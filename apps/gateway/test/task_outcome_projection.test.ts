import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionIntentReceipt } from "@blue-tanuki/core";
import { operationPlanDigest, type AuditEntry } from "@blue-tanuki/hds-brain";
import { getOperationDescriptor } from "@blue-tanuki/protocol";
import type { TaskExecutionCancellationEvidence } from "../src/execution_intent_store.js";
import {
  projectD4RuntimeActiveCommand,
  projectD4RuntimeCancellationStatus,
  projectD4RuntimeTaskOutcome,
  projectOwnerTaskActiveCommand,
  projectOwnerTaskCancellationScope,
  projectOwnerTaskCancellationStatus,
  projectOwnerTaskExecutionObservation,
  projectOwnerTaskOutcome,
  projectOwnerTaskPlanSteps,
  projectOwnerTaskRequestCommandIds,
  resolveOwnerTaskSavedResult,
} from "../src/task_outcome_projection.js";

const requestId = "a4d61cc0-46c3-49dc-9826-0b8a9fe302da";
const rulesDigest = "a".repeat(64);
const evidenceDigest = "b".repeat(64);

describe("owner task initial computation observation", () => {
  const commandId = "owner-task-compute-command";
  const commandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", commandId])).digest("hex");
  const purpose = { goal_id_digest: "1".repeat(64), purpose_version: 2, purpose_digest: "2".repeat(64) };
  const commitHash = "3".repeat(64);
  const decision = {
    request_id: requestId,
    frame: { actor: { actor_id: "webchat-owner-token-holder", channel: "webchat", actor_kind: "owner", trust_level: "owner" } },
    commit: { hash: commitHash, decision: "ASSERT" },
    goal_purpose_binding: purpose,
    memory_capture_suppressed_for: "operation_plan_compute",
  };
  const gate = { kind: "approval_gate", request_id: requestId, command_id: commandId,
    upstream_commit_hash: commitHash, evaluation: { context: { command_id: commandId } } };
  const feedback = { kind: "executor_feedback", request_id: requestId, command_id: commandId, known_command: true,
    upstream_decision: "ASSERT", upstream_commit_hash: commitHash, feedback: { status: "success" } };
  const verifiedEntries = (...logs: unknown[]) => logs.map(log => ({ log })) as AuditEntry[];
  const receipt: ExecutionIntentReceipt = {
    ticket_id: "initial-computation-ticket", command_key: commandKey,
    command_digest: "4".repeat(64), proof_digest: "5".repeat(64),
    hds_source_context_digest: "6".repeat(64), task_identity_digest: "7".repeat(64),
    goal_version_binding: purpose, execution_epoch: "initial-computation-epoch", issued_at_ms: 1, expires_at_ms: 2,
    state: "adapter_returned", invocation_boundary: "llm_adapter", feedback_status: "success", used_for_authority: false,
  };
  const input = {
    requestId,
    verifiedAudit: verifiedEntries(decision, gate, feedback),
    pendingCommandIds: [],
    activeCommandIds: [],
    lookupCommand: (key: string) => key === commandKey ? receipt : null,
  };

  it("recovers broker feedback only for the first computation of the authenticated submission", () => {
    const observation = projectOwnerTaskExecutionObservation({ ...input, activeCommandIds: ["unrelated-worker"] });
    expect(observation).toEqual({ status: "adapter_returned", feedback_status: "success", used_for_authority: false, may_execute: false });
    expect(projectOwnerTaskExecutionObservation({ ...input, verifiedAudit: verifiedEntries(decision, gate),
      activeCommandIds: ["unrelated-worker", commandId] })).toMatchObject({ status: "active" });
    expect(projectOwnerTaskExecutionObservation({ ...input, verifiedAudit: verifiedEntries(decision, gate),
      lookupCommand: () => ({ ...receipt, state: "outcome_unknown" }) })).toMatchObject({ status: "outcome_unknown" });
  });

  it("holds unknown for cross-request feedback, other actors, ambiguous bindings and mismatched purpose", () => {
    const otherRequest = "b4d61cc0-46c3-49dc-9826-0b8a9fe302da";
    expect(projectOwnerTaskExecutionObservation({ ...input, verifiedAudit: verifiedEntries(decision, gate,
      { ...feedback, request_id: otherRequest }) })).toMatchObject({ status: "unknown" });
    expect(projectOwnerTaskExecutionObservation({ ...input, verifiedAudit: verifiedEntries({ ...decision,
      frame: { actor: { ...decision.frame.actor, trust_level: "limited" } } }, gate, feedback) })).toMatchObject({ status: "unknown" });
    expect(projectOwnerTaskExecutionObservation({ ...input, verifiedAudit: verifiedEntries(decision, gate, feedback, { ...gate,
      command_id: "unrelated-worker", evaluation: { context: { command_id: "unrelated-worker" } } }) })).toMatchObject({ status: "unknown" });
    expect(projectOwnerTaskExecutionObservation({ ...input, lookupCommand: () => ({ ...receipt,
      goal_version_binding: { ...purpose, purpose_version: 3 } }) })).toMatchObject({ status: "unknown" });
    expect(projectOwnerTaskExecutionObservation({ ...input, lookupCommand: () => ({ ...receipt,
      invocation_boundary: "tool_adapter", operation_plan_binding_digest: "8".repeat(64) }) })).toMatchObject({ status: "unknown" });
  });

  it("matches the durable J and approval proof for the first computation before a plan exists", () => {
    const provedDecision = { ...decision, owner_task_compute_cancellation_binding: {
      kind: "initial", command_id: commandId, used_for_authority: false, may_execute: false,
    } };
    const boundGate = { ...gate, evaluation: { context: {
      ...gate.evaluation.context, actor: decision.frame.actor.actor_id, command_type: "llm_call", upstream_commit_hash: commitHash,
    } } };
    const snapshot = { plans: [] };
    const scope = projectOwnerTaskCancellationScope(snapshot, requestId, verifiedEntries(provedDecision, boundGate));
    expect(scope).toEqual({ status: "matched", command_ids: [commandId], compute_command_ids: [commandId], plans: [] });
    const proof = scope.status === "matched" ? scope.compute_command_ids : [];
    expect(projectOwnerTaskActiveCommand(snapshot, requestId, new Set([commandId, "unrelated-worker"]), proof))
      .toEqual({ status: "matched", command_id: commandId });
    expect(projectOwnerTaskCancellationStatus(snapshot, requestId, [{ ...recordedCancellation,
      command_id: commandId, actor: decision.frame.actor.actor_id, token_kind: "owner_task",
    }], proof)).toMatchObject({ status: "request_recorded", local_worker_stop: "not_observed", external_processing_stop: "unknown" });
    expect(projectOwnerTaskCancellationScope(snapshot, requestId, verifiedEntries(decision, boundGate))).toEqual({ status: "not_found" });
    expect(projectOwnerTaskCancellationScope(snapshot, "b4d61cc0-46c3-49dc-9826-0b8a9fe302da", verifiedEntries(provedDecision, boundGate)))
      .toEqual({ status: "not_found" });
    expect(projectOwnerTaskCancellationScope(snapshot, requestId, verifiedEntries(provedDecision, provedDecision, boundGate)))
      .toEqual({ status: "ambiguous" });
  });
});

describe("owner task plan step observation", () => {
  const owner = "webchat-owner-token-holder";
  const followUp = "b4d61cc0-46c3-49dc-9826-0b8a9fe302da";
  const command = "selected-step-command";
  const revision = "a".repeat(64);
  const stepId = "b".repeat(64);
  const definition = "c".repeat(64);
  const commit = "d".repeat(64);
  const task = "e".repeat(64);
  const purpose = { goal_ref: "goal_fixture", purpose_version: 2, purpose_digest: "f".repeat(64) };
  const descriptor = getOperationDescriptor("file.search")!;
  const commandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command])).digest("hex");
  const ticket = "fixture-broker-ticket";
  const delivery = "1".repeat(64);
  const receipt: ExecutionIntentReceipt = {
    ticket_id: ticket, command_key: commandKey, command_digest: "2".repeat(64), proof_digest: "3".repeat(64),
    hds_source_context_digest: "4".repeat(64), operation_plan_binding_digest: "5".repeat(64), task_identity_digest: task,
    goal_version_binding: { goal_id_digest: createHash("sha256").update(purpose.goal_ref).digest("hex"),
      purpose_version: purpose.purpose_version, purpose_digest: purpose.purpose_digest },
    operation_id: descriptor.tool_name, adapter_version: descriptor.adapter_version,
    execution_epoch: "fixture-epoch", issued_at_ms: 1, expires_at_ms: 2, state: "adapter_returned", invocation_boundary: "tool_adapter",
    feedback_status: "success", used_for_authority: false, result_delivery_digest: delivery,
    result_delivery_acknowledged: true, result_delivery_disposition: "reconciled",
  };
  const binding = { step_id: stepId, step_digest: definition, revision_digest: revision, operation: "file.search", command_id: command,
    request_id: followUp, commit_hash: commit, status: "verified", result_digest: "6".repeat(64), delivery_digest: delivery,
    command_digest: receipt.command_digest,
    execution_ticket_digest: createHash("sha256").update(ticket).digest("hex"), memory_status: "receipt_confirmed",
    memory_receipt_digest: "7".repeat(64) };
  const step = { step_id: stepId, definition_digest: definition, operation: "file.search", status: "verified",
    binding_source_revision_digest: revision };
  const plan = { request_id: `operation-request:${requestId}`, owner_identity_digest: operationPlanDigest(owner),
    channel_identity_digest: operationPlanDigest("webchat"), task_identity_digest: task, revision_digest: revision,
    goal_purpose_binding: purpose, steps: [step], bindings: [binding] };
  type Input = Parameters<typeof projectOwnerTaskPlanSteps>[0];
  const projection = (...plans: unknown[]) => ({ plans, recovery_refresh_status: "ready" } as Input["operationPlans"]);
  const decision = { request_id: followUp, frame: { actor: { actor_id: owner, channel: "webchat", actor_kind: "owner", trust_level: "owner" } },
    commit: { hash: commit, decision: "ASSERT" } };
  const gate = { kind: "approval_gate", request_id: followUp, command_id: command,
    upstream_commit_hash: commit, evaluation: { context: { command_id: command } } };
  const pending = { kind: "command_lifecycle", phase: "approval_pending", request_id: followUp, command_id: command, upstream_commit_hash: commit };
  const feedback = { kind: "executor_feedback", request_id: followUp, command_id: command, known_command: true,
    upstream_decision: "ASSERT", upstream_commit_hash: commit, feedback: { status: "success" } };
  const entries = (...logs: unknown[]) => logs.map(log => ({ log })) as AuditEntry[];
  const input: Input = { requestId, operationPlans: projection(plan), verifiedAudit: entries(decision, gate, pending, feedback),
    pendingCommandIds: [], activeCommandIds: [], lookupCommand: key => key === commandKey ? receipt : null,
    lookupApprovalState: () => null, confirmResultMemory: commandId => commandId === command };
  const flags = { used_for_authority: false, may_execute: false };

  it("distinguishes a matched adapter response from J result and durable memory confirmation", () => {
    const response = { index: 1, status: "adapter_returned", feedback_status: "success" };
    expect(projectOwnerTaskPlanSteps(input)).toEqual({ status: "available", ...flags,
      steps: [{ ...response, verification: "result_and_memory_confirmed" }] });
    expect(projectOwnerTaskPlanSteps({ ...input, confirmResultMemory: () => false }))
      .toEqual({ status: "available", ...flags, steps: [response] });
    expect(projectOwnerTaskPlanSteps({ ...input, lookupCommand: () => ({ ...receipt, result_delivery_digest: "8".repeat(64) }) }))
      .toEqual({ status: "available", ...flags, steps: [response] });
    expect(projectOwnerTaskPlanSteps({ ...input, lookupCommand: () => ({ ...receipt, result_delivery_disposition: "stale_generation_evidence" }) }))
      .toMatchObject({ steps: [{ status: "outcome_unknown" }] });
  });

  it("resolves a saved result only for the same receipt, current plan revision, and step", () => {
    const supportedStep = { ...step, saved_result_return_supported: true };
    const supportedPlan = { ...plan, plan_id: "8".repeat(64), goal_purpose_binding_status: "current", steps: [supportedStep] };
    const supported = { ...input, operationPlans: projection(supportedPlan) };
    const result = projectOwnerTaskPlanSteps(supported);
    const observed = result.status === "available" ? result.steps[0] : undefined;
    const resultRef = observed?.status === "adapter_returned" && observed.feedback_status === "success"
      ? observed.result_ref : undefined;
    expect(resultRef).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveOwnerTaskSavedResult(supported, 1, resultRef!)).toEqual({
      plan_id: supportedPlan.plan_id, revision_digest: revision, step_id: stepId,
    });
    expect(resolveOwnerTaskSavedResult(supported, 2, resultRef!)).toBeUndefined();
    expect(resolveOwnerTaskSavedResult({ ...supported, requestId: followUp }, 1, resultRef!)).toBeUndefined();
    expect(resolveOwnerTaskSavedResult({ ...supported, operationPlans: projection({ ...supportedPlan,
      revision_digest: "9".repeat(64) }) }, 1, resultRef!)).toBeUndefined();
    expect(resolveOwnerTaskSavedResult({ ...supported, operationPlans: projection({ ...supportedPlan,
      goal_purpose_binding_status: "stale" }) }, 1, resultRef!)).toBeUndefined();
    expect(resolveOwnerTaskSavedResult({ ...supported, operationPlans: projection({ ...supportedPlan,
      steps: [step] }) }, 1, resultRef!)).toBeUndefined();
    expect(resolveOwnerTaskSavedResult({ ...supported, confirmResultMemory: () => false }, 1, resultRef!)).toBeUndefined();
  });

  it("confines matching to exactly one owner plan, step, follow-up request, and ticket", () => {
    expect(projectOwnerTaskPlanSteps({ ...input, operationPlans: projection(plan, plan) })).toEqual({ status: "unknown", ...flags });
    expect(projectOwnerTaskPlanSteps({ ...input, operationPlans: projection({ ...plan, owner_identity_digest: operationPlanDigest("other") }) }))
      .toEqual({ status: "unknown", ...flags });
    expect(projectOwnerTaskPlanSteps({ ...input, lookupCommand: () => ({ ...receipt, ticket_id: "other-ticket" }) }))
      .toMatchObject({ steps: [{ status: "unknown" }] });
    expect(projectOwnerTaskPlanSteps({ ...input, verifiedAudit: entries(decision, gate, { ...feedback, request_id: requestId }) }))
      .toMatchObject({ steps: [{ status: "unknown" }] });
    expect(projectOwnerTaskPlanSteps({ ...input, lookupCommand: () => ({ ...receipt,
      goal_version_binding: { ...receipt.goal_version_binding!, purpose_version: 3 } }) })).toMatchObject({ steps: [{ status: "unknown" }] });
  });

  it("reports the latest exact interrupted approval after prior withdrawals and keeps ambiguous execution unknown", () => {
    const preStart = { ...binding, result_digest: undefined, delivery_digest: undefined, execution_ticket_digest: undefined,
      memory_receipt_digest: undefined, memory_status: "not_recorded" };
    const selectedPlan = { ...plan, steps: [{ ...step, status: "selected" }], bindings: [{ ...preStart, status: "selected" }] };
    expect(projectOwnerTaskPlanSteps({ ...input, operationPlans: projection(selectedPlan), pendingCommandIds: [command],
      lookupCommand: () => null })).toMatchObject({ steps: [{ status: "awaiting_approval" }] });
    const interruptedPlan = { ...plan, steps: [{ ...step, status: "not_selected", binding_source_revision_digest: undefined }],
      bindings: [{ ...preStart, status: "invalidated", request_id: requestId, command_id: "withdrawn-command" },
        { ...preStart, status: "invalidated" }] };
    const recovered: Input = { ...input, operationPlans: projection(interruptedPlan), lookupCommand: () => null,
      lookupApprovalState: (commandId, request) => commandId === command && request === followUp ? "interrupted" : null };
    expect(projectOwnerTaskPlanSteps(recovered)).toMatchObject({ steps: [{ status: "interrupted" }] });
    expect(projectOwnerTaskPlanSteps({ ...recovered, lookupApprovalState: () => "outcome_unknown" }))
      .toMatchObject({ steps: [{ status: "outcome_unknown" }] });
    expect(projectOwnerTaskPlanSteps({ ...recovered, operationPlans: projection({ ...interruptedPlan,
      bindings: [{ ...interruptedPlan.bindings[0], execution_ticket_digest: "8".repeat(64) }, interruptedPlan.bindings[1]] }) }))
      .toMatchObject({ steps: [{ status: "unknown" }] });
  });
});

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

describe("owner task cancellation across durable replans", () => {
  const purpose = { goal_ref: "goal_0123456789abcdef", purpose_version: 2, purpose_digest: "2".repeat(64) };
  const root = {
    plan_id: "3".repeat(64),
    request_id: `operation-request:${requestId}`,
    revision_digest: "4".repeat(64),
    previous_revision_digests: ["5".repeat(64)],
    task_identity_digest: "6".repeat(64),
    owner_identity_digest: operationPlanDigest("webchat-owner-token-holder"),
    channel_identity_digest: operationPlanDigest("webchat"),
    goal_purpose_binding: purpose,
    goal_purpose_binding_status: "stale",
    bindings: [{ request_id: "parent-review", command_id: "parent-command" }],
  };
  const child = {
    ...root,
    plan_id: "7".repeat(64),
    request_id: "same-task-replan-request",
    revision_digest: "8".repeat(64),
    previous_revision_digests: ["9".repeat(64)],
    bindings: [{ request_id: "child-review", command_id: "child-command" }],
  };
  const projection = (...planRows: unknown[]) => ({
    schema_version: "operation-plan-projection.v1",
    used_for_authority: false,
    raw_payload_exposed: false,
    recovery_refresh_status: "ready",
    plans: planRows,
  });

  it("finds the same owner's child step and readback while excluding other owner, channel, and task evidence", () => {
    const otherOwner = { ...child, owner_identity_digest: "a".repeat(64), bindings: [{ request_id: "other", command_id: "foreign" }] };
    const otherChannel = { ...child, channel_identity_digest: "a".repeat(64), bindings: [{ request_id: "other", command_id: "channel" }] };
    const otherTask = { ...child, task_identity_digest: "a".repeat(64), bindings: [{ request_id: "other", command_id: "task" }] };
    const snapshot = projection(root, otherOwner, child, otherChannel, otherTask);
    expect(projectOwnerTaskRequestCommandIds(snapshot, requestId)).toEqual({ status: "matched",
      command_ids: ["parent-command", "child-command"], plans: [root, child].map((plan) => ({
        plan_id: plan.plan_id, revision_digest: plan.revision_digest, previous_revision_digests: plan.previous_revision_digests,
        goal_purpose_binding: purpose,
      })),
    });
    expect(projectOwnerTaskActiveCommand(snapshot, requestId, new Set(["child-command", "foreign", "channel", "task"])))
      .toEqual({ status: "matched", command_id: "child-command" });
    expect(projectOwnerTaskActiveCommand(snapshot, requestId, new Set(["parent-command", "child-command"])))
      .toEqual({ status: "ambiguous" });
    expect(projectOwnerTaskCancellationStatus(snapshot, requestId, [{ ...recordedCancellation,
      actor: "webchat-owner-token-holder", token_kind: "owner_task", command_id: "child-command",
    }])).toMatchObject({ status: "request_recorded", local_worker_stop: "not_observed", external_processing_stop: "unknown" });
  });

  it("blocks incomplete recovery, duplicate selection, and inconsistent persisted purpose or revisions", () => {
    expect(projectOwnerTaskRequestCommandIds({ ...projection(root, child), recovery_refresh_status: "pending" }, requestId))
      .toEqual({ status: "invalid" });
    expect(projectOwnerTaskRequestCommandIds(projection(root, child, child), requestId)).toEqual({ status: "ambiguous" });
    expect(projectOwnerTaskRequestCommandIds(projection(root, { ...child, bindings: root.bindings }), requestId))
      .toEqual({ status: "ambiguous" });
    expect(projectOwnerTaskRequestCommandIds(projection(root, { ...child,
      goal_purpose_binding: { ...purpose, purpose_version: 3 },
    }), requestId)).toEqual({ status: "invalid" });
    expect(projectOwnerTaskRequestCommandIds(projection(root, { ...child, previous_revision_digests: [child.revision_digest] }), requestId))
      .toEqual({ status: "invalid" });
    expect(projectOwnerTaskRequestCommandIds(projection(child), requestId)).toEqual({ status: "not_found" });
  });

  it("scopes an issued child computation to the saved same-task parent and exact goal version", () => {
    const snapshot = projection(root);
    const commandId = "child-compute-command";
    const actor = { actor_id: "webchat-owner-token-holder", actor_kind: "owner", channel: "webchat", trust_level: "owner" };
    const commitHash = "a".repeat(64);
    const replan = {
      request_id: child.request_id, frame: { actor }, commit: { hash: commitHash, decision: "ASSERT" },
      goal_purpose_binding: { goal_id_digest: createHash("sha256").update(purpose.goal_ref, "utf8").digest("hex"),
        purpose_version: purpose.purpose_version, purpose_digest: purpose.purpose_digest },
      owner_task_compute_cancellation_binding: { kind: "saved_result_replan", command_id: commandId,
        plan_id_digest: root.plan_id, revision_digest: root.previous_revision_digests[0], task_identity_digest: root.task_identity_digest,
        used_for_authority: false, may_execute: false },
    };
    const gate = { kind: "approval_gate", request_id: replan.request_id, command_id: commandId, upstream_commit_hash: commitHash,
      evaluation: { context: { actor: actor.actor_id, command_id: commandId, command_type: "llm_call", upstream_commit_hash: commitHash } } };
    const audit = (...logs: unknown[]) => logs.map(log => ({ log })) as AuditEntry[];
    const scope = projectOwnerTaskCancellationScope(snapshot, requestId, audit(replan, gate));
    expect(scope).toMatchObject({ status: "matched", command_ids: ["parent-command", commandId], compute_command_ids: [commandId] });
    const proof = scope.status === "matched" ? scope.compute_command_ids : [];
    expect(projectOwnerTaskActiveCommand(snapshot, requestId, new Set(["parent-command", commandId]), proof)).toEqual({ status: "ambiguous" });
    expect(projectOwnerTaskActiveCommand(snapshot, requestId, new Set(), proof)).toEqual({ status: "not_active" });
    const requested = { ...recordedCancellation, command_id: commandId, actor: actor.actor_id, token_kind: "owner_task" as const };
    expect(projectOwnerTaskCancellationStatus(snapshot, requestId, [requested, { ...requested,
      cancellation_event_id: "a6a61be3-4e77-4fa2-af3d-119b3391f0ec", event: "execution_cancel_observed", observed_at_ms: 101,
      executor_settled: true, executor_status: "suspended", local_worker_stop: "provider_state_unknown",
    }], proof)).toMatchObject({ status: "execution_observed", local_worker_stop: "provider_state_unknown", external_processing_stop: "unknown" });

    const deadline = { ...replan, frame: { actor: { ...actor, actor_kind: "system", trust_level: "trusted" } },
      owner_task_compute_cancellation_binding: { ...replan.owner_task_compute_cancellation_binding, kind: "wait_resume" } };
    expect(projectOwnerTaskCancellationScope(snapshot, requestId, audit(deadline, gate))).toMatchObject({ compute_command_ids: [commandId] });
    for (const mismatch of [
      { ...replan, frame: { actor: { ...actor, channel: "cli" } } },
      { ...replan, frame: { actor: { ...actor, actor_id: "other-owner" } } },
      { ...replan, goal_purpose_binding: { ...replan.goal_purpose_binding, purpose_version: 3 } },
      ...["revision_digest", "plan_id_digest", "task_identity_digest", "command_id"].map(key => ({ ...replan,
        owner_task_compute_cancellation_binding: { ...replan.owner_task_compute_cancellation_binding, [key]: "f".repeat(64) },
      })),
    ]) {
      expect(projectOwnerTaskCancellationScope(snapshot, requestId, audit(mismatch, gate)))
        .toMatchObject({ status: "matched", command_ids: ["parent-command"], compute_command_ids: [] });
    }
  });

  it("keeps a legacy receipt without a dependable purpose limited to its direct bound command", () => {
    expect(projectOwnerTaskRequestCommandIds({ plans: [root, child] }, requestId))
      .toEqual({ status: "matched", command_ids: ["parent-command"], plans: [] });
    expect(projectOwnerTaskRequestCommandIds(projection({ ...root, goal_purpose_binding: undefined }, child), requestId))
      .toEqual({ status: "matched", command_ids: ["parent-command"], plans: [] });
  });
});

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

  it("binds the owner-submission UUID to the canonical plan of the same owner and channel", () => {
    const completed = outcome("achieved", "goal_completion_rules_satisfied", {
      status: "rules_satisfied",
      reason_code: "rules_satisfied",
      rules_digest: rulesDigest,
      rule_count: 1,
      satisfied_rule_count: 1,
      evidence_digest: evidenceDigest,
    });

    const canonicalId = `operation-request:${requestId}`;
    expect(projectOwnerTaskOutcome(plans(completed, canonicalId, "webchat-owner-token-holder"), requestId)).toMatchObject({
      status: "achieved",
      reason_code: "goal_completion_rules_satisfied",
      completion_evidence: { rules_digest: rulesDigest, evidence_digest: evidenceDigest, rule_count: 1 },
      used_for_authority: false,
      may_execute: false,
    });
    expect(projectOwnerTaskOutcome(plans(completed, `${canonicalId}-other`, "webchat-owner-token-holder"), requestId))
      .toMatchObject({ status: "unknown", reason_code: "projection_unavailable" });
    expect(projectOwnerTaskOutcome(plans(completed), requestId)).toMatchObject({
      status: "unknown",
      reason_code: "projection_unavailable",
      used_for_authority: false,
      may_execute: false,
    });
  });
});
