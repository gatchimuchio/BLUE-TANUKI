import { createHash } from "node:crypto";
import { z } from "zod";

const ScheduleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/).refine(value => value === value.trim());
const DigestSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const GoalRefSchema = z.string().regex(/^goal_[a-f0-9]{16,64}$/).refine(value => value === value.trim());
const PurposeVersionSchema = z.number().int().positive().safe();
const ScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ScheduleTextSchema = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim());
const ScheduleTimeZoneSchema = z.string().min(1).max(128).refine(value => {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value; }
  catch { return false; }
});

/** Exact arguments for the owner-originated, one-step L3 schedule-create plan. */
const RuntimeScheduleCreateArgumentsBaseSchema = z.object({
  id: ScheduleIdSchema,
  channel: ScheduleTextSchema(128),
  target: ScheduleTextSchema(1_024),
  content: ScheduleTextSchema(32_768),
  time: ScheduleTimeSchema.optional(),
  time_zone: ScheduleTimeZoneSchema.optional(),
  interval_ms: z.number().int().positive().max(2_147_483_647).safe().optional(),
}).strict();

export const RuntimeScheduleCreateArgumentsSchema = RuntimeScheduleCreateArgumentsBaseSchema.refine(value =>
  (value.time === undefined) !== (value.interval_ms === undefined) &&
  ((value.time !== undefined && value.time_zone !== undefined) ||
    (value.time === undefined && value.time_zone === undefined)), {
  message: "A schedule requires exactly one explicit trigger; daily schedules require an IANA time zone.",
});
export type RuntimeScheduleCreateArguments = z.infer<typeof RuntimeScheduleCreateArgumentsSchema>;

export const RuntimeScheduleCreateProposalSchema = RuntimeScheduleCreateArgumentsBaseSchema.extend({
  goal_ref: GoalRefSchema,
  purpose_version: PurposeVersionSchema,
}).strict().refine(value => (value.time === undefined) !== (value.interval_ms === undefined) &&
  ((value.time !== undefined && value.time_zone !== undefined) ||
    (value.time === undefined && value.time_zone === undefined)));
export type RuntimeScheduleCreateProposal = z.infer<typeof RuntimeScheduleCreateProposalSchema>;

/** Shared payload digest contract used by J's result validation and Gateway persistence. */
export function runtimeSchedulePayloadHash(value: Pick<RuntimeScheduleCreateArguments,
  "channel" | "target" | "content" | "time" | "time_zone" | "interval_ms">): string {
  const payload: Record<string, unknown> = {
    channel: value.channel,
    target: value.target,
    content: value.content,
    time: value.time ?? "07:00",
    interval_ms: value.interval_ms,
  };
  if (value.time_zone !== undefined) {
    const normalized = value.time_zone.trim();
    payload.time_zone = new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions().timeZone;
  }
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export const RuntimeScheduleCreateReviewSchema = z.object({
  kind: z.literal("schedule_create"),
  operation: z.literal("schedule.create"),
  command_id: z.string().min(1).max(128),
  command_digest: DigestSchema,
  review_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  schedule_id: ScheduleIdSchema,
  channel: ScheduleTextSchema(128),
  target: ScheduleTextSchema(1_024),
  content: ScheduleTextSchema(32_768),
  time: ScheduleTimeSchema.optional(),
  time_zone: ScheduleTimeZoneSchema.optional(),
  interval_ms: z.number().int().positive().max(2_147_483_647).safe().optional(),
  payload_hash: DigestSchema,
  goal_ref: GoalRefSchema,
  purpose_version: PurposeVersionSchema,
  purpose_digest: DigestSchema,
  purpose_text: z.string().min(1).max(32_768),
  no_store: z.literal(true),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().refine(review => (review.time === undefined) !== (review.interval_ms === undefined) &&
  ((review.time !== undefined && review.time_zone !== undefined) ||
    (review.time === undefined && review.time_zone === undefined)));
export type RuntimeScheduleCreateReview = z.infer<typeof RuntimeScheduleCreateReviewSchema>;

const RuntimeScheduleUpdatePlanArgumentsBaseSchema = z.object({
  id: ScheduleIdSchema,
  expected_revision_digest: DigestSchema,
  channel: ScheduleTextSchema(128),
  target: ScheduleTextSchema(1_024),
  content: ScheduleTextSchema(32_768),
  time: ScheduleTimeSchema.optional(),
  time_zone: ScheduleTimeZoneSchema.optional(),
  interval_ms: z.number().int().positive().max(2_147_483_647).safe().optional(),
}).strict();

export const RuntimeScheduleUpdatePlanArgumentsSchema = RuntimeScheduleUpdatePlanArgumentsBaseSchema.refine(value =>
  (value.time === undefined) !== (value.interval_ms === undefined) &&
  ((value.time !== undefined && value.time_zone !== undefined) ||
    (value.time === undefined && value.time_zone === undefined)), {
  message: "A schedule update requires one explicit trigger and a revision-bound full replacement.",
});
export type RuntimeScheduleUpdatePlanArguments = z.infer<typeof RuntimeScheduleUpdatePlanArgumentsSchema>;

export const RuntimeScheduleUpdateProposalSchema = RuntimeScheduleUpdatePlanArgumentsBaseSchema.extend({
  goal_ref: GoalRefSchema,
  purpose_version: PurposeVersionSchema,
}).strict().refine(value => (value.time === undefined) !== (value.interval_ms === undefined) &&
  ((value.time !== undefined && value.time_zone !== undefined) ||
    (value.time === undefined && value.time_zone === undefined)));
export type RuntimeScheduleUpdateProposal = z.infer<typeof RuntimeScheduleUpdateProposalSchema>;

export const RuntimeScheduleUpdateReviewSchema = z.object({
  kind: z.literal("schedule_update"),
  operation: z.literal("schedule.update"),
  command_id: z.string().min(1).max(128),
  command_digest: DigestSchema,
  review_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  schedule_id: ScheduleIdSchema,
  expected_revision_digest: DigestSchema,
  channel: ScheduleTextSchema(128),
  target: ScheduleTextSchema(1_024),
  content: ScheduleTextSchema(32_768),
  time: ScheduleTimeSchema.optional(),
  time_zone: ScheduleTimeZoneSchema.optional(),
  interval_ms: z.number().int().positive().max(2_147_483_647).safe().optional(),
  payload_hash: DigestSchema,
  goal_ref: GoalRefSchema,
  purpose_version: PurposeVersionSchema,
  purpose_digest: DigestSchema,
  purpose_text: z.string().min(1).max(32_768),
  no_store: z.literal(true),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().refine(review => (review.time === undefined) !== (review.interval_ms === undefined) &&
  ((review.time !== undefined && review.time_zone !== undefined) ||
    (review.time === undefined && review.time_zone === undefined)));
export type RuntimeScheduleUpdateReview = z.infer<typeof RuntimeScheduleUpdateReviewSchema>;

export const RuntimeScheduleUpdateArgumentsSchema = z.object({
  id: ScheduleIdSchema,
  expected_revision_digest: DigestSchema,
}).passthrough();
export type RuntimeScheduleUpdateArguments = z.infer<typeof RuntimeScheduleUpdateArgumentsSchema>;

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
