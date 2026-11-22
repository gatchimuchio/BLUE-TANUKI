import { createHash } from "node:crypto";
import type { ChannelSendPayload } from "@blue-tanuki/protocol";
import type { InboundLineReplyContext, OutboundChannel, SendContext, SendMeta, SendResult } from "./types.js";
import { classifyChannelDeliveryError } from "./delivery_error.js";

const OUTBOUND_REPLY_REQUEST_ID = Symbol.for("blue-tanuki.outbound-reply-request-id.v1");
const OUTBOUND_LINE_REPLY_CONTEXT = Symbol.for("blue-tanuki.outbound-line-reply-context.v1");
const OUTBOUND_TARGET_LOCK_TAILS = new Map<string, Promise<void>>();
const INBOUND_LINE_REPLY_CONTEXTS = new Map<string, { readonly context: InboundLineReplyContext; consumed: boolean }>();

export type OutboundLineReplyContext = InboundLineReplyContext;

/** Bind a signed LINE webhook's one-use reply capability to its in-flight request only. */
export function registerInboundLineReplyContext(requestId: string, context: InboundLineReplyContext): void {
  if (!isUuid(requestId) || !Number.isSafeInteger(context.expires_at_ms) || context.expires_at_ms < 0 ||
      (context.reply_token !== null && !(context.reply_token instanceof Uint8Array))) {
    throw new Error("inbound_line_reply_context_invalid");
  }
  if (INBOUND_LINE_REPLY_CONTEXTS.has(requestId)) throw new Error("inbound_line_reply_context_conflict");
  INBOUND_LINE_REPLY_CONTEXTS.set(requestId, { context, consumed: false });
}

/** Move the one-use context onto the immediate reply without exposing it to JSON/history. */
export function attachInboundLineReplyContext<T extends ChannelSendPayload>(payload: T, requestId: string): T {
  if (!isUuid(requestId)) return payload;
  const entry = INBOUND_LINE_REPLY_CONTEXTS.get(requestId);
  if (!entry) return payload;
  const context = entry.consumed
    ? { reply_token: null, expires_at_ms: entry.context.expires_at_ms }
    : entry.context;
  entry.consumed = true;
  Object.defineProperty(payload, OUTBOUND_LINE_REPLY_CONTEXT, {
    value: context,
    enumerable: false,
    configurable: true,
  });
  return payload;
}

/** Release request-scoped state and erase its token even when no reply was produced. */
export function clearInboundLineReplyContext(requestId: string): void {
  const entry = INBOUND_LINE_REPLY_CONTEXTS.get(requestId);
  entry?.context.reply_token?.fill(0);
  INBOUND_LINE_REPLY_CONTEXTS.delete(requestId);
}

/** Transfer the private context through the dispatcher to the LINE adapter. */
export function takeOutboundLineReplyContext(payload: ChannelSendPayload): OutboundLineReplyContext | undefined {
  const object = payload as ChannelSendPayload & { [OUTBOUND_LINE_REPLY_CONTEXT]?: OutboundLineReplyContext };
  const context = object[OUTBOUND_LINE_REPLY_CONTEXT];
  if (context) delete object[OUTBOUND_LINE_REPLY_CONTEXT];
  return context;
}

function attachOutboundLineReplyContext(payload: ChannelSendPayload, context: OutboundLineReplyContext): void {
  Object.defineProperty(payload, OUTBOUND_LINE_REPLY_CONTEXT, {
    value: context,
    enumerable: false,
    configurable: true,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function acquireOutboundTargetLock(key: string): Promise<() => void> {
  const previous = OUTBOUND_TARGET_LOCK_TAILS.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const tail = previous.then(() => current);
  OUTBOUND_TARGET_LOCK_TAILS.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (OUTBOUND_TARGET_LOCK_TAILS.get(key) === tail) OUTBOUND_TARGET_LOCK_TAILS.delete(key);
  };
}

function outboundTargetLockKey(payload: ChannelSendPayload): string {
  const targetDigest = createHash("sha256").update(JSON.stringify([
    "blue-tanuki.outbound-channel-target-lock.v1",
    payload.channel,
    payload.target,
  ]), "utf8").digest("hex");
  return `outbound-channel-target:${targetDigest}`;
}

async function acquireOutboundTargetLockUnlessCancelled(
  key: string,
  signal?: AbortSignal,
): Promise<(() => void) | undefined> {
  const pending = acquireOutboundTargetLock(key);
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.then((release) => release(), () => undefined);
    return undefined;
  }

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve(null);
  });
  const acquired = await Promise.race([pending, cancelled]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (!acquired) {
    // Keep the queue usable if this cancelled waiter reaches the head later.
    void pending.then((release) => release(), () => undefined);
    return undefined;
  }
  if (signal.aborted) {
    acquired();
    return undefined;
  }
  return acquired;
}

/**
 * Attach a gateway-owned request correlation to a reply without adding it to
 * the channel payload or its serialized wire form. The dispatcher moves it to
 * SendMeta and removes the symbol before calling an outbound adapter.
 */
export function correlateOutboundReply<T extends ChannelSendPayload>(payload: T, requestId: string): T {
  if (!isUuid(requestId)) {
    throw new Error("outbound_reply_request_id_invalid");
  }
  Object.defineProperty(payload, OUTBOUND_REPLY_REQUEST_ID, {
    value: requestId,
    enumerable: true,
    configurable: false,
  });
  return payload;
}

/**
 * OutboundDispatcher — routes ChannelSendPayload to the matching OutboundChannel.
 *
 * Routing is done by `payload.channel` exact match against `OutboundChannel.name`.
 * Unknown channels return a structured failure (never throw) so the executor
 * can record it as ExecuteFeedback without crashing.
 */
export class OutboundDispatcher {
  private readonly channels = new Map<string, OutboundChannel>();

  register(channel: OutboundChannel): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`OutboundDispatcher: channel already registered: ${channel.name}`);
    }
    this.channels.set(channel.name, channel);
  }

  async dispatch(
    payload: ChannelSendPayload,
    meta: SendMeta,
    context?: SendContext,
  ): Promise<SendResult> {
    if (context?.signal?.aborted) {
      return { delivered: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
        error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
    }
    const ch = this.channels.get(payload.channel);
    if (!ch) {
      return {
        delivered: false,
        error: `no_channel_registered:${payload.channel}`,
        error_kind: "non_recoverable",
        error_code: "no_channel_registered",
        next_action: `Register or enable the ${payload.channel} channel before retrying this send.`,
      };
    }
    const releaseTarget = await acquireOutboundTargetLockUnlessCancelled(outboundTargetLockKey(payload), context?.signal);
    if (!releaseTarget) {
      return { delivered: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
        error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
    }
    try {
      if (context?.signal?.aborted) {
        return { delivered: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
          error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
      }
      const lineReplyContext = takeOutboundLineReplyContext(payload);
      const correlatedPayload = payload as ChannelSendPayload & { [OUTBOUND_REPLY_REQUEST_ID]?: unknown };
      const replyRequestId = correlatedPayload[OUTBOUND_REPLY_REQUEST_ID];
      const { [OUTBOUND_REPLY_REQUEST_ID]: _replyRequestId, ...channelPayload } = correlatedPayload;
      if (lineReplyContext) attachOutboundLineReplyContext(channelPayload, lineReplyContext);
      const sendMeta = typeof replyRequestId === "string"
        ? { ...meta, request_id: replyRequestId }
        : meta;
      try {
        const result = await ch.send(channelPayload, sendMeta, context);
        if (context?.signal?.aborted && !result.delivered && result.delivery_status !== "not_delivered") {
          return { ...result, delivery_status: "unknown", error: "channel_send_cancelled; delivery outcome unknown",
            error_kind: "non_recoverable", error_code: "delivery_outcome_unknown",
            next_action: "Check the destination's delivery status before deciding whether to send again." };
        }
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const details = classifyChannelDeliveryError({ error });
        return {
          delivered: false,
          error,
          ...details,
          ...(context?.signal?.aborted
            ? { delivery_status: "unknown" as const, error_code: "delivery_outcome_unknown",
                next_action: "Check the destination's delivery status before deciding whether to send again." }
            : { next_action: details.error_kind === "recoverable"
                ? "Retry after the channel transport recovers."
                : "Inspect the channel configuration before retrying." }),
        };
      }
    } finally {
      releaseTarget();
    }
  }

  list(): readonly string[] {
    return Array.from(this.channels.keys());
  }
}
