import type {
  ExecuteCommand,
  ExecuteFeedback,
} from "@blue-tanuki/protocol";
import type { CompleteHistoryEntry } from "../complete-history/index.js";

export const FAILURE_MEMORY_SCHEMA_VERSION = "failure-memory-v2";

export type FailureScope =
  | "command"
  | "tool"
  | "file"
  | "repo"
  | "test"
  | "llm_output"
  | "workflow"
  | "authority"
  | "boundary";

export type FailureType =
  | "no_progress"
  | "repeat_error"
  | "boundary_violation"
  | "hallucination"
  | "wrong_file"
  | "bad_command"
  | "test_regression"
  | "permission_error"
  | "environment_error"
  | "logic_drift"
  | "unresolved_warning"
  | "repeated_manual_correction";

export type SuppressionPolicy =
  | "block"
  | "warn"
  | "downrank"
  | "require_approval"
  | "rewrite";

export type FailureSeverity =
  | "low"
  | "medium"
  | "high"
  | "critical";

export type FailureRuleState =
  | "draft"
  | "active"
  | "shadow"
  | "probation"
  | "retired";

export type ProbePolicy =
  | "manual"
  | "sandbox"
  | "shadow_only"
  | "never";

export type MatchLevel = 0 | 1 | 2 | 3;

export type FailureSignature = {
  id: string;

  scope: FailureScope;
  failure_type: FailureType;

  input_pattern: string;
  action_pattern: string;
  context_pattern: string;
  predicted_difference_digest?: string;
  result_pattern?: string;
  cause_candidates?: FailureType[];
  unknowns?: string[];

  evidence_log_ids: string[];

  match_level: MatchLevel;
  suppression_policy: SuppressionPolicy;

  confidence: number;
  severity: FailureSeverity;

  state: FailureRuleState;

  created_at: string;
  updated_at: string;
  last_seen_at: string;
  last_validated_at?: string;
  next_revalidation_at?: string;

  hit_count: number;

  ttl_days?: number;
  decay_rate?: number;

  allow_probe: boolean;
  probe_policy: ProbePolicy;

  notes?: string;
};

export type FailureSignatureInput = {
  scope: FailureScope;
  failure_type: FailureType;
  input_pattern: string;
  action_pattern: string;
  context_pattern: string;
  predicted_difference_digest?: string;
  result_pattern?: string;
  cause_candidates?: readonly FailureType[];
  unknowns?: readonly string[];
  evidence_log_ids?: readonly string[];
  match_level?: MatchLevel;
  suppression_policy?: SuppressionPolicy;
  confidence?: number;
  severity?: FailureSeverity;
  state?: FailureRuleState;
  created_at?: string;
  updated_at?: string;
  last_seen_at?: string;
  last_validated_at?: string;
  next_revalidation_at?: string;
  hit_count?: number;
  ttl_days?: number;
  decay_rate?: number;
  allow_probe?: boolean;
  probe_policy?: ProbePolicy;
  notes?: string;
};

export type FailureSignatureUpdate = Partial<Omit<
  FailureSignature,
  "id" | "created_at" | "evidence_log_ids"
>> & {
  evidence_log_ids?: readonly string[];
};

export type FailureMemorySnapshot = {
  schema_version: typeof FAILURE_MEMORY_SCHEMA_VERSION;
  exported_at: string;
  signatures: FailureSignature[];
};

export type FailureGateDecision =
  | "allow"
  | "warn"
  | "downrank"
  | "rewrite"
  | "require_approval"
  | "block";

export type FailureGateCandidate = {
  scope: FailureScope;
  input_pattern: string;
  action_pattern: string;
  context_pattern: string;
  result_pattern?: string;
  command?: ExecuteCommand;
  context?: Record<string, unknown>;
};

export type FailureGateMatch = {
  signature_id: string;
  match_level: MatchLevel;
  policy: SuppressionPolicy;
  state: FailureRuleState;
  severity: FailureSeverity;
  confidence: number;
  enforced: boolean;
  reason: string;
};

export type FailureGateResult = {
  decision: FailureGateDecision;
  matches: FailureGateMatch[];
  highest_match_level?: MatchLevel;
  applied_signature_ids: string[];
  requires_human_review: boolean;
  rewritten_candidate?: FailureGateCandidate;
  reason: string;
};

export type FailureExtractionInput =
  | { kind: "complete_history"; entry: CompleteHistoryEntry }
  | { kind: "command_result"; command: ExecuteCommand; feedback: ExecuteFeedback; context?: Record<string, unknown>; evidence_log_id?: string }
  | { kind: "tool_result"; tool_name: string; status: "success" | "failed"; error?: string; evidence_log_id?: string }
  | { kind: "test_result"; test_name: string; status: "passed" | "failed"; error?: string; evidence_log_id?: string }
  | { kind: "workflow_result"; workflow: string; status: "success" | "failed"; error?: string; evidence_log_id?: string }
  | { kind: "llm_output_validation"; validator: string; ok: boolean; error?: string; evidence_log_id?: string }
  | { kind: "authority_boundary"; reason: string; decision: string; evidence_log_id?: string };

export type PeriodicVerificationTrigger =
  | "daily"
  | "startup"
  | "after_test_failure"
  | "before_release"
  | "manual"
  | "post_failure";

export type PeriodicVerificationReport = {
  run_id: string;

  started_at: string;
  completed_at: string;

  scanned_log_range: {
    from: string;
    to: string;
  };

  detected_failures: FailureSignature[];
  repeated_failures: FailureSignature[];
  unresolved_risks: string[];

  recommended_rules: FailureSignature[];
  applied_rules: string[];

  requires_human_review: string[];

  stale_rules: string[];
  revalidated_rules: string[];
  retired_rules: string[];
  probation_rules: string[];

  notes?: string;
};

export type FailureMemoryVerifierInput = {
  entries: readonly CompleteHistoryEntry[];
  existing_rules?: readonly FailureSignature[];
  trigger: PeriodicVerificationTrigger;
  now?: Date;
  apply_recommendations?: boolean;
};

export type RevalidationOutcome =
  | "still_valid"
  | "no_longer_reproducible"
  | "false_positive"
  | "superseded"
  | "manual_review_required";

export type RevalidationResult = {
  rule_id: string;
  outcome: RevalidationOutcome;
  probe_policy: ProbePolicy;
  probed: boolean;
  next_state: FailureRuleState;
  next_policy?: SuppressionPolicy;
  reason: string;
};
