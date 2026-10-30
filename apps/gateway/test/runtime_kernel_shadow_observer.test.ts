import { execFileSync } from "node:child_process";
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
  projectRuntimeKernelJMemoryTransition,
  runStandaloneHDSBrain,
} from "@blue-tanuki/hds-brain";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(repositoryRoot, "packages", "hds-brain", "runtime-kernel-rust", "Cargo.toml");

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

  it("同じ合成系列のJ projectionをRustで再計算し、差分と非権限receiptを返す", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    const observer = await startRuntimeKernelShadowObserver({
      enabled: true,
      production: false,
      onEvent: (event) => events.push(event),
    });
    expect(observer).toBeDefined();

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
        typescript_policy_rule_id: "per_axis_fail" as const,
        typescript_policy_rule_axis: "risk_safety",
      },
    };
    const meaningAdoptionProjection = projectRuntimeKernelJMemoryTransition(firstProjectionResult, {
      kind: "meaning_update_adoption",
      reference_review_status: "prior_version_unverified",
      pending_reassessment_required_count: 2,
    });
    const memoryReassessmentProjection = projectRuntimeKernelJMemoryTransition(firstProjectionResult, {
      kind: "memory_judgment_reassessment",
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

    try {
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
    } finally {
      await observer!.shutdown();
    }

    expect(events[0]).toEqual({ kind: "ready" });
    const expectedSeries = [
      ...results.slice(0, 3).map((result, index) => ({
        comparison_kind: "decision" as const,
        comparison_status: "matched" as const,
        policy_decision_matches: true,
        purpose_binding_matches: null,
        policy_rule_matches: true,
        lifecycle_matches: true,
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
      })),
      {
        comparison_kind: "resume" as const,
        comparison_status: "matched" as const,
        policy_decision_matches: true,
        purpose_binding_matches: null,
        policy_rule_matches: true,
        lifecycle_matches: true,
        typescript_decision: "ASSERT",
        typescript_policy_rule_id: "per_axis_suspend_below",
        typescript_policy_rule_axis: "compliance",
        runtime_kernel_j_decision: "ASSERT",
        rule_id: "human_resume_transition",
        command_present: true,
        purpose_version: null,
      },
      {
        comparison_kind: "decision" as const,
        comparison_status: "matched" as const,
        policy_decision_matches: true,
        purpose_binding_matches: null,
        policy_rule_matches: true,
        lifecycle_matches: true,
        typescript_decision: results[3]!.decision,
        typescript_policy_rule_id: "out_of_scope_below",
        runtime_kernel_j_decision: results[3]!.decision,
        rule_id: "out_of_scope_below",
        command_present: results[3]!.command_type !== undefined,
        purpose_version: null,
      },
    ];
    expect(events.slice(1, 6)).toEqual(expectedSeries.map((expected, index) => ({
      kind: "observation",
      sequence: index + 1,
      shadow_revision: index + 1,
      ...expected,
    })));
    const mismatchedEvent = events[6];
    expect(mismatchedEvent).toMatchObject({
      kind: "observation",
      sequence: 6,
      shadow_revision: 6,
      comparison_kind: "decision",
      comparison_status: "mismatched",
      policy_decision_matches: true,
      purpose_binding_matches: true,
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
      residual_status: "meaning_unverified_with_reassessment_pending",
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
      residual_status: "named_judgments_reassessed",
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
      residual_status: "meaning_unverified_with_reassessment_pending",
      residual_status_matches: false,
    });
    expect(JSON.stringify(events)).not.toContain("a".repeat(64));
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
