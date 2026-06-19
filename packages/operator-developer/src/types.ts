import type { OperationCoreProjection, ToolCapability } from "@blue-tanuki/protocol";

export type DeveloperOperationKind =
  | "file.read"
  | "file.write"
  | "file.edit"
  | "github.read"
  | "github.write"
  | "browser.snapshot"
  | "browser.automation"
  | "shell.exec";

export type DeveloperApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review";

export type DeveloperApprovalRisk = "low" | "medium" | "high";

export interface DeveloperOperationSpec {
  kind: DeveloperOperationKind;
  label: string;
  approval_level: DeveloperApprovalLevel;
  approval_risk: DeveloperApprovalRisk;
  final_review_required: boolean;
  preview: boolean;
  disabled_by_default: boolean;
  downstream_tools: readonly string[];
  capabilities: readonly ToolCapability[];
  audit_trace: readonly string[];
}

export interface DeveloperBrowserPreviewBoundary {
  status: "preview_disabled_by_default";
  enable_env: "BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW";
  promoted_to_first_party: false;
}

export interface DeveloperSurfaceSnapshot {
  surface: "developer";
  layer: "A";
  status: "enabled";
  authority: "hds_brain_downstream_device";
  replaces_authority: false;
  raw_authority_added: false;
  browser_preview: DeveloperBrowserPreviewBoundary;
  operations: readonly DeveloperOperationSpec[];
  operation_core_projection: OperationCoreProjection;
  next_recommended_action: string;
}

export interface DeveloperInvocation {
  operation: DeveloperOperationKind;
  input_digest: string;
  source: "prompt" | "selected_file" | "repository_context";
  target?: string;
}
