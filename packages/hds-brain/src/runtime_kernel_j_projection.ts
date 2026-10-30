import type { Decision } from "@blue-tanuki/protocol";
import type { DecisionLog, GoalPurposeBindingReference, PolicyConfig, ResumeVerdict, ScoringResult } from "./types.js";
import { evaluateDecision } from "./policy.js";

const SCALE = 1_000_000;
const MAX_AXES = 128;
const AXIS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type RuntimeKernelJPolicyRuleId =
  | "detector_lifecycle"
  | "per_axis_fail"
  | "per_axis_suspend_below"
  | "out_of_scope_below"
  | "aggregate_assert"
  | "default_suspend";

export interface RuntimeKernelJAxisProjection {
  axis: string;
  score_micros: number;
  weight_micros: number;
  lifecycle_ok: boolean;
}

export interface RuntimeKernelJThresholdProjection {
  axis: string;
  threshold_micros: number;
}

/** 目的本文とgoal_refを含めない、shadow比較用の目的版束縛。 */
export type RuntimeKernelJPurposeBindingProjection = GoalPurposeBindingReference;

export type RuntimeKernelJCurrentPurposeBindingStatus =
  | "not_bound"
  | "ledger_unavailable"
  | "goal_not_found"
  | "available";

/** Digest-only snapshot from the current GoalGovernanceLedger; never an authority input. */
export interface RuntimeKernelJCurrentPurposeBindingProjection {
  status: RuntimeKernelJCurrentPurposeBindingStatus;
  binding: RuntimeKernelJPurposeBindingProjection | null;
}

export interface RuntimeKernelJPlanStepAdoptionAvailableProjection {
  purpose_relation: {
    status: "not_required" | "owner_reviewed_supports";
    candidate_outcome: "supports" | "conflicts" | "unknown";
    candidate_status: "present" | "missing" | "invalid";
    evidence_status: "exact_spans_present" | "not_provided" | "citation_mismatch" | "purpose_unavailable";
    owner_review_outcome: "supports" | null;
  };
  criterion_relation: {
    outcome: "supports" | "conflicts" | "unknown";
    evidence_status: "observed" | "inferred" | "assumed" | "unknown";
    risk_status: "verified" | "unverified";
    relation_count: number;
    objective_count: number;
    safety_count: number;
    supports_count: number;
    conflicts_count: number;
    reason_code: "request_declares_criterion_support_risk_unverified" |
      "request_declares_criterion_conflict" | "no_matching_goal_criterion" | "criteria_unavailable" |
      "criteria_invalid";
  };
}

export type RuntimeKernelJPlanStepAdoptionUnavailableReason = "binding_identity_unavailable" | "binding_unavailable" |
  "binding_not_selected" | "legacy_record_unavailable" | "record_invalid";

export type RuntimeKernelJPlanStepAdoptionProjection =
  | { status: "not_applicable" }
  | { status: "not_comparable"; reason: RuntimeKernelJPlanStepAdoptionUnavailableReason }
  | ({ status: "available" } & RuntimeKernelJPlanStepAdoptionAvailableProjection);

export type RuntimeKernelJPlanStepAdoptionReceipt =
  | { status: "not_applicable"; matches: null }
  | { status: "not_comparable"; reason: RuntimeKernelJPlanStepAdoptionUnavailableReason; matches: null }
  | ({ status: "matched" | "mismatched"; matches: boolean } & RuntimeKernelJPlanStepAdoptionAvailableProjection);

/** Recompute only the bounded relation-shape outcome carried by a selected step. */
export function classifyRuntimeKernelJPlanStepAdoption(
  projection: RuntimeKernelJPlanStepAdoptionProjection,
): RuntimeKernelJPlanStepAdoptionReceipt {
  if (projection.status === "not_applicable") return { status: "not_applicable", matches: null };
  if (projection.status === "not_comparable") {
    return { status: "not_comparable", reason: projection.reason, matches: null };
  }
  const purpose = projection.purpose_relation;
  const purposeMatches = purpose.status === "not_required"
    ? purpose.candidate_outcome === "unknown" && purpose.candidate_status === "missing" &&
      purpose.evidence_status === "not_provided" && purpose.owner_review_outcome === null
    : purpose.owner_review_outcome === "supports";
  const criterion = projection.criterion_relation;
  const countsAreConsistent = Number.isSafeInteger(criterion.relation_count) && criterion.relation_count >= 0 &&
    criterion.relation_count <= 64 && [criterion.objective_count, criterion.safety_count,
      criterion.supports_count, criterion.conflicts_count].every((count) =>
      Number.isSafeInteger(count) && count >= 0 && count <= 64) &&
    criterion.objective_count + criterion.safety_count === criterion.relation_count &&
    criterion.supports_count + criterion.conflicts_count === criterion.relation_count;
  const criterionMatches = countsAreConsistent && criterion.risk_status === "unverified" &&
    ((criterion.outcome === "unknown" && criterion.evidence_status === "unknown" &&
      criterion.relation_count === 0 && criterion.supports_count === 0 && criterion.conflicts_count === 0 &&
      (criterion.reason_code === "criteria_unavailable" || criterion.reason_code === "no_matching_goal_criterion")) ||
      (criterion.outcome === "supports" && criterion.evidence_status === "assumed" &&
        criterion.supports_count > 0 && criterion.conflicts_count === 0 &&
        criterion.reason_code === "request_declares_criterion_support_risk_unverified"));
  const matches = purposeMatches && criterionMatches;
  return {
    status: matches ? "matched" : "mismatched",
    matches,
    purpose_relation: { ...purpose },
    criterion_relation: { ...criterion },
  };
}

/** Human resume input and its TS outcome; identity, request, and command are excluded. */
export interface RuntimeKernelJResumeTransitionProjection {
  owner_verdict: ResumeVerdict;
  resume_allowed: boolean;
  typescript_result_decision: Decision;
  command_present: boolean;
}

export type RuntimeKernelJMemoryTransitionProjection =
  | {
    kind: "meaning_update_adoption";
    owner_verdict: ResumeVerdict;
    memory_application_status: "applied" | "not_applied";
    memory_revision_before: number | null;
    memory_revision_after: number | null;
    reference_review_status: "prior_version_unverified" | "counterevidence_absence_unverified" | null;
    semantic_relation_status: "not_assessed";
    follow_up_action_status: "unconfirmed";
    pending_reassessment_required_count: number | null;
    typescript_residual_status: "meaning_unverified" | "meaning_unverified_with_reassessment_pending" |
      "adoption_approved_not_applied" | "adoption_rejected" | "adoption_blocked";
    used_for_authority: false;
    may_execute: false;
  }
  | {
    kind: "memory_judgment_reassessment";
    owner_verdict: ResumeVerdict;
    memory_application_status: "applied" | "not_applied";
    memory_revision_before: number | null;
    memory_revision_after: number | null;
    requested_judgment_count: number;
    reassessed_judgment_count: number;
    remaining_reassessment_required_count: number;
    typescript_residual_status: "named_judgments_reassessed" | "named_judgments_pending";
    used_for_authority: false;
    may_execute: false;
  };

export type RuntimeKernelJMemoryTransitionInput =
  | {
    kind: "meaning_update_adoption";
    owner_verdict: ResumeVerdict;
    memory_application_status: "applied" | "not_applied";
    memory_revision_before: number | null;
    memory_revision_after: number | null;
    reference_review_status: string | null;
    pending_reassessment_required_count: number | null;
  }
  | {
    kind: "memory_judgment_reassessment";
    owner_verdict: ResumeVerdict;
    memory_application_status: "applied" | "not_applied";
    memory_revision_before: number | null;
    memory_revision_after: number | null;
    requested_judgment_count: number;
    reassessed_judgment_count: number;
    remaining_reassessment_required_count: number;
  };

/** Sanitized numeric inputs for a non-authoritative Rust J comparison. */
export interface RuntimeKernelJProjection {
  schema_version: "blue-tanuki.hds-runtime-j-projection.v10";
  typescript_decision: Decision;
  typescript_policy_rule_id: RuntimeKernelJPolicyRuleId;
  typescript_policy_rule_axis: string | null;
  purpose_binding: RuntimeKernelJPurposeBindingProjection | null;
  current_goal_purpose_binding: RuntimeKernelJCurrentPurposeBindingProjection;
  plan_step_adoption: RuntimeKernelJPlanStepAdoptionProjection;
  axes: RuntimeKernelJAxisProjection[];
  thresholds: {
    aggregate_assert_micros: number;
    out_of_scope_below_micros: number;
    per_axis_fail: RuntimeKernelJThresholdProjection[];
    per_axis_suspend_below: RuntimeKernelJThresholdProjection[];
  };
  resume_transition?: RuntimeKernelJResumeTransitionProjection;
  memory_transition?: RuntimeKernelJMemoryTransitionProjection;
}

export type RuntimeKernelJProjectionUnavailableReason =
  | "controller_override"
  | "axis_shape_mismatch"
  | "unsupported_policy_value"
  | "purpose_binding_invalid"
  | "resume_source_not_suspended"
  | "policy_rule_unavailable"
  | "memory_transition_invalid"
  | "memory_transition_unavailable"
  | "precision_boundary"
  | "quantization_changes_decision"
  | "projection_error";

export type RuntimeKernelJProjectionResult =
  | { status: "comparable"; projection: RuntimeKernelJProjection }
  | { status: "not_comparable"; reason: RuntimeKernelJProjectionUnavailableReason };

/**
 * Build the minimum fixed-point projection needed to independently evaluate
 * the policy decision. Raw input, detector evidence, command data and M are
 * deliberately excluded. Non-policy controller decisions are not projected.
 */
export function projectRuntimeKernelJDecision(
  log: DecisionLog,
  policy: PolicyConfig,
  purposeBinding: RuntimeKernelJPurposeBindingProjection | null = log.goal_purpose_binding ?? null,
  currentPurposeBinding: RuntimeKernelJCurrentPurposeBindingProjection = {
    status: purposeBinding ? "ledger_unavailable" : "not_bound",
    binding: null,
  },
  planStepAdoption: RuntimeKernelJPlanStepAdoptionProjection = { status: "not_applicable" },
): RuntimeKernelJProjectionResult {
  if (purposeBinding && (!/^[a-f0-9]{64}$/.test(purposeBinding.goal_id_digest) ||
      !Number.isSafeInteger(purposeBinding.purpose_version) || purposeBinding.purpose_version < 1 ||
      !/^[a-f0-9]{64}$/.test(purposeBinding.purpose_digest))) {
    return { status: "not_comparable", reason: "purpose_binding_invalid" };
  }
  if (!isCurrentPurposeBindingProjectionValid(purposeBinding, currentPurposeBinding)) {
    return { status: "not_comparable", reason: "purpose_binding_invalid" };
  }

  const scoring = log.model.scoring;
  const typescript = evaluateDecision(scoring, policy);
  if (log.commit.decision !== typescript.decision || log.commit.reason !== typescript.reason ||
      !sameStrings(log.commit.triggered_thresholds, typescript.triggered_thresholds)) {
    return { status: "not_comparable", reason: "controller_override" };
  }
  if (policy.axes.length === 0 || policy.axes.length > MAX_AXES || scoring.axis_scores.length !== policy.axes.length) {
    return { status: "not_comparable", reason: "axis_shape_mismatch" };
  }

  const aggregateAssert = toUnits(policy.thresholds.aggregate_assert, -1, 2);
  const outOfScopeBelow = toUnits(policy.thresholds.out_of_scope_below, -1, 2);
  if (aggregateAssert === undefined || outOfScopeBelow === undefined) {
    return { status: "not_comparable", reason: "unsupported_policy_value" };
  }

  const axes: RuntimeKernelJAxisProjection[] = [];
  for (let index = 0; index < policy.axes.length; index += 1) {
    const configuredAxis = policy.axes[index]!;
    const score = scoring.axis_scores[index]!;
    if (configuredAxis.name !== score.axis || !AXIS_NAME_PATTERN.test(configuredAxis.name)) {
      return { status: "not_comparable", reason: "axis_shape_mismatch" };
    }
    const scoreUnits = toUnits(score.score, 0, 1);
    const weightUnits = toUnits(configuredAxis.weight, 0, 1_000);
    if (scoreUnits === undefined || weightUnits === undefined) {
      return { status: "not_comparable", reason: "unsupported_policy_value" };
    }
    axes.push({
      axis: configuredAxis.name,
      score_micros: scoreUnits,
      weight_micros: weightUnits,
      lifecycle_ok: (score.lifecycle?.status ?? "ok") === "ok",
    });
  }

  const perAxisFail = thresholdEntries(policy.thresholds.per_axis_fail);
  const perAxisSuspendBelow = thresholdEntries(policy.thresholds.per_axis_suspend_below);
  if (perAxisFail === undefined || perAxisSuspendBelow === undefined) {
    return { status: "not_comparable", reason: "unsupported_policy_value" };
  }
  const typescriptPolicyRule = projectPolicyRule(scoring, typescript.triggered_thresholds);
  if (typescriptPolicyRule === undefined) {
    return { status: "not_comparable", reason: "policy_rule_unavailable" };
  }

  const scoreByAxis = new Map(axes.map((axis) => [axis.axis, axis.score_micros]));
  if (axes.some((axis) => !axis.lifecycle_ok)) {
    // Lifecycle escalation precedes numeric thresholds on both implementations.
  } else {
    for (const entry of [...perAxisFail, ...perAxisSuspendBelow]) {
      const score = scoreByAxis.get(entry.axis);
      if (score !== undefined && Math.abs(score - entry.threshold_micros) <= 2) {
        return { status: "not_comparable", reason: "precision_boundary" };
      }
    }
    const quantizedScoring = quantizedScoringForProjection(scoring, axes);
    const aggregateUnits = toUnits(quantizedScoring.aggregate, 0, 1);
    if (aggregateUnits === undefined || Math.abs(aggregateUnits - outOfScopeBelow) <= 2 ||
        Math.abs(aggregateUnits - aggregateAssert) <= 2) {
      return { status: "not_comparable", reason: "precision_boundary" };
    }
    const quantizedPolicy = quantizedPolicyForProjection(
      policy,
      aggregateAssert,
      outOfScopeBelow,
      perAxisFail,
      perAxisSuspendBelow,
    );
    if (evaluateDecision(quantizedScoring, quantizedPolicy).decision !== typescript.decision) {
      return { status: "not_comparable", reason: "quantization_changes_decision" };
    }
  }

  return {
    status: "comparable",
    projection: {
      schema_version: "blue-tanuki.hds-runtime-j-projection.v10",
      typescript_decision: typescript.decision,
      typescript_policy_rule_id: typescriptPolicyRule.id,
      typescript_policy_rule_axis: typescriptPolicyRule.axis,
      purpose_binding: purposeBinding ? { ...purposeBinding } : null,
      current_goal_purpose_binding: {
        status: currentPurposeBinding.status,
        binding: currentPurposeBinding.binding ? { ...currentPurposeBinding.binding } : null,
      },
      plan_step_adoption: planStepAdoption,
      axes,
      thresholds: {
        aggregate_assert_micros: aggregateAssert,
        out_of_scope_below_micros: outOfScopeBelow,
        per_axis_fail: perAxisFail,
        per_axis_suspend_below: perAxisSuspendBelow,
      },
    },
  };
}

/**
 * Project the original policy SUSPEND plus its later human resume outcome.
 * The Rust shadow recomputes the original policy decision and the fixed
 * resume mapping; it never receives owner identity or the resumed command.
 */
export function projectRuntimeKernelJResumeTransition(
  suspendedLog: DecisionLog,
  policy: PolicyConfig,
  purposeBinding: RuntimeKernelJPurposeBindingProjection | null,
  transition: RuntimeKernelJResumeTransitionProjection,
  currentPurposeBinding: RuntimeKernelJCurrentPurposeBindingProjection = {
    status: purposeBinding ? "ledger_unavailable" : "not_bound",
    binding: null,
  },
): RuntimeKernelJProjectionResult {
  const base = projectRuntimeKernelJDecision(suspendedLog, policy, purposeBinding, currentPurposeBinding);
  if (base.status !== "comparable") return base;
  if (base.projection.typescript_decision !== "SUSPEND") {
    return { status: "not_comparable", reason: "resume_source_not_suspended" };
  }
  return {
    status: "comparable",
    projection: {
      ...base.projection,
      resume_transition: { ...transition },
    },
  };
}

function isCurrentPurposeBindingProjectionValid(
  source: RuntimeKernelJPurposeBindingProjection | null,
  current: RuntimeKernelJCurrentPurposeBindingProjection,
): boolean {
  const binding = current.binding;
  if (current.status === "not_bound") return source === null && binding === null;
  if (current.status === "ledger_unavailable" || current.status === "goal_not_found") {
    return source !== null && binding === null;
  }
  return current.status === "available" && source !== null && binding !== null &&
    /^[a-f0-9]{64}$/.test(binding.goal_id_digest) && binding.goal_id_digest === source.goal_id_digest &&
    Number.isSafeInteger(binding.purpose_version) && binding.purpose_version >= 1 &&
    /^[a-f0-9]{64}$/.test(binding.purpose_digest);
}

/** Add only bounded, non-authoritative owner-memory commit outcomes to a J projection. */
export function projectRuntimeKernelJMemoryTransition(
  base: RuntimeKernelJProjectionResult,
  input: RuntimeKernelJMemoryTransitionInput,
): RuntimeKernelJProjectionResult {
  if (base.status !== "comparable") return base;
  if (base.projection.resume_transition || base.projection.memory_transition) {
    return { status: "not_comparable", reason: "memory_transition_invalid" };
  }

  let memoryTransition: RuntimeKernelJMemoryTransitionProjection;
  if (input.kind === "meaning_update_adoption") {
    let referenceReviewStatus: "prior_version_unverified" | "counterevidence_absence_unverified" | null;
    let pendingCount: number | null;
    const revisionsValid = input.memory_application_status === "applied"
      ? Number.isSafeInteger(input.memory_revision_before) && input.memory_revision_before! >= 0 &&
        Number.isSafeInteger(input.memory_revision_after) && input.memory_revision_after! >= 1
      : input.memory_revision_before === null && input.memory_revision_after === null;
    if (!revisionsValid) return { status: "not_comparable", reason: "memory_transition_unavailable" };
    if (input.owner_verdict === "approve") {
      if (input.memory_application_status === "applied" && input.pending_reassessment_required_count === null) {
        return { status: "not_comparable", reason: "memory_transition_unavailable" };
      }
      const reviewStatusValid = input.reference_review_status === null ||
        input.reference_review_status === "prior_version_unverified" ||
        input.reference_review_status === "counterevidence_absence_unverified";
      const appliedStateValid = input.memory_application_status === "applied" &&
        input.reference_review_status !== null && input.pending_reassessment_required_count !== null &&
        isBoundedCount(input.pending_reassessment_required_count);
      const notAppliedStateValid = input.memory_application_status === "not_applied" &&
        input.pending_reassessment_required_count === null;
      if (!reviewStatusValid || !(appliedStateValid || notAppliedStateValid)) {
        return { status: "not_comparable", reason: "memory_transition_invalid" };
      }
      referenceReviewStatus = input.reference_review_status === "prior_version_unverified" ||
        input.reference_review_status === "counterevidence_absence_unverified"
        ? input.reference_review_status : null;
      pendingCount = input.memory_application_status === "applied"
        ? input.pending_reassessment_required_count : null;
    } else {
      if (input.memory_application_status !== "not_applied" || input.reference_review_status !== null ||
          input.pending_reassessment_required_count !== null) {
        return { status: "not_comparable", reason: "memory_transition_invalid" };
      }
      referenceReviewStatus = input.reference_review_status;
      pendingCount = null;
    }
    const residualStatus = input.owner_verdict === "approve"
      ? input.memory_application_status === "not_applied"
        ? "adoption_approved_not_applied" as const
        : pendingCount === 0
          ? "meaning_unverified" as const : "meaning_unverified_with_reassessment_pending" as const
      : input.owner_verdict === "reject" ? "adoption_rejected" as const : "adoption_blocked" as const;
    memoryTransition = {
      kind: input.kind,
      owner_verdict: input.owner_verdict,
      memory_application_status: input.memory_application_status,
      memory_revision_before: input.memory_revision_before,
      memory_revision_after: input.memory_revision_after,
      reference_review_status: referenceReviewStatus,
      semantic_relation_status: "not_assessed",
      follow_up_action_status: "unconfirmed",
      pending_reassessment_required_count: pendingCount,
      typescript_residual_status: residualStatus,
      used_for_authority: false,
      may_execute: false,
    };
  } else {
    const revisionsValid = input.memory_application_status === "applied"
      ? Number.isSafeInteger(input.memory_revision_before) && input.memory_revision_before! >= 0 &&
        Number.isSafeInteger(input.memory_revision_after) && input.memory_revision_after! >= 1
      : input.memory_revision_before === null && input.memory_revision_after === null;
    if (!revisionsValid) return { status: "not_comparable", reason: "memory_transition_unavailable" };
    if (!isBoundedCount(input.requested_judgment_count) || input.requested_judgment_count < 1 ||
        !isBoundedCount(input.reassessed_judgment_count) ||
        !isBoundedCount(input.remaining_reassessment_required_count)) {
      return { status: "not_comparable", reason: "memory_transition_invalid" };
    }
    const complete = input.reassessed_judgment_count === input.requested_judgment_count &&
      input.remaining_reassessment_required_count === 0;
    const countsConsistent = input.reassessed_judgment_count + input.remaining_reassessment_required_count ===
      input.requested_judgment_count;
    const approvedAndApplied = input.owner_verdict === "approve" && input.memory_application_status === "applied" &&
      countsConsistent;
    const notApplied = input.memory_application_status === "not_applied" && input.reassessed_judgment_count === 0 &&
      input.remaining_reassessment_required_count === input.requested_judgment_count;
    if (!approvedAndApplied && !notApplied) {
      return { status: "not_comparable", reason: "memory_transition_invalid" };
    }
    memoryTransition = {
      kind: input.kind,
      owner_verdict: input.owner_verdict,
      memory_application_status: input.memory_application_status,
      memory_revision_before: input.memory_revision_before,
      memory_revision_after: input.memory_revision_after,
      requested_judgment_count: input.requested_judgment_count,
      reassessed_judgment_count: input.reassessed_judgment_count,
      remaining_reassessment_required_count: input.remaining_reassessment_required_count,
      typescript_residual_status: complete ? "named_judgments_reassessed" : "named_judgments_pending",
      used_for_authority: false,
      may_execute: false,
    };
  }

  return {
    status: "comparable",
    projection: { ...base.projection, memory_transition: memoryTransition },
  };
}

function projectPolicyRule(
  scoring: ScoringResult,
  triggeredThresholds: string[],
): { id: RuntimeKernelJPolicyRuleId; axis: string | null } | undefined {
  const lifecycleIssue = scoring.axis_scores.find((score) => (score.lifecycle?.status ?? "ok") !== "ok");
  if (lifecycleIssue) {
    return AXIS_NAME_PATTERN.test(lifecycleIssue.axis)
      ? { id: "detector_lifecycle", axis: lifecycleIssue.axis }
      : undefined;
  }

  if (triggeredThresholds.length !== 1) return undefined;
  const trigger = triggeredThresholds[0]!;
  const axisRule = (prefix: string, id: "per_axis_fail" | "per_axis_suspend_below") => {
    if (!trigger.startsWith(prefix)) return undefined;
    const axis = trigger.slice(prefix.length).split(/<=|</, 1)[0];
    return axis && AXIS_NAME_PATTERN.test(axis) ? { id, axis } : undefined;
  };
  const perAxisFail = axisRule("per_axis_fail:", "per_axis_fail");
  if (perAxisFail) return perAxisFail;
  const perAxisSuspend = axisRule("per_axis_suspend_below:", "per_axis_suspend_below");
  if (perAxisSuspend) return perAxisSuspend;
  if (trigger.startsWith("out_of_scope_below:")) return { id: "out_of_scope_below", axis: null };
  if (trigger.startsWith("aggregate_assert:")) return { id: "aggregate_assert", axis: null };
  if (trigger === "default_suspend") return { id: "default_suspend", axis: null };
  return undefined;
}

function thresholdEntries(
  values: Record<string, number> | undefined,
): RuntimeKernelJThresholdProjection[] | undefined {
  const entries = Object.entries(values ?? {});
  if (entries.length > MAX_AXES) return undefined;
  const result: RuntimeKernelJThresholdProjection[] = [];
  for (const [axis, threshold] of entries) {
    const thresholdUnits = toUnits(threshold, -1, 2);
    if (!AXIS_NAME_PATTERN.test(axis) || thresholdUnits === undefined) return undefined;
    result.push({ axis, threshold_micros: thresholdUnits });
  }
  return result;
}

function quantizedScoringForProjection(
  scoring: ScoringResult,
  axes: RuntimeKernelJAxisProjection[],
): ScoringResult {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const axis of axes) {
    const score = axis.score_micros / SCALE;
    const weight = axis.weight_micros / SCALE;
    weightedSum += score * weight;
    weightTotal += weight;
  }
  return {
    ...scoring,
    axis_scores: scoring.axis_scores.map((score, index) => ({
      ...score,
      score: axes[index]!.score_micros / SCALE,
    })),
    aggregate: weightTotal > 0 ? weightedSum / weightTotal : 0,
  };
}

function quantizedPolicyForProjection(
  policy: PolicyConfig,
  aggregateAssert: number,
  outOfScopeBelow: number,
  perAxisFail: RuntimeKernelJThresholdProjection[],
  perAxisSuspendBelow: RuntimeKernelJThresholdProjection[],
): PolicyConfig {
  return {
    ...policy,
    thresholds: {
      aggregate_assert: aggregateAssert / SCALE,
      out_of_scope_below: outOfScopeBelow / SCALE,
      per_axis_fail: Object.fromEntries(perAxisFail.map(({ axis, threshold_micros }) => [axis, threshold_micros / SCALE])),
      per_axis_suspend_below: Object.fromEntries(perAxisSuspendBelow.map(({ axis, threshold_micros }) => [axis, threshold_micros / SCALE])),
    },
  };
}

function toUnits(value: number, minimum: number, maximum: number): number | undefined {
  if (!Number.isFinite(value) || value < minimum || value > maximum) return undefined;
  const units = Math.round(value * SCALE);
  return Number.isSafeInteger(units) ? units : undefined;
}

function isBoundedCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 512;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
