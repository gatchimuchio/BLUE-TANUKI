import { describe, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { AuditLog, HDSUpperController, evaluateApproval, goalGovernanceEventDigest, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { Executor, ToolRegistry, createExecutorApprovalAuthority, fileDeleteTool, fileEditTool, fileSearchTool, fileWriteTool, LLMComputeAdapter, type LLMRequest, type LLMResponse } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, memoryCommitContentDigest, type ExecuteCommand, type OperationPlan, type InboundRequest } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { createFileSearchWorker } from "../src/file_search_worker.js";
import { executionAdmissionForCommand, reconcileExecutionResults, reconcileStartupExecutionState } from "../src/reconcile_execution_results.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";
import { projectOperationPlanStatus } from "../src/serve_projection.js";
import { goalPurposeMemoryStorage, operationResultMemoryStorage } from "../src/operation_result_memory_config.js";
import { operationPlanRecoveryEvidenceFromObservation } from "../src/operation_plan_recovery_evidence.js";
import { correlateOperationPlanBindings, inspectGatewayRecoveryState } from "../src/recovery_inspection.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function planTaskIdentityDigest(owner: string, channel: string, task: string, planId: string, requestId: string): string {
  return operationPlanDigest({
    schema_version: "blue-tanuki.operation-plan-task-identity.v1",
    owner_digest: operationPlanDigest(owner),
    channel_digest: operationPlanDigest(channel),
    task_digest: operationPlanDigest(task),
    plan_id_digest: operationPlanDigest(planId),
    request_id_digest: operationPlanDigest(requestId),
  });
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
function request(content: string): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner", timestamp: Date.now(), content,
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
}
function recoveryCommandIdDigest(commandId: string): string { return createHash("sha256").update(commandId).digest("hex"); }
function canonicalMemoryRestoreCommand(): ExecuteCommand {
  return { id: randomUUID(), type: "tool_call",
    payload: { tool_name: "recovery.restore", arguments: { backup_id: "fixture", store_key: "m_state", confirm: "RESTORE" } },
    upstream_decision: { request_id: randomUUID(), commit_hash: "a".repeat(64), commit_decision: "ASSERT" },
  } as unknown as ExecuteCommand;
}
function candidate(id: string, root: string): OperationPlan {
  const target = { kind: "directory" as const, id: root };
  const output = { root, sandbox_root: root, query: "blue", visited_files: 1, matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
  const step = (step_id: string) => ({ step_id, operation: "file.search", target, state: "planned" as const, effects: ["read" as const],
    permission: { risk: "low" as const, approval_level: "L1_observe" as const, final_review_required: false,
      hds_brain_authority_required: true as const, approval_gate_required: true },
    adapter: "internal_runtime" as const, adapter_is_authority: false as const, command_generated_by_adapter_only: false,
    parameters: { root, query: "blue", max_results: 1 }, preparation: { depends_on: [] as string[], bindings: [], preconditions: [],
      validation: [{ check_id: step_id, method: "result_equals" as const, target, expected: output }],
      compensation: { available: false as const, reason: "read-only" } } });
  const first = step("search"); const next = step("dependent"); next.preparation.depends_on = ["search"];
  return { version: "operation-core.v1", plan_id: `plan-${id}`, request_id: id, state: "planned", steps: [first, next],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function fileWriteCandidate(id: string, root: string, expectedByteAdjustment = 0): OperationPlan {
  const content = "synthetic planned file content\n";
  const target = { kind: "file" as const, id: "notes.txt" };
  const output = { path: "notes.txt", sandbox_root: root, mode: "create",
    bytes_written: Buffer.byteLength(content) + expectedByteAdjustment };
  return { version: "operation-core.v1", plan_id: `plan-${id}`, request_id: id, state: "planned",
    steps: [{ step_id: "create-note", operation: "file.write", target, state: "planned", effects: ["write"],
      permission: { risk: "medium", approval_level: "L2_operate", final_review_required: false,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { path: "notes.txt", content, mode: "create" }, preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "created-note", method: "result_equals", target, expected: output }],
        compensation: { available: false, reason: "new file cleanup requires owner direction" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function fileDeleteCandidate(id: string): OperationPlan {
  const target = { kind: "file" as const, id: "notes.txt" };
  return { version: "operation-core.v1", plan_id: "plan-" + id, request_id: id, state: "planned",
    steps: [{ step_id: "delete-note", operation: "file.delete", target, state: "planned", effects: ["delete"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { path: "notes.txt", max_bytes: 128 }, preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "deleted-note", method: "result_equals", target, expected: { deleted: true } }],
        compensation: { available: false, reason: "file deletion requires a new owner-reviewed create operation to recover" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function fileEditCandidate(id: string): OperationPlan {
  const target = { kind: "file" as const, id: "notes.txt" };
  const output = { edited: true, replacements: 1, bytes_written: Buffer.byteLength("synthetic edited text\n") };
  return { version: "operation-core.v1", plan_id: "plan-" + id, request_id: id, state: "planned",
    steps: [{ step_id: "edit-note", operation: "file.edit", target, state: "planned", effects: ["read", "write"],
      permission: { risk: "medium", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { path: "notes.txt", search: "original", replace: "edited", expected_replacements: 1, max_bytes: 128 },
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "edited-note", method: "result_equals", target, expected: output }],
        compensation: { available: false, reason: "an in-place edit requires a newly reviewed edit to restore" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function review(hds: HDSUpperController, plan: OperationPlan, step_id: string) {
  const p = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
  return hds.decide(request(`plan:review ${JSON.stringify({ plan_id: plan.plan_id, revision_digest: p.revision_digest, step_id })}`)).command;
}
async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  planFactory: (id: string, root: string) => OperationPlan = candidate,
  prepareWorkspace?: (workspace: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "blue-result-reconcile-")); const workspace = join(root, "workspace");
  mkdirSync(workspace); writeFileSync(join(workspace, "blue.txt"), "blue\n");
  prepareWorkspace?.(workspace);
  vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
  const context = await setup(root, workspace, planFactory);
  try { await run(context); } finally {
    for (const hds of context.controllers) { hds.closeOperationPlanMemory(); hds.close(); }
    context.execution.close(); context.j.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}
async function setup(root: string, workspace: string, planFactory: (id: string, root: string) => OperationPlan = candidate) {
  const executionPath = join(root, "executor.sqlite"); const jPath = join(root, "j.sqlite"); const executionEpoch = randomUUID();
  const execution = new GatewayExecutionIntentStore(executionPath, executionEpoch); const j = new OperationPlanStateStore(jPath);
  const memory = operationResultMemoryStorage({ BLUE_TANUKI_STATE_ROOT: join(root, "state") });
  const controllers: HDSUpperController[] = [];
  const oldMemory = { capture: vi.fn(), recent: vi.fn(() => []), all: vi.fn(() => []) };
  function createHds(state = j, installPurpose = false) {
    const controller = new HDSUpperController({ operation_plan_state: state, operation_plan_memory: memory, memory: oldMemory,
      ...(installPurpose ? { audit: new AuditLog({ filepath: join(root, "audit.jsonl") }),
        goal_purpose_memory: goalPurposeMemoryStorage({ BLUE_TANUKI_STATE_ROOT: join(root, "state") }),
        goal_governance: testGoalGovernance() } : {}) });
    controllers.push(controller); return controller;
  }
  const hds = createHds();
  const origin = request("plan:compute 合成の実行結果を後続へ安全に返す");
  const plan = planFactory(origin.id, workspace); const tools = new ToolRegistry();
  tools.register(fileSearchTool); tools.register(fileWriteTool); tools.register(fileDeleteTool); tools.register(fileEditTool);
  const authority = createExecutorApprovalAuthority({ execution_store: execution, execution_epoch: executionEpoch,
    require_hds_execution_binding: true });
  const actualWorker = createFileSearchWorker({ execution_epoch: executionEpoch,
    env: { SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace } });
  const invoke = vi.fn(actualWorker.invoke); const worker = { invoke };
  const executor = new Executor({ tools, approval_authority: authority, file_search_worker: worker,
    llm: { name: "fixture", call: async () => ({ content: JSON.stringify(plan), model: "fixture", tokens_used: 0 }) } });
  async function approve(cmd: ExecuteCommand) {
    const a = evaluateApproval(cmd, [], { actor: "fixture-owner", default_mode: "full_access" });
    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(cmd);
    const targetVersion = await executor.inspectCommandTargetVersion(cmd, undefined, operationPlanBindingDigest);
    const hdsBinding = hds.createExecutionAuthorityBinding(cmd, targetVersion);
    return authority.approve(cmd, { source: a.final_review_required ? "human_final_review" : "approval_gate",
      decision: a.final_review_required ? "approve" : "allow",
      approved_by: "fixture-owner", approved_at_ms: Date.now(), upstream_commit_hash: cmd.upstream_decision.commit_hash,
      operation: a.context.operation, risk: a.risk, final_review_required: a.final_review_required, reason: "fixture" },
      undefined, hdsBinding, targetVersion);
  }
  const initial = hds.decide(origin).command!; const first = await executor.execute(await approve(initial));
  finalizeCommandOutput({ hds, command: initial, feedback: first, request_id: origin.id, target_surface: "channel" });
  const cmd = review(hds, plan, plan.steps[0]!.step_id)!; const approved = await approve(cmd);
  const admission = executionAdmissionForCommand(cmd, authority.receipt(approved));
  return { root, workspace, executionPath, jPath, execution, j, hds, plan, cmd, approved, admission, authority, executor, invoke, memory,
    controllers, createHds, approve, oldMemory, purposeBinding: undefined as
      { goal_ref: string; purpose_version: number; purpose_digest: string } | undefined };
}

function testGoalGovernance() {
  const event = { event_ref: "ge_0123456789abcdef", event_kind: "purpose_change" as const,
    goal_ref: "goal_0123456789abcdef", source_ref: "F:0123456789abcdef", goal_kind: "delegated" as const,
    prior_version: 1, new_version: 2, prior_purpose_digest: "a".repeat(64), new_purpose_digest: "e".repeat(64),
    authority_kind: "owner" as const, authorization_ref: "ga_0123456789abcdef", recorded_at: 100, effective_from: 500 };
  return { schema_version: "blue-tanuki.goal-governance.v1" as const,
    goals: [{ goal_ref: event.goal_ref, goal_kind: event.goal_kind, source_ref: event.source_ref,
      initial_purpose_digest: "a".repeat(64), initial_interpretation_digest: "b".repeat(64), adopted_at: 0 }],
    authorizations: [{ authorization_ref: event.authorization_ref, event_ref: event.event_ref,
      event_digest: goalGovernanceEventDigest(event), goal_ref: event.goal_ref, event_kind: event.event_kind,
      authority_kind: event.authority_kind, authorized_at: event.recorded_at }], events: [event] };
}

function installTestPurpose(hds: HDSUpperController) {
  const purposeText = "Keep synthetic file action results as non-authoritative history and ask for fresh evidence before claiming current state.";
  const purposeDigest = createHash("sha256").update(purposeText, "utf8").digest("hex");
  const binding = { goal_ref: "goal_0123456789abcdef", purpose_version: 3, purpose_digest: purposeDigest };
  const requestId = randomUUID();
  const command: ExecuteCommand = { id: randomUUID(), type: "tool_call",
    payload: { tool_name: "goal.governance.change", arguments: { goal_ref: binding.goal_ref,
      prior_version: 2, prior_purpose_digest: "e".repeat(64), new_purpose_digest: purposeDigest } },
    constraints: { allowed_tools: ["goal.governance.change"], allowed_capabilities: ["tool:goal.governance.change"] },
    upstream_decision: { request_id: requestId, frame_goal: "Review a synthetic delegated-goal purpose update.",
      model_abstraction: "test", commit_hash: "a".repeat(64), commit_decision: "ASSERT" } };
  const evaluation = evaluateApproval(command, [], { actor: "webchat-owner-token-holder", default_mode: "full_access" });
  hds.onApprovalEvaluation(evaluation, { request_id: requestId });
  hds.onCommandLifecycle(command.id, "approval_approved", { actor: "webchat-resume-token-holder",
    reason: "human_approval:approve", request_id: requestId });
  const committed = hds.commitGoalPurposeChangeAfterL3({ goal_ref: binding.goal_ref, prior_version: 2,
    prior_purpose_digest: "e".repeat(64), new_purpose_digest: purposeDigest, purpose_text: purposeText,
    request_id: requestId, command_id: command.id, proposal_actor: "webchat-owner-token-holder",
    actor: "webchat-resume-token-holder", evaluation });
  if (!committed.ok) throw new Error(`synthetic purpose setup failed: ${committed.reason}`);
  return binding;
}

function inspectMemory(c: Awaited<ReturnType<typeof setup>>) {
  const db = new DatabaseSync(c.memory.memory_database_path);
  try {
    const revision = db.prepare("SELECT revision FROM m_state").get()!.revision;
    const rows = db.prepare("SELECT value_json FROM m_records").all();
    const receipts = db.prepare("SELECT receipt_json FROM m_receipts").all();
    return { revision, records: rows.map((r) => JSON.parse(String(r.value_json))), receipts: receipts.map((r) => JSON.parse(String(r.receipt_json))) };
  } finally { db.close(); }
}

describe("保存実結果→再起動J→依存stepの非作用調停", () => {
  it("Jが保持するcanonical action digestとExecutor ticket digestが一致しない限りattemptを開始しない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, { ...c.admission!, command_digest: "0".repeat(64) })).toBe(false);
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
  }));

  it("旧generationの遅延結果をprivate evidenceへ隔離し、現行J/Mへ適用しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    const saved = c.execution.pendingResults()[0]!;
    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    const currentEpoch = randomUUID();
    const reconcileResult = vi.spyOn(restarted, "reconcileOperationPlanResult");

    expect(reconcileStartupExecutionState(restarted, c.execution, currentEpoch)).toEqual({
      ready: true, adopted: 0, deferred: 0, stale_generation_archived: 1,
      memory_ready: true, result_store_readable: true,
    });
    expect(reconcileResult).not.toHaveBeenCalled();
    expect(c.j.load()?.plans[0]?.results).toHaveLength(0);
    expect(inspectMemory(c).revision).toBe(0);
    expect(c.execution.pendingResults()).toHaveLength(0);
    expect(c.execution.lookup(c.admission.ticket_id)).toMatchObject({
      result_delivery_acknowledged: true,
      result_delivery_disposition: "stale_generation_evidence",
      result_archived_by_epoch_digest: createHash("sha256").update(currentEpoch).digest("hex"),
    });
    expect(c.execution.verifyEvents()).toBe(true);
    const db = new DatabaseSync(c.executionPath);
    try {
      expect(db.prepare("SELECT delivery_digest FROM execution_result_outbox WHERE ticket_id=?")
        .get(c.admission.ticket_id)).toEqual({ delivery_digest: saved.delivery_digest });
    } finally { db.close(); }
    const visible = JSON.stringify(c.execution.snapshot());
    expect(visible).toContain("stale_generation_evidence");
    expect(visible).not.toContain(c.workspace);
    expect(visible).not.toContain('"matches"');
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("実worker結果とreceiptを保存し、承認/inflightなしの再起動後にJへ一回採用する", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success"); expect(c.invoke).toHaveBeenCalledTimes(1);
    const saved = c.execution.pendingResults()[0]!;
    expect(hash(saved.delivery.feedback.result)).toBe(feedback.operation_core_result?.output_digest);
    expect(saved.delivery.feedback.operation_core_result).toEqual(feedback.operation_core_result);
    expect(c.execution.lookup(c.admission.ticket_id)?.result_delivery_acknowledged).toBe(false);
    const reopened = new GatewayExecutionIntentStore(c.executionPath, c.execution.executionEpoch); const j = new OperationPlanStateStore(c.jPath);
    try {
      c.hds.closeOperationPlanMemory(); const hds = c.createHds(j);
      hds.onFeedback(feedback); // 通常のinflight保護は維持し、この遅延feedbackを採用しない。
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
      expect(review(hds, c.plan, "dependent")).toBeNull();
      expect(reconcileExecutionResults(hds, reopened, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
      expect(j.load()?.plans[0]?.results[0]?.observed_at_ms).toBe(feedback.operation_core_result?.observed_at_ms);
      expect(review(hds, c.plan, "dependent")?.type).toBe("tool_call");
      expect(reopened.pendingResults()).toHaveLength(0); expect(reopened.verifyEvents()).toBe(true);
      const visible = JSON.stringify({ execution: reopened.snapshot(), j: hds.getRuntimeSnapshot().operation_plans });
      for (const secret of [c.workspace, c.admission.ticket_id, c.admission.execution_epoch, '"matches"', '"execution_admission"']) expect(visible).not.toContain(secret);
      expect(c.invoke).toHaveBeenCalledTimes(1); expect((await c.executor.execute(c.approved)).status).toBe("failed");
    } finally { reopened.close(); j.close(); }
  }));

  it("Jで検証したfile.write結果だけをdigest観測としてMへ返し、C反省へ渡さない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic planned file content\n");

    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const checkpoint = c.j.load()!.plans[0]!;
    const binding = checkpoint.bindings[0]!;
    expect(binding).toMatchObject({ status: "verified", delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      memory_receipt: expect.objectContaining({ revision: 1 }) });
    expect(checkpoint.results).toHaveLength(1);
    expect(checkpoint.results[0]?.output).toEqual(feedback.result);
    expect(c.execution.pendingResults()).toHaveLength(0);

    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1); expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.write", delivery_digest: binding.delivery_digest, result_digest: binding.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const memoryJson = JSON.stringify(observation);
    for (const raw of [c.workspace, "notes.txt", "synthetic planned file content", "sandbox_root", "bytes_written"]) {
      expect(memoryJson).not.toContain(raw);
    }

    const current = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const reflection = request(`plan:reflect ${JSON.stringify({ plan_id: current.plan_id, revision_digest: current.revision_digest,
      step_ids: ["create-note"], question: "書込み結果を解釈する" })}`);
    expect(c.hds.decide(reflection).command).toBeNull();

    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    expect(restarted.reconcileOperationPlanMemory()).toBe(true);
    expect(inspectMemory(c)).toEqual(memory);
    expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("verified");
  }, fileWriteCandidate));

  it("Jで検証したfile.delete結果をdigest限定の非権威観測としてMへ返す", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(feedback.result).toEqual({ deleted: true });
    expect(() => readFileSync(join(c.workspace, "notes.txt"), "utf8")).toThrow();

    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const checkpoint = c.j.load()!.plans[0]!;
    const binding = checkpoint.bindings[0]!;
    expect(binding).toMatchObject({ status: "verified", delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      memory_receipt: expect.objectContaining({ revision: 1 }) });
    expect(checkpoint.results[0]?.output).toEqual({ deleted: true });
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1);
    expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.delete", delivery_digest: binding.delivery_digest, result_digest: binding.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const memoryJson = JSON.stringify(observation);
    for (const raw of [c.workspace, "notes.txt", "synthetic delete target"]) expect(memoryJson).not.toContain(raw);
    expect(c.execution.pendingResults()).toHaveLength(0);
  }, fileDeleteCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic delete target\n")));

  it("Operation Planから実行したfile.edit結果をJ/Mへ返し、明示選択後に非権威観測としてCへ渡す", async () => fixture(async (c) => {
    const operationPlanBindingDigest = c.hds.getExecutionOperationPlanBindingDigest(c.cmd);
    const observedTarget = await c.executor.inspectCommandTargetVersion(c.cmd, undefined, operationPlanBindingDigest);
    expect(observedTarget?.schema_version).toBe("blue-tanuki.file-edit-target-version.v1");
    const contentReview = await c.executor.inspectCommandContentReview(c.cmd, undefined, operationPlanBindingDigest);
    if (!contentReview || !("diff" in contentReview)) throw new Error("selected file.edit has no owner-review diff");
    expect(contentReview).toMatchObject({ path: "notes.txt", replacement_count: 1,
      command_digest: operationPlanDigest(c.cmd), operation_plan_binding_digest: operationPlanBindingDigest,
      used_for_authority: false, may_execute: false });
    expect(contentReview.diff).toContain("-original\n+edited\n");
    expect(contentReview.target_version_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic original text\n");
    expect(() => c.hds.createExecutionAuthorityBinding(c.cmd, { ...observedTarget!,
      operation_plan_binding_digest: "f".repeat(64) })).toThrow(/current Operation Plan source/);

    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(feedback.result).toEqual({ edited: true, replacements: 1,
      bytes_written: Buffer.byteLength("synthetic edited text\n") });
    const appliedContent = readFileSync(join(c.workspace, "notes.txt"));
    expect(appliedContent.toString("utf8")).toBe("synthetic edited text\n");
    expect(createHash("sha256").update(appliedContent).digest("hex")).toBe(contentReview.after_content_digest);
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    const checkpoint = c.j.load()!.plans[0]!;
    const binding = checkpoint.bindings[0]!;
    expect(binding).toMatchObject({ status: "verified", operation: "file.edit",
      delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/), memory_receipt: expect.objectContaining({ revision: 1 }) });
    expect(checkpoint.results[0]?.output).toEqual(feedback.result);
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1);
    expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.edit", delivery_digest: binding.delivery_digest, result_digest: binding.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const memoryJson = JSON.stringify(observation);
    for (const raw of [c.workspace, "notes.txt", "synthetic original text", "synthetic edited text"]) {
      expect(memoryJson).not.toContain(raw);
    }
    expect(c.execution.pendingResults()).toHaveLength(0);

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);
    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    const destinationRequestId = randomUUID();
    const task = "Use the selected historical edit report only as context; require fresh observation before claiming current file state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding, source_observation_refs: [sourceRef] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected edit observation was not routed to C: ${compute.log.commit.reason}`);
    expect(compute.command.payload.compute_context?.local_p_version).toBe("blue-tanuki.plan-compute-source-observations.v5");
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("verified_file_edit_result");
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(expectedTaskIdentityDigest);
    expect(serializedInput).toContain(sourceRef.plan_id_digest);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic original text", "synthetic edited text"]) {
      expect(serializedInput).not.toContain(forbidden);
    }

    const invalidRequest = createGatewayInternalInboundRequest({ ...computeRequest, id: randomUUID(),
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ ...sourceRef, step_id_digest: "f".repeat(64) }] })}`, timestamp: Date.now() });
    const invalid = c.hds.decide(invalidRequest);
    expect(invalid.command?.type).not.toBe("llm_call");
    expect(invalid.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_step_mismatch");

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toMatchObject([{ source: "verified_file_edit_result",
      operation: "file.edit", task_identity_digest: expectedTaskIdentityDigest,
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false }]);
    const retainedJson = JSON.stringify(retained?.compute_source_observations);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic original text", "synthetic edited text"]) {
      expect(retainedJson).not.toContain(forbidden);
    }
  }, fileEditCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic original text\n")));

  it("明示選択されたfile.write履歴はdigestだけを後続plan:computeへ渡し、候補保持前にも再照合する", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);

    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    const destinationRequestId = randomUUID();
    const task = "Plan a safe follow-up from a selected historical action report; require fresh observation before claiming current file state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding, source_observation_refs: [sourceRef] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected observation was not routed to C: ${compute.log.commit.reason}`);
    const context = compute.command.payload.compute_context;
    expect(context?.data_exposure.input_sources).toContain("selected_operation_result_observations");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(expectedTaskIdentityDigest);
    expect(serializedInput).toContain(sourceRef.plan_id_digest);
    expect(serializedInput).not.toContain(c.workspace);
    expect(serializedInput).not.toContain("notes.txt");
    expect(serializedInput).not.toContain("synthetic planned file content");

    const invalidRequest = createGatewayInternalInboundRequest({ ...computeRequest, id: randomUUID(),
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ ...sourceRef, step_id_digest: "f".repeat(64) }] })}`, timestamp: Date.now() });
    const invalid = c.hds.decide(invalidRequest);
    expect(invalid.command?.type).not.toBe("llm_call");
    expect(invalid.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_step_mismatch");

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toHaveLength(1);
    expect(retained?.compute_source_observations?.[0]).toMatchObject({ source: "verified_file_write_result",
      operation: "file.write", task_identity_digest: expectedTaskIdentityDigest,
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const publicProjection = projectOperationPlanStatus(c.hds.getRuntimeSnapshot().operation_plans);
    expect(publicProjection.status).toBe("available");
    expect(publicProjection.plans.find((entry) => entry.plan_id === operationPlanDigest(nextCandidate.plan_id))
      ?.compute_source_observations).toEqual(retained?.compute_source_observations);
    const safeObservation = JSON.stringify(retained?.compute_source_observations);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic planned file content", "sandbox_root", "target"]) {
      expect(safeObservation).not.toContain(forbidden);
    }
  }, fileWriteCandidate));

  it("明示選択されたfile.delete履歴を現在J/M照合後に非権威入力として後続plan:computeへ渡す", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(feedback.result).toEqual({ deleted: true });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    expect(c.hds.reconcileOperationPlanMemory()).toBe(true);
    c.purposeBinding = installTestPurpose(c.hds);

    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    const destinationRequestId = randomUUID();
    const task = "Use the selected historical deletion report as context; require fresh observation before claiming current file state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding, source_observation_refs: [sourceRef] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected delete observation was not routed to C: ${compute.log.commit.reason}`);
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    expect(compute.command.payload.compute_context?.local_p_version)
      .toBe("blue-tanuki.plan-compute-source-observations.v5");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("verified_file_delete_result");
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(expectedTaskIdentityDigest);
    expect(serializedInput).toContain(sourceRef.plan_id_digest);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic delete target"]) {
      expect(serializedInput).not.toContain(forbidden);
    }

    const invalidRequest = createGatewayInternalInboundRequest({ ...computeRequest, id: randomUUID(),
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ ...sourceRef, step_id_digest: "f".repeat(64) }] })}`, timestamp: Date.now() });
    const invalid = c.hds.decide(invalidRequest);
    expect(invalid.command?.type).not.toBe("llm_call");
    expect(invalid.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_step_mismatch");

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toHaveLength(1);
    expect(retained?.compute_source_observations?.[0]).toMatchObject({ source: "verified_file_delete_result",
      operation: "file.delete", task_identity_digest: expectedTaskIdentityDigest,
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const safeObservation = JSON.stringify(retained?.compute_source_observations);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic delete target", "sandbox_root", "target"]) {
      expect(safeObservation).not.toContain(forbidden);
    }
  }, fileDeleteCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic delete target\n")));

  it("有効期限内のJ/M照合済みfile.search要約だけを後続plan:computeへ渡す", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceResult = sourceCheckpoint.results[0]!;
    expect(sourceResult.operation).toBe("file.search");
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);

    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const task = "Plan a follow-up from a selected, bounded search observation; do not claim complete coverage.";
    const makeComputeRequest = (requestId: string) => createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat",
      user: "fixture-owner", content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [sourceRef] })}`, timestamp: Date.now(), metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": requestId,
      } });

    const destinationRequestId = randomUUID();
    const compute = c.hds.decide(makeComputeRequest(destinationRequestId));
    if (compute.command?.type !== "llm_call") throw new Error(`selected search observation was not routed to C: ${compute.log.commit.reason}`);
    expect(compute.command.payload.compute_context?.local_p_version).toBe("blue-tanuki.plan-compute-source-observations.v5");
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    const observationMessage = compute.command.payload.messages.find((message) =>
      message.role === "system" && message.content.includes("verified_file_search_result"));
    expect(observationMessage).toBeDefined();
    const observationPayload = JSON.parse(observationMessage!.content.slice(observationMessage!.content.indexOf("\n") + 1)) as {
      observations: Array<Record<string, unknown>>;
    };
    expect(observationPayload.observations).toHaveLength(1);
    expect(observationPayload.observations[0]).toMatchObject({ source: "verified_file_search_result",
      operation: "file.search", task_identity_digest: expectedTaskIdentityDigest,
      plan_binding_status: "verified", plan_validation_status: "matched",
      effect_observation: "reported_success", match_count: 1, visited_files: 1,
      expires_at_ms: sourceResult.expires_at_ms, search_completeness: "unknown",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const serializedInput = compute.command.payload.messages.map((message) => message.content).join("\n");
    for (const privateValue of [c.workspace, "blue.txt", '"line_number"', '"sandbox_root"']) {
      expect(serializedInput).not.toContain(privateValue);
    }

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toEqual(observationPayload.observations);

    const secondRequestId = randomUUID();
    const secondCompute = c.hds.decide(makeComputeRequest(secondRequestId));
    if (secondCompute.command?.type !== "llm_call") throw new Error("fresh search observation was not reusable before expiry");
    const expiredCandidate = fileWriteCandidate(secondRequestId, c.workspace);
    const now = vi.spyOn(Date, "now").mockReturnValue(sourceResult.expires_at_ms);
    c.hds.onFeedback({ command_id: secondCompute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: expiredCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans.some((entry) =>
      entry.plan_id === operationPlanDigest(expiredCandidate.plan_id))).toBe(false);

    const expired = c.hds.decide(makeComputeRequest(randomUUID()));
    expect(expired.command?.type).not.toBe("llm_call");
    expect(expired.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_expired");
    now.mockRestore();
  }));

  it("file.writeの応答が計画のresult_equals条件に合わない場合はMへ昇格しない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic planned file content\n");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    const binding = c.j.load()!.plans[0]!.bindings[0]!;
    expect(binding.status).toBe("verification_failed");
    expect(binding.memory_receipt).toBeUndefined();
    expect(c.j.load()!.plans[0]!.results).toHaveLength(0);
    expect(inspectMemory(c)).toMatchObject({ revision: 0, records: [], receipts: [] });
    expect(c.execution.pendingResults()).toHaveLength(0);
  }, (id, root) => fileWriteCandidate(id, root, 1)));

  it("J/M restore hold clears only at a fresh review after digest-exact dependencies are verified", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id,
      target_surface: "channel" });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
    expect(c.j.load()?.plans[0]?.bindings[0]?.memory_receipt).toBeDefined();

    const staleSelection = review(c.hds, c.plan, "dependent")!;
    const restoreCommand = canonicalMemoryRestoreCommand();
    expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
    expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
    expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
    expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);

    const observation = (command: ExecuteCommand) => ({
      status: "matched" as const,
      operation: "restore" as const,
      store_key: "m_state" as const,
      command_id_digest: recoveryCommandIdDigest(command.id),
      operation_digest: createHash("sha256").update("restore-operation").digest("hex"),
      result_digest: createHash("sha256").update("restore-result").digest("hex"),
      restore_backup_id_digest: createHash("sha256").update("restore-backup").digest("hex"),
      restored_state_digest: createHash("sha256").update("restored-state").digest("hex"),
      store_ledger_status: "verified" as const,
      store_ledger_residual_count: 0 as const,
    });
    const unrelatedRestore = canonicalMemoryRestoreCommand();
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(unrelatedRestore, observation(unrelatedRestore))).toBe(false);
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation(restoreCommand))).toBe(true);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });

    const currentPlan = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const staleReview = c.hds.decide(request(`plan:review ${JSON.stringify({ plan_id: currentPlan.plan_id,
      revision_digest: "f".repeat(64), step_id: operationPlanDigest("dependent") })}`));
    expect(staleReview.command).toBeNull();
    expect(staleReview.log.commit.reason).toBe("plan_control_denied:plan_revision_changed");
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });

    const freshSelection = review(c.hds, c.plan, "dependent")!;
    expect(freshSelection.type).toBe("tool_call");
    expect(freshSelection.id).not.toBe(staleSelection.id);
    expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
    expect(c.hds.getAudit().verify()).toBe(true);
  }));

  it("J/M receipt-backed plan hold survives a closed-store restart and releases only at a fresh review", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-result-reconcile-jm-process-restart-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "blue.txt"), "blue\n");
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const c = await setup(root, workspace);
    let originalJOpen = true;
    let restartedJ: OperationPlanStateStore | undefined;
    try {
      expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
      const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
      expect(feedback.status).toBe("success");
      finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id,
        target_surface: "channel" });
      expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
      expect(c.j.load()?.plans[0]?.bindings[0]?.memory_receipt).toBeDefined();

      const staleSelection = review(c.hds, c.plan, "dependent")!;
      const restoreCommand = canonicalMemoryRestoreCommand();
      expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
      expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
      expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
      expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);
      const observation = {
        status: "matched" as const,
        operation: "restore" as const,
        store_key: "m_state" as const,
        command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
        operation_digest: createHash("sha256").update("restart-restore-operation").digest("hex"),
        result_digest: createHash("sha256").update("restart-restore-result").digest("hex"),
        restore_backup_id_digest: createHash("sha256").update("restart-restore-backup").digest("hex"),
        restored_state_digest: createHash("sha256").update("restart-restored-state").digest("hex"),
        store_ledger_status: "verified" as const,
        store_ledger_residual_count: 0 as const,
      };
      expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation)).toBe(true);
      const checkpointBeforeRestart = c.j.load();
      const holdBeforeRestart = c.j.loadRecoveryHoldState();
      if (!checkpointBeforeRestart) throw new Error("missing restart checkpoint fixture");
      expect(holdBeforeRestart).toMatchObject({
        used_for_authority: false,
        may_execute: false,
        holds: [{ provenance: { source: "recovery_restore", restore_store_key: "m_state",
          checkpoint_digest: expect.any(String) } }],
      });
      expect(inspectMemory(c).receipts).toHaveLength(1);

      c.hds.closeOperationPlanMemory();
      c.controllers.splice(0, c.controllers.length);
      c.j.close();
      originalJOpen = false;
      restartedJ = new OperationPlanStateStore(c.jPath);
      const startupEvidence = operationPlanRecoveryEvidenceFromObservation({
        observation: {
          status: "matched", operation: "restore", store_key: "m_state",
          operation_digest: observation.operation_digest, result_digest: observation.result_digest,
          command_id_digest: observation.command_id_digest, restored_state_digest: observation.restored_state_digest,
          store_ledger_status: "verified", store_ledger_residual_count: 0,
          plan_residuals: null, restore_backup_id_digest: observation.restore_backup_id_digest,
          restore_scope_plan_digest: null, plan_restore_points: null, configuration_state: "not_observed",
          evidence_source: "COMPLETE_HISTORY", used_for_authority: false, may_execute: false,
        },
        checkpoint: checkpointBeforeRestart,
        history_complete: true,
      });
      const restarted = new HDSUpperController({ operation_plan_state: restartedJ, operation_plan_memory: c.memory,
        operation_plan_recovery_evidence: startupEvidence, memory: c.oldMemory });
      c.controllers.push(restarted);

      expect(restartedJ.load()).toEqual(checkpointBeforeRestart);
      expect(restartedJ.loadRecoveryHoldState()).toMatchObject({
        used_for_authority: false,
        may_execute: false,
        holds: [{ reason: "held_unverified", provenance: {
          command_id_digest: recoveryCommandIdDigest(restoreCommand.id), restore_store_key: "m_state",
          checkpoint_digest: operationPlanDigest(checkpointBeforeRestart),
        } }],
      });
      expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
      expect(restarted.beginOperationPlanAttempt(staleSelection)).toBe(false);
      expect(review(restarted, c.plan, "dependent")?.type).toBe("tool_call");
      expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
      expect(restartedJ.loadRecoveryHoldState()).toMatchObject({ holds: [] });
      expect(inspectMemory(c).receipts).toHaveLength(1);
      expect(restarted.getAudit().verify()).toBe(true);
    } finally {
      for (const controller of c.controllers) controller.closeOperationPlanMemory();
      restartedJ?.close();
      if (originalJOpen) c.j.close();
      c.execution.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("J/M restore permits a fresh review when an unexecuted plan has no J/M result dependency", async () => fixture(async (c) => {
    const staleSelection = c.cmd;
    const restoreCommand = canonicalMemoryRestoreCommand();
    expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
    expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
    expect(c.hds.beginOperationPlanAttempt(staleSelection, c.admission)).toBe(false);
    expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);

    const observation = {
      status: "matched" as const,
      operation: "restore" as const,
      store_key: "m_state" as const,
      command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
      operation_digest: createHash("sha256").update("no-dependency-restore-operation").digest("hex"),
      result_digest: createHash("sha256").update("no-dependency-restore-result").digest("hex"),
      restore_backup_id_digest: createHash("sha256").update("no-dependency-restore-backup").digest("hex"),
      restored_state_digest: createHash("sha256").update("no-dependency-restored-state").digest("hex"),
      store_ledger_status: "verified" as const,
      store_ledger_residual_count: 0 as const,
    };
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation)).toBe(true);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });

    const freshSelection = review(c.hds, c.plan, "search")!;
    expect(freshSelection.type).toBe("tool_call");
    expect(freshSelection.id).not.toBe(staleSelection.id);
    expect(c.hds.beginOperationPlanAttempt(staleSelection, c.admission)).toBe(false);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
  }));

  it("J commit後ack前の中断は同結果再送で回復し、ID差替えを拒否して結果を二重追加しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    const saved = c.execution.pendingResults()[0]!;
    const ack = vi.spyOn(c.execution, "acknowledgeResult").mockImplementationOnce(() => { throw new Error("fixture lost ack"); });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 });
    expect(c.j.load()?.plans[0]?.results).toHaveLength(1); expect(c.execution.pendingResults()).toHaveLength(1);
    ack.mockRestore();
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const checkpoint = c.j.load()!;
    expect(restarted.reconcileOperationPlanResult(saved.delivery, saved.delivery_digest)).toBe(true);
    expect(c.j.load()).toEqual(checkpoint); expect(checkpoint.plans[0]?.results).toHaveLength(1);
    const changed = structuredClone(saved.delivery); changed.feedback.result!.matches[0]!.line = "forged";
    expect(() => restarted.reconcileOperationPlanResult(changed, hash(changed))).toThrow("plan_delivery_identity_conflict");
    const foreign = structuredClone(saved.delivery); foreign.admission.execution_epoch = randomUUID();
    expect(() => restarted.reconcileOperationPlanResult(foreign, hash(foreign))).toThrow("plan_delivery_admission_mismatch");
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("配送時刻で鮮度を更新せず、旧revisionの結果へ帰属させる", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    const revised = structuredClone(c.plan); revised.steps[1]!.parameters!.max_results = 2;
    c.hds.decide(request(`plan:revise ${JSON.stringify({ plan_id: c.plan.plan_id, expected_revision_digest: operationPlanDigest(c.plan), plan: revised })}`));
    const now = feedback.operation_core_result!.observed_at_ms + 600_001;
    vi.spyOn(Date, "now").mockReturnValue(now);
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution, c.admission.execution_epoch).adopted).toBe(1);
    expect(review(restarted, revised, "dependent")).toBeNull();
    const state = c.j.load()!.plans[0]!;
    expect(state.bindings[0]?.revision_digest).toBe(operationPlanDigest(c.plan));
    expect(state.results[0]?.expires_at_ms).toBe(feedback.operation_core_result!.observed_at_ms + 600_000);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("admissionが無い・まだ開始されていないJ bindingを保存結果から権限化しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd); await c.executor.execute(c.approved, { save_result_delivery: true });
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 });
    expect(c.j.load()?.plans[0]?.results).toHaveLength(0); expect(c.execution.pendingResults()).toHaveLength(1);
    expect(review(restarted, c.plan, "search")).toBeNull(); expect(c.invoke).toHaveBeenCalledTimes(1);
    expect(() => executionAdmissionForCommand({ ...c.cmd, id: randomUUID() }, c.authority.receipt(c.approved))).toThrow();
  }));

  it("未呼出し結果も配送し、検証成功へ変換せず同ticketの再作用を防ぐ", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true, before_tool_dispatch: () => { throw new Error("fixture stop"); } });
    expect(feedback.operation_core_result?.action_outcome).toBe("not_attempted");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    expect(c.j.load()?.plans[0]?.bindings[0]?.status).toBe("not_attempted"); expect(c.j.load()?.plans[0]?.results).toHaveLength(0);
    expect(review(c.hds, c.plan, "dependent")).toBeNull(); expect((await c.executor.execute(c.approved)).error).toMatch(/already consumed/);
  }));

  it("呼出し後の不明結果をdigestだけMへ記録し、成功・反省・再作用へ昇格させない", async () => fixture(async (c) => {
    const privateFailure = "synthetic response lost after dispatch";
    c.invoke.mockImplementationOnce(async (workerRequest) => {
      const identity = { worker_id: randomUUID(), worker_pid: process.pid,
        worker_platform: process.platform, worker_started_at_ms: Date.now() };
      workerRequest.on_started(identity);
      workerRequest.before_dispatch();
      workerRequest.on_exit(identity, Date.now());
      throw new Error(privateFailure);
    });
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("failed");
    expect(feedback.operation_core_result).toMatchObject({ action_outcome: "unknown", execution_boundary: "tool_adapter" });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const saved = c.execution.lookup(c.admission.ticket_id)!;
    const checkpoint = c.j.load()!.plans[0]!;
    expect(checkpoint.bindings[0]).toMatchObject({ status: "outcome_unknown", delivery_digest: saved.result_delivery_digest });
    expect(checkpoint.results).toHaveLength(0);
    expect(checkpoint.bindings[0]?.memory_receipt).toBeDefined();
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1); expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-outcome.v1", record_type: "action_outcome_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.search", delivery_digest: saved.result_delivery_digest,
      result_digest: checkpoint.bindings[0]?.result_digest, plan_binding_status: "outcome_unknown",
      effect_observation: "unknown", adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(observation)).not.toContain(privateFailure);
    expect(review(c.hds, c.plan, "dependent")).toBeNull();
    expect((await c.executor.execute(c.approved)).error).toMatch(/already consumed/);
    expect(c.invoke).toHaveBeenCalledTimes(1);
    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    expect(restarted.reconcileOperationPlanMemory()).toBe(true);
    expect(inspectMemory(c)).toEqual(memory);
    expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
    expect(review(restarted, c.plan, "dependent")).toBeNull();
  }));

  it("outbox挿入後のreceipt保存故障を同じ取引でrollbackし、実結果を成功へ昇格しない", async () => fixture(async (c) => {
    const db = new DatabaseSync(c.executionPath);
    db.exec(`CREATE TRIGGER fixture_result_failure BEFORE UPDATE ON execution_intents
      WHEN json_extract(NEW.receipt_json,'$.result_delivery_digest') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;`);
    try {
      c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
      const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
      expect(feedback.status).toBe("failed"); expect(feedback.error).toMatch(/receipt persistence failed/);
      expect(c.execution.pendingResults()).toHaveLength(0); expect(c.execution.verifyEvents()).toBe(true);
      expect(c.execution.snapshot().records[0]?.state).toBe("outcome_unknown");
      expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 0, stale_generation_archived: 0 });
      expect(c.j.load()?.plans[0]?.results).toHaveLength(0); expect(c.invoke).toHaveBeenCalledTimes(1);
      expect((await c.executor.execute(c.approved)).error).toMatch(/already consumed/);
    } finally { db.close(); }
  }));

  it("私有outboxの本文改変と候補consumer追加を拒否する", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    const saved = c.execution.pendingResults()[0]!;
    const augmented = { ...saved.delivery, feedback: { ...saved.delivery.feedback, meaning_update_proposal: {} } };
    expect(() => c.hds.reconcileOperationPlanResult(augmented, hash(augmented))).toThrow();
    const db = new DatabaseSync(c.executionPath);
    try {
      db.prepare("UPDATE execution_result_outbox SET delivery_json=? WHERE ticket_id=?").run('{}', c.admission.ticket_id);
      expect(c.execution.verifyEvents()).toBe(false);
      expect(() => c.execution.pendingResults()).toThrow("execution_event_integrity_failed");
      expect(() => c.execution.acknowledgeResult(c.admission.ticket_id, saved.delivery_digest)).toThrow("execution_event_integrity_failed");
      expect(c.j.load()?.plans[0]?.results).toHaveLength(0);
    } finally { db.close(); }
  }));

  it("実観測だけをMへ一度保存し、別DBの同receiptと元出力を読取照合して後続へ戻る", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const before = inspectMemory(c); expect(before.revision).toBe(1); expect(before.records).toHaveLength(1);
    const observation = before.records[0];
    expect(observation.adoption_status).toBe("observation_only"); expect(observation.used_as_world_truth).toBe(false);
    expect(observation.used_for_authority).toBe(false); expect(observation.may_execute).toBe(false);
    expect(observation.result.request_id).toBe(c.plan.request_id);
    expect(observation.step_review_request_id).toBe(c.cmd.upstream_decision.request_id);
    expect(observation.result.request_id).not.toBe(observation.step_review_request_id);
    expect(observation.output_digest).toBe(feedback.operation_core_result!.output_digest);
    expect(observation.result.output).toEqual(feedback.result);
    expect(hash(observation.result.output)).not.toBe(observation.output_digest); // M canonical保存でキー順が変わる。
    const jDb = new DatabaseSync(c.memory.database_path);
    try { expect(jDb.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'm_*'").all()).toHaveLength(0); }
    finally { jDb.close(); }
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(restarted.reconcileOperationPlanMemory()).toBe(true); expect(inspectMemory(c)).toEqual(before);
    expect(review(restarted, c.plan, "dependent")?.type).toBe("tool_call");
    const projection = JSON.stringify(restarted.getRuntimeSnapshot().operation_plans);
    for (const raw of [c.workspace, '"matches"', '"memory_commit"', c.admission.ticket_id]) expect(projection).not.toContain(raw);

    const privateRoot = c.memory.private_state_root;
    const operationPlansDirectory = join(privateRoot, "operation-plans");
    const executionDirectory = join(privateRoot, "execution-intents");
    mkdirSync(operationPlansDirectory, { recursive: true }); mkdirSync(executionDirectory, { recursive: true });
    const inspectedPlanPath = join(operationPlansDirectory, "j-state.sqlite");
    const inspectedExecutionPath = join(executionDirectory, "executor.sqlite");
    copyFileSync(c.jPath, inspectedPlanPath); copyFileSync(c.executionPath, inspectedExecutionPath);
    const inspectedPaths = [c.memory.database_path, inspectedPlanPath, inspectedExecutionPath];
    const inspectedBefore = inspectedPaths.map((file) => readFileSync(file));
    const recovery = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: join(c.root, "state") });
    const memoryCorrelation = recovery.operation_plan_correlations.find((item) => item.memory_update_id_digest !== null);
    expect(memoryCorrelation).toMatchObject({ memory_correlation: "matched" });
    expect(memoryCorrelation?.memory_update_id_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(recovery.ledgers.operation_plans).toMatchObject({ status: "verified", unverified_memory_link_count: 0 });
    expect(recovery.operation_plan_residual_count).toBe(0);
    expect(recovery.used_for_authority).toBe(false); expect(recovery.may_execute).toBe(false);
    const mismatchedMemory = {
      ...recovery.ledgers.m,
      updates: recovery.ledgers.m.updates.map((update) => update.update_id_digest === memoryCorrelation?.memory_update_id_digest
        ? { ...update, content_digest: "f".repeat(64) }
        : update),
    };
    const mismatchCorrelation = correlateOperationPlanBindings(
      recovery.ledgers.operation_plans,
      recovery.ledgers.execution,
      recovery.ledgers.j,
      mismatchedMemory,
      recovery.ledgers.cron_events,
      [],
    ).find((item) => item.memory_update_id_digest !== null);
    expect(mismatchCorrelation?.memory_correlation).toBe("content_mismatch");
    const recoveryJson = JSON.stringify(recovery);
    const savedCommit = c.j.load()!.plans[0]!.bindings.find((binding) => binding.memory_commit)?.memory_commit!;
    for (const raw of [savedCommit.update_id, savedCommit.j_event_id, c.workspace, "blue.txt", '"matches"']) {
      expect(recoveryJson).not.toContain(raw);
    }
    expect(inspectedPaths.map((file) => readFileSync(file))).toEqual(inspectedBefore);

    const currentCheckpoint = c.j.load()!;
    const checkpointWithoutMemoryLink = structuredClone(currentCheckpoint);
    const resultBinding = checkpointWithoutMemoryLink.plans[0]!.bindings.find((binding) => binding.memory_commit)!;
    delete resultBinding.memory_commit; delete resultBinding.memory_receipt;
    c.j.compareAndSet(operationPlanDigest(currentCheckpoint), checkpointWithoutMemoryLink);
    expect(c.j.load()!.plans[0]!.bindings.find((binding) => binding.step_id === resultBinding.step_id)?.memory_commit).toBeUndefined();
    copyFileSync(c.jPath, inspectedPlanPath);
    const missingLinkBefore = [readFileSync(inspectedPlanPath), readFileSync(c.memory.database_path)];
    const missingLinkReport = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: join(c.root, "state") });
    expect(missingLinkReport.operation_plan_correlations.find((item) => item.plan_id_digest === memoryCorrelation?.plan_id_digest &&
      item.step_id_digest === memoryCorrelation.step_id_digest)?.memory_correlation)
      .toBe("missing_plan_memory_link");
    expect(missingLinkReport.operation_plan_residual_count).toBeGreaterThan(0);
    expect([readFileSync(inspectedPlanPath), readFileSync(c.memory.database_path)]).toEqual(missingLinkBefore);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it.each(["j_stage", "j_receipt", "checkpoint_receipt"])("%sの中断窓から保存済み同commitだけでM帰還を復旧する", async (window) => fixture(async (c) => {
    const path = window === "checkpoint_receipt" ? c.jPath : c.memory.database_path;
    const db = new DatabaseSync(path);
    if (window === "checkpoint_receipt") db.exec(`CREATE TRIGGER fixture_memory_failure BEFORE UPDATE ON operation_plan_state
      WHEN json_extract(NEW.checkpoint_json,'$.plans[0].bindings[0].memory_receipt') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture memory checkpoint failure'); END;`);
    else db.exec(`CREATE TRIGGER fixture_memory_failure BEFORE UPDATE ON j_state
      WHEN NEW.status='${window === "j_stage" ? "memory_commit_pending" : "ready"}'
      BEGIN SELECT RAISE(ABORT,'fixture memory receipt failure'); END;`);
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const saved = c.j.load()!.plans[0]!.bindings[0]!.memory_commit;
    expect(saved).toBeDefined(); expect(c.j.load()!.plans[0]!.bindings[0]!.memory_receipt).toBeUndefined();
    const before = inspectMemory(c);
    expect(before.revision).toBe(window === "j_stage" ? 0 : 1);
    expect(review(c.hds, c.plan, "dependent")).toBeNull(); expect(c.hds.operationPlanCommandIsCurrent(c.cmd)).toBe(false);
    c.hds.closeOperationPlanMemory(); db.exec("DROP TRIGGER fixture_memory_failure"); db.close();
    const restarted = c.createHds(); expect(restarted.reconcileOperationPlanMemory()).toBe(true);
    expect(c.j.load()!.plans[0]!.bindings[0]!.memory_commit).toEqual(saved);
    const after = inspectMemory(c); expect(after.revision).toBe(1); expect(after.records).toHaveLength(1);
    if (before.revision === 1) expect(after.receipts).toEqual(before.receipts);
    expect(review(restarted, c.plan, "dependent")?.type).toBe("tool_call"); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("保存J commitの権限化・任意変更を再起動時に拒否する", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch); c.hds.closeOperationPlanMemory();
    const previous = c.j.load()!; const changed = structuredClone(previous);
    const b = changed.plans[0]!.bindings[0]!; const commit = b.memory_commit!;
    (commit.changes[0] as { value: Record<string, unknown> }).value.used_for_authority = true;
    const { content_digest: _digest, ...content } = commit; commit.content_digest = memoryCommitContentDigest(content);
    delete b.memory_receipt; c.j.compareAndSet(operationPlanDigest(previous), changed);
    expect(() => c.createHds()).toThrow("plan_checkpoint_memory_mismatch"); expect(inspectMemory(c).revision).toBe(1);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("J保存読取不能で配送ackを保留し、復旧後の同内容確認だけでackする", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    const lost = vi.spyOn(c.execution, "acknowledgeResult").mockImplementationOnce(() => { throw new Error("fixture ack interrupted"); });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 }); lost.mockRestore();
    const before = inspectMemory(c);
    const unavailable = vi.spyOn(c.j, "load").mockImplementation(() => { throw new Error("fixture J unavailable"); });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 });
    expect(c.execution.pendingResults()).toHaveLength(1); unavailable.mockRestore();
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("片方だけ失われたJ/M DBを新規初期化して履歴の確定と扱わない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch); c.hds.closeOperationPlanMemory();
    rmSync(c.memory.database_path);
    expect(() => c.createHds()).toThrow(/schema_mismatch/); expect(inspectMemory(c).revision).toBe(1);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));
});

function reflect(c: Awaited<ReturnType<typeof setup>>, hds = c.hds, changes: Record<string, unknown> = {}) {
  const p = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
  return hds.decide(request(`plan:reflect ${JSON.stringify({ plan_id: p.plan_id, revision_digest: p.revision_digest,
    step_ids: [p.steps[0]!.step_id], question: "この観測で何が言えて、何が未確認か", ...changes })}`));
}
function reflectionExecutor(c: Awaited<ReturnType<typeof setup>>, mutate?: (response: LLMResponse) => LLMResponse) {
  const call = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    const projection = JSON.parse(req.messages[0]!.content.split("\n").at(-1)!);
    const response = { content: JSON.stringify({ schema_version: "operation-result-reflection-candidate.v1",
      projection_digest: operationPlanDigest(projection), citations: projection.citations.map((source: {record_id: string; record_digest: string}) => ({
        record_id: source.record_id, record_digest: source.record_digest,
        interpretation: "検索で1件の一致が報告された", uncertainty: "完全走査と現在の外界状態は未確認" })) }),
      model: "fixture", tokens_used: 0 };
    return mutate ? mutate(response) : response;
  });
  const llm = { name: "fixture", call };
  const history = { getMessages: vi.fn(async () => [{ role: "user" as const, content: "private-history-sentinel", timestamp: 1 }]),
    append: vi.fn(async () => {}), clear: vi.fn(async () => {}), size: async () => 1 };
  const executor = new Executor({ tools: new ToolRegistry(), approval_authority: c.authority,
    llm, compute: new LLMComputeAdapter(llm), session_store: history });
  return { executor, call, history };
}
async function recordActualObservation(c: Awaited<ReturnType<typeof setup>>) {
  expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
  expect((await c.executor.execute(c.approved, { save_result_delivery: true })).status).toBe("success");
  expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
}
describe("受領済みM実観測→有限C射影→表示前J照合", () => {
  it("実worker観測をraw/historyなしでCへ戻し、未採用解釈だけを表示する", async () => fixture(async (c) => {
    await recordActualObservation(c); const before = inspectMemory(c);
    const calls = { capture: c.oldMemory.capture.mock.calls.length, recent: c.oldMemory.recent.mock.calls.length };
    const decision = reflect(c); const command = decision.command!;
    expect(command.type).toBe("llm_call"); if (command.type !== "llm_call") throw new Error("expected reflection");
    expect(command.payload.session_id).toBeUndefined(); expect(command.payload.compute_context?.data_exposure.input_sources)
      .toEqual(["accepted_inbound_request", "selected_memory_references"]);
    expect(decision.log.memory_capture_suppressed_for).toBe("operation_result_reflection");
    expect(c.oldMemory.capture).toHaveBeenCalledTimes(calls.capture); expect(c.oldMemory.recent).toHaveBeenCalledTimes(calls.recent);
    const visible = JSON.stringify(command.payload);
    const planState = c.j.load()!.plans[0]!;
    expect(visible).toContain("operation-result-current-projection.v2");
    expect(command.payload.compute_context?.local_p_version).toBe("blue-tanuki.result-reflection.v2");
    expect(visible).toContain(planTaskIdentityDigest(planState.owner, planState.channel, planState.goal,
      c.plan.plan_id, c.plan.request_id));
    for (const raw of [c.workspace, "blue.txt", '"matches"', c.admission.ticket_id, c.cmd.id, c.plan.plan_id]) expect(visible).not.toContain(raw);
    expect(visible).toContain('completeness'); expect(visible).toContain('not_assessed');
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(true);
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    expect(feedback.status).toBe("success"); expect(runner.call).toHaveBeenCalledTimes(1);
    expect(runner.history.getMessages).not.toHaveBeenCalled(); expect(runner.history.append).not.toHaveBeenCalled();
    const result = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(result.reviewed_feedback.status).toBe("success");
    expect(result.rendered_output).toContain("references_verified_interpretation_unverified");
    expect(result.rendered_output).toContain('"memory_adoption": false'); expect(result.rendered_output).not.toContain(c.workspace);
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
  }));
  it("別owner/channel・重複step・未受領・旧版をCへfallbackせず拒否する", async () => fixture(async (c) => {
    expect(reflect(c).command).toBeNull(); await recordActualObservation(c);
    const p = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const content = `plan:reflect ${JSON.stringify({ plan_id: p.plan_id, revision_digest: p.revision_digest,
      step_ids: [p.steps[0]!.step_id], question: "観測を解釈" })}`;
    const outsider = createGatewayInternalInboundRequest({ ...request(content), user: "different-owner" });
    expect(c.hds.decide(outsider).command).toBeNull();
    const otherChannel = createGatewayInternalInboundRequest({ ...request(content), channel: "telegram" });
    expect(c.hds.decide(otherChannel).command).toBeNull();
    expect(c.hds.decide({ ...request(content) }).command).toBeNull(); // private brandはspreadで失われる。
    expect(reflect(c, c.hds, { step_ids: [p.steps[0]!.step_id, "search"] }).command).toBeNull();
    expect(reflect(c, c.hds, { revision_digest: "0".repeat(64) }).command).toBeNull();
  }));
  it("送信待機・返答待機中の計画改訂と再起動旧commandを拒否する", async () => fixture(async (c) => {
    await recordActualObservation(c); const decision = reflect(c); const command = decision.command!;
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    const altered = structuredClone(command); if (altered.type === "llm_call") altered.payload.compute_context!.local_p_version = "forged";
    expect(c.hds.operationPlanCommandIsCurrent(altered)).toBe(false);
    const changed = structuredClone(c.plan); changed.steps[1]!.parameters!.max_results = 2;
    const revised = c.hds.decide(request(`plan:revise ${JSON.stringify({ plan_id: c.plan.plan_id,
      expected_revision_digest: operationPlanDigest(c.plan), plan: changed })}`)); expect(revised.command?.type).toBe("noop");
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
    const output = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(output.reviewed_feedback.status).toBe("failed"); expect(output.rendered_output).not.toContain("検索で1件");
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(restarted.operationPlanCommandIsCurrent(command)).toBe(false); expect(reflect(c, restarted).command).toBeNull();
  }));
  it("参照しない別M観測の追加で同じ引用射影を全失効しない", async () => fixture(async (c) => {
    await recordActualObservation(c); const decision = reflect(c); const command = decision.command!;
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    const next = review(c.hds, c.plan, "dependent")!; const approved = await c.approve(next);
    const admission = executionAdmissionForCommand(next, c.authority.receipt(approved));
    expect(c.hds.beginOperationPlanAttempt(next, admission)).toBe(true);
    expect((await c.executor.execute(approved, { save_result_delivery: true })).status).toBe("success");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    expect(inspectMemory(c).revision).toBe(2); expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(true);
    const output = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(output.reviewed_feedback.status).toBe("success"); expect(c.invoke).toHaveBeenCalledTimes(2);
  }));
  it.each(["reference", "duplicate", "compute_request", "compute_output", "missing_compute", "tool", "meaning", "planner", "malformed_result", "failure"])("%sを成功・意味採用・作用へ変換しない", async (failure) => fixture(async (c) => {
    await recordActualObservation(c); const before = inspectMemory(c); const decision = reflect(c); const command = decision.command!;
    const runner = reflectionExecutor(c, (response) => {
      if (failure === "tool") return { ...response, tool_calls: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "x",
        tool_name: "file.search",
        arguments: {},
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }] };
      if (failure === "meaning") return { ...response, meaning_update_proposal: { private: true } };
      if (failure === "planner") return { ...response, content: JSON.stringify(c.plan) };
      const candidate = JSON.parse(response.content);
      if (failure === "reference") candidate.citations[0].record_digest = "0".repeat(64);
      if (failure === "duplicate") candidate.citations.push(candidate.citations[0]);
      return { ...response, content: JSON.stringify(candidate) };
    });
    const feedback = await runner.executor.execute(await c.approve(command));
    const value = feedback.result as Record<string, any>;
    if (failure === "compute_request") value.execution_identity.request_id = "other-command";
    if (failure === "compute_output") value.execution_identity.output_digest = "0".repeat(64);
    if (failure === "missing_compute") delete value.execution_identity;
      if (failure === "malformed_result") feedback.result = new Proxy({}, { ownKeys: () => { throw new Error("private provider metadata"); } });
    if (failure === "failure") { feedback.status = "failed"; feedback.error = "private-provider-error"; }
    const output = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(output.reviewed_feedback.status).toBe("failed"); expect(output.rendered_output).toContain("解釈候補を採用できません");
    expect(output.rendered_output).not.toContain("private-provider-error"); expect(output.rendered_output).not.toContain("private provider metadata");
    expect(output.output_audit.result_digest_status).toBe(failure === "malformed_result" ? "unavailable" : "recorded");
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));
  it("関連M破損・J読取不能・観測期限切れはC送信と返答を遮断する", async () => fixture(async (c) => {
    await recordActualObservation(c); const decision = reflect(c); const command = decision.command!;
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    const unreadable = vi.spyOn(c.j, "load").mockImplementation(() => { throw new Error("fixture read failure"); });
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false); unreadable.mockRestore();
    const observed = c.j.load()!.plans[0]!.results[0]!; const clock = vi.spyOn(Date, "now").mockReturnValue(observed.expires_at_ms);
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false); clock.mockRestore();
    const db = new DatabaseSync(c.memory.memory_database_path);
    try { db.exec("UPDATE m_records SET value_json='{}'"); } finally { db.close(); }
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
    expect(c.hds.reviewMemoryCitations(command, feedback).status).toBe("failed"); expect(reflect(c).command).toBeNull();
  }));
});
