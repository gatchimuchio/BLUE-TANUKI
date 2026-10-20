import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayInternalInboundRequest, meaningUpdateCandidateDigest } from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { AuditLog } from "../src/audit.js";
import { evaluateApproval, meaningUpdateAdoptionApprovalTarget } from "../src/approval_policy.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";
import { MeaningUpdateMemoryConsumer, meaningUpdateMemoryRecordId } from "../src/meaning_update_memory.js";
import type { OperationPlanMemoryStorage } from "../src/operation_plan.js";

const temporaryRoots: string[] = [];

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
        expect(persisted.verify()).toBe(true);
      } finally {
        persisted.close();
      }
    } finally {
      hds.close();
    }
  });
});
