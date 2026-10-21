import { createHash } from "node:crypto";
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
  constructor(private readonly message: SlackInboundMessage) {}
  async start(handler: SlackInboundHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async postMessage(_args: { channel: string; text: string; thread_ts?: string }): Promise<SlackPostResult> {
    return { ok: true, ts: "sent" };
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
});
