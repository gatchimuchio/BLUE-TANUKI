import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import {
  OperationPlanCheckpointSchema,
  type ExecutionAdmission,
  type OperationPlan,
  type OperationPlanCheckpoint,
} from "@blue-tanuki/protocol";
import { captureCanonicalStateSnapshots, inspectCanonicalStateSnapshots } from "../src/canonical_state_backup.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import {
  buildRecoverySnapshot,
  correlateTaskMemoryRestorePoints,
  createRecoveryBackup,
  factoryResetRecovery,
  inspectLatestRecoveryBackup,
  inspectRecoveryPlanRestoreScopeApplicability,
  inspectRecoveryTaskRestoreScopeApplicability,
  resetRecoveryConnector,
  resetRecoveryProvider,
  restoreRecoveryBackup,
  type RecoveryBackupOperationPlanDependencyInventory,
  type RecoveryBackupOperationPlanInventory,
} from "../src/recovery_surface.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const brokerCommandKey = (id: string): string => createHash("sha256")
  .update(JSON.stringify(["gateway-executor-command.v1", id])).digest("hex");

function seedBrokerReceipt(
  store: GatewayExecutionIntentStore,
  id: string,
  epoch: string,
  taskIdentityDigest?: string,
): void {
  const now = Date.now();
  const ticket = {
    ticket_id: randomUUID(),
    command_key: brokerCommandKey(id),
    command_digest: createHash("sha256").update(`${id}-command`).digest("hex"),
    proof_digest: createHash("sha256").update(`${id}-proof`).digest("hex"),
    ...(taskIdentityDigest ? { task_identity_digest: taskIdentityDigest } : {}),
    execution_epoch: epoch,
    issued_at_ms: now,
    expires_at_ms: now + 60_000,
  };
  store.issue(ticket);
  store.consume(ticket, now + 1);
  store.complete(ticket, { state: "not_attempted", feedback_status: "failed", observed_at_ms: now + 2 });
}

const CANONICAL_DATABASES = [
  ["j_control", path.join("result-memory", "j-control.sqlite")],
  ["m_state", path.join("result-memory", "m-state.sqlite")],
  ["broker", path.join("execution-intents", "executor.sqlite")],
  ["operation_plans", path.join("operation-plans", "j-state.sqlite")],
  ["cron_events", path.join("cron-events", "cron-events.sqlite")],
] as const;

describe("task-scoped M restore-point correlation", () => {
  it("keeps task lineages isolated and reports missing backup membership as unobserved", () => {
    const inventory: RecoveryBackupOperationPlanInventory = {
      status: "verified", reason: null, plan_scope_count: 3, plan_count: 3,
      plan_integrity_residual_count: 0, binding_count: 0, verified_binding_count: 0,
      residual_binding_count: 0, unverified_memory_link_count: 0, omitted_binding_count: 0,
      omitted_plan_scope_count: 0,
      plan_scopes: [
        { plan_id_digest: "a".repeat(64), task_identity_digest: "1".repeat(64), request_scope_digest: null,
          integrity: "verified", plan_record_count: 1, binding_count: 1, residual_binding_count: 0, omitted_binding_count: 0 },
        { plan_id_digest: "b".repeat(64), task_identity_digest: "1".repeat(64), request_scope_digest: null,
          integrity: "verified", plan_record_count: 1, binding_count: 1, residual_binding_count: 0, omitted_binding_count: 0 },
        { plan_id_digest: "c".repeat(64), task_identity_digest: "2".repeat(64), request_scope_digest: null,
          integrity: "verified", plan_record_count: 1, binding_count: 1, residual_binding_count: 0, omitted_binding_count: 0 },
      ],
      cross_ledger_correlation: "not_performed", used_for_authority: false, may_execute: false,
    };
    const dependencies: RecoveryBackupOperationPlanDependencyInventory = {
      status: "residuals_present", reason: null, plan_scope_count: 3, residual_plan_scope_count: 1,
      unobserved_plan_scope_count: 0, omitted_plan_scope_count: 0,
      plan_scopes: [
        { plan_id_digest: "a".repeat(64), status: "observed", residual_dependencies: [], unobserved_dependencies: [] },
        { plan_id_digest: "b".repeat(64), status: "residuals_present", residual_dependencies: ["memory"], unobserved_dependencies: [] },
        { plan_id_digest: "c".repeat(64), status: "observed", residual_dependencies: [], unobserved_dependencies: [] },
      ],
      cross_store_consistency: "independent_sqlite_online_snapshots", cross_store_atomic: false,
      external_backup_restore_point: "not_examined", used_for_authority: false, may_execute: false,
    };

    expect(correlateTaskMemoryRestorePoints([
      { plan_id_digest: "a".repeat(64), task_identity_digest: "1".repeat(64) },
      { plan_id_digest: "b".repeat(64), task_identity_digest: "1".repeat(64) },
      { plan_id_digest: "c".repeat(64), task_identity_digest: "2".repeat(64) },
      { plan_id_digest: "d".repeat(64), task_identity_digest: "3".repeat(64) },
    ], inventory, dependencies)).toEqual([
      { task_identity_digest: "1".repeat(64), plan_id_digests: ["a".repeat(64), "b".repeat(64)],
        dependency_status: "residuals_present" },
      { task_identity_digest: "2".repeat(64), plan_id_digests: ["c".repeat(64)], dependency_status: "observed" },
      { task_identity_digest: "3".repeat(64), plan_id_digests: ["d".repeat(64)], dependency_status: "unobserved" },
    ]);
    expect(correlateTaskMemoryRestorePoints([
      { plan_id_digest: "a".repeat(64), task_identity_digest: "1".repeat(64) },
    ], inventory, dependencies)?.[0]?.dependency_status).toBe("unobserved");
  });
});

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function createCanonicalDatabase(stateRoot: string, relativePath: string, marker: string): Promise<string> {
  const filepath = path.join(stateRoot, "private-state", relativePath);
  await mkdir(path.dirname(filepath), { recursive: true });
  const database: DatabaseSyncType = new DatabaseSync(filepath);
  database.exec("CREATE TABLE snapshot_fixture (value TEXT NOT NULL)");
  database.prepare("INSERT INTO snapshot_fixture (value) VALUES (?)").run(marker);
  database.close();
  return filepath;
}

function readCanonicalDatabase(filepath: string): string[] {
  const database: DatabaseSyncType = new DatabaseSync(filepath, { readOnly: true });
  try {
    return (database.prepare("SELECT value FROM snapshot_fixture ORDER BY rowid").all() as Array<{ value: string }>).map((row) => row.value);
  } finally {
    database.close();
  }
}

function recoveryPlanCheckpoint(suffix = "one"): { checkpoint: OperationPlanCheckpoint; planScopeDigest: string } {
  const step: OperationPlan["steps"][number] = {
    step_id: `recovery-scope-step-${suffix}`,
    operation: "file.search",
    target: { kind: "directory", id: "fixture-workspace" },
    state: "planned",
    effects: ["read"],
    permission: {
      risk: "low",
      approval_level: "L1_observe",
      final_review_required: false,
      hds_brain_authority_required: true,
      approval_gate_required: true,
    },
    adapter: "internal_runtime",
    adapter_is_authority: false,
    command_generated_by_adapter_only: false,
    parameters: { root: "fixture-workspace", query: "fixture", max_results: 1 },
    preparation: {
      depends_on: [],
      bindings: [],
      preconditions: [],
      validation: [{
        check_id: `recovery-scope-check-${suffix}`,
        method: "result_equals",
        target: { kind: "directory", id: "fixture-workspace" },
        expected: { count: 0 },
      }],
      compensation: { available: false, reason: "fixture" },
    },
  };
  const plan: OperationPlan = {
    version: "operation-core.v1",
    plan_id: `recovery-scope-plan-${suffix}`,
    request_id: `recovery-scope-request-${suffix}`,
    state: "planned",
    steps: [step],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false,
    hds_brain_authority_required: true,
  };
  const revisionDigest = operationPlanDigest(plan);
  const { state: _state, result_digest: _result, ...stepDefinition } = step;
  const commandId = `recovery-scope-command-${suffix}`;
  const admission: ExecutionAdmission = {
    ticket_id: randomUUID(),
    command_key: createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", commandId])).digest("hex"),
    command_digest: createHash("sha256").update(`recovery-scope-command-digest-${suffix}`).digest("hex"),
    proof_digest: createHash("sha256").update(`recovery-scope-proof-${suffix}`).digest("hex"),
    execution_epoch: randomUUID(),
    issued_at_ms: 10_000,
    expires_at_ms: 20_000,
  };
  const checkpoint = OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [{
      owner: "fixture-owner",
      channel: "webchat",
      goal: `fixture recovery scope ${suffix}`,
      revisions: [{ digest: revisionDigest, plan }],
      receipt_observations: [],
      bindings: [{
        step_id: step.step_id,
        revision_digest: revisionDigest,
        step_digest: operationPlanDigest(stepDefinition),
        prepared_step: step,
        command_id: commandId,
        request_id: plan.request_id,
        commit_hash: createHash("sha256").update(`recovery-scope-commit-${suffix}`).digest("hex"),
        payload_digest: createHash("sha256").update(`recovery-scope-payload-${suffix}`).digest("hex"),
        command_digest: admission.command_digest,
        operation: step.operation,
        status: "intent_committed",
        execution_admission: admission,
      }],
      results: [],
    }],
  });
  return { checkpoint, planScopeDigest: operationPlanDigest(plan.plan_id) };
}

function recoveryWait(planIdDigest: string, revisionDigest: string, suffix: string, taskIdentityDigest?: string) {
  const digest = (label: string) => createHash("sha256").update(`${suffix}-${label}`).digest("hex");
  return {
    wait_id: digest("wait"),
    plan_id_digest: planIdDigest,
    task_identity_digest: taskIdentityDigest ?? digest("task"),
    revision_digest: revisionDigest,
    owner_digest: digest("owner"),
    channel_digest: digest("channel"),
    session_id_digest: digest("session"),
    deadline_at_ms: 20_000,
    created_at_ms: 10_000,
    state: "waiting" as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
}

function recoveryUnboundShellObservation(suffix: string) {
  const digest = (label: string) => createHash("sha256").update(`${suffix}-${label}`).digest("hex");
  return {
    schema_version: "operation-plan-shell-exec-result.v1" as const,
    owner_digest: digest("owner"),
    channel_digest: digest("channel"),
    request_id_digest: digest("request"),
    command_id_digest: digest("command"),
    upstream_commit_hash_digest: digest("commit"),
    command_payload_digest: digest("payload"),
    result_id_digest: digest("result-id"),
    result_contract_digest: digest("contract"),
    result_digest: digest("result"),
    execution_status: "succeeded" as const,
    execution_boundary: "tool_adapter" as const,
    action_outcome: "reported_success" as const,
    plan_step_binding: "unbound" as const,
    observed_at_ms: 10_000,
    used_for_authority: false as const,
    may_execute: false as const,
  };
}

describe("buildRecoverySnapshot", () => {
  it("reports env backup inventory and recovery control boundaries without exposing env contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-"));
    try {
      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const sessionDir = path.join(root, "sessions");
      const memoryDir = path.join(root, "memory");
      const memoryFile = path.join(memoryDir, "memory.jsonl");
      const failureMemoryDir = path.join(root, "failure-memory");
      const schedulesDir = path.join(root, "schedules");
      const fileRoot = path.join(root, "files");
      await mkdir(auditDir);
      await mkdir(sessionDir);
      await mkdir(memoryDir);
      await mkdir(failureMemoryDir);
      await mkdir(schedulesDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_API_KEY=secret-value\n", "utf8");
      await writeFile(memoryFile, "{}\n", "utf8");
      await writeFile(`${envFile}.2026-06-13T01-00-00-000Z.101.settings.bak`, "older\n", "utf8");
      await writeFile(`${envFile}.2026-06-13T02-00-00-000Z.101.setup.bak`, "newer\n", "utf8");

      const snapshot = await buildRecoverySnapshot({
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_AUDIT_DIR: auditDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_MEMORY_FILE: memoryFile,
        BLUE_TANUKI_MEMORY_DIR: memoryDir,
        BLUE_TANUKI_FAILURE_MEMORY_DIR: failureMemoryDir,
        BLUE_TANUKI_SCHEDULES_DIR: schedulesDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
      });

      expect(snapshot.surface).toBe("recovery");
      expect(snapshot.mode).toBe("control_available");
      expect(snapshot.env_file).toMatchObject({
        configured: true,
        path: envFile,
        exists: true,
        backup_count: 2,
        secret_material: true,
      });
      expect(snapshot.env_file.latest_backup_path).toContain("setup.bak");
      expect(JSON.stringify(snapshot)).not.toContain("secret-value");
      expect(snapshot.runtime_paths.audit_dir).toMatchObject({
        configured: true,
        path: auditDir,
        exists: true,
        kind: "directory",
      });
      expect(snapshot.runtime_paths.memory_file).toMatchObject({
        configured: true,
        path: memoryFile,
        exists: true,
        kind: "file",
      });
      expect(snapshot.restore).toMatchObject({
        execution_available: false,
        restore_review_request_available: false,
        backup_available: true,
        latest_backup_id: null,
        factory_reset_review_request_available: true,
        provider_reset_review_request_available: true,
        connector_reset_review_request_available: true,
        factory_reset_available: false,
        provider_reset_available: false,
        connector_reset_available: false,
        blocked_reason: "owner_l3_review_required",
        destructive_repair_available: false,
        confirmation_required: true,
      });
      expect(snapshot.authority_boundary).toEqual({
        ui_used_for_authority: false,
        recovery_metadata_used_for_authority: false,
        recovery_action_used_for_authority: false,
        used_for_authority: false,
      });
      expect(snapshot.evidence_source).toEqual(["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up, restores, resets providers/connectors, and preserves audit on factory reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-actions-"));
    try {
      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const sessionDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionDir, "session.jsonl");
      const memoryDir = path.join(root, "memory");
      const memoryFile = path.join(memoryDir, "memory.jsonl");
      const failureMemoryDir = path.join(root, "failure-memory");
      const schedulesDir = path.join(root, "schedules");
      const logsDir = path.join(root, "logs");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await mkdir(auditDir);
      await mkdir(sessionDir);
      await mkdir(memoryDir);
      await mkdir(failureMemoryDir);
      await mkdir(schedulesDir);
      await mkdir(logsDir);
      await mkdir(fileRoot);
      await writeFile(path.join(auditDir, "audit.jsonl"), "{}\n", "utf8");
      await writeFile(sessionFile, "session-before\n", "utf8");
      await writeFile(memoryFile, "memory-before\n", "utf8");
      await writeFile(path.join(failureMemoryDir, "failure.jsonl"), "failure-before\n", "utf8");
      await writeFile(path.join(schedulesDir, "jobs.json"), "[]\n", "utf8");
      await writeFile(path.join(logsDir, "gateway.log"), "log-before\n", "utf8");
      await writeFile(
        envFile,
        [
          "LLM_BACKEND=openrouter",
          "OPENROUTER_API_KEY=provider-secret-value",
          "OPENROUTER_MODEL=openrouter/model",
          "COMPOSIO_API_KEY=connector-secret-value",
          "COMPOSIO_ALLOWED_TOOLKITS=github",
          "COMPOSIO_ALLOWED_ACTIONS=github:GITHUB_CREATE_AN_ISSUE",
          "COMPOSIO_DRY_RUN=false",
          "COMPOSIO_LIVE_EXECUTION=true",
          "",
        ].join("\n"),
        "utf8",
      );

      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_AUDIT_DIR: auditDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_MEMORY_FILE: memoryFile,
        BLUE_TANUKI_MEMORY_DIR: memoryDir,
        BLUE_TANUKI_FAILURE_MEMORY_DIR: failureMemoryDir,
        BLUE_TANUKI_SCHEDULES_DIR: schedulesDir,
        BLUE_TANUKI_LOG_DIR: logsDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
        LLM_BACKEND: "openrouter",
        OPENROUTER_API_KEY: "provider-secret-value",
        COMPOSIO_API_KEY: "connector-secret-value",
        COMPOSIO_DRY_RUN: "false",
        COMPOSIO_LIVE_EXECUTION: "true",
      };

      const backup = await createRecoveryBackup(env);
      expect(backup.action).toBe("backup");
      expect(backup.backup_id).toBeTruthy();
      expect(JSON.stringify(backup)).not.toContain("provider-secret-value");
      expect(JSON.stringify(backup)).not.toContain("connector-secret-value");
      expect((await buildRecoverySnapshot(env)).restore).toMatchObject({
        execution_available: false,
        restore_review_request_available: true,
        factory_reset_review_request_available: true,
        provider_reset_review_request_available: true,
        connector_reset_review_request_available: true,
        factory_reset_available: false,
        provider_reset_available: false,
        connector_reset_available: false,
        blocked_reason: "owner_l3_review_required",
      });

      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({
        surface: "recovery_backup_inspection",
        mode: "read_only",
        status: "verified",
        backup_id_digest: createHash("sha256").update(backup.backup_id!).digest("hex"),
        coverage: "complete_for_configured_targets",
        canonical_state_coverage: "none_present",
        canonical_state_expected_store_count: 5,
        canonical_state_snapshot_count: 0,
        canonical_state_verified_store_count: 0,
        canonical_state_missing_store_count: 5,
        canonical_state_unverified_store_count: 0,
        canonical_state_store_consistency: "independent_sqlite_online_snapshots",
        canonical_state_cross_store_atomic: false,
        canonical_state_stores: [
          { store_key: "j_control", status: "not_present" },
          { store_key: "m_state", status: "not_present" },
          { store_key: "broker", status: "not_present" },
          { store_key: "operation_plans", status: "not_present" },
          { store_key: "cron_events", status: "not_present" },
        ],
        used_for_authority: false,
        may_execute: false,
      });
      expect(inspection.copied_required_item_count).toBe(inspection.configured_required_item_count);
      expect(JSON.stringify(inspection)).not.toContain("provider-secret-value");
      expect(JSON.stringify(inspection)).not.toContain("connector-secret-value");

      await writeFile(envFile, "LLM_BACKEND=broken\n", "utf8");
      await writeFile(sessionFile, "session-after\n", "utf8");
      const restored = await restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        confirm: "RESTORE",
      });
      expect(restored.restored_items_count).toBeGreaterThan(0);
      expect(await readFile(envFile, "utf8")).toContain("OPENROUTER_API_KEY=provider-secret-value");
      expect(await readFile(sessionFile, "utf8")).toBe("session-before\n");
      expect(JSON.stringify(restored)).not.toContain("provider-secret-value");

      const providerReset = await resetRecoveryProvider(env, { confirm: "RESET_PROVIDER" });
      const providerEnv = await readFile(envFile, "utf8");
      expect(providerEnv).toContain("LLM_BACKEND=stub");
      expect(providerEnv).not.toContain("OPENROUTER_API_KEY=");
      expect(providerEnv).not.toContain("provider-secret-value");
      expect(providerReset.reset_keys).toContain("OPENROUTER_API_KEY");
      expect(JSON.stringify(providerReset)).not.toContain("provider-secret-value");

      const connectorReset = await resetRecoveryConnector(env, { confirm: "RESET_CONNECTOR" });
      const connectorEnv = await readFile(envFile, "utf8");
      expect(connectorEnv).toContain("COMPOSIO_DRY_RUN=true");
      expect(connectorEnv).toContain("COMPOSIO_LIVE_EXECUTION=false");
      expect(connectorEnv).not.toContain("COMPOSIO_API_KEY=");
      expect(connectorEnv).not.toContain("connector-secret-value");
      expect(connectorReset.reset_keys).toContain("COMPOSIO_API_KEY");

      await mkdir(sessionDir, { recursive: true });
      await mkdir(memoryDir, { recursive: true });
      await mkdir(failureMemoryDir, { recursive: true });
      await mkdir(schedulesDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeFile(sessionFile, "session-reset\n", "utf8");
      await writeFile(memoryFile, "memory-reset\n", "utf8");
      await writeFile(path.join(schedulesDir, "jobs.json"), "[]\n", "utf8");
      await writeFile(path.join(logsDir, "gateway.log"), "log-reset\n", "utf8");

      const factory = await factoryResetRecovery(env, { confirm: "FACTORY_RESET" });
      expect(factory.action).toBe("factory_reset");
      expect(await exists(sessionDir)).toBe(false);
      expect(await exists(memoryDir)).toBe(false);
      expect(await exists(schedulesDir)).toBe(false);
      expect(await exists(logsDir)).toBe(false);
      expect(await exists(auditDir)).toBe(true);
      expect(await exists(recoveryDir)).toBe(true);
      expect(JSON.stringify(factory)).not.toContain("provider-secret-value");
      expect(JSON.stringify(factory)).not.toContain("connector-secret-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("restores only the selected verified canonical store after a pre-action snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-selective-store-restore-"));
    let livePlanStore: OperationPlanStateStore | undefined;
    try {
      const envFile = path.join(root, "product.env");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const selectedPath = path.join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
      await mkdir(path.dirname(selectedPath), { recursive: true });
      const unrelatedPath = await createCanonicalDatabase(
        stateRoot,
        path.join("execution-intents", "executor.sqlite"),
        "unrelated-state",
      );
      const unrelatedBefore = await readFile(unrelatedPath);
      livePlanStore = new OperationPlanStateStore(selectedPath);
      const requestedBackup = recoveryPlanCheckpoint("requested");
      const siblingBackup = recoveryPlanCheckpoint("sibling");
      const taskIdentityDigest = operationPlanDigest({ schema_version: "fixture-task-identity.v1", task: "shared-recovery-task" });
      const requestedRevisionDigest = requestedBackup.checkpoint.plans[0]!.revisions[0]!.digest;
      const siblingRevisionDigest = siblingBackup.checkpoint.plans[0]!.revisions[0]!.digest;
      const checkpoint = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [...requestedBackup.checkpoint.plans, ...siblingBackup.checkpoint.plans]
          .map((plan) => ({ ...plan, task_identity_digest: taskIdentityDigest })),
        waits: [
          recoveryWait(requestedBackup.planScopeDigest, requestedRevisionDigest, "backup-requested", taskIdentityDigest),
          recoveryWait(siblingBackup.planScopeDigest, siblingRevisionDigest, "backup-sibling", taskIdentityDigest),
        ],
        shell_exec_result_observations: [recoveryUnboundShellObservation("backup")],
      });
      const planScopeDigest = requestedBackup.planScopeDigest;
      livePlanStore.compareAndSet(null, checkpoint);
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };
      const backup = await createRecoveryBackup(env);
      const packsBeforeRejectedRestore = await readdir(recoveryDir);
      await expect(restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        store_key: "operation_plans",
        confirm: "RESTORE",
      })).rejects.toThrow("operation_plan_scope_required");
      await expect(restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        store_key: "operation_plans",
        scope_kind: "operation_plan",
        scope_digest: "f".repeat(64),
        confirm: "RESTORE",
      })).rejects.toThrow("operation_plan_scope_unverified");
      expect(await readdir(recoveryDir)).toEqual(packsBeforeRejectedRestore);
      const restoreScopeInspection = await inspectRecoveryPlanRestoreScopeApplicability(env, backup.backup_id!, planScopeDigest);
      expect(restoreScopeInspection).toMatchObject({
        status: "matched",
        reason: null,
        backup_task_identity_digest: taskIdentityDigest,
        backup_task_lineage_plan_scope_count: 2,
        backup_task_lineage_integrity: "verified",
      });
      await writeFile(envFile, "LLM_BACKEND=changed\n", "utf8");
      const currentCheckpoint = OperationPlanCheckpointSchema.parse({
        ...checkpoint,
        plans: checkpoint.plans.map((plan) => ({ ...plan,
          goal: plan.revisions[0]!.plan.plan_id === "recovery-scope-plan-requested"
            ? "current requested plan should be replaced"
            : "current sibling plan should be preserved" })),
        waits: [
          recoveryWait(requestedBackup.planScopeDigest, requestedRevisionDigest, "current-requested", taskIdentityDigest),
          recoveryWait(siblingBackup.planScopeDigest, siblingRevisionDigest, "current-sibling", taskIdentityDigest),
        ],
        shell_exec_result_observations: [recoveryUnboundShellObservation("current")],
      });
      livePlanStore.compareAndSet(operationPlanDigest(checkpoint), currentCheckpoint);

      const restored = await restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        store_key: "operation_plans",
        scope_kind: "operation_plan",
        scope_digest: planScopeDigest,
        confirm: "RESTORE",
      });

      const expectedCheckpoint = OperationPlanCheckpointSchema.parse({
        ...currentCheckpoint,
        plans: currentCheckpoint.plans.map((plan) => plan.revisions[0]!.plan.plan_id === "recovery-scope-plan-requested"
          ? checkpoint.plans.find((backupPlan) => backupPlan.revisions[0]!.plan.plan_id === "recovery-scope-plan-requested")!
          : plan),
        waits: [
          recoveryWait(requestedBackup.planScopeDigest, requestedRevisionDigest, "backup-requested", taskIdentityDigest),
          recoveryWait(siblingBackup.planScopeDigest, siblingRevisionDigest, "current-sibling", taskIdentityDigest),
        ],
        shell_exec_result_observations: [recoveryUnboundShellObservation("current")],
      });
      expect(livePlanStore.load()).toEqual(expectedCheckpoint);
      expect(await readFile(unrelatedPath)).toEqual(unrelatedBefore);
      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=changed\n");
      expect(restored).toMatchObject({
        action: "restore",
        restored_backup_id: backup.backup_id,
        restored_store_key: "operation_plans",
        restore_scope_kind: "operation_plan",
        restore_scope_digest: planScopeDigest,
        restore_scope_mode: "plan_scoped_merge_v1",
        canonical_state_cross_store_atomic: false,
      });
      expect(restored.restored_store_archive_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(restored.restored_store_state_digest).toBe(
        createHash("sha256").update(await readFile(selectedPath)).digest("hex"),
      );
      expect(restored.pre_action_backup_id).toBeTruthy();
      const preActionManifest = JSON.parse(await readFile(
        path.join(recoveryDir, restored.pre_action_backup_id!, "manifest.json"),
        "utf8",
      )) as { canonical_state_snapshot: { entries: Array<{ store_key: string; status: string }> } };
      expect(preActionManifest.canonical_state_snapshot.entries.find((entry) => entry.store_key === "operation_plans")?.status)
        .toBe("verified");
      expect(JSON.stringify(restored)).not.toContain(selectedPath);
      expect(JSON.stringify(restored)).not.toContain(unrelatedPath);
    } finally {
      try { livePlanStore?.close(); } catch { /* test cleanup */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores one complete task lineage while retaining unrelated plans, waits, and live shell observations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-task-scope-restore-"));
    let livePlanStore: OperationPlanStateStore | undefined;
    try {
      const envFile = path.join(root, "product.env");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const selectedPath = path.join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
      await mkdir(path.dirname(selectedPath), { recursive: true });
      const firstBackup = recoveryPlanCheckpoint("task-first");
      const siblingBackup = recoveryPlanCheckpoint("task-sibling");
      const unrelatedBackup = recoveryPlanCheckpoint("task-unrelated");
      const taskIdentityDigest = operationPlanDigest({ schema_version: "fixture-task-identity.v1", task: "shared-task-scope" });
      const unrelatedTaskDigest = operationPlanDigest({ schema_version: "fixture-task-identity.v1", task: "unrelated-task-scope" });
      const firstPlan = { ...firstBackup.checkpoint.plans[0]!, task_identity_digest: taskIdentityDigest };
      const siblingPlan = { ...siblingBackup.checkpoint.plans[0]!, task_identity_digest: taskIdentityDigest };
      const unrelatedPlan = { ...unrelatedBackup.checkpoint.plans[0]!, task_identity_digest: unrelatedTaskDigest };
      const archived = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [firstPlan, siblingPlan, unrelatedPlan],
        waits: [
          recoveryWait(firstBackup.planScopeDigest, firstPlan.revisions[0]!.digest, "archive-first", taskIdentityDigest),
          recoveryWait(siblingBackup.planScopeDigest, siblingPlan.revisions[0]!.digest, "archive-sibling", taskIdentityDigest),
          recoveryWait(unrelatedBackup.planScopeDigest, unrelatedPlan.revisions[0]!.digest, "archive-unrelated", unrelatedTaskDigest),
        ],
        shell_exec_result_observations: [recoveryUnboundShellObservation("archive")],
      });
      livePlanStore = new OperationPlanStateStore(selectedPath);
      livePlanStore.compareAndSet(null, archived);
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };
      const backup = await createRecoveryBackup(env);
      const scope = await inspectRecoveryTaskRestoreScopeApplicability(env, backup.backup_id!, taskIdentityDigest);
      expect(scope).toMatchObject({
        status: "matched",
        reason: null,
        scope_kind: "task_identity",
        scope_digest: taskIdentityDigest,
        matched_plan_id_digest: null,
        matched_plan_scope_count: 2,
        matched_plan_id_digests: [firstBackup.planScopeDigest, siblingBackup.planScopeDigest].sort(),
        backup_task_identity_digest: taskIdentityDigest,
        backup_task_lineage_plan_scope_count: 2,
        backup_task_lineage_integrity: "verified",
        cross_store_atomic: false,
        used_for_authority: false,
        may_execute: false,
      });

      const current = OperationPlanCheckpointSchema.parse({
        ...archived,
        plans: archived.plans.map((plan) => ({ ...plan,
          goal: `current:${plan.revisions[0]!.plan.plan_id}` })),
        waits: [
          recoveryWait(firstBackup.planScopeDigest, firstPlan.revisions[0]!.digest, "current-first", taskIdentityDigest),
          recoveryWait(siblingBackup.planScopeDigest, siblingPlan.revisions[0]!.digest, "current-sibling", taskIdentityDigest),
          recoveryWait(unrelatedBackup.planScopeDigest, unrelatedPlan.revisions[0]!.digest, "current-unrelated", unrelatedTaskDigest),
        ],
        shell_exec_result_observations: [recoveryUnboundShellObservation("current")],
      });
      livePlanStore.compareAndSet(operationPlanDigest(archived), current);

      const restored = await restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        store_key: "operation_plans",
        scope_kind: "task_identity",
        scope_digest: taskIdentityDigest,
        confirm: "RESTORE",
      });
      const expected = OperationPlanCheckpointSchema.parse({
        ...current,
        plans: [firstPlan, siblingPlan, current.plans.find((plan) =>
          plan.revisions[0]!.plan.plan_id === unrelatedPlan.revisions[0]!.plan.plan_id)!],
        waits: [
          recoveryWait(firstBackup.planScopeDigest, firstPlan.revisions[0]!.digest, "archive-first", taskIdentityDigest),
          recoveryWait(siblingBackup.planScopeDigest, siblingPlan.revisions[0]!.digest, "archive-sibling", taskIdentityDigest),
          recoveryWait(unrelatedBackup.planScopeDigest, unrelatedPlan.revisions[0]!.digest, "current-unrelated", unrelatedTaskDigest),
        ],
        shell_exec_result_observations: [recoveryUnboundShellObservation("current")],
      });
      expect(livePlanStore.load()).toEqual(expected);
      expect(restored).toMatchObject({
        action: "restore",
        restored_store_key: "operation_plans",
        restore_scope_kind: "task_identity",
        restore_scope_digest: taskIdentityDigest,
        restore_scope_mode: "task_scoped_merge_v1",
        canonical_state_cross_store_atomic: false,
      });
      expect(restored.restored_store_state_digest).toBe(
        createHash("sha256").update(await readFile(selectedPath)).digest("hex"),
      );
    } finally {
      try { livePlanStore?.close(); } catch { /* test cleanup */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores Broker receipts for one verified task lineage without replacing current or unrelated history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-broker-task-scope-restore-"));
    let planStore: OperationPlanStateStore | undefined;
    let brokerStore: GatewayExecutionIntentStore | undefined;
    try {
      const envFile = path.join(root, "product.env");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const env = { BLUE_TANUKI_ENV_FILE: envFile, BLUE_TANUKI_RECOVERY_DIR: recoveryDir, BLUE_TANUKI_STATE_ROOT: stateRoot };
      const taskIdentityDigest = operationPlanDigest({ schema_version: "fixture-task-identity.v1", task: "broker-restore-target" });
      const unrelatedTaskDigest = operationPlanDigest({ schema_version: "fixture-task-identity.v1", task: "broker-restore-unrelated" });
      const baseCheckpoint = recoveryPlanCheckpoint("broker-task-restore").checkpoint;
      const taskPlan = { ...baseCheckpoint.plans[0]!, task_identity_digest: taskIdentityDigest };
      const checkpoint = OperationPlanCheckpointSchema.parse({ ...baseCheckpoint, plans: [taskPlan] });
      const planPath = path.join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
      planStore = new OperationPlanStateStore(planPath);
      planStore.compareAndSet(null, checkpoint);

      const archivedEpoch = randomUUID();
      brokerStore = GatewayExecutionIntentStore.fromEnvironment(archivedEpoch, env);
      seedBrokerReceipt(brokerStore, "archived-selected-task", archivedEpoch, taskIdentityDigest);
      seedBrokerReceipt(brokerStore, "archived-unrelated-task", archivedEpoch, unrelatedTaskDigest);
      const backup = await createRecoveryBackup(env);
      const brokerPath = path.join(stateRoot, "private-state", "execution-intents", "executor.sqlite");
      brokerStore.close();
      brokerStore = undefined;

      // Simulate a current Broker ledger that no longer contains the archived selected receipt.
      await unlink(brokerPath);
      const currentEpoch = randomUUID();
      brokerStore = GatewayExecutionIntentStore.fromEnvironment(currentEpoch, env);
      seedBrokerReceipt(brokerStore, "current-selected-task", currentEpoch, taskIdentityDigest);
      seedBrokerReceipt(brokerStore, "current-unrelated-task", currentEpoch, unrelatedTaskDigest);
      const restoreCommandId = "fixture-task-scoped-broker-restore";
      const restoreTicket = {
        ticket_id: randomUUID(),
        command_key: brokerCommandKey(restoreCommandId),
        command_digest: createHash("sha256").update("restore-command").digest("hex"),
        proof_digest: createHash("sha256").update("restore-proof").digest("hex"),
        task_identity_digest: taskIdentityDigest,
        execution_epoch: currentEpoch,
        issued_at_ms: Date.now(),
        expires_at_ms: Date.now() + 60_000,
      };
      brokerStore.issue(restoreTicket);
      brokerStore.consume(restoreTicket, restoreTicket.issued_at_ms + 1);
      brokerStore.markInvocation(restoreTicket, "tool_adapter", restoreTicket.issued_at_ms + 2);

      const applicability = await inspectRecoveryTaskRestoreScopeApplicability(
        env, backup.backup_id!, taskIdentityDigest, "broker",
      );
      expect(applicability).toMatchObject({
        status: "matched",
        scope_kind: "task_identity",
        scope_digest: taskIdentityDigest,
        store_candidate_count: 1,
        verified_store_candidate_count: 1,
        store_candidates: [{ store_key: "broker", snapshot_status: "verified", related_dependencies: ["broker", "delivery"] }],
        used_for_authority: false,
        may_execute: false,
      });

      const restored = await restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        store_key: "broker",
        scope_kind: "task_identity",
        scope_digest: taskIdentityDigest,
        executor_command_key: restoreTicket.command_key,
        broker_execution_store: brokerStore,
        confirm: "RESTORE",
      });

      expect(restored).toMatchObject({
        restored_store_key: "broker",
        restore_scope_kind: "task_identity",
        restore_scope_digest: taskIdentityDigest,
        restore_scope_mode: "task_scoped_merge_v1",
        restored_items_count: 1,
        canonical_state_cross_store_atomic: false,
      });
      expect(brokerStore.lookupCommand(brokerCommandKey("archived-selected-task"))?.state).toBe("not_attempted");
      expect(brokerStore.lookupCommand(brokerCommandKey("archived-unrelated-task"))).toBeNull();
      expect(brokerStore.lookupCommand(brokerCommandKey("current-selected-task"))?.state).toBe("not_attempted");
      expect(brokerStore.lookupCommand(brokerCommandKey("current-unrelated-task"))?.state).toBe("not_attempted");
      expect(brokerStore.verifyEvents()).toBe(true);
    } finally {
      try { planStore?.close(); } catch { /* test cleanup */ }
      try { brokerStore?.close(); } catch { /* test cleanup */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects selective recovery capacity overflow and stale pre-action state without mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-selective-restore-guards-"));
    const store = new OperationPlanStateStore(path.join(root, "state.sqlite"));
    try {
      const requested = recoveryPlanCheckpoint("guard-requested");
      const sibling = recoveryPlanCheckpoint("guard-sibling");
      const requestedPlan = requested.checkpoint.plans[0]!;
      const siblingPlan = sibling.checkpoint.plans[0]!;
      const requestedRevision = requestedPlan.revisions[0]!.digest;
      const siblingRevision = siblingPlan.revisions[0]!.digest;
      const current = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [requestedPlan, siblingPlan],
        waits: Array.from({ length: 100 }, (_, index) =>
          recoveryWait(sibling.planScopeDigest, siblingRevision, `current-sibling-${index}`)),
      });
      const archived = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [requestedPlan],
        waits: Array.from({ length: 200 }, (_, index) =>
          recoveryWait(requested.planScopeDigest, requestedRevision, `archive-requested-${index}`)),
      });
      store.compareAndSet(null, current);

      expect(() => store.restorePlanScope(archived, requested.planScopeDigest, current))
        .toThrow("operation_plan_restore_scope_wait_capacity");
      expect(store.load()).toEqual(current);

      const changed = OperationPlanCheckpointSchema.parse({
        ...current,
        plans: current.plans.map((plan) => ({ ...plan, goal: "concurrent writer update" })),
      });
      store.compareAndSet(operationPlanDigest(current), changed);
      expect(() => store.restorePlanScope(archived, requested.planScopeDigest, current))
        .toThrow("operation_plan_restore_scope_target_changed");
      expect(store.load()).toEqual(changed);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unverified selected store before creating a pre-action pack or changing state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-unverified-store-restore-"));
    try {
      const envFile = path.join(root, "product.env");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const selectedPath = path.join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
      await mkdir(path.dirname(selectedPath), { recursive: true });
      const { checkpoint, planScopeDigest } = recoveryPlanCheckpoint();
      const planStore = new OperationPlanStateStore(selectedPath);
      planStore.compareAndSet(null, checkpoint);
      planStore.close();
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };
      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        canonical_state_snapshot: { entries: Array<Record<string, unknown>> };
      };
      const entry = manifest.canonical_state_snapshot.entries.find((item) => item.store_key === "operation_plans")!;
      const archiveRelPath = String(entry.archive_rel_path);
      await rm(path.join(path.dirname(manifestPath), archiveRelPath), { force: true });
      Object.assign(entry, {
        status: "snapshot_failed",
        archive_rel_path: null,
        bytes: 0,
        sha256: null,
        integrity_check: "not_run",
      });
      const raw = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, raw, "utf8");
      await writeFile(`${manifestPath}.sha256`, `${createHash("sha256").update(raw).digest("hex")}  manifest.json\n`, "utf8");
      const packsBefore = await readdir(recoveryDir);

      await expect(restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        store_key: "operation_plans",
        scope_kind: "operation_plan",
        scope_digest: planScopeDigest,
        confirm: "RESTORE",
      })).rejects.toThrow("operation_plan_scope_unverified");

      const unchangedStore = new OperationPlanStateStore(selectedPath);
      try { expect(unchangedStore.load()).toEqual(checkpoint); } finally { unchangedStore.close(); }
      expect(await readdir(recoveryDir)).toEqual(packsBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects recovery pack integrity without changing the pack and reports tampering without details", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-inspection-"));
    try {
      const envFile = path.join(root, "product.env");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const env = { BLUE_TANUKI_ENV_FILE: envFile, BLUE_TANUKI_RECOVERY_DIR: recoveryDir, BLUE_TANUKI_STATE_ROOT: stateRoot };
      const missing = await inspectLatestRecoveryBackup(env);
      expect(missing).toMatchObject({
        status: "not_found",
        backup_id_digest: null,
        canonical_state_coverage: "not_included",
        canonical_state_stores: [],
        used_for_authority: false,
        may_execute: false,
      });

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifestBefore = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestBefore) as { items: Array<{ copied: boolean; archive_path: string | null; kind: string }> };
      const archive = manifest.items.find((item) => item.copied && item.kind === "file" && item.archive_path);
      expect(archive?.archive_path).toBeTruthy();
      const originalArchive = await readFile(archive!.archive_path!, "utf8");

      const verified = await inspectLatestRecoveryBackup(env);
      expect(verified.status).toBe("verified");
      expect(verified.canonical_state_coverage).toBe("none_present");
      expect(verified.canonical_state_stores.map(({ store_key, status }) => [store_key, status])).toEqual([
        ["j_control", "not_present"],
        ["m_state", "not_present"],
        ["broker", "not_present"],
        ["operation_plans", "not_present"],
        ["cron_events", "not_present"],
      ]);
      expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
      expect(await readFile(archive!.archive_path!, "utf8")).toBe(originalArchive);

      await writeFile(manifestPath, `${manifestBefore}\n`, "utf8");
      const invalidManifest = await inspectLatestRecoveryBackup(env);
      expect(invalidManifest.status).toBe("invalid");
      expect(JSON.stringify(invalidManifest)).not.toContain(manifestPath);
      await writeFile(manifestPath, manifestBefore, "utf8");

      await writeFile(archive!.archive_path!, `${originalArchive}tampered\n`, "utf8");
      const invalid = await inspectLatestRecoveryBackup(env);
      expect(invalid).toMatchObject({
        status: "invalid",
        coverage: "unknown",
        configured_required_item_count: null,
        copied_required_item_count: null,
        missing_required_item_count: null,
        canonical_state_coverage: "unknown",
        canonical_state_stores: [],
        used_for_authority: false,
        may_execute: false,
      });
      expect(JSON.stringify(invalid)).not.toContain("tampered");
      expect(JSON.stringify(invalid)).not.toContain(archive!.archive_path!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures and verifies per-store SQLite snapshots without mutating sources or applying them through generic restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-canonical-snapshot-"));
    try {
      const stateRoot = path.join(root, "state");
      const recoveryDir = path.join(root, "recovery");
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const sourcePaths = new Map<string, string>();
      for (const [key, relativePath] of CANONICAL_DATABASES) {
        sourcePaths.set(key, await createCanonicalDatabase(stateRoot, relativePath, `before-${key}`));
      }
      const sourceBytesBefore = new Map<string, Buffer>();
      for (const [key, filepath] of sourcePaths) sourceBytesBefore.set(key, await readFile(filepath));
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const packDir = path.dirname(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        canonical_state_snapshot: {
          store_consistency: string;
          cross_store_atomic: boolean;
          entries: Array<{ store_key: string; status: string; archive_rel_path: string | null }>;
        };
      };
      expect(manifest.canonical_state_snapshot).toMatchObject({
        store_consistency: "independent_sqlite_online_snapshots",
        cross_store_atomic: false,
      });
      expect(manifest.canonical_state_snapshot.entries).toHaveLength(5);
      expect(manifest.canonical_state_snapshot.entries.every((entry) => entry.status === "verified")).toBe(true);
      const snapshotPaths = manifest.canonical_state_snapshot.entries.map((entry) => path.join(packDir, entry.archive_rel_path!));
      const snapshotBytesBefore = await Promise.all(snapshotPaths.map((filepath) => readFile(filepath)));

      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({
        status: "verified",
        canonical_state_coverage: "complete",
        canonical_state_expected_store_count: 5,
        canonical_state_snapshot_count: 5,
        canonical_state_verified_store_count: 5,
        canonical_state_missing_store_count: 0,
        canonical_state_unverified_store_count: 0,
        canonical_state_store_consistency: "independent_sqlite_online_snapshots",
        canonical_state_cross_store_atomic: false,
      });
      expect(inspection.canonical_state_stores.map(({ store_key, status }) => [store_key, status])).toEqual([
        ["j_control", "verified"],
        ["m_state", "verified"],
        ["broker", "verified"],
        ["operation_plans", "verified"],
        ["cron_events", "verified"],
      ]);
      for (let index = 0; index < snapshotPaths.length; index += 1) {
        expect(await readFile(snapshotPaths[index]!)).toEqual(snapshotBytesBefore[index]);
      }
      for (const [key, filepath] of sourcePaths) {
        expect(await readFile(filepath)).toEqual(sourceBytesBefore.get(key));
        const entry = manifest.canonical_state_snapshot.entries.find((item) => item.store_key === key);
        expect(entry?.archive_rel_path).toBeTruthy();
        expect(readCanonicalDatabase(path.join(packDir, entry!.archive_rel_path!))).toEqual([`before-${key}`]);
      }

      const jPath = sourcePaths.get("j_control")!;
      const jDatabase: DatabaseSyncType = new DatabaseSync(jPath);
      jDatabase.prepare("INSERT INTO snapshot_fixture (value) VALUES (?)").run("after-backup");
      jDatabase.close();
      await restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" });
      expect(readCanonicalDatabase(jPath)).toEqual(["before-j_control", "after-backup"]);
      expect(JSON.stringify(inspection)).not.toContain(jPath);
      expect(JSON.stringify(inspection)).not.toContain("before-j_control");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("removes every captured archive when a canonical source commits during the multi-store capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-canonical-changing-source-"));
    try {
      const stateRoot = path.join(root, "state");
      const packDirectory = path.join(root, "pack");
      await mkdir(packDirectory);
      const sourcePaths = new Map<string, string>();
      for (const [key, relativePath] of CANONICAL_DATABASES) {
        sourcePaths.set(key, await createCanonicalDatabase(stateRoot, relativePath, `before-${key}`));
      }

      const capture = captureCanonicalStateSnapshots(stateRoot, packDirectory);
      const firstArchive = path.join(packDirectory, "canonical-state", "j_control.sqlite");
      let appeared = false;
      for (let attempt = 0; attempt < 5_000; attempt += 1) {
        if (await exists(firstArchive)) {
          appeared = true;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      }
      expect(appeared).toBe(true);

      const memoryPath = sourcePaths.get("m_state")!;
      const memoryDatabase: DatabaseSyncType = new DatabaseSync(memoryPath);
      memoryDatabase.prepare("INSERT INTO snapshot_fixture (value) VALUES (?)").run("changed-during-capture");
      memoryDatabase.close();

      const manifest = await capture;
      expect(manifest.cross_store_atomic).toBe(false);
      expect(manifest.entries).toHaveLength(5);
      expect(manifest.entries.every((entry) => entry.status === "snapshot_failed")).toBe(true);
      expect(await readdir(path.join(packDirectory, "canonical-state"))).toEqual([]);
      expect(readCanonicalDatabase(memoryPath)).toEqual(["before-m_state", "changed-during-capture"]);
      expect(readCanonicalDatabase(sourcePaths.get("j_control")!)).toEqual(["before-j_control"]);

      const inspection = await inspectCanonicalStateSnapshots(packDirectory, manifest);
      expect(inspection).toMatchObject({
        coverage: "partial",
        captured_store_count: 0,
        verified_store_count: 0,
        missing_store_count: 0,
        unverified_store_count: 5,
        store_consistency: "independent_sqlite_online_snapshots",
        cross_store_atomic: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects the combined snapshot when a previously absent canonical store appears during capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-canonical-new-store-during-capture-"));
    try {
      const stateRoot = path.join(root, "state");
      const packDirectory = path.join(root, "pack");
      await mkdir(packDirectory);
      for (const [key, relativePath] of CANONICAL_DATABASES) {
        if (key !== "m_state") await createCanonicalDatabase(stateRoot, relativePath, `initial-${key}`);
      }

      const capture = captureCanonicalStateSnapshots(stateRoot, packDirectory);
      const firstArchive = path.join(packDirectory, "canonical-state", "j_control.sqlite");
      let appeared = false;
      for (let attempt = 0; attempt < 5_000; attempt += 1) {
        if (await exists(firstArchive)) {
          appeared = true;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      }
      expect(appeared).toBe(true);

      const newlyCreatedStore = CANONICAL_DATABASES.find(([key]) => key === "m_state")!;
      const newStorePath = await createCanonicalDatabase(stateRoot, newlyCreatedStore[1], "created-during-capture");
      const manifest = await capture;

      expect(manifest.entries).toHaveLength(5);
      expect(manifest.entries.every((entry) => entry.status === "snapshot_failed")).toBe(true);
      expect(await readdir(path.join(packDirectory, "canonical-state"))).toEqual([]);
      expect(readCanonicalDatabase(newStorePath)).toEqual(["created-during-capture"]);

      const inspection = await inspectCanonicalStateSnapshots(packDirectory, manifest);
      expect(inspection).toMatchObject({
        coverage: "partial",
        captured_store_count: 0,
        verified_store_count: 0,
        missing_store_count: 0,
        unverified_store_count: 5,
        cross_store_atomic: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps missing and corrupt canonical stores isolated in partial snapshot coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-canonical-partial-"));
    try {
      const stateRoot = path.join(root, "state");
      const recoveryDir = path.join(root, "recovery");
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      await createCanonicalDatabase(stateRoot, CANONICAL_DATABASES[0][1], "j-state");
      const corruptPath = path.join(stateRoot, "private-state", CANONICAL_DATABASES[1][1]);
      await mkdir(path.dirname(corruptPath), { recursive: true });
      await writeFile(corruptPath, "not a SQLite database\n", "utf8");
      await createCanonicalDatabase(stateRoot, CANONICAL_DATABASES[2][1], "broker-state");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };

      await createRecoveryBackup(env);
      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({
        status: "verified",
        canonical_state_coverage: "partial",
        canonical_state_expected_store_count: 5,
        canonical_state_snapshot_count: 2,
        canonical_state_verified_store_count: 2,
        canonical_state_missing_store_count: 2,
        canonical_state_unverified_store_count: 1,
        canonical_state_cross_store_atomic: false,
      });
      expect(inspection.canonical_state_stores.map(({ store_key, status }) => [store_key, status])).toEqual([
        ["j_control", "verified"],
        ["m_state", "snapshot_failed"],
        ["broker", "verified"],
        ["operation_plans", "not_present"],
        ["cron_events", "not_present"],
      ]);
      expect(JSON.stringify(inspection)).not.toContain(corruptPath);
      expect(JSON.stringify(inspection)).not.toContain("not a SQLite database");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a modified canonical state snapshot archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-canonical-tamper-"));
    try {
      const stateRoot = path.join(root, "state");
      const recoveryDir = path.join(root, "recovery");
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      await createCanonicalDatabase(stateRoot, CANONICAL_DATABASES[0][1], "private-fixture-row");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };
      const backup = await createRecoveryBackup(env);
      const manifest = JSON.parse(await readFile(backup.backup_manifest_path!, "utf8")) as {
        canonical_state_snapshot: { entries: Array<{ archive_rel_path: string | null }> };
      };
      const archivePath = path.join(path.dirname(backup.backup_manifest_path!), manifest.canonical_state_snapshot.entries[0]!.archive_rel_path!);
      const unlistedArchive = path.join(path.dirname(archivePath), "unlisted.bin");
      await writeFile(unlistedArchive, "unlisted fixture file\n", "utf8");
      const unlistedInspection = await inspectLatestRecoveryBackup(env);
      expect(unlistedInspection).toMatchObject({ status: "invalid", canonical_state_coverage: "unknown" });
      await rm(unlistedArchive, { force: true });
      await writeFile(archivePath, "tampered snapshot\n", "utf8");

      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({ status: "invalid", canonical_state_coverage: "unknown" });
      expect(JSON.stringify(inspection)).not.toContain(archivePath);
      expect(JSON.stringify(inspection)).not.toContain("tampered snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects unsafe recovery env paths before destructive reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-unsafe-"));
    try {
      const envFile = path.join(root, "product.env");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");

      await expect(
        factoryResetRecovery({
          BLUE_TANUKI_ENV_FILE: envFile,
          BLUE_TANUKI_FILE_ROOT: fileRoot,
          BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
          BLUE_TANUKI_SESSION_DIR: os.homedir(),
          BLUE_TANUKI_MEMORY_DIR: path.join(os.homedir(), ".config"),
        }, { confirm: "FACTORY_RESET" }),
      ).rejects.toThrow(/unsafe_runtime_target/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore manifests that rewrite source_path outside configured runtime targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-manifest-"));
    try {
      const envFile = path.join(root, "product.env");
      const sessionDir = path.join(root, "sessions");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await mkdir(sessionDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      await writeFile(path.join(sessionDir, "session.jsonl"), "session\n", "utf8");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.items[0].source_path = os.homedir();
      const tampered = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, tampered, "utf8");
      const digest = createHash("sha256").update(tampered).digest("hex");
      await writeFile(`${manifestPath}.sha256`, `${digest}  manifest.json\n`, "utf8");

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow(/source_path_mismatch|unsafe_runtime_target/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects relative restore manifest paths and symlink runtime targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-symlink-"));
    try {
      const envFile = path.join(root, "product.env");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const outside = path.join(root, "outside");
      const link = path.join(root, "session-link");
      const stateRoot = path.join(root, "state");
      await mkdir(fileRoot);
      await mkdir(outside);
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      await symlink(outside, link, "dir");

      await expect(
        createRecoveryBackup({
          BLUE_TANUKI_ENV_FILE: envFile,
          BLUE_TANUKI_FILE_ROOT: fileRoot,
          BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
          BLUE_TANUKI_SESSION_DIR: link,
          BLUE_TANUKI_STATE_ROOT: stateRoot,
        }),
      ).rejects.toThrow(/symlink/);

      const sessionDir = path.join(root, "sessions");
      await mkdir(sessionDir);
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };
      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.items[0].source_path = "../escape";
      const tampered = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, tampered, "utf8");
      const digest = createHash("sha256").update(tampered).digest("hex");
      await writeFile(`${manifestPath}.sha256`, `${digest}  manifest.json\n`, "utf8");

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow(/source_path_mismatch|relative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights every archive before creating a pre-restore pack or changing targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-preflight-"));
    try {
      const envFile = path.join(root, "product.env");
      const sessionDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionDir, "session.jsonl");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const stateRoot = path.join(root, "state");
      await mkdir(sessionDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=before\n", "utf8");
      await writeFile(sessionFile, "session-before\n", "utf8");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const sessionItem = manifest.items.find((item: { key: string }) => item.key === "session_dir");
      const packDir = path.dirname(manifestPath);
      const sessionArchive = path.join(packDir, sessionItem.archive_rel_path, "session.jsonl");
      await writeFile(sessionArchive, "corrupted-archive\n", "utf8");

      await writeFile(envFile, "LLM_BACKEND=after\n", "utf8");
      await writeFile(sessionFile, "session-after\n", "utf8");
      const packsBeforeRestore = await readdir(recoveryDir);

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow(/invalid_backup_manifest_archive_digest:session_dir/);

      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=after\n");
      expect(await readFile(sessionFile, "utf8")).toBe("session-after\n");
      expect(await readdir(recoveryDir)).toEqual(packsBeforeRestore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks inside directory archives before restoring any target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-archive-link-"));
    try {
      const envFile = path.join(root, "product.env");
      const sessionDir = path.join(root, "sessions");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const outsideFile = path.join(root, "outside.json");
      const stateRoot = path.join(root, "state");
      await mkdir(sessionDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=before\n", "utf8");
      await writeFile(outsideFile, "outside\n", "utf8");
      await symlink(outsideFile, path.join(sessionDir, "linked.json"), "file");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_STATE_ROOT: stateRoot,
      };

      const backup = await createRecoveryBackup(env);
      await writeFile(envFile, "LLM_BACKEND=after\n", "utf8");
      const packsBeforeRestore = await readdir(recoveryDir);

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow("invalid_backup_manifest_archive_symlink");

      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=after\n");
      expect(await readdir(recoveryDir)).toEqual(packsBeforeRestore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
