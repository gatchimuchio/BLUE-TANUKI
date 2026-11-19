import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { currentHostAudienceDigest, isHostAudienceDigest } from "./host_audience_identity.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const OWNER_STATE_SCHEMA_VERSION = 2;
const RECOVERY_FENCE_SCHEMA_VERSION = 3;
const OWNER_UUID = /^[0-9a-f-]{36}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const FACTORY_BACKUP_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.pre_factory_reset\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPLICIT_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const GOAL_PURPOSE_REPAIR_MAX_HANDOFF_MS = 5 * 60_000;

interface RecoveryVerification {
  readonly before_sha256: string;
  readonly after_sha256: string;
}

interface RecoveryFenceBinding {
  readonly command_digest: string;
  readonly backup_id: string;
  readonly manifest_sha256: string;
}

interface FactoryResetFenceEvidence extends RecoveryFenceBinding {
  readonly operation: "recovery.factory_reset";
  readonly verification?: RecoveryVerification;
}

export interface GoalPurposeRepairFenceEvidence extends RecoveryFenceBinding {
  readonly operation: "recovery.goal_purpose_repair";
  readonly repair_sha256: string;
  readonly verification: RecoveryVerification;
}

export type RuntimeRecoveryFenceEvidence = FactoryResetFenceEvidence | GoalPurposeRepairFenceEvidence;

export interface OfflineGoalPurposeRepairBinding extends Omit<GoalPurposeRepairFenceEvidence, "operation"> {
  readonly handoff_digest: string;
  readonly expires_at_ms: number;
}

export type OfflineGoalPurposeRepairSelector = Pick<OfflineGoalPurposeRepairBinding,
  "backup_id" | "manifest_sha256" | "repair_sha256" | "handoff_digest">;

export type OfflineGoalPurposeRepairResult = "applied" | "authorization_required" | "authorization_expired" |
  "preflight_changed" | "owner_lock_busy" | "owner_lock_sidecars_present" | "owner_state_unavailable" |
  "recovery_pending" | "outcome_unknown";

export type RuntimeRecoveryFenceInspection =
  | { readonly status: "clear" | "unavailable" }
  | { readonly status: "pending"; readonly operation: RuntimeRecoveryFenceEvidence["operation"];
      readonly command_digest: string; readonly backup_id: string; readonly manifest_sha256: string;
      readonly repair_sha256?: string };

type OwnerGeneration = { generation: number; execution_epoch: string; updated_at_ms: number };
type OwnerStateRow = OwnerGeneration & { host_audience_digest: string };
type OwnerIdentity = Pick<OwnerStateRow, "generation" | "execution_epoch" | "host_audience_digest">;
type PreparedGoalPurposeRepair = { readonly binding: OfflineGoalPurposeRepairBinding; readonly issued_at_ms: number };
type RecoveryFenceTerminalStatus = "pre_action_state_matched" | "postconditions_matched";
export type RuntimeRecoveryFenceReconciliation =
  { readonly status: RecoveryFenceTerminalStatus | "unresolved" | "no_pending" };

export type OfflineGatewayObservation<T> =
  | { readonly status: "verified"; readonly observation: T }
  | { readonly status: "owner_lock_busy" | "owner_lock_sidecars_present" | "recovery_pending" | "owner_state_unavailable" };

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
        if (lstatSync(lockPath).size === 0) {
          // Materialize the empty SQLite database before holding the lease. Otherwise, SQLite keeps
          // an initialization journal open for the process lifetime, so a Windows stop leaves it behind.
          lockDb.exec("PRAGMA user_version=0; COMMIT; BEGIN EXCLUSIVE");
        }
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
  beginRecoveryMutation(evidence: FactoryResetFenceEvidence): void {
    this.assertActive();
    const record = parseRecoveryFenceEvidence(evidence);
    if (record.operation !== "recovery.factory_reset") throw new Error("gateway_runtime_recovery_fence_invalid");
    ownerStateTransaction(this.stateDb, () => {
      persistRecoveryFence(this.stateDb, record, {
        generation: this.generation, execution_epoch: this.executionEpoch, host_audience_digest: this.hostAudienceDigest,
      });
      clearPreparedGoalPurposeRepair(this.stateDb);
    });
  }

  /** Only the live lease that started the exact, now-verified mutation can settle this boundary. */
  finishRecoveryMutation(evidence: FactoryResetFenceEvidence): void {
    this.assertActive();
    const expected = parseRecoveryFenceEvidence(evidence);
    if (expected.operation !== "recovery.factory_reset") throw new Error("gateway_runtime_recovery_fence_invalid");
    ownerStateTransaction(this.stateDb, () => {
      if (pragmaInteger(this.stateDb, "user_version") !== RECOVERY_FENCE_SCHEMA_VERSION ||
          JSON.stringify(readRecoveryFence(this.stateDb, this.generation, this.executionEpoch, this.hostAudienceDigest)) !==
            JSON.stringify(expected)) {
        throw new Error("gateway_runtime_recovery_fence_mismatch");
      }
      clearRecoveryFence(this.stateDb);
    });
  }

  /** Persist one exact L3-authorized handoff from the trusted live preparation path. */
  prepareOfflineGoalPurposeRepair(binding: OfflineGoalPurposeRepairBinding): void {
    this.assertActive();
    const record = parsePreparedGoalPurposeRepair({ binding, issued_at_ms: Date.now() });
    const owner = { generation: this.generation, execution_epoch: this.executionEpoch,
      host_audience_digest: this.hostAudienceDigest };
    ownerStateTransaction(this.stateDb, () => {
      if (pragmaInteger(this.stateDb, "user_version") !== OWNER_STATE_SCHEMA_VERSION || hasRecoveryFence(this.stateDb)) {
        throw new Error("gateway_runtime_recovery_fence_unavailable");
      }
      const previous = readPreparedGoalPurposeRepair(this.stateDb, owner);
      if (previous && record.issued_at_ms < previous.binding.expires_at_ms) {
        throw new Error("gateway_goal_purpose_repair_authorization_pending");
      }
      this.stateDb.exec(`CREATE TABLE IF NOT EXISTS gateway_goal_purpose_repair_authorization (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), evidence_json TEXT NOT NULL, digest TEXT NOT NULL
      ) STRICT;`);
      this.stateDb.prepare(`INSERT INTO gateway_goal_purpose_repair_authorization VALUES(1,?,?)
        ON CONFLICT(singleton) DO UPDATE SET evidence_json=excluded.evidence_json,digest=excluded.digest`).run(
        JSON.stringify(record), goalPurposeRepairAuthorizationDigest(record, owner),
      );
    });
  }

  revokePreparedOfflineGoalPurposeRepair(): void {
    this.assertActive();
    ownerStateTransaction(this.stateDb, () => clearPreparedGoalPurposeRepair(this.stateDb));
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
    const files = existingRuntimeOwnerFiles(env);
    if (!files) return { status: "clear" };
    assertNoOwnerSidecars(files.statePath);
    db = openOwnerDatabaseReadOnly(files.statePath);
    db.exec("PRAGMA query_only=ON; BEGIN");
    assertOwnerDeleteJournal(db);
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
    const evidence = readRecoveryFence(
      db, owner.generation, owner.execution_epoch, owner.host_audience_digest,
    );
    const { operation, command_digest, backup_id, manifest_sha256 } = evidence;
    return { status: "pending", operation, command_digest, backup_id, manifest_sha256,
      ...(evidence.operation === "recovery.goal_purpose_repair" ? { repair_sha256: evidence.repair_sha256 } : {}) };
  } catch {
    return { status: "unavailable" };
  } finally {
    closeDatabase(db);
  }
}

/** Observe an existing stopped Gateway installation without opening or advancing a runtime lease. */
export async function observeUnderOfflineGatewayOwnerLock<T>(
  env: NodeJS.ProcessEnv,
  observe: (ownerScopeSha256: string) => Promise<T>,
): Promise<OfflineGatewayObservation<T>> {
  let lockDb: DatabaseType | undefined;
  let stateDb: DatabaseType | undefined;
  try {
    const files = existingRuntimeOwnerFiles(env);
    if (!files?.lockPath) return { status: "owner_state_unavailable" };
    const { lockPath, statePath } = files;
    const lockIdentity = ownerFileIdentity(lockPath);
    const stateIdentity = ownerFileIdentity(statePath);
    const host = currentHostAudienceDigest();
    lockDb = acquireExistingRuntimeOwnerLock(lockPath);
    const lock = lockDb;
    const assertContinuity = (): void => {
      const current = existingRuntimeOwnerFiles(env);
      if (current?.lockPath !== lockPath || current.statePath !== statePath || lock.isTransaction === false ||
          ownerFileIdentity(lockPath) !== lockIdentity || ownerFileIdentity(statePath) !== stateIdentity ||
          currentHostAudienceDigest() !== host) throw new Error("gateway_runtime_owner_state_unavailable");
      assertNoOwnerSidecars(lockPath);
      assertNoOwnerSidecars(statePath);
    };
    assertContinuity();

    stateDb = openOwnerDatabaseReadOnly(statePath);
    stateDb.exec("PRAGMA query_only=ON; BEGIN");
    assertOwnerDeleteJournal(stateDb);
    assertIntegrity(stateDb);
    const version = pragmaInteger(stateDb, "user_version");
    if (!hasOwnerStateSchema(stateDb)) return { status: "owner_state_unavailable" };
    const owner = readOwnerState(stateDb);
    if (!owner || !validOwnerGeneration(owner) || owner.host_audience_digest !== host) {
      return { status: "owner_state_unavailable" };
    }
    if (version === RECOVERY_FENCE_SCHEMA_VERSION) {
      readRecoveryFence(stateDb, owner.generation, owner.execution_epoch, owner.host_audience_digest);
      return { status: "recovery_pending" };
    }
    if (version !== OWNER_STATE_SCHEMA_VERSION || hasRecoveryFence(stateDb)) {
      return { status: "owner_state_unavailable" };
    }
    assertContinuity();
    const ownerScopeSha256 = createHash("sha256").update(JSON.stringify([
      "offline-gateway-owner-scope.v1", lockPath, lockIdentity, statePath, stateIdentity,
      owner.host_audience_digest, owner.generation, owner.execution_epoch,
    ])).digest("hex");
    const observation = await observe(ownerScopeSha256);
    if (stateDb.isTransaction === false) return { status: "owner_state_unavailable" };
    assertContinuity();

    // Reopen under the same exclusive lock to compare the current row, independent of the initial read transaction.
    stateDb.close();
    stateDb = openOwnerDatabaseReadOnly(statePath);
    stateDb.exec("PRAGMA query_only=ON; BEGIN");
    assertOwnerDeleteJournal(stateDb);
    assertIntegrity(stateDb);
    if (pragmaInteger(stateDb, "user_version") !== OWNER_STATE_SCHEMA_VERSION || !hasOwnerStateSchema(stateDb) ||
        hasRecoveryFence(stateDb) || JSON.stringify(readOwnerState(stateDb)) !== JSON.stringify(owner)) {
      return { status: "owner_state_unavailable" };
    }
    assertContinuity();
    return { status: "verified", observation };
  } catch (error) {
    if (!lockDb && isSqliteBusy(error)) return { status: "owner_lock_busy" };
    if (!lockDb && error instanceof Error && error.message === "gateway_runtime_owner_lock_sidecars_present") {
      return { status: "owner_lock_sidecars_present" };
    }
    return { status: "owner_state_unavailable" };
  } finally {
    closeDatabase(stateDb);
    closeDatabase(lockDb);
  }
}

/** Continue one live L3 handoff without creating an installation or advancing its owner epoch. */
export async function applyUnderOfflineGoalPurposeRepairLock(
  env: NodeJS.ProcessEnv,
  input: OfflineGoalPurposeRepairSelector,
  callbacks: {
    /** Prepare and observe without changing repair targets. Apply runs only after the durable fence. */
    readonly prepare: (binding: OfflineGoalPurposeRepairBinding, issuedAtMs: number) => Promise<null | {
      readonly apply: () => Promise<void>;
      readonly observe: () => Promise<string | null>;
    }>;
  },
): Promise<OfflineGoalPurposeRepairResult> {
  const { backup_id, manifest_sha256, repair_sha256, handoff_digest } = input;
  if (!validExplicitBackupId(backup_id) || !isDigest(manifest_sha256) || !isDigest(repair_sha256) || !isDigest(handoff_digest)) {
    return "authorization_required";
  }
  let lockDb: DatabaseType | undefined;
  let stateDb: DatabaseType | undefined;
  let fenceAttempted = false;
  try {
    const files = existingRuntimeOwnerFiles(env);
    if (!files?.lockPath) return "owner_state_unavailable";
    const { lockPath, statePath } = files;
    const lockIdentity = ownerFileIdentity(lockPath);
    const stateIdentity = ownerFileIdentity(statePath);
    lockDb = acquireExistingRuntimeOwnerLock(lockPath);
    const lock = lockDb;
    stateDb = openOwnerDatabaseForRecovery(statePath);
    const db = stateDb;
    assertIntegrity(db);
    const owner = hasOwnerStateSchema(db) ? readOwnerState(db) : undefined;
    if (!owner || !validOwnerGeneration(owner) || owner.host_audience_digest !== currentHostAudienceDigest()) {
      return "owner_state_unavailable";
    }
    const assertContinuity = (): void => {
      if (lock.isTransaction === false || ownerFileIdentity(lockPath) !== lockIdentity ||
          ownerFileIdentity(statePath) !== stateIdentity || JSON.stringify(readOwnerState(db)) !== JSON.stringify(owner)) {
        throw new Error("gateway_runtime_owner_lease_lost");
      }
    };
    assertContinuity();
    const version = pragmaInteger(db, "user_version");
    if (version === RECOVERY_FENCE_SCHEMA_VERSION) {
      readRecoveryFence(db, owner.generation, owner.execution_epoch, owner.host_audience_digest);
      return "recovery_pending";
    }
    if (version !== OWNER_STATE_SCHEMA_VERSION || hasRecoveryFence(db)) return "owner_state_unavailable";
    const authorization = readPreparedGoalPurposeRepair(db, owner);
    const binding = authorization?.binding;
    if (!authorization || !binding || binding.backup_id !== backup_id || binding.manifest_sha256 !== manifest_sha256 ||
        binding.repair_sha256 !== repair_sha256 ||
        !timingSafeEqual(Buffer.from(binding.handoff_digest, "hex"), Buffer.from(handoff_digest, "hex"))) {
      return "authorization_required";
    }
    if (!goalPurposeRepairAuthorizationCurrent(authorization)) return "authorization_expired";

    let prepared: Awaited<ReturnType<typeof callbacks.prepare>>;
    try {
      prepared = await callbacks.prepare(binding, authorization.issued_at_ms);
      if (!prepared || await prepared.observe() !== binding.verification.before_sha256) return "preflight_changed";
    } catch {
      return "preflight_changed";
    }
    const evidence: GoalPurposeRepairFenceEvidence = { operation: "recovery.goal_purpose_repair",
      command_digest: binding.command_digest, backup_id, manifest_sha256, repair_sha256, verification: binding.verification };
    const assertApplyingFence = (): void => {
      assertContinuity();
      if (pragmaInteger(db, "user_version") !== RECOVERY_FENCE_SCHEMA_VERSION ||
          JSON.stringify(readRecoveryFence(db, owner.generation, owner.execution_epoch, owner.host_audience_digest)) !==
            JSON.stringify(evidence)) throw new Error("gateway_runtime_recovery_fence_mismatch");
    };
    assertContinuity();
    ownerStateTransaction(db, () => {
      assertContinuity();
      const current = readPreparedGoalPurposeRepair(db, owner);
      if (!current || JSON.stringify(current) !== JSON.stringify(authorization)) {
        throw new Error("gateway_goal_purpose_repair_authorization_changed");
      }
      if (!goalPurposeRepairAuthorizationCurrent(current)) throw new Error("gateway_goal_purpose_repair_authorization_expired");
      fenceAttempted = true;
      persistRecoveryFence(db, evidence, owner);
      clearPreparedGoalPurposeRepair(db);
    });
    assertApplyingFence();
    await prepared.apply();
    const after = await prepared.observe();
    if (after !== evidence.verification.after_sha256 || await prepared.observe() !== after) return "outcome_unknown";
    ownerStateTransaction(db, () => {
      assertApplyingFence();
      persistRecoverySettlement(db, owner.generation, evidence, after, "postconditions_matched");
      clearRecoveryFence(db);
    });
    return "applied";
  } catch (error) {
    if (fenceAttempted) return "outcome_unknown";
    if (!lockDb && isSqliteBusy(error)) return "owner_lock_busy";
    if (error instanceof Error) {
      if (!lockDb && error.message === "gateway_runtime_owner_lock_sidecars_present") return "owner_lock_sidecars_present";
      if (error.message === "gateway_goal_purpose_repair_authorization_changed") return "authorization_required";
      if (error.message === "gateway_goal_purpose_repair_authorization_expired") return "authorization_expired";
    }
    return "owner_state_unavailable";
  } finally {
    closeDatabase(stateDb);
    closeDatabase(lockDb);
  }
}

/** Settle existing evidence under the regular Gateway lock, without obtaining a runtime lease or replaying work. */
export async function reconcileRuntimeRecoveryFence(
  env: NodeJS.ProcessEnv,
  expected: Pick<RuntimeRecoveryFenceEvidence, "backup_id" | "manifest_sha256"> &
    Partial<Pick<RuntimeRecoveryFenceEvidence, "command_digest">>,
  observe: (evidence: RuntimeRecoveryFenceEvidence) => Promise<string | null>,
): Promise<RuntimeRecoveryFenceReconciliation> {
  let lockDb: DatabaseType | undefined;
  let stateDb: DatabaseType | undefined;
  try {
    const files = existingRuntimeOwnerFiles(env);
    if (!files) return { status: "no_pending" };
    if (!files.lockPath) return { status: "unresolved" };
    const lockIdentity = ownerFileIdentity(files.lockPath);
    const stateIdentity = ownerFileIdentity(files.statePath);
    lockDb = acquireExistingRuntimeOwnerLock(files.lockPath);

    stateDb = openOwnerDatabaseForRecovery(files.statePath);
    stateDb.exec("BEGIN IMMEDIATE");
    assertIntegrity(stateDb);
    const version = pragmaInteger(stateDb, "user_version");
    if (version === 1 && hasOwnerStateSchemaV1(stateDb) && !hasRecoveryFence(stateDb)) {
      const legacy = stateDb.prepare("SELECT generation, execution_epoch, updated_at_ms FROM gateway_owner_state WHERE singleton=1")
        .get() as OwnerGeneration | undefined;
      return { status: legacy && validOwnerGeneration(legacy) ? "no_pending" : "unresolved" };
    }
    if (!hasOwnerStateSchema(stateDb)) return { status: "unresolved" };
    const owner = readOwnerState(stateDb);
    if (!owner || !validOwnerGeneration(owner) || owner.host_audience_digest !== currentHostAudienceDigest()) {
      return { status: "unresolved" };
    }
    if (version === OWNER_STATE_SCHEMA_VERSION && !hasRecoveryFence(stateDb)) return { status: "no_pending" };
    if (version !== RECOVERY_FENCE_SCHEMA_VERSION) return { status: "unresolved" };
    const evidence = readRecoveryFence(stateDb, owner.generation, owner.execution_epoch, owner.host_audience_digest);
    if (!evidence.verification || evidence.backup_id !== expected.backup_id ||
        evidence.manifest_sha256 !== expected.manifest_sha256 ||
        (expected.command_digest !== undefined && evidence.command_digest !== expected.command_digest)) {
      return { status: "unresolved" };
    }

    const observed = await observe(evidence);
    if (observed === null) return { status: "unresolved" };
    // A reset can be a no-op. Matching both proofs cannot establish that it ran.
    const status = observed === evidence.verification.before_sha256 ? "pre_action_state_matched"
      : observed === evidence.verification.after_sha256 ? "postconditions_matched" : null;
    if (!status || await observe(evidence) !== observed || lockDb.isTransaction === false ||
        ownerFileIdentity(files.lockPath) !== lockIdentity || ownerFileIdentity(files.statePath) !== stateIdentity) {
      return { status: "unresolved" };
    }
    persistRecoverySettlement(stateDb, owner.generation, evidence, observed, status);
    clearRecoveryFence(stateDb);
    stateDb.exec("COMMIT");
    return { status };
  } catch {
    return { status: "unresolved" };
  } finally {
    closeDatabase(stateDb);
    closeDatabase(lockDb);
  }
}

function acquireExistingRuntimeOwnerLock(filepath: string): DatabaseType {
  assertNoOwnerSidecars(filepath, "gateway_runtime_owner_lock_sidecars_present");
  const db = openOwnerDatabaseReadOnly(filepath);
  try {
    assertOwnerDeleteJournal(db);
    db.exec("BEGIN EXCLUSIVE");
    assertIntegrity(db);
    return db;
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

function existingRuntimeOwnerFiles(env: NodeJS.ProcessEnv): { statePath: string; lockPath: string | null } | null {
  const configuredRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
  if (!statIfPresent(configuredRoot)) return null;
  const root = realpathSync(configuredRoot);
  const privateRoot = join(root, "private-state");
  const directory = join(privateRoot, "gateway-runtime");
  for (const dir of [privateRoot, directory]) {
    const stat = statIfPresent(dir);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gateway_runtime_owner_state_unavailable");
  }
  const statePath = join(directory, "owner-state.sqlite");
  const lockPath = join(directory, "owner-lock.sqlite");
  const state = statIfPresent(statePath);
  const lock = statIfPresent(lockPath);
  if (!state && !lock) return null;
  if (!state?.isFile() || state.isSymbolicLink() || (lock && (!lock.isFile() || lock.isSymbolicLink()))) {
    throw new Error("gateway_runtime_owner_state_unavailable");
  }
  return { statePath, lockPath: lock ? lockPath : null };
}

function assertNoOwnerSidecars(filepath: string, reason = "gateway_runtime_owner_state_unavailable"): void {
  if (["-journal", "-wal", "-shm"].some(suffix => statIfPresent(filepath + suffix))) {
    throw new Error(reason);
  }
}

function openOwnerDatabaseReadOnly(filepath: string): DatabaseType {
  const db = new DatabaseSync(filepath, { readOnly: true });
  try {
    // Before the first SQLite read, force the connection to use file locking.
    // With a read-only handle this avoids creating WAL or SHM sidecars while checking journal mode.
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE");
    return db;
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

function assertOwnerDeleteJournal(db: DatabaseType): void {
  const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  if (mode?.journal_mode !== "delete") throw new Error("gateway_runtime_owner_state_unavailable");
}

function openExistingOwnerDatabase(filepath: string): DatabaseType {
  const url = pathToFileURL(filepath);
  url.searchParams.set("mode", "rw");
  return new DatabaseSync(url.href);
}

function openOwnerDatabaseForRecovery(filepath: string): DatabaseType {
  assertNoOwnerSidecars(filepath);
  const probe = openOwnerDatabaseReadOnly(filepath);
  try { assertOwnerDeleteJournal(probe); } finally { closeDatabase(probe); }
  const db = openExistingOwnerDatabase(filepath);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA");
    assertOwnerDeleteJournal(db);
    return db;
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

function ownerFileIdentity(filepath: string): string {
  const stat = lstatSync(filepath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino <= 0n) {
    throw new Error("gateway_runtime_owner_state_unavailable");
  }
  return `${stat.dev}:${stat.ino}`;
}

function persistRecoveryFence(
  db: DatabaseType, evidence: RuntimeRecoveryFenceEvidence, owner: OwnerIdentity,
): void {
  if (pragmaInteger(db, "user_version") !== OWNER_STATE_SCHEMA_VERSION || hasRecoveryFence(db)) {
    throw new Error("gateway_runtime_recovery_fence_unavailable");
  }
  db.exec(`CREATE TABLE gateway_recovery_fence (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), evidence_json TEXT NOT NULL, digest TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version=${RECOVERY_FENCE_SCHEMA_VERSION};`);
  db.prepare("INSERT INTO gateway_recovery_fence VALUES(1,?,?)").run(JSON.stringify(evidence),
    recoveryFenceDigest(evidence, owner.generation, owner.execution_epoch, owner.host_audience_digest));
}

function persistRecoverySettlement(
  db: DatabaseType,
  generation: number,
  evidence: RuntimeRecoveryFenceEvidence,
  observed: string,
  status: RecoveryFenceTerminalStatus,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_recovery_settlements (
    generation INTEGER NOT NULL, operation TEXT NOT NULL, command_digest TEXT NOT NULL,
    backup_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, observed_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pre_action_state_matched','postconditions_matched')),
    PRIMARY KEY(generation, backup_id)
  ) STRICT;`);
  const parameters = [generation, evidence.operation, evidence.command_digest, evidence.backup_id, evidence.manifest_sha256,
    observed, status] as const;
  const columns = "generation,operation,command_digest,backup_id,manifest_sha256,observed_sha256,status";
  if (evidence.operation === "recovery.goal_purpose_repair") {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('gateway_recovery_settlements') WHERE name='repair_sha256'").get()) {
      db.exec("ALTER TABLE gateway_recovery_settlements ADD COLUMN repair_sha256 TEXT");
    }
    db.prepare(`INSERT INTO gateway_recovery_settlements (${columns},repair_sha256) VALUES(?,?,?,?,?,?,?,?)`)
      .run(...parameters, evidence.repair_sha256);
  } else {
    db.prepare(`INSERT INTO gateway_recovery_settlements (${columns}) VALUES(?,?,?,?,?,?,?)`).run(...parameters);
  }
}

function clearRecoveryFence(db: DatabaseType): void {
  db.exec(`DROP TABLE gateway_recovery_fence; PRAGMA user_version=${OWNER_STATE_SCHEMA_VERSION};`);
}

function statIfPresent(filepath: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(filepath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function validExplicitBackupId(value: unknown): value is string {
  return typeof value === "string" && value !== "latest" && EXPLICIT_BACKUP_ID.test(value);
}

function parseRecoveryVerification(value: unknown): RecoveryVerification {
  const verification = value as Record<string, unknown> | null | undefined;
  if (!verification || typeof verification !== "object" || Object.keys(verification).length !== 2 ||
      !Object.hasOwn(verification, "before_sha256") || !isDigest(verification.before_sha256) ||
      !Object.hasOwn(verification, "after_sha256") || !isDigest(verification.after_sha256)) {
    throw new Error("gateway_runtime_recovery_fence_invalid");
  }
  return Object.freeze({ before_sha256: verification.before_sha256, after_sha256: verification.after_sha256 });
}

function parsePreparedGoalPurposeRepair(value: unknown): PreparedGoalPurposeRepair {
  const row = value as Record<string, unknown> | null | undefined;
  const binding = row?.binding as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object" || Object.keys(row).length !== 2 ||
      !Object.hasOwn(row, "binding") || !Object.hasOwn(row, "issued_at_ms") ||
      !binding || typeof binding !== "object" || Object.keys(binding).length !== 7 ||
      !["command_digest", "backup_id", "manifest_sha256", "repair_sha256", "verification", "handoff_digest",
        "expires_at_ms"].every(key => Object.hasOwn(binding, key)) ||
      !isDigest(binding.command_digest) || !validExplicitBackupId(binding.backup_id) ||
      !isDigest(binding.manifest_sha256) || !isDigest(binding.repair_sha256) || !isDigest(binding.handoff_digest) ||
      typeof row.issued_at_ms !== "number" || !Number.isSafeInteger(row.issued_at_ms) || row.issued_at_ms <= 0 ||
      typeof binding.expires_at_ms !== "number" || !Number.isSafeInteger(binding.expires_at_ms) ||
      binding.expires_at_ms <= row.issued_at_ms || binding.expires_at_ms - row.issued_at_ms > GOAL_PURPOSE_REPAIR_MAX_HANDOFF_MS) {
    throw new Error("gateway_goal_purpose_repair_authorization_invalid");
  }
  const verification = parseRecoveryVerification(binding.verification);
  if (verification.before_sha256 === verification.after_sha256) {
    throw new Error("gateway_goal_purpose_repair_authorization_invalid");
  }
  return Object.freeze({ binding: Object.freeze({
    command_digest: binding.command_digest, backup_id: binding.backup_id, manifest_sha256: binding.manifest_sha256,
    repair_sha256: binding.repair_sha256, verification, handoff_digest: binding.handoff_digest,
    expires_at_ms: binding.expires_at_ms,
  }), issued_at_ms: row.issued_at_ms });
}

function goalPurposeRepairAuthorizationDigest(record: PreparedGoalPurposeRepair, owner: OwnerIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    "gateway-goal-purpose-repair-authorization.v1", owner.generation, owner.execution_epoch,
    owner.host_audience_digest, record,
  ])).digest("hex");
}

function goalPurposeRepairAuthorizationCurrent(record: PreparedGoalPurposeRepair): boolean {
  const now = Date.now();
  return now >= record.issued_at_ms && now < record.binding.expires_at_ms;
}

function clearPreparedGoalPurposeRepair(db: DatabaseType): void {
  db.exec("DROP TABLE IF EXISTS gateway_goal_purpose_repair_authorization");
}

function readPreparedGoalPurposeRepair(db: DatabaseType, owner: OwnerIdentity): PreparedGoalPurposeRepair | null {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='gateway_goal_purpose_repair_authorization'").get()) return null;
  const rows = db.prepare("SELECT singleton,evidence_json,digest FROM gateway_goal_purpose_repair_authorization LIMIT 2")
    .all() as Array<{ singleton: number; evidence_json: string; digest: string }>;
  const [row] = rows;
  if (rows.length !== 1 || row?.singleton !== 1) throw new Error("gateway_goal_purpose_repair_authorization_invalid");
  const evidence = parsePreparedGoalPurposeRepair(JSON.parse(row.evidence_json));
  if (row.digest !== goalPurposeRepairAuthorizationDigest(evidence, owner)) {
    throw new Error("gateway_goal_purpose_repair_authorization_invalid");
  }
  return evidence;
}

function parseRecoveryFenceEvidence(value: unknown): RuntimeRecoveryFenceEvidence {
  if (!value || typeof value !== "object") {
    throw new Error("gateway_runtime_recovery_fence_invalid");
  }
  const row = value as Record<string, unknown>;
  if (row.operation === "recovery.goal_purpose_repair") {
    if (Object.keys(row).length !== 6 || !["operation", "command_digest", "backup_id", "manifest_sha256", "repair_sha256",
      "verification"].every(key => Object.hasOwn(row, key)) || !isDigest(row.command_digest) ||
      !validExplicitBackupId(row.backup_id) || !isDigest(row.manifest_sha256) || !isDigest(row.repair_sha256)) {
      throw new Error("gateway_runtime_recovery_fence_invalid");
    }
    const verification = parseRecoveryVerification(row.verification);
    if (verification.before_sha256 === verification.after_sha256) throw new Error("gateway_runtime_recovery_fence_invalid");
    return Object.freeze({ operation: row.operation, command_digest: row.command_digest, backup_id: row.backup_id,
      manifest_sha256: row.manifest_sha256, repair_sha256: row.repair_sha256, verification });
  }
  if (row.operation !== "recovery.factory_reset" || typeof row.command_digest !== "string" || !DIGEST.test(row.command_digest) ||
      typeof row.manifest_sha256 !== "string" || !DIGEST.test(row.manifest_sha256) ||
      typeof row.backup_id !== "string" || !FACTORY_BACKUP_ID.test(row.backup_id) ||
      Object.keys(row).length !== (Object.hasOwn(row, "verification") ? 5 : 4) ||
      !["operation", "command_digest", "backup_id", "manifest_sha256"].every(key => Object.hasOwn(row, key))) {
    throw new Error("gateway_runtime_recovery_fence_invalid");
  }
  const evidence = { operation: row.operation, command_digest: row.command_digest, backup_id: row.backup_id,
    manifest_sha256: row.manifest_sha256 } as const;
  if (!Object.hasOwn(row, "verification")) return Object.freeze(evidence);
  return Object.freeze({ ...evidence, verification: parseRecoveryVerification(row.verification) });
}

function recoveryFenceDigest(
  evidence: RuntimeRecoveryFenceEvidence, generation: number, epoch: string, hostAudienceDigest: string,
): string {
  const bound = evidence.operation === "recovery.goal_purpose_repair"
    ? ["gateway-recovery-fence.v3", generation, epoch, hostAudienceDigest, evidence]
    : evidence.verification ? ["gateway-recovery-fence.v2", generation, epoch, hostAudienceDigest, evidence]
    : ["gateway-recovery-fence.v1", generation, epoch, evidence];
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
}

function hasRecoveryFence(db: DatabaseType): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='gateway_recovery_fence'").get();
}

function readRecoveryFence(
  db: DatabaseType, generation: number, epoch: string, hostAudienceDigest: string,
): RuntimeRecoveryFenceEvidence {
  const rows = db.prepare("SELECT singleton,evidence_json,digest FROM gateway_recovery_fence LIMIT 2").all() as Array<{
    singleton: number; evidence_json: string; digest: string;
  }>;
  const [row] = rows;
  if (rows.length !== 1 || row?.singleton !== 1) throw new Error("gateway_runtime_recovery_fence_invalid");
  const evidence = parseRecoveryFenceEvidence(JSON.parse(row.evidence_json));
  if (row.digest !== recoveryFenceDigest(evidence, generation, epoch, hostAudienceDigest)) {
    throw new Error("gateway_runtime_recovery_fence_invalid");
  }
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
      readRecoveryFence(db, owner.generation, owner.execution_epoch, owner.host_audience_digest);
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
    clearPreparedGoalPurposeRepair(db);
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
