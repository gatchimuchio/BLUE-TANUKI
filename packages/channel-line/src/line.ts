import { randomUUID } from "node:crypto";
import type {
  ChannelSendPayload,
  InboundRequest,
} from "@blue-tanuki/protocol";
import {
  classifyChannelDeliveryError,
  isRecoverableChannelDeliveryError,
  withRetryBackoff,
  type BackoffOptions,
  type InboundChannel,
  type InboundHandler,
  type OutboundChannel,
  type SendMeta,
  type SendResult,
} from "@blue-tanuki/channel-base";
import {
  LineMessagingTransport,
  type LineFetch,
  type LineInboundMessage,
  type LinePostResult,
  type LineTransport,
} from "./transport.js";

export interface LineRetryConfig {
  max_retries: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_ratio: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface LineOptions {
  /** LINE Messaging API channel access token. Env: LINE_CHANNEL_ACCESS_TOKEN. */
  channel_access_token?: string;
  /** Test or future webhook transport injection. */
  transport?: LineTransport;
  /** Fetch injection for the built-in Messaging API transport. */
  fetch?: LineFetch;
  /** Per-request Messaging API HTTP timeout. Default: 15000ms. */
  request_timeout_ms?: number;
  retry?: LineRetryConfig | false;
  log?: (line: string) => void;
}

const DEFAULT_RETRY: LineRetryConfig = {
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

export class LineChannel implements InboundChannel, OutboundChannel {
  readonly name = "line";
  private readonly history: SentRecord[] = [];
  private silent = false;
  private started = false;
  private counter = 0;
  private transport: LineTransport | null = null;

  constructor(private readonly opts: LineOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.channel_access_token) {
      this.transport = new LineMessagingTransport({
        channel_access_token: this.opts.channel_access_token,
        fetch: this.opts.fetch,
        request_timeout_ms: this.opts.request_timeout_ms,
      });
    } else {
      this.silent = true;
      this.log("[line] WARN LINE_CHANNEL_ACCESS_TOKEN unset - running in silent mode");
      return;
    }

    try {
      await this.transport.start(async (m) => {
        const inbound = normalizeLineInbound(m);
        try {
          await handler(inbound);
        } catch (e) {
          this.log(
            `[line] inbound handler threw: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
      this.log("[line] active");
    } catch (e) {
      this.silent = true;
      this.log(
        `[line] WARN transport start failed (${e instanceof Error ? e.message : String(e)}); falling back to silent`,
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

  async send(payload: ChannelSendPayload, meta: SendMeta): Promise<SendResult> {
    this.counter += 1;
    const at = Date.now();
    if (this.silent || !this.transport) {
      const external_id = `line-silent-${meta.command_id}-${this.counter}`;
      const next_action =
        "Set LINE_CHANNEL_ACCESS_TOKEN and a LINE target, or leave LINE intentionally disabled.";
      this.history.push({
        payload,
        meta,
        at,
        external_id,
        ok: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "line_not_configured",
        next_action,
      });
      this.log(
        `[line:silent] would-send target=${payload.target} commit=${meta.upstream_commit_hash.slice(0, 8)} content="${truncate(payload.content, 80)}"`,
      );
      return {
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "line_not_configured",
        next_action,
      };
    }

    const retryCfg = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);
    const callOnce = (): Promise<LinePostResult> =>
      this.transport!.postMessage({ target: payload.target, text: payload.content });
    const r = retryCfg ? await withLineRetry(callOnce, retryCfg, this.opts.log, payload.target) : await callOnce();

    const details = r.ok
      ? null
      : classifyChannelDeliveryError({
          error: r.error ?? "line_send_failed",
          retry_after_ms: r.retry_after_ms,
        });
    const external_id = r.request_id ?? `line-${meta.command_id}-${this.counter}`;
    this.history.push({
      payload,
      meta,
      at,
      external_id,
      ok: r.ok,
      error: r.error,
      error_kind: r.error_kind ?? details?.error_kind,
      error_code: r.error_code ?? details?.error_code,
      retry_after_ms: r.retry_after_ms ?? details?.retry_after_ms,
      next_action: r.ok ? undefined : lineNextAction(r),
    });
    if (r.ok) {
      this.log(
        `[line] sent target=${payload.target} request_id=${external_id} commit=${meta.upstream_commit_hash.slice(0, 8)}`,
      );
      return { delivered: true, external_id };
    }
    return {
      delivered: false,
      error: r.error ?? "line_send_failed",
      error_kind: r.error_kind ?? details!.error_kind,
      error_code: r.error_code ?? details!.error_code,
      retry_after_ms: r.retry_after_ms ?? details!.retry_after_ms,
      next_action: lineNextAction(r),
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

function normalizeLineInbound(m: LineInboundMessage): InboundRequest {
  return {
    id: randomUUID(),
    channel: "line",
    user: m.user_display || m.user_id || m.source_id,
    content: m.text,
    timestamp: Date.now(),
    metadata: {
      reply_to: m.source_id,
      line_source_type: m.source_type,
      line_source_id: m.source_id,
      line_user_id: m.user_id,
      line_message_id: m.message_id,
      line_reply_token: m.reply_token,
      line_webhook_event_id: m.webhook_event_id,
      line_is_redelivery: m.is_redelivery,
    },
  };
}

async function withLineRetry(
  callOnce: () => Promise<LinePostResult>,
  retryCfg: LineRetryConfig,
  log: ((line: string) => void) | undefined,
  target: string,
): Promise<LinePostResult> {
  const opts: BackoffOptions<LinePostResult> = {
    max_retries: retryCfg.max_retries,
    base_delay_ms: retryCfg.base_delay_ms,
    max_delay_ms: retryCfg.max_delay_ms,
    jitter_ratio: retryCfg.jitter_ratio,
    sleep: retryCfg.sleep,
    random: retryCfg.random,
    is_retryable: (signal) => {
      if (signal.kind === "throw") {
        return isRecoverableChannelDeliveryError({
          error: signal.error instanceof Error ? signal.error.message : String(signal.error),
        });
      }
      if (signal.value.ok) return false;
      return isRecoverableChannelDeliveryError({
        error: signal.value.error,
        retry_after_ms: signal.value.retry_after_ms,
      });
    },
    extract_retry_after_ms: (signal) =>
      signal.kind === "value" ? (signal.value.retry_after_ms ?? null) : null,
    on_retry: ({ attempt, delay_ms }) => {
      log?.(`[line] retry attempt=${attempt} delay_ms=${delay_ms} target=${target}`);
    },
  };
  return await withRetryBackoff(callOnce, opts);
}

function lineNextAction(result: LinePostResult): string {
  const error = result.error ?? "line_send_failed";
  const details = classifyChannelDeliveryError({
    error,
    retry_after_ms: result.retry_after_ms,
  });
  if (details.error_kind === "recoverable") {
    const wait =
      details.retry_after_ms !== undefined
        ? ` after about ${details.retry_after_ms}ms`
        : "";
    return `LINE delivery is recoverable; retry${wait} or rerun live smoke after the LINE Messaging API recovers.`;
  }
  if (/401|unauthorized|invalid.*token|token/i.test(error)) {
    return "Rotate LINE_CHANNEL_ACCESS_TOKEN and restart the gateway.";
  }
  if (/403|forbidden|permission/i.test(error)) {
    return "Check LINE Messaging API channel permissions and target reachability before retrying.";
  }
  if (/400|missing_line_target|target/i.test(error)) {
    return "Check LINE_LIVE_TARGET. Use a LINE userId, groupId, or roomId reachable by the bot.";
  }
  return "Inspect LINE channel access token, Messaging API settings, and target reachability before retrying.";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "...";
}
