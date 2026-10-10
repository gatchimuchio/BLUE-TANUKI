import type {
  OperationApprovalLevel,
  OperationCoreProjection,
  OperationRisk,
  OperationStep,
  OperationTarget,
} from "@blue-tanuki/protocol";
import { requireOperationDescriptor } from "@blue-tanuki/protocol";
import type { DeveloperOperationSpec } from "./types.js";

const SURFACE_SCOPE = "operator:developer";

function targetForDeveloperOperation(spec: DeveloperOperationSpec): OperationTarget {
  if (spec.kind.startsWith("file.")) {
    return {
      kind: "file",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: SURFACE_SCOPE,
    };
  }
  if (spec.kind.startsWith("github.")) {
    return {
      kind: "repository",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: "github",
    };
  }
  if (spec.kind.startsWith("browser.")) {
    return {
      kind: "browser",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: "browser:preview",
    };
  }
  if (spec.kind === "shell.exec") {
    return {
      kind: "workspace",
      id: `${SURFACE_SCOPE}:${spec.kind}`,
      display_name: spec.label,
      scope: SURFACE_SCOPE,
    };
  }
  return {
    kind: "runtime",
    id: `${SURFACE_SCOPE}:${spec.kind}`,
    display_name: spec.label,
    scope: SURFACE_SCOPE,
  };
}

function stepForDeveloperOperation(spec: DeveloperOperationSpec): OperationStep {
  const descriptor = requireOperationDescriptor(spec.kind);
  const shellBacked = descriptor.adapter === "shell";
  return {
    step_id: `${SURFACE_SCOPE}:${spec.kind}`,
    operation: spec.kind,
    target: targetForDeveloperOperation(spec),
    state: "planned",
    effects: [...descriptor.effects],
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
      preview: spec.preview,
      disabled_by_default: spec.disabled_by_default,
    },
    adapter: descriptor.adapter,
    adapter_is_authority: false,
    command_generated_by_adapter_only: shellBacked,
  };
}

export function buildDeveloperOperationCoreProjection(
  operations: readonly DeveloperOperationSpec[],
): OperationCoreProjection {
  return {
    version: "operation-core.v1",
    projection_id: "operator:developer:operation-core",
    source_surface: "developer",
    state: "planned",
    steps: operations.map(stepForDeveloperOperation),
    raw_command_policy: {
      raw_command_is_core_operation: false,
      command_generation_location: "execution_adapter_only",
    },
    hds_brain_authority_required: true,
    planner_output_used_for_authority: false,
    ui_projection_used_for_authority: false,
    adapter_result_used_for_authority: false,
  };
}
