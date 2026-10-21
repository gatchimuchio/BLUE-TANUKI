/**
 * Transport abstraction for the Discord channel.
 *
 * Production wraps `discord.js` Client. Tests inject a fake.
 * Mirror of the Slack pattern; see packages/channel-slack/src/transport.ts.
 */
import type { ChannelDeliveryErrorKind } from "@blue-tanuki/channel-base";

export interface DiscordInboundMessage {
  /** Discord channel snowflake. */
  channel_id: string;
  /** Sender user snowflake. */
  user_id: string;
  /** Best-effort display name (member nickname or username). */
  user_display: string;
  /** Message text. Bot mention prefix already stripped. */
  text: string;
  /** Message snowflake (ordering / dedup key). */
  message_id: string;
  /** True iff received via DM channel. */
  is_dm: boolean;
  /** True iff the bot was mentioned in a guild message. */
  is_mention: boolean;
  /** Optional guild snowflake; absent for DMs. */
  guild_id?: string | null;
}

export type DiscordInboundHandler = (m: DiscordInboundMessage) => Promise<void>;

/** Exact owner-maintained admission scope; a null guild id means a DM. */
export interface DiscordInboundGrant {
  readonly guild_id: string | null;
  readonly channel_id: string;
  readonly user_id: string;
}

export type DiscordEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type DiscordEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: DiscordEventDeliveryState }
  | { readonly status: "identity_conflict" };

/** Gateway-owned durable replay boundary, scoped to one bot installation. */
export interface DiscordEventInbox {
  claim(message_id: string, payload_digest: string): DiscordEventClaim;
  settle(message_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown"): void;
}

export interface DiscordPostResult {
  ok: boolean;
  /** Native message snowflake on success. */
  message_id?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  /** `not_delivered` is only used when the transport knows Discord rejected the request. */
  delivery_status?: "not_delivered" | "unknown";
  /** True only for a confirmed HTTP 429 rejection, never inferred from error text. */
  rate_limit_rejected?: boolean;
  /** True when a confirmed HTTP 429 carried a missing or invalid Retry-After hint. */
  retry_after_invalid?: boolean;
  retry_after_ms?: number;
}

export type DiscordOutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";

export interface DiscordOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: "discord";
  readonly target: string;
  readonly text: string;
  readonly reply_to_message_id?: string;
}

export interface DiscordOutboundDeliveryClaim extends DiscordOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}

export interface DiscordPendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}

export interface DiscordOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: DiscordOutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly retry_after_ms?: number;
  readonly external_message_id?: string;
  readonly error_code?: string;
}

/** Gateway-owned durable outbound boundary; payload is removed after terminal settlement. */
export interface DiscordOutboundDeliveryStore {
  enqueue(input: DiscordOutboundDeliveryInput, now_ms?: number): void;
  pending(): readonly DiscordPendingDelivery[];
  claimDelivery(delivery_id: string, now_ms?: number): DiscordOutboundDeliveryClaim | null;
  scheduleRetry(delivery_id: string, not_before_ms: number, retry_after_ms: number, now_ms?: number): void;
  settleDelivery(delivery_id: string,
    state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result?: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number },
    now_ms?: number): void;
  cancelPending(delivery_id: string, now_ms?: number): void;
  status(delivery_id: string): DiscordOutboundDeliveryStatus | null;
}

export interface DiscordTransport {
  start(handler: DiscordInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: { channel: string; text: string; reply_to_message_id?: string }): Promise<DiscordPostResult>;
  getBotUserId(): string | undefined;
}
