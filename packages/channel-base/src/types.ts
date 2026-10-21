import type {
  InboundRequest,
  ChannelSendPayload,
  TransientImageInput,
  TransientAudioInput,
} from "@blue-tanuki/protocol";
import type { ChannelDeliveryErrorKind } from "./delivery_error.js";

/**
 * Handler called by an InboundChannel when a normalized request arrives.
 * The handler is supplied by InboundRouter and ultimately wires to
 * HDS-BRAIN's `decide()`.
 */
/** Volatile adapter bytes correlated to exactly one canonical inbound request. */
export interface InboundEphemeralContext {
  readonly request_id: string;
  readonly ephemeral_images: readonly TransientImageInput[];
  readonly ephemeral_audio?: readonly TransientAudioInput[];
}

export type InboundHandler = (req: InboundRequest, context?: InboundEphemeralContext) => Promise<void>;

/**
 * Inbound channel (e.g. Slack RTM, Discord gateway, WebChat HTTP/WS).
 *
 * Responsible for:
 *   1. Listening on its native protocol
 *   2. Normalizing raw events into `InboundRequest`
 *   3. Calling the supplied handler exactly once per inbound message
 *
 * Channels MUST NOT call LLMs or perform business logic. They are pure
 * I/O adapters. The upstream HDS-BRAIN owns all judgment.
 */
export interface InboundChannel {
  readonly name: string;
  /** Begin listening. The handler is wired by InboundRouter. */
  start(handler: InboundHandler): Promise<void>;
  /** Stop listening and release resources. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Metadata attached when dispatching an outbound send.
 * Carries the upstream commit hash so receiving systems can correlate
 * the send with the F→M→C decision that authorized it.
 */
export interface SendMeta {
  command_id: string;
  upstream_commit_hash: string;
}

/** Ephemeral execution controls, kept separate from correlation/audit metadata. */
export interface SendContext {
  signal?: AbortSignal;
}

/**
 * Result of a channel send attempt.
 */
export interface SendResult {
  delivered: boolean;
  /** A cancelled request may have reached the remote service before its reply was lost. */
  delivery_status?: "delivered" | "not_delivered" | "unknown";
  /** Native message identifier (e.g. Slack ts, Discord message id). */
  external_id?: string;
  error?: string;
  error_kind?: ChannelDeliveryErrorKind;
  error_code?: string;
  retry_after_ms?: number;
  next_action?: string;
}

/**
 * Outbound channel (e.g. Slack web API, Discord REST, WebChat WS push).
 *
 * Note: outbound channels do not own lifecycle hooks of their own. When a
 * concrete implementation is _also_ an InboundChannel (which is the common
 * case in BLUE-TANUKI — WebChat/Slack/Discord all are), its single
 * `start()/stop()` from InboundChannel governs the whole lifecycle.
 */
export interface OutboundChannel {
  readonly name: string;
  send(payload: ChannelSendPayload, meta: SendMeta, context?: SendContext): Promise<SendResult>;
}
