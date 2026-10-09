import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { DocumentOrganizationCheckpoint } from "@blue-tanuki/hds-brain";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const MAX_CHECKPOINTS = 128;

export interface DocumentOrganizationCheckpointIdentity {
  readonly channel: "cli" | "webchat";
  readonly actor: string;
  readonly source_sha256: string;
}

export interface StoredDocumentOrganizationCheckpoint {
  readonly checkpoint: unknown;
  readonly digest: string;
  readonly created: boolean;
}

export class DocumentOrganizationCheckpointCapacityError extends Error {
  constructor() {
    super("document_organization_checkpoint_capacity_reached");
    this.name = "DocumentOrganizationCheckpointCapacityError";
  }
}

export class DocumentOrganizationCheckpointConflictError extends Error {
  constructor() {
    super("document_organization_checkpoint_concurrent_update");
    this.name = "DocumentOrganizationCheckpointConflictError";
  }
}

export class DocumentOrganizationCheckpointIntegrityError extends Error {
  constructor() {
    super("document_organization_checkpoint_integrity_failed");
    this.name = "DocumentOrganizationCheckpointIntegrityError";
  }
}

/**
 * Local, non-authority J recovery metadata. The SQLite payload contains only
 * source/actor digests, confirmed UTF-16 span offsets and fixed J state.
 */
export class DocumentOrganizationCheckpointStore {
  private readonly database: DatabaseSyncType;

  constructor(filepath: string) {
    const absolutePath = resolve(filepath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    let database: DatabaseSyncType | undefined;
    try {
      database = new DatabaseSync(absolutePath);
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("PRAGMA synchronous = EXTRA");
      database.exec("PRAGMA foreign_keys = ON");
      initializeSchema(database);
      this.database = database;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the original initialization failure.
      }
      throw error;
    }
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DocumentOrganizationCheckpointStore {
    const root = env.BLUE_TANUKI_FILE_ROOT
      ? resolve(env.BLUE_TANUKI_FILE_ROOT)
      : resolve(cwd, ".blue-tanuki");
    return new DocumentOrganizationCheckpointStore(join(root, "document-organization", "j-checkpoints.sqlite"));
  }

  getOrCreate(
    identity: DocumentOrganizationCheckpointIdentity,
    initial: DocumentOrganizationCheckpoint,
  ): StoredDocumentOrganizationCheckpoint {
    validateBinding(identity, initial);
    return this.inTransaction(() => {
      const current = this.readRow(identity);
      if (current) return Object.freeze({ ...current, created: false });
      this.makeRoomForTask();
      const checkpointJson = JSON.stringify(initial);
      const digest = checkpointDigest(identity, checkpointJson);
      this.database.prepare(`
        INSERT INTO document_organization_checkpoints
          (actor_digest, source_sha256, status, checkpoint_json, checkpoint_digest, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(actorDigest(identity), identity.source_sha256, initial.status, checkpointJson, digest, Date.now());
      return Object.freeze({ checkpoint: initial, digest, created: true });
    });
  }

  load(identity: DocumentOrganizationCheckpointIdentity): StoredDocumentOrganizationCheckpoint | null {
    return this.readRow(identity);
  }

  compareAndSet(
    identity: DocumentOrganizationCheckpointIdentity,
    expectedDigest: string,
    checkpoint: DocumentOrganizationCheckpoint,
  ): StoredDocumentOrganizationCheckpoint {
    validateBinding(identity, checkpoint);
    return this.inTransaction(() => {
      const current = this.readRow(identity);
      if (!current || current.digest !== expectedDigest) {
        throw new DocumentOrganizationCheckpointConflictError();
      }
      const checkpointJson = JSON.stringify(checkpoint);
      const digest = checkpointDigest(identity, checkpointJson);
      const result = this.database.prepare(`
        UPDATE document_organization_checkpoints
        SET status = ?, checkpoint_json = ?, checkpoint_digest = ?, updated_at = ?
        WHERE actor_digest = ? AND source_sha256 = ? AND checkpoint_digest = ?
      `).run(checkpoint.status, checkpointJson, digest, Date.now(), actorDigest(identity), identity.source_sha256, expectedDigest);
      if (result.changes !== 1) throw new DocumentOrganizationCheckpointConflictError();
      return Object.freeze({ checkpoint, digest, created: false });
    });
  }

  close(): void {
    this.database.close();
  }

  private readRow(identity: DocumentOrganizationCheckpointIdentity): StoredDocumentOrganizationCheckpoint | null {
    const row = this.database.prepare(`
      SELECT status, checkpoint_json, checkpoint_digest
      FROM document_organization_checkpoints
      WHERE actor_digest = ? AND source_sha256 = ?
    `).get(actorDigest(identity), identity.source_sha256) as {
      status?: unknown;
      checkpoint_json?: unknown;
      checkpoint_digest?: unknown;
    } | undefined;
    if (!row) return null;
    if (typeof row.status !== "string" || typeof row.checkpoint_json !== "string" ||
        typeof row.checkpoint_digest !== "string" ||
        row.checkpoint_digest !== checkpointDigest(identity, row.checkpoint_json)) {
      throw new DocumentOrganizationCheckpointIntegrityError();
    }
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(row.checkpoint_json) as unknown;
    } catch {
      throw new DocumentOrganizationCheckpointIntegrityError();
    }
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) ||
        (checkpoint as { status?: unknown }).status !== row.status ||
        (checkpoint as { source_sha256?: unknown }).source_sha256 !== identity.source_sha256) {
      throw new DocumentOrganizationCheckpointIntegrityError();
    }
    return Object.freeze({ checkpoint, digest: row.checkpoint_digest, created: false });
  }

  private makeRoomForTask(): void {
    const countRow = this.database.prepare(
      "SELECT COUNT(*) AS count FROM document_organization_checkpoints",
    ).get() as { count?: number | bigint } | undefined;
    const count = Number(countRow?.count ?? 0);
    if (count < MAX_CHECKPOINTS) return;
    this.database.prepare(`
      DELETE FROM document_organization_checkpoints
      WHERE rowid = (
        SELECT rowid FROM document_organization_checkpoints
        WHERE status IN ('completed', 'held')
        ORDER BY updated_at ASC, rowid ASC
        LIMIT 1
      )
    `).run();
    const afterDelete = this.database.prepare(
      "SELECT COUNT(*) AS count FROM document_organization_checkpoints",
    ).get() as { count?: number | bigint } | undefined;
    if (Number(afterDelete?.count ?? 0) >= MAX_CHECKPOINTS) {
      throw new DocumentOrganizationCheckpointCapacityError();
    }
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the operation failure.
      }
      throw error;
    }
  }
}

function initializeSchema(database: DatabaseSyncType): void {
  const existing = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_organization_checkpoints'",
  ).get() as { sql?: unknown } | undefined;
  if (!existing) {
    database.exec(`
      CREATE TABLE document_organization_checkpoints (
        actor_digest TEXT NOT NULL CHECK(length(actor_digest) = 64),
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
        status TEXT NOT NULL CHECK(status IN ('ready', 'continuing', 'completed', 'held')),
        checkpoint_json TEXT NOT NULL,
        checkpoint_digest TEXT NOT NULL CHECK(length(checkpoint_digest) = 64),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        PRIMARY KEY(actor_digest, source_sha256)
      ) STRICT
    `);
    return;
  }
  const columns = database.prepare(
    "PRAGMA table_info(document_organization_checkpoints)",
  ).all() as Array<{ name?: unknown; type?: unknown; notnull?: unknown; pk?: unknown }>;
  const expected = [
    ["actor_digest", "TEXT", 1, 1],
    ["source_sha256", "TEXT", 1, 2],
    ["status", "TEXT", 1, 0],
    ["checkpoint_json", "TEXT", 1, 0],
    ["checkpoint_digest", "TEXT", 1, 0],
    ["updated_at", "INTEGER", 1, 0],
  ];
  if (columns.length !== expected.length || columns.some((column, index) => {
    const item = expected[index];
    return !item || column.name !== item[0] || column.type !== item[1] ||
      Number(column.notnull) !== item[2] || Number(column.pk) !== item[3];
  })) {
    throw new DocumentOrganizationCheckpointIntegrityError();
  }
}

function validateBinding(identity: DocumentOrganizationCheckpointIdentity, checkpoint: DocumentOrganizationCheckpoint): void {
  if ((identity.channel !== "cli" && identity.channel !== "webchat") ||
      typeof identity.actor !== "string" || identity.actor.length === 0 || identity.actor.length > 256 ||
      !/^[a-f0-9]{64}$/u.test(identity.source_sha256) ||
      checkpoint.source_sha256 !== identity.source_sha256 ||
      typeof checkpoint.task_id !== "string" || typeof checkpoint.request_id !== "string") {
    throw new DocumentOrganizationCheckpointIntegrityError();
  }
}

function actorDigest(identity: DocumentOrganizationCheckpointIdentity): string {
  return createHash("sha256")
    .update(`${identity.channel.length}:${identity.channel}|${identity.actor.length}:${identity.actor}`)
    .digest("hex");
}

function checkpointDigest(identity: DocumentOrganizationCheckpointIdentity, checkpointJson: string): string {
  return createHash("sha256")
    .update(`${actorDigest(identity)}|${identity.source_sha256}|${checkpointJson}`)
    .digest("hex");
}
