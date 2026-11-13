import { describe, expect, it } from "vitest";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { projectD4RuntimeTaskOutcome, projectOwnerTaskOutcome } from "../src/task_outcome_projection.js";

const requestId = "a4d61cc0-46c3-49dc-9826-0b8a9fe302da";
const rulesDigest = "a".repeat(64);
const evidenceDigest = "b".repeat(64);

function outcome(status: string, reason_code: string, assessment: Record<string, unknown>) {
  return {
    status,
    reason_code,
    goal_assessment: {
      ...assessment,
      used_for_authority: false,
      may_execute: false,
    },
    used_for_authority: false,
    may_execute: false,
  };
}

function plans(taskOutcome: unknown, id = requestId, actor = "d4-runtime-adapter-token-holder") {
  return { plans: [{
    request_id: id,
    owner_identity_digest: operationPlanDigest(actor),
    channel_identity_digest: operationPlanDigest("webchat"),
    task_outcome: taskOutcome,
  }] };
}

describe("D4 Runtime task outcome projection", () => {
  it("reports achieved only for the current J assessment with every explicit rule and evidence digest", () => {
    const projected = projectD4RuntimeTaskOutcome(plans(outcome("achieved", "goal_completion_rules_satisfied", {
      status: "rules_satisfied",
      reason_code: "rules_satisfied",
      rules_digest: rulesDigest,
      rule_count: 2,
      satisfied_rule_count: 2,
      evidence_digest: evidenceDigest,
    })), requestId);

    expect(projected).toEqual({
      status: "achieved",
      reason_code: "goal_completion_rules_satisfied",
      completion_evidence: {
        rules_digest: rulesDigest,
        evidence_digest: evidenceDigest,
        rule_count: 2,
        satisfied_rule_count: 2,
        used_for_authority: false,
        may_execute: false,
      },
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("keeps pending and held J outcomes distinct from dispatch completion", () => {
    const assessment = {
      status: "not_configured",
      reason_code: "rules_missing",
      rule_count: 0,
      satisfied_rule_count: 0,
    };
    expect(projectD4RuntimeTaskOutcome(
      plans(outcome("in_progress", "operation_plan_steps_pending", assessment)), requestId,
    )).toMatchObject({ status: "in_progress", reason_code: "completion_pending", used_for_authority: false });
    expect(projectD4RuntimeTaskOutcome(
      plans(outcome("held", "goal_completion_rules_missing", assessment)), requestId,
    )).toMatchObject({ status: "held", reason_code: "completion_held", may_execute: false });
  });

  it("holds missing, ambiguous, stale-shaped, or mismatched HDS evidence as unknown", () => {
    const satisfied = outcome("achieved", "goal_completion_rules_satisfied", {
      status: "rules_satisfied",
      reason_code: "rules_satisfied",
      rules_digest: rulesDigest,
      rule_count: 1,
      satisfied_rule_count: 1,
      evidence_digest: evidenceDigest,
    });
    expect(projectD4RuntimeTaskOutcome({ plans: [] }, requestId)).toMatchObject({
      status: "unknown", reason_code: "projection_unavailable",
    });
    expect(projectD4RuntimeTaskOutcome({ plans: [
      ...plans(satisfied).plans,
      ...plans(satisfied).plans,
    ] }, requestId)).toMatchObject({ status: "unknown", reason_code: "projection_ambiguous" });
    expect(projectD4RuntimeTaskOutcome(
      plans(outcome("achieved", "goal_completion_rules_satisfied", {
        status: "rules_satisfied", reason_code: "rules_satisfied", rules_digest: rulesDigest,
        rule_count: 1, satisfied_rule_count: 0, evidence_digest: evidenceDigest,
      })), requestId,
    )).toMatchObject({ status: "unknown", reason_code: "projection_invalid" });
    expect(projectD4RuntimeTaskOutcome(plans(satisfied, "b4d61cc0-46c3-49dc-9826-0b8a9fe302da"), requestId))
      .toMatchObject({ status: "unknown", reason_code: "projection_unavailable" });
    const wrongOwner = plans(satisfied).plans[0]!;
    expect(projectD4RuntimeTaskOutcome({ plans: [{ ...wrongOwner, owner_identity_digest: "0".repeat(64) }] }, requestId))
      .toMatchObject({ status: "unknown", reason_code: "projection_unavailable" });
  });

  it("binds owner-submission projection to the owner-token actor, not the D4 Runtime actor", () => {
    const completed = outcome("achieved", "goal_completion_rules_satisfied", {
      status: "rules_satisfied",
      reason_code: "rules_satisfied",
      rules_digest: rulesDigest,
      rule_count: 1,
      satisfied_rule_count: 1,
      evidence_digest: evidenceDigest,
    });

    expect(projectOwnerTaskOutcome(plans(completed, requestId, "webchat-owner-token-holder"), requestId)).toMatchObject({
      status: "achieved",
      reason_code: "goal_completion_rules_satisfied",
      completion_evidence: { rules_digest: rulesDigest, evidence_digest: evidenceDigest, rule_count: 1 },
      used_for_authority: false,
      may_execute: false,
    });
    expect(projectOwnerTaskOutcome(plans(completed), requestId)).toMatchObject({
      status: "unknown",
      reason_code: "projection_unavailable",
      used_for_authority: false,
      may_execute: false,
    });
  });
});
