import { createHash, randomUUID } from "node:crypto";
import type {
  ChannelSendPayload,
  InboundRequest,
} from "@blue-tanuki/protocol";
import {
  classifyChannelDeliveryError,
  isRecoverableChannelDeliveryError,
  withRetryBackoff,
  type BackoffOptions,
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
  type TeamsPostResult,
  type TeamsTransport,
} from "./transport.js";
import { TeamsAgentsTransport, type TeamsAgentCredentials } from "./agents_transport.js";

export interface TeamsRetryConfig {
  max_retries: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_ratio: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
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
  base_delay_ms: 500,
  max_delay_ms: 30_000,
  jitter_ratio: 0.2,
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

  constructor(private readonly opts: TeamsOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;

    if (this.opts.transport && this.opts.agent_auth) {
      throw new Error("teams_transport_and_agent_auth_conflict");
    }
    if (this.opts.agent_auth && !this.opts.inbox) {
      throw new Error("teams_durable_inbox_required_for_authenticated_ingress");
    }
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

    const retryCfg = this.opts.retry === false ? null : (this.opts.retry ?? DEFAULT_RETRY);
    const callOnce = (): Promise<TeamsPostResult> => {
      if (context?.signal?.aborted) return Promise.reject(new Error("channel_send_cancelled_before_transport_dispatch"));
      return this.transport!.postMessage({ target: payload.target, text: payload.content }, context?.signal);
    };
    const r = retryCfg ? await withTeamsRetry(callOnce, retryCfg, this.opts.log, payload.target, context?.signal) : await callOnce();

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
      return { delivered: true, external_id };
    }
    return {
      delivered: false,
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

async function withTeamsRetry(
  callOnce: () => Promise<TeamsPostResult>,
  retryCfg: TeamsRetryConfig,
  log: ((line: string) => void) | undefined,
  target: string,
  cancelSignal?: AbortSignal,
): Promise<TeamsPostResult> {
  const opts: BackoffOptions<TeamsPostResult> = {
    max_retries: retryCfg.max_retries,
    base_delay_ms: retryCfg.base_delay_ms,
    max_delay_ms: retryCfg.max_delay_ms,
    jitter_ratio: retryCfg.jitter_ratio,
    sleep: retryCfg.sleep,
    random: retryCfg.random,
    is_retryable: (signal) => {
      if (cancelSignal?.aborted) return false;
      if (signal.kind === "throw") {
        return isRecoverableChannelDeliveryError({
          error: signal.error instanceof Error ? signal.error.message : String(signal.error),
        });
      }
      if (signal.value.ok) return false;
      return isRecoverableChannelDeliveryError({
        error: signal.value.error,
        retry_after_ms: signal.value.retry_after_ms,
      });
    },
    extract_retry_after_ms: (signal) =>
      signal.kind === "value" ? (signal.value.retry_after_ms ?? null) : null,
    on_retry: ({ attempt, delay_ms }) => {
      log?.(`[teams] retry attempt=${attempt} delay_ms=${delay_ms} target=${target}`);
    },
  };
  return await withRetryBackoff(callOnce, opts);
}

function teamsNextAction(result: TeamsPostResult): string {
  const error = result.error ?? "teams_send_failed";
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
