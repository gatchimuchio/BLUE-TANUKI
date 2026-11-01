import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Google Calendar作成時点の対象・freebusy観測束縛。権限を付与しない。 */
export const GoogleCalendarWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.google-calendar-write-target-version.v1"),
  operation: z.literal("event.create"),
  target_identity_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  availability_observation_digest: DigestSchema,
  availability_result_digest: DigestSchema,
  availability_observed_at: z.string().min(20).max(64),
  availability_window_start: z.string().min(20).max(64),
  availability_window_end: z.string().min(20).max(64),
  event_start: z.string().min(1).max(256),
  event_end: z.string().min(1).max(256),
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema.optional(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type GoogleCalendarWriteTargetVersionObservation =
  z.infer<typeof GoogleCalendarWriteTargetVersionObservationSchema>;
