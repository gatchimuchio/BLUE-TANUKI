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

export type GoalCriterionToolRelation = z.infer<typeof GoalCriterionToolRelationSchema>;
export type GoalCriterion = z.infer<typeof GoalCriterionSchema>;
export type GoalCriteria = z.infer<typeof GoalCriteriaSchema>;
