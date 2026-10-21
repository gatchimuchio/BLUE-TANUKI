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
  DiscordEventInbox,
  DiscordInboundGrant,
  DiscordInboundMessage,
  DiscordTransport,
  DiscordPostResult,
  DiscordOutboundDeliveryStore,
} from "./transport.js";
import { DiscordJsTransport } from "./discordjs_transport.js";

export interface DiscordRetryConfig {
  max_retries: number;
  /** Testable delay hook; production wait is driven by Discord's Retry-After. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DiscordOptions {
  /** Bot token. Env: DISCORD_BOT_TOKEN. Absent → silent. */
  bot_token?: string;
  /** Inject a fake transport for tests. */
  transport?: DiscordTransport;
  /** Exact owner-configured inbound grants; missing or empty rejects all messages. */
  inbound_grants?: readonly DiscordInboundGrant[];
  /** Gateway-owned durable message replay boundary; required for the live transport. */
  inbox?: DiscordEventInbox;
  /** Gateway-owned durable outbound queue; required when a bot token enables Discord. */
  delivery_store?: DiscordOutboundDeliveryStore;
  /** Durable retry budget for confirmed Discord rate-limit rejections. */
  retry?: DiscordRetryConfig | false;
  log?: (line: string) => void;
}

const DEFAULT_RETRY: DiscordRetryConfig = {
  max_retries: 3,
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
 * Discord channel — Phase 3 real-SDK integration.
 *
 * Mirror of SlackChannel: silent fallback on missing token, transport
 * dependency injection for tests, metadata-tagged inbound for reply routing.
 *
 * Inbound filtering invariants (enforced by DiscordJsTransport):
 *   - bot's own messages dropped
 *   - any other bot's messages dropped (echo loop prevention with other bots)
 *   - in guild text channels, only @-mentions trigger handling
 *   - DMs always handled
 *
 * Outbound:
 *   - target = Discord channel snowflake. The originating
 *     InboundRequest.metadata.reply_to carries this from inbound.
 */
export class DiscordChannel implements InboundChannel, OutboundChannel {
  readonly name = "discord";
  private readonly history: SentRecord[] = [];
  private silent = false;
  private started = false;
  private counter = 0;
  private transport: DiscordTransport | null = null;
  private lifecycleAbort = new AbortController();

  constructor(private readonly opts: DiscordOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;

    if (this.opts.bot_token && !this.opts.inbox) throw new Error("discord_durable_inbox_required_for_live_events");
    if (this.opts.bot_token && !this.opts.delivery_store) throw new Error("discord_durable_delivery_store_required_for_live_sends");
    if (this.opts.transport || this.opts.bot_token) validateRetryConfig(this.opts.retry);

    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.bot_token) {
      this.transport = new DiscordJsTransport({
        bot_token: this.opts.bot_token,
        log: this.opts.log,
      });
    } else {
      this.silent = true;
      this.log(
        "[discord] WARN DISCORD_BOT_TOKEN unset — running in silent mode",
      );
      return;
    }

    this.lifecycleAbort = new AbortController();
    this.silent = false;

    if (!this.opts.inbound_grants?.length) {
      this.log("[discord] WARN DISCORD_INBOUND_GRANTS_JSON unset/empty — inbound messages are rejected");
    }

    this.started = true;
    try {
      await this.transport.start(async (m) => {
        if (!isValidDiscordInboundMessage(m)) {
          this.log("[discord] rejected inbound event with invalid identity");
          return;
        }
        const guildId = m.guild_id ?? null;
        const grant = this.opts.inbound_grants?.some((candidate) =>
          candidate.guild_id === guildId &&
          candidate.channel_id === m.channel_id &&
          candidate.user_id === m.user_id
        );
        if (!grant) return;

        const inbox = this.opts.inbox;
        if (!inbox) {
          this.log("[discord] rejected inbound event because durable admission is unavailable");
          return;
        }
        const payloadDigest = discordInboundPayloadDigest(m);
        let claim;
        try {
          claim = inbox.claim(m.message_id, payloadDigest);
        } catch {
          this.log("[discord] rejected inbound event because durable admission failed");
          return;
        }
        if (claim.status !== "accepted") {
          this.log(`[discord] suppressed inbound event status=${claim.status}`);
          return;
        }

        const inbound: InboundRequest = {
          id: randomUUID(),
          channel: "discord",
          // Display names are mutable labels, never the HDS actor identity.
          user: discordActorIdentity(m),
          content: m.text,
          timestamp: Date.now(),
          metadata: {
            reply_to: m.channel_id,
            discord_user_id: m.user_id,
            discord_channel_id: m.channel_id,
            discord_message_id: m.message_id,
            discord_guild_id: guildId,
            is_dm: m.is_dm,
            is_mention: m.is_mention,
          },
        };
        let deliveryState: "handler_returned" | "outcome_unknown" = "outcome_unknown";
        try {
          await handler(inbound);
          deliveryState = "handler_returned";
        } finally {
          try {
            inbox.settle(m.message_id, payloadDigest, deliveryState);
          } catch {
            this.log("[discord] inbound settlement failed; replay remains blocked");
          }
        }
      });
      this.log("[discord] active");
      for (const pending of this.opts.delivery_store?.pending() ?? []) {
        void this.dispatchPersistedDelivery(pending.delivery_id).then((result) => {
          this.log(`[discord] recovered outbound delivery state=${result.ok ? "delivered" : result.delivery_status ?? "unknown"}`);
        }).catch(() => this.log("[discord] recovered outbound delivery remains unresolved"));
      }
    } catch (e) {
      this.silent = true;
      this.started = false;
      try { await this.transport?.stop(); } catch { /* failed startup remains closed */ }
      this.log(
        `[discord] WARN transport start failed (${e instanceof Error ? e.message : String(e)}); falling back to silent`,
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
      const external_id = `discord-silent-${meta.command_id}-${this.counter}`;
      this.history.push({
        payload,
        meta,
        at,
        external_id,
        ok: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "discord_not_configured",
        next_action:
          "Set DISCORD_BOT_TOKEN, or leave Discord intentionally disabled.",
      });
      this.log(
        `[discord:silent] would-send target=${payload.target} commit=${meta.upstream_commit_hash.slice(0, 8)}… content="${truncate(payload.content, 80)}"`,
      );
      return {
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "discord_not_configured",
        next_action:
          "Set DISCORD_BOT_TOKEN, or leave Discord intentionally disabled.",
      };
    }

    let r: DiscordPostResult;
    const deliveryStore = this.opts.delivery_store;
    if (deliveryStore) {
      const delivery_id = randomUUID();
      deliveryStore.enqueue({
        delivery_id,
        channel: "discord",
        target: payload.target,
        text: payload.content,
        ...(payload.reply_to_message_id ? { reply_to_message_id: payload.reply_to_message_id } : {}),
      });
      r = await this.dispatchPersistedDelivery(delivery_id, context?.signal);
    } else {
      r = await this.dispatchTransient(payload, context?.signal);
    }

    const failureDetails = r.ok
      ? null
      : classifyChannelDeliveryError({
          error: r.error ?? "post_failed",
          retry_after_ms: r.retry_after_ms,
        });
    const outcomeKnown = r.delivery_status === "not_delivered";
    const external_id = r.message_id ?? `discord-${meta.command_id}-${this.counter}`;
    this.history.push({
      payload,
      meta,
      at,
      external_id,
      ok: r.ok,
      error: r.error,
      error_kind: r.ok ? undefined : outcomeKnown ? r.error_kind ?? failureDetails?.error_kind : "non_recoverable",
      error_code: r.ok ? undefined : outcomeKnown ? r.error_code ?? failureDetails?.error_code : "delivery_outcome_unknown",
      retry_after_ms: r.retry_after_ms ?? failureDetails?.retry_after_ms,
      next_action: r.ok ? undefined : outcomeKnown
        ? discordNextAction(r)
        : "Check the destination's delivery status before deciding whether to resend.",
    });
    if (r.ok) {
      this.log(
        `[discord] sent target=${payload.target} message_id=${r.message_id ?? ""} commit=${meta.upstream_commit_hash.slice(0, 8)}…`,
      );
      return { delivered: true, delivery_status: "delivered", external_id };
    }
    this.log(
      `[discord] FAILED target=${payload.target} error=${r.error ?? "unknown"}`,
    );
    const error = r.error ?? "post_failed";
    const details = classifyChannelDeliveryError({
      error,
      retry_after_ms: r.retry_after_ms,
    });
    return {
      delivered: false,
      delivery_status: outcomeKnown ? "not_delivered" : "unknown",
      error,
      error_kind: outcomeKnown ? r.error_kind ?? details.error_kind : "non_recoverable",
      error_code: outcomeKnown ? r.error_code ?? details.error_code : "delivery_outcome_unknown",
      retry_after_ms: r.retry_after_ms ?? details.retry_after_ms,
      next_action: outcomeKnown
        ? discordNextAction(r)
        : "Check the destination's delivery status before deciding whether to resend.",
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

  private async dispatchTransient(payload: ChannelSendPayload, signal?: AbortSignal): Promise<DiscordPostResult> {
    const retry = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);
    let attempt = 0;
    while (true) {
      if (signal?.aborted) return { ok: false, delivery_status: "not_delivered", error: "cancelled_before_dispatch", error_code: "cancelled_before_dispatch" };
      let result: DiscordPostResult;
      try {
        result = await this.transport!.postMessage({
          channel: payload.target,
          text: payload.content,
          ...(payload.reply_to_message_id ? { reply_to_message_id: payload.reply_to_message_id } : {}),
        });
      } catch {
        return { ok: false, delivery_status: "unknown", error: "discord_transport_outcome_unknown", error_code: "delivery_outcome_unknown" };
      }
      if (!isExplicitRateLimitRejection(result)) return result;
      const retryAfter = validRetryAfter(result);
      if (!retry || result.retry_after_invalid || retryAfter === null || attempt >= retry.max_retries) {
        return { ...result, delivery_status: "not_delivered", error_code: result.retry_after_invalid || retryAfter === null ? "invalid_retry_after" : "rate_limited" };
      }
      attempt += 1;
      this.log(`[discord] retry attempt=${attempt} delay_ms=${retryAfter} target=${payload.target}`);
      if (!await sleepWithSignal(retryAfter, signal, retry.sleep)) {
        return { ...result, delivery_status: "not_delivered", error: "cancelled_before_retry", error_code: "cancelled_before_retry" };
      }
    }
  }

  private async dispatchPersistedDelivery(deliveryId: string, callerSignal?: AbortSignal): Promise<DiscordPostResult> {
    const store = this.opts.delivery_store!;
    const retry = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);
    while (true) {
      if (callerSignal?.aborted) {
        try { store.cancelPending(deliveryId); } catch { /* dispatch may already be claimed */ }
        return { ok: false, delivery_status: "not_delivered", error: "cancelled_before_dispatch", error_code: "cancelled_before_dispatch" };
      }
      const pending = store.pending().find((row) => row.delivery_id === deliveryId);
      if (!pending) {
        const status = store.status(deliveryId);
        if (status?.delivery_state === "delivered") return { ok: true, message_id: status.external_message_id };
        const delivery_status = status?.delivery_state === "not_delivered" || status?.delivery_state === "retry_exhausted"
          ? "not_delivered" : "unknown";
        return { ok: false, delivery_status, error: status?.error_code ?? "discord_delivery_state_unavailable",
          error_code: status?.error_code, ...(status?.retry_after_ms ? { retry_after_ms: status.retry_after_ms } : {}) };
      }
      const delayMs = Math.max(0, pending.not_before_ms - Date.now());
      if (delayMs > 0 && !await sleepWithSignal(delayMs, combineSignals(callerSignal, this.lifecycleAbort.signal), retry?.sleep)) {
        if (callerSignal?.aborted) {
          try { store.cancelPending(deliveryId); } catch { /* already claimed or settled */ }
          return { ok: false, delivery_status: "not_delivered", error: "cancelled_before_retry", error_code: "cancelled_before_retry" };
        }
        return { ok: false, delivery_status: "not_delivered", error: "discord_delivery_wait_interrupted",
          error_code: "delivery_wait_interrupted", retry_after_ms: Math.max(1, pending.not_before_ms - Date.now()) };
      }
      if (callerSignal?.aborted) {
        try { store.cancelPending(deliveryId); } catch { /* already claimed or settled */ }
        return { ok: false, delivery_status: "not_delivered", error: "cancelled_before_dispatch", error_code: "cancelled_before_dispatch" };
      }
      if (this.lifecycleAbort.signal.aborted) {
        return { ok: false, delivery_status: "not_delivered", error: "discord_delivery_wait_interrupted",
          error_code: "delivery_wait_interrupted", retry_after_ms: pending.not_before_ms > Date.now()
            ? pending.not_before_ms - Date.now() : undefined };
      }
      const claim = store.claimDelivery(deliveryId);
      if (!claim) continue;
      if (callerSignal?.aborted) {
        store.settleDelivery(deliveryId, "not_delivered", { error_code: "cancelled_before_dispatch" });
        return { ok: false, delivery_status: "not_delivered", error: "cancelled_before_dispatch", error_code: "cancelled_before_dispatch" };
      }
      let result: DiscordPostResult;
      try {
        result = await this.transport!.postMessage({
          channel: claim.target,
          text: claim.text,
          ...(claim.reply_to_message_id ? { reply_to_message_id: claim.reply_to_message_id } : {}),
        });
      } catch {
        result = { ok: false, delivery_status: "unknown", error: "discord_transport_outcome_unknown", error_code: "delivery_outcome_unknown" };
      }
      if (result.ok) {
        store.settleDelivery(deliveryId, "delivered", { ...(result.message_id ? { external_message_id: result.message_id } : {}) });
        return result;
      }
      if (isExplicitRateLimitRejection(result)) {
        const retryAfter = validRetryAfter(result);
        if (result.retry_after_invalid || retryAfter === null) {
          store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "invalid_retry_after" });
          return { ...result, delivery_status: "not_delivered", error_code: "invalid_retry_after" };
        }
        if (retry && claim.attempt_count <= retry.max_retries) {
          store.scheduleRetry(deliveryId, Date.now() + retryAfter, retryAfter);
          if (callerSignal?.aborted) {
            try { store.cancelPending(deliveryId); } catch { /* already settled elsewhere */ }
            return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
          }
          if (this.lifecycleAbort.signal.aborted) return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
          this.log(`[discord] persisted retry attempt=${claim.attempt_count} delay_ms=${retryAfter} target=${claim.target}`);
          continue;
        }
        store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "rate_limited", retry_after_ms: retryAfter });
        return { ...result, delivery_status: "not_delivered", error_code: "rate_limited", retry_after_ms: retryAfter };
      }
      const state = result.delivery_status === "not_delivered" ? "not_delivered" : "outcome_unknown";
      store.settleDelivery(deliveryId, state, { ...(result.error_code ? { error_code: result.error_code } : {}) });
      return result;
    }
  }
}

function isExplicitRateLimitRejection(result: DiscordPostResult): boolean {
  return !result.ok && result.delivery_status === "not_delivered" && result.rate_limit_rejected === true;
}

function validRetryAfter(result: DiscordPostResult): number | null {
  const retryAfter = result.retry_after_ms;
  return Number.isSafeInteger(retryAfter) && retryAfter! > 0 && retryAfter! <= Number.MAX_SAFE_INTEGER - Date.now()
    ? retryAfter!
    : null;
}

function validateRetryConfig(retry: DiscordRetryConfig | false | undefined): void {
  if (retry === false || retry === undefined) return;
  if (!Number.isSafeInteger(retry.max_retries) || retry.max_retries < 0 || retry.max_retries > 100) {
    throw new Error("discord_retry_config_invalid");
  }
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
}

async function sleepWithSignal(ms: number, signal?: AbortSignal, injectedSleep?: (ms: number) => Promise<void>): Promise<boolean> {
  if (!Number.isSafeInteger(ms) || ms < 0 || signal?.aborted) return false;
  if (ms === 0) return true;
  if (injectedSleep) {
    await injectedSleep(ms);
    return !signal?.aborted;
  }
  return new Promise<boolean>((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const UINT64_MAX = 18_446_744_073_709_551_615n;

function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/u.test(value)) return false;
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

function isValidDiscordInboundMessage(message: unknown): message is DiscordInboundMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message as Record<string, unknown>;
  const guildId = m.guild_id;
  return isDiscordSnowflake(m.message_id) &&
    isDiscordSnowflake(m.channel_id) &&
    isDiscordSnowflake(m.user_id) &&
    (guildId === undefined || guildId === null || isDiscordSnowflake(guildId)) &&
    typeof m.text === "string" &&
    typeof m.user_display === "string" &&
    typeof m.is_dm === "boolean" &&
    typeof m.is_mention === "boolean" &&
    m.is_dm === (guildId === undefined || guildId === null) &&
    (m.is_dm || m.is_mention);
}

function discordInboundPayloadDigest(message: DiscordInboundMessage): string {
  return createHash("sha256").update(JSON.stringify([
    "discord-inbound-event.v1",
    message.message_id,
    message.guild_id ?? null,
    message.channel_id,
    message.user_id,
    message.text,
    message.is_dm,
    message.is_mention,
  ])).digest("hex");
}

function discordActorIdentity(message: DiscordInboundMessage): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "discord-actor.v1",
    message.guild_id ?? null,
    message.channel_id,
    message.user_id,
  ])).digest("hex");
  return `discord:${digest}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function discordNextAction(result: DiscordPostResult): string {
  if (result.error_code === "invalid_retry_after") {
    return "Discord rejected the send but supplied an invalid Retry-After value; inspect rate limits before retrying.";
  }
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
    return `Discord delivery is recoverable; retry${wait} or rerun live smoke after the service recovers.`;
  }
  if (/missing_access|channel_not_text_based|unknown.?channel|forbidden/i.test(error)) {
    return "Check DISCORD_LIVE_TARGET, bot channel permissions, and target channel type before retrying.";
  }
  if (/token|unauthorized|invalid/i.test(error)) {
    return "Rotate DISCORD_BOT_TOKEN and restart the gateway.";
  }
  return "Inspect Discord bot permissions and channel configuration before retrying.";
}
