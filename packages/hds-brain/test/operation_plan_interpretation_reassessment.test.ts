import { describe, expect, it } from "vitest";
import { createGatewayInternalInboundRequest, type ExecuteCommand, type OperationPlan,
  type OperationPlanMemoryInterpretationDependency } from "@blue-tanuki/protocol";
import { OperationPlanLedger, operationPlanDigest } from "../src/operation_plan.js";

describe("plan review consumes memory interpretation reassessment", () => {
  it("allows a current cited interpretation and blocks its plan after J marks the citation for reassessment", () => {
    const origin = createGatewayInternalInboundRequest({ id: "plan-origin", channel: "webchat", user: "fixture-owner",
      content: "plan:compute search fixture memory", timestamp: 1,
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
    const target = { kind: "directory" as const, id: "fixture-root" };
    const plan: OperationPlan = {
      version: "operation-core.v1", plan_id: "plan-memory-reassessment", request_id: origin.id, state: "planned",
      steps: [{ step_id: "search", operation: "file.search", target, state: "planned", effects: ["read"],
        permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
          hds_brain_authority_required: true, approval_gate_required: true },
        adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
        parameters: { root: "fixture-root", query: "blue", max_results: 1 },
        preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{ check_id: "search-result",
          method: "result_equals", target, expected: { root: "fixture-root" } }],
          compensation: { available: false, reason: "read-only" } } }],
      rollback: { available: false },
      raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
      planner_output_used_for_authority: false, hds_brain_authority_required: true,
    };
    const dependency: OperationPlanMemoryInterpretationDependency = {
      reference: { record_id: "F:memory-record", version: "a".repeat(64) },
      interpretation_id: "interpretation-v1", judgment_ref: "memory-citation-review:" + "b".repeat(64),
    };
    let reassessmentRequired = false;
    let judgmentPresent = true;
    const ledger = new OperationPlanLedger(undefined, undefined, undefined, undefined, undefined, undefined,
      (lineageId) => lineageId === dependency.reference.record_id ? ({ used_for_authority: false,
        record: { application_state: "active", current_interpretation_id: dependency.interpretation_id,
          interpretations: [{ interpretation_id: dependency.interpretation_id,
            basis_ref: `${dependency.reference.record_id}#${dependency.reference.version}` }],
          dependent_judgments: judgmentPresent ? [{ judgment_ref: dependency.judgment_ref,
            basis_interpretation_id: dependency.interpretation_id, reassessment_required: reassessmentRequired }] : [],
          used_for_authority: false, may_execute: false },
      }) : null);
    ledger.retainCandidate(plan, origin, undefined, undefined, [dependency]);

    const control = { action: "review" as const, plan_id: plan.plan_id,
      revision_digest: operationPlanDigest(plan), step_id: "search" };
    expect(ledger.inspectControl(control, origin).step?.step_id).toBe("search");

    const command: ExecuteCommand = {
      id: "selected-plan-command", type: "tool_call",
      payload: { tool_name: "file.search", arguments: { root: "fixture-root", query: "blue", max_results: 1 } },
      upstream_decision: { frame_goal: origin.content, model_abstraction: "fixture", commit_hash: "commit",
        commit_decision: "ASSERT", request_id: origin.id },
    };
    ledger.bind(control, origin, command);
    expect(ledger.canExecute(command)).toBe(true);

    reassessmentRequired = true;
    expect(() => ledger.inspectControl(control, origin)).toThrow("plan_memory_interpretation_reassessment_required");
    expect(ledger.canExecute(command)).toBe(false);

    judgmentPresent = false;
    expect(() => ledger.inspectControl(control, origin)).toThrow("plan_memory_interpretation_state_unavailable");
  });
});
