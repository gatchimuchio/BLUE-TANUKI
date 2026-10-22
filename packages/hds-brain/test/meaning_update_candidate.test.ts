import { describe, expect, it } from "vitest";
import { meaningUpdateCandidateDigest } from "@blue-tanuki/protocol";
import {
  buildMeaningUpdateOwnerReviewCandidate,
  completeMeaningUpdateProposalAssessment,
  prepareMeaningUpdateProposalAssessment,
} from "../src/meaning_update_candidate.js";

function proposal() {
  const candidateMeaning = "Bounded synthetic candidate meaning.";
  return {
    schema_version: "blue-tanuki.meaning-update-proposal.v3",
    record_type: "meaning_update_proposal",
    proposal_ref: "proposal-candidate-assessment",
    candidate_ref: "candidate:candidate-assessment",
    candidate_digest: meaningUpdateCandidateDigest(candidateMeaning),
    candidate_meaning: candidateMeaning,
    target_reference: { record_id: "F:target-record", version: "2".repeat(64) },
    prior_version_ref: "version:prior-candidate-assessment",
    supporting_evidence: [{ reference: "F:support-record", digest: "3".repeat(64) }],
    counterevidence_review: {
      status: "reviewed_with_references" as const,
      review_scope: { reference: "scope:candidate-assessment", digest: "4".repeat(64) },
      references: [{ reference: "F:counter-record", digest: "5".repeat(64) }],
    },
    applicability_scope: { reference: "scope:candidate-assessment", digest: "4".repeat(64) },
    reflection_target_ref: "reflection:candidate-assessment",
    proposal_status: "unverified",
    adoption_status: "not_adopted",
    may_apply: false,
    used_for_authority: false,
  };
}

describe("意味更新候補の純粋評価", () => {
  it("提案がない場合はnon-authorityのnot_present投影を返す", () => {
    const prepared = prepareMeaningUpdateProposalAssessment({
      proposal: undefined,
      feedback_succeeded: false,
      source_available: false,
      eligible_llm_compute: false,
    });
    const assessment = completeMeaningUpdateProposalAssessment({ prepared });

    expect(assessment.contract_status).toBe("not_present");
    expect(assessment.reference_review).toMatchObject({
      review_status: "not_present",
      candidate_content_digest_status: "not_present",
      may_apply: false,
      used_for_authority: false,
    });
    expect(buildMeaningUpdateOwnerReviewCandidate({ assessment, source_is_verified_asserted_compute: true }))
      .toBeUndefined();
  });

  it("parseできてもresult/source条件を欠くC提案をreview前で止める", () => {
    const prepared = prepareMeaningUpdateProposalAssessment({
      proposal: proposal(),
      feedback_succeeded: true,
      source_available: false,
      eligible_llm_compute: true,
    });
    const assessment = completeMeaningUpdateProposalAssessment({ prepared });

    expect(prepared.proposal_parse?.ok).toBe(true);
    expect(assessment.contract_status).toBe("failed");
    expect(assessment.reference_review).toMatchObject({
      review_status: "not_reviewed",
      candidate_content_digest_status: "unavailable",
      may_apply: false,
      used_for_authority: false,
    });
    expect(buildMeaningUpdateOwnerReviewCandidate({ assessment, source_is_verified_asserted_compute: true }))
      .toBeUndefined();
  });

  it("有効なC結果も現行M/観測照合なしではowner review候補にしない", () => {
    const prepared = prepareMeaningUpdateProposalAssessment({
      proposal: proposal(),
      feedback_succeeded: true,
      source_available: true,
      eligible_llm_compute: true,
    });
    const assessment = completeMeaningUpdateProposalAssessment({ prepared });

    expect(assessment.contract_status).toBe("passed");
    expect(assessment.reference_review).toMatchObject({
      review_status: "no_current_projection",
      candidate_content_digest_status: "verified",
      may_apply: false,
      used_for_authority: false,
    });
    expect(buildMeaningUpdateOwnerReviewCandidate({ assessment, source_is_verified_asserted_compute: true }))
      .toBeUndefined();
  });

  it("malformed C material produces a redacted invalid assessment, not a retained candidate", () => {
    const prepared = prepareMeaningUpdateProposalAssessment({
      proposal: { ...proposal(), raw_candidate_text: "PRIVATE-CANDIDATE-SENTINEL" },
      feedback_succeeded: true,
      source_available: true,
      eligible_llm_compute: true,
    });
    const assessment = completeMeaningUpdateProposalAssessment({ prepared });

    expect(assessment.contract_status).toBe("failed");
    expect(assessment.reference_review).toMatchObject({
      review_status: "invalid_contract",
      candidate_content_digest_status: "invalid",
      may_apply: false,
      used_for_authority: false,
    });
    expect(JSON.stringify(assessment)).not.toContain("PRIVATE-CANDIDATE-SENTINEL");
    expect(buildMeaningUpdateOwnerReviewCandidate({ assessment, source_is_verified_asserted_compute: true }))
      .toBeUndefined();
  });
});
