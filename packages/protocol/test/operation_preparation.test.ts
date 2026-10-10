import { describe, expect, it } from "vitest";
import { prepareOperationPlan, type OperationPlan, type OperationPreparationContext, type OperationStepPreparation } from "../src/index.js";

function fixture(): { plan: OperationPlan; context: OperationPreparationContext } {
  const permission = { risk: "high", approval_level: "L3_final_review", final_review_required: true,
    hds_brain_authority_required: true, approval_gate_required: true } as const;
  const sourceTarget = { kind: "directory", id: "notes" } as const;
  const futureTarget = { kind: "file", id: "pending:file" } as const;
  const binding = (field: OperationStepPreparation["bindings"][number]["field"], path: string[], output: string) =>
    ({ source_step_id: "read", field, path, output_path: [output] });
  const plan: OperationPlan = {
    version: "operation-core.v1", plan_id: "plan-local", request_id: "request-local", state: "planned",
    steps: [
      { step_id: "read", operation: "file.search", target: sourceTarget, parameters: { root: "notes", query: "青" },
        effects: ["read"], state: "planned", permission, adapter: "internal_runtime",
        adapter_is_authority: false, command_generated_by_adapter_only: false,
        preparation: { depends_on: [], bindings: [], preconditions: [],
          validation: [{ check_id: "found", method: "result_equals", target: sourceTarget, expected: true }],
          compensation: { available: false, reason: "読取は変更しない" } } },
      { step_id: "edit", operation: "file.edit", target: futureTarget,
        parameters: { path: "pending:file", search: "青", replace: "藍" }, effects: ["read", "write"],
        state: "planned", permission, adapter: "internal_runtime", adapter_is_authority: false,
        command_generated_by_adapter_only: false,
        preparation: { depends_on: ["read"],
          bindings: [binding("target", ["id"], "path"), binding("parameters", ["path"], "path"),
            binding("preconditions", ["0", "target", "id"], "path"), binding("preconditions", ["0", "expected_revision"], "revision"),
            binding("validation", ["0", "target", "id"], "path"), binding("validation", ["0", "expected"], "after"),
            binding("compensation", ["action", "target", "id"], "path"),
            binding("compensation", ["action", "parameters", "path"], "path"),
            binding("compensation", ["action", "parameters", "content"], "before")],
          preconditions: [{ condition_id: "revision", target: futureTarget, expected_revision: "pending:revision" }],
          validation: [{ check_id: "edited", method: "result_equals", target: futureTarget, expected: "pending:after" }],
          compensation: { available: true, action: { operation: "file.write", target: futureTarget,
            parameters: { path: "pending:file", content: null }, effects: ["write"], permission,
            adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false } } } },
    ], rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true,
  };
  const context: OperationPreparationContext = {
    now_ms: 100,
    results: [{ plan_id: plan.plan_id, request_id: plan.request_id, step_id: "read", result_id: "result-read", operation: "file.search",
      status: "succeeded", target: { ...sourceTarget }, output: { path: "notes/blue.md", revision: "v2", before: "青", after: "藍" },
      observed_at_ms: 90, expires_at_ms: 120 }],
    observations: [{ plan_id: plan.plan_id, request_id: plan.request_id, step_id: "edit", condition_id: "revision",
      target: { kind: "file", id: "notes/blue.md" }, revision: "v2", observed_at_ms: 95, expires_at_ms: 110 }],
  };
  return { plan, context };
}

describe("BT-U-D01.02-P concrete dependency preparation", () => {
  it("concretizes target, precondition, complete effects, validation and compensation without mutating inputs", () => {
    const { plan, context } = fixture();
    const original = JSON.stringify({ plan, context });
    const prepared = prepareOperationPlan(plan, context);
    if (prepared.kind !== "inspected") throw new Error("inspection missing");
    expect(prepared.summary).toMatchObject({ status: "ready", may_execute: false, used_for_authority: false });
    expect(prepared.plan.steps[1]).toMatchObject({ target: { id: "notes/blue.md" }, parameters: { path: "notes/blue.md" },
      effects: ["read", "write"], preparation: {
        preconditions: [{ target: { id: "notes/blue.md" }, expected_revision: "v2" }],
        validation: [{ target: { id: "notes/blue.md" }, expected: "藍" }],
        compensation: { action: { target: { id: "notes/blue.md" }, parameters: { path: "notes/blue.md", content: "青" }, effects: ["write"] } } } });
    expect(JSON.stringify({ plan, context })).toBe(original);
  });
  it("rechecks precondition expiry and recovers only from fresh observation", () => {
    const { plan, context } = fixture();
    context.now_ms = 110;
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "not_ready", may_execute: false,
      steps: [{ status: "ready" }, { issues: ["precondition_expired"] }] } });
    context.observations[0]!.observed_at_ms = 110;
    context.observations[0]!.expires_at_ms = 120;
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "ready", may_execute: false } });
  });
  it("keeps ordinary body punctuation", () => {
    const { plan, context } = fixture();
    plan.steps[0]!.parameters!.query = "*これは本文?*";
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "ready" } });
  });
});

describe("BT-U-D01.02-N preparation boundary", () => {
  it.each(["missing", "failed", "stale", "future", "other_plan", "other_request", "wrong_target", "wrong_operation", "missing_field"])(
    "keeps dependency %s unprepared despite planner success claims", (kind) => {
      const { plan, context } = fixture();
      plan.steps[0]!.state = "succeeded";
      plan.steps[0]!.result_digest = "planner-self-claim";
      const result = context.results[0]!;
      if (kind === "missing") context.results = [];
      if (kind === "failed") result.status = "failed";
      if (kind === "stale") result.expires_at_ms = 100;
      if (kind === "future") result.observed_at_ms = 101;
      if (kind === "other_plan") result.plan_id = "other";
      if (kind === "other_request") result.request_id = "other";
      if (kind === "wrong_target") result.target.id = "other-directory";
      if (kind === "wrong_operation") result.operation = "file.write";
      if (kind === "missing_field") result.output = {};
      expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "inspected", summary: { status: "not_ready", may_execute: false } });
    });
  it.each(["*", "pending:file", " pending:file ", "${read.path}", "{{future}}", "notes/?.md"])("refuses unresolved target %s", (id) => {
    const { plan, context } = fixture();
    (context.results[0]!.output as Record<string, string>).path = id;
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "not_ready" } });
  });
  it.each([["body_text", "${draft.body}"], ["cc", "*"], ["bcc", "pending:recipient"], ["parent_id", "*"], ["to", ""], ["to", null], ["path", " pending:file "]])(
    "keeps unresolved %s unprepared", (key, value) => {
      const { plan, context } = fixture();
      plan.steps[0]!.parameters![key!] = value;
      expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "not_ready" } });
    });
  it.each(["unknown", "self", "cycle", "duplicate_step", "duplicate_dependency"])("rejects %s graph", (kind) => {
    const { plan, context } = fixture();
    if (kind === "unknown") plan.steps[1]!.preparation!.depends_on = ["not-found"];
    if (kind === "self") plan.steps[1]!.preparation!.depends_on = ["edit"];
    if (kind === "cycle") plan.steps[0]!.preparation!.depends_on = ["edit"];
    if (kind === "duplicate_step") plan.steps[1]!.step_id = "read";
    if (kind === "duplicate_dependency") plan.steps[1]!.preparation!.depends_on = ["read", "read"];
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "invalid_dependency_graph" });
  });
  it.each(["undeclared_source", "duplicate", "parent_child", "authority", "nonexistent"])("rejects %s binding", (kind) => {
    const { plan, context } = fixture();
    const bindings = plan.steps[1]!.preparation!.bindings;
    if (kind === "undeclared_source") bindings[0]!.source_step_id = "edit";
    if (kind === "duplicate") bindings.push({ ...bindings[0]! });
    if (kind === "parent_child") bindings.push({ ...bindings[1]!, path: ["path", "child"] });
    if (kind === "authority") bindings[6]!.path = ["action", "permission", "risk"];
    if (kind === "nonexistent") bindings[1]!.path = ["typo"];
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "invalid_binding" });
    context.results = [];
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "invalid_binding" });
  });
  it("rejects wrong types, raw command output and duplicate context", () => {
    const { plan, context } = fixture();
    (context.results[0]!.output as Record<string, unknown>).path = 42;
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "binding_value_invalid" });
    (context.results[0]!.output as Record<string, unknown>).path = "notes/blue.md";
    (context.results[0]!.output as Record<string, unknown>).before = { command: "must-not-execute" };
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "binding_value_invalid" });
    context.results.push({ ...context.results[0]! });
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "invalid_context" });
  });
  it("requires independent matching preconditions and complete compensation effects", () => {
    const { plan, context } = fixture();
    context.observations[0]!.revision = "changed";
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "not_ready",
      steps: [{}, { issues: ["precondition_changed"] }] } });
    context.observations = [];
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "not_ready" } });
    const compensation = plan.steps[1]!.preparation!.compensation;
    if (compensation.available) compensation.action.effects = ["read"];
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "descriptor_mismatch" });
  });
  it("keeps legacy plans unprepared and rejects dangerous keys and invalid clocks", () => {
    const { plan, context } = fixture();
    delete plan.steps[1]!.preparation;
    expect(prepareOperationPlan(plan, context)).toMatchObject({ summary: { status: "not_ready",
      steps: [{}, { issues: expect.arrayContaining(["preparation_missing"]) }] } });
    context.now_ms = Number.NaN;
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "invalid_context" });
    context.now_ms = 100;
    context.results[0]!.output = JSON.parse('{"constructor":"dangerous"}');
    expect(prepareOperationPlan(plan, context)).toMatchObject({ kind: "rejected", code: "invalid_context" });
  });
});
