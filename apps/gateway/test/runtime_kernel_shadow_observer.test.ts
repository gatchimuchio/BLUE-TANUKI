import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startRuntimeKernelShadowObserver,
  type RuntimeKernelShadowObserverEvent,
} from "../src/runtime_kernel_shadow_observer.js";
import {
  DEFAULT_POLICY,
  HDSUpperController,
  classifyRuntimeKernelJPlanStepAdoption,
  operationPlanDigest,
  projectRuntimeKernelJMemoryTransition,
  runStandaloneHDSBrain,
  type RuntimeKernelJPlanStepAdoptionProjection,
  type RuntimeKernelJPlanStepAdoptionReceipt,
} from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, OperationPlanCheckpointSchema, type OperationPlan } from "@blue-tanuki/protocol";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(repositoryRoot, "packages", "hds-brain", "runtime-kernel-rust", "Cargo.toml");
const priorVersionReview = {
  review_status: "prior_version_unverified" as const,
  supporting_reference_count: 1,
  supporting_references_verified: 1,
  counterevidence_reference_count: 1,
  counterevidence_references_verified: 1,
  applicability_scope_matches_current: true,
  counterevidence_scope_matches_current: true,
  applicability_scope_digest_matches_current: true,
  counterevidence_scope_digest_matches_current: true,
  counterevidence_claim_status: "references_verified" as const,
  scope_digests_verified: true,
  target_reference_matches_current_projection: true,
  candidate_content_digest_status: "verified" as const,
};

function createSelectedPlanAdoptionFixture() {
  const root = mkdtempSync(join(tmpdir(), "blue-runtime-shadow-plan-adoption-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "blue.txt"), "synthetic plan adoption fixture\n", "utf8");
  const store = new OperationPlanStateStore(join(root, "plan-state.sqlite"));
  const requestId = "runtime-shadow-plan-adoption-request";
  const planId = "runtime-shadow-plan-adoption-plan";
  const query = "synthetic adoption query";
  const goal = "Select one bounded synthetic file-search plan step for comparison.";
  const target = { kind: "directory" as const, id: workspace };
  let controller: HDSUpperController | undefined;
  try {
    const candidate: OperationPlan = {
      version: "operation-core.v1",
      plan_id: planId,
      request_id: requestId,
      state: "planned",
      steps: [{
        step_id: "search-synthetic-file",
        operation: "file.search",
        target,
        state: "planned",
        effects: ["read"],
        permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
          hds_brain_authority_required: true, approval_gate_required: true },
        adapter: "internal_runtime",
        adapter_is_authority: false,
        command_generated_by_adapter_only: false,
        parameters: { root: workspace, query, max_results: 1 },
        preparation: { depends_on: [], bindings: [], preconditions: [],
          validation: [{ check_id: "synthetic-search-result", method: "result_equals", target,
            expected: { root: workspace, sandbox_root: workspace, query, visited_files: 1,
              matches: [{ path: "blue.txt", line_number: 1, line: "synthetic plan adoption fixture" }] } }],
          compensation: { available: false, reason: "read-only synthetic plan" } },
      }],
      rollback: { available: false },
      raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
    };
    const requestCriteria = { status: "not_provided" as const, request_id: requestId,
      content_sha256: createHash("sha256").update(goal, "utf8").digest("hex"), criteria: [], used_for_authority: false as const };
    store.compareAndSet(null, OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "synthetic-owner", channel: "webchat", goal, request_goal_criteria: requestCriteria,
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }],
        receipt_observations: [], bindings: [], results: [] }],
    }));
    controller = new HDSUpperController({ operation_plan_state: store });
    const savedPlan = controller.getRuntimeSnapshot().operation_plans.plans[0];
    if (!savedPlan) throw new Error("synthetic plan checkpoint unavailable");
    const review = controller.decide(createGatewayInternalInboundRequest({
      id: "runtime-shadow-plan-adoption-review",
      channel: "webchat",
      user: "synthetic-owner",
      timestamp: Date.now(),
      content: `plan:review ${JSON.stringify({ plan_id: savedPlan.plan_id,
        revision_digest: savedPlan.revision_digest, step_id: operationPlanDigest("search-synthetic-file") })}`,
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer" },
    }));
    if (review.command?.type !== "tool_call") throw new Error("synthetic plan step was not selected");
    const selectedProjection = controller.runtimeKernelJProjection(review.log, review.command);
    if (selectedProjection.status !== "comparable") throw new Error("selected plan projection unavailable");
    if (selectedProjection.projection.plan_step_adoption.status !== "available") {
      throw new Error("selected plan adoption assessment unavailable");
    }
    return {
      controller,
      store,
      root,
      workspace,
      planId,
      requestId,
      query,
      goal,
      selectedProjection,
      privateValues: [workspace, planId, requestId, query, goal, "blue.txt"],
      dispose(): void {
        controller!.close();
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    controller?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe("Gateway Runtime Kernel shadow observer", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "--locked", "--manifest-path", manifestPath], {
      cwd: repositoryRoot,
      stdio: "pipe",
      timeout: 600_000,
    });
  }, 600_000);

  it("productionでは明示設定があっても起動しない", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    const observer = await startRuntimeKernelShadowObserver({
      enabled: true,
      production: true,
      onEvent: (event) => events.push(event),
    });

    expect(observer).toBeUndefined();
    expect(events).toEqual([{ kind: "disabled", reason: "production_environment" }]);
  });

  it("command有無の不一致をRustのlifecycle一致と分けて記録する", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    const result = runStandaloneHDSBrain({
      id: "runtime-shadow-command-presence",
      channel: "webchat",
      user: "synthetic-owner",
      content: "ordinary synthetic input",
    });
    expect(result.decision).toBe("ASSERT");
    expect(result.runtime_kernel_j_projection.status).toBe("comparable");
    if (result.runtime_kernel_j_projection.status !== "comparable") {
      throw new Error("synthetic J projection unavailable");
    }

    const observer = await startRuntimeKernelShadowObserver({
      enabled: true,
      production: false,
      onEvent: (event) => events.push(event),
    });
    expect(observer).toBeDefined();
    try {
      observer!.observe({ j_projection: result.runtime_kernel_j_projection, command_present: false });
      await waitForObservedEvents(events, 1);
    } finally {
      await observer!.shutdown();
    }

    expect(events[1]).toMatchObject({
      kind: "observation",
      comparison_status: "mismatched",
      policy_decision_matches: true,
      lifecycle_matches: true,
      command_present: false,
      command_presence_matches: false,
      command_presence_mismatch: true,
    });
  }, 120_000);

  it("同じ合成系列のJ projectionをRustで再計算し、差分と非権限receiptを返す", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    let observer: Awaited<ReturnType<typeof startRuntimeKernelShadowObserver>> | undefined;

    const outOfScopePolicy = structuredClone(DEFAULT_POLICY);
    outOfScopePolicy.thresholds = { aggregate_assert: 0.9, out_of_scope_below: 0.8 };
    const inputs = [
      { content: "ordinary synthetic input", policy: DEFAULT_POLICY, expected: "ASSERT" },
      { content: "please rm -rf /; DROP TABLE users", policy: DEFAULT_POLICY, expected: "FAIL" },
      { content: "credit card number", policy: DEFAULT_POLICY, expected: "SUSPEND" },
      { content: "credit card number", policy: outOfScopePolicy, expected: "OUT_OF_SCOPE" },
    ] as const;
    const results = inputs.map(({ content, policy }, index) => runStandaloneHDSBrain({
      id: `runtime-shadow-synthetic-${index + 1}`,
      channel: "webchat",
      user: "synthetic-owner",
      content,
      policy,
    }));
    const resumeController = new HDSUpperController();
    const resumeRequestId = "runtime-shadow-resume-synthetic";
    const suspended = resumeController.decide({
      id: resumeRequestId,
      channel: "webchat",
      user: "synthetic-owner",
      content: "credit card number",
      timestamp: Date.now(),
    });
    expect(suspended.log.commit.decision).toBe("SUSPEND");
    const resumed = resumeController.resume(resumeRequestId, "approve", {
      actor: "synthetic-owner-identity",
      token_kind: "resume",
    });
    expect(resumed.runtime_kernel_j_projection.status).toBe("comparable");
    if (resumed.runtime_kernel_j_projection.status !== "comparable") {
      throw new Error("synthetic resume projection unavailable");
    }
    for (const [index, result] of results.entries()) {
      expect(result.decision).toBe(inputs[index]!.expected);
      expect(result.runtime_kernel_j_projection.status).toBe("comparable");
      if (result.runtime_kernel_j_projection.status === "comparable") {
        expect(JSON.stringify(result.runtime_kernel_j_projection.projection)).not.toContain(inputs[index]!.content);
      }
      expect(result.audit_chain_valid).toBe(true);
    }
    const firstProjectionResult = results[0]!.runtime_kernel_j_projection;
    if (firstProjectionResult.status !== "comparable") throw new Error("synthetic J projection unavailable");
    const mismatchedProjection = {
      status: "comparable" as const,
      projection: {
        ...firstProjectionResult.projection,
        purpose_binding: { goal_id_digest: "a".repeat(64), purpose_version: 3, purpose_digest: "b".repeat(64) },
        current_goal_purpose_binding: {
          status: "available" as const,
          binding: { goal_id_digest: "a".repeat(64), purpose_version: 3, purpose_digest: "b".repeat(64) },
        },
        typescript_policy_rule_id: "per_axis_fail" as const,
        typescript_policy_rule_axis: "risk_safety",
      },
    };
    const meaningAdoptionProjection = projectRuntimeKernelJMemoryTransition(firstProjectionResult, {
      kind: "meaning_update_adoption",
      owner_verdict: "approve",
      memory_application_status: "applied",
      memory_revision_before: 4,
      memory_revision_after: 5,
      reference_review: priorVersionReview,
      pending_reassessment_required_count: 2,
    });
    const memoryReassessmentProjection = projectRuntimeKernelJMemoryTransition(firstProjectionResult, {
      kind: "memory_judgment_reassessment",
      owner_verdict: "approve",
      memory_application_status: "applied",
      memory_revision_before: 5,
      memory_revision_after: 6,
      requested_judgment_count: 2,
      reassessed_judgment_count: 2,
      remaining_reassessment_required_count: 0,
    });
    if (meaningAdoptionProjection.status !== "comparable" || memoryReassessmentProjection.status !== "comparable") {
      throw new Error("synthetic memory transition projection unavailable");
    }
    const mismatchedResidualProjection = {
      status: "comparable" as const,
      projection: {
        ...meaningAdoptionProjection.projection,
        memory_transition: {
          ...meaningAdoptionProjection.projection.memory_transition!,
          typescript_residual_status: "meaning_unverified" as const,
        },
      },
    };
    const additionalMemoryTransitionCases: Array<{
      input: Parameters<typeof projectRuntimeKernelJMemoryTransition>[1];
      residual_status: string;
      comparison_status?: "matched" | "mismatched";
    }> = [
      { input: { kind: "meaning_update_adoption", owner_verdict: "reject", memory_application_status: "not_applied",
        memory_revision_before: null, memory_revision_after: null,
        reference_review: null, pending_reassessment_required_count: null }, residual_status: "adoption_rejected" },
      { input: { kind: "meaning_update_adoption", owner_verdict: "block", memory_application_status: "not_applied",
        memory_revision_before: null, memory_revision_after: null,
        reference_review: null, pending_reassessment_required_count: null }, residual_status: "adoption_blocked" },
      { input: { kind: "meaning_update_adoption", owner_verdict: "approve", memory_application_status: "not_applied",
        memory_revision_before: null, memory_revision_after: null,
        reference_review: priorVersionReview, pending_reassessment_required_count: null },
        residual_status: "adoption_approved_not_applied" },
      { input: { kind: "memory_judgment_reassessment", owner_verdict: "reject", memory_application_status: "not_applied",
        memory_revision_before: null, memory_revision_after: null,
        requested_judgment_count: 2, reassessed_judgment_count: 0, remaining_reassessment_required_count: 2 },
        residual_status: "named_judgments_pending" },
      { input: { kind: "memory_judgment_reassessment", owner_verdict: "block", memory_application_status: "not_applied",
        memory_revision_before: null, memory_revision_after: null,
        requested_judgment_count: 2, reassessed_judgment_count: 0, remaining_reassessment_required_count: 2 },
        residual_status: "named_judgments_pending" },
      { input: { kind: "memory_judgment_reassessment", owner_verdict: "approve", memory_application_status: "not_applied",
        memory_revision_before: null, memory_revision_after: null,
        requested_judgment_count: 2, reassessed_judgment_count: 0, remaining_reassessment_required_count: 2 },
        residual_status: "named_judgments_pending" },
      { input: { kind: "meaning_update_adoption", owner_verdict: "approve", memory_application_status: "applied",
        memory_revision_before: 4, memory_revision_after: 6,
        reference_review: priorVersionReview, pending_reassessment_required_count: 2 },
        residual_status: "meaning_unverified_with_reassessment_pending", comparison_status: "mismatched" },
      { input: { kind: "meaning_update_adoption", owner_verdict: "approve", memory_application_status: "applied",
        memory_revision_before: 4, memory_revision_after: 5,
        reference_review: { ...priorVersionReview, supporting_references_verified: 0 },
        pending_reassessment_required_count: 2 },
        residual_status: "meaning_unverified_with_reassessment_pending", comparison_status: "mismatched" },
    ];
    const additionalMemoryTransitionProjections = additionalMemoryTransitionCases.map(({ input, residual_status, comparison_status }) => {
      const result = projectRuntimeKernelJMemoryTransition(firstProjectionResult, input);
      if (result.status !== "comparable") throw new Error("additional synthetic memory transition unavailable");
      return { projection: result, residual_status, comparison_status };
    });
    const planFixture = createSelectedPlanAdoptionFixture();

    try {
      observer = await startRuntimeKernelShadowObserver({
        enabled: true,
        production: false,
        onEvent: (event) => events.push(event),
      });
      expect(observer).toBeDefined();
      let observedCount = 0;
      const observeAndWait = async (
        j_projection: typeof firstProjectionResult,
        command_present: boolean,
      ): Promise<void> => {
        observer!.observe({ j_projection, command_present });
        observedCount += 1;
        await waitForObservedEvents(events, observedCount);
      };
      for (const result of results) {
        await observeAndWait(result.runtime_kernel_j_projection, result.command_type !== undefined);
        if (result === results[2]) {
          await observeAndWait(resumed.runtime_kernel_j_projection, resumed.command !== null);
        }
      }
      await observeAndWait(mismatchedProjection, results[0]!.command_type !== undefined);
      await observeAndWait(meaningAdoptionProjection, false);
      await observeAndWait(memoryReassessmentProjection, false);
      await observeAndWait(mismatchedResidualProjection, false);
      for (const { projection } of additionalMemoryTransitionProjections) {
        await observeAndWait(projection, false);
      }
      await observeAndWait(planFixture.selectedProjection, true);
    } finally {
      await observer?.shutdown();
      planFixture.dispose();
    }

    expect(events[0]).toEqual({ kind: "ready" });
    const expectedSeries = [
      ...results.slice(0, 3).map((result, index) => ({
        comparison_kind: "decision" as const,
        comparison_status: "matched" as const,
        policy_decision_matches: true,
        purpose_binding_matches: null,
        current_goal_purpose_binding_status: "not_bound" as const,
        purpose_binding_current_matches: null,
        policy_rule_matches: true,
        lifecycle_matches: true,
        command_presence_matches: true,
        typescript_decision: result.decision,
        typescript_policy_rule_id: ["aggregate_assert", "per_axis_fail", "per_axis_suspend_below"][index]!,
        ...(index === 1 ? { typescript_policy_rule_axis: "risk_safety" } : {}),
        ...(index === 2 ? { typescript_policy_rule_axis: "compliance" } : {}),
        runtime_kernel_j_decision: result.decision,
        rule_id: ["aggregate_assert", "per_axis_fail", "per_axis_suspend_below"][index]!,
        ...(index === 1 ? { rule_axis: "risk_safety" } : {}),
        ...(index === 2 ? { rule_axis: "compliance" } : {}),
        command_present: result.command_type !== undefined,
        purpose_version: null,
        plan_step_adoption: { status: "not_applicable", matches: null },
      })),
      {
        comparison_kind: "resume" as const,
        comparison_status: "matched" as const,
        policy_decision_matches: true,
        purpose_binding_matches: null,
        current_goal_purpose_binding_status: "not_bound" as const,
        purpose_binding_current_matches: null,
        policy_rule_matches: true,
        lifecycle_matches: true,
        command_presence_matches: true,
        typescript_decision: "ASSERT",
        typescript_policy_rule_id: "per_axis_suspend_below",
        typescript_policy_rule_axis: "compliance",
        runtime_kernel_j_decision: "ASSERT",
        rule_id: "human_resume_transition",
        command_present: true,
        resume_owner_verdict: "approve",
        resume_allowed: true,
        purpose_version: null,
        plan_step_adoption: { status: "not_applicable", matches: null },
      },
      {
        comparison_kind: "decision" as const,
        comparison_status: "matched" as const,
        policy_decision_matches: true,
        purpose_binding_matches: null,
        current_goal_purpose_binding_status: "not_bound" as const,
        purpose_binding_current_matches: null,
        policy_rule_matches: true,
        lifecycle_matches: true,
        command_presence_matches: true,
        typescript_decision: results[3]!.decision,
        typescript_policy_rule_id: "out_of_scope_below",
        runtime_kernel_j_decision: results[3]!.decision,
        rule_id: "out_of_scope_below",
        command_present: results[3]!.command_type !== undefined,
        purpose_version: null,
        plan_step_adoption: { status: "not_applicable", matches: null },
      },
    ];
    expect(events.slice(1, 6)).toEqual(expectedSeries.map((expected, index) => ({
      kind: "observation",
      sequence: index + 1,
      shadow_revision: index + 1,
      ...expected,
      typescript_plan_step_adoption_status: "not_applicable",
      plan_step_adoption_classification_agrees: true,
    })));
    const mismatchedEvent = events[6];
    expect(mismatchedEvent).toMatchObject({
      kind: "observation",
      sequence: 6,
      shadow_revision: 6,
      comparison_kind: "decision",
      comparison_status: "mismatched",
      typescript_plan_step_adoption_status: "not_applicable",
      plan_step_adoption_classification_agrees: true,
      policy_decision_matches: true,
      purpose_binding_matches: true,
      current_goal_purpose_binding_status: "available",
      purpose_binding_current_matches: true,
      policy_rule_matches: false,
      lifecycle_matches: true,
      typescript_decision: results[0]!.decision,
      typescript_policy_rule_id: "per_axis_fail",
      typescript_policy_rule_axis: "risk_safety",
      runtime_kernel_j_decision: results[0]!.decision,
      rule_id: "aggregate_assert",
      command_present: results[0]!.command_type !== undefined,
      purpose_version: 3,
    });
    expect(events[7]).toMatchObject({
      kind: "observation",
      sequence: 7,
      shadow_revision: 7,
      comparison_kind: "memory_approval",
      comparison_status: "matched",
      policy_decision_matches: true,
      purpose_binding_matches: null,
      lifecycle_matches: true,
      typescript_decision: "ASSERT",
      runtime_kernel_j_decision: "ASSERT",
      rule_id: "memory_approval_transition",
      command_present: false,
      memory_transition_kind: "meaning_update_adoption",
      memory_transition_matches: true,
      memory_reference_review_matches: true,
      residual_status: "meaning_unverified_with_reassessment_pending",
      memory_revision_matches: true,
      residual_status_matches: true,
    });
    expect(events[8]).toMatchObject({
      kind: "observation",
      sequence: 8,
      shadow_revision: 8,
      comparison_kind: "memory_approval",
      comparison_status: "matched",
      lifecycle_matches: true,
      memory_transition_kind: "memory_judgment_reassessment",
      memory_transition_matches: true,
      memory_reference_review_matches: null,
      residual_status: "named_judgments_reassessed",
      memory_revision_matches: true,
      residual_status_matches: true,
    });
    expect(events[9]).toMatchObject({
      kind: "observation",
      sequence: 9,
      shadow_revision: 9,
      comparison_kind: "memory_approval",
      comparison_status: "mismatched",
      lifecycle_matches: false,
      memory_transition_kind: "meaning_update_adoption",
      memory_transition_matches: true,
      memory_reference_review_matches: true,
      residual_status: "meaning_unverified_with_reassessment_pending",
      memory_revision_matches: true,
      residual_status_matches: false,
    });
    for (const [index, { projection, residual_status, comparison_status }] of additionalMemoryTransitionProjections.entries()) {
      const transition = projection.projection.memory_transition!;
      const revisionMatches = transition.memory_application_status === "applied"
        ? transition.memory_revision_after === transition.memory_revision_before! + 1 : null;
      const isMatched = comparison_status !== "mismatched";
      expect(events[10 + index]).toMatchObject({
        kind: "observation",
        sequence: 10 + index,
        shadow_revision: 10 + index,
        comparison_kind: "memory_approval",
        comparison_status: comparison_status ?? "matched",
        lifecycle_matches: isMatched,
        command_present: false,
        memory_transition_kind: transition.kind,
        memory_transition_owner_verdict: transition.owner_verdict,
        memory_application_status: transition.memory_application_status,
        memory_revision_before: transition.memory_revision_before,
        memory_revision_after: transition.memory_revision_after,
        memory_reference_review_matches: transition.kind === "meaning_update_adoption" && transition.reference_review !== null
          ? transition.reference_review.supporting_references_verified ===
            transition.reference_review.supporting_reference_count : null,
        memory_revision_matches: revisionMatches,
        memory_transition_matches: isMatched,
        residual_status,
        residual_status_matches: true,
      });
    }
    expect(events[18]).toMatchObject({
      kind: "observation",
      sequence: 18,
      shadow_revision: 18,
      comparison_kind: "decision",
      comparison_status: "matched",
      command_presence_matches: true,
      command_present: true,
      plan_step_adoption: { status: "matched", matches: true },
      typescript_plan_step_adoption_status: "matched",
      plan_step_adoption_classification_agrees: true,
    });
    const serializedEvents = JSON.stringify(events);
    for (const privateValue of planFixture.privateValues) {
      expect(serializedEvents).not.toContain(privateValue);
    }
    expect(serializedEvents).not.toContain("a".repeat(64));
  }, 120_000);

  it("自己健全性fail-safeのSUSPENDをRust shadow receiptまで通し無作用で閉じる", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    const controller = new HDSUpperController({ self_health: { hds_available: false } });
    const { log, command } = controller.decide({
      id: "runtime-shadow-self-health-task",
      channel: "webchat",
      user: "synthetic-owner",
      content: "synthetic fail-safe observation",
      timestamp: Date.now(),
    });
    expect(log.commit.decision).toBe("SUSPEND");
    expect(command).toBeNull();
    const projection = controller.runtimeKernelJProjection(log, command);
    expect(projection.status).toBe("comparable");
    if (projection.status !== "comparable") throw new Error("self-health projection unavailable");
    expect(JSON.stringify(projection.projection)).not.toContain("hds_available");
    expect(JSON.stringify(projection.projection)).not.toContain("synthetic fail-safe observation");

    const observer = await startRuntimeKernelShadowObserver({
      enabled: true,
      production: false,
      onEvent: (event) => events.push(event),
    });
    expect(observer).toBeDefined();
    try {
      observer!.observe({ j_projection: projection, command_present: false });
      await waitForObservedEvents(events, 1);
    } finally {
      await observer!.shutdown();
    }

    expect(events[0]).toEqual({ kind: "ready" });
    expect(events[1]).toMatchObject({
      kind: "observation",
      sequence: 1,
      shadow_revision: 1,
      comparison_kind: "decision",
      comparison_status: "matched",
      policy_decision_matches: true,
      policy_rule_matches: true,
      lifecycle_matches: true,
      typescript_decision: "SUSPEND",
      typescript_policy_rule_id: "detector_lifecycle",
      typescript_policy_rule_axis: "self_health",
      runtime_kernel_j_decision: "SUSPEND",
      rule_id: "detector_lifecycle",
      rule_axis: "self_health",
      command_present: false,
      purpose_version: null,
    });
  }, 120_000);

  it("選択済みplanの採否要約を実Rust processへ送り、非権威receiptで照合する", async () => {
    const fixture = createSelectedPlanAdoptionFixture();
    const { selectedProjection } = fixture;
    const events: RuntimeKernelShadowObserverEvent[] = [];
    let observer: Awaited<ReturnType<typeof startRuntimeKernelShadowObserver>> | undefined;
    const classifierWithSyntheticDrift = (
      projection: RuntimeKernelJPlanStepAdoptionProjection,
    ): RuntimeKernelJPlanStepAdoptionReceipt => {
      const result = classifyRuntimeKernelJPlanStepAdoption(projection);
      return result.status === "mismatched"
        ? { ...result, status: "matched", matches: true }
        : result;
    };
    try {
      const planAdoption = selectedProjection.projection.plan_step_adoption;
      if (planAdoption.status !== "available") throw new Error("selected plan adoption assessment unavailable");
      const mismatchedProjection = {
        ...selectedProjection.projection,
        plan_step_adoption: {
          ...planAdoption,
          criterion_relation: {
            ...planAdoption.criterion_relation,
            conflicts_count: 1,
          },
        },
      };

      observer = await startRuntimeKernelShadowObserver({ enabled: true, production: false,
        onEvent: (event) => events.push(event), classifyPlanStepAdoptionForTest: classifierWithSyntheticDrift });
      expect(observer).toBeDefined();
      observer!.observe({ j_projection: selectedProjection, command_present: true });
      await waitForObservedEvents(events, 1);
      observer!.observe({ j_projection: { status: "comparable", projection: mismatchedProjection }, command_present: true });
      await waitForObservedEvents(events, 2);
    } finally {
      await observer?.shutdown();
      fixture.dispose();
    }

    expect(events[0]).toEqual({ kind: "ready" });
    expect(events[1]).toMatchObject({ kind: "observation", sequence: 1, shadow_revision: 1,
      comparison_kind: "decision", comparison_status: "matched",
      plan_step_adoption: { status: "matched", matches: true } });
    expect(events[2]).toMatchObject({ kind: "observation", sequence: 2, shadow_revision: 2,
      comparison_kind: "decision", comparison_status: "mismatched",
      plan_step_adoption: { status: "mismatched", matches: false },
      typescript_plan_step_adoption_status: "matched",
      plan_step_adoption_typescript_matches: true,
      plan_step_adoption_classification_agrees: false });
    const serializedEvents = JSON.stringify(events);
    for (const privateValue of fixture.privateValues) {
      expect(serializedEvents).not.toContain(privateValue);
    }
  }, 120_000);

  it("Rustへ送るprojectionを受付時点で固定し、後続の呼出元変更と混ぜない", async () => {
    const fixture = createSelectedPlanAdoptionFixture();
    const { selectedProjection } = fixture;
    const events: RuntimeKernelShadowObserverEvent[] = [];
    let observer: Awaited<ReturnType<typeof startRuntimeKernelShadowObserver>> | undefined;
    try {
      if (selectedProjection.projection.plan_step_adoption.status !== "available") {
        throw new Error("selected plan adoption assessment unavailable");
      }

      observer = await startRuntimeKernelShadowObserver({ enabled: true, production: false,
        onEvent: (event) => events.push(event) });
      expect(observer).toBeDefined();
      observer!.observe({ j_projection: selectedProjection, command_present: true });

      selectedProjection.projection.plan_step_adoption.criterion_relation.conflicts_count = 1;
      await waitForObservedEvents(events, 1);
    } finally {
      await observer?.shutdown();
      fixture.dispose();
    }

    expect(events[0]).toEqual({ kind: "ready" });
    expect(events[1]).toMatchObject({
      kind: "observation",
      sequence: 1,
      comparison_status: "matched",
      plan_step_adoption: { status: "matched", matches: true },
      typescript_plan_step_adoption_status: "matched",
      plan_step_adoption_classification_agrees: true,
    });
  }, 120_000);
});

async function waitForObservedEvents(events: RuntimeKernelShadowObserverEvent[], expectedCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (events.filter((event) => event.kind === "observation").length >= expectedCount) return;
    if (events.some((event) => event.kind === "stopped")) {
      throw new Error("Rust shadow stopped before observation completed");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Rust shadow observation timed out at ${expectedCount}; events=${JSON.stringify(events)}`);
}
