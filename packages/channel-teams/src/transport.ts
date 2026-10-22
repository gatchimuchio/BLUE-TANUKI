import type { ChannelDeliveryErrorKind } from "@blue-tanuki/channel-base";

export type TeamsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TeamsConversationType = "personal" | "groupChat" | "channel";

export interface TeamsInboundMessage {
  team_id?: string;
  channel_id?: string;
  conversation_id: string;
  conversation_type: TeamsConversationType;
  user_id: string;
  text: string;
  message_id: string;
  reply_to_message_id?: string;
  tenant_id: string;
}

/** Exact owner-maintained Teams admission scope. Missing grants reject all messages. */
export interface TeamsInboundGrant {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly conversation_type: TeamsConversationType;
  readonly user_id: string;
  readonly team_id: string | null;
  readonly channel_id: string | null;
}

export type TeamsEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type TeamsEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: TeamsEventDeliveryState }
  | { readonly status: "identity_conflict" };

/** Gateway-owned durable replay boundary; implementations persist digests, never event bodies. */
export interface TeamsEventInbox {
  claim(event_id: string, payload_digest: string): TeamsEventClaim;
  settle(event_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown"): void;
}

export type TeamsInboundHandler = (m: TeamsInboundMessage) => Promise<void>;

export interface TeamsPostResult {
  ok: boolean;
  delivery_status?: "delivered" | "not_delivered" | "unknown";
  message_id?: string;
  request_id?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  retry_after_ms?: number;
  rate_limit_rejected?: true;
  retry_after_invalid?: true;
}

export type TeamsOutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";

export interface TeamsOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: "teams";
  readonly target: string;
  readonly text: string;
}

export interface TeamsOutboundDeliveryClaim extends TeamsOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}

export interface TeamsPendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}

export interface TeamsOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: TeamsOutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly retry_after_ms?: number;
  readonly external_message_id?: string;
  readonly error_code?: string;
}

/** Gateway-owned durable outbox. Raw reply payloads exist only while delivery is pending. */
export interface TeamsOutboundDeliveryStore {
  enqueue(input: TeamsOutboundDeliveryInput, now_ms?: number): void;
  pending(): readonly TeamsPendingDelivery[];
  claimDelivery(delivery_id: string, now_ms?: number): TeamsOutboundDeliveryClaim | null;
  scheduleRetry(delivery_id: string, not_before_ms: number, retry_after_ms: number, now_ms?: number): void;
  settleDelivery(
    delivery_id: string,
    state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result?: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number },
    now_ms?: number,
  ): void;
  cancelPending(delivery_id: string, now_ms?: number): void;
  status(delivery_id: string): TeamsOutboundDeliveryStatus | null;
}

export interface TeamsTransport {
  start(handler: TeamsInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: { target: string; text: string }, signal?: AbortSignal): Promise<TeamsPostResult>;
}

interface TeamsGraphTransportOptions {
  access_token: string;
  fetch?: TeamsFetch;
  request_timeout_ms?: number;
}

interface ParsedTeamsTarget {
  kind: "channel" | "channel_reply" | "chat";
  team_id?: string;
  channel_id?: string;
  message_id?: string;
  chat_id?: string;
}

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const DEFAULT_TEAMS_REQUEST_TIMEOUT_MS = 15_000;

export class TeamsGraphTransport implements TeamsTransport {
  constructor(private readonly opts: TeamsGraphTransportOptions) {}

  async start(): Promise<void> {
    // Microsoft Graph outbound send does not provide a listener by itself.
  }

  async stop(): Promise<void> {
    // No persistent Graph connection is opened by this transport.
  }

  async postMessage(args: { target: string; text: string }, callerSignal?: AbortSignal): Promise<TeamsPostResult> {
    const target = parseTeamsTarget(args.target);
    if (!target.ok) {
      return {
        ok: false,
        delivery_status: "not_delivered",
        error: target.error,
        error_kind: "non_recoverable",
        error_code: "invalid_teams_target",
      };
    }
    const path = teamsTargetPath(target.value);
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
    const timeoutMs = this.opts.request_timeout_ms ?? DEFAULT_TEAMS_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(`${GRAPH_ROOT}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.access_token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          body: {
            contentType: "text",
            content: args.text,
          },
        }),
        redirect: "error",
        signal: callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal,
      });
      text = await res.text();
    } catch (error) {
      return {
        ok: false,
        delivery_status: "unknown",
        error: isAbortError(error) ? `teams_timeout_${timeoutMs}ms` : "teams_transport_outcome_unknown",
        error_kind: "non_recoverable",
        error_code: "delivery_outcome_unknown",
      };
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseJsonObject(text);
    const requestId =
      res.headers.get("request-id") ??
      res.headers.get("client-request-id") ??
      undefined;
    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        delivery_status: "delivered",
        message_id: readString(parsed, "id") ?? requestId,
        request_id: requestId,
      };
    }
    const graphCode = `graph_http_${res.status}`;
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const retryAfter = parseRetryAfterMs(header);
      return {
        ok: false,
        delivery_status: "not_delivered",
        rate_limit_rejected: true,
        request_id: requestId,
        error: graphError(res.status, parsed),
        error_kind: "recoverable",
        error_code: "rate_limited",
        ...(retryAfter.retry_after_ms === undefined ? {} : { retry_after_ms: retryAfter.retry_after_ms }),
        ...(retryAfter.invalid ? { retry_after_invalid: true } : {}),
      };
    }
    return {
      ok: false,
      delivery_status: res.status >= 400 && res.status < 500 ? "not_delivered" : "unknown",
      request_id: requestId,
      error: graphError(res.status, parsed),
      error_kind: "non_recoverable",
      error_code: graphCode,
    };
  }
}

export function teamsChannelTarget(teamId: string, channelId: string): string {
  return `channel/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`;
}

export function teamsChannelReplyTarget(
  teamId: string,
  channelId: string,
  messageId: string,
): string {
  return `reply/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`;
}

export function teamsChatTarget(chatId: string): string {
  return `chat/${encodeURIComponent(chatId)}`;
}

function parseTeamsTarget(
  raw: string,
): { ok: true; value: ParsedTeamsTarget } | { ok: false; error: string } {
  const parts = raw.split("/");
  try {
    if (parts[0] === "channel" && parts.length === 3) {
      const teamId = decodeURIComponent(parts[1]!);
      const channelId = decodeURIComponent(parts[2]!);
      if (!isSafeTeamsIdentifier(teamId) || !isSafeTeamsIdentifier(channelId)) throw new Error("invalid target id");
      return {
        ok: true,
        value: {
          kind: "channel",
          team_id: teamId,
          channel_id: channelId,
        },
      };
    }
    if (parts[0] === "reply" && parts.length === 4) {
      const teamId = decodeURIComponent(parts[1]!);
      const channelId = decodeURIComponent(parts[2]!);
      const messageId = decodeURIComponent(parts[3]!);
      if (!isSafeTeamsIdentifier(teamId) || !isSafeTeamsIdentifier(channelId) || !isSafeTeamsIdentifier(messageId)) {
        throw new Error("invalid target id");
      }
      return {
        ok: true,
        value: {
          kind: "channel_reply",
          team_id: teamId,
          channel_id: channelId,
          message_id: messageId,
        },
      };
    }
    if (parts[0] === "chat" && parts.length === 2) {
      const chatId = decodeURIComponent(parts[1]!);
      if (!isSafeTeamsIdentifier(chatId)) throw new Error("invalid target id");
      return {
        ok: true,
        value: {
          kind: "chat",
          chat_id: chatId,
        },
      };
    }
  } catch {
    return { ok: false, error: "invalid Teams target encoding" };
  }
  return {
    ok: false,
    error:
      "invalid Teams target; use channel/<team_id>/<channel_id>, reply/<team_id>/<channel_id>/<message_id>, or chat/<chat_id> with URL-encoded ids",
  };
}

function teamsTargetPath(target: ParsedTeamsTarget): string {
  if (target.kind === "chat") {
    return `/chats/${encodeURIComponent(target.chat_id!)}/messages`;
  }
  const base =
    `/teams/${encodeURIComponent(target.team_id!)}` +
    `/channels/${encodeURIComponent(target.channel_id!)}/messages`;
  if (target.kind === "channel_reply") {
    return `${base}/${encodeURIComponent(target.message_id!)}/replies`;
  }
  return base;
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

function graphError(status: number, body: Record<string, unknown>): string {
  const error = body.error;
  if (isRecord(error)) {
    const message = readString(error, "message");
    const code = readString(error, "code");
    if (code && message) return `graph_${status}_${code}: ${message}`;
    if (message) return `graph_${status}: ${message}`;
    if (code) return `graph_${status}_${code}`;
  }
  const message = readString(body, "message");
  return message ? `graph_${status}: ${message}` : `graph_http_${status}`;
}

function parseRetryAfterMs(value: string | null): { retry_after_ms?: number; invalid: boolean } {
  if (value === null) return { invalid: false };
  const trimmed = value.trim();
  if (!trimmed) return { invalid: true };
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    const delay = seconds * 1000;
    return Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(delay)
      ? { retry_after_ms: delay, invalid: false }
      : { invalid: true };
  }
  const time = Date.parse(trimmed);
  if (!Number.isNaN(time)) {
    const delta = time - Date.now();
    return Number.isSafeInteger(delta) && delta > 0
      ? { retry_after_ms: delta, invalid: false }
      : { invalid: true };
  }
  return { invalid: true };
}

function isSafeTeamsIdentifier(value: string): boolean {
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
