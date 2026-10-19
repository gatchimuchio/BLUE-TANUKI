import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteCommand, GoalGovernanceAuthorization, GoalGovernanceConfig, GoalGovernanceEvent } from "@blue-tanuki/protocol";
import { createGatewayInternalInboundRequest, GOAL_GOVERNANCE_SCHEMA_VERSION } from "@blue-tanuki/protocol";
import { evaluateApproval } from "../src/approval_policy.js";
import { AuditLog } from "../src/audit.js";
import { HDSUpperController } from "../src/controller.js";
import { GoalGovernanceLedger, goalGovernanceEventDigest, purposeVersionForEventTime } from "../src/goal_governance.js";
import { operationPlanDigest } from "../src/operation_plan.js";

const delegated = "goal_0000000000000001";
const operational = "goal_0000000000000002";
const subgoal = "goal_0000000000000003";
const digest = (character: string): string => character.repeat(64);

function createConfig(): GoalGovernanceConfig {
  const events: GoalGovernanceEvent[] = [
    {
      event_ref: "ge_0000000000000001",
      event_kind: "interpretation_correction",
      goal_ref: delegated,
      source_ref: "F:0000000000000001",
      goal_version: 1,
      prior_interpretation_digest: digest("b"),
      corrected_interpretation_digest: digest("c"),
      preserved_purpose_digest: digest("a"),
      authority_kind: "hds_j",
      authorization_ref: "ga_0000000000000001",
      recorded_at: 200,
      effective_from: 220,
    },
    {
      event_ref: "ge_0000000000000002",
      event_kind: "purpose_change",
      goal_ref: delegated,
      source_ref: "F:0000000000000001",
      goal_kind: "delegated",
      prior_version: 1,
      new_version: 2,
      prior_purpose_digest: digest("a"),
      new_purpose_digest: digest("3"),
      authority_kind: "owner",
      authorization_ref: "ga_0000000000000002",
      recorded_at: 230,
      effective_from: 250,
    },
    {
      event_ref: "ge_0000000000000003",
      event_kind: "purpose_change",
      goal_ref: operational,
      source_ref: "F:0000000000000002",
      goal_kind: "operational",
      prior_version: 1,
      new_version: 2,
      prior_purpose_digest: digest("d"),
      new_purpose_digest: digest("4"),
      authority_kind: "hds_j",
      parent_goal_version: 2,
      authorization_ref: "ga_0000000000000003",
      recorded_at: 230,
      effective_from: 260,
    },
    {
      event_ref: "ge_0000000000000004",
      event_kind: "purpose_change",
      goal_ref: subgoal,
      source_ref: "F:0000000000000003",
      goal_kind: "subgoal",
      prior_version: 1,
      new_version: 2,
      prior_purpose_digest: digest("f"),
      new_purpose_digest: digest("5"),
      authority_kind: "hds_j",
      parent_goal_version: 2,
      authorization_ref: "ga_0000000000000004",
      recorded_at: 230,
      effective_from: 270,
    },
  ];
  const authorizations = events.map((event) => ({
    authorization_ref: event.authorization_ref,
    event_ref: event.event_ref,
    event_digest: goalGovernanceEventDigest(event),
    goal_ref: event.goal_ref,
    event_kind: event.event_kind,
    authority_kind: event.authority_kind,
    authorized_at: event.recorded_at - 1,
  }));
  return {
    schema_version: GOAL_GOVERNANCE_SCHEMA_VERSION,
    goals: [
      {
        goal_ref: delegated,
        goal_kind: "delegated",
        source_ref: "F:0000000000000001",
        initial_purpose_digest: digest("a"),
        initial_interpretation_digest: digest("b"),
        adopted_at: 100,
      },
      {
        goal_ref: operational,
        goal_kind: "operational",
        source_ref: "F:0000000000000002",
        parent_goal_ref: delegated,
        parent_goal_version: 1,
        initial_purpose_digest: digest("d"),
        initial_interpretation_digest: digest("e"),
        adopted_at: 100,
      },
      {
        goal_ref: subgoal,
        goal_kind: "subgoal",
        source_ref: "F:0000000000000003",
        parent_goal_ref: operational,
        parent_goal_version: 1,
        initial_purpose_digest: digest("f"),
        initial_interpretation_digest: digest("6"),
        adopted_at: 100,
      },
    ],
    authorizations,
    events,
  };
}

const request = {
  id: "goal-governance-request",
  channel: "test",
  user: "owner",
  content: "Prepare a draft for review.",
  timestamp: 1_791_540_000_000,
};

describe("HDS goal governance consumer", () => {
  it("separates interpretation corrections from purpose changes and preserves effective versions", () => {
    const created = GoalGovernanceLedger.create(createConfig());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const beforeCorrection = created.ledger.project(219).goals.find((goal) => goal.goal_ref === delegated)!;
    expect(beforeCorrection.current_version).toBe(1);
    expect(beforeCorrection.current_interpretation_revision).toBe(1);

    const afterCorrection = created.ledger.project(249).goals.find((goal) => goal.goal_ref === delegated)!;
    expect(afterCorrection.current_version).toBe(1);
    expect(afterCorrection.current_purpose_digest).toBe(digest("a"));
    expect(afterCorrection.current_interpretation_revision).toBe(2);
    expect(afterCorrection.current_interpretation_digest).toBe(digest("c"));

    const afterPurposeChange = created.ledger.project(300).goals.find((goal) => goal.goal_ref === delegated)!;
    expect(afterPurposeChange.current_version).toBe(2);
    expect(afterPurposeChange.current_purpose_digest).toBe(digest("3"));
    expect(afterPurposeChange.purpose_versions.map((version) => version.version)).toEqual([1, 2]);
    expect(afterPurposeChange.current_interpretation_revision).toBe(0);
    expect(afterPurposeChange.current_interpretation_digest).toBeUndefined();
    expect(afterPurposeChange.interpretation_revisions.at(-1)).toMatchObject({ status: "unidentified", revision: 0 });
    const alignedOperational = created.ledger.project(300).goals.find((goal) => goal.goal_ref === operational)!;
    expect(alignedOperational.parent_alignment_status).toBe("aligned");
    expect(alignedOperational.parent_goal_version).toBe(2);
    expect(created.ledger.project(249).events.find((event) => event.event_ref === "ge_0000000000000002")?.status)
      .toBe("pending_effective");

    const delayedOldResult = purposeVersionForEventTime(created.ledger.project(300), delegated, 249);
    expect(delayedOldResult).toMatchObject({ version: 1, purpose_digest: digest("a") });
    const newResult = purposeVersionForEventTime(created.ledger.project(300), delegated, 250);
    expect(newResult).toMatchObject({ version: 2, purpose_digest: digest("3") });
  });

  it("rejects a delegated change without an exact owner authorization and rejects impersonation", () => {
    const config = createConfig();
    const unauthorized = {
      ...config,
      authorizations: config.authorizations.filter((authorization) => authorization.event_ref !== "ge_0000000000000002"),
    };
    const result = GoalGovernanceLedger.create(unauthorized);
    expect(result).toEqual({ ok: false, issue_codes: ["authorization_missing"] });
    expect(() => new HDSUpperController({ goal_governance: unauthorized as GoalGovernanceConfig }))
      .toThrow("invalid goal governance configuration");

    const impersonated = createConfig();
    const delegatedChange = impersonated.events[1]!;
    if (delegatedChange.event_kind !== "purpose_change") throw new Error("fixture event kind mismatch");
    const forged = { ...delegatedChange, authority_kind: "hds_j" as const };
    const forgedConfig = {
      ...impersonated,
      events: impersonated.events.map((event) => event.event_ref === forged.event_ref ? forged : event),
    };
    const forgedResult = GoalGovernanceLedger.create(forgedConfig);
    expect(forgedResult.ok).toBe(false);
    if (!forgedResult.ok) expect(forgedResult.issue_codes).toContain("unexpected_authority");
  });

  it("binds each authorization to its event digest and rejects changed or replayed events", () => {
    const config = createConfig();
    const altered = {
      ...config,
      events: config.events.map((event) => event.event_ref === "ge_0000000000000002" && event.event_kind === "purpose_change"
        ? { ...event, new_purpose_digest: digest("9") }
        : event),
    };
    const alteredResult = GoalGovernanceLedger.create(altered);
    expect(alteredResult.ok).toBe(false);
    if (!alteredResult.ok) expect(alteredResult.issue_codes).toContain("authorization_mismatch");

    const duplicate = {
      ...config,
      events: [...config.events, config.events[0]!],
    };
    const duplicateResult = GoalGovernanceLedger.create(duplicate);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.issue_codes).toContain("duplicate_event_ref");
  });

  it("rejects backdated application and a correction that points at the wrong prior interpretation", () => {
    const config = createConfig();
    const correction = config.events[0]!;
    if (correction.event_kind !== "interpretation_correction") throw new Error("fixture event kind mismatch");
    const backdatedCorrection = { ...correction, effective_from: 199 };
    const backdated = withEvent(config, backdatedCorrection);
    const backdatedResult = GoalGovernanceLedger.create(backdated);
    expect(backdatedResult.ok).toBe(false);
    if (!backdatedResult.ok) expect(backdatedResult.issue_codes).toContain("invalid_event_time");

    const mismatchedCorrection = { ...correction, prior_interpretation_digest: digest("8") };
    const mismatched = withEvent(config, mismatchedCorrection);
    const mismatchResult = GoalGovernanceLedger.create(mismatched);
    expect(mismatchResult.ok).toBe(false);
    if (!mismatchResult.ok) expect(mismatchResult.issue_codes).toContain("interpretation_transition_mismatch");
  });

  it("marks descendants for review when an ancestor purpose changes without rebinding them", () => {
    const config = createConfig();
    const parentOnly = {
      ...config,
      events: config.events.filter((event) => event.event_ref === "ge_0000000000000001" || event.event_ref === "ge_0000000000000002"),
      authorizations: config.authorizations.filter((authorization) => authorization.event_ref === "ge_0000000000000001" || authorization.event_ref === "ge_0000000000000002"),
    };
    const result = GoalGovernanceLedger.create(parentOnly);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projection = result.ledger.project(300);
    expect(projection.goals.find((goal) => goal.goal_ref === operational)?.parent_alignment_status).toBe("requires_review");
    expect(projection.goals.find((goal) => goal.goal_ref === subgoal)?.parent_alignment_status).toBe("requires_review");
  });

  it("attaches a frozen version projection to the actual decision/audit path without changing decisions", () => {
    const controller = new HDSUpperController({ goal_governance: createConfig() });
    const configured = controller.decide(request);
    const baseline = new HDSUpperController().decide(request);
    const projection = configured.log.frame.goal_governance;

    expect(projection).toBeDefined();
    expect(projection?.used_for_authority).toBe(false);
    expect(projection?.goals.find((goal) => goal.goal_ref === delegated)?.current_version).toBe(2);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.goals[0])).toBe(true);
    expect(configured.log.model).toEqual(baseline.log.model);
    expect(configured.log.commit.hash).toBe(baseline.log.commit.hash);
    expect(configured.command?.type ?? null).toBe(baseline.command?.type ?? null);
    expect(configured.command && { ...configured.command, id: "same" })
      .toEqual(baseline.command && { ...baseline.command, id: "same" });
    if (!configured.command) throw new Error("configured HDS decision did not issue a command");
    const binding = controller.createExecutionAuthorityBinding(configured.command);
    expect(binding.goal_governance_projection_digest).toBe(operationPlanDigest(projection));
    expect(binding.goal_governance_used_for_authority).toBe(false);
    expect(JSON.stringify(binding)).not.toContain(delegated);
    expect(JSON.stringify(controller.getAudit().list())).toContain("ge_0000000000000002");
    expect(controller.getAudit().verify()).toBe(true);
  });

  it("does not accept governance state from inbound metadata and omits it when unconfigured", () => {
    const forged = { ...createConfig(), schema_version: "SENTINEL_UNTRUSTED_GOVERNANCE" };
    const withoutConfiguration = new HDSUpperController().decide({
      ...request,
      metadata: { "untrusted.goal_governance": forged },
    });
    const configured = new HDSUpperController({ goal_governance: createConfig() }).decide({
      ...request,
      metadata: { "untrusted.goal_governance": forged },
    });
    expect(withoutConfiguration.log.frame.goal_governance).toBeUndefined();
    expect(configured.log.frame.goal_governance?.goals.find((goal) => goal.goal_ref === delegated)?.current_version).toBe(2);
  });

  it("routes delegated purpose changes only from a branded Gateway approval request", () => {
    const controller = new HDSUpperController({ goal_governance: createConfig() });
    const args = {
      goal_ref: delegated,
      prior_version: 2,
      prior_purpose_digest: digest("3"),
      new_purpose_digest: digest("8"),
    };
    const trusted = createGatewayInternalInboundRequest({
      ...request,
      user: "webchat-owner-token-holder",
      channel: "webchat",
      content: "Owner submitted a delegated goal purpose change for L3 review.",
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner",
        "blue_tanuki.process_kind": "approval",
        "blue_tanuki.goal_purpose_change.version": "v1",
        "blue_tanuki.tool_call": { tool_name: "goal.governance.change", arguments: args },
      },
    });
    const allowed = controller.decide(trusted);
    expect(allowed.command).toMatchObject({
      type: "tool_call",
      payload: { tool_name: "goal.governance.change", arguments: args },
      constraints: {
        allowed_tools: ["goal.governance.change"],
        allowed_capabilities: ["tool:goal.governance.change"],
      },
    });
    if (!allowed.command) throw new Error("trusted goal purpose change did not produce an HDS command");
    expect(evaluateApproval(allowed.command, [], { actor: trusted.user, default_mode: "full_access" })).toMatchObject({
      decision: "ask",
      risk: "high",
      approval_level: "L3_final_review",
      final_review_required: true,
    });

    const forged = controller.decide({
      ...trusted,
      metadata: trusted.metadata,
    });
    expect(forged.command?.type === "tool_call" && forged.command.payload.tool_name === "goal.governance.change").toBe(false);
  });

  it("commits a delegated purpose change only from the exact L3 review and replays it from the durable audit chain", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-goal-governance-audit-"));
    const filepath = join(root, "audit.jsonl");
    try {
      const controller = new HDSUpperController({
        audit: new AuditLog({ filepath }),
        goal_governance: createConfig(),
      });
      const command = purposeChangeCommand(digest("7"));
      const proposalActor = "webchat-owner-token-holder";
      const reviewerActor = "webchat-resume-token-holder";
      const evaluation = evaluateApproval(command, [], { actor: proposalActor, default_mode: "full_access" });
      expect(evaluation).toMatchObject({ decision: "ask", risk: "high", approval_level: "L3_final_review", final_review_required: true });
      controller.onApprovalEvaluation(evaluation, { request_id: "owner-request" });
      controller.onCommandLifecycle(command.id, "approval_approved", {
        actor: reviewerActor,
        reason: "human_approval:approve",
        request_id: "owner-request",
      });

      const committed = controller.commitGoalPurposeChangeAfterL3({
        goal_ref: delegated,
        prior_version: 2,
        prior_purpose_digest: digest("3"),
        new_purpose_digest: digest("7"),
        request_id: "owner-request",
        command_id: command.id,
        proposal_actor: proposalActor,
        actor: reviewerActor,
        evaluation,
      });
      expect(committed).toMatchObject({ ok: true, goal_ref: delegated, version: 3, purpose_digest: digest("7") });
      expect(controller.getAudit().verify()).toBe(true);

      const restarted = new HDSUpperController({
        audit: new AuditLog({ filepath }),
        goal_governance: createConfig(),
      });
      const projection = restarted.decide({ ...request, timestamp: Date.now() + 1_000 }).log.frame.goal_governance;
      expect(projection?.goals.find((goal) => goal.goal_ref === delegated)).toMatchObject({
        current_version: 3,
        current_purpose_digest: digest("7"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a purpose change when the approved digest differs from the requested digest", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-goal-governance-audit-"));
    const filepath = join(root, "audit.jsonl");
    try {
      const controller = new HDSUpperController({
        audit: new AuditLog({ filepath }),
        goal_governance: createConfig(),
      });
      const command = purposeChangeCommand(digest("7"));
      const proposalActor = "webchat-owner-token-holder";
      const reviewerActor = "webchat-resume-token-holder";
      const evaluation = evaluateApproval(command, [], { actor: proposalActor, default_mode: "full_access" });
      controller.onApprovalEvaluation(evaluation, { request_id: "owner-request" });
      controller.onCommandLifecycle(command.id, "approval_approved", {
        actor: reviewerActor,
        reason: "human_approval:approve",
        request_id: "owner-request",
      });

      expect(controller.commitGoalPurposeChangeAfterL3({
        goal_ref: delegated,
        prior_version: 2,
        prior_purpose_digest: digest("3"),
        new_purpose_digest: digest("8"),
        request_id: "owner-request",
        command_id: command.id,
        proposal_actor: proposalActor,
        actor: reviewerActor,
        evaluation,
      })).toEqual({ ok: false, reason: "approval_not_verified" });
      expect(controller.getAudit().list().some(({ log }) => "kind" in log && log.kind === "authority_event" &&
        log.event === "goal_purpose_change_committed")).toBe(false);
      expect(controller.getAudit().verify()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replay a bare goal event without its matching recorded L3 approval", () => {
    const audit = new AuditLog();
    const event: Extract<GoalGovernanceEvent, { event_kind: "purpose_change" }> = {
      event_ref: "ge_0000000000000005",
      event_kind: "purpose_change",
      goal_ref: delegated,
      source_ref: "F:0000000000000001",
      goal_kind: "delegated",
      prior_version: 2,
      new_version: 3,
      prior_purpose_digest: digest("3"),
      new_purpose_digest: digest("8"),
      authority_kind: "owner",
      authorization_ref: "ga_0000000000000005",
      recorded_at: 400,
      effective_from: 450,
    };
    const authorization: GoalGovernanceAuthorization = {
      authorization_ref: event.authorization_ref,
      event_ref: event.event_ref,
      event_digest: goalGovernanceEventDigest(event),
      goal_ref: event.goal_ref,
      event_kind: event.event_kind,
      authority_kind: event.authority_kind,
      authorized_at: event.recorded_at,
    };
    audit.append({
      kind: "authority_event",
      event: "goal_purpose_change_committed",
      request_id: "owner-request",
      command_id: "goal-purpose-change-command",
      actor: "webchat-resume-token-holder",
      proposal_actor: "webchat-owner-token-holder",
      reason: "forged_without_review",
      operation: "tool.call",
      risk: "high",
      goal_governance_event: event,
      goal_governance_authorization: authorization,
      timestamp: event.effective_from,
    });

    expect(() => new HDSUpperController({ audit, goal_governance: createConfig() }))
      .toThrow(/matching L3 approval record/);
  });

  it("rejects a malformed goal event marker instead of silently skipping it during startup", () => {
    const audit = new AuditLog();
    audit.append({
      kind: "authority_event",
      event: "goal_purpose_change_committed",
      request_id: "owner-request",
      command_id: "goal-purpose-change-command",
      actor: "owner",
      reason: "incomplete_event",
      timestamp: 500,
    });
    expect(() => new HDSUpperController({ audit, goal_governance: createConfig() }))
      .toThrow(/record is malformed/);
  });

  it("fails closed when a persistent audit append fails", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-goal-governance-audit-"));
    const filepath = join(root, "audit.jsonl");
    const controller = new HDSUpperController({
      audit: new AuditLog({ filepath }),
      goal_governance: createConfig(),
    });
    const command = purposeChangeCommand(digest("7"));
    const proposalActor = "webchat-owner-token-holder";
    const reviewerActor = "webchat-resume-token-holder";
    const evaluation = evaluateApproval(command, [], { actor: proposalActor, default_mode: "full_access" });
    controller.onApprovalEvaluation(evaluation, { request_id: "owner-request" });
    controller.onCommandLifecycle(command.id, "approval_approved", {
      actor: reviewerActor,
      reason: "human_approval:approve",
      request_id: "owner-request",
    });
    rmSync(root, { recursive: true, force: true });

    expect(controller.commitGoalPurposeChangeAfterL3({
      goal_ref: delegated,
      prior_version: 2,
      prior_purpose_digest: digest("3"),
      new_purpose_digest: digest("7"),
      request_id: "owner-request",
      command_id: command.id,
      proposal_actor: proposalActor,
      actor: reviewerActor,
      evaluation,
    })).toEqual({ ok: false, reason: "audit_append_failed" });
    expect(controller.getAudit().verify()).toBe(false);
    expect(controller.getAudit().list().some(({ log }) => "kind" in log && log.kind === "authority_event" &&
      log.event === "goal_purpose_change_committed")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

function purposeChangeCommand(new_purpose_digest: string): ExecuteCommand {
  return {
    id: "goal-purpose-change-command",
    type: "tool_call",
    payload: {
      tool_name: "goal.governance.change",
      arguments: {
        goal_ref: delegated,
        prior_version: 2,
        prior_purpose_digest: digest("3"),
        new_purpose_digest,
      },
    },
    constraints: {
      allowed_tools: ["goal.governance.change"],
      allowed_capabilities: ["tool:goal.governance.change"],
    },
    upstream_decision: {
      frame_goal: "Review a delegated goal purpose update.",
      model_abstraction: "test",
      commit_hash: "a".repeat(64),
      commit_decision: "ASSERT",
    },
  };
}

function withEvent(config: GoalGovernanceConfig, event: GoalGovernanceEvent): GoalGovernanceConfig {
  return {
    ...config,
    events: config.events.map((candidate) => candidate.event_ref === event.event_ref ? event : candidate),
    authorizations: config.authorizations.map((authorization) => authorization.event_ref === event.event_ref
      ? { ...authorization, event_digest: goalGovernanceEventDigest(event) }
      : authorization),
  };
}
