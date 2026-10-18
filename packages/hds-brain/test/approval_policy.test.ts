import { describe, expect, it } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  approvalContextFromCommand,
  approvalLevelFromContext,
  buildApprovalGrant,
  evaluateApproval,
  finalReviewRequired,
  FINAL_REVIEW_OPERATIONS,
  approvalGrantFromEvaluation,
} from "../src/approval_policy.js";

const upstream = {
  frame_goal: "goal",
  model_abstraction: "model",
  commit_hash: "abc123",
  commit_decision: "ASSERT" as const,
};

function toolCommand(
  tool_name: string,
  args: Record<string, unknown>,
  caps: string[],
): ExecuteCommand {
  return {
    id: "cmd-1",
    type: "tool_call",
    payload: { tool_name, arguments: args },
    constraints: { allowed_tools: [tool_name], allowed_capabilities: caps },
    upstream_decision: upstream,
  };
}

describe("approval policy", () => {
  it("classifies file search as low-risk read/search", () => {
    const cmd = toolCommand("file.search", { query: "docs" }, ["tool:file.search", "fs:read"]);
    const ctx = approvalContextFromCommand(cmd, { actor: "alice", now: 1 });
    expect(ctx.operation).toBe("tool.file.search");
    expect(ctx.risk).toBe("low");
    expect(approvalLevelFromContext(ctx)).toBe("L1_observe");
    expect(finalReviewRequired(ctx)).toBe(false);
  });

  it("allows non-final-review commands by default in full-access operator mode", () => {
    const cmd = toolCommand("file.write", { path: "docs/a.md" }, ["fs:write"]);
    const r = evaluateApproval(cmd, [], { actor: "alice", now: 1 });
    expect(r.decision).toBe("allow");
    expect(r.mode).toBe("full_access");
    expect(r.context.operation).toBe("tool.file.write");
    expect(r.risk).toBe("medium");
    expect(r.approval_level).toBe("L2_operate");
  });

  it("still supports strict ask-every-time mode by explicit configuration", () => {
    const cmd = toolCommand("file.write", { path: "docs/a.md" }, ["fs:write"]);
    const r = evaluateApproval(cmd, [], { actor: "alice", now: 1, default_mode: "ask_every_time" });
    expect(r.decision).toBe("ask");
    expect(r.mode).toBe("ask_every_time");
  });

  it("allows remembered same-operation same-scope grants", () => {
    const cmd = toolCommand("file.write", { path: "docs/a.md" }, ["fs:write"]);
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "allow",
      operation: "tool.file.write",
      target_scope: "file",
      target: "docs/a.md",
      path_pattern: "docs/a.md",
      risk: "medium",
      actor: "alice",
      created_by: "alice",
      expires_at: 9999,
    });
    const r = evaluateApproval(cmd, [grant], { actor: "alice", now: 1 });
    expect(r.decision).toBe("allow");
    expect(r.matched_grant_id).toBe(grant.id);
  });


  it("lets explicit deny grants override default full access", () => {
    const cmd = toolCommand("file.write", { path: "docs/a.md" }, ["fs:write"]);
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "deny",
      operation: "tool.file.write",
      target_scope: "file",
      target: "docs/a.md",
      path_pattern: "docs/a.md",
      risk: "medium",
      actor: "alice",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], { actor: "alice", now: 1 });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("deny_grant_matched");
  });

  it("keeps final review even when a matching allow grant exists", () => {
    const cmd = toolCommand("shell.exec", { command: "echo ok" }, ["shell:exec"]);
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "allow",
      operation: "tool.shell.exec",
      target_scope: "task_type",
      target: "shell.exec",
      risk: "high",
      actor: "alice",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], { actor: "alice", now: 1 });
    expect(r.decision).toBe("ask");
    expect(r.final_review_required).toBe(true);
  });


  it("makes the no-black-box authority boundary machine-readable", () => {
    const cmd = toolCommand("file.write", { path: "docs/a.md" }, ["fs:write"]);
    const r = evaluateApproval(cmd, [], { actor: "alice", now: 1 });
    expect(r.authority_trace.authority_model).toBe("owner_operated_full_access");
    expect(r.authority_trace.control_plane_black_boxes).toEqual([]);
    expect(r.authority_trace.black_box_boundary).toBe("none_in_hds_authority_path");
    expect(r.authority_trace.audit_closure).toEqual({
      decision: "hash_chain",
      approval: "hash_chain",
      execution_feedback: "hash_chain",
    });
    expect(r.authority_trace.resolved_factors.operation).toBe("tool.file.write");
    expect(r.authority_trace.resolved_factors.approval_level).toBe("L2_operate");
    expect(r.authority_trace.resolved_factors.final_review_required).toBe(false);
  });

  it("does not let full-access bypass final review operations", () => {
    const cmd = toolCommand("shell.exec", { command: "rm -rf ./tmp" }, ["shell:exec"]);
    const grant = buildApprovalGrant({
      mode: "full_access",
      decision: "allow",
      operation: "*",
      target_scope: "*",
      risk: "*",
      actor: "*",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], { actor: "alice", now: 1, default_mode: "full_access" });
    expect(r.context.operation).toBe("tool.shell.exec");
    expect(r.final_review_required).toBe(true);
    expect(r.approval_level).toBe("L3_final_review");
    expect(r.decision).toBe("ask");
  });

  it("keeps ApprovalRisk three-tier while mapping privileged operations to L3", () => {
    const create = toolCommand(
      "schedule.create",
      { channel: "webchat", target: "local-user", content: "smoke", interval_ms: 120000 },
      ["tool:schedule.create", "schedule:create"],
    );
    const r = evaluateApproval(create, [], { actor: "alice", now: 1, default_mode: "full_access" });
    expect(r.context.operation).toBe("schedule.create");
    expect(r.risk).toBe("high");
    expect(r.approval_level).toBe("L3_final_review");
    expect(r.final_review_required).toBe(true);
    expect(r.decision).toBe("ask");
    expect(["low", "medium", "high"]).toContain(r.risk);
  });

  it("classifies schedule list as L1 and schedule update/delete as L3", () => {
    const list = evaluateApproval(
      toolCommand("schedule.list", {}, ["tool:schedule.list", "schedule:read"]),
      [],
      { actor: "alice", now: 1, default_mode: "full_access" },
    );
    expect(list.context.operation).toBe("schedule.list");
    expect(list.risk).toBe("low");
    expect(list.approval_level).toBe("L1_observe");
    expect(list.decision).toBe("allow");

    for (const [tool, cap, operation] of [
      ["schedule.update", "schedule:update", "schedule.update"],
      ["schedule.delete", "schedule:delete", "schedule.delete"],
      ["schedule.resolve_event", "schedule:resolve_event", "schedule.resolve_event"],
    ] as const) {
      const result = evaluateApproval(
        toolCommand(tool, { id: "runtime-smoke" }, [`tool:${tool}`, cap]),
        [],
        { actor: "alice", now: 1, default_mode: "full_access" },
      );
      expect(result.context.operation).toBe(operation);
      expect(result.risk).toBe("high");
      expect(result.approval_level).toBe("L3_final_review");
      expect(result.decision).toBe("ask");
    }
  });

  it("includes defensive final-review placeholders", () => {
    for (const operation of [
      "tool.file.delete",
      "tool.shell.exec",
      "external.send",
      "credential.access",
      "settings.write",
      "schedule.create",
      "schedule.update",
      "schedule.delete",
      "schedule.resolve_event",
      "recovery.restore",
      "recovery.reset_provider",
      "recovery.reset_connector",
      "recovery.factory_reset",
      "browser.automation",
      "payment.charge",
    ] as const) {
      expect(FINAL_REVIEW_OPERATIONS.has(operation)).toBe(true);
    }
  });

  it("does not let reusable grants bypass schedule final review", () => {
    const cmd = toolCommand(
      "schedule.delete",
      { id: "runtime-smoke" },
      ["tool:schedule.delete", "schedule:delete"],
    );
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "allow",
      operation: "schedule.delete",
      target_scope: "task_type",
      target: "schedule.delete",
      risk: "high",
      actor: "alice",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], { actor: "alice", now: 1 });
    expect(r.final_review_required).toBe(true);
    expect(r.approval_level).toBe("L3_final_review");
    expect(r.decision).toBe("ask");
  });

  it("classifies recovery mutations as high-risk L3 operations even under full access", () => {
    const grant = buildApprovalGrant({
      mode: "full_access",
      decision: "allow",
      operation: "*",
      target_scope: "*",
      risk: "*",
      actor: "*",
      created_by: "alice",
      expires_at: null,
    });
    for (const operation of [
      "recovery.restore",
      "recovery.reset_provider",
      "recovery.reset_connector",
      "recovery.factory_reset",
    ] as const) {
      const result = evaluateApproval(toolCommand(operation, { backup_id: "opaque" }, [`tool:${operation}`, "fs:write"]), [grant], {
        actor: "alice",
        now: 1,
        default_mode: "full_access",
      });
      expect(result.context.operation).toBe(operation);
      expect(result.risk).toBe("high");
      expect(result.approval_level).toBe("L3_final_review");
      expect(result.final_review_required).toBe(true);
      expect(result.decision).toBe("ask");
    }
  });

  it("maps host-scoped network capability into network tool operation", () => {
    const cmd = toolCommand(
      "github.read",
      { owner: "gatchimuchio", repo: "blue-tanuki" },
      ["tool:github.read", "network:github.com"],
    );
    const r = evaluateApproval(cmd, [], {
      actor: "alice",
      now: 1,
      default_mode: "full_access",
    });

    expect(r.context.operation).toBe("tool.network.http");
    expect(r.context.risk).toBe("medium");
    expect(r.final_review_required).toBe(false);
  });

  it("maps browser snapshot to L2 and browser automation actions to L3", () => {
    const snapshot = evaluateApproval(
      toolCommand(
        "browser.snapshot",
        { url: "https://example.com" },
        ["tool:browser.snapshot", "browser:snapshot", "network:http"],
      ),
      [],
      { actor: "alice", now: 1, default_mode: "full_access" },
    );
    expect(snapshot.context.operation).toBe("browser.snapshot");
    expect(snapshot.risk).toBe("medium");
    expect(snapshot.approval_level).toBe("L2_operate");
    expect(snapshot.final_review_required).toBe(false);

    const action = evaluateApproval(
      toolCommand(
        "browser.automation",
        { action: "click", url: "https://example.com", selector: "#go" },
        ["tool:browser.automation", "browser:act", "network:http"],
      ),
      [],
      { actor: "alice", now: 1, default_mode: "full_access" },
    );
    expect(action.context.operation).toBe("browser.automation");
    expect(action.risk).toBe("high");
    expect(action.approval_level).toBe("L3_final_review");
    expect(action.final_review_required).toBe(true);
    expect(action.decision).toBe("ask");
  });

  it("forces github.write through L3 final-review even in full-access mode", () => {
    const cmd = toolCommand(
      "github.write",
      { operation: "issue.create", owner: "gatchimuchio", repo: "blue-tanuki", title: "hi" },
      [
        "tool:github.write",
        "network:github.com",
        "secrets:GITHUB_TOKEN",
        "github:issue.write",
        "github:pr.write",
        "github:comment.write",
      ],
    );
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "allow",
      operation: "github.write",
      target_scope: "repo",
      target: "gatchimuchio/blue-tanuki",
      risk: "high",
      actor: "alice",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], {
      actor: "alice",
      now: 1,
      default_mode: "full_access",
    });

    expect(FINAL_REVIEW_OPERATIONS.has("github.write")).toBe(true);
    expect(r.context.operation).toBe("github.write");
    expect(r.context.target_scope).toBe("repo");
    expect(r.context.target).toBe("gatchimuchio/blue-tanuki");
    expect(r.context.risk).toBe("high");
    expect(r.approval_level).toBe("L3_final_review");
    expect(r.final_review_required).toBe(true);
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("grant_matched_but_final_review_required");
  });

  it("forces credential-backed Google read tools through L3 final-review", () => {
    const cmd = toolCommand(
      "gmail.read",
      { query: "newer_than:1d" },
      [
        "tool:gmail.read",
        "network:googleapis.com",
        "secrets:GMAIL_ACCESS_TOKEN",
        "secrets:GOOGLE_ACCESS_TOKEN",
        "google:gmail.read",
      ],
    );
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "allow",
      operation: "credential.access",
      target_scope: "task_type",
      target: "gmail.read:newer_than:1d",
      risk: "high",
      actor: "alice",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], {
      actor: "alice",
      now: 1,
      default_mode: "full_access",
    });

    expect(FINAL_REVIEW_OPERATIONS.has("credential.access")).toBe(true);
    expect(r.context.operation).toBe("credential.access");
    expect(r.context.risk).toBe("high");
    expect(r.approval_level).toBe("L3_final_review");
    expect(r.final_review_required).toBe(true);
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("grant_matched_but_final_review_required");
  });

  it("forces Google write tools through L3 final-review even with reusable grants", () => {
    const cmd = toolCommand(
      "google.calendar.write",
      { operation: "event.create", calendar_id: "primary", summary: "Standup" },
      [
        "tool:google.calendar.write",
        "network:googleapis.com",
        "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
        "secrets:GOOGLE_ACCESS_TOKEN",
        "google:calendar.write",
      ],
    );
    const grant = buildApprovalGrant({
      mode: "remember_this_decision",
      decision: "allow",
      operation: "google.write",
      target_scope: "task_type",
      target: "google.calendar.write:event.create:primary",
      risk: "high",
      actor: "alice",
      created_by: "alice",
      expires_at: null,
    });
    const r = evaluateApproval(cmd, [grant], {
      actor: "alice",
      now: 1,
      default_mode: "full_access",
    });

    expect(FINAL_REVIEW_OPERATIONS.has("google.write")).toBe(true);
    expect(r.context.operation).toBe("google.write");
    expect(r.context.risk).toBe("high");
    expect(r.approval_level).toBe("L3_final_review");
    expect(r.final_review_required).toBe(true);
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("grant_matched_but_final_review_required");
  });
});


describe("approval grant helpers", () => {
  it("builds a reusable grant from an approval evaluation", () => {
    const cmd = toolCommand("file.write", { path: "docs/a.md" }, ["fs:write"]);
    const evaluation = evaluateApproval(cmd, [], { actor: "alice", now: 1 });
    const grant = approvalGrantFromEvaluation(evaluation, { created_by: "alice", expires_at: 9999 });
    expect(grant.operation).toBe("tool.file.write");
    expect(grant.target).toBe("docs/a.md");
    expect(grant.actor).toBe("alice");
  });
});

describe("Recovery mutation final review", () => {
  it("keeps every recovery mutation high-risk L3 ask despite matching reusable grants", () => {
    const cases = [
      { name: "recovery.restore", args: { backup_id: "backup-2026-01", confirm: "RESTORE" }, target: "recovery.restore:backup-2026-01" },
      { name: "recovery.restore", args: { backup_id: "backup-2026-01", store_key: "operation_plans", confirm: "RESTORE" }, target: "recovery.restore:backup-2026-01:store:operation_plans" },
      { name: "recovery.reset_provider", args: { confirm: "RESET_PROVIDER" }, target: "recovery.reset_provider:provider-configuration" },
      { name: "recovery.reset_connector", args: { confirm: "RESET_CONNECTOR" }, target: "recovery.reset_connector:connector-configuration" },
      { name: "recovery.factory_reset", args: { confirm: "FACTORY_RESET" }, target: "recovery.factory_reset:local-runtime-state-and-config" },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const command = toolCommand(item.name, item.args, [`tool:${item.name}`, `recovery:${item.name.slice("recovery.".length)}`, "fs:write"]);
      command.id = `recovery-${index}`;
      const grant = buildApprovalGrant({
        mode: "full_access",
        decision: "allow",
        operation: item.name,
        target_scope: "task_type",
        target: item.target,
        risk: "high",
        actor: "owner",
        created_by: "owner",
        expires_at: null,
      });
      const evaluation = evaluateApproval(command, [grant], { actor: "owner", default_mode: "full_access" });

      expect(evaluation.context.operation).toBe(item.name);
      expect(evaluation.context.target).toBe(item.target);
      expect(evaluation.risk).toBe("high");
      expect(evaluation.approval_level).toBe("L3_final_review");
      expect(evaluation.final_review_required).toBe(true);
      expect(evaluation.decision).toBe("ask");
      expect(evaluation.reason).toContain("grant_matched_but_final_review_required");
    }
  });
});
