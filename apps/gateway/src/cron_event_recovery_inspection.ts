import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/;
const CRON_INSPECTION_ROW_LIMIT = 10_000;

export type CronEventRecoveryStatus = "verified" | "residuals_present" | "corrupt" | "unavailable" | "schema_mismatch";
export type CronEventRecoveryReason = "store_unavailable" | "schema_mismatch" | "ledger_corrupt" | "outbox_mismatch";
export type CronEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type CronEventRequestMatchStatus = "matched" | "not_in_current_cursor" | "not_observed_due_to_limit" | "ambiguous" | "unverified";

export interface CronEventRecoveryInspection {
  readonly status: CronEventRecoveryStatus;
  readonly reason: CronEventRecoveryReason | null;
  readonly cursor_count: number | null;
  readonly verified_cursor_count: number | null;
  readonly unverified_cursor_count: number | null;
  readonly omitted_cursor_count: number | null;
  readonly unresolved_cursor_count: number | null;
  readonly orphan_outbox_count: number | null;
  readonly approval_handoff_count: number | null;
  readonly verified_approval_handoff_count: number | null;
  readonly unverified_approval_handoff_count: number | null;
  readonly omitted_approval_handoff_count: number | null;
  readonly pending_approval_handoff_count: number | null;
  readonly interrupted_approval_handoff_count: number | null;
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
}

export interface CronEventRecoveryLedgerInspection extends CronEventRecoveryInspection {
  /** Digest-only matches requested by the recovery aggregator; never contains command IDs. */
  readonly approval_command_matches: readonly CronApprovalCommandMatch[];
  /** Digest-only matches against each source's current cursor; this is not historical event proof. */
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
    orphan_outbox_count: null,
    approval_handoff_count: null,
    verified_approval_handoff_count: null,
    unverified_approval_handoff_count: null,
    omitted_approval_handoff_count: null,
    pending_approval_handoff_count: null,
    interrupted_approval_handoff_count: null,
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

function verifyCronRecoverySchema(database: DatabaseType): boolean {
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
  };
  const objects = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view')")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tableRows = objects.filter((row) => row.type === "table" && Object.hasOwn(expected, row.name));
  if (tableRows.length !== Object.keys(expected).length ||
      objects.some((row) => row.type === "trigger" || row.type === "view" || (row.type === "table" && !Object.hasOwn(expected, row.name)))) {
    return false;
  }
  for (const [table, columns] of Object.entries(expected)) {
    const schema = tableRows.find((row) => row.name === table)?.sql;
    if (typeof schema !== "string" || !/\bSTRICT\b/i.test(schema)) return false;
    const actual = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number; notnull: number }[];
    if (actual.length !== columns.length || !columns.every((column, index) => {
      const row = actual[index];
      return row?.name === column.name && row.type.toUpperCase() === column.type && row.pk === column.primaryKey && row.notnull === column.notNull;
    })) return false;
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(cron_event_outbox)").all() as { table: string; from: string; to: string }[];
  return foreignKeys.length === 1 && foreignKeys[0]?.table === "cron_event_inbox" &&
    foreignKeys[0].from === "source_digest" && foreignKeys[0].to === "source_digest";
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

function validApprovalRow(row: CronApprovalRow): boolean {
  return typeof row.source_digest === "string" && DIGEST.test(row.source_digest) &&
    nonnegativeSafeInteger(row.sequence) && typeof row.event_id === "string" &&
    row.event_id === `cron-${sha256(`${row.source_digest}\0${row.sequence}`)}` &&
    typeof row.payload_digest === "string" && DIGEST.test(row.payload_digest) &&
    typeof row.command_id_digest === "string" && DIGEST.test(row.command_id_digest) &&
    typeof row.request_id_digest === "string" && DIGEST.test(row.request_id_digest) &&
    ["pending", "interrupted", "consumed", "rejected", "cancelled"].includes(String(row.state)) &&
    row.cursor_source_digest === row.source_digest && row.cursor_sequence === row.sequence &&
    row.cursor_event_id === row.event_id && row.cursor_payload_digest === row.payload_digest &&
    nonnegativeSafeInteger(row.created_at_ms) && nonnegativeSafeInteger(row.updated_at_ms);
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
    if (!verifyCronRecoverySchema(database)) return unavailableInspection("schema_mismatch", "schema_mismatch");
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
    const orphanRow = database.prepare(`SELECT COUNT(*) AS count FROM cron_event_outbox o
      LEFT JOIN cron_event_inbox i ON i.source_digest=o.source_digest WHERE i.source_digest IS NULL`).get() as { count?: unknown } | undefined;
    if (cursorCount === null || approvalCount === null || !nonnegativeSafeInteger(orphanRow?.count)) {
      return unavailableInspection("schema_mismatch", "schema_mismatch");
    }
    const cursorRows = database.prepare(`SELECT i.source_digest,i.sequence,i.event_id,i.payload_digest,i.delivery_state,i.updated_at_ms,
        o.event_id AS outbox_event_id,o.sequence AS outbox_sequence,o.payload_digest AS outbox_payload_digest,
        o.delivery_state AS outbox_delivery_state,o.updated_at_ms AS outbox_updated_at_ms
      FROM cron_event_inbox i LEFT JOIN cron_event_outbox o ON o.source_digest=i.source_digest
      ORDER BY i.source_digest LIMIT ?`).all(CRON_INSPECTION_ROW_LIMIT) as unknown as CronCursorRow[];
    const approvalRows = database.prepare(`SELECT a.source_digest,a.sequence,a.event_id,a.payload_digest,a.command_id_digest,
        a.request_id_digest,a.state,a.created_at_ms,a.updated_at_ms,
        i.source_digest AS cursor_source_digest,i.sequence AS cursor_sequence,i.event_id AS cursor_event_id,
        i.payload_digest AS cursor_payload_digest
      FROM cron_approval_handoff a LEFT JOIN cron_event_inbox i ON i.source_digest=a.source_digest
      ORDER BY a.event_id,a.command_id_digest LIMIT ?`).all(CRON_INSPECTION_ROW_LIMIT) as unknown as CronApprovalRow[];

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
        const requestDigest = sha256(String(row.event_id));
        if (wantedRequestDigests.has(requestDigest)) {
          const match = eventMatches.get(requestDigest) ?? { row_count: 0, states: new Set<CronEventDeliveryState>(), unverified: false };
          match.row_count++;
          match.states.add(row.delivery_state as CronEventDeliveryState);
          eventMatches.set(requestDigest, match);
        }
        if (row.delivery_state !== "handler_returned") unresolvedCursorCount++;
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
    const omittedApprovalCount = approvalCount - approvalRows.length;
    const residualCount = unverifiedCursorCount + omittedCursorCount + unresolvedCursorCount + orphanRow.count +
      unverifiedApprovalCount + omittedApprovalCount + pendingApprovalCount + interruptedApprovalCount;
    const status: CronEventRecoveryStatus = residualCount === 0 ? "verified" : "residuals_present";
    return {
      status,
      reason: unverifiedCursorCount > 0 || unverifiedApprovalCount > 0 ? "ledger_corrupt"
        : orphanRow.count > 0 ? "outbox_mismatch" : null,
      cursor_count: cursorCount,
      verified_cursor_count: verifiedCursorCount,
      unverified_cursor_count: unverifiedCursorCount,
      omitted_cursor_count: omittedCursorCount,
      unresolved_cursor_count: unresolvedCursorCount,
      orphan_outbox_count: orphanRow.count,
      approval_handoff_count: approvalCount,
      verified_approval_handoff_count: verifiedApprovalCount,
      unverified_approval_handoff_count: unverifiedApprovalCount,
      omitted_approval_handoff_count: omittedApprovalCount,
      pending_approval_handoff_count: pendingApprovalCount,
      interrupted_approval_handoff_count: interruptedApprovalCount,
      residual_count: residualCount,
      used_for_authority: false,
      approval_command_matches: [...approvalMatches.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([command_id_digest, match]) => ({
        command_id_digest,
        row_count: match.row_count,
        states: [...match.states].sort(),
      })),
      event_request_matches: [...wantedRequestDigests].sort().map((request_id_digest): CronEventRequestMatch => {
        const match = eventMatches.get(request_id_digest);
        if (match) {
          if (match.row_count !== 1) return { request_id_digest, status: "ambiguous", delivery_state: null };
          if (match.unverified || match.states.size !== 1) return { request_id_digest, status: "unverified", delivery_state: null };
          return { request_id_digest, status: "matched", delivery_state: [...match.states][0]! };
        }
        return {
          request_id_digest,
          status: omittedCursorCount > 0 ? "not_observed_due_to_limit"
            : unverifiedCursorCount > 0 ? "unverified" : "not_in_current_cursor",
          delivery_state: null,
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
