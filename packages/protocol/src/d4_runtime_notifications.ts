import { z } from "zod";

export const D4RuntimeNotificationCategorySchema = z.enum([
  "owner_attention",
  "interrupted_work",
  "outcome_unknown",
  "scheduled_activity",
  "recovery_unavailable",
  "service_issue",
  "audit_integrity_issue",
]);

const D4RuntimeNotificationItemSchema = z.object({
  category: D4RuntimeNotificationCategorySchema,
  severity: z.enum(["info", "warning", "critical", "action_required"]),
  occurred_at_ms: z.number().int().nonnegative().safe(),
}).strict();

export const D4RuntimeNotificationsProjectionSchema = z.object({
  schema_version: z.literal("blue-tanuki.d4-runtime-notifications.v1"),
  runtime_id: z.string().min(1).max(128),
  notifications: z.array(D4RuntimeNotificationItemSchema).max(64),
  observed_at_ms: z.number().int().nonnegative().safe(),
  evidence_source: z.tuple([z.literal("INTERNAL_STATE")]),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type D4RuntimeNotificationCategory = z.infer<typeof D4RuntimeNotificationCategorySchema>;
export type D4RuntimeNotificationsProjection = z.infer<typeof D4RuntimeNotificationsProjectionSchema>;
