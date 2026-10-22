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
  TeamsGraphTransport,
  teamsChannelReplyTarget,
  teamsChannelTarget,
  teamsChatTarget,
  type TeamsFetch,
  type TeamsInboundMessage,
  type TeamsInboundGrant,
  type TeamsEventInbox,
  type TeamsOutboundDeliveryStore,
  type TeamsPostResult,
  type TeamsTransport,
} from "./transport.js";
import { TeamsAgentsTransport, type TeamsAgentCredentials } from "./agents_transport.js";

export interface TeamsRetryConfig {
  max_retries: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TeamsOptions {
  /** Delegated Microsoft Graph access token. Env: MICROSOFT_GRAPH_ACCESS_TOKEN. */
  access_token?: string;
  /** Test or future webhook/subscription transport injection. */
  transport?: TeamsTransport;
  /** Microsoft 365 Agents SDK credentials. When present, starts an authenticated local ingress. */
  agent_auth?: TeamsAgentCredentials;
  /** Exact owner-maintained ingress grants. Missing or empty rejects all messages. */
  inbound_grants?: readonly TeamsInboundGrant[];
  /** Gateway-owned durable inbound replay boundary; required when agent_auth is configured. */
  inbox?: TeamsEventInbox;
  /** Gateway-owned durable outbound queue; required for every active transport. */
  delivery_store?: TeamsOutboundDeliveryStore;
  /** Authenticated ingress bind address. Defaults to loopback. */
  agent_host?: string;
  /** Authenticated ingress port. Defaults to 3978. */
  agent_port?: number;
  /** Authenticated ingress route. Defaults to /api/messages. */
  agent_route?: string;
  /** Fetch injection for the built-in Graph transport. */
  fetch?: TeamsFetch;
  /** Per-request Microsoft Graph HTTP timeout. Default: 15000ms. */
  request_timeout_ms?: number;
  retry?: TeamsRetryConfig | false;
  log?: (line: string) => void;
}

const DEFAULT_RETRY: TeamsRetryConfig = {
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

export class TeamsChannel implements InboundChannel, OutboundChannel {
  readonly name = "teams";
  private readonly history: SentRecord[] = [];
  private silent = false;
  private started = false;
  private counter = 0;
  private transport: TeamsTransport | null = null;
  private lifecycleAbort = new AbortController();

  constructor(private readonly opts: TeamsOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;

    if (this.opts.transport && this.opts.agent_auth) {
      throw new Error("teams_transport_and_agent_auth_conflict");
    }
    if (this.opts.agent_auth && !this.opts.inbox) {
      throw new Error("teams_durable_inbox_required_for_authenticated_ingress");
    }
    if ((this.opts.transport || this.opts.access_token || this.opts.agent_auth) && !this.opts.delivery_store) {
      throw new Error("teams_durable_delivery_store_required_for_live_sends");
    }
    if (this.opts.transport || this.opts.access_token || this.opts.agent_auth) validateRetryConfig(this.opts.retry);
    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.agent_auth) {
      this.transport = new TeamsAgentsTransport({
        credentials: this.opts.agent_auth,
        graph_access_token: this.opts.access_token,
        fetch: this.opts.fetch,
        host: this.opts.agent_host,
        port: this.opts.agent_port,
        route: this.opts.agent_route,
        log: this.opts.log,
      });
    } else if (this.opts.access_token) {
      this.transport = new TeamsGraphTransport({
        access_token: this.opts.access_token,
        fetch: this.opts.fetch,
        request_timeout_ms: this.opts.request_timeout_ms,
      });
    } else {
      this.silent = true;
      this.log("[teams] WARN MICROSOFT_GRAPH_ACCESS_TOKEN unset - running in silent mode");
      return;
    }

    this.lifecycleAbort = new AbortController();
    this.started = true;
    if (!this.opts.inbound_grants?.length) {
      this.log("[teams] WARN TEAMS_INBOUND_GRANTS_JSON unset/empty - inbound messages are rejected");
    }
    try {
      await this.transport.start(async (m) => {
        if (!isValidTeamsInboundMessage(m)) {
          this.log("[teams] rejected inbound event with invalid identity");
          return;
        }
        const grant = this.opts.inbound_grants?.some((candidate) => teamsGrantMatches(candidate, m));
        if (!grant) return;

        const inbox = this.opts.inbox;
        if (!inbox) {
          this.log("[teams] rejected inbound event because durable admission is unavailable");
          return;
        }
        const eventId = teamsEventIdentity(m);
        const payloadDigest = teamsInboundPayloadDigest(m);
        let claim;
        try {
          claim = inbox.claim(eventId, payloadDigest);
        } catch {
          this.log("[teams] rejected inbound event because durable admission failed");
          return;
        }
        if (claim.status !== "accepted") {
          this.log(`[teams] suppressed inbound event status=${claim.status}`);
          return;
        }

        const inbound = normalizeTeamsInbound(m);
        let deliveryState: "handler_returned" | "outcome_unknown" = "outcome_unknown";
        try {
          await handler(inbound);
          deliveryState = "handler_returned";
        } finally {
          try {
            inbox.settle(eventId, payloadDigest, deliveryState);
          } catch {
            this.log("[teams] inbound settlement failed; replay remains blocked");
          }
        }
      });
      this.silent = false;
      this.log("[teams] active");
      for (const pending of this.opts.delivery_store?.pending() ?? []) {
        void this.dispatchPersistedDelivery(pending.delivery_id).then((result) => {
          this.log(`[teams] recovered outbound delivery state=${result.ok ? "delivered" : result.delivery_status ?? "unknown"}`);
        }).catch(() => this.log("[teams] recovered outbound delivery remains unresolved"));
      }
    } catch (e) {
      this.silent = true;
      this.started = false;
      const transport = this.transport;
      this.transport = null;
      if (this.opts.agent_auth) {
        try { await transport?.stop(); } catch { /* startup failure remains fail-closed */ }
        this.log("[teams] authenticated ingress failed to start");
        throw new Error("teams_authenticated_ingress_start_failed");
      }
      this.log(
        `[teams] WARN transport start failed (${e instanceof Error ? e.message : String(e)}); falling back to silent`,
      );
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
      const external_id = `teams-silent-${meta.command_id}-${this.counter}`;
      const next_action =
        "Set MICROSOFT_GRAPH_ACCESS_TOKEN and a Teams target, or leave Teams intentionally disabled.";
      this.history.push({
        payload,
        meta,
        at,
        external_id,
        ok: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "teams_not_configured",
        next_action,
      });
      this.log(
        `[teams:silent] would-send target=${payload.target} commit=${meta.upstream_commit_hash.slice(0, 8)} content="${truncate(payload.content, 80)}"`,
      );
      return {
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "teams_not_configured",
        next_action,
      };
    }

    let r: TeamsPostResult = { ok: false, delivery_status: "not_delivered",
      error: "teams_send_not_started", error_kind: "non_recoverable", error_code: "send_not_started" };
    if (this.opts.delivery_store) {
      const deliveryId = randomUUID();
      let enqueued = false;
      try {
        this.opts.delivery_store.enqueue({
          delivery_id: deliveryId,
          channel: "teams",
          target: payload.target,
          text: payload.content,
        });
        enqueued = true;
      } catch {
        r = { ok: false, delivery_status: "not_delivered", error: "teams_delivery_store_unavailable",
          error_kind: "non_recoverable", error_code: "delivery_store_unavailable" };
      }
      if (enqueued) {
        try {
          r = await this.dispatchPersistedDelivery(deliveryId, context?.signal);
        } catch {
          r = { ok: false, delivery_status: "unknown", error: "teams_delivery_state_unavailable",
            error_kind: "non_recoverable", error_code: "delivery_state_unavailable" };
        }
      }
    } else {
      r = { ok: false, delivery_status: "not_delivered", error: "teams_delivery_store_unavailable",
        error_kind: "non_recoverable", error_code: "delivery_store_unavailable" };
    }

    const details = r.ok
      ? null
      : classifyChannelDeliveryError({
          error: r.error ?? "teams_send_failed",
          retry_after_ms: r.retry_after_ms,
        });
    const external_id = r.message_id ?? r.request_id ?? `teams-${meta.command_id}-${this.counter}`;
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
      next_action: r.ok ? undefined : teamsNextAction(r),
    });
    if (r.ok) {
      this.log(
        `[teams] sent target=${payload.target} id=${external_id} commit=${meta.upstream_commit_hash.slice(0, 8)}`,
      );
      return { delivered: true, delivery_status: "delivered", external_id };
    }
    return {
      delivered: false,
      delivery_status: r.delivery_status ?? "unknown",
      error: r.error ?? "teams_send_failed",
      error_kind: r.error_kind ?? details!.error_kind,
      error_code: r.error_code ?? details!.error_code,
      retry_after_ms: r.retry_after_ms ?? details!.retry_after_ms,
      next_action: teamsNextAction(r),
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

  private async dispatchPersistedDelivery(deliveryId: string, callerSignal?: AbortSignal): Promise<TeamsPostResult> {
    const store = this.opts.delivery_store!;
    const retry = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);
    while (true) {
      if (callerSignal?.aborted) {
        try { store.cancelPending(deliveryId); } catch { /* already claimed or settled */ }
        return { ...cancelledBeforeDispatch(), error: "cancelled_before_retry", error_code: "cancelled_before_retry" };
      }
      const pending = store.pending().find((row) => row.delivery_id === deliveryId);
      if (!pending) {
        const status = store.status(deliveryId);
        if (status?.delivery_state === "delivered") return { ok: true, delivery_status: "delivered", message_id: status.external_message_id };
        const delivery_status = status?.delivery_state === "not_delivered" || status?.delivery_state === "retry_exhausted"
          ? "not_delivered" : "unknown";
        return { ok: false, delivery_status, error: status?.error_code ?? "teams_delivery_state_unavailable",
          error_code: status?.error_code, ...(status?.retry_after_ms ? { retry_after_ms: status.retry_after_ms } : {}) };
      }
      const delay = Math.max(0, pending.not_before_ms - Date.now());
      const lifecycleSignal = this.lifecycleAbort.signal;
      const waitSignal = callerSignal ? AbortSignal.any([callerSignal, lifecycleSignal]) : lifecycleSignal;
      if (delay > 0 && !await sleepWithSignal(delay, waitSignal, retry?.sleep)) {
        if (callerSignal?.aborted) {
          try { store.cancelPending(deliveryId); } catch { /* already claimed or settled */ }
          return { ...cancelledBeforeDispatch(), error: "cancelled_before_retry", error_code: "cancelled_before_retry" };
        }
        return { ok: false, delivery_status: "not_delivered", error: "teams_delivery_wait_interrupted",
          error_code: "delivery_wait_interrupted", retry_after_ms: delay };
      }
      if (callerSignal?.aborted) {
        try { store.cancelPending(deliveryId); } catch { /* already claimed or settled */ }
        return cancelledBeforeDispatch();
      }
      if (lifecycleSignal.aborted) {
        return { ok: false, delivery_status: "not_delivered", error: "teams_delivery_wait_interrupted",
          error_code: "delivery_wait_interrupted", ...(delay > 0 ? { retry_after_ms: delay } : {}) };
      }
      const claim = store.claimDelivery(deliveryId);
      if (!claim) continue;
      if (callerSignal?.aborted) {
        store.settleDelivery(deliveryId, "not_delivered", { error_code: "cancelled_before_dispatch" });
        return cancelledBeforeDispatch();
      }
      let result: TeamsPostResult;
      try {
        result = await this.transport!.postMessage({ target: claim.target, text: claim.text },
          callerSignal ? AbortSignal.any([callerSignal, lifecycleSignal]) : lifecycleSignal);
      } catch {
        result = { ok: false, delivery_status: "unknown", error: "teams_transport_outcome_unknown",
          error_kind: "non_recoverable", error_code: "delivery_outcome_unknown" };
      }
      if (result.ok) {
        store.settleDelivery(deliveryId, "delivered", { ...(result.message_id ? { external_message_id: result.message_id } : {}) });
        return { ...result, delivery_status: "delivered" };
      }
      if (isExplicitRateLimitRejection(result)) {
        const retryAfter = validRetryAfter(result);
        if (result.retry_after_invalid) {
          store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "retry_after_invalid" });
          return { ...result, delivery_status: "not_delivered", error_code: "retry_after_invalid" };
        }
        if (retryAfter === null) {
          store.settleDelivery(deliveryId, "not_delivered", { error_code: "retry_after_missing" });
          return { ...result, delivery_status: "not_delivered", error_code: "retry_after_missing" };
        }
        if (retry && claim.attempt_count <= retry.max_retries && retryAfter <= Number.MAX_SAFE_INTEGER - Date.now()) {
          store.scheduleRetry(deliveryId, Date.now() + retryAfter, retryAfter);
          if (callerSignal?.aborted) {
            try { store.cancelPending(deliveryId); } catch { /* already settled */ }
            return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
          }
          if (lifecycleSignal.aborted) return { ...result, delivery_status: "not_delivered", retry_after_ms: retryAfter };
          this.log(`[teams] persisted retry attempt=${claim.attempt_count} delay_ms=${retryAfter} target=${claim.target}`);
          continue;
        }
        store.settleDelivery(deliveryId, "retry_exhausted", { error_code: "rate_limited", retry_after_ms: retryAfter });
        return { ...result, delivery_status: "not_delivered", error_code: "rate_limited", retry_after_ms: retryAfter };
      }
      store.settleDelivery(deliveryId, result.delivery_status === "not_delivered" ? "not_delivered" : "outcome_unknown",
        { ...(result.error_code ? { error_code: result.error_code } : {}) });
      return result;
    }
  }
}

function normalizeTeamsInbound(m: TeamsInboundMessage): InboundRequest {
  const replyTarget =
    m.team_id && m.channel_id && m.reply_to_message_id
      ? teamsChannelReplyTarget(m.team_id, m.channel_id, m.reply_to_message_id)
      : m.team_id && m.channel_id
        ? teamsChannelTarget(m.team_id, m.channel_id)
      : teamsChatTarget(m.conversation_id);
  return {
    id: randomUUID(),
    channel: "teams",
    user: teamsActorIdentity(m),
    content: m.text,
    timestamp: Date.now(),
    metadata: {
      reply_to: replyTarget,
      teams_user_id: m.user_id,
      teams_team_id: m.team_id,
      teams_channel_id: m.channel_id,
      teams_message_id: m.message_id,
      teams_tenant_id: m.tenant_id,
      teams_conversation_id: m.conversation_id,
      teams_conversation_type: m.conversation_type,
    },
  };
}

function isValidTeamsInboundMessage(message: TeamsInboundMessage): boolean {
  return isTenantId(message.tenant_id) &&
    isSafeTeamsId(message.conversation_id) &&
    isSafeTeamsId(message.user_id) &&
    isSafeTeamsId(message.message_id) &&
    typeof message.text === "string" && Boolean(message.text.trim()) &&
    (message.conversation_type === "personal" || message.conversation_type === "groupChat" || message.conversation_type === "channel") &&
    (message.conversation_type === "channel"
      ? isSafeTeamsId(message.team_id) && isSafeTeamsId(message.channel_id)
      : message.team_id === undefined && message.channel_id === undefined);
}

function teamsGrantMatches(grant: TeamsInboundGrant, message: TeamsInboundMessage): boolean {
  return grant.tenant_id.toLowerCase() === message.tenant_id.toLowerCase() &&
    grant.conversation_type === message.conversation_type &&
    grant.conversation_id === message.conversation_id &&
    grant.user_id === message.user_id &&
    grant.team_id === (message.team_id ?? null) &&
    grant.channel_id === (message.channel_id ?? null);
}

function teamsEventIdentity(message: TeamsInboundMessage): string {
  return createHash("sha256").update(JSON.stringify([
    "teams-event-identity.v1",
    message.tenant_id.toLowerCase(),
    message.conversation_id,
    message.message_id,
  ])).digest("hex");
}

function teamsInboundPayloadDigest(message: TeamsInboundMessage): string {
  return createHash("sha256").update(JSON.stringify([
    "teams-inbound-payload.v1",
    message.tenant_id.toLowerCase(),
    message.conversation_type,
    message.conversation_id,
    message.user_id,
    message.team_id ?? null,
    message.channel_id ?? null,
    message.text,
  ])).digest("hex");
}

function teamsActorIdentity(message: TeamsInboundMessage): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "teams-actor.v1",
    message.tenant_id.toLowerCase(),
    message.user_id,
  ])).digest("hex");
  return `teams:${digest}`;
}

function isTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isSafeTeamsId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isExplicitRateLimitRejection(result: TeamsPostResult): boolean {
  return !result.ok && result.delivery_status === "not_delivered" && result.rate_limit_rejected === true;
}

function validRetryAfter(result: TeamsPostResult): number | null {
  const retryAfter = result.retry_after_ms;
  return Number.isSafeInteger(retryAfter) && retryAfter! > 0 && retryAfter! <= Number.MAX_SAFE_INTEGER - Date.now()
    ? retryAfter!
    : null;
}

function validateRetryConfig(retry: TeamsRetryConfig | false | undefined): void {
  if (retry === false || retry === undefined) return;
  if (!Number.isSafeInteger(retry.max_retries) || retry.max_retries < 0 || retry.max_retries > 100) {
    throw new Error("teams_retry_config_invalid");
  }
}

function cancelledBeforeDispatch(): TeamsPostResult {
  return { ok: false, delivery_status: "not_delivered", error: "cancelled_before_dispatch",
    error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
}

async function sleepWithSignal(ms: number, signal?: AbortSignal, injectedSleep?: (ms: number) => Promise<void>): Promise<boolean> {
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
    const began = Date.now();
    const completed = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(() => finish(true), chunk);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (!completed) return false;
    remaining -= Math.max(1, Date.now() - began);
  }
  return true;
}

function teamsNextAction(result: TeamsPostResult): string {
  const error = result.error ?? "teams_send_failed";
  if (result.delivery_status === "unknown") {
    return "Microsoft Graph did not confirm whether the reply was delivered. Inspect the Teams conversation before deciding on a manual retry; automatic replay was suppressed.";
  }
  if (result.error_code === "retry_after_missing" || result.error_code === "retry_after_invalid" || result.retry_after_invalid) {
    return "Microsoft Graph confirmed the reply was not delivered but did not provide a usable Retry-After. Automatic retry was suppressed; wait for rate limiting to clear before a deliberate retry.";
  }
  const details = classifyChannelDeliveryError({
    error,
    retry_after_ms: result.retry_after_ms,
  });
  if (details.error_kind === "recoverable") {
    const wait =
      details.retry_after_ms !== undefined
        ? ` after about ${details.retry_after_ms}ms`
        : "";
    return `Teams delivery is recoverable; retry${wait} or rerun live smoke after Microsoft Graph recovers.`;
  }
  if (/invalid_teams_target|target/i.test(error)) {
    return "Check TEAMS_LIVE_TARGET. Use channel/<team_id>/<channel_id>, reply/<team_id>/<channel_id>/<message_id>, or chat/<chat_id> with URL-encoded ids.";
  }
  if (/401|unauthorized|invalid.*token|token/i.test(error)) {
    return "Rotate MICROSOFT_GRAPH_ACCESS_TOKEN and restart the gateway.";
  }
  if (/403|forbidden|permission|ChannelMessage.Send/i.test(error)) {
    return "Check delegated Microsoft Graph ChannelMessage.Send permission and that the signed-in user can post to the target.";
  }
  return "Inspect Teams app registration, Graph delegated permissions, and the target id before retrying.";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "...";
}
