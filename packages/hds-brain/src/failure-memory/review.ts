import {
  FailureReviewCandidateSchema,
  FailureReviewIndependentObservationSchema,
  FailureReviewLineageReferenceSchema,
  FailureReviewProjectionSchema,
  FailureLearningDevelopmentHandoffSchema,
  type FailureReviewCandidate,
  type FailureReviewIndependentObservation,
  type FailureReviewLineageReference,
  type FailureReviewProjection,
  type FailureLearningDevelopmentHandoff,
} from "@blue-tanuki/protocol";
import { sha256Hex, stableJson } from "../complete-history/codec.js";
import { FailureLearningLineageRecordSchema, type FailureLearningLineageRecord, type FailureSignature, type FailureType } from "./types.js";
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
  priorLearningLineages: readonly FailureReviewLineageReference[] = [],
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
  const signatureDigest = failureSignatureDigest(signature);
  const preStateDigest = failureSignaturePreStateDigest(signature);
  const parsedLineages = priorLearningLineages.map((lineage) => FailureReviewLineageReferenceSchema.parse(lineage));
  if (parsedLineages.some((lineage) => lineage.signature_digest !== signatureDigest) ||
      new Set(parsedLineages.map((lineage) => lineage.record_digest)).size !== parsedLineages.length) {
    throw new Error("failure review lineage reference is not bound to signature");
  }
  return FailureReviewProjectionSchema.parse({
    schema_version: "blue-tanuki.failure-review-projection.v1",
    signature_id: signature.id,
    signature_digest: signatureDigest,
    pre_state_digest: preStateDigest,
    retention_period: {
      first_observed_at: signature.created_at ?? "unavailable",
      last_observed_at: signature.last_seen_at ?? "unavailable",
    },
    evidence_log_id_digests: evidenceLogIdDigests,
    prior_learning_lineages: parsedLineages,
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

export function failureSignatureDigest(signature: FailureSignature): string {
  return sha256Hex(stableJson({
    id: signature.id,
    scope: signature.scope,
    failure_type: signature.failure_type,
    input_pattern: signature.input_pattern,
    action_pattern: signature.action_pattern,
    context_pattern: signature.context_pattern,
    result_pattern: signature.result_pattern ?? null,
    cause_candidates: [...new Set(signature.cause_candidates ?? [])],
    unknowns: [...new Set((signature.unknowns ?? []).filter((item) => SAFE_UNKNOWNS.has(item)))],
    evidence_log_id_digests: [...new Set(signature.evidence_log_ids.map((id) => sha256Hex(id)))].sort(),
  }));
}

export function failureSignaturePreStateDigest(signature: FailureSignature): string {
  return sha256Hex(stableJson({
    signature_digest: failureSignatureDigest(signature),
    state: signature.state,
    match_level: signature.match_level,
    suppression_policy: signature.suppression_policy,
    confidence: signature.confidence,
    severity: signature.severity,
    probe_policy: signature.probe_policy,
    allow_probe: signature.allow_probe,
    created_at: signature.created_at,
    updated_at: signature.updated_at,
    last_seen_at: signature.last_seen_at,
    last_validated_at: signature.last_validated_at ?? null,
    next_revalidation_at: signature.next_revalidation_at ?? null,
    hit_count: signature.hit_count,
    ttl_days: signature.ttl_days ?? null,
    decay_rate: signature.decay_rate ?? null,
  }));
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

/** Hash the C derivation body separately from its request/projection binding. */
export function failureReviewDerivationDigest(candidate: FailureReviewCandidate): string {
  return sha256Hex(stableJson({
    cause_hypotheses: candidate.cause_hypotheses,
    alternative_hypotheses: candidate.alternative_hypotheses,
    observation_error_hypotheses: candidate.observation_error_hypotheses,
    scope_assessment: candidate.scope_assessment,
    counterexamples: candidate.counterexamples,
    resume_conditions: candidate.resume_conditions,
    additional_observations: candidate.additional_observations,
  }));
}

export function failureReviewExperienceDigest(projection: FailureReviewProjection): string {
  return sha256Hex(stableJson({
    evidence_log_id_digests: projection.evidence_log_id_digests,
    independent_observation_source_status: projection.independent_observation_source_status,
    independent_observations: projection.independent_observations,
  }));
}

/** Build a digest-only M record for a J-reviewed, still-unadopted C derivation. */
export function buildFailureLearningLineageRecord(input: {
  projection: FailureReviewProjection;
  candidate: FailureReviewCandidate;
  request_id: string;
  command_id: string;
  derived_at?: Date;
}): FailureLearningLineageRecord {
  const projection = FailureReviewProjectionSchema.parse(input.projection);
  const candidate = FailureReviewCandidateSchema.parse(input.candidate);
  if (candidate.signature_id !== projection.signature_id || candidate.signature_digest !== projection.signature_digest ||
      candidate.projection_digest !== failureReviewProjectionDigest(projection)) {
    throw new Error("failure learning candidate is not bound to current projection");
  }
  const content = {
    schema_version: "blue-tanuki.failure-learning-lineage.v1" as const,
    signature_id_digest: sha256Hex(projection.signature_id),
    signature_digest: projection.signature_digest,
    pre_state_digest: projection.pre_state_digest,
    scope: projection.scope,
    retention_period: projection.retention_period,
    experience_reference_digests: projection.evidence_log_id_digests,
    experience_digest: failureReviewExperienceDigest(projection),
    prior_lineage_record_digests: projection.prior_learning_lineages.map((lineage) => lineage.record_digest),
    request_id_digest: sha256Hex(input.request_id),
    command_id_digest: sha256Hex(input.command_id),
    projection_digest: failureReviewProjectionDigest(projection),
    candidate_content_digest: sha256Hex(stableJson(candidate)),
    derivation_digest: failureReviewDerivationDigest(candidate),
    application_target: "failure-memory.learning-lineage.v1" as const,
    derivation_categories: [...new Set(candidate.cause_hypotheses.map((hypothesis) => hypothesis.category))].sort() as FailureType[],
    derived_at: (input.derived_at ?? new Date()).toISOString(),
    learning_action_status: "candidate_derivation_recorded" as const,
    validity_status: "not_assessed" as const,
    improvement_status: "not_measured" as const,
    generalization_status: "not_assessed" as const,
    c_result_binding_status: "request_bound" as const,
    internal_derivation_attribution_status: "not_established" as const,
    external_change_contribution_status: "not_assessed" as const,
    teacher_input_contribution_status: "excluded_from_c_projection" as const,
    adoption_status: "not_adopted" as const,
    approval_status: "not_requested" as const,
    memory_application_status: "stored_for_future_reference" as const,
    follow_up_action_status: "unconfirmed" as const,
    cross_store_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return FailureLearningLineageRecordSchema.parse({
    ...content,
    record_id: sha256Hex(stableJson(content)),
  });
}

/** Separate a J-reviewed runtime learning candidate into a development-only inbox record. */
export function buildFailureLearningDevelopmentHandoff(
  recordInput: FailureLearningLineageRecord,
  candidateInput: FailureReviewCandidate,
): FailureLearningDevelopmentHandoff {
  const record = FailureLearningLineageRecordSchema.parse(recordInput);
  const candidate = FailureReviewCandidateSchema.parse(candidateInput);
  const candidateDigest = sha256Hex(stableJson(candidate));
  if (candidate.signature_id.length === 0 ||
      sha256Hex(candidate.signature_id) !== record.signature_id_digest ||
      candidate.signature_digest !== record.signature_digest ||
      candidate.projection_digest !== record.projection_digest ||
      record.candidate_content_digest !== candidateDigest ||
      record.derivation_digest !== failureReviewDerivationDigest(candidate)) {
    throw new Error("failure learning development handoff is not bound to its stored candidate");
  }
  return FailureLearningDevelopmentHandoffSchema.parse({
    schema_version: "blue-tanuki.failure-learning-development-handoff.v1",
    handoff_id: sha256Hex(`blue-tanuki.failure-learning-development-handoff.v1:${record.record_id}`),
    source_record_digest: record.record_id,
    source_signature_digest: record.signature_digest,
    source_projection_digest: record.projection_digest,
    source_derivation_digest: record.derivation_digest,
    candidate_content_digest: candidateDigest,
    candidate_kind: "runtime_learning_signal",
    candidate,
    source_state: {
      learning_action_status: record.learning_action_status ?? "candidate_derivation_recorded",
      validity_status: record.validity_status ?? "not_assessed",
      improvement_status: record.improvement_status ?? "not_measured",
      generalization_status: record.generalization_status ?? "not_assessed",
      c_result_binding_status: record.c_result_binding_status ?? "request_bound",
      internal_derivation_attribution_status: record.internal_derivation_attribution_status ?? "not_established",
      external_change_contribution_status: record.external_change_contribution_status ?? "not_assessed",
      teacher_input_contribution_status: record.teacher_input_contribution_status ?? "excluded_from_c_projection",
    },
    created_at: record.derived_at,
    development_status: "awaiting_development_review",
    may_promote_version: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function failureLearningLineageReference(record: FailureLearningLineageRecord): FailureReviewLineageReference {
  const parsed = FailureLearningLineageRecordSchema.parse(record);
  return FailureReviewLineageReferenceSchema.parse({
    record_digest: parsed.record_id,
    signature_digest: parsed.signature_digest,
    pre_state_digest: parsed.pre_state_digest,
    experience_digest: parsed.experience_digest,
    derivation_digest: parsed.derivation_digest,
    derived_at: parsed.derived_at,
    candidate_categories: parsed.derivation_categories,
    learning_action_status: parsed.learning_action_status ?? "candidate_derivation_recorded",
    validity_status: parsed.validity_status ?? "not_assessed",
    improvement_status: parsed.improvement_status ?? "not_measured",
    generalization_status: parsed.generalization_status ?? "not_assessed",
    c_result_binding_status: parsed.c_result_binding_status ?? "request_bound",
    internal_derivation_attribution_status: parsed.internal_derivation_attribution_status ?? "not_established",
    external_change_contribution_status: parsed.external_change_contribution_status ?? "not_assessed",
    teacher_input_contribution_status: parsed.teacher_input_contribution_status ?? "excluded_from_c_projection",
    adoption_status: parsed.adoption_status,
    approval_status: parsed.approval_status,
    memory_application_status: parsed.memory_application_status,
    follow_up_action_status: parsed.follow_up_action_status,
    used_for_authority: false,
    may_execute: false,
  });
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
    prior_learning_lineage_count: input.projection.prior_learning_lineages.length,
    prior_learning_lineage_digests: input.projection.prior_learning_lineages.map((lineage) => lineage.record_digest),
    prior_learning_lineage_connection_status: input.projection.prior_learning_lineages.length === 0
      ? "no_prior_lineages"
      : "candidate_bound_to_projection",
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
    prior_learning_lineage_count: projection.prior_learning_lineages.length,
    prior_learning_lineage_digests: projection.prior_learning_lineages.map((lineage) => lineage.record_digest),
    prior_learning_lineage_connection_status: projection.prior_learning_lineages.length === 0
      ? "no_prior_lineages"
      : "not_bound",
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
