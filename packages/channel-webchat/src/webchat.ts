import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type {
  InboundRequest,
  ChannelSendPayload,
} from "@blue-tanuki/protocol";
import {
  TokenBucket,
  type InboundChannel,
  type InboundHandler,
  type OutboundChannel,
  type SendMeta,
  type SendResult,
} from "@blue-tanuki/channel-base";
import {
  MemoryTicketStore,
  type TicketStore,
} from "./ticket_store.js";
import {
  MemoryResumeApprovalTokenStore,
  type ResumeApprovalTokenIssued,
  type ResumeApprovalTokenStore,
} from "./resume_approval_token_store.js";
import { renderControlCenterHtml } from "./control_center_html.js";
import {
  readApprovalControlContext,
  readEvidenceControlContext,
  readHistoryReplayFilter,
  readJson,
  readResumeApprovalOptions,
  readWebhookContent,
  nonEmptyString,
  sanitizeHistorySnapshot,
} from "./webchat_request_helpers.js";

import type {
  WebChatAboutSurface,
  WebChatApprovalGrantItem,
  WebChatApprovalHistoryItem,
  WebChatApprovalQueueItem,
  WebChatApprovalSurface,
  WebChatAuditSurface,
  WebChatAuthoritySurface,
  WebChatAuthorityTraceItem,
  WebChatEmergencyStopSnapshot,
  WebChatEvidenceSurface,
  WebChatHistorySurface,
  WebChatNotificationItem,
  WebChatNotificationKind,
  WebChatNotificationSeverity,
  WebChatNotificationSurface,
  WebChatOperatorSurface,
  WebChatOperatorSurfaces,
  WebChatOptions,
  WebChatRateLimits,
  WebChatRecoverySurface,
  WebChatResumeContext,
  WebChatRuntimeSurface,
  WebChatSettingsSurface,
  WebChatUpdateSurface,
} from "./webchat_types.js";
const DEFAULT_RATE_LIMITS: Required<WebChatRateLimits> = {
  inbound: { capacity: 10, refill_per_sec: 1.0 },
  resume: { capacity: 5, refill_per_sec: 0.5 },
  ws_ticket: { capacity: 3, refill_per_sec: 10 / 60 },
};

const RESUME_GLOBAL_KEY = "*";

/**
 * WebChat channel — Phase 4.
 *
 * Endpoint summary:
 *   POST /ws-ticket  body:{user}  auth:Bearer  rate-limited per-user
 *   POST /inbound    body:{user, content}  auth:Bearer  rate-limited per-user
 *   POST /webhook    body:{content|text|event,user?,source?,reply_to?} auth:Bearer webhook-token
 *   POST /resume     body:{request_id, verdict, approval_token}  auth:Bearer  rate-limited (global)
 *   GET  /approval   auth:Bearer resume-token
 *   POST /approval/:id body:{verdict, approval_token} auth:Bearer resume-token
 *   GET  /approval/grants auth:Bearer resume-token
 *   POST /approval/grants/:id/revoke body:{actor?,reason?} auth:Bearer resume-token
 *   GET  /approval/history auth:Bearer resume-token
 *   GET  /approval/emergency-stop auth:Bearer resume-token
 *   POST /approval/emergency-stop body:{action,actor?,reason?} auth:Bearer resume-token
 *   GET  /audit/dump auth:Bearer inbound-token
 *   GET  /authority/trace auth:Bearer inbound-token
 *   GET  /notifications auth:Bearer inbound-token
 *   GET  /history auth:Bearer inbound-token
 *   GET  /history/replay auth:Bearer inbound-token
 *   POST /evidence/export body:{actor?} auth:Bearer inbound-token
 *   GET  /operators/writing auth:Bearer inbound-token
 *   POST /operators/writing/invoke body:{user,content} auth:Bearer inbound-token
 *   GET  /operators/daily auth:Bearer inbound-token
 *   POST /operators/daily/invoke body:{user,content} auth:Bearer inbound-token
 *   GET  /operators/developer auth:Bearer inbound-token
 *   POST /operators/developer/invoke body:{user,content} auth:Bearer inbound-token
 *   GET  /ws         query:?ticket=...
 *   GET  /healthz    no auth, not rate-limited
 *
 * Rate-limit response:
 *   HTTP 429
 *   Retry-After: <seconds>
 *   { "error": "rate_limited", "retry_after_ms": <ms> }
 */
export class WebChatChannel implements InboundChannel, OutboundChannel {
  readonly name = "webchat";
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private handler: InboundHandler | null = null;
  private readonly conns = new Map<string, Set<WebSocket>>();
  private readonly ticketStore: TicketStore;
  private readonly ticketTtlMs: number;
  private readonly resumeApprovalTokenStore: ResumeApprovalTokenStore | null;
  private readonly resumeApprovalTokenTtlMs: number;
  private readonly buckets: {
    inbound: TokenBucket | null;
    resume: TokenBucket | null;
    ws_ticket: TokenBucket | null;
  };
  private starting = false;
  private started = false;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: WebChatOptions) {
    if (!opts.token || opts.token.length < 8) {
      throw new Error(
        "WebChatChannel: opts.token is required and must be ≥8 chars",
      );
    }
    if (opts.resume_token !== undefined && opts.resume_token.length < 8) {
      throw new Error(
        "WebChatChannel: opts.resume_token must be >=8 chars when set",
      );
    }
    if (opts.resume_token !== undefined && opts.resume_token === opts.token) {
      throw new Error("WebChatChannel: opts.resume_token must differ from opts.token");
    }
    if (opts.webhook_token !== undefined && opts.webhook_token.length < 8) {
      throw new Error(
        "WebChatChannel: opts.webhook_token must be >=8 chars when set",
      );
    }
    if (
      opts.webhook_token !== undefined &&
      (opts.webhook_token === opts.token ||
        opts.webhook_token === opts.resume_token)
    ) {
      throw new Error("WebChatChannel: opts.webhook_token must differ from WebChat tokens");
    }
    if (opts.onResume && !opts.resume_token) {
      throw new Error("WebChatChannel: opts.resume_token is required when onResume is set");
    }
    if (opts.settings && opts.settings.token.length < 16) {
      throw new Error("WebChatChannel: opts.settings.token must be >=16 chars");
    }
    if (
      opts.settings &&
      (opts.settings.token === opts.token ||
        opts.settings.token === opts.resume_token ||
        opts.settings.token === opts.webhook_token)
    ) {
      throw new Error("WebChatChannel: opts.settings.token must differ from WebChat tokens");
    }
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error("WebChatChannel: opts.port must be a valid TCP port");
    }
    this.ticketTtlMs = opts.ws_ticket_ttl_ms ?? 30_000;
    if (this.ticketTtlMs < 1_000) {
      throw new Error("WebChatChannel: ws_ticket_ttl_ms must be ≥ 1000");
    }
    this.resumeApprovalTokenTtlMs =
      opts.resume_approval_token_ttl_ms ?? 10 * 60_000;
    if (this.resumeApprovalTokenTtlMs < 1_000) {
      throw new Error(
        "WebChatChannel: resume_approval_token_ttl_ms must be >= 1000",
      );
    }
    this.ticketStore =
      opts.ticket_store ??
      new MemoryTicketStore({
        cap: opts.ws_ticket_cap ?? 10_000,
        now: opts.clock ? () => opts.clock!.now() : undefined,
      });
    this.resumeApprovalTokenStore =
      opts.resume_approval_tokens === false
        ? null
        : opts.resume_approval_tokens ??
          new MemoryResumeApprovalTokenStore({
            cap: opts.resume_approval_token_cap ?? 10_000,
            now: opts.clock ? () => opts.clock!.now() : undefined,
          });

    if (opts.rate_limits === false) {
      this.buckets = { inbound: null, resume: null, ws_ticket: null };
    } else {
      const cfg = opts.rate_limits ?? {};
      this.buckets = {
        inbound: new TokenBucket({
          ...DEFAULT_RATE_LIMITS.inbound,
          ...cfg.inbound,
          clock: opts.clock,
        }),
        resume: new TokenBucket({
          ...DEFAULT_RATE_LIMITS.resume,
          ...cfg.resume,
          clock: opts.clock,
        }),
        ws_ticket: new TokenBucket({
          ...DEFAULT_RATE_LIMITS.ws_ticket,
          ...cfg.ws_ticket,
          clock: opts.clock,
        }),
      };
    }
  }

  async issueResumeApprovalToken(
    request_id: string,
    ttl_ms = this.resumeApprovalTokenTtlMs,
  ): Promise<ResumeApprovalTokenIssued | null> {
    if (!this.resumeApprovalTokenStore) return null;
    return this.resumeApprovalTokenStore.issue(request_id, ttl_ms);
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.started || this.starting) {
      throw new Error("WebChatChannel: already started");
    }
    this.starting = true;
    this.handler = handler;

    this.server = createServer((req, res) => {
      this.handleHttp(req, res).catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] http handler error:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        }
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", "http://internal");
          if (url.pathname !== "/ws") {
            socket.destroy();
            return;
          }
          const ticket = url.searchParams.get("ticket");
          if (!ticket) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          const user = await this.ticketStore.consume(ticket);
          if (!user) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.attachConnection(user, ws);
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[webchat] upgrade error:", e);
          socket.destroy();
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => {
        this.starting = false;
        reject(e);
      };
      this.server!.once("error", onError);
      this.server!.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => {
        this.server!.off("error", onError);
        resolve();
      });
    });

    // Periodic TokenBucket prune. Keeps the per-key state map from
    // growing unboundedly on long-running processes that see many
    // distinct (user, endpoint) pairs.
    const prune_interval = this.opts.rate_limit_prune_interval_ms ?? 60_000;
    if (prune_interval > 0) {
      const idle_ms =
        this.opts.rate_limit_prune_idle_ms ?? prune_interval * 5;
      this.pruneTimer = setInterval(() => {
        this.buckets.inbound?.prune(idle_ms);
        this.buckets.resume?.prune(idle_ms);
        this.buckets.ws_ticket?.prune(idle_ms);
      }, prune_interval);
      // Don't keep the event loop alive solely for prune.
      this.pruneTimer.unref?.();
    }

    this.starting = false;
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const set of this.conns.values()) {
      for (const ws of set) {
        try {
          ws.close(1001, "server_shutdown");
        } catch {
          /* ignore */
        }
      }
    }
    this.conns.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
    this.wss = null;
    this.handler = null;
  }

  async send(
    payload: ChannelSendPayload,
    meta: SendMeta,
  ): Promise<SendResult> {
    const set = this.conns.get(payload.target);
    if (!set || set.size === 0) {
      return { delivered: false, error: "no_active_connection" };
    }
    const frame = JSON.stringify({
      kind: "channel_send",
      command_id: meta.command_id,
      upstream_commit_hash: meta.upstream_commit_hash,
      content: payload.content,
    });
    let any = false;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
        any = true;
      }
    }
    return any
      ? { delivered: true, external_id: `webchat-${meta.command_id}` }
      : { delivered: false, error: "no_open_socket" };
  }

  connectionCount(user?: string): number {
    if (user) return this.conns.get(user)?.size ?? 0;
    let n = 0;
    for (const s of this.conns.values()) n += s.size;
    return n;
  }

  /** Live ticket count (test/diagnostic). Backed by the ticket store. */
  async ticketCount(): Promise<number> {
    return this.ticketStore.size();
  }

  private attachConnection(user: string, ws: WebSocket): void {
    let set = this.conns.get(user);
    if (!set) {
      set = new Set();
      this.conns.set(user, set);
    }
    set.add(ws);
    ws.on("close", () => {
      const s = this.conns.get(user);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) this.conns.delete(user);
    });
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
    setImmediate(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ kind: "hello", user }));
        } catch {
          /* ignore */
        }
      }
    });
  }

  /** Apply rate-limit check; on miss, write 429 + Retry-After and return false. */
  private rateLimitOr429(
    bucket: TokenBucket | null,
    key: string,
    res: ServerResponse,
  ): boolean {
    if (!bucket) return true;
    const r = bucket.consume(key);
    if (r.ok) return true;
    const retry_after_sec = Math.max(1, Math.ceil(r.retry_after_ms / 1000));
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(retry_after_sec),
    });
    res.end(
      JSON.stringify({
        error: "rate_limited",
        retry_after_ms: r.retry_after_ms,
      }),
    );
    return false;
  }

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(renderControlCenterHtml());
      return;
    }

    if (url.pathname === "/app/about") {
      await this.handleAbout(req, res);
      return;
    }

    if (url.pathname.startsWith("/update/")) {
      await this.handleUpdate(req, res, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/recovery/")) {
      await this.handleRecovery(req, res, url.pathname);
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: "webchat" }));
      return;
    }

    if (url.pathname === "/settings") {
      await this.handleSettingsPage(req, res);
      return;
    }

    if (url.pathname === "/settings/config") {
      await this.handleSettingsConfig(req, res);
      return;
    }

    if (url.pathname === "/settings/llm/verify") {
      await this.handleSettingsLlmVerify(req, res);
      return;
    }

    if (url.pathname === "/runtime/snapshot") {
      await this.handleRuntimeSnapshot(req, res);
      return;
    }

    if (url.pathname === "/approval" || url.pathname.startsWith("/approval/")) {
      await this.handleApproval(req, res, url);
      return;
    }

    if (url.pathname === "/audit/dump") {
      await this.handleAuditDump(req, res, url);
      return;
    }

    if (url.pathname === "/authority/trace") {
      await this.handleAuthorityTrace(req, res);
      return;
    }

    if (url.pathname === "/notifications") {
      await this.handleNotifications(req, res);
      return;
    }

    if (url.pathname === "/history" || url.pathname === "/history/replay") {
      await this.handleHistory(req, res, url);
      return;
    }

    if (url.pathname === "/evidence/export") {
      await this.handleEvidenceExport(req, res);
      return;
    }

    if (url.pathname === "/operators/writing" || url.pathname === "/operators/writing/invoke") {
      await this.handleOperator(req, res, url, "writing");
      return;
    }

    if (url.pathname === "/operators/daily" || url.pathname === "/operators/daily/invoke") {
      await this.handleOperator(req, res, url, "daily");
      return;
    }
    if (url.pathname === "/operators/developer" || url.pathname === "/operators/developer/invoke") {
      await this.handleOperator(req, res, url, "developer");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const tokenKind =
      url.pathname === "/resume"
        ? "resume"
        : url.pathname === "/webhook"
        ? "webhook"
        : url.pathname === "/inbound" || url.pathname === "/ws-ticket"
        ? "inbound"
        : null;
    if (!tokenKind) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (tokenKind === "webhook" && !this.opts.webhook_token) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "webhook_not_configured" }));
      return;
    }

    if (!this.checkAuth(req, tokenKind)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const body = await readJson(req);

    if (url.pathname === "/ws-ticket") {
      const user = typeof body?.user === "string" ? body.user.trim() : "";
      if (!user) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "user is required string" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.ws_ticket, user, res)) return;
      const issued = await this.ticketStore.issue(user, this.ticketTtlMs);
      const expires_in_sec = Math.max(
        0,
        Math.floor((issued.expires_at_ms - Date.now()) / 1000),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket: issued.ticket, expires_in_sec }));
      return;
    }

    if (url.pathname === "/inbound") {
      const user = typeof body?.user === "string" ? body.user : null;
      const content = typeof body?.content === "string" ? body.content : null;
      if (!user || !content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "user and content are required strings" }),
        );
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, user, res)) return;
      const inboundReq: InboundRequest = {
        id: randomUUID(),
        channel: "webchat",
        user,
        content,
        timestamp: Date.now(),
        // WebChat targets users by literal user name (the WS connection map
        // is keyed on it). reply_to mirrors that for symmetry with Slack/Discord.
        metadata: { reply_to: user },
      };
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] inbound handler error:", e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ accepted: true, request_id: inboundReq.id }),
      );
      return;
    }

    if (url.pathname === "/webhook") {
      const content = readWebhookContent(body);
      if (!content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "content, text, or event is required",
          }),
        );
        return;
      }
      const user = nonEmptyString(body?.user) ?? "webhook";
      const source = nonEmptyString(body?.source) ?? "generic";
      const reply_to = nonEmptyString(body?.reply_to) ?? user;
      if (
        !this.rateLimitOr429(
          this.buckets.inbound,
          `webhook:${source}:${user}`,
          res,
        )
      )
        return;
      const inboundReq: InboundRequest = {
        id: randomUUID(),
        channel: "webchat",
        user,
        content,
        timestamp: Date.now(),
        metadata: {
          reply_to,
          webhook_source: source,
        },
      };
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] webhook handler error:", e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ accepted: true, request_id: inboundReq.id }),
      );
      return;
    }

    if (url.pathname === "/resume") {
      const request_id =
        typeof body?.request_id === "string" ? body.request_id : null;
      const verdict = body?.verdict;
      if (
        !request_id ||
        (verdict !== "approve" && verdict !== "reject" && verdict !== "block")
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "request_id and verdict (approve|reject|block) required",
          }),
        );
        return;
      }
      if (!this.opts.onResume) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "resume_not_configured" }));
        return;
      }
      const actor =
        typeof body?.actor === "string" && body.actor.trim().length > 0
          ? body.actor.trim()
          : "webchat-human";
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
        return;
      if (this.resumeApprovalTokenStore) {
        if (!(await this.consumeResumeApprovalToken(request_id, body, res)))
          return;
      }
      try {
        const result = await this.opts.onResume(request_id, verdict, {
          actor,
          token_kind: "resume",
          approval: readResumeApprovalOptions(body),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }

  private checkAuth(
    req: IncomingMessage,
    kind: "inbound" | "resume" | "webhook",
  ): boolean {
    const h = req.headers["authorization"];
    if (typeof h !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const expected =
      kind === "resume"
        ? this.opts.resume_token
        : kind === "webhook"
        ? this.opts.webhook_token
        : this.opts.token;
    return typeof expected === "string" && m[1] === expected;
  }

  private checkSettingsAuth(req: IncomingMessage): boolean {
    const h = req.headers["authorization"];
    if (typeof h !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return Boolean(m && this.opts.settings && m[1] === this.opts.settings.token);
  }

  private async handleApproval(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.checkAuth(req, "resume")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (url.pathname === "/approval") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_not_configured" }));
        return;
      }
      const pending_approvals = await this.opts.approval.list();
      const grants = this.opts.approval.grants
        ? await this.opts.approval.grants()
        : undefined;
      const approval_history = this.opts.approval.history
        ? await this.opts.approval.history()
        : undefined;
      const emergency_stop = this.opts.approval.emergencyStop
        ? await this.opts.approval.emergencyStop.getSnapshot()
        : undefined;
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({
        pending_approvals,
        ...(grants ? { grants } : {}),
        ...(approval_history ? { approval_history } : {}),
        ...(emergency_stop ? { emergency_stop } : {}),
      }));
      return;
    }

    if (url.pathname === "/approval/grants") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.grants) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_grants_not_configured" }));
        return;
      }
      const grants = await this.opts.approval.grants();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ grants }));
      return;
    }

    if (url.pathname.startsWith("/approval/grants/") && url.pathname.endsWith("/revoke")) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.revokeGrant) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_revoke_not_configured" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
        return;
      const encoded = url.pathname.slice("/approval/grants/".length, -"/revoke".length);
      const grant_id = decodeURIComponent(encoded);
      if (!grant_id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "grant_id required" }));
        return;
      }
      const body = await readJson(req);
      const result = await this.opts.approval.revokeGrant(
        grant_id,
        readApprovalControlContext(body),
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (url.pathname === "/approval/history") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.history) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_history_not_configured" }));
        return;
      }
      const approval_history = await this.opts.approval.history();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ approval_history }));
      return;
    }

    if (url.pathname === "/approval/emergency-stop") {
      if (!this.opts.approval?.emergencyStop) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "emergency_stop_not_configured" }));
        return;
      }
      if (req.method === "GET") {
        const emergency_stop = await this.opts.approval.emergencyStop.getSnapshot();
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ emergency_stop }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
        return;
      const body = await readJson(req);
      const action = body?.action;
      if (action !== "activate" && action !== "clear") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "action (activate|clear) required" }));
        return;
      }
      const context = readApprovalControlContext(body);
      const result = action === "activate"
        ? await this.opts.approval.emergencyStop.activate(context)
        : await this.opts.approval.emergencyStop.clear(context);
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    const prefix = "/approval/";
    if (!url.pathname.startsWith(prefix) || req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.opts.onResume) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval_not_configured" }));
      return;
    }
    const approval_id = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!approval_id) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval id required" }));
      return;
    }

    const body = await readJson(req);
    const verdict = body?.verdict;
    if (verdict !== "approve" && verdict !== "reject" && verdict !== "block") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "verdict (approve|reject|block) required" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
      return;
    if (!(await this.consumeResumeApprovalToken(approval_id, body, res))) return;

    const actor =
      typeof body?.actor === "string" && body.actor.trim().length > 0
        ? body.actor.trim()
        : "webchat-human";
    try {
      const result = await this.opts.onResume(approval_id, verdict, {
        actor,
        token_kind: "resume",
        approval: readResumeApprovalOptions(body),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  private async consumeResumeApprovalToken(
    request_id: string,
    body: Record<string, unknown> | null,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!this.resumeApprovalTokenStore) return true;
    const approval_token =
      typeof body?.approval_token === "string"
        ? body.approval_token.trim()
        : "";
    if (!approval_token) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval_token required" }));
      return false;
    }
    const ok = await this.resumeApprovalTokenStore.consume(
      request_id,
      approval_token,
    );
    if (!ok) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_approval_token" }));
      return false;
    }
    return true;
  }

  private async handleAuditDump(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.opts.audit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "audit_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const format = url.searchParams.get("format") === "text" ? "text" : "json";
    const dump = await this.opts.audit.dump(format);
    res.writeHead(200, {
      "content-type": dump.content_type,
      "cache-control": "no-store",
    });
    res.end(dump.body);
  }

  private async handleAuthorityTrace(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.authority) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "authority_trace_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const authority_trace = await this.opts.authority.trace();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ authority_trace }));
  }

  private async handleRuntimeSnapshot(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.runtime) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "runtime_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const snapshot = await this.opts.runtime.getSnapshot();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshot));
  }

  private async handleNotifications(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.notifications) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "notifications_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const notifications = await this.opts.notifications.list();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ notifications }));
  }

  private async handleHistory(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.opts.history) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "history_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const history = sanitizeHistorySnapshot(
      await this.opts.history.replay(readHistoryReplayFilter(url)),
    );
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ history }));
  }

  private async handleEvidenceExport(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.evidence) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "evidence_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.inbound, "evidence-export", res)) return;
    const body = await readJson(req);
    const evidence = await this.opts.evidence.exportPack(readEvidenceControlContext(body));
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, evidence }));
  }

  private async handleOperator(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    surfaceName: "writing" | "daily" | "developer",
  ): Promise<void> {
    const surface = this.opts.operators?.[surfaceName];
    if (!surface) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `${surfaceName}_operator_not_configured` }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (url.pathname === `/operators/${surfaceName}` && req.method === "GET") {
      const operator = await surface.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ operator }));
      return;
    }

    if (url.pathname === `/operators/${surfaceName}/invoke` && req.method === "POST") {
      const body = await readJson(req);
      const user = typeof body?.user === "string" ? body.user : null;
      const content = typeof body?.content === "string" ? body.content : null;
      if (!user || !content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "user and content are required strings" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, `operator:${surfaceName}:${user}`, res)) return;
      const inboundReq: InboundRequest = {
        id: randomUUID(),
        channel: "webchat",
        user,
        content,
        timestamp: Date.now(),
        metadata: {
          reply_to: user,
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": surfaceName,
        },
      };
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[webchat] ${surfaceName} operator handler error:`, e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, request_id: inboundReq.id }));
      return;
    }

    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
  }

  private async handleSettingsPage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.settings) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const html =
      typeof this.opts.settings.html === "function"
        ? this.opts.settings.html()
        : this.opts.settings.html;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  }

  private async handleAbout(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.about) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "about_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const snapshot = await this.opts.about.getSnapshot();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshot));
  }

  private async handleUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<void> {
    if (!this.opts.update) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "update_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (route === "/update/snapshot") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const snapshot = await this.opts.update.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    try {
      let result: unknown;
      if (route === "/update/verify") {
        if (!this.opts.update.verifyCandidate) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "update_action_not_configured" }));
          return;
        }
        result = await this.opts.update.verifyCandidate();
      } else if (route === "/update/prepare") {
        if (!this.opts.update.prepareUpdate) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "update_action_not_configured" }));
          return;
        }
        const body = (await readJson(req)) ?? {};
        result = await this.opts.update.prepareUpdate(body);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "update_action_not_found" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "update_action_failed" }));
    }
  }

  private async handleRecovery(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<void> {
    if (!this.opts.recovery) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "recovery_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (route === "/recovery/snapshot") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const snapshot = await this.opts.recovery.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    try {
      const body = (await readJson(req)) ?? {};
      let result: unknown;
      if (route === "/recovery/backup") {
        if (!this.opts.recovery.createBackup) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.createBackup();
      } else if (route === "/recovery/restore") {
        if (!this.opts.recovery.restoreBackup) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.restoreBackup(body);
      } else if (route === "/recovery/reset-provider") {
        if (!this.opts.recovery.resetProvider) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.resetProvider(body);
      } else if (route === "/recovery/reset-connector") {
        if (!this.opts.recovery.resetConnector) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.resetConnector(body);
      } else if (route === "/recovery/factory-reset") {
        if (!this.opts.recovery.factoryReset) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.factoryReset(body);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "recovery_action_not_found" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "recovery_action_failed" }));
    }
  }

  private async handleSettingsConfig(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.settings) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (!this.checkSettingsAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET") {
      const snapshot = await this.opts.settings.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.method === "POST") {
      if (!this.opts.settings.update) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "settings_update_not_configured" }));
        return;
      }
      const body = await readJson(req);
      if (!body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "json_body_required" }));
        return;
      }
      const result = await this.opts.settings.update(body);
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
  }

  private async handleSettingsLlmVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.settings) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (!this.checkSettingsAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.opts.settings.verifyLlm) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_llm_verify_not_configured" }));
      return;
    }
    const body = await readJson(req);
    if (!body) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "json_body_required" }));
      return;
    }
    const result = await this.opts.settings.verifyLlm(body);
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, result }));
  }
}
