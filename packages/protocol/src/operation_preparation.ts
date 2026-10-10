import { z } from "zod";
import { getOperationDescriptor } from "./operation_catalog.js";
import {
  inspectOperationPlanAdapterRegistry,
  OperationJsonValueSchema,
  OperationPlanSchema,
  OperationPreparationSummarySchema,
  OperationTargetSchema,
  type OperationPlan,
  type OperationPreparationSummary,
  type OperationStep,
  type OperationStepPreparation,
  type OperationTarget,
} from "./operation_core.js";

const Identity = z.string().min(1).max(200);
const Time = z.number().finite().nonnegative();
// このcontextはplan外の観測入力。LLMのstate/result_digestで代用しない。
export const OperationPreparationContextSchema = z.object({
  now_ms: Time,
  results: z.array(z.object({
    plan_id: Identity,
    request_id: Identity,
    step_id: Identity,
    result_id: Identity,
    operation: Identity,
    status: z.enum(["succeeded", "failed", "suspended"]),
    target: OperationTargetSchema,
    output: OperationJsonValueSchema.optional(),
    observed_at_ms: Time,
    expires_at_ms: Time,
  }).strict()).max(100),
  observations: z.array(z.object({
    plan_id: Identity,
    request_id: Identity,
    step_id: Identity,
    condition_id: Identity,
    target: OperationTargetSchema,
    revision: Identity,
    observed_at_ms: Time,
    expires_at_ms: Time,
  }).strict()).max(100),
}).strict();
export type OperationPreparationContext = z.infer<typeof OperationPreparationContextSchema>;
type Issue = OperationPreparationSummary["steps"][number]["issues"][number];
type Rejection = "invalid_plan" | "invalid_context" | "invalid_dependency_graph" |
  "invalid_binding" | "binding_value_invalid" | "descriptor_mismatch";
export type OperationPlanPreparation =
  | { kind: "rejected"; code: Rejection; may_execute: false; used_for_authority: false }
  | { kind: "inspected"; plan: OperationPlan; summary: OperationPreparationSummary };

function rejected(code: Rejection): OperationPlanPreparation {
  return { kind: "rejected", code, may_execute: false, used_for_authority: false };
}

/** 実値への限定差込と準備検査のみ。I/O、承認、下流実行を行わない。 */
export function prepareOperationPlan(input: unknown, observations: unknown): OperationPlanPreparation {
  const parsed = OperationPlanSchema.safeParse(input);
  if (!parsed.success) return rejected("invalid_plan");
  const context = OperationPreparationContextSchema.safeParse(observations);
  if (!context.success) return rejected("invalid_context");
  const plan = parsed.data;
  if (inspectOperationPlanAdapterRegistry(plan).kind === "rejected") return rejected("descriptor_mismatch");
  const byId = new Map(plan.steps.map((step) => [step.step_id, step]));
  if (byId.size !== plan.steps.length) return rejected("invalid_dependency_graph");
  const order: OperationStep[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(step: OperationStep): boolean {
    if (visited.has(step.step_id)) return true;
    if (visiting.has(step.step_id)) return false;
    const dependencies = step.preparation?.depends_on ?? [];
    if (new Set(dependencies).size !== dependencies.length) return false;
    visiting.add(step.step_id);
    for (const id of dependencies) {
      const predecessor = byId.get(id);
      if (!predecessor || id === step.step_id || !visit(predecessor)) return false;
    }
    visiting.delete(step.step_id);
    visited.add(step.step_id);
    order.push(step);
    return true;
  }
  if (!plan.steps.every(visit)) return rejected("invalid_dependency_graph");
  const { results, observations: observed, now_ms: now } = context.data;
  if (new Set(results.map((result) => result.step_id)).size !== results.length ||
      new Set(results.map((result) => result.result_id)).size !== results.length ||
      new Set(observed.map((item) => JSON.stringify([item.step_id, item.condition_id]))).size !== observed.length) {
    return rejected("invalid_context");
  }
  const summaries = new Map<string, OperationPreparationSummary["steps"][number]>();
  for (const step of order) {
    const issues = new Set<Issue>();
    const prep = step.preparation;
    if (!prep) issues.add("preparation_missing");
    if (!step.parameters) issues.add("parameters_missing");
    if (prep) {
      if (new Set(prep.preconditions.map((item) => item.condition_id)).size !== prep.preconditions.length ||
          new Set(prep.validation.map((item) => item.check_id)).size !== prep.validation.length ||
          !validBindings(prep)) return rejected("invalid_binding");
      for (const binding of prep.bindings) {
        const destination = binding.field === "target" || binding.field === "parameters"
          ? step[binding.field] : prep[binding.field];
        if (!readPath(destination, binding.path).found) return rejected("invalid_binding");
      }
      const usable = new Map<string, (typeof results)[number]>();
      for (const id of prep.depends_on) {
        const result = results.find((item) => item.step_id === id && item.plan_id === plan.plan_id && item.request_id === plan.request_id);
        if (!result || result.status !== "succeeded") issues.add("dependency_unavailable");
        else if (!fresh(result, now)) issues.add("dependency_expired");
        else if (!sameTarget(result.target, byId.get(id)!.target) || !concreteTarget(result.target) ||
          getOperationDescriptor(result.operation)?.operation_id !== getOperationDescriptor(byId.get(id)!.operation)?.operation_id) issues.add("dependency_target_mismatch");
        else usable.set(id, result);
      }
      for (const binding of prep.bindings) {
        const result = usable.get(binding.source_step_id);
        if (!result) continue;
        const value = readPath(result.output, binding.output_path);
        if (!value.found) { issues.add("dependency_field_missing"); continue; }
        const destination = binding.field === "target" || binding.field === "parameters"
          ? step[binding.field] : prep[binding.field];
        if (!writePath(destination, binding.path, value.value)) return rejected("invalid_binding");
      }
      // 差込値に型違い、raw command、危険keyがあれば候補を返さない。
      const checked = OperationPlanSchema.safeParse(plan);
      if (!checked.success) return rejected("binding_value_invalid");
      for (const condition of prep.preconditions) {
        if (!concreteTarget(condition.target)) issues.add("target_unresolved");
        if (unresolved(condition.expected_revision)) issues.add("value_unresolved");
        const observation = observed.find((item) => item.plan_id === plan.plan_id && item.request_id === plan.request_id &&
          item.step_id === step.step_id && item.condition_id === condition.condition_id);
        if (!observation) issues.add("precondition_unobserved");
        else if (!fresh(observation, now)) issues.add("precondition_expired");
        else if (!sameTarget(observation.target, condition.target) || observation.revision !== condition.expected_revision) issues.add("precondition_changed");
      }
      for (const check of prep.validation) {
        if (!concreteTarget(check.target)) issues.add("target_unresolved");
        if (containsUnresolved(check.expected)) issues.add("value_unresolved");
      }
      if (prep.compensation.available) {
        const action = prep.compensation.action;
        if (!concreteTarget(action.target)) issues.add("target_unresolved");
        if (unresolvedParameters(action.parameters)) issues.add("value_unresolved");
        const compensationPlan: OperationPlan = {
          ...plan,
          steps: [{ ...action, step_id: step.step_id, state: "planned" }],
        };
        if (inspectOperationPlanAdapterRegistry(compensationPlan).kind === "rejected") return rejected("descriptor_mismatch");
      }
    }
    if (!concreteTarget(step.target)) issues.add("target_unresolved");
    if (step.parameters && unresolvedParameters(step.parameters)) issues.add("value_unresolved");
    summaries.set(step.step_id, { step_id: step.step_id, status: issues.size ? "not_ready" : "ready", issues: [...issues] });
  }
  if (inspectOperationPlanAdapterRegistry(plan).kind === "rejected") return rejected("descriptor_mismatch");
  const steps = plan.steps.map((step) => summaries.get(step.step_id)!);
  return {
    kind: "inspected",
    plan,
    summary: OperationPreparationSummarySchema.parse({
      status: steps.every((step) => step.status === "ready") ? "ready" : "not_ready",
      steps,
      may_execute: false,
      used_for_authority: false,
      hds_brain_authority_required: true,
    }),
  };
}

function fresh(value: { observed_at_ms: number; expires_at_ms: number }, now: number): boolean {
  return value.observed_at_ms <= now && value.expires_at_ms > now && value.expires_at_ms > value.observed_at_ms;
}
function sameTarget(left: OperationTarget, right: OperationTarget): boolean {
  return left.kind === right.kind && left.id === right.id && left.scope === right.scope;
}
function unresolved(value: string): boolean {
  const candidate = value.trim();
  return /\*|\$\{|\{\{|^<[^>]+>$|^(?:unknown|pending|unresolved|template|operator)(?::|$)/i.test(candidate) || candidate === "?";
}
function concreteTarget(target: OperationTarget): boolean {
  return target.kind !== "unknown" && target.id.trim().length > 0 && !unresolved(target.id) &&
    !( ["file", "directory", "workspace", "project", "repository"].includes(target.kind) && /[?\[\]]/.test(target.id));
}
const IDENTITY_KEYS = new Set(["path", "root", "cwd", "url", "to", "cc", "bcc", "target", "owner", "repo", "id",
  "calendar_id", "event_id", "file_id", "draft_id", "parent_id", "team_id", "channel_id", "chat_id", "recipient", "recipients"]);
function unresolvedParameters(value: unknown, key = ""): boolean {
  if (typeof value === "string") return containsUnresolved(value) || (IDENTITY_KEYS.has(key) && (!value.trim() || unresolved(value)));
  if (Array.isArray(value)) return value.some((item) => unresolvedParameters(item, key));
  if (IDENTITY_KEYS.has(key)) return true;
  if (value && typeof value === "object") return Object.entries(value).some(([name, item]) =>
    name === "$step" || name === "$ref" || name === "$binding" || unresolvedParameters(item, name));
  return false;
}
function containsUnresolved(value: unknown): boolean {
  if (typeof value === "string") return /\$\{|\{\{|^(?:pending|unresolved|template):/i.test(value.trim());
  if (Array.isArray(value)) return value.some(containsUnresolved);
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) =>
    key === "$step" || key === "$ref" || key === "$binding" || containsUnresolved(item));
  return false;
}
function validBindings(prep: OperationStepPreparation): boolean {
  const paths: string[][] = [];
  for (const binding of prep.bindings) {
    if (!prep.depends_on.includes(binding.source_step_id)) return false;
    const path = binding.path;
    const targetId = (offset: number) => path.length === offset + 2 && path[offset] === "target" && path[offset + 1] === "id";
    const allowed = binding.field === "parameters" ||
      (binding.field === "target" && path.length === 1 && path[0] === "id") ||
      (binding.field === "preconditions" && /^(0|[1-9]\d*)$/.test(path[0]!) &&
        (targetId(1) || (path.length === 2 && path[1] === "expected_revision"))) ||
      (binding.field === "validation" && /^(0|[1-9]\d*)$/.test(path[0]!) && (targetId(1) || path[1] === "expected")) ||
      (binding.field === "compensation" && path[0] === "action" && (targetId(1) || path[1] === "parameters"));
    if (!allowed) return false;
    const full = [binding.field, ...path];
    if (paths.some((previous) => previous.slice(0, Math.min(previous.length, full.length)).every((part, index) => part === full[index]))) return false;
    paths.push(full);
  }
  return true;
}
function readPath(root: unknown, path: string[]): { found: false } | { found: true; value: unknown } {
  let value = root;
  for (const part of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part) ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part))) return { found: false };
    value = (value as Record<string, unknown>)[part];
  }
  return value === undefined ? { found: false } : { found: true, value };
}
function writePath(root: unknown, path: string[], value: unknown): boolean {
  const parent = path.length === 1 ? { found: true, value: root } : readPath(root, path.slice(0, -1));
  const key = path[path.length - 1]!;
  if (!parent.found || !parent.value || typeof parent.value !== "object" || !Object.hasOwn(parent.value, key) ||
      (Array.isArray(parent.value) && !/^(0|[1-9]\d*)$/.test(key))) return false;
  (parent.value as Record<string, unknown>)[key] = value;
  return true;
}
