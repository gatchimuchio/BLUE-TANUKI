import {
  llmSettingsWriteEnvPatch,
  SETTINGS_WRITE_ACTIVATION_DESTINATIONS,
  SettingsWriteArgumentsSchema,
  type SettingsWriteLlmProvider,
  type SettingsWritePatch,
} from "@blue-tanuki/protocol";
import { parseComputeBudgetPolicy } from "./compute_budget_store.js";
import { assessLlmComputeReadiness } from "./control_center/setup/api_settings.js";
import { validateLLMFallbackProfilesJson } from "./llm_config.js";
import { llmApiKeyForProvider, llmSecretStorageStatus, secretRefKey } from "./secret_store.js";

type Env = NodeJS.ProcessEnv;

const COST_PROFILES_KEY = "BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON";
const COMPUTE_BUDGET_KEY = "BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON";
const ACTIVATION_ENV_KEY = /^(?:LLM_|ANTHROPIC_|OPENAI_|OPENROUTER_|BLUE_TANUKI_LLM_|BLUE_TANUKI_(?:COMPUTE_BUDGET_POLICY_JSON|SECRET_DIR)$)/u;
const ENDPOINT_KEYS = {
  anthropic: ["ANTHROPIC_ENDPOINT"],
  openai: ["OPENAI_COMPAT_ENDPOINT", "OPENAI_ENDPOINT", "LLM_ENDPOINT"],
  openrouter: ["OPENROUTER_ENDPOINT"],
} as const;

export function prepareLlmProviderActivation(
  patch: NonNullable<SettingsWritePatch["llm"]>,
  currentProvider: SettingsWriteLlmProvider,
  fileEnv: Env,
  configuredEnv: Env,
  inheritedEnvKeys: readonly string[],
): Record<string, string> {
  const args = SettingsWriteArgumentsSchema.parse({ patch: { llm: patch }, expected_llm_provider: currentProvider });
  const activation = args.patch.llm?.activation;
  if (!activation) throw new Error("llm_activation_invalid");
  // Windows resolves process environment names case-insensitively. Observe the same names the next startup will use.
  if (Object.keys(fileEnv).some((key) => key !== key.toUpperCase() && ACTIVATION_ENV_KEY.test(key.toUpperCase()))) {
    throw new Error("llm_activation_ambiguous_environment_names");
  }

  const provider = activation.provider;
  const destination = SETTINGS_WRITE_ACTIVATION_DESTINATIONS[provider];
  const credentialKey = llmApiKeyForProvider(provider);
  if (!credentialKey) throw new Error("llm_activation_unsupported_provider");
  const referenceKey = secretRefKey(credentialKey);
  const reference = fileEnv[referenceKey];
  const inherited = new Set(inheritedEnvKeys.map((key) => key.toUpperCase()));
  if ([credentialKey, referenceKey, COST_PROFILES_KEY, COMPUTE_BUDGET_KEY, ...ENDPOINT_KEYS[provider]].some((key) => inherited.has(key)) ||
      ENDPOINT_KEYS[provider].some((key) => configuredEnv[key]?.trim() && configuredEnv[key]?.trim() !== destination)) {
    throw new Error("llm_activation_protected_route_unavailable");
  }
  if (activation.register_credential) {
    if (configuredEnv[credentialKey] !== undefined || configuredEnv[referenceKey] !== undefined ||
        configuredEnv.BLUE_TANUKI_SECRET_DIR !== undefined || inherited.has("BLUE_TANUKI_SECRET_DIR")) {
      throw new Error("llm_credential_registration_target_unavailable");
    }
  } else if (!reference || configuredEnv[referenceKey] !== reference || !llmSecretStorageStatus(configuredEnv, provider).os_protected) {
    throw new Error("llm_activation_protected_route_unavailable");
  }
  const unsupportedOverrides = provider === "openai"
    ? ["OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_API_KEY_REF", "LLM_API_KEY", "LLM_API_KEY_REF", "OPENAI_COMPAT_MODEL",
      "OPENAI_COMPAT_HEADERS_JSON", "LLM_HEADERS_JSON"]
    : provider === "openrouter" ? ["OPENROUTER_SITE_URL", "OPENROUTER_APP_TITLE"] : [];
  if (unsupportedOverrides.some((key) => configuredEnv[key]?.trim() || inherited.has(key))) {
    throw new Error("llm_activation_conflicting_route_overrides");
  }

  const policy = parseComputeBudgetPolicy(configuredEnv[COMPUTE_BUDGET_KEY]);
  if (policy.currency !== activation.currency) throw new Error("llm_activation_budget_currency_mismatch");
  const maxCost = { amount: activation.max_cost_per_24h_micros / 1_000_000, currency: activation.currency };
  const attemptCost = { amount: activation.max_cost_per_attempt_micros / 1_000_000, currency: activation.currency };
  const budget = { ...policy, system: { ...policy.system, max_cost: maxCost },
    parent: { ...policy.parent, max_cost: maxCost }, task: { ...policy.task, max_cost: maxCost } };

  const profilesJson = configuredEnv[COST_PROFILES_KEY];
  validateLLMFallbackProfilesJson(profilesJson);
  const profiles = profilesJson ? JSON.parse(profilesJson) as Record<string, unknown> : {};
  const canonicalProvider = provider === "openai" ? "openai-compatible" : provider;
  const existingKeys = Object.keys(profiles);
  if (existingKeys.some((key) => {
    const normalized = key.trim().toLowerCase();
    return key !== canonicalProvider && (normalized === canonicalProvider || normalized === provider ||
      (provider === "anthropic" && normalized === "claude"));
  })) throw new Error("llm_activation_ambiguous_cost_profile");
  const selectedProfile = profiles[canonicalProvider] as { capabilities?: unknown[] } | undefined;
  if (selectedProfile?.capabilities?.some((capability) => capability !== "llm.text.generate")) {
    throw new Error("llm_activation_existing_capability_scope_unavailable");
  }
  profiles[canonicalProvider] = { capabilities: ["llm.text.generate"], max_cost_per_attempt: attemptCost };
  const updates = { ...llmSettingsWriteEnvPatch(patch, provider), LLM_BACKEND: provider,
    [COST_PROFILES_KEY]: JSON.stringify(profiles), [COMPUTE_BUDGET_KEY]: JSON.stringify(budget) };
  // Only the configuration-only pricing check assumes a future credential. The reference is created after L3.
  const readiness = assessLlmComputeReadiness({ ...configuredEnv, ...updates,
    ...(activation.register_credential ? { [referenceKey]: "configured-after-native-registration" } : {}) });
  if (readiness.status !== "ready" || readiness.currency !== activation.currency ||
      readiness.maximum_provider_attempts !== 1 || readiness.max_cost_amount !== attemptCost.amount ||
      readiness.max_tokens !== patch.max_tokens || readiness.max_compute_ms !== patch.timeout_ms) {
    throw new Error("llm_activation_budget_cannot_admit_request");
  }
  return updates;
}
