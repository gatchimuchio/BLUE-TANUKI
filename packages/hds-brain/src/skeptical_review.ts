import type { LLMToolCallCandidate, SkepticalReviewRequest } from "@blue-tanuki/protocol";
import {
  assessCandidateGoalCriteria,
  digestGoalCriteriaValue,
  projectGoalCriteriaForBinding,
} from "./candidate_criteria.js";
import { determineCandidateAdoptionDisposition } from "./policy.js";
import type {
  DecisionLog,
  LLMToolCandidateAssessment,
  SkepticalReviewAuditTrace,
  SkepticalReviewCandidateTrace,
} from "./types.js";

/**
 * Reopen only the criterion scope named by a downstream review proposal.
 * The proposal is never treated as an observation, approval, or execution input.
 */
export function assessSkepticalReview(input: {
  review: SkepticalReviewRequest;
  sourceLog: DecisionLog | undefined;
  candidates: readonly LLMToolCallCandidate[];
  assessments: readonly LLMToolCandidateAssessment[];
}): SkepticalReviewAuditTrace {
  const reportDigests = input.review.observation_reports.map((report) => digestGoalCriteriaValue(report));
  const affectedCriterionDigests = [...new Set(
    input.review.observation_reports.map((report) => digestGoalCriteriaValue(report.criterion_ref)),
  )].sort();
  const contradictoryCriterionDigests = contradictoryScopes(input.review.observation_reports);
  const hypothesisDigests = (input.review.alternative_hypotheses ?? [])
    .map((hypothesis) => digestGoalCriteriaValue(hypothesis));
  const proposedCriteriaDigest = input.review.proposed_goal_criteria === undefined
    ? undefined
    : digestGoalCriteriaValue(input.review.proposed_goal_criteria);
  const sourceLog = input.sourceLog;
  const originalGoalProjectionId = sourceLog?.frame.goal_projection.projection_id;
  const originalGoalContentSha256 = sourceLog?.frame.goal_projection.original_request_ref.content_sha256;
  const proposedProjection = sourceLog && input.review.proposed_goal_criteria !== undefined
    ? projectGoalCriteriaForBinding(
      sourceLog.request_id,
      sourceLog.frame.goal_projection.original_request_ref.content_sha256,
      input.review.proposed_goal_criteria,
    )
    : undefined;

  const unmatchedCriterionDigests = sourceLog === undefined
    ? affectedCriterionDigests
    : affectedCriterionDigests.filter((criterionDigest) =>
      !sourceLog.frame.candidate_goal_criteria.criteria.some((criterion) =>
        criterion.criterion_ref_digest === criterionDigest,
      ) && !proposedProjection?.criteria.some((criterion) =>
        criterion.criterion_ref_digest === criterionDigest,
      ),
    );

  const frameCorrection: SkepticalReviewAuditTrace["frame_correction"] = {
    status: input.review.proposed_goal_criteria === undefined ? "not_proposed" : "proposed_unverified",
    ...(originalGoalProjectionId ? { original_goal_projection_id: originalGoalProjectionId } : {}),
    ...(originalGoalContentSha256 ? { original_goal_content_sha256: originalGoalContentSha256 } : {}),
    ...(proposedCriteriaDigest ? { proposed_criteria_digest: proposedCriteriaDigest } : {}),
    original_goal_binding_preserved: sourceLog !== undefined,
  };

  if (!sourceLog) {
    return {
      status: "unbound",
      observation_report_count: input.review.observation_reports.length,
      observation_report_digests: reportDigests,
      observation_claim_status: "assumed",
      affected_criterion_ref_digests: affectedCriterionDigests,
      conflicting_report_criterion_ref_digests: contradictoryCriterionDigests,
      unmatched_criterion_ref_digests: unmatchedCriterionDigests,
      alternative_hypothesis_count: hypothesisDigests.length,
      alternative_hypothesis_digests: hypothesisDigests,
      frame_correction: frameCorrection,
      candidate_reviews: [],
      follow_up_required: "none",
      may_execute: false,
      used_for_authority: false,
    };
  }

  if (unmatchedCriterionDigests.length > 0 || proposedProjection?.status === "invalid") {
    return {
      status: "unmatched_scope",
      observation_report_count: input.review.observation_reports.length,
      observation_report_digests: reportDigests,
      observation_claim_status: "assumed",
      affected_criterion_ref_digests: affectedCriterionDigests,
      conflicting_report_criterion_ref_digests: contradictoryCriterionDigests,
      unmatched_criterion_ref_digests: unmatchedCriterionDigests,
      alternative_hypothesis_count: hypothesisDigests.length,
      alternative_hypothesis_digests: hypothesisDigests,
      frame_correction: frameCorrection,
      candidate_reviews: input.assessments.map(preservedCandidate),
      follow_up_required: "none",
      may_execute: false,
      used_for_authority: false,
    };
  }

  const candidateReviews = input.candidates.flatMap((candidate, index) => {
    const previous = input.assessments[index];
    if (!previous) return [];
    const proposedGoalCriteria = proposedProjection?.status === "provided"
      ? assessCandidateGoalCriteria(candidate.tool_name, proposedProjection, {
        request_id: sourceLog.request_id,
        content_sha256: sourceLog.frame.goal_projection.original_request_ref.content_sha256,
      })
      : undefined;
    const relationToProposedFrame = proposedGoalCriteria !== undefined &&
      proposedGoalCriteria.reason_code !== "no_matching_goal_criterion" &&
      proposedGoalCriteria.reason_code !== "criteria_unavailable";
    const affectedByExistingScope = previous.goal_criteria.criterion_ref_digests.some((digest) =>
      affectedCriterionDigests.includes(digest),
    );
    const affected = affectedByExistingScope || relationToProposedFrame;

    let reviewDisposition = previous.adoption_disposition;
    if (affected && proposedGoalCriteria) {
      reviewDisposition = determineCandidateAdoptionDisposition({
        mechanical_contract: previous.mechanical_contract.outcome,
        domain_validation: previous.domain_validation.outcome,
        semantic_outcome: previous.semantic_judgment.outcome,
        semantic_evidence_status: previous.semantic_judgment.evidence_status,
        goal_criteria: proposedGoalCriteria,
      });
    } else if (affected) {
      // Existing candidate facts remain intact; only the questioned relation is held.
      reviewDisposition = "held";
    }

    const trace: SkepticalReviewCandidateTrace = {
      candidate_digest: previous.candidate_digest,
      scope_status: affected ? "affected" : "preserved",
      prior_adoption_disposition: previous.adoption_disposition,
      review_disposition: affected ? reviewDisposition : previous.adoption_disposition,
      retained_checks: {
        mechanical_contract: previous.mechanical_contract,
        domain_validation: previous.domain_validation,
      },
      ...(affected && proposedGoalCriteria ? { proposed_goal_criteria: proposedGoalCriteria } : {}),
      may_execute: false,
      used_for_authority: false,
    };
    return [trace];
  });

  return {
    status: "recorded",
    observation_report_count: input.review.observation_reports.length,
    observation_report_digests: reportDigests,
    observation_claim_status: "assumed",
    affected_criterion_ref_digests: affectedCriterionDigests,
    conflicting_report_criterion_ref_digests: contradictoryCriterionDigests,
    unmatched_criterion_ref_digests: [],
    alternative_hypothesis_count: hypothesisDigests.length,
    alternative_hypothesis_digests: hypothesisDigests,
    frame_correction: frameCorrection,
    candidate_reviews: candidateReviews,
    follow_up_required: affectedCriterionDigests.length > 0 ? "independent_observation" : "none",
    may_execute: false,
    used_for_authority: false,
  };
}

export function invalidSkepticalReviewTrace(): SkepticalReviewAuditTrace {
  return {
    status: "invalid",
    observation_report_count: 0,
    observation_report_digests: [],
    observation_claim_status: "assumed",
    affected_criterion_ref_digests: [],
    conflicting_report_criterion_ref_digests: [],
    unmatched_criterion_ref_digests: [],
    alternative_hypothesis_count: 0,
    alternative_hypothesis_digests: [],
    frame_correction: { status: "not_proposed", original_goal_binding_preserved: false },
    candidate_reviews: [],
    follow_up_required: "none",
    may_execute: false,
    used_for_authority: false,
  };
}

function preservedCandidate(assessment: LLMToolCandidateAssessment): SkepticalReviewCandidateTrace {
  return {
    candidate_digest: assessment.candidate_digest,
    scope_status: "preserved",
    prior_adoption_disposition: assessment.adoption_disposition,
    review_disposition: assessment.adoption_disposition,
    retained_checks: {
      mechanical_contract: assessment.mechanical_contract,
      domain_validation: assessment.domain_validation,
    },
    may_execute: false,
    used_for_authority: false,
  };
}

function contradictoryScopes(
  reports: SkepticalReviewRequest["observation_reports"],
): string[] {
  const relations = new Map<string, Set<string>>();
  for (const report of reports) {
    const digest = digestGoalCriteriaValue(report.criterion_ref);
    const values = relations.get(digest) ?? new Set<string>();
    if (report.relation !== "unclear") values.add(report.relation);
    relations.set(digest, values);
  }
  return [...relations.entries()]
    .filter(([, values]) => values.has("supports") && values.has("conflicts"))
    .map(([digest]) => digest)
    .sort();
}
