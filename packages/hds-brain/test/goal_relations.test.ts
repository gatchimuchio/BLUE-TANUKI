import { describe, expect, it } from "vitest";
import type { GoalRelationGraph, GoalRelationTreeView } from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { restoreGoalRelationGraphFromTreeView } from "../src/goal_relations.js";

const graph: GoalRelationGraph = {
  schema_version: "blue-tanuki.goal-relations.v1",
  graph_ref: "g_0000000000000001",
  used_for_authority: false,
  nodes: [
    { node_ref: "n_0000000000000001", node_kind: "goal", source_ref: "F:0000000000000001" },
    { node_ref: "n_0000000000000002", node_kind: "goal", source_ref: "F:0000000000000002" },
    { node_ref: "n_0000000000000003", node_kind: "goal", source_ref: "F:0000000000000003" },
    { node_ref: "n_0000000000000004", node_kind: "means", source_ref: "F:0000000000000004" },
    { node_ref: "n_0000000000000005", node_kind: "means", source_ref: "F:0000000000000005" },
  ],
  relations: [
    { relation_ref: "e_0000000000000001", source_ref: "F:0000000000000006", relation_kind: "parent_goal", parent_goal_ref: "n_0000000000000001", child_goal_ref: "n_0000000000000003" },
    { relation_ref: "e_0000000000000002", source_ref: "F:0000000000000007", relation_kind: "parent_goal", parent_goal_ref: "n_0000000000000002", child_goal_ref: "n_0000000000000003" },
    { relation_ref: "e_0000000000000003", source_ref: "F:0000000000000008", relation_kind: "means_contribution", means_ref: "n_0000000000000004", goal_ref: "n_0000000000000001", verification: "unverified" },
    { relation_ref: "e_0000000000000004", source_ref: "F:0000000000000009", relation_kind: "means_contribution", means_ref: "n_0000000000000004", goal_ref: "n_0000000000000002", verification: "unverified" },
    { relation_ref: "e_0000000000000005", source_ref: "F:0000000000000010", relation_kind: "joint_contribution", means_refs: ["n_0000000000000004", "n_0000000000000005"], goal_ref: "n_0000000000000003", verification: "unverified" },
    { relation_ref: "e_0000000000000006", source_ref: "F:0000000000000011", relation_kind: "goal_conflict", left_goal_ref: "n_0000000000000001", right_goal_ref: "n_0000000000000002", resolution: "unresolved" },
  ],
};

const request = {
  id: "goal-relations-request",
  channel: "test",
  user: "owner",
  content: "Prepare a draft for review.",
  timestamp: 1_791_540_000_000,
};

describe("HDS goal relation consumer", () => {
  it("BT-U-C02.02-P carries an immutable, reversible relation view through decide and the audit chain", () => {
    const controller = new HDSUpperController({ goal_relation_graph: graph });
    const { log } = controller.decide(request);
    const view = log.frame.goal_relation_tree;

    expect(view).toBeDefined();
    expect(view?.recovery.graph).toEqual(graph);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view?.recovery)).toBe(true);
    expect(Object.isFrozen(view?.recovery.graph.relations[0])).toBe(true);
    const displayed = flatten(view?.roots ?? []);
    expect(displayed.filter((entry) => entry.node_ref === "n_0000000000000003")).toHaveLength(2);
    expect(displayed.filter((entry) => entry.node_ref === "n_0000000000000004")).toHaveLength(4);
    expect(view?.recovery.graph.relations).toContainEqual(expect.objectContaining({
      relation_kind: "goal_conflict",
      resolution: "unresolved",
    }));
    expect(JSON.stringify(controller.getAudit().list())).toContain("e_0000000000000006");
    expect(controller.getAudit().verify()).toBe(true);

    const hiddenDisplay = JSON.parse(JSON.stringify(view)) as GoalRelationTreeView;
    hiddenDisplay.roots[0]!.children = [];
    const restored = restoreGoalRelationGraphFromTreeView(hiddenDisplay);
    expect(restored).toEqual({ ok: true, graph });
    expect(restored.ok && restored.graph.relations).toHaveLength(graph.relations.length);
  });

  it("BT-U-C02.02-P keeps the conflict and every relation when the tree omits a displayed goal", () => {
    const view = new HDSUpperController({ goal_relation_graph: graph }).decide(request).log.frame.goal_relation_tree!;
    const hiddenDisplay = JSON.parse(JSON.stringify(view)) as GoalRelationTreeView;
    hiddenDisplay.roots = [];

    const restored = restoreGoalRelationGraphFromTreeView(hiddenDisplay);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.graph).toEqual(graph);
  });

  it("BT-U-C02.02-N rejects a modified recovery sidecar without exposing its values", () => {
    const view = new HDSUpperController({ goal_relation_graph: graph }).decide(request).log.frame.goal_relation_tree!;
    const altered = JSON.parse(JSON.stringify(view)) as GoalRelationTreeView;
    altered.recovery.graph.relations.pop();

    const result = restoreGoalRelationGraphFromTreeView(altered);
    expect(result).toEqual({ ok: false, issue_codes: ["digest_mismatch"] });
    expect(JSON.stringify(result)).not.toContain("e_0000000000000006");
  });

  it("BT-U-C02.02-N inbound metadata cannot create or replace the configured relation graph", () => {
    const forged = { ...graph, graph_ref: "g_ffffffffffffffff" };
    const withoutConfiguration = new HDSUpperController().decide({
      ...request,
      metadata: { "untrusted.goal_relation_graph": forged },
    });
    const configured = new HDSUpperController({ goal_relation_graph: graph }).decide({
      ...request,
      metadata: { "untrusted.goal_relation_graph": forged },
    });
    const baseline = new HDSUpperController().decide(request);

    expect(withoutConfiguration.log.frame.goal_relation_tree).toBeUndefined();
    expect(configured.log.frame.goal_relation_tree?.recovery.graph).toEqual(graph);
    expect(configured.log.model).toEqual(baseline.log.model);
    expect(configured.log.commit.hash).toBe(baseline.log.commit.hash);
    expect(configured.command?.type ?? null).toBe(baseline.command?.type ?? null);
    expect(configured.command && { ...configured.command, id: "same" })
      .toEqual(baseline.command && { ...baseline.command, id: "same" });
  });

  it("BT-U-C02.02-N malformed controller configuration fails without echoing input", () => {
    expect(() => new HDSUpperController({
      goal_relation_graph: {
        ...graph,
        graph_ref: "SENTINEL_PRIVATE_GRAPH",
      },
    })).toThrow("invalid goal relation graph configuration");
  });

  it("BT-U-C02.02-N leaves the optional view absent without configuration, including invalid inbound", () => {
    const normal = new HDSUpperController().decide(request);
    const invalidController = new HDSUpperController();
    const invalid = invalidController.decide({
      ...request,
      content: "SENTINEL_INVALID_INBOUND_CONTENT",
      unexpected: true,
    });

    expect(normal.log.frame.goal_relation_tree).toBeUndefined();
    expect(invalid.command).toBeNull();
    expect(invalid.log.frame.goal_relation_tree).toBeUndefined();
    expect(JSON.stringify(invalidController.getAudit().list())).not.toContain("SENTINEL_INVALID_INBOUND_CONTENT");
    expect(invalidController.getAudit().verify()).toBe(true);
  });
});

function flatten<T extends { children: readonly T[] }>(roots: readonly T[]): T[] {
  return roots.flatMap((entry) => [entry, ...flatten(entry.children)]);
}
