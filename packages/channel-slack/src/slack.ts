import { createHash, randomUUID } from "node:crypto";
import type {
  InboundRequest,
  ChannelSendPayload,
} from "@blue-tanuki/protocol";
import {
  classifyChannelDeliveryError,
  type InboundChannel,
  type InboundHandler,
  type OutboundChannel,
  type SendContext,
  type SendMeta,
  type SendResult,
} from "@blue-tanuki/channel-base";
import type {
  SlackEventInbox,
  SlackInboundGrant,
  SlackInboundMessage,
  SlackTransport,
  SlackPostResult,
  SlackOutboundDeliveryStore,
} from "./transport.js";
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
  /** Exact owner-configured inbound grants. Empty or absent rejects all messages. */
  inbound_grants?: readonly SlackInboundGrant[];
  /** Gateway-owned durable event replay boundary; required for the live Bolt transport. */
  inbox?: SlackEventInbox;
  /** Gateway-owned durable outbox for rate-limited replies; required on the live transport. */
  delivery_store?: SlackOutboundDeliveryStore;
  /**
   * Outbound retry/backoff for explicit rate-limit rejections only. Ambiguous
   * transport failures are never retried because Slack may have accepted them.
   * Pass `false` to disable retries. Default: 3 retries with exponential
   * fallback delay capped at 30s and ±20% jitter; provider Retry-After is obeyed in full.
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
 *   - The Gateway outbox durably retains a rate-limited reply until its
 *     Retry-After wait elapses; interrupted dispatches remain outcome-unknown.
 *   - Thread replies use the originating Slack message timestamp.
 */
export class SlackChannel implements InboundChannel, OutboundChannel {
  readonly name = "slack";
  private readonly history: SentRecord[] = [];
  private silent = false;
  private started = false;
  private counter = 0;
  private transport: SlackTransport | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private lifecycleAbort = new AbortController();

  constructor(private readonly opts: SlackOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;

    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.bot_token && this.opts.app_token) {
      if (!this.opts.inbox) throw new Error("slack_durable_inbox_required_for_live_events");
      if (!this.opts.delivery_store) throw new Error("slack_durable_delivery_store_required_for_live_events");
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

    if (!this.opts.inbound_grants?.length) {
      this.log("[slack] WARN SLACK_INBOUND_GRANTS_JSON unset/empty — inbound messages are rejected");
    }

    this.started = true;
    this.lifecycleAbort = new AbortController();
    try {
      await this.transport.start(async (m) => {
        if (!isValidSlackInboundMessage(m)) {
          this.log("[slack] rejected inbound event with invalid identity");
          return;
        }
        const grant = this.opts.inbound_grants?.some((candidate) =>
          candidate.team_id === m.team_id &&
          candidate.channel_id === m.channel_id &&
          candidate.user_id === m.user_id &&
          candidate.thread_ts === m.thread_ts
        );
        if (!grant) return;
        const inbox = this.opts.inbox;
        if (!inbox) {
          this.log("[slack] rejected inbound event because durable admission is unavailable");
          return;
        }
        const payloadDigest = slackInboundPayloadDigest(m);
        let claim;
        try {
          claim = inbox.claim(m.event_id, payloadDigest);
        } catch {
          this.log("[slack] rejected inbound event because durable admission failed");
          return;
        }
        if (claim.status !== "accepted") {
          this.log(`[slack] suppressed inbound event status=${claim.status}`);
          return;
        }

        let deliveryState: "handler_returned" | "outcome_unknown" = "outcome_unknown";
        const inbound: InboundRequest = {
          id: randomUUID(),
          channel: "slack",
          // Scope HDS owner/channel matching to this exact workspace, sender,
          // conversation, and thread. Display names are mutable labels only.
          user: slackActorIdentity(m),
          content: m.text,
          timestamp: Date.now(),
          metadata: {
            // reply_to is the Slack channel id; this is what the gateway
            // must hand back as ChannelSendPayload.target on outbound.
            reply_to: m.channel_id,
            slack_team_id: m.team_id,
            slack_user_id: m.user_id,
            slack_channel_id: m.channel_id,
            slack_ts: m.ts,
            slack_thread_ts: m.thread_ts,
            slack_reply_thread_ts: m.thread_ts ?? m.ts,
            is_dm: m.is_dm,
            is_mention: m.is_mention,
          },
        };
        try {
          await handler(inbound);
          deliveryState = "handler_returned";
        } catch {
          // The handler may already have crossed a durable boundary. Suppress
          // replay and expose only a redacted outcome state.
          this.log("[slack] inbound handler failed; delivery outcome is unknown");
        } finally {
          try {
            inbox.settle(m.event_id, payloadDigest, deliveryState);
          } catch {
            this.log("[slack] inbound delivery settlement failed; replay remains blocked");
          }
        }
      });
      this.log("[slack] active");
      for (const pending of this.opts.delivery_store?.pending() ?? []) {
        void this.enqueuePersistedDelivery(pending.delivery_id).then((result) => {
          this.log(`[slack] recovered outbound delivery state=${result.ok ? "delivered" : result.delivery_status ?? "unknown"}`);
        }).catch(() => this.log("[slack] recovered outbound delivery remains unresolved"));
      }
    } catch (e) {
      this.silent = true;
      this.started = false;
      try {
        await this.transport?.stop();
      } catch {
        /* A failed startup remains closed even when transport cleanup also fails. */
      }
      this.log(
        `[slack] WARN transport start failed (${e instanceof Error ? e.message : String(e)}); falling back to silent`,
      );
      this.transport = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.lifecycleAbort.abort();
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

    if (payload.channel !== "slack" || !/^(?:C|D|G)[A-Z0-9]{1,31}$/u.test(payload.target) ||
        (payload.thread_ts !== undefined && !/^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(payload.thread_ts))) {
      return { delivered: false, delivery_status: "not_delivered", error: "slack_target_or_thread_invalid",
        error_kind: "non_recoverable", error_code: "invalid_target" };
    }

    if (this.opts.delivery_store) {
      const delivery_id = randomUUID();
      try {
        this.opts.delivery_store.enqueue({
          delivery_id,
          channel: "slack",
          target: payload.target,
          text: payload.content,
          ...(payload.thread_ts ? { thread_ts: payload.thread_ts } : {}),
        }, at);
      } catch {
        return { delivered: false, delivery_status: "not_delivered", error: "slack_outbound_queue_unavailable",
          error_kind: "non_recoverable", error_code: "outbound_queue_unavailable",
          next_action: "Inspect the private Slack delivery state before sending this reply again." };
      }
      const durable = await this.enqueuePersistedDelivery(delivery_id, context?.signal);
      return this.recordResult(payload, meta, at, durable);
    }

    const callOnce = (): Promise<SlackPostResult> => {
      if (context?.signal?.aborted) return Promise.reject(new Error("channel_send_cancelled_before_transport_dispatch"));
      return transport.postMessage({
        channel: payload.target,
        text: payload.content,
        ...(payload.thread_ts ? { thread_ts: payload.thread_ts } : {}),
      });
    };

    const r = await sendWithRateLimitRetry(callOnce, retryCfg, context?.signal, (attempt, delay) =>
      this.log(`[slack] retry attempt=${attempt} delay_ms=${delay} target=${payload.target}`));

    return this.recordResult(payload, meta, at, r);
  }

  private recordResult(payload: ChannelSendPayload, meta: SendMeta, at: number, r: SlackPostResult): SendResult {
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
      ...(r.delivery_status ? { delivery_status: r.delivery_status } : {}),
      error,
      error_kind: r.error_kind ?? details.error_kind,
      error_code: r.error_code ?? details.error_code,
      retry_after_ms: r.retry_after_ms ?? details.retry_after_ms,
      next_action: slackNextAction(r),
    };
  }

  private enqueuePersistedDelivery(deliveryId: string, signal?: AbortSignal): Promise<SlackPostResult> {
    const task = this.deliveryTail.then(
      () => this.dispatchPersistedDelivery(deliveryId, signal),
      () => this.dispatchPersistedDelivery(deliveryId, signal),
    );
    this.deliveryTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async dispatchPersistedDelivery(deliveryId: string, signal?: AbortSignal): Promise<SlackPostResult> {
    const store = this.opts.delivery_store!;
    const retryCfg = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);
    while (true) {
      if (signal?.aborted) {
        try { store.cancelPending(deliveryId); } catch { /* a concurrent claim is resolved by its owner */ }
        return { ok: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch" };
      }
      const pending = store.pending().find((row) => row.delivery_id === deliveryId);
      if (!pending) {
        const status = store.status(deliveryId);
        if (status?.delivery_state === "delivered") return { ok: true, ts: status.external_ts };
        return {
          ok: false,
          delivery_status: status?.delivery_state === "not_delivered" || status?.delivery_state === "retry_exhausted"
            ? "not_delivered" : "unknown",
          error: status?.error_code ?? "slack_delivery_state_unavailable",
          ...(status?.retry_after_ms ? { retry_after_ms: status.retry_after_ms } : {}),
        };
      }
      const delay = Math.max(0, pending.not_before_ms - Date.now());
      if (delay > 0) {
        const completedWait = await sleepWithSignal(delay,
          signal ? AbortSignal.any([signal, this.lifecycleAbort.signal]) : this.lifecycleAbort.signal,
          retryCfg?.sleep);
        if (!completedWait) {
          if (signal?.aborted) {
            try { store.cancelPending(deliveryId); } catch { /* a concurrent claim is resolved by its owner */ }
            return { ok: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch" };
          }
          return { ok: false, delivery_status: "not_delivered", error: "slack_delivery_wait_interrupted",
            retry_after_ms: Math.max(1, pending.not_before_ms - Date.now()) };
        }
      }
      if (signal?.aborted) continue;
      const claim = store.claimDelivery(deliveryId);
      if (!claim) continue;
      if (signal?.aborted || this.lifecycleAbort.signal.aborted) {
        store.settleDelivery(deliveryId, "not_delivered", { error_code: "cancelled_before_dispatch" });
        return { ok: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch" };
      }
      let result: SlackPostResult;
      try {
        result = await this.transport!.postMessage({
          channel: claim.target,
          text: claim.text,
          ...(claim.thread_ts ? { thread_ts: claim.thread_ts } : {}),
        });
      } catch (error) {
        result = { ok: false, delivery_status: "unknown", error: error instanceof Error ? error.message : "slack_transport_failed" };
      }
      if (result.ok) {
        store.settleDelivery(deliveryId, "delivered", { ...(result.ts ? { external_ts: result.ts } : {}) });
        return result;
      }
      if (isExplicitRateLimitRejection(result)) {
        if (result.retry_after_invalid) {
          store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "invalid_retry_after" });
          return { ...result, delivery_status: "not_delivered", error_code: "invalid_retry_after" };
        }
        const retryAfter = retryDelayMs(retryCfg, result.retry_after_ms, claim.attempt_count);
        if (retryAfter === null) {
          store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "invalid_retry_after" });
          return { ...result, delivery_status: "not_delivered", error_code: "invalid_retry_after" };
        }
        if (retryCfg && claim.attempt_count <= retryCfg.max_retries) {
          store.scheduleRetry(deliveryId, Date.now() + retryAfter, retryAfter);
          if (signal?.aborted) {
            try { store.cancelPending(deliveryId); } catch { /* settled by a concurrent delivery */ }
            return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
          }
          if (this.lifecycleAbort.signal.aborted) {
            return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
          }
          this.log(`[slack] persisted retry attempt=${claim.attempt_count} delay_ms=${retryAfter} target=${claim.target}`);
          continue;
        }
        store.settleDelivery(deliveryId, "retry_exhausted", {
          error_code: result.error_code ?? "rate_limited",
          retry_after_ms: retryAfter,
        });
        return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
      }
      store.settleDelivery(deliveryId, result.delivery_status === "not_delivered" ? "not_delivered" : "outcome_unknown", {
        ...(result.error_code ? { error_code: result.error_code } : {}),
      });
      return result;
    }
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

function isValidSlackInboundMessage(value: unknown): value is SlackInboundMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return isSlackIdentifier(message.team_id, /^T[A-Z0-9]{1,31}$/u) &&
    isSlackIdentifier(message.channel_id, /^(?:C|D|G)[A-Z0-9]{1,31}$/u) &&
    isSlackIdentifier(message.user_id, /^(?:U|W)[A-Z0-9]{1,31}$/u) &&
    typeof message.event_id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(message.event_id) &&
    typeof message.text === "string" && message.text.length <= 1_000_000 &&
    typeof message.ts === "string" && /^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(message.ts) &&
    (message.thread_ts === null ||
      (typeof message.thread_ts === "string" && /^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(message.thread_ts))) &&
    message.is_dm === message.channel_id.startsWith("D") &&
    typeof message.is_mention === "boolean" &&
    typeof message.user_display === "string";
}

function isSlackIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function slackInboundPayloadDigest(message: SlackInboundMessage): string {
  return createHash("sha256").update(JSON.stringify([
    message.team_id,
    message.channel_id,
    message.user_id,
    message.thread_ts,
    message.ts,
    message.text,
    message.is_dm,
    message.is_mention,
  ])).digest("hex");
}

function slackActorIdentity(message: SlackInboundMessage): string {
  const digest = createHash("sha256").update(JSON.stringify([
    message.team_id,
    message.channel_id,
    message.user_id,
    message.thread_ts,
  ])).digest("hex");
  return `slack:${digest}`;
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

async function sendWithRateLimitRetry(
  send: () => Promise<SlackPostResult>,
  retry: SlackRetryConfig | null,
  signal: AbortSignal | undefined,
  onRetry: (attempt: number, delayMs: number) => void,
): Promise<SlackPostResult> {
  let attempt = 0;
  while (true) {
    let result: SlackPostResult;
    try {
      result = await send();
    } catch (error) {
      return { ok: false, delivery_status: "unknown",
        error: error instanceof Error ? error.message : "slack_transport_failed" };
    }
    if (result.ok || !retry || !isExplicitRateLimitRejection(result) || attempt >= retry.max_retries) return result;
    if (result.retry_after_invalid) return { ...result, error_code: "invalid_retry_after" };
    attempt += 1;
    const delayMs = retryDelayMs(retry, result.retry_after_ms, attempt);
    if (delayMs === null) return { ...result, error_code: "invalid_retry_after" };
    onRetry(attempt, delayMs);
    if (signal?.aborted) return { ...result, delivery_status: "not_delivered", error: "channel_send_cancelled_before_retry" };
    const waited = await sleepWithSignal(delayMs, signal, retry.sleep);
    if (!waited) return { ...result, delivery_status: "not_delivered", error: "channel_send_cancelled_before_retry" };
  }
}

function isExplicitRateLimitRejection(result: SlackPostResult): boolean {
  return !result.ok && result.delivery_status === "not_delivered" &&
    (result.error_code === "rate_limited" || /ratelimit|too_many|\b429\b/i.test(result.error ?? ""));
}

function retryDelayMs(retry: SlackRetryConfig | null, providerHint: number | undefined, retryAttempt: number): number | null {
  if (providerHint !== undefined) {
    return Number.isSafeInteger(providerHint) && providerHint > 0 &&
      providerHint <= Number.MAX_SAFE_INTEGER - Date.now()
      ? providerHint
      : null;
  }
  const base = retry?.base_delay_ms ?? DEFAULT_RETRY.base_delay_ms;
  const max = retry?.max_delay_ms ?? DEFAULT_RETRY.max_delay_ms;
  const jitterRatio = retry?.jitter_ratio ?? DEFAULT_RETRY.jitter_ratio;
  const random = retry?.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** Math.max(0, retryAttempt - 1));
  return Math.max(1, Math.floor(exponential * (1 + ((random() * 2) - 1) * jitterRatio)));
}

async function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
  injectedSleep?: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (!Number.isSafeInteger(ms) || ms < 0 || signal?.aborted) return false;
  if (ms === 0) return true;
  if (injectedSleep) {
    await injectedSleep(ms);
    return !signal?.aborted;
  }
  let remaining = ms;
  while (remaining > 0) {
    if (signal?.aborted) return false;
    const chunk = Math.min(remaining, 2_147_000_000);
    const completed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(true);
      }, chunk);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(false);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (!completed) return false;
    remaining -= chunk;
  }
  return !signal?.aborted;
}
