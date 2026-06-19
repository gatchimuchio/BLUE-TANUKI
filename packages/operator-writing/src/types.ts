import type { OperationCoreProjection, ToolCapability } from "@blue-tanuki/protocol";

export type WritingOperationKind =
  | "draft.in_memory"
  | "proofread.in_memory"
  | "summarize.in_memory"
  | "translate.in_memory"
  | "file.read"
  | "file.write"
  | "file.edit"
  | "gmail.write"
  | "google.drive.write";

export type WritingApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review";

export type WritingApprovalRisk = "low" | "medium" | "high";

export interface WritingOperationSpec {
  kind: WritingOperationKind;
  label: string;
  approval_level: WritingApprovalLevel;
  approval_risk: WritingApprovalRisk;
  final_review_required: boolean;
  downstream_tools: readonly string[];
  capabilities: readonly ToolCapability[];
  audit_trace: readonly string[];
}

export interface WritingSurfaceSnapshot {
  surface: "writing";
  layer: "A";
  status: "enabled";
  authority: "hds_brain_downstream_device";
  replaces_authority: false;
  raw_authority_added: false;
  operations: readonly WritingOperationSpec[];
  operation_core_projection: OperationCoreProjection;
  next_recommended_action: string;
}

export interface WritingInvocation {
  operation: WritingOperationKind;
  input_digest: string;
  source: "prompt" | "selected_file" | "provided_text";
  target?: string;
}
