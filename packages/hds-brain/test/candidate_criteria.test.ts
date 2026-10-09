import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOAL_CRITERIA_SCHEMA_VERSION,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import {
  assessCandidateGoalCriteria,
  projectRequestGoalCriteria,
} from "../src/candidate_criteria.js";
import { determineCandidateAdoptionDisposition } from "../src/policy.js";

function request(relation: "supports" | "conflicts" = "supports"): InboundRequest {
  return {
    id: "c06-criteria-request",
    channel: "test",
    user: "owner",
    content: "prepare the reviewed output",
    timestamp: 1,
    goal_criteria: {
      schema_version: GOAL_CRITERIA_SCHEMA_VERSION,
      criteria: [{
        criterion_ref: "criterion-private-sentinel",
        criterion_kind: "safety",
        tool_relations: [{ tool_name: "echo", relation }],
      }],
    },
  };
}

const supportedSemanticInput = {
  mechanical_contract: "pass" as const,
  domain_validation: "pass" as const,
  semantic_outcome: "supports" as const,
  semantic_evidence_status: "observed" as const,
};

describe("request-bound candidate criteria", () => {
  it("projects only digests and enum states, bound to the accepted request", () => {
    const original = request();
    const projection = projectRequestGoalCriteria(original, original.content);
    const serialized = JSON.stringify(projection);

    expect(projection.status).toBe("provided");
    expect(projection.request_id).toBe(original.id);
    expect(projection.content_sha256).toBe(createHash("sha256").update(original.content, "utf8").digest("hex"));
    expect(projection.criteria_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.criteria[0]?.criterion_ref_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.criteria[0]?.tool_relations[0]?.tool_name_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.used_for_authority).toBe(false);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.criteria)).toBe(true);
    expect(serialized).not.toContain("criterion-private-sentinel");
    expect(serialized).not.toContain("echo");
  });

  it("keeps assumed support held while risk is unverified", () => {
    const original = request("supports");
    const projection = projectRequestGoalCriteria(original, original.content);
    const binding = { request_id: original.id, content_sha256: projection.content_sha256 };
    const assessment = assessCandidateGoalCriteria("echo", projection, binding);

    expect(assessment).toMatchObject({
      outcome: "supports",
      evidence_status: "assumed",
      risk_status: "unverified",
      reason_code: "request_declares_criterion_support_risk_unverified",
    });
    expect(determineCandidateAdoptionDisposition({ ...supportedSemanticInput, goal_criteria: assessment })).toBe("held");
  });

  it("rejects a declared criterion conflict even when semantic support is otherwise supplied", () => {
    const original = request("conflicts");
    const projection = projectRequestGoalCriteria(original, original.content);
    const assessment = assessCandidateGoalCriteria("echo", projection, {
      request_id: original.id,
      content_sha256: projection.content_sha256,
    });

    expect(assessment.outcome).toBe("conflicts");
    expect(determineCandidateAdoptionDisposition({ ...supportedSemanticInput, goal_criteria: assessment })).toBe("rejected");
  });

  it("holds missing, unmatched, and cross-request criteria instead of adopting", () => {
    const original = request("supports");
    const projection = projectRequestGoalCriteria(original, original.content);
    expect(assessCandidateGoalCriteria("other-tool", projection).reason_code).toBe("no_matching_goal_criterion");
    expect(assessCandidateGoalCriteria("echo", undefined).reason_code).toBe("criteria_unavailable");
    expect(assessCandidateGoalCriteria("echo", projection, {
      request_id: "different-request",
      content_sha256: projection.content_sha256,
    })).toMatchObject({ outcome: "unknown", reason_code: "criteria_invalid" });
    expect(determineCandidateAdoptionDisposition({
      ...supportedSemanticInput,
      goal_criteria: assessCandidateGoalCriteria("other-tool", projection),
    })).toBe("held");
  });
});
