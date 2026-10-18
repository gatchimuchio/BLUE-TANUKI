import { describe, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { HDSUpperController, evaluateApproval, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { Executor, ToolRegistry, createExecutorApprovalAuthority, fileSearchTool, LLMComputeAdapter, type LLMRequest, type LLMResponse } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, memoryCommitContentDigest, type ExecuteCommand, type OperationPlan, type InboundRequest } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { createFileSearchWorker } from "../src/file_search_worker.js";
import { executionAdmissionForCommand, reconcileExecutionResults, reconcileStartupExecutionState } from "../src/reconcile_execution_results.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";
import { operationResultMemoryStorage } from "../src/operation_result_memory_config.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
function request(content: string): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner", timestamp: Date.now(), content,
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
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
function review(hds: HDSUpperController, plan: OperationPlan, step_id: string) {
  const p = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
  return hds.decide(request(`plan:review ${JSON.stringify({ plan_id: plan.plan_id, revision_digest: p.revision_digest, step_id })}`)).command;
}
async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "blue-result-reconcile-")); const workspace = join(root, "workspace");
  mkdirSync(workspace); writeFileSync(join(workspace, "blue.txt"), "blue\n");
  vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
  const context = await setup(root, workspace);
  try { await run(context); } finally { for (const hds of context.controllers) hds.closeOperationPlanMemory(); context.execution.close(); context.j.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
}
async function setup(root: string, workspace: string) {
  const executionPath = join(root, "executor.sqlite"); const jPath = join(root, "j.sqlite");
  const execution = new GatewayExecutionIntentStore(executionPath); const j = new OperationPlanStateStore(jPath);
  const memory = operationResultMemoryStorage({ BLUE_TANUKI_STATE_ROOT: join(root, "state") });
  const controllers: HDSUpperController[] = [];
  const oldMemory = { capture: vi.fn(), recent: vi.fn(() => []), all: vi.fn(() => []) };
  function createHds(state = j) {
    const controller = new HDSUpperController({ operation_plan_state: state, operation_plan_memory: memory, memory: oldMemory });
    controllers.push(controller); return controller;
  }
  const hds = createHds(); const origin = request("plan:compute 合成の検索結果を後続stepへ渡す");
  const plan = candidate(origin.id, workspace); const tools = new ToolRegistry(); tools.register(fileSearchTool);
  const authority = createExecutorApprovalAuthority({ execution_store: execution });
  const actualWorker = createFileSearchWorker({ SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace });
  const invoke = vi.fn(actualWorker.invoke); const worker = { invoke };
  const executor = new Executor({ tools, approval_authority: authority, file_search_worker: worker,
    llm: { name: "fixture", call: async () => ({ content: JSON.stringify(plan), model: "fixture", tokens_used: 0 }) } });
  function approve(cmd: ExecuteCommand) {
    const a = evaluateApproval(cmd, [], { actor: "fixture-owner", default_mode: "full_access" });
    return authority.approve(cmd, { source: a.final_review_required ? "human_final_review" : "approval_gate", decision: "allow",
      approved_by: "fixture-owner", approved_at_ms: Date.now(), upstream_commit_hash: cmd.upstream_decision.commit_hash,
      operation: a.context.operation, risk: a.risk, final_review_required: a.final_review_required, reason: "fixture" });
  }
  const initial = hds.decide(origin).command!; const first = await executor.execute(approve(initial));
  finalizeCommandOutput({ hds, command: initial, feedback: first, request_id: origin.id, target_surface: "channel" });
  const cmd = review(hds, plan, "search")!; const approved = approve(cmd);
  const admission = executionAdmissionForCommand(cmd, authority.receipt(approved));
  return { root, workspace, executionPath, jPath, execution, j, hds, plan, cmd, approved, admission, authority, executor, invoke, memory, controllers, createHds, approve, oldMemory };
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
    const reopened = new GatewayExecutionIntentStore(c.executionPath); const j = new OperationPlanStateStore(c.jPath);
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
    for (const raw of [c.workspace, "blue.txt", '"matches"', c.admission.ticket_id, c.cmd.id, c.plan.plan_id]) expect(visible).not.toContain(raw);
    expect(visible).toContain('completeness'); expect(visible).toContain('not_assessed');
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(true);
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(c.approve(command));
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
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(c.approve(command));
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
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(c.approve(command));
    const next = review(c.hds, c.plan, "dependent")!; const approved = c.approve(next);
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
    const feedback = await runner.executor.execute(c.approve(command));
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
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(c.approve(command));
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
