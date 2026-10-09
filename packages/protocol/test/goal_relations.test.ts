import { describe, expect, it } from "vitest";
import {
  GoalRelationGraphSchema,
  parseGoalRelationGraphAtBoundary,
} from "../src/goal_relations.js";

const graph = () => ({
  schema_version: "blue-tanuki.goal-relations.v1",
  graph_ref: "g_0000000000000001",
  used_for_authority: false,
  nodes: [
    { node_ref: "n_0000000000000001", node_kind: "goal", source_ref: "F:0000000000000001" },
    { node_ref: "n_0000000000000002", node_kind: "goal", source_ref: "F:0000000000000002" },
    { node_ref: "n_0000000000000003", node_kind: "goal", source_ref: "F:0000000000000003" },
    { node_ref: "n_0000000000000004", node_kind: "means", source_ref: "F:0000000000000004" },
    { node_ref: "n_0000000000000005", node_kind: "means", source_ref: "F:0000000000000005" },
    { node_ref: "n_0000000000000006", node_kind: "means", source_ref: "F:0000000000000006" },
  ],
  relations: [
    {
      relation_ref: "e_0000000000000001",
      source_ref: "F:0000000000000007",
      relation_kind: "parent_goal",
      parent_goal_ref: "n_0000000000000001",
      child_goal_ref: "n_0000000000000003",
    },
    {
      relation_ref: "e_0000000000000002",
      source_ref: "F:0000000000000008",
      relation_kind: "parent_goal",
      parent_goal_ref: "n_0000000000000002",
      child_goal_ref: "n_0000000000000003",
    },
    {
      relation_ref: "e_0000000000000003",
      source_ref: "F:0000000000000009",
      relation_kind: "means_contribution",
      means_ref: "n_0000000000000004",
      goal_ref: "n_0000000000000001",
      verification: "unverified",
    },
    {
      relation_ref: "e_0000000000000004",
      source_ref: "F:0000000000000010",
      relation_kind: "means_contribution",
      means_ref: "n_0000000000000004",
      goal_ref: "n_0000000000000002",
      verification: "unverified",
    },
    {
      relation_ref: "e_0000000000000005",
      source_ref: "F:0000000000000011",
      relation_kind: "joint_contribution",
      means_refs: ["n_0000000000000005", "n_0000000000000006"],
      goal_ref: "n_0000000000000003",
      verification: "unverified",
    },
    {
      relation_ref: "e_0000000000000006",
      source_ref: "F:0000000000000012",
      relation_kind: "goal_conflict",
      left_goal_ref: "n_0000000000000001",
      right_goal_ref: "n_0000000000000002",
      resolution: "unresolved",
    },
  ],
});

describe("GoalRelationGraphSchema", () => {
  it("BT-U-C02.02-P retains multiple parents, a shared means, joint contribution, and unresolved conflict", () => {
    const candidate = graph();
    const result = parseGoalRelationGraphAtBoundary(candidate);

    expect(result.ok).toBe(true);
    expect(GoalRelationGraphSchema.parse(candidate)).toEqual(candidate);
    expect(candidate.relations.filter((relation) => relation.relation_kind === "parent_goal")).toHaveLength(2);
    expect(candidate.relations.filter((relation) =>
      relation.relation_kind === "means_contribution" && relation.means_ref === "n_0000000000000004",
    )).toHaveLength(2);
    expect(candidate.relations.find((relation) => relation.relation_kind === "joint_contribution")).toMatchObject({
      means_refs: ["n_0000000000000005", "n_0000000000000006"],
      verification: "unverified",
    });
    expect(candidate.relations.find((relation) => relation.relation_kind === "goal_conflict")).toMatchObject({
      resolution: "unresolved",
    });
  });

  it("BT-U-C02.02-N rejects dangling refs, wrong endpoint kinds, cycles, duplicate relations, and incomplete joint contribution", () => {
    const dangling = graph();
    dangling.relations[2] = {
      ...dangling.relations[2]!,
      relation_kind: "means_contribution",
      goal_ref: "n_ffffffffffffffff",
    };
    const wrongKind = graph();
    wrongKind.relations[0] = {
      ...wrongKind.relations[0]!,
      parent_goal_ref: "n_0000000000000004",
    };
    const cycle = graph();
    cycle.relations.push({
      relation_ref: "e_0000000000000007",
      source_ref: "F:0000000000000013",
      relation_kind: "parent_goal",
      parent_goal_ref: "n_0000000000000003",
      child_goal_ref: "n_0000000000000001",
    });
    const duplicate = graph();
    duplicate.relations.push({
      relation_ref: "e_0000000000000007",
      source_ref: "F:0000000000000014",
      relation_kind: "goal_conflict",
      left_goal_ref: "n_0000000000000002",
      right_goal_ref: "n_0000000000000001",
      resolution: "unresolved",
    });
    const incompleteJoint = graph();
    incompleteJoint.relations[4] = {
      ...incompleteJoint.relations[4]!,
      relation_kind: "joint_contribution",
      means_refs: ["n_0000000000000005"],
    };

    for (const candidate of [dangling, wrongKind, cycle, duplicate, incompleteJoint]) {
      expect(parseGoalRelationGraphAtBoundary(candidate).ok).toBe(false);
    }
  });

  it("BT-U-C02.02-N rejects unopaque references and unknown fields without returning input values", () => {
    const raw = graph();
    raw.nodes[0] = {
      ...raw.nodes[0]!,
      node_ref: "n_private_goal_text",
      source_ref: "F:SENTINEL_RAW_GOAL_TEXT",
    };
    const unknown = { ...graph(), owner_authority: "SENTINEL_RAW_GOAL_TEXT" };
    for (const candidate of [raw, unknown]) {
      const result = parseGoalRelationGraphAtBoundary(candidate);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("SENTINEL_RAW_GOAL_TEXT");
    }
  });
});
