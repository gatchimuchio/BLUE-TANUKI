import { describe, it, expect } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  DiscordChannel,
  type DiscordTransport,
  type DiscordEventInbox,
  type DiscordInboundHandler,
  type DiscordInboundMessage,
  type DiscordPostResult,
} from "../src/index.js";

class FakeDiscordTransport implements DiscordTransport {
  handler: DiscordInboundHandler | null = null;
  posted: Array<{ channel: string; text: string }> = [];
  nextPostFails: string | null = null;
  startCalls = 0;
  stopCalls = 0;

  async start(handler: DiscordInboundHandler): Promise<void> {
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
  }): Promise<DiscordPostResult> {
    if (this.nextPostFails) {
      const err = this.nextPostFails;
      this.nextPostFails = null;
      return { ok: false, error: err };
    }
    this.posted.push({ ...args });
    return { ok: true, message_id: `mid-${this.posted.length}` };
  }

  getBotUserId(): string | undefined {
    return "BOT_ID";
  }

  emitInbound(m: DiscordInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("transport not started");
    return this.handler(m);
  }
}

class MemoryDiscordEventInbox implements DiscordEventInbox {
  readonly events = new Map<string, { payload_digest: string; delivery_state: "dispatching" | "handler_returned" | "outcome_unknown" }>();

  claim(messageId: string, payloadDigest: string) {
    const current = this.events.get(messageId);
    if (current) {
      return current.payload_digest === payloadDigest
        ? { status: "duplicate" as const, delivery_state: current.delivery_state }
        : { status: "identity_conflict" as const };
    }
    this.events.set(messageId, { payload_digest: payloadDigest, delivery_state: "dispatching" });
    return { status: "accepted" as const };
  }

  settle(messageId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown"): void {
    const current = this.events.get(messageId);
    if (!current || current.payload_digest !== payloadDigest || current.delivery_state !== "dispatching") {
      throw new Error("memory_discord_inbox_settlement_conflict");
    }
    current.delivery_state = state;
  }
}

describe("DiscordChannel — silent mode", () => {
  it("starts silently when no token / no transport", async () => {
    const lines: string[] = [];
    const ch = new DiscordChannel({ log: (l) => lines.push(l) });
    await ch.start(async () => {});
    expect(ch.isSilent()).toBe(true);
    expect(lines.some((l) => l.includes("silent mode"))).toBe(true);
    await ch.stop();
  });

  it("send() returns silent_mode error", async () => {
    const ch = new DiscordChannel({ log: () => {} });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "discord", target: "999", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("silent_mode");
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("discord_not_configured");
    expect(r.next_action).toContain("DISCORD_BOT_TOKEN");
    await ch.stop();
  });
});

describe("DiscordChannel — active mode (fake transport)", () => {
  it("delivers DM inbound through handler with metadata.reply_to", async () => {
    const t = new FakeDiscordTransport();
    const inbox = new MemoryDiscordEventInbox();
    const ch = new DiscordChannel({
      transport: t,
      inbound_grants: [{ guild_id: null, channel_id: "777", user_id: "888" }],
      inbox,
      log: () => {},
    });
    const received: InboundRequest[] = [];
    await ch.start(async (req) => {
      received.push(req);
    });

    await t.emitInbound({
      channel_id: "777",
      user_id: "888",
      user_display: "bob",
      text: "hi",
      message_id: "999",
      is_dm: true,
      is_mention: false,
    });

    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.channel).toBe("discord");
    expect(r.user).toMatch(/^discord:[a-f0-9]{64}$/u);
    expect(r.user).not.toBe("bob");
    expect(r.metadata?.reply_to).toBe("777");
    expect(r.metadata?.is_dm).toBe(true);
    expect(r.metadata?.discord_user_id).toBe("888");
    expect(r.metadata?.discord_message_id).toBe("999");
    expect(inbox.events.get("999")?.delivery_state).toBe("handler_returned");
    await ch.stop();
  });

  it("admits only exact guild/channel/user grants and suppresses duplicate or conflicting message IDs", async () => {
    const t = new FakeDiscordTransport();
    const inbox = new MemoryDiscordEventInbox();
    const ch = new DiscordChannel({
      transport: t,
      inbound_grants: [{ guild_id: "444", channel_id: "777", user_id: "888" }],
      inbox,
      log: () => {},
    });
    const received: InboundRequest[] = [];
    await ch.start(async (req) => { received.push(req); });

    const message: DiscordInboundMessage = {
      guild_id: "444",
      channel_id: "777",
      user_id: "888",
      user_display: "mutable-name",
      text: "hello",
      message_id: "999",
      is_dm: false,
      is_mention: true,
    };
    await t.emitInbound(message);
    await t.emitInbound(message);
    await t.emitInbound({ ...message, text: "changed payload for same id" });
    await t.emitInbound({ ...message, channel_id: "778", message_id: "1000" });
    await t.emitInbound({ ...message, message_id: "invalid-id" });

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata?.discord_guild_id).toBe("444");
    expect(inbox.events.get("999")?.delivery_state).toBe("handler_returned");
    expect(inbox.events.has("1000")).toBe(false);
    await ch.stop();
  });

  it("keeps a message outcome unknown when the Gateway handler throws", async () => {
    const t = new FakeDiscordTransport();
    const inbox = new MemoryDiscordEventInbox();
    const ch = new DiscordChannel({
      transport: t,
      inbound_grants: [{ guild_id: null, channel_id: "777", user_id: "888" }],
      inbox,
      log: () => {},
    });
    await ch.start(async () => { throw new Error("synthetic handler failure"); });
    await expect(t.emitInbound({
      channel_id: "777",
      user_id: "888",
      user_display: "bob",
      text: "hi",
      message_id: "1001",
      is_dm: true,
      is_mention: false,
    })).rejects.toThrow("synthetic handler failure");
    expect(inbox.events.get("1001")?.delivery_state).toBe("outcome_unknown");
    await ch.stop();
  });

  it("rejects inbound delivery when owner grants or durable admission are absent", async () => {
    const t = new FakeDiscordTransport();
    let received = 0;
    const ch = new DiscordChannel({ transport: t, log: () => {} });
    await ch.start(async () => { received++; });
    await t.emitInbound({
      channel_id: "777", user_id: "888", user_display: "bob", text: "hi", message_id: "1002",
      is_dm: true, is_mention: false,
    });
    expect(received).toBe(0);
    await ch.stop();
  });

  it("send() posts via transport and reports message_id", async () => {
    const t = new FakeDiscordTransport();
    const ch = new DiscordChannel({ transport: t, log: () => {} });
    await ch.start(async () => {});

    const r = await ch.send(
      { channel: "discord", target: "777", content: "ok" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(true);
    expect(r.external_id).toBe("mid-1");
    expect(t.posted).toEqual([{ channel: "777", text: "ok" }]);
    await ch.stop();
  });

  it("send() surfaces transport failure", async () => {
    const t = new FakeDiscordTransport();
    t.nextPostFails = "missing_access";
    const ch = new DiscordChannel({ transport: t, log: () => {} });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "discord", target: "777", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("missing_access");
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("missing_access");
    expect(r.next_action).toContain("DISCORD_LIVE_TARGET");
    await ch.stop();
  });

  it("transport.start failure falls back to silent", async () => {
    const failing: DiscordTransport = {
      start: async () => {
        throw new Error("token_invalid");
      },
      stop: async () => {},
      postMessage: async () => ({ ok: false, error: "x" }),
      getBotUserId: () => undefined,
    };
    const lines: string[] = [];
    const ch = new DiscordChannel({ transport: failing, log: (l) => lines.push(l) });
    await ch.start(async () => {});
    expect(ch.isSilent()).toBe(true);
    expect(lines.some((l) => l.includes("token_invalid"))).toBe(true);
    await ch.stop();
  });
});

describe("DiscordChannel — retry / backoff", () => {
  it("retries on rate-limit hint, then succeeds", async () => {
    const t = new FakeDiscordTransport();
    let calls = 0;
    t.postMessage = async (): Promise<DiscordPostResult> => {
      calls++;
      if (calls < 3) {
        return { ok: false, error: "rate_limited", retry_after_ms: 150 };
      }
      return { ok: true, message_id: `mid-${calls}` };
    };
    const sleeps: number[] = [];
    const ch = new DiscordChannel({
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
      { channel: "discord", target: "777", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([150, 150]);
    await ch.stop();
  });

  it("does not retry permanent errors (e.g. missing_access)", async () => {
    const t = new FakeDiscordTransport();
    let calls = 0;
    t.postMessage = async (): Promise<DiscordPostResult> => {
      calls++;
      return { ok: false, error: "missing_access" };
    };
    const ch = new DiscordChannel({
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
      { channel: "discord", target: "Cbad", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(calls).toBe(1);
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("missing_access");
    await ch.stop();
  });

  it("retry: false disables retries", async () => {
    const t = new FakeDiscordTransport();
    let calls = 0;
    t.postMessage = async (): Promise<DiscordPostResult> => {
      calls++;
      return { ok: false, error: "rate_limited", retry_after_ms: 50 };
    };
    const ch = new DiscordChannel({ transport: t, log: () => {}, retry: false });
    await ch.start(async () => {});
    const r = await ch.send(
      { channel: "discord", target: "777", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(r.delivered).toBe(false);
    expect(calls).toBe(1);
    expect(r.error_kind).toBe("recoverable");
    expect(r.error_code).toBe("rate_limited");
    expect(r.retry_after_ms).toBe(50);
    expect(r.next_action).toContain("recoverable");
    await ch.stop();
  });

  it("does not retry after task cancellation", async () => {
    const t = new FakeDiscordTransport();
    const controller = new AbortController();
    let calls = 0;
    t.postMessage = async (): Promise<DiscordPostResult> => {
      calls++;
      controller.abort();
      return { ok: false, error: "rate_limited", retry_after_ms: 1 };
    };
    const ch = new DiscordChannel({ transport: t, log: () => {}, retry: {
      max_retries: 3, base_delay_ms: 0, max_delay_ms: 1, jitter_ratio: 0,
      sleep: async () => {}, random: () => 0.5,
    } });
    await ch.start(async () => {});
    const r = await ch.send({ channel: "discord", target: "777", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" }, { signal: controller.signal });
    expect(r.delivered).toBe(false);
    expect(calls).toBe(1);
    await ch.stop();
  });
});
