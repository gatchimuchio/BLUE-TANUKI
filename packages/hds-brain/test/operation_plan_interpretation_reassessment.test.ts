import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executorCommandDigest } from "@blue-tanuki/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayInternalInboundRequest, GOAL_GOVERNANCE_SCHEMA_VERSION, OperationPlanCheckpointSchema,
  inspectExecutionResultDelivery, type ExecuteCommand, type ExecutionResultDelivery, type OperationPlan,
  type OperationPlanMemoryInterpretationDependency } from "@blue-tanuki/protocol";
import { mergeOperationPlanMemoryInterpretationDependencies, OperationPlanLedger, operationPlanDigest,
  type OperationPlanMemoryStorage, type OperationPlanStatePort } from "../src/operation_plan.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class InMemoryOperationPlanState implements OperationPlanStatePort {
  private checkpoint = OperationPlanCheckpointSchema.parse({ schema_version: "operation-plan-state.v1", plans: [] });
  private recoveryHolds: unknown = null;
  load(): unknown { return structuredClone(this.checkpoint); }
  compareAndSet(_expectedDigest: string | null, checkpoint: ReturnType<typeof OperationPlanCheckpointSchema.parse>): void {
    this.checkpoint = structuredClone(checkpoint);
  }
  loadRecoveryHoldState(): unknown { return structuredClone(this.recoveryHolds); }
  compareAndSetRecoveryHoldState(_expectedDigest: string | null, state: unknown): void {
    this.recoveryHolds = structuredClone(state);
  }
}

describe("plan review consumes memory interpretation reassessment", () => {
  it("unions parent, explicit, and accepted citation dependencies without conflicting replacements", () => {
    const parent = { reference: { record_id: "F:parent", version: "a".repeat(64) },
      interpretation_id: "parent-interpretation", judgment_ref: "parent-judgment" };
    const explicit = { reference: { record_id: "F:explicit", version: "b".repeat(64) },
      interpretation_id: "explicit-interpretation", judgment_ref: "explicit-judgment" };
    const later = { reference: { record_id: "F:later", version: "c".repeat(64) },
      interpretation_id: "later-interpretation", judgment_ref: "later-judgment" };

    expect(mergeOperationPlanMemoryInterpretationDependencies(
      [parent, explicit], [explicit], [later],
    )).toEqual([parent, explicit, later]);
    expect(() => mergeOperationPlanMemoryInterpretationDependencies([parent, parent]))
      .toThrow("plan_memory_interpretation_dependency_invalid");
    expect(() => mergeOperationPlanMemoryInterpretationDependencies([parent], [{ ...parent,
      interpretation_id: "conflicting-interpretation" }]))
      .toThrow("plan_memory_interpretation_dependency_invalid");
  });

  it("propagates current parent dependencies and blocks a parent marked for reassessment", () => {
    const goalPurposeBinding = { goal_ref: "goal_0123456789abcdef", purpose_version: 1,
      purpose_digest: "a".repeat(64) };
    const origin = createGatewayInternalInboundRequest({ id: "parent-plan-origin", channel: "webchat",
      user: "fixture-owner", content: "Parent task", timestamp: 1,
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.operation_core.goal_purpose_binding": goalPurposeBinding } });
    const plan: OperationPlan = {
      version: "operation-core.v1", plan_id: "parent-plan-lineage", request_id: origin.id, state: "planned",
      steps: [{ step_id: "search", operation: "file.search", target: { kind: "directory", id: "fixture-root" },
        state: "planned", effects: ["read"],
        permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
          hds_brain_authority_required: true, approval_gate_required: true },
        adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
        parameters: { root: "fixture-root", query: "blue", max_results: 1 },
        preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{ check_id: "search-result",
          method: "result_equals", target: { kind: "directory", id: "fixture-root" },
          expected: { root: "fixture-root" } }], compensation: { available: false, reason: "read-only" } } }],
      rollback: { available: false },
      raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
      planner_output_used_for_authority: false, hds_brain_authority_required: true,
    };
    const dependency: OperationPlanMemoryInterpretationDependency = {
      reference: { record_id: "F:parent-memory", version: "b".repeat(64) },
      interpretation_id: "parent-memory-interpretation", judgment_ref: "parent-memory-judgment",
    };
    const goalGovernanceProjection = {
      schema_version: GOAL_GOVERNANCE_SCHEMA_VERSION,
      as_of: 1,
      used_for_authority: false as const,
      goals: [{ goal_ref: goalPurposeBinding.goal_ref, goal_kind: "delegated" as const,
        source_ref: `F:${"1".repeat(32)}`, parent_alignment_status: "not_applicable" as const,
        current_version: goalPurposeBinding.purpose_version, current_purpose_digest: goalPurposeBinding.purpose_digest,
        current_interpretation_revision: 1, effective_from: 1,
        purpose_versions: [{ version: goalPurposeBinding.purpose_version,
          purpose_digest: goalPurposeBinding.purpose_digest, effective_from: 1 }],
        interpretation_revisions: [{ revision: 1, status: "identified" as const,
          interpretation_digest: "c".repeat(64), effective_from: 1 }],
      }],
      events: [],
    };
    let reassessmentRequired = false;
    const ledger = new OperationPlanLedger(new InMemoryOperationPlanState(), undefined, undefined,
      () => goalGovernanceProjection, undefined, undefined,
      (lineageId) => lineageId === dependency.reference.record_id ? ({ used_for_authority: false,
        record: { application_state: "active", current_interpretation_id: dependency.interpretation_id,
          interpretations: [{ interpretation_id: dependency.interpretation_id,
            basis_ref: `${dependency.reference.record_id}#${dependency.reference.version}` }],
          dependent_judgments: [{ judgment_ref: dependency.judgment_ref,
            basis_interpretation_id: dependency.interpretation_id, reassessment_required: reassessmentRequired }],
          used_for_authority: false, may_execute: false },
      }) : null);
    ledger.retainCandidate(plan, origin, undefined, undefined, [dependency]);
    const reference = { plan_id_digest: operationPlanDigest(plan.plan_id), revision_digest: operationPlanDigest(plan) };

    expect(ledger.inspectComputeParentPlan(reference, origin).memory_interpretation_dependencies).toEqual([dependency]);
    reassessmentRequired = true;
    expect(() => ledger.inspectComputeParentPlan(reference, origin))
      .toThrow("plan_memory_interpretation_reassessment_required");
  });

  it("binds the selected operation source to the exact cited memory interpretation dependencies", () => {
    const createBoundDigest = (dependency: OperationPlanMemoryInterpretationDependency): string => {
      const origin = createGatewayInternalInboundRequest({ id: "plan-origin-binding", channel: "webchat",
        user: "fixture-owner", content: "plan:compute search fixture memory", timestamp: 1,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "developer" } });
      const target = { kind: "directory" as const, id: "fixture-root" };
      const plan: OperationPlan = {
        version: "operation-core.v1", plan_id: "plan-memory-binding", request_id: origin.id, state: "planned",
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
      const ledger = new OperationPlanLedger(undefined, undefined, undefined, undefined, undefined, undefined,
        (lineageId) => lineageId === dependency.reference.record_id ? ({ used_for_authority: false,
          record: { application_state: "active", current_interpretation_id: dependency.interpretation_id,
            interpretations: [{ interpretation_id: dependency.interpretation_id,
              basis_ref: `${dependency.reference.record_id}#${dependency.reference.version}` }],
            dependent_judgments: [{ judgment_ref: dependency.judgment_ref,
              basis_interpretation_id: dependency.interpretation_id, reassessment_required: false }],
            used_for_authority: false, may_execute: false },
        }) : null);
      ledger.retainCandidate(plan, origin, undefined, undefined, [dependency]);

      const control = { action: "review" as const, plan_id: plan.plan_id,
        revision_digest: operationPlanDigest(plan), step_id: "search" };
      ledger.inspectControl(control, origin);
      const command: ExecuteCommand = {
        id: "selected-plan-command-binding", type: "tool_call",
        payload: { tool_name: "file.search", arguments: { root: "fixture-root", query: "blue", max_results: 1 } },
        upstream_decision: { frame_goal: origin.content, model_abstraction: "fixture", commit_hash: "commit",
          commit_decision: "ASSERT", request_id: origin.id },
      };
      ledger.bind(control, origin, command);
      const digest = ledger.executionSourceBindingDigest(command);
      if (!digest) throw new Error("plan_execution_source_binding_unavailable");
      return digest;
    };

    const first = createBoundDigest({ reference: { record_id: "F:memory-record-a", version: "a".repeat(64) },
      interpretation_id: "interpretation-a", judgment_ref: "memory-citation-review:" + "b".repeat(64) });
    const second = createBoundDigest({ reference: { record_id: "F:memory-record-b", version: "c".repeat(64) },
      interpretation_id: "interpretation-b", judgment_ref: "memory-citation-review:" + "d".repeat(64) });

    expect(first).not.toBe(second);
  });

  it("shows a memory interpretation follow-up only after the bound action result and M receipt are verified", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-interpretation-follow-up-"));
    temporaryRoots.push(root);
    const privateRoot = join(root, "private-state");
    mkdirSync(privateRoot, { recursive: true });
    const storage: OperationPlanMemoryStorage = { private_state_root: privateRoot,
      database_path: join(privateRoot, "j-control.sqlite"), memory_database_path: join(privateRoot, "m-state.sqlite") };
    const nowMs = Date.now();
    const origin = createGatewayInternalInboundRequest({ id: "plan-memory-follow-up", channel: "webchat",
      user: "fixture-owner", content: "Find the synthetic blue marker.", timestamp: nowMs,
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer" } });
    const target = { kind: "directory" as const, id: "fixture-root" };
    const output = { root: "fixture-root", sandbox_root: "fixture-root", query: "blue", visited_files: 1,
      matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
    const plan: OperationPlan = { version: "operation-core.v1", plan_id: "plan-memory-follow-up",
      request_id: origin.id, state: "planned", steps: [{ step_id: "search", operation: "file.search", target,
        state: "planned", effects: ["read"], permission: { risk: "low", approval_level: "L1_observe",
          final_review_required: false, hds_brain_authority_required: true, approval_gate_required: true },
        adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
        parameters: { root: "fixture-root", query: "blue", max_results: 1 }, preparation: { depends_on: [], bindings: [],
          preconditions: [], validation: [{ check_id: "search-result", method: "result_equals", target, expected: output }],
          compensation: { available: false, reason: "read-only" } } }], rollback: { available: false },
      raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
      planner_output_used_for_authority: false, hds_brain_authority_required: true };
    const dependency: OperationPlanMemoryInterpretationDependency = { reference: {
      record_id: "F:private-synthetic-meaning", version: "a".repeat(64) },
      interpretation_id: "synthetic-interpretation", judgment_ref: "private-citation-judgment" };
    const memoryReader = (lineageId: string) => lineageId === dependency.reference.record_id ? ({ used_for_authority: false as const,
      record: { application_state: "active", current_interpretation_id: dependency.interpretation_id,
        interpretations: [{ interpretation_id: dependency.interpretation_id,
          basis_ref: `${dependency.reference.record_id}#${dependency.reference.version}` }],
        dependent_judgments: [{ judgment_ref: dependency.judgment_ref,
          basis_interpretation_id: dependency.interpretation_id, reassessment_required: false }],
        used_for_authority: false as const, may_execute: false as const },
    }) : null;
    const ledger = new OperationPlanLedger(new InMemoryOperationPlanState(), storage, undefined,
      undefined, undefined, undefined, memoryReader, undefined, undefined, undefined, undefined, () => nowMs);

    try {
      ledger.retainCandidate(plan, origin, undefined, undefined, [dependency]);
      expect((ledger.projection() as { plans: Array<{ memory_interpretation_follow_up: { status: string } }> })
        .plans[0]?.memory_interpretation_follow_up.status).toBe("unconfirmed");

      const control = { action: "review" as const, plan_id: plan.plan_id,
        revision_digest: operationPlanDigest(plan), step_id: "search" };
      ledger.inspectControl(control, origin);
      const command: ExecuteCommand = { id: "plan-memory-follow-up-command", type: "tool_call",
        payload: { tool_name: "file.search", arguments: { root: "fixture-root", query: "blue", max_results: 1 } },
        upstream_decision: { frame_goal: origin.content, model_abstraction: "fixture", commit_hash: "commit",
          commit_decision: "ASSERT", request_id: origin.id } };
      ledger.bind(control, origin, command);
      const taskIdentityDigest = ledger.executionTaskIdentityDigest(command);
      if (!taskIdentityDigest) throw new Error("plan_memory_follow_up_task_identity_unavailable");
      const admission = { ticket_id: randomUUID(),
        command_key: createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command.id])).digest("hex"),
        command_digest: executorCommandDigest(command), proof_digest: "b".repeat(64),
        task_identity_digest: taskIdentityDigest, execution_epoch: randomUUID(),
        issued_at_ms: nowMs, expires_at_ms: nowMs + 60_000 };
      expect(ledger.beginAttempt(command, admission)).toBe(true);

      const coreResult = { version: "operation-core.v1" as const, role: "command_execution_result" as const,
        result_id: "plan-memory-follow-up-result", request_id: origin.id, command_id: command.id,
        upstream_commit_hash: "commit", operation: "file.search", state: "succeeded" as const,
        adapter: "internal_runtime" as const, execution_boundary: "tool_adapter" as const,
        action_outcome: "reported_success" as const, observed_at_ms: nowMs,
        command_payload_digest: createHash("sha256").update(JSON.stringify(command.payload)).digest("hex"),
        output_digest: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
        plan_step_binding: "unbound" as const, adapter_result_used_for_authority: false as const,
        used_for_authority: false as const, evidence_source: ["INTERNAL_STATE"] as ["INTERNAL_STATE"] };
      const delivery: ExecutionResultDelivery = { profile: "file-search-result-delivery.v1", admission,
        feedback: { command_id: command.id, status: "success", metrics: { duration_ms: 1 },
          operation_core_result: coreResult, result: output } };
      const deliveryDigest = createHash("sha256").update(JSON.stringify(inspectExecutionResultDelivery(delivery))).digest("hex");
      expect(ledger.reconcileResult(delivery, deliveryDigest)).toBe(true);
      expect((ledger.projection() as { plans: Array<{ memory_interpretation_follow_up: { status: string } }> })
        .plans[0]?.memory_interpretation_follow_up.status).toBe("unconfirmed");
      expect(ledger.reconcileMemory()).toBe(true);

      const followUp = (ledger.projection() as { plans: Array<{ memory_interpretation_follow_up: Record<string, unknown> }> })
        .plans[0]!.memory_interpretation_follow_up;
      expect(followUp).toMatchObject({ status: "action_observed", dependency_count: 1, action_count: 1,
        validity_status: "not_assessed", improvement_status: "not_measured", generalization_status: "not_assessed",
        used_for_authority: false, may_execute: false });
      expect(followUp.dependency_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(followUp.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
      const projectionText = JSON.stringify(ledger.projection());
      expect(projectionText).not.toContain(dependency.reference.record_id);
      expect(projectionText).not.toContain(dependency.judgment_ref);
      expect(projectionText).not.toContain("blue.txt");
    } finally {
      ledger.closeMemory();
    }
  });

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
