import { describe, expect, it } from "vitest";
import { CompleteHistoryStore, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { OperationPlanSchema } from "@blue-tanuki/protocol";
import {
  operationCorePlannerHistoryProjection,
  projectApprovalHistoryEntry,
  projectOperationCoreExecutionHistory,
  projectOperationPlanStatus,
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

  it("exposes only a valid content-review digest in approval history", () => {
    const history = new CompleteHistoryStore();
    const entry = history.append({
      kind: "approval_history",
      request_id: "req-review",
      command_id: "cmd-review",
      actor: "owner",
      source: "approval_runtime",
      timestamp: 12345,
      payload: {
        event: "human_resume_approved",
        content_review_digest: "c".repeat(64),
        body_text: "SECRET-EMAIL-BODY",
      },
    });
    const projection = projectApprovalHistoryEntry(entry!);

    expect(projection.content_review_digest).toBe("c".repeat(64));
    expect(JSON.stringify(projection)).not.toContain("SECRET-EMAIL-BODY");
    expect(projectApprovalHistoryEntry({
      ...entry!,
      payload: { event: "human_resume_approved", content_review_digest: "invalid" },
    }).content_review_digest).toBeUndefined();
  });

  it("projects versioned J plan and outcome-unknown state without content or authority", () => {
    const projection = projectOperationPlanStatus({
      schema_version: "operation-plan-projection.v1",
      used_for_authority: false,
      raw_payload_exposed: false,
      plans: [{
        plan_id: "a".repeat(64),
        owner_identity_digest: "7".repeat(64),
        channel_identity_digest: operationPlanDigest("telegram"),
        request_id: "SECRET-REQUEST-ID",
        goal: "SECRET-GOAL",
        revision: 2,
        revision_digest: "b".repeat(64),
        status: "awaiting_step_review",
        goal_purpose_relation: { status: "unverified", candidate_outcome: "supports", candidate_status: "present",
          evidence_status: "exact_spans_present", evidence_count: 1, semantic_assessment_status: "not_assessed",
          record_digest: "5".repeat(64), used_for_authority: false, may_execute: false },
        recovery_hold_reason: "held_unobserved",
        recovery_hold_scope_relation: "collateral",
        steps: [{
          step_id: "c".repeat(64), operation: "gmail.write", definition_digest: "d".repeat(64),
          status: "outcome_unknown", external_receipt_observation: "not_recorded",
          parameters: { to: "SECRET-RECIPIENT", body_text: "SECRET-BODY" },
        }],
        bindings: [{
          step_id: "c".repeat(64), command_id: "SECRET-COMMAND-ID", command_digest: "e".repeat(64),
          status: "outcome_unknown", result_digest: "f".repeat(64), delivery_digest: "1".repeat(64),
          payload_digest: "SECRET-PAYLOAD-DIGEST", memory_status: "not_recorded",
        }],
      }],
    });
    const text = JSON.stringify(projection);
    expect(projection).toMatchObject({
      schema_version: "operation-plan.status.v1", evidence_source: ["INTERNAL_STATE"],
      used_for_authority: false, raw_payload_exposed: false, status: "available",
      recovery_refresh_status: "ready",
      plan_count: 1, displayed_count: 1,
      plans: [{ revision: 2, revision_digest: "b".repeat(64), owner_authentication_required: true,
        owner_reauthentication_binding: { owner_identity_digest: "7".repeat(64),
          channel_identity_digest: operationPlanDigest("telegram") }, goal_purpose_relation: {
        status: "unverified", candidate_outcome: "supports", candidate_status: "present",
        evidence_status: "exact_spans_present", evidence_count: 1, semantic_assessment_status: "not_assessed",
        record_digest: "5".repeat(64), used_for_authority: false, may_execute: false,
      }, steps: [{
        operation: "gmail.write", status: "outcome_unknown", external_receipt_observation: "not_recorded",
        binding: { command_digest: "e".repeat(64), result_digest: "f".repeat(64), delivery_digest: "1".repeat(64) },
      }], recovery_hold_reason: "held_unobserved", recovery_hold_scope_relation: "collateral" }],
    });
    for (const secret of ["SECRET-REQUEST-ID", "SECRET-GOAL", "SECRET-RECIPIENT", "SECRET-BODY", "SECRET-COMMAND-ID", "SECRET-PAYLOAD-DIGEST"]) {
      expect(text).not.toContain(secret);
    }

    const observed = projectOperationPlanStatus({
      schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false,
      plans: [{ plan_id: "a".repeat(64), owner_identity_digest: "7".repeat(64),
        channel_identity_digest: operationPlanDigest("webchat"), revision: 2, revision_digest: "b".repeat(64), status: "awaiting_step_review",
        steps: [{ step_id: "c".repeat(64), definition_digest: "d".repeat(64), operation: "gmail.write",
          status: "outcome_unknown", external_receipt_observation: "matched", external_receipt: {
            source: "local_inspection", match_count: 1, evidence_digest: "e".repeat(64), receipt_digest: "f".repeat(64),
            observed_at_ms: 1_800_000_000_000, used_for_authority: false, raw_receipt_exposed: false,
          } }], bindings: [] }],
    });
    expect(observed).toMatchObject({ status: "available", used_for_authority: false, plans: [{ owner_authentication_required: false, steps: [{
      status: "outcome_unknown", external_receipt_observation: "matched", external_receipt: {
        source: "local_inspection", match_count: 1, evidence_digest: "e".repeat(64), receipt_digest: "f".repeat(64),
      },
    }] }] });
    expect(projectOperationPlanStatus({
      schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false,
      recovery_refresh_status: "pending", plans: [],
    })).toMatchObject({ status: "available", recovery_refresh_status: "pending", plan_count: 0 });
    expect(projectOperationPlanStatus({
      schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false,
      recovery_refresh_status: "unknown", plans: [],
    })).toMatchObject({ status: "unavailable", recovery_refresh_status: "unavailable", plans: [] });
    expect(projectOperationPlanStatus({
      schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false,
      plans: [{ plan_id: "a".repeat(64), revision: 2, revision_digest: "b".repeat(64), status: "awaiting_step_review",
        steps: [{ step_id: "c".repeat(64), definition_digest: "d".repeat(64), operation: "gmail.write",
          status: "outcome_unknown", external_receipt_observation: "matched", external_receipt: {
            source: "local_inspection", match_count: 1, evidence_digest: "e".repeat(64), receipt_digest: "f".repeat(64),
            observed_at_ms: 1_800_000_000_000, used_for_authority: true, raw_receipt_exposed: false,
          } }], bindings: [] }],
    })).toMatchObject({ status: "unavailable", plans: [] });

    expect(projectOperationPlanStatus({ schema_version: "operation-plan-projection.v1", used_for_authority: true,
      raw_payload_exposed: false, plans: [] })).toMatchObject({ status: "unavailable", plans: [] });
    expect(projectOperationPlanStatus({ schema_version: "operation-plan-projection.v1", used_for_authority: false,
      raw_payload_exposed: false, plans: [{ plan_id: "a".repeat(64), revision: 1, revision_digest: "b".repeat(64),
        goal_purpose_relation: { status: "unverified", candidate_outcome: "supports", candidate_status: "present",
          evidence_status: "exact_spans_present", evidence_count: 1, semantic_assessment_status: "not_assessed",
          record_digest: "5".repeat(64), used_for_authority: false, may_execute: true },
        status: "awaiting_step_review", recovery_hold_reason: "raw-state", steps: [], bindings: [] }] }))
      .toMatchObject({ status: "unavailable", plans: [] });
    expect(projectOperationPlanStatus({ schema_version: "operation-plan-projection.v1", used_for_authority: false,
      raw_payload_exposed: false, plans: [{ plan_id: "a".repeat(64), revision: 1, revision_digest: "b".repeat(64),
        status: "awaiting_step_review", recovery_hold_reason: "held_unverified", recovery_hold_scope_relation: "raw-state",
        steps: [], bindings: [] }] })).toMatchObject({ status: "unavailable", plans: [] });
    expect(projectOperationPlanStatus({ schema_version: "operation-plan-projection.v1", used_for_authority: false,
      raw_payload_exposed: false, plans: [{ plan_id: "a".repeat(64), revision: 1, revision_digest: "b".repeat(64),
        status: "awaiting_step_review", recovery_hold_scope_relation: "requested", steps: [], bindings: [] }] }))
      .toMatchObject({ status: "unavailable", plans: [] });
  });
});
