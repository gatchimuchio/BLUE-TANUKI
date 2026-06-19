import type { WritingOperationKind, WritingOperationSpec, WritingSurfaceSnapshot } from "./types.js";
import { buildWritingOperationCoreProjection } from "./operation_core.js";

export const WRITING_SURFACE_NAME = "writing" as const;

export const WRITING_OPERATOR_REQUIRED_PERMISSIONS = [
  "tool:file.search",
  "fs:read",
  "tool:file.write",
  "tool:file.edit",
  "fs:write",
  "tool:gmail.write",
  "tool:google.drive.write",
  "network:googleapis.com",
  "secrets:GOOGLE_ACCESS_TOKEN",
  "secrets:GMAIL_ACCESS_TOKEN",
  "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
  "google:gmail.write",
  "google:drive.write",
  "external:send",
  "email:send",
] as const;

export const WRITING_OPERATION_SPECS: readonly WritingOperationSpec[] = [
  {
    kind: "draft.in_memory",
    label: "Draft text in memory",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["llm_call"],
    capabilities: [],
    audit_trace: ["surface", "source_type", "llm_input_digest", "llm_output_digest"],
  },
  {
    kind: "proofread.in_memory",
    label: "Proofread owner-provided text",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["llm_call"],
    capabilities: [],
    audit_trace: ["surface", "source_type", "llm_input_digest", "llm_output_digest"],
  },
  {
    kind: "summarize.in_memory",
    label: "Summarize owner-provided text",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["llm_call"],
    capabilities: [],
    audit_trace: ["surface", "source_type", "llm_input_digest", "llm_output_digest"],
  },
  {
    kind: "translate.in_memory",
    label: "Translate owner-provided text",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["llm_call"],
    capabilities: [],
    audit_trace: ["surface", "source_type", "llm_input_digest", "llm_output_digest"],
  },
  {
    kind: "file.read",
    label: "Read owner-selected local file through existing tools",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["file.search"],
    capabilities: ["tool:file.search", "fs:read"],
    audit_trace: ["surface", "source_type", "downstream_tool_name", "path_metadata"],
  },
  {
    kind: "file.write",
    label: "Write sandboxed local file through existing tools",
    approval_level: "L2_operate",
    approval_risk: "medium",
    final_review_required: false,
    downstream_tools: ["file.write"],
    capabilities: ["tool:file.write", "fs:write"],
    audit_trace: ["surface", "downstream_tool_name", "path_metadata", "approval_level"],
  },
  {
    kind: "file.edit",
    label: "Edit sandboxed local file through existing tools",
    approval_level: "L2_operate",
    approval_risk: "medium",
    final_review_required: false,
    downstream_tools: ["file.edit"],
    capabilities: ["tool:file.edit", "fs:write"],
    audit_trace: ["surface", "downstream_tool_name", "path_metadata", "approval_level"],
  },
  {
    kind: "gmail.write",
    label: "Prepare Gmail external write through existing tool",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["gmail.write"],
    capabilities: ["tool:gmail.write", "network:googleapis.com", "secrets:GMAIL_ACCESS_TOKEN", "google:gmail.write", "external:send", "email:send"],
    audit_trace: ["surface", "downstream_tool_name", "external_target_summary", "final_review_result"],
  },
  {
    kind: "google.drive.write",
    label: "Prepare Google Drive external write through existing tool",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["google.drive.write"],
    capabilities: ["tool:google.drive.write", "network:googleapis.com", "secrets:GOOGLE_DRIVE_ACCESS_TOKEN", "google:drive.write"],
    audit_trace: ["surface", "downstream_tool_name", "external_target_summary", "final_review_result"],
  },
] as const;

export function getWritingOperationSpec(kind: WritingOperationKind): WritingOperationSpec {
  const spec = WRITING_OPERATION_SPECS.find((operation) => operation.kind === kind);
  if (!spec) throw new Error(`unknown Writing Operator operation: ${kind}`);
  return spec;
}

export function getWritingSurfaceSnapshot(): WritingSurfaceSnapshot {
  return {
    surface: WRITING_SURFACE_NAME,
    layer: "A",
    status: "enabled",
    authority: "hds_brain_downstream_device",
    replaces_authority: false,
    raw_authority_added: false,
    operations: WRITING_OPERATION_SPECS,
    operation_core_projection: buildWritingOperationCoreProjection(WRITING_OPERATION_SPECS),
    next_recommended_action: "Use existing HDS-BRAIN decision, Approval Gate, and downstream tools for writing tasks.",
  };
}
