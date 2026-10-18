import { describe, it, expect, vi } from "vitest";
import type { InboundRequest, ChannelSendPayload } from "@blue-tanuki/protocol";
import {
  InboundRouter,
  OutboundDispatcher,
  classifyChannelDeliveryError,
  type InboundChannel,
  type InboundHandler,
  type OutboundChannel,
  type SendMeta,
  type SendResult,
} from "../src/index.js";

class FakeInbound implements InboundChannel {
  readonly name: string;
  private handler: InboundHandler | null = null;
  started = false;
  stopped = false;
  constructor(name: string) {
    this.name = name;
  }
  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.handler = null;
  }
  async push(req: InboundRequest): Promise<void> {
    if (!this.handler) throw new Error("not started");
    await this.handler(req);
  }
}

class FakeOutbound implements OutboundChannel {
  readonly name: string;
  readonly sent: Array<{ payload: ChannelSendPayload; meta: SendMeta }> = [];
  shouldThrow = false;
  constructor(name: string) {
    this.name = name;
  }
  async send(payload: ChannelSendPayload, meta: SendMeta): Promise<SendResult> {
    if (this.shouldThrow) throw new Error("boom");
    this.sent.push({ payload, meta });
    return { delivered: true, external_id: `${this.name}-${this.sent.length}` };
  }
}

const baseMeta: SendMeta = { command_id: "cmd-1", upstream_commit_hash: "h0" };

function inbound(channel: string, content: string, id = "r1"): InboundRequest {
  return { id, channel, user: "u1", content, timestamp: Date.now() };
}

describe("channel delivery error classification", () => {
  it("classifies rate limits as recoverable and permission/config errors as non-recoverable", () => {
    expect(
      classifyChannelDeliveryError({
        error: "ratelimited",
        retry_after_ms: 250,
      }),
    ).toMatchObject({
      error_kind: "recoverable",
      error_code: "rate_limited",
      retry_after_ms: 250,
    });
    expect(
      classifyChannelDeliveryError({ error: "missing_access" }),
    ).toMatchObject({
      error_kind: "non_recoverable",
      error_code: "missing_access",
    });
  });
});

describe("InboundRouter", () => {
  it("multiplexes channels into a single handler", async () => {
    const router = new InboundRouter();
    const a = new FakeInbound("a");
    const b = new FakeInbound("b");
    router.register(a);
    router.register(b);

    const seen: string[] = [];
    await router.start(async (req) => {
      seen.push(`${req.channel}:${req.content}`);
    });

    await a.push(inbound("a", "x", "r1"));
    await b.push(inbound("b", "y", "r2"));

    expect(seen).toEqual(["a:x", "b:y"]);
    expect(a.started).toBe(true);
    expect(b.started).toBe(true);
  });

  it("rejects duplicate channel registration", () => {
    const router = new InboundRouter();
    router.register(new FakeInbound("a"));
    expect(() => router.register(new FakeInbound("a"))).toThrow(/already/);
  });

  it("rejects register after start", async () => {
    const router = new InboundRouter();
    router.register(new FakeInbound("a"));
    await router.start(async () => {});
    expect(() => router.register(new FakeInbound("b"))).toThrow(/after start/);
    await router.stop();
  });

  it("contains handler exceptions so the channel keeps running", async () => {
    const router = new InboundRouter();
    const a = new FakeInbound("a");
    router.register(a);
    await router.start(async () => {
      throw new Error("handler-failed");
    });
    // Must not throw at the channel level.
    await expect(a.push(inbound("a", "x"))).resolves.toBeUndefined();
    await router.stop();
  });

  it("propagates failures only for explicitly configured channels and hides details from scheduler errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = new InboundRouter({ propagateHandlerErrorsForChannels: ["cron"] });
    const cron = new FakeInbound("cron");
    const webchat = new FakeInbound("webchat");
    router.register(cron);
    router.register(webchat);
    await router.start(async () => {
      throw new Error("private synthetic failure detail");
    });

    try {
      await expect(webchat.push(inbound("webchat", "safe"))).resolves.toBeUndefined();
      await expect(cron.push(inbound("cron", "safe"))).rejects.toThrow("inbound_handler_failed");
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      await router.stop();
      errorSpy.mockRestore();
    }
  });

  it("stops all channels", async () => {
    const router = new InboundRouter();
    const a = new FakeInbound("a");
    const b = new FakeInbound("b");
    router.register(a);
    router.register(b);
    await router.start(async () => {});
    await router.stop();
    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(true);
  });
});

describe("OutboundDispatcher", () => {
  it("dispatches by payload.channel", async () => {
    const d = new OutboundDispatcher();
    const slack = new FakeOutbound("slack");
    const discord = new FakeOutbound("discord");
    d.register(slack);
    d.register(discord);

    const r = await d.dispatch(
      { channel: "slack", target: "#ops", content: "hi" },
      baseMeta,
    );
    expect(r.delivered).toBe(true);
    expect(slack.sent).toHaveLength(1);
    expect(discord.sent).toHaveLength(0);
  });

  it("returns structured failure for unknown channel (no throw)", async () => {
    const d = new OutboundDispatcher();
    const r = await d.dispatch(
      { channel: "telegram", target: "x", content: "y" },
      baseMeta,
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/no_channel_registered/);
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("no_channel_registered");
    expect(r.next_action).toContain("telegram");
  });

  it("captures channel exceptions as failure result", async () => {
    const d = new OutboundDispatcher();
    const slack = new FakeOutbound("slack");
    slack.shouldThrow = true;
    d.register(slack);

    const r = await d.dispatch(
      { channel: "slack", target: "x", content: "y" },
      baseMeta,
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe("boom");
    expect(r.error_kind).toBe("non_recoverable");
    expect(r.error_code).toBe("boom");
    expect(r.next_action).toContain("Inspect");
  });

  it("rejects duplicate registration", () => {
    const d = new OutboundDispatcher();
    d.register(new FakeOutbound("slack"));
    expect(() => d.register(new FakeOutbound("slack"))).toThrow(/already/);
  });

  it("propagates upstream_commit_hash via SendMeta", async () => {
    const d = new OutboundDispatcher();
    const slack = new FakeOutbound("slack");
    d.register(slack);
    await d.dispatch(
      { channel: "slack", target: "#x", content: "y" },
      { command_id: "c1", upstream_commit_hash: "deadbeef" },
    );
    expect(slack.sent[0]!.meta.upstream_commit_hash).toBe("deadbeef");
  });
});
