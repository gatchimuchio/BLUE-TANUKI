import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  memoryCommitContentDigest,
  parseMemoryCommit,
  parseMemoryUpdateReceipt,
  createMemoryUpdateReceipt,
  type MemoryCommitV1,
  type MemoryUpdateReceiptV1,
} from "@blue-tanuki/protocol";

// Vitest 2.1.9/Vite failed to resolve a static node:sqlite import (it treated
// the specifier as "sqlite"); use Node's built-in loader without a shim/backend.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const MEMORY_STORAGE_SCHEMA_VERSION = 1;
const MEMORY_EVENT_SCHEMA_VERSION = "blue-tanuki.memory-event.v1";
const GENESIS_EVENT_DIGEST = "GENESIS";

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

export type MemoryUpdateFailureReason =
  | "schema_validation_failed"
  | "j_approval_not_verified"
  | "update_id_already_consumed"
  | "store_integrity_failed"
  | "storage_failed"
  | "commit_outcome_unknown"
  | "store_unavailable";

export type MemoryUpdateResult =
  | { readonly ok: true; readonly receipt: MemoryUpdateReceiptV1 }
  | { readonly ok: false; readonly reason: MemoryUpdateFailureReason };

export interface MemoryStoreSnapshot {
  readonly revision: number;
  readonly event_digest: string;
  readonly records: Readonly<Record<string, unknown>>;
  readonly used_for_authority: false;
}

interface MemoryEventBody {
  readonly schema_version: typeof MEMORY_EVENT_SCHEMA_VERSION;
  readonly event_id: string;
  readonly revision: number;
  readonly previous_event_digest: string;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly content_digest: string;
  readonly changes: MemoryCommitV1["changes"];
  readonly committed_at_utc: string;
}

interface StoredMemoryEvent extends MemoryEventBody {
  readonly event_digest: string;
}

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
  private closed = false;
  private readonly now: () => Date;

  constructor(options: {
    readonly private_state_root: string;
    readonly database_path: string;
    readonly now?: () => Date;
  }) {
    let databasePath: string;
    try {
      databasePath = privateDatabasePath(options.private_state_root, options.database_path);
    } catch {
      throw new Error("invalid M database path");
    }
    const existed = existsSync(databasePath);
    if (existed && statSync(databasePath).size > 0 && !hasMStorageSchema(databasePath)) {
      throw new Error("incompatible M database");
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
      if (!verifyPragmas(database)) throw new Error("unsupported M database settings");
      this.database = database;
      initializeMStorageSchema(database);
      if (!verifyDatabase(database)) {
        throw new Error("invalid M database state");
      }
    } catch {
      try {
        database?.close();
      } catch {
        // Keep initialization errors generic and do not echo paths or data.
      }
      throw new Error("M database initialization failed");
    }
  }

  applyApprovedMemoryCommit(input: unknown, jApproval: JMemoryApprovalReader): MemoryUpdateResult {
    if (this.closed || this.unavailable) return { ok: false, reason: "store_unavailable" };
    const parsed = parseMemoryCommit(input);
    if (!parsed.ok) return { ok: false, reason: "schema_validation_failed" };

    let transactionStarted = false;
    let commitAttempted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      if (!verifyDatabase(this.database)) {
        this.rollbackOrPoison();
        return { ok: false, reason: this.unavailable ? "commit_outcome_unknown" : "store_integrity_failed" };
      }
      if (this.database.prepare("SELECT 1 AS present FROM m_updates WHERE update_id = ?").get(parsed.commit.update_id)) {
        this.database.exec("ROLLBACK");
        transactionStarted = false;
        return { ok: false, reason: "update_id_already_consumed" };
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

      const state = this.database.prepare(
        "SELECT revision, event_digest FROM m_state WHERE singleton = 1",
      ).get();
      const previousRevision = integerValue(state?.revision);
      const previousEventDigest = stringValue(state?.event_digest);
      if (previousRevision === null || previousEventDigest === null || previousRevision >= Number.MAX_SAFE_INTEGER) {
        this.rollbackOrPoison();
        return { ok: false, reason: this.unavailable ? "commit_outcome_unknown" : "store_integrity_failed" };
      }

      const committedAt = this.now().toISOString();
      const eventBody: MemoryEventBody = {
        schema_version: MEMORY_EVENT_SCHEMA_VERSION,
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
    } catch {
      if (commitAttempted) {
        this.unavailable = true;
        return { ok: false, reason: "commit_outcome_unknown" };
      }
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
          transactionStarted = false;
        } catch {
          this.unavailable = true;
          return { ok: false, reason: "commit_outcome_unknown" };
        }
      }
      return { ok: false, reason: "storage_failed" };
    }
  }

  readSnapshot(): MemoryStoreSnapshot | null {
    if (this.closed || this.unavailable) return null;
    try {
      if (!verifyDatabase(this.database)) return null;
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
    } catch {
      return null;
    }
  }

  readReceipt(updateId: string): MemoryUpdateReceiptV1 | null {
    if (this.closed || this.unavailable) return null;
    try {
      if (!verifyDatabase(this.database)) return null;
      const row = this.database.prepare(
        "SELECT receipt_json FROM m_receipts WHERE update_id = ?",
      ).get(updateId);
      const receiptJson = stringValue(row?.receipt_json);
      if (receiptJson === null) return null;
      const parsed = parseMemoryUpdateReceipt(JSON.parse(receiptJson) as unknown);
      return parsed.ok ? parsed.receipt : null;
    } catch {
      return null;
    }
  }

  verify(): boolean {
    if (this.closed || this.unavailable) return false;
    try {
      return verifyPragmas(this.database) && verifyDatabase(this.database);
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private rollbackOrPoison(): void {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      this.unavailable = true;
    }
  }
}

function hasMStorageSchema(databasePath: string): boolean {
  let database: DatabaseSyncType | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'm_schema'",
    ).get();
    return row !== undefined;
  } catch {
    return false;
  } finally {
    try {
      database?.close();
    } catch {
      // A failed read-only preflight remains a generic incompatibility.
    }
  }
}

function privateDatabasePath(stateRootInput: string, databasePathInput: string): string {
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

function initializeMStorageSchema(database: DatabaseSyncType): void {
  const existingSchemaTable = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'm_schema'",
  ).get();
  if (existingSchemaTable) {
    const existingSchema = database.prepare(
      "SELECT schema_version FROM m_schema WHERE singleton = 1",
    ).get();
    if (!existingSchema || integerValue(existingSchema.schema_version) !== MEMORY_STORAGE_SCHEMA_VERSION) {
      throw new Error("unsupported M schema");
    }
    return;
  }

  database.exec("BEGIN EXCLUSIVE");
  try {
    database.exec(`
      CREATE TABLE m_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE m_events (
        event_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
        previous_event_digest TEXT NOT NULL,
        event_digest TEXT NOT NULL CHECK (length(event_digest) = 64),
        event_payload_json TEXT NOT NULL
      );
      CREATE TABLE m_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        event_digest TEXT NOT NULL
      );
      CREATE TABLE m_records (
        record_id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE m_updates (
        update_id TEXT PRIMARY KEY,
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        revision INTEGER NOT NULL UNIQUE,
        event_id TEXT NOT NULL UNIQUE REFERENCES m_events(event_id)
      );
      CREATE TABLE m_receipts (
        update_id TEXT PRIMARY KEY REFERENCES m_updates(update_id),
        receipt_json TEXT NOT NULL
      );
      INSERT INTO m_schema (singleton, schema_version) VALUES (1, ${MEMORY_STORAGE_SCHEMA_VERSION});
      INSERT INTO m_state (singleton, revision, event_digest) VALUES (1, 0, '${GENESIS_EVENT_DIGEST}');
    `);
    database.exec("COMMIT");
  } catch {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Initialization is abandoned and the connection is closed by caller.
    }
    throw new Error("M schema creation failed");
  }
}

function verifyDatabase(database: DatabaseSyncType): boolean {
  const schemaRows = database.prepare("SELECT singleton, schema_version FROM m_schema").all();
  if (schemaRows.length !== 1 || integerValue(schemaRows[0]?.singleton) !== 1 ||
      integerValue(schemaRows[0]?.schema_version) !== MEMORY_STORAGE_SCHEMA_VERSION) return false;

  const stateRows = database.prepare("SELECT singleton, revision, event_digest FROM m_state").all();
  if (stateRows.length !== 1 || integerValue(stateRows[0]?.singleton) !== 1) return false;
  const stateRevision = integerValue(stateRows[0]?.revision);
  const stateEventDigest = stringValue(stateRows[0]?.event_digest);
  if (stateRevision === null || stateEventDigest === null) return false;

  const events = database.prepare(
    "SELECT event_id, revision, previous_event_digest, event_digest, event_payload_json FROM m_events ORDER BY revision",
  ).all();
  const updates = database.prepare(
    "SELECT update_id, content_digest, revision, event_id FROM m_updates ORDER BY revision",
  ).all();
  const receipts = database.prepare(
    "SELECT r.update_id, r.receipt_json FROM m_receipts r JOIN m_updates u USING (update_id) ORDER BY u.revision",
  ).all();
  if (events.length !== updates.length || events.length !== receipts.length || events.length !== stateRevision) return false;

  let revision = 0;
  let priorDigest = GENESIS_EVENT_DIGEST;
  const replay = new Map<string, string>();
  const seenUpdateIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const eventRow = events[index];
    const updateRow = updates[index];
    if (!eventRow || !updateRow) return false;
    const eventJson = stringValue(eventRow.event_payload_json);
    if (eventJson === null) return false;
    let eventValue: unknown;
    try {
      eventValue = JSON.parse(eventJson) as unknown;
    } catch {
      return false;
    }
    if (!isRecord(eventValue)) return false;
    const event = eventValue as Partial<StoredMemoryEvent>;
    if (event.schema_version !== MEMORY_EVENT_SCHEMA_VERSION ||
        typeof event.event_id !== "string" || event.event_id !== eventRow.event_id ||
        typeof event.revision !== "number" || event.revision !== revision + 1 ||
        event.revision !== eventRow.revision || event.revision !== updateRow.revision ||
        typeof event.previous_event_digest !== "string" || event.previous_event_digest !== priorDigest ||
        event.previous_event_digest !== eventRow.previous_event_digest ||
        typeof event.event_digest !== "string" || event.event_digest !== eventRow.event_digest ||
        typeof event.update_id !== "string" || event.update_id !== updateRow.update_id ||
        event.update_id !== stringValue(receipts[index]?.update_id) ||
        event.event_id !== updateRow.event_id ||
        typeof event.j_event_id !== "string" ||
        typeof event.content_digest !== "string" || event.content_digest !== updateRow.content_digest ||
        typeof event.committed_at_utc !== "string" ||
        !Array.isArray(event.changes)) return false;
    if (seenUpdateIds.has(event.update_id)) return false;
    seenUpdateIds.add(event.update_id);
    if (canonicalJson(eventValue) !== eventJson) return false;

    const content = {
      schema_version: "blue-tanuki.memory-commit.v1" as const,
      update_id: event.update_id,
      j_event_id: event.j_event_id,
      changes: event.changes,
    };
    try {
      if (memoryCommitContentDigest(content) !== event.content_digest) return false;
    } catch {
      return false;
    }
    const { event_digest: _eventDigest, ...eventBody } = event as StoredMemoryEvent;
    const computedEventDigest = sha256(canonicalJson(eventBody));
    if (computedEventDigest !== event.event_digest) return false;

    const receiptJson = stringValue(receipts[index]?.receipt_json);
    if (receiptJson === null) return false;
    let receiptValue: unknown;
    try {
      receiptValue = JSON.parse(receiptJson) as unknown;
    } catch {
      return false;
    }
    const parsedReceipt = parseMemoryUpdateReceipt(receiptValue);
    if (!parsedReceipt.ok || parsedReceipt.receipt.update_id !== event.update_id ||
        parsedReceipt.receipt.event_id !== event.event_id ||
        parsedReceipt.receipt.revision !== event.revision ||
        parsedReceipt.receipt.previous_revision !== event.revision - 1 ||
        parsedReceipt.receipt.event_digest !== event.event_digest ||
        parsedReceipt.receipt.content_digest !== event.content_digest ||
        parsedReceipt.receipt.committed_at_utc !== event.committed_at_utc) return false;
    if (canonicalJson(parsedReceipt.receipt) !== receiptJson) return false;

    for (const change of event.changes) {
      if (!isRecord(change) || typeof change.record_id !== "string") return false;
      if (change.operation === "upsert") {
        if (!("value" in change)) return false;
        replay.set(change.record_id, canonicalJson(change.value));
      } else if (change.operation === "delete") {
        replay.delete(change.record_id);
      } else {
        return false;
      }
    }
    revision = event.revision;
    priorDigest = event.event_digest;
  }

  if (revision !== stateRevision || priorDigest !== stateEventDigest) return false;
  const recordRows = database.prepare("SELECT record_id, value_json FROM m_records ORDER BY record_id").all();
  if (recordRows.length !== replay.size) return false;
  for (const row of recordRows) {
    const id = stringValue(row.record_id);
    const valueJson = stringValue(row.value_json);
    if (id === null || valueJson === null || replay.get(id) !== valueJson) return false;
    try {
      if (canonicalJson(JSON.parse(valueJson) as unknown) !== valueJson) return false;
    } catch {
      return false;
    }
  }
  return stateEventDigest === GENESIS_EVENT_DIGEST || /^[a-f0-9]{64}$/.test(stateEventDigest);
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
