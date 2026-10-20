import { z } from "zod";
import { OperationPlanSchema, OperationJsonValueSchema, OperationTargetSchema, OperationStepSchema } from "./operation_core.js";
import { ExecutionAdmissionSchema } from "./execution_result_delivery.js";
import { MemoryCommitV2Schema, MemoryUpdateReceiptV1Schema } from "./状態更新契約.js";
import { GoalCriteriaProjectionSchema } from "./goal_criteria.js";

const Id = z.string().min(1).max(200);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const GoalRef = z.string().regex(/^goal_[a-f0-9]{16,64}$/);
export const OperationPlanGoalPurposeBindingSchema = z.object({
  goal_ref: GoalRef,
  purpose_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  purpose_digest: Digest,
}).strict();
export type OperationPlanGoalPurposeBinding = z.infer<typeof OperationPlanGoalPurposeBindingSchema>;
/** Explicit, non-authority reference to one J/M-verified plan result. */
const OperationPlanPlanComputeSourceObservationReferenceSchema = z.object({
  plan_id_digest: Digest,
  revision_digest: Digest,
  step_id_digest: Digest,
}).strict();
/** Explicit selection of one digest-only shell result report. */
const OperationPlanShellResultComputeSourceObservationReferenceSchema = z.object({
  command_id_digest: Digest,
}).strict();
export const OperationPlanComputeSourceObservationReferenceSchema = z.union([
  OperationPlanPlanComputeSourceObservationReferenceSchema,
  OperationPlanShellResultComputeSourceObservationReferenceSchema,
]);
export type OperationPlanComputeSourceObservationReference = z.infer<typeof OperationPlanComputeSourceObservationReferenceSchema>;
/** Finite projections carry no target, path, query, or file content. */
const OperationPlanComputeSourceObservationCommon = {
  schema_version: z.literal("operation-plan-compute-source-observation.v1"),
  /** Stable J-owned task correlation; it does not establish semantic fit or authority. */
  task_identity_digest: Digest.optional(),
  effect_observation: z.literal("reported_success"),
  record_digest: Digest,
  memory_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  memory_receipt_digest: Digest,
  observed_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  adoption_status: z.literal("observation_only"),
  used_as_world_truth: z.literal(false),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
};
const OperationPlanPlanComputeSourceObservation = {
  ...OperationPlanComputeSourceObservationCommon,
  plan_id_digest: Digest,
  revision_digest: Digest,
  step_id_digest: Digest,
  plan_binding_status: z.literal("verified"),
  plan_validation_status: z.literal("matched"),
};
export const OperationPlanComputeSourceObservationSchema = z.discriminatedUnion("source", [
  z.object({ ...OperationPlanPlanComputeSourceObservation,
    source: z.literal("verified_file_write_result"), operation: z.literal("file.write") }).strict(),
  z.object({ ...OperationPlanPlanComputeSourceObservation,
    source: z.literal("verified_file_delete_result"), operation: z.literal("file.delete") }).strict(),
  z.object({ ...OperationPlanPlanComputeSourceObservation,
    source: z.literal("verified_file_edit_result"), operation: z.literal("file.edit") }).strict(),
  z.object({ ...OperationPlanPlanComputeSourceObservation,
    source: z.literal("verified_file_search_result"), operation: z.literal("file.search"),
    expires_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    match_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    visited_files: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    search_completeness: z.literal("unknown"),
  }).strict(),
  z.object({ ...OperationPlanComputeSourceObservationCommon,
    source: z.literal("verified_shell_exec_result"), operation: z.literal("shell.exec"),
    command_id_digest: Digest, request_id_digest: Digest, upstream_commit_hash_digest: Digest,
    command_payload_digest: Digest, result_id_digest: Digest, result_contract_digest: Digest,
    result_digest: Digest, execution_status: z.literal("succeeded"),
    execution_boundary: z.literal("tool_adapter"), action_outcome: z.literal("reported_success"),
  }).strict(),
]);
export type OperationPlanComputeSourceObservation = z.infer<typeof OperationPlanComputeSourceObservationSchema>;

/** J-source-matched, digest-only shell result; no command or process output is retained. */
export const OperationPlanShellExecResultObservationSchema = z.object({
  schema_version: z.literal("operation-plan-shell-exec-result.v1"),
  owner_digest: Digest,
  channel_digest: Digest,
  request_id_digest: Digest,
  command_id_digest: Digest,
  upstream_commit_hash_digest: Digest,
  command_payload_digest: Digest,
  result_id_digest: Digest,
  result_contract_digest: Digest,
  result_digest: Digest,
  execution_status: z.literal("succeeded"),
  execution_boundary: z.literal("tool_adapter"),
  action_outcome: z.literal("reported_success"),
  plan_step_binding: z.literal("unbound"),
  observed_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
  memory_commit: MemoryCommitV2Schema.optional(),
  memory_receipt: MemoryUpdateReceiptV1Schema.optional(),
}).strict();
export type OperationPlanShellExecResultObservation = z.infer<typeof OperationPlanShellExecResultObservationSchema>;
/** J記録済みの記憶引用が依存した解釈版。依存情報は権限ではない。 */
export const OperationPlanMemoryInterpretationDependencySchema = z.object({
  reference: z.object({ record_id: Id, version: Digest }).strict(),
  interpretation_id: Id,
  judgment_ref: Id,
  reassesses_judgment_refs: z.array(Id).max(64).optional(),
}).strict().superRefine((dependency, context) => {
  const reassessed = dependency.reassesses_judgment_refs ?? [];
  if (new Set(reassessed).size !== reassessed.length || reassessed.includes(dependency.judgment_ref)) {
    context.addIssue({ code: "custom", message: "invalid_memory_interpretation_reassessment_references" });
  }
});
export type OperationPlanMemoryInterpretationDependency = z.infer<typeof OperationPlanMemoryInterpretationDependencySchema>;
export const OPERATION_PLAN_COMPUTE_SOURCE_OBSERVATION_LOCAL_P_VERSION =
  "blue-tanuki.plan-compute-source-observations.v6";
export const OPERATION_PLAN_COMPUTE_MEMORY_CITATION_LOCAL_P_VERSION =
  "blue-tanuki.plan-compute-memory-citation.v1";
/** Explicit task input for internal plan computation; the binding selects context, not authority. */
export const OperationPlanComputeInputSchema = z.object({
  task: z.string().trim().min(1).max(20_000),
  goal_purpose_binding: OperationPlanGoalPurposeBindingSchema.optional(),
  source_citation_request_id: z.string().trim().min(1).max(128).optional(),
  source_observation_refs: z.array(OperationPlanComputeSourceObservationReferenceSchema).max(8).optional(),
}).strict().superRefine((input, context) => {
  if (!input.goal_purpose_binding && !input.source_citation_request_id) {
    context.addIssue({ code: "custom", message: "plan_compute_context_binding_required" });
  }
  const references = input.source_observation_refs ?? [];
  if (references.length > 0 && !input.goal_purpose_binding) {
    context.addIssue({ code: "custom", message: "plan_compute_source_observation_requires_purpose_binding" });
  }
  const identities = references.map((reference) => "command_id_digest" in reference
    ? `shell:${reference.command_id_digest}`
    : `plan:${reference.plan_id_digest}:${reference.revision_digest}:${reference.step_id_digest}`);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", message: "duplicate_plan_compute_source_observation_reference" });
  }
});
export type OperationPlanComputeInput = z.infer<typeof OperationPlanComputeInputSchema>;
/** C's task-purpose relation claim is a candidate only; exact citations do not verify semantic fit. */
export const OperationPlanGoalPurposeRelationCandidateSchema = z.object({
  outcome: z.enum(["supports", "conflicts", "unknown"]),
  evidence: z.array(z.object({
    task_quote: z.string().min(1).max(800).refine((value) => value.trim().length > 0),
    purpose_quote: z.string().min(1).max(800).refine((value) => value.trim().length > 0),
  }).strict()).max(8),
}).strict().superRefine((candidate, context) => {
  if (candidate.outcome !== "unknown" && candidate.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "non_unknown_purpose_relation_requires_cited_evidence" });
  }
});
export type OperationPlanGoalPurposeRelationCandidate = z.infer<typeof OperationPlanGoalPurposeRelationCandidateSchema>;
/** Content-bound request accepted for an explicit owner-token-holder purpose relation review. */
export const OperationPlanGoalPurposeRelationReviewArgumentsSchema = z.object({
  plan_id_digest: Digest,
  task_digest: Digest,
  revision_digest: Digest,
  goal_ref: z.string().regex(/^goal_[a-f0-9]{16,64}$/),
  purpose_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  purpose_digest: Digest,
  outcome: z.enum(["supports", "conflicts", "unknown"]),
}).strict();
export type OperationPlanGoalPurposeRelationReviewArguments = z.infer<typeof OperationPlanGoalPurposeRelationReviewArgumentsSchema>;

/** J-owned digest reference to an explicit, content-bound L3 relation review. */
export const OperationPlanGoalPurposeRelationOwnerReviewSchema = z.object({
  outcome: z.enum(["supports", "conflicts", "unknown"]),
  request_id: z.string().min(1).max(128),
  command_id: z.string().min(1).max(128),
  command_digest: Digest,
  target_digest: Digest,
  proposal_actor_digest: Digest,
  reviewer_actor_digest: Digest,
  content_review_digest: Digest,
  reviewed_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  audit_event_digest: Digest,
}).strict();
export type OperationPlanGoalPurposeRelationOwnerReview = z.infer<typeof OperationPlanGoalPurposeRelationOwnerReviewSchema>;

/** J's digest-only record of a C claim and any separate owner-reviewed evidence. */
export const OperationPlanGoalPurposeRelationRecordSchema = z.object({
  schema_version: z.literal("operation-plan-goal-purpose-relation.v1"),
  task_digest: Digest,
  plan_digest: Digest,
  goal_purpose_binding: OperationPlanGoalPurposeBindingSchema,
  candidate_outcome: z.enum(["supports", "conflicts", "unknown"]),
  candidate_status: z.enum(["present", "missing", "invalid"]),
  evidence_status: z.enum(["exact_spans_present", "not_provided", "citation_mismatch", "purpose_unavailable"]),
  evidence_digests: z.array(z.object({ task_span_digest: Digest, purpose_span_digest: Digest }).strict()).max(8),
  owner_review: OperationPlanGoalPurposeRelationOwnerReviewSchema.optional(),
  semantic_assessment_status: z.literal("not_assessed"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().superRefine((record, context) => {
  if ((record.candidate_status !== "present" || record.evidence_status !== "exact_spans_present") &&
      record.evidence_digests.length > 0) {
    context.addIssue({ code: "custom", message: "unverified_purpose_relation_must_not_keep_evidence_digests" });
  }
  if ((record.candidate_status === "missing" || record.candidate_status === "invalid") &&
      record.candidate_outcome !== "unknown") {
    context.addIssue({ code: "custom", message: "missing_or_invalid_purpose_relation_must_be_unknown" });
  }
  if (record.evidence_status === "exact_spans_present" && record.evidence_digests.length === 0) {
    context.addIssue({ code: "custom", message: "exact_purpose_relation_evidence_requires_digests" });
  }
});
export type OperationPlanGoalPurposeRelationRecord = z.infer<typeof OperationPlanGoalPurposeRelationRecordSchema>;
export const OperationPlanExternalReceiptObservationSchema = z.object({
  schema_version: z.literal("external-receipt-observation.v1"),
  source: z.literal("local_inspection"),
  plan_id_digest: Digest,
  revision_digest: Digest,
  step_id_digest: Digest,
  command_digest: Digest,
  executor_command_digest: Digest,
  command_key_digest: Digest,
  observed_command_digest: Digest.optional(),
  observed_command_key_digest: Digest.optional(),
  request_payload_digest: Digest,
  observed_payload_digest: Digest.optional(),
  candidate_set_digest: Digest,
  status: z.enum(["matched", "not_found", "mismatch", "ambiguous"]),
  match_count: z.number().int().min(0).max(100),
  receipt_digest: Digest.optional(),
  evidence_digest: Digest,
  observed_at_ms: z.number().int().safe().nonnegative(),
  used_for_authority: z.literal(false),
  raw_receipt_exposed: z.literal(false),
}).strict().superRefine((observation, context) => {
  if (observation.status === "matched" && (observation.match_count !== 1 || !observation.receipt_digest ||
      !observation.observed_command_digest || !observation.observed_command_key_digest || !observation.observed_payload_digest)) {
    context.addIssue({ code: "custom", message: "matched_receipt_requires_one_digest_bound_record" });
  }
  if (observation.status === "matched" && observation.observed_payload_digest !== observation.request_payload_digest) {
    context.addIssue({ code: "custom", message: "matched_receipt_requires_payload_digest_match" });
  }
  if (observation.status === "matched" && (observation.observed_command_digest !== observation.executor_command_digest ||
      observation.observed_command_key_digest !== observation.command_key_digest)) {
    context.addIssue({ code: "custom", message: "matched_receipt_requires_command_digest_match" });
  }
  if (observation.status === "not_found" && (observation.match_count !== 0 || observation.receipt_digest !== undefined ||
      observation.observed_command_digest !== undefined || observation.observed_command_key_digest !== undefined ||
      observation.observed_payload_digest !== undefined)) {
    context.addIssue({ code: "custom", message: "not_found_receipt_must_have_no_matches" });
  }
  if (observation.status === "mismatch" && (observation.match_count !== 1 || !observation.receipt_digest ||
      !observation.observed_command_digest || !observation.observed_command_key_digest || !observation.observed_payload_digest)) {
    context.addIssue({ code: "custom", message: "mismatched_receipt_requires_one_candidate" });
  }
  if (observation.status === "mismatch" && observation.observed_payload_digest === observation.request_payload_digest &&
      observation.observed_command_digest === observation.executor_command_digest &&
      observation.observed_command_key_digest === observation.command_key_digest) {
    context.addIssue({ code: "custom", message: "mismatched_receipt_requires_digest_mismatch" });
  }
  if (observation.status === "ambiguous" && (observation.match_count < 2 || observation.receipt_digest !== undefined ||
      observation.observed_command_digest !== undefined || observation.observed_command_key_digest !== undefined ||
      observation.observed_payload_digest !== undefined)) {
    context.addIssue({ code: "custom", message: "ambiguous_receipt_requires_multiple_candidates" });
  }
});
export type OperationPlanExternalReceiptObservation = z.infer<typeof OperationPlanExternalReceiptObservationSchema>;

/** J-owned linkage for delivering digest-only receipt evidence to M. It grants no authority. */
export const OperationPlanReceiptMemoryDeliverySchema = z.object({
  evidence_digest: Digest,
  memory_commit: MemoryCommitV2Schema.optional(),
  memory_receipt: MemoryUpdateReceiptV1Schema.optional(),
}).strict().superRefine((delivery, context) => {
  if (delivery.memory_receipt && !delivery.memory_commit) {
    context.addIssue({ code: "custom", message: "receipt_memory_receipt_requires_commit" });
  }
});
export type OperationPlanReceiptMemoryDelivery = z.infer<typeof OperationPlanReceiptMemoryDeliverySchema>;

/** J-owned durable wait linkage. It correlates one plan task with a reply or deadline and grants no authority. */
export const OperationPlanWaitStateSchema = z.object({
  wait_id: Digest,
  plan_id_digest: Digest,
  task_identity_digest: Digest,
  revision_digest: Digest,
  owner_digest: Digest,
  channel_digest: Digest,
  session_id_digest: Digest,
  deadline_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  created_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["waiting", "resumed"]),
  resumed_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  wake_reason: z.enum(["reply", "deadline"]).optional(),
  wake_event_id_digest: Digest.optional(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().superRefine((wait, context) => {
  const resumedFieldsPresent = wait.resumed_at_ms !== undefined && wait.wake_reason !== undefined &&
    wait.wake_event_id_digest !== undefined;
  if (wait.deadline_at_ms <= wait.created_at_ms) {
    context.addIssue({ code: "custom", message: "operation_plan_wait_deadline_must_follow_creation" });
  }
  if ((wait.state === "waiting" && (wait.resumed_at_ms !== undefined || wait.wake_reason !== undefined ||
      wait.wake_event_id_digest !== undefined)) || (wait.state === "resumed" && !resumedFieldsPresent)) {
    context.addIssue({ code: "custom", message: "operation_plan_wait_state_fields_mismatch" });
  }
  if (wait.resumed_at_ms !== undefined && wait.resumed_at_ms < wait.created_at_ms) {
    context.addIssue({ code: "custom", message: "operation_plan_wait_resume_precedes_creation" });
  }
});
export type OperationPlanWaitState = z.infer<typeof OperationPlanWaitStateSchema>;

export const OperationPlanControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), plan_id: Id, revision_digest: Digest, step_id: Id,
    goal_purpose_binding: OperationPlanGoalPurposeBindingSchema.optional() }).strict(),
  z.object({ action: z.literal("reconcile"), plan_id: Id, revision_digest: Digest, step_id: Id }).strict(),
  z.object({ action: z.literal("revise"), plan_id: Id, expected_revision_digest: Digest, plan: OperationPlanSchema }).strict(),
  z.object({ action: z.literal("wait"), plan_id: Id, revision_digest: Digest,
    deadline_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ action: z.literal("reflect"), plan_id: Id, revision_digest: Digest,
    step_ids: z.array(Id).min(1).max(8), question: z.string().trim().min(1).max(4000) }).strict(),
]);
export type OperationPlanControl = z.infer<typeof OperationPlanControlSchema>;
export type OperationPlanReflectionControl = Extract<OperationPlanControl, { action: "reflect" }>;
export type OperationPlanReceiptReconciliationControl = Extract<OperationPlanControl, { action: "reconcile" }>;
export const OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION = "blue-tanuki.result-reflection.v2";
/** Cの解釈候補。形状・引用一致は意味採用や実行許可を表さない。 */
export const OperationPlanReflectionCandidateSchema = z.object({
  schema_version: z.literal("operation-result-reflection-candidate.v1"), projection_digest: Digest,
  citations: z.array(z.object({ record_id: Id, record_digest: Digest,
    interpretation: z.string().trim().min(1).max(800), uncertainty: z.string().trim().min(1).max(800) }).strict()).min(1).max(8),
}).strict();

export const OperationPlanCheckpointSchema = z.object({
  schema_version: z.literal("operation-plan-state.v1"),
  waits: z.array(OperationPlanWaitStateSchema).max(256).optional(),
  shell_exec_result_observations: z.array(OperationPlanShellExecResultObservationSchema).max(256).optional(),
  plans: z.array(z.object({
    owner: Id, channel: Id, goal: z.string().min(1).max(200_000),
    /** Stable task lineage across J-authorized wait/resume plan candidates; non-authority identity only. */
    task_identity_digest: Digest.optional(),
    goal_purpose_binding: OperationPlanGoalPurposeBindingSchema.optional(),
    goal_purpose_relation: OperationPlanGoalPurposeRelationRecordSchema.optional(),
    compute_source_observations: z.array(OperationPlanComputeSourceObservationSchema).max(8).optional(),
    memory_interpretation_dependencies: z.array(OperationPlanMemoryInterpretationDependencySchema).max(64).optional(),
    request_goal_criteria: GoalCriteriaProjectionSchema.optional(),
    revisions: z.array(z.object({ digest: Digest, plan: OperationPlanSchema }).strict()).min(1).max(100),
    receipt_observations: z.array(OperationPlanExternalReceiptObservationSchema).max(100).default([]),
    receipt_memory: z.array(OperationPlanReceiptMemoryDeliverySchema).max(100).optional(),
    bindings: z.array(z.object({
      step_id: Id, revision_digest: Digest, step_digest: Digest, prepared_step: OperationStepSchema,
      command_id: Id, request_id: Id, commit_hash: Id, payload_digest: Digest, command_digest: Digest,
      executor_command_digest: Digest.optional(),
      operation: Id,
      status: z.enum(["selected", "intent_committed", "verified", "outcome_unknown", "verification_failed", "not_attempted", "invalidated"]),
      result_digest: Digest.optional(),
      execution_admission: ExecutionAdmissionSchema.optional(),
      delivery_digest: Digest.optional(),
      memory_commit: MemoryCommitV2Schema.optional(),
      memory_receipt: MemoryUpdateReceiptV1Schema.optional(),
    }).strict()).max(1000),
    results: z.array(z.object({
      plan_id: Id, request_id: Id, step_id: Id, result_id: Id, operation: Id,
      status: z.literal("succeeded"), target: OperationTargetSchema,
      output: OperationJsonValueSchema,
      observed_at_ms: z.number().finite().nonnegative(),
      expires_at_ms: z.number().finite().nonnegative(),
    }).strict()).max(100),
  }).strict()).max(64),
}).strict();
export type OperationPlanCheckpoint = z.infer<typeof OperationPlanCheckpointSchema>;
