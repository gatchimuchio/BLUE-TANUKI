import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type {
  WebChatD4RuntimeCancellationScope,
  WebChatD4RuntimeIntentClaim,
  WebChatD4RuntimeIntentResult,
  WebChatOwnerTaskSubmissionClaim,
  WebChatOwnerTaskSubmissionResult,
  WebChatOwnerTaskSubmissionState,
  WebChatOwnerTaskSubmissionStatus,
  WebChatOwnerTaskSubmissionStore,
} from "@blue-tanuki/channel-webchat";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNER_TASK_SCOPE = sha256("webchat-owner-task-scope.v1");
const D4_RUNTIME_TARGET = /^d4-runtime:[a-f0-9]{64}$/u;
const CANCELLATION_COMMAND_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const MAX_CANCELLATION_COMMANDS_PER_REQUEST = 256;
const OWNER_TASK_RESULT_TTL_MS = 15 * 60 * 1000;
const OWNER_TASK_RESULT_MAX_ENTRIES = 512;
const OWNER_TASK_RESULT_MAX_BYTES = 64 * 1024;
const OWNER_TASK_RESULT_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const OWNER_NOTIFICATION_REQUEST_LIMIT = 20;
const RESULT_CACHE_CLEANUP_INTERVAL_MS = 10_000;
const D4_RUNTIME_RESULT_TTL_MS = 15 * 60 * 1000;
const D4_RUNTIME_RESULT_MAX_ENTRIES = 512;
const D4_RUNTIME_RESULT_MAX_BYTES = 64 * 1024;
const D4_RUNTIME_RESULT_CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface SubmissionRow {
  readonly payload_digest: string;
  readonly request_id: string;
  readonly delivery_state: WebChatOwnerTaskSubmissionState;
}

interface D4RuntimeResultEntry {
  readonly scope_digest: string;
  readonly response_target: string;
  expires_at_ms: number;
  content?: string;
  content_sha256?: string;
  captured_at_ms?: number;
  unavailable_reason?: "content_too_large" | "capacity_reached";
}

interface OwnerTaskResultEntry {
  readonly scope_digest: string;
  expires_at_ms: number;
  content?: string;
  content_sha256?: string;
  captured_at_ms?: number;
  unavailable_reason?: "content_too_large" | "capacity_reached";
}

interface RuntimeSubmissionRow {
  readonly scope_digest: string;
  readonly delivery_state: WebChatOwnerTaskSubmissionState;
}

type D4RuntimeDecisionScope = Pick<WebChatD4RuntimeCancellationScope, "request_id" | "scope_digest">;

/** Durable, content-free inbox for deduplicating authenticated WebChat submissions. */
export class GatewayWebChatOwnerTaskStore implements WebChatOwnerTaskSubmissionStore {
  private readonly db: DatabaseType;
  private readonly ownerTaskResults = new Map<string, OwnerTaskResultEntry>();
  private ownerTaskResultBytes = 0;
  private readonly d4RuntimeResults = new Map<string, D4RuntimeResultEntry>();
  private d4RuntimeResultBytes = 0;
  private readonly resultCacheCleanupTimer: NodeJS.Timeout;
  private closed = false;

  constructor(filepath: string) {
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("webchat_owner_task_store_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db = new DatabaseSync(filepath);
    try {
      if (process.platform !== "win32") chmodSync(filepath, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS webchat_owner_task_inbox (
        scope_digest TEXT NOT NULL CHECK(length(scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        request_id TEXT NOT NULL UNIQUE,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN
          ('dispatching','handler_returned','outcome_unknown','rejected')),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(scope_digest,event_digest)
      ) STRICT;`);
      // 過去に別セッションで受理された同一IDも照合できるようにする。旧環境の重複行は保持する。
      this.db.exec(`CREATE INDEX IF NOT EXISTS webchat_owner_task_inbox_by_event
        ON webchat_owner_task_inbox(event_digest);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS webchat_owner_task_inbox_recent
        ON webchat_owner_task_inbox(scope_digest,created_at_ms DESC,request_id DESC) WHERE delivery_state<>'rejected';`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS webchat_d4_cancellation_commands (
        request_id TEXT NOT NULL REFERENCES webchat_owner_task_inbox(request_id),
        command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 256),
        binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64),
        PRIMARY KEY(request_id,command_id)
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") {
        throw new Error("webchat_owner_task_store_integrity_check_failed");
      }
      // A previous process may have stopped after claiming an event but before completing its handler.
      // Preserve every identity and refuse replay; never infer that no work started.
      this.transaction(() => {
        const columns = this.db.prepare("PRAGMA table_info(webchat_owner_task_inbox)").all();
        if (!columns.some(column => column.name === "d4_decision_state")) {
          this.db.exec(`ALTER TABLE webchat_owner_task_inbox ADD COLUMN d4_decision_state TEXT
            CHECK(d4_decision_state IN ('queued','started','cancelled'))`);
        }
        this.db.prepare(`UPDATE webchat_owner_task_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE delivery_state='dispatching'`).run(Date.now());
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
    this.resultCacheCleanupTimer = setInterval(() => {
      if (this.closed) return;
      const now = Date.now();
      this.pruneOwnerTaskResults(now);
      this.pruneD4RuntimeResults(now);
    }, RESULT_CACHE_CLEANUP_INTERVAL_MS);
    this.resultCacheCleanupTimer.unref();
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayWebChatOwnerTaskStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("webchat_owner_task_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "webchat-owner-task-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("webchat_owner_task_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    return new GatewayWebChatOwnerTaskStore(join(directory, "owner-task-inbox.sqlite"));
  }

  claim(input: { readonly submission_id: string; readonly payload_digest: string; readonly request_id: string }):
    WebChatOwnerTaskSubmissionClaim {
    this.assertOpen();
    if (!SUBMISSION_ID.test(input.submission_id) || !DIGEST.test(input.payload_digest) ||
        !REQUEST_ID.test(input.request_id)) throw new Error("webchat_owner_task_claim_invalid");
    const eventDigest = sha256(`webchat-owner-task-event.v1\0${input.submission_id.toLowerCase()}`);
    const result = this.claimInScope(OWNER_TASK_SCOPE, eventDigest, input.payload_digest, input.request_id, true);
    if (result.status === "not_dispatched") throw new Error("webchat_owner_task_unreachable_dispatch_state");
    if (result.status === "accepted") this.registerOwnerTaskResultTarget(result.request_id);
    return result;
  }

  claimD4RuntimeIntent(input: {
    readonly submission_id: string;
    readonly payload_digest: string;
    readonly scope_digest: string;
    readonly request_id: string;
    readonly dispatch_available: boolean;
    readonly response_target?: string;
  }): WebChatD4RuntimeIntentClaim {
    this.assertOpen();
    if (!SUBMISSION_ID.test(input.submission_id) || !DIGEST.test(input.payload_digest) ||
        !DIGEST.test(input.scope_digest) || input.scope_digest === OWNER_TASK_SCOPE || !REQUEST_ID.test(input.request_id)) {
      throw new Error("webchat_d4_runtime_intent_claim_invalid");
    }
    if (input.response_target !== undefined && !D4_RUNTIME_TARGET.test(input.response_target)) {
      throw new Error("webchat_d4_runtime_response_target_invalid");
    }
    const eventDigest = sha256(`webchat-d4-runtime-intent-event.v1\0${input.submission_id.toLowerCase()}`);
    const claim = this.claimInScope(input.scope_digest, eventDigest, input.payload_digest, input.request_id,
      input.dispatch_available);
    if (claim.status === "accepted" && input.response_target) {
      this.registerD4RuntimeResultTarget(claim.request_id, input.scope_digest, input.response_target);
    }
    return claim;
  }

  getD4RuntimeIntentStatus(input: {
    readonly submission_id: string;
    readonly scope_digest: string;
  }): WebChatOwnerTaskSubmissionStatus | null {
    this.assertOpen();
    if (!SUBMISSION_ID.test(input.submission_id) || !DIGEST.test(input.scope_digest)) {
      throw new Error("webchat_d4_runtime_intent_submission_id_invalid");
    }
    const eventDigest = sha256(`webchat-d4-runtime-intent-event.v1\0${input.submission_id.toLowerCase()}`);
    return this.getStatusInScope(input.scope_digest, eventDigest);
  }

  /** Gatewayの認証済み入口が、同じ受付の処理開始と取消を排他的に記録する。 */
  beginD4RuntimeIntentDecision(requestId: string): boolean {
    this.assertOpen();
    if (!REQUEST_ID.test(requestId)) throw new Error("webchat_d4_runtime_intent_decision_invalid");
    const result = this.db.prepare(`UPDATE webchat_owner_task_inbox SET d4_decision_state='started',updated_at_ms=?
      WHERE request_id=? AND scope_digest<>? AND delivery_state='dispatching' AND d4_decision_state='queued'`)
      .run(Date.now(), requestId, OWNER_TASK_SCOPE);
    if (result.changes === 1) return true;
    const cancelled = this.db.prepare(`SELECT 1 FROM webchat_owner_task_inbox
      WHERE request_id=? AND scope_digest<>? AND delivery_state='rejected' AND d4_decision_state='cancelled'`)
      .get(requestId, OWNER_TASK_SCOPE);
    if (cancelled) return false;
    throw new Error("webchat_d4_runtime_intent_decision_unavailable");
  }

  cancelD4RuntimeIntentBeforeDecision(scope: D4RuntimeDecisionScope): number | null {
    this.assertOpen();
    validateD4RuntimeDecisionScope(scope);
    const cancelledAt = Date.now();
    const result = this.db.prepare(`UPDATE webchat_owner_task_inbox
      SET delivery_state='rejected',d4_decision_state='cancelled',updated_at_ms=?
      WHERE request_id=? AND scope_digest=? AND scope_digest<>? AND delivery_state='dispatching' AND d4_decision_state='queued'`)
      .run(cancelledAt, scope.request_id, scope.scope_digest, OWNER_TASK_SCOPE);
    if (result.changes !== 1) return this.readD4RuntimeIntentBeforeDecisionCancellation(scope);
    const resultEntry = this.d4RuntimeResults.get(scope.request_id);
    if (resultEntry?.content !== undefined) this.d4RuntimeResultBytes -= Buffer.byteLength(resultEntry.content, "utf8");
    this.d4RuntimeResults.delete(scope.request_id);
    return cancelledAt;
  }

  readD4RuntimeIntentBeforeDecisionCancellation(scope: D4RuntimeDecisionScope): number | null {
    this.assertOpen();
    validateD4RuntimeDecisionScope(scope);
    const row = this.db.prepare(`SELECT updated_at_ms FROM webchat_owner_task_inbox
      WHERE request_id=? AND scope_digest=? AND scope_digest<>? AND delivery_state='rejected' AND d4_decision_state='cancelled'`)
      .get(scope.request_id, scope.scope_digest, OWNER_TASK_SCOPE);
    if (!row) return null;
    if (typeof row.updated_at_ms !== "number" || !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
      throw new Error("webchat_d4_runtime_intent_cancellation_invalid");
    }
    return row.updated_at_ms;
  }

  /** Preserve which command received the authenticated submission's cancellation signal. */
  bindD4RuntimeCancellationCommand(scope: WebChatD4RuntimeCancellationScope, commandId: string): void {
    this.assertOpen();
    const bindingDigest = cancellationBindingDigest(scope);
    if (!CANCELLATION_COMMAND_ID.test(commandId)) throw new Error("webchat_d4_cancellation_command_invalid");
    this.db.prepare(`INSERT INTO webchat_d4_cancellation_commands (request_id,command_id,binding_digest)
      SELECT request_id,?,? FROM webchat_owner_task_inbox
      WHERE request_id=? AND scope_digest=? AND scope_digest<>? AND delivery_state<>'rejected'
      ON CONFLICT(request_id,command_id) DO NOTHING`)
      .run(commandId, bindingDigest, scope.request_id, scope.scope_digest, OWNER_TASK_SCOPE);
  }

  /** Return observation bindings only. The Broker ledger independently proves what happened. */
  readD4RuntimeCancellationCommands(scope: WebChatD4RuntimeCancellationScope): {
    matching: readonly string[]; conflicting: readonly string[];
  } {
    this.assertOpen();
    const bindingDigest = cancellationBindingDigest(scope);
    const records = this.db.prepare(`SELECT command.command_id,command.binding_digest
      FROM webchat_d4_cancellation_commands command
      JOIN webchat_owner_task_inbox inbox ON inbox.request_id=command.request_id
      WHERE inbox.request_id=? AND inbox.scope_digest=? AND inbox.scope_digest<>? AND inbox.delivery_state<>'rejected'
      ORDER BY command.command_id LIMIT ?`)
      .all(scope.request_id, scope.scope_digest, OWNER_TASK_SCOPE, MAX_CANCELLATION_COMMANDS_PER_REQUEST + 1) as
      { command_id: string; binding_digest: string }[];
    if (records.length > MAX_CANCELLATION_COMMANDS_PER_REQUEST) {
      throw new Error("webchat_d4_cancellation_command_limit_exceeded");
    }
    const matching: string[] = [];
    const conflicting: string[] = [];
    for (const record of records) {
      if (!CANCELLATION_COMMAND_ID.test(record.command_id) || !DIGEST.test(record.binding_digest)) {
        throw new Error("webchat_d4_cancellation_command_invalid");
      }
      (record.binding_digest === bindingDigest ? matching : conflicting).push(record.command_id);
    }
    return { matching, conflicting };
  }

  getD4RuntimeIntentResult(input: {
    readonly request_id: string;
    readonly scope_digest: string;
  }): WebChatD4RuntimeIntentResult {
    this.assertOpen();
    if (!REQUEST_ID.test(input.request_id) || !DIGEST.test(input.scope_digest)) {
      return { status: "unavailable", reason_code: "not_retained", used_for_authority: false, may_execute: false };
    }
    const row = this.db.prepare(`SELECT scope_digest,delivery_state FROM webchat_owner_task_inbox
      WHERE request_id=?`).get(input.request_id) as RuntimeSubmissionRow | undefined;
    if (!row || row.scope_digest !== input.scope_digest || row.scope_digest === OWNER_TASK_SCOPE ||
        row.delivery_state === "rejected") {
      return { status: "unavailable", reason_code: "not_retained", used_for_authority: false, may_execute: false };
    }
    const now = Date.now();
    this.pruneD4RuntimeResults(now);
    const entry = this.d4RuntimeResults.get(input.request_id);
    if (entry && entry.scope_digest === input.scope_digest && entry.expires_at_ms > now) {
      if (entry.content !== undefined && entry.content_sha256 && entry.captured_at_ms !== undefined) {
        return {
          status: "available",
          content: entry.content,
          content_sha256: entry.content_sha256,
          captured_at_ms: entry.captured_at_ms,
          used_for_authority: false,
          may_execute: false,
        };
      }
      if (entry.unavailable_reason) {
        return { status: "unavailable", reason_code: entry.unavailable_reason,
          used_for_authority: false, may_execute: false };
      }
    }
    return row.delivery_state === "dispatching"
      ? { status: "not_ready", used_for_authority: false, may_execute: false }
      : { status: "unavailable", reason_code: "not_retained", used_for_authority: false, may_execute: false };
  }

  recordD4RuntimeIntentResult(input: {
    readonly request_id: string;
    readonly response_target: string;
    readonly content: string;
  }): void {
    this.assertOpen();
    if (!REQUEST_ID.test(input.request_id) || !D4_RUNTIME_TARGET.test(input.response_target)) return;
    const now = Date.now();
    this.pruneD4RuntimeResults(now);
    const entry = this.d4RuntimeResults.get(input.request_id);
    if (!entry || entry.response_target !== input.response_target || entry.expires_at_ms <= now) return;
    const row = this.db.prepare(`SELECT scope_digest,delivery_state FROM webchat_owner_task_inbox WHERE request_id=?`)
      .get(input.request_id) as RuntimeSubmissionRow | undefined;
    if (!row || row.scope_digest !== entry.scope_digest || row.scope_digest === OWNER_TASK_SCOPE ||
        row.delivery_state === "rejected") return;
    if (entry.content !== undefined) this.d4RuntimeResultBytes -= Buffer.byteLength(entry.content, "utf8");
    delete entry.content;
    delete entry.content_sha256;
    delete entry.captured_at_ms;
    delete entry.unavailable_reason;
    const byteLength = Buffer.byteLength(input.content, "utf8");
    entry.captured_at_ms = now;
    entry.expires_at_ms = now + D4_RUNTIME_RESULT_TTL_MS;
    if (byteLength > D4_RUNTIME_RESULT_MAX_BYTES) {
      entry.unavailable_reason = "content_too_large";
      return;
    }
    if (this.d4RuntimeResultBytes + byteLength > D4_RUNTIME_RESULT_CACHE_MAX_BYTES) {
      entry.unavailable_reason = "capacity_reached";
      return;
    }
    entry.content = input.content;
    entry.content_sha256 = sha256(input.content);
    this.d4RuntimeResultBytes += byteLength;
  }

  markD4RuntimeIntentHandlerReturned(input: { readonly request_id: string; readonly scope_digest: string }): void {
    this.updateDispatchState(input.request_id, "handler_returned", input.scope_digest);
  }

  markD4RuntimeIntentOutcomeUnknown(input: { readonly request_id: string; readonly scope_digest: string }): void {
    this.updateDispatchState(input.request_id, "outcome_unknown", input.scope_digest);
  }

  private claimInScope(
    scopeDigest: string,
    eventDigest: string,
    payloadDigest: string,
    requestId: string,
    dispatchAvailable = true,
  ): WebChatD4RuntimeIntentClaim {
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest,request_id,delivery_state
        FROM webchat_owner_task_inbox WHERE scope_digest=? AND event_digest=?`)
        .get(scopeDigest, eventDigest) as SubmissionRow | undefined;
      if (current) {
        validateSubmissionRow(current);
        return current.payload_digest === payloadDigest
          ? { status: "duplicate", request_id: current.request_id, state: current.delivery_state } as const
          : { status: "identity_conflict", request_id: current.request_id } as const;
      }
      if (scopeDigest !== OWNER_TASK_SCOPE) {
        const otherScope = this.db.prepare(`SELECT payload_digest,request_id,delivery_state
          FROM webchat_owner_task_inbox WHERE event_digest=? AND scope_digest NOT IN (?,?) LIMIT 1`)
          .get(eventDigest, scopeDigest, OWNER_TASK_SCOPE) as SubmissionRow | undefined;
        if (otherScope) {
          validateSubmissionRow(otherScope);
          return { status: "identity_conflict", request_id: otherScope.request_id } as const;
        }
      }
      if (!dispatchAvailable) return { status: "not_dispatched" } as const;
      const now = Date.now();
      this.db.prepare(`INSERT INTO webchat_owner_task_inbox
        (scope_digest,event_digest,payload_digest,request_id,delivery_state,created_at_ms,updated_at_ms,d4_decision_state)
        VALUES (?,?,?,?,'dispatching',?,?,?)`)
        .run(scopeDigest, eventDigest, payloadDigest, requestId, now, now, scopeDigest === OWNER_TASK_SCOPE ? null : "queued");
      return { status: "accepted", request_id: requestId } as const;
    });
  }

  private getStatusInScope(scopeDigest: string, eventDigest: string): WebChatOwnerTaskSubmissionStatus | null {
    const row = this.db.prepare(`SELECT payload_digest,request_id,delivery_state
      FROM webchat_owner_task_inbox WHERE scope_digest=? AND event_digest=?`)
      .get(scopeDigest, eventDigest) as SubmissionRow | undefined;
    if (!row) return null;
    validateSubmissionRow(row);
    return { request_id: row.request_id, state: row.delivery_state };
  }

  getStatus(input: { readonly submission_id: string }): WebChatOwnerTaskSubmissionStatus | null {
    this.assertOpen();
    if (!SUBMISSION_ID.test(input.submission_id)) throw new Error("webchat_owner_task_submission_id_invalid");
    const eventDigest = sha256(`webchat-owner-task-event.v1\0${input.submission_id.toLowerCase()}`);
    return this.getStatusInScope(OWNER_TASK_SCOPE, eventDigest);
  }

  /** 結果通知の照合候補。所有者の受付だけを返し、結果本文や申請IDは読み込まない。 */
  recentOwnerTaskRequestIdsForNotification(): string[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT request_id FROM webchat_owner_task_inbox
      WHERE scope_digest=? AND delivery_state<>'rejected'
      ORDER BY created_at_ms DESC, request_id DESC LIMIT ?`).all(OWNER_TASK_SCOPE, OWNER_NOTIFICATION_REQUEST_LIMIT);
    return rows.map(row => {
      if (typeof row.request_id !== "string" || !REQUEST_ID.test(row.request_id)) {
        throw new Error("webchat_owner_task_notification_request_id_invalid");
      }
      return row.request_id;
    });
  }

  getOwnerTaskSubmissionResult(input: { readonly request_id: string }): WebChatOwnerTaskSubmissionResult {
    this.assertOpen();
    if (!REQUEST_ID.test(input.request_id)) {
      return { status: "unavailable", reason_code: "not_retained", used_for_authority: false, may_execute: false };
    }
    const row = this.db.prepare(`SELECT scope_digest,delivery_state FROM webchat_owner_task_inbox WHERE request_id=?`)
      .get(input.request_id) as RuntimeSubmissionRow | undefined;
    if (!row || row.scope_digest !== OWNER_TASK_SCOPE || row.delivery_state === "rejected") {
      return { status: "unavailable", reason_code: "not_retained", used_for_authority: false, may_execute: false };
    }
    const now = Date.now();
    this.pruneOwnerTaskResults(now);
    const entry = this.ownerTaskResults.get(input.request_id);
    if (entry && entry.scope_digest === OWNER_TASK_SCOPE && entry.expires_at_ms > now) {
      if (entry.content !== undefined && entry.content_sha256 && entry.captured_at_ms !== undefined) {
        return { status: "available", content: entry.content, content_sha256: entry.content_sha256,
          captured_at_ms: entry.captured_at_ms, used_for_authority: false, may_execute: false };
      }
      if (entry.unavailable_reason) {
        return { status: "unavailable", reason_code: entry.unavailable_reason,
          used_for_authority: false, may_execute: false };
      }
    }
    return row.delivery_state === "dispatching"
      ? { status: "not_ready", used_for_authority: false, may_execute: false }
      : { status: "unavailable", reason_code: "not_retained", used_for_authority: false, may_execute: false };
  }

  recordOwnerTaskSubmissionResult(input: { readonly request_id: string; readonly content: string }): void {
    this.assertOpen();
    if (!REQUEST_ID.test(input.request_id)) return;
    const now = Date.now();
    this.pruneOwnerTaskResults(now);
    const entry = this.ownerTaskResults.get(input.request_id);
    if (!entry || entry.scope_digest !== OWNER_TASK_SCOPE || entry.expires_at_ms <= now) return;
    const row = this.db.prepare(`SELECT scope_digest,delivery_state FROM webchat_owner_task_inbox WHERE request_id=?`)
      .get(input.request_id) as { readonly scope_digest: string; readonly delivery_state: WebChatOwnerTaskSubmissionState } | undefined;
    if (!row || row.scope_digest !== OWNER_TASK_SCOPE || row.delivery_state === "rejected") return;
    if (entry.content !== undefined) this.ownerTaskResultBytes -= Buffer.byteLength(entry.content, "utf8");
    delete entry.content;
    delete entry.content_sha256;
    delete entry.captured_at_ms;
    delete entry.unavailable_reason;
    const byteLength = Buffer.byteLength(input.content, "utf8");
    entry.captured_at_ms = now;
    entry.expires_at_ms = now + OWNER_TASK_RESULT_TTL_MS;
    if (byteLength > OWNER_TASK_RESULT_MAX_BYTES) {
      entry.unavailable_reason = "content_too_large";
      return;
    }
    if (this.ownerTaskResultBytes + byteLength > OWNER_TASK_RESULT_CACHE_MAX_BYTES) {
      entry.unavailable_reason = "capacity_reached";
      return;
    }
    entry.content = input.content;
    entry.content_sha256 = sha256(input.content);
    this.ownerTaskResultBytes += byteLength;
  }

  markHandlerReturned(request_id: string): void {
    this.updateDispatchState(request_id, "handler_returned");
  }

  markOutcomeUnknown(request_id: string): void {
    this.updateDispatchState(request_id, "outcome_unknown");
  }

  markRejected(request_id: string): void {
    this.updateDispatchState(request_id, "rejected");
  }

  close(): void {
    if (this.closed) return;
    clearInterval(this.resultCacheCleanupTimer);
    this.ownerTaskResults.clear();
    this.ownerTaskResultBytes = 0;
    this.d4RuntimeResults.clear();
    this.d4RuntimeResultBytes = 0;
    this.db.close();
    this.closed = true;
  }

  private updateDispatchState(
    requestId: string,
    state: Exclude<WebChatOwnerTaskSubmissionState, "dispatching">,
    scopeDigest: string = OWNER_TASK_SCOPE,
  ): void {
    this.assertOpen();
    if (!REQUEST_ID.test(requestId) || !DIGEST.test(scopeDigest)) throw new Error("webchat_owner_task_request_id_invalid");
    const result = this.db.prepare(`UPDATE webchat_owner_task_inbox SET delivery_state=?,updated_at_ms=?
      WHERE scope_digest=? AND request_id=? AND delivery_state='dispatching'`)
      .run(state, Date.now(), scopeDigest, requestId);
    if (result.changes === 1 || (scopeDigest !== OWNER_TASK_SCOPE && this.readD4RuntimeIntentBeforeDecisionCancellation({
      request_id: requestId,
      scope_digest: scopeDigest,
    }) !== null)) return;
    throw new Error("webchat_owner_task_state_transition_rejected");
  }

  private registerD4RuntimeResultTarget(requestId: string, scopeDigest: string, responseTarget: string): void {
    const now = Date.now();
    this.pruneD4RuntimeResults(now);
    if (this.d4RuntimeResults.size >= D4_RUNTIME_RESULT_MAX_ENTRIES) return;
    this.d4RuntimeResults.set(requestId, {
      scope_digest: scopeDigest,
      response_target: responseTarget,
      // Keep only the digest-derived route binding while an asynchronous task is
      // running; the 15-minute result-retention window begins when output arrives.
      expires_at_ms: now + 24 * 60 * 60 * 1000,
    });
  }

  private registerOwnerTaskResultTarget(requestId: string): void {
    const now = Date.now();
    this.pruneOwnerTaskResults(now);
    if (this.ownerTaskResults.size >= OWNER_TASK_RESULT_MAX_ENTRIES) return;
    this.ownerTaskResults.set(requestId, {
      scope_digest: OWNER_TASK_SCOPE,
      // Keep only an in-memory request binding while work runs; the output retention window
      // begins only after a matching reply is captured.
      expires_at_ms: now + 24 * 60 * 60 * 1000,
    });
  }

  private pruneOwnerTaskResults(now: number): void {
    for (const [requestId, entry] of this.ownerTaskResults) {
      if (entry.expires_at_ms > now) continue;
      if (entry.content !== undefined) this.ownerTaskResultBytes -= Buffer.byteLength(entry.content, "utf8");
      this.ownerTaskResults.delete(requestId);
    }
  }

  private pruneD4RuntimeResults(now: number): void {
    for (const [requestId, entry] of this.d4RuntimeResults) {
      if (entry.expires_at_ms > now) continue;
      if (entry.content !== undefined) this.d4RuntimeResultBytes -= Buffer.byteLength(entry.content, "utf8");
      this.d4RuntimeResults.delete(requestId);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("webchat_owner_task_store_closed");
  }
}

function validateSubmissionRow(row: SubmissionRow): void {
  if (!DIGEST.test(row.payload_digest) || !REQUEST_ID.test(row.request_id) ||
      !["dispatching", "handler_returned", "outcome_unknown", "rejected"].includes(row.delivery_state)) {
    throw new Error("webchat_owner_task_store_row_invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateD4RuntimeDecisionScope(scope: D4RuntimeDecisionScope): void {
  if (!REQUEST_ID.test(scope.request_id) || !DIGEST.test(scope.scope_digest)) {
    throw new Error("webchat_d4_runtime_intent_decision_invalid");
  }
}

function cancellationBindingDigest(scope: WebChatD4RuntimeCancellationScope): string {
  if (!REQUEST_ID.test(scope.request_id) || !DIGEST.test(scope.scope_digest) ||
      !DIGEST.test(scope.runtime_ref_digest) || !DIGEST.test(scope.session_ref_digest)) {
    throw new Error("webchat_d4_cancellation_scope_invalid");
  }
  return sha256(JSON.stringify(["webchat-d4-cancellation-scope.v1", scope.request_id, scope.scope_digest,
    scope.runtime_ref_digest, scope.session_ref_digest]));
}
