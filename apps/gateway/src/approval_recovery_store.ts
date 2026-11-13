import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

export type ApprovalRecoveryState = "pending" | "resolving" | "interrupted" | "outcome_unknown";

export interface InterruptedApprovalRecoverySnapshot {
  readonly command_id_digest: string;
  readonly request_id_digest: string;
  readonly state: "interrupted" | "outcome_unknown";
  readonly timestamp_ms: number;
}

interface ApprovalRecoveryRow {
  command_id_digest: string;
  request_id_digest: string;
  state: string;
  created_at_ms: number;
  updated_at_ms: number;
}

const STORE_SCHEMA_VERSION = 1;
const MAX_UNRESOLVED_APPROVALS = 4096;
const DIGEST = /^[a-f0-9]{64}$/u;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function digestId(kind: "command" | "request", value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error("approval_recovery_identifier_invalid");
  }
  return createHash("sha256").update(`blue-tanuki.approval-recovery.${kind}.v1\0${value}`, "utf8").digest("hex");
}

export function approvalRecoveryCommandIdDigest(value: string): string {
  return digestId("command", value);
}

function parseRow(row: ApprovalRecoveryRow): InterruptedApprovalRecoverySnapshot {
  if (!DIGEST.test(row.command_id_digest) || !DIGEST.test(row.request_id_digest) ||
      (row.state !== "interrupted" && row.state !== "outcome_unknown") ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < row.created_at_ms) {
    throw new Error("approval_recovery_store_invalid");
  }
  return {
    command_id_digest: row.command_id_digest,
    request_id_digest: row.request_id_digest,
    state: row.state,
    timestamp_ms: row.updated_at_ms,
  };
}

/** Durable digest-only interruption evidence. It cannot reconstruct or authorize an approval. */
export class GatewayApprovalRecoveryStore {
  private readonly db: DatabaseType;
  private closed = false;

  constructor(filepath: string) {
    const absolutePath = resolve(filepath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    try {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("approval_recovery_store_file_must_be_regular");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      closeSync(openSync(absolutePath, "wx", 0o600));
    }
    this.db = new DatabaseSync(absolutePath);
    try {
      if (process.platform !== "win32") chmodSync(absolutePath, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== STORE_SCHEMA_VERSION) {
        throw new Error("approval_recovery_store_version_unsupported");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS approval_recovery (
          command_id_digest TEXT PRIMARY KEY CHECK(length(command_id_digest)=64 AND command_id_digest NOT GLOB '*[^0-9a-f]*'),
          request_id_digest TEXT NOT NULL CHECK(length(request_id_digest)=64 AND request_id_digest NOT GLOB '*[^0-9a-f]*'),
          state TEXT NOT NULL CHECK(state IN ('pending','resolving','interrupted','outcome_unknown')),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
        ) STRICT;
      `);
      if (version.user_version === 0) this.db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
      this.assertIntegrity();
      this.recoverPriorProcess();
      this.listInterrupted();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayApprovalRecoveryStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("approval_recovery_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "approval-recovery");
    for (const path of [privateRoot, directory]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (lstatSync(path).isSymbolicLink()) throw new Error("approval_recovery_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(path, 0o700);
    }
    return new GatewayApprovalRecoveryStore(join(directory, "approval-recovery.sqlite"));
  }

  recordPending(commandId: string, requestId: string): void {
    this.assertOpen();
    const commandDigest = digestId("command", commandId);
    const requestDigest = digestId("request", requestId);
    const now = Date.now();
    this.transaction(() => {
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM approval_recovery").get() as { count: number };
      if (!Number.isSafeInteger(count.count) || count.count >= MAX_UNRESOLVED_APPROVALS) {
        throw new Error("approval_recovery_store_capacity_exceeded");
      }
      this.db.prepare(`INSERT INTO approval_recovery
        (command_id_digest,request_id_digest,state,created_at_ms,updated_at_ms) VALUES (?,?, 'pending',?,?)`)
        .run(commandDigest, requestDigest, now, now);
    });
  }

  state(commandId: string): ApprovalRecoveryState | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT state FROM approval_recovery WHERE command_id_digest=?")
      .get(digestId("command", commandId)) as { state: string } | undefined;
    if (!row) return null;
    if (row.state !== "pending" && row.state !== "resolving" && row.state !== "interrupted" && row.state !== "outcome_unknown") {
      throw new Error("approval_recovery_store_invalid");
    }
    return row.state;
  }

  beginResolution(commandId: string): boolean {
    this.assertOpen();
    const now = Date.now();
    const result = this.db.prepare(`UPDATE approval_recovery SET state='resolving',updated_at_ms=MAX(updated_at_ms,?)
      WHERE command_id_digest=? AND state='pending'`).run(now, digestId("command", commandId));
    return result.changes === 1;
  }

  clearPending(commandId: string): void {
    this.assertOpen();
    this.db.prepare("DELETE FROM approval_recovery WHERE command_id_digest=? AND state='pending'")
      .run(digestId("command", commandId));
  }

  completeResolution(commandId: string): void {
    this.assertOpen();
    this.db.prepare("DELETE FROM approval_recovery WHERE command_id_digest=? AND state='resolving'")
      .run(digestId("command", commandId));
  }

  markOutcomeUnknown(commandId: string): void {
    this.assertOpen();
    const now = Date.now();
    this.db.prepare(`UPDATE approval_recovery SET state='outcome_unknown',updated_at_ms=MAX(updated_at_ms,?)
      WHERE command_id_digest=? AND state='resolving'`).run(now, digestId("command", commandId));
  }

  listInterrupted(): InterruptedApprovalRecoverySnapshot[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT command_id_digest,request_id_digest,state,created_at_ms,updated_at_ms
      FROM approval_recovery WHERE state IN ('interrupted','outcome_unknown')
      ORDER BY updated_at_ms ASC,command_id_digest ASC`).all() as unknown as ApprovalRecoveryRow[];
    if (rows.length > MAX_UNRESOLVED_APPROVALS) throw new Error("approval_recovery_store_capacity_invalid");
    return rows.map(parseRow);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private recoverPriorProcess(): void {
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare("UPDATE approval_recovery SET state='interrupted',updated_at_ms=MAX(updated_at_ms,?) WHERE state='pending'").run(now);
      this.db.prepare("UPDATE approval_recovery SET state='outcome_unknown',updated_at_ms=MAX(updated_at_ms,?) WHERE state='resolving'").run(now);
    });
  }

  private assertIntegrity(): void {
    const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
    if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("approval_recovery_store_integrity_check_failed");
    const invalid = this.db.prepare(`SELECT 1 AS invalid FROM approval_recovery
      WHERE length(command_id_digest)<>64 OR command_id_digest GLOB '*[^0-9a-f]*' OR
        length(request_id_digest)<>64 OR request_id_digest GLOB '*[^0-9a-f]*' OR
        state NOT IN ('pending','resolving','interrupted','outcome_unknown') OR
        created_at_ms<0 OR updated_at_ms<created_at_ms LIMIT 1`).get();
    if (invalid) throw new Error("approval_recovery_store_invalid");
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM approval_recovery").get() as { count: number };
    if (!Number.isSafeInteger(count.count) || count.count > MAX_UNRESOLVED_APPROVALS) {
      throw new Error("approval_recovery_store_capacity_invalid");
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Keep the original persistence failure. */ }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("approval_recovery_store_closed");
  }
}
