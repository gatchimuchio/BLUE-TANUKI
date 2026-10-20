import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGatewayInternalInboundRequest, type ExecuteCommand } from "@blue-tanuki/protocol";
import { AuditLog } from "../src/audit.js";
import { evaluateApproval } from "../src/approval_policy.js";
import { HDSUpperController } from "../src/controller.js";
import { runtimeScheduleScopeDigest, type RuntimeScheduleDelegation } from "../src/controller_security.js";

const schedule = {
  id: "runtime-delegation",
  channel: "webchat",
  target: "local-user",
  content: "synthetic approved schedule content",
  payload_hash: "a".repeat(64),
};
const commandId = "cmd-runtime-delegation-create";
const requestId = "req-runtime-delegation-create";
const delegation: RuntimeScheduleDelegation = {
  command_id: commandId,
  request_id: requestId,
  scope_digest: runtimeScheduleScopeDigest({
    schedule_id: schedule.id,
    channel: schedule.channel,
    target: schedule.target,
    content: schedule.content,
    payload_hash: schedule.payload_hash,
  }),
};

function scheduleCommand(): Extract<ExecuteCommand, { type: "tool_call" }> {
  return {
    id: commandId,
    type: "tool_call",
    payload: {
      tool_name: "schedule.create",
      arguments: {
        id: schedule.id,
        channel: schedule.channel,
        target: schedule.target,
        content: schedule.content,
        interval_ms: 60_000,
      },
    },
    constraints: {
      allowed_tools: ["schedule.create"],
      allowed_capabilities: ["tool:schedule.create", "schedule:create"],
    },
    upstream_decision: {
      frame_goal: "create a scheduled message",
      model_abstraction: "synthetic test",
      commit_hash: "b".repeat(64),
      commit_decision: "ASSERT",
    },
  };
}

function runtimeRequest(overrides: {
  content?: string;
  target?: string;
  payload_hash?: string;
  scope_digest?: string;
} = {}) {
  const content = overrides.content ?? schedule.content;
  const target = overrides.target ?? schedule.target;
  const payloadHash = overrides.payload_hash ?? schedule.payload_hash;
  return createGatewayInternalInboundRequest({
    id: "cron-runtime-event-1",
    channel: "cron",
    user: "blue-tanuki-cron",
    content,
    timestamp: 100,
    metadata: {
      "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.actor_kind": "cron",
      "blue_tanuki.trust_level": "trusted",
      "blue_tanuki.process_kind": "cron",
      "blue_tanuki.cron.task_id": schedule.id,
      "blue_tanuki.cron.origin": "runtime",
      "blue_tanuki.cron.payload_hash": payloadHash,
      "blue_tanuki.cron.delegation.command_id": commandId,
      "blue_tanuki.cron.delegation.request_id": requestId,
      "blue_tanuki.cron.delegation.scope_digest": overrides.scope_digest ?? delegation.scope_digest,
      "blue_tanuki.channel_send.channel": schedule.channel,
      "blue_tanuki.channel_send.target": target,
      "blue_tanuki.channel_send.content": content,
    },
  });
}

function recordActiveApproval(hds: HDSUpperController): void {
  const command = scheduleCommand();
  const evaluation = evaluateApproval(command, [], { actor: "alice", default_mode: "full_access" });
  if (evaluation.decision !== "ask" || evaluation.approval_level !== "L3_final_review") {
    throw new Error("test schedule command did not require L3 final review");
  }
  hds.onApprovalEvaluation(evaluation, { request_id: requestId });
  hds.onScheduleLifecycle("schedule.lifecycle.requested", {
    schedule_id: schedule.id,
    origin: "runtime",
    operation: "create",
    actor: "alice",
    approval_level: evaluation.approval_level,
    risk: evaluation.risk,
    payload_hash: schedule.payload_hash,
    command_id: commandId,
    request_id: requestId,
    delegation,
  });
  hds.onCommandLifecycle(commandId, "approval_approved", {
    actor: "owner",
    reason: "human_approval:approve",
    request_id: requestId,
  });
  hds.onScheduleLifecycle("schedule.lifecycle.approved", {
    schedule_id: schedule.id,
    origin: "runtime",
    operation: "create",
    actor: "alice",
    approval_level: evaluation.approval_level,
    risk: evaluation.risk,
    payload_hash: schedule.payload_hash,
    command_id: commandId,
    request_id: requestId,
    delegation,
  });
  hds.onScheduleLifecycle("schedule.lifecycle.activated", {
    schedule_id: schedule.id,
    origin: "runtime",
    operation: "create",
    actor: "alice",
    approval_level: evaluation.approval_level,
    risk: evaluation.risk,
    payload_hash: schedule.payload_hash,
    command_id: commandId,
    request_id: requestId,
    delegation,
  });
}

describe("runtime schedule delegation", () => {
  it("lets J emit only the exact durable scope backed by the matching L3 approval", () => {
    const root = mkdtempSync(join(tmpdir(), "bt-runtime-schedule-delegation-"));
    try {
      const hds = new HDSUpperController({ audit: new AuditLog({ filepath: join(root, "audit.jsonl") }) });
      recordActiveApproval(hds);

      const allowed = hds.decide(runtimeRequest());
      expect(allowed.command).toMatchObject({
        type: "channel_send",
        payload: { channel: schedule.channel, target: schedule.target, content: schedule.content },
      });

      for (const tampered of [
        runtimeRequest({ content: "tampered content" }),
        runtimeRequest({ target: "different-target" }),
        runtimeRequest({ payload_hash: "c".repeat(64) }),
        runtimeRequest({ scope_digest: "d".repeat(64) }),
      ]) {
        const denied = hds.decide(tampered);
        expect(denied.command).toBeNull();
        expect(denied.log.commit.decision).toBe("FAIL");
        expect(denied.log.commit.reason).toMatch(/^runtime_schedule_delegation_denied:/);
      }
      expect(hds.getAudit().verify()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without durable audit and after a later approved deletion", () => {
    const memoryOnly = new HDSUpperController();
    expect(memoryOnly.decide(runtimeRequest()).command).toBeNull();

    const root = mkdtempSync(join(tmpdir(), "bt-runtime-schedule-deleted-"));
    try {
      const hds = new HDSUpperController({ audit: new AuditLog({ filepath: join(root, "audit.jsonl") }) });
      recordActiveApproval(hds);
      hds.onScheduleLifecycle("schedule.lifecycle.approved", {
        schedule_id: schedule.id,
        origin: "runtime",
        operation: "delete",
        actor: "alice",
        approval_level: "L3_final_review",
        risk: "high",
        command_id: "cmd-runtime-delegation-delete",
        request_id: "req-runtime-delegation-delete",
      });
      const denied = hds.decide(runtimeRequest());
      expect(denied.command).toBeNull();
      expect(denied.log.commit.reason).toContain("runtime_schedule_latest_mutation_not_active_scope");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
