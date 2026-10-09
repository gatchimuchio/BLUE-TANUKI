import { z } from "zod";

export const GOAL_PROJECTION_SCHEMA_VERSION = "blue-tanuki.goal-projection.v1" as const;

const ReferenceSchema = z.string().trim().min(1).max(512);
const UnknownValueSchema = z.object({ status: z.literal("unknown") }).strict();

export const GoalNecessitySchema = z.discriminatedUnion("status", [
  UnknownValueSchema,
  z.object({
    status: z.literal("identified"),
    value: z.string().trim().min(1).max(2048),
    source_ref: ReferenceSchema,
  }).strict(),
]);

export const GoalTargetStateSchema = z.discriminatedUnion("status", [
  UnknownValueSchema,
  z.object({
    status: z.literal("identified"),
    subject: z.string().trim().min(1).max(512),
    condition: z.string().trim().min(1).max(2048),
    scope: z.string().trim().min(1).max(1024),
    source_ref: ReferenceSchema,
  }).strict(),
]);

export const GoalEvaluationRulesSchema = z.discriminatedUnion("status", [
  UnknownValueSchema,
  z.object({
    status: z.literal("identified"),
    rules: z.array(z.string().trim().min(1).max(1024)).min(1).max(32),
    source_ref: ReferenceSchema,
  }).strict(),
]);

export const GoalValidityPeriodSchema = z.discriminatedUnion("status", [
  UnknownValueSchema,
  z.object({
    status: z.literal("identified"),
    starts_at: z.number().finite().nonnegative().optional(),
    ends_at: z.number().finite().nonnegative().optional(),
    source_ref: ReferenceSchema,
  }).strict(),
]);

export const GoalAuthoritySchema = z.discriminatedUnion("status", [
  UnknownValueSchema,
  z.object({
    status: z.literal("identified"),
    delegator_ref: ReferenceSchema,
    scope_ref: ReferenceSchema,
    source_ref: ReferenceSchema,
  }).strict(),
]);

export const GoalProjectionSchema = z.object({
  schema_version: z.literal(GOAL_PROJECTION_SCHEMA_VERSION),
  projection_id: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["identifying", "ready"]),
  original_request_ref: z.object({
    source_kind: z.enum(["accepted_inbound_request", "synthetic_rejection_placeholder"]),
    request_id: ReferenceSchema,
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    immutable: z.literal(true),
  }).strict(),
  necessity: GoalNecessitySchema,
  target_state: GoalTargetStateSchema,
  evaluation_rules: GoalEvaluationRulesSchema,
  validity_period: GoalValidityPeriodSchema,
  authority: GoalAuthoritySchema,
}).strict().superRefine((projection, context) => {
  if (projection.validity_period.status === "identified") {
    const period = projection.validity_period;
    if (period.starts_at === undefined && period.ends_at === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "identified validity period requires at least one bound",
        path: ["validity_period"],
      });
    }
    if (period.starts_at !== undefined && period.ends_at !== undefined && period.ends_at < period.starts_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "validity period end precedes its start",
        path: ["validity_period"],
      });
    }
  }

  const complete = [
    projection.necessity,
    projection.target_state,
    projection.evaluation_rules,
    projection.validity_period,
    projection.authority,
  ].every((value) => value.status === "identified");

  if (projection.state === "ready" && !complete) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ready projection requires every goal element to be identified",
      path: ["state"],
    });
  }
  if (projection.state === "identifying" && complete) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "complete projection must use ready state",
      path: ["state"],
    });
  }
});

export type GoalProjection = z.infer<typeof GoalProjectionSchema>;

export type GoalProjectionBoundaryResult =
  | { ok: true; projection: GoalProjection }
  | { ok: false; issue_codes: string[] };

/** 不正な本文や値を返さず、goal projection契約だけを検査する。 */
export function parseGoalProjectionAtBoundary(input: unknown): GoalProjectionBoundaryResult {
  const parsed = GoalProjectionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issue_codes: [...new Set(parsed.error.issues.map((issue) => issue.code))],
    };
  }
  return { ok: true, projection: parsed.data };
}
