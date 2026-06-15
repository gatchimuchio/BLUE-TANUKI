import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  LineChannel,
  type LineInboundHandler,
  type LineInboundMessage,
  type LinePostResult,
  type LineTransport,
} from "../src/index.js";

class FakeLineTransport implements LineTransport {
  handler: LineInboundHandler | null = null;
  posted: Array<{ target: string; text: string }> = [];
  nextPostFails: string | null = null;

  async start(handler: LineInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: { target: string; text: string }): Promise<LinePostResult> {
    if (this.nextPostFails) {
      const error = this.nextPostFails;
      this.nextPostFails = null;
      return { ok: false, error };
    }
    this.posted.push({ ...args });
    return { ok: true, request_id: `line-req-${this.posted.length}` };
  }

  async emit(message: LineInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("transport not started");
    await this.handler(message);
  }
}

describe("LineChannel", () => {
  it("starts silently and fails closed when no token or transport is configured", async () => {
    const channel = new LineChannel({ log: () => undefined });
    await channel.start(async () => undefined);
    try {
      expect(channel.isSilent()).toBe(true);
      const result = await channel.send(
        { channel: "line", target: "U123", content: "x" },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "line_not_configured",
      });
    } finally {
      await channel.stop();
    }
  });

  it("normalizes injected inbound messages without authority metadata", async () => {
    const transport = new FakeLineTransport();
    const channel = new LineChannel({ transport, log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit({
        source_type: "user",
        source_id: "U123",
        user_id: "U123",
        user_display: "alice",
        text: "hello line",
        message_id: "msg-1",
        reply_token: "reply-token",
        webhook_event_id: "event-1",
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "line",
        user: "alice",
        content: "hello line",
      });
      expect(received[0]!.metadata?.reply_to).toBe("U123");
      expect(received[0]!.metadata).not.toHaveProperty("blue_tanuki.authority_context");
    } finally {
      await channel.stop();
    }
  });

  it("sends through transport and classifies permanent failures", async () => {
    const transport = new FakeLineTransport();
    const channel = new LineChannel({ transport, log: () => undefined });
    await channel.start(async () => undefined);
    try {
      const sent = await channel.send(
        { channel: "line", target: "U123", content: "reply" },
        { command_id: "cmd-1", upstream_commit_hash: "hash" },
      );
      expect(sent).toMatchObject({ delivered: true, external_id: "line-req-1" });
      expect(transport.posted).toEqual([{ target: "U123", text: "reply" }]);

      transport.nextPostFails = "line_http_403";
      const failed = await channel.send(
        { channel: "line", target: "U123", content: "reply" },
        { command_id: "cmd-2", upstream_commit_hash: "hash" },
      );
      expect(failed.delivered).toBe(false);
      expect(failed.error_kind).toBe("non_recoverable");
      expect(failed.next_action).toContain("LINE");
    } finally {
      await channel.stop();
    }
  });

  it("Messaging API transport uses fixed push endpoint", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null; has_signal: boolean }> = [];
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      log: () => undefined,
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
          auth: new Headers(init?.headers).get("authorization"),
          has_signal: init?.signal instanceof AbortSignal,
        });
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "x-line-request-id": "REQ-1" },
        });
      },
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(
        { channel: "line", target: "U123", content: "hello" },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({ delivered: true, external_id: "REQ-1" });
      expect(calls).toEqual([
        {
          url: "https://api.line.me/v2/bot/message/push",
          body: { to: "U123", messages: [{ type: "text", text: "hello" }] },
          auth: "Bearer secret-line-token",
          has_signal: true,
        },
      ]);
      expect(JSON.stringify(channel.getHistory())).not.toContain("secret-line-token");
    } finally {
      await channel.stop();
    }
  });

  it("classifies Messaging API HTTP timeout as recoverable", async () => {
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      request_timeout_ms: 1,
      retry: false,
      log: () => undefined,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(
        { channel: "line", target: "U123", content: "hello" },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({
        delivered: false,
        error_kind: "recoverable",
        error_code: "line_timeout",
      });
    } finally {
      await channel.stop();
    }
  });

  it("retries recoverable rate-limit responses", async () => {
    const transport = new FakeLineTransport();
    let calls = 0;
    transport.postMessage = async (): Promise<LinePostResult> => {
      calls += 1;
      if (calls < 3) return { ok: false, error: "rate_limited", retry_after_ms: 25 };
      return { ok: true, request_id: "done" };
    };
    const sleeps: number[] = [];
    const channel = new LineChannel({
      transport,
      log: () => undefined,
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
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(
        { channel: "line", target: "U123", content: "x" },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({ delivered: true, external_id: "done" });
      expect(calls).toBe(3);
      expect(sleeps).toEqual([25, 25]);
    } finally {
      await channel.stop();
    }
  });
});
