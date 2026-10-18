import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateDocumentOrganizationCheckpointShape } from "@blue-tanuki/hds-brain";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
const ROW_LIMIT = 128;
const CHECKPOINT_STATUSES = ["ready", "continuing", "completed", "held"] as const;

export type DocumentOrganizationCheckpointStatus = typeof CHECKPOINT_STATUSES[number];
export type DocumentOrganizationCheckpointLedgerStatus =
  | "verified"
  | "residuals_present"
  | "corrupt"
  | "unavailable"
  | "schema_mismatch";
export type DocumentOrganizationCheckpointLedgerReason =
  | "store_unavailable"
  | "schema_mismatch"
  | "ledger_corrupt"
  | "row_limit_reached"
  | "unfinished_checkpoints";

export interface DocumentOrganizationCheckpointRecordInspection {
  readonly checkpoint_ref_digest: string | null;
  readonly integrity: "verified" | "residuals_present";
  readonly reason: "row_shape_invalid" | "checkpoint_digest_mismatch" | "checkpoint_json_invalid" |
    "checkpoint_shape_invalid" | "checkpoint_identity_mismatch" | null;
  readonly checkpoint_status: DocumentOrganizationCheckpointStatus | null;
}

export interface DocumentOrganizationCheckpointRecoveryInspection {
  readonly status: DocumentOrganizationCheckpointLedgerStatus;
  readonly reason: DocumentOrganizationCheckpointLedgerReason | null;
  readonly checkpoint_count: number | null;
  readonly verified_checkpoint_count: number | null;
  readonly residual_checkpoint_count: number | null;
  readonly omitted_checkpoint_count: number | null;
  readonly unresolved_checkpoint_count: number | null;
  readonly residual_count: number;
  readonly records: readonly DocumentOrganizationCheckpointRecordInspection[];
  readonly used_for_authority: false;
}

interface CheckpointRow {
  readonly actor_digest: unknown;
  readonly source_sha256: unknown;
  readonly status: unknown;
  readonly checkpoint_json: unknown;
  readonly checkpoint_digest: unknown;
  readonly updated_at: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unavailableInspection(
  status: "corrupt" | "unavailable" | "schema_mismatch",
  reason: DocumentOrganizationCheckpointLedgerReason,
): DocumentOrganizationCheckpointRecoveryInspection {
  return {
    status,
    reason,
    checkpoint_count: null,
    verified_checkpoint_count: null,
    residual_checkpoint_count: null,
    omitted_checkpoint_count: null,
    unresolved_checkpoint_count: null,
    residual_count: 1,
    records: [],
    used_for_authority: false,
  };
}

function safeCheckpointPath(env: NodeJS.ProcessEnv): string | null {
  try {
    const configuredRoot = resolve(env.BLUE_TANUKI_FILE_ROOT ?? ".blue-tanuki");
    const rootStat = lstatSync(configuredRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const root = realpathSync(configuredRoot);
    const directory = join(root, "document-organization");
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
    const databasePath = join(directory, "j-checkpoints.sqlite");
    const fileStat = lstatSync(databasePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size === 0) return null;
    const absolutePath = resolve(databasePath);
    const relativePath = relative(root, absolutePath);
    if (relativePath !== join("document-organization", "j-checkpoints.sqlite") || isAbsolute(relativePath) ||
        relativePath.startsWith(`..${sep}`) || realpathSync(absolutePath) !== absolutePath) return null;
    return absolutePath;
  } catch {
    return null;
  }
}

function hasSqliteSidecar(databasePath: string): boolean {
  return ["-journal", "-wal", "-shm"].some((suffix) => {
    try {
      lstatSync(`${databasePath}${suffix}`);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

function verifySchema(database: DatabaseType): boolean {
  const objects = database.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger','view')",
  ).all() as Array<{ type?: unknown; name?: unknown; sql?: unknown }>;
  const tables = objects.filter((item) => item.type === "table");
  if (tables.length !== 1 || tables[0]?.name !== "document_organization_checkpoints" ||
      objects.some((item) => item.type === "trigger" || item.type === "view") ||
      typeof tables[0]?.sql !== "string" || !/\bSTRICT\b/i.test(tables[0].sql)) return false;
  const columns = database.prepare("PRAGMA table_info(document_organization_checkpoints)").all() as Array<{
    name?: unknown;
    type?: unknown;
    notnull?: unknown;
    pk?: unknown;
  }>;
  const expected = [
    ["actor_digest", "TEXT", 1, 1],
    ["source_sha256", "TEXT", 1, 2],
    ["status", "TEXT", 1, 0],
    ["checkpoint_json", "TEXT", 1, 0],
    ["checkpoint_digest", "TEXT", 1, 0],
    ["updated_at", "INTEGER", 1, 0],
  ] as const;
  return columns.length === expected.length && columns.every((column, index) => {
    const item = expected[index];
    return item !== undefined && column.name === item[0] && column.type === item[1] &&
      Number(column.notnull) === item[2] && Number(column.pk) === item[3];
  });
}

function inspectRow(row: CheckpointRow): DocumentOrganizationCheckpointRecordInspection {
  const referenceDigest = typeof row.actor_digest === "string" && DIGEST.test(row.actor_digest) &&
    typeof row.source_sha256 === "string" && DIGEST.test(row.source_sha256)
    ? sha256(`document-organization-checkpoint\0${row.actor_digest}\0${row.source_sha256}`)
    : null;
  let reason: DocumentOrganizationCheckpointRecordInspection["reason"] = null;
  let checkpointStatus: DocumentOrganizationCheckpointStatus | null = null;
  if (referenceDigest === null || typeof row.status !== "string" || !CHECKPOINT_STATUSES.includes(row.status as DocumentOrganizationCheckpointStatus) ||
      typeof row.checkpoint_json !== "string" || typeof row.checkpoint_digest !== "string" || !DIGEST.test(row.checkpoint_digest) ||
      typeof row.updated_at !== "number" || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0) {
    reason = "row_shape_invalid";
  } else if (row.checkpoint_digest !== sha256(`${row.actor_digest}|${row.source_sha256}|${row.checkpoint_json}`)) {
    reason = "checkpoint_digest_mismatch";
  } else {
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(row.checkpoint_json) as unknown;
    } catch {
      reason = "checkpoint_json_invalid";
    }
    if (reason === null && !validateDocumentOrganizationCheckpointShape(checkpoint)) {
      reason = "checkpoint_shape_invalid";
    }
    if (reason === null && checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
      const payload = checkpoint as Record<string, unknown>;
      if (payload.source_sha256 !== row.source_sha256 || payload.status !== row.status ||
          typeof payload.request_id !== "string" || payload.task_id !== `document-organization:${payload.request_id}`) {
        reason = "checkpoint_identity_mismatch";
      } else {
        checkpointStatus = row.status as DocumentOrganizationCheckpointStatus;
      }
    }
  }
  return {
    checkpoint_ref_digest: referenceDigest,
    integrity: reason === null ? "verified" : "residuals_present",
    reason,
    checkpoint_status: checkpointStatus,
  };
}

/** Read-only inspection of the file-root J checkpoint ledger. It does not validate source spans or authorize recovery. */
export function inspectDocumentOrganizationCheckpointLedger(
  env: NodeJS.ProcessEnv = process.env,
): DocumentOrganizationCheckpointRecoveryInspection {
  const databasePath = safeCheckpointPath(env);
  if (!databasePath || hasSqliteSidecar(databasePath)) return unavailableInspection("unavailable", "store_unavailable");
  let database: DatabaseType | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
    database.enableLoadExtension(false);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; BEGIN");
    const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (typeof journal?.journal_mode !== "string" || journal.journal_mode.toLowerCase() !== "delete") {
      return unavailableInspection("unavailable", "store_unavailable");
    }
    if (hasSqliteSidecar(databasePath)) return unavailableInspection("unavailable", "store_unavailable");
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
      return unavailableInspection("corrupt", "ledger_corrupt");
    }
    if (!verifySchema(database)) return unavailableInspection("schema_mismatch", "schema_mismatch");
    const countRow = database.prepare("SELECT COUNT(*) AS count FROM document_organization_checkpoints").get() as { count?: unknown } | undefined;
    const checkpointCount = typeof countRow?.count === "bigint" ? Number(countRow.count) : countRow?.count;
    if (typeof checkpointCount !== "number" || !Number.isSafeInteger(checkpointCount) || checkpointCount < 0) {
      return unavailableInspection("corrupt", "ledger_corrupt");
    }
    const rows = database.prepare(`
      SELECT actor_digest, source_sha256, status, checkpoint_json, checkpoint_digest, updated_at
      FROM document_organization_checkpoints
      ORDER BY actor_digest, source_sha256
      LIMIT ?
    `).all(ROW_LIMIT) as unknown as CheckpointRow[];
    const records = rows.map(inspectRow).sort((left, right) =>
      (left.checkpoint_ref_digest ?? "").localeCompare(right.checkpoint_ref_digest ?? ""));
    const omittedCheckpointCount = checkpointCount - records.length;
    const residualCheckpointCount = records.filter((record) => record.integrity === "residuals_present").length;
    const unresolvedCheckpointCount = records.filter((record) => record.integrity === "verified" &&
      record.checkpoint_status !== null && record.checkpoint_status !== "completed").length;
    const residualCount = residualCheckpointCount + omittedCheckpointCount + unresolvedCheckpointCount;
    return {
      status: residualCount === 0 ? "verified" : "residuals_present",
      reason: residualCheckpointCount > 0 ? "ledger_corrupt" : omittedCheckpointCount > 0 ? "row_limit_reached"
        : unresolvedCheckpointCount > 0 ? "unfinished_checkpoints" : null,
      checkpoint_count: checkpointCount,
      verified_checkpoint_count: records.length - residualCheckpointCount,
      residual_checkpoint_count: residualCheckpointCount,
      omitted_checkpoint_count: omittedCheckpointCount,
      unresolved_checkpoint_count: unresolvedCheckpointCount,
      residual_count: residualCount,
      records,
      used_for_authority: false,
    };
  } catch {
    return unavailableInspection("unavailable", "store_unavailable");
  } finally {
    if (database) {
      try { database.exec("ROLLBACK"); } catch { /* keep the read-only inspection result */ }
      try { database.close(); } catch { /* keep the read-only inspection result */ }
    }
  }
}
