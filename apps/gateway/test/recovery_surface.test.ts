import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { AuditLog, HDSUpperController, evaluateApproval, goalPurposeAdoptionReviewDigest, operationPlanDigest } from "@blue-tanuki/hds-brain";
import {
  canonicalExecutorCommandBytes,
  createGatewayInternalInboundRequest,
  OperationPlanCheckpointSchema,
  type ExecutionAdmission,
  type OperationPlan,
  type OperationPlanCheckpoint,
} from "@blue-tanuki/protocol";
import {
  captureCanonicalStateSnapshots,
  inspectCanonicalStateSnapshots,
  inspectCanonicalStateStoreTarget,
  restoreCanonicalStateSnapshotStore,
  type CanonicalStateSnapshotManifest,
} from "../src/canonical_state_backup.js";
import { goalPurposeMemoryStorage } from "../src/operation_result_memory_config.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { EmergencyStopStateStore } from "../src/emergency_stop_state_store.js";
import {
  GatewayRuntimeOwnerLease, inspectRuntimeRecoveryFence, type GoalPurposeRepairFenceEvidence, type RuntimeRecoveryFenceEvidence,
} from "../src/runtime_owner_lease.js";
import {
  applyOfflineGoalPurposeRepair,
  buildRecoverySnapshot,
  correlateTaskMemoryRestorePoints,
  createRecoveryBackup,
  factoryResetRecovery,
  inspectLatestRecoveryBackup,
  inspectRecoveryPlanRestoreScopeApplicability,
  inspectRecoveryTaskRestoreScopeApplicability,
  observeOfflineGoalPurposeRepair,
  planOfflineGoalPurposeRepair,
  planOfflineRecoveryRestore,
  resetRecoveryConnector,
  resetRecoveryProvider,
  restoreRecoveryBackup,
  rollbackInterruptedOfflineGoalPurposeRepair,
  type OfflineGoalPurposeRepairPlan,
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
  ["meaning_update_j_control", path.join("meaning-update-memory", "j-control.sqlite")],
  ["meaning_update_m_state", path.join("meaning-update-memory", "m-state.sqlite")],
  ["goal_purpose_j_control", path.join("goal-purpose-memory", "j-control.sqlite")],
  ["goal_purpose_m_state", path.join("goal-purpose-memory", "m-state.sqlite")],
] as const;

async function seedGoalPurposeRecoveryFixture(root: string) {
  const envFile = path.join(root, "product.env");
  const env = {
    BLUE_TANUKI_ENV_FILE: envFile,
    BLUE_TANUKI_AUDIT_DIR: path.join(root, "audit"),
    BLUE_TANUKI_RECOVERY_DIR: path.join(root, "recovery"),
    BLUE_TANUKI_STATE_ROOT: path.join(root, "state"),
  };
  await writeFile(envFile, Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value.replaceAll("\\", "/"))}`).join("\n") + "\n");
  await mkdir(env.BLUE_TANUKI_AUDIT_DIR);
  const auditPath = path.join(env.BLUE_TANUKI_AUDIT_DIR, "audit.jsonl");
  const sourceMemory = goalPurposeMemoryStorage(env);
  const controller = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }), goal_purpose_memory: sourceMemory });
  const purpose = "合成資料の出典を確認し、未確認事項を区別する。";
  const args = { goal_ref: `goal_${"a".repeat(32)}`, purpose_digest: createHash("sha256").update(purpose).digest("hex") };
  try {
    const requestId = randomUUID();
    const proposalActor = "webchat-owner-token-holder";
    const reviewerActor = "webchat-resume-token-holder";
    const { command } = controller.decide(createGatewayInternalInboundRequest({
      id: requestId, user: proposalActor, channel: "webchat", timestamp: Date.now(),
      content: "Owner submitted an initial delegated purpose for L3 review.",
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "approval",
        "blue_tanuki.goal_purpose_adoption.version": "v1",
        "blue_tanuki.tool_call": { tool_name: "goal.governance.adopt", arguments: args },
      },
    }));
    if (!command) throw new Error("HDS did not issue a purpose adoption command");
    expect(command).toMatchObject({ type: "tool_call", payload: { tool_name: "goal.governance.adopt", arguments: args } });
    const binding = {
      ...args, request_id: requestId, command_id: command.id, proposal_actor: proposalActor,
      command_digest: createHash("sha256").update(canonicalExecutorCommandBytes(command)).digest("hex"),
    };
    const reviewDigest = goalPurposeAdoptionReviewDigest(binding);
    const evaluation = evaluateApproval(command, [], { actor: proposalActor, default_mode: "full_access" });
    controller.onApprovalEvaluation(evaluation, { request_id: requestId });
    expect(controller.recordGoalPurposeAdoptionContentReview({ ...binding, review_digest: reviewDigest })).toBe(true);
    controller.onCommandLifecycle(command.id, "approval_approved", {
      actor: reviewerActor, request_id: requestId, reason: "human_approval:approve",
    });
    expect(controller.commitGoalPurposeAdoptionAfterL3({ ...binding, content_review_digest: reviewDigest,
      purpose_text: purpose, actor: reviewerActor, evaluation })).toMatchObject({ ok: true, ...args, version: 1 });
  } finally {
    controller.close();
  }
  return { env, envFile, auditPath, purpose, args, sourceMemory };
}

function setFixtureSqliteApplicationId(filepath: string, applicationId: number): void {
  const database = new DatabaseSync(filepath);
  try {
    database.exec(`PRAGMA application_id = ${applicationId}`);
  } finally {
    database.close();
  }
}

function goalPurposeRepairFence(plan: OfflineGoalPurposeRepairPlan): GoalPurposeRepairFenceEvidence {
  return {
    operation: "recovery.goal_purpose_repair", command_digest: createHash("sha256").update(randomUUID()).digest("hex"),
    backup_id: plan.backup_id, manifest_sha256: plan.manifest_sha256, repair_sha256: plan.repair_sha256,
    verification: { before_sha256: plan.before_sha256, after_sha256: plan.after_sha256 },
  };
}

function recordFixtureGoalPurposeRepairApproval(auditPath: string, fence: GoalPurposeRepairFenceEvidence): void {
  const audit = new AuditLog({ filepath: auditPath });
  const actor = "webchat-resume-token-holder";
  const requestId = randomUUID();
  const commandId = randomUUID();
  const timestamp = Date.now();
  const receipt = {
    kind: "authority_event" as const, request_id: requestId, command_id: commandId, actor,
    operation: "recovery.restore" as const, timestamp,
    offline_goal_purpose_repair_review: { command_digest: fence.command_digest,
      review_digest: "a".repeat(64), repair_sha256: fence.repair_sha256 },
  };
  audit.append({ ...receipt, event: "offline_goal_purpose_repair_content_reviewed", reason: "fixture_review" });
  audit.append({ kind: "command_lifecycle", phase: "approval_approved", request_id: requestId, command_id: commandId,
    upstream_commit_hash: "b".repeat(64), upstream_decision: "ASSERT", actor, reason: "human_approval:approve", timestamp });
  audit.append({ ...receipt, event: "offline_goal_purpose_repair_authorized", reason: "fixture_approved" });
}

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

describe("canonical state target inspection", () => {
  it.each(["wal", "hardlink"])("leaves a %s canonical store unverified and untouched", async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-protected-canonical-store-"));
    try {
      const [key, relativePath] = CANONICAL_DATABASES[0]!;
      const target = await createCanonicalDatabase(root, relativePath, "fixture");
      if (kind === "wal") {
        const database = new DatabaseSync(target);
        try { database.exec("PRAGMA journal_mode=WAL"); }
        finally { database.close(); }
      } else {
        await link(target, path.join(root, "alias.sqlite"));
      }
      const beforeNames = await readdir(path.dirname(target));
      const before = await readFile(target);
      expect(beforeNames).toEqual([path.basename(target)]);
      if (kind === "wal") expect(before.subarray(18, 20)).toEqual(Buffer.from([2, 2]));
      expect(await inspectCanonicalStateStoreTarget(root, key)).toEqual({ status: "unverified", bytes: null, sha256: null });
      expect(await readdir(path.dirname(target))).toEqual(beforeNames);
      expect(await readFile(target)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing nested store directory as absent without creating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-missing-canonical-store-"));
    try {
      await mkdir(path.join(root, "private-state"), { recursive: true });
      expect(await inspectCanonicalStateStoreTarget(root, "meaning_update_j_control")).toEqual({
        status: "not_present",
        bytes: null,
        sha256: null,
      });
      expect(await exists(path.join(root, "private-state", "meaning-update-memory"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat disappearance after canonical file identity capture as absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-changed-canonical-store-"));
    try {
      const [key, relativePath] = CANONICAL_DATABASES[0]!;
      const target = await realpath(await createCanonicalDatabase(root, relativePath, "fixture"));
      const open = vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("disappeared"), { code: "ENOENT" }));
      try {
        expect(await inspectCanonicalStateStoreTarget(root, key)).toEqual({ status: "unverified", bytes: null, sha256: null });
        expect(open).toHaveBeenCalledWith(target, "r");
      } finally { open.mockRestore(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a symlinked store directory unverified", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-symlinked-canonical-store-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-outside-canonical-store-"));
    try {
      await mkdir(path.join(root, "private-state"), { recursive: true });
      await symlink(outside, path.join(root, "private-state", "meaning-update-memory"), "dir");
      expect(await inspectCanonicalStateStoreTarget(root, "meaning_update_j_control")).toEqual({
        status: "unverified",
        bytes: null,
        sha256: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("legacy canonical snapshot inspection", () => {
  it("keeps five- and seven-store archives inspectable as partial with their prior selected-store eligibility", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-legacy-canonical-snapshot-"));
    const pack = path.join(root, "pack");
    const target = path.join(root, "target");
    try {
      await mkdir(pack);
      await mkdir(path.join(target, "private-state", "result-memory"), { recursive: true });
      await createCanonicalDatabase(root, CANONICAL_DATABASES[0]![1], "legacy-j-control");
      const captured = await captureCanonicalStateSnapshots(root, pack);
      const legacyFive = {
        ...captured,
        expected_store_count: 5 as const,
        entries: captured.entries.slice(0, 5),
      };
      const legacySeven = {
        ...captured,
        expected_store_count: 7 as const,
        entries: captured.entries.slice(0, 7),
      };

      await expect(inspectCanonicalStateSnapshots(pack, legacyFive)).resolves.toMatchObject({
        coverage: "partial",
        expected_store_count: 9,
        captured_store_count: 1,
        verified_store_count: 1,
        missing_store_count: 4,
        unverified_store_count: 4,
      });
      await expect(restoreCanonicalStateSnapshotStore(target, pack, legacyFive, "j_control"))
        .rejects.toThrow("canonical_state_restore_store_unverified");
      await expect(inspectCanonicalStateSnapshots(pack, legacySeven)).resolves.toMatchObject({
        coverage: "partial",
        expected_store_count: 9,
        captured_store_count: 1,
        verified_store_count: 1,
        missing_store_count: 6,
        unverified_store_count: 2,
      });
      await expect(inspectCanonicalStateSnapshots(pack, {
        ...legacySeven,
        entries: [...legacySeven.entries.slice(0, 6), captured.entries[7]!],
      })).rejects.toThrow("invalid_canonical_state_snapshot_manifest");
      await expect(restoreCanonicalStateSnapshotStore(target, pack, legacySeven, "j_control"))
        .resolves.toMatchObject({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(readCanonicalDatabase(path.join(target, "private-state", CANONICAL_DATABASES[0]![1])))
        .toEqual(["legacy-j-control"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildRecoverySnapshot", () => {
  it("resolves the default schedule recovery path beneath runtime state root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-schedules-"));
    try {
      const stateRoot = path.join(root, "runtime-state");
      const schedulesDir = path.join(stateRoot, "schedules");
      await mkdir(schedulesDir, { recursive: true });

      const snapshot = await buildRecoverySnapshot({ BLUE_TANUKI_STATE_ROOT: stateRoot });

      expect(snapshot.runtime_paths.schedules_dir).toMatchObject({
        configured: true,
        path: schedulesDir,
        exists: true,
        kind: "directory",
        backup_required: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(snapshot.runtime_paths.failure_memory_file).toMatchObject({
        configured: true,
        path: path.join(failureMemoryDir, "failure-memory.json"),
        exists: false,
        kind: "missing",
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

  it("reports the effective failure-memory path for legacy Setup environments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-legacy-memory-"));
    const sessionDir = path.join(root, "sessions");
    try {
      await mkdir(sessionDir);
      const snapshot = await buildRecoverySnapshot({ BLUE_TANUKI_SESSION_DIR: sessionDir });
      const failureMemoryDir = path.join(sessionDir, "failure-memory");
      expect(snapshot.runtime_paths.failure_memory_file).toMatchObject({
        configured: true,
        path: path.join(failureMemoryDir, "failure-memory.json"),
        exists: false,
        kind: "missing",
      });
      expect(snapshot.runtime_paths.failure_memory_dir).toMatchObject({
        configured: true,
        path: failureMemoryDir,
        exists: false,
        kind: "missing",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up, restores, resets providers/connectors, and preserves audit on factory reset", async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "blue-tanuki-recovery-actions-"));
    try {
      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const sessionDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionDir, "session.jsonl");
      const stateRoot = path.join(root, "state");
      const memoryDir = path.join(stateRoot, "private-state", "long-term-memory");
      const memoryFile = path.join(memoryDir, "memory.jsonl");
      const failureMemoryDir = path.join(root, "failure-memory");
      const schedulesDir = path.join(root, "schedules");
      const logsDir = path.join(root, "logs");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(auditDir);
      await mkdir(sessionDir);
      await mkdir(memoryDir, { recursive: true });
      await mkdir(failureMemoryDir);
      await mkdir(schedulesDir);
      await mkdir(logsDir);
      await mkdir(fileRoot);
      await writeFile(path.join(auditDir, "audit.jsonl"), "{}\n", "utf8");
      await writeFile(sessionFile, "session-before\n", "utf8");
      await writeFile(memoryFile, "memory-before\n", "utf8");
      await writeFile(path.join(failureMemoryDir, "failure-memory.json"), "{\"records\":[]}\n", "utf8");
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
        restore_review_request_available: false,
        full_restore_review_request_available: false,
        store_restore_review_request_available: true,
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
        canonical_state_expected_store_count: 9,
        canonical_state_snapshot_count: 0,
        canonical_state_verified_store_count: 0,
        canonical_state_missing_store_count: 9,
        canonical_state_unverified_store_count: 0,
        canonical_state_store_consistency: "independent_sqlite_online_snapshots",
        canonical_state_cross_store_atomic: false,
        canonical_state_stores: [
          { store_key: "j_control", status: "not_present" },
          { store_key: "m_state", status: "not_present" },
          { store_key: "broker", status: "not_present" },
          { store_key: "operation_plans", status: "not_present" },
          { store_key: "cron_events", status: "not_present" },
          { store_key: "meaning_update_j_control", status: "not_present" },
          { store_key: "meaning_update_m_state", status: "not_present" },
          { store_key: "goal_purpose_j_control", status: "not_present" },
          { store_key: "goal_purpose_m_state", status: "not_present" },
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
      expect(factory.removed_paths_count).toBe(5);
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
        ["meaning_update_j_control", "not_present"],
        ["meaning_update_m_state", "not_present"],
        ["goal_purpose_j_control", "not_present"],
        ["goal_purpose_m_state", "not_present"],
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

  it("uses the configured root to inspect the exact backup via the built CLI without writing or leaking configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-cli-"));
    try {
      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: path.join(root, "recovery"),
        BLUE_TANUKI_STATE_ROOT: path.join(root, "state"),
      };
      const configured = { ...env, BLUE_TANUKI_AUDIT_DIR: auditDir, LLM_API_KEY: "private-fixture-value" };
      const config = Object.entries(configured).map(([key, value]) => key + "=" + JSON.stringify(value)).join("\n") + "\n";
      await writeFile(envFile, config);
      const selected = await createRecoveryBackup(env);
      const baseline = await inspectLatestRecoveryBackup(env);
      expect(baseline.status).toBe("verified");
      await mkdir(auditDir);
      await writeFile(path.join(auditDir, "sample.json"), "{}");
      const latest = await createRecoveryBackup(configured);
      expect(selected.backup_id).not.toBe(latest.backup_id);

      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BLUE_TANUKI_")));
      const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const run = (...args: string[]) => spawnSync(process.execPath, ["--", main, "--recovery-inspect", "--json", ...args], {
        cwd: root, encoding: "utf8", env: inherited, timeout: 15_000, windowsHide: true,
      });
      const before = await readFile(selected.backup_manifest_path!);
      const result = run("--env-file", envFile, "--backup-id", selected.backup_id!);
      expect(result.status, result.stderr).toBe(2);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        status: "verified",
        manifest_sha256: createHash("sha256").update(before).digest("hex"),
        backup_id_digest: createHash("sha256").update(selected.backup_id!).digest("hex"),
        coverage: "partial",
        missing_required_item_count: baseline.missing_required_item_count! + 1,
        canonical_state_coverage: "none_present",
        used_for_authority: false,
        may_execute: false,
      });
      expect(result.stdout).not.toContain("private-fixture-value");
      expect(result.stdout).not.toContain(envFile);
      expect(JSON.parse(run("--env-file", envFile, "--backup-id", "absent-backup-id").stdout).status).toBe("not_found");
      expect(JSON.parse(run("--env-file", envFile, "--backup-id", "latest").stdout).status).toBe("invalid_backup_id");
      expect(JSON.parse(run("--env-file", path.join(root, "missing.env"), "--backup-id", selected.backup_id!).stdout))
        .toEqual({ status: "configuration_unavailable" });
      expect(await readFile(selected.backup_manifest_path!)).toEqual(before);
      expect(await readFile(envFile, "utf8")).toBe(config);
      await expect(stat(env.BLUE_TANUKI_STATE_ROOT)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("plans a pinned whole-pack restore through the built diagnostic without applying it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-offline-restore-plan-"));
    try {
      const envFile = path.join(root, "product.env");
      const failureDir = path.join(root, "failure");
      const sessionDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionDir, "current-session.jsonl");
      const memoryFile = path.join(root, "memory.json");
      const grants = path.join(root, "grants.json");
      const stateRoot = path.join(root, "state");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: path.join(root, "recovery"),
        BLUE_TANUKI_STATE_ROOT: stateRoot,
        BLUE_TANUKI_MEMORY_FILE: memoryFile,
        BLUE_TANUKI_FAILURE_MEMORY_FILE: path.join(failureDir, "records.jsonl"),
        BLUE_TANUKI_FAILURE_MEMORY_DIR: failureDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_SCHEDULES_DIR: path.join(root, "schedules-not-captured"),
        BLUE_TANUKI_APPROVALS_FILE: grants,
        OPENAI_API_KEY: "synthetic-private-plan-sentinel",
      };
      const config = (variables: typeof env) => Object.entries(variables)
        .map(([key, value]) => key + "=" + JSON.stringify(value)).join("\n") + "\n";
      await mkdir(failureDir);
      await mkdir(sessionDir);
      await writeFile(envFile, config(env));
      await writeFile(grants, "synthetic grant");
      await writeFile(memoryFile, "before-backup");
      await writeFile(env.BLUE_TANUKI_FAILURE_MEMORY_FILE, "synthetic failure");
      await writeFile(sessionFile, "synthetic session before backup");
      await createCanonicalDatabase(stateRoot, CANONICAL_DATABASES[0]![1], "synthetic canonical snapshot");
      const brokerStore = CANONICAL_DATABASES.find(([key]) => key === "broker")!;
      const brokerPath = await createCanonicalDatabase(stateRoot, brokerStore[1], "synthetic broker before backup");
      const backup = await createRecoveryBackup(env);
      const manifestFile = backup.backup_manifest_path!;
      const original = await readFile(manifestFile);
      const pin = createHash("sha256").update(original).digest("hex");
      const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(Path|SystemRoot|windir|SystemDrive|ComSpec|Temp|Tmp|Home|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
      const inspect = (backupId: string, configFile: string, expectedDigest: string, ...extra: string[]) => spawnSync(process.execPath, [
        "--", main, "--recovery-inspect", "--restore-plan", "--backup-id", backupId,
        "--manifest-sha256", expectedDigest, "--env-file", configFile, "--json", ...extra,
      ], { cwd: root, encoding: "utf8", env: inherited, timeout: 15_000, windowsHide: true });
      const run = (expectedDigest: string, ...extra: string[]) => inspect(backup.backup_id!, envFile, expectedDigest, ...extra);
      const snapshot = async () => {
        const inventory = await readdir(root, { recursive: true, withFileTypes: true });
        const files = await Promise.all(inventory.map(async entry => {
          const file = path.join(entry.parentPath, entry.name);
          const digest = entry.isFile() ? createHash("sha256").update(await readFile(file)).digest("hex") : "directory";
          return [path.relative(root, file), digest] as const;
        }));
        return files.sort(([left], [right]) => left.localeCompare(right));
      };
      const before = await snapshot();
      const result = run(pin);
      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan).toMatchObject({
        surface: "offline_recovery_restore_plan", status: "planned", manifest_sha256: pin,
        plan_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        offline_lease_verified: false, cross_store_atomic: false, used_for_authority: false, may_execute: false,
        items: expect.arrayContaining([
          { role: "env_file", disposition: "preserve_current" },
          { role: "approval_grants_file", disposition: "preserve_current" },
          { role: "schedules_dir", disposition: "not_captured" },
          { role: "failure_memory_file", disposition: "overlapping_targets" },
          { role: "failure_memory_dir", disposition: "overlapping_targets" },
          { role: "memory_file", disposition: "requires_domain_review" },
        ]),
        canonical_stores: expect.arrayContaining([
          { store_key: CANONICAL_DATABASES[0]![0], archive_status: "verified", disposition: "requires_store_reconciliation" },
          { store_key: "goal_purpose_j_control", archive_status: "not_present", disposition: "preserve_current" },
          { store_key: "goal_purpose_m_state", archive_status: "not_present", disposition: "preserve_current" },
        ]),
      });
      expect(plan.canonical_stores).toHaveLength(9);
      expect(result.stdout).not.toContain("synthetic-private-plan-sentinel");
      expect(result.stdout).not.toContain("before-backup");
      expect(result.stdout).not.toContain("product.env");
      expect(await snapshot()).toEqual(before);

      const unavailable = run(pin, "--verify-offline");
      expect(unavailable.status, unavailable.stderr).toBe(2);
      expect(JSON.parse(unavailable.stdout)).toMatchObject({
        status: "offline_lease_unverified", offline_lease_status: "owner_state_unavailable",
        offline_lease_verified: false, plan_sha256: null, may_execute: false, used_for_authority: false,
      });
      expect(await snapshot()).toEqual(before);
      const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
      try {
        const blocked = run(pin, "--verify-offline");
        expect(blocked.status, blocked.stderr).toBe(2);
        const blockedPlan = JSON.parse(blocked.stdout);
        expect(blockedPlan).toMatchObject({
          status: "offline_lease_unverified",
          offline_lease_verified: false, plan_sha256: null, may_execute: false, used_for_authority: false,
        });
        expect(["owner_lock_busy", "owner_lock_sidecars_present"]).toContain(blockedPlan.offline_lease_status);
      } finally {
        lease.close();
      }
      const stoppedOverlapping = await snapshot();
      const overlapping = run(pin, "--verify-offline");
      expect(overlapping.status, overlapping.stderr).toBe(0);
      const overlappingPlan = JSON.parse(overlapping.stdout);
      expect(overlappingPlan).toMatchObject({ status: "planned", offline_lease_verified: true,
        items: expect.arrayContaining([
          { role: "failure_memory_file", disposition: "overlapping_targets" },
          { role: "failure_memory_dir", disposition: "overlapping_targets" },
        ]),
      });
      expect(overlappingPlan).not.toHaveProperty("target_state_sha256");
      expect(await snapshot()).toEqual(stoppedOverlapping);

      const completeEnv = { ...env, BLUE_TANUKI_ENV_FILE: path.join(root, "verified-product.env"),
        BLUE_TANUKI_FAILURE_MEMORY_FILE: path.join(root, "standalone-failure.jsonl") };
      await writeFile(completeEnv.BLUE_TANUKI_ENV_FILE, config(completeEnv));
      await writeFile(completeEnv.BLUE_TANUKI_FAILURE_MEMORY_FILE, "synthetic standalone failure");
      const completeBackup = await createRecoveryBackup(completeEnv);
      const completePin = createHash("sha256").update(await readFile(completeBackup.backup_manifest_path!)).digest("hex");
      const advisory = inspect(completeBackup.backup_id!, completeEnv.BLUE_TANUKI_ENV_FILE, completePin);
      expect(advisory.status, advisory.stderr).toBe(0);
      const advisoryPlan = JSON.parse(advisory.stdout);
      const stopped = await snapshot();
      const inspectStopped = () => {
        const result = inspect(completeBackup.backup_id!, completeEnv.BLUE_TANUKI_ENV_FILE, completePin, "--verify-offline");
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("synthetic-private-plan-sentinel");
        expect(result.stdout).not.toContain("synthetic broker");
        expect(result.stdout).not.toContain("current-session.jsonl");
        return JSON.parse(result.stdout);
      };
      const verified = inspectStopped();
      expect(advisoryPlan).not.toHaveProperty("target_state_sha256");
      expect(verified).toMatchObject({ status: "planned", manifest_sha256: completePin,
        offline_lease_verified: true, offline_lease_status: "verified",
        target_state_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        plan_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        cross_store_atomic: false, used_for_authority: false, may_execute: false,
        items: expect.arrayContaining([
          { role: "env_file", disposition: "preserve_current" },
          { role: "session_dir", disposition: "requires_domain_review", target_status: "verified" },
          { role: "schedules_dir", disposition: "not_captured", target_status: "not_present" },
        ]),
        canonical_stores: expect.arrayContaining([
          { store_key: brokerStore[0], archive_status: "verified", target_status: "verified",
            disposition: "requires_store_reconciliation" },
          { store_key: "goal_purpose_j_control", archive_status: "not_present", target_status: "not_present",
            disposition: "preserve_current" },
        ]),
      });
      expect(verified.plan_sha256).not.toBe(advisoryPlan.plan_sha256);
      expect(inspectStopped()).toEqual(verified);
      expect(await snapshot()).toEqual(stopped);
      expect(JSON.parse(run(pin, "--verify-offline", "--verify-offline").stdout)).toEqual({ status: "invalid_arguments" });

      GatewayRuntimeOwnerLease.fromEnvironment(completeEnv).close();
      const nextOwner = inspectStopped();
      expect(nextOwner.target_state_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(nextOwner.target_state_sha256).not.toBe(verified.target_state_sha256);

      const broker = new DatabaseSync(brokerPath);
      try {
        broker.prepare("INSERT INTO snapshot_fixture (value) VALUES (?)").run("synthetic broker drift");
      } finally {
        broker.close();
      }
      const changedBroker = inspectStopped();
      expect(changedBroker.manifest_sha256).toBe(completePin);
      expect(changedBroker.target_state_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(changedBroker.target_state_sha256).not.toBe(nextOwner.target_state_sha256);
      expect(changedBroker.plan_sha256).not.toBe(nextOwner.plan_sha256);
      expect(JSON.parse(run(pin).stdout)).toEqual(plan);

      await writeFile(sessionFile, "synthetic current session drift");
      const changedSession = inspectStopped();
      expect(changedSession.target_state_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(changedSession.target_state_sha256).not.toBe(changedBroker.target_state_sha256);

      await mkdir(env.BLUE_TANUKI_SCHEDULES_DIR);
      await writeFile(path.join(env.BLUE_TANUKI_SCHEDULES_DIR, "current-schedules.json"), "[]\n");
      const changedSchedule = inspectStopped();
      expect(changedSchedule.items).toContainEqual({ role: "schedules_dir", disposition: "not_captured", target_status: "verified" });
      expect(changedSchedule.target_state_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(changedSchedule.target_state_sha256).not.toBe(changedSession.target_state_sha256);

      const brokerSidecar = `${brokerPath}-wal`;
      await writeFile(brokerSidecar, "isolated unverified sidecar");
      const beforeSidecarInspection = await snapshot();
      const unverified = inspectStopped();
      expect(unverified).toMatchObject({ status: "planned", manifest_sha256: completePin,
        offline_lease_verified: true, may_execute: false, used_for_authority: false,
        canonical_stores: expect.arrayContaining([
          { store_key: brokerStore[0], archive_status: "verified", target_status: "unverified",
            disposition: "requires_store_reconciliation" },
        ]),
      });
      expect(unverified).not.toHaveProperty("target_state_sha256");
      expect(await snapshot()).toEqual(beforeSidecarInspection);
      await unlink(brokerSidecar);
      expect(inspectStopped()).toEqual(changedSchedule);

      const protectedAlias = path.join(sessionDir, "protected-alias");
      await fs.link(completeEnv.BLUE_TANUKI_ENV_FILE, protectedAlias);
      const aliased = inspectStopped();
      expect(aliased.items).toContainEqual({ role: "session_dir", disposition: "unverified_target", target_status: "unverified" });
      expect(aliased).not.toHaveProperty("target_state_sha256");
      await unlink(protectedAlias);

      let sessionSamples = 0;
      const originalRead = fs.readFile.bind(fs);
      const driftAfterSample = vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const data = await originalRead(...args);
        if (args[0] === sessionFile && ++sessionSamples === 1) {
          await writeFile(sessionFile, "synthetic drift during verification");
        }
        return data;
      });
      try {
        const duringRead = await planOfflineRecoveryRestore(completeEnv, completeBackup.backup_id!, completePin,
          { offline_owner_scope_sha256: "a".repeat(64) });
        expect(sessionSamples).toBe(2);
        expect(duringRead).toMatchObject({ status: "target_changed", plan_sha256: null,
          may_execute: false, used_for_authority: false });
        expect(duringRead).not.toHaveProperty("target_state_sha256");
      } finally {
        driftAfterSample.mockRestore();
      }

      await writeFile(memoryFile, "new-current-value");
      const changed = JSON.parse(run(pin).stdout);
      expect(changed.status).toBe("planned");
      expect(changed.plan_sha256).not.toBe(plan.plan_sha256);
      expect(await readFile(memoryFile, "utf8")).toBe("new-current-value");

      const archivedFailure = path.join(path.dirname(manifestFile), "items", "failure_memory_dir.dir", "records.jsonl");
      const archivedBytes = await readFile(archivedFailure);
      const modifiedBytes = Buffer.from(archivedBytes);
      modifiedBytes[0] = modifiedBytes[0]! ^ 1;
      await writeFile(archivedFailure, modifiedBytes);
      expect(JSON.parse(run(pin).stdout)).toMatchObject({ status: "invalid", plan_sha256: null });
      await writeFile(archivedFailure, archivedBytes);

      const replacement = Buffer.concat([original, Buffer.from("\n")]);
      await writeFile(manifestFile, replacement);
      await writeFile(`${manifestFile}.sha256`, createHash("sha256").update(replacement).digest("hex") + "  manifest.json\n");
      const mismatch = run(pin);
      expect(mismatch.status, mismatch.stderr).toBe(2);
      expect(JSON.parse(mismatch.stdout)).toMatchObject({ status: "manifest_changed", plan_sha256: null, items: [] });
      const verifiedMismatch = run(pin, "--verify-offline");
      expect(verifiedMismatch.status, verifiedMismatch.stderr).toBe(2);
      expect(JSON.parse(verifiedMismatch.stdout)).toEqual(JSON.parse(mismatch.stdout));
      expect(await readFile(manifestFile)).toEqual(replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("captures HDS-authored purpose records and reserves the archived J/M pair for offline reconciliation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-goal-purpose-snapshot-"));
    let archiveReader: HDSUpperController | undefined;
    try {
      const { env, envFile, auditPath, purpose, args } = await seedGoalPurposeRecoveryFixture(root);

      const backup = await createRecoveryBackup(env);
      const pack = path.dirname(backup.backup_manifest_path!);
      const manifestBytes = await readFile(backup.backup_manifest_path!);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
        canonical_state_snapshot: CanonicalStateSnapshotManifest;
        items: { key: string; archive_rel_path: string | null }[];
      };
      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({ status: "verified", canonical_state_expected_store_count: 9,
        canonical_state_verified_store_count: 2, canonical_state_cross_store_atomic: false, may_execute: false });
      expect(JSON.stringify(inspection)).not.toContain(purpose);
      const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
      const inspectPlan = () => planOfflineRecoveryRestore(env, backup.backup_id!, manifestSha);
      const plan = await inspectPlan();
      expect(plan).toMatchObject({ status: "planned", may_execute: false, used_for_authority: false, cross_store_atomic: false,
        goal_purpose_replay: { status: "matched", verified_purpose_count: 1 } });
      expect(JSON.stringify(plan)).not.toContain(purpose);

      const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
      lease.close();
      const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const cli = spawnSync(process.execPath, ["--", main, "--recovery-inspect", "--restore-plan", "--verify-offline",
        "--backup-id", backup.backup_id!, "--manifest-sha256", manifestSha, "--env-file", envFile, "--json"], {
        cwd: root, encoding: "utf8", env: { SystemRoot: process.env.SystemRoot }, timeout: 15_000, windowsHide: true,
      });
      expect(cli.status, cli.stderr).toBe(0);
      const stoppedPlan = JSON.parse(cli.stdout);
      expect(stoppedPlan).toMatchObject({ offline_lease_verified: true, plan_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        goal_purpose_replay: { status: "matched", verified_purpose_count: 1 }, may_execute: false });
      expect(stoppedPlan.plan_sha256).not.toBe(plan.plan_sha256);
      expect(cli.stdout).not.toContain(purpose);

      const configPath = path.join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "goal-governance.json");
      await writeFile(configPath, "{");
      expect((await inspectPlan()).goal_purpose_replay).toEqual({ status: "unverified", verified_purpose_count: 0 });
      expect(await readFile(configPath, "utf8")).toBe("{");
      await unlink(configPath);

      const currentAuditBytes = await readFile(auditPath);
      const observedAudit = new AuditLog({ filepath: auditPath, read_only: true });
      expect(() => observedAudit.append(observedAudit.list()[0]!.log)).toThrow("read-only inspection cannot append");
      expect(await readFile(auditPath)).toEqual(currentAuditBytes);
      const currentAudit = new AuditLog({ filepath: auditPath });
      currentAudit.append(currentAudit.list()[0]!.log);
      const laterPlan = await inspectPlan();
      expect(laterPlan.goal_purpose_replay).toEqual(plan.goal_purpose_replay);
      expect(laterPlan.plan_sha256).not.toBe(plan.plan_sha256);
      await writeFile(auditPath, "");
      expect((await inspectPlan()).goal_purpose_replay).toEqual({ status: "unverified", verified_purpose_count: 0 });
      await unlink(auditPath);
      expect((await inspectPlan()).goal_purpose_replay).toEqual({ status: "unverified", verified_purpose_count: 0 });
      await expect(stat(auditPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(auditPath, currentAuditBytes);

      const stagedMemory = goalPurposeMemoryStorage({ BLUE_TANUKI_STATE_ROOT: path.join(root, "archive-reader") });
      for (const [key, stagedPath] of [
        ["goal_purpose_j_control", stagedMemory.database_path], ["goal_purpose_m_state", stagedMemory.memory_database_path],
      ] as const) {
        expect(plan.canonical_stores).toContainEqual({ store_key: key, archive_status: "verified", disposition: "requires_store_reconciliation" });
        const entry = manifest.canonical_state_snapshot.entries.find(({ store_key }) => store_key === key);
        expect(entry).toMatchObject({ status: "verified", archive_rel_path: expect.any(String) });
        await expect(restoreCanonicalStateSnapshotStore(env.BLUE_TANUKI_STATE_ROOT, pack, manifest.canonical_state_snapshot, key))
          .rejects.toThrow("goal_purpose_restore_requires_offline_reconciliation");
        await expect(restoreRecoveryBackup(env, { backup_id: backup.backup_id, store_key: key, confirm: "RESTORE" }))
          .rejects.toThrow("goal_purpose_restore_requires_offline_reconciliation");
        await copyFile(path.join(pack, entry!.archive_rel_path!), stagedPath);
      }
      expect(await readdir(env.BLUE_TANUKI_RECOVERY_DIR)).toEqual([backup.backup_id]);
      const archivedAudit = manifest.items.find(({ key }) => key === "audit_dir")!.archive_rel_path!;
      const stagedAudit = path.join(root, "archive-reader", "audit.jsonl");
      await copyFile(path.join(pack, archivedAudit, "audit.jsonl"), stagedAudit);
      // The archive is only replayed in a separate test state with the matching audit.
      archiveReader = new HDSUpperController({ audit: new AuditLog({ filepath: stagedAudit }), goal_purpose_memory: stagedMemory });
      expect(archiveReader.getAudit().verify()).toBe(true);
      expect(archiveReader.readGoalPurposeContent(args.goal_ref, 1)).toMatchObject({ ...args, version: 1,
        purpose_text: purpose, used_for_authority: false });
    } finally {
      archiveReader?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it.each(["write failure", "target drift", "lost fence", "emergency stop", "lost rename response", "initially missing J"] as const)(
    "preserves the reviewed offline goal-purpose pair after %s", async (interruption) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-goal-purpose-rollback-"));
      try {
        const { env, auditPath, sourceMemory } = await seedGoalPurposeRecoveryFixture(root);
        const targets = [sourceMemory.database_path, sourceMemory.memory_database_path] as const;
        const backup = await createRecoveryBackup(env);
        const manifest = await readFile(backup.backup_manifest_path!);
        const pack = path.dirname(backup.backup_manifest_path!);
        const archivedJ = await readFile(path.join(pack, "canonical-state", "goal_purpose_j_control.sqlite"));
        const archivedM = await readFile(path.join(pack, "canonical-state", "goal_purpose_m_state.sqlite"));
        const auditBefore = await readFile(auditPath);
        // Change physical bytes without introducing a distinct logical purpose or corrupting SQLite.
        for (const [index, target] of targets.entries()) setFixtureSqliteApplicationId(target, 123456789 + index);
        const missingJ = interruption === "initially missing J";
        if (missingJ) await unlink(targets[0]);
        const initialJ = missingJ ? null : await readFile(targets[0]);
        const initialM = await readFile(targets[1]);
        const selector = { backup_id: backup.backup_id!, manifest_sha256: createHash("sha256").update(manifest).digest("hex") };
        const plan = await planOfflineGoalPurposeRepair(env, selector);
        if (!plan) throw new Error("Expected a verified goal-purpose repair candidate");
        expect(plan.stores.map(({ target_state }) => target_state)).toEqual([missingJ ? "missing" : "different", "different"]);
        expect(initialJ).not.toEqual(archivedJ);

        let firstMemberReplaced = false;
        let secondMemberAttempted = false;
        let secondMemberReplaced = false;
        let fenceLost = false;
        let driftedJ: Buffer | undefined;
        const rename = fs.rename.bind(fs);
        const replacement = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
          if (path.basename(String(source)) === "new-m-state.sqlite" && target === targets[1]) {
            secondMemberAttempted = true;
            expect(await readFile(targets[0])).toEqual(archivedJ);
            if (interruption === "target drift") {
              setFixtureSqliteApplicationId(targets[0], 9356832);
              driftedJ = await readFile(targets[0]);
            }
            if (interruption === "lost fence") fenceLost = true;
            if (interruption === "lost rename response") {
              await rename(source, target);
              expect(await readFile(targets[1])).toEqual(archivedM);
              secondMemberReplaced = true;
            }
            throw Object.assign(new Error("synthetic rename failure"), { code: "EACCES" });
          }
          await rename(source, target);
          if (path.basename(String(source)) === "new-j-control.sqlite" && target === targets[0]) firstMemberReplaced = true;
        });

        const assertFence = () => {
          if (fenceLost) throw new Error("synthetic owner fence loss");
        };
        const permitsContinuation = () => {
          if (interruption === "emergency stop" && firstMemberReplaced) throw new Error("synthetic emergency stop");
        };
        try {
          const operation = applyOfflineGoalPurposeRepair(env, plan, assertFence, permitsContinuation, goalPurposeRepairFence(plan));
          if (interruption === "target drift" || interruption === "lost fence") {
            await expect(operation).rejects.toThrow();
          } else {
            await expect(operation).resolves.toBe("rolled_back");
          }
        } finally {
          replacement.mockRestore();
        }

        expect(firstMemberReplaced).toBe(true);
        expect(secondMemberAttempted).toBe(interruption !== "emergency stop");
        expect(secondMemberReplaced).toBe(interruption === "lost rename response");
        if (interruption === "target drift") {
          expect(driftedJ).toBeDefined();
          expect(driftedJ).not.toEqual(initialJ);
          expect(driftedJ).not.toEqual(archivedJ);
        }
        const expectedJ = interruption === "target drift" ? driftedJ : interruption === "lost fence" ? archivedJ : initialJ;
        if (missingJ) {
          await expect(stat(targets[0])).rejects.toMatchObject({ code: "ENOENT" });
          const savedDirectories = (await readdir(path.dirname(targets[0]))).filter((name) => name.startsWith(".offline-goal-repair-"));
          expect(savedDirectories).toHaveLength(1);
          expect(await readFile(path.join(path.dirname(targets[0]), savedDirectories[0]!, "interrupted-j-control.sqlite"))).toEqual(archivedJ);
        } else {
          expect(await readFile(targets[0])).toEqual(expectedJ);
        }
        expect(await readFile(targets[1])).toEqual(initialM);
        expect(await readFile(auditPath)).toEqual(auditBefore);
        expect(await readFile(backup.backup_manifest_path!)).toEqual(manifest);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 25_000,
  );

  it.each(["original J", "missing J", "durable stop"] as const)(
    "rechecks the interrupted staged pair with %s", async (scenario) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-goal-purpose-interrupted-"));
      try {
        const { env, auditPath, sourceMemory } = await seedGoalPurposeRecoveryFixture(root);
        const jPath = sourceMemory.database_path;
        const mPath = sourceMemory.memory_database_path;
        const safety = EmergencyStopStateStore.fromEnvironment(env);
        safety.close();
        const backup = await createRecoveryBackup(env);
        const manifest = await readFile(backup.backup_manifest_path!);
        const pack = path.dirname(backup.backup_manifest_path!);
        const archivedJ = await readFile(path.join(pack, "canonical-state", "goal_purpose_j_control.sqlite"));
        if (scenario === "missing J") await unlink(jPath);
        else setFixtureSqliteApplicationId(jPath, 101);
        setFixtureSqliteApplicationId(mPath, 102);
        const beforeJ = scenario === "missing J" ? null : await readFile(jPath);
        const beforeM = await readFile(mPath);
        const plan = await planOfflineGoalPurposeRepair(env, { backup_id: backup.backup_id!,
          manifest_sha256: createHash("sha256").update(manifest).digest("hex") });
        if (!plan) throw new Error("fixture repair plan unavailable");
        const fence = goalPurposeRepairFence(plan);
        recordFixtureGoalPurposeRepairApproval(auditPath, fence);
        const auditBeforeRollback = await readFile(auditPath);

        let firstProcessCanContinue = true;
        const rename = fs.rename.bind(fs);
        const interrupt = vi.spyOn(fs, "rename").mockImplementationOnce(async (source, target) => {
          expect(target).toBe(jPath);
          await rename(source, target);
          firstProcessCanContinue = false;
        });
        try {
          await expect(applyOfflineGoalPurposeRepair(env, plan, () => {
            if (!firstProcessCanContinue) throw new Error("fixture process was stopped");
          }, () => {}, fence)).rejects.toThrow("fixture process was stopped");
        } finally {
          interrupt.mockRestore();
        }
        expect(await readFile(jPath)).toEqual(archivedJ);
        expect(await readFile(mPath)).toEqual(beforeM);
        const mixed = await observeOfflineGoalPurposeRepair(env, fence);
        expect(mixed).toMatch(/^[a-f0-9]{64}$/u);
        expect(mixed).not.toBe(plan.before_sha256);
        expect(mixed).not.toBe(plan.after_sha256);

        const stage = path.join(path.dirname(jPath), `.offline-goal-repair-${fence.command_digest}`);
        const journalPath = path.join(stage, "before-state.json");
        const journal = await readFile(journalPath, "utf8");
        expect(JSON.parse(journal)).toMatchObject({ schema_version: 2, command_digest: fence.command_digest,
          repair_sha256: fence.repair_sha256, before_sha256: plan.before_sha256, after_sha256: plan.after_sha256 });
        const rollback = (digest: string) => rollbackInterruptedOfflineGoalPurposeRepair(env, fence, digest, () => {});
        await expect(rollback(plan.before_sha256)).resolves.toBe(false);
        await writeFile(journalPath, journal.replace('"schema_version":2', '"schema_version":1'));
        await expect(rollback(mixed!)).rejects.toThrow("offline_goal_purpose_file_changed");
        expect(await readFile(jPath)).toEqual(archivedJ);
        expect(await readFile(mPath)).toEqual(beforeM);
        await writeFile(journalPath, journal);

        if (scenario === "durable stop") {
          const stop = EmergencyStopStateStore.fromEnvironment(env);
          try {
            stop.activate({ control_event_id: randomUUID(), actor: "fixture-stop-owner", occurred_at_ms: Date.now() });
          } finally { stop.close(); }
          await expect(rollback(mixed!)).rejects.toThrow("offline_goal_purpose_rollback_authority_unverified");
          expect(await readFile(jPath)).toEqual(archivedJ);
          expect(await observeOfflineGoalPurposeRepair(env, fence)).toBe(mixed);
        } else {
          await expect(rollback(mixed!)).resolves.toBe(true);
          expect(await observeOfflineGoalPurposeRepair(env, fence)).toBe(plan.before_sha256);
          if (beforeJ) expect(await readFile(jPath)).toEqual(beforeJ);
          else {
            await expect(stat(jPath)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await readFile(path.join(stage, "interrupted-j-control.sqlite"))).toEqual(archivedJ);
          }
          await expect(rollback(mixed!)).resolves.toBe(false);
        }
        expect(await readFile(mPath)).toEqual(beforeM);
        expect(await readFile(journalPath, "utf8")).toBe(journal);
        expect(await readFile(auditPath)).toEqual(auditBeforeRollback);
        expect(await readFile(backup.backup_manifest_path!)).toEqual(manifest);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 25_000,
  );

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
      expect(manifest.canonical_state_snapshot.entries).toHaveLength(9);
      expect(manifest.canonical_state_snapshot.entries.every((entry) => entry.status === "verified")).toBe(true);
      const snapshotPaths = manifest.canonical_state_snapshot.entries.map((entry) => path.join(packDir, entry.archive_rel_path!));
      const snapshotBytesBefore = await Promise.all(snapshotPaths.map((filepath) => readFile(filepath)));

      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({
        status: "verified",
        canonical_state_coverage: "complete",
        canonical_state_expected_store_count: 9,
        canonical_state_snapshot_count: 9,
        canonical_state_verified_store_count: 9,
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
        ["meaning_update_j_control", "verified"],
        ["meaning_update_m_state", "verified"],
        ["goal_purpose_j_control", "verified"],
        ["goal_purpose_m_state", "verified"],
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
      expect(manifest.entries).toHaveLength(9);
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
        unverified_store_count: 9,
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

      expect(manifest.entries).toHaveLength(9);
      expect(manifest.entries.every((entry) => entry.status === "snapshot_failed")).toBe(true);
      expect(await readdir(path.join(packDirectory, "canonical-state"))).toEqual([]);
      expect(readCanonicalDatabase(newStorePath)).toEqual(["created-during-capture"]);

      const inspection = await inspectCanonicalStateSnapshots(packDirectory, manifest);
      expect(inspection).toMatchObject({
        coverage: "partial",
        captured_store_count: 0,
        verified_store_count: 0,
        missing_store_count: 0,
        unverified_store_count: 9,
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
        canonical_state_expected_store_count: 9,
        canonical_state_snapshot_count: 2,
        canonical_state_verified_store_count: 2,
        canonical_state_missing_store_count: 6,
        canonical_state_unverified_store_count: 1,
        canonical_state_cross_store_atomic: false,
      });
      expect(inspection.canonical_state_stores.map(({ store_key, status }) => [store_key, status])).toEqual([
        ["j_control", "verified"],
        ["m_state", "snapshot_failed"],
        ["broker", "verified"],
        ["operation_plans", "not_present"],
        ["cron_events", "not_present"],
        ["meaning_update_j_control", "not_present"],
        ["meaning_update_m_state", "not_present"],
        ["goal_purpose_j_control", "not_present"],
        ["goal_purpose_m_state", "not_present"],
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
      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=stub\n");
      expect(await exists(recoveryDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects factory-reset overlaps with protected data before backup and writes", async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "blue-tanuki-factory-reset-protected-"));
    try {
      const stateRoot = path.join(root, "state");
      const ownerDir = path.join(stateRoot, "private-state", "gateway-runtime");
      const sessions = path.join(root, "sessions");
      const auditDir = path.join(sessions, "..audit");
      const historyDir = path.join(root, "history");
      const historyFile = path.join(historyDir, "complete-history.jsonl");
      const installDataRoot = path.join(root, "install-data");
      const installMarker = path.join(installDataRoot, "blue-tanuki-product-data.json");
      const recoveryDir = path.join(root, "recovery");
      const envFile = path.join(root, "product.env");
      const configuredEnv = "LLM_BACKEND=stub\nCOMPOSIO_DRY_RUN=false\n";
      const protectedFile = path.join(ownerDir, "owner-state.sqlite");
      await mkdir(auditDir, { recursive: true });
      await mkdir(ownerDir, { recursive: true });
      await mkdir(historyDir);
      await mkdir(installDataRoot);
      await writeFile(envFile, configuredEnv);
      await writeFile(protectedFile, "owner state fixture\n");
      await writeFile(path.join(auditDir, "audit.jsonl"), "audit fixture\n");
      await writeFile(historyFile, "history fixture\n");
      await writeFile(installMarker, "install data fixture\n");
      const env = {
        BLUE_TANUKI_STATE_ROOT: stateRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_AUDIT_DIR: auditDir,
        BLUE_TANUKI_COMPLETE_HISTORY_FILE: ` ${historyFile} `,
        BLUE_TANUKI_DATA_ROOT: installDataRoot,
      };
      for (const resetPath of [sessions, auditDir, historyDir, installDataRoot, recoveryDir, stateRoot, ownerDir]) {
        await expect(factoryResetRecovery({ ...env, BLUE_TANUKI_LOG_DIR: resetPath }, {
          confirm: "FACTORY_RESET",
        })).rejects.toThrow("factory_reset_target_protected");
      }
      await expect(factoryResetRecovery({ ...env, BLUE_TANUKI_MEMORY_FILE: installMarker }, {
        confirm: "FACTORY_RESET",
      })).rejects.toThrow("factory_reset_target_protected");
      expect(await readFile(envFile, "utf8")).toBe(configuredEnv);
      expect(await readFile(path.join(auditDir, "audit.jsonl"), "utf8")).toBe("audit fixture\n");
      expect(await readFile(historyFile, "utf8")).toBe("history fixture\n");
      expect(await readFile(installMarker, "utf8")).toBe("install data fixture\n");
      expect(await readFile(protectedFile, "utf8")).toBe("owner state fixture\n");
      expect(await exists(recoveryDir)).toBe(false);
      expect((await readdir(root)).sort()).toEqual(["history", "install-data", "product.env", "sessions", "state"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a factory-reset target reached through a deeper directory link", async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "blue-tanuki-factory-reset-link-"));
    try {
      const actual = path.join(root, "actual");
      const alias = path.join(root, "alias");
      const sessionFile = path.join(actual, "nested", "sessions", "session.jsonl");
      const envFile = path.join(root, "product.env");
      const backup = path.join(root, "recovery");
      await mkdir(path.dirname(sessionFile), { recursive: true });
      await writeFile(sessionFile, "session fixture\n");
      await writeFile(envFile, "LLM_BACKEND=stub\n");
      await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(factoryResetRecovery({
        BLUE_TANUKI_STATE_ROOT: path.join(root, "state"),
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: backup,
        BLUE_TANUKI_SESSION_DIR: path.join(alias, "nested", "sessions"),
      }, { confirm: "FACTORY_RESET" })).rejects.toThrow("factory_reset_target_unverified");
      expect(await readFile(sessionFile, "utf8")).toBe("session fixture\n");
      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=stub\n");
      expect(await exists(backup)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { interruption: "deletion failure", partial: true, matches: "pre_action_state_matched" },
    { interruption: "failed settlement", partial: false, matches: "postconditions_matched" },
  ])("reconciles factory-reset effects after $interruption without replay", async (fixture) => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "blue-tanuki-factory-reset-partial-"));
    const sessionDir = path.join(root, "sessions");
    const sessionFile = path.join(sessionDir, "session.jsonl");
    const envFile = path.join(root, "product.env");
    const fsRm = fs.rm;
    const denyRemoval = vi.spyOn(fs, "rm").mockImplementation(async (filepath, options) => {
      if (fixture.partial && filepath === sessionDir) {
        throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
      }
      return fsRm(filepath, options);
    });
    try {
      await mkdir(sessionDir);
      await writeFile(sessionFile, "session fixture\n");
      const originalEnv = "LLM_BACKEND=stub\nCOMPOSIO_DRY_RUN=false\n";
      await writeFile(envFile, originalEnv);
      const env = {
        BLUE_TANUKI_STATE_ROOT: path.join(root, "state"),
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_RECOVERY_DIR: path.join(root, "recovery"),
        BLUE_TANUKI_SESSION_DIR: sessionDir,
      };
      const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
      const evidence = (backupId: string, manifestSha256: string, verification: RuntimeRecoveryFenceEvidence["verification"]) => ({
        operation: "recovery.factory_reset" as const,
        command_digest: "a".repeat(64), backup_id: backupId, manifest_sha256: manifestSha256, verification,
      });
      try {
        await expect(factoryResetRecovery(env, {
          confirm: "FACTORY_RESET",
          fence: {
            begin: (id, digest, verification) => lease.beginRecoveryMutation(evidence(id, digest, verification)),
            finish: () => { throw new Error("fixture interrupted before settlement"); },
          },
        })).rejects.toThrow("factory_reset_outcome_unknown");
      } finally {
        lease.close();
      }
      expect(await readFile(envFile, "utf8")).toContain("COMPOSIO_DRY_RUN=true");
      if (fixture.partial) expect(await readFile(sessionFile, "utf8")).toBe("session fixture\n");
      else await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      const backup = await inspectLatestRecoveryBackup(env);
      expect(backup).toMatchObject({
        status: "verified",
        backup_action: "pre_factory_reset",
      });
      const pending = inspectRuntimeRecoveryFence(env);
      expect(pending).toMatchObject({ status: "pending", manifest_sha256: backup.manifest_sha256 });
      if (pending.status !== "pending") throw new Error("fixture fence was not held");
      expect(createHash("sha256").update(pending.backup_id).digest("hex")).toBe(backup.backup_id_digest);

      const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const systemKeys = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE",
        "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "ComSpec"];
      const inherited = Object.fromEntries(systemKeys.map(key => [key, process.env[key]]));
      const run = (...args: string[]) => spawnSync(process.execPath, ["--", main, ...args], {
        cwd: root, env: { ...inherited, ...env, LLM_BACKEND: "stub", WEBCHAT_HOST: "127.0.0.1" },
        encoding: "utf8", timeout: 15_000, windowsHide: true,
      });
      for (const args of [["--serve"], ["fixture one-shot work"]]) {
        const startup = run(...args);
        expect(startup.status, startup.stderr).toBe(1);
        expect(startup.stdout + startup.stderr).toContain("gateway_runtime_recovery_pending");
      }
      const diagnostic = run("--recovery-inspect", "--json");
      expect(diagnostic.status, diagnostic.stderr).toBe(2);
      expect(JSON.parse(diagnostic.stdout)).toMatchObject({ runtime_recovery_fence: pending });
      expect(inspectRuntimeRecoveryFence(env)).toEqual(pending);

      const reconcile = (commandSha256?: string) => run("--recovery-reconcile", "--backup-id", pending.backup_id,
        "--manifest-sha256", pending.manifest_sha256, "--json",
        ...(commandSha256 === undefined ? [] : ["--command-sha256", commandSha256]));
      if (fixture.partial) {
        const mixed = reconcile();
        expect(mixed.status, mixed.stderr).toBe(2);
        expect(JSON.parse(mixed.stdout)).toMatchObject({ status: "unresolved", used_for_authority: false });
        expect(inspectRuntimeRecoveryFence(env)).toEqual(pending);
        await writeFile(envFile, originalEnv);
      }
      const manifestPath = path.join(env.BLUE_TANUKI_RECOVERY_DIR, pending.backup_id, "manifest.json");
      const manifest = await readFile(manifestPath);
      const checksum = await readFile(`${manifestPath}.sha256`);
      const tampered = Buffer.concat([manifest, Buffer.from("\n")]);
      await writeFile(manifestPath, tampered);
      await writeFile(`${manifestPath}.sha256`, `${createHash("sha256").update(tampered).digest("hex")}  manifest.json\n`);
      expect(JSON.parse(reconcile().stdout)).toMatchObject({ status: "unresolved" });
      expect(inspectRuntimeRecoveryFence(env)).toEqual(pending);
      await writeFile(manifestPath, manifest);
      await writeFile(`${manifestPath}.sha256`, checksum);

      const currentEnvBytes = await readFile(envFile);
      const malformed = reconcile("invalid");
      expect(malformed.status, malformed.stderr).toBe(2);
      expect(JSON.parse(malformed.stdout)).toMatchObject({ status: "invalid_arguments", used_for_authority: false });
      const differentCommandDigest = (pending.command_digest[0] === "0" ? "1" : "0") + pending.command_digest.slice(1);
      const changedCommand = reconcile(differentCommandDigest);
      expect(changedCommand.status, changedCommand.stderr).toBe(2);
      expect(JSON.parse(changedCommand.stdout)).toMatchObject({ status: "unresolved", used_for_authority: false });
      expect(inspectRuntimeRecoveryFence(env)).toEqual(pending);
      const matched = reconcile(pending.command_digest);
      expect(matched.status, matched.stderr).toBe(0);
      expect(JSON.parse(matched.stdout)).toMatchObject({ status: fixture.matches, used_for_authority: false });
      expect(inspectRuntimeRecoveryFence(env).status).toBe("clear");
      expect(await readFile(envFile)).toEqual(currentEnvBytes);
      if (fixture.partial) expect(await readFile(sessionFile, "utf8")).toBe("session fixture\n");
      else await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(reconcile().stdout)).toMatchObject({ status: "no_pending" });
    } finally {
      denyRemoval.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

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
