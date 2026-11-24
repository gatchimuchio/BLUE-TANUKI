import { z } from "zod";
import { createHash } from "node:crypto";
import { GoalCriteriaSchema } from "./goal_criteria.js";
import { GoalCompletionRulesSchema } from "./goal_completion.js";

import { OperationCoreExecutorTraceSchema, OperationCommandExecutionResultSchema, type OperationInterface } from "./operation_core.js";

const DangerousObjectKeySchema = z.string().refine(
  (key) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
  "dangerous object key is not allowed",
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type MetadataObject = Record<string, JsonValue | undefined>;

const GATEWAY_INTERNAL_AUTHORITY_BRAND: unique symbol = Symbol("blue_tanuki.gateway_internal_authority.v1");
const GATEWAY_INTERNAL_TRANSIENT_AUDIO_REQUESTS = new WeakSet<object>();

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
  "blue_tanuki.cron.delegation.goal_id_digest",
  "blue_tanuki.cron.delegation.purpose_version",
  "blue_tanuki.cron.delegation.purpose_digest",
  "blue_tanuki.runtime_ingress.version",
  "blue_tanuki.runtime_ingress.runtime_id_digest",
  "blue_tanuki.runtime_ingress.session_id_digest",
  "blue_tanuki.runtime_ingress.used_for_authority",
  "blue_tanuki.failure_review",
  "blue_tanuki.goal_purpose_change.version",
  "blue_tanuki.goal_purpose_adoption.version",
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
  "blue_tanuki.cron.delegation.goal_id_digest"?: string;
  "blue_tanuki.cron.delegation.purpose_version"?: number;
  "blue_tanuki.cron.delegation.purpose_digest"?: string;
  "blue_tanuki.runtime_ingress.version"?: "d4-runtime-intent.v1";
  "blue_tanuki.runtime_ingress.runtime_id_digest"?: string;
  "blue_tanuki.runtime_ingress.session_id_digest"?: string;
  "blue_tanuki.runtime_ingress.used_for_authority"?: false;
  "blue_tanuki.channel_send.content"?: string;
  "blue_tanuki.failure_review.version"?: "blue-tanuki.failure-review.v1";
  "blue_tanuki.failure_review.signature_id"?: string;
  "blue_tanuki.failure_review.projection_json"?: string;
  "blue_tanuki.goal_purpose_change.version"?: "v1";
  "blue_tanuki.goal_purpose_adoption.version"?: "v1";
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
    "selected_google_drive_document_content",
    "selected_memory_references",
    "selected_mcp_tool_catalog",
    "selected_operation_plan_context",
    "selected_operation_result_observations",
    "session_history",
    "user_image",
    "user_audio",
    "user_canvas_artifact",
  ])).min(1).max(7),
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

/** 未確定の資源量は数値予約額が0でもJの再検討対象とする。 */
export function computeResourceUseRequiresReview(resourceUse: ComputeResourceUse): boolean {
  return resourceUse.charged_compute_ms > 0 || resourceUse.charged_tokens > 0 || resourceUse.charged_cost_amount > 0 ||
    resourceUse.tokens_usage_status === "unknown" || resourceUse.cost_status === "unknown";
}

const AgentDelegationResultEvidenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const AgentDelegationChildResultEvidenceV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema,
    outcome: z.literal("candidate"),
  }).strict(),
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema.optional(),
    outcome: z.literal("unknown"),
    reason: z.enum(["compute_outcome_unknown", "child_deadline_elapsed"]),
  }).strict(),
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema,
    outcome: z.literal("rejected"),
    reason: z.literal("invalid_child_output"),
  }).strict(),
]);

/** Digest-only legacy shape retained so append-only audit entries stay readable. */
export const AgentDelegationResultEvidenceV1Schema = z.object({
  schema_version: z.literal("blue-tanuki.agent-delegation-result-evidence.v1"),
  parent_command_digest: AgentDelegationResultEvidenceDigestSchema,
  contract_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_goal_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_task_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_budget_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  criteria_digest: AgentDelegationResultEvidenceDigestSchema,
  termination_digest: AgentDelegationResultEvidenceDigestSchema,
  children: z.tuple([
    AgentDelegationChildResultEvidenceV1Schema,
    AgentDelegationChildResultEvidenceV1Schema,
    AgentDelegationChildResultEvidenceV1Schema,
    AgentDelegationChildResultEvidenceV1Schema,
  ]).superRefine((children, context) => {
    const expectedRoles: AgentWorkerRole[] = ["division", "independent_comparison", "audit", "redundancy"];
    children.forEach((child, index) => {
      if (child.role !== expectedRoles[index]) {
        context.addIssue({ code: "custom", path: [index, "role"], message: "agent_delegation_result_role_order_mismatch" });
      }
    });
  }),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();
export type AgentDelegationResultEvidenceV1 = z.infer<typeof AgentDelegationResultEvidenceV1Schema>;

const AgentDelegationChildResultEvidenceV2UnionSchema = z.discriminatedUnion("outcome", [
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use: ComputeResourceUseSchema,
    outcome: z.literal("candidate"),
  }).strict(),
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema.optional(),
    resource_use: ComputeResourceUseSchema.optional(),
    outcome: z.literal("unknown"),
    reason: z.enum(["compute_outcome_unknown", "child_deadline_elapsed"]),
  }).strict(),
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use: ComputeResourceUseSchema,
    outcome: z.literal("rejected"),
    reason: z.literal("invalid_child_output"),
  }).strict(),
]);
const AgentDelegationChildResultEvidenceV2Schema = AgentDelegationChildResultEvidenceV2UnionSchema.superRefine((child, context) => {
  if (child.outcome === "unknown" &&
      ((child.resource_use_digest === undefined) !== (child.resource_use === undefined))) {
    context.addIssue({ code: "custom", message: "agent_delegation_resource_use_pair_mismatch" });
  }
});

/** Digest-bound resource measurements only; child candidate text is never stored here. */
export const AgentDelegationResultEvidenceV2Schema = z.object({
  schema_version: z.literal("blue-tanuki.agent-delegation-result-evidence.v2"),
  parent_command_digest: AgentDelegationResultEvidenceDigestSchema,
  contract_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_goal_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_task_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_budget_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  criteria_digest: AgentDelegationResultEvidenceDigestSchema,
  termination_digest: AgentDelegationResultEvidenceDigestSchema,
  children: z.tuple([
    AgentDelegationChildResultEvidenceV2Schema,
    AgentDelegationChildResultEvidenceV2Schema,
    AgentDelegationChildResultEvidenceV2Schema,
    AgentDelegationChildResultEvidenceV2Schema,
  ]).superRefine((children, context) => {
    const expectedRoles: AgentWorkerRole[] = ["division", "independent_comparison", "audit", "redundancy"];
    children.forEach((child, index) => {
      if (child.role !== expectedRoles[index]) {
        context.addIssue({ code: "custom", path: [index, "role"], message: "agent_delegation_result_role_order_mismatch" });
      }
    });
  }),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();
export type AgentDelegationResultEvidenceV2 = z.infer<typeof AgentDelegationResultEvidenceV2Schema>;

const AgentDelegationChildResultEvidenceV3UnionSchema = z.discriminatedUnion("outcome", [
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use: ComputeResourceUseSchema,
    /** Digest of the exact trimmed candidate text sent to parent C; it proves identity, not meaning. */
    candidate_content_digest: AgentDelegationResultEvidenceDigestSchema,
    outcome: z.literal("candidate"),
  }).strict(),
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema.optional(),
    resource_use: ComputeResourceUseSchema.optional(),
    outcome: z.literal("unknown"),
    reason: z.enum(["compute_outcome_unknown", "child_deadline_elapsed"]),
  }).strict(),
  z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use_digest: AgentDelegationResultEvidenceDigestSchema,
    resource_use: ComputeResourceUseSchema,
    outcome: z.literal("rejected"),
    reason: z.literal("invalid_child_output"),
  }).strict(),
]);
const AgentDelegationChildResultEvidenceV3Schema = AgentDelegationChildResultEvidenceV3UnionSchema.superRefine((child, context) => {
  if (child.outcome === "unknown" &&
      ((child.resource_use_digest === undefined) !== (child.resource_use === undefined))) {
    context.addIssue({ code: "custom", message: "agent_delegation_resource_use_pair_mismatch" });
  }
});

/** Digest-bound child candidate identity; raw child text remains outside J/M evidence. */
export const AgentDelegationResultEvidenceV3Schema = z.object({
  schema_version: z.literal("blue-tanuki.agent-delegation-result-evidence.v3"),
  parent_command_digest: AgentDelegationResultEvidenceDigestSchema,
  contract_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_goal_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_task_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_budget_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  criteria_digest: AgentDelegationResultEvidenceDigestSchema,
  termination_digest: AgentDelegationResultEvidenceDigestSchema,
  children: z.tuple([
    AgentDelegationChildResultEvidenceV3Schema,
    AgentDelegationChildResultEvidenceV3Schema,
    AgentDelegationChildResultEvidenceV3Schema,
    AgentDelegationChildResultEvidenceV3Schema,
  ]).superRefine((children, context) => {
    const expectedRoles: AgentWorkerRole[] = ["division", "independent_comparison", "audit", "redundancy"];
    children.forEach((child, index) => {
      if (child.role !== expectedRoles[index]) {
        context.addIssue({ code: "custom", path: [index, "role"], message: "agent_delegation_result_role_order_mismatch" });
      }
    });
  }),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();
export type AgentDelegationResultEvidenceV3 = z.infer<typeof AgentDelegationResultEvidenceV3Schema>;

export const AgentDelegationResultEvidenceSchema = z.discriminatedUnion("schema_version", [
  AgentDelegationResultEvidenceV1Schema,
  AgentDelegationResultEvidenceV2Schema,
  AgentDelegationResultEvidenceV3Schema,
]);
export type AgentDelegationResultEvidence = z.infer<typeof AgentDelegationResultEvidenceSchema>;

/** Cの子候補報告。引用とunknownはJの照合入力であり、実行権限や事実認定ではない。 */
export const AgentDelegationChildCandidateReportSchema = z.object({
  schema_version: z.literal("blue-tanuki.agent-child-candidate-report.v1"),
  candidate: z.string().trim().min(1).max(16_000),
  evidence: z.array(z.object({
    source: z.literal("parent_task"),
    quote: z.string().trim().min(1).max(800),
  }).strict()).max(8),
  counterevidence: z.array(z.object({
    source: z.literal("parent_task"),
    quote: z.string().trim().min(1).max(800),
  }).strict()).max(8),
  unknowns: z.array(z.string().trim().min(1).max(800)).max(8),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().superRefine((report, context) => {
  for (const [name, entries] of [["evidence", report.evidence], ["counterevidence", report.counterevidence]] as const) {
    const quotes = entries.map((entry) => entry.quote);
    if (new Set(quotes).size !== quotes.length) {
      context.addIssue({ code: "custom", path: [name], message: "agent_child_candidate_duplicate_quote" });
    }
  }
  if (new Set(report.unknowns).size !== report.unknowns.length) {
    context.addIssue({ code: "custom", path: ["unknowns"], message: "agent_child_candidate_duplicate_unknown" });
  }
});
export type AgentDelegationChildCandidateReport = z.infer<typeof AgentDelegationChildCandidateReportSchema>;

/** 一時的なJ照合入力。Controllerは本文を監査/Mへ転記せず、評価digestだけを残す。 */
export const AgentDelegationCandidateReviewPacketSchema = z.object({
  schema_version: z.literal("blue-tanuki.agent-delegation-candidate-review-packet.v1"),
  parent_command_digest: AgentDelegationResultEvidenceDigestSchema,
  contract_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_goal_digest: AgentDelegationResultEvidenceDigestSchema,
  parent_task_identity_digest: AgentDelegationResultEvidenceDigestSchema,
  criteria_digest: AgentDelegationResultEvidenceDigestSchema,
  termination_digest: AgentDelegationResultEvidenceDigestSchema,
  children: z.array(z.object({
    role: AgentWorkerRoleSchema,
    child_task_digest: AgentDelegationResultEvidenceDigestSchema,
    candidate_content_digest: AgentDelegationResultEvidenceDigestSchema,
    report: AgentDelegationChildCandidateReportSchema,
  }).strict()).max(4),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().superRefine((packet, context) => {
  const roles = packet.children.map((child) => child.role);
  const tasks = packet.children.map((child) => child.child_task_digest);
  if (new Set(roles).size !== roles.length || new Set(tasks).size !== tasks.length) {
    context.addIssue({ code: "custom", message: "agent_delegation_review_packet_duplicate_child" });
  }
});
export type AgentDelegationCandidateReviewPacket = z.infer<typeof AgentDelegationCandidateReviewPacketSchema>;

export const LLMComputeInputSourceSchema = z.enum([
  "accepted_inbound_request",
  "selected_google_drive_document_content",
  "selected_memory_references",
  "selected_mcp_tool_catalog",
  "selected_operation_plan_context",
  "failure_memory_digest_projection",
  "selected_operation_result_observations",
  "complete_history_digest_observations",
  "session_history",
  "user_image",
  "user_audio",
  "user_canvas_artifact",
]);
export type LLMComputeInputSource = z.infer<typeof LLMComputeInputSourceSchema>;

/** J's bounded authorization for one provider-compute task; it never authorizes tools or business effects. */
export const ComputeGrantSchema = z.object({
  schema_version: z.literal("blue-tanuki.compute-grant.v1"),
  grant_id: z.string().uuid(),
  request_id: z.string().trim().min(1).max(200),
  task_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  projection_digest: z.string().regex(/^[a-f0-9]{64}$/),
  purpose_digest: z.string().regex(/^[a-f0-9]{64}$/),
  local_p_version: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  allowed_input_sources: z.array(LLMComputeInputSourceSchema).min(1).max(6),
  max_tokens: z.number().int().safe().positive(),
  max_compute_ms: z.number().int().safe().positive(),
  max_cost: z.object({
    amount: z.number().finite().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
  issued_at_ms: z.number().int().safe().nonnegative(),
  expires_at_ms: z.number().int().safe().positive(),
  issuer: z.literal("J"),
}).strict().superRefine((grant, context) => {
  if (new Set(grant.allowed_input_sources).size !== grant.allowed_input_sources.length) {
    context.addIssue({ code: "custom", message: "compute_grant_input_sources_duplicate" });
  }
  if (grant.expires_at_ms <= grant.issued_at_ms) {
    context.addIssue({ code: "custom", message: "compute_grant_expiry_invalid" });
  }
  if (grant.expires_at_ms - grant.issued_at_ms > grant.max_compute_ms) {
    context.addIssue({ code: "custom", message: "compute_grant_lifetime_exceeds_compute_limit" });
  }
});
export type ComputeGrant = z.infer<typeof ComputeGrantSchema>;

export const LLMComputeContextSchema = z.object({
  schema_version: z.literal("blue-tanuki.compute-context.v1"),
  projection_digest: z.string().regex(/^[a-f0-9]{64}$/),
  local_p_version: z.string().trim().min(1).max(120),
  /** Optional only for local/legacy paths; external Provider use requires a current J grant. */
  compute_grant: ComputeGrantSchema.optional(),
  data_exposure: z.object({
    input_sources: z.array(LLMComputeInputSourceSchema).min(1).max(6),
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
  /** Optional provider-native reply thread, used only by channels that support it. */
  thread_ts: z.string().optional(),
  /** Optional provider-native message reference, used for a direct reply to an inbound message. */
  reply_to_message_id: z.string().optional(),
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

/** Exact read-only tool calls whose existing Complete History results may be projected by Gateway. */
export const FAILURE_REVIEW_READ_ONLY_TOOL_OPERATIONS = Object.freeze([
  "browser.read",
  "gmail.read",
  "google.calendar.read",
  "google.drive.read",
] as const);

const FailureReviewSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const FailureReviewScopeSchema = z.enum([
  "command", "tool", "file", "repo", "test", "llm_output", "workflow", "authority", "boundary",
]);
const FailureReviewTypeSchema = z.enum([
  "no_progress", "repeat_error", "boundary_violation", "hallucination", "wrong_file", "bad_command",
  "test_regression", "permission_error", "environment_error", "logic_drift", "unresolved_warning",
  "repeated_manual_correction",
]);

const FailureReviewBrowserReadObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.failure-review.browser-read-history.v1"),
  requested_origin_digest: FailureReviewSha256Schema,
  final_origin_digest: FailureReviewSha256Schema,
  origin_changed: z.boolean(),
  evidence_source: z.enum(["EXTERNAL_EVIDENCE", "FIXTURE"]),
  navigation: z.literal("http_get"),
  credential_context: z.literal("no_tool_supplied_credentials"),
  page_content_is_untrusted: z.literal(true),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

/** A digest-only, later read-only Complete History observation for a saved failure signature. */
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
  /** Present only when Gateway found a later exact read-only execution in Complete History. */
  observation_kind: z.literal("post_signature_read_only").optional(),
  operation: z.enum(["file.search", ...FAILURE_REVIEW_READ_ONLY_TOOL_OPERATIONS]).optional(),
  browser_read_observation: FailureReviewBrowserReadObservationSchema.optional(),
  result_status: z.literal("success").optional(),
  entry_index: z.number().int().nonnegative().optional(),
  observed_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  action_pattern_digest: FailureReviewSha256Schema.optional(),
  input_pattern_digest: FailureReviewSha256Schema.optional(),
  context_pattern_digest: FailureReviewSha256Schema.optional(),
  result_digest: FailureReviewSha256Schema.optional(),
}).strict().superRefine((observation, context) => {
  if (observation.operation === "browser.read" && !observation.browser_read_observation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "browser.read observation metadata is required" });
  }
  if (observation.operation !== "browser.read" && observation.browser_read_observation !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "browser.read metadata cannot accompany another operation" });
  }
});
export type FailureReviewIndependentObservation = z.infer<typeof FailureReviewIndependentObservationSchema>;

/** C由来の失敗レビューに対する、実行権限を持たないJ判定の要約。 */
export const FailureReviewJDispositionSchema = z.object({
  disposition_digest: FailureReviewSha256Schema,
  scope_disposition: z.enum(["held_for_independent_observation", "bound_to_independent_observation"]),
  independent_observation_count: z.number().int().nonnegative(),
  independent_observation_digest: FailureReviewSha256Schema,
  counterexample_review_target_status: z.enum(["not_present", "held_for_scope", "retained_for_future_observation"]),
  resume_condition_review_target_status: z.enum(["not_present", "held_for_scope", "retained_for_future_observation"]),
  cause_adoption: z.literal("not_adopted"),
  follow_up_required: z.enum(["none", "independent_observation"]),
  may_execute: z.literal(false),
  used_for_authority: z.literal(false),
}).strict();
export type FailureReviewJDisposition = z.infer<typeof FailureReviewJDispositionSchema>;

/** 以前のC導出と、任意でそのJ判定要約を参照する非権威reference。 */
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
  j_disposition: FailureReviewJDispositionSchema.optional(),
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
  j_disposition: FailureReviewJDispositionSchema.optional(),
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
  baseline_evidence_last_index: z.number().int().nonnegative().optional(),
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

export const ExecuteFeedbackSchema = z.object({
  command_id: z.string(),
  status: z.enum(["success", "failed", "suspended"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  llm_failure: LLMCallFailureSchema.optional(),
  compute_resource_use: ComputeResourceUseSchema.optional(),
  agent_delegation_result_evidence: AgentDelegationResultEvidenceSchema.optional(),
  /** 一時的な子報告照合入力。HDSは評価後、候補本文/引用を永続化しない。 */
  agent_delegation_candidate_review: AgentDelegationCandidateReviewPacketSchema.optional(),
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
  goal_completion_rules: GoalCompletionRulesSchema.optional(),
  metadata: z.record(DangerousObjectKeySchema, JsonValueSchema.optional()).optional(),
}).strict();
export type InboundRequest = z.infer<typeof InboundRequestSchema>;

/**
 * In-process image bytes used only for one downstream C request. This type is
 * deliberately not part of InboundRequest or any persisted protocol schema.
 */
export interface TransientImageInput {
  readonly media_type: "image/jpeg" | "image/png";
  readonly data: Uint8Array;
}

export const TRANSIENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CANONICAL_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** RFC 4648の正規Base64表記を、padding bitを含めて検証する。 */
export function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_CANONICAL_PATTERN.test(value)) return false;
  if (value.endsWith("==")) {
    const finalValue = BASE64_ALPHABET.indexOf(value.charAt(value.length - 3));
    return finalValue >= 0 && (finalValue & 0x0f) === 0;
  }
  if (value.endsWith("=")) {
    const finalValue = BASE64_ALPHABET.indexOf(value.charAt(value.length - 2));
    return finalValue >= 0 && (finalValue & 0x03) === 0;
  }
  return true;
}

export function detectTransientImageMediaType(bytes: Uint8Array): TransientImageInput["media_type"] | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.byteLength >= pngSignature.length &&
    pngSignature.every((value, index) => bytes[index] === value)
    ? "image/png"
    : null;
}

/** In-process audio bytes used only for one downstream transcription call. */
export interface TransientAudioInput {
  readonly format: "flac" | "mp3" | "mp4" | "mpeg" | "mpga" | "m4a" | "ogg" | "wav" | "webm";
  readonly data: Uint8Array;
}

/** One-request Canvas source data for C. It is never part of InboundRequest or persisted history. */
export interface TransientCanvasArtifactInput {
  readonly media_type: "text/html" | "text/markdown";
  readonly source_request_id: string;
  readonly version: 1;
  readonly sha256: string;
  readonly data: Uint8Array;
}

export const TRANSIENT_CANVAS_ARTIFACT_MAX_BYTES = 64 * 1024;

export const TRANSIENT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

export function detectTransientAudioFormat(bytes: Uint8Array): TransientAudioInput["format"] | null {
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "flac";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return "wav";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "ogg";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    return brand.startsWith("M4A") ? "m4a" : "mp4";
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0) return "mp3";
  return null;
}

export function transientAudioMimeMatches(value: string | undefined, format: TransientAudioInput["format"]): boolean {
  if (value === undefined) return true;
  const mime = value.split(";")[0]?.trim().toLowerCase();
  const allowed: Readonly<Record<TransientAudioInput["format"], readonly string[]>> = {
    flac: ["audio/flac", "audio/x-flac"],
    mp3: ["audio/mpeg", "audio/mp3", "audio/x-mpeg"],
    mp4: ["audio/mp4", "video/mp4"],
    m4a: ["audio/mp4", "audio/x-m4a"],
    mpeg: ["audio/mpeg"],
    mpga: ["audio/mpeg", "audio/mpga"],
    ogg: ["audio/ogg", "application/ogg", "audio/opus"],
    wav: ["audio/wav", "audio/x-wav", "audio/wave"],
    webm: ["audio/webm", "video/webm"],
  };
  return mime !== undefined && (allowed[format]?.includes(mime) ?? false);
}

const RegisteredRuntimeReferenceSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

/** Authenticated D4 Runtime session transport reference; identifiers are context only. */
export const RuntimeSessionInputSchema = z.object({
  runtime_id: RegisteredRuntimeReferenceSchema,
  session_id: RegisteredRuntimeReferenceSchema,
}).strict();
export type RuntimeSessionInput = z.infer<typeof RuntimeSessionInputSchema>;

const RuntimeSubmissionIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);

/** Authenticated D4 Runtime dialogue input; submission_id is an idempotency key, never authority. */
const RuntimeIntentImageInputSchema = z.object({
  media_type: z.enum(["image/jpeg", "image/png"]),
  data_base64: z.string().min(4).max(Math.ceil(TRANSIENT_IMAGE_MAX_BYTES / 3) * 4).refine(isCanonicalBase64),
}).strict();

const RuntimeIntentAudioInputSchema = z.object({
  data_base64: z.string().min(4).max(Math.ceil(TRANSIENT_AUDIO_MAX_BYTES / 3) * 4).refine(isCanonicalBase64),
}).strict();

export const RuntimeIntentInputSchema = z.object({
  runtime_id: RegisteredRuntimeReferenceSchema,
  session_id: RegisteredRuntimeReferenceSchema,
  submission_id: RuntimeSubmissionIdSchema,
  intent: z.string().min(1).max(4_096),
  /** Optional one-request image bytes; decoded only into Gateway ephemeral context. */
  image_input: RuntimeIntentImageInputSchema.optional(),
  /** Optional one-request audio bytes; decoded only into Gateway ephemeral context. */
  audio_input: RuntimeIntentAudioInputSchema.optional(),
}).strict();
export type RuntimeIntentInput = z.infer<typeof RuntimeIntentInputSchema>;

/** Content-free state lookup for a previously submitted D4 Runtime intent. */
export const RuntimeIntentStatusInputSchema = z.object({
  runtime_id: RegisteredRuntimeReferenceSchema,
  session_id: RegisteredRuntimeReferenceSchema,
  submission_id: RuntimeSubmissionIdSchema,
}).strict();
export type RuntimeIntentStatusInput = z.infer<typeof RuntimeIntentStatusInputSchema>;

export const RuntimeIntentStatusQuerySchema = RuntimeIntentStatusInputSchema.extend({
  include_reply_observation: z.literal(true).optional(),
});

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
    const request = normalizeInboundRequestForAuthority(parsed.data, {
      internal_authority_metadata: isGatewayInternalInboundRequest(raw),
    });
    if (isGatewayInternalTransientAudioRequest(raw)) {
      GATEWAY_INTERNAL_TRANSIENT_AUDIO_REQUESTS.add(request);
    }
    return {
      ok: true,
      request,
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
    ...(opts.internal_authority_metadata === true && request.goal_completion_rules
      ? { goal_completion_rules: GoalCompletionRulesSchema.parse(request.goal_completion_rules) } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  if (opts.internal_authority_metadata !== true) return normalized;
  markGatewayInternalInboundRequest(normalized);
  if (isGatewayInternalTransientAudioRequest(request)) {
    GATEWAY_INTERNAL_TRANSIENT_AUDIO_REQUESTS.add(normalized);
  }
  return normalized;
}

export function createGatewayInternalInboundRequest(
  request: GatewayInternalInboundRequestInput,
): InboundRequest {
  return normalizeInboundRequestForAuthority(request, {
    internal_authority_metadata: true,
  });
}

/** D4 Runtime由来の制限付きGateway要求であることを内部印と受付digestまで照合する。 */
export function isGatewayInternalD4RuntimeIntentRequest(value: unknown): value is InboundRequest {
  if (!isGatewayInternalInboundRequest(value)) return false;
  const request = value as InboundRequest;
  const runtimeIdDigest = request.metadata?.["blue_tanuki.runtime_ingress.runtime_id_digest"];
  const sessionIdDigest = request.metadata?.["blue_tanuki.runtime_ingress.session_id_digest"];
  return request.channel === "webchat" && request.user === "d4-runtime-adapter-token-holder" &&
    request.metadata?.["blue_tanuki.actor_kind"] === "user" &&
    request.metadata?.["blue_tanuki.trust_level"] === "limited" &&
    request.metadata?.["blue_tanuki.process_kind"] === "chat" &&
    request.metadata?.["blue_tanuki.runtime_ingress.version"] === "d4-runtime-intent.v1" &&
    typeof runtimeIdDigest === "string" && /^[a-f0-9]{64}$/u.test(runtimeIdDigest) &&
    typeof sessionIdDigest === "string" && /^[a-f0-9]{64}$/u.test(sessionIdDigest) &&
    request.metadata?.["blue_tanuki.runtime_ingress.used_for_authority"] === false;
}

/**
 * Bind a Gateway-validated, one-request audio input to its HDS decision without
 * adding media bytes or a caller-forgeable marker to the persisted request.
 */
export function createGatewayInternalTransientAudioRequest(
  request: InboundRequest,
  context: {
    readonly request_id: string;
    readonly ephemeral_images: readonly TransientImageInput[];
    readonly ephemeral_audio?: readonly TransientAudioInput[];
  },
): InboundRequest {
  const audio = context.ephemeral_audio;
  const input = audio?.length === 1 ? audio[0] : undefined;
  const telegramInput = request.channel === "telegram";
  const ownerWebChatInput = request.channel === "webchat" && isGatewayInternalInboundRequest(request) &&
    request.user === "webchat-owner-token-holder" &&
    request.metadata?.["blue_tanuki.actor_kind"] === "owner" &&
    request.metadata?.["blue_tanuki.trust_level"] === "owner" &&
    request.metadata?.["blue_tanuki.process_kind"] === "chat" &&
    request.metadata?.["blue_tanuki.operator_surface"] === "developer" &&
    request.metadata?.["blue_tanuki.operation_core.projection_id"] === "owner-audio-transcription:operation-core" &&
    request.metadata?.["blue_tanuki.operation_core.used_for_authority"] === false;
  const d4RuntimeInput = isGatewayInternalD4RuntimeIntentRequest(request);
  if ((!telegramInput && !ownerWebChatInput && !d4RuntimeInput) || context.request_id !== request.id ||
      context.ephemeral_images.length !== 0 || !input ||
      !(input.data instanceof Uint8Array) || input.data.byteLength === 0 ||
      input.data.byteLength > TRANSIENT_AUDIO_MAX_BYTES || detectTransientAudioFormat(input.data) !== input.format) {
    throw new Error("transient audio request is not bound to one validated Telegram, owner WebChat, or D4 Runtime input");
  }
  const internal = createGatewayInternalInboundRequest({
    ...request,
    metadata: {
      ...(request.metadata ?? {}),
      "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.transient_audio.input_sha256": createHash("sha256").update(input.data).digest("hex"),
      "blue_tanuki.transient_audio.format": input.format,
      "blue_tanuki.transient_audio.byte_length": input.data.byteLength,
      "blue_tanuki.transient_audio.reference_is_ephemeral": true,
      "blue_tanuki.transient_audio.used_for_authority": false,
    },
  });
  GATEWAY_INTERNAL_TRANSIENT_AUDIO_REQUESTS.add(internal);
  return internal;
}

export function isGatewayInternalTransientAudioRequest(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && GATEWAY_INTERNAL_TRANSIENT_AUDIO_REQUESTS.has(value));
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
