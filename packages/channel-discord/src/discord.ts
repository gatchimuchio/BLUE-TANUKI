import { randomUUID } from "node:crypto";
import type {
  InboundRequest,
  ChannelSendPayload,
} from "@blue-tanuki/protocol";
import {
  classifyChannelDeliveryError,
  isRecoverableChannelDeliveryError,
  withRetryBackoff,
  type BackoffOptions,
  type InboundChannel,
  type InboundHandler,
  type OutboundChannel,
  type SendContext,
  type SendMeta,
  type SendResult,
} from "@blue-tanuki/channel-base";
import type { DiscordTransport, DiscordPostResult } from "./transport.js";
import { DiscordJsTransport } from "./discordjs_transport.js";

export interface DiscordRetryConfig {
  max_retries: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_ratio: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface DiscordOptions {
  /** Bot token. Env: DISCORD_BOT_TOKEN. Absent → silent. */
  bot_token?: string;
  /** Inject a fake transport for tests. */
  transport?: DiscordTransport;
  /**
   * Outbound retry/backoff for rate-limit failures. discord.js itself
   * queues internally on 429; this is a *fallback* layer for the rare
   * cases where the SDK surfaces a rate-limit error rather than queueing.
   * Pass `false` to disable retries entirely. Default: 3 retries with
   * exponential backoff capped at 30s, ±20% jitter.
   */
  retry?: DiscordRetryConfig | false;
  log?: (line: string) => void;
}

const DEFAULT_RETRY: DiscordRetryConfig = {
  max_retries: 3,
  base_delay_ms: 500,
  max_delay_ms: 30_000,
  jitter_ratio: 0.2,
};

interface SentRecord {
  payload: ChannelSendPayload;
  meta: SendMeta;
  at: number;
  external_id: string;
  ok: boolean;
  error?: string;
  error_kind?: SendResult["error_kind"];
  error_code?: string;
  retry_after_ms?: number;
  next_action?: string;
}

/**
 * Discord channel — Phase 3 real-SDK integration.
 *
 * Mirror of SlackChannel: silent fallback on missing token, transport
 * dependency injection for tests, metadata-tagged inbound for reply routing.
 *
 * Inbound filtering invariants (enforced by DiscordJsTransport):
 *   - bot's own messages dropped
 *   - any other bot's messages dropped (echo loop prevention with other bots)
 *   - in guild text channels, only @-mentions trigger handling
 *   - DMs always handled
 *
 * Outbound:
 *   - target = Discord channel snowflake. The originating
 *     InboundRequest.metadata.reply_to carries this from inbound.
 */
export class DiscordChannel implements InboundChannel, OutboundChannel {
  readonly name = "discord";
  private readonly history: SentRecord[] = [];
  private silent = false;
  private started = false;
  private counter = 0;
  private transport: DiscordTransport | null = null;

  constructor(private readonly opts: DiscordOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.bot_token) {
      this.transport = new DiscordJsTransport({
        bot_token: this.opts.bot_token,
        log: this.opts.log,
      });
    } else {
      this.silent = true;
      this.log(
        "[discord] WARN DISCORD_BOT_TOKEN unset — running in silent mode",
      );
      return;
    }

    try {
      await this.transport.start(async (m) => {
        const inbound: InboundRequest = {
          id: randomUUID(),
          channel: "discord",
          user: m.user_display,
          content: m.text,
          timestamp: Date.now(),
          metadata: {
            reply_to: m.channel_id,
            discord_user_id: m.user_id,
            discord_channel_id: m.channel_id,
            discord_message_id: m.message_id,
            discord_guild_id: m.guild_id,
            is_dm: m.is_dm,
            is_mention: m.is_mention,
          },
        };
        try {
          await handler(inbound);
        } catch (e) {
          this.log(
            `[discord] inbound handler threw: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
      this.log("[discord] active");
    } catch (e) {
      this.silent = true;
      this.log(
        `[discord] WARN transport start failed (${e instanceof Error ? e.message : String(e)}); falling back to silent`,
      );
      this.transport = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.transport) {
      try {
        await this.transport.stop();
      } catch {
        /* ignore */
      }
      this.transport = null;
    }
  }

  async send(
    payload: ChannelSendPayload,
    meta: SendMeta,
    context?: SendContext,
  ): Promise<SendResult> {
    if (context?.signal?.aborted) return { delivered: false, delivery_status: "not_delivered",
      error: "channel_send_cancelled_before_dispatch", error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
    this.counter += 1;
    const at = Date.now();
    if (this.silent || !this.transport) {
      const external_id = `discord-silent-${meta.command_id}-${this.counter}`;
      this.history.push({
        payload,
        meta,
        at,
        external_id,
        ok: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "discord_not_configured",
        next_action:
          "Set DISCORD_BOT_TOKEN, or leave Discord intentionally disabled.",
      });
      this.log(
        `[discord:silent] would-send target=${payload.target} commit=${meta.upstream_commit_hash.slice(0, 8)}… content="${truncate(payload.content, 80)}"`,
      );
      return {
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "discord_not_configured",
        next_action:
          "Set DISCORD_BOT_TOKEN, or leave Discord intentionally disabled.",
      };
    }

    const transport = this.transport;
    const retryCfg = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);

    const callOnce = (): Promise<DiscordPostResult> => {
      if (context?.signal?.aborted) return Promise.reject(new Error("channel_send_cancelled_before_transport_dispatch"));
      return transport.postMessage({
        channel: payload.target,
        text: payload.content,
      });
    };

    let r: DiscordPostResult;
    if (!retryCfg) {
      r = await callOnce();
    } else {
      const opts: BackoffOptions<DiscordPostResult> = {
        max_retries: retryCfg.max_retries,
        base_delay_ms: retryCfg.base_delay_ms,
        max_delay_ms: retryCfg.max_delay_ms,
        jitter_ratio: retryCfg.jitter_ratio,
        sleep: retryCfg.sleep,
        random: retryCfg.random,
        is_retryable: (signal) => {
          if (context?.signal?.aborted) return false;
          if (signal.kind === "throw") return true;
          const v = signal.value;
          if (v.ok) return false;
          return isRecoverableChannelDeliveryError({
            error: v.error,
            retry_after_ms: v.retry_after_ms,
          });
        },
        extract_retry_after_ms: (signal) =>
          signal.kind === "value" ? (signal.value.retry_after_ms ?? null) : null,
        on_retry: ({ attempt, delay_ms }) => {
          this.log(
            `[discord] retry attempt=${attempt} delay_ms=${delay_ms} target=${payload.target}`,
          );
        },
      };
      r = await withRetryBackoff(callOnce, opts);
    }

    const failureDetails = r.ok
      ? null
      : classifyChannelDeliveryError({
          error: r.error ?? "post_failed",
          retry_after_ms: r.retry_after_ms,
        });
    const external_id = r.message_id ?? `discord-${meta.command_id}-${this.counter}`;
    this.history.push({
      payload,
      meta,
      at,
      external_id,
      ok: r.ok,
      error: r.error,
      error_kind: r.error_kind ?? failureDetails?.error_kind,
      error_code: r.error_code ?? failureDetails?.error_code,
      retry_after_ms: r.retry_after_ms ?? failureDetails?.retry_after_ms,
      next_action: r.ok ? undefined : discordNextAction(r),
    });
    if (r.ok) {
      this.log(
        `[discord] sent target=${payload.target} message_id=${r.message_id ?? ""} commit=${meta.upstream_commit_hash.slice(0, 8)}…`,
      );
      return { delivered: true, external_id };
    }
    this.log(
      `[discord] FAILED target=${payload.target} error=${r.error ?? "unknown"}`,
    );
    const error = r.error ?? "post_failed";
    const details = classifyChannelDeliveryError({
      error,
      retry_after_ms: r.retry_after_ms,
    });
    return {
      delivered: false,
      error,
      error_kind: r.error_kind ?? details.error_kind,
      error_code: r.error_code ?? details.error_code,
      retry_after_ms: r.retry_after_ms ?? details.retry_after_ms,
      next_action: discordNextAction(r),
    };
  }

  getHistory(): readonly SentRecord[] {
    return [...this.history];
  }

  isSilent(): boolean {
    return this.silent;
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function discordNextAction(result: DiscordPostResult): string {
  const error = result.error ?? "post_failed";
  const details = classifyChannelDeliveryError({
    error,
    retry_after_ms: result.retry_after_ms,
  });
  if (details.error_kind === "recoverable") {
    const wait =
      details.retry_after_ms !== undefined
        ? ` after about ${details.retry_after_ms}ms`
        : "";
    return `Discord delivery is recoverable; retry${wait} or rerun live smoke after the service recovers.`;
  }
  if (/missing_access|channel_not_text_based|unknown.?channel|forbidden/i.test(error)) {
    return "Check DISCORD_LIVE_TARGET, bot channel permissions, and target channel type before retrying.";
  }
  if (/token|unauthorized|invalid/i.test(error)) {
    return "Rotate DISCORD_BOT_TOKEN and restart the gateway.";
  }
  return "Inspect Discord bot permissions and channel configuration before retrying.";
}
