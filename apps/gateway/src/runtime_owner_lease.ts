import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { currentHostAudienceDigest, isHostAudienceDigest } from "./host_audience_identity.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const OWNER_STATE_SCHEMA_VERSION = 2;
const RECOVERY_FENCE_SCHEMA_VERSION = 3;
const OWNER_UUID = /^[0-9a-f-]{36}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const FACTORY_BACKUP_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.pre_factory_reset\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RuntimeRecoveryFenceEvidence {
  readonly operation: "recovery.factory_reset";
  readonly command_digest: string;
  readonly backup_id: string;
  readonly manifest_sha256: string;
}

export type RuntimeRecoveryFenceInspection =
  | { readonly status: "clear" | "unavailable" }
  | { readonly status: "pending"; readonly operation: RuntimeRecoveryFenceEvidence["operation"];
      readonly command_digest: string; readonly backup_id: string; readonly manifest_sha256: string };

type OwnerGeneration = { generation: number; execution_epoch: string; updated_at_ms: number };
type OwnerStateRow = OwnerGeneration & { host_audience_digest: string };

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
        "gateway_host_audience_identity_unavailable", "gateway_runtime_recovery_pending"].includes(error.message)) throw error;
      if (isSqliteBusy(error)) throw new Error("gateway_runtime_owner_already_active");
      throw new Error("gateway_runtime_owner_state_unavailable");
    }
  }

  assertActive(): void {
    // DatabaseSync.isTransaction was added in Node 22.16. The bundled
    // Node 22.14 baseline has no such property; this private connection is
    // otherwise held for the lease lifetime and is never committed here.
    if (this.closed || this.lockDb.isTransaction === false) throw new Error("gateway_runtime_owner_lease_lost");
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

  /** A deny-only boundary. The caller already owns the L3 and mutation admission checks. */
  beginRecoveryMutation(evidence: RuntimeRecoveryFenceEvidence): void {
    this.assertActive();
    const record = parseRecoveryFenceEvidence(evidence);
    ownerStateTransaction(this.stateDb, () => {
      if (pragmaInteger(this.stateDb, "user_version") !== OWNER_STATE_SCHEMA_VERSION ||
          hasRecoveryFence(this.stateDb)) throw new Error("gateway_runtime_recovery_fence_unavailable");
      this.stateDb.exec(`CREATE TABLE gateway_recovery_fence (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), evidence_json TEXT NOT NULL, digest TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=${RECOVERY_FENCE_SCHEMA_VERSION};`);
      this.stateDb.prepare("INSERT INTO gateway_recovery_fence VALUES(1,?,?)").run(
        JSON.stringify(record), recoveryFenceDigest(record, this.generation, this.executionEpoch),
      );
    });
  }

  /** Only the live lease that started the exact, now-verified mutation can settle this boundary. */
  finishRecoveryMutation(evidence: RuntimeRecoveryFenceEvidence): void {
    this.assertActive();
    const expected = parseRecoveryFenceEvidence(evidence);
    ownerStateTransaction(this.stateDb, () => {
      if (pragmaInteger(this.stateDb, "user_version") !== RECOVERY_FENCE_SCHEMA_VERSION ||
          JSON.stringify(readRecoveryFence(this.stateDb, this.generation, this.executionEpoch)) !== JSON.stringify(expected)) {
        throw new Error("gateway_runtime_recovery_fence_mismatch");
      }
      this.stateDb.exec(`DROP TABLE gateway_recovery_fence;
        PRAGMA user_version=${OWNER_STATE_SCHEMA_VERSION};`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeDatabase(this.stateDb);
    closeDatabase(this.lockDb);
  }
}

/** The diagnostic never opens the normal owner lease, creates a state root, or clears a hold. */
export function inspectRuntimeRecoveryFence(env: NodeJS.ProcessEnv = process.env): RuntimeRecoveryFenceInspection {
  let db: DatabaseType | undefined;
  try {
    const configuredRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    if (!statIfPresent(configuredRoot)) return { status: "clear" };
    const root = realpathSync(configuredRoot);
    const privateRoot = join(root, "private-state");
    const directory = join(privateRoot, "gateway-runtime");
    for (const dir of [privateRoot, directory]) {
      const stat = statIfPresent(dir);
      if (!stat) return { status: "clear" };
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "unavailable" };
    }
    const filepath = join(directory, "owner-state.sqlite");
    const stat = statIfPresent(filepath);
    if (!stat) return { status: statIfPresent(join(directory, "owner-lock.sqlite")) ? "unavailable" : "clear" };
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unavailable" };
    if (["-journal", "-wal", "-shm"].some(suffix => statIfPresent(filepath + suffix))) return { status: "unavailable" };
    db = new DatabaseSync(filepath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN");
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== "delete") return { status: "unavailable" };
    assertIntegrity(db);
    const version = pragmaInteger(db, "user_version");
    if (version === 1 && hasOwnerStateSchemaV1(db) && !hasRecoveryFence(db)) {
      const legacy = db.prepare("SELECT generation, execution_epoch, updated_at_ms FROM gateway_owner_state WHERE singleton=1")
        .get() as OwnerGeneration | undefined;
      return { status: legacy && validOwnerGeneration(legacy) ? "clear" : "unavailable" };
    }
    if (!hasOwnerStateSchema(db)) return { status: "unavailable" };
    const owner = readOwnerState(db);
    if (!owner || !validOwnerGeneration(owner) || !isHostAudienceDigest(owner.host_audience_digest)) {
      return { status: "unavailable" };
    }
    if (version === OWNER_STATE_SCHEMA_VERSION && !hasRecoveryFence(db)) return { status: "clear" };
    if (version !== RECOVERY_FENCE_SCHEMA_VERSION) return { status: "unavailable" };
    const evidence = readRecoveryFence(db, owner.generation, owner.execution_epoch);
    return { status: "pending", ...evidence };
  } catch {
    return { status: "unavailable" };
  } finally {
    closeDatabase(db);
  }
}

function statIfPresent(filepath: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(filepath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseRecoveryFenceEvidence(value: unknown): RuntimeRecoveryFenceEvidence {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 4) {
    throw new Error("gateway_runtime_recovery_fence_invalid");
  }
  const row = value as Record<string, unknown>;
  if (row.operation !== "recovery.factory_reset" || typeof row.command_digest !== "string" || !DIGEST.test(row.command_digest) ||
      typeof row.manifest_sha256 !== "string" || !DIGEST.test(row.manifest_sha256) ||
      typeof row.backup_id !== "string" || !FACTORY_BACKUP_ID.test(row.backup_id) ||
      !["operation", "command_digest", "backup_id", "manifest_sha256"].every(key => Object.hasOwn(row, key))) {
    throw new Error("gateway_runtime_recovery_fence_invalid");
  }
  return { operation: row.operation, command_digest: row.command_digest, backup_id: row.backup_id, manifest_sha256: row.manifest_sha256 };
}

function recoveryFenceDigest(evidence: RuntimeRecoveryFenceEvidence, generation: number, epoch: string): string {
  return createHash("sha256").update(JSON.stringify(["gateway-recovery-fence.v1", generation, epoch, evidence])).digest("hex");
}

function hasRecoveryFence(db: DatabaseType): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='gateway_recovery_fence'").get();
}

function readRecoveryFence(db: DatabaseType, generation: number, epoch: string): RuntimeRecoveryFenceEvidence {
  const rows = db.prepare("SELECT singleton,evidence_json,digest FROM gateway_recovery_fence LIMIT 2").all() as Array<{
    singleton: number; evidence_json: string; digest: string;
  }>;
  const [row] = rows;
  if (rows.length !== 1 || row?.singleton !== 1) throw new Error("gateway_runtime_recovery_fence_invalid");
  const evidence = parseRecoveryFenceEvidence(JSON.parse(row.evidence_json));
  if (row.digest !== recoveryFenceDigest(evidence, generation, epoch)) throw new Error("gateway_runtime_recovery_fence_invalid");
  return evidence;
}

function ownerStateTransaction(db: DatabaseType, apply: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    apply();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Keep the original persistence failure. */ }
    throw error;
  }
}

function readOwnerState(db: DatabaseType): OwnerStateRow | undefined {
  return db.prepare(
    "SELECT generation, execution_epoch, updated_at_ms, host_audience_digest FROM gateway_owner_state WHERE singleton=1",
  ).get() as OwnerStateRow | undefined;
}

function validOwnerGeneration(state: OwnerGeneration): boolean {
  return Number.isSafeInteger(state.generation) && state.generation > 0 &&
    OWNER_UUID.test(state.execution_epoch) && Number.isSafeInteger(state.updated_at_ms) &&
    state.updated_at_ms > 0;
}

function advanceOwnerState(db: DatabaseType, hostAudienceDigest: string): OwnerStateRow {
  let transaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    const version = pragmaInteger(db, "user_version");
    if (version === RECOVERY_FENCE_SCHEMA_VERSION) {
      assertIntegrity(db);
      if (!hasOwnerStateSchema(db)) throw new Error("owner schema invalid");
      const owner = readOwnerState(db);
      if (!owner || !validOwnerGeneration(owner) || !isHostAudienceDigest(owner.host_audience_digest)) {
        throw new Error("owner generation invalid");
      }
      if (owner.host_audience_digest !== hostAudienceDigest) throw new Error("gateway_runtime_owner_host_identity_mismatch");
      readRecoveryFence(db, owner.generation, owner.execution_epoch);
      // Version 3 is reserved for unsettled mutations. Older gateways also reject it.
      throw new Error("gateway_runtime_recovery_pending");
    }
    if (hasRecoveryFence(db)) throw new Error("owner recovery fence version invalid");
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

    const previous = readOwnerState(db);
    if (version !== 0 && (!previous || !validOwnerGeneration(previous) ||
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
    if (error instanceof Error && ["gateway_runtime_owner_host_identity_mismatch", "gateway_runtime_recovery_pending"].includes(error.message)) throw error;
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
