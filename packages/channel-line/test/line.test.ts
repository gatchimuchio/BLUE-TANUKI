import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  LineChannel,
  type LineInboundHandler,
  type LineInboundMessage,
  type LineInboundEventInbox,
  type LineInboundGrant,
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

class FakeLineInbox implements LineInboundEventInbox {
  readonly settled: Array<{ eventId: string; payloadDigest: string; state: "handler_returned" | "outcome_unknown" }> = [];
  claim(): { status: "accepted" } { return { status: "accepted" }; }
  settle(eventId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown"): void {
    this.settled.push({ eventId, payloadDigest, state });
  }
}

const LINE_DESTINATION = "Ubot-destination";
const LINE_EVENT_ID = "01FZ74A0TDDPYRVKNK77XKC3ZR";
const LINE_GRANT: LineInboundGrant = {
  destination: LINE_DESTINATION,
  source_type: "user",
  source_id: "U123",
  user_id: "U123",
};

function lineMessage(overrides: Partial<LineInboundMessage> = {}): LineInboundMessage {
  return {
    destination: LINE_DESTINATION,
    source_type: "user",
    source_id: "U123",
    user_id: "U123",
    text: "hello line",
    message_id: "msg-1",
    webhook_event_id: LINE_EVENT_ID,
    event_timestamp_ms: 1_700_000_000_000,
    is_redelivery: false,
    ...overrides,
  };
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
    const inbox = new FakeLineInbox();
    const channel = new LineChannel({
      transport,
      channel_destination: LINE_DESTINATION,
      inbound_grants: [LINE_GRANT],
      inbox,
      log: () => undefined,
    });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit(lineMessage());
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "line",
        user: expect.stringMatching(/^line:[a-f0-9]{64}$/u),
        content: "hello line",
        timestamp: 1_700_000_000_000,
      });
      expect(received[0]!.metadata?.reply_to).toBe("U123");
      expect(received[0]!.metadata).not.toHaveProperty("blue_tanuki.authority_context");
      expect(received[0]!.metadata).not.toHaveProperty("line_reply_token");
      expect(inbox.settled).toMatchObject([{ eventId: LINE_EVENT_ID, state: "handler_returned" }]);
    } finally {
      await channel.stop();
    }
  });

  it("does not forward an ungranted identity or a group event with no user identity", async () => {
    const transport = new FakeLineTransport();
    const inbox = new FakeLineInbox();
    const received: InboundRequest[] = [];
    const channel = new LineChannel({
      transport,
      channel_destination: LINE_DESTINATION,
      inbound_grants: [LINE_GRANT],
      inbox,
      log: () => undefined,
    });
    await channel.start(async (request) => { received.push(request); });
    try {
      await transport.emit(lineMessage({ user_id: "U999", source_id: "U999" }));
      await transport.emit(lineMessage({ source_type: "group", source_id: "Cgroup", user_id: undefined }));
      expect(received).toEqual([]);
      expect(inbox.settled).toEqual([]);
    } finally {
      await channel.stop();
    }
  });

  it("settles a failed Gateway consumer as outcome-unknown and propagates a redacted error", async () => {
    const transport = new FakeLineTransport();
    const inbox = new FakeLineInbox();
    const channel = new LineChannel({
      transport,
      channel_destination: LINE_DESTINATION,
      inbound_grants: [LINE_GRANT],
      inbox,
      log: () => undefined,
    });
    await channel.start(async () => { throw new Error("private handler details"); });
    try {
      await expect(transport.emit(lineMessage())).rejects.toThrow("line_inbound_handler_failed");
      expect(inbox.settled).toMatchObject([{ eventId: LINE_EVENT_ID, state: "outcome_unknown" }]);
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

  it("aborts the local LINE HTTP request when the execution is cancelled", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      retry: false,
      log: () => undefined,
      fetch: async (_input, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    await channel.start(async () => undefined);
    try {
      const sending = channel.send({ channel: "line", target: "U123", content: "hello" },
        { command_id: "cmd", upstream_commit_hash: "hash" }, { signal: controller.signal });
      await requestStarted;
      controller.abort();
      const result = await sending;
      expect(requestSignal?.aborted).toBe(true);
      expect(result.delivered).toBe(false);
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

  it("does not retry after task cancellation", async () => {
    const transport = new FakeLineTransport();
    const controller = new AbortController();
    let calls = 0;
    transport.postMessage = async (): Promise<LinePostResult> => {
      calls++;
      controller.abort();
      return { ok: false, error: "rate_limited", retry_after_ms: 1 };
    };
    const channel = new LineChannel({ transport, log: () => {}, retry: {
      max_retries: 3, base_delay_ms: 0, max_delay_ms: 1, jitter_ratio: 0,
      sleep: async () => {}, random: () => 0.5,
    } });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send({ channel: "line", target: "U123", content: "hello" },
        { command_id: "cmd", upstream_commit_hash: "hash" }, { signal: controller.signal });
      expect(result.delivered).toBe(false);
      expect(calls).toBe(1);
    } finally {
      await channel.stop();
    }
  });
});
