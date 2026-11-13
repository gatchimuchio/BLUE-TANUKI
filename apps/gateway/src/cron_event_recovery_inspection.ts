import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { parseCronEventResultReceipt, type CronEventResultReceipt } from "./cron_event_result_receipt.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/;
const CRON_INSPECTION_ROW_LIMIT = 10_000;

export type CronEventRecoveryStatus = "verified" | "residuals_present" | "corrupt" | "unavailable" | "schema_mismatch";
export type CronEventRecoveryReason = "store_unavailable" | "schema_mismatch" | "ledger_corrupt" | "outbox_mismatch";
export type CronEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type CronEventRequestMatchStatus = "matched" | "not_in_current_cursor" | "not_in_retained_event_history" |
  "not_observed_due_to_limit" | "ambiguous" | "unverified";

export interface CronEventRecoveryInspection {
  readonly status: CronEventRecoveryStatus;
  readonly reason: CronEventRecoveryReason | null;
  readonly cursor_count: number | null;
  readonly verified_cursor_count: number | null;
  readonly unverified_cursor_count: number | null;
  readonly omitted_cursor_count: number | null;
  readonly unresolved_cursor_count: number | null;
  readonly event_history_available: boolean | null;
  readonly archived_event_count: number | null;
  readonly verified_archived_event_count: number | null;
  readonly unverified_archived_event_count: number | null;
  readonly omitted_archived_event_count: number | null;
  readonly orphan_outbox_count: number | null;
  readonly approval_handoff_count: number | null;
  readonly verified_approval_handoff_count: number | null;
  readonly unverified_approval_handoff_count: number | null;
  readonly omitted_approval_handoff_count: number | null;
  readonly pending_approval_handoff_count: number | null;
  readonly interrupted_approval_handoff_count: number | null;
  readonly result_receipt_available: boolean | null;
  readonly result_receipt_count: number | null;
  readonly verified_result_receipt_count: number | null;
  readonly unverified_result_receipt_count: number | null;
  readonly omitted_result_receipt_count: number | null;
  readonly orphan_result_receipt_count: number | null;
  readonly residual_count: number;
  readonly used_for_authority: false;
}

export type CronApprovalHandoffState = "pending" | "interrupted" | "consumed" | "rejected" | "cancelled";

export interface CronApprovalCommandMatch {
  readonly command_id_digest: string;
  readonly row_count: number;
  readonly states: readonly CronApprovalHandoffState[];
}

export interface CronEventRequestMatch {
  readonly request_id_digest: string;
  readonly status: CronEventRequestMatchStatus;
  readonly delivery_state: CronEventDeliveryState | null;
  readonly result_receipt_status: "verified" | "not_recorded" | "not_available" | "unverified";
  readonly result_receipt: CronEventResultReceiptSummary | null;
}

export interface CronEventResultReceiptSummary {
  readonly receipt_digest: string;
  readonly plan_match_status: CronEventResultReceipt["plan_match_status"];
  readonly plan_id_digest: string | null;
  readonly plan_revision_digest: string | null;
  readonly task_outcome_status: CronEventResultReceipt["task_outcome_status"];
  readonly task_outcome_reason_digest: string | null;
  readonly result_memory_status: CronEventResultReceipt["result_memory_status"];
  readonly result_memory_receipt_count: number;
  readonly result_memory_receipt_set_digest: string | null;
  readonly final_output_status: CronEventResultReceipt["final_output_status"];
  readonly final_output_count: number;
  readonly latest_final_output_digest: string | null;
  readonly observed_at_ms: number;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface CronEventRecoveryLedgerInspection extends CronEventRecoveryInspection {
  /** Digest-only matches requested by the recovery aggregator; never contains command IDs. */
  readonly approval_command_matches: readonly CronApprovalCommandMatch[];
  /** Digest-only matches against the current cursor and retained prior-event receipts. */
  readonly event_request_matches: readonly CronEventRequestMatch[];
}

interface CronCursorRow {
  source_digest: unknown;
  sequence: unknown;
  event_id: unknown;
  payload_digest: unknown;
  delivery_state: unknown;
  updated_at_ms: unknown;
  outbox_event_id: unknown;
  outbox_sequence: unknown;
  outbox_payload_digest: unknown;
  outbox_delivery_state: unknown;
  outbox_updated_at_ms: unknown;
}

interface CronApprovalRow {
  source_digest: unknown;
  sequence: unknown;
  event_id: unknown;
  payload_digest: unknown;
  command_id_digest: unknown;
  request_id_digest: unknown;
  state: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  cursor_source_digest: unknown;
  cursor_sequence: unknown;
  cursor_event_id: unknown;
  cursor_payload_digest: unknown;
  history_source_digest: unknown;
  history_sequence: unknown;
  history_event_id: unknown;
  history_payload_digest: unknown;
}

interface CronEventHistoryRow {
  event_id: unknown;
  request_id_digest: unknown;
  source_digest: unknown;
  sequence: unknown;
  payload_digest: unknown;
  delivery_state: unknown;
  updated_at_ms: unknown;
}

interface CronEventResultReceiptRow {
  event_id: unknown;
  request_id_digest: unknown;
  source_digest: unknown;
  sequence: unknown;
  payload_digest: unknown;
  receipt_json: unknown;
  receipt_digest: unknown;
  observed_at_ms: unknown;
}

function unavailableInspection(
  status: "corrupt" | "unavailable" | "schema_mismatch",
  reason: CronEventRecoveryReason,
): CronEventRecoveryLedgerInspection {
  return {
    status,
    reason,
    cursor_count: null,
    verified_cursor_count: null,
    unverified_cursor_count: null,
    omitted_cursor_count: null,
    unresolved_cursor_count: null,
    event_history_available: null,
    archived_event_count: null,
    verified_archived_event_count: null,
    unverified_archived_event_count: null,
    omitted_archived_event_count: null,
    orphan_outbox_count: null,
    approval_handoff_count: null,
    verified_approval_handoff_count: null,
    unverified_approval_handoff_count: null,
    omitted_approval_handoff_count: null,
    pending_approval_handoff_count: null,
    interrupted_approval_handoff_count: null,
    result_receipt_available: null,
    result_receipt_count: null,
    verified_result_receipt_count: null,
    unverified_result_receipt_count: null,
    omitted_result_receipt_count: null,
    orphan_result_receipt_count: null,
    residual_count: 1,
    used_for_authority: false,
    approval_command_matches: [],
    event_request_matches: [],
  };
}

function safeCronRecoveryPath(privateStateRoot: string, databasePath: string): string | null {
  try {
    const rootStat = lstatSync(privateStateRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const root = realpathSync(privateStateRoot);
    const absolutePath = resolve(databasePath);
    const rel = relative(root, absolutePath);
    const allowedPaths = [join("cron-events", "cron-events.sqlite"), join("canonical-state", "cron_events.sqlite")];
    if (!allowedPaths.includes(rel) || isAbsolute(rel) || rel.startsWith(`..${sep}`)) return null;
    const directory = join(root, dirname(rel));
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || realpathSync(directory) !== directory) return null;
    const fileStat = lstatSync(absolutePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size === 0 || realpathSync(absolutePath) !== absolutePath) return null;
    return absolutePath;
  } catch {
    return null;
  }
}

function hasCronSqliteSidecar(databasePath: string): boolean {
  return ["-journal", "-wal", "-shm"].some((suffix) => {
    try {
      lstatSync(`${databasePath}${suffix}`);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

type CronEventSchemaVersion = "current_cursor_only" | "digest_history";

function verifyCronRecoverySchema(database: DatabaseType): CronEventSchemaVersion | null {
  const expected: Record<string, readonly { name: string; type: string; primaryKey: number; notNull: number }[]> = {
    cron_event_inbox: [
      { name: "source_digest", type: "TEXT", primaryKey: 1, notNull: 1 },
      { name: "sequence", type: "INTEGER", primaryKey: 0, notNull: 1 },
      { name: "event_id", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "payload_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "delivery_state", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "updated_at_ms", type: "INTEGER", primaryKey: 0, notNull: 1 },
    ],
    cron_event_outbox: [
      { name: "source_digest", type: "TEXT", primaryKey: 1, notNull: 1 },
      { name: "event_id", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "sequence", type: "INTEGER", primaryKey: 0, notNull: 1 },
      { name: "payload_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "delivery_state", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "updated_at_ms", type: "INTEGER", primaryKey: 0, notNull: 1 },
    ],
    cron_approval_handoff: [
      { name: "source_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "sequence", type: "INTEGER", primaryKey: 0, notNull: 1 },
      { name: "event_id", type: "TEXT", primaryKey: 1, notNull: 1 },
      { name: "payload_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "command_id_digest", type: "TEXT", primaryKey: 2, notNull: 1 },
      { name: "request_id_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "state", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "created_at_ms", type: "INTEGER", primaryKey: 0, notNull: 1 },
      { name: "updated_at_ms", type: "INTEGER", primaryKey: 0, notNull: 1 },
    ],
    cron_event_archive: [
      { name: "event_id", type: "TEXT", primaryKey: 1, notNull: 1 },
      { name: "request_id_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "source_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "sequence", type: "INTEGER", primaryKey: 0, notNull: 1 },
      { name: "payload_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "delivery_state", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "updated_at_ms", type: "INTEGER", primaryKey: 0, notNull: 1 },
    ],
    cron_event_result_receipt: [
      { name: "event_id", type: "TEXT", primaryKey: 1, notNull: 1 },
      { name: "request_id_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "source_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "sequence", type: "INTEGER", primaryKey: 0, notNull: 1 },
      { name: "payload_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "receipt_json", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "receipt_digest", type: "TEXT", primaryKey: 0, notNull: 1 },
      { name: "observed_at_ms", type: "INTEGER", primaryKey: 0, notNull: 1 },
    ],
  };
  const optionalTables = new Set(["cron_event_archive", "cron_event_result_receipt"]);
  const objects = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view')")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tableRows = objects.filter((row) => row.type === "table" && Object.hasOwn(expected, row.name));
  const hasHistory = tableRows.some((row) => row.name === "cron_event_archive");
  const expectedTables = Object.keys(expected).filter((table) =>
    !optionalTables.has(table) || tableRows.some((row) => row.name === table));
  if (tableRows.length !== expectedTables.length ||
      objects.some((row) => row.type === "trigger" || row.type === "view" || (row.type === "table" && !Object.hasOwn(expected, row.name)))) {
    return null;
  }
  for (const table of expectedTables) {
    const columns = expected[table]!;
    const schema = tableRows.find((row) => row.name === table)?.sql;
    if (typeof schema !== "string" || !/\bSTRICT\b/i.test(schema)) return null;
    const actual = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number; notnull: number }[];
    if (actual.length !== columns.length || !columns.every((column, index) => {
      const row = actual[index];
      return row?.name === column.name && row.type.toUpperCase() === column.type && row.pk === column.primaryKey && row.notnull === column.notNull;
    })) return null;
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(cron_event_outbox)").all() as { table: string; from: string; to: string }[];
  if (!(foreignKeys.length === 1 && foreignKeys[0]?.table === "cron_event_inbox" &&
      foreignKeys[0].from === "source_digest" && foreignKeys[0].to === "source_digest")) return null;
  return hasHistory ? "digest_history" : "current_cursor_only";
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCursor(row: CronCursorRow): boolean {
  if (typeof row.source_digest !== "string" || !DIGEST.test(row.source_digest) ||
      !nonnegativeSafeInteger(row.sequence) || typeof row.event_id !== "string" ||
      row.event_id !== `cron-${sha256(`${row.source_digest}\0${row.sequence}`)}` ||
      typeof row.payload_digest !== "string" || !DIGEST.test(row.payload_digest) ||
      !["dispatching", "handler_returned", "outcome_unknown"].includes(String(row.delivery_state)) ||
      !nonnegativeSafeInteger(row.updated_at_ms)) return false;
  return row.outbox_event_id === row.event_id && row.outbox_sequence === row.sequence &&
    row.outbox_payload_digest === row.payload_digest && row.outbox_delivery_state === row.delivery_state &&
    row.outbox_updated_at_ms === row.updated_at_ms;
}

function validArchivedEvent(row: CronEventHistoryRow): boolean {
  return typeof row.source_digest === "string" && DIGEST.test(row.source_digest) &&
    nonnegativeSafeInteger(row.sequence) && typeof row.event_id === "string" &&
    row.event_id === `cron-${sha256(`${row.source_digest}\0${row.sequence}`)}` &&
    typeof row.request_id_digest === "string" && row.request_id_digest === sha256(row.event_id) &&
    typeof row.payload_digest === "string" && DIGEST.test(row.payload_digest) &&
    ["dispatching", "handler_returned", "outcome_unknown"].includes(String(row.delivery_state)) &&
    nonnegativeSafeInteger(row.updated_at_ms);
}

function validApprovalRow(row: CronApprovalRow): boolean {
  const matchesCurrent = row.cursor_source_digest === row.source_digest && row.cursor_sequence === row.sequence &&
    row.cursor_event_id === row.event_id && row.cursor_payload_digest === row.payload_digest;
  const matchesHistory = row.history_source_digest === row.source_digest && row.history_sequence === row.sequence &&
    row.history_event_id === row.event_id && row.history_payload_digest === row.payload_digest;
  return typeof row.source_digest === "string" && DIGEST.test(row.source_digest) &&
    nonnegativeSafeInteger(row.sequence) && typeof row.event_id === "string" &&
    row.event_id === `cron-${sha256(`${row.source_digest}\0${row.sequence}`)}` &&
    typeof row.payload_digest === "string" && DIGEST.test(row.payload_digest) &&
    typeof row.command_id_digest === "string" && DIGEST.test(row.command_id_digest) &&
    typeof row.request_id_digest === "string" && DIGEST.test(row.request_id_digest) &&
    ["pending", "interrupted", "consumed", "rejected", "cancelled"].includes(String(row.state)) &&
    (matchesCurrent !== matchesHistory) &&
    nonnegativeSafeInteger(row.created_at_ms) && nonnegativeSafeInteger(row.updated_at_ms);
}

function resultReceiptSummary(receipt: CronEventResultReceipt): CronEventResultReceiptSummary {
  return {
    receipt_digest: receipt.receipt_digest,
    plan_match_status: receipt.plan_match_status,
    plan_id_digest: receipt.plan_id_digest,
    plan_revision_digest: receipt.plan_revision_digest,
    task_outcome_status: receipt.task_outcome_status,
    task_outcome_reason_digest: receipt.task_outcome_reason_digest,
    result_memory_status: receipt.result_memory_status,
    result_memory_receipt_count: receipt.result_memory_receipt_count,
    result_memory_receipt_set_digest: receipt.result_memory_receipt_set_digest,
    final_output_status: receipt.final_output_status,
    final_output_count: receipt.final_output_count,
    latest_final_output_digest: receipt.latest_final_output_digest,
    observed_at_ms: receipt.observed_at_ms,
    used_for_authority: false,
    may_execute: false,
  };
}

/** Read-only, bounded inspection of the private Cron ledger; it never creates or repairs a store. */
export function inspectCronEventRecoveryLedger(options: {
  readonly private_state_root: string;
  readonly database_path: string;
  readonly command_id_digests?: readonly string[];
  readonly request_id_digests?: readonly string[];
}): CronEventRecoveryLedgerInspection {
  let database: DatabaseType | undefined;
  let databasePath = "";
  try {
    databasePath = safeCronRecoveryPath(options.private_state_root, options.database_path) ?? "";
    if (!databasePath || hasCronSqliteSidecar(databasePath)) {
      return unavailableInspection("unavailable", "store_unavailable");
    }
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    database.enableLoadExtension(false);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; BEGIN");
    if (hasCronSqliteSidecar(databasePath)) {
      return unavailableInspection("unavailable", "store_unavailable");
    }
    const mode = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (typeof mode?.journal_mode !== "string" || mode.journal_mode.toLowerCase() !== "delete") {
      return unavailableInspection("unavailable", "store_unavailable");
    }
    const schemaVersion = verifyCronRecoverySchema(database);
    if (!schemaVersion) return unavailableInspection("schema_mismatch", "schema_mismatch");
    const resultReceiptAvailable = database.prepare(`SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='cron_event_result_receipt'`).get() !== undefined;
    const integrity = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
    if (!integrity || Object.values(integrity)[0] !== "ok") {
      return unavailableInspection("corrupt", "ledger_corrupt");
    }

    const count = (table: string): number | null => {
      const row = database!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown } | undefined;
      return nonnegativeSafeInteger(row?.count) ? row.count : null;
    };
    const cursorCount = count("cron_event_inbox");
    const approvalCount = count("cron_approval_handoff");
    const archivedEventCount = schemaVersion === "digest_history" ? count("cron_event_archive") : 0;
    const resultReceiptCount = resultReceiptAvailable ? count("cron_event_result_receipt") : null;
    const orphanRow = database.prepare(`SELECT COUNT(*) AS count FROM cron_event_outbox o
      LEFT JOIN cron_event_inbox i ON i.source_digest=o.source_digest WHERE i.source_digest IS NULL`).get() as { count?: unknown } | undefined;
    if (cursorCount === null || approvalCount === null || archivedEventCount === null ||
        (resultReceiptAvailable && resultReceiptCount === null) || !nonnegativeSafeInteger(orphanRow?.count)) {
      return unavailableInspection("schema_mismatch", "schema_mismatch");
    }
    const cursorRows = database.prepare(`SELECT i.source_digest,i.sequence,i.event_id,i.payload_digest,i.delivery_state,i.updated_at_ms,
        o.event_id AS outbox_event_id,o.sequence AS outbox_sequence,o.payload_digest AS outbox_payload_digest,
        o.delivery_state AS outbox_delivery_state,o.updated_at_ms AS outbox_updated_at_ms
      FROM cron_event_inbox i LEFT JOIN cron_event_outbox o ON o.source_digest=i.source_digest
      ORDER BY i.source_digest LIMIT ?`).all(CRON_INSPECTION_ROW_LIMIT) as unknown as CronCursorRow[];
    const approvalQuery = schemaVersion === "digest_history" ? `SELECT a.source_digest,a.sequence,a.event_id,a.payload_digest,a.command_id_digest,
        a.request_id_digest,a.state,a.created_at_ms,a.updated_at_ms,
        i.source_digest AS cursor_source_digest,i.sequence AS cursor_sequence,i.event_id AS cursor_event_id,
        i.payload_digest AS cursor_payload_digest,
        h.source_digest AS history_source_digest,h.sequence AS history_sequence,h.event_id AS history_event_id,
        h.payload_digest AS history_payload_digest
      FROM cron_approval_handoff a LEFT JOIN cron_event_inbox i ON i.source_digest=a.source_digest
      LEFT JOIN cron_event_archive h ON h.event_id=a.event_id
      ORDER BY a.event_id,a.command_id_digest LIMIT ?`
      : `SELECT a.source_digest,a.sequence,a.event_id,a.payload_digest,a.command_id_digest,
        a.request_id_digest,a.state,a.created_at_ms,a.updated_at_ms,
        i.source_digest AS cursor_source_digest,i.sequence AS cursor_sequence,i.event_id AS cursor_event_id,
        i.payload_digest AS cursor_payload_digest,
        NULL AS history_source_digest,NULL AS history_sequence,NULL AS history_event_id,NULL AS history_payload_digest
      FROM cron_approval_handoff a LEFT JOIN cron_event_inbox i ON i.source_digest=a.source_digest
      ORDER BY a.event_id,a.command_id_digest LIMIT ?`;
    const approvalRows = database.prepare(approvalQuery).all(CRON_INSPECTION_ROW_LIMIT) as unknown as CronApprovalRow[];
    const archivedEventRows = schemaVersion === "digest_history"
      ? database.prepare(`SELECT event_id,request_id_digest,source_digest,sequence,payload_digest,delivery_state,updated_at_ms
          FROM cron_event_archive ORDER BY request_id_digest,event_id LIMIT ?`).all(CRON_INSPECTION_ROW_LIMIT) as unknown as CronEventHistoryRow[]
      : [];
    const resultReceiptRows = resultReceiptAvailable
      ? database.prepare(`SELECT event_id,request_id_digest,source_digest,sequence,payload_digest,receipt_json,receipt_digest,observed_at_ms
          FROM cron_event_result_receipt ORDER BY request_id_digest,event_id LIMIT ?`).all(CRON_INSPECTION_ROW_LIMIT) as unknown as CronEventResultReceiptRow[]
      : [];

    const wantedCommandDigests = new Set((options.command_id_digests ?? [])
      .filter((value) => typeof value === "string" && DIGEST.test(value))
      .map((value) => value.toLowerCase()));
    const wantedRequestDigests = new Set((options.request_id_digests ?? [])
      .filter((value) => typeof value === "string" && DIGEST.test(value))
      .map((value) => value.toLowerCase()));
    const approvalMatches = new Map<string, { row_count: number; states: Set<CronApprovalHandoffState> }>();
    const eventMatches = new Map<string, { row_count: number; states: Set<CronEventDeliveryState>; unverified: boolean }>();

    let verifiedCursorCount = 0;
    let unverifiedCursorCount = 0;
    let unresolvedCursorCount = 0;
    const observedEventIds = new Set<string>();
    const observedEventIdentities = new Map<string, {
      request_id_digest: string; source_digest: string; sequence: number; payload_digest: string;
      delivery_state: CronEventDeliveryState;
    }>();
    for (const row of cursorRows) {
      if (!validCursor(row)) {
        unverifiedCursorCount++;
        if (typeof row.event_id === "string") {
          const requestDigest = sha256(row.event_id);
          if (wantedRequestDigests.has(requestDigest)) {
            const match = eventMatches.get(requestDigest) ?? { row_count: 0, states: new Set<CronEventDeliveryState>(), unverified: false };
            match.row_count++;
            match.unverified = true;
            eventMatches.set(requestDigest, match);
          }
        }
      } else {
        verifiedCursorCount++;
        observedEventIds.add(String(row.event_id));
        const requestDigest = sha256(String(row.event_id));
        observedEventIdentities.set(String(row.event_id), {
          request_id_digest: requestDigest, source_digest: String(row.source_digest), sequence: Number(row.sequence),
          payload_digest: String(row.payload_digest), delivery_state: row.delivery_state as CronEventDeliveryState,
        });
        if (wantedRequestDigests.has(requestDigest)) {
          const match = eventMatches.get(requestDigest) ?? { row_count: 0, states: new Set<CronEventDeliveryState>(), unverified: false };
          match.row_count++;
          match.states.add(row.delivery_state as CronEventDeliveryState);
          eventMatches.set(requestDigest, match);
        }
        if (row.delivery_state !== "handler_returned") unresolvedCursorCount++;
      }
    }
    let verifiedArchivedEventCount = 0;
    let unverifiedArchivedEventCount = 0;
    for (const row of archivedEventRows) {
      if (!validArchivedEvent(row) || observedEventIds.has(String(row.event_id))) {
        unverifiedArchivedEventCount++;
        if (typeof row.request_id_digest === "string" && wantedRequestDigests.has(row.request_id_digest)) {
          const match = eventMatches.get(row.request_id_digest) ?? { row_count: 0, states: new Set<CronEventDeliveryState>(), unverified: false };
          match.row_count++;
          match.unverified = true;
          eventMatches.set(row.request_id_digest, match);
        }
        continue;
      }
      verifiedArchivedEventCount++;
      observedEventIds.add(String(row.event_id));
      observedEventIdentities.set(String(row.event_id), {
        request_id_digest: String(row.request_id_digest), source_digest: String(row.source_digest), sequence: Number(row.sequence),
        payload_digest: String(row.payload_digest), delivery_state: row.delivery_state as CronEventDeliveryState,
      });
      if (wantedRequestDigests.has(String(row.request_id_digest))) {
        const match = eventMatches.get(String(row.request_id_digest)) ?? { row_count: 0, states: new Set<CronEventDeliveryState>(), unverified: false };
        match.row_count++;
        match.states.add(row.delivery_state as CronEventDeliveryState);
        eventMatches.set(String(row.request_id_digest), match);
      }
    }
    let verifiedApprovalCount = 0;
    let unverifiedApprovalCount = 0;
    let pendingApprovalCount = 0;
    let interruptedApprovalCount = 0;
    for (const row of approvalRows) {
      if (!validApprovalRow(row)) {
        unverifiedApprovalCount++;
      } else {
        verifiedApprovalCount++;
        const commandIdDigest = String(row.command_id_digest).toLowerCase();
        if (wantedCommandDigests.has(commandIdDigest)) {
          const match = approvalMatches.get(commandIdDigest) ?? { row_count: 0, states: new Set<CronApprovalHandoffState>() };
          match.row_count++;
          match.states.add(row.state as CronApprovalHandoffState);
          approvalMatches.set(commandIdDigest, match);
        }
        if (row.state === "pending") pendingApprovalCount++;
        if (row.state === "interrupted") interruptedApprovalCount++;
      }
    }
    const omittedCursorCount = cursorCount - cursorRows.length;
    const omittedArchivedEventCount = archivedEventCount - archivedEventRows.length;
    const omittedApprovalCount = approvalCount - approvalRows.length;
    const omittedResultReceiptCount = resultReceiptAvailable ? resultReceiptCount! - resultReceiptRows.length : null;
    let verifiedResultReceiptCount = 0;
    let unverifiedResultReceiptCount = 0;
    let unverifiedResultReceiptDueToEventLimitCount = 0;
    let orphanResultReceiptCandidateCount = 0;
    const resultReceiptMatches = new Map<string, { row_count: number; unverified: boolean; receipt?: CronEventResultReceipt }>();
    for (const row of resultReceiptRows) {
      let decoded: unknown;
      try { decoded = typeof row.receipt_json === "string" ? JSON.parse(row.receipt_json) : undefined; } catch { decoded = undefined; }
      const receipt = parseCronEventResultReceipt(decoded);
      const eventId = typeof row.event_id === "string" ? row.event_id : "";
      const eventIdentity = observedEventIdentities.get(eventId);
      const valid = !!receipt && !!eventIdentity && eventIdentity.delivery_state === "handler_returned" &&
        row.request_id_digest === eventIdentity.request_id_digest && row.source_digest === eventIdentity.source_digest &&
        row.sequence === eventIdentity.sequence && row.payload_digest === eventIdentity.payload_digest &&
        row.receipt_digest === receipt.receipt_digest && row.observed_at_ms === receipt.observed_at_ms &&
        receipt.event_id_digest === sha256(eventId) && receipt.request_id_digest === eventIdentity.request_id_digest &&
        receipt.source_digest === eventIdentity.source_digest && receipt.sequence === eventIdentity.sequence &&
        receipt.payload_digest === eventIdentity.payload_digest;
      if (valid) verifiedResultReceiptCount++;
      else {
        unverifiedResultReceiptCount++;
        if (!eventIdentity) {
          if (omittedCursorCount > 0 || omittedArchivedEventCount > 0 ||
              unverifiedCursorCount > 0 || unverifiedArchivedEventCount > 0) {
            unverifiedResultReceiptDueToEventLimitCount++;
          } else orphanResultReceiptCandidateCount++;
        }
      }
      const requestDigest = typeof row.request_id_digest === "string" ? row.request_id_digest : "";
      if (wantedRequestDigests.has(requestDigest)) {
        const match = resultReceiptMatches.get(requestDigest) ?? { row_count: 0, unverified: false };
        match.row_count++;
        if (!valid || !receipt) match.unverified = true;
        else match.receipt = receipt;
        resultReceiptMatches.set(requestDigest, match);
      }
    }
    const orphanResultReceiptCount = omittedCursorCount === 0 && omittedArchivedEventCount === 0 &&
      unverifiedCursorCount === 0 && unverifiedArchivedEventCount === 0
      ? orphanResultReceiptCandidateCount : 0;
    const residualCount = unverifiedCursorCount + omittedCursorCount + unresolvedCursorCount +
      unverifiedArchivedEventCount + omittedArchivedEventCount + orphanRow.count +
      unverifiedApprovalCount + omittedApprovalCount + pendingApprovalCount + interruptedApprovalCount +
      unverifiedResultReceiptCount + (omittedResultReceiptCount ?? 0);
    const status: CronEventRecoveryStatus = residualCount === 0 ? "verified" : "residuals_present";
    return {
      status,
      reason: unverifiedCursorCount > 0 || unverifiedArchivedEventCount > 0 || unverifiedApprovalCount > 0 ||
        unverifiedResultReceiptCount > unverifiedResultReceiptDueToEventLimitCount ? "ledger_corrupt"
        : orphanRow.count > 0 ? "outbox_mismatch" : null,
      cursor_count: cursorCount,
      verified_cursor_count: verifiedCursorCount,
      unverified_cursor_count: unverifiedCursorCount,
      omitted_cursor_count: omittedCursorCount,
      unresolved_cursor_count: unresolvedCursorCount,
      event_history_available: schemaVersion === "digest_history",
      archived_event_count: archivedEventCount,
      verified_archived_event_count: verifiedArchivedEventCount,
      unverified_archived_event_count: unverifiedArchivedEventCount,
      omitted_archived_event_count: omittedArchivedEventCount,
      orphan_outbox_count: orphanRow.count,
      approval_handoff_count: approvalCount,
      verified_approval_handoff_count: verifiedApprovalCount,
      unverified_approval_handoff_count: unverifiedApprovalCount,
      omitted_approval_handoff_count: omittedApprovalCount,
      pending_approval_handoff_count: pendingApprovalCount,
      interrupted_approval_handoff_count: interruptedApprovalCount,
      result_receipt_available: resultReceiptAvailable,
      result_receipt_count: resultReceiptCount,
      verified_result_receipt_count: resultReceiptAvailable ? verifiedResultReceiptCount : null,
      unverified_result_receipt_count: resultReceiptAvailable ? unverifiedResultReceiptCount : null,
      omitted_result_receipt_count: omittedResultReceiptCount,
      orphan_result_receipt_count: resultReceiptAvailable ? orphanResultReceiptCount : null,
      residual_count: residualCount,
      used_for_authority: false,
      approval_command_matches: [...approvalMatches.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([command_id_digest, match]) => ({
        command_id_digest,
        row_count: match.row_count,
        states: [...match.states].sort(),
      })),
      event_request_matches: [...wantedRequestDigests].sort().map((request_id_digest): CronEventRequestMatch => {
        const match = eventMatches.get(request_id_digest);
        const resultMatch = resultReceiptMatches.get(request_id_digest);
        const resultReceiptStatus: CronEventRequestMatch["result_receipt_status"] = !resultReceiptAvailable ? "not_available"
          : resultMatch?.row_count === 1 && !resultMatch.unverified && resultMatch.receipt ? "verified"
            : resultMatch ? "unverified" : "not_recorded";
        const resultReceipt = resultReceiptStatus === "verified" && resultMatch?.receipt
          ? resultReceiptSummary(resultMatch.receipt) : null;
        if (match) {
          if (match.row_count !== 1) return { request_id_digest, status: "ambiguous", delivery_state: null, result_receipt_status: resultReceiptStatus, result_receipt: null };
          if (match.unverified || match.states.size !== 1) return { request_id_digest, status: "unverified", delivery_state: null, result_receipt_status: "unverified", result_receipt: null };
          return { request_id_digest, status: "matched", delivery_state: [...match.states][0]!, result_receipt_status: resultReceiptStatus, result_receipt: resultReceipt };
        }
        return {
          request_id_digest,
          status: omittedCursorCount > 0 || omittedArchivedEventCount > 0 ? "not_observed_due_to_limit"
            : unverifiedCursorCount > 0 || unverifiedArchivedEventCount > 0 ? "unverified"
              : schemaVersion === "current_cursor_only" ? "not_in_current_cursor" : "not_in_retained_event_history",
          delivery_state: null,
          result_receipt_status: resultReceiptStatus,
          result_receipt: null,
        };
      }),
    };
  } catch {
    return unavailableInspection("unavailable", "store_unavailable");
  } finally {
    if (database) {
      try { database.exec("ROLLBACK"); } catch { /* retain the read-only inspection result */ }
      try { database.close(); } catch { /* retain the read-only inspection result */ }
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
