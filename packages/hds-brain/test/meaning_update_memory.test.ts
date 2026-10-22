import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executorCommandDigest } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, meaningUpdateCandidateDigest, OperationPlanCheckpointSchema,
  type OperationPlan, type OperationPlanCheckpoint, type OperationStep } from "@blue-tanuki/protocol";
import { HDSUpperController, memoryCitationReviewAuditDigest } from "../src/controller.js";
import { AuditLog } from "../src/audit.js";
import { evaluateApproval, meaningUpdateAdoptionApprovalTarget,
  memoryJudgmentReassessmentApprovalTarget } from "../src/approval_policy.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";
import { MeaningUpdateMemoryConsumer } from "../src/meaning_update_memory.js";
import { buildMeaningUpdateMemoryRecord, meaningUpdateInterpretationId,
  meaningUpdateMemoryRecordId } from "../src/meaning_update_semantics.js";
import { operationPlanDigest } from "../src/operation_plan.js";
import type { OperationPlanMemoryStorage, OperationPlanRecoveryHoldState, OperationPlanStatePort } from "../src/operation_plan.js";

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

function completedExternalSendCheckpoint(): OperationPlanCheckpoint {
  const requestId = "meaning-restore-completed-send-fixture";
  const target = { kind: "external_service" as const, id: "gmail" };
  const output = { mutation_status: "confirmed" };
  const step: OperationStep = { step_id: "send", operation: "gmail.write", target, state: "planned",
    effects: ["external_send", "write", "credential_access"],
    permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
      hds_brain_authority_required: true, approval_gate_required: true },
    adapter: "external_api", adapter_is_authority: false, command_generated_by_adapter_only: false,
    parameters: { operation: "message.send", to: "inspection@example.invalid", subject: "fixture", body_text: "fixture only" },
    preparation: { depends_on: [], bindings: [], preconditions: [],
      validation: [{ check_id: "send-confirmed", method: "result_equals", target, expected: output }],
      compensation: { available: false, reason: "an external send cannot be recalled" } } };
  const plan: OperationPlan = { version: "operation-core.v1", plan_id: "meaning-restore-completed-send-plan",
    request_id: requestId, state: "planned", steps: [step], rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
  const { state: _state, result_digest: _resultDigest, ...stepDefinition } = step;
  const revisionDigest = operationPlanDigest(plan);
  return OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [{ owner: "fixture-owner", channel: "test", goal: "synthetic Gmail send completed before meaning restoration",
      revisions: [{ digest: revisionDigest, plan }], receipt_observations: [],
      bindings: [{ step_id: step.step_id, revision_digest: revisionDigest, step_digest: operationPlanDigest(stepDefinition),
        prepared_step: step, command_id: "fixture-completed-send-command", request_id: requestId,
        commit_hash: "a".repeat(64), payload_digest: "b".repeat(64), command_digest: "c".repeat(64),
        operation: step.operation, status: "verified", result_digest: operationPlanDigest(output) }],
      results: [{ plan_id: plan.plan_id, request_id: requestId, step_id: step.step_id,
        result_id: "fixture-completed-send-result", operation: step.operation, status: "succeeded",
        target, output, observed_at_ms: 1, expires_at_ms: 600_001 }] }],
  });
}

class FixtureOperationPlanStatePort implements OperationPlanStatePort {
  private checkpoint: OperationPlanCheckpoint;
  private recoveryHolds: OperationPlanRecoveryHoldState | null = null;

  constructor(checkpoint: OperationPlanCheckpoint) { this.checkpoint = structuredClone(checkpoint); }

  load(): unknown { return structuredClone(this.checkpoint); }
  compareAndSet(expectedDigest: string | null, checkpoint: OperationPlanCheckpoint): void {
    if (expectedDigest !== operationPlanDigest(this.checkpoint)) throw new Error("fixture_plan_state_conflict");
    this.checkpoint = structuredClone(checkpoint);
  }
  loadRecoveryHoldState(): unknown { return this.recoveryHolds ? structuredClone(this.recoveryHolds) : null; }
  compareAndSetRecoveryHoldState(expectedDigest: string | null, state: OperationPlanRecoveryHoldState): void {
    const currentDigest = this.recoveryHolds ? operationPlanDigest(this.recoveryHolds) : null;
    if (expectedDigest !== currentDigest) throw new Error("fixture_recovery_hold_conflict");
    this.recoveryHolds = structuredClone(state);
  }
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
    // This digest-bound J fixture represents a completed synthetic send. The test never calls a provider.
    const operationPlanState = new FixtureOperationPlanStatePort(completedExternalSendCheckpoint());
    let hds = new HDSUpperController({
      audit: new AuditLog({ filepath: auditPath }),
      memory: new LongTermMemoryStore(),
      meaning_update_memory: storage,
      operation_plan_state: operationPlanState,
    });

    try {
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]).toMatchObject({
        operation: "gmail.write", status: "verified",
      });
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
      const interpretationAfterUpdate = new MeaningUpdateMemoryConsumer(storage, {
        readVerifiedMemoryApproval: (reference) => ({ ...reference }),
      });
      try {
        expect(interpretationAfterUpdate.readInterpretation(support.f_reference)?.record?.dependent_judgments)
          .toContainEqual({ judgment_ref: citationJudgmentRefs[0],
            basis_interpretation_id: meaningUpdateInterpretationId(buildMeaningUpdateMemoryRecord(ownerReview!.proposal)),
            reassessment_required: true });
      } finally { interpretationAfterUpdate.close(); }
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

      const freshRequest = createGatewayInternalInboundRequest({ id: "citation-after-meaning-change",
        channel: "test", user: "webchat-owner-token-holder",
        content: `compare ${support.f_reference} with ${counter.f_reference}`, timestamp: 8,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner" },
      });
      const freshDecision = hds.decide(freshRequest);
      if (!freshDecision.command || freshDecision.command.type !== "llm_call") {
        throw new Error("expected the fresh cited-memory C request");
      }
      const freshTrace = freshDecision.log.frame.memory_trace;
      const freshCitationContent = JSON.stringify({ schema_version: "blue-tanuki.memory-citation-response.v1",
        answer: "Synthetic reassessment.", citations: [{ claim: "Synthetic reassessment claim.",
          supporting: { record_id: support.f_reference, version: support.entry_hash },
          counterevidence: { record_id: counter.f_reference, version: counter.entry_hash },
          application_scope_id: freshTrace.search_plan!.application_scope_id }] });
      hds.reviewMemoryCitations(freshDecision.command, { command_id: freshDecision.command.id,
        status: "success", result: { content: freshCitationContent }, metrics: { duration_ms: 1 } });
      const freshCitationReview = hds.getAudit().list().map(({ log }) => log).find((log) => "kind" in log &&
        log.kind === "memory_citation_review" && log.command_id === freshDecision.command!.id);
      expect(freshCitationReview && "interpretation_dependencies" in freshCitationReview
        ? freshCitationReview.interpretation_dependencies : undefined).toMatchObject([{
        reference: { record_id: support.f_reference, version: support.entry_hash },
        interpretation_id: meaningUpdateInterpretationId(buildMeaningUpdateMemoryRecord(nextOwnerReview!.proposal)),
        reassesses_judgment_refs: citationJudgmentRefs,
      }]);
      const freshPlan = citedMemoryPlan(freshRequest.id);
      hds.onFeedback({ command_id: freshDecision.command.id, status: "success",
        result: { content: freshCitationContent, operation_core: { status: "valid_plan", plan: freshPlan } },
        metrics: { duration_ms: 1 } });
      const freshPlanReview = hds.decide(createGatewayInternalInboundRequest({
        id: "fresh-current-plan-review", channel: "test", user: "webchat-owner-token-holder",
        content: `plan:review ${JSON.stringify({ plan_id: operationPlanDigest(freshPlan.plan_id),
          revision_digest: operationPlanDigest(freshPlan), step_id: operationPlanDigest("search") })}`,
        timestamp: 9,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer",
          "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner" },
      }));
      expect(freshPlanReview.command, freshPlanReview.log.commit.reason).not.toBeNull();
      const stillBlockedOldPlanReview = hds.decide(createGatewayInternalInboundRequest({
        id: "old-plan-review-after-fresh-decision", channel: "test", user: "webchat-owner-token-holder",
        content: `plan:review ${JSON.stringify({ plan_id: operationPlanDigest(citationPlan.plan_id),
          revision_digest: operationPlanDigest(citationPlan), step_id: operationPlanDigest("search") })}`,
        timestamp: 10,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer",
          "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner" },
      }));
      expect(stillBlockedOldPlanReview.command).toBeNull();
      expect(stillBlockedOldPlanReview.log.commit.reason)
        .toContain("plan_control_denied:plan_memory_interpretation_reassessment_required");

      const reassessmentProposals = hds.getMemoryJudgmentReassessmentProposals(freshDecision.command.id);
      expect(reassessmentProposals).toHaveLength(1);
      const reassessmentProposal = reassessmentProposals[0]!;
      expect(reassessmentProposal.args.citation_audit_digest).toBe(memoryCitationReviewAuditDigest(
        freshCitationReview as NonNullable<typeof freshCitationReview> & { kind: "memory_citation_review" }));
      const pendingMemory = new MeaningUpdateMemoryConsumer(storage, {
        readVerifiedMemoryApproval: (reference) => ({ ...reference }),
      });
      try {
        const beforeExplicitReview = pendingMemory.readInterpretation(support.f_reference)?.record;
        expect(beforeExplicitReview?.dependent_judgments).toContainEqual({ judgment_ref: citationJudgmentRefs[0],
          basis_interpretation_id: meaningUpdateInterpretationId(buildMeaningUpdateMemoryRecord(ownerReview!.proposal)),
          reassessment_required: true });
        expect(beforeExplicitReview?.dependent_judgments.some((row) => row.judgment_ref === reassessmentProposal.args.judgment_ref))
          .toBe(false);
      } finally { pendingMemory.close(); }

      const reassessmentRequestId = "fresh-citation-reassessment-l3";
      const reassessmentActor = "webchat-owner-token-holder";
      const reassessmentRequest = createGatewayInternalInboundRequest({
        id: reassessmentRequestId, channel: "webchat", user: reassessmentActor,
        content: "Owner submitted a fresh J citation judgment for explicit M reassessment.", timestamp: 11,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "approval",
          "blue_tanuki.memory_judgment_reassessment.version": "v1",
          "blue_tanuki.tool_call": { tool_name: "memory.citation.reassess", arguments: { ...reassessmentProposal.args } } },
      });
      const reassessmentDecision = hds.decide(reassessmentRequest);
      expect(reassessmentDecision.command?.type, reassessmentDecision.log.commit.reason).toBe("tool_call");
      if (!reassessmentDecision.command) throw new Error("expected owner L3 citation reassessment command");
      const reassessmentEvaluation = evaluateApproval(reassessmentDecision.command, [], { actor: reassessmentActor,
        default_mode: "full_access" });
      expect(reassessmentEvaluation).toMatchObject({ decision: "ask", risk: "high", approval_level: "L3_final_review",
        final_review_required: true, context: { operation: "tool.call",
          target: memoryJudgmentReassessmentApprovalTarget(reassessmentProposal.args) } });
      hds.onApprovalEvaluation(reassessmentEvaluation, { request_id: reassessmentRequestId });
      hds.onCommandLifecycle(reassessmentDecision.command.id, "approval_pending", { actor: reassessmentActor,
        reason: reassessmentEvaluation.reason, request_id: reassessmentRequestId });
      const reassessmentCommandDigest = executorCommandDigest(reassessmentDecision.command);
      expect(hds.recordMemoryJudgmentReassessmentContentReview({ args: reassessmentProposal.args,
        reassesses_judgment_refs: reassessmentProposal.reassesses_judgment_refs,
        request_id: reassessmentRequestId, command_id: reassessmentDecision.command.id,
        proposal_actor: reassessmentActor, command_digest: reassessmentCommandDigest })).toBe(true);
      hds.onCommandLifecycle(reassessmentDecision.command.id, "approval_approved", { actor: reassessmentActor,
        reason: "human_approval:approve", request_id: reassessmentRequestId });
      const reassessmentCommit = hds.commitMemoryJudgmentReassessmentAfterL3({ args: reassessmentProposal.args,
        request_id: reassessmentRequestId, command_id: reassessmentDecision.command.id,
        command_digest: reassessmentCommandDigest, content_review_digest: reassessmentCommandDigest,
        proposal_actor: reassessmentActor, reviewer_actor: reassessmentActor, evaluation: reassessmentEvaluation });
      expect(reassessmentCommit).toMatchObject({ ok: true, judgment_ref: reassessmentProposal.args.judgment_ref,
        used_for_authority: false, may_execute: false });
      const registeredMemory = new MeaningUpdateMemoryConsumer(storage, {
        readVerifiedMemoryApproval: (reference) => ({ ...reference }),
      });
      try {
        const afterExplicitReview = registeredMemory.readInterpretation(support.f_reference)?.record;
        expect(afterExplicitReview?.dependent_judgments).toContainEqual({ judgment_ref: citationJudgmentRefs[0],
          basis_interpretation_id: meaningUpdateInterpretationId(buildMeaningUpdateMemoryRecord(ownerReview!.proposal)),
          reassessment_required: false });
        expect(afterExplicitReview?.dependent_judgments).toContainEqual({
          judgment_ref: reassessmentProposal.args.judgment_ref,
          basis_interpretation_id: reassessmentProposal.args.interpretation_id, reassessment_required: false });
        expect(afterExplicitReview?.events.at(-1)).toMatchObject({ kind: "reassessed",
          reassessment_judgment_ref: reassessmentProposal.args.judgment_ref,
          affected_judgment_refs: citationJudgmentRefs });
      } finally { registeredMemory.close(); }
      const auditText = JSON.stringify(hds.getAudit().list());
      expect(auditText).not.toContain(candidateMeaning);
      expect(auditText).toContain(ownerReview!.proposal.candidate_digest);
      expect(hds.getAudit().verify()).toBe(true);
      expect(meaningUpdateAdoptionApprovalTarget(args)).toContain(ownerReview!.proposal_digest);

      hds.close();
      hds = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }),
        memory: new LongTermMemoryStore(), meaning_update_memory: storage, operation_plan_state: operationPlanState });
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
        const correctedInterpretation = persisted.readInterpretation(support.f_reference);
        const nextInterpretationId = meaningUpdateInterpretationId(nextRecord);
        expect(correctedInterpretation?.record).toMatchObject({ application_state: "active",
          current_interpretation_id: nextInterpretationId,
          interpretations: [
            { interpretation_id: initialInterpretationId, meaning: { candidate_meaning: candidateMeaning } },
            { interpretation_id: nextInterpretationId, meaning: { candidate_meaning: nextMeaning } },
          ],
          used_for_authority: false, may_execute: false });
        expect(correctedInterpretation?.record?.events.map((event) => event.kind))
          .toEqual(["quarantined", "restored", "reassessed"]);
        expect(correctedInterpretation?.record?.events.find((event) => event.kind === "restored"))
          .toMatchObject({ kind: "restored", resulting_interpretation_id: nextInterpretationId });
        expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]).toMatchObject({
          operation: "gmail.write", status: "verified",
        });
        expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.recovery_hold_reason).toBeUndefined();
        expect(correctedInterpretation?.record?.events.at(-1)).toMatchObject({ kind: "reassessed",
          reassessment_judgment_ref: reassessmentProposal.args.judgment_ref,
          affected_judgment_refs: citationJudgmentRefs });
        for (const judgmentRef of citationJudgmentRefs) {
          expect(correctedInterpretation?.record?.dependent_judgments.find((row) => row.judgment_ref === judgmentRef))
            .toMatchObject({ basis_interpretation_id: initialInterpretationId, reassessment_required: false });
        }
        expect(correctedInterpretation?.record?.dependent_judgments.find((row) =>
          row.judgment_ref === reassessmentProposal.args.judgment_ref)).toMatchObject({
          basis_interpretation_id: nextInterpretationId, reassessment_required: false });
        expect(persisted.verify()).toBe(true);
      } finally {
        persisted.close();
      }
    } finally {
      hds.close();
    }
  });
});
