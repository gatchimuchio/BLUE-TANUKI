import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, HDSUpperController, operationPlanDigest, type OperationPlanStatePort } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, FileSearchTargetVersionObservationSchema, OperationPlanCheckpointSchema,
  type FileSearchTargetVersionObservation, type GoalGovernanceConfig } from "@blue-tanuki/protocol";
import type { ExecutionIntentStore, ExecutionIntentTicket } from "../src/execution_intent.js";
import { createExecutorApprovalAuthority, executorCommandDigest, type ExecutorApprovalProof } from "../src/executor.js";

function issuedCommand(id: string, goal_governance?: GoalGovernanceConfig) {
  const hds = new HDSUpperController(goal_governance ? { goal_governance } : {});
  const result = hds.decide({ id, channel: "webchat", user: "fixture-owner", content: "hello world", timestamp: 1 });
  if (!result.command || result.log.commit.decision !== "ASSERT") throw new Error("fixture HDS did not issue an ASSERT command");
  return { hds, command: result.command, log: result.log };
}

function goalGovernanceConfig(purposeDigest = "a".repeat(64)): GoalGovernanceConfig {
  return {
    schema_version: "blue-tanuki.goal-governance.v1",
    goals: [{
      goal_ref: "goal_0000000000000001",
      goal_kind: "delegated",
      source_ref: "F:0000000000000001",
      initial_purpose_digest: purposeDigest,
      initial_interpretation_digest: "b".repeat(64),
      adopted_at: 1,
    }],
    authorizations: [],
    events: [],
  };
}

function issuedPlanCommand() {
  const plan = {
    version: "operation-core.v1" as const,
    plan_id: "fixture-plan-id",
    request_id: "fixture-plan-request",
    state: "planned" as const,
    steps: [{
      step_id: "fixture-search-step",
      operation: "file.search",
      target: { kind: "directory" as const, id: "C:\\blue-tanuki-fixture" },
      state: "planned" as const,
      effects: ["read" as const],
      permission: { risk: "low" as const, approval_level: "L1_observe" as const, final_review_required: false,
        hds_brain_authority_required: true as const, approval_gate_required: true },
      adapter: "internal_runtime" as const,
      adapter_is_authority: false as const,
      command_generated_by_adapter_only: false,
      parameters: { root: "C:\\blue-tanuki-fixture", query: "fixture query", max_results: 1 },
      preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{
        check_id: "fixture-search-result",
        method: "result_equals" as const,
        target: { kind: "directory" as const, id: "C:\\blue-tanuki-fixture" },
        expected: { count: 0 },
      }], compensation: { available: false as const, reason: "read-only fixture" } },
    }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false as const, command_generation_location: "not_applicable" as const },
    planner_output_used_for_authority: false as const,
    hds_brain_authority_required: true as const,
  };
  const planDigest = operationPlanDigest(plan);
  let checkpoint = OperationPlanCheckpointSchema.parse({ schema_version: "operation-plan-state.v1", plans: [{
    owner: "fixture-owner",
    channel: "webchat",
    goal: "Find the fixture line for the delegated test request.",
    request_goal_criteria: {
      status: "not_provided",
      request_id: plan.request_id,
      content_sha256: createHash("sha256").update("Find the fixture line for the delegated test request.", "utf8").digest("hex"),
      criteria: [],
      used_for_authority: false,
    },
    revisions: [{ digest: planDigest, plan }],
    receipt_observations: [],
    bindings: [],
    results: [],
  }] });
  let savedDigest: string | null = operationPlanDigest(checkpoint);
  const statePort: OperationPlanStatePort = {
    load: () => checkpoint,
    compareAndSet(expectedDigest, next) {
      if (expectedDigest !== savedDigest) throw new Error("fixture operation-plan revision changed");
      checkpoint = OperationPlanCheckpointSchema.parse(next);
      savedDigest = operationPlanDigest(checkpoint);
    },
    loadRecoveryHoldState: () => null,
    compareAndSetRecoveryHoldState() { throw new Error("not used by source-binding fixture"); },
  };
  const hds = new HDSUpperController({ operation_plan_state: statePort });
  const request = createGatewayInternalInboundRequest({
    id: "fixture-plan-review-request",
    channel: "webchat",
    user: "fixture-owner",
    content: `plan:review ${JSON.stringify({ plan_id: plan.plan_id, revision_digest: planDigest, step_id: "fixture-search-step" })}`,
    timestamp: 1,
    metadata: { "blue_tanuki.operator_surface": "developer" },
  });
  const result = hds.decide(request);
  if (!result.command || result.log.commit.decision !== "ASSERT") {
    throw new Error(`fixture HDS did not issue a selected plan command: ${result.log.commit.reason}`);
  }
  const revisePlan = (): void => {
    const revisedPlan = structuredClone(plan);
    revisedPlan.steps[0]!.parameters!.query = "changed fixture query";
    const revised = createGatewayInternalInboundRequest({
      id: "fixture-plan-revision-request",
      channel: "webchat",
      user: "fixture-owner",
      content: `plan:revise ${JSON.stringify({ plan_id: plan.plan_id, expected_revision_digest: planDigest, plan: revisedPlan })}`,
      timestamp: 2,
      metadata: { "blue_tanuki.operator_surface": "developer" },
    });
    hds.decide(revised);
  };
  return { hds, command: result.command, goal: checkpoint.plans[0]!.goal, target: plan.steps[0]!.target.id, revisePlan };
}

function proofFor(command: ReturnType<typeof issuedCommand>["command"]): ExecutorApprovalProof {
  const context = approvalContextFromCommand(command, { actor: "fixture-owner" });
  return {
    source: "approval_gate",
    decision: "allow",
    approved_by: "fixture-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: context.operation,
    risk: context.risk,
    final_review_required: context.risk === "high",
    reason: "synthetic approval fixture",
  };
}

function targetVersionFor(command: ReturnType<typeof issuedCommand>["command"], operationPlanBindingDigest?: string): FileSearchTargetVersionObservation {
  if (command.type !== "tool_call" || command.payload.tool_name !== "file.search") throw new Error("fixture is not file.search");
  const requestedRoot = command.payload.arguments.root;
  if (typeof requestedRoot !== "string") throw new Error("fixture root is missing");
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  return FileSearchTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.file-search-target-version.v1",
    requested_root_digest: digest(requestedRoot),
    canonical_root_digest: digest("C:\\blue-tanuki-fixture"),
    resource_version_digest: digest("fixture-resource-version"),
    ...(operationPlanBindingDigest ? { operation_plan_binding_digest: operationPlanBindingDigest } : {}),
    files_examined: 1,
    used_for_authority: false,
    may_execute: false,
  });
}

function recordingIntentStore(tickets: ExecutionIntentTicket[]): ExecutionIntentStore {
  return {
    issue(ticket) { tickets.push({ ...ticket }); },
    consume() { throw new Error("not used by approval-only fixture"); },
    markInvocation() { throw new Error("not used by approval-only fixture"); },
    complete() { throw new Error("not used by approval-only fixture"); },
    lookup() { return null; },
  };
}

describe("HDSからExecutorへの非直列化source binding", () => {
  it("正確なHDS発行commandのsource digestをcanonical command/proofと同じticketへ結合する", () => {
    const { hds, command, log } = issuedCommand("source-binding-1", goalGovernanceConfig());
    const binding = hds.createExecutionAuthorityBinding(command);
    const digest = executorCommandDigest(command);
    const tickets: ExecutionIntentTicket[] = [];
    const authority = createExecutorApprovalAuthority({
      execution_store: recordingIntentStore(tickets),
      require_hds_execution_binding: true,
    });
    const proof = proofFor(command);

    expect(binding.goal_governance_projection_digest).toBe(operationPlanDigest(log.frame.goal_governance));
    expect(binding.goal_governance_used_for_authority).toBe(false);
    expect(Object.keys(binding).sort()).toEqual([
      "goal_governance_projection_digest", "goal_governance_used_for_authority", "schema_version", "source_context_digest",
    ]);
    expect(JSON.stringify(binding)).not.toContain("fixture-owner");
    expect(JSON.stringify(binding)).not.toContain("hello world");
    expect(() => authority.approve(command, proof, digest)).toThrow(/binding is required/);

    authority.approve(command, proof, digest, binding);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.command_digest).toBe(digest);
    expect(tickets[0]!.proof_digest).toBe(createHash("sha256").update(JSON.stringify({
      schema_version: "blue-tanuki.executor-authority-content-binding.v4",
      command_digest: digest,
      proof,
      hds_source_context_digest: binding.source_context_digest,
    })).digest("hex"));
    expect(() => authority.approve(command, proof, digest, binding)).toThrow(/already consumed/);
  });

  it("copyしたcommandや直列化したsealは発行元のHDS tokenとして使えない", () => {
    const { hds, command } = issuedCommand("source-binding-2");
    const binding = hds.createExecutionAuthorityBinding(command);
    const tickets: ExecutionIntentTicket[] = [];
    const authority = createExecutorApprovalAuthority({
      execution_store: recordingIntentStore(tickets),
      require_hds_execution_binding: true,
    });
    const proof = proofFor(command);
    const copiedCommand = structuredClone(command);
    const copiedBinding = JSON.parse(JSON.stringify(binding)) as typeof binding;

    expect(() => hds.createExecutionAuthorityBinding(copiedCommand)).toThrow(/source is unavailable/);
    expect(() => authority.approve(copiedCommand, proof, executorCommandDigest(copiedCommand), binding)).toThrow(/binding is invalid/);
    expect(() => authority.approve(command, proof, executorCommandDigest(command), copiedBinding)).toThrow(/binding is invalid/);
    expect(tickets).toHaveLength(0);

    authority.approve(command, proof, executorCommandDigest(command), binding);
    expect(tickets).toHaveLength(1);
  });

  it("purpose versionの再構成が変わるとHDS source sealとExecutor ticket proofも変わる", () => {
    const first = issuedCommand("source-binding-purpose-1", goalGovernanceConfig("a".repeat(64)));
    const second = issuedCommand("source-binding-purpose-2", goalGovernanceConfig("c".repeat(64)));
    const firstBinding = first.hds.createExecutionAuthorityBinding(first.command);
    const secondBinding = second.hds.createExecutionAuthorityBinding(second.command);
    expect(firstBinding.goal_governance_projection_digest)
      .toBe(operationPlanDigest(first.log.frame.goal_governance));
    expect(secondBinding.goal_governance_projection_digest)
      .toBe(operationPlanDigest(second.log.frame.goal_governance));
    expect(firstBinding.goal_governance_projection_digest).not.toBe(secondBinding.goal_governance_projection_digest);
    expect(firstBinding.source_context_digest).not.toBe(secondBinding.source_context_digest);

    const firstTickets: ExecutionIntentTicket[] = [];
    const secondTickets: ExecutionIntentTicket[] = [];
    const firstAuthority = createExecutorApprovalAuthority({ execution_store: recordingIntentStore(firstTickets), require_hds_execution_binding: true });
    const secondAuthority = createExecutorApprovalAuthority({ execution_store: recordingIntentStore(secondTickets), require_hds_execution_binding: true });
    firstAuthority.approve(first.command, proofFor(first.command), executorCommandDigest(first.command), firstBinding);
    secondAuthority.approve(second.command, proofFor(second.command), executorCommandDigest(second.command), secondBinding);
    expect(firstTickets[0]!.proof_digest).not.toBe(secondTickets[0]!.proof_digest);
  });

  it("J選択済みOperationPlanの改訂・step・target・引数bindingを同じExecutor ticketへ結合する", () => {
    const { hds, command, goal, target } = issuedPlanCommand();
    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
    if (!operationPlanBindingDigest) throw new Error("selected plan source binding was unavailable");
    const targetVersion = targetVersionFor(command, operationPlanBindingDigest);
    expect(() => hds.createExecutionAuthorityBinding(command)).toThrow(/file.search target version observation is required/);
    expect(() => hds.createExecutionAuthorityBinding(command, targetVersionFor(command)))
      .toThrow(/current Operation Plan source/);
    const binding = hds.createExecutionAuthorityBinding(command, targetVersion);
    expect(binding.operation_plan_binding_digest).toBe(operationPlanBindingDigest);
    expect(binding.task_identity_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.broker_target_version_observation_digest).toBe(operationPlanDigest(targetVersion));
    expect(JSON.stringify(binding)).not.toContain("fixture-owner");
    expect(JSON.stringify(binding)).not.toContain(goal);
    expect(JSON.stringify(binding)).not.toContain(target);

    const tickets: ExecutionIntentTicket[] = [];
    const authority = createExecutorApprovalAuthority({
      execution_store: recordingIntentStore(tickets),
      require_hds_execution_binding: true,
    });
    const proof = proofFor(command);
    const digest = executorCommandDigest(command);
    const changedTargetVersion = FileSearchTargetVersionObservationSchema.parse({ ...targetVersion,
      resource_version_digest: createHash("sha256").update("changed target version").digest("hex") });
    expect(() => authority.approve(command, proof, digest, binding, changedTargetVersion))
      .toThrow(/HDS target version binding does not match evidence/);
    authority.approve(command, proof, digest, binding, targetVersion);

    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.proof_digest).toBe(createHash("sha256").update(JSON.stringify({
      schema_version: "blue-tanuki.executor-authority-content-binding.v4",
      command_digest: digest,
      proof,
      hds_source_context_digest: binding.source_context_digest,
      task_identity_digest: binding.task_identity_digest,
      target_version_observation_digest: operationPlanDigest(targetVersion),
    })).digest("hex"));
  });

  it("plan改訂で失効した旧commandにはsource sealを発行しない", () => {
    const { hds, command, revisePlan } = issuedPlanCommand();
    revisePlan();
    expect(() => hds.createExecutionAuthorityBinding(command)).toThrow(/source is unavailable|no longer current/);
  });
});
