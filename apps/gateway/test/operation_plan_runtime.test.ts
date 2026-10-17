import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { HDSUpperController, evaluateApproval, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { Executor, createExecutorApprovalAuthority, ToolRegistry, fileSearchTool } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, OperationPlanCheckpointSchema, type ExecuteCommand, type OperationParameters, type OperationPlan, type OperationStep, type InboundRequest } from "@blue-tanuki/protocol";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function request(content: string, user = "fixture-owner"): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user, timestamp: Date.now(), content,
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
}
function plan(id: string, root: string): OperationPlan {
  const target = { kind: "directory" as const, id: root };
  const result = { root, sandbox_root: root, query: "blue", visited_files: 1,
    matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
  const step = (step_id: string): OperationStep => ({ step_id, operation: "file.search", target, state: "planned" as const,
    effects: ["read" as const], permission: { risk: "low" as const, approval_level: "L1_observe" as const,
      final_review_required: false, hds_brain_authority_required: true as const, approval_gate_required: true },
    adapter: "internal_runtime" as const, adapter_is_authority: false as const, command_generated_by_adapter_only: false,
    parameters: { root, query: "blue", max_results: 1 },
    preparation: { depends_on: [], bindings: [],
      preconditions: [], validation: [{ check_id: `check-${step_id}`, method: "result_equals" as const, target, expected: result }],
      compensation: { available: false as const, reason: "read-only" } } });
  const first = step("search"); const dependent = step("dependent"); const independent = step("independent");
  dependent.preparation!.depends_on = ["search"];
  dependent.preparation!.bindings = [{ source_step_id: "search", output_path: ["matches", "0", "line"], field: "parameters", path: ["query"] }];
  dependent.parameters!.query = "${search.line}";
  return { version: "operation-core.v1", plan_id: `plan-${id}`, request_id: id, state: "planned", steps: [first, dependent, independent],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function gmailSendPlan(id: string, parameters: OperationParameters): OperationPlan {
  const target = { kind: "external_service" as const, id: "gmail" };
  return { version: "operation-core.v1", plan_id: `gmail-plan-${id}`, request_id: id, state: "planned",
    steps: [{ step_id: "send", operation: "gmail.write", target, state: "planned",
      effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api", adapter_is_authority: false, command_generated_by_adapter_only: false, parameters,
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "send-accepted", method: "result_equals", target, expected: { mutation_status: "confirmed" } }],
        compensation: { available: false, reason: "external send cannot be recalled" } } }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function rig(hds: HDSUpperController, candidate: OperationPlan, tool = fileSearchTool) {
  const tools = new ToolRegistry(); tools.register(tool);
  const authority = createExecutorApprovalAuthority();
  const executor = new Executor({ llm: { name: "fixture", call: async () => ({ content: JSON.stringify(candidate), model: "fixture", tokens_used: 0 }) },
    tools, approval_authority: authority });
  async function run(command: ExecuteCommand, begin = true) {
    const approval = evaluateApproval(command, [], { actor: "fixture-owner", default_mode: "full_access" });
    const approved = authority.approve(command, { source: approval.final_review_required ? "human_final_review" : "approval_gate",
      decision: "allow", approved_by: "fixture-owner", approved_at_ms: Date.now(), upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required, reason: "fixture" });
    if (begin) expect(hds.beginOperationPlanAttempt(command)).toBe(true);
    const feedback = await executor.execute(approved);
    finalizeCommandOutput({ hds, command, feedback, request_id: command.upstream_decision.request_id ?? null, target_surface: "channel" });
    return feedback;
  }
  return { run };
}
function review(hds: HDSUpperController, candidate: OperationPlan, step_id: string) {
  const current = hds.getRuntimeSnapshot().operation_plans.plans.find((p) => p.plan_id === operationPlanDigest(candidate.plan_id))!;
  return hds.decide(request(`plan:review ${JSON.stringify({ plan_id: current.plan_id, revision_digest: current.revision_digest, step_id: operationPlanDigest(step_id) })}`));
}

describe("計画候補→明示step選択→実結果→改訂・復帰", () => {
  it("receipt配列を持たない旧checkpointをdigest検証後に既定値へ移行して読む", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-legacy-state-"));
    const filepath = join(root, "state.sqlite");
    const store = new OperationPlanStateStore(filepath);
    const candidate = plan("legacy", join(root, "workspace"));
    const legacy = {
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "legacy checkpoint",
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], bindings: [], results: [] }],
    };
    try {
      OperationPlanCheckpointSchema.parse(legacy);
      store.close();
      const db = new DatabaseSync(filepath);
      try {
        db.prepare("INSERT INTO operation_plan_state (id, checkpoint_json, digest) VALUES (1, ?, ?)")
          .run(JSON.stringify(legacy), operationPlanDigest(legacy));
      } finally { db.close(); }
      const restored = new OperationPlanStateStore(filepath);
      try { expect(restored.load()?.plans[0]?.receipt_observations).toEqual([]); }
      finally { restored.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("Gmail計画は宛先固定の単一message.sendだけをtool commandへ結ぶ", async () => {
    const safeHds = new HDSUpperController(); const safeOrigin = request("plan:compute synthetic send");
    const safe = gmailSendPlan(safeOrigin.id, { operation: "message.send", to: "inspection@example.invalid",
      subject: "synthetic", body_text: "fixture" });
    const safeExecutor = rig(safeHds, safe); await safeExecutor.run(safeHds.decide(safeOrigin).command!);
    const selected = review(safeHds, safe, "send");
    expect(selected.command?.type).toBe("tool_call");
    if (selected.command?.type !== "tool_call") throw new Error("bounded Gmail plan was not connected");
    expect(selected.command.payload).toMatchObject({ tool_name: "gmail.write", arguments: safe.steps[0]?.parameters });

    const unsafeHds = new HDSUpperController(); const unsafeOrigin = request("plan:compute multiple send targets");
    const unsafe = gmailSendPlan(unsafeOrigin.id, { operation: "message.send", to: "inspection@example.invalid",
      cc: "second@example.invalid", subject: "synthetic", body_text: "fixture" });
    const unsafeExecutor = rig(unsafeHds, unsafe); await unsafeExecutor.run(unsafeHds.decide(unsafeOrigin).command!);
    const rejected = review(unsafeHds, unsafe, "send");
    expect(rejected.command).toBeNull();
    expect(rejected.log.commit.decision).not.toBe("ASSERT");
  });

  it("実file.search結果を依存入力にし、変更pendingだけ失効して旧版と試行済みを保持", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-")); const workspace = join(root, "workspace");
    await mkdir(workspace); await writeFile(join(workspace, "blue.txt"), "blue\n");
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const origin = request("plan:compute 青という語を探して、その検索結果をもう一度照合");
      const candidate = plan(origin.id, workspace); const exec = rig(hds, candidate);
      const initial = hds.decide(origin); expect(initial.command?.type).toBe("llm_call");
      await exec.run(initial.command!);
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
      expect(review(hds, candidate, "dependent").command).toBeNull();
      const first = review(hds, candidate, "search").command!;
      const feedback = await exec.run(first);
      expect(feedback.operation_core_result?.plan_step_binding).toBe("unbound");
      expect(hds.beginOperationPlanAttempt(first)).toBe(false);
      expect(review(hds, candidate, "search").command).toBeNull();
      const dependent = review(hds, candidate, "dependent").command!;
      const independent = review(hds, candidate, "independent").command!;
      expect(dependent.type).toBe("tool_call");
      if (dependent.type !== "tool_call") throw new Error("missing tool");
      expect(dependent.payload.arguments.query).toBe("blue");
      const next = structuredClone(candidate); next.steps[2]!.parameters!.max_results = 2;
      const before = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
      const revised = hds.decide(request(`plan:revise ${JSON.stringify({ plan_id: candidate.plan_id,
        expected_revision_digest: before.revision_digest, plan: next })}`));
      expect(revised.command?.type).toBe("noop");
      expect((await exec.run(revised.command!)).status).toBe("success");
      expect(hds.operationPlanCommandIsCurrent(independent)).toBe(false);
      expect(hds.operationPlanCommandIsCurrent(dependent)).toBe(true);
      expect(hds.beginOperationPlanAttempt(independent)).toBe(false);
      await exec.run(dependent);
      const snapshot = hds.getRuntimeSnapshot().operation_plans;
      expect(snapshot.plans[0]?.revision).toBe(2);
      expect(snapshot.plans[0]?.previous_revision_digests).toEqual([operationPlanDigest(candidate)]);
      expect(snapshot.plans[0]?.steps[0]?.status).toBe("verified");
      expect(snapshot.plans[0]?.steps[1]?.status).toBe("verified");
      expect(JSON.stringify(snapshot)).not.toContain(workspace);
      expect(JSON.stringify(snapshot)).not.toContain('"goal"');
      expect(hds.getAudit().verify()).toBe(true);
      const restarted = new HDSUpperController({ operation_plan_state: store });
      expect(review(restarted, next, "search").command).toBeNull();
      const forbidden = structuredClone(next); forbidden.steps[0]!.parameters!.query = "changed";
      expect(restarted.decide(request(`plan:revise ${JSON.stringify({ plan_id: next.plan_id,
        expected_revision_digest: operationPlanDigest(next), plan: forbidden })}`)).command).toBeNull();
    } finally { store.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("壊れたcontrol・外部metadata・別接続の選択をC/作用へfallbackさせない", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture"); const candidate = plan(origin.id, "synthetic-root");
    const exec = rig(hds, candidate); await exec.run(hds.decide(origin).command!);
    for (const content of ["plan:review {", "plan:unknown {}", "plan:", "plan:revise {}", "PLAN:REVIEW {}"]) {
      expect(hds.decide(request(content)).command).toBeNull();
    }
    const content = `plan:review ${JSON.stringify({ plan_id: candidate.plan_id, revision_digest: operationPlanDigest(candidate), step_id: "search" })}`;
    const external = { ...request(content), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } };
    expect(hds.decide(external).command).toBeNull();
    expect(hds.decide(request(content, "other-user")).command).toBeNull();
    const forged = structuredClone(candidate); forged.steps[0]!.state = "succeeded";
    const unknownOrigin = request("plan:compute unknown"); const wrong = rig(hds, forged);
    await wrong.run(hds.decide(unknownOrigin).command!);
    expect(hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
  });

  it("SUSPENDした計画選択はresumeで未結合commandへ変わらない", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture"); const candidate = plan(origin.id, "synthetic-root");
    candidate.steps[0]!.parameters!.query = "rm -rf foo";
    const exec = rig(hds, candidate); await exec.run(hds.decide(origin).command!);
    const selection = review(hds, candidate, "search");
    expect(selection.log.commit.decision).toBe("SUSPEND");
    expect(hds.resume(selection.log.request_id, "approve").command).toBeNull();
    expect(hds.listSuspended().find((entry) => entry.request_id === selection.log.request_id)?.resume_allowed).toBe(false);
  });

  it("失敗・期限失効を依存の成功にせず、provider識別子を射影へ出さない", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture"); const candidate = plan(origin.id, "synthetic-root");
    candidate.plan_id = "private-provider-plan-body"; candidate.steps[2]!.step_id = "private-provider-step-body";
    const failing = { ...fileSearchTool, invoke: async () => { throw new Error("fixture failure"); } };
    const exec = rig(hds, candidate, failing); await exec.run(hds.decide(origin).command!);
    const failed = review(hds, candidate, "search").command!; await exec.run(failed);
    expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
    expect(review(hds, candidate, "search").command).toBeNull();
    expect(review(hds, candidate, "dependent").command).toBeNull();
    expect(JSON.stringify(hds.getRuntimeSnapshot().operation_plans)).not.toContain("private-provider");
    const origin2 = request("plan:compute freshness"); const fresh = plan(origin2.id, "synthetic-root");
    const success = { ...fileSearchTool, invoke: async () => (fresh.steps[0]!.preparation!.validation[0]!.expected) };
    const exec2 = rig(hds, fresh, success); await exec2.run(hds.decide(origin2).command!);
    await exec2.run(review(hds, fresh, "search").command!);
    const pending = review(hds, fresh, "dependent").command!;
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
    try { expect(hds.beginOperationPlanAttempt(pending)).toBe(false); }
    finally { clock.mockRestore(); }
  });

  it("内容差替え・crash窓・別writerを実行前に遮断", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-fence-")); const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store }); const origin = request("plan:compute fixture");
      const candidate = plan(origin.id, root); const exec = rig(hds, candidate);
      await exec.run(hds.decide(origin).command!);
      const selected = review(hds, candidate, "search").command!;
      if (selected.type !== "tool_call") throw new Error("missing tool");
      const originalId = selected.id; selected.id = "changed-id";
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      selected.id = originalId;
      selected.payload.arguments.query = "substituted";
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      selected.payload.arguments.query = "blue";
      const timeout = selected.constraints?.timeout_ms;
      selected.constraints = { ...selected.constraints, timeout_ms: 999_999 };
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      selected.constraints = { ...selected.constraints, timeout_ms: timeout };
      Object.freeze(selected.payload);
      expect(hds.beginOperationPlanAttempt(selected)).toBe(true);
      expect(() => { selected.payload.arguments.query = "after-begin"; }).toThrow();
      const restarted = new HDSUpperController({ operation_plan_state: store });
      expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
      expect(review(restarted, candidate, "search").command).toBeNull();
      const pending = review(restarted, candidate, "independent").command!;
      const staleWriter = new HDSUpperController({ operation_plan_state: store });
      expect(restarted.operationPlanCommandIsCurrent(pending)).toBe(true);
      expect(() => restarted.beginOperationPlanAttempt(pending)).toThrow("plan_checkpoint_concurrent_update");
      expect(staleWriter.getRuntimeSnapshot().operation_plans.plans[0]?.steps[2]?.status).toBe("invalidated");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
