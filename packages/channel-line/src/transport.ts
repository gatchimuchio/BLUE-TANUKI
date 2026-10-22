import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChannelDeliveryErrorKind } from "@blue-tanuki/channel-base";

export type LineFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LineInboundMessage {
  destination: string;
  source_type: "user" | "group" | "room";
  source_id: string;
  user_id?: string;
  text: string;
  message_id: string;
  webhook_event_id: string;
  event_timestamp_ms: number;
  is_redelivery: boolean;
}

export type LineInboundHandler = (m: LineInboundMessage) => Promise<void>;

export interface LinePostResult {
  ok: boolean;
  delivery_status?: "delivered" | "not_delivered" | "unknown";
  request_id?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  retry_after_ms?: number;
  rate_limit_rejected?: true;
  retry_after_invalid?: true;
  /** The same immutable request may be retried with its X-Line-Retry-Key. */
  idempotent_retryable?: true;
}

export type LineOutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";

export interface LineOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: "line";
  readonly target: string;
  readonly text: string;
  readonly expires_at_ms: number;
}

export interface LineOutboundDeliveryClaim extends LineOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}

export interface LinePendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}

export interface LineOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: LineOutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly expires_at_ms: number;
  readonly retry_after_ms?: number;
  readonly external_request_id?: string;
  readonly error_code?: string;
}

/** Gateway-owned durable outbox. Reply text is retained only while delivery is pending. */
export interface LineOutboundDeliveryStore {
  enqueue(input: LineOutboundDeliveryInput, now_ms?: number): void;
  pending(now_ms?: number): readonly LinePendingDelivery[];
  claimDelivery(delivery_id: string, now_ms?: number): LineOutboundDeliveryClaim | null;
  scheduleRetry(delivery_id: string, not_before_ms: number, retry_after_ms?: number, now_ms?: number,
    error_code?: "rate_limited" | "server_retry"): void;
  settleDelivery(
    delivery_id: string,
    state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result?: { readonly external_request_id?: string; readonly error_code?: string; readonly retry_after_ms?: number },
    now_ms?: number,
  ): void;
  cancelPending(delivery_id: string, now_ms?: number): void;
  abandonPending(
    delivery_id: string,
    state: "not_delivered" | "outcome_unknown",
    error_code: string,
    now_ms?: number,
  ): void;
  status(delivery_id: string): LineOutboundDeliveryStatus | null;
}

export interface LineTransport {
  start(handler: LineInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: { target: string; text: string; retry_key: string }, signal?: AbortSignal): Promise<LinePostResult>;
}

interface LineMessagingTransportOptions {
  channel_access_token?: string;
  channel_secret?: string;
  channel_destination?: string;
  webhook_host?: string;
  webhook_port?: number;
  webhook_route?: string;
  log?: (line: string) => void;
  fetch?: LineFetch;
  request_timeout_ms?: number;
}

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const DEFAULT_LINE_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LINE_WEBHOOK_HOST = "127.0.0.1";
const DEFAULT_LINE_WEBHOOK_PORT = 3980;
const DEFAULT_LINE_WEBHOOK_ROUTE = "/webhooks/line";
const MAX_LINE_WEBHOOK_BODY_BYTES = 1_048_576;
const LINE_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const LINE_WEBHOOK_EVENT_ID_PATTERN = /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/iu;
const SAFE_LINE_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;

class LineWebhookBodyTooLarge extends Error {}

export class LineMessagingTransport implements LineTransport {
  private server: Server | null = null;
  private listeningPort: number | null = null;

  constructor(private readonly opts: LineMessagingTransportOptions) {
    if (Boolean(opts.channel_secret) !== Boolean(opts.channel_destination)) {
      throw new Error("line_webhook_secret_and_destination_must_be_configured_together");
    }
    validateWebhookOptions(opts);
  }

  async start(handler: LineInboundHandler): Promise<void> {
    if (this.server || !this.opts.channel_secret || !this.opts.channel_destination) return;

    const server = createServer((request, response) => {
      void this.handleWebhook(request, response, handler).catch(() => {
        this.opts.log?.("[line] webhook request processing failed");
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendWebhookResponse(response, 500, "line_webhook_processing_failed");
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 64;
    server.on("error", () => this.opts.log?.("[line] webhook listener error"));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(
        this.opts.webhook_port ?? DEFAULT_LINE_WEBHOOK_PORT,
        this.opts.webhook_host ?? DEFAULT_LINE_WEBHOOK_HOST,
      );
    });
    this.server = server;
    const address = server.address();
    this.listeningPort = address && typeof address === "object" ? address.port : null;
    this.opts.log?.(`[line] signed webhook listener active host=${this.opts.webhook_host ?? DEFAULT_LINE_WEBHOOK_HOST} port=${this.listeningPort ?? "unknown"}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  getListeningPort(): number | null {
    return this.listeningPort;
  }

  async postMessage(args: { target: string; text: string; retry_key: string }, callerSignal?: AbortSignal): Promise<LinePostResult> {
    if (!args.target.trim()) {
      return {
        ok: false,
        delivery_status: "not_delivered",
        error: "missing_line_target",
        error_kind: "non_recoverable",
        error_code: "missing_line_target",
      };
    }
    if (!this.opts.channel_access_token?.trim()) {
      return {
        ok: false,
        delivery_status: "not_delivered",
        error: "line_channel_access_token_unset",
        error_kind: "non_recoverable",
        error_code: "line_not_configured",
      };
    }
    if (!isRetryKey(args.retry_key)) {
      return { ok: false, delivery_status: "not_delivered", error: "line_retry_key_invalid",
        error_kind: "non_recoverable", error_code: "retry_key_invalid" };
    }
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      return {
        ok: false,
        delivery_status: "not_delivered",
        error: "fetch_unavailable",
        error_kind: "non_recoverable",
        error_code: "fetch_unavailable",
      };
    }
    const timeoutMs = this.opts.request_timeout_ms ?? DEFAULT_LINE_REQUEST_TIMEOUT_MS;
    if (callerSignal?.aborted) {
      return { ok: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
        error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
    }
    const controller = new AbortController();
    let abortSource: "caller" | "timeout" | undefined;
    const abortForCaller = (): void => {
      if (abortSource !== undefined) return;
      abortSource = "caller";
      controller.abort();
    };
    if (callerSignal) {
      callerSignal.addEventListener("abort", abortForCaller, { once: true });
      if (callerSignal.aborted) {
        callerSignal.removeEventListener("abort", abortForCaller);
        return { ok: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
          error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
      }
    }
    const timer = setTimeout(() => {
      if (abortSource !== undefined) return;
      abortSource = "timeout";
      controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(LINE_PUSH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.channel_access_token}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-line-retry-key": args.retry_key,
        },
        body: JSON.stringify({
          to: args.target,
          messages: [{ type: "text", text: args.text }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (abortSource === "caller") {
        return { ok: false, delivery_status: "unknown", error: "caller_cancelled_after_ambiguous_send",
          error_kind: "non_recoverable", error_code: "caller_cancelled_after_ambiguous_send" };
      }
      if (abortSource === "timeout") {
        return {
          ok: false,
          delivery_status: "unknown",
          error: `line_timeout_${timeoutMs}ms`,
          error_kind: "recoverable",
          error_code: "line_timeout",
          idempotent_retryable: true,
        };
      }
      if (isAbortError(error)) {
        return { ok: false, delivery_status: "unknown", error: "line_abort_outcome_unknown",
          error_kind: "non_recoverable", error_code: "line_abort_outcome_unknown" };
      }
      return { ok: false, delivery_status: "unknown", error: "line_network_outcome_unknown",
        error_kind: "recoverable", error_code: "line_network_error", idempotent_retryable: true };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortForCaller);
    }
    const requestId =
      res.headers.get("x-line-request-id") ??
      res.headers.get("x-request-id") ??
      undefined;
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, delivery_status: "delivered", request_id: requestId };
    }
    const acceptedRequestId = res.headers.get("x-line-accepted-request-id") ?? undefined;
    if (res.status === 409 && acceptedRequestId && isSafeRequestId(acceptedRequestId)) {
      return { ok: true, delivery_status: "delivered", request_id: acceptedRequestId };
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = parseJsonObject(await res.text());
    } catch {
      // HTTP status and headers already establish the delivery classification.
    }
    const retryAfterHeader = res.status === 429 ? res.headers.get("retry-after") : null;
    const retryAfter = parseRetryAfter(retryAfterHeader);
    return {
      ok: false,
      delivery_status: res.status === 429 || res.status < 500 ? "not_delivered" : "unknown",
      request_id: requestId,
      error: lineError(res.status, parsed),
      ...(res.status === 429 ? {
        rate_limit_rejected: true as const,
        ...(retryAfterHeader !== null && !retryAfter.valid ? { retry_after_invalid: true as const } : {}),
        ...(retryAfter.valid ? { retry_after_ms: retryAfter.retry_after_ms } : {}),
        error_code: "rate_limited",
      } : {
        error_code: `line_http_${res.status}`,
        ...(res.status === 500 ? { idempotent_retryable: true as const } : {}),
      }),
    };
  }

  private async handleWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    handler: LineInboundHandler,
  ): Promise<void> {
    const route = this.opts.webhook_route ?? DEFAULT_LINE_WEBHOOK_ROUTE;
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (requestPath !== route) {
      sendWebhookResponse(response, 404, "not_found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendWebhookResponse(response, 405, "method_not_allowed");
      return;
    }
    if (mediaType(request.headers["content-type"]) !== "application/json") {
      sendWebhookResponse(response, 415, "application_json_required");
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(request, MAX_LINE_WEBHOOK_BODY_BYTES);
    } catch (error) {
      request.resume();
      sendWebhookResponse(response, error instanceof LineWebhookBodyTooLarge ? 413 : 400, "invalid_webhook_body");
      return;
    }

    const signature = request.headers["x-line-signature"];
    if (typeof signature !== "string" || !verifyLineSignature(rawBody, signature, this.opts.channel_secret!)) {
      this.opts.log?.("[line] rejected webhook with invalid signature");
      sendWebhookResponse(response, 401, "invalid_signature");
      return;
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
    } catch {
      sendWebhookResponse(response, 400, "invalid_webhook_json");
      return;
    }
    if (!isRecord(envelope) || !isSafeLineIdentifier(envelope.destination) || !Array.isArray(envelope.events)) {
      sendWebhookResponse(response, 400, "invalid_webhook_envelope");
      return;
    }
    if (envelope.destination !== this.opts.channel_destination) {
      this.opts.log?.("[line] rejected webhook with unexpected destination");
      sendWebhookResponse(response, 403, "unexpected_destination");
      return;
    }
    if (envelope.events.length > 500) {
      sendWebhookResponse(response, 413, "too_many_webhook_events");
      return;
    }

    // LINE's verification request is a valid signed envelope with no events.
    for (const event of envelope.events) {
      const message = lineTextMessageFromEvent(envelope.destination, event);
      if (message) await handler(message);
    }
    sendWebhookResponse(response, 200, "ok");
  }
}

export function verifyLineSignature(rawBody: Uint8Array, signature: string, channelSecret: string): boolean {
  if (!LINE_SIGNATURE_PATTERN.test(signature)) return false;
  const received = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function lineTextMessageFromEvent(destination: string, input: unknown): LineInboundMessage | null {
  if (!isRecord(input) || input.type !== "message" || !isRecord(input.message) || input.message.type !== "text" ||
      !isRecord(input.source) || !isRecord(input.deliveryContext)) return null;
  const message = input.message;
  const source = input.source;
  const sourceType = source.type;
  const sourceId = sourceType === "user" ? source.userId : sourceType === "group" ? source.groupId : sourceType === "room" ? source.roomId : undefined;
  const userId = source.userId;
  if ((sourceType !== "user" && sourceType !== "group" && sourceType !== "room") ||
      !isSafeLineIdentifier(sourceId) || !isSafeLineIdentifier(userId) ||
      !isSafeLineIdentifier(message.id) || typeof message.text !== "string" ||
      message.text.length === 0 || message.text.length > 5000 ||
      typeof input.webhookEventId !== "string" || !LINE_WEBHOOK_EVENT_ID_PATTERN.test(input.webhookEventId) ||
      !Number.isSafeInteger(input.timestamp) || (input.timestamp as number) <= 0 ||
      typeof input.deliveryContext.isRedelivery !== "boolean") return null;
  if (sourceType === "user" && sourceId !== userId) return null;
  return {
    destination,
    source_type: sourceType,
    source_id: sourceId,
    user_id: userId,
    text: message.text,
    message_id: message.id,
    webhook_event_id: input.webhookEventId as string,
    event_timestamp_ms: input.timestamp as number,
    is_redelivery: input.deliveryContext.isRedelivery,
  };
}

function validateWebhookOptions(options: LineMessagingTransportOptions): void {
  if (options.channel_secret !== undefined &&
      (options.channel_secret.length === 0 || options.channel_secret.length > 4096)) {
    throw new Error("line_webhook_channel_secret_invalid");
  }
  if (options.channel_destination !== undefined && !isSafeLineIdentifier(options.channel_destination)) {
    throw new Error("line_webhook_destination_invalid");
  }
  if (options.webhook_host !== undefined &&
      options.webhook_host !== "127.0.0.1" && options.webhook_host !== "::1") {
    throw new Error("line_webhook_listener_host_must_be_loopback");
  }
  if (options.webhook_port !== undefined && (!Number.isSafeInteger(options.webhook_port) || options.webhook_port < 0 || options.webhook_port > 65535)) {
    throw new Error("line_webhook_port_invalid");
  }
  if (options.webhook_route !== undefined && !/^\/[A-Za-z0-9/_-]{1,127}$/u.test(options.webhook_route)) {
    throw new Error("line_webhook_route_invalid");
  }
}

function isSafeLineIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_LINE_IDENTIFIER_PATTERN.test(value) && value.trim() === value;
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) throw new LineWebhookBodyTooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function sendWebhookResponse(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: code }));
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

function parseRetryAfter(value: string | null): { readonly valid: false } |
  { readonly valid: true; readonly retry_after_ms: number } {
  if (value === null) return { valid: false };
  if (/^(?:0|[1-9]\d*)$/u.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
      return { valid: true, retry_after_ms: seconds * 1000 };
    }
    return { valid: false };
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return { valid: false };
  const delay = Math.max(0, time - Date.now());
  return Number.isSafeInteger(delay) ? { valid: true, retry_after_ms: delay } : { valid: false };
}

function isRetryKey(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
}

function isSafeRequestId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
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
