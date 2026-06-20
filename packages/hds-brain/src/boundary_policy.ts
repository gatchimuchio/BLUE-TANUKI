import type { ApprovalLevel, ApprovalRisk } from "./approval_policy.js";

export const HDS_BOUNDARY_POLICY_VERSION = "phase12-s0-boundary-v1";

export type BoundaryReferenceSource =
  | "memory"
  | "complete_history"
  | "session"
  | "tool_result"
  | "llm_output"
  | "channel_metadata"
  | "plugin_metadata"
  | "external_metadata"
  | "audit_viewer"
  | "control_center";

export type BoundaryRequestedUse =
  | "reference"
  | "audit_evidence"
  | "authority_decision"
  | "risk_classification"
  | "approval_substitution"
  | "privilege_escalation"
  | "final_review_bypass"
  | "policy_update";

export type BoundaryUpdateTarget = "policy" | "detector" | "approval" | "history";
export type UnknownEscalationReason =
  | "unknown_operation"
  | "ambiguous_operation"
  | "unclassified_capability"
  | "missing_tool_capability"
  | "policy_version_mismatch"
  | "history_reference_ambiguity"
  | "approval_grant_ambiguity"
  | "external_metadata_conflict"
  | "detector_conflict"
  | "detector_unknown_pattern";

export interface BoundaryEvaluation {
  policy_version: typeof HDS_BOUNDARY_POLICY_VERSION;
  allowed: boolean;
  decision: "allow_reference" | "ask" | "suspend" | "deny";
  risk: ApprovalRisk;
  approval_level: ApprovalLevel;
  used_for_authority: false;
  reason: string;
}

export interface FailSafeInput {
  hds_available: boolean;
  policy_valid: boolean;
  audit_chain_valid: boolean;
  runtime_invariants_valid: boolean;
  runtime_health_observed: boolean;
  approval_gate_available: boolean;
  memory_chain_valid?: boolean;
}

export interface TrinityMClosureInput {
  x_defined: boolean;
  r_defined: boolean;
  m_defined: boolean;
}

export const TRINITY_M_POLICY_MODEL = {
  version: HDS_BOUNDARY_POLICY_VERSION,
  x: "request, actor, process, target scope, log scope",
  r: "frame/model/detector relations and declared downstream command envelope",
  m: [
    "identity rules",
    "boundary conditions",
    "judgement rules",
    "log rules",
    "suspend rules",
  ],
} as const;

const AUTHORITY_CONVERSION_USES = new Set<BoundaryRequestedUse>([
  "authority_decision",
  "risk_classification",
  "approval_substitution",
  "privilege_escalation",
  "final_review_bypass",
  "policy_update",
]);

export function evaluateReferenceBoundary(
  source: BoundaryReferenceSource,
  requested_use: BoundaryRequestedUse,
): BoundaryEvaluation & { source: BoundaryReferenceSource; requested_use: BoundaryRequestedUse } {
  if (!AUTHORITY_CONVERSION_USES.has(requested_use)) {
    return {
      policy_version: HDS_BOUNDARY_POLICY_VERSION,
      source,
      requested_use,
      allowed: true,
      decision: "allow_reference",
      risk: "low",
      approval_level: "L1_observe",
      used_for_authority: false,
      reason: `${source}:reference_only`,
    };
  }
  return {
    policy_version: HDS_BOUNDARY_POLICY_VERSION,
    source,
    requested_use,
    allowed: false,
    decision: "suspend",
    risk: "high",
    approval_level: "L3_final_review",
    used_for_authority: false,
    reason: `${source}:authority_conversion_forbidden:${requested_use}`,
  };
}

export function evaluateUnknownEscalation(reason: UnknownEscalationReason): BoundaryEvaluation & {
  reason_code: UnknownEscalationReason;
  auto_allow: false;
} {
  return {
    policy_version: HDS_BOUNDARY_POLICY_VERSION,
    reason_code: reason,
    auto_allow: false,
    allowed: false,
    decision: "suspend",
    risk: "high",
    approval_level: "L3_final_review",
    used_for_authority: false,
    reason: `unknown_must_escalate:${reason}`,
  };
}

export function evaluateFailSafeBoundary(input: FailSafeInput): BoundaryEvaluation & {
  failed_preconditions: Array<keyof FailSafeInput>;
  command_execution_allowed: boolean;
  downstream_execution_allowed: boolean;
} {
  const failed = Object.entries(input)
    .filter(([, ok]) => ok === false)
    .map(([key]) => key as keyof FailSafeInput);
  if (failed.length === 0) {
    return {
      policy_version: HDS_BOUNDARY_POLICY_VERSION,
      failed_preconditions: failed,
      allowed: true,
      decision: "allow_reference",
      risk: "low",
      approval_level: "L1_observe",
      used_for_authority: false,
      reason: "hds_fail_safe:healthy",
      command_execution_allowed: true,
      downstream_execution_allowed: true,
    };
  }
  return {
    policy_version: HDS_BOUNDARY_POLICY_VERSION,
    failed_preconditions: failed,
    allowed: false,
    decision: "suspend",
    risk: "high",
    approval_level: "L3_final_review",
    used_for_authority: false,
    reason: `hds_fail_safe:suspend:${failed.join(",")}`,
    command_execution_allowed: false,
    downstream_execution_allowed: false,
  };
}

export function classifyBoundaryUpdate(target: BoundaryUpdateTarget): BoundaryEvaluation & {
  target: BoundaryUpdateTarget;
  final_review_required: true;
} {
  return {
    policy_version: HDS_BOUNDARY_POLICY_VERSION,
    target,
    allowed: false,
    decision: "ask",
    risk: "high",
    approval_level: "L3_final_review",
    used_for_authority: false,
    final_review_required: true,
    reason: `${target}:update_requires_l3_final_review`,
  };
}

export function evaluateTrinityMClosure(input: TrinityMClosureInput): BoundaryEvaluation & {
  missing: Array<"X" | "R" | "M">;
} {
  const missing: Array<"X" | "R" | "M"> = [];
  if (!input.x_defined) missing.push("X");
  if (!input.r_defined) missing.push("R");
  if (!input.m_defined) missing.push("M");
  if (missing.length === 0) {
    return {
      policy_version: HDS_BOUNDARY_POLICY_VERSION,
      missing,
      allowed: true,
      decision: "allow_reference",
      risk: "low",
      approval_level: "L1_observe",
      used_for_authority: false,
      reason: "trinity_m:closed",
    };
  }
  return {
    policy_version: HDS_BOUNDARY_POLICY_VERSION,
    missing,
    allowed: false,
    decision: "suspend",
    risk: "high",
    approval_level: "L3_final_review",
    used_for_authority: false,
    reason: `trinity_m:suspend_missing:${missing.join(",")}`,
  };
}
