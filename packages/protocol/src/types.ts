import { z } from "zod";
import { GoalCriteriaSchema } from "./goal_criteria.js";

import { OperationCoreExecutorTraceSchema, OperationCommandExecutionResultSchema, type OperationInterface } from "./operation_core.js";

const DangerousObjectKeySchema = z.string().refine(
  (key) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
  "dangerous object key is not allowed",
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type MetadataObject = Record<string, JsonValue | undefined>;

const GATEWAY_INTERNAL_AUTHORITY_BRAND: unique symbol = Symbol("blue_tanuki.gateway_internal_authority.v1");

export const RESERVED_EXTERNAL_METADATA_KEYS = [
  "blue_tanuki.authority_context",
  "blue_tanuki.actor_kind",
  "blue_tanuki.trust_level",
  "blue_tanuki.process_kind",
  "blue_tanuki.operator_surface",
  "blue_tanuki.operation_core",
  "blue_tanuki.operation_core.goal_purpose_binding",
  "blue_tanuki.operation_plan",
  "blue_tanuki.channel_send",
  "blue_tanuki.runtime_ingress.version",
  "blue_tanuki.runtime_ingress.runtime_id_digest",
  "blue_tanuki.runtime_ingress.session_id_digest",
  "blue_tanuki.runtime_ingress.used_for_authority",
  "blue_tanuki.failure_review",
  "blue_tanuki.goal_purpose_change.version",
  "blue_tanuki.meaning_update_adoption.version",
  "blue_tanuki.memory_judgment_reassessment.version",
  "actor_kind",
  "trust_level",
  "process_kind",
] as const;

const RESERVED_EXTERNAL_METADATA_KEY_SET = new Set<string>(RESERVED_EXTERNAL_METADATA_KEYS);

export interface GatewayInternalAuthorityMetadata extends MetadataObject {
  "blue_tanuki.authority_context": "gateway_internal_v1";
  "blue_tanuki.actor_kind"?: "owner" | "user" | "system" | "webhook" | "cron";
  "blue_tanuki.trust_level"?: "owner" | "trusted" | "limited" | "untrusted";
  "blue_tanuki.process_kind"?: "chat" | "tool" | "approval" | "cron" | "webhook" | "system";
  "blue_tanuki.operator_surface"?: "writing" | "daily" | "developer";
  "blue_tanuki.operation_core.version"?: "operation-core.v1";
  "blue_tanuki.operation_core.request_id"?: string;
  "blue_tanuki.operation_core.projection_id"?: string;
  "blue_tanuki.operation_core.source_interface"?: OperationInterface;
  "blue_tanuki.operation_core.used_for_authority"?: false;
  "blue_tanuki.operation_core.planner_output_used_for_authority"?: false;
  "blue_tanuki.operation_core.ui_projection_used_for_authority"?: false;
  "blue_tanuki.operation_core.parent_wait_id"?: string;
  "blue_tanuki.operation_core.parent_task_identity_digest"?: string;
  "blue_tanuki.operation_plan.wait_deadline_id"?: string;
  "blue_tanuki.operation_core.goal_purpose_binding"?: {
    goal_ref: string;
    purpose_version: number;
    purpose_digest: string;
  };
  "blue_tanuki.channel_send.channel"?: string;
  "blue_tanuki.channel_send.target"?: string;
  "blue_tanuki.runtime_ingress.version"?: "d4-runtime-intent.v1";
  "blue_tanuki.runtime_ingress.runtime_id_digest"?: string;
  "blue_tanuki.runtime_ingress.session_id_digest"?: string;
  "blue_tanuki.runtime_ingress.used_for_authority"?: false;
  "blue_tanuki.channel_send.content"?: string;
  "blue_tanuki.failure_review.version"?: "blue-tanuki.failure-review.v1";
  "blue_tanuki.failure_review.signature_id"?: string;
  "blue_tanuki.failure_review.projection_json"?: string;
  "blue_tanuki.goal_purpose_change.version"?: "v1";
  "blue_tanuki.meaning_update_adoption.version"?: "v1";
  "blue_tanuki.memory_judgment_reassessment.version"?: "v1";
}

export interface GatewayInternalInboundRequestInput extends Omit<InboundRequest, "metadata"> {
  metadata: GatewayInternalAuthorityMetadata;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(DangerousObjectKeySchema, JsonValueSchema.optional()),
  ]),
);

/**
 * Decision values returned by HDS-BRAIN's commit phase.
 * - ASSERT       : Execute. Pass command to BLUE-TANUKI.
 * - SUSPEND      : Hold. Wait for resolution (human/external signal).
 * - OUT_OF_SCOPE : Outside protected scope. No action.
 * - FAIL         : Reject. Audit-only.
 */
export const DecisionSchema = z.enum([
  "ASSERT",
  "SUSPEND",
  "OUT_OF_SCOPE",
  "FAIL",
]);
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * The upstream (HDS-BRAIN) decision attached to every command sent downstream.
 * Used for audit traceability — every executor action carries the F→M→C trace.
 */
export const UpstreamDecisionSchema = z.object({
  frame_goal: z.string(),
  model_abstraction: z.string(),
  commit_hash: z.string(),
  commit_decision: DecisionSchema,
  request_id: z.string().min(1).max(200).optional(),
});
export type UpstreamDecision = z.infer<typeof UpstreamDecisionSchema>;

/**
 * LLM call payload (one of the executor's primary command types).
 */
export const LLMFallbackAuthorizationSchema = z.object({
  allowed_providers: z.array(z.string().trim().min(1).max(120)).min(1).max(16),
  allowed_input_sources: z.array(z.enum([
    "accepted_inbound_request",
    "selected_memory_references",
    "selected_operation_result_observations",
    "session_history",
  ])).min(1).max(4),
  required_capabilities: z.array(z.string().trim().min(1).max(120)).min(1).max(16),
  max_total_cost: z.object({
    amount: z.number().finite().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
}).strict().superRefine((value, context) => {
  const providers = value.allowed_providers.map((provider) => provider.toLowerCase());
  if (new Set(providers).size !== providers.length) {
    context.addIssue({ code: "custom", message: "fallback providers must be unique" });
  }
  if (new Set(value.allowed_input_sources).size !== value.allowed_input_sources.length) {
    context.addIssue({ code: "custom", message: "fallback input sources must be unique" });
  }
  if (new Set(value.required_capabilities).size !== value.required_capabilities.length) {
    context.addIssue({ code: "custom", message: "fallback capabilities must be unique" });
  }
});
export type LLMFallbackAuthorization = z.infer<typeof LLMFallbackAuthorizationSchema>;

export const AgentWorkerRoleSchema = z.enum([
  "division",
  "independent_comparison",
  "audit",
  "redundancy",
]);
export type AgentWorkerRole = z.infer<typeof AgentWorkerRoleSchema>;

/** C-only child work contract. It carries bounded resource scope, never authority. */
export const AgentDelegationContractSchema = z.object({
  schema_version: z.literal("blue-tanuki.agent-delegation.v1"),
  parent_goal_digest: z.string().regex(/^[a-f0-9]{64}$/),
  parent_task_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  parent_budget_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  criteria_digest: z.string().regex(/^[a-f0-9]{64}$/),
  termination_digest: z.string().regex(/^[a-f0-9]{64}$/),
  roles: z.tuple([
    z.literal("division"),
    z.literal("independent_comparison"),
    z.literal("audit"),
    z.literal("redundancy"),
  ]),
  max_child_tasks: z.literal(4),
  max_delegation_depth: z.literal(1),
  parent_resource_limits: z.object({
    timeout_ms: z.number().int().positive().max(180_000),
  }).strict(),
  child_resource_limits: z.object({
    max_tokens: z.number().int().positive().max(100_000),
    timeout_ms: z.number().int().positive().max(180_000),
  }).strict(),
  capabilities: z.array(z.literal("llm_compute_candidate")).length(1),
  may_delegate: z.literal(false),
  may_execute: z.literal(false),
  used_for_authority: z.literal(false),
}).strict();
export type AgentDelegationContract = z.infer<typeof AgentDelegationContractSchema>;

export const LLMComputeContextSchema = z.object({
  schema_version: z.literal("blue-tanuki.compute-context.v1"),
  projection_digest: z.string().regex(/^[a-f0-9]{64}$/),
  local_p_version: z.string().trim().min(1).max(120),
  data_exposure: z.object({
    input_sources: z.array(z.enum([
      "accepted_inbound_request",
      "selected_memory_references",
      "failure_memory_digest_projection",
      "selected_operation_result_observations",
      "complete_history_digest_observations",
    ])).min(1).max(3),
    requested_egress_provider: z.string().trim().min(1).max(120),
  }).strict(),
  /** Non-authority correlation scope for aggregate C resource accounting. */
  budget_scope: z.object({
    parent_task_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
    task_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  /** HDS-issued constraints for an alternate provider; absent means no fallback authorization. */
  fallback_authorization: LLMFallbackAuthorizationSchema.optional(),
}).strict();
export type LLMComputeContext = z.infer<typeof LLMComputeContextSchema>;

export const LLMCallPayloadSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    }),
  ),
  /**
   * Optional downstream provider selector. This is a routing hint, not an
   * authority signal: HDS-BRAIN still owns the ASSERT/SUSPEND/FAIL decision,
   * and the executor resolves the hint against its configured registry.
   */
  backend_hint: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Non-authority binding for the current HDS projection and requested data route. */
  compute_context: LLMComputeContextSchema.optional(),
  /** Bounded C-only child analysis, available only on an HDS-issued request. */
  agent_delegation: AgentDelegationContractSchema.optional(),
  /**
   * Optional session identifier. When set, the executor's SessionStore
   * (if configured) will (a) prepend retained history before calling the
   * LLM, and (b) append the current user message and the assistant's
   * reply on success. When unset, history is not consulted nor written.
   *
   * Convention used by the gateway: `${channel}:${user}` (e.g.
   * `slack:U12345`, `webchat:bob`). The executor treats it opaquely.
   */
  session_id: z.string().optional(),
});
export type LLMCallPayload = z.infer<typeof LLMCallPayloadSchema>;

/**
 * Tool call payload.
 */
export const ToolCallPayloadSchema = z.object({
  tool_name: z.string(),
  arguments: z.record(z.unknown()),
});
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

/**
 * Channel send payload (e.g. reply on Slack/Discord/WebChat).
 */
export const ChannelSendPayloadSchema = z.object({
  channel: z.string(),
  target: z.string(),
  content: z.string(),
});
export type ChannelSendPayload = z.infer<typeof ChannelSendPayloadSchema>;

/**
 * Runtime capability strings enforced by the executor.
 *
 * Capability names are intentionally free-form but non-empty. Built-in
 * conventions include:
 *   - tool:<name>
 *   - fs:read
 *   - fs:write
 *   - network:http
 *   - network:<host>
 *   - shell:probe
 *   - shell:exec
 *   - channel:send
 */
export const ToolCapabilitySchema = z.string().min(1);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * Constraints attached to a command. Set by upstream, enforced by executor.
 */
export const CommandConstraintsSchema = z.object({
  max_tokens: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  allowed_capabilities: z.array(ToolCapabilitySchema).optional(),
});
export type CommandConstraints = z.infer<typeof CommandConstraintsSchema>;

/**
 * Discriminated union of all command shapes.
 * BLUE-TANUKI executor switches on `type`.
 */
export const ExecuteCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("llm_call"),
    payload: LLMCallPayloadSchema,
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("tool_call"),
    payload: ToolCallPayloadSchema,
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("channel_send"),
    payload: ChannelSendPayloadSchema,
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("noop"),
    payload: z.object({}).passthrough(),
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
]);
export type ExecuteCommand = z.infer<typeof ExecuteCommandSchema>;

/**
 * Feedback from BLUE-TANUKI executor back to HDS-BRAIN.
 * Used by HDS-BRAIN to update its state machine.
 */
export const LLMCallFailureSchema = z.object({
  schema_version: z.literal("blue-tanuki.llm-failure.v1"),
  kind: z.enum([
    "rate_limited",
    "temporary_network",
    "disconnected",
    "remote_service_unavailable",
    "auth",
    "bad_request",
    "bad_response",
    "timeout",
    "cancelled",
    "partial_response",
    "invalid_structured_output",
    "unknown",
  ]),
  retryable: z.boolean(),
  provider: z.string().min(1).max(128).optional(),
  status: z.number().int().min(100).max(599).optional(),
  retry_after_ms: z.number().int().min(0).max(604_800_000).optional(),
  authority_boundary: z.object({
    used_for_authority: z.literal(false),
  }).strict(),
}).strict();
export type LLMCallFailure = z.infer<typeof LLMCallFailureSchema>;
export type LLMCallFailureKind = LLMCallFailure["kind"];

/**
 * Untrusted provider tool output. It is returned for J review and is never an
 * executable command or permission grant by itself.
 */
export const LLMToolCallCandidateSchema = z.object({
  schema_version: z.literal("blue-tanuki.llm-tool-call-candidate.v1"),
  call_id: z.string().min(1).max(200),
  tool_name: z.string().min(1).max(200),
  arguments: z.record(z.unknown()),
  authority_boundary: z.object({
    candidate_only: z.literal(true),
    may_execute: z.literal(false),
    used_for_authority: z.literal(false),
  }).strict(),
}).strict();
export type LLMToolCallCandidate = z.infer<typeof LLMToolCallCandidateSchema>;

/**
 * Downstream skepticism input for a bounded, non-authority HDS review.
 * Reports and hypotheses are claims to inspect, never verified observations.
 */
export const SkepticalReviewRequestSchema = z.object({
  schema_version: z.literal("blue-tanuki.skeptical-review.v1"),
  observation_reports: z.array(z.object({
    criterion_ref: z.string().min(1).max(200),
    finding: z.string().min(1).max(4_000),
    relation: z.enum(["supports", "conflicts", "unclear"]),
  }).strict()).min(1).max(32),
  alternative_hypotheses: z.array(z.string().min(1).max(4_000)).max(16).optional(),
  proposed_goal_criteria: GoalCriteriaSchema.optional(),
  /** Untrusted C candidate for a delegated purpose change; J may only queue it for owner review. */
  goal_purpose_change_proposal: z.object({
    goal_ref: z.string().regex(/^goal_[a-f0-9]{16,64}$/),
    purpose_text: z.string().min(1).max(16 * 1024),
  }).strict().optional(),
}).strict();
export type SkepticalReviewRequest = z.infer<typeof SkepticalReviewRequestSchema>;

export const FAILURE_REVIEW_LOCAL_P_VERSION = "blue-tanuki.failure-review.v1" as const;

const FailureReviewSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const FailureReviewScopeSchema = z.enum([
  "command", "tool", "file", "repo", "test", "llm_output", "workflow", "authority", "boundary",
]);
const FailureReviewTypeSchema = z.enum([
  "no_progress", "repeat_error", "boundary_violation", "hallucination", "wrong_file", "bad_command",
  "test_regression", "permission_error", "environment_error", "logic_drift", "unresolved_warning",
  "repeated_manual_correction",
]);

/** A digest-only Complete History observation linked to a saved failure signature. */
export const FailureReviewIndependentObservationSchema = z.object({
  source: z.literal("complete_history"),
  entry_id_digest: FailureReviewSha256Schema,
  entry_hash: FailureReviewSha256Schema,
  payload_digest: FailureReviewSha256Schema,
  entry_kind: z.enum([
    "user_input", "llm_history", "hds_decision", "approval_history", "execution_history", "audit_history", "final_output",
  ]),
  observed_failures: z.array(z.object({
    scope: FailureReviewScopeSchema,
    failure_type: FailureReviewTypeSchema,
  }).strict()).max(16),
}).strict();
export type FailureReviewIndependentObservation = z.infer<typeof FailureReviewIndependentObservationSchema>;

/** A retained, non-authoritative reference to an earlier C derivation. */
export const FailureReviewLineageReferenceSchema = z.object({
  record_digest: FailureReviewSha256Schema,
  signature_digest: FailureReviewSha256Schema,
  pre_state_digest: FailureReviewSha256Schema,
  experience_digest: FailureReviewSha256Schema,
  derivation_digest: FailureReviewSha256Schema,
  derived_at: z.string().datetime(),
  candidate_categories: z.array(FailureReviewTypeSchema).max(16),
  learning_action_status: z.literal("candidate_derivation_recorded").default("candidate_derivation_recorded"),
  validity_status: z.literal("not_assessed").default("not_assessed"),
  improvement_status: z.literal("not_measured").default("not_measured"),
  generalization_status: z.literal("not_assessed").default("not_assessed"),
  c_result_binding_status: z.literal("request_bound").default("request_bound"),
  internal_derivation_attribution_status: z.literal("not_established").default("not_established"),
  external_change_contribution_status: z.literal("not_assessed").default("not_assessed"),
  teacher_input_contribution_status: z.literal("excluded_from_c_projection").default("excluded_from_c_projection"),
  adoption_status: z.literal("not_adopted"),
  approval_status: z.literal("not_requested"),
  memory_application_status: z.literal("stored_for_future_reference"),
  follow_up_action_status: z.literal("unconfirmed"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();
export type FailureReviewLineageReference = z.infer<typeof FailureReviewLineageReferenceSchema>;

/** Retained digest-only C derivation bound to FailureMemory; never an enforceable rule. */
export const FailureLearningLineageRecordSchema = z.object({
  schema_version: z.literal("blue-tanuki.failure-learning-lineage.v1"),
  record_id: FailureReviewSha256Schema,
  signature_id_digest: FailureReviewSha256Schema,
  signature_digest: FailureReviewSha256Schema,
  pre_state_digest: FailureReviewSha256Schema,
  scope: FailureReviewScopeSchema,
  retention_period: z.object({
    first_observed_at: z.string().min(1).max(64),
    last_observed_at: z.string().min(1).max(64),
  }).strict(),
  experience_reference_digests: z.array(FailureReviewSha256Schema).max(256),
  experience_digest: FailureReviewSha256Schema,
  prior_lineage_record_digests: z.array(FailureReviewSha256Schema).max(32),
  request_id_digest: FailureReviewSha256Schema,
  command_id_digest: FailureReviewSha256Schema,
  projection_digest: FailureReviewSha256Schema,
  candidate_content_digest: FailureReviewSha256Schema,
  derivation_digest: FailureReviewSha256Schema,
  application_target: z.literal("failure-memory.learning-lineage.v1"),
  derivation_categories: z.array(FailureReviewTypeSchema).max(16),
  derived_at: z.string().datetime(),
  learning_action_status: z.literal("candidate_derivation_recorded").optional(),
  validity_status: z.literal("not_assessed").optional(),
  improvement_status: z.literal("not_measured").optional(),
  generalization_status: z.literal("not_assessed").optional(),
  c_result_binding_status: z.literal("request_bound").optional(),
  internal_derivation_attribution_status: z.literal("not_established").optional(),
  external_change_contribution_status: z.literal("not_assessed").optional(),
  teacher_input_contribution_status: z.literal("excluded_from_c_projection").optional(),
  adoption_status: z.literal("not_adopted"),
  approval_status: z.literal("not_requested"),
  memory_application_status: z.literal("stored_for_future_reference"),
  follow_up_action_status: z.literal("unconfirmed"),
  cross_store_atomic: z.literal(false),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();
export type FailureLearningLineageRecord = z.infer<typeof FailureLearningLineageRecordSchema>;

/** Gatewayが失敗署名と参照済みComplete Historyから作るdigest-only入力。権限や世界事実ではない。 */
export const FailureReviewProjectionSchema = z.object({
  schema_version: z.literal("blue-tanuki.failure-review-projection.v1"),
  signature_id: z.string().uuid(),
  signature_digest: FailureReviewSha256Schema,
  pre_state_digest: FailureReviewSha256Schema,
  retention_period: z.object({
    first_observed_at: z.string().min(1).max(64),
    last_observed_at: z.string().min(1).max(64),
  }).strict(),
  evidence_log_id_digests: z.array(FailureReviewSha256Schema).max(256),
  prior_learning_lineages: z.array(FailureReviewLineageReferenceSchema).max(32),
  independent_observation_source_status: z.enum(["verified", "unavailable", "invalid"]),
  independent_observations: z.array(FailureReviewIndependentObservationSchema).max(256),
  scope: FailureReviewScopeSchema,
  failure_type: FailureReviewTypeSchema,
  cause_candidates: z.array(FailureReviewTypeSchema).max(16),
  unknowns: z.array(z.string().min(1).max(96)).max(16),
  input_pattern_digest: FailureReviewSha256Schema,
  action_pattern_digest: FailureReviewSha256Schema,
  context_pattern_digest: FailureReviewSha256Schema,
  result_pattern_digest: FailureReviewSha256Schema.optional(),
}).strict();
export type FailureReviewProjection = z.infer<typeof FailureReviewProjectionSchema>;

/** Cの原因・反対仮説・観測誤差提案。Jがrequest-boundに検査するまで全て未信頼。 */
export const FailureReviewCandidateSchema = z.object({
  schema_version: z.literal("blue-tanuki.failure-review-candidate.v1"),
  signature_id: z.string().min(1).max(200),
  signature_digest: FailureReviewSha256Schema,
  projection_digest: FailureReviewSha256Schema,
  cause_hypotheses: z.array(z.object({
    category: FailureReviewTypeSchema,
    rationale: z.string().min(1).max(1_200),
  }).strict()).max(16),
  alternative_hypotheses: z.array(z.string().min(1).max(1_200)).max(16),
  observation_error_hypotheses: z.array(z.string().min(1).max(1_200)).max(16),
  scope_assessment: z.enum(["same_scope", "uncertain", "different_scope"]),
  counterexamples: z.array(z.string().min(1).max(1_200)).max(16),
  resume_conditions: z.array(z.string().min(1).max(1_200)).max(16),
  additional_observations: z.array(z.string().min(1).max(1_200)).max(16),
  authority_boundary: z.object({
    candidate_only: z.literal(true),
    may_execute: z.literal(false),
    used_for_authority: z.literal(false),
  }).strict(),
}).strict();
export type FailureReviewCandidate = z.infer<typeof FailureReviewCandidateSchema>;

/**
 * Read-only handoff of a validated runtime learning candidate to the separate
 * development review path. It is never a code change, version decision, or authority.
 */
export const FailureLearningDevelopmentHandoffSchema = z.object({
  schema_version: z.literal("blue-tanuki.failure-learning-development-handoff.v1"),
  handoff_id: FailureReviewSha256Schema,
  source_record_digest: FailureReviewSha256Schema,
  source_signature_digest: FailureReviewSha256Schema,
  source_projection_digest: FailureReviewSha256Schema,
  source_derivation_digest: FailureReviewSha256Schema,
  candidate_content_digest: FailureReviewSha256Schema,
  candidate_kind: z.literal("runtime_learning_signal"),
  candidate: FailureReviewCandidateSchema,
  source_state: z.object({
    learning_action_status: z.literal("candidate_derivation_recorded"),
    validity_status: z.literal("not_assessed"),
    improvement_status: z.literal("not_measured"),
    generalization_status: z.literal("not_assessed"),
    c_result_binding_status: z.literal("request_bound"),
    internal_derivation_attribution_status: z.literal("not_established"),
    external_change_contribution_status: z.literal("not_assessed"),
    teacher_input_contribution_status: z.literal("excluded_from_c_projection"),
  }).strict(),
  created_at: z.string().datetime(),
  development_status: z.literal("awaiting_development_review"),
  may_promote_version: z.literal(false),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();
export type FailureLearningDevelopmentHandoff = z.infer<typeof FailureLearningDevelopmentHandoffSchema>;

/** Measured C resource consumption. It is evidence for J review, never authority. */
export const ComputeResourceUseSchema = z.object({
  schema_version: z.literal("blue-tanuki.compute-resource-use.v1"),
  request_digest: z.string().regex(/^[a-f0-9]{64}$/),
  charged_compute_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  charged_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tokens_usage_status: z.enum(["provider_reported", "unknown"]),
  cost_status: z.enum(["actual", "estimated", "unknown"]),
  charged_cost_amount: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  charge_basis: z.enum(["provider_reported", "configured_estimate", "reserved_upper_bound"]),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().superRefine((observation, context) => {
  const expectedBasis = observation.cost_status === "actual" ? "provider_reported"
    : observation.cost_status === "estimated" ? "configured_estimate" : "reserved_upper_bound";
  if (observation.charge_basis !== expectedBasis) {
    context.addIssue({ code: "custom", message: "compute_resource_use_charge_basis_mismatch" });
  }
});
export type ComputeResourceUse = z.infer<typeof ComputeResourceUseSchema>;

export const ExecuteFeedbackSchema = z.object({
  command_id: z.string(),
  status: z.enum(["success", "failed", "suspended"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  llm_failure: LLMCallFailureSchema.optional(),
  compute_resource_use: ComputeResourceUseSchema.optional(),
  llm_tool_candidates: z.array(LLMToolCallCandidateSchema).max(32).optional(),
  /** C output is deliberately unchecked until HDS applies the source-bound review contract. */
  skeptical_review: z.unknown().optional(),
  /** C由来の未信頼出力。提案を記録する前にHDS-BRAINが検証する。 */
  meaning_update_proposal: z.unknown().optional(),
  metrics: z.object({
    duration_ms: z.number(),
    tokens_used: z.number().optional(),
    tool_calls: z.number().optional(),
  }),
  operation_core: OperationCoreExecutorTraceSchema.optional(),
  operation_core_result: OperationCommandExecutionResultSchema.optional(),
});
export type ExecuteFeedback = z.infer<typeof ExecuteFeedbackSchema>;

/**
 * Inbound request that reaches HDS-BRAIN. Channel-agnostic.
 * BLUE-TANUKI's channel adapters normalize raw channel events into this shape.
 */
export const InboundRequestSchema = z.object({
  id: z.string().min(1).max(200),
  channel: z.string().min(1).max(80),
  user: z.string().min(1).max(200),
  content: z.string().max(200_000),
  timestamp: z.number().finite().nonnegative(),
  // Executor conversation scope is accepted only from the Gateway's internal
  // request builder. External channel payloads are stripped at normalization.
  session_id: z.string().min(1).max(200).optional(),
  goal_criteria: GoalCriteriaSchema.optional(),
  metadata: z.record(DangerousObjectKeySchema, JsonValueSchema.optional()).optional(),
}).strict();
export type InboundRequest = z.infer<typeof InboundRequestSchema>;

const RegisteredRuntimeReferenceSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

/** Authenticated D4 Runtime dialogue input; identifiers are context only. */
export const RuntimeIntentInputSchema = z.object({
  runtime_id: RegisteredRuntimeReferenceSchema,
  session_id: RegisteredRuntimeReferenceSchema,
  intent: z.string().min(1).max(4_096),
}).strict();
export type RuntimeIntentInput = z.infer<typeof RuntimeIntentInputSchema>;

export type InboundRequestBoundaryFailureReason =
  | "schema_validation_failed"
  | "canonicalization_failed";

export interface InboundRequestBoundaryFailure {
  ok: false;
  reason: InboundRequestBoundaryFailureReason;
  issues: string[];
}

export interface InboundRequestBoundarySuccess {
  ok: true;
  request: InboundRequest;
}

export type InboundRequestBoundaryResult =
  | InboundRequestBoundarySuccess
  | InboundRequestBoundaryFailure;

export function parseInboundRequestAtBoundary(raw: unknown): InboundRequestBoundaryResult {
  const parsed = InboundRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_validation_failed",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    };
  }
  try {
    return {
      ok: true,
      request: normalizeInboundRequestForAuthority(parsed.data, {
        internal_authority_metadata: isGatewayInternalInboundRequest(raw),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "canonicalization_failed",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function normalizeInboundRequestForAuthority(
  request: InboundRequest,
  opts: { internal_authority_metadata?: boolean } = {},
): InboundRequest {
  const metadata = request.metadata
    ? canonicalJsonObject(request.metadata, {
        stripReservedAuthorityMetadata: opts.internal_authority_metadata !== true,
      })
    : undefined;
  const normalized: InboundRequest = {
    id: normalizeScalar(request.id, "id"),
    channel: normalizeScalar(request.channel, "channel"),
    user: normalizeScalar(request.user, "user"),
    content: request.content.normalize("NFKC"),
    timestamp: request.timestamp,
    ...(opts.internal_authority_metadata === true && request.session_id !== undefined
      ? { session_id: normalizeScalar(request.session_id, "session_id") }
      : {}),
    ...(request.goal_criteria ? { goal_criteria: GoalCriteriaSchema.parse(request.goal_criteria) } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  return opts.internal_authority_metadata === true
    ? markGatewayInternalInboundRequest(normalized)
    : normalized;
}

export function createGatewayInternalInboundRequest(
  request: GatewayInternalInboundRequestInput,
): InboundRequest {
  return normalizeInboundRequestForAuthority(request, {
    internal_authority_metadata: true,
  });
}

export function isGatewayInternalInboundRequest(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { [GATEWAY_INTERNAL_AUTHORITY_BRAND]?: unknown })[GATEWAY_INTERNAL_AUTHORITY_BRAND] === true,
  );
}

export function metadataKeyReservedForInternalAuthority(key: string): boolean {
  const normalized = key.normalize("NFKC").trim();
  return (
    RESERVED_EXTERNAL_METADATA_KEY_SET.has(normalized) ||
    normalized.startsWith("blue_tanuki.operation_core.") ||
    normalized.startsWith("blue_tanuki.operation_plan.") ||
    normalized.startsWith("blue_tanuki.channel_send.") ||
    normalized.startsWith("blue_tanuki.failure_review.")
  );
}

function normalizeScalar(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new Error(`${field} normalized to empty string`);
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error(`${field} contains path-like traversal characters`);
  }
  return normalized;
}

function canonicalJsonObject(
  value: MetadataObject,
  opts: { stripReservedAuthorityMetadata: boolean },
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (item === undefined) continue;
    const normalizedKey = normalizeMetadataKey(key);
    if (opts.stripReservedAuthorityMetadata && metadataKeyReservedForInternalAuthority(normalizedKey)) {
      continue;
    }
    out[normalizedKey] = canonicalJsonValue(item, opts);
  }
  return out;
}

function canonicalJsonValue(value: JsonValue, opts: { stripReservedAuthorityMetadata: boolean }): JsonValue {
  if (typeof value === "string") return value.normalize("NFKC");
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, opts));
  if (value && typeof value === "object") return canonicalJsonObject(value, opts);
  return value;
}

function normalizeMetadataKey(key: string): string {
  const normalized = key.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new Error("metadata key normalized to empty string");
  }
  if (normalized === "__proto__" || normalized === "prototype" || normalized === "constructor") {
    throw new Error(`metadata key is not allowed: ${normalized}`);
  }
  return normalized;
}

function markGatewayInternalInboundRequest(request: InboundRequest): InboundRequest {
  Object.defineProperty(request, GATEWAY_INTERNAL_AUTHORITY_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return request;
}
