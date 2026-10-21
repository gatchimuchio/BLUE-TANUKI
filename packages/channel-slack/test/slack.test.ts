import { describe, it, expect } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  SlackChannel,
  type SlackTransport,
  type SlackInboundHandler,
  type SlackEventInbox,
  type SlackInboundMessage,
  type SlackPostResult,
} from "../src/index.js";
import { readSlackEventEnvelopeIdentity } from "../src/bolt_transport.js";

const slackGrant = { team_id: "T1", channel_id: "C100", user_id: "U7", thread_ts: null } as const;

class MemorySlackEventInbox implements SlackEventInbox {
  readonly records = new Map<string, { payload_digest: string; state: "dispatching" | "handler_returned" | "outcome_unknown" }>();
  claim(event_id: string, payload_digest: string) {
    const current = this.records.get(event_id);
    if (current) return current.payload_digest === payload_digest
      ? { status: "duplicate", delivery_state: current.state } as const
      : { status: "identity_conflict" } as const;
    this.records.set(event_id, { payload_digest, state: "dispatching" });
    return { status: "accepted" } as const;
  }
  settle(event_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown") {
    const current = this.records.get(event_id);
    if (!current || current.payload_digest !== payload_digest || current.state !== "dispatching") {
      throw new Error("fixture_settlement_conflict");
    }
    current.state = state;
  }
}

function inboundMessage(overrides: Partial<SlackInboundMessage> = {}): SlackInboundMessage {
  return {
    team_id: "T1",
    event_id: "Ev1",
    channel_id: "C100",
    user_id: "U7",
    user_display: "alice",
    text: "hello bot",
    ts: "111.222",
    thread_ts: null,
    is_dm: false,
    is_mention: true,
    ...overrides,
  };
}

/**
 * In-memory fake transport for Slack tests. Mirrors the production
 * BoltTransport contract without bringing in `@slack/bolt`.
 *
 * Test driver:
 *   - call `emitInbound(...)` to simulate a Slack message arriving
 *   - inspect `posted` to verify outbound calls
 *   - flip `nextPostFails` to force a postMessage failure
 */
class FakeSlackTransport implements SlackTransport {
  handler: SlackInboundHandler | null = null;
  posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  nextPostFails: string | null = null;
  startCalls = 0;
  stopCalls = 0;
  private botUserId = "UBOT";

  async start(handler: SlackInboundHandler): Promise<void> {
    this.startCalls++;
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.handler = null;
  }

  async postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult> {
    if (this.nextPostFails) {
      const err = this.nextPostFails;
      this.nextPostFails = null;
      return { ok: false, error: err };
    }
    this.posted.push({ ...args });
    return { ok: true, ts: `ts-${this.posted.length}` };
  }

  getBotUserId(): string | undefined {
    return this.botUserId;
  }

  emitInbound(m: SlackInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("transport not started");
    return this.handler(m);
  }
}

describe("SlackChannel — silent mode (no token, no transport)", () => {
  it("starts silently when neither bot_token nor app_token nor transport given", async () => {
    const lines: string[] = [];
    const ch = new SlackChannel({ log: (l) => lines.push(l) });
    await ch.start(async () => {});
    expect(ch.isSilent()).toBe(true);
    expect(lines.some((l) => l.includes("silent mode"))).toBe(true);
    await ch.stop();
  });

  it("send() returns delivered=false in silent mode", async () => {
    const ch = new SlackChannel({ log: () => {} });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C123", content: "x" },
      { command_id: "c1", upstream_commit_hash: "abc" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("silent_mode");
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("slack_not_configured");
    expect(r.next_action).toContain("SLACK_BOT_TOKEN");
    await ch.stop();
  });

  it("only one of (bot_token, app_token) is not enough — still silent", async () => {
    const ch = new SlackChannel({ bot_token: "xoxb-x", log: () => {} });
    await ch.start(async () => {});
    expect(ch.isSilent()).toBe(true);
    await ch.stop();
  });

  it("requires a durable inbox before starting a credentialed Bolt transport", async () => {
    const ch = new SlackChannel({ bot_token: "xoxb-fixture", app_token: "xapp-fixture" });
    await expect(ch.start(async () => {})).rejects.toThrow("slack_durable_inbox_required_for_live_events");
  });
});

describe("SlackChannel — active mode (fake transport)", () => {
  it("starts the transport and delivers inbound through the handler", async () => {
    const t = new FakeSlackTransport();
    const inbox = new MemorySlackEventInbox();
    const ch = new SlackChannel({ transport: t, inbound_grants: [slackGrant], inbox, log: () => {} });
    const received: InboundRequest[] = [];
    await ch.start(async (req) => {
      received.push(req);
    });

    expect(t.startCalls).toBe(1);
    expect(ch.isSilent()).toBe(false);

    await t.emitInbound(inboundMessage());

    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.channel).toBe("slack");
    expect(r.user).toMatch(/^slack:[a-f0-9]{64}$/u);
    expect(r.content).toBe("hello bot");
    expect(r.metadata?.reply_to).toBe("C100");
    expect(r.metadata?.slack_team_id).toBe("T1");
    expect(r.metadata?.slack_user_id).toBe("U7");
    expect(r.metadata?.slack_thread_ts).toBeNull();
    expect(r.metadata).not.toHaveProperty("slack_event_id");
    expect(r.metadata?.is_mention).toBe(true);
    expect(r.metadata?.is_dm).toBe(false);

    await ch.stop();
    expect(t.stopCalls).toBe(1);
  });

  it("defaults to denying inbound and reports that state when grants are empty", async () => {
    const t = new FakeSlackTransport();
    const inbox = new MemorySlackEventInbox();
    const lines: string[] = [];
    const ch = new SlackChannel({ transport: t, inbox, log: (line) => lines.push(line) });
    let handlerCalls = 0;
    await ch.start(async () => { handlerCalls += 1; });
    await t.emitInbound(inboundMessage());
    expect(handlerCalls).toBe(0);
    expect(lines.some((line) => line.includes("inbound messages are rejected"))).toBe(true);
    await ch.stop();
  });

  it("send() routes to transport.postMessage and reports the ts", async () => {
    const t = new FakeSlackTransport();
    const ch = new SlackChannel({ transport: t, log: () => {} });
    await ch.start(async () => {});

    const r = await ch.send(
      { channel: "slack", target: "C100", content: "reply text" },
      { command_id: "cmd-1", upstream_commit_hash: "deadbeef" },
    );

    expect(r.delivered).toBe(true);
    expect(r.external_id).toBe("ts-1");
    expect(t.posted).toEqual([{ channel: "C100", text: "reply text", thread_ts: undefined }]);
    await ch.stop();
  });

  it("send() surfaces transport failure as delivered=false with error", async () => {
    const t = new FakeSlackTransport();
    t.nextPostFails = "channel_not_found";
    const ch = new SlackChannel({ transport: t, log: () => {} });
    await ch.start(async () => {});

    const r = await ch.send(
      { channel: "slack", target: "Cbad", content: "x" },
      { command_id: "cmd-2", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("channel_not_found");
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("channel_not_found");
    expect(r.next_action).toContain("SLACK_LIVE_TARGET");

    const hist = ch.getHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0]!.ok).toBe(false);
    expect(hist[0]!.error).toBe("channel_not_found");
    expect(hist[0]!.error_kind).toBe("non_recoverable");
    await ch.stop();
  });

  it("inbound handler error does not break listener (logs only)", async () => {
    const lines: string[] = [];
    const t = new FakeSlackTransport();
    const inbox = new MemorySlackEventInbox();
    const ch = new SlackChannel({ transport: t, inbound_grants: [slackGrant], inbox, log: (l) => lines.push(l) });
    await ch.start(async () => {
      throw new Error("downstream-fail");
    });

    await expect(
      t.emitInbound(inboundMessage()),
    ).resolves.toBeUndefined();

    expect(lines.some((l) => l.includes("outcome is unknown"))).toBe(true);
    expect(inbox.records.get("Ev1")?.state).toBe("outcome_unknown");
    await ch.stop();
  });

  it("admits only exact team/channel/user/thread grants and suppresses duplicate or conflicting events", async () => {
    const t = new FakeSlackTransport();
    const inbox = new MemorySlackEventInbox();
    const received: InboundRequest[] = [];
    const ch = new SlackChannel({
      transport: t,
      inbound_grants: [slackGrant, { ...slackGrant, thread_ts: "111.222" }],
      inbox,
      log: () => {},
    });
    await ch.start(async (request) => { received.push(request); });

    await t.emitInbound(inboundMessage({ team_id: "T2" }));
    await t.emitInbound(inboundMessage({ channel_id: "C101" }));
    await t.emitInbound(inboundMessage({ user_id: "U8" }));
    await t.emitInbound(inboundMessage({ thread_ts: "999.000" }));
    expect(received).toHaveLength(0);
    expect(inbox.records.size).toBe(0);

    await t.emitInbound(inboundMessage());
    await t.emitInbound(inboundMessage());
    await t.emitInbound(inboundMessage({ text: "changed payload" }));
    expect(received).toHaveLength(1);
    expect(inbox.records.get("Ev1")?.state).toBe("handler_returned");

    const thread = inboundMessage({ event_id: "Ev2", thread_ts: "111.222" });
    await t.emitInbound(thread);
    expect(received).toHaveLength(2);
    expect(received[1]?.user).not.toBe(received[0]?.user);
    await ch.stop();
  });

  it("extracts team and event identity only from the authenticated outer Bolt payload", () => {
    expect(readSlackEventEnvelopeIdentity({ team_id: "T1", event_id: "Ev1", event: {} }))
      .toEqual({ team_id: "T1", event_id: "Ev1" });
    expect(readSlackEventEnvelopeIdentity({ event: { team_id: "T1", event_id: "Ev1" } })).toBeNull();
    expect(readSlackEventEnvelopeIdentity(null)).toBeNull();
  });

  it("transport.start failure falls back to silent (does not throw)", async () => {
    const lines: string[] = [];
    const failing: SlackTransport = {
      start: async () => {
        throw new Error("auth_test_failed");
      },
      stop: async () => {},
      postMessage: async () => ({ ok: false, error: "x" }),
      getBotUserId: () => undefined,
    };
    const ch = new SlackChannel({ transport: failing, log: (l) => lines.push(l) });
    await ch.start(async () => {});
    expect(ch.isSilent()).toBe(true);
    expect(lines.some((l) => l.includes("auth_test_failed"))).toBe(true);
    await ch.stop();
  });
});

describe("SlackChannel — retry/backoff on rate limits", () => {
  /** Transport that fails the first N postMessage calls with a ratelimit, then succeeds. */
  class FlakeyRateLimitTransport implements SlackTransport {
    handler: SlackInboundHandler | null = null;
    posted: Array<{ channel: string; text: string }> = [];
    private failsLeft: number;
    constructor(
      private readonly retry_after_ms: number | undefined,
      failures: number,
      private readonly errorString = "ratelimited",
    ) {
      this.failsLeft = failures;
    }
    async start(h: SlackInboundHandler): Promise<void> {
      this.handler = h;
    }
    async stop(): Promise<void> {
      this.handler = null;
    }
    async postMessage(args: { channel: string; text: string }): Promise<SlackPostResult> {
      if (this.failsLeft > 0) {
        this.failsLeft -= 1;
        return {
          ok: false,
          error: this.errorString,
          retry_after_ms: this.retry_after_ms,
        };
      }
      this.posted.push({ channel: args.channel, text: args.text });
      return { ok: true, ts: `ts-${this.posted.length}` };
    }
    getBotUserId(): string | undefined {
      return "UBOT";
    }
  }

  it("retries ratelimited responses and eventually succeeds", async () => {
    const t = new FlakeyRateLimitTransport(50, 2);
    const sleeps: number[] = [];
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 3,
        base_delay_ms: 10,
        max_delay_ms: 1000,
        jitter_ratio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5, // no jitter
      },
    });
    await ch.start(async () => {});

    const r = await ch.send(
      { channel: "slack", target: "C1", content: "hi" },
      { command_id: "c-1", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(true);
    expect(t.posted).toHaveLength(1);
    expect(sleeps).toHaveLength(2); // 2 retries
    // server-hint (50ms) overrides exponential 10/20
    expect(sleeps).toEqual([50, 50]);
    await ch.stop();
  });

  it("falls back to exponential delay when no retry_after_ms hint is given", async () => {
    const t = new FlakeyRateLimitTransport(undefined, 2, "ratelimited");
    const sleeps: number[] = [];
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 3,
        base_delay_ms: 100,
        max_delay_ms: 1000,
        jitter_ratio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      },
    });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "hi" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(true);
    expect(sleeps).toEqual([100, 200]);
    await ch.stop();
  });

  it("non-ratelimit failure is NOT retried", async () => {
    const t = new FlakeyRateLimitTransport(undefined, 5, "channel_not_found");
    const sleeps: number[] = [];
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 3,
        base_delay_ms: 10,
        max_delay_ms: 1000,
        jitter_ratio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      },
    });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "hi" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("channel_not_found");
    expect(sleeps).toEqual([]); // no retries scheduled
    await ch.stop();
  });

  it("retry: false disables retry entirely", async () => {
    const t = new FlakeyRateLimitTransport(undefined, 5, "ratelimited");
    const ch = new SlackChannel({ transport: t, log: () => {}, retry: false });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "hi" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("ratelimited");
    expect(r.error_kind).toBe("recoverable");
    expect(r.error_code).toBe("ratelimited");
    await ch.stop();
  });

  it("gives up after max_retries and surfaces the final error", async () => {
    const t = new FlakeyRateLimitTransport(5, 10, "ratelimited"); // always fails
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 2,
        base_delay_ms: 1,
        max_delay_ms: 10,
        jitter_ratio: 0,
        sleep: async () => {},
        random: () => 0.5,
      },
    });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "hi" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("ratelimited");
    expect(r.error_kind).toBe("recoverable");
    expect(r.error_code).toBe("rate_limited");
    expect(r.retry_after_ms).toBe(5);
    expect(r.next_action).toContain("recoverable");
    await ch.stop();
  });
});

describe("SlackChannel — retry / backoff", () => {
  it("retries on rate_limited result with retry_after_ms hint, then succeeds", async () => {
    const t = new FakeSlackTransport();
    let calls = 0;
    t.postMessage = async (args): Promise<SlackPostResult> => {
      calls++;
      if (calls < 3) {
        return { ok: false, error: "ratelimited", retry_after_ms: 200 };
      }
      return { ok: true, ts: `ts-${calls}` };
    };
    const sleeps: number[] = [];
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 5,
        base_delay_ms: 100,
        max_delay_ms: 10_000,
        jitter_ratio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      },
    });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(true);
    expect(calls).toBe(3);
    // Both retries used the server hint (200ms).
    expect(sleeps).toEqual([200, 200]);
    await ch.stop();
  });

  it("does not retry permanent errors (e.g. channel_not_found)", async () => {
    const t = new FakeSlackTransport();
    let calls = 0;
    t.postMessage = async (): Promise<SlackPostResult> => {
      calls++;
      return { ok: false, error: "channel_not_found" };
    };
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 3,
        base_delay_ms: 10,
        max_delay_ms: 100,
        jitter_ratio: 0,
        sleep: async () => {},
        random: () => 0.5,
      },
    });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "Cbad", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(calls).toBe(1); // no retries
    await ch.stop();
  });

  it("retry: false disables retries entirely", async () => {
    const t = new FakeSlackTransport();
    let calls = 0;
    t.postMessage = async (): Promise<SlackPostResult> => {
      calls++;
      return { ok: false, error: "ratelimited", retry_after_ms: 100 };
    };
    const ch = new SlackChannel({ transport: t, log: () => {}, retry: false });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(calls).toBe(1);
    await ch.stop();
  });

  it("eventually surfaces failure after exhausting retries", async () => {
    const t = new FakeSlackTransport();
    let calls = 0;
    t.postMessage = async (): Promise<SlackPostResult> => {
      calls++;
      return { ok: false, error: "ratelimited", retry_after_ms: 50 };
    };
    const ch = new SlackChannel({
      transport: t,
      log: () => {},
      retry: {
        max_retries: 2,
        base_delay_ms: 10,
        max_delay_ms: 1_000,
        jitter_ratio: 0,
        sleep: async () => {},
        random: () => 0.5,
      },
    });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "slack", target: "C1", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(calls).toBe(3); // 1 initial + 2 retries
    await ch.stop();
  });

  it("does not retry after task cancellation", async () => {
    const t = new FakeSlackTransport();
    const controller = new AbortController();
    let calls = 0;
    t.postMessage = async (): Promise<SlackPostResult> => {
      calls++;
      controller.abort();
      return { ok: false, error: "ratelimited", retry_after_ms: 1 };
    };
    const ch = new SlackChannel({ transport: t, log: () => {}, retry: {
      max_retries: 3, base_delay_ms: 0, max_delay_ms: 1, jitter_ratio: 0,
      sleep: async () => {}, random: () => 0.5,
    } });
    await ch.start(async () => {});
    const r = await ch.send({ channel: "slack", target: "C1", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" }, { signal: controller.signal });
    expect(r.delivered).toBe(false);
    expect(calls).toBe(1);
    await ch.stop();
  });
});
