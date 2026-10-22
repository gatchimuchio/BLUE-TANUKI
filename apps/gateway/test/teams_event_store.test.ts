import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InboundRouter } from "@blue-tanuki/channel-base";
import { OutboundDispatcher } from "@blue-tanuki/channel-base";
import {
  TeamsChannel,
  type TeamsInboundHandler,
  type TeamsInboundMessage,
  type TeamsInboundGrant,
  type TeamsPostResult,
  teamsChannelReplyTarget,
  type TeamsTransport,
} from "@blue-tanuki/channel-teams";
import { GatewayTeamsEventStore } from "../src/teams_event_store.js";
import { planGatewayInboundBoundary, replyPayload } from "../src/serve.js";

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FixtureTeamsTransport implements TeamsTransport {
  private handler: TeamsInboundHandler | null = null;
  readonly posts: Array<{ target: string; text: string }> = [];
  onPost?: () => void;
  constructor(private readonly results: TeamsPostResult[] = []) {}
  async start(handler: TeamsInboundHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async postMessage(args: { target: string; text: string }): Promise<TeamsPostResult> {
    this.posts.push(args);
    this.onPost?.();
    return this.results.shift() ?? { ok: true, message_id: "synthetic-reply-id" };
  }
  async emit(message: TeamsInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("teams_transport_not_started");
    await this.handler(message);
  }
}

describe("GatewayTeamsEventStore", () => {
  it("persists replay decisions as digests and converts interrupted dispatch to outcome-unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-inbox-"));
    const filepath = path.join(dir, "teams.sqlite");
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const conversation = "19:private-conversation@thread.v2";
    const messageId = "synthetic-message-id";
    const text = "synthetic private text never persist";
    const eventId = digest(JSON.stringify([tenant, conversation, messageId]));
    const payloadDigest = digest(text);
    const first = new GatewayTeamsEventStore(filepath, CLIENT_ID);
    try {
      expect(first.claim(eventId, payloadDigest)).toEqual({ status: "accepted" });
      expect(first.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "dispatching" });
    } finally {
      first.close();
    }

    try {
      const reopened = new GatewayTeamsEventStore(filepath, CLIENT_ID);
      expect(reopened.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      reopened.settle(eventId, payloadDigest, "outcome_unknown");
      expect(reopened.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      expect(reopened.claim(eventId, digest("changed text"))).toEqual({ status: "identity_conflict" });
      const otherBot = new GatewayTeamsEventStore(filepath, "22222222-3333-4444-8555-666666666666");
      expect(otherBot.claim(eventId, payloadDigest)).toEqual({ status: "accepted" });
      otherBot.close();
      reopened.close();
      const persisted = await fs.readFile(filepath);
      for (const raw of [CLIENT_ID, eventId, tenant, conversation, messageId, text]) {
        expect(persisted.includes(Buffer.from(raw))).toBe(false);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("routes a granted synthetic Teams event into the Gateway inbound boundary exactly once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-route-"));
    const filepath = path.join(dir, "teams.sqlite");
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const message: TeamsInboundMessage = {
      tenant_id: tenant,
      conversation_id: "19:conversation@thread.v2",
      conversation_type: "groupChat",
      user_id: "29:owner-platform-id",
      text: "synthetic request body",
      message_id: "synthetic-activity-id",
    };
    const grant: TeamsInboundGrant = {
      tenant_id: tenant,
      conversation_id: message.conversation_id,
      conversation_type: "groupChat",
      user_id: message.user_id,
      team_id: null,
      channel_id: null,
    };
    const store = new GatewayTeamsEventStore(filepath, CLIENT_ID);
    const transport = new FixtureTeamsTransport();
    const channel = new TeamsChannel({ transport, inbox: store, delivery_store: store,
      inbound_grants: [grant], log: () => {} });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["teams"],
      redactHandlerErrorsForChannels: ["teams"],
    });
    router.register(channel);
    const requests: Array<{ user: string; content: string }> = [];
    try {
      await router.start(async (request) => {
        const boundary = planGatewayInboundBoundary(request);
        expect(boundary.boundary_ok).toBe(true);
        requests.push({ user: boundary.request.user, content: boundary.request.content });
      });
      await transport.emit(message);
      await transport.emit(message);
      await transport.emit({ ...message, text: "conflicting replay payload" });
      await transport.emit({ ...message, conversation_id: "19:another-conversation@thread.v2" });
      expect(requests).toEqual([{
        user: expect.stringMatching(/^teams:[a-f0-9]{64}$/u),
        content: "synthetic request body",
      }]);
      expect((await fs.readFile(filepath)).includes(Buffer.from("synthetic request body"))).toBe(false);
    } finally {
      await router.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("connects an admitted Teams event through Gateway reply routing, durable outbox, and a synthetic Graph consumer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-reply-outbox-"));
    const filepath = path.join(dir, "teams.sqlite");
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const message: TeamsInboundMessage = {
      tenant_id: tenant,
      conversation_id: "19:channel-conversation@thread.v2",
      conversation_type: "channel",
      team_id: "19:team@thread.tacv2",
      channel_id: "19:channel@thread.tacv2",
      user_id: "29:owner-platform-id",
      text: "synthetic inbound private fixture",
      message_id: "synthetic-activity-id",
      reply_to_message_id: "synthetic-activity-id",
    };
    const grant: TeamsInboundGrant = {
      tenant_id: tenant,
      conversation_id: message.conversation_id,
      conversation_type: "channel",
      user_id: message.user_id,
      team_id: message.team_id!,
      channel_id: message.channel_id!,
    };
    const store = new GatewayTeamsEventStore(filepath, CLIENT_ID);
    const transport = new FixtureTeamsTransport([
      { ok: false, delivery_status: "not_delivered", rate_limit_rejected: true,
        retry_after_ms: 100, error: "synthetic Graph 429", error_code: "rate_limited" },
      { ok: true, delivery_status: "delivered", message_id: "synthetic-reply-id" },
    ]);
    let observedRetryWait = false;
    const channel = new TeamsChannel({
      transport,
      inbox: store,
      delivery_store: store,
      inbound_grants: [grant],
      retry: { max_retries: 1,
        sleep: async (ms) => {
          const pending = store.pending();
          expect(pending).toHaveLength(1);
          expect(pending[0]?.delivery_state).toBe("retry_wait");
          observedRetryWait = true;
          await new Promise((resolve) => setTimeout(resolve, ms));
        } },
      log: () => {},
    });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["teams"],
      redactHandlerErrorsForChannels: ["teams"],
    });
    router.register(channel);
    const dispatcher = new OutboundDispatcher();
    dispatcher.register(channel);
    try {
      let replies = 0;
      await router.start(async (request) => {
        const boundary = planGatewayInboundBoundary(request);
        expect(boundary.boundary_ok).toBe(true);
        expect(boundary.request.user).toMatch(/^teams:[a-f0-9]{64}$/u);
        const result = await dispatcher.dispatch(
          replyPayload(boundary.request, "synthetic reply never persisted after settlement"),
          { command_id: "teams-reply-fixture", upstream_commit_hash: "h" },
        );
        expect(result).toMatchObject({ delivered: true, delivery_status: "delivered", external_id: "synthetic-reply-id" });
        replies += 1;
      });
      await transport.emit(message);
      await transport.emit(message);
      expect(replies).toBe(1);
      expect(transport.posts).toHaveLength(2);
      expect(observedRetryWait).toBe(true);
      const target = teamsChannelReplyTarget(message.team_id!, message.channel_id!, message.message_id);
      expect(transport.posts).toEqual([
        { target, text: "synthetic reply never persisted after settlement" },
        { target, text: "synthetic reply never persisted after settlement" },
      ]);
      expect(store.pending()).toEqual([]);
      const persisted = await fs.readFile(filepath);
      for (const raw of [message.text, "synthetic reply never persisted after settlement", CLIENT_ID]) {
        expect(persisted.includes(Buffer.from(raw))).toBe(false);
      }
    } finally {
      await router.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay an interrupted Teams send and removes its private payload on reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-outbox-restart-"));
    const filepath = path.join(dir, "teams.sqlite");
    const token = "teams-outbox-token-fixture";
    const payload = {
      delivery_id: "8d55ca37-b7b5-4db5-909d-5e49daef82ab",
      channel: "teams" as const,
      target: "chat/19%3Aprivate%40thread.v2",
      text: "private outbound body never replay after interrupted dispatch",
    };
    const first = new GatewayTeamsEventStore(filepath, token);
    try {
      first.enqueue(payload);
      expect(first.claimDelivery(payload.delivery_id)).toMatchObject({ attempt_count: 1, target: payload.target });
      first.close();
      const reopened = new GatewayTeamsEventStore(filepath, token);
      expect(reopened.pending()).toEqual([]);
      expect(reopened.status(payload.delivery_id)).toMatchObject({
        delivery_state: "outcome_unknown",
        error_code: "interrupted_during_send",
      });
      const persisted = await fs.readFile(filepath);
      for (const raw of [payload.target, payload.text, token]) expect(persisted.includes(Buffer.from(raw))).toBe(false);
      reopened.close();
    } finally {
      try { first.close(); } catch { /* already closed above */ }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removes pending outbox bodies when the configured credential scope changes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-outbox-scope-"));
    const filepath = path.join(dir, "teams.sqlite");
    const payload = {
      delivery_id: "89b50286-24a8-4427-88d5-a62db125a416",
      channel: "teams" as const,
      target: "chat/19%3Aold-owner%40thread.v2",
      text: "private stale credential scope reply fixture",
    };
    const oldScope = new GatewayTeamsEventStore(filepath, "old-teams-scope-fixture");
    try {
      oldScope.enqueue(payload);
      oldScope.close();
      const currentScope = new GatewayTeamsEventStore(filepath, "new-teams-scope-fixture");
      expect(currentScope.pending()).toEqual([]);
      expect((await fs.readFile(filepath)).includes(Buffer.from(payload.text))).toBe(false);
      currentScope.close();
    } finally {
      try { oldScope.close(); } catch { /* already closed above */ }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes a persisted Teams Retry-After wait after restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-retry-restart-"));
    const filepath = path.join(dir, "teams.sqlite");
    const payload = {
      delivery_id: "30c1f38b-72ab-45db-a04a-f1bc0d04ceaf",
      channel: "teams" as const,
      target: "chat/19%3Aretry%40thread.v2",
      text: "synthetic retry resume fixture",
    };
    const first = new GatewayTeamsEventStore(filepath, CLIENT_ID);
    let reopened: GatewayTeamsEventStore | undefined;
    let channel: TeamsChannel | undefined;
    try {
      first.enqueue(payload);
      first.claimDelivery(payload.delivery_id);
      first.scheduleRetry(payload.delivery_id, Date.now() + 100, 100);
      first.close();

      reopened = new GatewayTeamsEventStore(filepath, CLIENT_ID);
      expect(reopened.pending()).toMatchObject([{ delivery_id: payload.delivery_id, delivery_state: "retry_wait" }]);
      const transport = new FixtureTeamsTransport();
      channel = new TeamsChannel({ transport, delivery_store: reopened, log: () => {} });
      const firstPost = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("retry_recovery_timeout")), 3000);
        transport.onPost = () => { clearTimeout(timer); resolve(); };
      });
      await channel.start(async () => undefined);
      await firstPost;
      const deadline = Date.now() + 2000;
      while (reopened.status(payload.delivery_id)?.delivery_state === "dispatching" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(transport.posts).toEqual([{ target: payload.target, text: payload.text }]);
      expect(reopened.status(payload.delivery_id)).toMatchObject({ delivery_state: "delivered" });
      expect(reopened.pending()).toEqual([]);
    } finally {
      await channel?.stop();
      try { first.close(); } catch { /* already closed above */ }
      reopened?.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
