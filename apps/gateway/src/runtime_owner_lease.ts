import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { currentHostAudienceDigest, isHostAudienceDigest } from "./host_audience_identity.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const OWNER_STATE_SCHEMA_VERSION = 2;
const OWNER_UUID = /^[0-9a-f-]{36}$/i;

type OwnerStateRow = { generation: number; execution_epoch: string; updated_at_ms: number; host_audience_digest: string };

/** Same-state-root Gateway processes are serialized by an OS-released SQLite transaction. */
export class GatewayRuntimeOwnerLease {
  private closed = false;

  private constructor(
    private readonly lockDb: DatabaseType,
    private readonly stateDb: DatabaseType,
    readonly generation: number,
    readonly executionEpoch: string,
    readonly hostAudienceDigest: string,
  ) {}

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    hostAudienceDigest = currentHostAudienceDigest(),
  ): GatewayRuntimeOwnerLease {
    if (!isHostAudienceDigest(hostAudienceDigest)) throw new Error("gateway_host_audience_identity_unavailable");
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "gateway-runtime");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("gateway_runtime_owner_state_unavailable");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }

    const lockPath = join(directory, "owner-lock.sqlite");
    const statePath = join(directory, "owner-state.sqlite");
    for (const filepath of [lockPath, statePath]) {
      try {
        const stat = lstatSync(filepath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("gateway_runtime_owner_state_unavailable");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    let lockDb: DatabaseType | undefined;
    let stateDb: DatabaseType | undefined;
    try {
      lockDb = new DatabaseSync(lockPath);
      if (process.platform !== "win32") chmodSync(lockPath, 0o600);
      lockDb.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA");
      try {
        lockDb.exec("BEGIN EXCLUSIVE");
      } catch {
        throw new Error("gateway_runtime_owner_already_active");
      }
      assertIntegrity(lockDb);

      stateDb = new DatabaseSync(statePath);
      if (process.platform !== "win32") chmodSync(statePath, 0o600);
      stateDb.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
      const state = advanceOwnerState(stateDb, hostAudienceDigest);
      return new GatewayRuntimeOwnerLease(lockDb, stateDb, state.generation, state.execution_epoch, state.host_audience_digest);
    } catch (error) {
      closeDatabase(stateDb);
      closeDatabase(lockDb);
      if (error instanceof Error && ["gateway_runtime_owner_already_active", "gateway_runtime_owner_host_identity_mismatch",
        "gateway_host_audience_identity_unavailable"].includes(error.message)) throw error;
      if (isSqliteBusy(error)) throw new Error("gateway_runtime_owner_already_active");
      throw new Error("gateway_runtime_owner_state_unavailable");
    }
  }

  assertActive(): void {
    if (this.closed || !this.lockDb.isTransaction) throw new Error("gateway_runtime_owner_lease_lost");
    try {
      const row = this.stateDb.prepare(
        "SELECT generation, execution_epoch, host_audience_digest FROM gateway_owner_state WHERE singleton=1",
      ).get() as Pick<OwnerStateRow, "generation" | "execution_epoch" | "host_audience_digest"> | undefined;
      if (row?.generation !== this.generation || row.execution_epoch !== this.executionEpoch ||
          row.host_audience_digest !== this.hostAudienceDigest) {
        throw new Error("gateway_runtime_owner_lease_lost");
      }
    } catch {
      throw new Error("gateway_runtime_owner_lease_lost");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeDatabase(this.stateDb);
    closeDatabase(this.lockDb);
  }
}

function advanceOwnerState(db: DatabaseType, hostAudienceDigest: string): OwnerStateRow {
  let transaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    const version = pragmaInteger(db, "user_version");
    if (version === 0) {
      const existing = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_owner_state'",
      ).get();
      if (existing) throw new Error("owner schema version missing");
      db.exec(`CREATE TABLE gateway_owner_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        generation INTEGER NOT NULL CHECK(generation > 0),
        execution_epoch TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        host_audience_digest TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=${OWNER_STATE_SCHEMA_VERSION};`);
    } else if (version === 1 && hasOwnerStateSchemaV1(db)) {
      // Migration binds the old state to this host and rotates the owner epoch below,
      // making every pre-migration execution ticket unusable.
      db.exec("ALTER TABLE gateway_owner_state ADD COLUMN host_audience_digest TEXT NOT NULL DEFAULT ''");
      db.prepare("UPDATE gateway_owner_state SET host_audience_digest=? WHERE singleton=1").run(hostAudienceDigest);
      db.exec(`PRAGMA user_version=${OWNER_STATE_SCHEMA_VERSION}`);
    } else if (version !== OWNER_STATE_SCHEMA_VERSION || !hasOwnerStateSchema(db)) {
      throw new Error("owner schema invalid");
    }

    const previous = db.prepare(
      "SELECT generation, execution_epoch, updated_at_ms, host_audience_digest FROM gateway_owner_state WHERE singleton=1",
    ).get() as OwnerStateRow | undefined;
    if (version !== 0 && (!previous || !Number.isSafeInteger(previous.generation) || previous.generation < 1 ||
        !OWNER_UUID.test(previous.execution_epoch) || !Number.isSafeInteger(previous.updated_at_ms) || previous.updated_at_ms <= 0 ||
        previous.host_audience_digest !== hostAudienceDigest)) {
      if (previous?.host_audience_digest && previous.host_audience_digest !== hostAudienceDigest) {
        throw new Error("gateway_runtime_owner_host_identity_mismatch");
      }
      throw new Error("owner generation invalid");
    }
    const state: OwnerStateRow = {
      generation: previous ? previous.generation + 1 : 1,
      execution_epoch: randomUUID(),
      updated_at_ms: Date.now(),
      host_audience_digest: hostAudienceDigest,
    };
    if (!Number.isSafeInteger(state.generation)) throw new Error("owner generation exhausted");
    db.prepare(`INSERT INTO gateway_owner_state(singleton, generation, execution_epoch, updated_at_ms, host_audience_digest)
      VALUES(1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      generation=excluded.generation, execution_epoch=excluded.execution_epoch,
      updated_at_ms=excluded.updated_at_ms, host_audience_digest=excluded.host_audience_digest`)
      .run(state.generation, state.execution_epoch, state.updated_at_ms, state.host_audience_digest);
    assertIntegrity(db);
    db.exec("COMMIT");
    transaction = false;
    return state;
  } catch (error) {
    if (transaction) {
      try { db.exec("ROLLBACK"); } catch { /* closing the database releases any remaining transaction */ }
    }
    if (error instanceof Error && error.message === "gateway_runtime_owner_host_identity_mismatch") throw error;
    throw new Error("gateway_runtime_owner_state_unavailable");
  }
}

function hasOwnerStateSchema(db: DatabaseType): boolean {
  const rows = db.prepare("PRAGMA table_info(gateway_owner_state)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>;
  const expected = [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "execution_epoch", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "host_audience_digest", type: "TEXT", notnull: 1, pk: 0 },
  ];
  return rows.length === expected.length && expected.every((column, index) => {
    const actual = rows[index];
    return actual?.name === column.name && actual.type === column.type &&
      actual.notnull === column.notnull && actual.pk === column.pk;
  });
}

function hasOwnerStateSchemaV1(db: DatabaseType): boolean {
  const rows = db.prepare("PRAGMA table_info(gateway_owner_state)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>;
  const expected = [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "execution_epoch", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
  ];
  return rows.length === expected.length && expected.every((column, index) => {
    const actual = rows[index];
    return actual?.name === column.name && actual.type === column.type &&
      actual.notnull === column.notnull && actual.pk === column.pk;
  });
}

function pragmaInteger(db: DatabaseType, name: "user_version"): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("gateway_runtime_owner_state_unavailable");
  }
  return value;
}

function assertIntegrity(db: DatabaseType): void {
  const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
  if (Object.values(row ?? {})[0] !== "ok") throw new Error("gateway_runtime_owner_state_unavailable");
}

function closeDatabase(db: DatabaseType | undefined): void {
  if (!db) return;
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch { /* close still releases the native lock */ }
  try { db.close(); } catch { /* best-effort cleanup after failed startup */ }
}

function isSqliteBusy(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code === "EBUSY" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ||
    message.includes("database is locked") || message.includes("database is busy");
}
