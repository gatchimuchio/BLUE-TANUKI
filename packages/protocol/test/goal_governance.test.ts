import { describe, expect, it } from "vitest";
import {
  GOAL_GOVERNANCE_SCHEMA_VERSION,
  parseGoalGovernanceAtBoundary,
  type GoalGovernanceConfig,
} from "../src/goal_governance.js";

const delegated = "goal_0000000000000001";
const operational = "goal_0000000000000002";
const subgoal = "goal_0000000000000003";
const source = "F:0000000000000001";
const digest = (character: string): string => character.repeat(64);

const config: GoalGovernanceConfig = {
  schema_version: GOAL_GOVERNANCE_SCHEMA_VERSION,
  goals: [
    {
      goal_ref: delegated,
      goal_kind: "delegated",
      source_ref: source,
      initial_purpose_digest: digest("a"),
      initial_interpretation_digest: digest("b"),
      adopted_at: 100,
    },
    {
      goal_ref: operational,
      goal_kind: "operational",
      source_ref: "F:0000000000000002",
      parent_goal_ref: delegated,
      parent_goal_version: 1,
      initial_purpose_digest: digest("c"),
      initial_interpretation_digest: digest("d"),
      adopted_at: 100,
    },
    {
      goal_ref: subgoal,
      goal_kind: "subgoal",
      source_ref: "F:0000000000000003",
      parent_goal_ref: operational,
      parent_goal_version: 1,
      initial_purpose_digest: digest("e"),
      initial_interpretation_digest: digest("f"),
      adopted_at: 100,
    },
  ],
  authorizations: [],
  events: [],
};

describe("goal governance protocol", () => {
  it("accepts delegated, operational and subgoal references with a strict bounded shape", () => {
    expect(parseGoalGovernanceAtBoundary(config)).toEqual({ ok: true, config });
  });

  it("rejects missing parent links and raw purpose content without echoing it", () => {
    const missingParent = {
      ...config,
      goals: config.goals.map((goal) => goal.goal_ref === operational
        ? { ...goal, parent_goal_ref: undefined }
        : goal),
    };
    expect(parseGoalGovernanceAtBoundary(missingParent).ok).toBe(false);

    const sentinel = "SENTINEL_RAW_PURPOSE_TEXT";
    const withRawContent = {
      ...config,
      goals: config.goals.map((goal) => goal.goal_ref === delegated
        ? { ...goal, purpose_text: sentinel }
        : goal),
    };
    const result = parseGoalGovernanceAtBoundary(withRawContent);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("rejects authority impersonation and purpose events that collapse versions", () => {
    const invalidEvent = {
      event_ref: "ge_0000000000000001",
      event_kind: "purpose_change",
      goal_ref: delegated,
      source_ref: source,
      goal_kind: "delegated",
      prior_version: 1,
      new_version: 1,
      prior_purpose_digest: digest("a"),
      new_purpose_digest: digest("1"),
      authority_kind: "hds_j",
      authorization_ref: "ga_0000000000000001",
      recorded_at: 110,
      effective_from: 110,
    };
    expect(parseGoalGovernanceAtBoundary({ ...config, events: [invalidEvent] }).ok).toBe(false);
  });
});
