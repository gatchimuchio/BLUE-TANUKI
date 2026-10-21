import { describe, it, expect } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  SlackChannel,
  type SlackTransport,
  type SlackInboundHandler,
  type SlackInboundMessage,
  type SlackPostResult,
} from "../src/index.js";

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
});

describe("SlackChannel — active mode (fake transport)", () => {
  it("starts the transport and delivers inbound through the handler", async () => {
    const t = new FakeSlackTransport();
    const ch = new SlackChannel({ transport: t, log: () => {} });
    const received: InboundRequest[] = [];
    await ch.start(async (req) => {
      received.push(req);
    });

    expect(t.startCalls).toBe(1);
    expect(ch.isSilent()).toBe(false);

    await t.emitInbound({
      channel_id: "C100",
      user_id: "U7",
      user_display: "alice",
      text: "hello bot",
      ts: "111.222",
      is_dm: false,
      is_mention: true,
    });

    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.channel).toBe("slack");
    expect(r.user).toBe("alice");
    expect(r.content).toBe("hello bot");
    expect(r.metadata?.reply_to).toBe("C100");
    expect(r.metadata?.slack_user_id).toBe("U7");
    expect(r.metadata?.is_mention).toBe(true);
    expect(r.metadata?.is_dm).toBe(false);

    await ch.stop();
    expect(t.stopCalls).toBe(1);
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
    const ch = new SlackChannel({ transport: t, log: (l) => lines.push(l) });
    await ch.start(async () => {
      throw new Error("downstream-fail");
    });

    await expect(
      t.emitInbound({
        channel_id: "C1",
        user_id: "U1",
        user_display: "u",
        text: "x",
        ts: "1",
        is_dm: true,
        is_mention: false,
      }),
    ).resolves.toBeUndefined();

    expect(lines.some((l) => l.includes("downstream-fail"))).toBe(true);
    await ch.stop();
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
