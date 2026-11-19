import type { WebChatD4RuntimeCancellationStatus, WebChatOwnerTaskCancellationStatus,
  WebChatTaskExecutionObservation, WebChatTaskOutcome } from "@blue-tanuki/channel-webchat";
import { createHash } from "node:crypto";
import type { ExecutionIntentReceipt } from "@blue-tanuki/core";
import { operationPlanDigest, type AuditEntry, type DecisionLog } from "@blue-tanuki/hds-brain";
import type { TaskExecutionCancellationEvidence } from "./execution_intent_store.js";

const TASK_OUTCOME_REASON_CODES = new Set([
  "recovery_hold_active",
  "goal_purpose_binding_required",
  "goal_purpose_binding_stale",
  "goal_purpose_relation_unconfirmed",
  "operation_result_unverified",
  "result_memory_receipt_unconfirmed",
  "goal_completion_not_assessed",
  "goal_completion_rules_missing",
  "goal_completion_rule_target_missing",
  "goal_completion_rule_target_ambiguous",
  "goal_completion_result_unverified",
  "goal_completion_result_mismatch",
  "goal_completion_memory_unverified",
  "goal_completion_wait_pending",
  "goal_completion_peer_execution_unresolved",
  "goal_completion_assessment_stale",
  "goal_completion_rules_satisfied",
  "operation_plan_steps_pending",
]);
const PENDING_TASK_OUTCOME_REASONS = new Set([
  "operation_plan_steps_pending",
  "goal_completion_wait_pending",
  "goal_completion_peer_execution_unresolved",
]);
const GOAL_ASSESSMENT_REASON_CODES = new Set([
  "rules_missing",
  "rules_invalid",
  "rule_target_missing",
  "rule_target_ambiguous",
  "result_unverified",
  "result_mismatch",
  "memory_unverified",
  "rules_satisfied",
]);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const DIGEST = /^[a-f0-9]{64}$/iu;
const D4_RUNTIME_OWNER_DIGEST = operationPlanDigest("d4-runtime-adapter-token-holder");
const WEBCHAT_OWNER_TASK_DIGEST = operationPlanDigest("webchat-owner-token-holder");
const WEBCHAT_CHANNEL_DIGEST = operationPlanDigest("webchat");

export type D4RuntimeActiveCommandProjection =
  | { readonly status: "matched"; readonly command_id: string }
  | { readonly status: "not_active" | "ambiguous" | "invalid" };

export type D4RuntimeRequestCommandIdsProjection =
  | { readonly status: "matched"; readonly command_ids: readonly string[] }
  | { readonly status: "not_found" }
  | { readonly status: "ambiguous" }
  | { readonly status: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesWebChatTaskPlan(plan: unknown, requestId: string, ownerIdentityDigest: string): plan is Record<string, unknown> {
  if (!isRecord(plan) || plan.owner_identity_digest !== ownerIdentityDigest ||
      plan.channel_identity_digest !== WEBCHAT_CHANNEL_DIGEST) return false;
  // Owner Task supplies a canonical OperationRequest ID while the receipt keeps the transport request UUID.
  return plan.request_id === requestId ||
    (ownerIdentityDigest === WEBCHAT_OWNER_TASK_DIGEST && plan.request_id === `operation-request:${requestId}`);
}

function unknownOutcome(
  reason_code: Extract<WebChatTaskOutcome["reason_code"], "projection_unavailable" | "projection_ambiguous" | "projection_invalid">,
): WebChatTaskOutcome {
  return { status: "unknown", reason_code, used_for_authority: false, may_execute: false };
}

function validGoalAssessment(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const requiredKeys = ["status", "reason_code", "rule_count", "satisfied_rule_count", "used_for_authority", "may_execute"];
  const allowedKeys = [...requiredKeys, "rules_digest", "evidence_digest"];
  if (!requiredKeys.every((key) => key in value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) return false;
  if (value.used_for_authority !== false || value.may_execute !== false ||
      !GOAL_ASSESSMENT_REASON_CODES.has(String(value.reason_code)) ||
      typeof value.rule_count !== "number" || !Number.isInteger(value.rule_count) || value.rule_count < 0 || value.rule_count > 64 ||
      typeof value.satisfied_rule_count !== "number" || !Number.isInteger(value.satisfied_rule_count) || value.satisfied_rule_count < 0 ||
      (value.satisfied_rule_count as number) > (value.rule_count as number)) return false;
  if ((value.rules_digest !== undefined && (typeof value.rules_digest !== "string" || !DIGEST.test(value.rules_digest))) ||
      (value.evidence_digest !== undefined && (typeof value.evidence_digest !== "string" || !DIGEST.test(value.evidence_digest)))) return false;
  if (value.status === "not_configured") {
    return value.reason_code === "rules_missing" && value.rule_count === 0 && value.satisfied_rule_count === 0 &&
      value.rules_digest === undefined && value.evidence_digest === undefined;
  }
  if (value.status === "rules_satisfied") {
    return value.reason_code === "rules_satisfied" && (value.rule_count as number) > 0 &&
      value.rule_count === value.satisfied_rule_count && typeof value.rules_digest === "string" &&
      typeof value.evidence_digest === "string";
  }
  return value.status === "held" && value.reason_code !== "rules_missing" && value.reason_code !== "rules_satisfied";
}

function projectTaskOutcome(
  operationPlans: unknown,
  requestId: string,
  ownerIdentityDigest: string,
): WebChatTaskOutcome {
  if (!REQUEST_ID.test(requestId)) return unknownOutcome("projection_invalid");
  if (!isRecord(operationPlans) || !Array.isArray(operationPlans.plans)) return unknownOutcome("projection_unavailable");
  const matches = operationPlans.plans.filter((plan) => matchesWebChatTaskPlan(plan, requestId, ownerIdentityDigest));
  if (matches.length === 0) return unknownOutcome("projection_unavailable");
  if (matches.length !== 1 || !isRecord(matches[0])) return unknownOutcome("projection_ambiguous");

  const taskOutcome = matches[0].task_outcome;
  if (!isRecord(taskOutcome) ||
      Object.keys(taskOutcome).some((key) => !["status", "reason_code", "goal_assessment", "used_for_authority", "may_execute"].includes(key)) ||
      !["status", "reason_code", "goal_assessment", "used_for_authority", "may_execute"].every((key) => key in taskOutcome) ||
      taskOutcome.used_for_authority !== false || taskOutcome.may_execute !== false ||
      !TASK_OUTCOME_REASON_CODES.has(String(taskOutcome.reason_code)) || !validGoalAssessment(taskOutcome.goal_assessment)) {
    return unknownOutcome("projection_invalid");
  }
  const status = taskOutcome.status;
  const reasonCode = String(taskOutcome.reason_code);
  if (status === "achieved") {
    const assessment = taskOutcome.goal_assessment as Record<string, unknown>;
    if (reasonCode !== "goal_completion_rules_satisfied" || assessment.status !== "rules_satisfied") {
      return unknownOutcome("projection_invalid");
    }
    return {
      status: "achieved",
      reason_code: "goal_completion_rules_satisfied",
      completion_evidence: {
        rules_digest: assessment.rules_digest as string,
        evidence_digest: assessment.evidence_digest as string,
        rule_count: assessment.rule_count as number,
        satisfied_rule_count: assessment.satisfied_rule_count as number,
        used_for_authority: false,
        may_execute: false,
      },
      used_for_authority: false,
      may_execute: false,
    };
  }
  if (status === "in_progress" && PENDING_TASK_OUTCOME_REASONS.has(reasonCode)) {
    return { status: "in_progress", reason_code: "completion_pending", used_for_authority: false, may_execute: false };
  }
  if (status === "held" && !PENDING_TASK_OUTCOME_REASONS.has(reasonCode) &&
      reasonCode !== "goal_completion_rules_satisfied") {
    return { status: "held", reason_code: "completion_held", used_for_authority: false, may_execute: false };
  }
  return unknownOutcome("projection_invalid");
}

/** Maps one D4 Runtime request-bound J assessment into a content-free, non-authority status. */
export function projectD4RuntimeTaskOutcome(operationPlans: unknown, requestId: string): WebChatTaskOutcome {
  return projectTaskOutcome(operationPlans, requestId, D4_RUNTIME_OWNER_DIGEST);
}

interface TaskExecutionObservationInput {
  readonly requestId: string;
  readonly verifiedAudit: readonly AuditEntry[];
  readonly pendingCommandIds: readonly string[];
  readonly activeCommandIds: readonly string[];
  readonly lookupCommand: (key: string) => ExecutionIntentReceipt | null;
}

/** 受付と同じ要求のJ判断・承認記録・Broker受領票を照合し、実行の事実だけを返す。 */
function projectTaskExecutionObservation(
  input: TaskExecutionObservationInput,
  source: "d4_runtime" | "owner_plan_compute",
): WebChatTaskExecutionObservation {
  const noAuthority = { used_for_authority: false, may_execute: false } as const;
  const unknown = { status: "unknown", ...noAuthority } as const;
  if (!REQUEST_ID.test(input.requestId)) return unknown;
  const logs = input.verifiedAudit.flatMap(({ log }) => "request_id" in log && log.request_id === input.requestId ? [log] : []);
  const decisions = logs.filter((log): log is DecisionLog => !("kind" in log));
  const decision = decisions[0];
  const ownerCompute = source === "owner_plan_compute";
  if (decisions.length !== 1 || !decision || decision.frame.actor.channel !== "webchat" ||
      decision.frame.actor.actor_kind !== (ownerCompute ? "owner" : "user") ||
      decision.frame.actor.trust_level !== (ownerCompute ? "owner" : "limited") ||
      operationPlanDigest(decision.frame.actor.actor_id) !== (ownerCompute ? WEBCHAT_OWNER_TASK_DIGEST : D4_RUNTIME_OWNER_DIGEST) ||
      (ownerCompute && decision.memory_capture_suppressed_for !== "operation_plan_compute")) return unknown;
  if (decision.commit.decision === "SUSPEND") return { status: "held", ...noAuthority };
  if (decision.commit.decision !== "ASSERT") return unknown;

  const commandIds = new Set(logs.flatMap(log => "kind" in log && log.kind === "approval_gate" &&
    log.upstream_commit_hash === decision.commit.hash && log.evaluation.context.command_id === log.command_id ? [log.command_id] : []));
  const [commandId] = commandIds;
  if (commandIds.size !== 1 || !commandId || !COMMAND_ID.test(commandId)) return unknown;
  // D4's registry input is pre-scoped. Owner Work matches the audit's exact command against the shared registry.
  if (input.pendingCommandIds.some(id => id !== commandId) ||
      (!ownerCompute && input.activeCommandIds.some(id => id !== commandId))) return unknown;
  if (input.pendingCommandIds.includes(commandId) && logs.some(log => "kind" in log && log.kind === "command_lifecycle" &&
    log.command_id === commandId && log.phase === "approval_pending" && log.upstream_commit_hash === decision.commit.hash)) {
    return { status: "awaiting_approval", ...noAuthority };
  }
  if (input.activeCommandIds.includes(commandId)) return { status: "active", ...noAuthority };

  const commandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", commandId])).digest("hex");
  const receipt = input.lookupCommand(commandKey);
  if (!receipt || receipt.command_key !== commandKey || receipt.used_for_authority !== false ||
      !receipt.task_identity_digest || !receipt.hds_source_context_digest || !receipt.goal_version_binding) return unknown;
  if (ownerCompute) {
    const purpose = decision.goal_purpose_binding;
    if (!purpose || receipt.operation_plan_binding_digest !== undefined ||
        receipt.goal_version_binding.goal_id_digest !== purpose.goal_id_digest ||
        receipt.goal_version_binding.purpose_version !== purpose.purpose_version ||
        receipt.goal_version_binding.purpose_digest !== purpose.purpose_digest) return unknown;
  }
  if (receipt.state === "not_attempted" || receipt.state === "outcome_unknown") {
    return { status: receipt.state, ...noAuthority };
  }
  if (receipt.state !== "adapter_returned" || !receipt.feedback_status ||
      (receipt.invocation_boundary !== "llm_adapter" &&
        (ownerCompute || receipt.invocation_boundary !== "tool_adapter"))) return unknown;
  const feedback = logs.flatMap(log => "kind" in log && log.kind === "executor_feedback" && log.known_command &&
    log.command_id === commandId && log.upstream_decision === "ASSERT" && log.upstream_commit_hash === decision.commit.hash
    ? [log.feedback.status] : []);
  if (feedback.length !== 1 || feedback[0] !== receipt.feedback_status) return unknown;
  return { status: "adapter_returned", feedback_status: receipt.feedback_status, ...noAuthority };
}

export function projectD4RuntimeExecutionObservation(input: TaskExecutionObservationInput): WebChatTaskExecutionObservation {
  return projectTaskExecutionObservation(input, "d4_runtime");
}

/** Workの初回計算が対象。後続の審査・計画step・目的達成は別の観測が必要。 */
export function projectOwnerTaskExecutionObservation(input: TaskExecutionObservationInput): WebChatTaskExecutionObservation {
  return projectTaskExecutionObservation(input, "owner_plan_compute");
}

function projectRequestCommandIds(
  operationPlans: unknown,
  requestId: string,
  ownerIdentityDigest: string,
): D4RuntimeRequestCommandIdsProjection {
  if (!REQUEST_ID.test(requestId) || !isRecord(operationPlans) || !Array.isArray(operationPlans.plans)) {
    return { status: "invalid" };
  }
  const plans = operationPlans.plans.filter((plan) => matchesWebChatTaskPlan(plan, requestId, ownerIdentityDigest));
  if (plans.length === 0) return { status: "not_found" };
  if (plans.length !== 1 || !isRecord(plans[0])) return { status: "ambiguous" };
  const bindings = plans[0].bindings;
  if (!Array.isArray(bindings)) return { status: "invalid" };

  const commandIds = new Set<string>();
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.request_id !== "string" || typeof binding.command_id !== "string" ||
        !COMMAND_ID.test(binding.command_id)) {
      return { status: "invalid" };
    }
    // The authenticated owner can follow later review requests issued for the same J plan.
    if (binding.request_id === requestId || ownerIdentityDigest === WEBCHAT_OWNER_TASK_DIGEST) {
      commandIds.add(binding.command_id);
    }
  }
  return { status: "matched", command_ids: [...commandIds] };
}

export function projectD4RuntimeRequestCommandIds(operationPlans: unknown, requestId: string): D4RuntimeRequestCommandIdsProjection {
  return projectRequestCommandIds(operationPlans, requestId, D4_RUNTIME_OWNER_DIGEST);
}

export function projectOwnerTaskRequestCommandIds(operationPlans: unknown, requestId: string): D4RuntimeRequestCommandIdsProjection {
  return projectRequestCommandIds(operationPlans, requestId, WEBCHAT_OWNER_TASK_DIGEST);
}

function unknownCancellationStatus(
  reason_code: Extract<WebChatOwnerTaskCancellationStatus, { status: "unknown" }>["reason_code"],
): WebChatOwnerTaskCancellationStatus {
  return { status: "unknown", reason_code, used_for_authority: false, may_execute: false };
}

/** Scoped command IDs come from the exact authenticated D4 receipt lookup in the private inbox. */
export function projectD4RuntimeCancellationStatus(
  operationPlans: unknown,
  requestId: string,
  observations: readonly TaskExecutionCancellationEvidence[],
  scopedCommandIds: readonly string[] = [],
): WebChatD4RuntimeCancellationStatus {
  return projectTaskCancellationStatus(
    operationPlans, requestId, observations, D4_RUNTIME_OWNER_DIGEST, ["d4_runtime"], scopedCommandIds,
  );
}

export function projectOwnerTaskCancellationStatus(
  operationPlans: unknown,
  requestId: string,
  observations: readonly TaskExecutionCancellationEvidence[],
): WebChatOwnerTaskCancellationStatus {
  return projectTaskCancellationStatus(
    operationPlans, requestId, observations, WEBCHAT_OWNER_TASK_DIGEST, ["owner_task", "resume"],
  );
}

function projectTaskCancellationStatus(
  operationPlans: unknown,
  requestId: string,
  observations: readonly TaskExecutionCancellationEvidence[],
  ownerIdentityDigest: string,
  tokenKinds: readonly TaskExecutionCancellationEvidence["token_kind"][],
  scopedCommandIds: readonly string[] = [],
): WebChatOwnerTaskCancellationStatus {
  const binding = projectRequestCommandIds(operationPlans, requestId, ownerIdentityDigest);
  if (binding.status === "ambiguous") return unknownCancellationStatus("projection_ambiguous");
  if (binding.status === "invalid" || scopedCommandIds.some((id) => typeof id !== "string" || !COMMAND_ID.test(id))) {
    return unknownCancellationStatus("projection_invalid");
  }
  if (binding.status === "not_found" && scopedCommandIds.length === 0) {
    return unknownCancellationStatus("projection_unavailable");
  }
  const commandIds = new Set(scopedCommandIds);
  if (binding.status === "matched") {
    for (const id of binding.command_ids) commandIds.add(id);
  }
  const matching = observations.filter((event) => commandIds.has(event.command_id) && tokenKinds.includes(event.token_kind));
  if (matching.length === 0) return unknownCancellationStatus("no_recorded_evidence");

  const byCommand = new Map<string, TaskExecutionCancellationEvidence[]>();
  for (const event of matching) {
    if (event.used_for_authority !== false || event.may_execute !== false || event.external_processing_stop !== "unknown" ||
        event.cancel_request_accepted !== true || !isRecord(event) || !Number.isSafeInteger(event.observed_at_ms) ||
        !Number.isSafeInteger(event.cancel_requested_at_ms)) return unknownCancellationStatus("projection_invalid");
    const entries = byCommand.get(event.command_id) ?? [];
    entries.push(event);
    byCommand.set(event.command_id, entries);
  }

  const latestByCommand: TaskExecutionCancellationEvidence[] = [];
  for (const events of byCommand.values()) {
    const requested = events.filter((event) => event.event === "execution_cancel_requested");
    const observed = events.filter((event) => event.event === "execution_cancel_observed");
    if (requested.length > 1 || observed.length > 1) return unknownCancellationStatus("projection_ambiguous");
    const requestEvent = requested[0];
    const observedEvent = observed[0];
    if (requestEvent && (requestEvent.executor_settled !== false || requestEvent.executor_status !== "unknown" ||
        requestEvent.local_worker_stop !== "not_observed")) return unknownCancellationStatus("projection_invalid");
    if (observedEvent && requestEvent && observedEvent.cancel_requested_at_ms !== requestEvent.cancel_requested_at_ms) {
      return unknownCancellationStatus("projection_invalid");
    }
    if (observedEvent && requestEvent && observedEvent.observed_at_ms < requestEvent.observed_at_ms) {
      return unknownCancellationStatus("projection_invalid");
    }
    latestByCommand.push(observedEvent ?? requestEvent ?? events[0]!);
  }
  const newestRequestAt = Math.max(...latestByCommand.map((event) => event.cancel_requested_at_ms));
  const newest = latestByCommand.filter((event) => event.cancel_requested_at_ms === newestRequestAt);
  if (newest.length !== 1) return unknownCancellationStatus("projection_ambiguous");
  const event = newest[0]!;
  if (event.event === "execution_cancel_requested") {
    return {
      status: "request_recorded",
      cancel_request_accepted: true,
      executor_settled: false,
      executor_status: "unknown",
      local_worker_stop: "not_observed",
      external_processing_stop: "unknown",
      cancel_requested_at_ms: event.cancel_requested_at_ms,
      used_for_authority: false,
      may_execute: false,
    };
  }
  return {
    status: "execution_observed",
    cancel_request_accepted: true,
    executor_settled: event.executor_settled,
    executor_status: event.executor_status,
    local_worker_stop: event.local_worker_stop,
    external_processing_stop: "unknown",
    cancel_requested_at_ms: event.cancel_requested_at_ms,
    observed_at_ms: event.observed_at_ms,
    used_for_authority: false,
    may_execute: false,
  };
}

/** Resolves only one currently active command bound to this D4 Runtime-owned WebChat request. */
export function projectD4RuntimeActiveCommand(
  operationPlans: unknown,
  requestId: string,
  activeCommandIds: ReadonlySet<string>,
): D4RuntimeActiveCommandProjection {
  return projectRequestActiveCommand(operationPlans, requestId, activeCommandIds, D4_RUNTIME_OWNER_DIGEST);
}

export function projectOwnerTaskActiveCommand(
  operationPlans: unknown,
  requestId: string,
  activeCommandIds: ReadonlySet<string>,
): D4RuntimeActiveCommandProjection {
  return projectRequestActiveCommand(operationPlans, requestId, activeCommandIds, WEBCHAT_OWNER_TASK_DIGEST);
}

function projectRequestActiveCommand(
  operationPlans: unknown,
  requestId: string,
  activeCommandIds: ReadonlySet<string>,
  ownerIdentityDigest: string,
): D4RuntimeActiveCommandProjection {
  const binding = projectRequestCommandIds(operationPlans, requestId, ownerIdentityDigest);
  if (binding.status === "not_found") return { status: "not_active" };
  if (binding.status === "ambiguous") return { status: "ambiguous" };
  if (binding.status === "invalid") return { status: "invalid" };
  if (binding.command_ids.length === 0) return { status: "not_active" };
  const activeBindings = binding.command_ids.filter((commandId) => activeCommandIds.has(commandId));
  if (activeBindings.length === 0) return { status: "not_active" };
  if (activeBindings.length !== 1) return { status: "ambiguous" };
  return { status: "matched", command_id: activeBindings[0]! };
}

/** Maps one owner-submitted WebChat task's J assessment into a content-free, non-authority status. */
export function projectOwnerTaskOutcome(operationPlans: unknown, requestId: string): WebChatTaskOutcome {
  return projectTaskOutcome(operationPlans, requestId, WEBCHAT_OWNER_TASK_DIGEST);
}
