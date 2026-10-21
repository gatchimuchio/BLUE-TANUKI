import {
  FailureReviewCandidateSchema,
  FailureReviewIndependentObservationSchema,
  FailureReviewProjectionSchema,
  type FailureReviewCandidate,
  type FailureReviewIndependentObservation,
  type FailureReviewProjection,
} from "@blue-tanuki/protocol";
import { sha256Hex, stableJson } from "../complete-history/codec.js";
import type { FailureSignature, FailureType } from "./types.js";
import type { FailureReviewAuditTrace } from "../types.js";

const SAFE_UNKNOWNS = new Set([
  "root_cause_unconfirmed",
  "predicted_difference_not_observed",
  "goal_not_available",
  "actor_not_available",
  "channel_not_available",
  "legacy_history_missing_conditioned_patterns",
]);

/** FailureMemoryの署名から、自由文を含まないC向け射影を作る。 */
export function createFailureReviewProjection(
  signature: FailureSignature,
  independentObservations: readonly FailureReviewIndependentObservation[] = [],
  independentObservationSourceStatus: FailureReviewProjection["independent_observation_source_status"] = "unavailable",
): FailureReviewProjection {
  const causeCandidates = [...new Set(signature.cause_candidates ?? [])];
  const unknowns = [...new Set((signature.unknowns ?? []).filter((item) => SAFE_UNKNOWNS.has(item)))];
  const evidenceLogIdDigests = [...new Set(signature.evidence_log_ids.map((id) => sha256Hex(id)))].sort();
  const allowedEvidenceIds = new Set(evidenceLogIdDigests);
  const parsedObservations = independentObservations.map((observation) =>
    FailureReviewIndependentObservationSchema.parse(observation));
  if (parsedObservations.some((observation) => !allowedEvidenceIds.has(observation.entry_id_digest))) {
    throw new Error("failure review observation is not bound to signature evidence");
  }
  const identity = {
    id: signature.id,
    scope: signature.scope,
    failure_type: signature.failure_type,
    input_pattern: signature.input_pattern,
    action_pattern: signature.action_pattern,
    context_pattern: signature.context_pattern,
    result_pattern: signature.result_pattern ?? null,
    cause_candidates: causeCandidates,
    unknowns,
    evidence_log_id_digests: evidenceLogIdDigests,
  };
  return FailureReviewProjectionSchema.parse({
    schema_version: "blue-tanuki.failure-review-projection.v1",
    signature_id: signature.id,
    signature_digest: sha256Hex(stableJson(identity)),
    evidence_log_id_digests: evidenceLogIdDigests,
    independent_observation_source_status: independentObservationSourceStatus,
    independent_observations: parsedObservations,
    scope: signature.scope,
    failure_type: signature.failure_type,
    cause_candidates: causeCandidates,
    unknowns,
    input_pattern_digest: sha256Hex(signature.input_pattern),
    action_pattern_digest: sha256Hex(signature.action_pattern),
    context_pattern_digest: sha256Hex(signature.context_pattern),
    ...(signature.result_pattern !== undefined ? { result_pattern_digest: sha256Hex(signature.result_pattern) } : {}),
  });
}

export function failureReviewProjectionDigest(projection: FailureReviewProjection): string {
  return sha256Hex(stableJson(projection));
}

export function parseFailureReviewCandidate(value: unknown): FailureReviewCandidate | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { return null; }
  }
  const parsed = FailureReviewCandidateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Cの提案をJのdigest-only、非権威レビューへ結合する。提案自体は採用しない。 */
export function assessFailureReviewCandidate(input: {
  projection: FailureReviewProjection;
  candidate: unknown;
  source_bound: boolean;
}): FailureReviewAuditTrace {
  const candidate = parseFailureReviewCandidate(input.candidate);
  const projectionDigest = failureReviewProjectionDigest(input.projection);
  const observation = assessIndependentObservations(input.projection);
  if (!input.source_bound) return emptyFailureReviewTrace(input.projection, projectionDigest, "unbound", observation);
  if (!candidate) return emptyFailureReviewTrace(input.projection, projectionDigest, "invalid", observation);
  if (candidate.signature_id !== input.projection.signature_id ||
      candidate.signature_digest !== input.projection.signature_digest ||
      candidate.projection_digest !== projectionDigest) {
    return emptyFailureReviewTrace(input.projection, projectionDigest, "mismatched", observation);
  }

  const scopeBound = observation.bound && candidate.scope_assessment === "same_scope";
  return {
    status: "recorded",
    signature_id_digest: sha256Hex(input.projection.signature_id),
    signature_digest: input.projection.signature_digest,
    projection_digest: projectionDigest,
    proposed_scope_assessment: candidate.scope_assessment,
    scope_disposition: scopeBound
      ? "bound_to_independent_observation"
      : "held_for_independent_observation",
    independent_observation_count: observation.count,
    independent_observation_digest: observation.digest,
    counterexample_review_target_status: candidate.counterexamples.length === 0
      ? "not_present"
      : scopeBound ? "retained_for_future_observation" : "held_for_scope",
    resume_condition_review_target_status: candidate.resume_conditions.length === 0
      ? "not_present"
      : scopeBound ? "retained_for_future_observation" : "held_for_scope",
    cause_hypothesis_count: candidate.cause_hypotheses.length,
    cause_hypothesis_categories: [...new Set(candidate.cause_hypotheses.map((item) => item.category))].sort() as FailureType[],
    cause_hypothesis_digests: candidate.cause_hypotheses.map((item) => sha256Hex(item.rationale)),
    alternative_hypothesis_digests: candidate.alternative_hypotheses.map((item) => sha256Hex(item)),
    observation_error_hypothesis_digests: candidate.observation_error_hypotheses.map((item) => sha256Hex(item)),
    counterexample_digests: candidate.counterexamples.map((item) => sha256Hex(item)),
    resume_condition_digests: candidate.resume_conditions.map((item) => sha256Hex(item)),
    additional_observation_digests: candidate.additional_observations.map((item) => sha256Hex(item)),
    cause_adoption: "not_adopted",
    follow_up_required: "independent_observation",
    may_execute: false,
    used_for_authority: false,
  };
}

export function invalidFailureReviewTrace(
  projection: FailureReviewProjection,
  status: "invalid" | "unbound" | "mismatched" = "invalid",
): FailureReviewAuditTrace {
  return emptyFailureReviewTrace(projection, failureReviewProjectionDigest(projection), status);
}

export function failureReviewResultContent(trace: FailureReviewAuditTrace, value?: unknown): string {
  const candidate = trace.status === "recorded" ? parseFailureReviewCandidate(value) : null;
  return JSON.stringify({
    schema_version: "blue-tanuki.failure-review-result.v1",
    review: trace,
    review_basis: "failure categories and digests only; no raw goal, action, context, or result was provided to C",
    candidate_proposals: candidate ? {
      cause_hypotheses: candidate.cause_hypotheses,
      alternative_hypotheses: candidate.alternative_hypotheses,
      observation_error_hypotheses: candidate.observation_error_hypotheses,
      proposed_scope_assessment: candidate.scope_assessment,
      counterexamples: candidate.counterexamples,
      resume_conditions: candidate.resume_conditions,
      additional_observations: candidate.additional_observations,
      status: "unverified_candidate_only",
    } : null,
    independent_observation: {
      disposition: trace.scope_disposition,
      count: trace.independent_observation_count,
      digest: trace.independent_observation_digest,
      basis: "linked Complete History entry digests and failure classifications only",
    },
    review_targets: {
      counterexamples: trace.counterexample_review_target_status,
      resume_conditions: trace.resume_condition_review_target_status,
    },
    counterexamples_adopted_as_facts: false,
    resume_conditions_adopted_as_permissions: false,
    proposed_causes_are_unverified: true,
    cause_adoption: "not_adopted",
    independent_observation_required: trace.follow_up_required === "independent_observation",
    may_execute: false,
    used_for_authority: false,
  }, null, 2);
}

function emptyFailureReviewTrace(
  projection: FailureReviewProjection,
  projectionDigest: string,
  status: FailureReviewAuditTrace["status"],
  observation = assessIndependentObservations(projection),
): FailureReviewAuditTrace {
  return {
    status,
    signature_id_digest: sha256Hex(projection.signature_id),
    signature_digest: projection.signature_digest,
    projection_digest: projectionDigest,
    proposed_scope_assessment: "not_assessed",
    scope_disposition: "held_for_independent_observation",
    independent_observation_count: observation.count,
    independent_observation_digest: observation.digest,
    counterexample_review_target_status: "not_present",
    resume_condition_review_target_status: "not_present",
    cause_hypothesis_count: 0,
    cause_hypothesis_categories: [],
    cause_hypothesis_digests: [],
    alternative_hypothesis_digests: [],
    observation_error_hypothesis_digests: [],
    counterexample_digests: [],
    resume_condition_digests: [],
    additional_observation_digests: [],
    cause_adoption: "not_adopted",
    follow_up_required: status === "recorded" ? "independent_observation" : "none",
    may_execute: false,
    used_for_authority: false,
  };
}

function assessIndependentObservations(projection: FailureReviewProjection): {
  bound: boolean;
  count: number;
  digest: string;
} {
  const observations = projection.independent_observations;
  const ids = observations.map((observation) => observation.entry_id_digest);
  const uniqueIds = new Set(ids);
  const expected = new Set(projection.evidence_log_id_digests);
  const recordsMatch = observations.every((observation) =>
    expected.has(observation.entry_id_digest) &&
    observation.observed_failures.length === 1 &&
    observation.observed_failures[0]?.scope === projection.scope &&
    observation.observed_failures[0]?.failure_type === projection.failure_type);
  const bound = projection.independent_observation_source_status === "verified" &&
    expected.size > 0 && observations.length === expected.size &&
    uniqueIds.size === observations.length && recordsMatch;
  return {
    bound,
    count: observations.length,
    digest: sha256Hex(stableJson(observations)),
  };
}
