import type { ChannelSendPayload } from "@blue-tanuki/protocol";
import type { OutboundChannel, SendContext, SendMeta, SendResult } from "./types.js";
import { classifyChannelDeliveryError } from "./delivery_error.js";

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
    try {
      const result = await ch.send(payload, meta, context);
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
