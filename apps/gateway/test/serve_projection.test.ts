import { describe, expect, it } from "vitest";
import { CompleteHistoryStore } from "@blue-tanuki/hds-brain";
import { OperationPlanSchema } from "@blue-tanuki/protocol";
import {
  operationCorePlannerHistoryProjection,
  projectApprovalHistoryEntry,
  projectOperationCoreExecutionHistory,
} from "../src/serve_projection.js";

describe("Operation Core execution projection", () => {
  it("projects execution history as display-only digest metadata", () => {
    const history = new CompleteHistoryStore();
    history.append({
      kind: "execution_history",
      request_id: "req-1",
      command_id: "cmd-1",
      actor: "owner",
      source: "executor",
      timestamp: 12345,
      payload: {
        command: {
          type: "tool_call",
          operation: "shell.exec",
          upstream_decision: "ASSERT",
          upstream_commit_hash: "commit-hash",
          constraints: {
            allowed_tools: ["shell.exec"],
            allowed_capabilities: ["fs:read:workspace"],
            secret_constraint: "SECRET-CONSTRAINT",
          },
          payload: {
            tool_name: "shell.exec",
            argument_keys: ["cmd", "args"],
            arguments_digest: "argument-digest",
            raw_arguments: { cmd: "SECRET-RAW-COMMAND" },
          },
        },
        origin_channel: "webchat",
        status: "failed",
        result_present: true,
        result_digest: "result-digest",
        error: "SECRET-ERROR-DETAIL",
        metrics: { duration_ms: 12 },
        operation_core: {
          version: "operation-core.v1",
          role: "execution_adapter_trace",
          operation: "tool.shell.exec",
          state: "failed",
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
        operation_core_planner: {
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
        raw_result: "SECRET-RAW-RESULT",
      },
    });

    const projection = projectOperationCoreExecutionHistory(history.replay({ kind: "execution_history" }), {
      chain_valid: history.verify(),
      skipped_count: history.skippedCount(),
    });
    const text = JSON.stringify(projection);

    expect(projection).toMatchObject({
      schema_version: "operation-core.execution.v1",
      used_for_authority: false,
      adapter_result_used_for_authority: false,
      execution_history_used_for_authority: false,
      raw_payload_exposed: false,
      chain_valid: true,
      entries_count: 1,
      displayed_count: 1,
    });
    expect(projection.latest_results[0]).toMatchObject({
      request_id: "req-1",
      command_id: "cmd-1",
      status: "failed",
      result_digest: "result-digest",
      error_present: true,
      command: {
        type: "tool_call",
        operation: "shell.exec",
        payload: {
          tool_name: "shell.exec",
          argument_keys: ["cmd", "args"],
          arguments_digest: "argument-digest",
        },
      },
      execution_trace: {
        operation: "tool.shell.exec",
        adapter: "shell",
        runtime_boundary: "shell_adapter",
        adapter_is_authority: false,
        raw_command_is_core_operation: false,
        executor_trace_used_for_authority: false,
      },
      planner_output: {
        role: "planner_output_projection",
        plan_id: "plan-1",
        steps_count: 1,
        raw_command_is_core_operation: false,
        planner_output_used_for_authority: false,
      },
      diff: {
        available: false,
        used_for_authority: false,
      },
      rollback: {
        available: false,
        used_for_authority: false,
      },
    });
    expect(text).toContain("error_digest");
    expect(text).not.toContain("SECRET-RAW-COMMAND");
    expect(text).not.toContain("SECRET-RAW-RESULT");
    expect(text).not.toContain("SECRET-ERROR-DETAIL");
    expect(text).not.toContain("SECRET-CONSTRAINT");
  });

  it("extracts valid OperationPlan feedback into digest-only planner history projection", () => {
    const feedback = {
      command_id: "cmd-plan",
      status: "success" as const,
      result: {
        operation_core: {
          status: "valid_plan",
          plan: {
            version: "operation-core.v1",
            plan_id: "plan-secret-target",
            request_id: "operation-request:req-plan",
            state: "planned",
            steps: [
              {
                step_id: "step-1",
                operation: "file.search",
                target: {
                  kind: "workspace",
                  id: "SECRET-WORKSPACE-PATH",
                },
                state: "planned",
                effects: ["read"],
                permission: {
                  risk: "low",
                  approval_level: "L1_observe",
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
          },
        },
      },
      metrics: { duration_ms: 1 },
    };
    const projection = operationCorePlannerHistoryProjection(feedback);
    const text = JSON.stringify(projection);

    expect(projection).toMatchObject({
      role: "planner_output_projection",
      plan_id: "plan-secret-target",
      steps_count: 1,
      preparation: { status: "not_ready", may_execute: false, used_for_authority: false },
      planner_output_used_for_authority: false,
      step_summaries: [
        {
          operation: "file.search",
          target_kind: "workspace",
          adapter: "internal_runtime",
        },
      ],
    });
    expect(text).not.toContain("SECRET-WORKSPACE-PATH");
    expect(text).toContain("target_id_digest");

    const plan = OperationPlanSchema.parse(feedback.result.operation_core.plan);
    plan.steps[0]!.parameters = { query: "SECRET-ARGUMENT" };
    plan.steps[0]!.preparation = {
      depends_on: [], bindings: [], preconditions: [],
      validation: [{ check_id: "observed", target: plan.steps[0]!.target, method: "result_equals", expected: "SECRET-EXPECTED" }],
      compensation: { available: false, reason: "SECRET-COMPENSATION" },
    };
    const prepare = () => operationCorePlannerHistoryProjection({ ...feedback, result: { operation_core: {
      ...feedback.result.operation_core, plan, preparation: { status: "ready", may_execute: true },
    } } });
    const ready = prepare();
    expect(ready).toMatchObject({ preparation: { status: "ready", may_execute: false, used_for_authority: false } });
    expect(JSON.stringify(ready)).not.toContain("SECRET-");
    delete plan.steps[0]!.preparation;
    expect(prepare()).toMatchObject({ preparation: { status: "not_ready", may_execute: false } });
    plan.steps[0]!.operation = "review_project";
    expect(prepare()).toBeUndefined();
    plan.steps[0]!.operation = "file.search";
    plan.steps[0]!.effects = ["write"];
    expect(prepare()).toBeUndefined();
  });

  it("projects Approval Gate adapter traces as display-only metadata", () => {
    const history = new CompleteHistoryStore();
    const entry = history.append({
      kind: "approval_history",
      request_id: "req-approval",
      command_id: "cmd-approval",
      actor: "owner",
      source: "approval_runtime",
      timestamp: 12345,
      payload: {
        event: "approval_pending",
        decision: "ask",
        operation: "tool.shell.exec",
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
        reason: "no_matching_approval_grant",
        operation_core: {
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
        },
        raw_command: "SECRET-RAW-COMMAND",
      },
    });
    const projection = projectApprovalHistoryEntry(entry!);
    const text = JSON.stringify(projection);

    expect(projection).toMatchObject({
      event: "approval_pending",
      operation: "tool.shell.exec",
      used_for_authority: false,
      operation_core: {
        role: "approval_gate_trace",
        adapter: "shell",
        runtime_boundary: "shell_adapter",
        approval_trace_used_for_authority: false,
      },
    });
    expect(text).not.toContain("SECRET-RAW-COMMAND");
  });
});
