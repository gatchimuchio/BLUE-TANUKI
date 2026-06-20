import { describe, expect, it } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  approvalContextFromCommand,
  evaluateApproval,
  FINAL_REVIEW_OPERATIONS,
  riskForOperation,
} from "../src/approval_policy.js";
import {
  classifyBoundaryUpdate,
  evaluateFailSafeBoundary,
  evaluateReferenceBoundary,
  evaluateTrinityMClosure,
  evaluateUnknownEscalation,
  HDS_BOUNDARY_POLICY_VERSION,
  TRINITY_M_POLICY_MODEL,
  type BoundaryReferenceSource,
  type UnknownEscalationReason,
} from "../src/boundary_policy.js";

const upstream = {
  frame_goal: "goal",
  model_abstraction: "model",
  commit_hash: "abc123",
  commit_decision: "ASSERT" as const,
};

function toolCommand(
  tool_name: string,
  args: Record<string, unknown>,
  caps: string[],
): ExecuteCommand {
  return {
    id: "cmd-boundary",
    type: "tool_call",
    payload: { tool_name, arguments: args },
    constraints: { allowed_tools: [tool_name], allowed_capabilities: caps },
    upstream_decision: upstream,
  };
}

describe("Phase 12-S0 boundary policy", () => {
  it("allows memory/history/session/tool result as references only", () => {
    const sources: BoundaryReferenceSource[] = [
      "memory",
      "complete_history",
      "session",
      "tool_result",
      "llm_output",
    ];

    for (const source of sources) {
      const result = evaluateReferenceBoundary(source, "reference");
      expect(result.policy_version).toBe(HDS_BOUNDARY_POLICY_VERSION);
      expect(result.allowed).toBe(true);
      expect(result.decision).toBe("allow_reference");
      expect(result.used_for_authority).toBe(false);
      expect(result.approval_level).toBe("L1_observe");
    }
  });

  it("suspends authority conversion from downstream reference material", () => {
    for (const source of [
      "memory",
      "complete_history",
      "session",
      "tool_result",
      "external_metadata",
      "control_center",
    ] as const) {
      const result = evaluateReferenceBoundary(source, "authority_decision");
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe("suspend");
      expect(result.risk).toBe("high");
      expect(result.approval_level).toBe("L3_final_review");
      expect(result.used_for_authority).toBe(false);
      expect(result.reason).toContain("authority_conversion_forbidden");
    }
  });

  it("never auto-allows unknown, ambiguous, or unclassified conditions", () => {
    const reasons: UnknownEscalationReason[] = [
      "unknown_operation",
      "ambiguous_operation",
      "unclassified_capability",
      "missing_tool_capability",
      "policy_version_mismatch",
      "history_reference_ambiguity",
      "approval_grant_ambiguity",
      "external_metadata_conflict",
      "detector_conflict",
      "detector_unknown_pattern",
    ];

    for (const reason of reasons) {
      const result = evaluateUnknownEscalation(reason);
      expect(result.auto_allow).toBe(false);
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe("suspend");
      expect(result.risk).toBe("high");
      expect(result.approval_level).toBe("L3_final_review");
    }
  });

  it("maps command-level unknown tool calls to L3 ask instead of full-access allow", () => {
    const command = toolCommand("plugin.unclassified", {}, []);
    const ctx = approvalContextFromCommand(command, { actor: "alice", now: 1 });
    expect(ctx.operation).toBe("tool.call");
    expect(ctx.risk).toBe("high");
    expect(FINAL_REVIEW_OPERATIONS.has("tool.call")).toBe(true);
    expect(riskForOperation("unknown")).toBe("high");
    expect(FINAL_REVIEW_OPERATIONS.has("unknown")).toBe(true);

    const evaluation = evaluateApproval(command, [], {
      actor: "alice",
      now: 1,
      default_mode: "full_access",
    });
    expect(evaluation.decision).toBe("ask");
    expect(evaluation.final_review_required).toBe(true);
    expect(evaluation.approval_level).toBe("L3_final_review");
  });

  it("fails safe when HDS health or authority prerequisites are unavailable", () => {
    const healthy = evaluateFailSafeBoundary({
      hds_available: true,
      policy_valid: true,
      audit_chain_valid: true,
      runtime_invariants_valid: true,
      runtime_health_observed: true,
      approval_gate_available: true,
    });
    expect(healthy.command_execution_allowed).toBe(true);
    expect(healthy.downstream_execution_allowed).toBe(true);
    expect(healthy.failed_preconditions).toEqual([]);

    const unhealthy = evaluateFailSafeBoundary({
      hds_available: true,
      policy_valid: true,
      audit_chain_valid: false,
      runtime_invariants_valid: true,
      runtime_health_observed: true,
      approval_gate_available: true,
    });
    expect(unhealthy.allowed).toBe(false);
    expect(unhealthy.decision).toBe("suspend");
    expect(unhealthy.command_execution_allowed).toBe(false);
    expect(unhealthy.downstream_execution_allowed).toBe(false);
    expect(unhealthy.failed_preconditions).toEqual(["audit_chain_valid"]);
    expect(unhealthy.reason).toContain("audit_chain_valid");
  });

  it("requires L3 final review for policy, detector, approval, and history updates", () => {
    for (const target of ["policy", "detector", "approval", "history"] as const) {
      const result = classifyBoundaryUpdate(target);
      expect(result.final_review_required).toBe(true);
      expect(result.decision).toBe("ask");
      expect(result.risk).toBe("high");
      expect(result.approval_level).toBe("L3_final_review");
    }
  });

  it("suspends Trinity M closure when X, R, or M is missing", () => {
    expect(TRINITY_M_POLICY_MODEL.version).toBe(HDS_BOUNDARY_POLICY_VERSION);
    const closed = evaluateTrinityMClosure({
      x_defined: true,
      r_defined: true,
      m_defined: true,
    });
    expect(closed.allowed).toBe(true);
    expect(closed.missing).toEqual([]);

    const missingM = evaluateTrinityMClosure({
      x_defined: true,
      r_defined: true,
      m_defined: false,
    });
    expect(missingM.allowed).toBe(false);
    expect(missingM.decision).toBe("suspend");
    expect(missingM.missing).toEqual(["M"]);
    expect(missingM.approval_level).toBe("L3_final_review");
  });
});
