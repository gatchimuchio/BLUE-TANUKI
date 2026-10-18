import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import {
  OperationPlanCheckpointSchema,
  type ExecutionAdmission,
  type OperationPlan,
} from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { inspectGatewayRecoveryState, projectGatewayRecoveryInspectionForOperator } from "../src/recovery_inspection.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("J OperationPlan recovery inspection", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
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
    request_id: "private-request-id",
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
