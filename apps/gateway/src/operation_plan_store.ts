import { mkdirSync, realpathSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { operationPlanDigest, operationPlanTaskIdentityDigest, partitionOperationPlanCheckpointForRuntime,
  type OperationPlanRecoveryHoldState, type OperationPlanStatePort } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointEnvelopeSchema, OperationPlanCheckpointSchema,
  type OperationPlanCheckpoint, type OperationPlanCheckpointEnvelope } from "@blue-tanuki/protocol";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
/** 私有runtime回復状態。原子的CASで別processの古いwriterを拒否する。 */
export class OperationPlanStateStore implements OperationPlanStatePort {
  private readonly db: DatabaseType;
  constructor(filepath: string) {
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
    this.db.exec("CREATE TABLE IF NOT EXISTS operation_plan_state (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT");
    this.ensureRecoveryHoldTable();
  }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): OperationPlanStateStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "operation-plans");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("plan_state_directory_must_not_be_symlink");
    }
    const filepath = join(directory, "j-state.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("plan_state_file_must_not_be_symlink");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new OperationPlanStateStore(filepath);
  }
  load(memoryAvailable = true): OperationPlanCheckpoint | null {
    return this.readCheckpoint(memoryAvailable)?.partition.checkpoint ?? null;
  }
  compareAndSet(expected_digest: string | null, checkpoint: OperationPlanCheckpoint, memoryAvailable = true): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readCheckpoint(memoryAvailable);
      const currentCheckpoint = current?.partition.checkpoint ?? null;
      if ((currentCheckpoint ? operationPlanDigest(currentCheckpoint) : null) !== expected_digest) {
        throw new Error("plan_checkpoint_concurrent_update");
      }
      const incoming = OperationPlanCheckpointSchema.parse(checkpoint);
      const incomingPartition = partitionOperationPlanCheckpointForRuntime(incoming, memoryAvailable);
      if (incomingPartition.quarantined_plan_indices.length > 0 || incomingPartition.quarantined_wait_indices.length > 0) {
        throw new Error("plan_checkpoint_residual_write_rejected");
      }

      const quarantinedPlanIndices = current?.partition.quarantined_plan_indices ?? [];
      const quarantinedPlans = quarantinedPlanIndices.map((index) => current!.raw.plans[index]!);
      const quarantinedPlanDigests = new Set((current?.partition.quarantined_plans ?? [])
        .flatMap((plan) => plan.plan_id_digest ? [plan.plan_id_digest] : []));
      const incomingPlanDigests = new Set(incoming.plans.map((plan) =>
        operationPlanDigest(plan.revisions[0]!.plan.plan_id)));
      if ([...incomingPlanDigests].some((digest) => quarantinedPlanDigests.has(digest))) {
        throw new Error("plan_checkpoint_quarantined_identity_conflict");
      }

      const quarantinedWaitIndices = current?.partition.quarantined_wait_indices ?? [];
      const quarantinedWaits = quarantinedWaitIndices.map((index) => current!.raw.waits![index]!);
      const quarantinedWaitIds = new Set(quarantinedWaits.map((wait) => wait.wait_id));
      if ((incoming.waits ?? []).some((wait) => quarantinedWaitIds.has(wait.wait_id))) {
        throw new Error("plan_checkpoint_quarantined_wait_identity_conflict");
      }
      const merged = {
        ...incoming,
        plans: [...incoming.plans, ...quarantinedPlans],
        ...(incoming.waits !== undefined || quarantinedWaits.length > 0
          ? { waits: [...(incoming.waits ?? []), ...quarantinedWaits] } : {}),
      };
      OperationPlanCheckpointEnvelopeSchema.parse(merged);
      this.writeCheckpoint(merged);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 元の保存失敗を保持する。 */ }
      throw error;
    }
  }
  restorePlanScope(
    checkpoint: OperationPlanCheckpoint,
    planIdDigest: string,
    expectedCurrent: OperationPlanCheckpoint | null,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readCheckpoint(true);
      const currentCheckpoint = current?.partition.checkpoint ?? null;
      const expectedDigest = expectedCurrent ? operationPlanDigest(expectedCurrent) : null;
      if ((currentCheckpoint ? operationPlanDigest(currentCheckpoint) : null) !== expectedDigest) {
        throw new Error("operation_plan_restore_scope_target_changed");
      }
      const archived = OperationPlanCheckpointSchema.parse(checkpoint);
      const archivePartition = partitionOperationPlanCheckpointForRuntime(archived, true);
      const archiveMatches = archivePartition.checkpoint.plans.map((plan, index) => ({ plan, index })).filter(({ plan }) =>
        operationPlanDigest(plan.revisions[0]!.plan.plan_id) === planIdDigest.toLowerCase());
      if (archiveMatches.length !== 1) {
        throw new Error("operation_plan_restore_scope_archive_unverified");
      }
      const merged = mergeOperationPlanCheckpointScope(currentCheckpoint, archivePartition.checkpoint, planIdDigest);
      const residualPlanIndexes = new Set((current?.partition.quarantined_plans ?? [])
        .filter((plan) => plan.plan_id_digest !== planIdDigest.toLowerCase()).map((plan) => plan.index));
      const residualPlans = [...residualPlanIndexes].map((index) => current!.raw.plans[index]!);
      const residualWaits = (current?.partition.quarantined_wait_indices ?? [])
        .map((index) => current!.raw.waits?.[index])
        .filter((wait): wait is NonNullable<OperationPlanCheckpointEnvelope["waits"]>[number] =>
          wait !== undefined && wait.plan_id_digest !== planIdDigest.toLowerCase());
      const persisted = {
        ...merged,
        plans: [...merged.plans, ...residualPlans],
        ...(merged.waits !== undefined || residualWaits.length > 0
          ? { waits: [...(merged.waits ?? []), ...residualWaits] } : {}),
      };
      const persistedEnvelope = OperationPlanCheckpointEnvelopeSchema.parse(persisted);
      const mergedPartition = partitionOperationPlanCheckpointForRuntime(persistedEnvelope, true);
      const restoredIndex = mergedPartition.checkpoint.plans.findIndex((plan) =>
        operationPlanDigest(plan.revisions[0]!.plan.plan_id) === planIdDigest.toLowerCase());
      if (restoredIndex < 0) {
        throw new Error("operation_plan_restore_scope_target_unverified");
      }
      this.writeCheckpoint(persistedEnvelope);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 元の保存失敗を保持する。 */ }
      throw error;
    }
  }
  restoreTaskScope(
    checkpoint: OperationPlanCheckpoint,
    taskIdentityDigest: string,
    expectedCurrent: OperationPlanCheckpoint | null,
  ): void {
    if (!/^[a-f0-9]{64}$/i.test(taskIdentityDigest)) {
      throw new Error("operation_plan_restore_task_scope_invalid");
    }
    const scopeDigest = taskIdentityDigest.toLowerCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readCheckpoint(true);
      const currentCheckpoint = current?.partition.checkpoint ?? null;
      const expectedDigest = expectedCurrent ? operationPlanDigest(expectedCurrent) : null;
      if ((currentCheckpoint ? operationPlanDigest(currentCheckpoint) : null) !== expectedDigest) {
        throw new Error("operation_plan_restore_task_scope_target_changed");
      }
      const archived = OperationPlanCheckpointEnvelopeSchema.parse(checkpoint);
      const archivePartition = partitionOperationPlanCheckpointForRuntime(archived, true);
      const archivePlans = archivePartition.checkpoint.plans.filter((plan) =>
        operationPlanTaskIdentityDigest(plan) === scopeDigest);
      if (archivePlans.length === 0 || new Set(archivePlans.map((plan) =>
        operationPlanDigest(plan.revisions[0]!.plan.plan_id))).size !== archivePlans.length) {
        throw new Error("operation_plan_restore_task_scope_archive_unverified");
      }
      const archivePlanIds = new Set(archivePlans.map((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id)));
      const archiveResidualForScope = archivePartition.quarantined_plans.some(({ index }) =>
        checkpointPlanTaskIdentityDigest(archived.plans[index]) === scopeDigest);
      const archiveWaitResidualForScope = archivePartition.quarantined_wait_indices.some((index) =>
        archived.waits?.[index]?.task_identity_digest === scopeDigest);
      if (archiveResidualForScope || archiveWaitResidualForScope) {
        throw new Error("operation_plan_restore_task_scope_archive_residuals");
      }
      const archiveScopeWaits = (archivePartition.checkpoint.waits ?? []).filter((wait) =>
        wait.task_identity_digest === scopeDigest);
      if (archiveScopeWaits.some((wait) => !archivePlanIds.has(wait.plan_id_digest))) {
        throw new Error("operation_plan_restore_task_scope_archive_wait_unverified");
      }

      const currentRaw = current?.raw;
      const currentResidualForScope = (current?.partition.quarantined_plans ?? []).some(({ index }) =>
        checkpointPlanTaskIdentityDigest(currentRaw?.plans[index]) === scopeDigest);
      const currentWaitResidualForScope = (current?.partition.quarantined_wait_indices ?? []).some((index) =>
        currentRaw?.waits?.[index]?.task_identity_digest === scopeDigest);
      if (currentResidualForScope || currentWaitResidualForScope) {
        throw new Error("operation_plan_restore_task_scope_target_residuals");
      }
      const merged = mergeOperationPlanCheckpointTaskScope(currentCheckpoint, archivePartition.checkpoint, scopeDigest);
      const residualPlanIndexes = new Set((current?.partition.quarantined_plans ?? [])
        .filter(({ index }) => checkpointPlanTaskIdentityDigest(currentRaw?.plans[index]) !== scopeDigest)
        .map(({ index }) => index));
      const residualPlans = [...residualPlanIndexes].map((index) => currentRaw!.plans[index]!);
      const residualWaits = (current?.partition.quarantined_wait_indices ?? [])
        .map((index) => currentRaw?.waits?.[index])
        .filter((wait): wait is NonNullable<OperationPlanCheckpointEnvelope["waits"]>[number] =>
          wait !== undefined && wait.task_identity_digest !== scopeDigest);
      const persistedWaits = [...(merged.waits ?? []), ...residualWaits];
      if (new Set(persistedWaits.map((wait) => wait.wait_id)).size !== persistedWaits.length) {
        throw new Error("operation_plan_restore_task_scope_wait_ambiguous");
      }
      const persisted = {
        ...merged,
        plans: [...merged.plans, ...residualPlans],
        ...(merged.waits !== undefined || residualWaits.length > 0
          ? { waits: persistedWaits } : {}),
      };
      const persistedEnvelope = OperationPlanCheckpointEnvelopeSchema.parse(persisted);
      const mergedPartition = partitionOperationPlanCheckpointForRuntime(persistedEnvelope, true);
      const restoredPlans = mergedPartition.checkpoint.plans.filter((plan) =>
        operationPlanTaskIdentityDigest(plan) === scopeDigest);
      if (restoredPlans.length !== archivePlans.length ||
          restoredPlans.some((plan) => !archivePlanIds.has(operationPlanDigest(plan.revisions[0]!.plan.plan_id)))) {
        throw new Error("operation_plan_restore_task_scope_target_unverified");
      }
      this.writeCheckpoint(persistedEnvelope);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 元の保存失敗を保持する。 */ }
      throw error;
    }
  }
  private readCheckpoint(memoryAvailable: boolean): {
    readonly raw: OperationPlanCheckpointEnvelope;
    readonly partition: ReturnType<typeof partitionOperationPlanCheckpointForRuntime>;
  } | null {
    const row = this.db.prepare("SELECT checkpoint_json, digest FROM operation_plan_state WHERE id=1").get() as
      { checkpoint_json: string; digest: string } | undefined;
    if (!row) return null;
    let raw: unknown;
    try { raw = JSON.parse(row.checkpoint_json); }
    catch { throw new Error("plan_checkpoint_integrity_failed"); }
    if (operationPlanDigest(raw) !== row.digest) throw new Error("plan_checkpoint_integrity_failed");
    const parsedEnvelope = OperationPlanCheckpointEnvelopeSchema.parse(raw);
    return {
      raw: raw as OperationPlanCheckpointEnvelope,
      partition: partitionOperationPlanCheckpointForRuntime(parsedEnvelope, memoryAvailable),
    };
  }
  private writeCheckpoint(value: unknown): void {
    const checked = OperationPlanCheckpointEnvelopeSchema.parse(value);
    this.db.prepare("INSERT INTO operation_plan_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,digest=excluded.digest")
      .run(JSON.stringify(checked), operationPlanDigest(checked));
  }
  loadRecoveryHoldState(): unknown | null {
    this.ensureRecoveryHoldTable();
    const row = this.db.prepare("SELECT state_json, digest FROM operation_plan_recovery_holds WHERE id=1").get() as
      { state_json: string; digest: string } | undefined;
    if (!row) return null;
    const raw: unknown = JSON.parse(row.state_json);
    if (operationPlanDigest(raw) !== row.digest) throw new Error("plan_recovery_hold_state_integrity_failed");
    return raw;
  }
  compareAndSetRecoveryHoldState(expected_digest: string | null, state: OperationPlanRecoveryHoldState): void {
    this.ensureRecoveryHoldTable();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state_json, digest FROM operation_plan_recovery_holds WHERE id=1").get() as
        { state_json: string; digest: string } | undefined;
      let currentDigest: string | null = null;
      if (row) {
        const raw: unknown = JSON.parse(row.state_json);
        if (operationPlanDigest(raw) !== row.digest) throw new Error("plan_recovery_hold_state_integrity_failed");
        currentDigest = operationPlanDigest(raw);
      }
      if (currentDigest !== expected_digest) throw new Error("plan_recovery_hold_state_concurrent_update");
      const checked = structuredClone(state);
      this.db.prepare("INSERT INTO operation_plan_recovery_holds VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,digest=excluded.digest")
        .run(JSON.stringify(checked), operationPlanDigest(checked));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 元の保存失敗を保持する。 */ }
      throw error;
    }
  }
  private ensureRecoveryHoldTable(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS operation_plan_recovery_holds (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT");
  }
  close(): void { this.db.close(); }
}

function checkpointPlanTaskIdentityDigest(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const digest = operationPlanTaskIdentityDigest(value as OperationPlanCheckpoint["plans"][number]);
    return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/** Replace one archived plan and its wait records while retaining every unrelated checkpoint field. */
export function mergeOperationPlanCheckpointScope(
  currentValue: OperationPlanCheckpoint | null,
  archivedValue: OperationPlanCheckpoint,
  requestedPlanIdDigest: string,
): OperationPlanCheckpoint {
  if (!/^[a-f0-9]{64}$/i.test(requestedPlanIdDigest)) {
    throw new Error("operation_plan_restore_scope_invalid");
  }
  const scopeDigest = requestedPlanIdDigest.toLowerCase();
  const current = currentValue === null ? null : OperationPlanCheckpointSchema.parse(currentValue);
  const archived = OperationPlanCheckpointSchema.parse(archivedValue);
  const planIdDigest = (plan: OperationPlanCheckpoint["plans"][number]): string =>
    operationPlanDigest(plan.revisions[0]!.plan.plan_id);
  const archivedMatches = archived.plans.filter((plan) => planIdDigest(plan) === scopeDigest);
  if (archivedMatches.length !== 1) throw new Error("operation_plan_restore_scope_archive_ambiguous");
  const currentPlans = current?.plans ?? [];
  const currentMatches = currentPlans.filter((plan) => planIdDigest(plan) === scopeDigest);
  if (currentMatches.length > 1) throw new Error("operation_plan_restore_scope_target_ambiguous");

  const plans = [...currentPlans];
  const currentIndex = plans.findIndex((plan) => planIdDigest(plan) === scopeDigest);
  if (currentIndex === -1) plans.push(archivedMatches[0]!);
  else plans[currentIndex] = archivedMatches[0]!;

  const currentWaits = current?.waits ?? [];
  const archivedScopeWaits = (archived.waits ?? []).filter((wait) => wait.plan_id_digest === scopeDigest);
  const waits: NonNullable<OperationPlanCheckpoint["waits"]> = [];
  let insertedArchivedWaits = false;
  for (const wait of currentWaits) {
    if (wait.plan_id_digest === scopeDigest) {
      if (!insertedArchivedWaits) {
        waits.push(...archivedScopeWaits);
        insertedArchivedWaits = true;
      }
    } else {
      waits.push(wait);
    }
  }
  if (!insertedArchivedWaits) waits.push(...archivedScopeWaits);
  if (waits.length > 256) throw new Error("operation_plan_restore_scope_wait_capacity");
  if (new Set(waits.map((wait) => wait.wait_id)).size !== waits.length) {
    throw new Error("operation_plan_restore_scope_wait_ambiguous");
  }

  const base = current ?? { schema_version: "operation-plan-state.v1" as const, plans: [] };
  const merged = {
    ...base,
    plans,
    ...(current?.waits !== undefined || archivedScopeWaits.length > 0 ? { waits } : {}),
    // Shell results are intentionally unbound to an Operation Plan. Preserve the current set.
  };
  try {
    return OperationPlanCheckpointSchema.parse(merged);
  } catch {
    throw new Error("operation_plan_restore_scope_checkpoint_invalid");
  }
}

/** Replace one archived task lineage, including all its plans and waits, while retaining unrelated state. */
export function mergeOperationPlanCheckpointTaskScope(
  currentValue: OperationPlanCheckpoint | null,
  archivedValue: OperationPlanCheckpoint,
  requestedTaskIdentityDigest: string,
): OperationPlanCheckpoint {
  if (!/^[a-f0-9]{64}$/i.test(requestedTaskIdentityDigest)) {
    throw new Error("operation_plan_restore_task_scope_invalid");
  }
  const scopeDigest = requestedTaskIdentityDigest.toLowerCase();
  const current = currentValue === null ? null : OperationPlanCheckpointSchema.parse(currentValue);
  const archived = OperationPlanCheckpointSchema.parse(archivedValue);
  const taskIdentity = (plan: OperationPlanCheckpoint["plans"][number]) => operationPlanTaskIdentityDigest(plan);
  const planIdDigest = (plan: OperationPlanCheckpoint["plans"][number]) =>
    operationPlanDigest(plan.revisions[0]!.plan.plan_id);
  const archivedPlans = archived.plans.filter((plan) => taskIdentity(plan) === scopeDigest);
  if (archivedPlans.length === 0 || new Set(archivedPlans.map(planIdDigest)).size !== archivedPlans.length) {
    throw new Error("operation_plan_restore_task_scope_archive_ambiguous");
  }

  const currentPlans = current?.plans ?? [];
  const retainedPlans = currentPlans.filter((plan) => taskIdentity(plan) !== scopeDigest);
  const retainedPlanIds = new Set(retainedPlans.map(planIdDigest));
  if (archivedPlans.some((plan) => retainedPlanIds.has(planIdDigest(plan)))) {
    throw new Error("operation_plan_restore_task_scope_plan_identity_conflict");
  }
  const plans: OperationPlanCheckpoint["plans"] = [];
  let insertedArchivedPlans = false;
  for (const plan of currentPlans) {
    if (taskIdentity(plan) === scopeDigest) {
      if (!insertedArchivedPlans) {
        plans.push(...archivedPlans);
        insertedArchivedPlans = true;
      }
    } else {
      plans.push(plan);
    }
  }
  if (!insertedArchivedPlans) plans.push(...archivedPlans);

  const archivedPlanIds = new Set(archivedPlans.map(planIdDigest));
  const archivedScopeWaits = (archived.waits ?? []).filter((wait) => wait.task_identity_digest === scopeDigest);
  if (archivedScopeWaits.some((wait) => !archivedPlanIds.has(wait.plan_id_digest))) {
    throw new Error("operation_plan_restore_task_scope_archive_wait_unverified");
  }
  const waits: NonNullable<OperationPlanCheckpoint["waits"]> = [];
  let insertedArchivedWaits = false;
  for (const wait of current?.waits ?? []) {
    if (wait.task_identity_digest === scopeDigest) {
      if (!insertedArchivedWaits) {
        waits.push(...archivedScopeWaits);
        insertedArchivedWaits = true;
      }
    } else {
      waits.push(wait);
    }
  }
  if (!insertedArchivedWaits) waits.push(...archivedScopeWaits);
  if (waits.length > 256) throw new Error("operation_plan_restore_task_scope_wait_capacity");
  if (new Set(waits.map((wait) => wait.wait_id)).size !== waits.length) {
    throw new Error("operation_plan_restore_task_scope_wait_ambiguous");
  }

  const base = current ?? { schema_version: "operation-plan-state.v1" as const, plans: [] };
  const merged = {
    ...base,
    plans,
    ...(current?.waits !== undefined || archivedScopeWaits.length > 0 ? { waits } : {}),
    // Shell results are deliberately unbound to a plan and retain the current set.
  };
  try {
    return OperationPlanCheckpointSchema.parse(merged);
  } catch {
    throw new Error("operation_plan_restore_task_scope_checkpoint_invalid");
  }
}
