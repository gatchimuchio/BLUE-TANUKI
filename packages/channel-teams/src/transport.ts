import type { ChannelDeliveryErrorKind } from "@blue-tanuki/channel-base";

export type TeamsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TeamsInboundMessage {
  team_id?: string;
  channel_id?: string;
  chat_id?: string;
  user_id: string;
  user_display: string;
  text: string;
  message_id: string;
  reply_to_message_id?: string;
  tenant_id?: string;
}

export type TeamsInboundHandler = (m: TeamsInboundMessage) => Promise<void>;

export interface TeamsPostResult {
  ok: boolean;
  message_id?: string;
  request_id?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  retry_after_ms?: number;
}

export interface TeamsTransport {
  start(handler: TeamsInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: { target: string; text: string }): Promise<TeamsPostResult>;
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

  async postMessage(args: { target: string; text: string }): Promise<TeamsPostResult> {
    const target = parseTeamsTarget(args.target);
    if (!target.ok) {
      return {
        ok: false,
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
        error: "fetch_unavailable",
        error_kind: "non_recoverable",
        error_code: "fetch_unavailable",
      };
    }
    const timeoutMs = this.opts.request_timeout_ms ?? DEFAULT_TEAMS_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
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
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          error: `teams_timeout_${timeoutMs}ms`,
          error_kind: "recoverable",
          error_code: "teams_timeout",
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const parsed = parseJsonObject(text);
    const requestId =
      res.headers.get("request-id") ??
      res.headers.get("client-request-id") ??
      undefined;
    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        message_id: readString(parsed, "id") ?? requestId,
        request_id: requestId,
      };
    }
    return {
      ok: false,
      request_id: requestId,
      error: graphError(res.status, parsed),
      retry_after_ms: retryAfterMs(res.headers.get("retry-after")),
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
      return {
        ok: true,
        value: {
          kind: "channel",
          team_id: decodeURIComponent(parts[1]!),
          channel_id: decodeURIComponent(parts[2]!),
        },
      };
    }
    if (parts[0] === "reply" && parts.length === 4) {
      return {
        ok: true,
        value: {
          kind: "channel_reply",
          team_id: decodeURIComponent(parts[1]!),
          channel_id: decodeURIComponent(parts[2]!),
          message_id: decodeURIComponent(parts[3]!),
        },
      };
    }
    if (parts[0] === "chat" && parts.length === 2) {
      return {
        ok: true,
        value: {
          kind: "chat",
          chat_id: decodeURIComponent(parts[1]!),
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
