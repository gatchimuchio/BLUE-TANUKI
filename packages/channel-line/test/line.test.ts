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
  type LineOutboundDeliveryInput,
  type LineOutboundDeliveryClaim,
  type LineOutboundDeliveryState,
  type LineOutboundDeliveryStatus,
  type LinePendingDelivery,
  type LineOutboundDeliveryStore,
} from "../src/index.js";

class FakeLineTransport implements LineTransport {
  handler: LineInboundHandler | null = null;
  posted: Array<{ target: string; text: string; retry_key: string }> = [];
  nextPostFails: string | null = null;

  async start(handler: LineInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: { target: string; text: string; retry_key: string }): Promise<LinePostResult> {
    if (this.nextPostFails) {
      const error = this.nextPostFails;
      this.nextPostFails = null;
      return { ok: false, delivery_status: "not_delivered", error };
    }
    this.posted.push({ ...args });
    return { ok: true, delivery_status: "delivered", request_id: `line-req-${this.posted.length}` };
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

class FakeLineDeliveryStore implements LineOutboundDeliveryStore {
  lastDeliveryId: string | null = null;
  private readonly rows = new Map<string, {
    input: LineOutboundDeliveryInput;
    payload_digest: string;
    delivery_state: LineOutboundDeliveryState;
    attempt_count: number;
    not_before_ms: number;
    retry_after_ms?: number;
    external_request_id?: string;
    error_code?: string;
  }>();

  enqueue(input: LineOutboundDeliveryInput, nowMs = Date.now()): void {
    this.lastDeliveryId = input.delivery_id;
    this.rows.set(input.delivery_id, { input, payload_digest: "a".repeat(64), delivery_state: "queued",
      attempt_count: 0, not_before_ms: nowMs });
  }
  pending(): readonly LinePendingDelivery[] {
    return [...this.rows.values()].filter((row) => row.delivery_state === "queued" || row.delivery_state === "retry_wait")
      .map((row) => ({ delivery_id: row.input.delivery_id,
        delivery_state: row.delivery_state as "queued" | "retry_wait", not_before_ms: row.not_before_ms }));
  }
  claimDelivery(deliveryId: string, nowMs = Date.now()): LineOutboundDeliveryClaim | null {
    const row = this.rows.get(deliveryId);
    if (!row || (row.delivery_state !== "queued" && row.delivery_state !== "retry_wait") || row.not_before_ms > nowMs) return null;
    row.delivery_state = "dispatching";
    row.attempt_count++;
    return { ...row.input, payload_digest: row.payload_digest, attempt_count: row.attempt_count };
  }
  scheduleRetry(deliveryId: string, notBefore: number, retryAfter?: number): void {
    const row = this.rows.get(deliveryId)!;
    row.delivery_state = "retry_wait";
    row.not_before_ms = notBefore;
    row.retry_after_ms = retryAfter;
  }
  settleDelivery(deliveryId: string, state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result: { external_request_id?: string; error_code?: string; retry_after_ms?: number } = {}): void {
    const row = this.rows.get(deliveryId)!;
    row.delivery_state = state;
    row.external_request_id = result.external_request_id;
    row.error_code = result.error_code;
    row.retry_after_ms = result.retry_after_ms;
    row.input = { ...row.input, target: "", text: "" };
  }
  cancelPending(deliveryId: string): void {
    const row = this.rows.get(deliveryId);
    if (row && (row.delivery_state === "queued" || row.delivery_state === "retry_wait")) {
      this.settleDelivery(deliveryId, "not_delivered", { error_code: "cancelled_before_retry" });
    }
  }
  abandonPending(deliveryId: string, state: "not_delivered" | "outcome_unknown", errorCode: string): void {
    this.settleDelivery(deliveryId, state, { error_code: errorCode });
  }
  status(deliveryId: string): LineOutboundDeliveryStatus | null {
    const row = this.rows.get(deliveryId);
    if (!row) return null;
    return { delivery_id: deliveryId, payload_digest: row.payload_digest, delivery_state: row.delivery_state,
      attempt_count: row.attempt_count, not_before_ms: row.not_before_ms, expires_at_ms: row.input.expires_at_ms,
      ...(row.retry_after_ms === undefined ? {} : { retry_after_ms: row.retry_after_ms }),
      ...(row.external_request_id === undefined ? {} : { external_request_id: row.external_request_id }),
      ...(row.error_code === undefined ? {} : { error_code: row.error_code }) };
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
      delivery_store: new FakeLineDeliveryStore(),
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
      delivery_store: new FakeLineDeliveryStore(),
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
      delivery_store: new FakeLineDeliveryStore(),
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
    const channel = new LineChannel({ transport, delivery_store: new FakeLineDeliveryStore(), log: () => undefined });
    await channel.start(async () => undefined);
    try {
      const sent = await channel.send(
        { channel: "line", target: "U123", content: "reply" },
        { command_id: "cmd-1", upstream_commit_hash: "hash" },
      );
      expect(sent).toMatchObject({ delivered: true, external_id: "line-req-1" });
      expect(transport.posted).toMatchObject([{ target: "U123", text: "reply", retry_key: expect.stringMatching(/^[a-f0-9-]{36}$/u) }]);

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
    const calls: Array<{ url: string; body: unknown; auth: string | null; retry_key: string | null; has_signal: boolean }> = [];
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      delivery_store: new FakeLineDeliveryStore(),
      log: () => undefined,
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
          auth: new Headers(init?.headers).get("authorization"),
          retry_key: new Headers(init?.headers).get("x-line-retry-key"),
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
          retry_key: expect.stringMatching(/^[a-f0-9-]{36}$/u),
          has_signal: true,
        },
      ]);
      expect(JSON.stringify(channel.getHistory())).not.toContain("secret-line-token");
    } finally {
      await channel.stop();
    }
  });

  it("treats the accepted-request id on a retry-key 409 as the original delivery", async () => {
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      delivery_store: new FakeLineDeliveryStore(),
      log: () => undefined,
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("x-line-retry-key")).toMatch(/^[a-f0-9-]{36}$/u);
        return new Response(JSON.stringify({ message: "The retry key is already accepted" }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "x-line-request-id": "retry-attempt-id",
            "x-line-accepted-request-id": "accepted-original-id",
          },
        });
      },
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send({ channel: "line", target: "U123", content: "same payload" },
        { command_id: "cmd-retry-key", upstream_commit_hash: "hash" });
      expect(result).toMatchObject({ delivered: true, delivery_status: "delivered", external_id: "accepted-original-id" });
    } finally {
      await channel.stop();
    }
  });

  it("classifies Messaging API HTTP timeout as recoverable", async () => {
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      delivery_store: new FakeLineDeliveryStore(),
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

  it("does not retry server statuses beyond LINE's documented 500 retry case", async () => {
    let calls = 0;
    const channel = new LineChannel({
      channel_access_token: "secret-line-token",
      delivery_store: new FakeLineDeliveryStore(),
      log: () => undefined,
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 502 });
      },
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send({ channel: "line", target: "U123", content: "hello" },
        { command_id: "cmd-502", upstream_commit_hash: "hash" });
      expect(calls).toBe(1);
      expect(result).toMatchObject({ delivered: false, delivery_status: "unknown", error_code: "line_http_502" });
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
      delivery_store: new FakeLineDeliveryStore(),
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
      if (calls < 3) return { ok: false, delivery_status: "not_delivered", rate_limit_rejected: true,
        error: "rate_limited", retry_after_ms: 25 };
      return { ok: true, request_id: "done" };
    };
    const sleeps: number[] = [];
    const channel = new LineChannel({
      transport,
      delivery_store: new FakeLineDeliveryStore(),
      log: () => undefined,
      retry: {
        max_retries: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
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
      expect(sleeps).toHaveLength(2);
      expect(sleeps.every((ms) => ms > 0 && ms <= 25)).toBe(true);
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
      return { ok: false, delivery_status: "not_delivered", rate_limit_rejected: true,
        error: "rate_limited", retry_after_ms: 1 };
    };
    const channel = new LineChannel({ transport, delivery_store: new FakeLineDeliveryStore(), log: () => {}, retry: {
      max_retries: 3, sleep: async () => {},
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

  it("keeps a cancelled timeout outcome unknown instead of recording it as undelivered", async () => {
    const transport = new FakeLineTransport();
    const store = new FakeLineDeliveryStore();
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    transport.postMessage = async (_args, signal): Promise<LinePostResult> => {
      started();
      return await new Promise<LinePostResult>((resolve) => {
        signal?.addEventListener("abort", () => resolve({ ok: false, delivery_status: "unknown",
          idempotent_retryable: true, error: "line_timeout", error_code: "line_timeout" }), { once: true });
      });
    };
    const channel = new LineChannel({ transport, delivery_store: store, log: () => undefined });
    await channel.start(async () => undefined);
    try {
      const sending = channel.send({ channel: "line", target: "U123", content: "possibly accepted before timeout" },
        { command_id: "cmd-timeout", upstream_commit_hash: "hash" }, { signal: controller.signal });
      await requestStarted;
      controller.abort();
      const result = await sending;
      expect(result).toMatchObject({ delivered: false, delivery_status: "unknown", error_code: "cancelled_after_ambiguous_send" });
      expect(store.status(store.lastDeliveryId!)).toMatchObject({
        delivery_state: "outcome_unknown",
        error_code: "cancelled_after_ambiguous_send",
      });
    } finally {
      await channel.stop();
    }
  });
});
