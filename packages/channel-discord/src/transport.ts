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
  /**
   * If the underlying transport recognized a rate-limit signal (HTTP 429
   * with `retry_after`), it MAY surface that here in milliseconds. The
   * DiscordChannel uses this to schedule a backoff retry.
   */
  retry_after_ms?: number;
}

export interface DiscordTransport {
  start(handler: DiscordInboundHandler): Promise<void>;
  stop(): Promise<void>;
  postMessage(args: { channel: string; text: string }): Promise<DiscordPostResult>;
  getBotUserId(): string | undefined;
}
