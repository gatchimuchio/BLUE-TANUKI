import { z } from "zod";

const ScheduleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/).refine(value => value === value.trim());
const DigestSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const GoalRefSchema = z.string().regex(/^goal_[a-f0-9]{16,64}$/).refine(value => value === value.trim());
const PurposeVersionSchema = z.number().int().positive().safe();

export const RuntimeScheduleDeleteArgumentsSchema = z.object({
  id: ScheduleIdSchema,
  expected_revision_digest: DigestSchema,
}).strict();
export const RuntimeScheduleDeleteProposalSchema = RuntimeScheduleDeleteArgumentsSchema.extend({
  goal_ref: GoalRefSchema,
  purpose_version: PurposeVersionSchema,
});
export type RuntimeScheduleDeleteProposal = z.infer<typeof RuntimeScheduleDeleteProposalSchema>;

export const RuntimeScheduleDeleteReviewSchema = z.object({
  kind: z.literal("schedule_delete"),
  operation: z.literal("schedule.delete"),
  command_id: z.string().min(1).max(128),
  command_digest: DigestSchema,
  review_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  schedule_id: ScheduleIdSchema,
  revision_digest: DigestSchema,
  channel: z.string().min(1),
  target: z.string().min(1),
  time: z.string().length(5).regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  time_zone: z.string().min(1).optional(),
  interval_ms: z.number().int().positive().safe().optional(),
  payload_hash: DigestSchema,
  goal_ref: GoalRefSchema,
  purpose_version: PurposeVersionSchema,
  no_store: z.literal(true),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().refine(review => (review.time === undefined) !== (review.interval_ms === undefined) &&
  (review.time_zone === undefined || review.time !== undefined));
export type RuntimeScheduleDeleteReview = z.infer<typeof RuntimeScheduleDeleteReviewSchema>;

export function runtimeScheduleDeleteResult(scheduleId: string) {
  return { schedule_id: scheduleId, status: "deleted", active: false, can_fire: false,
    next_action: "No further action is needed. Recreate the schedule if it should run again." } as const;
}
