import { describe, expect, it } from "vitest";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { TaskExecutionCancellationEvidence } from "../src/execution_intent_store.js";
import {
  projectD4RuntimeActiveCommand,
  projectD4RuntimeCancellationStatus,
  projectD4RuntimeTaskOutcome,
  projectOwnerTaskCancellationStatus,
  projectOwnerTaskOutcome,
} from "../src/task_outcome_projection.js";

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

const recordedCancellation: TaskExecutionCancellationEvidence = {
  cancellation_event_id: "99d8e93e-a242-4ee9-9bbc-36159a01daaf",
  command_id: "command-d4-cancellation",
  event: "execution_cancel_requested",
  actor: "d4-runtime-adapter-token-holder",
  token_kind: "d4_runtime",
  observed_at_ms: 100,
  cancel_requested_at_ms: 100,
  cancel_request_accepted: true,
  executor_settled: false,
  executor_status: "unknown",
  local_worker_stop: "not_observed",
  external_processing_stop: "unknown",
  used_for_authority: false,
  may_execute: false,
};

describe("D4 Runtime cancellation projection", () => {
  it("reports the exact durable scope without an operation plan and separates local observations from external stop", () => {
    const observed: TaskExecutionCancellationEvidence = {
      ...recordedCancellation,
      cancellation_event_id: "5a03b456-a02d-4312-b136-66e03e1e434d",
      event: "execution_cancel_observed",
      observed_at_ms: 110,
      executor_settled: true,
      executor_status: "failed",
      local_worker_stop: "worker_exit_observed",
    };
    const scope = [recordedCancellation.command_id];
    expect(projectD4RuntimeCancellationStatus({ plans: [] }, requestId, [recordedCancellation])).toMatchObject({
      status: "unknown", reason_code: "projection_unavailable",
    });
    expect(projectD4RuntimeCancellationStatus({ plans: [] }, requestId, [recordedCancellation], scope)).toMatchObject({
      status: "request_recorded", executor_settled: false, external_processing_stop: "unknown",
    });
    expect(projectD4RuntimeCancellationStatus({ plans: [] }, requestId, [recordedCancellation, observed], scope)).toEqual({
      status: "execution_observed",
      cancel_request_accepted: true,
      executor_settled: true,
      executor_status: "failed",
      local_worker_stop: "worker_exit_observed",
      external_processing_stop: "unknown",
      cancel_requested_at_ms: 100,
      observed_at_ms: 110,
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("merges legacy command bindings and durable scope while rejecting unbound or wrong-token evidence", () => {
    const legacyCancellation: TaskExecutionCancellationEvidence = {
      ...recordedCancellation,
      cancellation_event_id: "7abdddfe-ace8-41b4-8dc0-b699748d63e7",
      command_id: "command-d4-legacy",
      observed_at_ms: 90,
      cancel_requested_at_ms: 90,
    };
    const plan = {
      ...plans(null).plans[0],
      bindings: [{ request_id: requestId, command_id: legacyCancellation.command_id }],
    };
    const evidence: TaskExecutionCancellationEvidence[] = [
      legacyCancellation,
      recordedCancellation,
      { ...recordedCancellation, command_id: "command-different-request", cancel_requested_at_ms: 120, observed_at_ms: 120 },
      { ...recordedCancellation, token_kind: "owner_task", cancel_requested_at_ms: 130, observed_at_ms: 130 },
    ];
    expect(projectD4RuntimeCancellationStatus({ plans: [plan] }, requestId, evidence)).toMatchObject({
      status: "request_recorded", cancel_requested_at_ms: 90,
    });
    expect(projectD4RuntimeCancellationStatus({ plans: [plan] }, requestId, evidence, [
      legacyCancellation.command_id, recordedCancellation.command_id,
    ])).toMatchObject({ status: "request_recorded", cancel_requested_at_ms: 100 });
    const ownerPlan = { ...plan, owner_identity_digest: operationPlanDigest("webchat-owner-token-holder") };
    expect(projectOwnerTaskCancellationStatus({ plans: [ownerPlan] }, requestId, evidence)).toMatchObject({
      status: "unknown", reason_code: "no_recorded_evidence",
    });
  });

  it("keeps ambiguous plan and invalid scope or observation data unknown", () => {
    const plan = {
      ...plans(null).plans[0],
      bindings: [{ request_id: requestId, command_id: recordedCancellation.command_id }],
    };
    const scope = [recordedCancellation.command_id];
    expect(projectD4RuntimeCancellationStatus({ plans: [plan, plan] }, requestId, [recordedCancellation], scope))
      .toMatchObject({ status: "unknown", reason_code: "projection_ambiguous" });
    expect(projectD4RuntimeCancellationStatus({ plans: [{ ...plan, bindings: null }] },
      requestId, [recordedCancellation], scope)).toMatchObject({ status: "unknown", reason_code: "projection_invalid" });
    expect(projectD4RuntimeCancellationStatus({ plans: [] }, requestId, [recordedCancellation], ["\u0000"]))
      .toMatchObject({ status: "unknown", reason_code: "projection_invalid" });
    expect(projectD4RuntimeCancellationStatus({ plans: [] }, requestId,
      [{ ...recordedCancellation, executor_settled: true }], scope))
      .toMatchObject({ status: "unknown", reason_code: "projection_invalid" });
  });
});

describe("D4 Runtime task outcome projection", () => {
  it("resolves only the one active command bound to the exact D4 Runtime request and channel", () => {
    const commandId = "command-d4-active";
    const plan = {
      request_id: requestId,
      owner_identity_digest: operationPlanDigest("d4-runtime-adapter-token-holder"),
      channel_identity_digest: operationPlanDigest("webchat"),
      bindings: [
        { request_id: requestId, command_id: commandId },
        { request_id: "b4d61cc0-46c3-49dc-9826-0b8a9fe302da", command_id: "other-request" },
      ],
    };
    expect(projectD4RuntimeActiveCommand({ plans: [plan] }, requestId, new Set([commandId]))).toEqual({
      status: "matched", command_id: commandId,
    });
    expect(projectD4RuntimeActiveCommand({ plans: [plan] }, requestId, new Set())).toEqual({ status: "not_active" });
    expect(projectD4RuntimeActiveCommand({ plans: [{ ...plan, owner_identity_digest: "0".repeat(64) }] },
      requestId, new Set([commandId]))).toEqual({ status: "not_active" });
    expect(projectD4RuntimeActiveCommand({ plans: [{ ...plan, channel_identity_digest: "0".repeat(64) }] },
      requestId, new Set([commandId]))).toEqual({ status: "not_active" });
  });

  it("fails closed on multiple active bindings, duplicate plans, malformed plans, or a different request", () => {
    const basePlan = {
      request_id: requestId,
      owner_identity_digest: operationPlanDigest("d4-runtime-adapter-token-holder"),
      channel_identity_digest: operationPlanDigest("webchat"),
      bindings: [{ request_id: requestId, command_id: "command-one" }],
    };
    expect(projectD4RuntimeActiveCommand({ plans: [basePlan, basePlan] }, requestId,
      new Set(["command-one"]))).toEqual({ status: "ambiguous" });
    expect(projectD4RuntimeActiveCommand({ plans: [{ ...basePlan, bindings: [
      ...basePlan.bindings, { request_id: requestId, command_id: "command-two" },
    ] }] }, requestId, new Set(["command-one", "command-two"]))).toEqual({ status: "ambiguous" });
    expect(projectD4RuntimeActiveCommand({ plans: [{ ...basePlan, bindings: null }] }, requestId,
      new Set(["command-one"]))).toEqual({ status: "invalid" });
    expect(projectD4RuntimeActiveCommand({ plans: [basePlan] }, "b4d61cc0-46c3-49dc-9826-0b8a9fe302da",
      new Set(["command-one"]))).toEqual({ status: "not_active" });
  });

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
