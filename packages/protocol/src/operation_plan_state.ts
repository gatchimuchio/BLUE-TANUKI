import { z } from "zod";
import { OperationPlanSchema, OperationJsonValueSchema, OperationTargetSchema, OperationStepSchema } from "./operation_core.js";
import { ExecutionAdmissionSchema } from "./execution_result_delivery.js";
import { MemoryCommitV2Schema, MemoryUpdateReceiptV1Schema } from "./状態更新契約.js";

const Id = z.string().min(1).max(200);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const OperationPlanControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), plan_id: Id, revision_digest: Digest, step_id: Id }).strict(),
  z.object({ action: z.literal("revise"), plan_id: Id, expected_revision_digest: Digest, plan: OperationPlanSchema }).strict(),
  z.object({ action: z.literal("reflect"), plan_id: Id, revision_digest: Digest,
    step_ids: z.array(Id).min(1).max(8), question: z.string().trim().min(1).max(4000) }).strict(),
]);
export type OperationPlanControl = z.infer<typeof OperationPlanControlSchema>;
export type OperationPlanReflectionControl = Extract<OperationPlanControl, { action: "reflect" }>;
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
    revisions: z.array(z.object({ digest: Digest, plan: OperationPlanSchema }).strict()).min(1).max(100),
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
