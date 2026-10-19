import { z } from "zod";

export const GOAL_CRITERIA_SCHEMA_VERSION = "blue-tanuki.goal-criteria.v1" as const;

const CriterionRefSchema = z.string().trim().min(1).max(200);

export const GoalCriterionToolRelationSchema = z.object({
  tool_name: z.string().trim().min(1).max(200).transform((value) => value.normalize("NFKC"))
    .pipe(z.string().min(1).max(200)),
  relation: z.enum(["supports", "conflicts"]),
}).strict();

export const GoalCriterionSchema = z.object({
  criterion_ref: CriterionRefSchema,
  criterion_kind: z.enum(["objective", "safety"]),
  tool_relations: z.array(GoalCriterionToolRelationSchema).max(64),
}).strict().superRefine((criterion, context) => {
  const toolNames = criterion.tool_relations.map((relation) => relation.tool_name);
  if (new Set(toolNames).size !== toolNames.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "criterion must not repeat a tool relation",
      path: ["tool_relations"],
    });
  }
});

/**
 * Optional, request-scoped task criteria. This is input context, not authority,
 * verification evidence, permission, or an instruction to execute a tool.
 */
export const GoalCriteriaSchema = z.object({
  schema_version: z.literal(GOAL_CRITERIA_SCHEMA_VERSION),
  criteria: z.array(GoalCriterionSchema).min(1).max(64),
}).strict().superRefine((criteria, context) => {
  const refs = criteria.criteria.map((criterion) => criterion.criterion_ref);
  if (new Set(refs).size !== refs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "goal criteria must use distinct criterion references",
      path: ["criteria"],
    });
  }
});

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Digest-only, request-bound criteria retained with a J-owned operation plan. */
export const GoalCriteriaProjectionSchema = z.object({
  status: z.enum(["not_provided", "provided", "invalid"]),
  request_id: z.string().min(1).max(200),
  content_sha256: DigestSchema,
  criteria_digest: DigestSchema.optional(),
  criteria: z.array(z.object({
    criterion_ref_digest: DigestSchema,
    criterion_kind: z.enum(["objective", "safety"]),
    tool_relations: z.array(z.object({
      tool_name_digest: DigestSchema,
      relation: z.enum(["supports", "conflicts"]),
    }).strict()).max(64),
  }).strict()).max(64),
  used_for_authority: z.literal(false),
}).strict().superRefine((projection, context) => {
  if (projection.status === "provided" && (!projection.criteria_digest || projection.criteria.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "provided_goal_criteria_projection_requires_digest_and_criteria" });
  }
  if (projection.status !== "provided" && (projection.criteria_digest !== undefined || projection.criteria.length !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "empty_goal_criteria_projection_must_not_contain_criteria" });
  }
  if (new Set(projection.criteria.map((criterion) => criterion.criterion_ref_digest)).size !== projection.criteria.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "goal_criteria_projection_refs_must_be_distinct" });
  }
  for (const [criterionIndex, criterion] of projection.criteria.entries()) {
    const toolDigests = criterion.tool_relations.map((relation) => relation.tool_name_digest);
    if (new Set(toolDigests).size !== toolDigests.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "goal_criteria_projection_tools_must_be_distinct",
        path: ["criteria", criterionIndex, "tool_relations"] });
    }
  }
});

export type GoalCriterionToolRelation = z.infer<typeof GoalCriterionToolRelationSchema>;
export type GoalCriterion = z.infer<typeof GoalCriterionSchema>;
export type GoalCriteria = z.infer<typeof GoalCriteriaSchema>;
export type GoalCriteriaProjection = z.infer<typeof GoalCriteriaProjectionSchema>;
