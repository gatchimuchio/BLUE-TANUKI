import type { ChannelDeliveryErrorKind } from "@blue-tanuki/channel-base";

export type LineFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LineInboundMessage {
  source_type: "user" | "group" | "room";
  source_id: string;
  user_id?: string;
  user_display?: string;
  text: string;
  message_id: string;
  reply_token?: string;
  webhook_event_id?: string;
  is_redelivery?: boolean;
}

export type LineInboundHandler = (m: LineInboundMessage) => Promise<void>;

export interface LinePostResult {
  ok: boolean;
  request_id?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  retry_after_ms?: number;
}

export interface LineTransport {
  start(handler: LineInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: { target: string; text: string }): Promise<LinePostResult>;
}

interface LineMessagingTransportOptions {
  channel_access_token: string;
  fetch?: LineFetch;
  request_timeout_ms?: number;
}

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const DEFAULT_LINE_REQUEST_TIMEOUT_MS = 15_000;

export class LineMessagingTransport implements LineTransport {
  constructor(private readonly opts: LineMessagingTransportOptions) {}

  async start(): Promise<void> {
    // LINE webhooks require the gateway to expose an HTTP callback. This
    // transport only owns outbound push; injected transports can provide inbound.
  }

  async stop(): Promise<void> {
    // No persistent LINE connection is opened by this transport.
  }

  async postMessage(args: { target: string; text: string }): Promise<LinePostResult> {
    if (!args.target.trim()) {
      return {
        ok: false,
        error: "missing_line_target",
        error_kind: "non_recoverable",
        error_code: "missing_line_target",
      };
    }
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      return {
        ok: false,
        error: "fetch_unavailable",
        error_kind: "non_recoverable",
        error_code: "fetch_unavailable",
      };
    }
    const timeoutMs = this.opts.request_timeout_ms ?? DEFAULT_LINE_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(LINE_PUSH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.channel_access_token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          to: args.target,
          messages: [{ type: "text", text: args.text }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          error: `line_timeout_${timeoutMs}ms`,
          error_kind: "recoverable",
          error_code: "line_timeout",
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const parsed = parseJsonObject(text);
    const requestId =
      res.headers.get("x-line-request-id") ??
      res.headers.get("x-request-id") ??
      undefined;
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, request_id: requestId };
    }
    return {
      ok: false,
      request_id: requestId,
      error: lineError(res.status, parsed),
      retry_after_ms: retryAfterMs(res.headers.get("retry-after")),
    };
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function lineError(status: number, body: Record<string, unknown>): string {
  const message = readString(body, "message");
  if (message) return `line_http_${status}: ${message}`;
  return `line_http_${status}`;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const time = Date.parse(value);
  if (!Number.isNaN(time)) {
    const delta = time - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}
