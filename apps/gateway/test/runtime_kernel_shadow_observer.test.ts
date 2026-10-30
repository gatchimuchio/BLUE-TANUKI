import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startRuntimeKernelShadowObserver,
  type RuntimeKernelShadowObserverEvent,
} from "../src/runtime_kernel_shadow_observer.js";
import { DEFAULT_POLICY, runStandaloneHDSBrain } from "@blue-tanuki/hds-brain";

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
    const mismatchedDecision = firstProjectionResult.projection.typescript_decision === "ASSERT" ? "FAIL" : "ASSERT";
    const mismatchedProjection = {
      status: "comparable" as const,
      projection: {
        ...firstProjectionResult.projection,
        purpose_binding: { goal_id_digest: "a".repeat(64), purpose_version: 3, purpose_digest: "b".repeat(64) },
        typescript_decision: mismatchedDecision,
      },
    };

    try {
      for (const result of results) {
        observer!.observe({
          j_projection: result.runtime_kernel_j_projection,
          command_present: result.command_type !== undefined,
        });
      }
      observer!.observe({
        j_projection: mismatchedProjection,
        command_present: results[0]!.command_type !== undefined,
      });
    } finally {
      await observer!.shutdown();
    }

    expect(events[0]).toEqual({ kind: "ready" });
    expect(events.slice(1, 5)).toEqual(results.map((result, index) => ({
      kind: "observation",
      sequence: index + 1,
      shadow_revision: index + 1,
      comparison_status: "matched",
      typescript_decision: result.decision,
      runtime_kernel_j_decision: result.decision,
      rule_id: ["aggregate_assert", "per_axis_fail", "per_axis_suspend_below", "out_of_scope_below"][index],
      ...(index === 1 ? { rule_axis: "risk_safety" } : {}),
      ...(index === 2 ? { rule_axis: "compliance" } : {}),
      command_present: result.command_type !== undefined,
      purpose_version: null,
    })));
    expect(events[5]).toMatchObject({
      kind: "observation",
      sequence: 5,
      shadow_revision: 5,
      comparison_status: "mismatched",
      typescript_decision: mismatchedDecision,
      runtime_kernel_j_decision: results[0]!.decision,
      rule_id: "aggregate_assert",
      command_present: results[0]!.command_type !== undefined,
      purpose_version: 3,
    });
    expect(JSON.stringify(events)).not.toContain("a".repeat(64));
  }, 120_000);
});
