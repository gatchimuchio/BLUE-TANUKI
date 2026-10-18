import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointSchema } from "@blue-tanuki/protocol";
import {
  buildRecoveryPostActionObservation,
  buildRecoverySnapshot,
  createRecoveryBackup,
  recoveryStoreRestoreHistoryEvidence,
  type RecoveryHistoryEvidenceEntry,
} from "../src/recovery_surface.js";
import { operationPlanRecoveryEvidenceFromObservation } from "../src/operation_plan_recovery_evidence.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const digest = (value: string) => value.repeat(64).slice(0, 64);

function historyFor(
  operation: string,
  status: "success" | "failed" | "suspended" = "success",
  resultDigest: string | null = digest("b"),
  finalOutputDigest: string | null = resultDigest,
  commandId = "recovery-command-1",
  firstIndex = 4,
): RecoveryHistoryEvidenceEntry[] {
  return [
    {
      kind: "execution_history",
      command_id: commandId,
      index: firstIndex,
      timestamp: Date.now(),
      used_for_authority: false,
      payload: {
        command: {
          operation,
          payload: {
            tool_name: operation,
            arguments_digest: digest("a"),
          },
        },
        status,
        result_digest: resultDigest,
      },
    },
    {
      kind: "final_output",
      command_id: commandId,
      index: firstIndex + 1,
      timestamp: Date.now(),
      used_for_authority: false,
      payload: {
        status,
        result_present: status === "success",
        result_digest: finalOutputDigest,
        used_for_authority: false,
      },
    },
  ];
}

function selectedStoreRestoreHistory(
  stateDigest: string,
  backupIdDigest = digest("e"),
  commandId = "recovery-command-1",
  firstIndex = 4,
  scopePlanDigest: string | null = operationPlanDigest("private-clean-plan"),
): RecoveryHistoryEvidenceEntry[] {
  const entries = historyFor("recovery.restore", "success", digest("b"), digest("b"), commandId, firstIndex);
  const execution = entries[0]!;
  const payload = execution.payload as Record<string, unknown>;
  return [
    {
      ...execution,
      payload: {
        ...payload,
        recovery_store_restore: {
          schema_version: 1,
          store_key: "operation_plans",
          restored_store_state_digest: stateDigest,
          restored_backup_id_digest: backupIdDigest,
          ...(scopePlanDigest ? { restore_scope_plan_digest: scopePlanDigest } : {}),
        },
      },
    },
    entries[1]!,
  ];
}

async function createOperationPlanStore(stateRoot: string, plans: unknown[] = []): Promise<string> {
  const databasePath = path.join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const store = new OperationPlanStateStore(databasePath);
  store.compareAndSet(null, OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans,
  }));
  store.close();
  return databasePath;
}

function recoveryObservationPlanState(planId: string, withResidualBinding: boolean): unknown {
  const requestId = `private-request-${planId}`;
  const step = {
    step_id: `private-step-${planId}`,
    operation: "file.search",
    target: { kind: "directory" as const, id: "private-workspace" },
    state: "planned" as const,
    effects: ["read" as const],
    permission: {
      risk: "low" as const,
      approval_level: "L1_observe" as const,
      final_review_required: false,
      hds_brain_authority_required: true as const,
      approval_gate_required: true,
    },
    adapter: "internal_runtime" as const,
    adapter_is_authority: false as const,
    command_generated_by_adapter_only: false,
  };
  const plan = {
    version: "operation-core.v1" as const,
    plan_id: planId,
    request_id: requestId,
    state: "planned" as const,
    steps: [step],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false as const, command_generation_location: "not_applicable" as const },
    planner_output_used_for_authority: false as const,
    hds_brain_authority_required: true as const,
  };
  const revisionDigest = operationPlanDigest(plan);
  const { state: _state, ...stepDefinition } = step;
  const bindings = withResidualBinding ? [{
    step_id: step.step_id,
    revision_digest: revisionDigest,
    step_digest: operationPlanDigest(stepDefinition),
    prepared_step: step,
    command_id: `private-command-${planId}`,
    request_id: requestId,
    commit_hash: "private-commit",
    payload_digest: digest("c"),
    command_digest: digest("d"),
    operation: step.operation,
    status: "intent_committed" as const,
  }] : [];
  return {
    owner: "private-owner",
    channel: "webchat",
    goal: "private recovery observation goal",
    revisions: [{ digest: revisionDigest, plan }],
    receipt_observations: [],
    bindings,
    results: [],
  };
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("buildRecoveryPostActionObservation", () => {
  it("persists only fixed selected-store identity and digests for restore observation", () => {
    const evidence = recoveryStoreRestoreHistoryEvidence({
      action: "restore",
      status: "completed",
      used_for_authority: false,
      canonical_state_cross_store_atomic: false,
      restored_backup_id: "private-backup-id",
      restored_store_key: "operation_plans",
      restored_store_archive_digest: digest("a"),
      restored_store_state_digest: digest("b"),
      restore_scope_kind: "operation_plan",
      restore_scope_digest: operationPlanDigest("private-correlated-plan"),
      backup_manifest_path: "private/path/manifest.json",
    });

    expect(evidence).toEqual({
      schema_version: 1,
      store_key: "operation_plans",
      restored_store_state_digest: digest("b"),
      restored_backup_id_digest: createHash("sha256").update("private-backup-id").digest("hex"),
      restore_scope_plan_digest: operationPlanDigest("private-correlated-plan"),
    });
    expect(JSON.stringify(evidence)).not.toContain("private-backup-id");
    expect(JSON.stringify(evidence)).not.toContain("private/path");
    expect(recoveryStoreRestoreHistoryEvidence({
      action: "restore", status: "completed", used_for_authority: false,
      canonical_state_cross_store_atomic: false, restored_store_key: "unknown",
      restored_backup_id: "private-backup-id",
      restored_store_archive_digest: digest("a"), restored_store_state_digest: digest("b"),
    })).toBeUndefined();
    expect(recoveryStoreRestoreHistoryEvidence({
      action: "restore", status: "completed", used_for_authority: false,
      canonical_state_cross_store_atomic: false, restored_store_key: "operation_plans",
      restored_store_archive_digest: digest("a"), restored_store_state_digest: digest("b"),
      restored_backup_id: "../private-backup-id",
    })).toBeUndefined();
    expect(recoveryStoreRestoreHistoryEvidence({
      action: "restore", status: "completed", used_for_authority: false,
      canonical_state_cross_store_atomic: false, restored_store_key: "operation_plans",
      restored_store_archive_digest: digest("a"), restored_store_state_digest: digest("b"),
    })).toBeUndefined();
  });

  it("confirms only provider configuration observed in both the env file and current process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const observation = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider"),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });

      expect(observation).toMatchObject({
        status: "changed",
        operation: "provider_reset",
        configuration_state: "provider_stub",
        evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
        used_for_authority: false,
        may_execute: false,
      });
      expect(observation.operation_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.result_digest).toBe(digest("b"));
      expect(JSON.stringify(observation)).not.toContain("product.env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("startup recovery-hold observation keeps the latest plan restore visible after a newer provider reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-plan-hold-reobserve-latest-reset-"));
    try {
      const stateRoot = path.join(root, "state");
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const storePath = await createOperationPlanStore(stateRoot, [recoveryObservationPlanState("plan-after-restore", false)]);
      const restoredStateDigest = await sha256File(storePath);
      const entries = [
        ...selectedStoreRestoreHistory(restoredStateDigest, digest("e"), "plan-restore-command", 4,
          operationPlanDigest("plan-after-restore")),
        ...historyFor("recovery.reset_provider", "success", digest("f"), digest("f"), "later-provider-reset", 6),
      ];
      const history = { entries, chain_valid: true, skipped_count: 0, not_before_timestamp_ms: Date.now() + 10_000 };
      const env = { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: path.join(root, "recovery"), LLM_BACKEND: "stub" };
      const latestMutation = await buildRecoveryPostActionObservation(history, env);
      const planHoldObservation = await buildRecoveryPostActionObservation(history, env, { mode: "startup_operation_plan_hold" });

      expect(latestMutation.operation).toBe("provider_reset");
      expect(planHoldObservation).toMatchObject({
        operation: "restore",
        store_key: "operation_plans",
        command_id_digest: createHash("sha256").update("plan-restore-command").digest("hex"),
        restored_state_digest: restoredStateDigest,
      });
      const publicObservation = JSON.stringify((await buildRecoverySnapshot(env, planHoldObservation)).post_action_observation);
      expect(publicObservation).not.toContain("command_id_digest");
      expect(publicObservation).not.toContain(restoredStateDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when history is incomplete, the output digest does not match, or restore scope is broader than observation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const incomplete = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider"), chain_valid: true, skipped_count: 1,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const digestMismatch = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider", "success", digest("b"), digest("c")),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const prototypeOperation = await buildRecoveryPostActionObservation({
        entries: historyFor("toString"), chain_valid: true, skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const previousProcessHistory = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider").map((entry) => ({ ...entry, timestamp: 10 })),
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: 11,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const mismatchedFailure = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider", "failed", digest("b"), digest("c")),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const restore = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.restore"), chain_valid: true, skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });

      expect(incomplete.status).toBe("unverified");
      expect(incomplete.operation).toBeNull();
      expect(digestMismatch.status).toBe("unverified");
      expect(prototypeOperation.status).toBe("no_record");
      expect(previousProcessHistory).toMatchObject({
        status: "unverified",
        operation: "provider_reset",
        configuration_state: "not_observed",
      });
      expect(mismatchedFailure.status).toBe("unverified");
      expect(restore).toMatchObject({
        status: "unverified",
        operation: "restore",
        evidence_source: "COMPLETE_HISTORY",
        configuration_state: "not_observed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a failed execution distinct and never treats factory-reset configuration as full verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\nCOMPOSIO_DRY_RUN=true\nCOMPOSIO_LIVE_EXECUTION=false\n", "utf8");
      const failed = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_connector", "failed", null, null),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile });
      const factory = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.factory_reset"),
        chain_valid: true,
        skipped_count: 0,
      }, {
        BLUE_TANUKI_ENV_FILE: envFile,
        LLM_BACKEND: "stub",
        COMPOSIO_DRY_RUN: "true",
        COMPOSIO_LIVE_EXECUTION: "false",
      });

      expect(failed).toMatchObject({ status: "failed", operation: "connector_reset" });
      expect(factory).toMatchObject({
        status: "unverified",
        operation: "factory_reset",
        configuration_state: "provider_connector_dry_run",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not confirm a reset while provider keys remain in process environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const observation = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider"),
        chain_valid: true,
        skipped_count: 0,
      }, {
        BLUE_TANUKI_ENV_FILE: envFile,
        LLM_BACKEND: "stub",
        OPENAI_API_KEY: "must-never-be-returned",
      });

      expect(observation.status).toBe("unverified");
      expect(observation.configuration_state).toBe("not_observed");
      expect(JSON.stringify(observation)).not.toContain("must-never-be-returned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reobserves only the selected SQLite store after restart and detects later changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-restore-reobserve-"));
    try {
      const stateRoot = path.join(root, "state");
      const storePath = await createOperationPlanStore(stateRoot, [
        recoveryObservationPlanState("private-clean-plan", false),
        recoveryObservationPlanState("private-residual-plan", true),
      ]);
      await writeFile(path.join(stateRoot, "private-state", "execution-intents"), "unselected sibling store", "utf8");
      const restoredStateDigest = await sha256File(storePath);
      const history = {
        entries: selectedStoreRestoreHistory(restoredStateDigest),
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: Date.now() + 10_000,
      };
      const sameProcess = await buildRecoveryPostActionObservation({
        ...history,
        not_before_timestamp_ms: history.entries[0]!.timestamp - 1,
      }, { BLUE_TANUKI_STATE_ROOT: stateRoot });
      expect(sameProcess).toMatchObject({ status: "unverified", store_key: "operation_plans" });

      const originalBytes = await readFile(storePath);
      const matched = await buildRecoveryPostActionObservation(history, { BLUE_TANUKI_STATE_ROOT: stateRoot });

      expect(matched).toMatchObject({
        status: "matched",
        operation: "restore",
        store_key: "operation_plans",
        restore_scope_plan_digest: operationPlanDigest("private-clean-plan"),
        evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
        store_ledger_status: "residuals_present",
        store_ledger_residual_count: 1,
        plan_residuals: [
          { status: "verified", binding_count: 0, residual_binding_count: 0, omitted_binding_count: 0 },
          { status: "residuals_present", binding_count: 1, residual_binding_count: 1, omitted_binding_count: 0 },
        ],
        used_for_authority: false,
        may_execute: false,
      });
      expect(matched.plan_residuals?.map((plan) => plan.plan_id_digest)).toEqual([
        operationPlanDigest("private-clean-plan"), operationPlanDigest("private-residual-plan"),
      ]);
      expect(await readFile(storePath)).toEqual(originalBytes);
      expect(JSON.stringify(matched)).not.toContain(storePath);
      for (const secret of ["private-owner", "private recovery observation goal", "private-clean-plan", "private-residual-plan",
        "private-request-private-clean-plan", "private-command-private-residual-plan"]) {
        expect(JSON.stringify(matched)).not.toContain(secret);
      }

      const missingScope = await buildRecoveryPostActionObservation({
        ...history,
        entries: selectedStoreRestoreHistory(restoredStateDigest, digest("e"), "recovery-command-1", 4, null),
      }, { BLUE_TANUKI_STATE_ROOT: stateRoot });
      expect(missingScope).toMatchObject({
        status: "unverified",
        store_key: "operation_plans",
        restore_scope_plan_digest: null,
        plan_residuals: null,
        used_for_authority: false,
        may_execute: false,
      });

      const database: DatabaseSyncType = new DatabaseSync(storePath);
      const emptyCheckpoint = { schema_version: "operation-plan-state.v1", plans: [] };
      database.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
        .run(JSON.stringify(emptyCheckpoint), operationPlanDigest(emptyCheckpoint));
      database.close();
      const changedBytes = await readFile(storePath);
      const changed = await buildRecoveryPostActionObservation(history, { BLUE_TANUKI_STATE_ROOT: stateRoot });

      expect(changed).toMatchObject({
        status: "changed",
        operation: "restore",
        store_key: "operation_plans",
        store_ledger_status: "verified",
        store_ledger_residual_count: 0,
        plan_residuals: [],
        plan_restore_points: [],
      });
      expect(await readFile(storePath)).toEqual(changedBytes);

      const corruptCheckpoint = { schema_version: "operation-plan-state.v1", plans: null };
      const corruptDatabase: DatabaseSyncType = new DatabaseSync(storePath);
      corruptDatabase.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
        .run(JSON.stringify(corruptCheckpoint), operationPlanDigest(corruptCheckpoint));
      corruptDatabase.close();
      const residuals = await buildRecoveryPostActionObservation(history, { BLUE_TANUKI_STATE_ROOT: stateRoot });
      expect(residuals).toMatchObject({
        status: "changed",
        store_ledger_status: "schema_mismatch",
        store_ledger_residual_count: 1,
        plan_residuals: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("correlates selected-plan residuals with the exact backup pack through digests only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-restore-point-"));
    try {
      const stateRoot = path.join(root, "state");
      const recoveryRoot = path.join(root, "recovery");
      const storePath = await createOperationPlanStore(stateRoot, [
        recoveryObservationPlanState("private-correlated-plan", true),
      ]);
      const backup = await createRecoveryBackup({
        BLUE_TANUKI_STATE_ROOT: stateRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryRoot,
      });
      const backupId = backup.backup_id!;
      const backupIdDigest = createHash("sha256").update(backupId).digest("hex");
      const archiveManifest = JSON.parse(await readFile(backup.backup_manifest_path!, "utf8")) as {
        canonical_state_snapshot: { entries: Array<{ store_key: string; archive_rel_path: string | null }> };
      };
      const planArchivePath = path.join(path.dirname(backup.backup_manifest_path!),
        archiveManifest.canonical_state_snapshot.entries.find((entry) => entry.store_key === "operation_plans")!.archive_rel_path!);
      const archiveDigestBefore = await sha256File(planArchivePath);
      const stateDigest = await sha256File(storePath);
      const restoreHistoryEntries = selectedStoreRestoreHistory(stateDigest, backupIdDigest, "recovery-command-1", 4,
        operationPlanDigest("private-correlated-plan"));
      const history = {
        entries: restoreHistoryEntries,
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: Date.now() + 10_000,
      };
      const observation = await buildRecoveryPostActionObservation(history,
        { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_RECOVERY_DIR: recoveryRoot });
      const inProcessObservation = await buildRecoveryPostActionObservation({
        ...history,
        not_before_timestamp_ms: restoreHistoryEntries[0]!.timestamp - 1,
      }, { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_RECOVERY_DIR: recoveryRoot }, {
        mode: "in_process_restore",
        expected_command_id: "recovery-command-1",
      });
      const mismatchedCommandObservation = await buildRecoveryPostActionObservation({
        ...history,
        not_before_timestamp_ms: restoreHistoryEntries[0]!.timestamp - 1,
      }, { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_RECOVERY_DIR: recoveryRoot }, {
        mode: "in_process_restore",
        expected_command_id: "another-command",
      });

      expect(observation).toMatchObject({
        status: "matched",
        restore_backup_id_digest: backupIdDigest,
        restore_scope_plan_digest: operationPlanDigest("private-correlated-plan"),
        plan_restore_points: [
          {
            plan_id_digest: operationPlanDigest("private-correlated-plan"),
            backup_plan_record_status: "matched",
            backup_plan_integrity: "residuals_present",
            backup_plan_record_count: 1,
          },
        ],
        used_for_authority: false,
        may_execute: false,
      });
      expect(inProcessObservation).toMatchObject({
        status: "matched",
        operation: "restore",
        store_key: "operation_plans",
        restore_backup_id_digest: backupIdDigest,
        restore_scope_plan_digest: operationPlanDigest("private-correlated-plan"),
        plan_restore_points: [{
          plan_id_digest: operationPlanDigest("private-correlated-plan"),
          backup_plan_record_status: "matched",
          dependency_status: "residuals_present",
        }],
        used_for_authority: false,
        may_execute: false,
      });
      expect(mismatchedCommandObservation.status).toBe("unverified");
      const point = observation.plan_restore_points?.[0];
      expect(point).toMatchObject({
        dependency_status: "residuals_present",
        residual_dependencies: ["operation_plan"],
        unobserved_dependencies: ["broker", "delivery", "cron_approval"],
      });
      expect(await sha256File(planArchivePath)).toBe(archiveDigestBefore);
      expect(JSON.stringify(observation)).not.toContain(backupId);
      expect(JSON.stringify(observation)).not.toContain("private-correlated-plan");
      expect(JSON.stringify(observation)).not.toContain(planArchivePath);
      const stateReader = new OperationPlanStateStore(storePath);
      const checkpoint = stateReader.load();
      stateReader.close();
      const hdsEvidence = operationPlanRecoveryEvidenceFromObservation({
        observation: inProcessObservation,
        checkpoint,
        history_complete: true,
      });
      expect(hdsEvidence?.plans).toMatchObject([{
        plan_id_digest: operationPlanDigest("private-correlated-plan"),
        restore_scope_relation: "requested",
        restore_membership: "restored",
        integrity: "residuals_present",
        dependency_status: "residuals_present",
      }]);
      expect(hdsEvidence?.used_for_authority).toBe(false);
      expect(hdsEvidence?.may_execute).toBe(false);
      expect(JSON.stringify(hdsEvidence)).not.toContain("private-correlated-plan");

      const missingBackup = await buildRecoveryPostActionObservation({
        entries: selectedStoreRestoreHistory(stateDigest, digest("f"), "recovery-command-1", 4,
          operationPlanDigest("private-correlated-plan")),
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: Date.now() + 10_000,
      }, { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_RECOVERY_DIR: recoveryRoot });
      expect(missingBackup.plan_restore_points).toMatchObject([{
        backup_plan_record_status: "unverified",
        backup_plan_integrity: null,
        dependency_status: "unknown",
        residual_dependencies: [],
        unobserved_dependencies: [],
      }]);

      const changedCheckpoint = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [recoveryObservationPlanState("private-after-restore-plan", false)],
      });
      const changedDatabase: DatabaseSyncType = new DatabaseSync(storePath);
      changedDatabase.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
        .run(JSON.stringify(changedCheckpoint), operationPlanDigest(changedCheckpoint));
      changedDatabase.close();
      const postRestorePlan = await buildRecoveryPostActionObservation({
        entries: selectedStoreRestoreHistory(stateDigest, backupIdDigest, "recovery-command-1", 4,
          operationPlanDigest("private-correlated-plan")),
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: Date.now() + 10_000,
      }, { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_RECOVERY_DIR: recoveryRoot });
      expect(postRestorePlan).toMatchObject({
        status: "changed",
        plan_restore_points: [{
          plan_id_digest: operationPlanDigest("private-after-restore-plan"),
          backup_plan_record_status: "not_found",
          dependency_status: "unknown",
        }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps missing or invalid selected-store state distinct from an unobservable sidecar state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-restore-boundary-"));
    try {
      const stateRoot = path.join(root, "state");
      const storePath = await createOperationPlanStore(stateRoot);
      const history = {
        entries: selectedStoreRestoreHistory(await sha256File(storePath)),
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: Date.now() + 10_000,
      };
      await writeFile(storePath, "not a sqlite database", "utf8");
      const mismatch = await buildRecoveryPostActionObservation(history, { BLUE_TANUKI_STATE_ROOT: stateRoot });
      expect(mismatch).toMatchObject({ status: "mismatch", store_key: "operation_plans" });

      await rm(storePath);
      const validStore = await createOperationPlanStore(stateRoot);
      await writeFile(`${validStore}-wal`, "pending-sidecar", "utf8");
      const unverified = await buildRecoveryPostActionObservation(history, { BLUE_TANUKI_STATE_ROOT: stateRoot });
      expect(unverified).toMatchObject({ status: "unverified", store_key: "operation_plans" });

      await rm(`${validStore}-wal`);
      await rm(validStore);
      const missing = await buildRecoveryPostActionObservation(history, { BLUE_TANUKI_STATE_ROOT: stateRoot });
      expect(missing).toMatchObject({ status: "mismatch", store_key: "operation_plans" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
