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
import type { SlackTransport, SlackPostResult } from "./transport.js";
import { BoltTransport } from "./bolt_transport.js";

export interface SlackRetryConfig {
  max_retries: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_ratio: number;
  /** Test-only injection of sleep; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only injection of RNG; defaults to Math.random. */
  random?: () => number;
}

export interface SlackOptions {
  /**
   * Bot token (xoxb-...). Env: SLACK_BOT_TOKEN.
   * If absent AND no `transport` is supplied, channel runs silent.
   */
  bot_token?: string;
  /**
   * App-level token (xapp-...) for Socket Mode. Env: SLACK_APP_TOKEN.
   * Required for the default Bolt-based transport. If absent AND no
   * `transport` is supplied, channel runs silent.
   */
  app_token?: string;
  /**
   * Inject a custom transport (typically a fake during tests).
   * When provided, takes precedence over bot_token/app_token defaults.
   */
  transport?: SlackTransport;
  /**
   * Outbound retry/backoff for rate-limit-style failures. The Slack SDK
   * already queues internally on 429; this is a *fallback* that gives a
   * few more attempts when the SDK eventually surfaces a rate-limit error.
   * Pass `false` to disable retries entirely. Default: 3 retries with
   * exponential backoff capped at 30s, ±20% jitter.
   */
  retry?: SlackRetryConfig | false;
  log?: (line: string) => void;
}

const DEFAULT_RETRY: SlackRetryConfig = {
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
 * Slack channel — Phase 3 real-SDK integration.
 *
 * Lifecycle:
 *   - silent mode: no token AND no injected transport → start() logs a
 *     warning, never produces inbound, send() fails fast with a structured
 *     error (still recorded in history for diagnostics). Matches Phase 2
 *     fail-soft behavior.
 *   - active mode: a transport is available → start() begins listening,
 *     inbound messages flow through the supplied InboundHandler.
 *
 * Inbound filtering invariants (enforced by BoltTransport, but SlackChannel
 * relies on these):
 *   - bot's own posts are dropped (echo loop prevention)
 *   - in public channels, only @-mentions of the bot trigger handling
 *   - DMs are always handled
 *
 * Outbound:
 *   - target = Slack channel id (Cxxx, Dxxx, or Gxxx)
 *   - When the originating InboundRequest has metadata.reply_to set,
 *     callers should use that as `payload.target`. SlackChannel itself
 *     does not consult metadata; it merely posts to the given target.
 *
 * Notes:
 *   - Rate limiting / backoff is handled as adapter-level retry around
 *     transport failures that still surface after Slack SDK handling.
 *   - Threaded replies require the caller to pass thread_ts; not yet
 *     surfaced through ChannelSendPayload (would require a protocol
 *     extension). Phase 3 posts to the channel root.
 */
export class SlackChannel implements InboundChannel, OutboundChannel {
  readonly name = "slack";
  private readonly history: SentRecord[] = [];
  private silent = false;
  private started = false;
  private counter = 0;
  private transport: SlackTransport | null = null;

  constructor(private readonly opts: SlackOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.bot_token && this.opts.app_token) {
      this.transport = new BoltTransport({
        bot_token: this.opts.bot_token,
        app_token: this.opts.app_token,
        log: this.opts.log,
      });
    } else {
      this.silent = true;
      this.log(
        "[slack] WARN SLACK_BOT_TOKEN/SLACK_APP_TOKEN not both set — running in silent mode",
      );
      return;
    }

    try {
      await this.transport.start(async (m) => {
        const inbound: InboundRequest = {
          id: randomUUID(),
          channel: "slack",
          user: m.user_display,
          content: m.text,
          timestamp: Date.now(),
          metadata: {
            // reply_to is the Slack channel id; this is what the gateway
            // must hand back as ChannelSendPayload.target on outbound.
            reply_to: m.channel_id,
            slack_user_id: m.user_id,
            slack_channel_id: m.channel_id,
            slack_ts: m.ts,
            slack_thread_ts: m.thread_ts,
            is_dm: m.is_dm,
            is_mention: m.is_mention,
          },
        };
        try {
          await handler(inbound);
        } catch (e) {
          // Inbound handler errors must not break the listener.
          this.log(
            `[slack] inbound handler threw: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
      this.log("[slack] active");
    } catch (e) {
      this.silent = true;
      this.log(
        `[slack] WARN transport start failed (${e instanceof Error ? e.message : String(e)}); falling back to silent`,
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
      const external_id = `slack-silent-${meta.command_id}-${this.counter}`;
      this.history.push({
        payload,
        meta,
        at,
        external_id,
        ok: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "slack_not_configured",
        next_action:
          "Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN, or leave Slack intentionally disabled.",
      });
      this.log(
        `[slack:silent] would-send target=${payload.target} commit=${meta.upstream_commit_hash.slice(0, 8)}… content="${truncate(payload.content, 80)}"`,
      );
      return {
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "slack_not_configured",
        next_action:
          "Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN, or leave Slack intentionally disabled.",
      };
    }

    const transport = this.transport;
    const retryCfg = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);

    const callOnce = (): Promise<SlackPostResult> => {
      if (context?.signal?.aborted) return Promise.reject(new Error("channel_send_cancelled_before_transport_dispatch"));
      return transport.postMessage({
        channel: payload.target,
        text: payload.content,
      });
    };

    let r: SlackPostResult;
    if (!retryCfg) {
      r = await callOnce();
    } else {
      const opts: BackoffOptions<SlackPostResult> = {
        max_retries: retryCfg.max_retries,
        base_delay_ms: retryCfg.base_delay_ms,
        max_delay_ms: retryCfg.max_delay_ms,
        jitter_ratio: retryCfg.jitter_ratio,
        sleep: retryCfg.sleep,
        random: retryCfg.random,
        is_retryable: (signal) => {
          if (context?.signal?.aborted) return false;
          if (signal.kind === "throw") {
            // Network-ish exceptions are retryable; the transport normally
            // catches and converts to {ok:false}, but defensively treat
            // throws as retryable too.
            return true;
          }
          const v = signal.value;
          if (v.ok) return false;
          // Only retry on recoverable delivery failures.
          return isRecoverableChannelDeliveryError({
            error: v.error,
            retry_after_ms: v.retry_after_ms,
          });
        },
        extract_retry_after_ms: (signal) =>
          signal.kind === "value" ? (signal.value.retry_after_ms ?? null) : null,
        on_retry: ({ attempt, delay_ms }) => {
          this.log(
            `[slack] retry attempt=${attempt} delay_ms=${delay_ms} target=${payload.target}`,
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
    const external_id = r.ts ?? `slack-${meta.command_id}-${this.counter}`;
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
      next_action: r.ok ? undefined : slackNextAction(r),
    });
    if (r.ok) {
      this.log(
        `[slack] sent target=${payload.target} ts=${r.ts ?? ""} commit=${meta.upstream_commit_hash.slice(0, 8)}…`,
      );
      return { delivered: true, external_id };
    }
    this.log(
      `[slack] FAILED target=${payload.target} error=${r.error ?? "unknown"}`,
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
      next_action: slackNextAction(r),
    };
  }

  /** Inspect what was sent (or attempted). Test/diagnostic only. */
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

function slackNextAction(result: SlackPostResult): string {
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
    return `Slack delivery is recoverable; retry${wait} or rerun live smoke after the service recovers.`;
  }
  if (/channel_not_found|not_in_channel|missing_access/i.test(error)) {
    return "Check SLACK_LIVE_TARGET and invite the bot to the target channel before retrying.";
  }
  if (/invalid_auth|token_revoked|account_inactive|not_authed/i.test(error)) {
    return "Rotate SLACK_BOT_TOKEN/SLACK_APP_TOKEN and restart the gateway.";
  }
  return "Inspect Slack app permissions and channel configuration before retrying.";
}
