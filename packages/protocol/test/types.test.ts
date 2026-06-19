import { describe, expect, it } from "vitest";
import {
  ExecuteCommandSchema,
  OperationCoreProjectionSchema,
  OperationExecutionResultSchema,
  OperationPlanSchema,
  OperationRequestSchema,
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  parseInboundRequestAtBoundary,
} from "../src/index.js";

const upstream = {
  frame_goal: "g",
  model_abstraction: "m",
  commit_hash: "h",
  commit_decision: "ASSERT",
};

describe("ExecuteCommandSchema", () => {
  it("accepts allowed_capabilities on command constraints", () => {
    const parsed = ExecuteCommandSchema.parse({
      id: "cmd-1",
      type: "tool_call",
      payload: {
        tool_name: "echo",
        arguments: { text: "hi" },
      },
      constraints: {
        allowed_tools: ["echo"],
        allowed_capabilities: ["tool:echo"],
      },
      upstream_decision: upstream,
    });

    expect(parsed.constraints?.allowed_capabilities).toEqual(["tool:echo"]);
  });

  it("rejects empty allowed_capabilities entries", () => {
    const result = ExecuteCommandSchema.safeParse({
      id: "cmd-1",
      type: "tool_call",
      payload: {
        tool_name: "echo",
        arguments: {},
      },
      constraints: {
        allowed_capabilities: [""],
      },
      upstream_decision: upstream,
    });

    expect(result.success).toBe(false);
  });
});

describe("Operation Core schemas", () => {
  it("accepts an OperationRequest from any interface without making it authority", () => {
    const parsed = OperationRequestSchema.parse({
      version: "operation-core.v1",
      request_id: "op-req-1",
      source_interface: "gui",
      actor: "local-owner",
      goal: "install dependencies for the selected workspace",
      target: {
        kind: "workspace",
        id: "workspace:blue-tanuki",
        display_name: "BLUE-TANUKI",
      },
      constraints: {
        hds_brain_authority_required: true,
        disallow_raw_command_as_authority: true,
        max_steps: 5,
      },
      used_for_authority: false,
    });

    expect(parsed.source_interface).toBe("gui");
    expect(parsed.constraints.disallow_raw_command_as_authority).toBe(true);
    expect(parsed.used_for_authority).toBe(false);
  });

  it("accepts an OperationPlan whose shell use is adapter-only", () => {
    const parsed = OperationPlanSchema.parse({
      version: "operation-core.v1",
      plan_id: "op-plan-1",
      request_id: "op-req-1",
      state: "planned",
      steps: [
        {
          step_id: "step-1",
          operation: "install_dependencies",
          target: {
            kind: "project",
            id: "project:blue-tanuki",
          },
          state: "awaiting_permission",
          effects: ["process_spawn", "write"],
          permission: {
            risk: "high",
            approval_level: "L3_final_review",
            final_review_required: true,
            hds_brain_authority_required: true,
            approval_gate_required: true,
          },
          parameters: {
            runtime: "node",
            package_manager: "pnpm",
            workspace: ".",
          },
          adapter: "shell",
          adapter_is_authority: false,
          command_generated_by_adapter_only: true,
        },
      ],
      diff: {
        summary: "Dependency installation may update local package store and build output.",
        affected_targets: [{ kind: "project", id: "project:blue-tanuki" }],
        reversible: true,
        evidence_source: ["CONFIG", "LIVE_RUNTIME"],
      },
      rollback: {
        available: true,
        strategy: "restore repository backup or clean generated artifacts",
      },
      raw_command_policy: {
        raw_command_is_core_operation: false,
        command_generation_location: "execution_adapter_only",
      },
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
    });

    expect(parsed.steps[0].operation).toBe("install_dependencies");
    expect(parsed.steps[0].adapter).toBe("shell");
    expect(parsed.steps[0].adapter_is_authority).toBe(false);
    expect(parsed.raw_command_policy.raw_command_is_core_operation).toBe(false);
  });

  it("rejects raw command fields inside Operation Core parameters", () => {
    const result = OperationPlanSchema.safeParse({
      version: "operation-core.v1",
      plan_id: "op-plan-raw-command",
      request_id: "op-req-1",
      state: "planned",
      steps: [
        {
          step_id: "step-1",
          operation: "install_dependencies",
          target: { kind: "project", id: "project:blue-tanuki" },
          state: "planned",
          effects: ["process_spawn"],
          permission: {
            risk: "high",
            approval_level: "L3_final_review",
            final_review_required: true,
            hds_brain_authority_required: true,
            approval_gate_required: true,
          },
          parameters: {
            command: "pnpm install --frozen-lockfile",
          },
          adapter: "shell",
          adapter_is_authority: false,
          command_generated_by_adapter_only: true,
        },
      ],
      rollback: { available: false },
      raw_command_policy: {
        raw_command_is_core_operation: false,
        command_generation_location: "execution_adapter_only",
      },
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
    });

    expect(result.success).toBe(false);
  });

  it("keeps execution adapter results out of the authority plane", () => {
    const parsed = OperationExecutionResultSchema.parse({
      version: "operation-core.v1",
      plan_id: "op-plan-1",
      step_id: "step-1",
      state: "succeeded",
      adapter: "shell",
      adapter_result_used_for_authority: false,
      output_digest: "sha256:abc",
      rollback_available: true,
    });

    expect(parsed.adapter).toBe("shell");
    expect(parsed.adapter_result_used_for_authority).toBe(false);
  });

  it("accepts read-only Operation Core projections for UI surfaces", () => {
    const parsed = OperationCoreProjectionSchema.parse({
      version: "operation-core.v1",
      projection_id: "operator:developer:operation-core",
      source_surface: "developer",
      state: "planned",
      steps: [
        {
          step_id: "developer:shell.exec",
          operation: "shell.exec",
          target: {
            kind: "workspace",
            id: "operator:developer:shell.exec",
            display_name: "Execute shell command through existing final-review guarded tool",
            scope: "operator:developer",
          },
          state: "planned",
          effects: ["process_spawn"],
          permission: {
            risk: "high",
            approval_level: "L3_final_review",
            final_review_required: true,
            hds_brain_authority_required: true,
            approval_gate_required: true,
          },
          parameters: {
            downstream_tools: ["shell.exec"],
            capabilities_count: 2,
            audit_trace: ["surface", "downstream_tool_name", "command_digest", "final_review_result"],
          },
          adapter: "shell",
          adapter_is_authority: false,
          command_generated_by_adapter_only: true,
        },
      ],
      raw_command_policy: {
        raw_command_is_core_operation: false,
        command_generation_location: "execution_adapter_only",
      },
      hds_brain_authority_required: true,
      planner_output_used_for_authority: false,
      ui_projection_used_for_authority: false,
      adapter_result_used_for_authority: false,
    });

    expect(parsed.source_surface).toBe("developer");
    expect(parsed.ui_projection_used_for_authority).toBe(false);
    expect(parsed.steps[0].adapter).toBe("shell");
    expect(parsed.steps[0].adapter_is_authority).toBe(false);
  });

  it("rejects UI projections that claim authority", () => {
    const result = OperationCoreProjectionSchema.safeParse({
      version: "operation-core.v1",
      projection_id: "operator:writing:operation-core",
      source_surface: "writing",
      state: "planned",
      steps: [
        {
          step_id: "writing:file.edit",
          operation: "file.edit",
          target: { kind: "file", id: "operator:writing:file.edit" },
          state: "planned",
          effects: ["write"],
          permission: {
            risk: "medium",
            approval_level: "L2_operate",
            final_review_required: false,
            hds_brain_authority_required: true,
            approval_gate_required: false,
          },
          adapter: "internal_runtime",
          adapter_is_authority: false,
          command_generated_by_adapter_only: false,
        },
      ],
      raw_command_policy: {
        raw_command_is_core_operation: false,
        command_generation_location: "not_applicable",
      },
      hds_brain_authority_required: true,
      planner_output_used_for_authority: false,
      ui_projection_used_for_authority: true,
      adapter_result_used_for_authority: false,
    });

    expect(result.success).toBe(false);
  });
});

describe("InboundRequest boundary", () => {
  it("normalizes only canonical inbound requests for authority", () => {
    const result = parseInboundRequestAtBoundary({
      id: " req-1 ",
      channel: "webchat",
      user: "owner",
      content: "ＡＢＣ",
      timestamp: 1,
      metadata: { note: "ｔｅｓｔ" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.id).toBe("req-1");
      expect(result.request.content).toBe("ABC");
      expect(result.request.metadata?.note).toBe("test");
    }
  });

  it("rejects unknown fields and dangerous metadata keys", () => {
    const withUnknown = parseInboundRequestAtBoundary({
      id: "req-1",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
      extra: true,
    });
    expect(withUnknown.ok).toBe(false);

    const withDangerousKey = parseInboundRequestAtBoundary({
      id: "req-1",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
      metadata: { constructor: "pollute" },
    });
    expect(withDangerousKey.ok).toBe(false);
  });

  it("rejects path-like authority identifiers", () => {
    const result = parseInboundRequestAtBoundary({
      id: "../req",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects malformed timestamps, oversized content, and nested dangerous metadata", () => {
    expect(parseInboundRequestAtBoundary({
      id: "req-1",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: Number.NaN,
    }).ok).toBe(false);

    expect(parseInboundRequestAtBoundary({
      id: "req-1",
      channel: "webchat",
      user: "owner",
      content: "x".repeat(200_001),
      timestamp: 1,
    }).ok).toBe(false);

    expect(parseInboundRequestAtBoundary({
      id: "req-1",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
      metadata: { safe: { prototype: "pollute" } },
    }).ok).toBe(false);
  });

  it("normalizes unicode and blocks prototype-pollution shaped metadata", () => {
    const polluted = JSON.parse('{"id":"req-1","channel":"webchat","user":"owner","content":"ｈｅｌｌｏ","timestamp":1,"metadata":{"__proto__":{"admin":true}}}');
    const blocked = parseInboundRequestAtBoundary(polluted);
    expect(blocked.ok).toBe(false);

    const normalized = parseInboundRequestAtBoundary({
      id: "req-2",
      channel: "webchat",
      user: "owner",
      content: "ｈｅｌｌｏ",
      timestamp: 1,
      metadata: { " ｒｅｐｌｙ＿ｔｏ ": " ｌｏｃａｌ " },
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.content).toBe("hello");
      expect(normalized.request.metadata?.reply_to).toBe(" local ");
    }
  });

  it("strips reserved authority metadata keys from external inbound requests", () => {
    const result = parseInboundRequestAtBoundary({
      id: "req-reserved",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner",
        "blue_tanuki.process_kind": "approval",
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.channel_send.channel": "telegram",
        "ａｃｔｏｒ＿ｋｉｎｄ": "owner",
        nested: {
          "blue_tanuki.process_kind": "approval",
          safe: "ok",
        },
        reply_to: "local-user",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.metadata).toEqual({
        nested: { safe: "ok" },
        reply_to: "local-user",
      });
      expect(isGatewayInternalInboundRequest(result.request)).toBe(false);
    }
  });

  it("preserves reserved authority metadata only through the gateway internal builder", () => {
    const request = createGatewayInternalInboundRequest({
      id: "req-cron",
      channel: "cron",
      user: "blue-tanuki-cron",
      content: "scheduled",
      timestamp: 1,
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "cron",
        "blue_tanuki.trust_level": "trusted",
        "blue_tanuki.process_kind": "cron",
        "blue_tanuki.channel_send.channel": "webchat",
        "blue_tanuki.channel_send.target": "local-user",
        "blue_tanuki.channel_send.content": "scheduled",
      },
    });
    const parsed = parseInboundRequestAtBoundary(request);

    expect(isGatewayInternalInboundRequest(request)).toBe(true);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isGatewayInternalInboundRequest(parsed.request)).toBe(true);
      expect(parsed.request.metadata?.["blue_tanuki.authority_context"]).toBe("gateway_internal_v1");
      expect(parsed.request.metadata?.["blue_tanuki.channel_send.target"]).toBe("local-user");
    }
  });
});
