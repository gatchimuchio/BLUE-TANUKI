import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayInternalInboundRequest, meaningUpdateCandidateDigest, type OperationPlan } from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { AuditLog } from "../src/audit.js";
import { evaluateApproval, meaningUpdateAdoptionApprovalTarget } from "../src/approval_policy.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";
import { buildMeaningUpdateMemoryRecord, MeaningUpdateMemoryConsumer, meaningUpdateInterpretationId,
  meaningUpdateMemoryRecordId } from "../src/meaning_update_memory.js";
import { operationPlanDigest } from "../src/operation_plan.js";
import type { OperationPlanMemoryStorage } from "../src/operation_plan.js";

const temporaryRoots: string[] = [];

function citedMemoryPlan(requestId: string): OperationPlan {
  const target = { kind: "directory" as const, id: "fixture-root" };
  const expected = { root: "fixture-root", sandbox_root: "fixture-root", query: "blue", visited_files: 1,
    matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
  return { version: "operation-core.v1", plan_id: `plan-${requestId}`, request_id: requestId, state: "planned",
    steps: [{ step_id: "search", operation: "file.search", target, state: "planned", effects: ["read"],
      permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { root: "fixture-root", query: "blue", max_results: 1 },
      preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{ check_id: "plan-search-result",
        method: "result_equals", target, expected }], compensation: { available: false, reason: "read-only" } } }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C meaning update to owner L3 and J/M consumer", () => {
  it("persists the exact candidate only after content review and a matching L3 approval", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-meaning-update-l3-"));
    temporaryRoots.push(root);
    const privateRoot = join(root, "private-state");
    mkdirSync(privateRoot, { recursive: true });
    const storage: OperationPlanMemoryStorage = {
      private_state_root: privateRoot,
      database_path: join(privateRoot, "j-control.sqlite"),
      memory_database_path: join(privateRoot, "m-state.sqlite"),
    };
    const auditPath = join(root, "hds-audit.jsonl");
    let hds = new HDSUpperController({
      audit: new AuditLog({ filepath: auditPath }),
      memory: new LongTermMemoryStore(),
      meaning_update_memory: storage,
    });

    try {
      hds.decide({ id: "citation-support", channel: "test", user: "fixture-user", content: "first source fact",
        timestamp: 1 });
      hds.decide({ id: "citation-counter", channel: "test", user: "fixture-user", content: "second source counterpoint",
        timestamp: 2 });
      const sourceRequest = createGatewayInternalInboundRequest({
        id: "citation-current-request", channel: "test", user: "webchat-owner-token-holder",
        content: "compare F:citation-support with F:citation-counter", timestamp: 3,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner" },
      });
      const source = hds.decide(sourceRequest);
      expect(source.command?.type).toBe("llm_call");
      if (!source.command || source.command.type !== "llm_call") throw new Error("expected the C proposal command");
      const support = source.log.frame.memory_trace.hits.find((hit) => hit.memory_id === "citation-support");
      const counter = source.log.frame.memory_trace.hits.find((hit) => hit.memory_id === "citation-counter");
      const plan = source.log.frame.memory_trace.search_plan;
      if (!support || !counter || !plan) throw new Error("expected current J/M references and scope");

      const candidateMeaning = "Synthetic owner-reviewed candidate meaning.";
      const proposal = {
        schema_version: "blue-tanuki.meaning-update-proposal.v3",
        record_type: "meaning_update_proposal",
        proposal_ref: "proposal-c07-02-l3",
        candidate_ref: "candidate:c07-02-l3",
        candidate_digest: meaningUpdateCandidateDigest(candidateMeaning),
        candidate_meaning: candidateMeaning,
        target_reference: { record_id: support.f_reference, version: support.entry_hash },
        prior_version_ref: "version:meaning-support-prior",
        supporting_evidence: [{ reference: support.f_reference, digest: support.entry_hash }],
        counterevidence_review: {
          status: "reviewed_with_references" as const,
          review_scope: { reference: plan.application_scope_id, digest: plan.plan_id },
          references: [{ reference: counter.f_reference, digest: counter.entry_hash }],
        },
        applicability_scope: { reference: plan.application_scope_id, digest: plan.plan_id },
        reflection_target_ref: "reflection:meaning-source",
        proposal_status: "unverified",
        adoption_status: "not_adopted",
        may_apply: false,
        used_for_authority: false,
      };
      hds.onFeedback({ command_id: source.command.id, status: "success", meaning_update_proposal: proposal,
        metrics: { duration_ms: 1 } });

      const feedbackAudit = hds.getAudit().list().map(({ log }) => log).find((log) => "kind" in log &&
        log.kind === "executor_feedback" && log.command_id === source.command!.id);
      expect(feedbackAudit).toMatchObject({ kind: "executor_feedback", feedback: {
        meaning_update_proposal_contract_status: "passed",
        meaning_update_proposal_reference_review: { review_status: "prior_version_unverified" },
      } });
      const ownerReview = hds.getMeaningUpdateProposalForOwnerReview(source.command.id);
      expect(ownerReview?.reference_review.review_status).toBe("prior_version_unverified");
      expect(ownerReview?.proposal.candidate_meaning).toBe(candidateMeaning);
      const args = {
        proposal_digest: ownerReview!.proposal_digest,
        candidate_digest: ownerReview!.proposal.candidate_digest,
        target_record_id: ownerReview!.proposal.target_reference.record_id,
        target_version: ownerReview!.proposal.target_reference.version,
      };
      const requestId = "meaning-owner-review-request";
      const proposalActor = "webchat-owner-token-holder";
      const request = createGatewayInternalInboundRequest({
        id: requestId,
        channel: "webchat",
        user: proposalActor,
        content: "Owner submitted a C meaning-update candidate for L3 review.",
        timestamp: 4,
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner",
          "blue_tanuki.process_kind": "approval",
          "blue_tanuki.meaning_update_adoption.version": "v1",
          "blue_tanuki.tool_call": { tool_name: "memory.meaning.adopt", arguments: args },
        },
      });
      const approval = hds.decide(request);
      expect(approval.log.commit.decision).toBe("ASSERT");
      expect(approval.command?.type).toBe("tool_call");
      if (!approval.command) throw new Error("expected the internal L3 tool command");
      const evaluation = evaluateApproval(approval.command, [], { actor: proposalActor, default_mode: "full_access" });
      hds.onApprovalEvaluation(evaluation, { request_id: requestId });
      const commandDigest = "a".repeat(64);
      expect(hds.recordMeaningUpdateProposalContentReview({ source_command_id: source.command.id, args,
        request_id: requestId, command_id: approval.command.id, proposal_actor: proposalActor,
        command_digest: commandDigest })).toBe(true);

      const approvalEntry = hds.getAudit().list().find(({ log }) => "kind" in log && log.kind === "approval_gate" &&
        log.request_id === requestId && log.command_id === approval.command!.id);
      if (!approvalEntry || !("kind" in approvalEntry.log) || approvalEntry.log.kind !== "approval_gate") {
        throw new Error("expected an audited L3 approval evaluation");
      }
      expect(approvalEntry.log.evaluation.approval_level).toBe("L3_final_review");
      expect(approvalEntry.log.evaluation.final_review_required).toBe(true);
      expect(hds.commitMeaningUpdateAfterL3({ source_command_id: source.command.id, args,
        request_id: requestId, command_id: approval.command.id, command_digest: commandDigest,
        content_review_digest: commandDigest, proposal_actor: proposalActor, reviewer_actor: proposalActor,
        evaluation: approvalEntry.log.evaluation })).toEqual({ ok: false, reason: "approval_not_verified" });
      hds.onCommandLifecycle(approval.command.id, "approval_approved", {
        actor: proposalActor, reason: "human_approval:approve", request_id: requestId,
      });
      expect(hds.commitMeaningUpdateAfterL3({ source_command_id: source.command.id, args,
        request_id: requestId, command_id: approval.command.id, command_digest: commandDigest,
        content_review_digest: "b".repeat(64), proposal_actor: proposalActor, reviewer_actor: proposalActor,
        evaluation: approvalEntry.log.evaluation })).toEqual({ ok: false, reason: "approval_not_verified" });
      const committed = hds.commitMeaningUpdateAfterL3({ source_command_id: source.command.id, args,
        request_id: requestId, command_id: approval.command.id, command_digest: commandDigest,
        content_review_digest: commandDigest, proposal_actor: proposalActor, reviewer_actor: proposalActor,
        evaluation: approvalEntry.log.evaluation });
      expect(committed).toEqual({ ok: true, proposal_digest: ownerReview!.proposal_digest,
        candidate_digest: ownerReview!.proposal.candidate_digest, approval_status: "approved",
        memory_application_status: "applied", follow_up_action_status: "unconfirmed" });

      const citationRequest = createGatewayInternalInboundRequest({ id: "citation-after-interpretation",
        channel: "test", user: "webchat-owner-token-holder",
        content: `compare ${support.f_reference} with ${counter.f_reference}`, timestamp: 5,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner" },
      });
      const citationDecision = hds.decide(citationRequest);
      if (!citationDecision.command || citationDecision.command.type !== "llm_call") {
        throw new Error("expected the cited-memory C request");
      }
      const citationTrace = citationDecision.log.frame.memory_trace;
      const citationContent = JSON.stringify({ schema_version: "blue-tanuki.memory-citation-response.v1",
        answer: "Synthetic comparison.", citations: [{ claim: "Synthetic comparison claim.",
          supporting: { record_id: support.f_reference, version: support.entry_hash },
          counterevidence: { record_id: counter.f_reference, version: counter.entry_hash },
          application_scope_id: citationTrace.search_plan!.application_scope_id }] });
      hds.reviewMemoryCitations(citationDecision.command, { command_id: citationDecision.command.id,
        status: "success", result: { content: citationContent }, metrics: { duration_ms: 1 } });
      const citationReview = hds.getAudit().list().map(({ log }) => log).find((log) => "kind" in log &&
        log.kind === "memory_citation_review" && log.command_id === citationDecision.command!.id);
      expect(citationReview && "interpretation_dependencies" in citationReview
        ? citationReview.interpretation_dependencies : undefined).toMatchObject([{
        reference: { record_id: support.f_reference, version: support.entry_hash },
        interpretation_id: meaningUpdateInterpretationId(buildMeaningUpdateMemoryRecord(ownerReview!.proposal)),
      }]);
      const citationJudgmentRefs = citationReview && "interpretation_dependencies" in citationReview
        ? (citationReview.interpretation_dependencies ?? []).map((dependency) => dependency.judgment_ref) : [];
      expect(citationJudgmentRefs).toHaveLength(1);

      const nextMeaning = "Synthetic corrected candidate meaning.";
      const citationPlan = citedMemoryPlan(citationRequest.id);
      const nextProposal = { ...ownerReview!.proposal,
        proposal_ref: "proposal-c07-03-corrected",
        candidate_ref: "candidate:c07-03-corrected",
        candidate_digest: meaningUpdateCandidateDigest(nextMeaning),
        candidate_meaning: nextMeaning,
        prior_version_ref: "version:meaning-support-after-correction",
        counterevidence_review: { ...ownerReview!.proposal.counterevidence_review,
          review_scope: { reference: citationTrace.search_plan!.application_scope_id, digest: citationTrace.search_plan!.plan_id } },
        applicability_scope: { reference: citationTrace.search_plan!.application_scope_id, digest: citationTrace.search_plan!.plan_id },
      };
      hds.onFeedback({ command_id: citationDecision.command.id, status: "success", result: { content: "Synthetic response.",
        operation_core: { status: "valid_plan", plan: citationPlan } },
        meaning_update_proposal: nextProposal, metrics: { duration_ms: 1 } });
      const nextOwnerReview = hds.getMeaningUpdateProposalForOwnerReview(citationDecision.command.id);
      expect(nextOwnerReview?.proposal.candidate_meaning).toBe(nextMeaning);
      const nextArgs = {
        proposal_digest: nextOwnerReview!.proposal_digest,
        candidate_digest: nextOwnerReview!.proposal.candidate_digest,
        target_record_id: nextOwnerReview!.proposal.target_reference.record_id,
        target_version: nextOwnerReview!.proposal.target_reference.version,
      };
      const nextApprovalRequestId = "meaning-owner-review-request-2";
      const nextApproval = hds.decide(createGatewayInternalInboundRequest({
        id: nextApprovalRequestId, channel: "webchat", user: proposalActor,
        content: "Owner submitted a C meaning-update candidate for L3 review.", timestamp: 6,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "approval",
          "blue_tanuki.meaning_update_adoption.version": "v1",
          "blue_tanuki.tool_call": { tool_name: "memory.meaning.adopt", arguments: nextArgs } },
      }));
      expect(nextApproval.command?.type, nextApproval.log.commit.reason).toBe("tool_call");
      if (!nextApproval.command) throw new Error("expected the corrected internal L3 command");
      const nextEvaluation = evaluateApproval(nextApproval.command, [], { actor: proposalActor, default_mode: "full_access" });
      hds.onApprovalEvaluation(nextEvaluation, { request_id: nextApprovalRequestId });
      const nextCommandDigest = "c".repeat(64);
      expect(hds.recordMeaningUpdateProposalContentReview({ source_command_id: citationDecision.command.id, args: nextArgs,
        request_id: nextApprovalRequestId, command_id: nextApproval.command.id, proposal_actor: proposalActor,
        command_digest: nextCommandDigest })).toBe(true);
      const nextApprovalEntry = hds.getAudit().list().find(({ log }) => "kind" in log && log.kind === "approval_gate" &&
        log.request_id === nextApprovalRequestId && log.command_id === nextApproval.command!.id);
      if (!nextApprovalEntry || !("kind" in nextApprovalEntry.log) || nextApprovalEntry.log.kind !== "approval_gate") {
        throw new Error("expected the corrected L3 approval evaluation");
      }
      hds.onCommandLifecycle(nextApproval.command.id, "approval_approved", {
        actor: proposalActor, reason: "human_approval:approve", request_id: nextApprovalRequestId,
      });
      expect(hds.commitMeaningUpdateAfterL3({ source_command_id: citationDecision.command.id, args: nextArgs,
        request_id: nextApprovalRequestId, command_id: nextApproval.command.id, command_digest: nextCommandDigest,
        content_review_digest: nextCommandDigest, proposal_actor: proposalActor, reviewer_actor: proposalActor,
        evaluation: nextApprovalEntry.log.evaluation })).toEqual({ ok: true, proposal_digest: nextOwnerReview!.proposal_digest,
        candidate_digest: nextOwnerReview!.proposal.candidate_digest, approval_status: "approved",
        memory_application_status: "applied", follow_up_action_status: "unconfirmed" });
      const blockedPlanReview = hds.decide(createGatewayInternalInboundRequest({
        id: "plan-review-after-meaning-change", channel: "test", user: "webchat-owner-token-holder",
        content: `plan:review ${JSON.stringify({ plan_id: operationPlanDigest(citationPlan.plan_id),
          revision_digest: operationPlanDigest(citationPlan), step_id: operationPlanDigest("search") })}`,
        timestamp: 7,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer",
          "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner" },
      }));
      expect(blockedPlanReview.command).toBeNull();
      expect(blockedPlanReview.log.commit.reason).toContain("plan_control_denied:plan_memory_interpretation_reassessment_required");

      const auditText = JSON.stringify(hds.getAudit().list());
      expect(auditText).not.toContain(candidateMeaning);
      expect(auditText).toContain(ownerReview!.proposal.candidate_digest);
      expect(hds.getAudit().verify()).toBe(true);
      expect(meaningUpdateAdoptionApprovalTarget(args)).toContain(ownerReview!.proposal_digest);

      hds.close();
      hds = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }),
        memory: new LongTermMemoryStore(), meaning_update_memory: storage });
      expect(hds.getAudit().verify()).toBe(true);
      hds.close();
      const persisted = new MeaningUpdateMemoryConsumer(storage, {
        readVerifiedMemoryApproval: (reference) => ({ ...reference }),
      });
      try {
        const record = persisted.read(meaningUpdateMemoryRecordId(ownerReview!.proposal_digest));
        expect(record).toMatchObject({ approval_status: "approved", memory_application_status: "applied",
          follow_up_action_status: "unconfirmed", semantic_relation_status: "not_assessed",
          used_for_authority: false, may_execute: false, proposal: { candidate_meaning: candidateMeaning } });
        const initialInterpretationId = meaningUpdateInterpretationId(record!);
        const nextRecord = buildMeaningUpdateMemoryRecord(nextOwnerReview!.proposal);
        const nextCommit = persisted.commit(nextRecord, () => {}, citationJudgmentRefs);
        expect(nextCommit.ok).toBe(true);
        const correctedInterpretation = persisted.readInterpretation(support.f_reference);
        const nextInterpretationId = meaningUpdateInterpretationId(nextRecord);
        expect(correctedInterpretation?.record).toMatchObject({
          application_state: "active",
          current_interpretation_id: nextInterpretationId,
          interpretations: [
            { interpretation_id: initialInterpretationId, meaning: { candidate_meaning: candidateMeaning } },
            { interpretation_id: nextInterpretationId, meaning: { candidate_meaning: nextMeaning } },
          ],
          events: [
            { kind: "quarantined", prior_interpretation_id: initialInterpretationId, resulting_interpretation_id: null,
              affected_judgment_refs: ["meaning-update-approval:" + ownerReview!.proposal_digest, ...citationJudgmentRefs] },
            { kind: "restored", prior_interpretation_id: initialInterpretationId, resulting_interpretation_id: nextInterpretationId,
              affected_judgment_refs: ["meaning-update-approval:" + ownerReview!.proposal_digest, ...citationJudgmentRefs] },
          ],
          dependent_judgments: [
            { judgment_ref: "meaning-update-approval:" + ownerReview!.proposal_digest,
              basis_interpretation_id: initialInterpretationId, reassessment_required: true },
            ...citationJudgmentRefs.map((judgment_ref) => ({ judgment_ref,
              basis_interpretation_id: initialInterpretationId, reassessment_required: true })),
            { judgment_ref: "meaning-update-approval:" + nextRecord.proposal_digest,
              basis_interpretation_id: nextInterpretationId, reassessment_required: false },
          ],
          used_for_authority: false,
          may_execute: false,
        });
        expect(persisted.verify()).toBe(true);
      } finally {
        persisted.close();
      }
    } finally {
      hds.close();
    }
  });
});
