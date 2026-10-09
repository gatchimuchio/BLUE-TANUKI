import { describe, expect, it } from "vitest";
import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";
import {
  buildOutputAuditLog,
  classifyOutputKind,
} from "../src/output_audit.js";
import { HDSUpperController } from "../src/controller.js";
import { DocumentOrganizationCoordinator, renderDocumentOrganizationProjection } from "../src/document_organization.js";

const upstream = {
  frame_goal: "goal",
  model_abstraction: "model",
  commit_hash: "abc123",
  commit_decision: "ASSERT" as const,
};

function command(
  type: ExecuteCommand["type"],
  extra: Partial<ExecuteCommand> = {},
): ExecuteCommand {
  if (type === "llm_call") {
    return {
      id: "cmd-llm",
      type,
      payload: { messages: [{ role: "user", content: "hi" }] },
      upstream_decision: upstream,
      ...extra,
    } as ExecuteCommand;
  }
  if (type === "channel_send") {
    return {
      id: "cmd-channel",
      type,
      payload: { channel: "webchat", target: "local-user", content: "hi" },
      upstream_decision: upstream,
      ...extra,
    } as ExecuteCommand;
  }
  if (type === "noop") {
    return {
      id: "cmd-noop",
      type,
      payload: { reason: "unsupported tool" },
      upstream_decision: upstream,
      ...extra,
    } as ExecuteCommand;
  }
  return {
    id: "cmd-tool",
    type,
    payload: { tool_name: "file.search", arguments: {} },
    constraints: { allowed_tools: ["file.search"], allowed_capabilities: ["fs:read"] },
    upstream_decision: upstream,
    ...extra,
  } as ExecuteCommand;
}

function feedback(result: unknown): ExecuteFeedback {
  return {
    command_id: "cmd",
    status: "success",
    result,
    metrics: { duration_ms: 1 },
  };
}

describe("OutputAudit", () => {
  it("audits LLM raw output before user-visible release without storing raw content", () => {
    const log = buildOutputAuditLog({
      command: command("llm_call"),
      feedback: feedback({ content: "hello" }),
      rendered_output: "hello",
      target_surface: "channel",
      request_id: "r-1",
      timestamp: 1,
    });

    expect(log.kind).toBe("output_audit");
    expect(log.output_kind).toBe("llm_raw_output");
    expect(log.request_id).toBe("r-1");
    expect(log.user_visible_output).toBe(true);
    expect(log.used_for_authority).toBe(false);
    expect(log.result_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(log.rendered_output_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(log)).not.toContain("hello");
  });

  it("classifies tool, scheduler, plugin, and external action results", () => {
    expect(classifyOutputKind(command("tool_call"))).toBe("tool_result");
    expect(
      classifyOutputKind(command("tool_call", {
        payload: { tool_name: "schedule.create", arguments: {} },
      })),
    ).toBe("scheduler_result");
    expect(
      classifyOutputKind(command("tool_call", {
        payload: { tool_name: "plugin.demo", arguments: {} },
        constraints: { allowed_tools: ["plugin.demo"], allowed_capabilities: ["plugin:demo"] },
      })),
    ).toBe("plugin_result");
    expect(
      classifyOutputKind(command("tool_call", {
        payload: { tool_name: "github.write", arguments: {} },
        constraints: { allowed_tools: ["github.write"], allowed_capabilities: ["github:issue.write"] },
      })),
    ).toBe("external_action_result");
    expect(classifyOutputKind(command("channel_send"))).toBe("external_action_result");
  });

  it("records output audit in the HDS hash-chain", () => {
    const hds = new HDSUpperController();
    const log = hds.onOutputAudit({
      command: command("tool_call"),
      feedback: feedback({ a: 1 }),
      rendered_output: "{\"a\":1}",
      target_surface: "cli",
      request_id: "r-out",
      timestamp: 1,
    });

    expect(log.kind).toBe("output_audit");
    const entries = hds.getAudit().list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.log).toEqual(log);
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("audits restored J projection display by digest without creating execution authority", () => {
    const source = "C08_PRIVATE_RESTORED_OUTPUT";
    const hds = new HDSUpperController();
    const coordinator = new DocumentOrganizationCoordinator({
      task_id: "task-restored-projection",
      request_id: "r-restored-projection",
      source_text: source,
      memory_version: {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: "verified",
        revision_digest: "e".repeat(64),
        entry_count: 0,
      },
    });
    coordinator.applyComputeOutput(JSON.stringify({
      schema_version: "blue-tanuki.document-organization.candidate.v1",
      sections: [{ label: "復旧検査", excerpts: [{ start: 0, end: source.length, quote: source }] }],
    }));
    const projection = DocumentOrganizationCoordinator.restore(
      { source_text: source },
      coordinator.checkpoint(),
    ).snapshot();
    const rendered = renderDocumentOrganizationProjection(projection);
    const log = hds.onDocumentOrganizationProjectionOutputAudit({
      request_id: "r-restored-projection",
      upstream_commit_hash: "d".repeat(64),
      projection,
      rendered_output: rendered,
      target_surface: "channel",
      timestamp: 2,
    });

    expect(log).toMatchObject({
      kind: "j_projection_output_audit",
      request_id: "r-restored-projection",
      projection_status: "completed",
      user_visible_output: true,
      external_side_effect_result: false,
      used_for_authority: false,
      may_execute: false,
      may_commit_to_memory: false,
      reason: "terminal_j_projection_reviewed_before_display",
    });
    expect(JSON.stringify(log)).not.toContain(source);
    expect(hds.getAudit().list().some((event) => event.log.kind === "j_projection_output_audit")).toBe(true);
    expect(hds.getAudit().verify()).toBe(true);
  });
});
