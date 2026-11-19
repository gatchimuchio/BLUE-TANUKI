import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ModelSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)
  .refine((value) => !/^(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})$/iu.test(value),
    "credential-like values are not model identifiers");

export const SettingsWritePatchSchema = z.object({
  llm: z.object({
    model: ModelSchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_048_576).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
  }).strict().refine((llm) => Object.keys(llm).length > 0, "at least one supported LLM setting is required").optional(),
  composio: z.object({
    user_id: z.string().trim().min(1).max(512).nullable().optional(),
    allowed_toolkits: z.string().trim().max(4_096).nullable().optional(),
    allowed_actions: z.string().trim().max(8_192).nullable().optional(),
    revoked_actions: z.string().trim().max(8_192).nullable().optional(),
    api_base_url: z.string().trim().min(1).max(2_048).refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    }, "Composio API base URL must be credentialless HTTPS without query or fragment").nullable().optional(),
    dry_run: z.boolean().optional(),
    live_execution: z.boolean().optional(),
    clear_api_key: z.literal(true).optional(),
  }).strict().refine((composio) => Object.keys(composio).length > 0, "at least one supported Composio setting is required")
    .refine((composio) => composio.clear_api_key !== true ||
      (composio.dry_run === undefined && composio.live_execution === undefined),
    "disconnect resets dry_run and live_execution and cannot be combined with explicit values").optional(),
}).strict().refine((patch) => Number(patch.llm !== undefined) + Number(patch.composio !== undefined) === 1,
  "exactly one settings domain must be changed per request");

export const SettingsWriteLlmProviderSchema = z.enum(["stub", "anthropic", "openai", "openai-compatible", "openrouter"]);

export const SettingsWriteArgumentsSchema = z.object({
  patch: SettingsWritePatchSchema,
  expected_llm_provider: SettingsWriteLlmProviderSchema.optional(),
}).strict().refine(({ patch, expected_llm_provider }) => expected_llm_provider === undefined || patch.llm !== undefined,
  "a provider expectation applies only to the LLM domain");

/** Non-authority target evidence for one explicitly selected Gateway settings patch. */
export const SettingsWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.settings-write-target-version.v1"),
  target_identity_digest: DigestSchema,
  target_state_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type SettingsWritePatch = z.infer<typeof SettingsWritePatchSchema>;
export type SettingsWriteArguments = z.infer<typeof SettingsWriteArgumentsSchema>;
export type SettingsWriteLlmProvider = z.infer<typeof SettingsWriteLlmProviderSchema>;
export type SettingsWriteTargetVersionObservation =
  z.infer<typeof SettingsWriteTargetVersionObservationSchema>;

export function settingsWriteTargetIdentityDigest(): string {
  return createHash("sha256").update("blue-tanuki.gateway-settings-target.v1", "utf8").digest("hex");
}

export function settingsWriteRequestBinding(args: SettingsWriteArguments) {
  return { schema_version: "blue-tanuki.settings-write-request.v1", patch: args.patch,
    ...(args.expected_llm_provider !== undefined ? { expected_llm_provider: args.expected_llm_provider } : {}) };
}

const providerModelKey: Record<SettingsWriteLlmProvider, string> = {
  stub: "LLM_MODEL",
  anthropic: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
  "openai-compatible": "OPENAI_COMPAT_MODEL",
  openrouter: "OPENROUTER_MODEL",
};

export function llmSettingsWriteEnvPatch(patch: NonNullable<SettingsWritePatch["llm"]>,
  provider: SettingsWriteLlmProvider, bindCommandModel = true): Record<string, string> {
  const updates: Record<string, string> = {};
  if (patch.model !== undefined) {
    updates.LLM_MODEL = patch.model;
    updates[providerModelKey[provider]] = patch.model;
    if (bindCommandModel) updates.BLUE_TANUKI_LLM_MODEL = patch.model;
  }
  if (patch.temperature !== undefined) updates.BLUE_TANUKI_LLM_TEMPERATURE = String(patch.temperature);
  if (patch.max_tokens !== undefined) updates.BLUE_TANUKI_LLM_MAX_TOKENS = String(patch.max_tokens);
  if (patch.timeout_ms !== undefined) updates.BLUE_TANUKI_LLM_TIMEOUT_MS = String(patch.timeout_ms);
  return updates;
}
