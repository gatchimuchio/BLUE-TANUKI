import type { ChannelSendPayload } from "@blue-tanuki/protocol";
import type { OutboundChannel, SendContext, SendMeta, SendResult } from "./types.js";
import { classifyChannelDeliveryError } from "./delivery_error.js";

const OUTBOUND_REPLY_REQUEST_ID = Symbol.for("blue-tanuki.outbound-reply-request-id.v1");

/**
 * Attach a gateway-owned request correlation to a reply without adding it to
 * the channel payload or its serialized wire form. The dispatcher moves it to
 * SendMeta and removes the symbol before calling an outbound adapter.
 */
export function correlateOutboundReply<T extends ChannelSendPayload>(payload: T, requestId: string): T {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) {
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
    const correlatedPayload = payload as ChannelSendPayload & { [OUTBOUND_REPLY_REQUEST_ID]?: unknown };
    const replyRequestId = correlatedPayload[OUTBOUND_REPLY_REQUEST_ID];
    const { [OUTBOUND_REPLY_REQUEST_ID]: _replyRequestId, ...channelPayload } = correlatedPayload;
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
  }

  list(): readonly string[] {
    return Array.from(this.channels.keys());
  }
}
