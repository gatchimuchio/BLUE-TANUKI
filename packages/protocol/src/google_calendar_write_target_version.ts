import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Google Calendarの単一イベント、作成時点のfreebusy観測と更新時点のevent状態を束縛する非権威証拠。 */
const GoogleCalendarWriteTargetVersionBaseSchema = z.object({
  schema_version: z.literal("blue-tanuki.google-calendar-write-target-version.v1"),
  target_identity_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema.optional(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
});

export const GoogleCalendarWriteTargetVersionObservationSchema = z.discriminatedUnion("operation", [
  GoogleCalendarWriteTargetVersionBaseSchema.extend({
    operation: z.literal("event.create"),
    availability_observation_digest: DigestSchema,
    availability_result_digest: DigestSchema,
    availability_observed_at: z.string().min(20).max(64),
    availability_window_start: z.string().min(20).max(64),
    availability_window_end: z.string().min(20).max(64),
    event_start: z.string().min(1).max(256),
    event_end: z.string().min(1).max(256),
  }).strict(),
  GoogleCalendarWriteTargetVersionBaseSchema.extend({
    operation: z.literal("event.update"),
    calendar_id: z.string().min(1).max(512),
    event_id: z.string().min(1).max(1_024),
    event_state_digest: DigestSchema,
    event_etag_digest: DigestSchema,
  }).strict(),
]);

/** Owner-confirmed, targeted snapshot returned by a single-event read. */
export const GoogleCalendarEventTargetObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.google-calendar-event-target.v1"),
  service: z.literal("calendar"),
  view: z.literal("event"),
  mode: z.literal("read_only"),
  calendar_id: z.string().min(1).max(512),
  calendar_id_original: z.string().min(1).max(512),
  event_id: z.string().min(1).max(1_024),
  event_state_digest: DigestSchema,
  event_etag_digest: DigestSchema,
  status: z.string().min(1).max(64),
  summary: z.string().max(8_192).nullable(),
  recurrence_present: z.boolean(),
  observed_at: z.string().min(20).max(64),
  observed_at_source: z.literal("client_response_received"),
  result_complete: z.literal(true),
  mutation_sent: z.literal(false),
  trust_boundary: z.object({
    provider_data_is_untrusted: z.literal(true),
    calendar_data_can_authorize_operation: z.literal(false),
    used_for_authority: z.literal(false),
  }).strict(),
}).strict();

export type GoogleCalendarEventTargetObservation = z.infer<typeof GoogleCalendarEventTargetObservationSchema>;

export type GoogleCalendarWriteTargetVersionObservation =
  z.infer<typeof GoogleCalendarWriteTargetVersionObservationSchema>;
