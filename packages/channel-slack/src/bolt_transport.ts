import type {
  SlackInboundHandler,
  SlackPostResult,
  SlackTransport,
} from "./transport.js";
import { classifyChannelDeliveryError } from "@blue-tanuki/channel-base";

/**
 * BoltTransport — production Slack transport using `@slack/bolt` with
 * Socket Mode. Requires both `bot_token` (xoxb-...) and `app_token`
 * (xapp-...). The dependency on `@slack/bolt` is loaded lazily so that
 * test environments which inject a fake transport never need the SDK
 * installed at runtime (the import only fires inside start()).
 *
 * Inbound surface:
 *   - `message` events on every channel/DM the bot is in
 *   - `app_mention` events
 *
 * Outbound: chat.postMessage.
 *
 * Rate-limit responses are classified here; the SlackChannel/Gateway outbox
 * owns the durable wait and bounded retry. Reaction and Block Kit interaction
 * remain outside this transport contract.
 */
export class BoltTransport implements SlackTransport {
  private app: unknown = null;
  private botUserId: string | undefined;
  private started = false;

  constructor(
    private readonly opts: {
      bot_token: string;
      app_token: string;
      log?: (line: string) => void;
    },
  ) {}

  async start(handler: SlackInboundHandler): Promise<void> {
    if (this.started) return;

    // Lazy import: only loaded on real production wire-up.
    // `@slack/bolt` brings ~3MB of deps; we keep it out of cold-path tests.
    const bolt = (await import("@slack/bolt")) as {
      App: new (cfg: Record<string, unknown>) => unknown;
    };

    const app = new bolt.App({
      token: this.opts.bot_token,
      appToken: this.opts.app_token,
      socketMode: true,
      logLevel: "warn",
    }) as {
      message: (fn: (ctx: { message: SlackRawMessage; body: unknown }) => Promise<void>) => void;
      event: (
        name: string,
        fn: (ctx: { event: SlackRawAppMention }) => Promise<void>,
      ) => void;
      client: {
        chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> };
        auth: { test: () => Promise<{ user_id?: string }> };
      };
      start: () => Promise<void>;
      stop: () => Promise<void>;
    };

    this.app = app;

    // Resolve bot user_id once for self-message filtering.
    try {
      const auth = await app.client.auth.test();
      this.botUserId = auth.user_id;
    } catch (e) {
      this.log(
        `[slack] WARN auth.test failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    app.message(async ({ message, body }) => {
      // Slack types are loose. Defensive narrowing.
      if (!message || typeof message !== "object") return;
      if ("subtype" in message && message.subtype) return; // edits, joins, etc.
      const m = message as SlackRawMessage;
      if (!m.text || !m.user || !m.channel || !m.ts) return;
      const identity = readSlackEventEnvelopeIdentity(body);
      if (!identity) return;
      const isDm = m.channel.startsWith("D");
      // Plain `message` events fire for both DM and channel posts.
      // Channel-without-mention is handled by the early return below.
      const mentionTag = this.botUserId ? `<@${this.botUserId}>` : "";
      const isMention = !!mentionTag && m.text.includes(mentionTag);
      if (!isDm && !isMention) return;
      const cleanText = mentionTag ? m.text.replace(mentionTag, "").trim() : m.text;
      await handler({
        ...identity,
        channel_id: m.channel,
        user_id: m.user,
        user_display: m.user, // Resolving display name requires users.info; deferred.
        text: cleanText,
        ts: m.ts,
        thread_ts: m.thread_ts ?? null,
        is_dm: isDm,
        is_mention: isMention,
      });
    });

    // app_mention also fires on channel mentions; the message handler above
    // already covers this case via `isMention`. Subscribing here as well
    // would double-deliver, so we deliberately skip a second subscription.

    await app.start();
    this.started = true;
    this.log(
      `[slack] connected (bot_user_id=${this.botUserId ?? "unknown"})`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const app = this.app as { stop?: () => Promise<void> } | null;
    try {
      await app?.stop?.();
    } catch {
      /* ignore */
    }
    this.app = null;
  }

  async postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult> {
    const app = this.app as {
      client: { chat: { postMessage: (a: Record<string, unknown>) => Promise<unknown> } };
    } | null;
    if (!app) {
      return { ok: false, error: "not_started" };
    }
    try {
      const r = (await app.client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        thread_ts: args.thread_ts,
      })) as { ok?: boolean; ts?: string; error?: string };
      if (r.ok) return { ok: true, ts: r.ts };
      const error = r.error ?? "unknown_error";
      const details = classifyChannelDeliveryError({ error });
      return { ok: false, delivery_status: "not_delivered", error, ...details };
    } catch (e) {
      const error = slackErrorMessage(e);
      const retryAfter = retryAfterHint(e);
      const retry_after_ms = retryAfter.retry_after_ms;
      const details = classifyChannelDeliveryError({ error, retry_after_ms });
      return {
        ok: false,
        delivery_status: explicitProviderRejection(e) ? "not_delivered" : "unknown",
        ...(retryAfter.retry_after_invalid ? { retry_after_invalid: true } : {}),
        error,
        ...details,
      };
    }
  }

  getBotUserId(): string | undefined {
    return this.botUserId;
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }
}

/** Extract identity only from Bolt's authenticated outer Events API payload. */
export function readSlackEventEnvelopeIdentity(
  body: unknown,
): { team_id: string; event_id: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return typeof record.team_id === "string" && typeof record.event_id === "string"
    ? { team_id: record.team_id, event_id: record.event_id }
    : null;
}

/** Minimal shape of the Slack `message` event we care about. */
interface SlackRawMessage {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

/** Minimal shape of the Slack `app_mention` event (kept for future use). */
interface SlackRawAppMention {
  type?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

function slackErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const candidate =
    readString(data?.error) ??
    readString(record?.code) ??
    (error instanceof Error ? error.message : undefined) ??
    String(error);
  return candidate || "slack_post_failed";
}

function retryAfterHint(error: unknown): { retry_after_ms?: number; retry_after_invalid?: true } {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const headers = asRecord(record?.headers);
  const header = headers?.["retry-after"] ?? headers?.["Retry-After"] ?? headerRetryAfterValue(record?.headers);
  const candidates: Array<{ value: unknown; unit: "ms" | "seconds" }> = [
    { value: record?.retry_after_ms, unit: "ms" },
    { value: record?.retryAfter, unit: "seconds" },
    { value: data?.retry_after, unit: "seconds" },
    { value: data?.retry_after_ms, unit: "ms" },
    { value: header, unit: "seconds" },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null) continue;
    const parsed = parseRetryAfter(candidate.value, candidate.unit);
    if (parsed === undefined) return { retry_after_invalid: true };
    return { retry_after_ms: parsed };
  }
  return {};
}

function explicitProviderRejection(error: unknown): boolean {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const status = readStatusCode(record) ?? readStatusCode(data);
  return (typeof data?.error === "string" && data.error.length > 0) ||
    (status !== undefined && status >= 400 && status < 500);
}

function readStatusCode(record: Record<string, unknown> | undefined): number | undefined {
  const value = record?.statusCode ?? record?.status ?? record?.status_code;
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function headerRetryAfterValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const getter = (value as { get?: unknown }).get;
  if (typeof getter === "function") {
    try { return getter.call(value, "retry-after") ?? undefined; } catch { return undefined; }
  }
  return undefined;
}

function parseRetryAfter(value: unknown, unit: "ms" | "seconds"): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  const milliseconds = unit === "seconds" ? Math.ceil(n * 1000) : Math.ceil(n);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 &&
    milliseconds <= Number.MAX_SAFE_INTEGER - Date.now()
    ? milliseconds
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
