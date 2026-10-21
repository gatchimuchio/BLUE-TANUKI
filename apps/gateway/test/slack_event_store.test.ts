import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SlackInboundHandler,
  type SlackInboundMessage,
  type SlackPostResult,
  type SlackTransport,
  SlackChannel,
} from "@blue-tanuki/channel-slack";
import { InboundRouter } from "@blue-tanuki/channel-base";
import { GatewaySlackEventStore } from "../src/slack_event_store.js";
import { planGatewayInboundBoundary } from "../src/serve.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(token = "fixture-slack-bot-token"): { root: string; filepath: string; store: GatewaySlackEventStore } {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-slack-inbox-"));
  roots.push(root);
  const filepath = join(root, "private", "slack-inbox.sqlite");
  return { root, filepath, store: new GatewaySlackEventStore(filepath, token) };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventPayloadDigest(message: SlackInboundMessage): string {
  return digest(JSON.stringify([message.team_id, message.channel_id, message.user_id, message.thread_ts,
    message.ts, message.text, message.is_dm, message.is_mention]));
}

function event(overrides: Partial<SlackInboundMessage> = {}): SlackInboundMessage {
  return {
    team_id: "T1",
    event_id: "Ev1",
    channel_id: "C1",
    user_id: "U1",
    user_display: "mutable-display-name",
    text: "synthetic private message body",
    ts: "100.200",
    thread_ts: null,
    is_dm: false,
    is_mention: true,
    ...overrides,
  };
}

class ReplayTransport implements SlackTransport {
  handler: SlackInboundHandler | null = null;
  readonly posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  constructor(private readonly message: SlackInboundMessage, private readonly postResults: SlackPostResult[] = []) {}
  async start(handler: SlackInboundHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<SlackPostResult> {
    this.posts.push(args);
    return this.postResults.shift() ?? { ok: true, ts: "200.300" };
  }
  getBotUserId(): string | undefined { return "UBOT"; }
  async emit(): Promise<void> {
    if (!this.handler) throw new Error("transport_not_started");
    await this.handler(this.message);
  }
}

describe("GatewaySlackEventStore", () => {
  it("stores only scoped digests and rejects duplicate or conflicting event identities", () => {
    const { filepath, store } = makeStore();
    const body = "synthetic private message body";
    const payloadDigest = digest(body);
    expect(store.claim("Ev1", payloadDigest, 100)).toEqual({ status: "accepted" });
    store.settle("Ev1", payloadDigest, "handler_returned", 200);
    expect(store.claim("Ev1", payloadDigest)).toEqual({ status: "duplicate", delivery_state: "handler_returned" });
    expect(store.claim("Ev1", digest("altered body"))).toEqual({ status: "identity_conflict" });

    const anotherBot = new GatewaySlackEventStore(filepath, "different-fixture-token");
    try {
      expect(anotherBot.claim("Ev1", payloadDigest)).toEqual({ status: "accepted" });
      const stored = readFileSync(filepath).toString("utf8");
      expect(stored).not.toContain(body);
      expect(stored).not.toContain("fixture-slack-bot-token");
      expect(stored).not.toContain("Ev1");
    } finally {
      anotherBot.close();
      store.close();
    }
  });

  it("keeps interrupted admissions outcome-unknown across process restart", () => {
    const { filepath, store } = makeStore();
    const payloadDigest = digest("synthetic in-flight event");
    expect(store.claim("Ev2", payloadDigest, 10)).toEqual({ status: "accepted" });
    store.close();

    const reopened = new GatewaySlackEventStore(filepath, "fixture-slack-bot-token");
    try {
      expect(reopened.claim("Ev2", payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      expect(reopened.claim("Ev3", digest("next event"))).toEqual({ status: "accepted" });
      reopened.settle("Ev3", digest("next event"), "handler_returned");
    } finally {
      reopened.close();
    }
  });

  it("connects durable replay suppression to the Slack adapter consumer across restarts", async () => {
    const { filepath, store } = makeStore();
    const firstTransport = new ReplayTransport(event());
    const firstChannel = new SlackChannel({ transport: firstTransport,
      inbound_grants: [{ team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: null }], inbox: store,
      log: () => {} });
    let firstHandlerCalls = 0;
    await firstChannel.start(async (request) => {
      const boundary = planGatewayInboundBoundary(request);
      expect(boundary.boundary_ok).toBe(true);
      expect(boundary.request.user).toMatch(/^slack:[a-f0-9]{64}$/u);
      expect(boundary.request.metadata?.slack_team_id).toBe("T1");
      firstHandlerCalls += 1;
    });
    await firstTransport.emit();
    await firstChannel.stop();
    expect(firstHandlerCalls).toBe(1);
    store.close();

    const reopened = new GatewaySlackEventStore(filepath, "fixture-slack-bot-token");
    const replayTransport = new ReplayTransport(event());
    const replayChannel = new SlackChannel({ transport: replayTransport,
      inbound_grants: [{ team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: null }], inbox: reopened,
      log: () => {} });
    let replayHandlerCalls = 0;
    try {
      await replayChannel.start(async () => { replayHandlerCalls += 1; });
      await replayTransport.emit();
      expect(replayHandlerCalls).toBe(0);
      await replayChannel.stop();
    } finally {
      await replayChannel.stop();
      reopened.close();
    }
  });

  it("propagates Slack Gateway handler failure so durable admission stays outcome-unknown", async () => {
    const { store } = makeStore();
    const transport = new ReplayTransport(event());
    const channel = new SlackChannel({ transport,
      inbound_grants: [{ team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: null }], inbox: store,
      log: () => {} });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["slack"],
      redactHandlerErrorsForChannels: ["slack"],
    });
    router.register(channel);
    try {
      await router.start(async () => { throw new Error("private handler detail"); });
      await transport.emit();
      expect(store.claim("Ev1", eventPayloadDigest(event()))).toEqual({
        status: "duplicate", delivery_state: "outcome_unknown",
      });
    } finally {
      await router.stop();
      store.close();
    }
  });

  it("persists Retry-After and retries only an explicitly rejected Slack delivery after restart", async () => {
    const { filepath, store } = makeStore();
    const deliveryId = randomUUID();
    const payload = { delivery_id: deliveryId, channel: "slack", target: "C1", text: "synthetic reply", thread_ts: "100.200" } as const;
    store.enqueue(payload, 100);
    const firstAttempt = store.claimDelivery(deliveryId, 100);
    expect(firstAttempt).toMatchObject({ delivery_id: deliveryId, attempt_count: 1, text: "synthetic reply" });
    store.scheduleRetry(deliveryId, 150, 50, 100);
    expect(store.pending()).toEqual([{ delivery_id: deliveryId, delivery_state: "retry_wait", not_before_ms: 150 }]);
    store.close();

    const reopened = new GatewaySlackEventStore(filepath, "fixture-slack-bot-token");
    const transport = new ReplayTransport(event());
    const channel = new SlackChannel({ transport, delivery_store: reopened, log: () => {}, retry: {
      max_retries: 3, base_delay_ms: 1, max_delay_ms: 10, jitter_ratio: 0, sleep: async () => {}, random: () => 0.5,
    } });
    try {
      await channel.start(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(transport.posts).toEqual([{ channel: "C1", text: "synthetic reply", thread_ts: "100.200" }]);
      expect(reopened.status(deliveryId)).toMatchObject({ delivery_state: "delivered", attempt_count: 2,
        retry_after_ms: 50, external_ts: "200.300" });
      expect(reopened.pending()).toEqual([]);
      const stored = readFileSync(filepath).toString("utf8");
      expect(stored).not.toContain("synthetic reply");
      expect(stored).not.toContain("fixture-slack-bot-token");
    } finally {
      await channel.stop();
      reopened.close();
    }
  });

  it("writes the rate-limit wait before retrying the same thread reply", async () => {
    const { store } = makeStore();
    const transport = new ReplayTransport(event(), [
      { ok: false, delivery_status: "not_delivered", error: "ratelimited", error_code: "rate_limited", retry_after_ms: 100 },
      { ok: true, ts: "200.300" },
    ]);
    let waitObserved = false;
    const channel = new SlackChannel({ transport, delivery_store: store, log: () => {}, retry: {
      max_retries: 2, base_delay_ms: 1, max_delay_ms: 10, jitter_ratio: 0,
      sleep: async (ms) => {
        const pending = store.pending();
        expect(pending).toHaveLength(1);
        expect(pending[0]?.delivery_state).toBe("retry_wait");
        expect(pending[0]?.not_before_ms).toBeGreaterThan(Date.now());
        waitObserved = true;
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      random: () => 0.5,
    } });
    try {
      await channel.start(async () => {});
      const result = await channel.send(
        { channel: "slack", target: "C1", content: "synthetic reply", thread_ts: "100.200" },
        { command_id: "slack-thread-reply", upstream_commit_hash: "h" },
      );
      expect(result.delivered).toBe(true);
      expect(waitObserved).toBe(true);
      expect(transport.posts).toEqual([
        { channel: "C1", text: "synthetic reply", thread_ts: "100.200" },
        { channel: "C1", text: "synthetic reply", thread_ts: "100.200" },
      ]);
      expect(store.pending()).toEqual([]);
    } finally {
      await channel.stop();
      store.close();
    }
  });

  it("settles an explicitly rate-limited reply when durable retries are disabled", async () => {
    const { store } = makeStore();
    const transport = new ReplayTransport(event(), [
      { ok: false, delivery_status: "not_delivered", error: "ratelimited", error_code: "rate_limited", retry_after_ms: 25 },
    ]);
    let deliveryId = "";
    const enqueue = store.enqueue.bind(store);
    store.enqueue = (input, nowMs) => { deliveryId = input.delivery_id; enqueue(input, nowMs); };
    const channel = new SlackChannel({ transport, delivery_store: store, retry: false, log: () => {} });
    try {
      await channel.start(async () => {});
      const result = await channel.send(
        { channel: "slack", target: "C1", content: "no retry" },
        { command_id: "no-retry", upstream_commit_hash: "h" },
      );
      expect(result.delivered).toBe(false);
      expect(result.delivery_status).toBe("not_delivered");
      expect(transport.posts).toHaveLength(1);
      expect(store.pending()).toEqual([]);
      expect(store.status(deliveryId)).toMatchObject({
        delivery_state: "retry_exhausted",
        retry_after_ms: 25,
      });
    } finally {
      await channel.stop();
      store.close();
    }
  });

  it("settles a claimed reply without sending when cancellation wins before dispatch", async () => {
    const { store } = makeStore();
    const transport = new ReplayTransport(event());
    const controller = new AbortController();
    let queuedDeliveryId = "";
    const enqueue = store.enqueue.bind(store);
    store.enqueue = (input, nowMs) => {
      queuedDeliveryId = input.delivery_id;
      enqueue(input, nowMs);
    };
    const claimDelivery = store.claimDelivery.bind(store);
    store.claimDelivery = (deliveryId, nowMs) => {
      const claim = claimDelivery(deliveryId, nowMs);
      controller.abort();
      return claim;
    };
    const channel = new SlackChannel({ transport, delivery_store: store, log: () => {} });
    try {
      await channel.start(async () => {});
      const result = await channel.send(
        { channel: "slack", target: "C1", content: "cancel before dispatch" },
        { command_id: "cancelled-reply", upstream_commit_hash: "h" },
        { signal: controller.signal },
      );
      expect(result.delivered).toBe(false);
      expect(result.delivery_status).toBe("not_delivered");
      expect(transport.posts).toEqual([]);
      expect(store.status(queuedDeliveryId)).toMatchObject({
        delivery_state: "not_delivered",
        error_code: "cancelled_before_dispatch",
      });
    } finally {
      await channel.stop();
      store.close();
    }
  });

  it("converts an interrupted outbound dispatch to outcome-unknown without retrying", async () => {
    const { filepath, store } = makeStore();
    const deliveryId = randomUUID();
    store.enqueue({ delivery_id: deliveryId, channel: "slack", target: "C1", text: "possibly delivered" }, 100);
    expect(store.claimDelivery(deliveryId, 100)?.attempt_count).toBe(1);
    store.close();
    const reopened = new GatewaySlackEventStore(filepath, "fixture-slack-bot-token");
    const transport = new ReplayTransport(event());
    const channel = new SlackChannel({ transport, delivery_store: reopened, log: () => {} });
    try {
      await channel.start(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(transport.posts).toEqual([]);
      expect(reopened.status(deliveryId)).toMatchObject({ delivery_state: "outcome_unknown", attempt_count: 1 });
    } finally {
      await channel.stop();
      reopened.close();
    }
  });
});
