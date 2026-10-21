/**
 * Transport abstraction for the Slack channel.
 *
 * The concrete production implementation (BoltTransport) wraps `@slack/bolt`
 * Socket Mode + WebClient. Tests inject a fake transport instead, so the
 * adapter logic in `SlackChannel` (filtering, normalization, dedup) can be
 * exercised without a real Slack workspace.
 */

import type { ChannelDeliveryErrorKind } from "@blue-tanuki/channel-base";

export interface SlackInboundMessage {
  /** Authenticated Slack workspace identity from the outer Events API payload. */
  team_id: string;
  /** Slack Events API identity used only for durable replay suppression. */
  event_id: string;
  /** Slack channel id, e.g. "C12345" or "D12345" (DM). */
  channel_id: string;
  /** Slack user id of the sender, e.g. "U12345". */
  user_id: string;
  /** Best-effort display name. May be the user_id itself if lookup fails. */
  user_display: string;
  /** Message text. For mentions, the leading bot mention is already stripped. */
  text: string;
  /** Slack ts of the message (ordering / dedup key). */
  ts: string;
  /** Parent thread ts, if this is a threaded reply; null means channel root. */
  thread_ts: string | null;
  /** True iff received via DM (channel id starts with "D"). */
  is_dm: boolean;
  /** True iff the bot was @-mentioned in the text. */
  is_mention: boolean;
}

/** Exact owner-configured Slack message admission scope. */
export interface SlackInboundGrant {
  readonly team_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly thread_ts: string | null;
}

export type SlackEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";

export type SlackEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: SlackEventDeliveryState }
  | { readonly status: "identity_conflict" };

/** Gateway-owned durable store; implementations persist digests, never event bodies. */
export interface SlackEventInbox {
  claim(event_id: string, payload_digest: string): SlackEventClaim;
  settle(event_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown"): void;
}

export type SlackInboundHandler = (m: SlackInboundMessage) => Promise<void>;

export interface SlackPostResult {
  ok: boolean;
  /** Native Slack message ts on success. */
  ts?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  /**
   * If the underlying transport recognized a rate-limit signal (e.g. an
   * HTTP 429 with a `Retry-After` header), it MAY surface that here in
   * milliseconds. The SlackChannel uses this to schedule a backoff retry.
   */
  retry_after_ms?: number;
}

/**
 * Anything that can listen for Slack messages and post replies.
 *
 * Lifecycle: start(handler) → ... → stop(). Idempotent stop().
 *
 * `getBotUserId()` is used by SlackChannel for self-message filtering
 * (the bot must never react to its own posts). Implementations should
 * resolve this during start() (e.g. via `auth.test`) and cache it.
 */
export interface SlackTransport {
  start(handler: SlackInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult>;
  getBotUserId(): string | undefined;
}
