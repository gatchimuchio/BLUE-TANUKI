import { createHash } from "node:crypto";
import {
  parseMeaningUpdateProposal,
  type MeaningUpdateProposal,
  type MeaningUpdateProposalV3,
  type OperationPlanComputeSourceObservation,
} from "@blue-tanuki/protocol";
import {
  reviewMeaningUpdateProposalReferences,
  type MeaningUpdateProposalReferenceReview,
} from "./memory_citation_review.js";
import type { ExecutorFeedbackAuditTrace, MemoryTrace } from "./types.js";

export interface MeaningUpdateSourceObservationBinding {
  readonly schema_version: "blue-tanuki.meaning-update-source-observation-binding.v1";
  readonly digest: string;
  readonly count: number;
  readonly used_as_world_truth: false;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export type MeaningUpdateProposalContractStatus = "not_present" | "passed" | "failed";
export type MeaningUpdateProposalParse = ReturnType<typeof parseMeaningUpdateProposal>;
export type MeaningUpdateProposalReferenceAssessment =
  ExecutorFeedbackAuditTrace["meaning_update_proposal_reference_review"];

export interface MeaningUpdateProposalPreparedAssessment {
  readonly proposal_parse: MeaningUpdateProposalParse | undefined;
  readonly contract_status: MeaningUpdateProposalContractStatus;
  readonly source_observation_binding?: MeaningUpdateSourceObservationBinding;
}

export interface MeaningUpdateProposalAssessment extends MeaningUpdateProposalPreparedAssessment {
  readonly reference_review: MeaningUpdateProposalReferenceAssessment;
  readonly owner_review_ready: boolean;
}

export type MeaningUpdateProposalReferenceAssessmentResult =
  | { readonly reference_review: MeaningUpdateProposalReferenceReview; readonly owner_review_ready: true }
  | { readonly reference_review: MeaningUpdateProposalReferenceAssessment; readonly owner_review_ready: false };

export interface MeaningUpdateOwnerReviewCandidatePayload {
  readonly proposal: MeaningUpdateProposalV3;
  readonly proposal_digest: string;
  readonly source_observation_binding?: MeaningUpdateSourceObservationBinding;
}

/** Canonical bytes shared by proposal identity and its persisted M record. */
export function canonicalMeaningUpdateJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalMeaningUpdateJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalMeaningUpdateJson(item)}`).join(",")}}`;
}

export function meaningUpdateProposalDigest(proposal: MeaningUpdateProposalV3): string {
  return createHash("sha256").update(canonicalMeaningUpdateJson(proposal), "utf8").digest("hex");
}

/** Bind only J-selected, bounded observation metadata; never retain C's raw result. */
export function buildMeaningUpdateSourceObservationBinding(
  observations: readonly OperationPlanComputeSourceObservation[],
): MeaningUpdateSourceObservationBinding | undefined {
  if (observations.length < 1 || observations.length > 8) return undefined;
  return Object.freeze({
    schema_version: "blue-tanuki.meaning-update-source-observation-binding.v1",
    digest: createHash("sha256").update(canonicalMeaningUpdateJson(observations), "utf8").digest("hex"),
    count: observations.length,
    used_as_world_truth: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function isMeaningUpdateSourceObservationBinding(value: unknown): value is MeaningUpdateSourceObservationBinding {
  return isRecord(value) && hasExactKeys(value, ["schema_version", "digest", "count", "used_as_world_truth",
      "used_for_authority", "may_execute"]) &&
    value.schema_version === "blue-tanuki.meaning-update-source-observation-binding.v1" &&
    typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= 8 &&
    value.used_as_world_truth === false && value.used_for_authority === false && value.may_execute === false;
}

/** Purely parse and bind a C proposal to the verified command/result envelope. */
export function prepareMeaningUpdateProposalAssessment(input: {
  readonly proposal: unknown | undefined;
  readonly feedback_succeeded: boolean;
  readonly source_available: boolean;
  readonly eligible_llm_compute: boolean;
  readonly source_observations?: readonly OperationPlanComputeSourceObservation[];
}): MeaningUpdateProposalPreparedAssessment {
  const proposalParse = input.proposal === undefined ? undefined : parseMeaningUpdateProposal(input.proposal);
  const sourceObservationBinding = input.source_observations?.length
    ? buildMeaningUpdateSourceObservationBinding(input.source_observations) : undefined;
  const contractStatus = input.proposal === undefined
    ? "not_present" as const
    : input.feedback_succeeded && input.source_available && proposalParse?.ok === true && input.eligible_llm_compute &&
      (!input.source_observations?.length || sourceObservationBinding !== undefined)
      ? "passed" as const
      : "failed" as const;
  return Object.freeze({
    proposal_parse: proposalParse,
    contract_status: contractStatus,
    ...(sourceObservationBinding ? { source_observation_binding: sourceObservationBinding } : {}),
  });
}

/** Complete the pure candidate review using only already-read J/M projections. */
export function completeMeaningUpdateProposalAssessment(input: {
  readonly prepared: MeaningUpdateProposalPreparedAssessment;
  readonly memory_trace?: MemoryTrace;
  readonly current_reference_versions?: ReadonlyMap<string, string | null> | null;
}): MeaningUpdateProposalAssessment {
  const { prepared } = input;
  let referenceAssessment: MeaningUpdateProposalReferenceAssessmentResult;
  if (!prepared.proposal_parse) {
    referenceAssessment = emptyReferenceAssessment("not_present");
  } else if (!prepared.proposal_parse.ok) {
    referenceAssessment = emptyReferenceAssessment("invalid_contract");
  } else if (prepared.contract_status !== "passed") {
    referenceAssessment = emptyReferenceAssessment("not_reviewed");
  } else {
    referenceAssessment = assessMeaningUpdateProposalReferences({
      proposal: prepared.proposal_parse.record,
      memory_trace: input.memory_trace,
      current_reference_versions: input.current_reference_versions,
    });
  }
  return Object.freeze({ ...prepared, ...referenceAssessment });
}

/** Purely review candidate references against the supplied current M projection. */
export function assessMeaningUpdateProposalReferences(input: {
  readonly proposal: MeaningUpdateProposal;
  readonly memory_trace?: MemoryTrace;
  readonly current_reference_versions?: ReadonlyMap<string, string | null> | null;
}): MeaningUpdateProposalReferenceAssessmentResult {
  const referenceReview = reviewMeaningUpdateProposalReferences(
      input.proposal,
      input.memory_trace,
      input.current_reference_versions,
    );
  return Object.freeze(isMeaningUpdateReviewReady(referenceReview)
    ? { reference_review: referenceReview, owner_review_ready: true as const }
    : { reference_review: referenceReview, owner_review_ready: false as const });
}

/** Retain only a verified, non-authoritative candidate for the existing owner-review path. */
export function buildMeaningUpdateOwnerReviewCandidate(input: {
  readonly assessment: MeaningUpdateProposalAssessment;
  readonly source_is_verified_asserted_compute: boolean;
}): MeaningUpdateOwnerReviewCandidatePayload | undefined {
  const parsed = input.assessment.proposal_parse;
  if (!parsed || !parsed.ok || !isMeaningUpdateProposalV3(parsed.record)) return undefined;
  if (!input.source_is_verified_asserted_compute || input.assessment.contract_status !== "passed" ||
      !input.assessment.owner_review_ready) return undefined;
  return Object.freeze({
    proposal: structuredClone(parsed.record),
    proposal_digest: meaningUpdateProposalDigest(parsed.record),
    ...(input.assessment.source_observation_binding
      ? { source_observation_binding: Object.freeze({ ...input.assessment.source_observation_binding }) }
      : {}),
  });
}

export function isMeaningUpdateReviewReady(review: MeaningUpdateProposalReferenceAssessment): boolean {
  return (review.review_status === "prior_version_unverified" || review.review_status === "counterevidence_absence_unverified") &&
    review.supporting_reference_count > 0 && review.supporting_reference_count === review.supporting_references_verified &&
    review.counterevidence_reference_count === review.counterevidence_references_verified &&
    review.scope_digests_verified && review.target_reference_matches_current_projection &&
    review.candidate_content_digest_status === "verified" && review.used_for_authority === false &&
    review.may_apply === false && review.adoption_status === "not_adopted" && review.semantic_relation_status === "not_assessed";
}

function emptyReferenceAssessment(status: "not_present" | "invalid_contract" | "not_reviewed"): MeaningUpdateProposalReferenceAssessmentResult {
  return Object.freeze({ reference_review: emptyReferenceReview(status), owner_review_ready: false });
}

function emptyReferenceReview(status: "not_present" | "invalid_contract" | "not_reviewed"): MeaningUpdateProposalReferenceAssessment {
  return {
    review_status: status,
    supporting_reference_count: 0,
    supporting_references_verified: 0,
    counterevidence_reference_count: 0,
    counterevidence_references_verified: 0,
    applicability_scope_matches_current: false,
    counterevidence_scope_matches_current: false,
    applicability_scope_digest_matches_current: false,
    counterevidence_scope_digest_matches_current: false,
    counterevidence_claim_status: status === "invalid_contract" ? "invalid_contract"
      : status === "not_present" ? "not_present" : "not_reviewed",
    scope_digests_verified: false,
    target_reference_matches_current_projection: false,
    candidate_content_digest_status: status === "not_present" ? "not_present"
      : status === "invalid_contract" ? "invalid" : "unavailable",
    target_and_prior_version_verified: false,
    semantic_relation_status: "not_assessed",
    adoption_status: "not_adopted",
    may_apply: false,
    used_for_authority: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isMeaningUpdateProposalV3(proposal: MeaningUpdateProposal): proposal is MeaningUpdateProposalV3 {
  return proposal.schema_version === "blue-tanuki.meaning-update-proposal.v3";
}
