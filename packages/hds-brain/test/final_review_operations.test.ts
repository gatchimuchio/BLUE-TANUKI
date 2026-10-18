import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  buildRuntimeInvariantEvidence,
  FINAL_REVIEW_OPERATION_LIST,
  FINAL_REVIEW_OPERATIONS,
  finalReviewOperationList,
} from "../src/index.js";
import { resolveActor, resolveProcess } from "../src/process.js";
import { buildAuthorityTransparencyTrace } from "../src/approval_policy.js";

const req: InboundRequest = {
  id: "s4-req",
  channel: "cli",
  user: "local-user",
  content: "hello",
  timestamp: 1,
  metadata: {},
};

describe("final-review operation single source", () => {
  it("keeps the exported list unique and backed by the exported set", () => {
    expect(new Set(FINAL_REVIEW_OPERATION_LIST).size).toBe(FINAL_REVIEW_OPERATION_LIST.length);
    expect(finalReviewOperationList()).toEqual([...FINAL_REVIEW_OPERATION_LIST]);
    for (const operation of FINAL_REVIEW_OPERATION_LIST) {
      expect(FINAL_REVIEW_OPERATIONS.has(operation)).toBe(true);
    }
  });

  it("uses the same source for process approval profiles", () => {
    const actor = resolveActor(req);
    const process = resolveProcess(req, actor);

    expect(process.approval_profile.final_review_operations).toEqual(finalReviewOperationList());
    expect(process.approval_profile.final_review_operations).toContain("tool.call");
    expect(process.approval_profile.final_review_operations).toContain("google.write");
    expect(process.approval_profile.final_review_operations).toContain("schedule.resolve_event");
    expect(process.approval_profile.final_review_operations).toContain("unknown");
  });

  it("uses the same source in authority trace and runtime invariant evidence", () => {
    const ctx = {
      operation: "tool.shell.exec",
      target_scope: "task_type",
      risk: "high",
      actor: "local-user",
      capabilities: ["shell:exec"],
      command_type: "tool_call",
      command_id: "cmd-1",
      upstream_commit_hash: "abc123",
      created_at: 1,
    } as const;
    const trace = buildAuthorityTransparencyTrace(ctx, {
      final_review_required: true,
      reason: "test",
    });
    const expectedSorted = finalReviewOperationList().sort();

    expect(trace.final_review_boundary).toEqual(expectedSorted);

    const report = buildRuntimeInvariantEvidence({ generated_at_ms: 1 });
    const finalReviewEvidence = report.evidence.find((entry) =>
      entry.key === "final_review_boundary_enforced_by_approval_gate"
    );

    expect(finalReviewEvidence?.metadata?.required_final_review_operations).toEqual(FINAL_REVIEW_OPERATION_LIST);
    expect(finalReviewEvidence?.metadata?.configured_final_review_operations).toEqual(expectedSorted);
  });
});
