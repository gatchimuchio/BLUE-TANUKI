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
/** Explicit task input for internal plan computation; the binding selects context, not authority. */
export const OperationPlanComputeInputSchema = z.object({
  task: z.string().trim().min(1).max(20_000),
  goal_purpose_binding: OperationPlanGoalPurposeBindingSchema,
}).strict();
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
/** J's digest-only record of a C claim. It remains unassessed and cannot admit execution. */
export const OperationPlanGoalPurposeRelationRecordSchema = z.object({
  schema_version: z.literal("operation-plan-goal-purpose-relation.v1"),
  task_digest: Digest,
  plan_digest: Digest,
  goal_purpose_binding: OperationPlanGoalPurposeBindingSchema,
  candidate_outcome: z.enum(["supports", "conflicts", "unknown"]),
  candidate_status: z.enum(["present", "missing", "invalid"]),
  evidence_status: z.enum(["exact_spans_present", "not_provided", "citation_mismatch", "purpose_unavailable"]),
  evidence_digests: z.array(z.object({ task_span_digest: Digest, purpose_span_digest: Digest }).strict()).max(8),
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

export const OperationPlanControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), plan_id: Id, revision_digest: Digest, step_id: Id,
    goal_purpose_binding: OperationPlanGoalPurposeBindingSchema.optional() }).strict(),
  z.object({ action: z.literal("reconcile"), plan_id: Id, revision_digest: Digest, step_id: Id }).strict(),
  z.object({ action: z.literal("revise"), plan_id: Id, expected_revision_digest: Digest, plan: OperationPlanSchema }).strict(),
  z.object({ action: z.literal("reflect"), plan_id: Id, revision_digest: Digest,
    step_ids: z.array(Id).min(1).max(8), question: z.string().trim().min(1).max(4000) }).strict(),
]);
export type OperationPlanControl = z.infer<typeof OperationPlanControlSchema>;
export type OperationPlanReflectionControl = Extract<OperationPlanControl, { action: "reflect" }>;
export type OperationPlanReceiptReconciliationControl = Extract<OperationPlanControl, { action: "reconcile" }>;
export const OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION = "blue-tanuki.result-reflection.v1";
/** Cの解釈候補。形状・引用一致は意味採用や実行許可を表さない。 */
export const OperationPlanReflectionCandidateSchema = z.object({
  schema_version: z.literal("operation-result-reflection-candidate.v1"), projection_digest: Digest,
  citations: z.array(z.object({ record_id: Id, record_digest: Digest,
    interpretation: z.string().trim().min(1).max(800), uncertainty: z.string().trim().min(1).max(800) }).strict()).min(1).max(8),
}).strict();

export const OperationPlanCheckpointSchema = z.object({
  schema_version: z.literal("operation-plan-state.v1"),
  plans: z.array(z.object({
    owner: Id, channel: Id, goal: z.string().min(1).max(200_000),
    goal_purpose_binding: OperationPlanGoalPurposeBindingSchema.optional(),
    goal_purpose_relation: OperationPlanGoalPurposeRelationRecordSchema.optional(),
    request_goal_criteria: GoalCriteriaProjectionSchema.optional(),
    revisions: z.array(z.object({ digest: Digest, plan: OperationPlanSchema }).strict()).min(1).max(100),
    receipt_observations: z.array(OperationPlanExternalReceiptObservationSchema).max(100).default([]),
    bindings: z.array(z.object({
      step_id: Id, revision_digest: Digest, step_digest: Digest, prepared_step: OperationStepSchema,
      command_id: Id, request_id: Id, commit_hash: Id, payload_digest: Digest, command_digest: Digest,
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
