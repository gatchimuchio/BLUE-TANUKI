import { z } from "zod";

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

const OperationJsonValueSchema: z.ZodType<OperationJsonValue> = z.lazy(() =>
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

export const OperationDiffSchema = z.object({
  summary: z.string().min(1).max(2000),
  affected_targets: z.array(OperationTargetSchema).max(100),
  reversible: z.boolean(),
  evidence_source: z.array(z.enum([
    "CONFIG",
    "INTERNAL_STATE",
    "LIVE_RUNTIME",
    "EXTERNAL_EVIDENCE",
    "FIXTURE",
  ])).min(1),
}).strict();
export type OperationDiff = z.infer<typeof OperationDiffSchema>;

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
