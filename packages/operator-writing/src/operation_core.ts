import type {
  OperationAdapterKind,
  OperationApprovalLevel,
  OperationCoreProjection,
  OperationEffect,
  OperationRisk,
  OperationStep,
  OperationTarget,
} from "@blue-tanuki/protocol";
import type { WritingOperationSpec } from "./types.js";

const SURFACE_SCOPE = "operator:writing";

function targetForWritingOperation(spec: WritingOperationSpec): OperationTarget {
  if (spec.kind.startsWith("file.")) {
    return {
      kind: "file",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: SURFACE_SCOPE,
    };
  }
  if (spec.kind === "gmail.write") {
    return {
      kind: "external_service",
      id: `${SURFACE_SCOPE}:gmail`,
      display_name: spec.label,
      scope: "google:gmail",
    };
  }
  if (spec.kind === "google.drive.write") {
    return {
      kind: "external_service",
      id: `${SURFACE_SCOPE}:google-drive`,
      display_name: spec.label,
      scope: "google:drive",
    };
  }
  return {
    kind: "runtime",
    id: `${SURFACE_SCOPE}:${spec.kind}`,
    display_name: spec.label,
    scope: SURFACE_SCOPE,
  };
}

function effectsForWritingOperation(spec: WritingOperationSpec): OperationEffect[] {
  if (spec.kind === "file.read") return ["read"];
  if (spec.kind === "file.write" || spec.kind === "file.edit" || spec.kind === "google.drive.write") return ["write"];
  if (spec.kind === "gmail.write") return ["external_send"];
  return ["observe"];
}

function adapterForWritingOperation(spec: WritingOperationSpec): OperationAdapterKind {
  if (spec.kind === "gmail.write" || spec.kind === "google.drive.write") return "external_api";
  return "internal_runtime";
}

function stepForWritingOperation(spec: WritingOperationSpec): OperationStep {
  return {
    step_id: `${SURFACE_SCOPE}:${spec.kind}`,
    operation: spec.kind,
    target: targetForWritingOperation(spec),
    state: "planned",
    effects: effectsForWritingOperation(spec),
    permission: {
      risk: spec.approval_risk as OperationRisk,
      approval_level: spec.approval_level as OperationApprovalLevel,
      final_review_required: spec.final_review_required,
      hds_brain_authority_required: true,
      approval_gate_required: spec.final_review_required || spec.approval_level === "L3_final_review",
    },
    parameters: {
      downstream_tools: [...spec.downstream_tools],
      capabilities_count: spec.capabilities.length,
      audit_trace: [...spec.audit_trace],
    },
    adapter: adapterForWritingOperation(spec),
    adapter_is_authority: false,
    command_generated_by_adapter_only: false,
  };
}

export function buildWritingOperationCoreProjection(
  operations: readonly WritingOperationSpec[],
): OperationCoreProjection {
  return {
    version: "operation-core.v1",
    projection_id: "operator:writing:operation-core",
    source_surface: "writing",
    state: "planned",
    steps: operations.map(stepForWritingOperation),
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
