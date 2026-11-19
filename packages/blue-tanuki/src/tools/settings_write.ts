import {
  SETTINGS_WRITE_ACTIVATION_DESTINATIONS,
  SettingsWriteArgumentsSchema,
  SettingsWriteTargetVersionObservationSchema,
  requireToolOperationDescriptor,
  settingsWriteRequestBinding,
  settingsWriteTargetIdentityDigest,
  type SettingsWriteActivation,
  type SettingsWriteArguments,
  type SettingsWriteLlmProvider,
  type SettingsWritePatch,
  type SettingsWriteTargetVersionObservation,
} from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { assertToolExecutionNotCancelled, type SettingsWriteContentReview, type Tool } from "./registry.js";

export interface SettingsWritePort {
  inspect(expectedLlmProvider?: SettingsWriteLlmProvider,
    activationPatch?: NonNullable<SettingsWritePatch["llm"]>): Promise<{
    target_state_digest: string;
    llm_provider?: SettingsWriteLlmProvider;
    managed_llm_settings?: boolean;
    provider_activation_ready?: true;
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
  apply(patch: SettingsWritePatch, expected_target_state_digest: string, expectedLlmProvider?: SettingsWriteLlmProvider,
    credentialRegistration?: { command_digest: string; signal?: AbortSignal; assert_current: () => void }): Promise<{
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
      const args = parseArgs(rawArgs);
      const commandDigest = requireDigest(options.command_digest, "command");
      const planDigest = requireDigest(options.operation_plan_binding_digest, "operation plan");
      const target = await inspectBoundTarget(port, args);
      return SettingsWriteTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.settings-write-target-version.v1",
        target_identity_digest: settingsWriteTargetIdentityDigest(),
        target_state_digest: requireDigest(target.target_state_digest, "target state"),
        request_payload_digest: operationPlanDigest(settingsWriteRequestBinding(args)),
        command_digest: commandDigest,
        operation_plan_binding_digest: planDigest,
        used_for_authority: false,
        may_execute: false,
      });
    },
    async inspect_content_review(rawArgs, options = {}): Promise<SettingsWriteContentReview> {
      const args = parseArgs(rawArgs);
      const { patch, expected_llm_provider } = args;
      const observation = SettingsWriteTargetVersionObservationSchema.parse(
        await tool.inspect_target_version!(rawArgs, options),
      );
      const commandDigest = requireDigest(options.command_digest, "command");
      const planDigest = requireDigest(options.operation_plan_binding_digest, "operation plan");
      const target = await inspectBoundTarget(port, args);
      if (target.target_state_digest !== observation.target_state_digest) {
        throw new Error("settings_write_target_changed_during_review");
      }
      const changes = patch.llm
        ? buildLlmChanges(patch.llm, target)
        : buildComposioChanges(patch.composio!, target.values.composio);
      if (changes.length === 0) throw new Error("settings_write_patch_has_no_effect");
      const reviewBase = {
        kind: "settings_write" as const,
        operation: "settings.write" as const,
        ...(expected_llm_provider !== undefined ? { expected_llm_provider } : {}),
        ...(patch.llm?.activation ? { activation: settingsWriteActivationReview(patch.llm.activation) } : {}),
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
      const args = parseArgs(rawArgs);
      const observation = SettingsWriteTargetVersionObservationSchema.parse(context.target_version_observation);
      if (observation.target_identity_digest !== settingsWriteTargetIdentityDigest() ||
          observation.command_digest !== context.operation_plan_command_digest ||
          observation.request_payload_digest !== operationPlanDigest(settingsWriteRequestBinding(args)) ||
          !context.operation_plan_command_digest || !context.upstream_commit_hash) {
        throw new Error("settings_write_approved_target_mismatch");
      }
      assertToolExecutionNotCancelled(context.signal, "settings.write");
      if (args.patch.llm?.activation?.register_credential) {
        if (!context.assert_current_settings_write) throw new Error("llm_credential_registration_not_authorized");
        return port.apply(args.patch, observation.target_state_digest, args.expected_llm_provider, {
          command_digest: context.operation_plan_command_digest,
          assert_current: context.assert_current_settings_write,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      }
      return port.apply(args.patch, observation.target_state_digest, args.expected_llm_provider);
    },
  };
  BUILTIN_SETTINGS_WRITE_TOOLS.add(tool);
  return tool;
}

export function isSettingsWriteTool(tool: Tool | undefined): boolean {
  return !!tool && BUILTIN_SETTINGS_WRITE_TOOLS.has(tool);
}

function parseArgs(value: Record<string, unknown>): SettingsWriteArguments {
  const parsed = SettingsWriteArgumentsSchema.safeParse(value);
  if (!parsed.success) throw new Error("settings_write_arguments_invalid");
  return parsed.data;
}

export function settingsWriteActivationReview(activation: SettingsWriteActivation):
  NonNullable<SettingsWriteContentReview["activation"]> {
  const { register_credential, ...approvedConfiguration } = activation;
  return {
    ...approvedConfiguration,
    destination: SETTINGS_WRITE_ACTIVATION_DESTINATIONS[activation.provider],
    ...(register_credential ? { protected_reference_configured: false, credential_registration_required: true }
      : { protected_reference_configured: true }),
  };
}

async function inspectBoundTarget(port: SettingsWritePort, args: SettingsWriteArguments) {
  const expectedProvider = args.expected_llm_provider;
  const activationPatch = args.patch.llm?.activation ? args.patch.llm : undefined;
  const target = await port.inspect(expectedProvider, activationPatch);
  if (expectedProvider !== undefined &&
      (target.llm_provider !== expectedProvider || target.managed_llm_settings !== true)) {
    throw new Error("settings_write_bound_llm_target_unavailable");
  }
  if (activationPatch && target.provider_activation_ready !== true) {
    throw new Error("settings_write_provider_activation_unavailable");
  }
  return target;
}

function buildLlmChanges(patch: NonNullable<SettingsWritePatch["llm"]>,
  target: Awaited<ReturnType<SettingsWritePort["inspect"]>>): SettingsWriteContentReview["changes"] {
  const changes: SettingsWriteContentReview["changes"][number][] = [];
  if (patch.activation) {
    changes.push({ key: "llm.provider", before: target.llm_provider ?? null, after: patch.activation.provider });
  }
  for (const field of Object.keys(PATCH_FIELDS) as Array<keyof typeof PATCH_FIELDS>) {
    const after = patch[field];
    if (after === undefined) continue;
    const before = target.values[field];
    if (before !== after || patch.activation) changes.push({ key: PATCH_FIELDS[field], before, after });
  }
  return changes;
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

function requireDigest(value: string | undefined, field: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`settings_write_${field.replaceAll(" ", "_")}_digest_required`);
  return value;
}
