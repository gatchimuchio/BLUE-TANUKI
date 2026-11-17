import {
  SettingsWriteArgumentsSchema,
  SettingsWriteTargetVersionObservationSchema,
  requireToolOperationDescriptor,
  settingsWriteTargetIdentityDigest,
  type SettingsWritePatch,
  type SettingsWriteTargetVersionObservation,
} from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { SettingsWriteContentReview, Tool } from "./registry.js";

export interface SettingsWritePort {
  inspect(): Promise<{
    target_state_digest: string;
    values: {
      model: string | null;
      temperature: number | null;
      max_tokens: number | null;
      timeout_ms: number | null;
      composio: {
        api_key_configured: boolean;
        user_id: string | null;
        allowed_toolkits: string | null;
        allowed_actions: string | null;
        revoked_actions: string | null;
        api_base_url: string | null;
        dry_run: boolean;
        live_execution: boolean;
      };
    };
  }>;
  apply(patch: SettingsWritePatch, expected_target_state_digest: string): Promise<{
    changed_keys: readonly string[];
    restart_required: true;
  }>;
}

const BUILTIN_SETTINGS_WRITE_TOOLS = new WeakSet<Tool>();
const PATCH_FIELDS = {
  model: "llm.model",
  temperature: "llm.temperature",
  max_tokens: "llm.max_tokens",
  timeout_ms: "llm.timeout_ms",
} as const;

const COMPOSIO_PATCH_FIELDS = {
  user_id: "composio.user_id",
  allowed_toolkits: "composio.allowed_toolkits",
  allowed_actions: "composio.allowed_actions",
  revoked_actions: "composio.revoked_actions",
  api_base_url: "composio.api_base_url",
  dry_run: "composio.dry_run",
  live_execution: "composio.live_execution",
} as const;

export function createSettingsWriteTool(port: SettingsWritePort): Tool {
  const tool: Tool = {
    name: "settings.write",
    adapter_version: "1.0.0-rc.1",
    description: "Apply one explicit non-secret Gateway LLM or Composio settings patch through the HDS Operation Plan and L3 review. API key bytes are never accepted.",
    required_capabilities: requireToolOperationDescriptor("settings.write").required_capabilities,
    async inspect_target_version(rawArgs, options = {}): Promise<SettingsWriteTargetVersionObservation> {
      const { patch } = parseArgs(rawArgs);
      const commandDigest = requireDigest(options.command_digest, "command");
      const planDigest = requireDigest(options.operation_plan_binding_digest, "operation plan");
      const target = await port.inspect();
      return SettingsWriteTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.settings-write-target-version.v1",
        target_identity_digest: settingsWriteTargetIdentityDigest(),
        target_state_digest: requireDigest(target.target_state_digest, "target state"),
        request_payload_digest: requestPayloadDigest(patch),
        command_digest: commandDigest,
        operation_plan_binding_digest: planDigest,
        used_for_authority: false,
        may_execute: false,
      });
    },
    async inspect_content_review(rawArgs, options = {}): Promise<SettingsWriteContentReview> {
      const { patch } = parseArgs(rawArgs);
      const observation = SettingsWriteTargetVersionObservationSchema.parse(
        await tool.inspect_target_version!(rawArgs, options),
      );
      const commandDigest = requireDigest(options.command_digest, "command");
      const planDigest = requireDigest(options.operation_plan_binding_digest, "operation plan");
      const target = await port.inspect();
      if (target.target_state_digest !== observation.target_state_digest) {
        throw new Error("settings_write_target_changed_during_review");
      }
      const changes = patch.llm
        ? Object.entries(patch.llm).map(([field, after]) => {
          const key = field as keyof typeof PATCH_FIELDS;
          const before = target.values[key];
          if (before === after) return null;
          return { key: PATCH_FIELDS[key], before, after };
        }).filter((change): change is NonNullable<typeof change> => change !== null)
        : buildComposioChanges(patch.composio!, target.values.composio);
      if (changes.length === 0) throw new Error("settings_write_patch_has_no_effect");
      const reviewBase = {
        kind: "settings_write" as const,
        operation: "settings.write" as const,
        changes,
        request_payload_digest: observation.request_payload_digest,
        target_version_digest: operationPlanDigest(observation),
        operation_plan_binding_digest: planDigest,
        command_digest: commandDigest,
        no_store: true as const,
        used_for_authority: false as const,
        may_execute: false as const,
      };
      return { ...reviewBase, review_digest: operationPlanDigest(reviewBase) };
    },
    async invoke(rawArgs, context): Promise<unknown> {
      const { patch } = parseArgs(rawArgs);
      const observation = SettingsWriteTargetVersionObservationSchema.parse(context.target_version_observation);
      if (observation.target_identity_digest !== settingsWriteTargetIdentityDigest() ||
          observation.command_digest !== context.operation_plan_command_digest ||
          !context.operation_plan_command_digest || !context.upstream_commit_hash) {
        throw new Error("settings_write_approved_target_mismatch");
      }
      return port.apply(patch, observation.target_state_digest);
    },
  };
  BUILTIN_SETTINGS_WRITE_TOOLS.add(tool);
  return tool;
}

export function isSettingsWriteTool(tool: Tool | undefined): boolean {
  return !!tool && BUILTIN_SETTINGS_WRITE_TOOLS.has(tool);
}

function parseArgs(value: Record<string, unknown>): { patch: SettingsWritePatch } {
  const parsed = SettingsWriteArgumentsSchema.safeParse(value);
  if (!parsed.success) throw new Error("settings_write_arguments_invalid");
  return parsed.data;
}

function buildComposioChanges(
  patch: NonNullable<SettingsWritePatch["composio"]>,
  current: Awaited<ReturnType<SettingsWritePort["inspect"]>>["values"]["composio"],
): SettingsWriteContentReview["changes"] {
  const changes: SettingsWriteContentReview["changes"][number][] = [];
  for (const [field, after] of Object.entries(patch)) {
    if (field === "clear_api_key") continue;
    const key = field as keyof typeof COMPOSIO_PATCH_FIELDS;
    const before = current[key];
    if (before !== after) changes.push({ key: COMPOSIO_PATCH_FIELDS[key], before, after });
  }
  if (patch.clear_api_key === true) {
    if (current.api_key_configured) changes.push({
      key: "composio.api_key", before: "設定済み", after: "未設定",
    });
    if (current.dry_run !== true) changes.push({
      key: "composio.dry_run", before: current.dry_run, after: true,
    });
    if (current.live_execution !== false) changes.push({
      key: "composio.live_execution", before: current.live_execution, after: false,
    });
  }
  return changes;
}

function requestPayloadDigest(patch: SettingsWritePatch): string {
  return operationPlanDigest({ schema_version: "blue-tanuki.settings-write-request.v1", patch });
}

function requireDigest(value: string | undefined, field: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`settings_write_${field.replaceAll(" ", "_")}_digest_required`);
  return value;
}
