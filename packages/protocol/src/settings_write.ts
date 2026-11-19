import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ModelSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)
  .refine((value) => !/^(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})$/iu.test(value),
    "credential-like values are not model identifiers");

export const SETTINGS_WRITE_ACTIVATION_DESTINATIONS = Object.freeze({
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
} as const);

export const SETTINGS_WRITE_NATIVE_CREDENTIAL_ENTRY_WINDOW_MS = 120_000;
export const SETTINGS_WRITE_NATIVE_CREDENTIAL_OPERATION_TIMEOUT_MS = 150_000;
export const SETTINGS_WRITE_CREDENTIAL_ROTATION_CHANGE = Object.freeze({
  key: "llm.credential_reference", before: "protected", after: "replace_on_restart",
} as const);
export const SETTINGS_WRITE_GOOGLE_READ_CREDENTIAL_CHANGE = Object.freeze({
  key: "google_read.credential_reference", before: "unconfigured", after: "register_on_restart",
} as const);
export const SETTINGS_WRITE_GITHUB_WRITE_CREDENTIAL_CHANGE = Object.freeze({
  key: "github_write.credential_reference", before: "unconfigured", after: "register_on_restart",
} as const);
export const SETTINGS_WRITE_GITHUB_WRITE_CREDENTIAL_REVIEW = Object.freeze({
  api_host: "api.github.com", protected_reference_configured: false,
} as const);
export const SETTINGS_WRITE_TELEGRAM_BOT_CREDENTIAL_CHANGE = Object.freeze({
  key: "telegram.credential_reference", before: "unconfigured", after: "register_on_restart",
} as const);
export const SETTINGS_WRITE_TELEGRAM_BOT_CREDENTIAL_REVIEW = Object.freeze({
  api_host: "api.telegram.org", protected_reference_configured: false,
} as const);
export const SettingsWriteGoogleReadCredentialScopeSchema = z.enum(["gmail", "calendar", "drive", "shared"]);
export type SettingsWriteGoogleReadCredentialScope = z.infer<typeof SettingsWriteGoogleReadCredentialScopeSchema>;
export const SETTINGS_WRITE_GOOGLE_READ_CREDENTIAL_TARGETS = Object.freeze({
  gmail: { key: "GMAIL_ACCESS_TOKEN", api_hosts: ["gmail.googleapis.com"] },
  calendar: { key: "GOOGLE_CALENDAR_ACCESS_TOKEN", api_hosts: ["www.googleapis.com"] },
  drive: { key: "GOOGLE_DRIVE_ACCESS_TOKEN", api_hosts: ["www.googleapis.com"] },
  shared: { key: "GOOGLE_ACCESS_TOKEN", api_hosts: ["gmail.googleapis.com", "www.googleapis.com"] },
} as const);

const ActivationCostMicrosSchema = z.number().int().min(1).max(1_000_000_000);
export const SettingsWriteNativeLlmProviderSchema = z.enum(["anthropic", "openai", "openrouter"]);

export const SettingsWriteActivationSchema = z.object({
  provider: SettingsWriteNativeLlmProviderSchema,
  currency: z.literal("USD"),
  max_cost_per_attempt_micros: ActivationCostMicrosSchema,
  max_cost_per_24h_micros: ActivationCostMicrosSchema,
  register_credential: z.literal(true).optional(),
}).strict().refine((activation) => activation.max_cost_per_attempt_micros <= activation.max_cost_per_24h_micros,
  "per-attempt cost must not exceed the 24-hour budget");

export const SettingsWritePatchSchema = z.object({
  llm: z.object({
    model: ModelSchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_048_576).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
    activation: SettingsWriteActivationSchema.optional(),
    rotate_credential: z.literal(true).optional(),
  }).strict().refine((llm) => Object.keys(llm).length > 0, "at least one supported LLM setting is required")
    .refine((llm) => llm.activation === undefined ||
      (llm.model !== undefined && llm.max_tokens !== undefined && llm.timeout_ms !== undefined),
    "provider activation requires a model, token limit, and timeout")
    .refine((llm) => llm.rotate_credential !== true || Object.keys(llm).length === 1,
      "credential rotation must be the only change in the patch").optional(),
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
  google_read: z.object({ register_credential: SettingsWriteGoogleReadCredentialScopeSchema }).strict().optional(),
  github_write: z.object({ register_credential: z.literal(true) }).strict().optional(),
  telegram: z.object({ register_credential: z.literal(true) }).strict().optional(),
}).strict().refine((patch) => Number(patch.llm !== undefined) + Number(patch.composio !== undefined) +
  Number(patch.google_read !== undefined) + Number(patch.github_write !== undefined) + Number(patch.telegram !== undefined) === 1,
  "exactly one settings domain must be changed per request");

export const SettingsWriteLlmProviderSchema = z.enum(["stub", "anthropic", "openai", "openai-compatible", "openrouter"]);

export const SettingsWriteArgumentsSchema = z.object({
  patch: SettingsWritePatchSchema,
  expected_llm_provider: SettingsWriteLlmProviderSchema.optional(),
}).strict().refine(({ patch, expected_llm_provider }) => expected_llm_provider === undefined || patch.llm !== undefined,
  "a provider expectation applies only to the LLM domain")
  .refine(({ patch, expected_llm_provider }) => patch.llm?.activation === undefined ||
    (expected_llm_provider !== undefined && expected_llm_provider !== patch.llm.activation.provider),
  "provider activation requires the current provider to differ from the selected provider")
  .refine(({ patch, expected_llm_provider }) => patch.llm?.rotate_credential !== true ||
    SettingsWriteNativeLlmProviderSchema.safeParse(expected_llm_provider).success,
  "credential rotation requires the expected native provider");

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
export type SettingsWriteActivation = z.infer<typeof SettingsWriteActivationSchema>;
export type SettingsWriteLlmProvider = z.infer<typeof SettingsWriteLlmProviderSchema>;
export type SettingsWriteNativeLlmProvider = z.infer<typeof SettingsWriteNativeLlmProviderSchema>;
export type SettingsWriteCredentialRotationReview = ReturnType<typeof settingsWriteCredentialRotationReview>;
export type SettingsWriteGoogleReadCredentialReview = ReturnType<typeof settingsWriteGoogleReadCredentialReview>;
export type SettingsWriteGitHubWriteCredentialReview = typeof SETTINGS_WRITE_GITHUB_WRITE_CREDENTIAL_REVIEW;
export type SettingsWriteTelegramBotCredentialReview = typeof SETTINGS_WRITE_TELEGRAM_BOT_CREDENTIAL_REVIEW;
export type SettingsWriteTargetVersionObservation =
  z.infer<typeof SettingsWriteTargetVersionObservationSchema>;

export function settingsWriteRequiresNativeCredentialEntry(patch: SettingsWritePatch): boolean {
  return patch.llm?.activation?.register_credential === true || patch.llm?.rotate_credential === true ||
    patch.google_read !== undefined || patch.github_write !== undefined || patch.telegram !== undefined;
}

export function settingsWriteCredentialRotationReview(provider: SettingsWriteNativeLlmProvider) {
  return { provider, destination: SETTINGS_WRITE_ACTIVATION_DESTINATIONS[provider], protected_reference_configured: true as const };
}

export function settingsWriteGoogleReadCredentialReview(scope: SettingsWriteGoogleReadCredentialScope) {
  return { scope, api_hosts: SETTINGS_WRITE_GOOGLE_READ_CREDENTIAL_TARGETS[scope].api_hosts,
    protected_reference_configured: false as const };
}

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

export function llmSettingsWriteEnvKeys(patch: NonNullable<SettingsWritePatch["llm"]>,
  currentProvider: SettingsWriteLlmProvider): string[] {
  if (patch.rotate_credential) return [`${SettingsWriteNativeLlmProviderSchema.parse(currentProvider).toUpperCase()}_API_KEY_REF`];
  const keys = Object.keys(llmSettingsWriteEnvPatch(patch, patch.activation?.provider ?? currentProvider));
  if (patch.activation) {
    keys.push("LLM_BACKEND", "BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON", "BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON");
    if (patch.activation.register_credential) keys.push(`${patch.activation.provider.toUpperCase()}_API_KEY_REF`);
  }
  return keys.sort();
}
