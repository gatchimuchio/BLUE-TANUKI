import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayInternalInboundRequest, GOAL_GOVERNANCE_SCHEMA_VERSION, meaningUpdateCandidateDigest,
  OperationPlanCheckpointSchema, type GoalGovernanceConfig } from "@blue-tanuki/protocol";
import { AuditLog } from "../src/audit.js";
import { evaluateApproval } from "../src/approval_policy.js";
import { HDSUpperController } from "../src/controller.js";
import { goalGovernanceEventDigest } from "../src/goal_governance.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";
import { operationPlanDigest, type OperationPlanMemoryStorage, type OperationPlanStatePort } from "../src/operation_plan.js";

const roots: string[] = [];

class FixtureOperationPlanState implements OperationPlanStatePort {
  private checkpoint = OperationPlanCheckpointSchema.parse({ schema_version: "operation-plan-state.v1", plans: [] });
  private recoveryHolds: unknown = null;
  load(): unknown { return structuredClone(this.checkpoint); }
  compareAndSet(_expectedDigest: string | null, checkpoint: ReturnType<typeof OperationPlanCheckpointSchema.parse>): void {
    this.checkpoint = structuredClone(checkpoint);
  }
  loadRecoveryHoldState(): unknown { return structuredClone(this.recoveryHolds); }
  compareAndSetRecoveryHoldState(_expectedDigest: string | null, state: unknown): void {
    this.recoveryHolds = structuredClone(state);
  }
}

function testGoalGovernance(): GoalGovernanceConfig {
  const goalRef = "goal_0123456789abcdef";
  const event = { event_ref: "ge_0123456789abcdef", event_kind: "purpose_change" as const, goal_ref: goalRef,
    source_ref: "F:0123456789abcdef", goal_kind: "delegated" as const, prior_version: 1, new_version: 2,
    prior_purpose_digest: "a".repeat(64), new_purpose_digest: "e".repeat(64), authority_kind: "owner" as const,
    authorization_ref: "ga_0123456789abcdef", recorded_at: 1, effective_from: 2 };
  return { schema_version: GOAL_GOVERNANCE_SCHEMA_VERSION,
    goals: [{ goal_ref: goalRef, goal_kind: "delegated", source_ref: event.source_ref,
      initial_purpose_digest: event.prior_purpose_digest, initial_interpretation_digest: "b".repeat(64), adopted_at: 0 }],
    authorizations: [{ authorization_ref: event.authorization_ref, event_ref: event.event_ref,
      event_digest: goalGovernanceEventDigest(event), goal_ref: goalRef, event_kind: event.event_kind,
      authority_kind: event.authority_kind, authorized_at: 0 }], events: [event] };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("plan:compute selected observations and isolated M", () => {
  it("keeps selected J observations non-authoritative and withholds a proposal without current M projection", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-meaning-observation-l3-"));
    roots.push(root);
    const privateRoot = join(root, "private-state");
    const purposeDirectory = join(privateRoot, "goal-purpose");
    const resultDirectory = join(privateRoot, "operation-result");
    for (const directory of [purposeDirectory, resultDirectory]) mkdirSync(directory, { recursive: true });
    const storage = (directory: string): OperationPlanMemoryStorage => ({ private_state_root: privateRoot,
      database_path: join(directory, "j-control.sqlite"), memory_database_path: join(directory, "m-state.sqlite") });
    const purposeStorage = storage(purposeDirectory);
    const resultStorage = storage(resultDirectory);
    const auditPath = join(root, "audit.jsonl");
    const memory = new LongTermMemoryStore();
    const hds = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }), memory,
      goal_purpose_memory: purposeStorage, goal_governance: testGoalGovernance(),
      operation_plan_state: new FixtureOperationPlanState(), operation_plan_memory: resultStorage });

    try {
      const goalRef = "goal_0123456789abcdef";
      const priorPurposeDigest = "e".repeat(64);
      const purposeText = "Use selected synthetic operation reports as non-authoritative context and require fresh evidence for current claims.";
      const purposeDigest = createHash("sha256").update(purposeText, "utf8").digest("hex");
      const purposeRequestId = "meaning-observation-purpose-request";
      const purposeCommand = { id: randomUUID(), type: "tool_call" as const,
        payload: { tool_name: "goal.governance.change", arguments: { goal_ref: goalRef, prior_version: 2,
          prior_purpose_digest: priorPurposeDigest, new_purpose_digest: purposeDigest } },
        constraints: { allowed_tools: ["goal.governance.change"], allowed_capabilities: ["tool:goal.governance.change"] },
        upstream_decision: { request_id: purposeRequestId, frame_goal: "Review a synthetic delegated-goal purpose change.",
          model_abstraction: "test", commit_hash: "c".repeat(64), commit_decision: "ASSERT" } };
      const purposeEvaluation = evaluateApproval(purposeCommand, [],
        { actor: "fixture-owner", default_mode: "full_access" });
      hds.onApprovalEvaluation(purposeEvaluation, { request_id: purposeRequestId });
      hds.onCommandLifecycle(purposeCommand.id, "approval_approved", { actor: "fixture-reviewer",
        reason: "human_approval:approve", request_id: purposeRequestId });
      const purposeCommit = hds.commitGoalPurposeChangeAfterL3({ goal_ref: goalRef, prior_version: 2,
        prior_purpose_digest: priorPurposeDigest, new_purpose_digest: purposeDigest, purpose_text: purposeText,
        request_id: purposeRequestId, command_id: purposeCommand.id, proposal_actor: "fixture-owner",
        actor: "fixture-reviewer", evaluation: purposeEvaluation });
      if (!purposeCommit.ok) throw new Error(`synthetic purpose setup failed: ${purposeCommit.reason}`);
      const purposeBinding = { goal_ref: goalRef, purpose_version: purposeCommit.version,
        purpose_digest: purposeCommit.purpose_digest };

      hds.decide({ id: "meaning-observation-support", channel: "test", user: "fixture-owner",
        content: "Synthetic supporting observation for a bounded meaning update.", timestamp: 10 });
      hds.decide({ id: "meaning-observation-counter", channel: "test", user: "fixture-owner",
        content: "Synthetic counterevidence for the bounded meaning update.", timestamp: 11 });
      const shellRequest = createGatewayInternalInboundRequest({ id: "meaning-observation-shell-request", channel: "test",
        user: "fixture-owner", content: `tool:shell.exec ${JSON.stringify({ cmd: "node", args: ["--version"], cwd: "." })}`,
        timestamp: 12, metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner" } });
      const shell = hds.decide(shellRequest);
      if (shell.command?.type !== "tool_call") throw new Error(`expected synthetic shell call: ${shell.log.commit.reason}`);
      const rawShellResult = { stdout: "PRIVATE_SYNTHETIC_SHELL_OUTPUT", stderr: "", exit_code: 0 };
      hds.onFeedback({ command_id: shell.command.id, status: "success", result: rawShellResult,
        operation_core_result: { version: "operation-core.v1", role: "command_execution_result", result_id: randomUUID(),
          request_id: shell.log.request_id, command_id: shell.command.id, upstream_commit_hash: shell.log.commit.hash,
          operation: "shell.exec", state: "succeeded", adapter: "shell", execution_boundary: "tool_adapter",
          action_outcome: "reported_success", observed_at_ms: 12,
          command_payload_digest: createHash("sha256").update(JSON.stringify(shell.command.payload), "utf8").digest("hex"),
          output_digest: createHash("sha256").update(JSON.stringify(rawShellResult), "utf8").digest("hex"),
          plan_step_binding: "unbound", adapter_result_used_for_authority: false, used_for_authority: false,
          evidence_source: ["INTERNAL_STATE"] }, metrics: { duration_ms: 1 } });

      const task = "Compare F:meaning-observation-support with F:meaning-observation-counter; treat the selected shell report only as context.";
      const computeRequest = createGatewayInternalInboundRequest({ id: "meaning-observation-compute-request", channel: "test",
        user: "fixture-owner", content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: purposeBinding,
          source_observation_refs: [{ command_id_digest: operationPlanDigest(shell.command.id) }] })}`, timestamp: 13,
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer",
          "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
          "blue_tanuki.operation_core.version": "operation-core.v1", "blue_tanuki.operation_core.request_id": "meaning-observation-compute" } });
      const compute = hds.decide(computeRequest);
      if (compute.command?.type !== "llm_call") throw new Error(`selected observation did not reach C: ${compute.log.commit.reason}`);
      expect(compute.command.payload.compute_context?.data_exposure.input_sources)
        .toContain("selected_operation_result_observations");
      const trace = compute.log.frame.memory_trace;
      expect(memory.verify()).toBe(true);
      expect(trace).toMatchObject({ hits: [], used_for_authority: false, search_plan: {
        allowed_sources: [], source_integrity_verified: false, used_for_authority: false,
      } });
      const computeProjection = JSON.stringify(compute.command.payload.messages);
      expect(computeProjection).toContain("verified_shell_exec_result");
      expect(computeProjection).not.toContain("blue-tanuki.memory-candidates.v1");
      expect(computeProjection).not.toContain("PRIVATE_SYNTHETIC_SHELL_OUTPUT");

      const scope = trace.search_plan;
      if (!scope) throw new Error("plan compute citation scope was not recorded");
      const candidateMeaning = "Synthetic candidate without a current memory projection.";
      const proposal = { schema_version: "blue-tanuki.meaning-update-proposal.v3" as const,
        record_type: "meaning_update_proposal" as const, proposal_ref: "proposal:meaning-observation-l3",
        candidate_ref: "candidate:meaning-observation-l3", candidate_digest: meaningUpdateCandidateDigest(candidateMeaning),
        candidate_meaning: candidateMeaning,
        target_reference: { record_id: "F:meaning-observation-support", version: "a".repeat(64) },
        prior_version_ref: "version:synthetic-prior",
        supporting_evidence: [{ reference: "F:meaning-observation-support", digest: "a".repeat(64) }],
        counterevidence_review: { status: "reviewed_with_references" as const,
          review_scope: { reference: scope.application_scope_id, digest: scope.plan_id },
          references: [{ reference: "F:meaning-observation-counter", digest: "b".repeat(64) }] },
        applicability_scope: { reference: scope.application_scope_id, digest: scope.plan_id },
        reflection_target_ref: "reflection:meaning-observation", proposal_status: "unverified" as const,
        adoption_status: "not_adopted" as const, may_apply: false as const, used_for_authority: false as const };
      hds.onFeedback({ command_id: compute.command.id, status: "success", meaning_update_proposal: proposal,
        metrics: { duration_ms: 1 } });
      const feedbackEntry = hds.getAudit().list().map(({ log }) => log).find((log) => "kind" in log &&
        log.kind === "executor_feedback" && log.command_id === compute.command!.id);
      expect(feedbackEntry && "kind" in feedbackEntry && feedbackEntry.kind === "executor_feedback"
        ? feedbackEntry.feedback : undefined).toMatchObject({
        meaning_update_proposal_contract_status: "passed",
        meaning_update_proposal_reference_review: { review_status: "no_current_projection", may_apply: false,
          used_for_authority: false, adoption_status: "not_adopted" },
        meaning_update_proposal_applied: false,
        meaning_update_proposal_used_for_authority: false,
      });
      expect(hds.getMeaningUpdateProposalForOwnerReview(compute.command.id)).toBeNull();
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      hds.closeOperationPlanMemory();
      hds.close();
    }
  });
});
