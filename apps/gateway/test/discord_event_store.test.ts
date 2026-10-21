import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiscordChannel,
  type DiscordInboundHandler,
  type DiscordInboundMessage,
  type DiscordPostResult,
  type DiscordTransport,
} from "@blue-tanuki/channel-discord";
import { InboundRouter, OutboundDispatcher } from "@blue-tanuki/channel-base";
import { GatewayDiscordEventStore } from "../src/discord_event_store.js";
import { planGatewayInboundBoundary, replyPayload } from "../src/serve.js";

const stores: GatewayDiscordEventStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function storeAt(filepath: string, token = "discord-token-fixture"): GatewayDiscordEventStore {
  const store = new GatewayDiscordEventStore(filepath, token);
  stores.push(store);
  return store;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class ReplyTransport implements DiscordTransport {
  private handler: DiscordInboundHandler | null = null;
  readonly posts: Array<{ channel: string; text: string; reply_to_message_id?: string }> = [];
  constructor(private readonly results: DiscordPostResult[] = []) {}
  async start(handler: DiscordInboundHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async postMessage(args: { channel: string; text: string; reply_to_message_id?: string }): Promise<DiscordPostResult> {
    this.posts.push(args);
    return this.results.shift() ?? { ok: true, message_id: "987654321" };
  }
  getBotUserId(): string | undefined { return "123456789"; }
  async emitInbound(message: DiscordInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("discord_transport_not_started");
    await this.handler(message);
  }
}

describe("GatewayDiscordEventStore", () => {
  it("durably deduplicates message snowflakes and detects payload conflicts per bot scope", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-inbox-"));
    try {
      const filepath = path.join(dir, "discord.sqlite");
      const store = storeAt(filepath);
      const payloadDigest = digest("private discord message fixture");
      expect(store.claim("123456789", payloadDigest)).toEqual({ status: "accepted" });
      store.settle("123456789", payloadDigest, "handler_returned");
      expect(store.claim("123456789", payloadDigest)).toEqual({
        status: "duplicate",
        delivery_state: "handler_returned",
      });
      expect(store.claim("123456789", digest("changed payload"))).toEqual({ status: "identity_conflict" });
      expect(store.claim("123456789", payloadDigest)).toMatchObject({ status: "duplicate" });

      const otherBot = storeAt(filepath, "another-discord-token-fixture");
      expect(otherBot.claim("123456789", payloadDigest)).toEqual({ status: "accepted" });
      otherBot.close();
      store.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted message as outcome-unknown and persists no raw identifiers, text, or token", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-inbox-"));
    try {
      const filepath = path.join(dir, "discord.sqlite");
      const messageId = "987654321012345678";
      const token = "discord-token-never-persist-fixture";
      const message = "private message never persist fixture";
      const payloadDigest = digest(message);
      const first = storeAt(filepath, token);
      expect(first.claim(messageId, payloadDigest)).toEqual({ status: "accepted" });
      first.close();

      const reopened = storeAt(filepath, token);
      expect(reopened.claim(messageId, payloadDigest)).toEqual({
        status: "duplicate",
        delivery_state: "outcome_unknown",
      });
      const persisted = await fs.readFile(filepath);
      expect(persisted.includes(Buffer.from(messageId))).toBe(false);
      expect(persisted.includes(Buffer.from(message))).toBe(false);
      expect(persisted.includes(Buffer.from(token))).toBe(false);
      reopened.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists Discord reply delivery and retries only an explicit rate-limit rejection", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-outbox-"));
    const filepath = path.join(dir, "discord.sqlite");
    const token = "discord-outbox-fixture-token";
    const first = storeAt(filepath, token);
    const transport = new ReplyTransport([
      { ok: false, delivery_status: "not_delivered", rate_limit_rejected: true,
        retry_after_ms: 50, error: "rate-limited", error_code: "rate_limited" },
      { ok: true, message_id: "987654321" },
    ]);
    let retryWasDurable = false;
    const channel = new DiscordChannel({
      transport,
      inbox: first,
      inbound_grants: [{ guild_id: null, channel_id: "111222333", user_id: "444555666" }],
      delivery_store: first,
      log: () => {},
      retry: { max_retries: 2,
        sleep: async (ms) => {
          const pending = first.pending();
          expect(pending).toHaveLength(1);
          expect(pending[0]?.delivery_state).toBe("retry_wait");
          expect(pending[0]?.not_before_ms).toBeGreaterThan(Date.now() - ms - 10);
          retryWasDurable = true;
          await new Promise((resolve) => setTimeout(resolve, ms));
        } },
    });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["discord"],
      redactHandlerErrorsForChannels: ["discord"],
    });
    router.register(channel);
    const dispatcher = new OutboundDispatcher();
    dispatcher.register(channel);
    try {
      let handlerCalls = 0;
      await router.start(async (request) => {
        const boundary = planGatewayInboundBoundary(request);
        expect(boundary.boundary_ok).toBe(true);
        expect(boundary.request.user).toMatch(/^discord:[a-f0-9]{64}$/u);
        const result = await dispatcher.dispatch(
          replyPayload(boundary.request, "synthetic reply body"),
          { command_id: "discord-reply-fixture", upstream_commit_hash: "h" },
        );
        expect(result).toMatchObject({ delivered: true, delivery_status: "delivered", external_id: "987654321" });
        handlerCalls += 1;
      });
      await transport.emitInbound({
        channel_id: "111222333", user_id: "444555666", user_display: "mutable-name",
        text: "synthetic inbound request", message_id: "777888999", is_dm: true, is_mention: false,
      });
      expect(handlerCalls).toBe(1);
      expect(retryWasDurable).toBe(true);
      expect(transport.posts).toEqual([
        { channel: "111222333", text: "synthetic reply body", reply_to_message_id: "777888999" },
        { channel: "111222333", text: "synthetic reply body", reply_to_message_id: "777888999" },
      ]);
      expect(first.pending()).toEqual([]);
      const stored = await fs.readFile(filepath);
      expect(stored.includes(Buffer.from("synthetic reply body"))).toBe(false);
      expect(stored.includes(Buffer.from(token))).toBe(false);
    } finally {
      await router.stop();
      first.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay an interrupted outbound dispatch and removes its pending payload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-outbox-"));
    try {
      const filepath = path.join(dir, "discord.sqlite");
      const token = "discord-outbox-never-persist-token";
      const payload = { delivery_id: "6b0b68e2-f19d-4c4a-9b95-829eea244e70", channel: "discord" as const,
        target: "111222333", text: "outbound content cleared after interruption", reply_to_message_id: "444555666" };
      const first = storeAt(filepath, token);
      first.enqueue(payload, 1);
      expect(first.claimDelivery(payload.delivery_id, 1)).toMatchObject({ attempt_count: 1, text: payload.text });
      first.close();

      const reopened = storeAt(filepath, token);
      expect(reopened.pending()).toEqual([]);
      expect(reopened.status(payload.delivery_id)).toMatchObject({ delivery_state: "outcome_unknown", error_code: "interrupted_during_send" });
      const stored = await fs.readFile(filepath);
      expect(stored.includes(Buffer.from(payload.text))).toBe(false);
      expect(stored.includes(Buffer.from(payload.target))).toBe(false);
      expect(stored.includes(Buffer.from(token))).toBe(false);
      reopened.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous Discord send outcome terminal instead of retrying", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-outbox-"));
    const filepath = path.join(dir, "discord.sqlite");
    const store = storeAt(filepath);
    const transport = new ReplyTransport([
      { ok: false, delivery_status: "unknown", error: "transport timeout", error_code: "delivery_outcome_unknown" },
    ]);
    let deliveryId = "";
    const enqueue = store.enqueue.bind(store);
    store.enqueue = (input, nowMs) => { deliveryId = input.delivery_id; enqueue(input, nowMs); };
    const channel = new DiscordChannel({ transport, delivery_store: store, log: () => {} });
    try {
      await channel.start(async () => {});
      const result = await channel.send(
        { channel: "discord", target: "111222333", content: "ambiguous reply fixture" },
        { command_id: "discord-unknown-fixture", upstream_commit_hash: "h" },
      );
      expect(result).toMatchObject({ delivered: false, delivery_status: "unknown", error_code: "delivery_outcome_unknown" });
      expect(transport.posts).toHaveLength(1);
      expect(store.status(deliveryId)).toMatchObject({ delivery_state: "outcome_unknown" });
      expect(store.pending()).toEqual([]);
    } finally {
      await channel.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a persisted rate-limit wait queued on shutdown and resumes it after restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-outbox-"));
    const filepath = path.join(dir, "discord.sqlite");
    const token = "discord-restart-fixture-token";
    const store = storeAt(filepath, token);
    const transport = new ReplyTransport([
      { ok: false, delivery_status: "not_delivered", rate_limit_rejected: true,
        retry_after_ms: 100, error: "rate-limited", error_code: "rate_limited" },
    ]);
    let deliveryId = "";
    const enqueue = store.enqueue.bind(store);
    store.enqueue = (input, nowMs) => { deliveryId = input.delivery_id; enqueue(input, nowMs); };
    const channel = new DiscordChannel({ transport, delivery_store: store, log: () => {} });
    let restartedChannel: DiscordChannel | undefined;
    let reopenedStore: GatewayDiscordEventStore | undefined;
    try {
      await channel.start(async () => {});
      const send = channel.send(
        { channel: "discord", target: "111222333", content: "shutdown retry fixture" },
        { command_id: "discord-shutdown-fixture", upstream_commit_hash: "h" },
      );
      let retryPending = false;
      for (let i = 0; i < 100; i += 1) {
        if (store.pending().some((row) => row.delivery_state === "retry_wait")) {
          retryPending = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(retryPending).toBe(true);
      await channel.stop();
      await expect(send).resolves.toMatchObject({ delivered: false, delivery_status: "not_delivered" });
      expect(transport.posts).toHaveLength(1);
      expect(store.pending()).toHaveLength(1);
      expect(store.pending()[0]?.delivery_state).toBe("retry_wait");
      store.close();

      const reopened = reopenedStore = storeAt(filepath, token);
      const restartedTransport = new ReplyTransport([{ ok: true, message_id: "987654322" }]);
      restartedChannel = new DiscordChannel({ transport: restartedTransport, delivery_store: reopened, log: () => {} });
      await restartedChannel.start(async () => {});
      let resumed = false;
      for (let i = 0; i < 100; i += 1) {
        if (reopened.status(deliveryId)?.delivery_state === "delivered") {
          resumed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(resumed).toBe(true);
      expect(restartedTransport.posts).toEqual([{ channel: "111222333", text: "shutdown retry fixture" }]);
      expect(reopened.status(deliveryId)).toMatchObject({ delivery_state: "delivered", attempt_count: 2,
        retry_after_ms: 100, external_message_id: "987654322" });
      expect(reopened.pending()).toEqual([]);
    } finally {
      await restartedChannel?.stop();
      reopenedStore?.close();
      await channel.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
