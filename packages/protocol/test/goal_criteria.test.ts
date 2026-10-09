import { describe, expect, it } from "vitest";
import {
  GOAL_CRITERIA_SCHEMA_VERSION,
  GoalCriteriaSchema,
} from "../src/goal_criteria.js";

const criteria = {
  schema_version: GOAL_CRITERIA_SCHEMA_VERSION,
  criteria: [{
    criterion_ref: "task.output",
    criterion_kind: "objective",
    tool_relations: [{ tool_name: " echo ", relation: "supports" }],
  }],
};

describe("GoalCriteriaSchema", () => {
  it("accepts bounded request criteria and canonicalizes tool identifiers", () => {
    expect(GoalCriteriaSchema.parse(criteria).criteria[0]?.tool_relations[0]?.tool_name).toBe("echo");
  });

  it("rejects duplicate references, duplicate tool relations, and unknown fields", () => {
    expect(GoalCriteriaSchema.safeParse({
      ...criteria,
      criteria: [criteria.criteria[0], criteria.criteria[0]],
    }).success).toBe(false);
    expect(GoalCriteriaSchema.safeParse({
      ...criteria,
      criteria: [{
        ...criteria.criteria[0],
        tool_relations: [criteria.criteria[0].tool_relations[0], criteria.criteria[0].tool_relations[0]],
      }],
    }).success).toBe(false);
    expect(GoalCriteriaSchema.safeParse({ ...criteria, unexpected: true }).success).toBe(false);
  });

  it("rejects empty or oversized criterion data", () => {
    expect(GoalCriteriaSchema.safeParse({ ...criteria, criteria: [] }).success).toBe(false);
    expect(GoalCriteriaSchema.safeParse({
      ...criteria,
      criteria: [{ criterion_ref: "", criterion_kind: "safety", tool_relations: [] }],
    }).success).toBe(false);
  });
});
