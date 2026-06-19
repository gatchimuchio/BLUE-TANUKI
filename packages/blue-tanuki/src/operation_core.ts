import {
  inspectOperationPlanAdapterRegistry,
  type OperationAdapterRegistryEvidence,
  OperationPlanSchema,
  type OperationPlan,
} from "@blue-tanuki/protocol";

const RAW_COMMAND_KEYS = new Set([
  "cmd",
  "command",
  "raw_command",
  "shell_command",
  "terminal_command",
  "subprocess_command",
]);

export interface OperationCorePlannerEvidence {
  role: "planner_output";
  status: "valid_plan";
  plan: OperationPlan;
  adapter_registry: OperationAdapterRegistryEvidence;
  planner_output_used_for_authority: false;
  hds_brain_authority_required: true;
  evidence_source: readonly ["EXTERNAL_EVIDENCE"];
}

export interface OperationCorePlannerRejection {
  role: "planner_output";
  status: "rejected";
  reason: string;
  planner_output_used_for_authority: false;
  hds_brain_authority_required: true;
  evidence_source: readonly ["EXTERNAL_EVIDENCE"];
}

export type OperationCorePlannerInspection =
  | { kind: "none" }
  | { kind: "valid_plan"; evidence: OperationCorePlannerEvidence }
  | { kind: "rejected"; rejection: OperationCorePlannerRejection };

export function inspectOperationCorePlannerOutput(content: string): OperationCorePlannerInspection {
  const candidate = extractJsonCandidate(content);
  if (!candidate) return { kind: "none" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return rejectPlannerOutput(`invalid JSON planner output: ${errorMessage(error)}`);
  }

  const rawCommandPath = rawCommandKeyPath(parsed);
  if (rawCommandPath) {
    return rejectPlannerOutput(`raw command field is not allowed in planner output: ${rawCommandPath}`);
  }

  if (!plannerLike(parsed)) return { kind: "none" };

  const plan = OperationPlanSchema.safeParse(parsed);
  if (!plan.success) {
    const issue = plan.error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "<root>";
    return rejectPlannerOutput(
      `OperationPlanSchema rejected planner output at ${location}: ${issue?.message ?? "invalid plan"}`,
    );
  }

  const adapterRegistryInspection = inspectOperationPlanAdapterRegistry(plan.data);
  if (adapterRegistryInspection.kind === "rejected") {
    return rejectPlannerOutput(`adapter registry rejected planner output: ${adapterRegistryInspection.reason}`);
  }

  return {
    kind: "valid_plan",
    evidence: {
      role: "planner_output",
      status: "valid_plan",
      plan: plan.data,
      adapter_registry: adapterRegistryInspection.evidence,
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
      evidence_source: ["EXTERNAL_EVIDENCE"],
    },
  };
}

function rejectPlannerOutput(reason: string): OperationCorePlannerInspection {
  return {
    kind: "rejected",
    rejection: {
      role: "planner_output",
      status: "rejected",
      reason,
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
      evidence_source: ["EXTERNAL_EVIDENCE"],
    },
  };
}

function extractJsonCandidate(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) return trimmed;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1]?.trim();
  return body?.startsWith("{") ? body : undefined;
}

function plannerLike(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.version === "operation-core.v1" ||
    "plan_id" in obj ||
    "steps" in obj ||
    "raw_command_policy" in obj ||
    "planner_output_used_for_authority" in obj
  );
}

function rawCommandKeyPath(value: unknown, path: readonly string[] = []): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = rawCommandKeyPath(value[i], [...path, String(i)]);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.trim().toLowerCase();
    if (RAW_COMMAND_KEYS.has(normalized)) return [...path, key].join(".");
    const nested = rawCommandKeyPath(nestedValue, [...path, key]);
    if (nested) return nested;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
