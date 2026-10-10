import { describe, expect, it } from "vitest";
import {
  ExecuteCommandSchema,
  ExecuteFeedbackSchema,
  LLMComputeContextSchema,
  inspectOperationPlanAdapterRegistry,
  OPERATION_ADAPTER_REGISTRY,
  OperationCoreApprovalTraceSchema,
  OperationCoreExecutionProjectionSchema,
  OperationCoreProjectionSchema,
  OperationExecutionResultSchema,
  OperationPlanSchema,
  OperationRequestSchema,
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  parseInboundRequestAtBoundary,
  GOAL_CRITERIA_SCHEMA_VERSION,
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

describe("C07.01 ExecuteFeedback proposal transport", () => {
  it("keeps a C proposal as untrusted feedback data for independent HDS validation", () => {
    const proposal = { record_type: "meaning_update_proposal", raw_statement: "untrusted claim" };
    const parsed = ExecuteFeedbackSchema.parse({
      command_id: "cmd-c07-proposal",
      status: "success",
      meaning_update_proposal: proposal,
      metrics: { duration_ms: 1 },
    });

    expect(parsed.meaning_update_proposal).toEqual(proposal);
  });
});

describe("InboundRequest goal criteria boundary", () => {
  const base = {
    id: "criteria-request-1",
    channel: "test",
    user: "owner",
    content: "prepare the task",
    timestamp: 1,
  };
  const goalCriteria = {
    schema_version: GOAL_CRITERIA_SCHEMA_VERSION,
    criteria: [{
      criterion_ref: "task.output",
      criterion_kind: "objective",
      tool_relations: [{ tool_name: "echo", relation: "supports" }],
    }],
  };

  it("preserves only the explicit top-level criteria contract through canonicalization", () => {
    const parsed = parseInboundRequestAtBoundary({ ...base, goal_criteria: goalCriteria });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.goal_criteria).toEqual(goalCriteria);
  });

  it("rejects malformed criteria at the inbound boundary", () => {
    const parsed = parseInboundRequestAtBoundary({
      ...base,
      goal_criteria: { ...goalCriteria, extra: "not allowed" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("schema_validation_failed");
  });

  it("does not promote metadata that resembles a criteria contract", () => {
    const parsed = parseInboundRequestAtBoundary({
      ...base,
      metadata: { "untrusted.goal_criteria": goalCriteria },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.goal_criteria).toBeUndefined();
  });
});

describe("ExecuteFeedback skeptical review boundary", () => {
  const base = {
    command_id: "cmd-review",
    status: "success" as const,
    metrics: { duration_ms: 1 },
  };

  it("accepts bounded reports and a proposed frame as non-authority feedback", () => {
    const parsed = ExecuteFeedbackSchema.safeParse({
      ...base,
      skeptical_review: {
        schema_version: "blue-tanuki.skeptical-review.v1",
        observation_reports: [{
          criterion_ref: "criterion-one",
          finding: "synthetic observation report",
          relation: "supports",
        }],
        alternative_hypotheses: ["synthetic alternative"],
        proposed_goal_criteria: {
          schema_version: GOAL_CRITERIA_SCHEMA_VERSION,
          criteria: [{
            criterion_ref: "criterion-one",
            criterion_kind: "objective",
            tool_relations: [{ tool_name: "echo", relation: "supports" }],
          }],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects malformed or unbounded review fields", () => {
    const malformed = ExecuteFeedbackSchema.safeParse({
      ...base,
      skeptical_review: {
        schema_version: "blue-tanuki.skeptical-review.v1",
        observation_reports: [{ criterion_ref: "", finding: "", relation: "supports" }],
        unexpected: true,
      },
    });

    expect(malformed.success).toBe(false);
  });
});

describe("LLMComputeContextSchema fallback authorization", () => {
  const context = {
    schema_version: "blue-tanuki.compute-context.v1",
    projection_digest: "a".repeat(64),
    local_p_version: "local-p.v1",
    data_exposure: {
      input_sources: ["accepted_inbound_request"],
      requested_egress_provider: "primary",
    },
  };

  it("accepts an explicit provider, capability, and cumulative cost bound", () => {
    const parsed = LLMComputeContextSchema.parse({
      ...context,
      fallback_authorization: {
        allowed_providers: ["backup"],
        allowed_input_sources: ["accepted_inbound_request"],
        required_capabilities: ["llm.text.generate"],
        max_total_cost: { amount: 0.5, currency: "USD" },
      },
    });

    expect(parsed.fallback_authorization?.allowed_providers).toEqual(["backup"]);
  });

  it("rejects duplicate, empty, unbounded, or unknown fallback authorization data", () => {
    for (const authorization of [
      { allowed_providers: ["backup", "BACKUP"], allowed_input_sources: ["accepted_inbound_request"], required_capabilities: ["llm.text.generate"], max_total_cost: { amount: 1, currency: "USD" } },
      { allowed_providers: ["backup"], allowed_input_sources: [], required_capabilities: [], max_total_cost: { amount: 1, currency: "USD" } },
      { allowed_providers: ["backup"], allowed_input_sources: ["accepted_inbound_request"], required_capabilities: ["llm.text.generate"], max_total_cost: { amount: -1, currency: "USD" } },
      { allowed_providers: ["backup"], allowed_input_sources: ["accepted_inbound_request"], required_capabilities: ["llm.text.generate"], max_total_cost: { amount: 1, currency: "usd" } },
      { allowed_providers: ["backup"], allowed_input_sources: ["accepted_inbound_request"], required_capabilities: ["llm.text.generate"], max_total_cost: { amount: 1, currency: "USD" }, approved: true },
    ]) {
      expect(LLMComputeContextSchema.safeParse({ ...context, fallback_authorization: authorization }).success).toBe(false);
    }
  });
});

describe("Operation Core schemas", () => {
  it("accepts executor feedback with non-authority Operation Core adapter trace", () => {
    const parsed = ExecuteFeedbackSchema.parse({
      command_id: "cmd-shell",
      status: "success",
      result: { ok: true },
      metrics: { duration_ms: 12, tool_calls: 1 },
      operation_core: {
        version: "operation-core.v1",
        role: "execution_adapter_trace",
        operation: "tool.shell.exec",
        state: "succeeded",
        target: {
          kind: "runtime",
          id: "tool:shell.exec",
          scope: "shell_adapter",
        },
        effects: ["process_spawn"],
        permission: {
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
          hds_brain_authority_required: true,
          approval_gate_required: true,
        },
        adapter: "shell",
        runtime_boundary: "shell_adapter",
        adapter_is_authority: false,
        command_generated_by_adapter_only: true,
        raw_command_is_core_operation: false,
        adapter_result_used_for_authority: false,
        executor_trace_used_for_authority: false,
        hds_brain_authority_required: true,
        evidence_source: ["INTERNAL_STATE"],
      },
    });

    expect(parsed.operation_core?.adapter).toBe("shell");
    expect(parsed.operation_core?.executor_trace_used_for_authority).toBe(false);
  });

  it("rejects executor traces that claim authority", () => {
    const result = ExecuteFeedbackSchema.safeParse({
      command_id: "cmd-shell",
      status: "success",
      metrics: { duration_ms: 12 },
      operation_core: {
        version: "operation-core.v1",
        role: "execution_adapter_trace",
        operation: "tool.shell.exec",
        state: "succeeded",
        target: {
          kind: "runtime",
          id: "tool:shell.exec",
        },
        effects: ["process_spawn"],
        permission: {
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
          hds_brain_authority_required: true,
          approval_gate_required: true,
        },
        adapter: "shell",
        runtime_boundary: "shell_adapter",
        adapter_is_authority: true,
        command_generated_by_adapter_only: true,
        raw_command_is_core_operation: false,
        adapter_result_used_for_authority: false,
        executor_trace_used_for_authority: false,
        hds_brain_authority_required: true,
        evidence_source: ["INTERNAL_STATE"],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts typed LLM failures and candidate-only tool calls", () => {
    const parsed = ExecuteFeedbackSchema.parse({
      command_id: "llm-candidate",
      status: "success",
      result: { content: "", tokens_used: 1, model: "fixture-model" },
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-1",
        tool_name: "shell.exec",
        arguments: { command: "echo forbidden" },
        authority_boundary: {
          candidate_only: true,
          may_execute: false,
          used_for_authority: false,
        },
      }],
      metrics: { duration_ms: 4 },
    });

    expect(parsed.llm_tool_candidates?.[0]?.authority_boundary).toEqual({
      candidate_only: true,
      may_execute: false,
      used_for_authority: false,
    });

    const failed = ExecuteFeedbackSchema.parse({
      command_id: "llm-timeout",
      status: "failed",
      error: "The provider request timed out.",
      llm_failure: {
        schema_version: "blue-tanuki.llm-failure.v1",
        kind: "timeout",
        retryable: true,
        provider: "fixture-provider",
        authority_boundary: { used_for_authority: false },
      },
      metrics: { duration_ms: 1 },
    });
    expect(failed.llm_failure?.kind).toBe("timeout");
  });

  it("rejects tool candidates or failure metadata that claim authority", () => {
    const candidate = ExecuteFeedbackSchema.safeParse({
      command_id: "llm-candidate",
      status: "success",
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-1",
        tool_name: "shell.exec",
        arguments: {},
        authority_boundary: {
          candidate_only: true,
          may_execute: true,
          used_for_authority: false,
        },
      }],
      metrics: { duration_ms: 1 },
    });
    const failure = ExecuteFeedbackSchema.safeParse({
      command_id: "llm-error",
      status: "failed",
      llm_failure: {
        schema_version: "blue-tanuki.llm-failure.v1",
        kind: "cancelled",
        retryable: false,
        authority_boundary: { used_for_authority: true },
      },
      metrics: { duration_ms: 1 },
    });
    expect(candidate.success).toBe(false);
    expect(failure.success).toBe(false);
  });

  it("accepts display-only Approval Gate Operation Core traces", () => {
    const parsed = OperationCoreApprovalTraceSchema.parse({
      version: "operation-core.v1",
      role: "approval_gate_trace",
      operation: "tool.shell.exec",
      state: "awaiting_permission",
      target: {
        kind: "runtime",
        id: "tool:shell.exec",
        scope: "shell_adapter",
      },
      effects: ["process_spawn"],
      permission: {
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
        hds_brain_authority_required: true,
        approval_gate_required: true,
      },
      adapter: "shell",
      runtime_boundary: "shell_adapter",
      adapter_is_authority: false,
      command_generated_by_adapter_only: true,
      raw_command_is_core_operation: false,
      adapter_result_used_for_authority: false,
      approval_trace_used_for_authority: false,
      hds_brain_authority_required: true,
      evidence_source: ["INTERNAL_STATE"],
    });

    expect(parsed.approval_trace_used_for_authority).toBe(false);
    expect(parsed.adapter).toBe("shell");
  });

  it("rejects Approval Gate traces that claim authority", () => {
    const result = OperationCoreApprovalTraceSchema.safeParse({
      version: "operation-core.v1",
      role: "approval_gate_trace",
      operation: "tool.shell.exec",
      state: "awaiting_permission",
      target: {
        kind: "runtime",
        id: "tool:shell.exec",
      },
      effects: ["process_spawn"],
      permission: {
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
        hds_brain_authority_required: true,
        approval_gate_required: true,
      },
      adapter: "shell",
      runtime_boundary: "shell_adapter",
      adapter_is_authority: false,
      command_generated_by_adapter_only: true,
      raw_command_is_core_operation: false,
      adapter_result_used_for_authority: false,
      approval_trace_used_for_authority: true,
      hds_brain_authority_required: true,
      evidence_source: ["INTERNAL_STATE"],
    });

    expect(result.success).toBe(false);
  });

  it("defines execution adapters without making shell the default runtime", () => {
    expect(OPERATION_ADAPTER_REGISTRY.internal_runtime).toMatchObject({
      default_runtime: true,
      adapter_is_authority: false,
      command_generation_location: "not_applicable",
    });
    expect(OPERATION_ADAPTER_REGISTRY.shell).toMatchObject({
      display_name: "ShellAdapter",
      runtime_boundary: "shell_adapter",
      default_runtime: false,
      adapter_is_authority: false,
      adapter_result_used_for_authority: false,
      command_generation_location: "execution_adapter_only",
    });
    expect(OPERATION_ADAPTER_REGISTRY.windows).toMatchObject({
      runtime_boundary: "os_adapter",
      command_generation_location: "execution_adapter_only",
    });
    expect(OPERATION_ADAPTER_REGISTRY.linux).toMatchObject({
      runtime_boundary: "os_adapter",
      command_generation_location: "execution_adapter_only",
    });
    expect(OPERATION_ADAPTER_REGISTRY.macos).toMatchObject({
      runtime_boundary: "os_adapter",
      command_generation_location: "execution_adapter_only",
    });
  });

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

  it("accepts display-only Operation Core execution projections", () => {
    const parsed = OperationCoreExecutionProjectionSchema.parse({
      schema_version: "operation-core.execution.v1",
      evidence_source: ["INTERNAL_STATE"],
      used_for_authority: false,
      adapter_result_used_for_authority: false,
      execution_history_used_for_authority: false,
      raw_payload_exposed: false,
      chain_valid: true,
      skipped_count: 0,
      entries_count: 1,
      displayed_count: 1,
      latest_results: [
        {
          index: 0,
          request_id: "req-1",
          command_id: "cmd-1",
          actor: "owner",
          source: "executor",
          timestamp: 12345,
          payload_digest: "payload-digest",
          entry_hash: "entry-hash",
          origin_channel: "webchat",
          status: "success",
          result_present: true,
          result_digest: "result-digest",
          error_present: false,
          error_digest: null,
          metrics: { duration_ms: 10 },
          command: {
            type: "tool_call",
            operation: "shell.exec",
            upstream_decision: "ASSERT",
            upstream_commit_hash: "commit-hash",
            constraints: {
              max_tokens: null,
              timeout_ms: 1000,
              allowed_tools: ["shell.exec"],
              allowed_capabilities: ["fs:read:workspace"],
            },
            payload: {
              tool_name: "shell.exec",
              argument_keys: ["cmd"],
              arguments_digest: "arguments-digest",
              messages_count: null,
              message_roles: [],
              content_chars: null,
            },
          },
          execution_trace: {
            version: "operation-core.v1",
            role: "execution_adapter_trace",
            operation: "tool.shell.exec",
            state: "succeeded",
            target: {
              kind: "runtime",
              id: "tool:shell.exec",
              scope: "shell_adapter",
            },
            effects: ["process_spawn"],
            permission: {
              risk: "high",
              approval_level: "L3_final_review",
              final_review_required: true,
              hds_brain_authority_required: true,
              approval_gate_required: true,
            },
            adapter: "shell",
            runtime_boundary: "shell_adapter",
            adapter_is_authority: false,
            command_generated_by_adapter_only: true,
            raw_command_is_core_operation: false,
            adapter_result_used_for_authority: false,
            executor_trace_used_for_authority: false,
            hds_brain_authority_required: true,
            evidence_source: ["INTERNAL_STATE"],
          },
          planner_output: {
            role: "planner_output_projection",
            status: "valid_plan",
            plan_id: "plan-1",
            request_id: "operation-request:req-1",
            state: "planned",
            steps_count: 1,
            step_summaries: [
              {
                step_id: "step-1",
                operation: "shell.exec",
                target_kind: "runtime",
                target_id_digest: "target-digest",
                effects: ["process_spawn"],
                adapter: "shell",
                adapter_is_authority: false,
                command_generated_by_adapter_only: true,
                approval_level: "L3_final_review",
                risk: "high",
                final_review_required: true,
              },
            ],
            raw_command_is_core_operation: false,
            planner_output_used_for_authority: false,
            hds_brain_authority_required: true,
            evidence_source: ["EXTERNAL_EVIDENCE", "INTERNAL_STATE"],
          },
          diff: {
            available: false,
            reason: "OperationDiff is not recorded for this execution yet",
            used_for_authority: false,
            evidence_source: ["INTERNAL_STATE"],
          },
          rollback: {
            available: false,
            reason: "Rollback plan is not recorded for this execution yet",
            used_for_authority: false,
            evidence_source: ["INTERNAL_STATE"],
          },
          operation_core: {
            role: "execution_result_projection",
            used_for_authority: false,
            adapter_result_used_for_authority: false,
            raw_payload_exposed: false,
            evidence_source: ["INTERNAL_STATE"],
          },
        },
      ],
    });

    expect(parsed.latest_results[0].operation_core.used_for_authority).toBe(false);
    expect(parsed.raw_payload_exposed).toBe(false);
  });

  it("rejects Operation Core execution projections that claim authority", () => {
    const result = OperationCoreExecutionProjectionSchema.safeParse({
      schema_version: "operation-core.execution.v1",
      evidence_source: ["INTERNAL_STATE"],
      used_for_authority: true,
      adapter_result_used_for_authority: false,
      execution_history_used_for_authority: false,
      raw_payload_exposed: false,
      chain_valid: true,
      skipped_count: 0,
      entries_count: 0,
      displayed_count: 0,
      latest_results: [],
    });

    expect(result.success).toBe(false);
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

  it("BT-U-D01.01-P validates OperationPlan steps through reviewed descriptors", () => {
    const parsed = OperationPlanSchema.parse({
      version: "operation-core.v1",
      plan_id: "plan-1",
      request_id: "request-1",
      state: "planned",
      steps: [
        {
          step_id: "step-shell",
          operation: "shell.exec",
          target: { kind: "workspace", id: "workspace:blue-tanuki" },
          state: "planned",
          effects: [
            "process_spawn",
            "read",
            "write",
            "delete",
            "external_send",
            "credential_access",
            "settings_change",
          ],
          permission: {
            risk: "high",
            approval_level: "L3_final_review",
            final_review_required: true,
            hds_brain_authority_required: true,
            approval_gate_required: true,
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

    const registry = inspectOperationPlanAdapterRegistry(parsed);

    expect(registry.kind).toBe("valid");
    if (registry.kind === "valid") {
      expect(registry.evidence).toMatchObject({
        default_runtime_adapter: "internal_runtime",
        shell_default_runtime: false,
        adapter_registry_used_for_authority: false,
        descriptor_registry_used_for_authority: false,
        steps: [
          {
            step_id: "step-shell",
            descriptor_version: "1.0.0",
            implementation_ref: "packages/blue-tanuki/src/tools/shell_exec.ts#shellExecTool",
            required_effects: [
              "process_spawn",
              "read",
              "write",
              "delete",
              "external_send",
              "credential_access",
              "settings_change",
            ],
            descriptor_registry_used_for_authority: false,
            adapter: "shell",
            runtime_boundary: "shell_adapter",
            command_generation_location: "execution_adapter_only",
          },
        ],
      });
    }
  });

  it("BT-U-D01.01-N rejects unknown operations, adapter mismatch, and lost effects", () => {
    const base = OperationPlanSchema.parse({
      version: "operation-core.v1",
      plan_id: "plan-descriptor-negative",
      request_id: "request-descriptor-negative",
      state: "planned",
      steps: [
        {
          step_id: "step-file-edit",
          operation: "file.edit",
          target: { kind: "file", id: "workspace:note.txt" },
          state: "planned",
          effects: ["read", "write"],
          permission: {
            risk: "medium",
            approval_level: "L2_operate",
            final_review_required: false,
            hds_brain_authority_required: true,
            approval_gate_required: true,
          },
          adapter: "internal_runtime",
          adapter_is_authority: false,
          command_generated_by_adapter_only: false,
        },
      ],
      rollback: { available: false },
      raw_command_policy: {
        raw_command_is_core_operation: false,
        command_generation_location: "not_applicable",
      },
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
    });
    const mutations = [
      { operation: "unreviewed.operation" },
      { adapter: "external_api" },
      { effects: ["write"] },
    ] as const;

    for (const mutation of mutations) {
      const candidate = {
        ...base,
        steps: [{ ...base.steps[0], ...mutation }],
      };
      const inspection = inspectOperationPlanAdapterRegistry(candidate);
      expect(inspection.kind).toBe("rejected");
    }
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
        "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": "operation-request:forged",
        "blue_tanuki.operation_core.used_for_authority": true,
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
        "blue_tanuki.operator_surface": "daily",
        "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": "operation-request:req-cron",
        "blue_tanuki.operation_core.projection_id": "operator:daily:operation-core",
        "blue_tanuki.operation_core.source_interface": "scheduler",
        "blue_tanuki.operation_core.used_for_authority": false,
        "blue_tanuki.operation_core.planner_output_used_for_authority": false,
        "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
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
      expect(parsed.request.metadata?.["blue_tanuki.operation_core.version"]).toBe("operation-core.v1");
      expect(parsed.request.metadata?.["blue_tanuki.operation_core.used_for_authority"]).toBe(false);
      expect(parsed.request.metadata?.["blue_tanuki.channel_send.target"]).toBe("local-user");
    }
  });
});
