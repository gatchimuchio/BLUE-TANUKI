import { createHash } from "node:crypto";
import {
  GOAL_RELATION_TREE_SCHEMA_VERSION,
  GoalRelationGraphSchema,
  GoalRelationTreeViewSchema,
  parseGoalRelationGraphAtBoundary,
  parseGoalRelationTreeViewAtBoundary,
  type GoalRelationGraph,
  type GoalRelationTreeEntry,
  type GoalRelationTreeView,
} from "@blue-tanuki/protocol";
import type { DeepReadonly } from "./goal_projection.js";

export type ReadonlyGoalRelationTreeView = DeepReadonly<GoalRelationTreeView>;

/** Validate a non-authority graph and build its reversible display tree. */
export function buildGoalRelationTreeView(input: unknown): ReadonlyGoalRelationTreeView {
  const parsed = parseGoalRelationGraphAtBoundary(input);
  if (!parsed.ok) throw new TypeError("invalid goal relation graph configuration");
  const graph = GoalRelationGraphSchema.parse(parsed.value);
  const parentRelations = graph.relations.filter((relation) => relation.relation_kind === "parent_goal");
  const childRelations = groupBy(parentRelations, (relation) => relation.parent_goal_ref);
  const contributionRelations = graph.relations.filter((relation) =>
    relation.relation_kind === "means_contribution" || relation.relation_kind === "joint_contribution",
  );
  const contributionsByGoal = groupBy(contributionRelations, (relation) => relation.goal_ref);
  const incomingParents = new Set(parentRelations.map((relation) => relation.child_goal_ref));
  const contributedMeans = new Set<string>();
  for (const relation of contributionRelations) {
    if (relation.relation_kind === "means_contribution") contributedMeans.add(relation.means_ref);
    else for (const meansRef of relation.means_refs) contributedMeans.add(meansRef);
  }

  let entries = 0;
  const buildEntry = (nodeRef: string, viaRelationRefs: string[], depth: number): GoalRelationTreeEntry => {
    entries += 1;
    if (entries > 2048 || depth > 32) throw new RangeError("goal relation tree exceeds bounded display limits");
    const node = graph.nodes.find((candidate) => candidate.node_ref === nodeRef);
    if (!node) throw new TypeError("goal relation graph configuration is inconsistent");
    const children: GoalRelationTreeEntry[] = [];
    if (node.node_kind === "goal") {
      for (const relation of childRelations.get(nodeRef) ?? []) {
        children.push(buildEntry(relation.child_goal_ref, [relation.relation_ref], depth + 1));
      }
      for (const relation of contributionsByGoal.get(nodeRef) ?? []) {
        if (relation.relation_kind === "means_contribution") {
          children.push(buildEntry(relation.means_ref, [relation.relation_ref], depth + 1));
        } else {
          for (const meansRef of relation.means_refs) {
            children.push(buildEntry(meansRef, [relation.relation_ref], depth + 1));
          }
        }
      }
    }
    return {
      node_ref: node.node_ref,
      node_kind: node.node_kind,
      via_relation_refs: viaRelationRefs,
      children,
    };
  };

  const roots: GoalRelationTreeEntry[] = [];
  for (const node of graph.nodes) {
    if (node.node_kind === "goal" && !incomingParents.has(node.node_ref)) {
      roots.push(buildEntry(node.node_ref, [], 1));
    }
  }
  for (const node of graph.nodes) {
    if (node.node_kind === "means" && !contributedMeans.has(node.node_ref)) {
      roots.push(buildEntry(node.node_ref, [], 1));
    }
  }

  const candidate = GoalRelationTreeViewSchema.parse({
    schema_version: GOAL_RELATION_TREE_SCHEMA_VERSION,
    used_for_authority: false,
    recovery: { graph_digest: graphDigest(graph), graph },
    roots,
  });
  return deepFreeze(candidate);
}

/** Restore the canonical graph, ignoring edits or omissions in the display tree. */
export function restoreGoalRelationGraphFromTreeView(input: unknown):
  | { ok: true; graph: GoalRelationGraph }
  | { ok: false; issue_codes: string[] } {
  const parsed = parseGoalRelationTreeViewAtBoundary(input);
  if (!parsed.ok) return parsed;
  if (graphDigest(parsed.value.recovery.graph) !== parsed.value.recovery.graph_digest) {
    return { ok: false, issue_codes: ["digest_mismatch"] };
  }
  return { ok: true, graph: parsed.value.recovery.graph };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = grouped.get(groupKey) ?? [];
    group.push(item);
    grouped.set(groupKey, group);
  }
  return grouped;
}

function graphDigest(graph: GoalRelationGraph): string {
  return createHash("sha256").update(stableSerialize(graph), "utf8").digest("hex");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableSerialize(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export type { GoalRelation, GoalRelationGraph, GoalRelationTreeView } from "@blue-tanuki/protocol";
