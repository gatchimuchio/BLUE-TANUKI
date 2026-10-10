import {
  inspectOperationPlanAdapterRegistry,
  getOperationDescriptor,
  getToolOperationDescriptor,
  OPERATION_ADAPTER_REGISTRY,
  OperationCoreApprovalTraceSchema,
  OperationCoreExecutorTraceSchema,
  type ExecuteCommand,
  type ExecuteFeedback,
  type OperationAdapterKind,
  type OperationApprovalLevel,
  type OperationCoreApprovalTrace,
  type OperationCoreExecutorTrace,
  type OperationAdapterRegistryEvidence,
  type OperationEffect,
  type OperationPermission,
  OperationPlanSchema,
  prepareOperationPlan,
  type OperationPreparationContext,
  type OperationPreparationSummary,
  type OperationPlan,
  type OperationRisk,
  type OperationState,
  type OperationTarget,
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
  preparation: OperationPreparationSummary;
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

export function inspectOperationCorePlannerOutput(
  content: string,
  context: OperationPreparationContext = { now_ms: Date.now(), results: [], observations: [] },
): OperationCorePlannerInspection {
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

  const prepared = prepareOperationPlan(plan.data, context);
  if (prepared.kind === "rejected") return rejectPlannerOutput(`plan preparation rejected: ${prepared.code}`);

  return {
    kind: "valid_plan",
    evidence: {
      role: "planner_output",
      status: "valid_plan",
      plan: prepared.plan,
      adapter_registry: adapterRegistryInspection.evidence,
      preparation: prepared.summary,
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

export interface OperationCoreApprovalEvidenceLike {
  operation: string;
  risk: OperationRisk;
  approval_level?: OperationApprovalLevel;
  final_review_required: boolean;
}

export function buildOperationCoreExecutorTrace(
  command: ExecuteCommand,
  status: ExecuteFeedback["status"],
  approval: OperationCoreApprovalEvidenceLike,
): OperationCoreExecutorTrace {
  const adapter = operationAdapterForCommand(command);
  const descriptor = OPERATION_ADAPTER_REGISTRY[adapter];
  return OperationCoreExecutorTraceSchema.parse({
    ...operationCoreCommandTraceBase(command, approval),
    role: "execution_adapter_trace",
    state: operationStateForFeedbackStatus(status),
    adapter,
    runtime_boundary: descriptor.runtime_boundary,
    command_generated_by_adapter_only: descriptor.command_generation_location === "execution_adapter_only",
    executor_trace_used_for_authority: false,
  });
}

export function buildOperationCoreApprovalTrace(
  input: {
    command: ExecuteCommand;
    operation: string;
    state: Extract<OperationState, "awaiting_permission" | "approved" | "failed" | "suspended">;
    risk: OperationRisk;
    approval_level: OperationApprovalLevel;
    final_review_required: boolean;
  },
): OperationCoreApprovalTrace {
  const adapter = operationAdapterForCommand(input.command);
  const descriptor = OPERATION_ADAPTER_REGISTRY[adapter];
  return OperationCoreApprovalTraceSchema.parse({
    ...operationCoreCommandTraceBase(input.command, input),
    role: "approval_gate_trace",
    state: input.state,
    adapter,
    runtime_boundary: descriptor.runtime_boundary,
    command_generated_by_adapter_only: descriptor.command_generation_location === "execution_adapter_only",
    approval_trace_used_for_authority: false,
  });
}

function operationCoreCommandTraceBase(
  command: ExecuteCommand,
  approval: OperationCoreApprovalEvidenceLike,
): Omit<
  OperationCoreExecutorTrace,
  "role" | "state" | "adapter" | "runtime_boundary" | "command_generated_by_adapter_only" | "executor_trace_used_for_authority"
> {
  return {
    version: "operation-core.v1",
    operation: bounded(approval.operation || commandOperationLabel(command), 160),
    target: operationTargetForCommand(command),
    effects: operationEffectsForCommand(command),
    permission: operationPermissionForApproval(approval),
    adapter_is_authority: false,
    raw_command_is_core_operation: false,
    adapter_result_used_for_authority: false,
    hds_brain_authority_required: true,
    evidence_source: ["INTERNAL_STATE"],
  };
}

function operationStateForFeedbackStatus(status: ExecuteFeedback["status"]): OperationCoreExecutorTrace["state"] {
  if (status === "success") return "succeeded";
  if (status === "suspended") return "suspended";
  return "failed";
}

function operationPermissionForApproval(approval: OperationCoreApprovalEvidenceLike): OperationPermission {
  return {
    risk: approval.risk,
    approval_level: approval.approval_level ?? (
      approval.final_review_required || approval.risk === "high"
        ? "L3_final_review"
        : approval.risk === "medium"
          ? "L2_operate"
          : "L1_observe"
    ),
    final_review_required: approval.final_review_required,
    hds_brain_authority_required: true,
    approval_gate_required: true,
  };
}

function operationAdapterForCommand(command: ExecuteCommand): OperationAdapterKind {
  if (command.type === "noop") return "none";
  if (command.type === "llm_call") return getOperationDescriptor("llm.call")!.adapter;
  if (command.type === "channel_send") return getOperationDescriptor("channel.send")!.adapter;
  if (command.type !== "tool_call") return "internal_runtime";
  return getToolOperationDescriptor(command.payload.tool_name)?.adapter ?? "internal_runtime";
}

function operationEffectsForCommand(command: ExecuteCommand): OperationEffect[] {
  if (command.type === "noop") return ["observe"];
  if (command.type === "llm_call") return [...getOperationDescriptor("llm.call")!.effects];
  if (command.type === "channel_send") return [...getOperationDescriptor("channel.send")!.effects];
  if (command.type !== "tool_call") return ["observe"];
  return [...(getToolOperationDescriptor(command.payload.tool_name)?.effects ?? ["observe"] as const)];
}

function operationTargetForCommand(command: ExecuteCommand): OperationTarget {
  if (command.type === "llm_call") {
    return {
      kind: "external_service",
      id: bounded(command.payload.backend_hint ?? command.payload.model ?? "llm_backend"),
      scope: "llm_backend",
    };
  }
  if (command.type === "channel_send") {
    return {
      kind: "external_service",
      id: bounded(`channel:${command.payload.channel}`),
      display_name: bounded(command.payload.channel),
      scope: "channel_send",
    };
  }
  if (command.type === "tool_call") {
    const tool = command.payload.tool_name;
    if (tool === "shell.exec") return { kind: "runtime", id: "tool:shell.exec", scope: "shell_adapter" };
    if (tool === "browser.automation" || tool === "browser.snapshot") {
      return { kind: "browser", id: bounded(`tool:${tool}`), scope: "browser_adapter" };
    }
    if (tool.startsWith("schedule.")) return { kind: "service", id: "runtime_schedule", scope: "internal_runtime" };
    if (
      tool === "composio.execute" ||
      tool === "web.search" ||
      tool.startsWith("github.") ||
      tool.startsWith("google.") ||
      tool.startsWith("gmail.")
    ) {
      return { kind: "external_service", id: bounded(`tool:${tool}`), scope: "external_api_adapter" };
    }
    return { kind: "runtime", id: bounded(`tool:${tool}`), scope: "internal_runtime" };
  }
  return { kind: "runtime", id: "noop", scope: "no_adapter" };
}

function commandOperationLabel(command: ExecuteCommand): string {
  if (command.type === "tool_call") return command.payload.tool_name;
  return command.type;
}

function bounded(value: string, max = 300): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
