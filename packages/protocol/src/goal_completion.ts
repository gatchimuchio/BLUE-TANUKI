import { z } from "zod";
import { OperationJsonValueSchema, OperationTargetSchema } from "./operation_core.js";

export const GOAL_COMPLETION_RULES_SCHEMA_VERSION = "blue-tanuki.goal-completion-rules.v1" as const;

const JsonPointerSchema = z.string().max(2_048).refine((pointer) =>
  pointer === "" || (pointer.startsWith("/") && !/~(?![01])/u.test(pointer)),
"goal completion output pointer must be an RFC 6901 JSON pointer");

/** Owner supplied, deterministic predicate over one verified operation result. */
export const GoalCompletionRuleSchema = z.object({
  rule_id: z.string().trim().min(1).max(200),
  operation: z.string().trim().min(1).max(160),
  target: OperationTargetSchema.optional(),
  output_pointer: JsonPointerSchema,
  expected_value: OperationJsonValueSchema,
}).strict();

/** These rules describe when the delegated objective is complete; they grant no execution permission. */
export const GoalCompletionRulesSchema = z.object({
  schema_version: z.literal(GOAL_COMPLETION_RULES_SCHEMA_VERSION),
  rules: z.array(GoalCompletionRuleSchema).min(1).max(64),
}).strict().superRefine((ruleSet, context) => {
  const ruleIds = ruleSet.rules.map((rule) => rule.rule_id);
  if (new Set(ruleIds).size !== ruleIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "goal completion rule IDs must be distinct", path: ["rules"] });
  }
  if (JSON.stringify(ruleSet).length > 32_768) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "goal completion rules exceed the bounded input size", path: ["rules"] });
  }
});

export type GoalCompletionRule = z.infer<typeof GoalCompletionRuleSchema>;
export type GoalCompletionRules = z.infer<typeof GoalCompletionRulesSchema>;
