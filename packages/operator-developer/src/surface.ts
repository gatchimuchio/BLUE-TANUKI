import type { DeveloperOperationKind, DeveloperOperationSpec, DeveloperSurfaceSnapshot } from "./types.js";
import { buildDeveloperOperationCoreProjection } from "./operation_core.js";

export const DEVELOPER_SURFACE_NAME = "developer" as const;

export const DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS = [
  "tool:file.search",
  "fs:read",
  "tool:file.write",
  "tool:file.edit",
  "fs:write",
  "tool:github.read",
  "tool:github.write",
  "network:github.com",
  "secrets:GITHUB_TOKEN",
  "github:issue.write",
  "github:pr.write",
  "github:comment.write",
  "tool:browser.snapshot",
  "tool:browser.automation",
  "browser:snapshot",
  "browser:act",
  "network:http",
  "tool:shell.exec",
  "shell:exec",
] as const;

export const DEVELOPER_OPERATION_SPECS: readonly DeveloperOperationSpec[] = [
  {
    kind: "file.read",
    label: "Read owner-selected local files through existing tools",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    preview: false,
    disabled_by_default: false,
    downstream_tools: ["file.search"],
    capabilities: ["tool:file.search", "fs:read"],
    audit_trace: ["surface", "downstream_tool_name", "path_metadata"],
  },
  {
    kind: "github.read",
    label: "Read GitHub repository or issue context through existing tools",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    preview: false,
    disabled_by_default: false,
    downstream_tools: ["github.read"],
    capabilities: ["tool:github.read", "network:github.com", "secrets:GITHUB_TOKEN"],
    audit_trace: ["surface", "downstream_tool_name", "external_target_summary"],
  },
  {
    kind: "file.write",
    label: "Write sandboxed local file through existing tools",
    approval_level: "L2_operate",
    approval_risk: "medium",
    final_review_required: false,
    preview: false,
    disabled_by_default: false,
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
    preview: false,
    disabled_by_default: false,
    downstream_tools: ["file.edit"],
    capabilities: ["tool:file.edit", "fs:write"],
    audit_trace: ["surface", "downstream_tool_name", "path_metadata", "approval_level"],
  },
  {
    kind: "browser.snapshot",
    label: "Capture browser state through disabled-by-default preview tooling",
    approval_level: "L2_operate",
    approval_risk: "medium",
    final_review_required: false,
    preview: true,
    disabled_by_default: true,
    downstream_tools: ["browser.snapshot"],
    capabilities: ["tool:browser.snapshot", "browser:snapshot", "network:http"],
    audit_trace: ["surface", "downstream_tool_name", "target_origin", "approval_level"],
  },
  {
    kind: "github.write",
    label: "Mutate GitHub issue, PR, or comment state through existing tool",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    preview: false,
    disabled_by_default: false,
    downstream_tools: ["github.write"],
    capabilities: ["tool:github.write", "network:github.com", "secrets:GITHUB_TOKEN", "github:issue.write", "github:pr.write", "github:comment.write"],
    audit_trace: ["surface", "downstream_tool_name", "external_target_summary", "final_review_result"],
  },
  {
    kind: "browser.automation",
    label: "Run browser automation through disabled-by-default preview tooling",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    preview: true,
    disabled_by_default: true,
    downstream_tools: ["browser.automation"],
    capabilities: ["tool:browser.automation", "browser:act", "network:http"],
    audit_trace: ["surface", "downstream_tool_name", "target_origin", "final_review_result"],
  },
  {
    kind: "shell.exec",
    label: "Execute shell command through existing final-review guarded tool",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    preview: false,
    disabled_by_default: false,
    downstream_tools: ["shell.exec"],
    capabilities: ["tool:shell.exec", "shell:exec"],
    audit_trace: ["surface", "downstream_tool_name", "command_digest", "final_review_result"],
  },
] as const;

export function getDeveloperOperationSpec(kind: DeveloperOperationKind): DeveloperOperationSpec {
  const spec = DEVELOPER_OPERATION_SPECS.find((operation) => operation.kind === kind);
  if (!spec) throw new Error(`unknown Developer Operator operation: ${kind}`);
  return spec;
}

export function getDeveloperSurfaceSnapshot(): DeveloperSurfaceSnapshot {
  return {
    surface: DEVELOPER_SURFACE_NAME,
    layer: "A",
    status: "enabled",
    authority: "hds_brain_downstream_device",
    replaces_authority: false,
    raw_authority_added: false,
    browser_preview: {
      status: "preview_disabled_by_default",
      enable_env: "BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW",
      promoted_to_first_party: false,
    },
    operations: DEVELOPER_OPERATION_SPECS,
    operation_core_projection: buildDeveloperOperationCoreProjection(DEVELOPER_OPERATION_SPECS),
    next_recommended_action: "Use existing HDS-BRAIN decision, Approval Gate, audit, and downstream developer tools for code work.",
  };
}
