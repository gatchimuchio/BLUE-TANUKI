import { z } from "zod";
import { OperationPlanSchema, OperationJsonValueSchema, OperationTargetSchema, OperationStepSchema } from "./operation_core.js";

const Id = z.string().min(1).max(200);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const OperationPlanControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), plan_id: Id, revision_digest: Digest, step_id: Id }).strict(),
  z.object({ action: z.literal("revise"), plan_id: Id, expected_revision_digest: Digest, plan: OperationPlanSchema }).strict(),
]);
export type OperationPlanControl = z.infer<typeof OperationPlanControlSchema>;

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
