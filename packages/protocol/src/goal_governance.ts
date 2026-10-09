import { z } from "zod";

export const GOAL_GOVERNANCE_SCHEMA_VERSION = "blue-tanuki.goal-governance.v1" as const;

const GoalRefSchema = z.string().regex(/^goal_[a-f0-9]{16,64}$/);
const EventRefSchema = z.string().regex(/^ge_[a-f0-9]{16,64}$/);
const AuthorizationRefSchema = z.string().regex(/^ga_[a-f0-9]{16,64}$/);
const SourceRefSchema = z.string().regex(/^F:(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const GoalGovernanceGoalSchema = z.object({
  goal_ref: GoalRefSchema,
  goal_kind: z.enum(["delegated", "operational", "subgoal"]),
  source_ref: SourceRefSchema,
  parent_goal_ref: GoalRefSchema.optional(),
  parent_goal_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  initial_purpose_digest: DigestSchema,
  initial_interpretation_digest: DigestSchema,
  adopted_at: TimestampSchema,
}).strict();

export const GoalInterpretationCorrectionEventSchema = z.object({
  event_ref: EventRefSchema,
  event_kind: z.literal("interpretation_correction"),
  goal_ref: GoalRefSchema,
  source_ref: SourceRefSchema,
  goal_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  prior_interpretation_digest: DigestSchema.nullable(),
  corrected_interpretation_digest: DigestSchema,
  preserved_purpose_digest: DigestSchema,
  authority_kind: z.literal("hds_j"),
  authorization_ref: AuthorizationRefSchema,
  recorded_at: TimestampSchema,
  effective_from: TimestampSchema,
}).strict().superRefine((event, context) => {
  if (event.prior_interpretation_digest === event.corrected_interpretation_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interpretation correction must change its digest", path: ["corrected_interpretation_digest"] });
  }
});

export const GoalPurposeChangeEventSchema = z.object({
  event_ref: EventRefSchema,
  event_kind: z.literal("purpose_change"),
  goal_ref: GoalRefSchema,
  source_ref: SourceRefSchema,
  goal_kind: z.enum(["delegated", "operational", "subgoal"]),
  prior_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  new_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  prior_purpose_digest: DigestSchema,
  new_purpose_digest: DigestSchema,
  authority_kind: z.enum(["owner", "hds_j"]),
  parent_goal_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  authorization_ref: AuthorizationRefSchema,
  recorded_at: TimestampSchema,
  effective_from: TimestampSchema,
}).strict().superRefine((event, context) => {
  if (event.new_version !== event.prior_version + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "purpose change must advance exactly one version", path: ["new_version"] });
  }
  if (event.prior_purpose_digest === event.new_purpose_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "purpose change must change its digest", path: ["new_purpose_digest"] });
  }
  if (event.goal_kind === "delegated" && event.parent_goal_version !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "delegated goal cannot bind a parent version", path: ["parent_goal_version"] });
  }
  if (event.goal_kind !== "delegated" && event.parent_goal_version === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "child purpose change requires a parent version", path: ["parent_goal_version"] });
  }
});

export const GoalGovernanceEventSchema = z.union([
  GoalInterpretationCorrectionEventSchema,
  GoalPurposeChangeEventSchema,
]);

export const GoalGovernanceAuthorizationSchema = z.object({
  authorization_ref: AuthorizationRefSchema,
  event_ref: EventRefSchema,
  event_digest: DigestSchema,
  goal_ref: GoalRefSchema,
  event_kind: z.enum(["interpretation_correction", "purpose_change"]),
  authority_kind: z.enum(["owner", "hds_j"]),
  authorized_at: TimestampSchema,
}).strict();

export const GoalGovernanceConfigSchema = z.object({
  schema_version: z.literal(GOAL_GOVERNANCE_SCHEMA_VERSION),
  goals: z.array(GoalGovernanceGoalSchema).min(1).max(256),
  authorizations: z.array(GoalGovernanceAuthorizationSchema).max(1024),
  events: z.array(GoalGovernanceEventSchema).max(1024),
}).strict().superRefine((config, context) => {
  const goals = new Map(config.goals.map((goal) => [goal.goal_ref, goal]));
  const goalRefs = new Set<string>();
  for (const [index, goal] of config.goals.entries()) {
    if (goalRefs.has(goal.goal_ref)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate goal reference", path: ["goals", index, "goal_ref"] });
    }
    goalRefs.add(goal.goal_ref);
    if (goal.goal_kind === "delegated" && (goal.parent_goal_ref !== undefined || goal.parent_goal_version !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "delegated goal cannot have a parent", path: ["goals", index, "parent_goal_ref"] });
    }
    if (goal.goal_kind === "operational" && (goal.parent_goal_ref === undefined || goal.parent_goal_version === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "operational goal requires a delegated parent version", path: ["goals", index, "parent_goal_ref"] });
    }
    if (goal.goal_kind === "subgoal" && (goal.parent_goal_ref === undefined || goal.parent_goal_version === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "subgoal requires a parent version", path: ["goals", index, "parent_goal_ref"] });
    }
    if (goal.parent_goal_ref !== undefined) {
      const parent = goals.get(goal.parent_goal_ref);
      if (!parent) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "goal parent reference is unknown", path: ["goals", index, "parent_goal_ref"] });
      } else if (goal.goal_ref === parent.goal_ref) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "goal cannot parent itself", path: ["goals", index, "parent_goal_ref"] });
      } else if (goal.goal_kind === "operational" && parent.goal_kind !== "delegated") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "operational goal parent must be delegated", path: ["goals", index, "parent_goal_ref"] });
      } else if (goal.goal_kind === "subgoal" && parent.goal_kind === "delegated") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "subgoal must be below an operational or subgoal node", path: ["goals", index, "parent_goal_ref"] });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  let hasCycle = false;
  const visit = (goalRef: string): void => {
    if (visiting.has(goalRef)) {
      hasCycle = true;
      return;
    }
    if (visited.has(goalRef)) return;
    visiting.add(goalRef);
    const parent = goals.get(goalRef)?.parent_goal_ref;
    if (parent) visit(parent);
    visiting.delete(goalRef);
    visited.add(goalRef);
  };
  for (const goal of config.goals) visit(goal.goal_ref);
  if (hasCycle) context.addIssue({ code: z.ZodIssueCode.custom, message: "goal parent references must be acyclic", path: ["goals"] });
});

export type GoalGovernanceGoal = z.infer<typeof GoalGovernanceGoalSchema>;
export type GoalGovernanceEvent = z.infer<typeof GoalGovernanceEventSchema>;
export type GoalGovernanceAuthorization = z.infer<typeof GoalGovernanceAuthorizationSchema>;
export type GoalGovernanceConfig = z.infer<typeof GoalGovernanceConfigSchema>;

export type GoalGovernanceBoundaryResult =
  | { ok: true; config: GoalGovernanceConfig }
  | { ok: false; issue_codes: string[] };

/** Raw purpose text and approval payloads are rejected; this checks only the bounded reference contract. */
export function parseGoalGovernanceAtBoundary(input: unknown): GoalGovernanceBoundaryResult {
  const parsed = GoalGovernanceConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issue_codes: [...new Set(parsed.error.issues.map((issue) => issue.code))] };
  }
  return { ok: true, config: parsed.data };
}
