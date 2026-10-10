import { z } from "zod";
import { getOperationDescriptor } from "./operation_catalog.js";

const OperationObjectKeySchema = z.string().refine(
  (key) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
  "dangerous object key is not allowed",
);

export type OperationJsonValue =
  | string
  | number
  | boolean
  | null
  | OperationJsonValue[]
  | { [key: string]: OperationJsonValue | undefined };

export const OperationJsonValueSchema: z.ZodType<OperationJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(OperationJsonValueSchema),
    z.record(OperationObjectKeySchema, OperationJsonValueSchema.optional()),
  ]),
);

const RAW_COMMAND_KEYS = new Set([
  "cmd",
  "command",
  "raw_command",
  "shell_command",
  "terminal_command",
  "subprocess_command",
]);

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

export const OperationInterfaceSchema = z.enum([
  "gui",
  "natural_language",
  "api",
  "cli",
  "agent",
  "scheduler",
  "system",
]);
export type OperationInterface = z.infer<typeof OperationInterfaceSchema>;

export const OperationStateSchema = z.enum([
  "draft",
  "planned",
  "awaiting_permission",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "rolled_back",
  "suspended",
]);
export type OperationState = z.infer<typeof OperationStateSchema>;

export const OperationRiskSchema = z.enum(["low", "medium", "high"]);
export type OperationRisk = z.infer<typeof OperationRiskSchema>;

export const OperationApprovalLevelSchema = z.enum([
  "L1_observe",
  "L2_operate",
  "L3_final_review",
]);
export type OperationApprovalLevel = z.infer<typeof OperationApprovalLevelSchema>;

export const OperationEffectSchema = z.enum([
  "observe",
  "read",
  "write",
  "delete",
  "external_send",
  "process_spawn",
  "browser_action",
  "settings_change",
  "credential_access",
  "schedule_change",
  "rollback",
]);
export type OperationEffect = z.infer<typeof OperationEffectSchema>;

export const OperationAdapterKindSchema = z.enum([
  "none",
  "shell",
  "windows",
  "linux",
  "macos",
  "browser",
  "composio",
  "external_api",
  "internal_runtime",
]);
export type OperationAdapterKind = z.infer<typeof OperationAdapterKindSchema>;

export const OperationAdapterBoundarySchema = z.enum([
  "no_adapter",
  "shell_adapter",
  "os_adapter",
  "browser_adapter",
  "external_api_adapter",
  "internal_runtime_adapter",
]);
export type OperationAdapterBoundary = z.infer<typeof OperationAdapterBoundarySchema>;

export const OperationAdapterDescriptorSchema = z.object({
  kind: OperationAdapterKindSchema,
  display_name: z.string().min(1).max(120),
  runtime_boundary: OperationAdapterBoundarySchema,
  role: z.literal("execution_adapter"),
  default_runtime: z.boolean(),
  adapter_is_authority: z.literal(false),
  adapter_result_used_for_authority: z.literal(false),
  command_generation_location: z.enum([
    "execution_adapter_only",
    "not_applicable",
  ]),
}).strict();
export type OperationAdapterDescriptor = z.infer<typeof OperationAdapterDescriptorSchema>;

const OPERATION_ADAPTER_REGISTRY_DATA = {
  none: {
    kind: "none",
    display_name: "No execution adapter",
    runtime_boundary: "no_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "not_applicable",
  },
  shell: {
    kind: "shell",
    display_name: "ShellAdapter",
    runtime_boundary: "shell_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "execution_adapter_only",
  },
  windows: {
    kind: "windows",
    display_name: "WindowsAdapter",
    runtime_boundary: "os_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "execution_adapter_only",
  },
  linux: {
    kind: "linux",
    display_name: "LinuxAdapter",
    runtime_boundary: "os_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "execution_adapter_only",
  },
  macos: {
    kind: "macos",
    display_name: "MacOSAdapter",
    runtime_boundary: "os_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "execution_adapter_only",
  },
  browser: {
    kind: "browser",
    display_name: "BrowserAdapter",
    runtime_boundary: "browser_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "not_applicable",
  },
  composio: {
    kind: "composio",
    display_name: "ComposioAdapter",
    runtime_boundary: "external_api_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "not_applicable",
  },
  external_api: {
    kind: "external_api",
    display_name: "ExternalApiAdapter",
    runtime_boundary: "external_api_adapter",
    role: "execution_adapter",
    default_runtime: false,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "not_applicable",
  },
  internal_runtime: {
    kind: "internal_runtime",
    display_name: "InternalRuntimeAdapter",
    runtime_boundary: "internal_runtime_adapter",
    role: "execution_adapter",
    default_runtime: true,
    adapter_is_authority: false,
    adapter_result_used_for_authority: false,
    command_generation_location: "not_applicable",
  },
} as const satisfies Record<OperationAdapterKind, OperationAdapterDescriptor>;

export const OPERATION_ADAPTER_REGISTRY: Readonly<Record<OperationAdapterKind, OperationAdapterDescriptor>> =
  Object.freeze(OPERATION_ADAPTER_REGISTRY_DATA);

export const OperationTargetSchema = z.object({
  kind: z.enum([
    "workspace",
    "project",
    "file",
    "directory",
    "repository",
    "application",
    "service",
    "browser",
    "external_service",
    "runtime",
    "settings",
    "audit_log",
    "unknown",
  ]),
  id: z.string().min(1).max(300),
  display_name: z.string().min(1).max(300).optional(),
  scope: z.string().min(1).max(300).optional(),
  metadata: z.record(OperationObjectKeySchema, OperationJsonValueSchema.optional()).optional(),
}).strict();
export type OperationTarget = z.infer<typeof OperationTargetSchema>;

export const OperationParametersSchema = z
  .record(OperationObjectKeySchema, OperationJsonValueSchema.optional())
  .superRefine((value, ctx) => {
    const path = rawCommandKeyPath(value);
    if (path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `raw command field is not allowed in Operation Core parameters: ${path}`,
      });
    }
  });
export type OperationParameters = z.infer<typeof OperationParametersSchema>;

export const OperationPermissionSchema = z.object({
  risk: OperationRiskSchema,
  approval_level: OperationApprovalLevelSchema,
  final_review_required: z.boolean(),
  hds_brain_authority_required: z.literal(true),
  approval_gate_required: z.boolean(),
}).strict();
export type OperationPermission = z.infer<typeof OperationPermissionSchema>;

export const OperationEvidenceSourceSchema = z.enum([
  "CONFIG",
  "INTERNAL_STATE",
  "LIVE_RUNTIME",
  "EXTERNAL_EVIDENCE",
  "FIXTURE",
]);
export type OperationEvidenceSource = z.infer<typeof OperationEvidenceSourceSchema>;

export const OperationDiffSchema = z.object({
  summary: z.string().min(1).max(2000),
  affected_targets: z.array(OperationTargetSchema).max(100),
  reversible: z.boolean(),
  evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
}).strict();
export type OperationDiff = z.infer<typeof OperationDiffSchema>;

// 準備は具体値の候補を作るだけで、承認・実行・結果検証を行わない。
const PreparationPathSchema = z.array(OperationObjectKeySchema).min(1).max(12);
export const OperationStepPreparationSchema = z.object({
  depends_on: z.array(z.string().min(1).max(200)).max(100),
  bindings: z.array(z.object({
    source_step_id: z.string().min(1).max(200),
    output_path: PreparationPathSchema,
    field: z.enum(["target", "parameters", "preconditions", "validation", "compensation"]),
    path: PreparationPathSchema,
  }).strict()).max(100),
  preconditions: z.array(z.object({
    condition_id: z.string().min(1).max(200),
    target: OperationTargetSchema,
    expected_revision: z.string().min(1).max(200),
  }).strict()).max(100),
  validation: z.array(z.object({
    check_id: z.string().min(1).max(200),
    method: z.enum(["result_equals", "revision_equals"]),
    target: OperationTargetSchema,
    expected: OperationJsonValueSchema,
  }).strict()).min(1).max(100),
  compensation: z.discriminatedUnion("available", [
    z.object({ available: z.literal(false), reason: z.string().min(1).max(500) }).strict(),
    z.object({
      available: z.literal(true),
      action: z.object({
        operation: z.string().min(1).max(160),
        target: OperationTargetSchema,
        parameters: OperationParametersSchema,
        effects: z.array(OperationEffectSchema).min(1).max(20),
        permission: OperationPermissionSchema,
        adapter: OperationAdapterKindSchema,
        adapter_is_authority: z.literal(false),
        command_generated_by_adapter_only: z.boolean(),
      }).strict(),
    }).strict(),
  ]),
}).strict();
export type OperationStepPreparation = z.infer<typeof OperationStepPreparationSchema>;

export const OperationStepSchema = z.object({
  step_id: z.string().min(1).max(200),
  operation: z.string().min(1).max(160),
  target: OperationTargetSchema,
  state: OperationStateSchema,
  effects: z.array(OperationEffectSchema).min(1).max(20),
  permission: OperationPermissionSchema,
  parameters: OperationParametersSchema.optional(),
  adapter: OperationAdapterKindSchema,
  adapter_is_authority: z.literal(false),
  command_generated_by_adapter_only: z.boolean(),
  result_digest: z.string().min(1).max(200).optional(),
  preparation: OperationStepPreparationSchema.optional(),
}).strict();
export type OperationStep = z.infer<typeof OperationStepSchema>;

export const OperationRequestSchema = z.object({
  version: z.literal("operation-core.v1"),
  request_id: z.string().min(1).max(200),
  source_interface: OperationInterfaceSchema,
  actor: z.string().min(1).max(200),
  goal: z.string().min(1).max(200_000),
  target: OperationTargetSchema.optional(),
  constraints: z.object({
    hds_brain_authority_required: z.literal(true),
    disallow_raw_command_as_authority: z.literal(true),
    max_steps: z.number().int().positive().max(100).optional(),
  }).strict(),
  input_digest: z.string().min(1).max(200).optional(),
  used_for_authority: z.literal(false),
}).strict();
export type OperationRequest = z.infer<typeof OperationRequestSchema>;

export const OperationPlanSchema = z.object({
  version: z.literal("operation-core.v1"),
  plan_id: z.string().min(1).max(200),
  request_id: z.string().min(1).max(200),
  state: OperationStateSchema,
  steps: z.array(OperationStepSchema).min(1).max(100),
  diff: OperationDiffSchema.optional(),
  rollback: z.object({
    available: z.boolean(),
    strategy: z.string().min(1).max(1000).optional(),
    rollback_target: OperationTargetSchema.optional(),
  }).strict(),
  raw_command_policy: z.object({
    raw_command_is_core_operation: z.literal(false),
    command_generation_location: z.enum([
      "execution_adapter_only",
      "not_applicable",
    ]),
  }).strict(),
  planner_output_used_for_authority: z.literal(false),
  hds_brain_authority_required: z.literal(true),
}).strict();
export type OperationPlan = z.infer<typeof OperationPlanSchema>;

export const OperationPreparationIssueSchema = z.enum([
  "preparation_missing", "parameters_missing", "dependency_unavailable",
  "dependency_expired", "dependency_target_mismatch", "dependency_field_missing",
  "target_unresolved", "value_unresolved", "precondition_unobserved",
  "precondition_expired", "precondition_changed",
]);
export const OperationPreparationSummarySchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  steps: z.array(z.object({
    step_id: z.string().min(1).max(200),
    status: z.enum(["ready", "not_ready"]),
    issues: z.array(OperationPreparationIssueSchema).max(20),
  }).strict()).max(100),
  may_execute: z.literal(false),
  used_for_authority: z.literal(false),
  hds_brain_authority_required: z.literal(true),
}).strict();
export type OperationPreparationSummary = z.infer<typeof OperationPreparationSummarySchema>;

export interface OperationAdapterRegistryStepEvidence {
  step_id: string;
  operation: string;
  descriptor_version: string;
  implementation_ref: string;
  required_effects: readonly OperationEffect[];
  required_capabilities: readonly string[];
  descriptor_registry_used_for_authority: false;
  adapter: OperationAdapterKind;
  display_name: string;
  runtime_boundary: OperationAdapterBoundary;
  default_runtime: boolean;
  adapter_is_authority: false;
  adapter_result_used_for_authority: false;
  command_generation_location: OperationAdapterDescriptor["command_generation_location"];
}

export interface OperationAdapterRegistryEvidence {
  role: "adapter_registry";
  status: "validated";
  default_runtime_adapter: "internal_runtime";
  shell_default_runtime: false;
  hds_brain_authority_required: true;
  adapter_registry_used_for_authority: false;
  descriptor_registry_used_for_authority: false;
  evidence_source: readonly ["CONFIG", "INTERNAL_STATE"];
  steps: OperationAdapterRegistryStepEvidence[];
}

export type OperationAdapterRegistryInspection =
  | { kind: "valid"; evidence: OperationAdapterRegistryEvidence }
  | { kind: "rejected"; reason: string };

export function inspectOperationPlanAdapterRegistry(plan: OperationPlan): OperationAdapterRegistryInspection {
  const steps: OperationAdapterRegistryStepEvidence[] = [];
  let requiresAdapterCommandGeneration = false;

  for (const step of plan.steps) {
    const operationDescriptor = getOperationDescriptor(step.operation);
    if (!operationDescriptor) {
      return { kind: "rejected", reason: `operation descriptor registry does not contain operation: ${step.operation}` };
    }
    if (step.adapter !== operationDescriptor.adapter) {
      return {
        kind: "rejected",
        reason:
          `operation descriptor registry rejected ${step.step_id}: operation ${step.operation} ` +
          `requires adapter=${operationDescriptor.adapter}`,
      };
    }
    const expectedEffects = [...operationDescriptor.effects].sort();
    const actualEffects = [...step.effects].sort();
    if (
      actualEffects.length !== expectedEffects.length ||
      actualEffects.some((effect, index) => effect !== expectedEffects[index])
    ) {
      return {
        kind: "rejected",
        reason:
          `operation descriptor registry rejected ${step.step_id}: operation ${step.operation} ` +
          `requires the complete effect set [${expectedEffects.join(", ")}]`,
      };
    }
    const descriptor = OPERATION_ADAPTER_REGISTRY[step.adapter];
    if (!descriptor) {
      return { kind: "rejected", reason: `adapter registry does not contain adapter: ${step.adapter}` };
    }
    if (descriptor.adapter_is_authority !== false || step.adapter_is_authority !== false) {
      return { kind: "rejected", reason: `adapter may not be authority: ${step.step_id}` };
    }
    const expectedCommandGeneratedByAdapterOnly =
      descriptor.command_generation_location === "execution_adapter_only";
    if (step.command_generated_by_adapter_only !== expectedCommandGeneratedByAdapterOnly) {
      return {
        kind: "rejected",
        reason:
          `adapter registry rejected ${step.step_id}: ${step.adapter} requires ` +
          `command_generated_by_adapter_only=${expectedCommandGeneratedByAdapterOnly}`,
      };
    }
    if (descriptor.command_generation_location === "execution_adapter_only") {
      requiresAdapterCommandGeneration = true;
    }
    steps.push({
      step_id: step.step_id,
      operation: step.operation,
      descriptor_version: operationDescriptor.descriptor_version,
      implementation_ref: operationDescriptor.implementation_ref,
      required_effects: [...operationDescriptor.effects],
      required_capabilities: [...operationDescriptor.required_capabilities],
      descriptor_registry_used_for_authority: false,
      adapter: step.adapter,
      display_name: descriptor.display_name,
      runtime_boundary: descriptor.runtime_boundary,
      default_runtime: descriptor.default_runtime,
      adapter_is_authority: false,
      adapter_result_used_for_authority: false,
      command_generation_location: descriptor.command_generation_location,
    });
  }

  if (
    requiresAdapterCommandGeneration &&
    plan.raw_command_policy.command_generation_location !== "execution_adapter_only"
  ) {
    return {
      kind: "rejected",
      reason:
        "plan raw_command_policy must use command_generation_location=execution_adapter_only " +
        "when any step selects an execution adapter that generates commands",
    };
  }

  return {
    kind: "valid",
    evidence: {
      role: "adapter_registry",
      status: "validated",
      default_runtime_adapter: "internal_runtime",
      shell_default_runtime: false,
      hds_brain_authority_required: true,
      adapter_registry_used_for_authority: false,
      descriptor_registry_used_for_authority: false,
      evidence_source: ["CONFIG", "INTERNAL_STATE"],
      steps,
    },
  };
}

export const OperationCoreProjectionSchema = z.object({
  version: z.literal("operation-core.v1"),
  projection_id: z.string().min(1).max(200),
  source_surface: z.string().min(1).max(80),
  state: z.literal("planned"),
  steps: z.array(OperationStepSchema).min(1).max(200),
  raw_command_policy: z.object({
    raw_command_is_core_operation: z.literal(false),
    command_generation_location: z.enum([
      "execution_adapter_only",
      "not_applicable",
    ]),
  }).strict(),
  hds_brain_authority_required: z.literal(true),
  planner_output_used_for_authority: z.literal(false),
  ui_projection_used_for_authority: z.literal(false),
  adapter_result_used_for_authority: z.literal(false),
}).strict();
export type OperationCoreProjection = z.infer<typeof OperationCoreProjectionSchema>;

export const OperationExecutionResultSchema = z.object({
  version: z.literal("operation-core.v1"),
  plan_id: z.string().min(1).max(200),
  step_id: z.string().min(1).max(200),
  state: z.enum(["succeeded", "failed", "suspended"]),
  adapter: OperationAdapterKindSchema,
  adapter_result_used_for_authority: z.literal(false),
  output_digest: z.string().min(1).max(200).optional(),
  error: z.string().min(1).max(2000).optional(),
  rollback_available: z.boolean(),
}).strict();
export type OperationExecutionResult = z.infer<typeof OperationExecutionResultSchema>;

export const OperationCoreExecutorTraceSchema = z.object({
  version: z.literal("operation-core.v1"),
  role: z.literal("execution_adapter_trace"),
  operation: z.string().min(1).max(160),
  state: z.enum(["succeeded", "failed", "suspended"]),
  target: OperationTargetSchema,
  effects: z.array(OperationEffectSchema).min(1).max(20),
  permission: OperationPermissionSchema,
  adapter: OperationAdapterKindSchema,
  runtime_boundary: OperationAdapterBoundarySchema,
  adapter_is_authority: z.literal(false),
  command_generated_by_adapter_only: z.boolean(),
  raw_command_is_core_operation: z.literal(false),
  adapter_result_used_for_authority: z.literal(false),
  executor_trace_used_for_authority: z.literal(false),
  hds_brain_authority_required: z.literal(true),
  evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
}).strict();
export type OperationCoreExecutorTrace = z.infer<typeof OperationCoreExecutorTraceSchema>;

export const OperationCoreApprovalTraceSchema = z.object({
  version: z.literal("operation-core.v1"),
  role: z.literal("approval_gate_trace"),
  operation: z.string().min(1).max(160),
  state: z.enum(["awaiting_permission", "approved", "failed", "suspended"]),
  target: OperationTargetSchema,
  effects: z.array(OperationEffectSchema).min(1).max(20),
  permission: OperationPermissionSchema,
  adapter: OperationAdapterKindSchema,
  runtime_boundary: OperationAdapterBoundarySchema,
  adapter_is_authority: z.literal(false),
  command_generated_by_adapter_only: z.boolean(),
  raw_command_is_core_operation: z.literal(false),
  adapter_result_used_for_authority: z.literal(false),
  approval_trace_used_for_authority: z.literal(false),
  hds_brain_authority_required: z.literal(true),
  evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
}).strict();
export type OperationCoreApprovalTrace = z.infer<typeof OperationCoreApprovalTraceSchema>;

export const OperationCoreExecutionCommandProjectionSchema = z.object({
  type: z.string().min(1).max(80),
  operation: z.string().min(1).max(200),
  upstream_decision: z.string().min(1).max(80),
  upstream_commit_hash: z.string().min(1).max(200),
  constraints: z.object({
    max_tokens: z.number().finite().nonnegative().nullable(),
    timeout_ms: z.number().finite().nonnegative().nullable(),
    allowed_tools: z.array(z.string().min(1).max(200)).max(100),
    allowed_capabilities: z.array(z.string().min(1).max(200)).max(100),
  }).strict(),
  payload: z.object({
    tool_name: z.string().min(1).max(200).optional(),
    argument_keys: z.array(z.string().min(1).max(200)).max(100),
    arguments_digest: z.string().min(1).max(200).optional(),
    messages_count: z.number().finite().nonnegative().nullable(),
    message_roles: z.array(z.string().min(1).max(80)).max(50),
    messages_digest: z.string().min(1).max(200).optional(),
    backend_hint: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(200).optional(),
    channel: z.string().min(1).max(120).optional(),
    target_digest: z.string().min(1).max(200).optional(),
    content_digest: z.string().min(1).max(200).optional(),
    content_chars: z.number().finite().nonnegative().nullable(),
  }).strict(),
}).strict();
export type OperationCoreExecutionCommandProjection = z.infer<typeof OperationCoreExecutionCommandProjectionSchema>;

export const OperationCorePlannerExecutionProjectionSchema = z.object({
  role: z.literal("planner_output_projection"),
  status: z.literal("valid_plan"),
  plan_id: z.string().min(1).max(200),
  request_id: z.string().min(1).max(200),
  state: OperationStateSchema,
  steps_count: z.number().int().nonnegative(),
  preparation: OperationPreparationSummarySchema.optional(),
  step_summaries: z.array(z.object({
    step_id: z.string().min(1).max(200),
    operation: z.string().min(1).max(160),
    target_kind: z.string().min(1).max(80),
    target_id_digest: z.string().min(1).max(200),
    effects: z.array(OperationEffectSchema).min(1).max(20),
    adapter: OperationAdapterKindSchema,
    adapter_is_authority: z.literal(false),
    command_generated_by_adapter_only: z.boolean(),
    approval_level: OperationApprovalLevelSchema,
    risk: OperationRiskSchema,
    final_review_required: z.boolean(),
  }).strict()).max(20),
  raw_command_is_core_operation: z.literal(false),
  planner_output_used_for_authority: z.literal(false),
  hds_brain_authority_required: z.literal(true),
  evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
}).strict();
export type OperationCorePlannerExecutionProjection = z.infer<typeof OperationCorePlannerExecutionProjectionSchema>;

export const OperationCoreExecutionGapProjectionSchema = z.object({
  available: z.boolean(),
  reason: z.string().min(1).max(500),
  used_for_authority: z.literal(false),
  evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
}).strict();
export type OperationCoreExecutionGapProjection = z.infer<typeof OperationCoreExecutionGapProjectionSchema>;

export const OperationCoreExecutionResultProjectionSchema = z.object({
  index: z.number().int().nonnegative(),
  request_id: z.string().min(1).max(200).nullable(),
  command_id: z.string().min(1).max(200).nullable(),
  actor: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(120).optional(),
  timestamp: z.number().finite().nonnegative(),
  payload_digest: z.string().min(1).max(200),
  entry_hash: z.string().min(1).max(200),
  origin_channel: z.string().min(1).max(120),
  status: z.enum(["success", "failed", "suspended", "unknown"]),
  result_present: z.boolean(),
  result_digest: z.string().min(1).max(200).nullable(),
  error_present: z.boolean(),
  error_digest: z.string().min(1).max(200).nullable(),
  metrics: z.object({
    duration_ms: z.number().finite().nonnegative().optional(),
  }).strict(),
  command: OperationCoreExecutionCommandProjectionSchema,
  execution_trace: OperationCoreExecutorTraceSchema.optional(),
  planner_output: OperationCorePlannerExecutionProjectionSchema.optional(),
  diff: OperationCoreExecutionGapProjectionSchema,
  rollback: OperationCoreExecutionGapProjectionSchema,
  operation_core: z.object({
    role: z.literal("execution_result_projection"),
    used_for_authority: z.literal(false),
    adapter_result_used_for_authority: z.literal(false),
    raw_payload_exposed: z.literal(false),
    evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
  }).strict(),
}).strict();
export type OperationCoreExecutionResultProjection = z.infer<typeof OperationCoreExecutionResultProjectionSchema>;

export const OperationCoreExecutionProjectionSchema = z.object({
  schema_version: z.literal("operation-core.execution.v1"),
  evidence_source: z.array(OperationEvidenceSourceSchema).min(1),
  used_for_authority: z.literal(false),
  adapter_result_used_for_authority: z.literal(false),
  execution_history_used_for_authority: z.literal(false),
  raw_payload_exposed: z.literal(false),
  chain_valid: z.boolean(),
  skipped_count: z.number().int().nonnegative(),
  entries_count: z.number().int().nonnegative(),
  displayed_count: z.number().int().nonnegative(),
  latest_results: z.array(OperationCoreExecutionResultProjectionSchema).max(20),
}).strict();
export type OperationCoreExecutionProjection = z.infer<typeof OperationCoreExecutionProjectionSchema>;
