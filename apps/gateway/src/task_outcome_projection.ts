import type { WebChatD4RuntimeCancellationStatus,
  WebChatOwnerTaskPlanStep, WebChatOwnerTaskPlanSteps, WebChatTaskExecutionObservation, WebChatTaskOutcome } from "@blue-tanuki/channel-webchat";
import { MAX_OWNER_TASK_PLAN_STEPS } from "@blue-tanuki/channel-webchat";
import { createHash } from "node:crypto";
import type { ExecutionIntentReceipt } from "@blue-tanuki/core";
import { operationPlanDigest, type AuditEntry, type DecisionLog, type HDSRuntimeSnapshot } from "@blue-tanuki/hds-brain";
import { ExecutionGoalVersionBindingSchema, getOperationDescriptor, OperationPlanGoalPurposeBindingSchema,
  type OperationPlanGoalPurposeBinding } from "@blue-tanuki/protocol";
import type { ApprovalRecoveryState } from "./approval_recovery_store.js";
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

export interface OwnerTaskCancellationPlanReference {
  readonly plan_id: string;
  readonly revision_digest: string;
  readonly previous_revision_digests: readonly string[];
  readonly goal_purpose_binding: OperationPlanGoalPurposeBinding;
}

export type OwnerTaskCancellationScopeProjection =
  | { readonly status: "matched"; readonly command_ids: readonly string[]; readonly plans: readonly OwnerTaskCancellationPlanReference[] }
  | Exclude<D4RuntimeRequestCommandIdsProjection, { status: "matched" }>;

type OwnerTaskAuditedCancellationScopeProjection =
  | (Extract<OwnerTaskCancellationScopeProjection, { status: "matched" }> & { readonly compute_command_ids: readonly string[] })
  | Exclude<OwnerTaskCancellationScopeProjection, { status: "matched" }>;

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

type OperationPlans = HDSRuntimeSnapshot["operation_plans"];
type ProjectedPlan = OperationPlans["plans"][number];
type ProjectedBinding = ProjectedPlan["bindings"][number];

interface OwnerTaskPlanStepsInput extends TaskExecutionObservationInput {
  readonly operationPlans?: OperationPlans;
  readonly lookupApprovalState: (commandId: string, requestId: string) => ApprovalRecoveryState | null;
  readonly confirmResultMemory: (commandId: string) => boolean;
}

function ownerTaskStepEvidence(binding: ProjectedBinding, logs: readonly AuditEntry["log"][]) {
  const decisions = logs.filter((log): log is DecisionLog => !("kind" in log));
  const decision = decisions[0];
  if (decisions.length !== 1 || !decision || decision.commit.hash !== binding.commit_hash || decision.commit.decision !== "ASSERT" ||
      decision.frame.actor.channel !== "webchat" || decision.frame.actor.actor_kind !== "owner" ||
      decision.frame.actor.trust_level !== "owner" || operationPlanDigest(decision.frame.actor.actor_id) !== WEBCHAT_OWNER_TASK_DIGEST) return null;
  const scoped = logs.flatMap(log => "kind" in log && "command_id" in log && log.command_id === binding.command_id &&
    "upstream_commit_hash" in log && log.upstream_commit_hash === binding.commit_hash ? [log] : []);
  if (!scoped.some(log => log.kind === "approval_gate" && log.evaluation.context.command_id === binding.command_id)) return null;
  return {
    pendingApproval: scoped.some(log => log.kind === "command_lifecycle" && log.phase === "approval_pending"),
    feedback: scoped.flatMap(log => log.kind === "executor_feedback" && log.known_command && log.upstream_decision === "ASSERT"
      ? [log.feedback] : []),
  };
}

function ownerTaskStepReceiptMatches(receipt: ExecutionIntentReceipt, commandKey: string, plan: ProjectedPlan, binding: ProjectedBinding): boolean {
  const purpose = plan.goal_purpose_binding;
  const descriptor = getOperationDescriptor(binding.operation);
  return !!purpose && !!descriptor && !!receipt.goal_version_binding &&
    receipt.used_for_authority === false && receipt.command_key === commandKey &&
    binding.execution_ticket_digest === createHash("sha256").update(receipt.ticket_id, "utf8").digest("hex") &&
    receipt.task_identity_digest === plan.task_identity_digest &&
    receipt.goal_version_binding.goal_id_digest === createHash("sha256").update(purpose.goal_ref, "utf8").digest("hex") &&
    receipt.goal_version_binding.purpose_version === purpose.purpose_version &&
    receipt.goal_version_binding.purpose_digest === purpose.purpose_digest &&
    receipt.operation_id === descriptor.tool_name && receipt.adapter_version === descriptor.adapter_version &&
    DIGEST.test(receipt.operation_plan_binding_digest ?? "") && DIGEST.test(receipt.hds_source_context_digest ?? "");
}

function projectOwnerTaskPlanStep(
  input: OwnerTaskPlanStepsInput,
  plan: ProjectedPlan,
  step: ProjectedPlan["steps"][number],
  index: number,
  auditByRequest: ReadonlyMap<string, readonly AuditEntry["log"][]>,
  pending: ReadonlySet<string>,
  active: ReadonlySet<string>,
): WebChatOwnerTaskPlanStep {
  const unknown = { index, status: "unknown" } as const;
  const selectedRevision = step.binding_source_revision_digest ?? plan.revision_digest;
  const candidates = plan.bindings.filter((binding) => binding.step_id === step.step_id && binding.revision_digest === selectedRevision);
  if (candidates.some(binding => !COMMAND_ID.test(binding.command_id) || !COMMAND_ID.test(binding.request_id) ||
      binding.step_digest !== step.definition_digest || binding.operation !== step.operation)) return unknown;

  if (step.status === "not_selected" && step.binding_source_revision_digest === undefined) {
    if (candidates.length === 0) return { index, status: "pending" };
    // J keeps unexecuted withdrawals as history. Multiple invalidated records must not hide the current interrupted review.
    if (!candidates.every(binding => binding.status === "invalidated" && !binding.execution_ticket_digest &&
         !binding.result_digest && !binding.delivery_digest && binding.memory_status === "not_recorded")) return unknown;
    const last = candidates.at(-1)!;
    const evidence = ownerTaskStepEvidence(last, auditByRequest.get(last.request_id) ?? []);
    const recovery = input.lookupApprovalState(last.command_id, last.request_id);
    if (evidence?.pendingApproval && (recovery === "outcome_unknown" || recovery === "interrupted")) return { index, status: recovery };
    return unknown;
  }

  const matching = candidates.filter(binding => binding.status === step.status);
  const binding = matching[0];
  if (!binding || matching.length !== 1) return unknown;
  const evidence = ownerTaskStepEvidence(binding, auditByRequest.get(binding.request_id) ?? []);
  if (!evidence) return unknown;

  const isPending = pending.has(binding.command_id);
  const isActive = active.has(binding.command_id);
  if (isPending && isActive) return unknown;
  if (isPending && binding.status === "selected" && evidence.pendingApproval) return { index, status: "awaiting_approval" };
  if (isActive && (binding.status === "selected" || binding.status === "intent_committed")) return { index, status: "active" };

  const commandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", binding.command_id])).digest("hex");
  const receipt = input.lookupCommand(commandKey);
  if (binding.status === "outcome_unknown") return { index, status: "outcome_unknown" };
  if (!receipt) {
    const recovery = input.lookupApprovalState(binding.command_id, binding.request_id);
    if (evidence.pendingApproval && (recovery === "outcome_unknown" || recovery === "interrupted")) return { index, status: recovery };
    return binding.status === "invalidated" && recovery === null ? { index, status: "held" } : unknown;
  }
  if (!ownerTaskStepReceiptMatches(receipt, commandKey, plan, binding)) return unknown;
  if (receipt.state === "outcome_unknown" || receipt.result_delivery_disposition === "stale_generation_evidence") {
    return { index, status: "outcome_unknown" };
  }
  if (receipt.state === "not_attempted") return { index, status: "not_attempted" };
  if (receipt.state !== "adapter_returned" || receipt.invocation_boundary !== "tool_adapter" || !receipt.feedback_status ||
      evidence.feedback.length !== 1 || evidence.feedback[0]?.status !== receipt.feedback_status) return unknown;
  if (receipt.feedback_status === "success" && binding.status === "verified" && binding.result_digest && binding.delivery_digest &&
      binding.memory_status === "receipt_confirmed" && binding.memory_receipt_digest &&
      receipt.result_delivery_digest === binding.delivery_digest && receipt.result_delivery_acknowledged === true &&
      receipt.result_delivery_disposition === "reconciled" && input.confirmResultMemory(binding.command_id)) {
    const resultRef = step.saved_result_return_supported === true && plan.goal_purpose_binding_status === "current" &&
        !plan.recovery_hold_reason && DIGEST.test(plan.plan_id) && DIGEST.test(plan.revision_digest) &&
        DIGEST.test(step.step_id) && DIGEST.test(binding.command_digest) &&
        DIGEST.test(binding.result_digest) && DIGEST.test(binding.memory_receipt_digest)
      ? operationPlanDigest(["owner-task-saved-result.v1", input.requestId, index, plan.plan_id, plan.revision_digest,
          step.step_id, binding.revision_digest, binding.command_digest, binding.result_digest, binding.memory_receipt_digest])
      : undefined;
    return { index, status: "adapter_returned", feedback_status: "success", verification: "result_and_memory_confirmed",
      ...(resultRef ? { result_ref: resultRef } : {}) };
  }
  return { index, status: "adapter_returned", feedback_status: receipt.feedback_status };
}

function currentOwnerTaskPlan(input: OwnerTaskPlanStepsInput): ProjectedPlan | undefined {
  const { requestId, operationPlans } = input;
  if (!REQUEST_ID.test(requestId) || operationPlans?.recovery_refresh_status !== "ready") return undefined;
  const matches = operationPlans.plans.filter(plan => matchesWebChatTaskPlan(plan, requestId, WEBCHAT_OWNER_TASK_DIGEST));
  const plan = matches[0];
  if (matches.length !== 1 || !plan || plan.steps.length < 1 || plan.steps.length > MAX_OWNER_TASK_PLAN_STEPS ||
      new Set(plan.steps.map(step => step.step_id)).size !== plan.steps.length) return undefined;
  return plan;
}

function ownerTaskPlanStepEvidence(input: OwnerTaskPlanStepsInput, plan: ProjectedPlan) {
  const requests = new Set(plan.bindings.map(binding => binding.request_id));
  const auditByRequest = new Map<string, AuditEntry["log"][]>();
  for (const { log } of input.verifiedAudit) {
    if (!("request_id" in log) || typeof log.request_id !== "string" || !requests.has(log.request_id)) continue;
    const entries = auditByRequest.get(log.request_id) ?? [];
    entries.push(log);
    auditByRequest.set(log.request_id, entries);
  }
  return { auditByRequest, pending: new Set(input.pendingCommandIds), active: new Set(input.activeCommandIds) };
}

/** Jの現行計画に限り、同じ受付の後続ステップをBroker・承認台帳・Mの観測に対応させる。 */
export function projectOwnerTaskPlanSteps(input: OwnerTaskPlanStepsInput): WebChatOwnerTaskPlanSteps {
  const noAuthority = { used_for_authority: false, may_execute: false } as const;
  const plan = currentOwnerTaskPlan(input);
  if (!plan) return { status: "unknown", ...noAuthority };
  const { auditByRequest, pending, active } = ownerTaskPlanStepEvidence(input, plan);
  return { status: "available", ...noAuthority,
    steps: plan.steps.map((step, index) => projectOwnerTaskPlanStep(input, plan, step, index + 1, auditByRequest, pending, active)) };
}

/** 受付が保持する現行計画から、同じ結果を選んだ場合だけJ向け制御値を組み立てる。 */
export function resolveOwnerTaskSavedResult(input: OwnerTaskPlanStepsInput, stepIndex: number, resultRef: string):
  { plan_id: string; revision_digest: string; step_id: string } | undefined {
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 1 || stepIndex > MAX_OWNER_TASK_PLAN_STEPS || !DIGEST.test(resultRef)) {
    return undefined;
  }
  const plan = currentOwnerTaskPlan(input);
  const step = plan?.steps[stepIndex - 1];
  if (!plan || !step) return undefined;
  const { auditByRequest, pending, active } = ownerTaskPlanStepEvidence(input, plan);
  const observation = projectOwnerTaskPlanStep(input, plan, step, stepIndex, auditByRequest, pending, active);
  if (observation.status !== "adapter_returned" || observation.feedback_status !== "success" ||
      observation.result_ref !== resultRef) return undefined;
  return { plan_id: plan.plan_id, revision_digest: plan.revision_digest, step_id: step.step_id };
}

function projectRequestCommandIds(
  operationPlans: unknown,
  requestId: string,
  ownerIdentityDigest: string,
): D4RuntimeRequestCommandIdsProjection {
  if (ownerIdentityDigest === WEBCHAT_OWNER_TASK_DIGEST) {
    return projectOwnerTaskRequestCommandIds(operationPlans, requestId);
  }
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
    if (binding.request_id === requestId) commandIds.add(binding.command_id);
  }
  return { status: "matched", command_ids: [...commandIds] };
}

export function projectD4RuntimeRequestCommandIds(operationPlans: unknown, requestId: string): D4RuntimeRequestCommandIdsProjection {
  return projectRequestCommandIds(operationPlans, requestId, D4_RUNTIME_OWNER_DIGEST);
}

/** 元の受付からJが同じ仕事として保持した計画・審査だけを取消範囲へ含める。 */
export function projectOwnerTaskRequestCommandIds(operationPlans: unknown, requestId: string): OwnerTaskCancellationScopeProjection {
  if (!REQUEST_ID.test(requestId) || !isRecord(operationPlans) || !Array.isArray(operationPlans.plans)) {
    return { status: "invalid" };
  }
  const unversioned = ["schema_version", "used_for_authority", "raw_payload_exposed", "recovery_refresh_status"]
    .every((key) => !Object.hasOwn(operationPlans, key));
  if (!unversioned && (operationPlans.schema_version !== "operation-plan-projection.v1" ||
      operationPlans.used_for_authority !== false || operationPlans.raw_payload_exposed !== false ||
      operationPlans.recovery_refresh_status !== "ready")) return { status: "invalid" };

  const original = operationPlans.plans.filter((plan) => matchesWebChatTaskPlan(plan, requestId, WEBCHAT_OWNER_TASK_DIGEST));
  if (original.length === 0) return { status: "not_found" };
  if (original.length !== 1) return { status: "ambiguous" };
  const root = original[0]!;
  const scope = [root];
  const plans: OwnerTaskCancellationPlanReference[] = [];
  if (!unversioned && root.goal_purpose_binding !== undefined) {
    const purpose = OperationPlanGoalPurposeBindingSchema.safeParse(root.goal_purpose_binding);
    const taskIdentity = root.task_identity_digest;
    if (!purpose.success || typeof taskIdentity !== "string" || !DIGEST.test(taskIdentity)) return { status: "invalid" };
    const { goal_ref, purpose_version, purpose_digest } = purpose.data;
    const planIds = new Set<string>();
    const requestIds = new Set<string>();
    for (const plan of operationPlans.plans) {
      if (!isRecord(plan) || plan.task_identity_digest !== taskIdentity ||
          plan.owner_identity_digest !== WEBCHAT_OWNER_TASK_DIGEST || plan.channel_identity_digest !== WEBCHAT_CHANNEL_DIGEST) continue;
      const binding = OperationPlanGoalPurposeBindingSchema.safeParse(plan.goal_purpose_binding);
      if (!binding.success || binding.data.goal_ref !== goal_ref || binding.data.purpose_version !== purpose_version ||
          binding.data.purpose_digest !== purpose_digest) return { status: "invalid" };
      const { plan_id, request_id, revision_digest, previous_revision_digests } = plan;
      if (typeof plan_id !== "string" || !DIGEST.test(plan_id) || typeof request_id !== "string" || !COMMAND_ID.test(request_id) ||
          typeof revision_digest !== "string" || !DIGEST.test(revision_digest) || !Array.isArray(previous_revision_digests) ||
          previous_revision_digests.some((value) => typeof value !== "string" || !DIGEST.test(value)) ||
          new Set([revision_digest, ...previous_revision_digests]).size !== previous_revision_digests.length + 1) {
        return { status: "invalid" };
      }
      if (planIds.has(plan_id) || requestIds.has(request_id)) return { status: "ambiguous" };
      planIds.add(plan_id);
      requestIds.add(request_id);
      plans.push({ plan_id, revision_digest, previous_revision_digests, goal_purpose_binding: binding.data });
      if (plan !== root) scope.push(plan);
    }
  }

  const commandIds = new Set<string>();
  for (const { bindings } of scope) {
    if (!Array.isArray(bindings)) return { status: "invalid" };
    for (const binding of bindings) {
      if (!isRecord(binding) || typeof binding.request_id !== "string" || typeof binding.command_id !== "string" ||
          !COMMAND_ID.test(binding.command_id)) return { status: "invalid" };
      if (!unversioned && commandIds.has(binding.command_id)) return { status: "ambiguous" };
      commandIds.add(binding.command_id);
    }
  }
  return { status: "matched", command_ids: [...commandIds], plans };
}

function matchesOwnerTaskPurpose(decision: DecisionLog, purpose: OperationPlanGoalPurposeBinding): boolean {
  const binding = decision.goal_purpose_binding;
  return binding?.goal_id_digest === createHash("sha256").update(purpose.goal_ref, "utf8").digest("hex") &&
    binding.purpose_version === purpose.purpose_version && binding.purpose_digest === purpose.purpose_digest;
}

/** 検証済みJ監査から、同じ受付と目的版に属する計画保存前の計算コマンドを照合する。 */
export function projectOwnerTaskCancellationScope(
  operationPlans: unknown, requestId: string, verifiedAudit: readonly AuditEntry[],
): OwnerTaskAuditedCancellationScopeProjection {
  const scope = projectOwnerTaskRequestCommandIds(operationPlans, requestId);
  if (scope.status === "ambiguous" || scope.status === "invalid") return scope;
  const plans = scope.status === "matched" ? scope.plans : [];
  const root = (operationPlans as OperationPlans).plans.find(plan => matchesWebChatTaskPlan(plan, requestId, WEBCHAT_OWNER_TASK_DIGEST));
  const plansById = new Map(plans.map(plan => [plan.plan_id, plan]));
  const rootPurpose = root && plansById.get(root.plan_id)?.goal_purpose_binding;
  const decisionsByRequest = new Map<string, DecisionLog[]>();
  const gatesByRequest = new Map<string, Extract<AuditEntry["log"], { kind: "approval_gate" }>[]>();
  for (const { log } of verifiedAudit) {
    if (!("kind" in log)) {
      const decisions = decisionsByRequest.get(log.request_id) ?? [];
      decisions.push(log);
      decisionsByRequest.set(log.request_id, decisions);
    } else if (log.kind === "approval_gate" && log.request_id !== null) {
      const gates = gatesByRequest.get(log.request_id) ?? [];
      gates.push(log);
      gatesByRequest.set(log.request_id, gates);
    }
  }

  const computeCommands = new Set<string>();
  const existingCommands = new Set(scope.status === "matched" ? scope.command_ids : []);
  for (const [sourceRequestId, decisions] of decisionsByRequest) {
    const selected = decisions.filter(decision => {
      const actor = decision.frame.actor;
      const provenance = decision.owner_task_compute_cancellation_binding;
      if (!provenance || provenance.used_for_authority !== false || provenance.may_execute !== false ||
          actor.channel !== "webchat" || operationPlanDigest(actor.actor_id) !== WEBCHAT_OWNER_TASK_DIGEST ||
          decision.commit.decision !== "ASSERT") return false;
      const owner = actor.actor_kind === "owner" && actor.trust_level === "owner";
      if (sourceRequestId === requestId) {
        return owner && provenance.kind === "initial" && decision.memory_capture_suppressed_for === "operation_plan_compute" &&
          ExecutionGoalVersionBindingSchema.safeParse(decision.goal_purpose_binding).success &&
          (!rootPurpose || matchesOwnerTaskPurpose(decision, rootPurpose));
      }
      const waitDeadline = provenance.kind === "wait_resume" && actor.actor_kind === "system" && actor.trust_level === "trusted";
      if (provenance.kind === "initial" || !root || provenance.task_identity_digest !== root.task_identity_digest ||
          (!owner && !waitDeadline)) return false;
      const parent = plansById.get(provenance.plan_id_digest);
      return parent !== undefined && (parent.revision_digest === provenance.revision_digest ||
        parent.previous_revision_digests.includes(provenance.revision_digest)) &&
        matchesOwnerTaskPurpose(decision, parent.goal_purpose_binding);
    });
    if (!selected.length) continue;
    if (decisions.length !== 1) return { status: "ambiguous" };
    const decision = selected[0]!;
    const commandIds = new Set((gatesByRequest.get(sourceRequestId) ?? []).flatMap(gate =>
      gate.upstream_commit_hash === decision.commit.hash && gate.evaluation.context.command_id === gate.command_id &&
        gate.evaluation.context.upstream_commit_hash === decision.commit.hash && gate.evaluation.context.actor === decision.frame.actor.actor_id &&
        gate.evaluation.context.command_type === "llm_call" ? [gate.command_id] : []));
    if (commandIds.size > 1) return { status: "ambiguous" };
    const [commandId] = commandIds;
    if (!commandId || !COMMAND_ID.test(commandId)) continue;
    if (decision.owner_task_compute_cancellation_binding?.command_id !== commandId) continue;
    if (existingCommands.has(commandId) || computeCommands.has(commandId)) return { status: "ambiguous" };
    computeCommands.add(commandId);
  }

  if (scope.status === "not_found" && computeCommands.size === 0) return scope;
  return { status: "matched", plans, command_ids: [...existingCommands, ...computeCommands], compute_command_ids: [...computeCommands] };
}

function unknownCancellationStatus(
  reason_code: Extract<WebChatD4RuntimeCancellationStatus, { status: "unknown" }>["reason_code"],
): WebChatD4RuntimeCancellationStatus {
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
  scopedCommandIds: readonly string[] = [],
): WebChatD4RuntimeCancellationStatus {
  return projectTaskCancellationStatus(
    operationPlans, requestId, observations, WEBCHAT_OWNER_TASK_DIGEST, ["owner_task", "resume"], scopedCommandIds,
  );
}

function projectTaskCancellationStatus(
  operationPlans: unknown,
  requestId: string,
  observations: readonly TaskExecutionCancellationEvidence[],
  ownerIdentityDigest: string,
  tokenKinds: readonly TaskExecutionCancellationEvidence["token_kind"][],
  scopedCommandIds: readonly string[] = [],
): WebChatD4RuntimeCancellationStatus {
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
  scopedCommandIds: readonly string[] = [],
): D4RuntimeActiveCommandProjection {
  return projectRequestActiveCommand(operationPlans, requestId, activeCommandIds, WEBCHAT_OWNER_TASK_DIGEST, scopedCommandIds);
}

function projectRequestActiveCommand(
  operationPlans: unknown,
  requestId: string,
  activeCommandIds: ReadonlySet<string>,
  ownerIdentityDigest: string,
  scopedCommandIds: readonly string[] = [],
): D4RuntimeActiveCommandProjection {
  const binding = projectRequestCommandIds(operationPlans, requestId, ownerIdentityDigest);
  if (binding.status === "ambiguous") return { status: "ambiguous" };
  if (binding.status === "invalid" || scopedCommandIds.some(id => typeof id !== "string" || !COMMAND_ID.test(id))) return { status: "invalid" };
  const commandIds = new Set(binding.status === "matched" ? [...binding.command_ids, ...scopedCommandIds] : scopedCommandIds);
  const activeBindings = [...commandIds].filter((commandId) => activeCommandIds.has(commandId));
  if (activeBindings.length === 0) return { status: "not_active" };
  if (activeBindings.length !== 1) return { status: "ambiguous" };
  return { status: "matched", command_id: activeBindings[0]! };
}

/** Maps one owner-submitted WebChat task's J assessment into a content-free, non-authority status. */
export function projectOwnerTaskOutcome(operationPlans: unknown, requestId: string): WebChatTaskOutcome {
  return projectTaskOutcome(operationPlans, requestId, WEBCHAT_OWNER_TASK_DIGEST);
}
