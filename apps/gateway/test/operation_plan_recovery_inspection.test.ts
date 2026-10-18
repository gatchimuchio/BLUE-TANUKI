import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentOrganizationCoordinator, operationPlanDigest } from "@blue-tanuki/hds-brain";
import {
  OperationPlanCheckpointSchema,
  type ExecutionAdmission,
  type OperationPlanCheckpoint,
  type OperationPlan,
} from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { createRecoveryBackup, inspectLatestRecoveryBackup } from "../src/recovery_surface.js";
import { operationPlanRequestScopeDigest } from "../src/recovery_request_scope.js";
import { DocumentOrganizationCheckpointStore } from "../src/document_organization_checkpoint_store.js";
import { inspectOperationPlanRecoveryLedger } from "../src/operation_plan_recovery_inspection.js";
import { inspectGatewayRecoveryState, projectGatewayRecoveryInspectionForOperator } from "../src/recovery_inspection.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("J OperationPlan recovery inspection", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("inspects the archived J plan inventory and request scopes without treating it as a restore point", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-archive-"));
    const { stateRoot, privateRoot } = await createPlanState(temporaryRoot, 2);
    const envFile = path.join(temporaryRoot, "product.env");
    const recoveryDirectory = path.join(temporaryRoot, "recovery");
    await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
    const sourcePlanPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const sourceBefore = await readFile(sourcePlanPath);
    const env = { BLUE_TANUKI_STATE_ROOT: stateRoot, BLUE_TANUKI_ENV_FILE: envFile, BLUE_TANUKI_RECOVERY_DIR: recoveryDirectory };

    const backup = await createRecoveryBackup(env);
    const packDirectory = path.join(recoveryDirectory, backup.backup_id!);
    const archivePath = path.join(packDirectory, "canonical-state", "operation_plans.sqlite");
    const archiveBefore = await readFile(archivePath);
    expect(inspectOperationPlanRecoveryLedger({ private_state_root: packDirectory, database_path: archivePath }).status).toBe("verified");
    expect(inspectOperationPlanRecoveryLedger({ private_state_root: packDirectory, database_path: sourcePlanPath }).status).toBe("unavailable");
    const inspection = await inspectLatestRecoveryBackup(env);
    const inventory = inspection.operation_plan_archive_inventory;
    expect(inspection).toMatchObject({ status: "verified", canonical_state_cross_store_atomic: false });
    expect(inventory).toMatchObject({
      status: "verified",
      reason: null,
      plan_scope_count: 1,
      plan_count: 1,
      plan_integrity_residual_count: 0,
      binding_count: 2,
      verified_binding_count: 2,
      residual_binding_count: 0,
      unverified_memory_link_count: 0,
      omitted_binding_count: 0,
      omitted_plan_scope_count: 0,
      cross_ledger_correlation: "not_performed",
      used_for_authority: false,
      may_execute: false,
    });
    expect(inventory.plan_scopes).toMatchObject([{
      request_scope_digest: operationPlanRequestScopeDigest("operation-request:private-request-id", "webchat", "private-owner"),
      integrity: "verified",
      plan_record_count: 1,
      binding_count: 2,
      residual_binding_count: 0,
    }]);
    expect(JSON.stringify(inventory)).not.toContain("private-owner");
    expect(JSON.stringify(inventory)).not.toContain("private-goal");
    expect(JSON.stringify(inventory)).not.toContain("private-plan-id");
    expect(JSON.stringify(inventory)).not.toContain("private-request-id");
    expect(JSON.stringify(inventory)).not.toContain("private-command-");
    expect(await readFile(sourcePlanPath)).toEqual(sourceBefore);
    expect(await readFile(archivePath)).toEqual(archiveBefore);
  });

  it("correlates exact J admissions to verified Broker records without exposing plan or command content", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-"));
    const { stateRoot, privateRoot, checkpoint, admissions } = await createPlanState(temporaryRoot, 2);
    const executionDirectory = path.join(privateRoot, "execution-intents");
    await mkdir(executionDirectory, { recursive: true });
    const executionPath = path.join(executionDirectory, "executor.sqlite");
    const execution = new GatewayExecutionIntentStore(executionPath);
    execution.issue(admissions[0]!);
    // Same command key, different ticket identity: it must not satisfy the second J binding.
    execution.issue({ ...admissions[1]!, ticket_id: randomUUID() });
    execution.close();
    const planPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const planBefore = await readFile(planPath);
    const executionBefore = await readFile(executionPath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });
    const correlations = report.operation_plan_correlations;
    expect(report.ledgers.operation_plans).toMatchObject({
      status: "verified",
      plan_count: 1,
      binding_count: 2,
      verified_binding_count: 2,
      residual_binding_count: 0,
      used_for_authority: false,
      may_execute: false,
    });
    expect(report.ledgers.execution.status).toBe("verified");
    expect(correlations.map((item) => item.broker_correlation)).toEqual(["matched", "not_found"]);
    expect(correlations[0]).toMatchObject({
      status: "intent_committed",
      binding_integrity: "verified",
      broker_state: "issued",
      delivery_correlation: "not_recorded",
    });
    expect(correlations[1]).toMatchObject({
      status: "intent_committed",
      binding_integrity: "verified",
      broker_state: null,
    });
    expect(report.operation_plan_residual_count).toBeGreaterThan(0);
    expect(report.replay_checkpoint).toBeNull();
    const serialized = JSON.stringify(report);
    for (const secret of [
      "private-owner",
      "private-goal",
      "private-plan-id",
      "private-step-1",
      "private-command-1",
      admissions[0]!.ticket_id,
      admissions[0]!.command_key,
      "private-workspace-root",
    ]) expect(serialized).not.toContain(secret);
    expect(await readFile(planPath)).toEqual(planBefore);
    expect(await readFile(executionPath)).toEqual(executionBefore);
    await expect(stat(path.join(privateRoot, "result-memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("suppresses all J bindings when the self-stored checkpoint digest is corrupt", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-corrupt-"));
    const { stateRoot, privateRoot } = await createPlanState(temporaryRoot, 1);
    const planPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const database = new DatabaseSync(planPath);
    database.prepare("UPDATE operation_plan_state SET digest=? WHERE id=1").run(sha256("corrupt-checkpoint"));
    database.close();
    const before = await readFile(planPath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });
    expect(report.ledgers.operation_plans).toMatchObject({
      status: "corrupt",
      reason: "checkpoint_integrity_mismatch",
      bindings: [],
      used_for_authority: false,
      may_execute: false,
    });
    expect(report.operation_plan_correlations).toEqual([]);
    expect(report.operation_plan_residual_count).toBeGreaterThan(0);
    expect(await readFile(planPath)).toEqual(before);
  });

  it("reports a plan-level revision residual even when the plan has no bindings", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-revision-"));
    const { stateRoot, privateRoot } = await createPlanState(temporaryRoot, 1);
    const planPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const database = new DatabaseSync(planPath);
    const row = database.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id=1").get() as { checkpoint_json: string };
    const checkpoint = JSON.parse(row.checkpoint_json) as { plans: Array<{ revisions: Array<{ digest: string }>; bindings: unknown[] }> };
    checkpoint.plans[0]!.revisions[0]!.digest = sha256("wrong-revision");
    checkpoint.plans[0]!.bindings = [];
    const json = JSON.stringify(checkpoint);
    database.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
      .run(json, operationPlanDigest(checkpoint));
    database.close();
    const before = await readFile(planPath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });
    expect(report.ledgers.operation_plans).toMatchObject({
      status: "residuals_present",
      reason: "binding_mismatch",
      plan_count: 1,
      plan_integrity_residual_count: 1,
      binding_count: 0,
      residual_binding_count: 0,
    });
    expect(report.operation_plan_residual_count).toBeGreaterThan(0);
    expect(report.replay_checkpoint).toBeNull();
    expect(await readFile(planPath)).toEqual(before);
  });

  it("scopes one plan residual without spreading it to a separate inspected plan", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-scopes-"));
    const { stateRoot, privateRoot, checkpoint } = await createPlanState(temporaryRoot, 1);
    const brokenPlanState = structuredClone(checkpoint.plans[0]!);
    brokenPlanState.revisions[0]!.digest = sha256("bad-plan-revision");
    brokenPlanState.bindings = [];

    const cleanPlan: OperationPlan = {
      ...planFixture(1),
      plan_id: "private-plan-clean",
      request_id: "private-request-clean",
    };
    const cleanRevisionDigest = operationPlanDigest(cleanPlan);
    const cleanStep = cleanPlan.steps[0]!;
    const baseBinding = checkpoint.plans[0]!.bindings[0]!;
    const { execution_admission: _admission, ...bindingWithoutAdmission } = baseBinding;
    const cleanPlanState: OperationPlanCheckpoint["plans"][number] = {
      owner: "private-owner",
      channel: "webchat",
      goal: "private-clean-goal",
      revisions: [{ digest: cleanRevisionDigest, plan: cleanPlan }],
      receipt_observations: [],
      bindings: [{
        ...bindingWithoutAdmission,
        step_id: cleanStep.step_id,
        revision_digest: cleanRevisionDigest,
        step_digest: stepDefinitionDigest(cleanStep),
        prepared_step: cleanStep,
        command_id: "private-command-clean",
        request_id: cleanPlan.request_id,
        commit_hash: "private-commit-clean",
        payload_digest: sha256("clean-payload"),
        command_digest: sha256("clean-command"),
        operation: cleanStep.operation,
        status: "not_attempted",
      }],
      results: [],
    };
    const combined = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [brokenPlanState, cleanPlanState],
    });
    const planPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const database = new DatabaseSync(planPath);
    const serialized = JSON.stringify(combined);
    database.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
      .run(serialized, operationPlanDigest(combined));
    database.close();

    const cronDirectory = path.join(privateRoot, "cron-events");
    await mkdir(cronDirectory, { recursive: true });
    const cron = new GatewayCronEventStore(path.join(cronDirectory, "cron-events.sqlite"));
    cron.close();

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });
    const brokenPlanDigest = operationPlanDigest("private-plan-id");
    const cleanPlanDigest = operationPlanDigest("private-plan-clean");
    expect(report.ledgers.operation_plans).toMatchObject({
      status: "residuals_present",
      plan_count: 2,
      binding_count: 1,
      plan_integrity_residual_count: 1,
      residual_binding_count: 0,
      omitted_binding_count: 0,
    });
    expect(report.plan_dependency_scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plan_id_digest: brokenPlanDigest,
        integrity: "residuals_present",
        status: "residuals_present",
        residual_dependencies: ["operation_plan"],
      }),
      expect.objectContaining({
        plan_id_digest: cleanPlanDigest,
        integrity: "verified",
        status: "observed",
        inspected_binding_count: 1,
        residual_dependencies: [],
      }),
    ]));
    expect(report.plan_dependency_scopes.find((scope) => scope.plan_id_digest === cleanPlanDigest)?.request_scope_digest).toBeNull();
    expect(report.external_backup_restore_point).toBe("not_examined");
    expect(report.used_for_authority).toBe(false);
    expect(report.may_execute).toBe(false);
    const projection = projectGatewayRecoveryInspectionForOperator(report);
    expect(projection).toMatchObject({ boundary_valid: true, used_for_authority: false, may_execute: false });
    const serializedReport = JSON.stringify(report);
    const serializedProjection = JSON.stringify(projection);
    for (const secret of ["private-plan-id", "private-plan-clean", "private-request-clean", "private-command-clean", "private-clean-goal"]) {
      expect(serializedReport).not.toContain(secret);
      expect(serializedProjection).not.toContain(secret);
    }
  });

  it("correlates a verified plan and document checkpoint by the exact inbound request scope digest", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-request-scope-"));
    const { stateRoot } = await createPlanState(temporaryRoot, 1);
    const requestId = "private-request-id";
    const source = "private-document-source";
    const fileRoot = path.join(temporaryRoot, "files");
    const checkpointPath = path.join(fileRoot, "document-organization", "j-checkpoints.sqlite");
    const checkpoints = new DocumentOrganizationCheckpointStore(checkpointPath);
    checkpoints.getOrCreate({
      channel: "webchat",
      actor: "private-owner",
      source_sha256: sha256(source),
    }, new DocumentOrganizationCoordinator({
      task_id: `document-organization:${requestId}`,
      request_id: requestId,
      source_text: source,
    }).checkpoint());
    checkpoints.close();
    const checkpointBefore = await readFile(checkpointPath);

    const report = inspectGatewayRecoveryState({
      BLUE_TANUKI_STATE_ROOT: stateRoot,
      BLUE_TANUKI_FILE_ROOT: fileRoot,
    });
    const actorDigest = sha256(`7:webchat|13:private-owner`);
    const expectedScopeDigest = sha256(`blue-tanuki.inbound-request-scope.v1\0${actorDigest}\0${requestId}`);
    const planScope = report.plan_dependency_scopes[0];
    const documentRecord = report.ledgers.document_organization_checkpoints.records[0];
    expect(planScope?.request_scope_digest).toBe(expectedScopeDigest);
    expect(documentRecord?.request_scope_digest).toBe(expectedScopeDigest);
    expect(report.used_for_authority).toBe(false);
    expect(report.may_execute).toBe(false);
    const projection = projectGatewayRecoveryInspectionForOperator(report);
    expect(projection.boundary_valid).toBe(true);
    expect(projection.plan_dependency_scopes[0]?.request_scope_digest).toBe(expectedScopeDigest);
    expect(projection.document_organization_checkpoint_summary.records[0]?.request_scope_digest).toBe(expectedScopeDigest);
    for (const value of [requestId, `operation-request:${requestId}`, `document-organization:${requestId}`, source, "private-owner"]) {
      expect(JSON.stringify(report)).not.toContain(value);
      expect(JSON.stringify(projection)).not.toContain(value);
    }
    expect(await readFile(checkpointPath)).toEqual(checkpointBefore);
  });

  it("refuses an operation-plan database with SQLite sidecars without opening or changing it", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-sidecar-"));
    const { stateRoot, privateRoot } = await createPlanState(temporaryRoot, 1);
    const planPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const before = await readFile(planPath);
    const sidecar = `${planPath}-wal`;
    await writeFile(sidecar, "sentinel");

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });
    expect(report.ledgers.operation_plans.status).toBe("unavailable");
    expect(await readFile(planPath)).toEqual(before);
    expect(await readFile(sidecar, "utf8")).toBe("sentinel");
  });

  it("correlates Cron approval handoffs to Operation Plan bindings by digest without changing either ledger", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-plan-cron-"));
    const { stateRoot, privateRoot, checkpoint } = await createPlanState(temporaryRoot, 5);
    const cronDirectory = path.join(privateRoot, "cron-events");
    await mkdir(cronDirectory, { recursive: true });
    const cronPath = path.join(cronDirectory, "cron-events.sqlite");
    const cron = new GatewayCronEventStore(cronPath);
    const bindings = checkpoint.plans[0]!.bindings;
    const commandIds = bindings.map((binding) => binding.command_id);
    const requestIds = bindings.map((binding) => binding.request_id);
    const eventIds: string[] = [];
    const makePending = (source: string, sequence: number, bindingIndex: number, now: number) => {
      const event = createCronEventIdentity(source, sequence, sha256(`payload-${source}`));
      expect(cron.claim(event, now).status).toBe("accepted");
      cron.recordPendingApproval(event.event_id, event.payload_digest, commandIds[bindingIndex]!, requestIds[bindingIndex]!, now + 1);
      eventIds.push(event.event_id);
      return event;
    };

    const resolvedEvent = makePending("synthetic-resolved-source", 1, 0, 10);
    cron.resolvePendingApproval(
      resolvedEvent.event_id,
      resolvedEvent.payload_digest,
      commandIds[0]!,
      requestIds[0]!,
      "consumed",
      12,
    );
    makePending("synthetic-interrupted-source", 2, 1, 20);
    makePending("synthetic-duplicate-source-a", 3, 4, 30);
    makePending("synthetic-duplicate-source-b", 4, 4, 40);
    expect(cron.recoverPendingApprovalHandoffs(50)).toBe(3);
    makePending("synthetic-pending-source", 5, 2, 60);
    cron.close();

    const planPath = path.join(privateRoot, "operation-plans", "j-state.sqlite");
    const planBefore = await readFile(planPath);
    const cronBefore = await readFile(cronPath);
    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });

    expect(report.operation_plan_correlations.map((item) => item.cron_approval_correlation)).toEqual([
      "resolved", "interrupted", "pending", "not_recorded", "ambiguous",
    ]);
    expect(report.cron_approval_correlation_residual_count).toBe(1);
    expect(report.replay_checkpoint).toBeNull();
    expect(report.used_for_authority).toBe(false);
    expect(report.may_execute).toBe(false);
    const projection = projectGatewayRecoveryInspectionForOperator(report);
    expect(projection).toMatchObject({
      status: "residuals_present",
      cron_approval_correlation_residual_count: 1,
      operation_plan_correlations: report.operation_plan_correlations.map((item) => ({
        cron_approval_correlation: item.cron_approval_correlation,
      })),
      used_for_authority: false,
      may_execute: false,
    });
    const serialized = JSON.stringify(report);
    for (const secret of [
      ...commandIds,
      ...requestIds,
      ...eventIds,
      ...["synthetic-resolved-source", "synthetic-interrupted-source", "synthetic-duplicate-source-a", "synthetic-duplicate-source-b", "synthetic-pending-source"],
    ]) expect(serialized).not.toContain(secret);
    const projected = JSON.stringify(projection);
    for (const secret of [...commandIds, ...requestIds]) expect(projected).not.toContain(secret);
    expect(await readFile(planPath)).toEqual(planBefore);
    expect(await readFile(cronPath)).toEqual(cronBefore);
  });
});

async function createPlanState(temporaryRoot: string, bindingCount: number) {
  const stateRoot = path.join(temporaryRoot, "state");
  const privateRoot = path.join(stateRoot, "private-state");
  const plansDirectory = path.join(privateRoot, "operation-plans");
  await mkdir(plansDirectory, { recursive: true });
  const plan = planFixture(bindingCount);
  const revisionDigest = operationPlanDigest(plan);
  const admissions = plan.steps.map((step, index) => admissionFor(`private-command-${index + 1}`));
  const checkpoint = OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [{
      owner: "private-owner",
      channel: "webchat",
      goal: "private-goal",
      revisions: [{ digest: revisionDigest, plan }],
      receipt_observations: [],
      bindings: plan.steps.map((step, index) => ({
        step_id: step.step_id,
        revision_digest: revisionDigest,
        step_digest: stepDefinitionDigest(step),
        prepared_step: step,
        command_id: `private-command-${index + 1}`,
        request_id: plan.request_id,
        commit_hash: `private-commit-${index + 1}`,
        payload_digest: sha256(`payload-${index + 1}`),
        command_digest: sha256(`command-${index + 1}`),
        operation: step.operation,
        status: "intent_committed",
        execution_admission: admissions[index],
      })),
      results: [],
    }],
  });
  const store = new OperationPlanStateStore(path.join(plansDirectory, "j-state.sqlite"));
  store.compareAndSet(null, checkpoint);
  store.close();
  return { stateRoot, privateRoot, checkpoint, admissions };
}

function planFixture(bindingCount: number): OperationPlan {
  const steps = Array.from({ length: bindingCount }, (_, index) => ({
    step_id: `private-step-${index + 1}`,
    operation: "file.search",
    target: { kind: "directory" as const, id: "private-workspace-root" },
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
    parameters: { root: "private-workspace-root", query: "fixture", max_results: 1 },
    preparation: {
      depends_on: [],
      bindings: [],
      preconditions: [],
      validation: [{
        check_id: `private-step-${index + 1}`,
        method: "result_equals" as const,
        target: { kind: "directory" as const, id: "private-workspace-root" },
        expected: { count: 0 },
      }],
      compensation: { available: false as const, reason: "fixture" },
    },
  }));
  return {
    version: "operation-core.v1",
    plan_id: "private-plan-id",
    request_id: "operation-request:private-request-id",
    state: "planned",
    steps,
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false,
    hds_brain_authority_required: true,
  };
}

function stepDefinitionDigest(step: OperationPlan["steps"][number]): string {
  const { state: _state, result_digest: _result, ...definition } = step;
  return operationPlanDigest(definition);
}

function admissionFor(commandId: string): ExecutionAdmission {
  return {
    ticket_id: randomUUID(),
    command_key: sha256(JSON.stringify(["gateway-executor-command.v1", commandId])),
    command_digest: sha256(`admitted-command-${commandId}`),
    proof_digest: sha256(`proof-${commandId}`),
    execution_epoch: randomUUID(),
    issued_at_ms: 10_000,
    expires_at_ms: 20_000,
  };
}
