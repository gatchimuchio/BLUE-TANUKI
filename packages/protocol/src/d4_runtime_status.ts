import { z } from "zod";

const BoundedCount = z.number().int().min(0).max(1_000_000);

export const D4RuntimeStatusProjectionSchema = z.object({
  schema_version: z.literal("blue-tanuki.d4-runtime-status.v1"),
  runtime_id: z.string().min(1).max(128),
  gateway_status: z.enum(["running", "starting", "degraded"]),
  safe_mode: z.boolean(),
  hds_invariants_ok: z.boolean(),
  webchat_ready: z.boolean(),
  telegram_configured: z.boolean(),
  pending_approvals_count: BoundedCount,
  runtime_schedules_count: BoundedCount,
  pending_schedule_approvals_count: BoundedCount,
  audit_chain_valid: z.boolean(),
  observed_at_ms: z.number().int().nonnegative().safe(),
  evidence_source: z.tuple([z.literal("INTERNAL_STATE")]),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type D4RuntimeStatusProjection = z.infer<typeof D4RuntimeStatusProjectionSchema>;

const ReplyObservationFlags = { used_for_authority: z.literal(false), may_execute: z.literal(false) };

export const D4RuntimeIntentReplyObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown"), ...ReplyObservationFlags }).strict(),
  z.object({
    status: z.literal("prepared"),
    rendered_output_sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
    prepared_at_ms: z.number().int().nonnegative().safe(),
    ...ReplyObservationFlags,
  }).strict(),
]);
export type D4RuntimeIntentReplyObservation = z.infer<typeof D4RuntimeIntentReplyObservationSchema>;
