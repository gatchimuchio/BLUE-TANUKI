import { createHash } from "node:crypto";
import type {
  ApprovalGrant,
  CompleteHistoryEntry,
  CompleteHistoryKind,
  DecisionLog,
} from "@blue-tanuki/hds-brain";
import type {
  WebChatApprovalGrantItem,
  WebChatApprovalHistoryItem,
  WebChatHistoryEntry,
} from "@blue-tanuki/channel-webchat";
import {
  OperationCoreApprovalTraceSchema,
  OperationCoreExecutorTraceSchema,
  OperationCoreExecutionProjectionSchema,
  OperationCorePlannerExecutionProjectionSchema,
  OperationPlanSchema,
  OperationPlanComputeSourceObservationSchema,
  ComputeResourceUseSchema,
  prepareOperationPlan,
  inspectOperationCommandExecutionResult,
  type ExecuteCommand,
  type ExecuteFeedback,
  type OperationCoreApprovalTrace,
  type OperationCoreExecutionProjection,
  type OperationCorePlannerExecutionProjection,
  type OperationCommandExecutionResult,
  type OperationPlanComputeSourceObservation,
  type ComputeResourceUse,
} from "@blue-tanuki/protocol";
import { commandFailurePatterns, operationPlanDigest } from "@blue-tanuki/hds-brain";

export function metadataKeys(meta: Record<string, unknown> | undefined): string[] {
  return Object.keys(meta ?? {}).sort();
}

const WEBCHAT_OWNER_TOKEN_ACTOR_IDENTITY_DIGEST = operationPlanDigest("webchat-owner-token-holder");
const WEBCHAT_CHANNEL_IDENTITY_DIGEST = operationPlanDigest("webchat");

export function hdsDecisionHistoryPayload(
  log: DecisionLog,
  command: ExecuteCommand | null,
): Record<string, unknown> {
  return {
    decision: log.commit.decision,
    reason: log.commit.reason,
    commit_hash: log.commit.hash,
    triggered_thresholds: log.commit.triggered_thresholds,
    input_changed: log.input?.changed ?? false,
    normalized_content_digest: log.input?.normalized_content
      ? digestString(log.input.normalized_content)
      : undefined,
    control_chars: log.input?.controls.map((control) => ({
      index: control.index,
      code_point: control.code_point,
      kind: control.kind,
      name: control.name,
    })) ?? [],
    actor: {
      actor_kind: log.frame.actor.actor_kind,
      channel: log.frame.actor.channel,
      trust_level: log.frame.actor.trust_level,
    },
    process: {
      process_id: log.frame.process.process_id,
      process_kind: log.frame.process.process_kind,
      trigger_kind: log.frame.process.trigger.kind,
      approval_profile: log.frame.process.approval_profile,
      execution_policy: {
        allowed_command_types: log.frame.process.execution_policy.allowed_command_types,
        allowed_tools: log.frame.process.execution_policy.allowed_tools,
        allowed_capabilities: log.frame.process.execution_policy.allowed_capabilities,
        timeout_ms: log.frame.process.execution_policy.timeout_ms,
      },
    },
    operator_surface: log.frame.operator_surface,
    memory_trace: {
      policy_id: log.frame.memory_trace.policy_id,
      hits: log.frame.memory_trace.hits.length,
      used_for_authority: log.frame.memory_trace.used_for_authority,
    },
    model: {
      abstraction: log.model.abstraction,
      scoring_aggregate: log.model.scoring.aggregate,
      axis_count: log.model.scoring.axis_scores.length,
    },
    command: command ? commandHistoryDescriptor(command) : null,
  };
}

export function commandHistoryDescriptor(command: ExecuteCommand): Record<string, unknown> {
  const base = {
    command_id: command.id,
    type: command.type,
    operation: commandOperation(command),
    upstream_commit_hash: command.upstream_decision.commit_hash,
    upstream_decision: command.upstream_decision.commit_decision,
    failure_patterns: commandFailurePatterns(command),
    constraints: {
      max_tokens: command.constraints?.max_tokens,
      timeout_ms: command.constraints?.timeout_ms,
      allowed_tools: command.constraints?.allowed_tools,
      allowed_capabilities: command.constraints?.allowed_capabilities,
    },
  };
  if (command.type === "tool_call") {
    return {
      ...base,
      payload: {
        tool_name: command.payload.tool_name,
        argument_keys: Object.keys(command.payload.arguments).sort(),
        arguments_digest: digestValue(command.payload.arguments),
      },
    };
  }
  if (command.type === "llm_call") {
    return {
      ...base,
      payload: {
        messages_count: command.payload.messages.length,
        message_roles: command.payload.messages.map((message) => message.role),
        messages_digest: digestValue(command.payload.messages),
        backend_hint: command.payload.backend_hint,
        model: command.payload.model,
        temperature: command.payload.temperature,
        session_id_digest: command.payload.session_id
          ? digestString(command.payload.session_id)
          : undefined,
      },
    };
  }
  if (command.type === "channel_send") {
    return {
      ...base,
      payload: {
        channel: command.payload.channel,
        target_digest: digestString(command.payload.target),
        content_digest: digestString(command.payload.content),
        content_chars: command.payload.content.length,
      },
    };
  }
  return {
    ...base,
    payload: {},
  };
}

export function isComposioExecuteCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "composio.execute";
}

const COMPLETE_HISTORY_KINDS: readonly CompleteHistoryKind[] = [
  "user_input",
  "llm_history",
  "hds_decision",
  "approval_history",
  "execution_history",
  "audit_history",
  "final_output",
];

export function isCompleteHistoryKind(value: unknown): value is CompleteHistoryKind {
  return typeof value === "string" && COMPLETE_HISTORY_KINDS.includes(value as CompleteHistoryKind);
}

export function projectCompleteHistoryEntry(entry: CompleteHistoryEntry): WebChatHistoryEntry {
  return {
    schema_version: entry.schema_version,
    index: entry.index,
    id: entry.id,
    kind: entry.kind,
    request_id: entry.request_id,
    command_id: entry.command_id,
    actor: entry.actor,
    source: entry.source,
    payload_digest: entry.payload_digest,
    used_for_authority: false,
    timestamp: entry.timestamp,
    prev_hash: entry.prev_hash,
    entry_hash: entry.entry_hash,
  };
}

export function projectOperationCoreExecutionHistory(
  entries: readonly CompleteHistoryEntry[],
  opts: { chain_valid: boolean; skipped_count: number; limit?: number },
): OperationCoreExecutionProjection {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 6));
  const executionEntries = entries.filter((entry) => entry.kind === "execution_history");
  const latestResults = executionEntries
    .slice(-limit)
    .reverse()
    .map(projectOperationCoreExecutionEntry);
  return OperationCoreExecutionProjectionSchema.parse({
    schema_version: "operation-core.execution.v1",
    evidence_source: ["INTERNAL_STATE"],
    used_for_authority: false,
    adapter_result_used_for_authority: false,
    execution_history_used_for_authority: false,
    raw_payload_exposed: false,
    chain_valid: opts.chain_valid === true,
    skipped_count: opts.skipped_count,
    entries_count: executionEntries.length,
    displayed_count: latestResults.length,
    latest_results: latestResults,
  });
}

export interface OperationPlanStatusProjection {
  schema_version: "operation-plan.status.v1";
  evidence_source: ["INTERNAL_STATE"];
  used_for_authority: false;
  raw_payload_exposed: false;
  status: "available" | "unavailable";
  recovery_refresh_status: "ready" | "pending" | "unavailable";
  plan_count: number;
  displayed_count: number;
  goal_purpose_options: Array<{
    goal_ref: string;
    goal_kind: "delegated" | "operational" | "subgoal";
    purpose_version: number;
    purpose_digest: string;
    parent_alignment_status: "not_applicable" | "aligned" | "requires_review";
  }>;
  waits: Array<{
    wait_id: string;
    plan_id: string;
    revision_digest?: string;
    task_identity_digest: string;
    owner_authentication_required: boolean;
    owner_reauthentication_binding?: { owner_identity_digest: string; channel_identity_digest: string };
    state: "waiting" | "resumed";
    deadline_at_ms: number;
    recovery_hold_reason?: "held_residual" | "held_unobserved" | "held_unverified";
    resumed_at_ms?: number;
    wake_reason?: "reply" | "deadline" | "recovery";
    compute_outcome: "not_started" | "pending" | "interrupted" | "candidate_retained" | "candidate_rejected" | "failed" | "not_recorded";
    compute_result_digest?: string;
    candidate_plan_id?: string;
    compute_completed_at_ms?: number;
    compute_interrupted_at_ms?: number;
    compute_resource_use?: Pick<ComputeResourceUse,
      "charged_compute_ms" | "charged_tokens" | "tokens_usage_status" | "cost_status" |
      "charged_cost_amount" | "currency" | "charge_basis" | "used_for_authority" | "may_execute">;
    resource_review_required: boolean;
    used_for_authority: false;
    may_execute: false;
  }>;
  plans: Array<{
    plan_id: string;
    task_identity_digest?: string;
    revision: number;
    revision_digest: string;
    status: "awaiting_step_review" | "results_verified";
    owner_authentication_required: boolean;
    owner_reauthentication_binding?: { owner_identity_digest: string; channel_identity_digest: string };
    goal_purpose_binding?: { goal_ref: string; purpose_version: number; purpose_digest: string };
    goal_purpose_binding_status: "not_configured" | "required" | "current" | "stale";
    goal_purpose_relation?: {
      status: "not_required" | "unavailable" | "stale" | "unverified" | "conflicts" | "owner_reviewed_supports" | "owner_reviewed_unknown";
      candidate_outcome?: "supports" | "conflicts" | "unknown";
      candidate_status?: "present" | "missing" | "invalid";
      evidence_status?: "exact_spans_present" | "not_provided" | "citation_mismatch" | "purpose_unavailable";
      evidence_count?: number;
      owner_review_status?: "not_reviewed" | "verified" | "invalid";
      owner_review_outcome?: "supports" | "conflicts" | "unknown";
      semantic_assessment_status?: "not_assessed";
      record_digest?: string;
      used_for_authority: false;
      may_execute: false;
    };
    compute_source_observations?: OperationPlanComputeSourceObservation[];
    recovery_hold_reason?: "held_residual" | "held_unobserved" | "held_unverified";
    recovery_hold_scope_relation?: "requested" | "collateral" | "unknown";
    step_count: number;
    steps: Array<{
      step_id: string;
      operation: string;
      status: "not_selected" | "selected" | "intent_committed" | "outcome_unknown" | "not_attempted" | "verified" | "verification_failed" | "invalidated";
      external_receipt_observation: "not_applicable" | "not_recorded" | "matched" | "not_found" | "mismatch" | "ambiguous";
      external_receipt?: {
        source: "local_inspection";
        match_count: number;
        evidence_digest: string;
        receipt_digest?: string;
        observed_at_ms: number;
        used_for_authority: false;
        raw_receipt_exposed: false;
      };
      binding?: {
        command_digest: string;
        result_digest?: string;
        delivery_digest?: string;
        memory_status: "not_recorded" | "memory_commit_pending" | "receipt_confirmed";
      };
    }>;
  }>;
}

const OPERATION_PLAN_STEP_STATUSES = new Set([
  "not_selected", "selected", "intent_committed", "outcome_unknown", "not_attempted",
  "verified", "verification_failed", "invalidated",
]);

function invalidOperationPlanStatusProjection(): OperationPlanStatusProjection {
  return {
    schema_version: "operation-plan.status.v1", evidence_source: ["INTERNAL_STATE"],
    used_for_authority: false, raw_payload_exposed: false, status: "unavailable",
    recovery_refresh_status: "unavailable",
    plan_count: 0, displayed_count: 0, goal_purpose_options: [], waits: [], plans: [],
  };
}

/** Current J plan state for the existing operator view; it omits goals, targets, and arguments. */
export function projectOperationPlanStatus(value: unknown): OperationPlanStatusProjection {
  if (!isRecord(value) || value.schema_version !== "operation-plan-projection.v1" ||
      value.used_for_authority !== false || value.raw_payload_exposed !== false || !Array.isArray(value.plans)) {
    return invalidOperationPlanStatusProjection();
  }
  const recoveryRefreshStatus = value.recovery_refresh_status === undefined
    ? "ready"
    : value.recovery_refresh_status;
  if (recoveryRefreshStatus !== "ready" && recoveryRefreshStatus !== "pending") {
    return invalidOperationPlanStatusProjection();
  }
  const rawGoalPurposeOptions = value.goal_purpose_options === undefined ? [] : value.goal_purpose_options;
  if (!Array.isArray(rawGoalPurposeOptions) || rawGoalPurposeOptions.length > 256 || !rawGoalPurposeOptions.every(isRecord)) {
    return invalidOperationPlanStatusProjection();
  }
  const goalPurposeOptions: OperationPlanStatusProjection["goal_purpose_options"] = [];
  for (const option of rawGoalPurposeOptions as Record<string, unknown>[]) {
    if (Object.keys(option).some((key) => !["goal_ref", "goal_kind", "purpose_version", "purpose_digest", "parent_alignment_status"].includes(key)) ||
        typeof option.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(option.goal_ref) ||
        !["delegated", "operational", "subgoal"].includes(String(option.goal_kind)) ||
        !Number.isSafeInteger(option.purpose_version) || (option.purpose_version as number) < 1 || !isDigest(option.purpose_digest) ||
        !["not_applicable", "aligned", "requires_review"].includes(String(option.parent_alignment_status))) {
      return invalidOperationPlanStatusProjection();
    }
    goalPurposeOptions.push({ goal_ref: option.goal_ref, goal_kind: option.goal_kind as "delegated" | "operational" | "subgoal",
      purpose_version: option.purpose_version as number, purpose_digest: option.purpose_digest as string,
      parent_alignment_status: option.parent_alignment_status as "not_applicable" | "aligned" | "requires_review" });
  }
  const rawWaits = value.waits === undefined ? [] : value.waits;
  if (!Array.isArray(rawWaits) || rawWaits.length > 256 || !rawWaits.every(isRecord)) {
    return invalidOperationPlanStatusProjection();
  }
  const waits: OperationPlanStatusProjection["waits"] = [];
  for (const wait of rawWaits as Record<string, unknown>[]) {
    const allowedKeys = new Set(["wait_id", "plan_id", "revision_digest", "task_identity_digest", "owner_authentication_required",
      "owner_reauthentication_binding", "state", "deadline_at_ms",
      "recovery_hold_reason", "resumed_at_ms", "wake_reason", "compute_outcome", "compute_result_digest", "candidate_plan_id",
      "compute_completed_at_ms", "compute_interrupted_at_ms", "compute_resource_use", "used_for_authority", "may_execute"]);
    const state = wait.state;
    const outcome = wait.compute_outcome;
    const resumed = state === "resumed";
    const resumedAt = wait.resumed_at_ms;
    const completedAt = wait.compute_completed_at_ms;
    const interruptedAt = wait.compute_interrupted_at_ms;
    const parsedResourceUse = wait.compute_resource_use === undefined
      ? undefined : ComputeResourceUseSchema.safeParse(wait.compute_resource_use);
    const resourceUse = parsedResourceUse?.success ? parsedResourceUse.data : undefined;
    const ownerReauthenticationBinding = wait.owner_reauthentication_binding;
    if (Object.keys(wait).some((key) => !allowedKeys.has(key)) || !isDigest(wait.wait_id) || !isDigest(wait.plan_id) ||
        (wait.revision_digest !== undefined && !isDigest(wait.revision_digest)) || !isDigest(wait.task_identity_digest) || (state !== "waiting" && !resumed) ||
        (wait.owner_authentication_required !== undefined && typeof wait.owner_authentication_required !== "boolean") ||
        (ownerReauthenticationBinding !== undefined && (!isRecord(ownerReauthenticationBinding) ||
          Object.keys(ownerReauthenticationBinding).some((key) => !["owner_identity_digest", "channel_identity_digest"].includes(key)) ||
          !isDigest(ownerReauthenticationBinding.owner_identity_digest) || !isDigest(ownerReauthenticationBinding.channel_identity_digest))) ||
        !Number.isSafeInteger(wait.deadline_at_ms) || (wait.deadline_at_ms as number) < 0 ||
        (wait.recovery_hold_reason !== undefined &&
          !["held_residual", "held_unobserved", "held_unverified"].includes(String(wait.recovery_hold_reason))) ||
        wait.used_for_authority !== false || wait.may_execute !== false ||
        (resumed && (!Number.isSafeInteger(resumedAt) || (resumedAt as number) < 0 ||
          !["reply", "deadline", "recovery"].includes(String(wait.wake_reason)))) ||
        (!resumed && (resumedAt !== undefined || wait.wake_reason !== undefined)) ||
        (outcome !== "not_started" && outcome !== "pending" && outcome !== "interrupted" && outcome !== "candidate_retained" &&
          outcome !== "candidate_rejected" && outcome !== "failed" && outcome !== "not_recorded") ||
        (state === "waiting" && outcome !== "not_started") ||
        (resumed && outcome === "not_started") ||
        (wait.compute_result_digest !== undefined && !isDigest(wait.compute_result_digest)) ||
        (wait.candidate_plan_id !== undefined && !isDigest(wait.candidate_plan_id)) ||
        (completedAt !== undefined && (!Number.isSafeInteger(completedAt) || (completedAt as number) < (resumedAt as number))) ||
        (interruptedAt !== undefined && (!Number.isSafeInteger(interruptedAt) || (interruptedAt as number) < (resumedAt as number))) ||
        ((outcome === "interrupted") !== (interruptedAt !== undefined)) ||
        ((outcome === "candidate_retained" || outcome === "candidate_rejected" || outcome === "failed") !== (completedAt !== undefined)) ||
        ((outcome === "candidate_retained") !== (wait.candidate_plan_id !== undefined)) ||
        (outcome === "pending" && (wait.compute_result_digest !== undefined || wait.candidate_plan_id !== undefined || completedAt !== undefined)) ||
        (outcome === "interrupted" && (wait.compute_result_digest !== undefined || wait.candidate_plan_id !== undefined || completedAt !== undefined)) ||
        ((outcome === "not_started" || outcome === "not_recorded") &&
          (wait.compute_result_digest !== undefined || wait.candidate_plan_id !== undefined || completedAt !== undefined || interruptedAt !== undefined)) ||
        (wait.compute_resource_use !== undefined && (!resourceUse || completedAt === undefined))) {
      return invalidOperationPlanStatusProjection();
    }
    const resourceReviewRequired = Boolean(resourceUse &&
      (outcome === "candidate_rejected" || outcome === "failed") &&
      (resourceUse.charged_compute_ms > 0 || resourceUse.charged_tokens > 0 || resourceUse.charged_cost_amount > 0));
    waits.push({ wait_id: wait.wait_id as string, plan_id: wait.plan_id as string,
      ...(typeof wait.revision_digest === "string" ? { revision_digest: wait.revision_digest } : {}),
      task_identity_digest: wait.task_identity_digest as string, state: state as "waiting" | "resumed",
      owner_authentication_required: wait.owner_authentication_required === true,
      ...(isRecord(ownerReauthenticationBinding) ? { owner_reauthentication_binding: {
        owner_identity_digest: ownerReauthenticationBinding.owner_identity_digest as string,
        channel_identity_digest: ownerReauthenticationBinding.channel_identity_digest as string,
      } } : {}),
      deadline_at_ms: wait.deadline_at_ms as number,
      ...(wait.recovery_hold_reason === "held_residual" || wait.recovery_hold_reason === "held_unobserved" ||
        wait.recovery_hold_reason === "held_unverified" ? { recovery_hold_reason: wait.recovery_hold_reason } : {}),
      ...(typeof resumedAt === "number" ? { resumed_at_ms: resumedAt } : {}),
      ...(wait.wake_reason === "reply" || wait.wake_reason === "deadline" || wait.wake_reason === "recovery"
        ? { wake_reason: wait.wake_reason } : {}),
      compute_outcome: outcome as OperationPlanStatusProjection["waits"][number]["compute_outcome"],
      ...(typeof wait.compute_result_digest === "string" ? { compute_result_digest: wait.compute_result_digest } : {}),
      ...(typeof wait.candidate_plan_id === "string" ? { candidate_plan_id: wait.candidate_plan_id } : {}),
      ...(typeof completedAt === "number" ? { compute_completed_at_ms: completedAt } : {}),
      ...(typeof interruptedAt === "number" ? { compute_interrupted_at_ms: interruptedAt } : {}),
      ...(resourceUse ? { compute_resource_use: {
        charged_compute_ms: resourceUse.charged_compute_ms,
        charged_tokens: resourceUse.charged_tokens,
        tokens_usage_status: resourceUse.tokens_usage_status,
        cost_status: resourceUse.cost_status,
        charged_cost_amount: resourceUse.charged_cost_amount,
        currency: resourceUse.currency,
        charge_basis: resourceUse.charge_basis,
        used_for_authority: false as const,
        may_execute: false as const,
      } } : {}),
      resource_review_required: resourceReviewRequired,
      used_for_authority: false, may_execute: false });
  }
  const inputPlans = value.plans;
  if (inputPlans.length > 0 && !inputPlans.every(isRecord)) return invalidOperationPlanStatusProjection();
  const plans: OperationPlanStatusProjection["plans"] = [];
  for (const plan of inputPlans.slice(-20).reverse()) {
    const revision = numberValue(plan.revision);
    const goalPurposeBinding = plan.goal_purpose_binding;
    const goalPurposeRelation = plan.goal_purpose_relation;
    const rawComputeSourceObservations = plan.compute_source_observations;
    const computeSourceObservations: OperationPlanComputeSourceObservation[] = [];
    if (rawComputeSourceObservations !== undefined) {
      if (!Array.isArray(rawComputeSourceObservations) || rawComputeSourceObservations.length > 8) {
        return invalidOperationPlanStatusProjection();
      }
      for (const observation of rawComputeSourceObservations) {
        const parsed = OperationPlanComputeSourceObservationSchema.safeParse(observation);
        if (!parsed.success) return invalidOperationPlanStatusProjection();
        computeSourceObservations.push(parsed.data);
      }
    }
    const goalPurposeBindingValid = goalPurposeBinding === undefined || (isRecord(goalPurposeBinding) &&
      Object.keys(goalPurposeBinding).length === 3 &&
      Object.keys(goalPurposeBinding).every((key) => ["goal_ref", "purpose_version", "purpose_digest"].includes(key)) &&
      typeof goalPurposeBinding.goal_ref === "string" && /^goal_[a-f0-9]{16,64}$/.test(goalPurposeBinding.goal_ref) &&
      Number.isSafeInteger(goalPurposeBinding.purpose_version) && (goalPurposeBinding.purpose_version as number) >= 1 &&
      isDigest(goalPurposeBinding.purpose_digest));
    const goalPurposeRelationValid = goalPurposeRelation === undefined || (isRecord(goalPurposeRelation) &&
      Object.keys(goalPurposeRelation).every((key) => ["status", "candidate_outcome", "candidate_status", "evidence_status",
        "evidence_count", "owner_review_status", "owner_review_outcome", "semantic_assessment_status", "record_digest",
        "used_for_authority", "may_execute"].includes(key)) &&
      ["not_required", "unavailable", "stale", "unverified", "conflicts", "owner_reviewed_supports", "owner_reviewed_unknown"]
        .includes(String(goalPurposeRelation.status)) &&
      goalPurposeRelation.used_for_authority === false && goalPurposeRelation.may_execute === false &&
      (goalPurposeRelation.candidate_outcome === undefined || ["supports", "conflicts", "unknown"].includes(String(goalPurposeRelation.candidate_outcome))) &&
      (goalPurposeRelation.candidate_status === undefined || ["present", "missing", "invalid"].includes(String(goalPurposeRelation.candidate_status))) &&
      (goalPurposeRelation.evidence_status === undefined || ["exact_spans_present", "not_provided", "citation_mismatch", "purpose_unavailable"].includes(String(goalPurposeRelation.evidence_status))) &&
      (goalPurposeRelation.evidence_count === undefined || (Number.isInteger(goalPurposeRelation.evidence_count) &&
        (goalPurposeRelation.evidence_count as number) >= 0 && (goalPurposeRelation.evidence_count as number) <= 8)) &&
      (goalPurposeRelation.owner_review_status === undefined || ["not_reviewed", "verified", "invalid"].includes(String(goalPurposeRelation.owner_review_status))) &&
      (goalPurposeRelation.owner_review_outcome === undefined || ["supports", "conflicts", "unknown"].includes(String(goalPurposeRelation.owner_review_outcome))) &&
      (goalPurposeRelation.semantic_assessment_status === undefined || goalPurposeRelation.semantic_assessment_status === "not_assessed") &&
      (goalPurposeRelation.record_digest === undefined || isDigest(goalPurposeRelation.record_digest)) &&
      (goalPurposeRelation.status !== "unverified" || (goalPurposeRelation.candidate_outcome !== undefined &&
        goalPurposeRelation.candidate_status !== undefined && goalPurposeRelation.evidence_status !== undefined &&
        goalPurposeRelation.evidence_count !== undefined && goalPurposeRelation.semantic_assessment_status === "not_assessed" &&
        isDigest(goalPurposeRelation.record_digest))) &&
      (goalPurposeRelation.status !== "not_required" || goalPurposeRelation.candidate_outcome === undefined) &&
      (!String(goalPurposeRelation.status).startsWith("owner_reviewed_") ||
        (goalPurposeRelation.owner_review_status === "verified" &&
          ((goalPurposeRelation.status === "owner_reviewed_supports" && goalPurposeRelation.owner_review_outcome === "supports") ||
            (goalPurposeRelation.status === "owner_reviewed_unknown" && goalPurposeRelation.owner_review_outcome === "unknown")))));
    if (!isDigest(plan.plan_id) || (plan.task_identity_digest !== undefined && !isDigest(plan.task_identity_digest)) ||
        !Number.isInteger(revision) || revision! < 1 || !isDigest(plan.revision_digest) ||
        !isDigest(plan.owner_identity_digest) || !isDigest(plan.channel_identity_digest) ||
        !goalPurposeBindingValid || !goalPurposeRelationValid ||
        !["not_configured", "required", "current", "stale"].includes(String(plan.goal_purpose_binding_status ??
          (goalPurposeBinding === undefined ? "not_configured" : "current"))) ||
        !["awaiting_step_review", "results_verified"].includes(String(plan.status)) ||
        (plan.recovery_hold_reason !== undefined &&
          !["held_residual", "held_unobserved", "held_unverified"].includes(String(plan.recovery_hold_reason))) ||
        (plan.recovery_hold_scope_relation !== undefined &&
          (!plan.recovery_hold_reason || !["requested", "collateral", "unknown"].includes(String(plan.recovery_hold_scope_relation)))) ||
        !Array.isArray(plan.steps) || !Array.isArray(plan.bindings) ||
        !plan.steps.every(isRecord) || !plan.bindings.every(isRecord)) return invalidOperationPlanStatusProjection();
    const bindings = plan.bindings as Record<string, unknown>[];
    const steps: OperationPlanStatusProjection["plans"][number]["steps"] = [];
    for (const step of (plan.steps as Record<string, unknown>[]).slice(0, 20)) {
      if (!isDigest(step.step_id) || !isDigest(step.definition_digest) || typeof step.operation !== "string" ||
          !/^[a-z][a-z0-9._-]{0,99}$/.test(step.operation) || typeof step.status !== "string" ||
          !OPERATION_PLAN_STEP_STATUSES.has(step.status)) return invalidOperationPlanStatusProjection();
      const observationStatus = step.external_receipt_observation;
      const observation = step.external_receipt;
      const allowedObservationStatuses = step.status === "outcome_unknown"
        ? ["not_recorded", "matched", "not_found", "mismatch", "ambiguous"]
        : ["not_applicable"];
      const observationValid = observationStatus === "not_recorded" || observationStatus === "not_applicable"
        ? observation === undefined
        : isRecord(observation) && Object.keys(observation).every((key) =>
          ["source", "match_count", "evidence_digest", "receipt_digest", "observed_at_ms", "used_for_authority", "raw_receipt_exposed"].includes(key)) &&
          observation.source === "local_inspection" && observation.used_for_authority === false && observation.raw_receipt_exposed === false &&
          Number.isInteger(observation.match_count) && (observation.match_count as number) >= 0 &&
          (observation.match_count as number) <= 100 && isDigest(observation.evidence_digest) &&
          (observation.receipt_digest === undefined || isDigest(observation.receipt_digest)) &&
          Number.isSafeInteger(observation.observed_at_ms) && (observation.observed_at_ms as number) >= 0;
      const observationStateValid = observationStatus === "not_recorded" || observationStatus === "not_applicable" ||
        (observationStatus === "matched" && isRecord(observation) && observation.match_count === 1 && isDigest(observation.receipt_digest)) ||
        (observationStatus === "not_found" && isRecord(observation) && observation.match_count === 0 && observation.receipt_digest === undefined) ||
        (observationStatus === "mismatch" && isRecord(observation) && observation.match_count === 1 && isDigest(observation.receipt_digest)) ||
        (observationStatus === "ambiguous" && isRecord(observation) && typeof observation.match_count === "number" && observation.match_count >= 2 &&
          observation.receipt_digest === undefined);
      if (typeof observationStatus !== "string" || !allowedObservationStatuses.includes(observationStatus) ||
          !observationValid || !observationStateValid) {
        return invalidOperationPlanStatusProjection();
      }
      const matching = bindings.filter((candidate) => candidate.step_id === step.step_id);
      const binding = matching.at(-1);
      if (binding && (binding.status !== step.status || !isDigest(binding.command_digest) ||
          (binding.result_digest !== undefined && !isDigest(binding.result_digest)) ||
          (binding.delivery_digest !== undefined && !isDigest(binding.delivery_digest)) ||
          !["not_recorded", "memory_commit_pending", "receipt_confirmed"].includes(String(binding.memory_status)))) {
        return invalidOperationPlanStatusProjection();
      }
      steps.push({
        step_id: step.step_id,
        operation: step.operation,
        status: step.status as OperationPlanStatusProjection["plans"][number]["steps"][number]["status"],
        external_receipt_observation: observationStatus as OperationPlanStatusProjection["plans"][number]["steps"][number]["external_receipt_observation"],
        ...(isRecord(observation) ? { external_receipt: {
          source: "local_inspection" as const,
          match_count: observation.match_count as number,
          evidence_digest: observation.evidence_digest as string,
          ...(typeof observation.receipt_digest === "string" ? { receipt_digest: observation.receipt_digest } : {}),
          observed_at_ms: observation.observed_at_ms as number,
          used_for_authority: false as const,
          raw_receipt_exposed: false as const,
        } } : {}),
        ...(binding ? { binding: {
          command_digest: binding.command_digest as string,
          ...(typeof binding.result_digest === "string" ? { result_digest: binding.result_digest } : {}),
          ...(typeof binding.delivery_digest === "string" ? { delivery_digest: binding.delivery_digest } : {}),
          memory_status: binding.memory_status as "not_recorded" | "memory_commit_pending" | "receipt_confirmed",
        } } : {}),
      });
    }
    const crossChannelOwnerReview = plan.channel_identity_digest !== WEBCHAT_CHANNEL_IDENTITY_DIGEST;
    plans.push({ plan_id: plan.plan_id, ...(typeof plan.task_identity_digest === "string"
      ? { task_identity_digest: plan.task_identity_digest } : {}),
      revision: revision!, revision_digest: plan.revision_digest,
      owner_authentication_required: crossChannelOwnerReview || plan.owner_identity_digest === WEBCHAT_OWNER_TOKEN_ACTOR_IDENTITY_DIGEST,
      ...(crossChannelOwnerReview ? { owner_reauthentication_binding: {
        owner_identity_digest: plan.owner_identity_digest as string,
        channel_identity_digest: plan.channel_identity_digest as string,
      } } : {}),
      ...(isRecord(goalPurposeBinding) ? { goal_purpose_binding: {
        goal_ref: goalPurposeBinding.goal_ref as string, purpose_version: goalPurposeBinding.purpose_version as number,
        purpose_digest: goalPurposeBinding.purpose_digest as string,
      } } : {}),
      goal_purpose_binding_status: (plan.goal_purpose_binding_status ??
        (goalPurposeBinding === undefined ? "not_configured" : "current")) as "not_configured" | "required" | "current" | "stale",
      ...(isRecord(goalPurposeRelation) ? { goal_purpose_relation: {
        status: goalPurposeRelation.status as "not_required" | "unavailable" | "stale" | "unverified",
        ...(goalPurposeRelation.candidate_outcome !== undefined ? { candidate_outcome: goalPurposeRelation.candidate_outcome as "supports" | "conflicts" | "unknown" } : {}),
        ...(goalPurposeRelation.candidate_status !== undefined ? { candidate_status: goalPurposeRelation.candidate_status as "present" | "missing" | "invalid" } : {}),
        ...(goalPurposeRelation.evidence_status !== undefined ? { evidence_status: goalPurposeRelation.evidence_status as "exact_spans_present" | "not_provided" | "citation_mismatch" | "purpose_unavailable" } : {}),
        ...(goalPurposeRelation.evidence_count !== undefined ? { evidence_count: goalPurposeRelation.evidence_count as number } : {}),
        ...(goalPurposeRelation.owner_review_status !== undefined ? { owner_review_status: goalPurposeRelation.owner_review_status as "not_reviewed" | "verified" | "invalid" } : {}),
        ...(goalPurposeRelation.owner_review_outcome !== undefined ? { owner_review_outcome: goalPurposeRelation.owner_review_outcome as "supports" | "conflicts" | "unknown" } : {}),
        ...(goalPurposeRelation.semantic_assessment_status !== undefined ? { semantic_assessment_status: "not_assessed" as const } : {}),
        ...(goalPurposeRelation.record_digest !== undefined ? { record_digest: goalPurposeRelation.record_digest as string } : {}),
        used_for_authority: false as const, may_execute: false as const,
      } } : {}),
      ...(computeSourceObservations.length ? { compute_source_observations: computeSourceObservations } : {}),
      ...(plan.recovery_hold_reason ? { recovery_hold_reason: plan.recovery_hold_reason as "held_residual" | "held_unobserved" | "held_unverified" } : {}),
      ...(plan.recovery_hold_scope_relation ? { recovery_hold_scope_relation: plan.recovery_hold_scope_relation as "requested" | "collateral" | "unknown" } : {}),
      status: plan.status as "awaiting_step_review" | "results_verified", step_count: plan.steps.length, steps });
  }
  return {
    schema_version: "operation-plan.status.v1", evidence_source: ["INTERNAL_STATE"],
    used_for_authority: false, raw_payload_exposed: false, status: "available",
    recovery_refresh_status: recoveryRefreshStatus,
    plan_count: inputPlans.length, displayed_count: plans.length, goal_purpose_options: goalPurposeOptions, waits, plans,
  };
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function operationCorePlannerHistoryProjection(
  feedback: ExecuteFeedback,
): OperationCorePlannerExecutionProjection | undefined {
  const result = isRecord(feedback.result) ? feedback.result : null;
  const operationCore = isRecord(result?.operation_core) ? result.operation_core : null;
  if (!operationCore || operationCore.status !== "valid_plan") return undefined;
  const plan = OperationPlanSchema.safeParse(operationCore.plan);
  if (!plan.success) return undefined;
  // 履歴の自己申告statusを信頼せず再検査する。依存観測は履歴から権限化しない。
  const prepared = prepareOperationPlan(plan.data, { now_ms: Date.now(), results: [], observations: [] });
  if (prepared.kind === "rejected") return undefined;
  return OperationCorePlannerExecutionProjectionSchema.parse({
    role: "planner_output_projection",
    status: "valid_plan",
    plan_id: plan.data.plan_id,
    request_id: plan.data.request_id,
    state: plan.data.state,
    steps_count: plan.data.steps.length,
    preparation: prepared.summary,
    step_summaries: plan.data.steps.slice(0, 20).map((step) => ({
      step_id: step.step_id,
      operation: step.operation,
      target_kind: step.target.kind,
      target_id_digest: digestString(step.target.id),
      effects: step.effects,
      adapter: step.adapter,
      adapter_is_authority: step.adapter_is_authority,
      command_generated_by_adapter_only: step.command_generated_by_adapter_only,
      approval_level: step.permission.approval_level,
      risk: step.permission.risk,
      final_review_required: step.permission.final_review_required,
    })),
    raw_command_is_core_operation: plan.data.raw_command_policy.raw_command_is_core_operation,
    planner_output_used_for_authority: plan.data.planner_output_used_for_authority,
    hds_brain_authority_required: plan.data.hds_brain_authority_required,
    evidence_source: ["EXTERNAL_EVIDENCE", "INTERNAL_STATE"],
  });
}

export function operationCoreResultHistoryProjection(
  command: ExecuteCommand,
  feedback: ExecuteFeedback,
): OperationCommandExecutionResult | undefined {
  return inspectOperationCommandExecutionResult(feedback.operation_core_result, {
    request_id: command.upstream_decision.request_id ?? null,
    command_id: command.id,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    status: feedback.status,
    operation: command.type === "channel_send" ? "channel.send" : commandOperation(command),
  });
}

function projectOperationCoreExecutionEntry(entry: CompleteHistoryEntry): Record<string, unknown> {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  const command = isRecord(payload.command) ? payload.command : {};
  const metrics = isRecord(payload.metrics) ? payload.metrics : {};
  const error = stringValue(payload.error);
  const executionTrace = projectOperationCoreExecutorTrace(payload.operation_core);
  const plannerOutput = projectOperationCorePlannerExecutionProjection(payload.operation_core_planner);
  const commandResult = inspectOperationCommandExecutionResult(payload.operation_core_result, {
    request_id: entry.request_id,
    command_id: entry.command_id,
    upstream_commit_hash: stringValue(command.upstream_commit_hash) ?? null,
    status: stringValue(payload.status) ?? "unknown",
    operation: command.type === "channel_send" ? "channel.send" : stringValue(command.operation) ?? "unknown",
  });
  return {
    index: entry.index,
    request_id: entry.request_id,
    command_id: entry.command_id,
    actor: entry.actor,
    source: entry.source,
    timestamp: entry.timestamp,
    payload_digest: entry.payload_digest,
    entry_hash: entry.entry_hash,
    origin_channel: stringValue(payload.origin_channel) ?? "unknown",
    status: stringValue(payload.status) ?? "unknown",
    result_present: payload.result_present === true,
    result_digest: stringValue(payload.result_digest) ?? null,
    error_present: Boolean(error),
    error_digest: error ? digestString(error) : null,
    metrics: {
      duration_ms: numberValue(metrics.duration_ms),
    },
    command: projectOperationCoreCommandDescriptor(command),
    ...(executionTrace ? { execution_trace: executionTrace } : {}),
    ...(commandResult ? { command_execution_result: commandResult } : {}),
    ...(plannerOutput ? { planner_output: plannerOutput } : {}),
    diff: {
      available: false,
      reason: "OperationDiff is not recorded for this execution yet",
      used_for_authority: false,
      evidence_source: ["INTERNAL_STATE"],
    },
    rollback: {
      available: false,
      reason: "Rollback plan is not recorded for this execution yet",
      used_for_authority: false,
      evidence_source: ["INTERNAL_STATE"],
    },
    operation_core: {
      role: "execution_result_projection",
      used_for_authority: false,
      adapter_result_used_for_authority: false,
      raw_payload_exposed: false,
      evidence_source: ["INTERNAL_STATE"],
    },
  };
}

function projectOperationCorePlannerExecutionProjection(
  value: unknown,
): OperationCorePlannerExecutionProjection | undefined {
  const parsed = OperationCorePlannerExecutionProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function projectOperationCoreExecutorTrace(value: unknown): unknown | undefined {
  const parsed = OperationCoreExecutorTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function projectOperationCoreCommandDescriptor(command: Record<string, unknown>): Record<string, unknown> {
  const constraints = isRecord(command.constraints) ? command.constraints : {};
  const payload = isRecord(command.payload) ? command.payload : {};
  return {
    type: stringValue(command.type) ?? "unknown",
    operation: stringValue(command.operation) ?? "unknown",
    upstream_decision: stringValue(command.upstream_decision) ?? "unknown",
    upstream_commit_hash: stringValue(command.upstream_commit_hash) ?? "unknown",
    constraints: {
      max_tokens: numberValueOrNull(constraints.max_tokens),
      timeout_ms: numberValueOrNull(constraints.timeout_ms),
      allowed_tools: stringArray(constraints.allowed_tools),
      allowed_capabilities: stringArray(constraints.allowed_capabilities),
    },
    payload: {
      tool_name: stringValue(payload.tool_name),
      argument_keys: stringArray(payload.argument_keys),
      arguments_digest: stringValue(payload.arguments_digest),
      messages_count: numberValueOrNull(payload.messages_count),
      message_roles: stringArray(payload.message_roles),
      messages_digest: stringValue(payload.messages_digest),
      backend_hint: stringValue(payload.backend_hint),
      model: stringValue(payload.model),
      channel: stringValue(payload.channel),
      target_digest: stringValue(payload.target_digest),
      content_digest: stringValue(payload.content_digest),
      content_chars: numberValueOrNull(payload.content_chars),
    },
  };
}

export function projectApprovalGrant(grant: ApprovalGrant): WebChatApprovalGrantItem {
  return {
    id: grant.id,
    mode: grant.mode,
    decision: grant.decision,
    operation: grant.operation,
    target_scope: grant.target_scope,
    target: grant.target,
    path_pattern: grant.path_pattern,
    channel: grant.channel,
    risk: grant.risk,
    actor: grant.actor,
    created_by: grant.created_by,
    created_at: grant.created_at,
    expires_at: grant.expires_at,
    revocable: grant.revocable,
    note: grant.note,
  };
}

export function projectApprovalHistoryEntry(entry: CompleteHistoryEntry): WebChatApprovalHistoryItem {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  const operationCore = projectOperationCoreApprovalTrace(payload.operation_core);
  return {
    index: entry.index,
    event: stringValue(payload.event) ?? "approval_history",
    request_id: entry.request_id,
    command_id: entry.command_id,
    grant_id: stringValue(payload.grant_id),
    actor: entry.actor,
    decision: stringValue(payload.decision) ?? null,
    operation: stringValue(payload.operation) ?? null,
    risk: stringValue(payload.risk) ?? null,
    approval_level: stringValue(payload.approval_level) ?? null,
    final_review_required:
      typeof payload.final_review_required === "boolean"
        ? payload.final_review_required
        : undefined,
    reason: stringValue(payload.reason) ?? null,
    ...(isDigest(payload.content_review_digest)
      ? { content_review_digest: payload.content_review_digest }
      : {}),
    timestamp: entry.timestamp,
    payload_digest: entry.payload_digest,
    used_for_authority: false,
    ...(operationCore ? { operation_core: operationCore } : {}),
  };
}

function projectOperationCoreApprovalTrace(value: unknown): OperationCoreApprovalTrace | undefined {
  const parsed = OperationCoreApprovalTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function humanizeDecision(
  decision: "ASSERT" | "SUSPEND" | "OUT_OF_SCOPE" | "FAIL",
  reason: string,
  request_id: string,
  approval_token?: string,
): string {
  switch (decision) {
    case "SUSPEND":
      return `[suspended] Awaiting human review. reason=${reason} request_id=${request_id}${
        approval_token ? ` approval_token=${approval_token}` : ""
      }`;
    case "OUT_OF_SCOPE":
      return `[out-of-scope] Request not handled. reason=${reason}`;
    case "FAIL":
      if (reason === "plan_control_denied:plan_recovery_unverified_hold") {
        return `[rejected] Request blocked by upstream policy. reason=${reason}\n` +
          "安全な次の操作: Control Centerで復旧状態を読み取り確認してください。Recovery画面の「回復台帳を読み取り検査」を実行してください。状態確認後に続ける場合は、新しい依頼から新規計画を作成してください。保留中の計画レビューは再試行しないでください。";
      }
      return `[rejected] Request blocked by upstream policy. reason=${reason}`;
    case "ASSERT":
      return `[ok] reason=${reason}`;
  }
}

export function commandOperation(command: ExecuteCommand): string {
  if (command.type === "tool_call") return command.payload.tool_name;
  if (command.type === "llm_call") return "llm_call";
  if (command.type === "channel_send") return `channel_send:${command.payload.channel}`;
  return "noop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValueOrNull(value: unknown): number | null {
  return numberValue(value) ?? null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function digestString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown, inArray = false): unknown => {
    if (v === undefined) return inArray ? null : undefined;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => normalize(item, true));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const normalized = normalize((v as Record<string, unknown>)[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}
