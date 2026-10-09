import type { CommandConstraints, Decision, ExecuteCommand, ExecuteFeedback, OperationRequest } from "@blue-tanuki/protocol";
import type { OutputAuditLog } from "./output_audit.js";
import type { RuntimeInvariantEvidenceReport, RuntimeInvariantValues } from "./runtime_invariants.js";
import type { ApprovalEvaluation } from "./approval_policy.js";
import type { DetectorLifecycleTrace } from "./detectors/types.js";
import type { HDSBrainHealth } from "./health.js";
import type { ReadonlyGoalProjection } from "./goal_projection.js";
import type { ReadonlyGoalRelationTreeView } from "./goal_relations.js";
import type { ReadonlyGoalGovernanceProjection } from "./goal_governance.js";

/**
 * Output of the F (Frame) phase.
 * Establishes the goal, protected values, world closure W=(X,R,M),
 * and which problem_definition this request maps to (selects the policy).
 */
export type ActorKind = "owner" | "user" | "system" | "webhook" | "cron";
export type TrustLevel = "owner" | "trusted" | "limited" | "untrusted";
export type ProcessKind = "chat" | "tool" | "approval" | "cron" | "webhook" | "system";
export type MemorySource = "hds_ltm" | "authority" | "audit";
export type MemoryRetrievalMode = "exact" | "tag" | "recent";
export type OperatorSurfaceId = "writing" | "daily" | "developer";

export interface OperatorSurfaceRef {
  id: OperatorSurfaceId;
  layer: "A";
  source: "content_prefix" | "gateway_internal_metadata";
  authority: "downstream_device_only";
}

export interface OperationCoreFrameRef {
  request: OperationRequest;
  source: "gateway_internal_metadata";
  projection_id?: string;
  used_for_authority: false;
  planner_output_used_for_authority: false;
  ui_projection_used_for_authority: false;
}

export interface ActorRef {
  actor_id: string;
  actor_kind: ActorKind;
  channel: string;
  external_user_id?: string;
  trust_level: TrustLevel;
}

export interface MemoryReadPolicy {
  policy_id: string;
  enabled: boolean;
  max_hits: number;
  allowed_sources: MemorySource[];
  retrieval_modes: MemoryRetrievalMode[];
}

/** J-owned bounded search intent. It is a reference scope, never authority. */
export interface MemorySearchPlan {
  plan_id: string;
  purpose: "current_request_citation_context";
  request_id: string;
  process_id: string;
  query_digest: string;
  /** Whether this request contains an explicit F reference; raw input is not retained. */
  explicit_references_requested: boolean;
  application_scope_id: string;
  allowed_sources: MemorySource[];
  retrieval_modes: MemoryRetrievalMode[];
  max_hits: number;
  source_integrity_verified: boolean;
  used_for_authority: false;
}

/** Origin metadata copied from one immutable HDS long-term-memory record. */
export interface MemoryRecordProvenance {
  source_store: "hds_ltm";
  record_id: string;
  version: string;
  source_ref: string;
  captured_at_ms: number;
  source_process_id?: string;
  source_process_version?: string;
  source_actor_kind?: ActorKind;
  source_decision?: Decision;
  source_decision_hash?: string;
}

export interface MemoryHit {
  source: MemorySource;
  memory_id: string;
  f_reference: string;
  entry_hash: string;
  reason: MemoryRetrievalMode;
  matched_on?: string;
  provenance?: MemoryRecordProvenance;
  summary?: {
    goal: string;
    problem_definition_id: string;
    abstraction: string;
  };
  /** Digest-only account of source fields omitted from the bounded C projection. */
  summary_projection: MemorySummarySourceProjection;
}

export type MemorySummaryField = "goal" | "problem_definition_id" | "abstraction";

export interface MemorySummarySourceProjection {
  included_fields: MemorySummaryField[];
  included_source_digest: string;
  omitted_source_fields: string[];
  omitted_source_digest: string;
}

export interface MemorySummaryTruncation {
  field: MemorySummaryField;
  source_char_count: number;
  projected_char_count: number;
  omitted_suffix_digest: string;
}

export interface MemorySummaryDifference extends MemorySummarySourceProjection {
  truncations: MemorySummaryTruncation[];
  /** No semantic equivalence is inferred from the compact projection. */
  semantic_difference: "not_assessed";
  difference_note: string;
}

export interface MemoryTrace {
  policy_id: string;
  process_id: string;
  search_plan?: MemorySearchPlan;
  /** Current invariant: memory is surfaced for context/audit, not for authority escalation. */
  used_for_authority: false;
  hits: MemoryHit[];
}

export interface MemoryCitationReference {
  /** Canonical F reference for an exact retrieved record. */
  record_id: string;
  /** Immutable LongTermMemoryStore entry hash. */
  version: string;
}

export interface MemoryCitationProjectionRecord {
  reference: MemoryCitationReference;
  disposition: "adopted" | "not_adopted" | "excluded_from_context";
  reason:
    | "accepted_citation"
    | "not_used_by_accepted_citation"
    | "explicit_reference_scope";
  summary_difference?: MemorySummaryDifference;
}

export interface MemoryCitationReviewLog {
  kind: "memory_citation_review";
  event: "memory.citation_review";
  request_id: string | null;
  command_id: string;
  search_plan_id: string;
  application_scope_id: string;
  status: "accepted" | "accepted_with_rejections" | "no_proposals" | "rejected" | "invalid_output";
  candidate_count: number;
  candidate_references: MemoryCitationReference[];
  /** Exact immutable versions supplied to C for this projection; absent only on legacy review entries. */
  dependency_versions?: MemoryCitationReference[];
  /** Per-record context disposition and reversible, content-free projection differences. */
  /** Missing only on legacy C04.01 audit entries written before this projection was added. */
  projection_records?: MemoryCitationProjectionRecord[];
  source_result_digest: string;
  reviewed_content_digest: string;
  accepted_citations: Array<{
    claim_digest: string;
    supporting: MemoryCitationReference;
    counterevidence: MemoryCitationReference;
  }>;
  rejected_proposal_count: number;
  rejection_reasons: string[];
  used_for_authority: false;
  timestamp: number;
}

export interface HDSProcessDefinition {
  process_id: string;
  process_kind: ProcessKind;
  version: string;
  trigger: {
    kind: "inbound" | "cron" | "webhook" | "resume" | "system";
    channel?: string;
  };
  actor_policy: {
    allowed_actor_kinds: ActorKind[];
    owner_required: boolean;
  };
  memory_policy: MemoryReadPolicy;
  approval_profile: {
    default_mode: "ask_every_time" | "remember_this_decision" | "full_access";
    final_review_operations: string[];
  };
  execution_policy: {
    allowed_command_types: ExecuteCommand["type"][];
    allowed_tools: string[];
    allowed_capabilities: NonNullable<CommandConstraints["allowed_capabilities"]>;
    timeout_ms: number;
  };
  capture_policy: {
    capture_on: Array<"assert" | "approval" | "feedback" | "failure">;
    persist_to_ltm: boolean;
  };
}

export interface FrameResult {
  actor: ActorRef;
  process: HDSProcessDefinition;
  memory_trace: MemoryTrace;
  operator_surface?: OperatorSurfaceRef;
  operation_core?: OperationCoreFrameRef;
  goal_projection: ReadonlyGoalProjection;
  /** Display/audit reference only. It is excluded from model, commit, approval and execution inputs. */
  goal_relation_tree?: ReadonlyGoalRelationTreeView;
  /** Version/event projection for audit and later attribution; not consumed by model, commit, approval or execution. */
  goal_governance?: ReadonlyGoalGovernanceProjection;
  goal: string;
  protected_values: string[];
  world_closure: {
    x: string[]; // observed objects
    r: string[]; // relations
    m: string[]; // media
  };
  problem_definition_id: string;
}

/**
 * One axis score produced by a detector.
 * score is normalized to [0, 1] where 1.0 = most desirable.
 *
 * IMPORTANT — score direction is unified across all detectors:
 * even for "risk" axes, score=1.0 means "no risk" (most desirable),
 * score=0.0 means "highest risk" (least desirable).
 */
export interface AxisScore {
  axis: string;
  score: number;
  detector: string;
  evidence?: string;
  lifecycle: DetectorLifecycleTrace;
}

/**
 * Aggregated scoring output.
 */
export interface ScoringResult {
  axis_scores: AxisScore[];
  weights: Record<string, number>;
  aggregate: number;
}

/**
 * Output of the M (Model) phase.
 */
export interface ModelResult {
  abstraction: string;
  structure: Record<string, unknown>;
  scoring: ScoringResult;
}

/**
 * Output of the C (Commit) phase.
 * triggered_thresholds lists the policy rules that fired.
 */
export interface CommitResult {
  decision: Decision;
  reason: string;
  hash: string;
  triggered_thresholds: string[];
}

/**
 * One full F→M→C trace, recorded for audit.
 */
export interface InputNormalizationTrace {
  raw_content: string;
  normalized_content: string;
  changed: boolean;
  controls: Array<{
    index: number;
    code_point: string;
    kind: "zero_width" | "bidi_control";
    name: string;
  }>;
}

export interface DecisionLog {
  request_id: string;
  input?: InputNormalizationTrace;
  resume?: ResumeAuditTrace;
  frame: FrameResult;
  model: ModelResult;
  commit: CommitResult;
  timestamp: number;
}


export interface ExecutorFeedbackAuditTrace {
  status: ExecuteFeedback["status"];
  result_present: boolean;
  result_digest?: string;
  error?: string;
  llm_failure?: ExecuteFeedback["llm_failure"];
  llm_tool_candidate_count?: number;
  llm_tool_candidates_digest?: string;
  metrics: ExecuteFeedback["metrics"];
}

/**
 * Executor feedback is an audit event, not an authority signal.
 * It closes the downstream execution loop by recording what happened after an
 * ASSERTed command left HDS-BRAIN. Unknown command feedback is also recorded so
 * spoofed or stale downstream messages are visible instead of silently ignored.
 */
export interface ExecutorFeedbackLog {
  kind: "executor_feedback";
  request_id: string | null;
  command_id: string;
  upstream_commit_hash: string | null;
  upstream_decision: Decision | null;
  known_command: boolean;
  feedback: ExecutorFeedbackAuditTrace;
  timestamp: number;
}

export interface ApprovalGateLog {
  kind: "approval_gate";
  request_id: string | null;
  command_id: string;
  upstream_commit_hash: string;
  evaluation: ApprovalEvaluation;
  timestamp: number;
}

export type AuthorityEventKind =
  | "grant_created"
  | "grant_used"
  | "grant_revoked"
  | "grant_revoke_failed"
  | "grant_expired"
  | "emergency_stop_activated"
  | "emergency_stop_cleared"
  | "emergency_stop_blocked"
  | "evidence_pack_export_requested"
  | "evidence_pack_exported"
  | "composio_execution_requested"
  | "composio_execution_completed"
  | "composio_execution_failed"
  | "approval_asked"
  | "approval_allowed"
  | "approval_denied";

export interface AuthorityEventLog {
  kind: "authority_event";
  event: AuthorityEventKind;
  request_id: string | null;
  command_id?: string;
  grant_id?: string;
  actor: string;
  reason: string;
  operation?: ApprovalEvaluation["context"]["operation"];
  target_scope?: ApprovalEvaluation["context"]["target_scope"];
  risk?: ApprovalEvaluation["risk"];
  authority_trace?: ApprovalEvaluation["authority_trace"];
  timestamp: number;
}

export type ScheduleLifecycleEvent =
  | "schedule.lifecycle.requested"
  | "schedule.lifecycle.approved"
  | "schedule.lifecycle.rejected"
  | "schedule.lifecycle.activated"
  | "schedule.lifecycle.updated"
  | "schedule.lifecycle.deleted"
  | "schedule.lifecycle.fired";

export interface ScheduleLifecycleLog {
  kind: "schedule_lifecycle";
  event: ScheduleLifecycleEvent;
  schedule_id: string;
  origin: "boot" | "runtime";
  operation: "list" | "create" | "update" | "delete" | "fire";
  actor: string;
  approval_level?: ApprovalEvaluation["approval_level"];
  risk?: ApprovalEvaluation["risk"];
  payload_hash?: string;
  previous_payload_hash?: string;
  command_id?: string;
  request_id?: string | null;
  timestamp: number;
}

export interface MemoryReferenceLog {
  kind: "memory_reference";
  event: "memory.read" | "memory.write";
  request_id: string | null;
  memory_id: string;
  f_reference: string;
  entry_hash: string;
  source: MemorySource;
  used_for_authority: false;
  reason: string;
  matched_on?: string;
  summary?: MemoryHit["summary"];
  timestamp: number;
}

export interface RuntimeInvariantsLog {
  kind: "runtime_invariants";
  request_id: string | null;
  event: "runtime_invariants.evidence";
  all_ok: boolean;
  report_digest: string;
  evidence_count: number;
  values: RuntimeInvariantValues;
  report: RuntimeInvariantEvidenceReport;
  used_for_authority: false;
  reason: string;
  timestamp: number;
}

export type CommandLifecyclePhase =
  | "approval_pending"
  | "approval_approved"
  | "approval_rejected"
  | "approval_cancelled";

export interface CommandLifecycleLog {
  kind: "command_lifecycle";
  phase: CommandLifecyclePhase;
  request_id: string | null;
  command_id: string;
  upstream_commit_hash: string | null;
  upstream_decision: Decision | null;
  actor: string;
  reason: string;
  timestamp: number;
}

export type AuditRecord =
  | DecisionLog
  | ExecutorFeedbackLog
  | OutputAuditLog
  | ApprovalGateLog
  | AuthorityEventLog
  | MemoryReferenceLog
  | MemoryCitationReviewLog
  | RuntimeInvariantsLog
  | CommandLifecycleLog
  | ScheduleLifecycleLog;

/**
 * Per-axis policy entry.
 */
export interface PolicyAxis {
  name: string;
  detector: string;
  weight: number;
  detector_args?: Record<string, unknown>;
}

/**
 * Operational Policy thresholds.
 *
 * Decision order at commit:
 *   1. If any axis in per_axis_fail is at-or-below its threshold → FAIL
 *   2. If any axis in per_axis_suspend_below is below its threshold → SUSPEND
 *   3. If aggregate < out_of_scope_below → OUT_OF_SCOPE
 *   4. If aggregate >= aggregate_assert → ASSERT
 *   5. Otherwise → SUSPEND
 */
export interface PolicyThresholds {
  aggregate_assert: number;
  out_of_scope_below: number;
  per_axis_fail?: Record<string, number>;
  per_axis_suspend_below?: Record<string, number>;
}

export interface PolicyConfig {
  problem_definition_id: string;
  description?: string;
  axes: PolicyAxis[];
  thresholds: PolicyThresholds;
}

/**
 * Controller state machine.
 */
export type ControllerState =
  | "IDLE"
  | "DECIDED"
  | "SUSPENDED"
  | "AWAITING_RESUME";

export interface SuspendedRequest {
  request_id: string;
  log: DecisionLog;
  suspended_at: number;
  reason: string;
  fail_safe?: boolean;
  resume_allowed?: boolean;
  self_health?: HDSBrainHealth;
}

/**
 * Human verdict on a suspended request.
 *   approve → treat as ASSERT; emit the original command
 *   reject  → treat as FAIL;   record only, no command
 *   block   → treat as OUT_OF_SCOPE; record only, no command
 */
export type ResumeVerdict = "approve" | "reject" | "block";

export interface ResumeAuditTrace {
  verdict: ResumeVerdict;
  actor: string;
  token_kind: "resume";
}
