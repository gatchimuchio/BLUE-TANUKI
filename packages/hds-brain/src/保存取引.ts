import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  memoryCommitContentDigest,
  parseMemoryCommitV2,
  parseMemoryUpdateReceipt,
  createMemoryUpdateReceipt,
  type MemoryCommitV1,
  type MemoryCommitV2,
  type MemoryUpdateReceiptV1,
} from "@blue-tanuki/protocol";

// Vitest 2.1.9/Vite failed to resolve a static node:sqlite import (it treated
// the specifier as "sqlite"); use Node's built-in loader without a shim/backend.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const MEMORY_STORAGE_SCHEMA_VERSION = 1;
const MEMORY_EVENT_V1_SCHEMA_VERSION = "blue-tanuki.memory-event.v1" as const;
const MEMORY_EVENT_V2_SCHEMA_VERSION = "blue-tanuki.memory-event.v2" as const;
const GENESIS_EVENT_DIGEST = "GENESIS";
const SQLITE_PRIMARY_ERROR_MASK = 0xff;
const SQLITE_FULL = 13;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_IOERR_FSYNC = 1034;
const SQLITE_IOERR_DIR_FSYNC = 1290;

export interface JMemoryApprovalReference {
  readonly update_id: string;
  readonly j_event_id: string;
  readonly content_digest: string;
}

/**
 * Internal seam for a read-only J-owned approval lookup. A caller-provided
 * boolean is deliberately not accepted. This package-private implementation
 * is not wired to a production J store by C03.01.
 */
export interface JMemoryApprovalReader {
  readVerifiedMemoryApproval(reference: JMemoryApprovalReference): unknown;
}

export type PersistenceFailureReason =
  | "disk_full"
  | "write_failed"
  | "sync_failed"
  | "schema_mismatch"
  | "ledger_corrupt"
  | "projection_mismatch"
  | "store_unavailable";

export interface PersistenceHealth {
  readonly available: boolean;
  readonly failure: PersistenceFailureReason | null;
  readonly outcome_unknown: boolean;
}

export type PersistenceRecoveryResult =
  | { readonly ok: true; readonly revision: number; readonly event_count: number }
  | { readonly ok: false; readonly reason: PersistenceFailureReason; readonly outcome_unknown?: boolean };

export class PersistenceStoreError extends Error {
  constructor(
    readonly owner: "M" | "J",
    readonly reason: PersistenceFailureReason,
  ) {
    super(owner + " storage unavailable (" + reason + ")");
    this.name = "PersistenceStoreError";
  }
}

export function classifyPersistenceFailure(error: unknown): PersistenceFailureReason {
  const code = sqliteErrorCode(error);
  if (code === null) return "write_failed";
  const primaryCode = code & SQLITE_PRIMARY_ERROR_MASK;
  if (primaryCode === SQLITE_FULL) return "disk_full";
  if (code === SQLITE_IOERR_FSYNC || code === SQLITE_IOERR_DIR_FSYNC) return "sync_failed";
  if (primaryCode === SQLITE_IOERR) return "write_failed";
  if (primaryCode === SQLITE_CORRUPT || primaryCode === SQLITE_NOTADB) return "ledger_corrupt";
  return "write_failed";
}

export function sqliteErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = error as Record<string, unknown>;
  return typeof value.errcode === "number"
    ? value.errcode
    : typeof value.code === "number"
      ? value.code
      : null;
}

export type MemoryUpdateFailureReason =
  | "schema_validation_failed"
  | "j_approval_not_verified"
  | "update_id_content_conflict"
  | "expected_version_conflict"
  | "store_integrity_failed"
  | "storage_failed"
  | "commit_outcome_unknown"
  | "store_unavailable"
  | "disk_full"
  | "write_failed"
  | "sync_failed"
  | "schema_mismatch"
  | "ledger_corrupt"
  | "projection_mismatch";

export type MemoryUpdateResult =
  | { readonly ok: true; readonly receipt: MemoryUpdateReceiptV1 }
  | { readonly ok: false; readonly reason: MemoryUpdateFailureReason; readonly outcome_unknown?: boolean };

export interface MemoryStoreSnapshot {
  readonly revision: number;
  readonly event_digest: string;
  readonly records: Readonly<Record<string, unknown>>;
  readonly used_for_authority: false;
}

interface MemoryEventFields {
  readonly event_id: string;
  readonly revision: number;
  readonly previous_event_digest: string;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly content_digest: string;
  readonly changes: MemoryCommitV1["changes"];
  readonly committed_at_utc: string;
}

interface MemoryEventV1 extends MemoryEventFields {
  readonly schema_version: typeof MEMORY_EVENT_V1_SCHEMA_VERSION;
}

interface MemoryEventV2 extends MemoryEventFields {
  readonly schema_version: typeof MEMORY_EVENT_V2_SCHEMA_VERSION;
  readonly expected_version: number;
}

type MemoryEventBody = MemoryEventV1 | MemoryEventV2;

type StoredMemoryEvent = MemoryEventBody & {
  readonly event_digest: string;
};

interface SqlRow {
  readonly [key: string]: unknown;
}

/**
 * M-owned SQLite transaction boundary. This module stays out of the HDS
 * package barrel until a later unit connects and verifies a real J consumer.
 */
export class MTransactionStore {
  private readonly database!: DatabaseSyncType;
  private unavailable = false;
  private failureReason: PersistenceFailureReason | null = null;
  private outcomeUnknown = false;
  private closed = false;
  private readonly now: () => Date;

  constructor(options: {
    readonly private_state_root: string;
    readonly database_path: string;
    readonly now?: () => Date;
  }) {
    let databasePath: string;
    try {
      databasePath = resolvePrivateStateDatabasePath(options.private_state_root, options.database_path);
    } catch {
      throw new Error("invalid M database path");
    }
    const existedWithContents = existsSync(databasePath) && statSync(databasePath).size > 0;
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
      if (!verifyPragmas(database)) throw new PersistenceStoreError("M", "schema_mismatch");
      this.database = database;
      initializeMStorageSchema(database, existedWithContents);
      const inspection = inspectMDatabase(database);
      if (!inspection.ok) throw new PersistenceStoreError("M", inspection.reason);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Keep initialization errors generic and do not echo paths or data.
      }
      if (error instanceof PersistenceStoreError) throw error;
      throw new PersistenceStoreError("M", classifyPersistenceFailure(error));
    }
  }

  applyApprovedMemoryCommit(input: unknown, jApproval: JMemoryApprovalReader): MemoryUpdateResult {
    if (this.closed || this.unavailable) return { ok: false, reason: "store_unavailable" };
    const parsed = parseMemoryCommitV2(input);
    if (!parsed.ok) return { ok: false, reason: "schema_validation_failed" };

    let transactionStarted = false;
    let commitAttempted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const inspection = inspectMDatabase(this.database);
      if (!inspection.ok) {
        this.rollbackAndStop(inspection.reason);
        return { ok: false, reason: this.failureReason ?? inspection.reason };
      }
      const approvalReference: JMemoryApprovalReference = Object.freeze({
        update_id: parsed.commit.update_id,
        j_event_id: parsed.commit.j_event_id,
        content_digest: parsed.content_digest,
      });
      let approval: unknown;
      try {
        approval = jApproval.readVerifiedMemoryApproval(approvalReference);
      } catch {
        approval = null;
      }
      if (!matchesApprovalReference(approval, approvalReference)) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: false, reason: "j_approval_not_verified" };
      }

      const consumed = this.database.prepare(
        "SELECT content_digest FROM m_updates WHERE update_id = ?",
      ).get(parsed.commit.update_id);
      if (consumed) {
        const consumedDigest = stringValue(consumed.content_digest);
        if (consumedDigest !== parsed.content_digest) {
          this.database.exec("ROLLBACK");
          transactionStarted = false;
          return { ok: false, reason: "update_id_content_conflict" };
        }
        const receiptRow = this.database.prepare(
          "SELECT receipt_json FROM m_receipts WHERE update_id = ?",
        ).get(parsed.commit.update_id);
        const receiptJson = stringValue(receiptRow?.receipt_json);
        let savedReceipt: ReturnType<typeof parseMemoryUpdateReceipt>;
        try {
          savedReceipt = receiptJson === null
            ? { ok: false, reason: "schema_validation_failed" }
            : parseMemoryUpdateReceipt(JSON.parse(receiptJson) as unknown);
        } catch {
          savedReceipt = { ok: false, reason: "schema_validation_failed" };
        }
        if (!savedReceipt.ok || savedReceipt.receipt.update_id !== parsed.commit.update_id ||
            savedReceipt.receipt.content_digest !== parsed.content_digest) {
          this.rollbackAndStop("projection_mismatch");
          transactionStarted = false;
          return { ok: false, reason: this.failureReason ?? "projection_mismatch" };
        }
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: true, receipt: savedReceipt.receipt };
      }

      const state = this.database.prepare(
        "SELECT revision, event_digest FROM m_state WHERE singleton = 1",
      ).get();
      const previousRevision = integerValue(state?.revision);
      const previousEventDigest = stringValue(state?.event_digest);
      if (previousRevision === null || previousEventDigest === null || previousRevision >= Number.MAX_SAFE_INTEGER) {
        this.rollbackAndStop("projection_mismatch");
        transactionStarted = false;
        return { ok: false, reason: this.failureReason ?? "projection_mismatch" };
      }
      if (parsed.commit.expected_version !== previousRevision) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: false, reason: "expected_version_conflict" };
      }

      const committedAt = this.now().toISOString();
      const eventBody: MemoryEventV2 = {
        schema_version: MEMORY_EVENT_V2_SCHEMA_VERSION,
        expected_version: parsed.commit.expected_version,
        event_id: `m-event:${randomUUID()}`,
        revision: previousRevision + 1,
        previous_event_digest: previousEventDigest,
        update_id: parsed.commit.update_id,
        j_event_id: parsed.commit.j_event_id,
        content_digest: parsed.content_digest,
        changes: parsed.commit.changes,
        committed_at_utc: committedAt,
      };
      const eventDigest = sha256(canonicalJson(eventBody));
      const storedEvent: StoredMemoryEvent = { ...eventBody, event_digest: eventDigest };
      const receipt = createMemoryUpdateReceipt({
        schema_version: "blue-tanuki.memory-update-receipt.v1",
        update_id: parsed.commit.update_id,
        event_id: eventBody.event_id,
        previous_revision: previousRevision,
        revision: eventBody.revision,
        content_digest: parsed.content_digest,
        event_digest: eventDigest,
        committed_at_utc: committedAt,
      });

      this.database.prepare(
        "INSERT INTO m_events (event_id, revision, previous_event_digest, event_digest, event_payload_json) VALUES (?, ?, ?, ?, ?)",
      ).run(eventBody.event_id, eventBody.revision, previousEventDigest, eventDigest, canonicalJson(storedEvent));

      const upsert = this.database.prepare(
        "INSERT INTO m_records (record_id, value_json) VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET value_json = excluded.value_json",
      );
      const deleteRecord = this.database.prepare("DELETE FROM m_records WHERE record_id = ?");
      for (const change of parsed.commit.changes) {
        if (change.operation === "upsert") {
          upsert.run(change.record_id, canonicalJson(change.value));
        } else {
          deleteRecord.run(change.record_id);
        }
      }

      this.database.prepare(
        "UPDATE m_state SET revision = ?, event_digest = ? WHERE singleton = 1",
      ).run(eventBody.revision, eventDigest);
      this.database.prepare(
        "INSERT INTO m_updates (update_id, content_digest, revision, event_id) VALUES (?, ?, ?, ?)",
      ).run(parsed.commit.update_id, parsed.content_digest, eventBody.revision, eventBody.event_id);
      this.database.prepare(
        "INSERT INTO m_receipts (update_id, receipt_json) VALUES (?, ?)",
      ).run(parsed.commit.update_id, canonicalJson(receipt));

      commitAttempted = true;
      this.database.exec("COMMIT");
      transactionStarted = false;
      return { ok: true, receipt };
    } catch (error) {
      const failure = classifyPersistenceFailure(error);
      if (commitAttempted) {
        this.stop(failure, true);
        return { ok: false, reason: "commit_outcome_unknown", outcome_unknown: true };
      }
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
          transactionStarted = false;
        } catch {
          this.stop(failure, true);
          return { ok: false, reason: "commit_outcome_unknown", outcome_unknown: true };
        }
      }
      this.stop(failure);
      return { ok: false, reason: failure };
    }
  }

  readSnapshot(): MemoryStoreSnapshot | null {
    if (this.closed || this.unavailable) return null;
    try {
      const inspection = inspectMDatabase(this.database);
      if (!inspection.ok) {
        this.stop(inspection.reason);
        return null;
      }
      const state = this.database.prepare(
        "SELECT revision, event_digest FROM m_state WHERE singleton = 1",
      ).get();
      const revision = integerValue(state?.revision);
      const eventDigest = stringValue(state?.event_digest);
      if (revision === null || eventDigest === null) return null;
      const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const rows = this.database.prepare("SELECT record_id, value_json FROM m_records ORDER BY record_id").all();
      for (const row of rows) {
        const id = stringValue(row.record_id);
        const valueJson = stringValue(row.value_json);
        if (id === null || valueJson === null) return null;
        Object.defineProperty(records, id, {
          value: JSON.parse(valueJson) as unknown,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze({
        revision,
        event_digest: eventDigest,
        records: Object.freeze(records),
        used_for_authority: false,
      });
    } catch (error) {
      this.stop(classifyPersistenceFailure(error));
      return null;
    }
  }

  readReceipt(updateId: string): MemoryUpdateReceiptV1 | null {
    if (this.closed || this.unavailable) return null;
    try {
      const inspection = inspectMDatabase(this.database);
      if (!inspection.ok) {
        this.stop(inspection.reason);
        return null;
      }
      const row = this.database.prepare(
        "SELECT receipt_json FROM m_receipts WHERE update_id = ?",
      ).get(updateId);
      const receiptJson = stringValue(row?.receipt_json);
      if (receiptJson === null) return null;
      const parsed = parseMemoryUpdateReceipt(JSON.parse(receiptJson) as unknown);
      return parsed.ok ? parsed.receipt : null;
    } catch (error) {
      this.stop(classifyPersistenceFailure(error));
      return null;
    }
  }

  verify(): boolean {
    if (this.closed || this.unavailable) return false;
    try {
      if (!verifyPragmas(this.database)) {
        this.stop("schema_mismatch");
        return false;
      }
      const inspection = inspectMDatabase(this.database);
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

export function resolvePrivateStateDatabasePath(stateRootInput: string, databasePathInput: string): string {
  if (!isAbsolute(stateRootInput) || !isAbsolute(databasePathInput) || databasePathInput === ":memory:") {
    throw new Error("path must be absolute");
  }
  const stateRoot = realpathSync(resolve(stateRootInput));
  if (!statSync(stateRoot).isDirectory()) throw new Error("state root must be a directory");
  const resolvedInput = resolve(databasePathInput);
  const databasePath = existsSync(resolvedInput)
    ? realpathSync(resolvedInput)
    : joinPath(realpathSync(dirname(resolvedInput)), basename(resolvedInput));
  const relativePath = relative(stateRoot, databasePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("database must remain inside private state root");
  }
  return databasePath;
}

function joinPath(parent: string, child: string): string {
  return `${parent}${sep}${child}`;
}

function verifyPragmas(database: DatabaseSyncType): boolean {
  const journalMode = database.prepare("PRAGMA journal_mode").get();
  const synchronous = database.prepare("PRAGMA synchronous").get();
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get();
  const busyTimeout = database.prepare("PRAGMA busy_timeout").get();
  return stringValue(firstValue(journalMode))?.toLowerCase() === "delete" &&
    integerValue(firstValue(synchronous)) === 3 &&
    integerValue(firstValue(foreignKeys)) === 1 &&
    integerValue(firstValue(busyTimeout)) === 0;
}

const M_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  m_schema: ["singleton", "schema_version"],
  m_events: ["event_id", "revision", "previous_event_digest", "event_digest", "event_payload_json"],
  m_state: ["singleton", "revision", "event_digest"],
  m_records: ["record_id", "value_json"],
  m_updates: ["update_id", "content_digest", "revision", "event_id"],
  m_receipts: ["update_id", "receipt_json"],
});

function initializeMStorageSchema(database: DatabaseSyncType, existedWithContents: boolean): void {
  const existingMTables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'm_*' ORDER BY name",
  ).all().map((row) => stringValue(row.name)).filter((name): name is string => name !== null);
  if (existingMTables.length > 0) {
    if (!verifyMTableSchema(database)) throw new PersistenceStoreError("M", "schema_mismatch");
    return;
  }
  const allTables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  if (existedWithContents || allTables.length > 0) {
    throw new PersistenceStoreError("M", "schema_mismatch");
  }

  database.exec("BEGIN EXCLUSIVE");
  try {
    database.exec("CREATE TABLE m_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)");
    database.exec("CREATE TABLE m_events (event_id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE CHECK (revision > 0), previous_event_digest TEXT NOT NULL, event_digest TEXT NOT NULL CHECK (length(event_digest) = 64), event_payload_json TEXT NOT NULL)");
    database.exec("CREATE TABLE m_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision >= 0), event_digest TEXT NOT NULL)");
    database.exec("CREATE TABLE m_records (record_id TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
    database.exec("CREATE TABLE m_updates (update_id TEXT PRIMARY KEY, content_digest TEXT NOT NULL CHECK (length(content_digest) = 64), revision INTEGER NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE REFERENCES m_events(event_id))");
    database.exec("CREATE TABLE m_receipts (update_id TEXT PRIMARY KEY REFERENCES m_updates(update_id), receipt_json TEXT NOT NULL)");
    database.prepare("INSERT INTO m_schema (singleton, schema_version) VALUES (1, ?)").run(MEMORY_STORAGE_SCHEMA_VERSION);
    database.prepare("INSERT INTO m_state (singleton, revision, event_digest) VALUES (1, 0, ?)").run(GENESIS_EVENT_DIGEST);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Initialization is abandoned and the connection is closed by caller.
    }
    throw new PersistenceStoreError("M", classifyPersistenceFailure(error));
  }
}

interface MCanonicalProjection {
  readonly events: readonly StoredMemoryEvent[];
  readonly records: ReadonlyMap<string, string>;
  readonly revision: number;
  readonly event_digest: string;
}

type MDatabaseInspection =
  | { readonly ok: true; readonly canonical: MCanonicalProjection }
  | { readonly ok: false; readonly reason: PersistenceFailureReason };

function verifyMTableSchema(database: DatabaseSyncType): boolean {
  const actualTables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'm_*' ORDER BY name",
  ).all().map((row) => stringValue(row.name)).filter((name): name is string => name !== null);
  const expectedTables = Object.keys(M_TABLE_COLUMNS).sort();
  if (actualTables.length !== expectedTables.length ||
      actualTables.some((name, index) => name !== expectedTables[index])) return false;
  for (const tableName of expectedTables) {
    const columns = database.prepare("PRAGMA table_info(" + tableName + ")").all()
      .map((row) => stringValue(row.name));
    const expected = M_TABLE_COLUMNS[tableName];
    if (!expected || columns.length !== expected.length ||
        columns.some((name, index) => name !== expected[index])) return false;
  }
  const schemaRows = database.prepare("SELECT singleton, schema_version FROM m_schema").all();
  return schemaRows.length === 1 && integerValue(schemaRows[0]?.singleton) === 1 &&
    integerValue(schemaRows[0]?.schema_version) === MEMORY_STORAGE_SCHEMA_VERSION;
}

function verifyNoMRecoveryTriggers(database: DatabaseSyncType): boolean {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name GLOB 'm_*'",
  ).all().length === 0;
}

function replayMCanonicalLedger(database: DatabaseSyncType): MCanonicalProjection | null {
  try {
    const eventRows = database.prepare(
      "SELECT event_id, revision, previous_event_digest, event_digest, event_payload_json FROM m_events ORDER BY revision",
    ).all();
    let revision = 0;
    let priorDigest = GENESIS_EVENT_DIGEST;
    const events: StoredMemoryEvent[] = [];
    const records = new Map<string, string>();
    const seenUpdateIds = new Set<string>();
    for (const eventRow of eventRows) {
      const eventJson = stringValue(eventRow.event_payload_json);
      if (eventJson === null) return null;
      const eventValue = JSON.parse(eventJson) as unknown;
      if (!isRecord(eventValue)) return null;
      const event = eventValue as Record<string, unknown>;
      const isLegacyEvent = event.schema_version === MEMORY_EVENT_V1_SCHEMA_VERSION;
      const isCurrentEvent = event.schema_version === MEMORY_EVENT_V2_SCHEMA_VERSION;
      const expectedEventKeys = isLegacyEvent
        ? ["schema_version", "event_id", "revision", "previous_event_digest", "update_id", "j_event_id", "content_digest", "changes", "committed_at_utc", "event_digest"]
        : ["schema_version", "expected_version", "event_id", "revision", "previous_event_digest", "update_id", "j_event_id", "content_digest", "changes", "committed_at_utc", "event_digest"];
      if ((!isLegacyEvent && !isCurrentEvent) || Object.keys(event).length !== expectedEventKeys.length ||
          expectedEventKeys.some((key) => !Object.hasOwn(event, key)) ||
          typeof event.event_id !== "string" || event.event_id !== eventRow.event_id ||
          typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) ||
          event.revision !== revision + 1 || event.revision !== eventRow.revision ||
          typeof event.previous_event_digest !== "string" || event.previous_event_digest !== priorDigest ||
          event.previous_event_digest !== eventRow.previous_event_digest ||
          typeof event.event_digest !== "string" || event.event_digest !== eventRow.event_digest ||
          !/^[a-f0-9]{64}$/.test(event.event_digest) ||
          typeof event.update_id !== "string" || !isIdentifier(event.update_id) ||
          typeof event.j_event_id !== "string" || !isIdentifier(event.j_event_id) ||
          typeof event.content_digest !== "string" || !/^[a-f0-9]{64}$/.test(event.content_digest) ||
          typeof event.committed_at_utc !== "string" || !Array.isArray(event.changes)) return null;
      if (isCurrentEvent && (typeof event.expected_version !== "number" ||
          !Number.isSafeInteger(event.expected_version) || event.expected_version !== event.revision - 1)) return null;
      if (seenUpdateIds.has(event.update_id) || canonicalJson(eventValue) !== eventJson) return null;
      seenUpdateIds.add(event.update_id);
      const content = isCurrentEvent
        ? {
            schema_version: "blue-tanuki.memory-commit.v2" as const,
            expected_version: event.expected_version as number,
            update_id: event.update_id,
            j_event_id: event.j_event_id,
            changes: event.changes as MemoryCommitV2["changes"],
          }
        : {
            schema_version: "blue-tanuki.memory-commit.v1" as const,
            update_id: event.update_id,
            j_event_id: event.j_event_id,
            changes: event.changes as MemoryCommitV1["changes"],
          };
      if (memoryCommitContentDigest(content) !== event.content_digest) return null;
      const { event_digest: _eventDigest, ...eventBody } = event as unknown as StoredMemoryEvent;
      if (sha256(canonicalJson(eventBody)) !== event.event_digest) return null;
      for (const change of event.changes) {
        if (!isRecord(change) || typeof change.record_id !== "string" || !isIdentifier(change.record_id)) return null;
        if (change.operation === "upsert") {
          if (!("value" in change)) return null;
          records.set(change.record_id, canonicalJson(change.value));
        } else if (change.operation === "delete") {
          if (Object.keys(change).length !== 2 || !Object.hasOwn(change, "operation")) return null;
          records.delete(change.record_id);
        } else {
          return null;
        }
      }
      events.push(event as unknown as StoredMemoryEvent);
      revision = event.revision;
      priorDigest = event.event_digest;
    }
    return { events, records, revision, event_digest: priorDigest };
  } catch (error) {
    if (sqliteErrorCode(error) !== null) throw error;
    return null;
  }
}

function expectedMReceipt(event: StoredMemoryEvent): MemoryUpdateReceiptV1 {
  return createMemoryUpdateReceipt({
    schema_version: "blue-tanuki.memory-update-receipt.v1",
    update_id: event.update_id,
    event_id: event.event_id,
    previous_revision: event.revision - 1,
    revision: event.revision,
    content_digest: event.content_digest,
    event_digest: event.event_digest,
    committed_at_utc: event.committed_at_utc,
  });
}

function verifyMDerivedProjection(database: DatabaseSyncType, canonical: MCanonicalProjection): boolean {
  const stateRows = database.prepare("SELECT singleton, revision, event_digest FROM m_state").all();
  if (stateRows.length !== 1 || integerValue(stateRows[0]?.singleton) !== 1 ||
      integerValue(stateRows[0]?.revision) !== canonical.revision ||
      stringValue(stateRows[0]?.event_digest) !== canonical.event_digest) return false;
  const updateRows = database.prepare(
    "SELECT update_id, content_digest, revision, event_id FROM m_updates ORDER BY revision",
  ).all();
  const receiptRows = database.prepare("SELECT update_id, receipt_json FROM m_receipts").all();
  if (updateRows.length !== canonical.events.length || receiptRows.length !== canonical.events.length) return false;
  const receiptsById = new Map<string, string>();
  for (const row of receiptRows) {
    const id = stringValue(row.update_id);
    const receipt = stringValue(row.receipt_json);
    if (id === null || receipt === null || receiptsById.has(id)) return false;
    receiptsById.set(id, receipt);
  }
  for (const [index, event] of canonical.events.entries()) {
    const update = updateRows[index];
    if (!update || stringValue(update.update_id) !== event.update_id ||
        stringValue(update.content_digest) !== event.content_digest ||
        integerValue(update.revision) !== event.revision ||
        stringValue(update.event_id) !== event.event_id) return false;
    const receiptJson = receiptsById.get(event.update_id);
    if (receiptJson === undefined) return false;
    try {
      const parsed = parseMemoryUpdateReceipt(JSON.parse(receiptJson) as unknown);
      if (!parsed.ok || canonicalJson(parsed.receipt) !== receiptJson ||
          canonicalJson(parsed.receipt) !== canonicalJson(expectedMReceipt(event))) return false;
    } catch {
      return false;
    }
  }

  const recordRows = database.prepare("SELECT record_id, value_json FROM m_records ORDER BY record_id").all();
  if (recordRows.length !== canonical.records.size) return false;
  for (const row of recordRows) {
    const id = stringValue(row.record_id);
    const valueJson = stringValue(row.value_json);
    if (id === null || valueJson === null || canonical.records.get(id) !== valueJson) return false;
    try {
      if (canonicalJson(JSON.parse(valueJson) as unknown) !== valueJson) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function inspectMDatabase(database: DatabaseSyncType): MDatabaseInspection {
  try {
    if (!verifyMTableSchema(database)) return { ok: false, reason: "schema_mismatch" };
    const canonical = replayMCanonicalLedger(database);
    if (!canonical) return { ok: false, reason: "ledger_corrupt" };
    if (!verifyMDerivedProjection(database, canonical)) return { ok: false, reason: "projection_mismatch" };
    return { ok: true, canonical };
  } catch (error) {
    const reason = classifyPersistenceFailure(error);
    return {
      ok: false,
      reason: sqliteErrorCode(error) !== null && reason === "write_failed" ? "store_unavailable" : reason,
    };
  }
}

function openRecoveryDatabase(options: {
  readonly private_state_root: string;
  readonly database_path: string;
}): DatabaseSyncType {
  let databasePath: string;
  try {
    databasePath = resolvePrivateStateDatabasePath(options.private_state_root, options.database_path);
  } catch {
    throw new PersistenceStoreError("M", "store_unavailable");
  }
  let databaseExists = false;
  try {
    databaseExists = existsSync(databasePath) && statSync(databasePath).size > 0;
  } catch {
    throw new PersistenceStoreError("M", "store_unavailable");
  }
  if (!databaseExists) {
    throw new PersistenceStoreError("M", "store_unavailable");
  }
  let database: DatabaseSyncType;
  try {
    database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
  } catch (error) {
    const reason = sqliteErrorCode(error) === null ? "store_unavailable" : classifyPersistenceFailure(error);
    throw new PersistenceStoreError("M", reason);
  }
  try {
    database.enableLoadExtension(false);
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA synchronous = EXTRA");
    database.exec("PRAGMA foreign_keys = ON");
    if (!verifyPragmas(database)) throw new PersistenceStoreError("M", "schema_mismatch");
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Keep the recovery error bounded to a safe category.
    }
    if (error instanceof PersistenceStoreError) throw error;
    throw new PersistenceStoreError("M", classifyPersistenceFailure(error));
  }
}

export function rebuildMemoryDerivedProjection(options: {
  readonly private_state_root: string;
  readonly database_path: string;
}): PersistenceRecoveryResult {
  let database: DatabaseSyncType | undefined;
  let transactionStarted = false;
  let commitAttempted = false;
  try {
    database = openRecoveryDatabase(options);
    if (!verifyMTableSchema(database) || !verifyNoMRecoveryTriggers(database)) {
      return { ok: false, reason: "schema_mismatch" };
    }
    if (!replayMCanonicalLedger(database)) return { ok: false, reason: "ledger_corrupt" };

    database.exec("BEGIN EXCLUSIVE");
    transactionStarted = true;
    if (!verifyMTableSchema(database) || !verifyNoMRecoveryTriggers(database)) {
      database.exec("ROLLBACK");
      transactionStarted = false;
      return { ok: false, reason: "schema_mismatch" };
    }
    const canonical = replayMCanonicalLedger(database);
    if (!canonical) {
      database.exec("ROLLBACK");
      transactionStarted = false;
      return { ok: false, reason: "ledger_corrupt" };
    }

    database.exec("DELETE FROM m_receipts");
    database.exec("DELETE FROM m_updates");
    database.exec("DELETE FROM m_records");
    database.exec("DELETE FROM m_state");
    const insertRecord = database.prepare("INSERT INTO m_records (record_id, value_json) VALUES (?, ?)");
    for (const [recordId, valueJson] of canonical.records) insertRecord.run(recordId, valueJson);
    const insertUpdate = database.prepare(
      "INSERT INTO m_updates (update_id, content_digest, revision, event_id) VALUES (?, ?, ?, ?)",
    );
    const insertReceipt = database.prepare("INSERT INTO m_receipts (update_id, receipt_json) VALUES (?, ?)");
    for (const event of canonical.events) {
      insertUpdate.run(event.update_id, event.content_digest, event.revision, event.event_id);
      insertReceipt.run(event.update_id, canonicalJson(expectedMReceipt(event)));
    }
    database.prepare("INSERT INTO m_state (singleton, revision, event_digest) VALUES (1, ?, ?)")
      .run(canonical.revision, canonical.event_digest);
    if (!verifyMDerivedProjection(database, canonical)) {
      database.exec("ROLLBACK");
      transactionStarted = false;
      return { ok: false, reason: "projection_mismatch" };
    }

    commitAttempted = true;
    database.exec("COMMIT");
    transactionStarted = false;
    const afterCommit = inspectMDatabase(database);
    if (!afterCommit.ok) return { ok: false, reason: afterCommit.reason };
    return { ok: true, revision: canonical.revision, event_count: canonical.events.length };
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

function matchesApprovalReference(value: unknown, expected: JMemoryApprovalReference): boolean {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== 3) return false;
  const updateId = Object.getOwnPropertyDescriptor(value, "update_id");
  const jEventId = Object.getOwnPropertyDescriptor(value, "j_event_id");
  const contentDigest = Object.getOwnPropertyDescriptor(value, "content_digest");
  return !!updateId && "value" in updateId && updateId.value === expected.update_id &&
    !!jEventId && "value" in jEventId && jEventId.value === expected.j_event_id &&
    !!contentDigest && "value" in contentDigest && contentDigest.value === expected.content_digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstValue(row: SqlRow | undefined): unknown {
  if (!row) return undefined;
  const key = Object.keys(row)[0];
  return key === undefined ? undefined : row[key];
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("invalid canonical value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
