import type {
  OperationApprovalLevel,
  OperationCoreProjection,
  OperationRisk,
  OperationStep,
  OperationTarget,
} from "@blue-tanuki/protocol";
import { requireOperationDescriptor } from "@blue-tanuki/protocol";
import type { DailyApprovalLevel, DailyApprovalRisk, DailyOperationSpec } from "./types.js";

const SURFACE_SCOPE = "operator:daily";

function normalizeRisk(risk: DailyApprovalRisk): OperationRisk {
  return risk === "contextual" ? "medium" : risk;
}

function normalizeApprovalLevel(level: DailyApprovalLevel): OperationApprovalLevel {
  return level === "existing_channel_path" ? "L2_operate" : level;
}

function targetForDailyOperation(spec: DailyOperationSpec): OperationTarget {
  if (spec.kind.startsWith("google.") || spec.kind === "gmail.write") {
    return {
      kind: "external_service",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: spec.kind.startsWith("google.calendar") ? "google:calendar" : spec.kind.startsWith("google.drive") ? "google:drive" : "google:gmail",
    };
  }
  if (spec.kind.startsWith("schedule.")) {
    return {
      kind: "runtime",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: "runtime:schedule",
    };
  }
  return {
    kind: "runtime",
    id: `${SURFACE_SCOPE}:${spec.kind}`,
    display_name: spec.label,
    scope: SURFACE_SCOPE,
  };
}

function stepForDailyOperation(spec: DailyOperationSpec): OperationStep {
  const descriptor = requireOperationDescriptor(spec.kind);
  const approvalLevel = normalizeApprovalLevel(spec.approval_level);
  return {
    step_id: `${SURFACE_SCOPE}:${spec.kind}`,
    operation: spec.kind,
    target: targetForDailyOperation(spec),
    state: "planned",
    effects: [...descriptor.effects],
    permission: {
      risk: normalizeRisk(spec.approval_risk),
      approval_level: approvalLevel,
      final_review_required: spec.final_review_required,
      hds_brain_authority_required: true,
      approval_gate_required: spec.final_review_required || approvalLevel === "L3_final_review",
    },
    parameters: {
      downstream_tools: [...spec.downstream_tools],
      capabilities_count: spec.capabilities.length,
      audit_trace: [...spec.audit_trace],
      source_approval_level: spec.approval_level,
      source_approval_risk: spec.approval_risk,
    },
    adapter: descriptor.adapter,
    adapter_is_authority: false,
    command_generated_by_adapter_only: false,
  };
}

export function buildDailyOperationCoreProjection(
  operations: readonly DailyOperationSpec[],
): OperationCoreProjection {
  return {
    version: "operation-core.v1",
    projection_id: "operator:daily:operation-core",
    source_surface: "daily",
    state: "planned",
    steps: operations.map(stepForDailyOperation),
    raw_command_policy: {
      raw_command_is_core_operation: false,
      command_generation_location: "not_applicable",
    },
    hds_brain_authority_required: true,
    planner_output_used_for_authority: false,
    ui_projection_used_for_authority: false,
    adapter_result_used_for_authority: false,
  };
}
