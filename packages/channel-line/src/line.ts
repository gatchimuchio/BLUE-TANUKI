import { createHash, randomUUID } from "node:crypto";
import type {
  ChannelSendPayload,
  InboundRequest,
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
import {
  LineMessagingTransport,
  type LineFetch,
  type LineInboundMessage,
  type LineOutboundDeliveryStore,
  type LinePostResult,
  type LineTransport,
} from "./transport.js";

export interface LineInboundGrant {
  readonly destination: string;
  readonly source_type: "user" | "group" | "room";
  readonly source_id: string;
  readonly user_id: string;
}

export type LineEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: "dispatching" | "handler_returned" | "outcome_unknown" }
  | { readonly status: "identity_conflict" };

export interface LineInboundEventInbox {
  claim(eventId: string, payloadDigest: string, nowMs?: number): LineEventClaim;
  settle(eventId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown", nowMs?: number): void;
}

export interface LineRetryConfig {
  max_retries: number;
  base_delay_ms?: number;
  max_delay_ms?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LineOptions {
  /** LINE Messaging API channel access token. Env: LINE_CHANNEL_ACCESS_TOKEN. */
  channel_access_token?: string;
  /** Channel secret used only to authenticate raw webhook bodies. */
  channel_secret?: string;
  /** Exact LINE Official Account user ID from the signed webhook envelope. */
  channel_destination?: string;
  /** Exact identity grants; absent or empty configuration denies all inbound messages. */
  inbound_grants?: readonly LineInboundGrant[];
  /** Gateway-owned digest-only replay inbox; inbound is disabled without it. */
  inbox?: LineInboundEventInbox;
  /** Gateway-owned durable outbox required for every active transport. */
  delivery_store?: LineOutboundDeliveryStore;
  /** Pending reply payload expiry. Default: 24 hours. */
  delivery_ttl_ms?: number;
  webhook_host?: string;
  webhook_port?: number;
  webhook_route?: string;
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
};
const DEFAULT_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

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
  private lifecycleAbort = new AbortController();

  constructor(private readonly opts: LineOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;

    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.channel_access_token || (this.opts.channel_secret && this.opts.channel_destination)) {
      this.transport = new LineMessagingTransport({
        channel_access_token: this.opts.channel_access_token,
        channel_secret: this.opts.channel_secret,
        channel_destination: this.opts.channel_destination,
        webhook_host: this.opts.webhook_host,
        webhook_port: this.opts.webhook_port,
        webhook_route: this.opts.webhook_route,
        fetch: this.opts.fetch,
        request_timeout_ms: this.opts.request_timeout_ms,
        log: this.opts.log,
      });
    } else {
      this.silent = true;
      this.log("[line] WARN LINE_CHANNEL_ACCESS_TOKEN unset - running in silent mode");
      this.started = true;
      return;
    }

    if (!this.opts.delivery_store) throw new Error("line_durable_delivery_store_required_for_active_transport");
    validateRetryConfig(this.opts.retry, this.opts.delivery_ttl_ms);
    this.lifecycleAbort = new AbortController();
    this.started = true;

    try {
      await this.transport.start(async (m) => {
        if (!isValidInboundMessage(m) || m.destination !== this.opts.channel_destination) {
          this.log("[line] rejected inbound event with invalid identity");
          return;
        }
        if (!this.opts.inbound_grants?.some((grant) => lineGrantMatches(grant, m))) {
          this.log("[line] rejected inbound event without an exact owner grant");
          return;
        }
        const inbox = this.opts.inbox;
        if (!inbox) {
          this.log("[line] rejected inbound event because durable admission is unavailable");
          return;
        }
        const eventId = m.webhook_event_id;
        const payloadDigest = lineInboundPayloadDigest(m);
        let claim: LineEventClaim;
        try {
          claim = inbox.claim(eventId, payloadDigest);
        } catch {
          this.log("[line] rejected inbound event because durable admission failed");
          return;
        }
        if (claim.status !== "accepted") {
          this.log(`[line] suppressed inbound event status=${claim.status}`);
          return;
        }

        let deliveryState: "handler_returned" | "outcome_unknown" = "handler_returned";
        try {
          await handler(normalizeLineInbound(m));
        } catch {
          deliveryState = "outcome_unknown";
          throw new Error("line_inbound_handler_failed");
        } finally {
          try {
            inbox.settle(eventId, payloadDigest, deliveryState);
          } catch {
            this.log("[line] inbound settlement failed; replay remains blocked");
            throw new Error("line_inbound_settlement_failed");
          }
        }
      });
      this.silent = false;
      this.log("[line] active");
      for (const pending of this.opts.delivery_store.pending()) {
        void this.dispatchPersistedDelivery(pending.delivery_id).then((result) => {
          this.log(`[line] recovered outbound delivery state=${result.ok ? "delivered" : result.delivery_status ?? "unknown"}`);
        }).catch(() => this.log("[line] recovered outbound delivery remains unresolved"));
      }
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

  async send(payload: ChannelSendPayload, meta: SendMeta, context?: SendContext): Promise<SendResult> {
    if (context?.signal?.aborted) return { delivered: false, delivery_status: "not_delivered",
      error: "channel_send_cancelled_before_dispatch", error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
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

    const deliveryId = randomUUID();
    const now = Date.now();
    const ttl = this.opts.delivery_ttl_ms ?? DEFAULT_DELIVERY_TTL_MS;
    let r: LinePostResult;
    try {
      this.opts.delivery_store!.enqueue({
        delivery_id: deliveryId,
        channel: "line",
        target: payload.target,
        text: payload.content,
        expires_at_ms: now + ttl,
      }, now);
      r = await this.dispatchPersistedDelivery(deliveryId, context?.signal);
    } catch {
      r = { ok: false, delivery_status: "unknown", error: "line_delivery_state_unavailable",
        error_kind: "non_recoverable", error_code: "delivery_state_unavailable" };
    }

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
      return { delivered: true, delivery_status: "delivered", external_id };
    }
    return {
      delivered: false,
      delivery_status: r.delivery_status ?? "unknown",
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

  private async dispatchPersistedDelivery(deliveryId: string, callerSignal?: AbortSignal): Promise<LinePostResult> {
    const store = this.opts.delivery_store!;
    const retry = this.opts.retry === false ? null : { ...DEFAULT_RETRY, ...this.opts.retry };
    while (true) {
      if (callerSignal?.aborted) {
        try { return stopPendingAfterCallerCancellation(store, deliveryId); }
        catch { return { ok: false, delivery_status: "unknown", error: "line_delivery_state_unavailable",
          error_code: "delivery_state_unavailable" }; }
      }
      const pending = store.pending().find((row) => row.delivery_id === deliveryId);
      if (!pending) {
        const status = store.status(deliveryId);
        if (status?.delivery_state === "delivered") return {
          ok: true, delivery_status: "delivered", request_id: status.external_request_id,
        };
        const delivery_status = status?.delivery_state === "not_delivered" || status?.delivery_state === "retry_exhausted"
          ? "not_delivered" : "unknown";
        return { ok: false, delivery_status, error: status?.error_code ?? "line_delivery_state_unavailable",
          error_code: status?.error_code,
          ...(status?.retry_after_ms === undefined ? {} : { retry_after_ms: status.retry_after_ms }) };
      }

      const delay = Math.max(0, pending.not_before_ms - Date.now());
      const lifecycleSignal = this.lifecycleAbort.signal;
      const waitSignal = callerSignal ? AbortSignal.any([callerSignal, lifecycleSignal]) : lifecycleSignal;
      if (delay > 0 && !await sleepWithSignal(delay, waitSignal, retry?.sleep)) {
        if (callerSignal?.aborted) {
          try { return stopPendingAfterCallerCancellation(store, deliveryId); }
          catch { return { ok: false, delivery_status: "unknown", error: "line_delivery_state_unavailable",
            error_code: "delivery_state_unavailable" }; }
        }
        return { ok: false, delivery_status: "not_delivered", error: "line_delivery_wait_interrupted",
          error_code: "delivery_wait_interrupted", retry_after_ms: delay };
      }
      if (callerSignal?.aborted) {
        try { return stopPendingAfterCallerCancellation(store, deliveryId); }
        catch { return { ok: false, delivery_status: "unknown", error: "line_delivery_state_unavailable",
          error_code: "delivery_state_unavailable" }; }
      }
      if (lifecycleSignal.aborted) return { ok: false, delivery_status: "not_delivered",
        error: "line_delivery_wait_interrupted", error_code: "delivery_wait_interrupted",
        ...(delay > 0 ? { retry_after_ms: delay } : {}) };

      const claim = store.claimDelivery(deliveryId);
      if (!claim) continue;
      if (callerSignal?.aborted) {
        store.settleDelivery(deliveryId, "not_delivered", { error_code: "cancelled_before_dispatch" });
        return cancelledBeforeDispatch();
      }
      let result: LinePostResult;
      try {
        result = await this.transport!.postMessage({ target: claim.target, text: claim.text, retry_key: claim.delivery_id },
          callerSignal ? AbortSignal.any([callerSignal, lifecycleSignal]) : lifecycleSignal);
      } catch {
        result = { ok: false, delivery_status: "unknown", error: "line_transport_outcome_unknown",
          error_kind: "non_recoverable", error_code: "delivery_outcome_unknown" };
      }
      if (result.ok) {
        store.settleDelivery(deliveryId, "delivered", {
          ...(result.request_id ? { external_request_id: result.request_id } : {}),
        });
        return { ...result, delivery_status: "delivered" };
      }

      if (result.rate_limit_rejected) {
        if (result.retry_after_invalid) {
          store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "retry_after_invalid" });
          return { ...result, delivery_status: "not_delivered", error_code: "retry_after_invalid" };
        }
        if (result.retry_after_ms === undefined) {
          store.settleDelivery(deliveryId, "not_delivered", { error_code: "retry_after_missing" });
          return { ...result, delivery_status: "not_delivered", error_code: "retry_after_missing" };
        }
        if (!retry || claim.attempt_count > retry.max_retries) {
          store.settleDelivery(deliveryId, "retry_exhausted", {
            error_code: "rate_limited", retry_after_ms: result.retry_after_ms,
          });
          return { ...result, delivery_status: "not_delivered", error_code: "rate_limited" };
        }
        const notBefore = Date.now() + result.retry_after_ms;
        if (!Number.isSafeInteger(notBefore) || notBefore >= claim.expires_at_ms) {
          store.settleDelivery(deliveryId, "retry_exhausted", {
            error_code: "delivery_expired", retry_after_ms: result.retry_after_ms,
          });
          return { ...result, delivery_status: "not_delivered", error_code: "delivery_expired" };
        }
        store.scheduleRetry(deliveryId, notBefore, result.retry_after_ms);
        if (callerSignal?.aborted) {
          try { store.cancelPending(deliveryId); } catch { /* already settled */ }
          return { ...result, delivery_status: "not_delivered" };
        }
        if (lifecycleSignal.aborted) return { ...result, delivery_status: "not_delivered" };
        this.log(`[line] persisted rate-limit retry attempt=${claim.attempt_count} delay_ms=${result.retry_after_ms} delivery=${deliveryId.slice(0, 8)}`);
        continue;
      }

      if (result.idempotent_retryable && retry) {
        if (callerSignal?.aborted) {
          store.settleDelivery(deliveryId, "outcome_unknown", { error_code: "caller_cancelled_after_ambiguous_send" });
          return { ...result, delivery_status: "unknown", error_code: "caller_cancelled_after_ambiguous_send" };
        }
        if (claim.attempt_count > retry.max_retries) {
          store.settleDelivery(deliveryId, "outcome_unknown", { error_code: "retry_exhausted" });
          return { ...result, delivery_status: "unknown", error_code: "retry_exhausted" };
        }
        const backoff = Math.min(retry.max_delay_ms!, retry.base_delay_ms! * (2 ** (claim.attempt_count - 1)));
        const notBefore = Date.now() + backoff;
        if (!Number.isSafeInteger(notBefore) || notBefore >= claim.expires_at_ms) {
          store.settleDelivery(deliveryId, "outcome_unknown", { error_code: "delivery_expired" });
          return { ...result, delivery_status: "unknown", error_code: "delivery_expired" };
        }
        store.scheduleRetry(deliveryId, notBefore, undefined, Date.now(), "server_retry");
        if (callerSignal?.aborted) {
          try { store.abandonPending(deliveryId, "outcome_unknown", "caller_cancelled_after_ambiguous_send"); } catch { /* already settled */ }
          return { ...result, delivery_status: "unknown", error: "caller_cancelled_after_ambiguous_send",
            error_code: "caller_cancelled_after_ambiguous_send" };
        }
        if (lifecycleSignal.aborted) return { ...result, delivery_status: "unknown" };
        this.log(`[line] persisted idempotent retry attempt=${claim.attempt_count} delay_ms=${backoff} delivery=${deliveryId.slice(0, 8)}`);
        continue;
      }

      store.settleDelivery(deliveryId,
        result.delivery_status === "not_delivered" ? "not_delivered" : "outcome_unknown",
        { ...(result.error_code ? { error_code: result.error_code } : {}) });
      return result;
    }
  }
}

function normalizeLineInbound(m: LineInboundMessage): InboundRequest {
  return {
    id: randomUUID(),
    channel: "line",
    user: `line:${lineActorDigest(m.destination, m.user_id!)}`,
    content: m.text,
    timestamp: m.event_timestamp_ms,
    metadata: {
      reply_to: m.source_id,
      line_destination: m.destination,
      line_source_type: m.source_type,
      line_source_id: m.source_id,
      line_user_id: m.user_id,
      line_message_id: m.message_id,
      line_webhook_event_id: m.webhook_event_id,
      line_is_redelivery: m.is_redelivery,
      line_event_timestamp_ms: m.event_timestamp_ms,
    },
  };
}

function isValidInboundMessage(message: LineInboundMessage): boolean {
  return Boolean(message) &&
    isSafeLineIdentifier(message.destination) &&
    (message.source_type === "user" || message.source_type === "group" || message.source_type === "room") &&
    isSafeLineIdentifier(message.source_id) &&
    isSafeLineIdentifier(message.user_id) &&
    isSafeLineIdentifier(message.message_id) &&
    /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/iu.test(message.webhook_event_id) &&
    Number.isSafeInteger(message.event_timestamp_ms) && message.event_timestamp_ms > 0 &&
    typeof message.is_redelivery === "boolean" &&
    typeof message.text === "string" && message.text.length > 0 && message.text.length <= 5000 &&
    (message.source_type !== "user" || message.source_id === message.user_id);
}

function lineGrantMatches(grant: LineInboundGrant, message: LineInboundMessage): boolean {
  return grant.destination === message.destination &&
    grant.source_type === message.source_type &&
    grant.source_id === message.source_id &&
    grant.user_id === message.user_id;
}

function lineInboundPayloadDigest(message: LineInboundMessage): string {
  return createHash("sha256").update(JSON.stringify([
    "line-inbound-payload.v1",
    message.destination,
    message.source_type,
    message.source_id,
    message.user_id,
    message.message_id,
    message.webhook_event_id,
    message.event_timestamp_ms,
    message.text,
  ])).digest("hex");
}

function lineActorDigest(destination: string, userId: string): string {
  return createHash("sha256").update(JSON.stringify(["line-actor.v1", destination, userId])).digest("hex");
}

function isSafeLineIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateRetryConfig(retry: LineRetryConfig | false | undefined, ttl: number | undefined): void {
  if (retry !== undefined && retry !== false && (!Number.isSafeInteger(retry.max_retries) || retry.max_retries < 0 ||
      retry.max_retries > 10 || (retry.base_delay_ms !== undefined &&
        (!Number.isSafeInteger(retry.base_delay_ms) || retry.base_delay_ms <= 0 || retry.base_delay_ms > 60_000)) ||
      (retry.max_delay_ms !== undefined &&
        (!Number.isSafeInteger(retry.max_delay_ms) || retry.max_delay_ms <= 0 || retry.max_delay_ms > 60_000)) ||
      (retry.base_delay_ms !== undefined && retry.max_delay_ms !== undefined && retry.max_delay_ms < retry.base_delay_ms))) {
    throw new Error("line_retry_configuration_invalid");
  }
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > DEFAULT_DELIVERY_TTL_MS)) {
    throw new Error("line_delivery_ttl_invalid");
  }
}

function cancelledBeforeDispatch(): LinePostResult {
  return { ok: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
    error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
}

function stopPendingAfterCallerCancellation(store: LineOutboundDeliveryStore, deliveryId: string): LinePostResult {
  const status = store.status(deliveryId);
  if (status?.delivery_state === "retry_wait" && status.error_code === "server_retry") {
    store.abandonPending(deliveryId, "outcome_unknown", "caller_cancelled_after_ambiguous_send");
    return { ok: false, delivery_status: "unknown", error: "caller_cancelled_after_ambiguous_send",
      error_code: "caller_cancelled_after_ambiguous_send" };
  }
  store.cancelPending(deliveryId);
  return cancelledBeforeDispatch();
}

async function sleepWithSignal(ms: number, signal: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<boolean> {
  if (signal.aborted) return false;
  if (sleep) {
    let aborted = false;
    const onAbort = (): void => { aborted = true; };
    signal.addEventListener("abort", onAbort, { once: true });
    try { await sleep(ms); } finally { signal.removeEventListener("abort", onAbort); }
    return !aborted && !signal.aborted;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function lineNextAction(result: LinePostResult): string {
  if (result.delivery_status === "unknown") {
    return "LINE delivery remains unresolved. Review the Gateway delivery record before creating a new send for the same reply.";
  }
  if (result.error_code === "rate_limited") {
    return "LINE rejected the message at the rate limit and the retry budget is exhausted. Confirm delivery state before sending it again.";
  }
  if (result.error_code === "retry_after_missing" || result.error_code === "retry_after_invalid") {
    return "LINE rate limiting did not provide a usable retry interval. The reply was not resent; inspect the delivery record before trying again.";
  }
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
