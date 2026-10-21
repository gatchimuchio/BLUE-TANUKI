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
  const goalScopeReturns = buildGoalScopeReturns(input.review, affectedCriterionDigests, sourceLog, proposedProjection);
  const reportsByCriterion = reportDigestsByCriterion(input.review);

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
      goal_scope_returns: goalScopeReturns,
      alternative_hypothesis_count: hypothesisDigests.length,
      alternative_hypothesis_digests: hypothesisDigests,
      frame_correction: frameCorrection,
      candidate_reviews: input.assessments.map((assessment) =>
        preservedCandidate(assessment, "source_scope_unavailable")),
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
      goal_scope_returns: goalScopeReturns,
      alternative_hypothesis_count: hypothesisDigests.length,
      alternative_hypothesis_digests: hypothesisDigests,
      frame_correction: frameCorrection,
      candidate_reviews: input.assessments.map((assessment) => preservedCandidate(
        assessment,
        proposedProjection?.status === "invalid" ? "proposed_criteria_invalid" : "review_scope_unmatched",
      )),
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
    const currentScopeDigests = previous.goal_criteria.criterion_ref_digests
      .filter((digest) => affectedCriterionDigests.includes(digest));
    const proposedScopeDigests = proposedGoalCriteria?.criterion_ref_digests
      .filter((digest) => affectedCriterionDigests.includes(digest)) ?? [];
    const scopeRelationPaths = [
      ...relationPaths(currentScopeDigests, reportsByCriterion, "current_request_goal_criteria"),
      ...relationPaths(proposedScopeDigests, reportsByCriterion, "proposed_unverified_goal_criteria"),
    ];
    const affected = scopeRelationPaths.length > 0;

    let reviewDisposition = previous.adoption_disposition;
    if (proposedScopeDigests.length > 0 && proposedGoalCriteria) {
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
      scope_reason_code: affected
        ? currentScopeDigests.length > 0
          ? "reported_current_goal_criterion_relation"
          : "reported_proposed_goal_criterion_relation"
        : previous.goal_criteria.reason_code === "no_matching_goal_criterion" ||
            previous.goal_criteria.reason_code === "criteria_unavailable" ||
            previous.goal_criteria.reason_code === "criteria_invalid"
          ? "no_candidate_goal_criterion_relation"
          : "no_candidate_relation_to_reported_scope",
      scope_relation_paths: scopeRelationPaths,
      prior_adoption_disposition: previous.adoption_disposition,
      review_disposition: affected ? reviewDisposition : previous.adoption_disposition,
      retained_checks: {
        mechanical_contract: previous.mechanical_contract,
        domain_validation: previous.domain_validation,
      },
      ...(proposedScopeDigests.length > 0 && proposedGoalCriteria
        ? { proposed_goal_criteria: proposedGoalCriteria } : {}),
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
    goal_scope_returns: goalScopeReturns,
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
    goal_scope_returns: [],
    alternative_hypothesis_count: 0,
    alternative_hypothesis_digests: [],
    frame_correction: { status: "not_proposed", original_goal_binding_preserved: false },
    candidate_reviews: [],
    follow_up_required: "none",
    may_execute: false,
    used_for_authority: false,
  };
}

function preservedCandidate(
  assessment: LLMToolCandidateAssessment,
  reason: Extract<SkepticalReviewCandidateTrace["scope_reason_code"],
    "source_scope_unavailable" | "review_scope_unmatched" | "proposed_criteria_invalid">,
): SkepticalReviewCandidateTrace {
  return {
    candidate_digest: assessment.candidate_digest,
    scope_status: "preserved",
    scope_reason_code: reason,
    scope_relation_paths: [],
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

function buildGoalScopeReturns(
  review: SkepticalReviewRequest,
  criterionDigests: readonly string[],
  sourceLog: DecisionLog | undefined,
  proposedProjection: ReturnType<typeof projectGoalCriteriaForBinding> | undefined,
): SkepticalReviewAuditTrace["goal_scope_returns"] {
  const current = new Map((sourceLog?.frame.candidate_goal_criteria.criteria ?? [])
    .map((criterion) => [criterion.criterion_ref_digest, criterion] as const));
  const proposed = new Map((proposedProjection?.status === "provided" ? proposedProjection.criteria : [])
    .map((criterion) => [criterion.criterion_ref_digest, criterion] as const));
  const reportDigests = reportDigestsByCriterion(review);
  const reportsByCriterion = new Map<string, SkepticalReviewRequest["observation_reports"]>();
  for (const report of review.observation_reports) {
    const digest = digestGoalCriteriaValue(report.criterion_ref);
    const reports = reportsByCriterion.get(digest) ?? [];
    reports.push(report);
    reportsByCriterion.set(digest, reports);
  }
  return criterionDigests.map((criterionRefDigest) => {
    const currentCriterion = current.get(criterionRefDigest);
    const proposedCriterion = proposed.get(criterionRefDigest);
    const criterion = currentCriterion ?? proposedCriterion;
    const scopeBasis: SkepticalReviewAuditTrace["goal_scope_returns"][number]["scope_basis"] = !sourceLog
      ? "source_scope_unavailable"
      : currentCriterion ? "current_request_goal_criteria"
        : proposedCriterion ? "proposed_unverified_goal_criteria" : "unmatched";
    const reports = reportsByCriterion.get(criterionRefDigest) ?? [];
    return {
      criterion_ref_digest: criterionRefDigest,
      scope_basis: scopeBasis,
      ...(criterion ? { criterion_kind: criterion.criterion_kind } : {}),
      observation_report_digests: reportDigests.get(criterionRefDigest) ?? [],
      reported_relations: [...new Set(reports.map((report) => report.relation))].sort(),
    };
  });
}

function reportDigestsByCriterion(review: SkepticalReviewRequest): Map<string, string[]> {
  const byCriterion = new Map<string, Set<string>>();
  for (const report of review.observation_reports) {
    const criterionDigest = digestGoalCriteriaValue(report.criterion_ref);
    const digests = byCriterion.get(criterionDigest) ?? new Set<string>();
    digests.add(digestGoalCriteriaValue(report));
    byCriterion.set(criterionDigest, digests);
  }
  return new Map([...byCriterion].map(([criterionDigest, digests]) =>
    [criterionDigest, [...digests].sort()]));
}

function relationPaths(
  criterionDigests: readonly string[],
  reportsByCriterion: Map<string, string[]>,
  relationSource: "current_request_goal_criteria" | "proposed_unverified_goal_criteria",
): SkepticalReviewCandidateTrace["scope_relation_paths"] {
  return criterionDigests.map((criterionRefDigest) => ({
    criterion_ref_digest: criterionRefDigest,
    observation_report_digests: reportsByCriterion.get(criterionRefDigest) ?? [],
    relation_source: relationSource,
  }));
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
