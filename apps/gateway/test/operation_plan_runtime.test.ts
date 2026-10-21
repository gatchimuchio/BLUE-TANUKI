import { describe, it, expect, vi } from "vitest";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { AuditLog, HDSUpperController, evaluateApproval, goalGovernanceEventDigest, operationPlanDigest,
  type OperationPlanBrokerRestoreDependencyEvidence } from "@blue-tanuki/hds-brain";
import { Executor, createExecutorApprovalAuthority, executorCommandDigest, gmailDraftSendRequestPayloadDigest,
  ToolRegistry, fileDeleteTool, fileEditTool, fileSearchTool, fileWriteTool, gmailWriteTool } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, FileDeleteTargetVersionObservationSchema, FileWriteTargetVersionObservationSchema, GmailWriteTargetVersionObservationSchema,
  OperationPlanCheckpointSchema,
  OperationPlanCheckpointEnvelopeSchema,
  type ExecuteCommand, type OperationParameters, type OperationPlan, type OperationStep, type InboundRequest } from "@blue-tanuki/protocol";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { executionAdmissionForCommand } from "../src/reconcile_execution_results.js";
import { createFileSearchWorker } from "../src/file_search_worker.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";
import { projectOperationPlanStatus } from "../src/serve_projection.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function request(content: string, user = "fixture-owner", goal_criteria?: InboundRequest["goal_criteria"]): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user, timestamp: Date.now(), content,
    ...(goal_criteria ? { goal_criteria } : {}),
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
}
function operationPlanRestoreCommand(): ExecuteCommand {
  return {
    id: randomUUID(), type: "tool_call",
    payload: { tool_name: "recovery.restore", arguments: { backup_id: "fixture", store_key: "operation_plans", confirm: "RESTORE" } },
    upstream_decision: { request_id: randomUUID(), commit_hash: "a".repeat(64), commit_decision: "ASSERT" },
  } as unknown as ExecuteCommand;
}
function brokerRestoreCommand(): ExecuteCommand {
  return {
    id: randomUUID(), type: "tool_call",
    payload: { tool_name: "recovery.restore", arguments: { backup_id: "fixture", store_key: "broker", confirm: "RESTORE" } },
    upstream_decision: { request_id: randomUUID(), commit_hash: "a".repeat(64), commit_decision: "ASSERT" },
  } as unknown as ExecuteCommand;
}
function canonicalMemoryRestoreCommand(store_key: "j_control" | "m_state" = "j_control"): ExecuteCommand {
  return {
    id: randomUUID(), type: "tool_call",
    payload: { tool_name: "recovery.restore", arguments: { backup_id: "fixture", store_key, confirm: "RESTORE" } },
    upstream_decision: { request_id: randomUUID(), commit_hash: "a".repeat(64), commit_decision: "ASSERT" },
  } as unknown as ExecuteCommand;
}
function recoveryCommandIdDigest(commandId: string): string {
  return createHash("sha256").update(commandId).digest("hex");
}
function noRequestCriteria(content: string, requestId: string) {
  return { status: "not_provided" as const, request_id: requestId,
    content_sha256: createHash("sha256").update(content, "utf8").digest("hex"), criteria: [], used_for_authority: false as const };
}
function plan(id: string, root: string): OperationPlan {
  const target = { kind: "directory" as const, id: root };
  const result = { root, sandbox_root: root, query: "blue", visited_files: 1,
    matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
  const step = (step_id: string): OperationStep => ({ step_id, operation: "file.search", target, state: "planned" as const,
    effects: ["read" as const], permission: { risk: "low" as const, approval_level: "L1_observe" as const,
      final_review_required: false, hds_brain_authority_required: true as const, approval_gate_required: true },
    adapter: "internal_runtime" as const, adapter_is_authority: false as const, command_generated_by_adapter_only: false,
    parameters: { root, query: "blue", max_results: 1 },
    preparation: { depends_on: [], bindings: [],
      preconditions: [], validation: [{ check_id: `check-${step_id}`, method: "result_equals" as const, target, expected: result }],
      compensation: { available: false as const, reason: "read-only" } } });
  const first = step("search"); const dependent = step("dependent"); const independent = step("independent");
  dependent.preparation!.depends_on = ["search"];
  dependent.preparation!.bindings = [{ source_step_id: "search", output_path: ["matches", "0", "line"], field: "parameters", path: ["query"] }];
  dependent.parameters!.query = "${search.line}";
  return { version: "operation-core.v1", plan_id: `plan-${id}`, request_id: id, state: "planned", steps: [first, dependent, independent],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function gmailSendPlan(id: string, parameters: OperationParameters): OperationPlan {
  const target = { kind: "external_service" as const, id: "gmail" };
  return { version: "operation-core.v1", plan_id: `gmail-plan-${id}`, request_id: id, state: "planned",
    steps: [{ step_id: "send", operation: "gmail.write", target, state: "planned",
      effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api", adapter_is_authority: false, command_generated_by_adapter_only: false, parameters,
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "send-accepted", method: "result_equals", target, expected: { mutation_status: "confirmed" } }],
        compensation: { available: false, reason: "external send cannot be recalled" } } }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function rig(hds: HDSUpperController, candidate: OperationPlan, tool = fileSearchTool) {
  const tools = new ToolRegistry(); tools.register(tool);
  const authority = createExecutorApprovalAuthority();
  const executor = new Executor({ llm: { name: "fixture", call: async () => ({ content: JSON.stringify(candidate), model: "fixture", tokens_used: 0 }) },
    tools, approval_authority: authority });
  async function run(command: ExecuteCommand, begin = true) {
    const approval = evaluateApproval(command, [], { actor: "fixture-owner", default_mode: "full_access" });
    const approved = authority.approve(command, { source: approval.final_review_required ? "human_final_review" : "approval_gate",
      decision: "allow", approved_by: "fixture-owner", approved_at_ms: Date.now(), upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required, reason: "fixture" });
    if (begin) expect(hds.beginOperationPlanAttempt(command)).toBe(true);
    const feedback = await executor.execute(approved);
    finalizeCommandOutput({ hds, command, feedback, request_id: command.upstream_decision.request_id ?? null, target_surface: "channel" });
    return feedback;
  }
  return { run };
}
function review(hds: HDSUpperController, candidate: OperationPlan, step_id: string,
  goal_purpose_binding?: { goal_ref: string; purpose_version: number; purpose_digest: string }) {
  const current = hds.getRuntimeSnapshot().operation_plans.plans.find((p) => p.plan_id === operationPlanDigest(candidate.plan_id))!;
  return hds.decide(request(`plan:review ${JSON.stringify({ plan_id: current.plan_id, revision_digest: current.revision_digest,
    step_id: operationPlanDigest(step_id), ...(goal_purpose_binding ? { goal_purpose_binding } : {}) })}`));
}

function goalGovernanceConfig() {
  const event = {
    event_ref: "ge_0123456789abcdef", event_kind: "purpose_change" as const,
    goal_ref: "goal_0123456789abcdef", source_ref: "F:0123456789abcdef", goal_kind: "delegated" as const,
    prior_version: 1, new_version: 2, prior_purpose_digest: "a".repeat(64), new_purpose_digest: "e".repeat(64),
    authority_kind: "owner" as const, authorization_ref: "ga_0123456789abcdef", recorded_at: 100, effective_from: 500,
  };
  return {
    schema_version: "blue-tanuki.goal-governance.v1" as const,
    goals: [{ goal_ref: "goal_0123456789abcdef", goal_kind: "delegated" as const,
      source_ref: "F:0123456789abcdef", initial_purpose_digest: "a".repeat(64),
      initial_interpretation_digest: "b".repeat(64), adopted_at: 0 }],
    authorizations: [{ authorization_ref: event.authorization_ref, event_ref: event.event_ref,
      event_digest: goalGovernanceEventDigest(event), goal_ref: event.goal_ref, event_kind: event.event_kind,
      authority_kind: event.authority_kind, authorized_at: event.recorded_at }],
    events: [event],
  };
}

describe("計画候補→明示step選択→実結果→改訂・復帰", () => {
  it("期限切れfile.search観測をJの再審査・実行・source bindingで拒否する", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(1_000));
    const root = await mkdtemp(join(tmpdir(), "blue-plan-source-expiry-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const candidate = plan(randomUUID(), root);
      const goal = "plan:compute use one bounded, synthetic search observation";
      const observation = {
        schema_version: "operation-plan-compute-source-observation.v1" as const,
        source: "verified_file_search_result" as const,
        operation: "file.search" as const,
        plan_id_digest: "a".repeat(64), revision_digest: "b".repeat(64), step_id_digest: "c".repeat(64),
        plan_binding_status: "verified" as const, plan_validation_status: "matched" as const,
        effect_observation: "reported_success" as const, record_digest: "d".repeat(64),
        memory_revision: 1, memory_receipt_digest: "e".repeat(64), observed_at_ms: 1_000,
        expires_at_ms: 601_000, match_count: 1, visited_files: 1, search_completeness: "unknown" as const,
        adoption_status: "observation_only" as const, used_as_world_truth: false as const,
        used_for_authority: false as const, may_execute: false as const,
      };
      const checkpoint = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [{ owner: "fixture-owner", channel: "webchat", goal,
          compute_source_observations: [observation], request_goal_criteria: noRequestCriteria(goal, candidate.request_id),
          revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }],
          receipt_observations: [], bindings: [], results: [] }],
      });
      store.compareAndSet(null, checkpoint);
      const hds = new HDSUpperController({ operation_plan_state: store });
      try {
        const selected = review(hds, candidate, "search");
        if (selected.command?.type !== "tool_call") throw new Error(`fresh observation was not reviewable: ${selected.log.commit.reason}`);
        expect(hds.operationPlanCommandIsCurrent(selected.command)).toBe(true);
        expect(hds.getExecutionOperationPlanBindingDigest(selected.command)).toMatch(/^[a-f0-9]{64}$/);

        vi.setSystemTime(new Date(observation.expires_at_ms));
        expect(hds.operationPlanCommandIsCurrent(selected.command)).toBe(false);
        expect(() => hds.getExecutionOperationPlanBindingDigest(selected.command!)).toThrow("plan_execution_source_observation_expired");
        expect(hds.beginOperationPlanAttempt(selected.command)).toBe(false);
        const afterExpiry = review(hds, candidate, "independent");
        expect(afterExpiry.command).toBeNull();
        expect(afterExpiry.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_expired");
      } finally { hds.close(); }
    } finally { store.close(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
  });

  it("requires current purpose-version binding and refuses step review without task-purpose evidence", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(100));
    const root = await mkdtemp(join(tmpdir(), "blue-plan-purpose-scope-"));
    const workspace = join(root, "workspace"); await mkdir(workspace); await writeFile(join(workspace, "blue.txt"), "blue\n");
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store, goal_governance: goalGovernanceConfig() });
      const origin = request("plan:compute find the fixture token", "fixture-owner");
      const candidate = plan(origin.id, workspace);
      const executor = rig(hds, candidate);
      await executor.run(hds.decide(origin).command!);

      const goal = hds.getGoalGovernanceProjection()?.goals[0];
      if (!goal) throw new Error("missing synthetic delegated goal");
      const scope = { goal_ref: goal.goal_ref, purpose_version: goal.current_version, purpose_digest: goal.current_purpose_digest };
      const projection = hds.getRuntimeSnapshot().operation_plans;
      expect(projection.goal_purpose_options).toEqual([{ ...scope, goal_kind: "delegated", parent_alignment_status: "not_applicable" }]);
      expect(projection.plans[0]?.goal_purpose_binding_status).toBe("required");
      expect(JSON.stringify(projection)).not.toContain("F:0123456789abcdef");
      expect(projectOperationPlanStatus(projection).goal_purpose_options).toEqual(projection.goal_purpose_options);

      const missing = review(hds, candidate, "search");
      expect(missing.command).toBeNull();
      expect(missing.log.commit.reason).toContain("plan_control_denied:plan_goal_purpose_binding_required");

      const selected = review(hds, candidate, "search", scope);
      expect(selected.command).toBeNull();
      expect(selected.log.commit.reason).toContain("plan_control_denied:plan_goal_purpose_relation_unavailable");
      const current = hds.getRuntimeSnapshot().operation_plans.plans[0];
      expect(current?.goal_purpose_binding_status).toBe("required");
      expect(current?.goal_purpose_relation).toMatchObject({ status: "not_required", used_for_authority: false, may_execute: false });
      expect(projectOperationPlanStatus(hds.getRuntimeSnapshot().operation_plans).plans[0]?.goal_purpose_binding_status).toBe("required");
    } finally {
      store.close(); vi.unstubAllEnvs(); vi.useRealTimers(); await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates durable owner task-purpose review after restart and blocks missing-audit or stale-revision bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-purpose-review-restart-"));
    const auditPath = join(root, "audit.jsonl");
    const incompleteAuditPath = join(root, "audit-before-relation-review.jsonl");
    const initialStatePath = join(root, "initial-state.sqlite");
    const verifiedStatePath = join(root, "verified-state.sqlite");
    const incompleteStatePath = join(root, "incomplete-state.sqlite");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "blue.txt"), "blue synthetic fixture\n", "utf8");
    const purposeDirectory = join(root, "private-state", "goal-purpose-memory");
    await mkdir(purposeDirectory, { recursive: true });
    const purposeMemory = {
      private_state_root: join(root, "private-state"),
      database_path: join(purposeDirectory, "j-control.sqlite"),
      memory_database_path: join(purposeDirectory, "m-state.sqlite"),
    };
    const purposeText = "Send only this fixed synthetic message to inspection@example.invalid after separate owner approval.";
    const purposeDigest = createHash("sha256").update(purposeText, "utf8").digest("hex");
    const task = "Send the fixed synthetic message to inspection@example.invalid after separate owner approval.";
    const binding = { goal_ref: "goal_0123456789abcdef", purpose_version: 3, purpose_digest: purposeDigest };
    const planRequestId = randomUUID();
    const candidate = gmailSendPlan(planRequestId, {
      operation: "message.send", to: "inspection@example.invalid", subject: "synthetic", body_text: "fixed fixture",
    });
    candidate.steps.push(plan(planRequestId, workspace).steps[0]!);
    let initialStore: OperationPlanStateStore | undefined;
    let initialHds: HDSUpperController | undefined;
    let verifiedStore: OperationPlanStateStore | undefined;
    let verifiedHds: HDSUpperController | undefined;
    let incompleteStore: OperationPlanStateStore | undefined;
    let incompleteHds: HDSUpperController | undefined;
    let executionStore: GatewayExecutionIntentStore | undefined;
    try {
      initialStore = new OperationPlanStateStore(initialStatePath);
      initialHds = new HDSUpperController({
        audit: new AuditLog({ filepath: auditPath }),
        operation_plan_state: initialStore,
        goal_governance: goalGovernanceConfig(),
        goal_purpose_memory: purposeMemory,
      });

      const purposeChangeRequestId = randomUUID();
      const purposeChangeCommand: ExecuteCommand = {
        id: randomUUID(), type: "tool_call",
        payload: { tool_name: "goal.governance.change", arguments: {
          goal_ref: binding.goal_ref, prior_version: 2, prior_purpose_digest: "e".repeat(64),
          new_purpose_digest: purposeDigest,
        } },
        constraints: { allowed_tools: ["goal.governance.change"], allowed_capabilities: ["tool:goal.governance.change"] },
        upstream_decision: { request_id: purposeChangeRequestId, frame_goal: "Review a delegated goal purpose update.",
          model_abstraction: "test", commit_hash: "a".repeat(64), commit_decision: "ASSERT" },
      };
      const purposeEvaluation = evaluateApproval(purposeChangeCommand, [], {
        actor: "webchat-owner-token-holder", default_mode: "full_access",
      });
      expect(purposeEvaluation).toMatchObject({ decision: "ask", risk: "high",
        approval_level: "L3_final_review", final_review_required: true });
      initialHds.onApprovalEvaluation(purposeEvaluation, { request_id: purposeChangeRequestId });
      initialHds.onCommandLifecycle(purposeChangeCommand.id, "approval_approved", {
        actor: "webchat-resume-token-holder", reason: "human_approval:approve", request_id: purposeChangeRequestId,
      });
      expect(initialHds.commitGoalPurposeChangeAfterL3({
        goal_ref: binding.goal_ref, prior_version: 2, prior_purpose_digest: "e".repeat(64),
        new_purpose_digest: purposeDigest, purpose_text: purposeText, request_id: purposeChangeRequestId,
        command_id: purposeChangeCommand.id, proposal_actor: "webchat-owner-token-holder",
        actor: "webchat-resume-token-holder", evaluation: purposeEvaluation,
      })).toMatchObject({ ok: true, version: 3, purpose_digest: purposeDigest });

      const computeRequest = createGatewayInternalInboundRequest({
        id: randomUUID(), channel: "webchat", user: "fixture-owner",
        content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: binding })}`, timestamp: Date.now(),
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
          "blue_tanuki.operation_core.request_id": planRequestId,
        },
      });
      const computeDecision = initialHds.decide(computeRequest);
      if (computeDecision.command?.type !== "llm_call") throw new Error("plan computation did not produce a C request");
      initialHds.onFeedback({
        command_id: computeDecision.command.id, status: "success",
        result: { operation_core: { status: "valid_plan", plan: candidate,
          goal_purpose_relation: { outcome: "supports", evidence: [{ task_quote: task, purpose_quote: purposeText }] } } },
        metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 },
      });
      expect(review(initialHds, candidate, "send", binding).log.commit.reason)
        .toContain("plan_control_denied:plan_goal_purpose_relation_unverified");

      const currentPlan = initialHds.getRuntimeSnapshot().operation_plans.plans[0];
      if (!currentPlan) throw new Error("computed plan checkpoint was not persisted");
      const initialRevisionDigest = currentPlan.revision_digest;
      const prepared = initialHds.prepareOperationPlanGoalPurposeRelationReview(
        currentPlan.plan_id, currentPlan.revision_digest, "supports");
      const relationRequestId = randomUUID();
      const proposalActor = "webchat-owner-token-holder";
      const reviewerActor = "webchat-resume-token-holder";
      const relationDecision = initialHds.decide(createGatewayInternalInboundRequest({
        id: relationRequestId, channel: "webchat", user: proposalActor,
        content: "Owner submitted a task-purpose relation assessment for L3 review.", timestamp: Date.now() + 1,
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "approval",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.goal_purpose_relation_review.version": "v1",
          "blue_tanuki.tool_call": { tool_name: "goal.governance.review_task_purpose", arguments: prepared.args },
        },
      }));
      if (!relationDecision.command) throw new Error("owner task-purpose review did not produce an HDS command");
      const relationEvaluation = evaluateApproval(relationDecision.command, [], {
        actor: proposalActor, default_mode: "full_access",
      });
      expect(relationEvaluation).toMatchObject({ decision: "ask", risk: "high",
        approval_level: "L3_final_review", final_review_required: true });
      initialHds.onApprovalEvaluation(relationEvaluation, { request_id: relationRequestId });
      const relationCommandDigest = executorCommandDigest(relationDecision.command);
      expect(initialHds.recordOperationPlanGoalPurposeRelationContentReview({
        args: prepared.args, request_id: relationRequestId, command_id: relationDecision.command.id,
        proposal_actor: proposalActor, command_digest: relationCommandDigest,
      })).toBe(true);
      initialHds.onCommandLifecycle(relationDecision.command.id, "approval_approved", {
        actor: reviewerActor, reason: "human_approval:approve", request_id: relationRequestId,
      });
      // This valid audit prefix includes the exact L3 ask, content review, and owner approval, but not the final relation event.
      await copyFile(auditPath, incompleteAuditPath);
      expect(initialHds.commitOperationPlanGoalPurposeRelationReviewAfterL3({
        args: prepared.args, request_id: relationRequestId, command_id: relationDecision.command.id,
        command_digest: relationCommandDigest, proposal_actor: proposalActor, reviewer_actor: reviewerActor,
        content_review_digest: relationCommandDigest, evaluation: relationEvaluation,
      })).toEqual({ ok: true, outcome: "supports" });
      expect(initialHds.getRuntimeSnapshot().operation_plans.plans[0]?.goal_purpose_relation).toMatchObject({
        status: "owner_reviewed_supports", owner_review_status: "verified", used_for_authority: false, may_execute: false,
      });
      expect(initialHds.getAudit().verify()).toBe(true);

      initialHds.close(); initialHds = undefined;
      initialStore.close(); initialStore = undefined;
      await copyFile(initialStatePath, verifiedStatePath);
      await copyFile(initialStatePath, incompleteStatePath);

      verifiedStore = new OperationPlanStateStore(verifiedStatePath);
      const verifiedController = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }),
        operation_plan_state: verifiedStore, goal_governance: goalGovernanceConfig(), goal_purpose_memory: purposeMemory });
      verifiedHds = verifiedController;
      expect(verifiedController.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({
        revision_digest: initialRevisionDigest,
        goal_purpose_relation: {
          status: "owner_reviewed_supports", owner_review_status: "verified", used_for_authority: false, may_execute: false,
        },
      });
      const selected = review(verifiedController, candidate, "send", binding);
      if (selected.command?.type !== "tool_call") throw new Error("verified plan did not reach its separately gated operation");
      const operationApproval = evaluateApproval(selected.command, [], {
        actor: "fixture-owner", default_mode: "full_access",
      });
      expect(operationApproval).toMatchObject({ decision: "ask", risk: "high",
        approval_level: "L3_final_review", final_review_required: true });
      expect(verifiedController.operationPlanCommandIsCurrent(selected.command)).toBe(true);
      const sendPlanBindingDigest = verifiedController.getExecutionOperationPlanBindingDigest(selected.command);
      if (!sendPlanBindingDigest) throw new Error("current Gmail plan source was unavailable");
      const sendTools = new ToolRegistry(); sendTools.register(gmailWriteTool);
      const sendResolver = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
        tools: sendTools, approval_authority: createExecutorApprovalAuthority() });
      const sendTargetObservation = await sendResolver.inspectCommandTargetVersion(selected.command, undefined, sendPlanBindingDigest);
      if (!sendTargetObservation) throw new Error("Gmail target resolver returned no observation");
      expect(sendTargetObservation).toMatchObject({ operation_plan_binding_digest: sendPlanBindingDigest,
        used_for_authority: false, may_execute: false });
      const executionBinding = verifiedController.createExecutionAuthorityBinding(selected.command, sendTargetObservation);
      expect(executionBinding.operation_plan_binding_digest).toBe(sendPlanBindingDigest);
      expect(executionBinding.broker_target_version_observation_digest).toBe(operationPlanDigest(sendTargetObservation));

      const selectedSearch = review(verifiedController, candidate, "search", binding);
      if (selectedSearch.command?.type !== "tool_call" || selectedSearch.command.payload.tool_name !== "file.search") {
        throw new Error("purpose-bound file.search step was not selected");
      }
      const planBindingDigest = verifiedController.getExecutionOperationPlanBindingDigest(selectedSearch.command);
      if (!planBindingDigest) throw new Error("current purpose-bound plan source was unavailable");
      const searchTools = new ToolRegistry(); searchTools.register(fileSearchTool);
      const targetResolver = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
        tools: searchTools, approval_authority: createExecutorApprovalAuthority() });
      const targetObservation = await targetResolver.inspectCommandTargetVersion(selectedSearch.command,
        { BLUE_TANUKI_FILE_ROOT: workspace }, planBindingDigest);
      if (!targetObservation) throw new Error("file.search target resolver returned no observation");
      expect(targetObservation).toMatchObject({ operation_plan_binding_digest: planBindingDigest,
        used_for_authority: false, may_execute: false });
      expect(JSON.stringify(targetObservation)).not.toContain(task);
      expect(JSON.stringify(targetObservation)).not.toContain(purposeText);
      const searchExecutionBinding = verifiedController.createExecutionAuthorityBinding(selectedSearch.command, targetObservation);
      expect(searchExecutionBinding.operation_plan_binding_digest).toBe(planBindingDigest);
      const taskIdentityDigest = verifiedController.getExecutionOperationPlanTaskIdentityDigest(selectedSearch.command);
      if (!taskIdentityDigest) throw new Error("current J-owned task identity was unavailable");
      expect(taskIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(searchExecutionBinding.task_identity_digest).toBe(taskIdentityDigest);
      expect(verifiedController.getExecutionOperationPlanTaskIdentityDigest(selected.command!)).toBe(taskIdentityDigest);
      expect(searchExecutionBinding.broker_target_version_observation_digest).toBe(operationPlanDigest(targetObservation));
      expect(() => verifiedController.createExecutionAuthorityBinding(selectedSearch.command!, {
        ...targetObservation, operation_plan_binding_digest: "f".repeat(64),
      })).toThrow(/current Operation Plan source/);

      const searchExecutionEpoch = randomUUID();
      executionStore = new GatewayExecutionIntentStore(join(root, "execution-intents.sqlite"), searchExecutionEpoch);
      const searchAuthority = createExecutorApprovalAuthority({ execution_store: executionStore,
        execution_epoch: searchExecutionEpoch, require_hds_execution_binding: true });
      const searchExecutor = new Executor({
        llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
        tools: searchTools, approval_authority: searchAuthority,
        file_search_worker: createFileSearchWorker({ execution_epoch: searchExecutionEpoch,
          env: { SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace } }),
      });
      const searchApproval = evaluateApproval(selectedSearch.command, [], { actor: "fixture-owner", default_mode: "full_access" });
      const approvedSearch = searchAuthority.approve(selectedSearch.command, {
        source: searchApproval.final_review_required ? "human_final_review" : "approval_gate", decision: "allow",
        approved_by: "fixture-owner", approved_at_ms: Date.now(), upstream_commit_hash: selectedSearch.command.upstream_decision.commit_hash,
        operation: searchApproval.context.operation, risk: searchApproval.risk,
        final_review_required: searchApproval.final_review_required, reason: "synthetic plan-bound file.search fixture",
      }, executorCommandDigest(selectedSearch.command), searchExecutionBinding, targetObservation);
      const searchAdmission = executionAdmissionForCommand(selectedSearch.command, searchAuthority.receipt(approvedSearch));
      expect(searchAdmission.task_identity_digest).toBe(taskIdentityDigest);
      const { task_identity_digest: _missingTaskIdentity, ...admissionWithoutTaskIdentity } = searchAdmission;
      expect(verifiedController.beginOperationPlanAttempt(selectedSearch.command, admissionWithoutTaskIdentity)).toBe(false);
      expect(verifiedController.beginOperationPlanAttempt(selectedSearch.command, {
        ...searchAdmission, task_identity_digest: "f".repeat(64),
      })).toBe(false);
      expect(verifiedController.beginOperationPlanAttempt(selectedSearch.command, searchAdmission)).toBe(true);
      const searchFeedback = await searchExecutor.execute(approvedSearch);
      expect(searchFeedback.status).toBe("success");
      finalizeCommandOutput({ hds: verifiedController, command: selectedSearch.command, feedback: searchFeedback,
        request_id: selectedSearch.command.upstream_decision.request_id ?? null, target_surface: "channel" });
      expect(searchAuthority.receipt(approvedSearch)).toMatchObject({ state: "adapter_returned",
        task_identity_digest: taskIdentityDigest, worker_task_identity_digest: taskIdentityDigest,
        worker_operation_plan_binding_digest: planBindingDigest });
      expect(executionStore.verifyEvents()).toBe(true);
      const reopenedExecutionStore = new GatewayExecutionIntentStore(join(root, "execution-intents.sqlite"), searchExecutionEpoch);
      try {
        expect(reopenedExecutionStore.snapshot()).toEqual(executionStore.snapshot());
        expect(reopenedExecutionStore.verifyEvents()).toBe(true);
      } finally { reopenedExecutionStore.close(); }

      const reviewedCommand = selected.command;
      const reviewedSearchCommand = selectedSearch.command;
      const revisedPlan = structuredClone(candidate);
      revisedPlan.steps[0]!.parameters!.subject = "revised synthetic";
      const revision = verifiedController.getRuntimeSnapshot().operation_plans.plans[0]!;
      const revisionDecision = verifiedController.decide(request(`plan:revise ${JSON.stringify({
        plan_id: candidate.plan_id, expected_revision_digest: revision.revision_digest, plan: revisedPlan,
      })}`));
      if (!revisionDecision.command) throw new Error("plan revision did not produce its local commit command");
      await rig(verifiedController, revisedPlan).run(revisionDecision.command);
      expect(verifiedController.getRuntimeSnapshot().operation_plans.plans[0]?.revision_digest)
        .not.toBe(initialRevisionDigest);
      expect(verifiedController.operationPlanCommandIsCurrent(reviewedCommand)).toBe(false);
      expect(() => verifiedController.createExecutionAuthorityBinding(reviewedCommand)).toThrow();
      expect(verifiedController.operationPlanCommandIsCurrent(reviewedSearchCommand)).toBe(false);
      expect(() => verifiedController.getExecutionOperationPlanBindingDigest(reviewedSearchCommand)).toThrow();
      expect(review(verifiedController, revisedPlan, "send", binding).command).toBeNull();
      expect(verifiedController.getRuntimeSnapshot().operation_plans.plans[0]?.goal_purpose_relation?.status)
        .toBe("stale");

      verifiedController.close(); verifiedHds = undefined;
      verifiedStore.close(); verifiedStore = undefined;

      incompleteStore = new OperationPlanStateStore(incompleteStatePath);
      incompleteHds = new HDSUpperController({ audit: new AuditLog({ filepath: incompleteAuditPath }),
        operation_plan_state: incompleteStore, goal_governance: goalGovernanceConfig(), goal_purpose_memory: purposeMemory });
      expect(incompleteHds.getAudit().verify()).toBe(true);
      expect(incompleteHds.getRuntimeSnapshot().operation_plans.plans[0]?.goal_purpose_relation).toMatchObject({
        status: "unverified", owner_review_status: "invalid", used_for_authority: false, may_execute: false,
      });
      expect(review(incompleteHds, candidate, "send", binding).command).toBeNull();
    } finally {
      executionStore?.close();
      incompleteHds?.close(); incompleteStore?.close();
      verifiedHds?.close(); verifiedStore?.close();
      initialHds?.close(); initialStore?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains request criteria as a digest-only plan source and refuses an explicitly conflicting step", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-goal-criteria-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const criteria = { schema_version: "blue-tanuki.goal-criteria.v1" as const,
      criteria: [{ criterion_ref: "private-criterion-reference", criterion_kind: "safety" as const,
        tool_relations: [{ tool_name: "file.search", relation: "conflicts" as const }] }] };
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const origin = request("plan:compute find the fixture token", "fixture-owner", criteria);
      const candidate = plan(origin.id, root);
      await rig(hds, candidate).run(hds.decide(origin).command!);
      const projection = hds.getRuntimeSnapshot().operation_plans;
      expect(JSON.stringify(projection)).not.toContain("private-criterion-reference");

      const restarted = new HDSUpperController({ operation_plan_state: store });
      const reviewed = review(restarted, candidate, "search");
      expect(reviewed.command).toBeNull();
      expect(reviewed.log.commit.reason).toContain("plan_control_denied:plan_goal_criteria_conflict");
      expect(reviewed.log.commit.reason).not.toContain("private-criterion-reference");
      expect(JSON.stringify(restarted.getRuntimeSnapshot().operation_plans)).not.toContain("private-criterion-reference");
    } finally {
      store.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines one plan-local residual, keeps an unrelated J plan writable, and restores only the residual scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-goal-criteria-isolation-"));
    const databasePath = join(root, "state.sqlite");
    const store = new OperationPlanStateStore(databasePath);
    const cleanCandidate = plan("criteria-isolation-clean", root);
    const residualCandidate = plan("criteria-isolation-residual", root);
    const cleanGoal = "clean synthetic task";
    const residualGoal = "residual synthetic task";
    const cleanPlanState = {
      owner: "fixture-owner", channel: "webchat", goal: cleanGoal,
      request_goal_criteria: noRequestCriteria(cleanGoal, cleanCandidate.request_id),
      revisions: [{ digest: operationPlanDigest(cleanCandidate), plan: cleanCandidate }],
      receipt_observations: [], bindings: [], results: [],
    };
    const cleanCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1", plans: [cleanPlanState],
    });
    try {
      store.compareAndSet(null, cleanCheckpoint);
      const residualCheckpoint = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [
          { owner: "fixture-owner", channel: "webchat", goal: residualGoal,
            request_goal_criteria: { ...noRequestCriteria(residualGoal, residualCandidate.request_id), request_id: "another-request" },
            revisions: [{ digest: operationPlanDigest(residualCandidate), plan: residualCandidate }],
            receipt_observations: [], bindings: [], results: [] },
          cleanPlanState,
        ],
      });
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
          .run(JSON.stringify(residualCheckpoint), operationPlanDigest(residualCheckpoint));
      } finally { database.close(); }

      const hds = new HDSUpperController({ operation_plan_state: store });
      try {
        expect(hds.getRuntimeSnapshot().operation_plans.plans.map((entry) => entry.plan_id))
          .toEqual([operationPlanDigest(cleanCandidate.plan_id)]);
        const selected = review(hds, cleanCandidate, "search");
        expect(selected.command?.type).toBe("tool_call");

        expect(store.load()?.plans.map((entry) => entry.revisions[0]!.plan.plan_id))
          .toEqual([cleanCandidate.plan_id]);
        const persistedDatabase = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const row = persistedDatabase.prepare("SELECT checkpoint_json,digest FROM operation_plan_state WHERE id=1").get() as
            { checkpoint_json: string; digest: string };
          const persisted = OperationPlanCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
          expect(operationPlanDigest(JSON.parse(row.checkpoint_json))).toBe(row.digest);
          expect(persisted.plans).toHaveLength(2);
          expect(persisted.plans.find((entry) => entry.revisions[0]!.plan.plan_id === residualCandidate.plan_id))
            .toMatchObject({ request_goal_criteria: { request_id: "another-request" } });
          expect(persisted.plans.find((entry) => entry.revisions[0]!.plan.plan_id === cleanCandidate.plan_id)?.bindings)
            .toHaveLength(1);
        } finally { persistedDatabase.close(); }
      } finally { hds.close(); }

      const archivedResidual = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [{ owner: "fixture-owner", channel: "webchat", goal: residualGoal,
          request_goal_criteria: noRequestCriteria(residualGoal, residualCandidate.request_id),
          revisions: [{ digest: operationPlanDigest(residualCandidate), plan: residualCandidate }],
          receipt_observations: [], bindings: [], results: [] }],
      });
      const current = store.load();
      if (!current) throw new Error("missing isolated J checkpoint");
      store.restorePlanScope(archivedResidual, operationPlanDigest(residualCandidate.plan_id), current);
      expect(store.load()?.plans.map((entry) => entry.revisions[0]!.plan.plan_id).sort())
        .toEqual([cleanCandidate.plan_id, residualCandidate.plan_id].sort());
    } finally {
      store.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates a schema-invalid plan record, keeps its raw payload, and restores only that plan scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-schema-isolation-"));
    const databasePath = join(root, "state.sqlite");
    const store = new OperationPlanStateStore(databasePath);
    const invalidCandidate = plan("schema-isolation-invalid", root);
    const cleanCandidate = plan("schema-isolation-clean", root);
    const invalidGoal = "schema-invalid synthetic task";
    const cleanGoal = "schema-clean synthetic task";
    const invalidPlanState = {
      owner: "fixture-owner", channel: "webchat", goal: invalidGoal,
      request_goal_criteria: noRequestCriteria(invalidGoal, invalidCandidate.request_id),
      revisions: [{ digest: operationPlanDigest(invalidCandidate), plan: invalidCandidate }],
      receipt_observations: [], bindings: [], results: [],
    };
    const cleanPlanState = {
      owner: "fixture-owner", channel: "webchat", goal: cleanGoal,
      request_goal_criteria: noRequestCriteria(cleanGoal, cleanCandidate.request_id),
      revisions: [{ digest: operationPlanDigest(cleanCandidate), plan: cleanCandidate }],
      receipt_observations: [], bindings: [], results: [],
    };
    try {
      store.compareAndSet(null, OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1", plans: [invalidPlanState, cleanPlanState],
      }));
      const database = new DatabaseSync(databasePath);
      try {
        const row = database.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id=1").get() as {
          checkpoint_json: string;
        };
        const raw = JSON.parse(row.checkpoint_json) as { plans: Array<Record<string, unknown>> };
        raw.plans[0]!.owner = null;
        database.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
          .run(JSON.stringify(raw), operationPlanDigest(raw));
      } finally { database.close(); }

      const hds = new HDSUpperController({ operation_plan_state: store });
      try {
        expect(hds.getRuntimeSnapshot().operation_plans.plans.map((entry) => entry.plan_id))
          .toEqual([operationPlanDigest(cleanCandidate.plan_id)]);
        expect(review(hds, cleanCandidate, "search").command?.type).toBe("tool_call");
      } finally { hds.close(); }

      const persistedDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = persistedDatabase.prepare("SELECT checkpoint_json,digest FROM operation_plan_state WHERE id=1").get() as {
          checkpoint_json: string; digest: string;
        };
        const raw: unknown = JSON.parse(row.checkpoint_json);
        expect(operationPlanDigest(raw)).toBe(row.digest);
        expect(OperationPlanCheckpointEnvelopeSchema.parse(raw).plans).toHaveLength(2);
        expect(() => OperationPlanCheckpointSchema.parse(raw)).toThrow();
        const rawPlans = (raw as { plans: Array<Record<string, unknown>> }).plans;
        const storedInvalid = rawPlans.find((entry) => {
          const revisions = entry.revisions as Array<{ plan: OperationPlan }>;
          return revisions[0]?.plan.plan_id === invalidCandidate.plan_id;
        });
        const storedClean = rawPlans.find((entry) => {
          const revisions = entry.revisions as Array<{ plan: OperationPlan }>;
          return revisions[0]?.plan.plan_id === cleanCandidate.plan_id;
        });
        expect(storedInvalid?.owner).toBeNull();
        expect(storedClean?.bindings).toHaveLength(1);
      } finally { persistedDatabase.close(); }

      const archivedInvalidPlan = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1", plans: [invalidPlanState],
      });
      const current = store.load();
      if (!current) throw new Error("missing schema-isolated checkpoint");
      store.restorePlanScope(archivedInvalidPlan, operationPlanDigest(invalidCandidate.plan_id), current);
      const restored = store.load();
      expect(restored?.plans.map((entry) => entry.revisions[0]!.plan.plan_id).sort())
        .toEqual([cleanCandidate.plan_id, invalidCandidate.plan_id].sort());

      const restoredDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = restoredDatabase.prepare("SELECT checkpoint_json,digest FROM operation_plan_state WHERE id=1").get() as {
          checkpoint_json: string; digest: string;
        };
        expect(operationPlanDigest(JSON.parse(row.checkpoint_json))).toBe(row.digest);
        const parsed = OperationPlanCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
        expect(parsed.plans.find((entry) => entry.revisions[0]!.plan.plan_id === invalidCandidate.plan_id)?.owner)
          .toBe("fixture-owner");
        expect(parsed.plans.find((entry) => entry.revisions[0]!.plan.plan_id === cleanCandidate.plan_id)?.bindings)
          .toHaveLength(1);
      } finally { restoredDatabase.close(); }
    } finally {
      store.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid shared checkpoint state even when the top-level digest matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-shared-schema-fail-closed-"));
    const databasePath = join(root, "state.sqlite");
    const store = new OperationPlanStateStore(databasePath);
    const candidate = plan("shared-schema-fail-closed", root);
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "shared schema fixture",
        request_goal_criteria: noRequestCriteria("shared schema fixture", candidate.request_id),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }],
        receipt_observations: [], bindings: [], results: [] }],
    });
    try {
      store.compareAndSet(null, checkpoint);
      const database = new DatabaseSync(databasePath);
      try {
        const row = database.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id=1").get() as {
          checkpoint_json: string;
        };
        const raw = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
        raw.shell_exec_result_observations = [{ untrusted: true }];
        database.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
          .run(JSON.stringify(raw), operationPlanDigest(raw));
      } finally { database.close(); }
      expect(() => store.load()).toThrow();
    } finally {
      store.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("selected-store restore gates plan use, rebases the live ledger, and holds only restored plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-live-restore-refresh-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const restoreWriter = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const originalOrigin = request("plan:compute original synthetic task");
      const original = plan(originalOrigin.id, root);
      await rig(hds, original).run(hds.decide(originalOrigin).command!);
      const selected = review(hds, original, "search").command!;

      const restoreCommand = operationPlanRestoreCommand();
      expect(hds.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      expect(hds.getRuntimeSnapshot().operation_plans.recovery_refresh_status).toBe("pending");
      expect(hds.operationPlanCommandIsCurrent(selected)).toBe(false);
      const blocked = review(hds, original, "independent");
      expect(blocked.command).toBeNull();
      expect(blocked.log.commit.reason).toBe("plan_control_denied:plan_recovery_refresh_hold");

      const current = restoreWriter.load();
      if (!current) throw new Error("missing fixture checkpoint");
      const restoredOrigin = request("plan:compute restored synthetic task");
      const restored = plan(restoredOrigin.id, root);
      const restoredCheckpoint = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [{ owner: "fixture-owner", channel: "webchat", goal: "restored synthetic plan",
          request_goal_criteria: noRequestCriteria("restored synthetic plan", restored.request_id),
          revisions: [{ digest: operationPlanDigest(restored), plan: restored }],
          receipt_observations: [], bindings: [], results: [] }],
      });
      restoreWriter.compareAndSet(operationPlanDigest(current), restoredCheckpoint);

      hds.refreshOperationPlansAfterRecoveryRestore(restoreCommand);
      expect(hds.getRuntimeSnapshot().operation_plans.recovery_refresh_status).toBe("ready");
      expect(hds.operationPlanCommandIsCurrent(selected)).toBe(false);
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toMatchObject([
        { plan_id: operationPlanDigest(restored.plan_id), recovery_hold_reason: "held_unverified" },
      ]);
      const persistedHoldState = store.loadRecoveryHoldState() as {
        schema_version: string;
        holds: { plan_id_digest: string; reason: string; provenance: Record<string, unknown> }[];
      };
      expect(persistedHoldState).toMatchObject({
        schema_version: "operation-plan-recovery-holds.v1",
        used_for_authority: false,
        may_execute: false,
        holds: [{ plan_id_digest: operationPlanDigest(restored.plan_id), reason: "held_unverified",
          provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
            checkpoint_digest: operationPlanDigest(restoredCheckpoint) } }],
      });
      expect(JSON.stringify(persistedHoldState)).not.toContain(restoreCommand.id);
      const held = review(hds, restored, "search");
      expect(held.command).toBeNull();
      expect(held.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");

      const restarted = new HDSUpperController({ operation_plan_state: store });
      const heldAfterRestart = review(restarted, restored, "search");
      expect(heldAfterRestart.command).toBeNull();
      expect(heldAfterRestart.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");

      const newOrigin = request("plan:compute new task after restore refresh");
      const fresh = plan(newOrigin.id, root);
      await rig(hds, fresh).run(hds.decide(newOrigin).command!);
      expect(review(hds, fresh, "search").command?.type).toBe("tool_call");
    } finally {
      restoreWriter.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("復元hold対象の永続waitは期限起動を止め、状態を非権威projectionへ渡す", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-wait-recovery-hold-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    let hds: HDSUpperController | undefined;
    try {
      const goal = "Recover a synthetic plan without replaying a held wait";
      const seed = plan(randomUUID(), root);
      store.compareAndSet(null, OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [{ owner: "fixture-owner", channel: "webchat", goal,
          request_goal_criteria: noRequestCriteria(goal, seed.request_id),
          revisions: [{ digest: operationPlanDigest(seed), plan: seed }], receipt_observations: [], bindings: [], results: [] }],
      }));
      const controller = hds = new HDSUpperController({ operation_plan_state: store });
      const deadlineAt = Date.now() + 60_000;
      expect(controller.decide(request(`plan:wait ${JSON.stringify({ plan_id: seed.plan_id,
        revision_digest: operationPlanDigest(seed), deadline_at_ms: deadlineAt })}`)).command?.type).toBe("noop");
      const wait = controller.listOperationPlanWaits()[0]!;
      const restoreCommand = operationPlanRestoreCommand();
      const checkpoint = store.load();
      if (!checkpoint) throw new Error("missing plan checkpoint before restore refresh");
      expect(controller.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      controller.refreshOperationPlansAfterRecoveryRestore(restoreCommand, {
        schema_version: "operation-plan-recovery-evidence.v1",
        scope: "restored_operation_plans",
        checkpoint_digest: operationPlanDigest(checkpoint),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64),
          restore_store_key: "operation_plans",
          restore_scope_plan_digest: operationPlanDigest(seed.plan_id), restore_scope_mode: "plan_scoped_merge_v1",
          restore_backup_id_digest: "c".repeat(64), restored_state_digest: "d".repeat(64) },
        plans: [{ plan_id_digest: operationPlanDigest(seed.plan_id), restore_scope_relation: "requested",
          restore_membership: "restored", integrity: "residuals_present", dependency_status: "residuals_present" }],
        used_for_authority: false, may_execute: false,
      });

      expect(controller.operationPlanWaitContext(wait.wait_id)).toBeNull();
      expect(projectOperationPlanStatus(controller.getRuntimeSnapshot().operation_plans).waits)
        .toMatchObject([{ wait_id: wait.wait_id, recovery_hold_reason: "held_residual" }]);
      const now = vi.spyOn(Date, "now").mockReturnValue(deadlineAt);
      try {
        const deadlineEvent = createGatewayInternalInboundRequest({
          id: `plan-wait-deadline-${wait.wait_id}`, channel: "webchat", user: "fixture-owner",
          content: "Persistent operation-plan wait deadline event", timestamp: deadlineAt,
          metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "system",
            "blue_tanuki.trust_level": "trusted", "blue_tanuki.process_kind": "cron",
            "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_plan.wait_deadline_id": wait.wait_id },
        });
        expect(controller.decide(deadlineEvent).command).toBeNull();
        expect(controller.listOperationPlanWaits().find((candidate) => candidate.wait_id === wait.wait_id)?.state).toBe("waiting");
      } finally { now.mockRestore(); }
    } finally {
      hds?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("復元hold前に起動したC計算の遅延候補をJへ保存しない", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-stale-wait-candidate-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    let hds: HDSUpperController | undefined;
    try {
      const goal = "Do not retain an in-flight candidate after a recovery hold";
      const seed = plan(randomUUID(), root);
      store.compareAndSet(null, OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [{ owner: "fixture-owner", channel: "webchat", goal,
          request_goal_criteria: noRequestCriteria(goal, seed.request_id),
          revisions: [{ digest: operationPlanDigest(seed), plan: seed }], receipt_observations: [], bindings: [], results: [] }],
      }));
      const controller = hds = new HDSUpperController({ operation_plan_state: store });
      const deadlineAt = Date.now() + 60_000;
      expect(controller.decide(request(`plan:wait ${JSON.stringify({ plan_id: seed.plan_id,
        revision_digest: operationPlanDigest(seed), deadline_at_ms: deadlineAt })}`)).command?.type).toBe("noop");
      const wait = controller.listOperationPlanWaits()[0]!;
      const computeRequest = request("synthetic owner reply before scoped recovery");
      const compute = controller.decide(computeRequest).command;
      expect(compute?.type).toBe("llm_call");

      const restoreCommand = operationPlanRestoreCommand();
      const checkpoint = store.load();
      if (!checkpoint) throw new Error("missing pending wait checkpoint before restore refresh");
      expect(controller.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      controller.refreshOperationPlansAfterRecoveryRestore(restoreCommand, {
        schema_version: "operation-plan-recovery-evidence.v1", scope: "restored_operation_plans",
        checkpoint_digest: operationPlanDigest(checkpoint),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_store_key: "operation_plans",
          restore_scope_plan_digest: operationPlanDigest(seed.plan_id), restore_scope_mode: "plan_scoped_merge_v1",
          restore_backup_id_digest: "c".repeat(64), restored_state_digest: "d".repeat(64) },
        plans: [{ plan_id_digest: operationPlanDigest(seed.plan_id), restore_scope_relation: "requested",
          restore_membership: "restored", integrity: "residuals_present", dependency_status: "residuals_present" }],
        used_for_authority: false, may_execute: false,
      });

      const delayedCandidate = plan(computeRequest.id, root);
      controller.onFeedback({ command_id: compute!.id, status: "success",
        result: { operation_core: { status: "valid_plan", plan: delayedCandidate } }, metrics: { duration_ms: 1 } });
      expect(controller.listOperationPlanWaits().find((candidate) => candidate.wait_id === wait.wait_id))
        .toMatchObject({ compute_outcome: "candidate_rejected", used_for_authority: false, may_execute: false });
      expect(controller.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
      expect(controller.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_residual" });
    } finally {
      hds?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("復元hold対象の中断waitはowner返信があってもCへ再開しない", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-interrupted-recovery-hold-"));
    const databasePath = join(root, "state.sqlite");
    const goal = "Recover a synthetic task with a held interrupted wait";
    const seed = plan(randomUUID(), root);
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal,
        request_goal_criteria: noRequestCriteria(goal, seed.request_id),
        revisions: [{ digest: operationPlanDigest(seed), plan: seed }], receipt_observations: [], bindings: [], results: [] }],
    });
    let store = new OperationPlanStateStore(databasePath);
    store.compareAndSet(null, checkpoint);
    let hds = new HDSUpperController({ operation_plan_state: store });
    try {
      const deadlineAt = Date.now() + 60_000;
      expect(hds.decide(request(`plan:wait ${JSON.stringify({ plan_id: seed.plan_id,
        revision_digest: operationPlanDigest(seed), deadline_at_ms: deadlineAt })}`)).command?.type).toBe("noop");
      const wait = hds.listOperationPlanWaits()[0]!;
      expect(hds.decide(request("synthetic owner reply before process restart")).command?.type).toBe("llm_call");
      hds.close();
      store.close();

      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });
      expect(hds.reconcileOperationPlanWaitComputations()).toEqual({ candidate_reconciled: 0, interrupted: 1 });
      const restoreCommand = operationPlanRestoreCommand();
      const restoredCheckpoint = store.load();
      if (!restoredCheckpoint) throw new Error("missing interrupted wait checkpoint");
      expect(hds.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      hds.refreshOperationPlansAfterRecoveryRestore(restoreCommand, {
        schema_version: "operation-plan-recovery-evidence.v1",
        scope: "restored_operation_plans",
        checkpoint_digest: operationPlanDigest(restoredCheckpoint),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64),
          restore_store_key: "operation_plans",
          restore_scope_plan_digest: operationPlanDigest(seed.plan_id), restore_scope_mode: "plan_scoped_merge_v1",
          restore_backup_id_digest: "c".repeat(64), restored_state_digest: "d".repeat(64) },
        plans: [{ plan_id_digest: operationPlanDigest(seed.plan_id), restore_scope_relation: "requested",
          restore_membership: "restored", integrity: "residuals_present", dependency_status: "residuals_present" }],
        used_for_authority: false, may_execute: false,
      });
      const resume = hds.decide(request(`plan:resume_wait ${JSON.stringify({ wait_id: wait.wait_id,
        response: "new synthetic owner reply after recovery" })}`));
      expect(resume.command).toBeNull();
      expect(resume.log.commit.reason).toBe("plan_control_denied:plan_recovery_residual_hold");
      expect(hds.listOperationPlanWaits().find((candidate) => candidate.wait_id === wait.wait_id))
        .toMatchObject({ compute_outcome: "interrupted" });
      expect(projectOperationPlanStatus(hds.getRuntimeSnapshot().operation_plans).waits)
        .toMatchObject([{ wait_id: wait.wait_id, recovery_hold_reason: "held_residual" }]);
    } finally {
      hds.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to start selected-store restore while a plan action is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-live-restore-busy-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const origin = request("plan:compute restore busy synthetic task");
      const candidate = plan(origin.id, root);
      await rig(hds, candidate).run(hds.decide(origin).command!);
      const selected = review(hds, candidate, "search").command!;
      expect(hds.beginOperationPlanAttempt(selected)).toBe(true);
      expect(hds.beginOperationPlanRecoveryRefresh(operationPlanRestoreCommand())).toBe(false);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quiesces and reopens J/M only after internal verification while persisting plan holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-jm-restore-lifecycle-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const privateRoot = join(root, "private-state");
    await mkdir(privateRoot, { recursive: true });
    const memory = {
      private_state_root: privateRoot,
      database_path: join(privateRoot, "result-memory", "j-control.sqlite"),
      memory_database_path: join(privateRoot, "result-memory", "m-state.sqlite"),
    };
    await mkdir(join(privateRoot, "result-memory"), { recursive: true });
    let hds: HDSUpperController | undefined;
    try {
      hds = new HDSUpperController({ operation_plan_state: store, operation_plan_memory: memory });
      const origin = request("plan:compute synthetic task before J/M restore");
      const candidate = plan(origin.id, root);
      await rig(hds, candidate).run(hds.decide(origin).command!);
      const selected = review(hds, candidate, "search").command!;
      const restoreCommand = canonicalMemoryRestoreCommand();

      expect(hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
      expect(hds.operationPlanCommandIsCurrent(selected)).toBe(false);
      expect(hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      expect(hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      const unobservedReview = review(hds, candidate, "independent");
      expect(unobservedReview.command).toBeNull();
      expect(unobservedReview.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");

      hds.closeOperationPlanMemory();
      hds = new HDSUpperController({ operation_plan_state: store, operation_plan_memory: memory });
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
    } finally {
      hds?.closeOperationPlanMemory();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("J/M restore observation preserves an unresolved OperationPlan-store hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-jm-do-not-clear-plan-restore-hold-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const candidate = plan("older-operation-plan-restore", root);
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "unresolved plan-store restore",
        request_goal_criteria: noRequestCriteria("unresolved plan-store restore", candidate.request_id),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], receipt_observations: [], bindings: [], results: [] }],
    });
    const planIdDigest = operationPlanDigest(candidate.plan_id);
    store.compareAndSet(null, checkpoint);
    store.compareAndSetRecoveryHoldState(null, {
      schema_version: "operation-plan-recovery-holds.v1",
      holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified", restore_scope_relation: "requested",
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("older-plan-restore"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_store_key: "operation_plans",
          restore_backup_id_digest: "c".repeat(64), restore_scope_plan_digest: planIdDigest,
          restored_state_digest: "d".repeat(64), checkpoint_digest: operationPlanDigest(checkpoint) } }],
      used_for_authority: false, may_execute: false,
    });
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const restoreCommand = canonicalMemoryRestoreCommand("m_state");
      expect(hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
      const observation = {
        status: "matched" as const, operation: "restore" as const, store_key: "m_state" as const,
        command_id_digest: recoveryCommandIdDigest(restoreCommand.id), operation_digest: "e".repeat(64),
        result_digest: "f".repeat(64), restore_backup_id_digest: "1".repeat(64),
        restored_state_digest: "2".repeat(64), store_ledger_status: "verified" as const,
        store_ledger_residual_count: 0 as const,
      };
      expect(hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation)).toBe(true);
      expect(store.loadRecoveryHoldState()).toMatchObject({
        holds: [{ plan_id_digest: planIdDigest, provenance: { restore_store_key: "operation_plans" } }],
      });
      const blocked = review(hds, candidate, "search");
      expect(blocked.command).toBeNull();
      expect(blocked.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("same-process restore accepts only checkpoint-bound dependency evidence and applies plan-specific holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-live-restore-dependency-evidence-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const restoreWriter = new OperationPlanStateStore(join(root, "state.sqlite"));
    const candidates = [
      plan("restored-with-residual-dependency", root),
      plan("restored-with-unobserved-dependency", root),
      plan("restored-with-observed-dependencies", root),
      plan("restored-with-unknown-membership", root),
    ];
    const restoredCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: candidates.map((candidate) => ({ owner: "fixture-owner", channel: "webchat", goal: "synthetic restored plan",
        request_goal_criteria: noRequestCriteria("synthetic restored plan", candidate.request_id),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], receipt_observations: [], bindings: [], results: [] })),
    });
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const restoreCommand = operationPlanRestoreCommand();
      expect(hds.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      restoreWriter.compareAndSet(null, restoredCheckpoint);
      const evidence = {
        schema_version: "operation-plan-recovery-evidence.v1" as const,
        scope: "restored_operation_plans" as const,
        checkpoint_digest: operationPlanDigest(restoredCheckpoint),
        provenance: {
          source: "recovery_restore" as const,
          command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64),
          restore_scope_plan_digest: operationPlanDigest(candidates[0]!.plan_id),
          restore_backup_id_digest: "c".repeat(64), restored_state_digest: "d".repeat(64),
        },
        plans: [
          { plan_id_digest: operationPlanDigest(candidates[0]!.plan_id), restore_scope_relation: "requested" as const,
            restore_membership: "restored" as const,
            integrity: "residuals_present" as const, dependency_status: "residuals_present" as const },
          { plan_id_digest: operationPlanDigest(candidates[1]!.plan_id), restore_scope_relation: "collateral" as const,
            restore_membership: "restored" as const,
            integrity: "verified" as const, dependency_status: "unobserved" as const },
          { plan_id_digest: operationPlanDigest(candidates[2]!.plan_id), restore_scope_relation: "collateral" as const,
            restore_membership: "restored" as const,
            integrity: "verified" as const, dependency_status: "observed" as const },
          { plan_id_digest: operationPlanDigest(candidates[3]!.plan_id), restore_scope_relation: "collateral" as const,
            restore_membership: "unknown" as const,
            integrity: "unverified" as const, dependency_status: "unknown" as const },
        ],
        used_for_authority: false as const,
        may_execute: false as const,
      };
      hds.refreshOperationPlansAfterRecoveryRestore(restoreCommand, evidence);

      const projection = hds.getRuntimeSnapshot().operation_plans;
      expect(projection.recovery_refresh_status).toBe("ready");
      expect(projection.plans).toMatchObject([
        { plan_id: operationPlanDigest(candidates[0]!.plan_id), recovery_hold_reason: "held_residual",
          recovery_hold_scope_relation: "requested" },
        { plan_id: operationPlanDigest(candidates[1]!.plan_id), recovery_hold_reason: "held_unobserved",
          recovery_hold_scope_relation: "collateral" },
        { plan_id: operationPlanDigest(candidates[2]!.plan_id) },
        { plan_id: operationPlanDigest(candidates[3]!.plan_id), recovery_hold_reason: "held_unverified",
          recovery_hold_scope_relation: "collateral" },
      ]);
      const recoveryHolds = store.loadRecoveryHoldState() as { holds: unknown[] };
      expect(recoveryHolds.holds).toHaveLength(3);
      expect(recoveryHolds.holds).toEqual(expect.arrayContaining([
        { plan_id_digest: operationPlanDigest(candidates[0]!.plan_id), restore_scope_relation: "requested",
          reason: "held_residual", provenance: expect.objectContaining({
            restore_scope_plan_digest: operationPlanDigest(candidates[0]!.plan_id),
          }) },
        { plan_id_digest: operationPlanDigest(candidates[1]!.plan_id), restore_scope_relation: "collateral",
          reason: "held_unobserved", provenance: expect.objectContaining({
            restore_scope_plan_digest: operationPlanDigest(candidates[0]!.plan_id),
          }) },
        { plan_id_digest: operationPlanDigest(candidates[3]!.plan_id), restore_scope_relation: "collateral",
          reason: "held_unverified", provenance: expect.objectContaining({
            restore_scope_plan_digest: operationPlanDigest(candidates[0]!.plan_id),
          }) },
      ]));
      const restarted = new HDSUpperController({ operation_plan_state: store });
      expect(review(restarted, candidates[1]!, "search").command).toBeNull();
      expect(review(hds, candidates[0]!, "search").command).toBeNull();
      expect(review(hds, candidates[1]!, "search").command).toBeNull();
      expect(review(hds, candidates[3]!, "search").command).toBeNull();
      expect(review(hds, candidates[2]!, "search").command?.type).toBe("tool_call");
    } finally {
      restoreWriter.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("same-process restore digest mismatch holds every restored plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-live-restore-stale-evidence-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const restoreWriter = new OperationPlanStateStore(join(root, "state.sqlite"));
    const restored = plan("restored-after-ledger-race", root);
    const restoredCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "stale evidence fixture",
        revisions: [{ digest: operationPlanDigest(restored), plan: restored }], receipt_observations: [], bindings: [], results: [] }],
    });
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const restoreCommand = operationPlanRestoreCommand();
      expect(hds.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      restoreWriter.compareAndSet(null, restoredCheckpoint);
      hds.refreshOperationPlansAfterRecoveryRestore(restoreCommand, {
        schema_version: "operation-plan-recovery-evidence.v1",
        scope: "restored_operation_plans",
        checkpoint_digest: "f".repeat(64),
        provenance: {
          source: "recovery_restore",
          command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64),
          restore_scope_plan_digest: operationPlanDigest(restored.plan_id),
          restore_backup_id_digest: "c".repeat(64), restored_state_digest: "d".repeat(64),
        },
        plans: [{ plan_id_digest: operationPlanDigest(restored.plan_id), restore_scope_relation: "requested", restore_membership: "restored",
          integrity: "verified", dependency_status: "observed" }],
        used_for_authority: false,
        may_execute: false,
      });
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toMatchObject([
        { plan_id: operationPlanDigest(restored.plan_id), recovery_hold_reason: "held_unverified" },
      ]);
      expect(review(hds, restored, "search").command).toBeNull();
    } finally {
      restoreWriter.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plan-scoped restore refresh preserves sibling plan state and existing holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-selective-restore-holds-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const target = plan("selective-restore-target", root);
    const sibling = plan("selective-restore-sibling", root);
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [target, sibling].map((candidate) => ({ owner: "fixture-owner", channel: "webchat", goal: "selective restore fixture",
        request_goal_criteria: noRequestCriteria("selective restore fixture", candidate.request_id),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], receipt_observations: [], bindings: [], results: [] })),
    });
    const targetDigest = operationPlanDigest(target.plan_id);
    const siblingDigest = operationPlanDigest(sibling.plan_id);
    const holdProvenance = {
      source: "recovery_restore" as const,
      command_id_digest: recoveryCommandIdDigest("prior-scoped-restore"),
      operation_digest: "a".repeat(64),
      result_digest: "b".repeat(64),
      restore_scope_plan_digest: targetDigest,
      restore_backup_id_digest: "c".repeat(64),
      restored_state_digest: "d".repeat(64),
      checkpoint_digest: operationPlanDigest(checkpoint),
    };
    store.compareAndSet(null, checkpoint);
    store.compareAndSetRecoveryHoldState(null, {
      schema_version: "operation-plan-recovery-holds.v1",
      holds: [
        { plan_id_digest: targetDigest, reason: "held_unverified", restore_scope_relation: "requested", provenance: holdProvenance },
        { plan_id_digest: siblingDigest, reason: "held_residual", restore_scope_relation: "collateral", provenance: holdProvenance },
      ],
      used_for_authority: false,
      may_execute: false,
    });
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const restoreCommand = operationPlanRestoreCommand();
      expect(hds.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      hds.refreshOperationPlansAfterRecoveryRestore(restoreCommand, {
        schema_version: "operation-plan-recovery-evidence.v1",
        scope: "restored_operation_plans",
        checkpoint_digest: operationPlanDigest(checkpoint),
        provenance: {
          source: "recovery_restore",
          command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "e".repeat(64),
          result_digest: "f".repeat(64),
          restore_store_key: "operation_plans",
          restore_backup_id_digest: "1".repeat(64),
          restore_scope_plan_digest: targetDigest,
          restore_scope_mode: "plan_scoped_merge_v1",
          restored_state_digest: "2".repeat(64),
        },
        plans: [
          { plan_id_digest: targetDigest, restore_scope_relation: "requested", restore_membership: "restored",
            integrity: "verified", dependency_status: "observed" },
          { plan_id_digest: siblingDigest, restore_scope_relation: "collateral", restore_membership: "not_restored",
            integrity: "unverified", dependency_status: "unknown" },
        ],
        used_for_authority: false,
        may_execute: false,
      });
      expect(store.load()).toEqual(checkpoint);
      expect(store.loadRecoveryHoldState()).toMatchObject({
        holds: [{ plan_id_digest: siblingDigest, reason: "held_residual", restore_scope_relation: "collateral" }],
      });
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toMatchObject([
        { plan_id: targetDigest },
        { plan_id: siblingDigest, recovery_hold_reason: "held_residual", recovery_hold_scope_relation: "collateral" },
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore evidence from another command without replacing durable plan holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-live-restore-command-mismatch-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const restored = plan("restored-after-command-mismatch", root);
    const restoredCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "command mismatch fixture",
        revisions: [{ digest: operationPlanDigest(restored), plan: restored }], receipt_observations: [], bindings: [], results: [] }],
    });
    store.compareAndSet(null, restoredCheckpoint);
    store.compareAndSetRecoveryHoldState(null, {
      schema_version: "operation-plan-recovery-holds.v1",
      holds: [{ plan_id_digest: operationPlanDigest(restored.plan_id), reason: "held_residual",
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("prior-restore"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_backup_id_digest: "c".repeat(64),
          restored_state_digest: "d".repeat(64), checkpoint_digest: operationPlanDigest(restoredCheckpoint) } }],
      used_for_authority: false,
      may_execute: false,
    } as unknown as Parameters<typeof store.compareAndSetRecoveryHoldState>[1]);
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const restoreCommand = operationPlanRestoreCommand();
      expect(hds.beginOperationPlanRecoveryRefresh(restoreCommand)).toBe(true);
      const previousCheckpoint = store.load();
      const previousHoldState = store.loadRecoveryHoldState();
      expect(() => hds.refreshOperationPlansAfterRecoveryRestore(restoreCommand, {
        schema_version: "operation-plan-recovery-evidence.v1",
        scope: "restored_operation_plans",
        checkpoint_digest: operationPlanDigest(restoredCheckpoint),
        provenance: {
          source: "recovery_restore",
          command_id_digest: recoveryCommandIdDigest("different-restore"),
          operation_digest: "e".repeat(64), result_digest: "f".repeat(64),
          restore_scope_plan_digest: operationPlanDigest(restored.plan_id),
          restore_backup_id_digest: "1".repeat(64), restored_state_digest: "2".repeat(64),
        },
        plans: [{ plan_id_digest: operationPlanDigest(restored.plan_id), restore_scope_relation: "requested", restore_membership: "restored",
          integrity: "verified", dependency_status: "observed" }],
        used_for_authority: false,
        may_execute: false,
      })).toThrow("plan_recovery_evidence_command_mismatch");
      expect(hds.getRuntimeSnapshot().operation_plans.recovery_refresh_status).toBe("pending");
      expect(store.load()).toEqual(previousCheckpoint);
      expect(store.loadRecoveryHoldState()).toEqual(previousHoldState);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("復元残差は既存plan選択だけをholdし、cleanと新規planも通常HDS判断へ戻す", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-recovery-hold-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const residual = plan("restored-residual", join(root, "workspace"));
    const clean = plan("restored-clean", join(root, "workspace"));
    const afterRestore = plan("created-after-restore", join(root, "workspace"));
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [residual, clean, afterRestore].map((candidate) => ({ owner: "fixture-owner", channel: "webchat", goal: "synthetic recovery test",
        request_goal_criteria: noRequestCriteria("synthetic recovery test", candidate.request_id),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], receipt_observations: [], bindings: [], results: [] })),
    });
    store.compareAndSet(null, checkpoint);
    store.compareAndSetRecoveryHoldState(null, {
      schema_version: "operation-plan-recovery-holds.v1", holds: [],
      used_for_authority: false, may_execute: false,
    });
    const hds = new HDSUpperController({ operation_plan_state: store, operation_plan_recovery_evidence: {
      schema_version: "operation-plan-recovery-evidence.v1", scope: "restored_operation_plans",
      checkpoint_digest: operationPlanDigest(checkpoint),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("startup-restore"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_backup_id_digest: "c".repeat(64),
          restore_scope_plan_digest: operationPlanDigest(residual.plan_id), restored_state_digest: "d".repeat(64) },
      plans: [
          { plan_id_digest: operationPlanDigest(residual.plan_id), restore_scope_relation: "requested", restore_membership: "restored",
          integrity: "residuals_present", dependency_status: "residuals_present" },
          { plan_id_digest: operationPlanDigest(clean.plan_id), restore_scope_relation: "collateral", restore_membership: "restored", integrity: "verified", dependency_status: "observed" },
          { plan_id_digest: operationPlanDigest(afterRestore.plan_id), restore_scope_relation: "collateral", restore_membership: "not_restored",
          integrity: "unverified", dependency_status: "unknown" },
      ], used_for_authority: false, may_execute: false,
    } });
    try {
      const held = review(hds, residual, "search");
      expect(held.command).toBeNull();
      expect(held.log.commit.reason).toBe("plan_control_denied:plan_recovery_residual_hold");
      expect(review(hds, clean, "search").command?.type).toBe("tool_call");
      expect(review(hds, afterRestore, "search").command?.type).toBe("tool_call");

      const freshOrigin = request("plan:compute new synthetic task after recovery");
      const fresh = plan(freshOrigin.id, join(root, "workspace"));
      const executor = rig(hds, fresh);
      await executor.run(hds.decide(freshOrigin).command!);
      expect(review(hds, fresh, "search").command?.type).toBe("tool_call");
      expect(hds.getRuntimeSnapshot().operation_plans.plans.find((entry) => entry.plan_id === operationPlanDigest(residual.plan_id)))
        .toMatchObject({ recovery_hold_reason: "held_residual" });
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Broker復元後は同じtask lineageの計画を隔離し、全計画の再観測後だけ個別レビューを許す", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-broker-restore-hold-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const privateRoot = join(root, "private-state");
    const resultMemoryRoot = join(privateRoot, "result-memory");
    await mkdir(resultMemoryRoot, { recursive: true });
    const target = plan("broker-restored-target", root);
    const sameTaskSibling = plan("broker-restored-sibling", root);
    const unrelated = plan("broker-restored-unrelated", root);
    const sharedTaskIdentityDigest = "e".repeat(64);
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [target, sameTaskSibling, unrelated].map((candidate) => ({ owner: "fixture-owner", channel: "webchat",
        goal: "synthetic Broker recovery test", request_goal_criteria: noRequestCriteria("synthetic Broker recovery test", candidate.request_id),
        ...(candidate === target || candidate === sameTaskSibling ? { task_identity_digest: sharedTaskIdentityDigest } : {}),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], receipt_observations: [], bindings: [], results: [] })),
    });
    store.compareAndSet(null, checkpoint);
    const targetPlanIdDigest = operationPlanDigest(target.plan_id);
    const siblingPlanIdDigest = operationPlanDigest(sameTaskSibling.plan_id);
    const dependencyCurrentPlanIds = new Set<string>();
    let hds: HDSUpperController | undefined;
    try {
      hds = new HDSUpperController({
        operation_plan_state: store,
        operation_plan_memory: {
          private_state_root: privateRoot,
          database_path: join(resultMemoryRoot, "j-control.sqlite"),
          memory_database_path: join(resultMemoryRoot, "m-state.sqlite"),
        },
        operation_plan_broker_restore_dependency_verifier: (planIdDigest, provenance) =>
          [targetPlanIdDigest, siblingPlanIdDigest].includes(planIdDigest) &&
          provenance.restore_store_key === "broker" && dependencyCurrentPlanIds.has(planIdDigest),
      });
      const restoreCommand = brokerRestoreCommand();
      const evidence: OperationPlanBrokerRestoreDependencyEvidence = {
        schema_version: "operation-plan-broker-restore-dependency-evidence.v1",
        checkpoint_digest: operationPlanDigest(checkpoint),
        restore_observation: "verified",
        provenance: {
          source: "recovery_restore",
          command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
          operation_digest: "a".repeat(64),
          result_digest: "b".repeat(64),
          restore_store_key: "broker",
          restore_backup_id_digest: "c".repeat(64),
          restore_scope_plan_digest: null,
          restored_state_digest: "d".repeat(64),
        },
        plans: [
          { plan_id_digest: targetPlanIdDigest, status: "unobserved" },
          { plan_id_digest: siblingPlanIdDigest, status: "unaffected" },
          { plan_id_digest: operationPlanDigest(unrelated.plan_id), status: "unaffected" },
        ],
        used_for_authority: false,
        may_execute: false,
      };
      expect(hds.recordBrokerRestoreDependencyEvidence(restoreCommand, evidence)).toBe(true);
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toMatchObject([
        { plan_id: targetPlanIdDigest, recovery_hold_reason: "held_unobserved" },
        { plan_id: siblingPlanIdDigest, recovery_hold_reason: "held_unobserved" },
        { plan_id: operationPlanDigest(unrelated.plan_id) },
      ]);
      const persistedHolds = store.loadRecoveryHoldState() as { holds: { plan_id_digest: string; reason: string }[] };
      expect(persistedHolds.holds).toHaveLength(2);
      expect(persistedHolds.holds).toEqual(expect.arrayContaining([
        { plan_id_digest: targetPlanIdDigest, reason: "held_unobserved",
          restore_scope_relation: "unknown", provenance: expect.objectContaining({
            restore_store_key: "broker", command_id_digest: recoveryCommandIdDigest(restoreCommand.id) }) },
        { plan_id_digest: siblingPlanIdDigest, reason: "held_unobserved",
          restore_scope_relation: "unknown", provenance: expect.objectContaining({
            restore_store_key: "broker", command_id_digest: recoveryCommandIdDigest(restoreCommand.id) }) },
      ]));
      expect(persistedHolds).toMatchObject({
        used_for_authority: false,
        may_execute: false,
      });

      const held = review(hds, target, "search");
      expect(held.command).toBeNull();
      expect(held.log.commit.reason).toBe("plan_control_denied:plan_recovery_unobserved_hold");
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unobserved" });

      dependencyCurrentPlanIds.add(targetPlanIdDigest);
      const siblingNotReobserved = review(hds, target, "search");
      expect(siblingNotReobserved.command).toBeNull();
      expect(siblingNotReobserved.log.commit.reason).toBe("plan_control_denied:plan_recovery_unobserved_hold");

      dependencyCurrentPlanIds.add(siblingPlanIdDigest);
      expect(review(hds, target, "search").command?.type).toBe("tool_call");
      expect(hds.getRuntimeSnapshot().operation_plans.plans.find((entry) => entry.plan_id === targetPlanIdDigest)
        ?.recovery_hold_reason).toBeUndefined();
      expect(hds.getRuntimeSnapshot().operation_plans.plans.find((entry) => entry.plan_id === siblingPlanIdDigest))
        .toMatchObject({ recovery_hold_reason: "held_unobserved" });
      expect(review(hds, sameTaskSibling, "search").command?.type).toBe("tool_call");
      expect(review(hds, unrelated, "search").command?.type).toBe("tool_call");
    } finally {
      hds?.closeOperationPlanMemory();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("起動時に既存のplan単位Broker holdを同じtask lineageの計画へ拡張する", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-broker-restore-lineage-restart-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const target = plan("broker-lineage-legacy-hold", root);
    const sibling = plan("broker-lineage-legacy-sibling", root);
    const unrelated = plan("broker-lineage-legacy-unrelated", root);
    const sharedTaskIdentityDigest = "f".repeat(64);
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [target, sibling, unrelated].map((candidate) => ({ owner: "fixture-owner", channel: "webchat",
        goal: "synthetic persisted Broker hold lineage test",
        ...(candidate === target || candidate === sibling ? { task_identity_digest: sharedTaskIdentityDigest } : {}),
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }],
        receipt_observations: [], bindings: [], results: [] })),
    });
    const targetPlanIdDigest = operationPlanDigest(target.plan_id);
    store.compareAndSet(null, checkpoint);
    store.compareAndSetRecoveryHoldState(null, {
      schema_version: "operation-plan-recovery-holds.v1",
      holds: [{ plan_id_digest: targetPlanIdDigest, reason: "held_unobserved", restore_scope_relation: "unknown",
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("legacy-broker-restore"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_store_key: "broker",
          restore_backup_id_digest: "c".repeat(64), restore_scope_plan_digest: null,
          restored_state_digest: "d".repeat(64), checkpoint_digest: operationPlanDigest(checkpoint) } }],
      used_for_authority: false, may_execute: false,
    });
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toMatchObject([
        { plan_id: targetPlanIdDigest, recovery_hold_reason: "held_unobserved" },
        { plan_id: operationPlanDigest(sibling.plan_id), recovery_hold_reason: "held_unobserved" },
        { plan_id: operationPlanDigest(unrelated.plan_id) },
      ]);
      expect((store.loadRecoveryHoldState() as { holds: { plan_id_digest: string }[] }).holds.map((hold) => hold.plan_id_digest))
        .toEqual(expect.arrayContaining([targetPlanIdDigest, operationPlanDigest(sibling.plan_id)]));
      expect((store.loadRecoveryHoldState() as { holds: unknown[] }).holds).toHaveLength(2);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unverified recovery scope holds all existing plans and malformed evidence stops construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-recovery-unverified-"));
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    const existing = plan("existing-under-unknown-recovery", join(root, "workspace"));
    const checkpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "synthetic recovery test",
        revisions: [{ digest: operationPlanDigest(existing), plan: existing }], receipt_observations: [], bindings: [], results: [] }],
    });
    store.compareAndSet(null, checkpoint);
    try {
      const hds = new HDSUpperController({ operation_plan_state: store, operation_plan_recovery_evidence: {
        schema_version: "operation-plan-recovery-evidence.v1", scope: "unverified_history", plans: [],
        checkpoint_digest: operationPlanDigest(checkpoint),
        used_for_authority: false, may_execute: false,
      } });
      const held = review(hds, existing, "search");
      expect(held.command).toBeNull();
      expect(held.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");
      const staleEvidenceHds = new HDSUpperController({ operation_plan_state: store, operation_plan_recovery_evidence: {
        schema_version: "operation-plan-recovery-evidence.v1", scope: "restored_operation_plans",
        checkpoint_digest: "f".repeat(64),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("stale-restore"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_backup_id_digest: "c".repeat(64),
          restore_scope_plan_digest: operationPlanDigest(existing.plan_id), restored_state_digest: "d".repeat(64) },
        plans: [{ plan_id_digest: operationPlanDigest(existing.plan_id), restore_scope_relation: "requested", restore_membership: "restored",
          integrity: "verified", dependency_status: "observed" }],
        used_for_authority: false, may_execute: false,
      } });
      expect(review(staleEvidenceHds, existing, "search").command).toBeNull();
      expect(staleEvidenceHds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
      expect(() => new HDSUpperController({ operation_plan_recovery_evidence: {
        schema_version: "operation-plan-recovery-evidence.v1", scope: "restored_operation_plans",
        checkpoint_digest: "f".repeat(64),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("invalid-restore"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_backup_id_digest: "c".repeat(64),
          restore_scope_plan_digest: "d".repeat(64), restored_state_digest: "e".repeat(64) },
        plans: [{ plan_id_digest: "not-a-digest", restore_scope_relation: "collateral", restore_membership: "restored", integrity: "verified", dependency_status: "observed" }],
        used_for_authority: false, may_execute: false,
      } })).toThrow("plan_recovery_evidence_invalid");
      expect(() => new HDSUpperController({ operation_plan_recovery_evidence: {
        schema_version: "operation-plan-recovery-evidence.v1", scope: "restored_operation_plans",
        checkpoint_digest: operationPlanDigest(checkpoint),
        provenance: { source: "recovery_restore", command_id_digest: recoveryCommandIdDigest("scope-mismatch"),
          operation_digest: "a".repeat(64), result_digest: "b".repeat(64), restore_backup_id_digest: "c".repeat(64),
          restore_scope_plan_digest: operationPlanDigest(existing.plan_id), restored_state_digest: "d".repeat(64) },
        plans: [{ plan_id_digest: operationPlanDigest(existing.plan_id), restore_scope_relation: "collateral",
          restore_membership: "restored", integrity: "verified", dependency_status: "observed" }],
        used_for_authority: false, may_execute: false,
      } })).toThrow("plan_recovery_evidence_invalid");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("receipt配列を持たない旧checkpointをdigest検証後に既定値へ移行して読む", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-legacy-state-"));
    const filepath = join(root, "state.sqlite");
    const store = new OperationPlanStateStore(filepath);
    const candidate = plan("legacy", join(root, "workspace"));
    const legacy = {
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal: "legacy checkpoint",
        revisions: [{ digest: operationPlanDigest(candidate), plan: candidate }], bindings: [], results: [] }],
    };
    try {
      OperationPlanCheckpointSchema.parse(legacy);
      store.close();
      const db = new DatabaseSync(filepath);
      try {
        db.prepare("INSERT INTO operation_plan_state (id, checkpoint_json, digest) VALUES (1, ?, ?)")
          .run(JSON.stringify(legacy), operationPlanDigest(legacy));
      } finally { db.close(); }
      const restored = new OperationPlanStateStore(filepath);
      try { expect(restored.load()?.plans[0]?.receipt_observations).toEqual([]); }
      finally { restored.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("Gmail計画は宛先固定の単一message.sendだけをtool commandへ結ぶ", async () => {
    const safeHds = new HDSUpperController(); const safeOrigin = request("plan:compute synthetic send");
    const safe = gmailSendPlan(safeOrigin.id, { operation: "message.send", to: "inspection@example.invalid",
      subject: "synthetic", body_text: "fixture" });
    const safeExecutor = rig(safeHds, safe); await safeExecutor.run(safeHds.decide(safeOrigin).command!);
    const selected = review(safeHds, safe, "send");
    expect(selected.command?.type).toBe("tool_call");
    if (selected.command?.type !== "tool_call") throw new Error("bounded Gmail plan was not connected");
    expect(selected.command.payload).toMatchObject({ tool_name: "gmail.write", arguments: safe.steps[0]?.parameters });

    const unsafeHds = new HDSUpperController(); const unsafeOrigin = request("plan:compute multiple send targets");
    const unsafe = gmailSendPlan(unsafeOrigin.id, { operation: "message.send", to: "inspection@example.invalid",
      cc: "second@example.invalid", subject: "synthetic", body_text: "fixture" });
    const unsafeExecutor = rig(unsafeHds, unsafe); await unsafeExecutor.run(unsafeHds.decide(unsafeOrigin).command!);
    const rejected = review(unsafeHds, unsafe, "send");
    expect(rejected.command).toBeNull();
    expect(rejected.log.commit.decision).not.toBe("ASSERT");
  });

  it("Gmail message.sendのpurpose sourceとcanonical payload observationをHDS・Executor ticketへ結ぶ", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute synthetic send");
    const candidate = gmailSendPlan(origin.id, { operation: "message.send", to: "inspection@example.invalid",
      subject: "synthetic", body_text: "fixture" });
    const planExecutor = rig(hds, candidate);
    await planExecutor.run(hds.decide(origin).command!);
    const selected = review(hds, candidate, "send");
    if (selected.command?.type !== "tool_call") throw new Error("bounded Gmail plan was not connected");

    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(selected.command);
    if (!operationPlanBindingDigest) throw new Error("selected Gmail plan source binding was unavailable");
    const tools = new ToolRegistry(); tools.register(gmailWriteTool);
    const authority = createExecutorApprovalAuthority({ require_hds_execution_binding: true });
    const executor = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
      tools, approval_authority: authority });
    const targetObservation = GmailWriteTargetVersionObservationSchema.parse(
      await executor.inspectCommandTargetVersion(selected.command, undefined, operationPlanBindingDigest));
    expect(targetObservation).toMatchObject({ operation_plan_binding_digest: operationPlanBindingDigest,
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(targetObservation)).not.toContain("inspection@example.invalid");
    expect(JSON.stringify(targetObservation)).not.toContain("fixture");

    const binding = hds.createExecutionAuthorityBinding(selected.command, targetObservation);
    expect(binding.operation_plan_binding_digest).toBe(operationPlanBindingDigest);
    expect(binding.broker_target_version_observation_digest).toBe(operationPlanDigest(targetObservation));
    const approval = evaluateApproval(selected.command, [], { actor: "fixture-owner", default_mode: "full_access" });
    const proof = { source: "human_final_review" as const, decision: "approve" as const, approved_by: "fixture-owner",
      approved_at_ms: Date.now(), upstream_commit_hash: selected.command.upstream_decision.commit_hash,
      operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required,
      reason: "synthetic final review fixture" };
    const changedObservation = GmailWriteTargetVersionObservationSchema.parse({ ...targetObservation,
      request_payload_digest: "f".repeat(64) });
    expect(() => authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, changedObservation))
      .toThrow(/gmail.write target version does not match command|target version binding does not match evidence/);
    authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, targetObservation);
    // No executor call is made here: this test binds an outbound message but never sends it.
  });

  it("Gmail draft.createは作成先・正確なpayloadをcurrent plan sourceとHDS・Executor ticketへ結ぶ", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute synthetic draft");
    const candidate = gmailSendPlan(origin.id, { operation: "draft.create", to: "inspection@example.invalid",
      subject: "synthetic draft", body_text: "fixture draft body" });
    const planExecutor = rig(hds, candidate);
    await planExecutor.run(hds.decide(origin).command!);
    const selected = review(hds, candidate, "send");
    if (selected.command?.type !== "tool_call") throw new Error("bounded Gmail draft plan was not connected");

    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(selected.command);
    if (!operationPlanBindingDigest) throw new Error("selected Gmail draft plan source binding was unavailable");
    const tools = new ToolRegistry(); tools.register(gmailWriteTool);
    const authority = createExecutorApprovalAuthority({ require_hds_execution_binding: true });
    const executor = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
      tools, approval_authority: authority });
    const targetObservation = GmailWriteTargetVersionObservationSchema.parse(
      await executor.inspectCommandTargetVersion(selected.command, undefined, operationPlanBindingDigest));
    expect(targetObservation).toMatchObject({ operation_plan_binding_digest: operationPlanBindingDigest,
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(targetObservation)).not.toContain("inspection@example.invalid");
    expect(JSON.stringify(targetObservation)).not.toContain("fixture draft body");

    const binding = hds.createExecutionAuthorityBinding(selected.command, targetObservation);
    expect(binding.operation_plan_binding_digest).toBe(operationPlanBindingDigest);
    expect(binding.broker_target_version_observation_digest).toBe(operationPlanDigest(targetObservation));
    const approval = evaluateApproval(selected.command, [], { actor: "fixture-owner", default_mode: "full_access" });
    const proof = { source: "human_final_review" as const, decision: "approve" as const, approved_by: "fixture-owner",
      approved_at_ms: Date.now(), upstream_commit_hash: selected.command.upstream_decision.commit_hash,
      operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required,
      reason: "synthetic draft final review fixture" };
    const changedObservation = GmailWriteTargetVersionObservationSchema.parse({ ...targetObservation,
      request_payload_digest: "f".repeat(64) });
    expect(() => authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, changedObservation))
      .toThrow(/gmail.write target version does not match command|target version binding does not match evidence/);
    authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, targetObservation);
    // No executor call is made here: this test binds a draft request but never creates a provider draft.
  });

  it("Gmail draft.sendは既存draft idだけをJ計画へ結び、provider内容stateをHDS・Executor ticketへsealする", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture draftを内容確認後に送る");
    const candidate = gmailSendPlan(origin.id, { operation: "draft.send", draft_id: "fixture-draft-id" });
    const planExecutor = rig(hds, candidate);
    await planExecutor.run(hds.decide(origin).command!);
    const selected = review(hds, candidate, "send");
    if (selected.command?.type !== "tool_call") throw new Error("existing Gmail draft send plan was not connected");
    expect(selected.command.payload.arguments).toEqual({ operation: "draft.send", draft_id: "fixture-draft-id" });

    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(selected.command);
    if (!operationPlanBindingDigest) throw new Error("selected existing Gmail draft source binding was unavailable");
    const targetObservation = GmailWriteTargetVersionObservationSchema.parse({
      schema_version: "blue-tanuki.gmail-write-target-version.v1",
      target_identity_digest: operationPlanDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v3",
        service: "gmail", operation: "draft.send", draft_id: "fixture-draft-id" }),
      request_payload_digest: gmailDraftSendRequestPayloadDigest({ operation: "draft.send", draft_id: "fixture-draft-id" }, "d".repeat(64)),
      provider_state_digest: "c".repeat(64),
      provider_raw_digest: "d".repeat(64), command_digest: operationPlanDigest(selected.command),
      operation_plan_binding_digest: operationPlanBindingDigest, used_for_authority: false, may_execute: false,
    });
    const binding = hds.createExecutionAuthorityBinding(selected.command, targetObservation);
    expect(binding.broker_target_version_observation_digest).toBe(operationPlanDigest(targetObservation));
    const changedPayload = GmailWriteTargetVersionObservationSchema.parse({ ...targetObservation,
      request_payload_digest: "e".repeat(64) });
    expect(() => hds.createExecutionAuthorityBinding(selected.command!, changedPayload))
      .toThrow(/target version does not match/);

    const authority = createExecutorApprovalAuthority({ require_hds_execution_binding: true });
    const approval = evaluateApproval(selected.command, [], { actor: "fixture-owner", default_mode: "full_access" });
    const proof = { source: "human_final_review" as const, decision: "approve" as const, approved_by: "fixture-owner",
      approved_at_ms: Date.now(), upstream_commit_hash: selected.command.upstream_decision.commit_hash,
      operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required,
      reason: "synthetic existing draft content-review fixture" };
    const changedProviderState = GmailWriteTargetVersionObservationSchema.parse({ ...targetObservation,
      provider_state_digest: "e".repeat(64) });
    expect(() => authority.approve(selected.command!, proof, executorCommandDigest(selected.command!), binding, changedProviderState))
      .toThrow(/target version binding does not match evidence/);
    authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, targetObservation);
    // The fixture binds the existing draft state only; no Gmail provider request is issued.
  });

  it("旧L2のfile.edit計画は明示選択commandへ昇格しない", async () => {
    const origin = request("plan:compute synthetic noteの限定編集");
    const target = { kind: "file" as const, id: "notes.txt" };
    const candidate: OperationPlan = {
      version: "operation-core.v1", plan_id: `legacy-file-edit-${origin.id}`, request_id: origin.id,
      state: "planned", steps: [{ step_id: "edit-note", operation: "file.edit", target, state: "planned",
        effects: ["read", "write"], permission: { risk: "medium", approval_level: "L2_operate",
          final_review_required: false, hds_brain_authority_required: true, approval_gate_required: true },
        adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
        parameters: { path: "notes.txt", search: "old", replace: "new", expected_replacements: 1, max_bytes: 128 },
        preparation: { depends_on: [], bindings: [], preconditions: [],
          validation: [{ check_id: "edited-note", method: "result_equals", target,
            expected: { edited: true, replacements: 1, bytes_written: 3 } }],
          compensation: { available: false, reason: "an in-place edit requires a new owner-reviewed edit" } } }],
      rollback: { available: false },
      raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
      planner_output_used_for_authority: false, hds_brain_authority_required: true,
    };
    const hds = new HDSUpperController();
    try {
      const planExecutor = rig(hds, candidate, fileEditTool);
      await planExecutor.run(hds.decide(origin).command!);
      const rejected = review(hds, candidate, "edit-note");
      expect(rejected.command).toBeNull();
      expect(rejected.log.commit.reason).toContain("plan_target_resolver_not_connected");
      expect(hds.getAudit().verify()).toBe(true);
    } finally { hds.close(); }
  });

  it("J計画のfile.writeは未存在のcreate対象とpayloadをHDS・Executor ticketへ結び実ファイルへ接続する", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-write-"));
    const workspace = join(root, "workspace"); const content = "synthetic planned file content\n";
    await mkdir(workspace);
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const hds = new HDSUpperController();
    try {
      const origin = request("plan:compute synthetic noteを新規作成");
      const target = { kind: "file" as const, id: "notes.txt" };
      const candidate: OperationPlan = {
        version: "operation-core.v1", plan_id: `file-write-plan-${origin.id}`, request_id: origin.id,
        state: "planned", steps: [{ step_id: "create-note", operation: "file.write", target, state: "planned",
          effects: ["write"], permission: { risk: "medium", approval_level: "L2_operate",
            final_review_required: false, hds_brain_authority_required: true, approval_gate_required: true },
          adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
          parameters: { path: "notes.txt", content, mode: "create" },
          preparation: { depends_on: [], bindings: [], preconditions: [],
            validation: [{ check_id: "created-note", method: "result_equals", target,
              expected: { path: "notes.txt", sandbox_root: workspace, mode: "create", bytes_written: Buffer.byteLength(content) } }],
            compensation: { available: false, reason: "a newly created file requires owner-directed cleanup" } } }],
        rollback: { available: false },
        raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
        planner_output_used_for_authority: false, hds_brain_authority_required: true,
      };
      const planExecutor = rig(hds, candidate); await planExecutor.run(hds.decide(origin).command!);
      const selected = review(hds, candidate, "create-note");
      if (selected.command?.type !== "tool_call" || selected.command.payload.tool_name !== "file.write") {
        throw new Error("bounded file.write plan was not connected");
      }
      const planBindingDigest = hds.getExecutionOperationPlanBindingDigest(selected.command);
      if (!planBindingDigest) throw new Error("selected file.write plan source was unavailable");
      const tools = new ToolRegistry(); tools.register(fileWriteTool);
      const authority = createExecutorApprovalAuthority();
      const executor = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
        tools, approval_authority: authority });
      const observation = FileWriteTargetVersionObservationSchema.parse(await executor.inspectCommandTargetVersion(
        selected.command, { BLUE_TANUKI_FILE_ROOT: workspace }, planBindingDigest));
      expect(observation).toMatchObject({ operation_plan_binding_digest: planBindingDigest,
        target_state: "absent", used_for_authority: false, may_execute: false });
      expect(JSON.stringify(observation)).not.toContain(content);
      expect(() => hds.createExecutionAuthorityBinding(selected.command!, { ...observation, payload_digest: "f".repeat(64) }))
        .toThrow(/file.write target version does not match/);
      const binding = hds.createExecutionAuthorityBinding(selected.command, observation);
      expect(binding.broker_target_version_observation_digest).toBe(operationPlanDigest(observation));
      expect(hds.beginOperationPlanAttempt(selected.command)).toBe(true);
      const approval = evaluateApproval(selected.command, [], { actor: "fixture-owner", default_mode: "full_access" });
      const proof = { source: "approval_gate" as const, decision: "allow" as const, approved_by: "fixture-owner",
        approved_at_ms: Date.now(), upstream_commit_hash: selected.command.upstream_decision.commit_hash,
        operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required,
        reason: "synthetic create-only file plan fixture" };
      const approved = authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, observation);
      const feedback = await executor.execute(approved);
      if (feedback.status !== "success") throw new Error(`planned file.write failed: ${feedback.error ?? "unknown"}`);
      expect(feedback.status).toBe("success");
      expect(await readFile(join(workspace, "notes.txt"), "utf8")).toBe(content);
      const overwriteOrigin = request("plan:compute overwrite an existing note");
      const overwriteCandidate = structuredClone(candidate);
      overwriteCandidate.plan_id = `file-write-overwrite-${overwriteOrigin.id}`;
      overwriteCandidate.request_id = overwriteOrigin.id;
      overwriteCandidate.steps[0]!.parameters!.mode = "overwrite";
      const overwritePlanExecutor = rig(hds, overwriteCandidate);
      await overwritePlanExecutor.run(hds.decide(overwriteOrigin).command!);
      expect(review(hds, overwriteCandidate, "create-note").command).toBeNull();
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      hds.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    }
  });

  it("J計画のfile.deleteはL3 final reviewと変更前hashを結び、合成workspaceの対象へ接続する", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-delete-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
      const originalContent = "synthetic delete target\n";
      await writeFile(join(workspace, "notes.txt"), originalContent);
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const hds = new HDSUpperController();
    try {
      const origin = request("plan:compute 合成workspaceのnotes.txtを削除する");
      const target = { kind: "file" as const, id: "notes.txt" };
      const candidate: OperationPlan = {
        version: "operation-core.v1", plan_id: `file-delete-plan-${origin.id}`, request_id: origin.id,
        state: "planned", steps: [{ step_id: "delete-note", operation: "file.delete", target, state: "planned",
          effects: ["delete"], permission: { risk: "high", approval_level: "L3_final_review",
            final_review_required: true, hds_brain_authority_required: true, approval_gate_required: true },
          adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
          parameters: { path: "notes.txt", max_bytes: 128 },
          preparation: { depends_on: [], bindings: [], preconditions: [],
            validation: [{ check_id: "deleted-note", method: "result_equals", target, expected: { deleted: true } }],
            compensation: { available: false, reason: "file deletion requires a new owner-reviewed create operation to recover" } } }],
        rollback: { available: false },
        raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
        planner_output_used_for_authority: false, hds_brain_authority_required: true,
      };
      const planExecutor = rig(hds, candidate, fileDeleteTool);
      await planExecutor.run(hds.decide(origin).command!);
      const selected = review(hds, candidate, "delete-note");
      if (selected.command?.type !== "tool_call" || selected.command.payload.tool_name !== "file.delete") {
        throw new Error("bounded file.delete plan was not connected");
      }
      const planBindingDigest = hds.getExecutionOperationPlanBindingDigest(selected.command);
      if (!planBindingDigest) throw new Error("selected file.delete plan source was unavailable");
      const tools = new ToolRegistry(); tools.register(fileDeleteTool);
      const authority = createExecutorApprovalAuthority({ require_hds_execution_binding: true });
      const executor = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
        tools, approval_authority: authority });
      const observation = FileDeleteTargetVersionObservationSchema.parse(await executor.inspectCommandTargetVersion(
        selected.command, { BLUE_TANUKI_FILE_ROOT: workspace }, planBindingDigest));
      expect(observation).toMatchObject({ operation_plan_binding_digest: planBindingDigest, target_state: "present",
        used_for_authority: false, may_execute: false });
      expect(JSON.stringify(observation)).not.toContain("notes.txt");
      expect(JSON.stringify(observation)).not.toContain("synthetic delete target");
      expect(() => hds.createExecutionAuthorityBinding(selected.command!, { ...observation, target_identity_digest: "f".repeat(64) }))
        .toThrow(/file.delete target version does not match/);
      const binding = hds.createExecutionAuthorityBinding(selected.command, observation);
      expect(binding.broker_target_version_observation_digest).toBe(operationPlanDigest(observation));
      expect(hds.beginOperationPlanAttempt(selected.command)).toBe(true);
      const approval = evaluateApproval(selected.command, [], { actor: "fixture-owner", default_mode: "full_access" });
      expect(approval).toMatchObject({ decision: "ask", risk: "high", approval_level: "L3_final_review", final_review_required: true });
      const proof = { source: "human_final_review" as const, decision: "approve" as const, approved_by: "fixture-owner",
        approved_at_ms: Date.now(), upstream_commit_hash: selected.command.upstream_decision.commit_hash,
        operation: approval.context.operation, risk: approval.risk, final_review_required: approval.final_review_required,
        reason: "synthetic exact-target final review fixture" };
      const approved = authority.approve(selected.command, proof, executorCommandDigest(selected.command), binding, observation);
      const feedback = await executor.execute(approved);
      expect(feedback.status).toBe("success");
      expect(feedback.result).toEqual({ deleted: true });
      await expect(readFile(join(workspace, "notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      finalizeCommandOutput({ hds, command: selected.command, feedback,
        request_id: selected.command.upstream_decision.request_id ?? null, target_surface: "channel" });
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("verified");
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      hds.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    }
  });

  it("実file.search結果を依存入力にし、変更pendingだけ失効して旧版と試行済みを保持", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-")); const workspace = join(root, "workspace");
    await mkdir(workspace); await writeFile(join(workspace, "blue.txt"), "blue\n");
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store });
      const origin = request("plan:compute 青という語を探して、その検索結果をもう一度照合");
      const candidate = plan(origin.id, workspace); const exec = rig(hds, candidate);
      const initial = hds.decide(origin); expect(initial.command?.type).toBe("llm_call");
      await exec.run(initial.command!);
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
      expect(review(hds, candidate, "dependent").command).toBeNull();
      const first = review(hds, candidate, "search").command!;
      const feedback = await exec.run(first);
      expect(feedback.operation_core_result?.plan_step_binding).toBe("unbound");
      expect(hds.beginOperationPlanAttempt(first)).toBe(false);
      expect(review(hds, candidate, "search").command).toBeNull();
      const dependent = review(hds, candidate, "dependent").command!;
      const independent = review(hds, candidate, "independent").command!;
      expect(dependent.type).toBe("tool_call");
      if (dependent.type !== "tool_call") throw new Error("missing tool");
      expect(independent.type).toBe("tool_call");
      if (independent.type !== "tool_call") throw new Error("missing independent tool");
      expect(dependent.payload.arguments.query).toBe("blue");
      const dependentSourceDigest = hds.getExecutionOperationPlanBindingDigest(dependent);
      const independentSourceDigest = hds.getExecutionOperationPlanBindingDigest(independent);
      expect(dependentSourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(independentSourceDigest).toMatch(/^[a-f0-9]{64}$/);
      const taskIdentityDigest = hds.getExecutionOperationPlanTaskIdentityDigest(dependent);
      expect(taskIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
      const next = structuredClone(candidate); next.steps[2]!.parameters!.max_results = 2;
      const before = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
      const revised = hds.decide(request(`plan:revise ${JSON.stringify({ plan_id: candidate.plan_id,
        expected_revision_digest: before.revision_digest, plan: next })}`));
      expect(revised.command?.type).toBe("noop");
      expect((await exec.run(revised.command!)).status).toBe("success");
      expect(hds.operationPlanCommandIsCurrent(independent)).toBe(false);
      expect(() => hds.getExecutionOperationPlanBindingDigest(independent)).toThrow("plan_execution_source_binding_stale");
      expect(hds.operationPlanCommandIsCurrent(dependent)).toBe(true);
      expect(hds.getExecutionOperationPlanBindingDigest(dependent)).toBe(dependentSourceDigest);
      expect(hds.getExecutionOperationPlanTaskIdentityDigest(dependent)).toBe(taskIdentityDigest);
      const searchTools = new ToolRegistry(); searchTools.register(fileSearchTool);
      const targetResolver = new Executor({ llm: { name: "fixture", call: async () => ({ content: "", model: "fixture", tokens_used: 0 }) },
        tools: searchTools, approval_authority: createExecutorApprovalAuthority() });
      const targetObservation = await targetResolver.inspectCommandTargetVersion(dependent,
        { BLUE_TANUKI_FILE_ROOT: workspace }, dependentSourceDigest);
      if (!targetObservation) throw new Error("unchanged dependent step target resolver returned no observation after revision");
      expect(targetObservation).toMatchObject({ operation_plan_binding_digest: dependentSourceDigest,
        used_for_authority: false, may_execute: false });
      expect(hds.createExecutionAuthorityBinding(dependent, targetObservation)).toMatchObject({
        operation_plan_binding_digest: dependentSourceDigest,
        broker_target_version_observation_digest: operationPlanDigest(targetObservation),
      });
      expect(hds.beginOperationPlanAttempt(independent)).toBe(false);
      const revisedIndependent = review(hds, next, "independent").command;
      expect(revisedIndependent?.type).toBe("tool_call");
      if (revisedIndependent?.type !== "tool_call") throw new Error("revised pending step was not re-reviewed");
      expect(revisedIndependent.payload.arguments.max_results).toBe(2);
      expect(hds.operationPlanCommandIsCurrent(revisedIndependent)).toBe(true);
      expect(hds.getExecutionOperationPlanBindingDigest(revisedIndependent)).not.toBe(independentSourceDigest);
      await exec.run(revisedIndependent);
      await exec.run(dependent);
      const snapshot = hds.getRuntimeSnapshot().operation_plans;
      expect(snapshot.plans[0]?.revision).toBe(2);
      expect(snapshot.plans[0]?.previous_revision_digests).toEqual([operationPlanDigest(candidate)]);
      expect(snapshot.plans[0]?.steps[0]?.status).toBe("verified");
      expect(snapshot.plans[0]?.steps[1]?.status).toBe("verified");
      expect(snapshot.plans[0]?.steps[2]?.status).toBe("verified");
      expect(JSON.stringify(snapshot)).not.toContain(workspace);
      expect(JSON.stringify(snapshot)).not.toContain('"goal"');
      expect(hds.getAudit().verify()).toBe(true);
      const restarted = new HDSUpperController({ operation_plan_state: store });
      expect(review(restarted, next, "search").command).toBeNull();
      const forbidden = structuredClone(next); forbidden.steps[0]!.parameters!.query = "changed";
      expect(restarted.decide(request(`plan:revise ${JSON.stringify({ plan_id: next.plan_id,
        expected_revision_digest: operationPlanDigest(next), plan: forbidden })}`)).command).toBeNull();
    } finally { store.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("壊れたcontrol・外部metadata・別接続の選択をC/作用へfallbackさせない", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture"); const candidate = plan(origin.id, "synthetic-root");
    const exec = rig(hds, candidate); await exec.run(hds.decide(origin).command!);
    for (const content of ["plan:review {", "plan:unknown {}", "plan:", "plan:revise {}", "PLAN:REVIEW {}"]) {
      expect(hds.decide(request(content)).command).toBeNull();
    }
    const content = `plan:review ${JSON.stringify({ plan_id: candidate.plan_id, revision_digest: operationPlanDigest(candidate), step_id: "search" })}`;
    const external = { ...request(content), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } };
    expect(hds.decide(external).command).toBeNull();
    expect(hds.decide(request(content, "other-user")).command).toBeNull();
    const forged = structuredClone(candidate); forged.steps[0]!.state = "succeeded";
    const unknownOrigin = request("plan:compute unknown"); const wrong = rig(hds, forged);
    await wrong.run(hds.decide(unknownOrigin).command!);
    expect(hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
  });

  it("永続waitを再起動後に正規返信から一度だけCへつなぎ、期限eventも再利用しない", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-wait-resume-"));
    const databasePath = join(root, "state.sqlite");
    const goal = "Wait for the owner reply before generating the next plan candidate";
    const seed = plan(randomUUID(), "synthetic-root");
    const seedCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal,
        revisions: [{ digest: operationPlanDigest(seed), plan: seed }], receipt_observations: [], bindings: [], results: [] }],
    });
    let store = new OperationPlanStateStore(databasePath);
    let hds = new HDSUpperController({ operation_plan_state: store });
    try {
      store.compareAndSet(null, seedCheckpoint);
      hds.close();
      store.close();

      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });
      const deadlineAt = Date.now() + 60_000;
      const register = hds.decide(request(`plan:wait ${JSON.stringify({ plan_id: seed.plan_id,
        revision_digest: operationPlanDigest(seed), deadline_at_ms: deadlineAt })}`));
      expect(register.command?.type).toBe("noop");
      const wait = hds.listOperationPlanWaits()[0];
      expect(wait).toMatchObject({ state: "waiting", deadline_at_ms: deadlineAt,
        used_for_authority: false, may_execute: false });

      const persisted = store.load();
      expect(persisted?.waits?.[0]?.wait_id).toBe(wait?.wait_id);
      hds.close();
      store.close();
      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });

      const reply = request("The owner supplied the awaited synthetic detail");
      const resumed = hds.decide(reply);
      expect(resumed.command?.type).toBe("llm_call");
      expect(resumed.command?.type === "llm_call" && resumed.command.payload.compute_context?.local_p_version)
        .toBe("blue-tanuki.plan-compute-purpose-relation.v1");
      expect(hds.listOperationPlanWaits()[0]).toMatchObject({ state: "resumed", wake_reason: "reply" });

      const next = plan(reply.id, "synthetic-root");
      hds.onFeedback({ command_id: resumed.command!.id, status: "success",
        result: { operation_core: { status: "valid_plan", plan: next } }, metrics: { duration_ms: 1 } });
      expect(store.load()?.plans.find((candidate) => candidate.revisions[0]?.plan.plan_id === next.plan_id)
        ?.task_identity_digest).toBe(wait?.task_identity_digest);
      const replyWait = hds.listOperationPlanWaits().find((candidate) => candidate.wait_id === wait?.wait_id);
      expect(replyWait).toMatchObject({ state: "resumed", compute_outcome: "candidate_retained",
        candidate_plan_id_digest: operationPlanDigest(next.plan_id), used_for_authority: false, may_execute: false });
      expect(replyWait?.compute_result_digest).toMatch(/^[a-f0-9]{64}$/);
      const ownerProjection = projectOperationPlanStatus(hds.getRuntimeSnapshot().operation_plans);
      expect(ownerProjection.status).toBe("available");
      expect(ownerProjection.waits).toMatchObject([{ compute_outcome: "candidate_retained",
        candidate_plan_id: operationPlanDigest(next.plan_id), used_for_authority: false, may_execute: false }]);
      expect(JSON.stringify(ownerProjection)).not.toContain(goal);

      const secondDeadlineAt = Date.now() + 60_000;
      const secondWaitRegistration = hds.decide(request(`plan:wait ${JSON.stringify({ plan_id: next.plan_id,
        revision_digest: operationPlanDigest(next), deadline_at_ms: secondDeadlineAt })}`));
      expect(secondWaitRegistration.command?.type).toBe("noop");
      const deadlineWait = hds.listOperationPlanWaits().find((candidate) => candidate.state === "waiting");
      expect(deadlineWait).toBeDefined();
      const duplicateDeadline = createGatewayInternalInboundRequest({
        id: `plan-wait-deadline-${deadlineWait!.wait_id}`, channel: "webchat", user: "fixture-owner",
        content: "Persistent operation-plan wait deadline event", timestamp: Date.now(),
        metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "system",
          "blue_tanuki.trust_level": "trusted", "blue_tanuki.process_kind": "cron",
          "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_plan.wait_deadline_id": deadlineWait!.wait_id },
      });
      const deadlineClock = vi.spyOn(Date, "now").mockReturnValue(secondDeadlineAt);
      let deadlineResume: ReturnType<typeof hds.decide>;
      try {
        deadlineResume = hds.decide(duplicateDeadline);
        expect(deadlineResume.command?.type).toBe("llm_call");
        expect(hds.listOperationPlanWaits().find((candidate) => candidate.wait_id === deadlineWait!.wait_id))
          .toMatchObject({ state: "resumed", wake_reason: "deadline" });
        hds.onFeedback({ command_id: deadlineResume.command!.id, status: "failed",
          error: "synthetic planner failure", compute_resource_use: {
            schema_version: "blue-tanuki.compute-resource-use.v1",
            request_digest: createHash("sha256").update("blue-tanuki.compute-resource-use.request.v1\0")
              .update(deadlineResume.command!.id).digest("hex"),
            charged_compute_ms: 2_000, charged_tokens: 128, tokens_usage_status: "unknown",
            cost_status: "unknown", charged_cost_amount: 0.25, currency: "USD",
            charge_basis: "reserved_upper_bound", used_for_authority: false, may_execute: false,
          }, metrics: { duration_ms: 1 } });
      } finally { deadlineClock.mockRestore(); }
      expect(hds.listOperationPlanWaits().find((candidate) => candidate.wait_id === deadlineWait!.wait_id))
        .toMatchObject({ state: "resumed", compute_outcome: "failed", used_for_authority: false, may_execute: false,
          compute_resource_use: { charged_compute_ms: 2_000, charged_tokens: 128,
            charged_cost_amount: 0.25, charge_basis: "reserved_upper_bound" } });
      expect(store.load()?.waits?.find((candidate) => candidate.wait_id === deadlineWait!.wait_id)?.compute_resource_use)
        .toMatchObject({ request_digest: createHash("sha256").update("blue-tanuki.compute-resource-use.request.v1\0")
          .update(deadlineResume.command!.id).digest("hex"), used_for_authority: false, may_execute: false });
      const noProgressProjection = projectOperationPlanStatus(hds.getRuntimeSnapshot().operation_plans);
      expect(noProgressProjection.waits.find((candidate) => candidate.wait_id === deadlineWait!.wait_id))
        .toMatchObject({ resource_review_required: true, compute_resource_use: {
          charged_compute_ms: 2_000, charged_tokens: 128, cost_status: "unknown", currency: "USD",
          used_for_authority: false, may_execute: false,
        } });
      const nextReview = review(hds, next, "search");
      expect(nextReview.log.frame.goal).toContain("資源消費記録");
      expect(nextReview.log.frame.goal).toContain("charged_compute_ms");
      expect(nextReview.command?.type).toBe("tool_call");
      expect(hds.getAudit().verify()).toBe(true);
      expect(hds.decide(duplicateDeadline).command).toBeNull();
    } finally {
      hds.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("再起動後に結果未記録waitを中断へ分類し、ownerの新しい返信でのみC計算を再開する", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-wait-interrupted-"));
    const databasePath = join(root, "state.sqlite");
    const goal = "Wait for an owner reply and compute a candidate without granting authority";
    const seed = plan(randomUUID(), "synthetic-root");
    const seedCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal,
        revisions: [{ digest: operationPlanDigest(seed), plan: seed }], receipt_observations: [], bindings: [], results: [] }],
    });
    let store = new OperationPlanStateStore(databasePath);
    let hds = new HDSUpperController({ operation_plan_state: store });
    const previousReply = "PRIVATE PRE-RESTART REPLY MUST NOT BE SAVED";
    try {
      store.compareAndSet(null, seedCheckpoint);
      hds.close();
      store.close();
      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });
      const deadlineAt = Date.now() + 60_000;
      expect(hds.decide(request(`plan:wait ${JSON.stringify({ plan_id: seed.plan_id,
        revision_digest: operationPlanDigest(seed), deadline_at_ms: deadlineAt })}`)).command?.type).toBe("noop");
      const wait = hds.listOperationPlanWaits()[0]!;
      const firstCompute = hds.decide(request(previousReply));
      expect(firstCompute.command?.type).toBe("llm_call");
      expect(hds.listOperationPlanWaits().find((entry) => entry.wait_id === wait.wait_id))
        .toMatchObject({ state: "resumed", compute_outcome: "pending" });
      hds.close();
      store.close();

      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });
      expect(hds.reconcileOperationPlanWaitComputations()).toEqual({ candidate_reconciled: 0, interrupted: 1 });
      const interrupted = store.load()?.waits?.find((entry) => entry.wait_id === wait.wait_id);
      expect(interrupted).toMatchObject({ state: "resumed", compute_outcome: "interrupted",
        wake_reason: "reply", used_for_authority: false, may_execute: false });
      expect(JSON.stringify(store.load())).not.toContain(previousReply);

      const newReply = "NEW OWNER RESPONSE AFTER RESTART";
      const resumeControl = `plan:resume_wait ${JSON.stringify({ wait_id: wait.wait_id, response: newReply })}`;
      const wrongOwner = hds.decide(request(resumeControl, "different-user"));
      expect(wrongOwner.command).toBeNull();
      expect(wrongOwner.log.frame.goal).not.toContain(newReply);
      expect(JSON.stringify(hds.getAudit().list())).not.toContain(newReply);
      expect(hds.listOperationPlanWaits().find((entry) => entry.wait_id === wait.wait_id))
        .toMatchObject({ compute_outcome: "interrupted" });
      const resumeRequest = request(resumeControl);
      const resumed = hds.decide(resumeRequest);
      expect(resumed.command?.type).toBe("llm_call");
      expect(JSON.stringify(resumed.command?.payload)).toContain(newReply);
      expect(JSON.stringify(resumed.command?.payload)).not.toContain(previousReply);
      expect(store.load()?.waits?.find((entry) => entry.wait_id === wait.wait_id))
        .toMatchObject({ state: "resumed", wake_reason: "recovery", compute_outcome: "pending",
          used_for_authority: false, may_execute: false });

      const next = plan(resumeRequest.id, "synthetic-root");
      hds.onFeedback({ command_id: resumed.command!.id, status: "success",
        result: { operation_core: { status: "valid_plan", plan: next } }, metrics: { duration_ms: 1 } });
      expect(hds.listOperationPlanWaits().find((entry) => entry.wait_id === wait.wait_id))
        .toMatchObject({ compute_outcome: "candidate_retained", candidate_plan_id_digest: operationPlanDigest(next.plan_id),
          used_for_authority: false, may_execute: false });
      expect(JSON.stringify(store.load())).not.toContain(newReply);
      expect(JSON.stringify(hds.getAudit().list())).not.toContain(newReply);
      expect(JSON.stringify(hds.getRuntimeSnapshot().operation_plans)).not.toContain(newReply);
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      hds.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("起動時に保存済みの同一候補だけをwait結果へ結び直す", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-wait-candidate-reconcile-"));
    const databasePath = join(root, "state.sqlite");
    const goal = "Retain the exact candidate if its checkpoint completed before the wait receipt";
    const seed = plan(randomUUID(), "synthetic-root");
    const seedCheckpoint = OperationPlanCheckpointSchema.parse({
      schema_version: "operation-plan-state.v1",
      plans: [{ owner: "fixture-owner", channel: "webchat", goal,
        revisions: [{ digest: operationPlanDigest(seed), plan: seed }], receipt_observations: [], bindings: [], results: [] }],
    });
    let store = new OperationPlanStateStore(databasePath);
    let hds = new HDSUpperController({ operation_plan_state: store });
    try {
      store.compareAndSet(null, seedCheckpoint);
      hds.close();
      store.close();
      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });
      const deadlineAt = Date.now() + 60_000;
      hds.decide(request(`plan:wait ${JSON.stringify({ plan_id: seed.plan_id,
        revision_digest: operationPlanDigest(seed), deadline_at_ms: deadlineAt })}`));
      const wait = hds.listOperationPlanWaits()[0]!;
      const reply = request("synthetic owner reply for exact candidate recovery");
      const firstCompute = hds.decide(reply);
      const candidate = plan(reply.id, "synthetic-root");
      hds.onFeedback({ command_id: firstCompute.command!.id, status: "success",
        result: { operation_core: { status: "valid_plan", plan: candidate } }, metrics: { duration_ms: 1 } });
      const retained = store.load()!;
      const waitPending = structuredClone(retained);
      const pendingWait = waitPending.waits!.find((entry) => entry.wait_id === wait.wait_id)!;
      pendingWait.compute_outcome = "pending";
      delete pendingWait.compute_result_digest;
      delete pendingWait.candidate_plan_id_digest;
      delete pendingWait.compute_completed_at_ms;
      delete pendingWait.compute_resource_use;
      store.compareAndSet(operationPlanDigest(retained), waitPending);
      hds.close();
      store.close();

      store = new OperationPlanStateStore(databasePath);
      hds = new HDSUpperController({ operation_plan_state: store });
      expect(hds.reconcileOperationPlanWaitComputations()).toEqual({ candidate_reconciled: 1, interrupted: 0 });
      expect(hds.listOperationPlanWaits().find((entry) => entry.wait_id === wait.wait_id))
        .toMatchObject({ compute_outcome: "candidate_retained", candidate_plan_id_digest: operationPlanDigest(candidate.plan_id),
          used_for_authority: false, may_execute: false });
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(2);
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      hds.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SUSPENDした計画選択はresumeで未結合commandへ変わらない", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture"); const candidate = plan(origin.id, "synthetic-root");
    candidate.steps[0]!.parameters!.query = "rm -rf foo";
    const exec = rig(hds, candidate); await exec.run(hds.decide(origin).command!);
    const selection = review(hds, candidate, "search");
    expect(selection.log.commit.decision).toBe("SUSPEND");
    expect(hds.resume(selection.log.request_id, "approve").command).toBeNull();
    expect(hds.listSuspended().find((entry) => entry.request_id === selection.log.request_id)?.resume_allowed).toBe(false);
  });

  it("失敗・期限失効を依存の成功にせず、provider識別子を射影へ出さない", async () => {
    const hds = new HDSUpperController(); const origin = request("plan:compute fixture"); const candidate = plan(origin.id, "synthetic-root");
    candidate.plan_id = "private-provider-plan-body"; candidate.steps[2]!.step_id = "private-provider-step-body";
    const failing = { ...fileSearchTool, invoke: async () => { throw new Error("fixture failure"); } };
    const exec = rig(hds, candidate, failing); await exec.run(hds.decide(origin).command!);
    const failed = review(hds, candidate, "search").command!; await exec.run(failed);
    expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
    expect(review(hds, candidate, "search").command).toBeNull();
    expect(review(hds, candidate, "dependent").command).toBeNull();
    expect(JSON.stringify(hds.getRuntimeSnapshot().operation_plans)).not.toContain("private-provider");
    const origin2 = request("plan:compute freshness"); const fresh = plan(origin2.id, "synthetic-root");
    const success = { ...fileSearchTool, invoke: async () => (fresh.steps[0]!.preparation!.validation[0]!.expected) };
    const exec2 = rig(hds, fresh, success); await exec2.run(hds.decide(origin2).command!);
    await exec2.run(review(hds, fresh, "search").command!);
    const pending = review(hds, fresh, "dependent").command!;
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
    try { expect(hds.beginOperationPlanAttempt(pending)).toBe(false); }
    finally { clock.mockRestore(); }
  });

  it("内容差替え・crash窓・別writerを実行前に遮断", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-plan-fence-")); const store = new OperationPlanStateStore(join(root, "state.sqlite"));
    try {
      const hds = new HDSUpperController({ operation_plan_state: store }); const origin = request("plan:compute fixture");
      const candidate = plan(origin.id, root); const exec = rig(hds, candidate);
      await exec.run(hds.decide(origin).command!);
      const selected = review(hds, candidate, "search").command!;
      if (selected.type !== "tool_call") throw new Error("missing tool");
      const originalId = selected.id; selected.id = "changed-id";
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      selected.id = originalId;
      selected.payload.arguments.query = "substituted";
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      selected.payload.arguments.query = "blue";
      const timeout = selected.constraints?.timeout_ms;
      selected.constraints = { ...selected.constraints, timeout_ms: 999_999 };
      expect(hds.beginOperationPlanAttempt(selected)).toBe(false);
      selected.constraints = { ...selected.constraints, timeout_ms: timeout };
      Object.freeze(selected.payload);
      expect(hds.beginOperationPlanAttempt(selected)).toBe(true);
      expect(() => { selected.payload.arguments.query = "after-begin"; }).toThrow();
      const restarted = new HDSUpperController({ operation_plan_state: store });
      expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
      expect(review(restarted, candidate, "search").command).toBeNull();
      const pending = review(restarted, candidate, "independent").command!;
      const staleWriter = new HDSUpperController({ operation_plan_state: store });
      expect(restarted.operationPlanCommandIsCurrent(pending)).toBe(true);
      expect(() => restarted.beginOperationPlanAttempt(pending)).toThrow("plan_checkpoint_concurrent_update");
      expect(staleWriter.getRuntimeSnapshot().operation_plans.plans[0]?.steps[2]?.status).toBe("invalidated");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
