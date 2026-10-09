import { z } from "zod";

export const GOAL_RELATIONS_SCHEMA_VERSION = "blue-tanuki.goal-relations.v1" as const;
export const GOAL_RELATION_TREE_SCHEMA_VERSION = "blue-tanuki.goal-relation-tree.v1" as const;

const GraphRefSchema = z.string().regex(/^g_[a-f0-9]{16,64}$/);
const NodeRefSchema = z.string().regex(/^n_[a-f0-9]{16,64}$/);
const RelationRefSchema = z.string().regex(/^e_[a-f0-9]{16,64}$/);
const SourceRefSchema = z.string().regex(/^F:(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const GoalRelationNodeSchema = z.object({
  node_ref: NodeRefSchema,
  node_kind: z.enum(["goal", "means"]),
  source_ref: SourceRefSchema,
}).strict();

const ParentGoalRelationSchema = z.object({
  relation_ref: RelationRefSchema,
  source_ref: SourceRefSchema,
  relation_kind: z.literal("parent_goal"),
  parent_goal_ref: NodeRefSchema,
  child_goal_ref: NodeRefSchema,
}).strict();

const MeansContributionRelationSchema = z.object({
  relation_ref: RelationRefSchema,
  source_ref: SourceRefSchema,
  relation_kind: z.literal("means_contribution"),
  means_ref: NodeRefSchema,
  goal_ref: NodeRefSchema,
  verification: z.literal("unverified"),
}).strict();

const JointContributionRelationSchema = z.object({
  relation_ref: RelationRefSchema,
  source_ref: SourceRefSchema,
  relation_kind: z.literal("joint_contribution"),
  means_refs: z.array(NodeRefSchema).min(2).max(64),
  goal_ref: NodeRefSchema,
  verification: z.literal("unverified"),
}).strict();

const GoalConflictRelationSchema = z.object({
  relation_ref: RelationRefSchema,
  source_ref: SourceRefSchema,
  relation_kind: z.literal("goal_conflict"),
  left_goal_ref: NodeRefSchema,
  right_goal_ref: NodeRefSchema,
  resolution: z.literal("unresolved"),
}).strict();

export const GoalRelationSchema = z.discriminatedUnion("relation_kind", [
  ParentGoalRelationSchema,
  MeansContributionRelationSchema,
  JointContributionRelationSchema,
  GoalConflictRelationSchema,
]);

export const GoalRelationGraphSchema = z.object({
  schema_version: z.literal(GOAL_RELATIONS_SCHEMA_VERSION),
  graph_ref: GraphRefSchema,
  used_for_authority: z.literal(false),
  nodes: z.array(GoalRelationNodeSchema).min(1).max(256),
  relations: z.array(GoalRelationSchema).max(1024),
}).strict().superRefine((graph, context) => {
  const nodes = new Map<string, (typeof graph.nodes)[number]>();
  graph.nodes.forEach((node, index) => {
    if (nodes.has(node.node_ref)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate node reference", path: ["nodes", index, "node_ref"] });
    } else {
      nodes.set(node.node_ref, node);
    }
  });

  const relationRefs = new Set<string>();
  const relationKeys = new Set<string>();
  const goalChildren = new Map<string, string[]>();
  const addIssue = (index: number, field: string, message: string): void => {
    context.addIssue({ code: z.ZodIssueCode.custom, message, path: ["relations", index, field] });
  };
  const requireKind = (ref: string, expected: "goal" | "means", index: number, field: string): void => {
    const node = nodes.get(ref);
    if (!node) addIssue(index, field, "relation references an unknown node");
    else if (node.node_kind !== expected) addIssue(index, field, "relation endpoint has the wrong node kind");
  };

  graph.relations.forEach((relation, index) => {
    if (relationRefs.has(relation.relation_ref)) addIssue(index, "relation_ref", "duplicate relation reference");
    relationRefs.add(relation.relation_ref);

    let semanticKey: string;
    switch (relation.relation_kind) {
      case "parent_goal": {
        requireKind(relation.parent_goal_ref, "goal", index, "parent_goal_ref");
        requireKind(relation.child_goal_ref, "goal", index, "child_goal_ref");
        semanticKey = `parent_goal:${relation.parent_goal_ref}:${relation.child_goal_ref}`;
        const children = goalChildren.get(relation.parent_goal_ref) ?? [];
        children.push(relation.child_goal_ref);
        goalChildren.set(relation.parent_goal_ref, children);
        if (relation.parent_goal_ref === relation.child_goal_ref) addIssue(index, "child_goal_ref", "goal cannot be its own parent");
        break;
      }
      case "means_contribution":
        requireKind(relation.means_ref, "means", index, "means_ref");
        requireKind(relation.goal_ref, "goal", index, "goal_ref");
        semanticKey = `means_contribution:${relation.means_ref}:${relation.goal_ref}`;
        break;
      case "joint_contribution": {
        requireKind(relation.goal_ref, "goal", index, "goal_ref");
        const uniqueMeans = new Set(relation.means_refs);
        if (uniqueMeans.size !== relation.means_refs.length) addIssue(index, "means_refs", "joint contribution requires distinct means");
        for (const [memberIndex, ref] of relation.means_refs.entries()) requireKind(ref, "means", index, `means_refs.${memberIndex}`);
        semanticKey = `joint_contribution:${[...uniqueMeans].sort().join(",")}:${relation.goal_ref}`;
        break;
      }
      case "goal_conflict": {
        requireKind(relation.left_goal_ref, "goal", index, "left_goal_ref");
        requireKind(relation.right_goal_ref, "goal", index, "right_goal_ref");
        const [left, right] = [relation.left_goal_ref, relation.right_goal_ref].sort();
        semanticKey = `goal_conflict:${left}:${right}`;
        if (left === right) addIssue(index, "right_goal_ref", "goal cannot conflict with itself");
        break;
      }
    }
    if (relationKeys.has(semanticKey)) addIssue(index, "relation_kind", "duplicate semantic relation");
    relationKeys.add(semanticKey);
  });

  const visited = new Set<string>();
  const visiting = new Set<string>();
  let hasCycle = false;
  const visit = (goalRef: string): void => {
    if (visiting.has(goalRef)) {
      hasCycle = true;
      return;
    }
    if (visited.has(goalRef)) return;
    visiting.add(goalRef);
    for (const child of goalChildren.get(goalRef) ?? []) visit(child);
    visiting.delete(goalRef);
    visited.add(goalRef);
  };
  for (const node of graph.nodes) if (node.node_kind === "goal") visit(node.node_ref);
  if (hasCycle) context.addIssue({ code: z.ZodIssueCode.custom, message: "parent goal relations must be acyclic", path: ["relations"] });
});

export interface GoalRelationTreeEntry {
  node_ref: string;
  node_kind: "goal" | "means";
  via_relation_refs: string[];
  children: GoalRelationTreeEntry[];
}

export const GoalRelationTreeEntrySchema: z.ZodType<GoalRelationTreeEntry> = z.lazy(() => z.object({
  node_ref: NodeRefSchema,
  node_kind: z.enum(["goal", "means"]),
  via_relation_refs: z.array(RelationRefSchema).max(1024),
  children: z.array(GoalRelationTreeEntrySchema).max(2048),
}).strict());

export const GoalRelationTreeViewSchema = z.object({
  schema_version: z.literal(GOAL_RELATION_TREE_SCHEMA_VERSION),
  used_for_authority: z.literal(false),
  recovery: z.object({
    graph_digest: DigestSchema,
    graph: GoalRelationGraphSchema,
  }).strict(),
  roots: z.array(GoalRelationTreeEntrySchema).max(2048),
}).strict().superRefine((view, context) => {
  const nodes = new Map(view.recovery.graph.nodes.map((node) => [node.node_ref, node]));
  const relations = new Map(view.recovery.graph.relations.map((relation) => [relation.relation_ref, relation]));
  let entryCount = 0;
  const checkEntry = (entry: GoalRelationTreeEntry, parent?: GoalRelationTreeEntry, depth = 1): void => {
    entryCount += 1;
    if (entryCount > 2048 || depth > 32) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "tree view exceeds bounded display limits", path: ["roots"] });
      return;
    }
    const node = nodes.get(entry.node_ref);
    if (!node || node.node_kind !== entry.node_kind) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "tree entry does not match the recovery graph", path: ["roots"] });
    }
    if (new Set(entry.via_relation_refs).size !== entry.via_relation_refs.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "tree entry repeats a relation reference", path: ["roots"] });
    }
    if (!parent && entry.via_relation_refs.length !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "tree roots cannot claim a parent relation", path: ["roots"] });
    }
    for (const relationRef of entry.via_relation_refs) {
      const relation = relations.get(relationRef);
      if (!relation || !parent || !relationConnectsTreeEntry(relation, entry.node_ref, parent.node_ref)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "tree entry relation does not match its parent", path: ["roots"] });
      }
    }
    for (const child of entry.children) checkEntry(child, entry, depth + 1);
  };
  for (const root of view.roots) checkEntry(root);
});

function relationConnectsTreeEntry(relation: GoalRelation, childRef: string, parentRef: string): boolean {
  switch (relation.relation_kind) {
    case "parent_goal": return relation.parent_goal_ref === parentRef && relation.child_goal_ref === childRef;
    case "means_contribution": return relation.goal_ref === parentRef && relation.means_ref === childRef;
    case "joint_contribution": return relation.goal_ref === parentRef && relation.means_refs.includes(childRef);
    case "goal_conflict": return false;
  }
}

export type GoalRelationGraph = z.infer<typeof GoalRelationGraphSchema>;
export type GoalRelation = z.infer<typeof GoalRelationSchema>;
export type GoalRelationTreeView = z.infer<typeof GoalRelationTreeViewSchema>;

export type GoalRelationBoundaryResult =
  | { ok: true; value: GoalRelationGraph }
  | { ok: false; issue_codes: string[] };

export function parseGoalRelationGraphAtBoundary(input: unknown): GoalRelationBoundaryResult {
  const parsed = GoalRelationGraphSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issue_codes: [...new Set(parsed.error.issues.map((issue) => issue.code))] };
  return { ok: true, value: parsed.data };
}

export function parseGoalRelationTreeViewAtBoundary(input: unknown):
  | { ok: true; value: GoalRelationTreeView }
  | { ok: false; issue_codes: string[] } {
  if (!treeInputWithinLimits(input)) return { ok: false, issue_codes: ["custom"] };
  const parsed = GoalRelationTreeViewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issue_codes: [...new Set(parsed.error.issues.map((issue) => issue.code))] };
  return { ok: true, value: parsed.data };
}

function treeInputWithinLimits(input: unknown): boolean {
  if (!input || typeof input !== "object" || !("roots" in input)) return true;
  const roots = (input as { roots?: unknown }).roots;
  if (!Array.isArray(roots)) return true;
  if (roots.length > 2048) return false;
  const pending = roots.map((entry) => ({ entry, depth: 1 }));
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 32 || ++count > 2048) return false;
    if (!current.entry || typeof current.entry !== "object") continue;
    if (seen.has(current.entry)) return false;
    seen.add(current.entry);
    const children = (current.entry as { children?: unknown }).children;
    if (Array.isArray(children)) {
      if (children.length > 2048) return false;
      for (const child of children) pending.push({ entry: child, depth: current.depth + 1 });
    }
  }
  return true;
}
