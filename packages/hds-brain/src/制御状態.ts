import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  parseMemoryCommitV2,
  parseMemoryUpdateReceipt,
  type MemoryUpdateReceiptV1,
} from "@blue-tanuki/protocol";
import {
  classifyPersistenceFailure,
  resolvePrivateStateDatabasePath,
  PersistenceStoreError,
  sqliteErrorCode,
  type JMemoryApprovalReader,
  type JMemoryApprovalReference,
  type PersistenceFailureReason,
  type PersistenceHealth,
  type PersistenceRecoveryResult,
} from "./保存取引.js";
import { MemoryUpdateLedger } from "./記憶更新.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const J_STORAGE_SCHEMA_VERSION = 1;
const J_EVENT_SCHEMA_VERSION = "blue-tanuki.j-control-event.v1" as const;
const GENESIS_EVENT_DIGEST = "GENESIS";
const J_TABLES = ["j_events", "j_pending", "j_schema", "j_state"] as const;

type JControlStatus = "ready" | "memory_commit_pending" | "blocked";
type PendingStatus = "pending" | "receipt_confirmed" | "blocked";
type JBlockReason = "m_receipt_mismatch" | "m_update_rejected";

export interface JPendingSnapshot {
  readonly update_id: string;
  readonly j_event_id: string;
  readonly content_digest: string;
  readonly expected_version: number;
  readonly status: PendingStatus;
  readonly receipt: MemoryUpdateReceiptV1 | null;
  readonly block_reason: JBlockReason | null;
}

export interface JControlSnapshot {
  readonly revision: number;
  readonly event_digest: string;
  readonly status: JControlStatus;
  readonly active_update_id: string | null;
  readonly pending: readonly JPendingSnapshot[];
}

export type JMemoryCommitStageResult =
  | { readonly ok: true; readonly status: JControlStatus; readonly revision: number; readonly update_id: string }
  | { readonly ok: false; readonly reason: "schema_validation_failed" | "j_approval_not_verified" | "update_id_content_conflict" | "pending_update_exists" | "store_integrity_failed" | "storage_failed" | "commit_outcome_unknown" | "store_unavailable" | PersistenceFailureReason };

export type JMemoryCommitReconciliationResult =
  | { readonly ok: true; readonly status: "memory_commit_pending"; readonly revision: number; readonly update_id: string }
  | { readonly ok: true; readonly status: "ready"; readonly revision: number; readonly update_id: string; readonly receipt: MemoryUpdateReceiptV1 }
  | { readonly ok: false; readonly status: "blocked"; readonly revision: number | null; readonly update_id: string; readonly reason: "pending_not_found" | "store_integrity_failed" | "m_store_integrity_failed" | JBlockReason | "storage_failed" | "commit_outcome_unknown" | "store_unavailable" | PersistenceFailureReason };

interface SqlRow {
  readonly [key: string]: unknown;
}

interface JStateProjection {
  revision: number;
  event_digest: string;
  status: JControlStatus;
  active_update_id: string | null;
  pending: Map<string, JPendingSnapshot>;
}

interface JEventCommon {
  readonly schema_version: typeof J_EVENT_SCHEMA_VERSION;
  readonly event_id: string;
  readonly revision: number;
  readonly previous_event_digest: string;
  readonly update_id: string;
  readonly occurred_at_utc: string;
}

interface JPendingEvent extends JEventCommon {
  readonly event_type: "memory_commit_pending";
  readonly j_event_id: string;
  readonly content_digest: string;
  readonly expected_version: number;
}

interface JReceiptEvent extends JEventCommon {
  readonly event_type: "memory_commit_receipt_confirmed";
  readonly receipt: MemoryUpdateReceiptV1;
}

interface JBlockedEvent extends JEventCommon {
  readonly event_type: "memory_commit_blocked";
  readonly reason: JBlockReason;
}

type JEventBody = JPendingEvent | JReceiptEvent | JBlockedEvent;
type JStoredEvent = JEventBody & { readonly event_digest: string };

/**
 * J所有の内部保存とM receipt再照合を担う。実J authority sourceとconsumerが
 * 別単位で接続・検証されるまで、HDS package barrelからは公開しない。
 */
export class JMemoryCommitCoordinator {
  private readonly store: JControlStateStore;
  private readonly memoryLedger: MemoryUpdateLedger;
  private readonly jApprovalVerifier: JMemoryApprovalReader;
  private closed = false;

  constructor(options: {
    readonly private_state_root: string;
    readonly database_path: string;
    readonly j_approval_reader: JMemoryApprovalReader;
    readonly now?: () => Date;
  }) {
    let store: JControlStateStore | undefined;
    const persistedApprovalReader: JMemoryApprovalReader = {
      readVerifiedMemoryApproval: (reference) => store?.readVerifiedMemoryApproval(reference) ?? null,
    };
    this.memoryLedger = new MemoryUpdateLedger({
      private_state_root: options.private_state_root,
      database_path: options.database_path,
      j_approval_reader: persistedApprovalReader,
      now: options.now,
    });
    try {
      store = new JControlStateStore({
        private_state_root: options.private_state_root,
        database_path: options.database_path,
        now: options.now,
      });
      this.store = store;
    } catch (error) {
      this.memoryLedger.close();
      if (error instanceof PersistenceStoreError) throw error;
      throw new PersistenceStoreError("J", classifyPersistenceFailure(error));
    }
    this.jApprovalVerifier = options.j_approval_reader;
  }

  /** M書込み前に、検証済みJ参照の不透明な識別情報だけを保存する。 */
  stage(input: unknown): JMemoryCommitStageResult {
    if (this.closed || !this.store.health().available || !this.memoryLedger.health().available) {
      return { ok: false, reason: "store_unavailable" };
    }
    return this.store.stage(input, this.jApprovalVerifier);
  }

  /** M ledgerは自身のtransaction内で保存済みJ参照を再照合する。 */
  apply(input: unknown) {
    if (this.closed) return { ok: false as const, reason: "store_unavailable" as const };
    const parsed = parseMemoryCommitV2(input);
    if (!parsed.ok) return { ok: false as const, reason: "schema_validation_failed" as const };
    if (!this.store.matchesPendingCommit(parsed.commit, parsed.content_digest)) {
      return { ok: false as const, reason: "j_approval_not_verified" as const };
    }
    const result = this.memoryLedger.apply(parsed.commit);
    if (!result.ok && [
      "schema_validation_failed",
      "j_approval_not_verified",
      "update_id_content_conflict",
      "expected_version_conflict",
      "storage_failed",
      "disk_full",
      "write_failed",
      "sync_failed",
    ].includes(result.reason)) {
      this.store.blockPending(parsed.commit.update_id, "m_update_rejected");
    }
    return result;
  }

  /** receiptの読取専用照合。M applyや新規記憶更新を呼び出さない。 */
  reconcile(updateId: string): JMemoryCommitReconciliationResult {
    if (this.closed) {
      return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: "store_unavailable" };
    }
    return this.store.reconcile(updateId, this.memoryLedger);
  }

  snapshot(): JControlSnapshot | null {
    return this.closed ? null : this.store.snapshot();
  }

  verify(): boolean {
    return !this.closed && this.store.verify() && this.memoryLedger.verify();
  }

  health(): Readonly<{ j: PersistenceHealth; m: PersistenceHealth }> {
    return Object.freeze({ j: this.store.health(), m: this.memoryLedger.health() });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
    this.memoryLedger.close();
  }
}

class JControlStateStore {
  private readonly database: DatabaseSyncType;
  private readonly now: () => Date;
  private unavailable = false;
  private failureReason: PersistenceFailureReason | null = null;
  private outcomeUnknown = false;
  private closed = false;

  constructor(options: {
    readonly private_state_root: string;
    readonly database_path: string;
    readonly now?: () => Date;
  }) {
    let databasePath: string;
    try {
      databasePath = resolvePrivateStateDatabasePath(options.private_state_root, options.database_path);
    } catch {
      throw new Error("invalid private state database path");
    }
    this.now = options.now ?? (() => new Date());
    let database: DatabaseSyncType | undefined;
    try {
      database = new DatabaseSync(databasePath, {
        enableForeignKeyConstraints: true,
        allowExtension: false,
      });
      database.enableLoadExtension(false);
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("PRAGMA synchronous = EXTRA");
      database.exec("PRAGMA foreign_keys = ON");
      if (!verifyPragmas(database) || !verifyMNamespace(database)) {
        throw new PersistenceStoreError("J", "schema_mismatch");
      }
      this.database = database;
      initializeJStorageSchema(database);
      const inspection = inspectJDatabase(database);
      if (!inspection.ok) throw new PersistenceStoreError("J", inspection.reason);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // 初期化失敗は汎用エラーに留め、保存先を出力しない。
      }
      if (error instanceof PersistenceStoreError) throw error;
      throw new PersistenceStoreError("J", classifyPersistenceFailure(error));
    }
  }

  stage(input: unknown, approvalReader: JMemoryApprovalReader): JMemoryCommitStageResult {
    if (this.closed || this.unavailable) return { ok: false, reason: "store_unavailable" };
    const parsed = parseMemoryCommitV2(input);
    if (!parsed.ok) return { ok: false, reason: "schema_validation_failed" };
    let transactionStarted = false;
    let commitAttempted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const inspection = inspectJDatabase(this.database);
      if (!inspection.ok) {
        this.rollbackAndStop(inspection.reason);
        transactionStarted = false;
        return { ok: false, reason: this.failureReason ?? inspection.reason };
      }
      const approvalReference: JMemoryApprovalReference = Object.freeze({
        update_id: parsed.commit.update_id,
        j_event_id: parsed.commit.j_event_id,
        content_digest: parsed.content_digest,
      });
      let approval: unknown;
      try {
        approval = approvalReader.readVerifiedMemoryApproval(approvalReference);
      } catch {
        approval = null;
      }
      if (!matchesApprovalReference(approval, approvalReference)) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: false, reason: "j_approval_not_verified" };
      }

      const projection = replayDatabase(this.database);
      if (!projection) {
        this.rollbackAndStop("ledger_corrupt");
        transactionStarted = false;
        return { ok: false, reason: this.failureReason ?? "ledger_corrupt" };
      }
      const existing = projection.pending.get(parsed.commit.update_id);
      if (existing) {
        if (existing.j_event_id !== parsed.commit.j_event_id ||
            existing.content_digest !== parsed.content_digest ||
            existing.expected_version !== parsed.commit.expected_version) {
          this.database.exec("ROLLBACK");
          transactionStarted = false;
          return { ok: false, reason: "update_id_content_conflict" };
        }
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return {
          ok: true,
          status: existing.status === "pending" ? "memory_commit_pending" : existing.status === "receipt_confirmed" ? "ready" : "blocked",
          revision: projection.revision,
          update_id: parsed.commit.update_id,
        };
      }
      if (projection.status !== "ready" || projection.active_update_id !== null) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: false, reason: "pending_update_exists" };
      }

      const eventBody: JPendingEvent = {
        schema_version: J_EVENT_SCHEMA_VERSION,
        event_type: "memory_commit_pending",
        event_id: `j-control:${randomUUID()}`,
        revision: projection.revision + 1,
        previous_event_digest: projection.event_digest,
        update_id: parsed.commit.update_id,
        j_event_id: parsed.commit.j_event_id,
        content_digest: parsed.content_digest,
        expected_version: parsed.commit.expected_version,
        occurred_at_utc: this.now().toISOString(),
      };
      const event = storeEvent(eventBody);
      this.insertEvent(event);
      this.database.prepare(
        "INSERT INTO j_pending (update_id, j_event_id, content_digest, expected_version, status, receipt_json, block_reason) VALUES (?, ?, ?, ?, 'pending', NULL, NULL)",
      ).run(parsed.commit.update_id, parsed.commit.j_event_id, parsed.content_digest, parsed.commit.expected_version);
      this.database.prepare(
        "UPDATE j_state SET revision = ?, event_digest = ?, status = 'memory_commit_pending', active_update_id = ? WHERE singleton = 1",
      ).run(event.revision, event.event_digest, parsed.commit.update_id);
      commitAttempted = true;
      this.database.exec("COMMIT");
      transactionStarted = false;
      return { ok: true, status: "memory_commit_pending", revision: event.revision, update_id: parsed.commit.update_id };
    } catch (error) {
      const failure = classifyPersistenceFailure(error);
      if (commitAttempted) {
        this.stop(failure, true);
        return { ok: false, reason: "commit_outcome_unknown" };
      }
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          this.stop(failure, true);
          return { ok: false, reason: "commit_outcome_unknown" };
        }
      }
      this.stop(failure);
      return { ok: false, reason: failure };
    }
  }

  readVerifiedMemoryApproval(reference: JMemoryApprovalReference): unknown {
    if (this.closed || this.unavailable) return null;
    try {
      const inspection = inspectJDatabase(this.database);
      if (!inspection.ok) {
        this.stop(inspection.reason);
        return null;
      }
      const projection = replayDatabase(this.database);
      if (!projection || projection.status !== "memory_commit_pending" ||
          projection.active_update_id !== reference.update_id) return null;
      const pending = projection.pending.get(reference.update_id);
      if (!pending || pending.status !== "pending") return null;
      const verifiedReference = Object.freeze({
        update_id: pending.update_id,
        j_event_id: pending.j_event_id,
        content_digest: pending.content_digest,
      });
      return matchesApprovalReference(verifiedReference, reference) ? verifiedReference : null;
    } catch (error) {
      this.stop(classifyPersistenceFailure(error));
      return null;
    }
  }

  matchesPendingCommit(commit: { readonly update_id: string; readonly j_event_id: string }, contentDigest: string): boolean {
    const reference: JMemoryApprovalReference = {
      update_id: commit.update_id,
      j_event_id: commit.j_event_id,
      content_digest: contentDigest,
    };
    return this.readVerifiedMemoryApproval(reference) !== null;
  }

  blockPending(updateId: string, reason: JBlockReason): boolean {
    if (this.closed || this.unavailable) return false;
    let transactionStarted = false;
    let commitAttempted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const inspection = inspectJDatabase(this.database);
      if (!inspection.ok) {
        this.rollbackAndStop(inspection.reason);
        return false;
      }
      const projection = replayDatabase(this.database);
      const pending = projection?.pending.get(updateId);
      if (!projection || !pending) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return false;
      }
      if (pending.status === "blocked") {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return pending.block_reason === reason;
      }
      if (pending.status !== "pending" || projection.status !== "memory_commit_pending" ||
          projection.active_update_id !== updateId) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return false;
      }
      const eventBody: JBlockedEvent = {
        schema_version: J_EVENT_SCHEMA_VERSION,
        event_type: "memory_commit_blocked",
        event_id: `j-control:${randomUUID()}`,
        revision: projection.revision + 1,
        previous_event_digest: projection.event_digest,
        update_id: pending.update_id,
        reason,
        occurred_at_utc: this.now().toISOString(),
      };
      const event = storeEvent(eventBody);
      this.insertEvent(event);
      this.database.prepare(
        "UPDATE j_pending SET status = 'blocked', block_reason = ? WHERE update_id = ?",
      ).run(reason, updateId);
      this.database.prepare(
        "UPDATE j_state SET revision = ?, event_digest = ?, status = 'blocked', active_update_id = ? WHERE singleton = 1",
      ).run(event.revision, event.event_digest, updateId);
      commitAttempted = true;
      this.database.exec("COMMIT");
      transactionStarted = false;
      return true;
    } catch (error) {
      const failure = classifyPersistenceFailure(error);
      if (commitAttempted) {
        this.stop(failure, true);
        return false;
      }
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          this.stop(failure, true);
        }
      }
      this.stop(failure);
      return false;
    }
  }

  reconcile(updateId: string, memoryLedger: MemoryUpdateLedger): JMemoryCommitReconciliationResult {
    if (this.closed || this.unavailable) {
      return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: "store_unavailable" };
    }
    if (!isIdentifier(updateId)) {
      return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: "pending_not_found" };
    }
    let projection = this.safeReplay();
    if (!projection) {
      return {
        ok: false,
        status: "blocked",
        revision: null,
        update_id: updateId,
        reason: this.failureReason ?? "store_integrity_failed",
      };
    }
    let pending = projection.pending.get(updateId);
    if (!pending) {
      return { ok: false, status: "blocked", revision: projection.revision, update_id: updateId, reason: "pending_not_found" };
    }
    if (!memoryLedger.verify()) {
      return {
        ok: false,
        status: "blocked",
        revision: projection.revision,
        update_id: updateId,
        reason: memoryLedger.health().failure ?? "m_store_integrity_failed",
      };
    }
    const receipt = memoryLedger.receipt(updateId);
    if (pending.status === "blocked") {
      return { ok: false, status: "blocked", revision: projection.revision, update_id: updateId, reason: pending.block_reason ?? "m_receipt_mismatch" };
    }
    if (pending.status === "receipt_confirmed") {
      if (!receipt || !receiptMatchesPending(receipt, pending) ||
          !pending.receipt || canonicalJson(receipt) !== canonicalJson(pending.receipt)) {
        return { ok: false, status: "blocked", revision: projection.revision, update_id: updateId, reason: "m_receipt_mismatch" };
      }
      return { ok: true, status: "ready", revision: projection.revision, update_id: updateId, receipt: pending.receipt };
    }
    if (receipt === null) {
      return { ok: true, status: "memory_commit_pending", revision: projection.revision, update_id: updateId };
    }

    let transactionStarted = false;
    let commitAttempted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const inspection = inspectJDatabase(this.database);
      if (!inspection.ok) {
        this.rollbackAndStop(inspection.reason);
        transactionStarted = false;
        return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: this.failureReason ?? inspection.reason };
      }
      projection = replayDatabase(this.database);
      pending = projection?.pending.get(updateId);
      if (!projection || !pending) {
        this.rollbackAndStop("ledger_corrupt");
        transactionStarted = false;
        return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: this.unavailable ? "commit_outcome_unknown" : "store_integrity_failed" };
      }
      if (pending.status === "receipt_confirmed" && pending.receipt) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return receiptMatchesPending(receipt, pending)
          ? { ok: true, status: "ready", revision: projection.revision, update_id: updateId, receipt: pending.receipt }
          : { ok: false, status: "blocked", revision: projection.revision, update_id: updateId, reason: "m_receipt_mismatch" };
      }
      if (pending.status !== "pending" || projection.status !== "memory_commit_pending" ||
          projection.active_update_id !== updateId) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: false, status: "blocked", revision: projection.revision, update_id: updateId, reason: "store_integrity_failed" };
      }

      if (!receiptMatchesPending(receipt, pending)) {
        const eventBody: JBlockedEvent = {
          schema_version: J_EVENT_SCHEMA_VERSION,
          event_type: "memory_commit_blocked",
          event_id: `j-control:${randomUUID()}`,
          revision: projection.revision + 1,
          previous_event_digest: projection.event_digest,
          update_id: pending.update_id,
          reason: "m_receipt_mismatch",
          occurred_at_utc: this.now().toISOString(),
        };
        const event = storeEvent(eventBody);
        this.insertEvent(event);
        this.database.prepare(
          "UPDATE j_pending SET status = 'blocked', block_reason = 'm_receipt_mismatch' WHERE update_id = ?",
        ).run(updateId);
        this.database.prepare(
          "UPDATE j_state SET revision = ?, event_digest = ?, status = 'blocked', active_update_id = ? WHERE singleton = 1",
        ).run(event.revision, event.event_digest, updateId);
        commitAttempted = true;
        this.database.exec("COMMIT");
        transactionStarted = false;
        return { ok: false, status: "blocked", revision: event.revision, update_id: updateId, reason: "m_receipt_mismatch" };
      }

      const eventBody: JReceiptEvent = {
        schema_version: J_EVENT_SCHEMA_VERSION,
        event_type: "memory_commit_receipt_confirmed",
        event_id: `j-control:${randomUUID()}`,
        revision: projection.revision + 1,
        previous_event_digest: projection.event_digest,
        update_id: pending.update_id,
        receipt,
        occurred_at_utc: this.now().toISOString(),
      };
      const event = storeEvent(eventBody);
      this.insertEvent(event);
      this.database.prepare(
        "UPDATE j_pending SET status = 'receipt_confirmed', receipt_json = ?, block_reason = NULL WHERE update_id = ?",
      ).run(canonicalJson(receipt), updateId);
      this.database.prepare(
        "UPDATE j_state SET revision = ?, event_digest = ?, status = 'ready', active_update_id = NULL WHERE singleton = 1",
      ).run(event.revision, event.event_digest);
      commitAttempted = true;
      this.database.exec("COMMIT");
      transactionStarted = false;
      return { ok: true, status: "ready", revision: event.revision, update_id: updateId, receipt };
    } catch (error) {
      const failure = classifyPersistenceFailure(error);
      if (commitAttempted) {
        this.stop(failure, true);
        return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: "commit_outcome_unknown" };
      }
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          this.stop(failure, true);
          return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: "commit_outcome_unknown" };
        }
      }
      this.stop(failure);
      return { ok: false, status: "blocked", revision: null, update_id: updateId, reason: failure };
    }
  }

  snapshot(): JControlSnapshot | null {
    const projection = this.safeReplay();
    if (!projection) return null;
    return Object.freeze({
      revision: projection.revision,
      event_digest: projection.event_digest,
      status: projection.status,
      active_update_id: projection.active_update_id,
      pending: Object.freeze([...projection.pending.values()].map((item) => Object.freeze({ ...item }))),
    });
  }

  verify(): boolean {
    if (this.closed || this.unavailable) return false;
    try {
      if (!verifyPragmas(this.database)) {
        this.stop("schema_mismatch");
        return false;
      }
      const inspection = inspectJDatabase(this.database);
      if (!inspection.ok) {
        this.stop(inspection.reason);
        return false;
      }
      return true;
    } catch (error) {
      this.stop(classifyPersistenceFailure(error));
      return false;
    }
  }

  health(): PersistenceHealth {
    return Object.freeze({
      available: !this.closed && !this.unavailable,
      failure: this.failureReason,
      outcome_unknown: this.outcomeUnknown,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private safeReplay(): JStateProjection | null {
    if (this.closed || this.unavailable) return null;
    try {
      const inspection = inspectJDatabase(this.database);
      if (!inspection.ok) {
        this.stop(inspection.reason);
        return null;
      }
      return inspection.projection;
    } catch (error) {
      this.stop(classifyPersistenceFailure(error));
      return null;
    }
  }

  private insertEvent(event: JStoredEvent): void {
    this.database.prepare(
      "INSERT INTO j_events (event_id, revision, previous_event_digest, event_digest, event_payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(event.event_id, event.revision, event.previous_event_digest, event.event_digest, canonicalJson(event));
  }

  private stop(reason: PersistenceFailureReason, outcomeUnknown = false): void {
    this.unavailable = true;
    this.failureReason = reason;
    this.outcomeUnknown = outcomeUnknown;
  }

  private rollbackAndStop(reason: PersistenceFailureReason): void {
    try {
      this.database.exec("ROLLBACK");
      this.stop(reason);
    } catch (error) {
      this.stop(classifyPersistenceFailure(error), true);
    }
  }
}

function openJRecoveryDatabase(options: {
  readonly private_state_root: string;
  readonly database_path: string;
}): DatabaseSyncType {
  let databasePath: string;
  try {
    databasePath = resolvePrivateStateDatabasePath(options.private_state_root, options.database_path);
  } catch {
    throw new PersistenceStoreError("J", "store_unavailable");
  }
  let databaseExists = false;
  try {
    databaseExists = existsSync(databasePath) && statSync(databasePath).size > 0;
  } catch {
    throw new PersistenceStoreError("J", "store_unavailable");
  }
  if (!databaseExists) {
    throw new PersistenceStoreError("J", "store_unavailable");
  }
  let database: DatabaseSyncType;
  try {
    database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
  } catch (error) {
    const reason = sqliteErrorCode(error) === null ? "store_unavailable" : classifyPersistenceFailure(error);
    throw new PersistenceStoreError("J", reason);
  }
  try {
    database.enableLoadExtension(false);
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA synchronous = EXTRA");
    database.exec("PRAGMA foreign_keys = ON");
    if (!verifyPragmas(database)) throw new PersistenceStoreError("J", "schema_mismatch");
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Keep the recovery error bounded to a safe category.
    }
    if (error instanceof PersistenceStoreError) throw error;
    throw new PersistenceStoreError("J", classifyPersistenceFailure(error));
  }
}

/**
 * Explicit J-only recovery entrypoint. It replays j_events and rewrites only
 * j_state/j_pending; no runtime or package-barrel consumer invokes it.
 */
export function rebuildJControlProjection(options: {
  readonly private_state_root: string;
  readonly database_path: string;
}): PersistenceRecoveryResult {
  let database: DatabaseSyncType | undefined;
  let transactionStarted = false;
  let commitAttempted = false;
  try {
    database = openJRecoveryDatabase(options);
    if (!verifyJTableSchema(database) || !verifyNoJRecoveryTriggers(database)) {
      return { ok: false, reason: "schema_mismatch" };
    }
    if (!replayDatabase(database)) return { ok: false, reason: "ledger_corrupt" };

    database.exec("BEGIN EXCLUSIVE");
    transactionStarted = true;
    if (!verifyJTableSchema(database) || !verifyNoJRecoveryTriggers(database)) {
      database.exec("ROLLBACK");
      transactionStarted = false;
      return { ok: false, reason: "schema_mismatch" };
    }
    const projection = replayDatabase(database);
    if (!projection) {
      database.exec("ROLLBACK");
      transactionStarted = false;
      return { ok: false, reason: "ledger_corrupt" };
    }

    database.exec("DELETE FROM j_pending");
    const insertPending = database.prepare(
      "INSERT INTO j_pending (update_id, j_event_id, content_digest, expected_version, status, receipt_json, block_reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of projection.pending.values()) {
      insertPending.run(
        item.update_id,
        item.j_event_id,
        item.content_digest,
        item.expected_version,
        item.status,
        item.receipt === null ? null : canonicalJson(item.receipt),
        item.block_reason,
      );
    }
    database.exec("DELETE FROM j_state");
    database.prepare(
      "INSERT INTO j_state (singleton, revision, event_digest, status, active_update_id) VALUES (1, ?, ?, ?, ?)",
    ).run(projection.revision, projection.event_digest, projection.status, projection.active_update_id);
    if (!verifyJDerivedProjection(database, projection)) {
      database.exec("ROLLBACK");
      transactionStarted = false;
      return { ok: false, reason: "projection_mismatch" };
    }

    commitAttempted = true;
    database.exec("COMMIT");
    transactionStarted = false;
    const afterCommit = inspectJDatabase(database);
    if (!afterCommit.ok) return { ok: false, reason: afterCommit.reason };
    return { ok: true, revision: projection.revision, event_count: projection.revision };
  } catch (error) {
    const reason = error instanceof PersistenceStoreError
      ? error.reason
      : classifyPersistenceFailure(error);
    if (transactionStarted && database) {
      try {
        database.exec("ROLLBACK");
        transactionStarted = false;
      } catch {
        return { ok: false, reason, outcome_unknown: true };
      }
    }
    return commitAttempted
      ? { ok: false, reason, outcome_unknown: true }
      : { ok: false, reason };
  } finally {
    try {
      database?.close();
    } catch {
      // The recovery result never includes raw driver errors or paths.
    }
  }
}

function initializeJStorageSchema(database: DatabaseSyncType): void {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'j_*' ORDER BY name")
    .all().map((row) => stringValue(row.name)).filter((name): name is string => name !== null);
  const schemaExists = tables.includes("j_schema");
  if (schemaExists) {
    if (!verifyJTableSchema(database)) throw new PersistenceStoreError("J", "schema_mismatch");
    return;
  }
  if (tables.length > 0) throw new PersistenceStoreError("J", "schema_mismatch");

  database.exec("BEGIN EXCLUSIVE");
  try {
    database.exec(`
      CREATE TABLE j_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE j_events (
        event_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
        previous_event_digest TEXT NOT NULL,
        event_digest TEXT NOT NULL CHECK (length(event_digest) = 64),
        event_payload_json TEXT NOT NULL
      );
      CREATE TABLE j_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        event_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'memory_commit_pending', 'blocked')),
        active_update_id TEXT
      );
      CREATE TABLE j_pending (
        update_id TEXT PRIMARY KEY,
        j_event_id TEXT NOT NULL UNIQUE,
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'receipt_confirmed', 'blocked')),
        receipt_json TEXT,
        block_reason TEXT,
        CHECK ((status = 'pending' AND receipt_json IS NULL AND block_reason IS NULL) OR
               (status = 'receipt_confirmed' AND receipt_json IS NOT NULL AND block_reason IS NULL) OR
               (status = 'blocked' AND receipt_json IS NULL AND block_reason IN ('m_receipt_mismatch', 'm_update_rejected')))
      );
      INSERT INTO j_schema (singleton, schema_version) VALUES (1, ${J_STORAGE_SCHEMA_VERSION});
      INSERT INTO j_state (singleton, revision, event_digest, status, active_update_id)
        VALUES (1, 0, '${GENESIS_EVENT_DIGEST}', 'ready', NULL);
    `);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 初期化を中止し、接続は呼出元が閉じる。
    }
    throw new PersistenceStoreError("J", classifyPersistenceFailure(error));
  }
}

const J_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  j_events: ["event_id", "revision", "previous_event_digest", "event_digest", "event_payload_json"],
  j_pending: ["update_id", "j_event_id", "content_digest", "expected_version", "status", "receipt_json", "block_reason"],
  j_schema: ["singleton", "schema_version"],
  j_state: ["singleton", "revision", "event_digest", "status", "active_update_id"],
});

type JDatabaseInspection =
  | { readonly ok: true; readonly projection: JStateProjection }
  | { readonly ok: false; readonly reason: PersistenceFailureReason };

function verifyJTableSchema(database: DatabaseSyncType): boolean {
  const actualTables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'j_*' ORDER BY name",
  ).all().map((row) => stringValue(row.name)).filter((name): name is string => name !== null);
  const expectedTables = Object.keys(J_TABLE_COLUMNS).sort();
  if (actualTables.length !== expectedTables.length ||
      actualTables.some((name, index) => name !== expectedTables[index])) return false;
  for (const tableName of expectedTables) {
    const columns = database.prepare("PRAGMA table_info(" + tableName + ")").all()
      .map((row) => stringValue(row.name));
    const expected = J_TABLE_COLUMNS[tableName];
    if (!expected || columns.length !== expected.length ||
        columns.some((name, index) => name !== expected[index])) return false;
  }
  const schemaRows = database.prepare("SELECT singleton, schema_version FROM j_schema").all();
  return schemaRows.length === 1 && integerValue(schemaRows[0]?.singleton) === 1 &&
    integerValue(schemaRows[0]?.schema_version) === J_STORAGE_SCHEMA_VERSION;
}

function verifyNoJRecoveryTriggers(database: DatabaseSyncType): boolean {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name GLOB 'j_*'",
  ).all().length === 0;
}

function verifyJDerivedProjection(database: DatabaseSyncType, projection: JStateProjection): boolean {
  const stateRows = database.prepare("SELECT singleton, revision, event_digest, status, active_update_id FROM j_state").all();
  if (stateRows.length !== 1 || integerValue(stateRows[0]?.singleton) !== 1 ||
      integerValue(stateRows[0]?.revision) !== projection.revision ||
      stringValue(stateRows[0]?.event_digest) !== projection.event_digest ||
      stringValue(stateRows[0]?.status) !== projection.status ||
      nullableStringValue(stateRows[0]?.active_update_id) !== projection.active_update_id) return false;

  const pendingRows = database.prepare(
    "SELECT update_id, j_event_id, content_digest, expected_version, status, receipt_json, block_reason FROM j_pending ORDER BY update_id",
  ).all();
  if (pendingRows.length !== projection.pending.size) return false;
  for (const row of pendingRows) {
    const updateId = stringValue(row.update_id);
    const item = updateId === null ? undefined : projection.pending.get(updateId);
    if (!item || stringValue(row.j_event_id) !== item.j_event_id ||
        stringValue(row.content_digest) !== item.content_digest ||
        integerValue(row.expected_version) !== item.expected_version ||
        stringValue(row.status) !== item.status ||
        nullableStringValue(row.block_reason) !== item.block_reason) return false;
    const receiptJson = nullableStringValue(row.receipt_json);
    if (item.receipt === null) {
      if (receiptJson !== null) return false;
    } else {
      let parsed: ReturnType<typeof parseMemoryUpdateReceipt>;
      try {
        parsed = receiptJson === null
          ? { ok: false, reason: "schema_validation_failed" }
          : parseMemoryUpdateReceipt(JSON.parse(receiptJson) as unknown);
      } catch {
        return false;
      }
      if (!parsed.ok || canonicalJson(parsed.receipt) !== canonicalJson(item.receipt) ||
          canonicalJson(parsed.receipt) !== receiptJson) return false;
    }
  }
  return true;
}

function inspectJDatabase(database: DatabaseSyncType): JDatabaseInspection {
  try {
    if (!verifyJTableSchema(database)) return { ok: false, reason: "schema_mismatch" };
    const projection = replayDatabase(database);
    if (!projection) return { ok: false, reason: "ledger_corrupt" };
    if (!verifyJDerivedProjection(database, projection)) return { ok: false, reason: "projection_mismatch" };
    return { ok: true, projection };
  } catch (error) {
    const reason = classifyPersistenceFailure(error);
    return {
      ok: false,
      reason: sqliteErrorCode(error) !== null && reason === "write_failed" ? "store_unavailable" : reason,
    };
  }
}

function replayDatabase(database: DatabaseSyncType): JStateProjection | null {
  try {
    const events = database.prepare(
      "SELECT event_id, revision, previous_event_digest, event_digest, event_payload_json FROM j_events ORDER BY revision",
    ).all();
    let projection: JStateProjection = {
      revision: 0,
      event_digest: GENESIS_EVENT_DIGEST,
      status: "ready",
      active_update_id: null,
      pending: new Map(),
    };
    for (const row of events) {
      const json = stringValue(row.event_payload_json);
      if (json === null) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(json) as unknown;
      } catch {
        return null;
      }
      if (canonicalJson(raw) !== json) return null;
      const event = parseStoredEvent(raw, row);
      if (!event || event.revision !== projection.revision + 1 ||
          event.previous_event_digest !== projection.event_digest) return null;
      const next = applyEvent(projection, event);
      if (!next) return null;
      projection = next;
    }
    return projection;
  } catch (error) {
    if (sqliteErrorCode(error) !== null) throw error;
    return null;
  }
}

function applyEvent(current: JStateProjection, event: JStoredEvent): JStateProjection | null {
  const pending = new Map(current.pending);
  if (event.event_type === "memory_commit_pending") {
    if (current.status !== "ready" || current.active_update_id !== null || pending.has(event.update_id)) return null;
    pending.set(event.update_id, {
      update_id: event.update_id,
      j_event_id: event.j_event_id,
      content_digest: event.content_digest,
      expected_version: event.expected_version,
      status: "pending",
      receipt: null,
      block_reason: null,
    });
    return {
      revision: event.revision,
      event_digest: event.event_digest,
      status: "memory_commit_pending",
      active_update_id: event.update_id,
      pending,
    };
  }
  const existing = pending.get(event.update_id);
  if (!existing || existing.status !== "pending" || current.status !== "memory_commit_pending" ||
      current.active_update_id !== event.update_id) return null;
  if (event.event_type === "memory_commit_blocked") {
    pending.set(event.update_id, { ...existing, status: "blocked", block_reason: event.reason });
    return {
      revision: event.revision,
      event_digest: event.event_digest,
      status: "blocked",
      active_update_id: event.update_id,
      pending,
    };
  }
  if (!receiptMatchesPending(event.receipt, existing)) return null;
  pending.set(event.update_id, { ...existing, status: "receipt_confirmed", receipt: event.receipt });
  return {
    revision: event.revision,
    event_digest: event.event_digest,
    status: "ready",
    active_update_id: null,
    pending,
  };
}

function storeEvent(body: JEventBody): JStoredEvent {
  return { ...body, event_digest: sha256(canonicalJson(body)) };
}

function parseStoredEvent(raw: unknown, row: SqlRow): JStoredEvent | null {
  if (!isRecord(raw)) return null;
  const eventDigest = stringValue(raw.event_digest);
  if (eventDigest === null || !/^[0-9a-f]{64}$/.test(eventDigest)) return null;
  const { event_digest: _eventDigest, ...body } = raw;
  if (sha256(canonicalJson(body)) !== eventDigest ||
      stringValue(row.event_id) !== stringValue(raw.event_id) ||
      integerValue(row.revision) !== integerValue(raw.revision) ||
      stringValue(row.previous_event_digest) !== stringValue(raw.previous_event_digest) ||
      stringValue(row.event_digest) !== eventDigest) return null;
  if (raw.schema_version !== J_EVENT_SCHEMA_VERSION || !isIdentifier(raw.event_id) ||
      !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 ||
      !isDigest(raw.previous_event_digest) && raw.previous_event_digest !== GENESIS_EVENT_DIGEST ||
      !isIdentifier(raw.update_id) || !isIsoDate(raw.occurred_at_utc)) return null;
  if (raw.event_type === "memory_commit_pending") {
    if (!hasExactKeys(raw, ["schema_version", "event_type", "event_id", "revision", "previous_event_digest", "update_id", "j_event_id", "content_digest", "expected_version", "occurred_at_utc", "event_digest"]) ||
        !isIdentifier(raw.j_event_id) || !isDigest(raw.content_digest) ||
        !Number.isSafeInteger(raw.expected_version) || (raw.expected_version as number) < 0) return null;
    return raw as unknown as JStoredEvent;
  }
  if (raw.event_type === "memory_commit_receipt_confirmed") {
    if (!hasExactKeys(raw, ["schema_version", "event_type", "event_id", "revision", "previous_event_digest", "update_id", "receipt", "occurred_at_utc", "event_digest"])) return null;
    const parsedReceipt = parseMemoryUpdateReceipt(raw.receipt);
    if (!parsedReceipt.ok || parsedReceipt.receipt.update_id !== raw.update_id) return null;
    return { ...raw, receipt: parsedReceipt.receipt } as unknown as JStoredEvent;
  }
  if (raw.event_type === "memory_commit_blocked") {
    if (!hasExactKeys(raw, ["schema_version", "event_type", "event_id", "revision", "previous_event_digest", "update_id", "reason", "occurred_at_utc", "event_digest"]) ||
        (raw.reason !== "m_receipt_mismatch" && raw.reason !== "m_update_rejected")) return null;
    return raw as unknown as JStoredEvent;
  }
  return null;
}

function receiptMatchesPending(receipt: MemoryUpdateReceiptV1, pending: JPendingSnapshot): boolean {
  const parsed = parseMemoryUpdateReceipt(receipt);
  return parsed.ok && parsed.receipt.update_id === pending.update_id &&
    parsed.receipt.content_digest === pending.content_digest &&
    parsed.receipt.previous_revision === pending.expected_version &&
    parsed.receipt.revision === pending.expected_version + 1 &&
    isDigest(parsed.receipt.event_digest);
}

function matchesApprovalReference(value: unknown, expected: JMemoryApprovalReference): boolean {
  return isRecord(value) && hasExactKeys(value, ["update_id", "j_event_id", "content_digest"]) &&
    value.update_id === expected.update_id &&
    value.j_event_id === expected.j_event_id && value.content_digest === expected.content_digest;
}

function verifyMNamespace(database: DatabaseSyncType): boolean {
  try {
    const schema = database.prepare("SELECT singleton, schema_version FROM m_schema").all();
    if (schema.length !== 1 || integerValue(schema[0]?.singleton) !== 1 || integerValue(schema[0]?.schema_version) !== 1) return false;
    const state = database.prepare("SELECT singleton, revision, event_digest FROM m_state").all();
    return state.length === 1 && integerValue(state[0]?.singleton) === 1 &&
      integerValue(state[0]?.revision) !== null && stringValue(state[0]?.event_digest) !== null;
  } catch {
    return false;
  }
}

function verifyPragmas(database: DatabaseSyncType): boolean {
  const journalMode = database.prepare("PRAGMA journal_mode").get();
  const synchronous = database.prepare("PRAGMA synchronous").get();
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get();
  const busyTimeout = database.prepare("PRAGMA busy_timeout").get();
  return stringValue(firstValue(journalMode))?.toLowerCase() === "delete" &&
    integerValue(firstValue(synchronous)) === 3 && integerValue(firstValue(foreignKeys)) === 1 &&
    integerValue(firstValue(busyTimeout)) === 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("invalid canonical JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function integerValue(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableStringValue(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function firstValue(row: SqlRow | undefined): unknown {
  return row ? Object.values(row)[0] : undefined;
}
