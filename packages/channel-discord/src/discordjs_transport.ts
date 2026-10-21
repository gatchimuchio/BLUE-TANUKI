import type {
  DiscordInboundHandler,
  DiscordPostResult,
  DiscordTransport,
} from "./transport.js";
import { classifyChannelDeliveryError } from "@blue-tanuki/channel-base";

/**
 * DiscordJsTransport — production transport using `discord.js` v14.
 * Lazy-loads the SDK so tests injecting a fake never need the dep.
 *
 * Intents: Guilds + GuildMessages + MessageContent + DirectMessages.
 *   - Guilds          : required to receive any guild events at all.
 *   - GuildMessages   : message events in guild text channels.
 *   - MessageContent  : actually receive `content` strings (privileged).
 *   - DirectMessages  : DM events.
 *
 * MessageContent is a "privileged intent" — Discord requires explicit
 * opt-in in the Developer Portal once a bot reaches 100+ guilds.
 */
export class DiscordJsTransport implements DiscordTransport {
  private client: unknown = null;
  private botUserId: string | undefined;
  private started = false;

  constructor(
    private readonly opts: {
      bot_token: string;
      log?: (line: string) => void;
    },
  ) {}

  async start(handler: DiscordInboundHandler): Promise<void> {
    if (this.started) return;

    const djs = (await import("discord.js")) as {
      Client: new (cfg: { intents: number[]; rest: { rejectOnRateLimit: string[]; retries: number } }) => unknown;
      GatewayIntentBits: {
        Guilds: number;
        GuildMessages: number;
        MessageContent: number;
        DirectMessages: number;
      };
      Events: { ClientReady: string; MessageCreate: string };
    };

    const intents = [
      djs.GatewayIntentBits.Guilds,
      djs.GatewayIntentBits.GuildMessages,
      djs.GatewayIntentBits.MessageContent,
      djs.GatewayIntentBits.DirectMessages,
    ];
    // The Gateway outbox owns delivery retry. Throw on channel-route rate limits and disable
    // the SDK's automatic timeout/5xx retries so an ambiguous send cannot be replayed silently.
    const client = new djs.Client({ intents, rest: { rejectOnRateLimit: ["/channels"], retries: 0 } }) as {
      once: (e: string, fn: (...a: unknown[]) => void) => void;
      on: (e: string, fn: (...a: unknown[]) => void) => void;
      login: (t: string) => Promise<string>;
      destroy: () => Promise<void>;
      user: { id: string } | null;
      channels: {
        fetch: (id: string) => Promise<{
          isTextBased: () => boolean;
          send: (payload: string | { content: string; reply: { messageReference: string } }) => Promise<{ id: string }>;
        } | null>;
      };
    };
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        this.botUserId = client.user?.id;
        resolve();
      };
      client.once(djs.Events.ClientReady, onReady);
      client.login(this.opts.bot_token).catch(reject);
    });

    client.on(djs.Events.MessageCreate, (...args: unknown[]) => {
      const msg = args[0] as DiscordRawMessage;
      void this.handleMessage(msg, handler).catch(() => {
        this.log("[discord] inbound dispatch failed; replay remains blocked");
      });
    });

    this.started = true;
    this.log(
      `[discord] connected (bot_user_id=${this.botUserId ?? "unknown"})`,
    );
  }

  private async handleMessage(
    msg: DiscordRawMessage,
    handler: DiscordInboundHandler,
  ): Promise<void> {
    if (!msg || !msg.id || !msg.channelId) return;
    // Ignore bot's own messages and other bots.
    if (msg.author?.bot) return;
    if (this.botUserId && msg.author?.id === this.botUserId) return;

    const isDm = !msg.guildId; // guild absent ⇒ DM
    const mentionTag = this.botUserId ? `<@${this.botUserId}>` : "";
    const altMentionTag = this.botUserId ? `<@!${this.botUserId}>` : "";
    const rawText = msg.content ?? "";
    const isMention =
      !!mentionTag &&
      (rawText.includes(mentionTag) || rawText.includes(altMentionTag));

    if (!isDm && !isMention) return;

    const cleanText = rawText
      .replace(mentionTag, "")
      .replace(altMentionTag, "")
      .trim();

    const display =
      msg.member?.displayName ?? msg.author?.username ?? msg.author?.id ?? "unknown";

    await handler({
      channel_id: msg.channelId,
      user_id: msg.author?.id ?? "unknown",
      user_display: display,
      text: cleanText,
      message_id: msg.id,
      is_dm: isDm,
      is_mention: isMention,
      guild_id: msg.guildId ?? undefined,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const c = this.client as { destroy?: () => Promise<void> } | null;
    try {
      await c?.destroy?.();
    } catch {
      /* ignore */
    }
    this.client = null;
  }

  async postMessage(args: {
    channel: string;
    text: string;
    reply_to_message_id?: string;
  }): Promise<DiscordPostResult> {
    const c = this.client as {
      channels: {
        fetch: (id: string) => Promise<{
          isTextBased: () => boolean;
          send: (payload: string | { content: string; reply: { messageReference: string } }) => Promise<{ id: string }>;
        } | null>;
      };
    } | null;
    if (!c) {
      const error = "not_started";
      return {
        ok: false,
        delivery_status: "not_delivered",
        error,
        ...classifyChannelDeliveryError({ error }),
      };
    }
    try {
      const ch = await c.channels.fetch(args.channel);
      if (!ch || !ch.isTextBased()) {
        const error = "channel_not_text_based";
        return {
          ok: false,
          delivery_status: "not_delivered",
          error,
          ...classifyChannelDeliveryError({ error }),
        };
      }
      const sent = await ch.send(args.reply_to_message_id
        ? { content: args.text, reply: { messageReference: args.reply_to_message_id } }
        : args.text);
      return { ok: true, message_id: sent.id };
    } catch (e) {
      const error = discordErrorMessage(e);
      const status = httpStatus(e);
      const isRateLimit = status === 429 || isRateLimitError(e);
      const retryHint = retryAfterHint(e);
      const retry_after_ms = retryHint.retry_after_ms;
      const details = classifyChannelDeliveryError({ error, retry_after_ms });
      return {
        ok: false,
        error,
        ...details,
        delivery_status: isRateLimit || (status !== undefined && status >= 400 && status < 500) ? "not_delivered" : "unknown",
        ...(isRateLimit ? { rate_limit_rejected: true, retry_after_invalid: retryHint.invalid || retry_after_ms === undefined } : {}),
        ...(isRateLimit && retry_after_ms === undefined ? { error_code: "rate_limited" } : {}),
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

/** Subset of discord.js Message that we actually read. */
interface DiscordRawMessage {
  id?: string;
  channelId?: string;
  guildId?: string | null;
  content?: string;
  author?: { id?: string; bot?: boolean; username?: string };
  member?: { displayName?: string };
}

function discordErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const raw = asRecord(record?.rawError);
  const candidate =
    readString(raw?.message) ??
    readString(record?.message) ??
    readString(record?.code) ??
    (error instanceof Error ? error.message : undefined) ??
    String(error);
  return candidate || "discord_post_failed";
}

function retryAfterHint(error: unknown): { retry_after_ms?: number; invalid: boolean } {
  const record = asRecord(error);
  const raw = asRecord(record?.rawError);
  const hasHint = [record, raw].some((item) => item &&
    (Object.hasOwn(item, "retry_after_ms") || Object.hasOwn(item, "retry_after") || Object.hasOwn(item, "retryAfter")));
  const retry_after_ms = positiveMs(record?.retry_after_ms) ??
    positiveMs(record?.retryAfter) ??
    secondsToMs(record?.retry_after) ??
    positiveMs(raw?.retry_after_ms) ??
    secondsToMs(raw?.retry_after);
  return { ...(retry_after_ms === undefined ? {} : { retry_after_ms }), invalid: hasHint && retry_after_ms === undefined };
}

function isRateLimitError(error: unknown): boolean {
  const record = asRecord(error);
  return record?.name === "RateLimitError" && typeof record.retryAfter === "number";
}

function httpStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const raw = asRecord(record?.rawError);
  const status = record?.status ?? record?.statusCode ?? record?.httpStatus ?? raw?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function secondsToMs(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  const ms = Math.ceil(n * 1000);
  return Number.isFinite(n) && n > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}

function positiveMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.ceil(value)
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
