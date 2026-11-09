import { describe, expect, it } from "vitest";
import {
  GoalProjectionSchema,
  parseGoalProjectionAtBoundary,
} from "../src/goal_projection.js";

const unidentified = {
  schema_version: "blue-tanuki.goal-projection.v1",
  projection_id: "a".repeat(64),
  state: "identifying",
  original_request_ref: {
    source_kind: "accepted_inbound_request",
    request_id: "request-1",
    content_sha256: "b".repeat(64),
    immutable: true,
  },
  necessity: { status: "unknown" },
  target_state: { status: "unknown" },
  evaluation_rules: { status: "unknown" },
  validity_period: { status: "unknown" },
  authority: { status: "unknown" },
};

describe("GoalProjectionSchema", () => {
  it("accepts an explicit identifying projection with unknown elements", () => {
    expect(GoalProjectionSchema.safeParse(unidentified).success).toBe(true);
  });

  it("accepts referenced rule identity while keeping the goal identifying", () => {
    const referenced = {
      ...unidentified,
      evaluation_rules: { status: "referenced", rules_digest: "c".repeat(64), rule_count: 1, source_ref: "request-1" },
    };
    expect(GoalProjectionSchema.safeParse(referenced).success).toBe(true);

    const falselyReady = {
      ...referenced,
      state: "ready",
      necessity: { status: "identified", value: "必要性", source_ref: "request-1" },
      target_state: { status: "identified", subject: "対象", condition: "条件", scope: "範囲", source_ref: "request-1" },
      validity_period: { status: "identified", starts_at: 0, source_ref: "request-1" },
      authority: { status: "identified", delegator_ref: "owner", scope_ref: "task", source_ref: "request-1" },
    };
    expect(GoalProjectionSchema.safeParse(falselyReady).success).toBe(false);
  });

  it("BT-U-C02.01-N rejects fabricated completeness and value-bearing unknown fields", () => {
    const withValue = {
      ...unidentified,
      necessity: { status: "unknown", value: "SENTINEL_PRIVATE_VALUE" },
    };
    const falselyReady = { ...unidentified, state: "ready" };
    const withUnknownKey = { ...unidentified, inferred_owner: "SENTINEL_PRIVATE_VALUE" };

    for (const candidate of [withValue, falselyReady, withUnknownKey]) {
      const result = parseGoalProjectionAtBoundary(candidate);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("SENTINEL_PRIVATE_VALUE");
    }
  });

  it("requires identified evaluation rules and an internally consistent validity period", () => {
    const noRules = {
      ...unidentified,
      evaluation_rules: { status: "identified", rules: [], source_ref: "request-1" },
    };
    const reversedPeriod = {
      ...unidentified,
      validity_period: {
        status: "identified",
        starts_at: 20,
        ends_at: 10,
        source_ref: "request-1",
      },
    };

    expect(GoalProjectionSchema.safeParse(noRules).success).toBe(false);
    expect(GoalProjectionSchema.safeParse(reversedPeriod).success).toBe(false);
  });
});
