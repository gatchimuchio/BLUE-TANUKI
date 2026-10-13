import { describe, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { HDSUpperController, evaluateApproval, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { Executor, ToolRegistry, createExecutorApprovalAuthority, fileSearchTool } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, memoryCommitContentDigest, type ExecuteCommand, type OperationPlan, type InboundRequest } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { createFileSearchWorker } from "../src/file_search_worker.js";
import { executionAdmissionForCommand, reconcileExecutionResults } from "../src/reconcile_execution_results.js";
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
  function createHds(state = j) {
    const controller = new HDSUpperController({ operation_plan_state: state, operation_plan_memory: memory });
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
  return { root, workspace, executionPath, jPath, execution, j, hds, plan, cmd, approved, admission, authority, executor, invoke, memory, controllers, createHds };
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
      expect(reconcileExecutionResults(hds, reopened)).toEqual({ adopted: 1, deferred: 0 });
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
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 0, deferred: 1 });
    expect(c.j.load()?.plans[0]?.results).toHaveLength(1); expect(c.execution.pendingResults()).toHaveLength(1);
    ack.mockRestore();
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution)).toEqual({ adopted: 1, deferred: 0 });
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
    expect(reconcileExecutionResults(restarted, c.execution).adopted).toBe(1);
    expect(review(restarted, revised, "dependent")).toBeNull();
    const state = c.j.load()!.plans[0]!;
    expect(state.bindings[0]?.revision_digest).toBe(operationPlanDigest(c.plan));
    expect(state.results[0]?.expires_at_ms).toBe(feedback.operation_core_result!.observed_at_ms + 600_000);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("admissionが無い・まだ開始されていないJ bindingを保存結果から権限化しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd); await c.executor.execute(c.approved, { save_result_delivery: true });
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution)).toEqual({ adopted: 0, deferred: 1 });
    expect(c.j.load()?.plans[0]?.results).toHaveLength(0); expect(c.execution.pendingResults()).toHaveLength(1);
    expect(review(restarted, c.plan, "search")).toBeNull(); expect(c.invoke).toHaveBeenCalledTimes(1);
    expect(() => executionAdmissionForCommand({ ...c.cmd, id: randomUUID() }, c.authority.receipt(c.approved))).toThrow();
  }));

  it("未呼出し結果も配送し、検証成功へ変換せず同ticketの再作用を防ぐ", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true, before_tool_dispatch: () => { throw new Error("fixture stop"); } });
    expect(feedback.operation_core_result?.action_outcome).toBe("not_attempted");
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 1, deferred: 0 });
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
      expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 0, deferred: 0 });
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
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 1, deferred: 0 });
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
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 1, deferred: 0 });
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
    reconcileExecutionResults(c.hds, c.execution); c.hds.closeOperationPlanMemory();
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
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 0, deferred: 1 }); lost.mockRestore();
    const before = inspectMemory(c);
    const unavailable = vi.spyOn(c.j, "load").mockImplementation(() => { throw new Error("fixture J unavailable"); });
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 0, deferred: 1 });
    expect(c.execution.pendingResults()).toHaveLength(1); unavailable.mockRestore();
    expect(reconcileExecutionResults(c.hds, c.execution)).toEqual({ adopted: 1, deferred: 0 });
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("片方だけ失われたJ/M DBを新規初期化して履歴の確定と扱わない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    reconcileExecutionResults(c.hds, c.execution); c.hds.closeOperationPlanMemory();
    rmSync(c.memory.database_path);
    expect(() => c.createHds()).toThrow(/schema_mismatch/); expect(inspectMemory(c).revision).toBe(1);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));
});
