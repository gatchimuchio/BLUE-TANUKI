import { createHash } from "node:crypto";
import {
  AnthropicBackend,
  LLMRegistry,
  OpenAICompatibleBackend,
  SYNTHETIC_FILE_WRITE_PLAN_BACKEND,
  SyntheticFileWritePlanBackend,
  StubBackend,
  type LLMBackend,
  type LLMFallbackProfile,
  type LLMProviderCredentialAction,
  type LLMProviderCredentialResolver,
  type LLMRetryPolicy,
} from "@blue-tanuki/core";
import type { LLMCommandRoute } from "@blue-tanuki/hds-brain";
import { LLMFallbackAuthorizationSchema, SETTINGS_WRITE_ACTIVATION_DESTINATIONS, type InboundRequest } from "@blue-tanuki/protocol";
import {
  hasLLMSecretMaterial,
  LLM_SECRET_KEYS,
  resolveSecretMaterial,
  secretRefKey,
  validateLLMSecretReferences,
  type LlmSecretKey,
} from "./secret_store.js";

type Env = Record<string, string | undefined>;

interface ProviderSpec {
  name: string;
  type: "openai-compatible";
  endpoint: string;
  model: string;
  apiKey?: string;
  credentialKey?: LlmSecretKey;
  headers: Record<string, string>;
  aliases: string[];
}

function envValue(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function headersFromObject(
  parsed: Record<string, unknown>,
  label: string,
): Record<string, string> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      headers[key] = String(value);
    } else {
      throw new Error(`${label}.${key} must be string/number/boolean`);
    }
  }
  return headers;
}

function parseHeadersJson(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return headersFromObject(parsed, "LLM headers JSON");
}

function parseFallbackProfilesJson(raw: string | undefined): Array<[string, LLMFallbackProfile]> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON must be a provider object");
  }
  return Object.entries(parsed as Record<string, unknown>)
    .map(([provider, profile]) => [provider, profile as LLMFallbackProfile]);
}

/** Validate the owner-supplied per-provider reservation bounds without making a provider call. */
export function validateLLMFallbackProfilesJson(raw: string | undefined): void {
  for (const [provider, profile] of parseFallbackProfilesJson(raw)) {
    if (!provider.trim() || !isValidConfiguredFallbackProfile(profile)) {
      throw new Error("BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON has an invalid provider cost profile");
    }
  }
}

function isValidConfiguredFallbackProfile(profile: unknown): profile is LLMFallbackProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
      Object.getPrototypeOf(profile) !== Object.prototype) return false;
  const value = profile as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "capabilities,max_cost_per_attempt") return false;
  const capabilities = value.capabilities;
  const cost = value.max_cost_per_attempt;
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 16 ||
      capabilities.some((item) => typeof item !== "string" || !item.trim() || item.length > 120) ||
      new Set(capabilities).size !== capabilities.length || !cost || typeof cost !== "object" ||
      Array.isArray(cost) || Object.getPrototypeOf(cost) !== Object.prototype) return false;
  const bound = cost as Record<string, unknown>;
  return Object.keys(bound).sort().join(",") === "amount,currency" &&
    typeof bound.amount === "number" && Number.isFinite(bound.amount) && bound.amount >= 0 &&
    typeof bound.currency === "string" && /^[A-Z]{3}$/.test(bound.currency);
}

function parseModelCapabilitiesJson(raw: string | undefined, variableName: string): Map<string, string[]> {
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${variableName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${variableName} must be a provider object`);
  }
  const models = new Map<string, string[]>();
  for (const [providerName, providerModels] of Object.entries(parsed as Record<string, unknown>)) {
    const provider = providerName.trim().toLowerCase();
    if (!provider || !Array.isArray(providerModels) || providerModels.length === 0 || providerModels.length > 64 ||
        providerModels.some((model) => typeof model !== "string" || !model.trim() || model.length > 200) ||
        new Set(providerModels).size !== providerModels.length) {
      throw new Error(`${variableName} has an invalid provider model list`);
    }
    if (models.has(provider)) throw new Error(`${variableName} provider names must be unique`);
    models.set(provider, providerModels.map((model) => (model as string).trim()));
  }
  return models;
}

function parseImageCapableModelsJson(raw: string | undefined): Map<string, string[]> {
  return parseModelCapabilitiesJson(raw, "BLUE_TANUKI_LLM_IMAGE_CAPABLE_MODELS_JSON");
}

function parseAudioTranscriptionCapableModelsJson(raw: string | undefined): Map<string, string[]> {
  return parseModelCapabilitiesJson(raw, "BLUE_TANUKI_LLM_AUDIO_TRANSCRIPTION_CAPABLE_MODELS_JSON");
}

function parseAudioTaskCapableModelsJson(raw: string | undefined): Map<string, string[]> {
  return parseModelCapabilitiesJson(raw, "BLUE_TANUKI_LLM_AUDIO_TASK_CAPABLE_MODELS_JSON");
}

function parseFallbackAuthorizationJson(raw: string | undefined): LLMCommandRoute["fallback_authorization"] {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("BLUE_TANUKI_LLM_FALLBACK_AUTHORIZATION_JSON must be valid JSON");
  }
  const result = LLMFallbackAuthorizationSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("BLUE_TANUKI_LLM_FALLBACK_AUTHORIZATION_JSON has an invalid shape");
  }
  return result.data;
}

function parseProvidersJson(raw: string | undefined, env: Env, configurationOnly = false): ProviderSpec[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const rows =
    Array.isArray(parsed)
      ? parsed
      : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { providers?: unknown }).providers)
      ? (parsed as { providers: unknown[] }).providers
      : undefined;
  if (!rows) {
    throw new Error("LLM_PROVIDERS_JSON must be an array or { providers: [...] }");
  }
  return rows.map((row, index): ProviderSpec => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`LLM_PROVIDERS_JSON[${index}] must be an object`);
    }
    const obj = row as Record<string, unknown>;
    const name = stringOrUndefined(obj.name);
    if (!name) {
      throw new Error(`LLM_PROVIDERS_JSON[${index}].name is required`);
    }
    const type = stringOrUndefined(obj.type) ?? "openai-compatible";
    if (type !== "openai-compatible") {
      throw new Error(
        `LLM_PROVIDERS_JSON[${index}].type '${type}' is not supported`,
      );
    }
    const endpoint = stringOrUndefined(obj.endpoint);
    if (!endpoint) {
      throw new Error(`LLM_PROVIDERS_JSON[${index}].endpoint is required`);
    }
    const model = stringOrUndefined(obj.model);
    if (!model) {
      throw new Error(`LLM_PROVIDERS_JSON[${index}].model is required`);
    }
    const apiKeyEnv = stringOrUndefined(obj.api_key_env);
    const inlineApiKey = stringOrUndefined(obj.api_key);
    const credentialKey = !inlineApiKey && apiKeyEnv
      ? LLM_SECRET_KEYS.find((key) => apiKeyEnv === key || apiKeyEnv === secretRefKey(key))
      : undefined;
    const apiKey = configurationOnly ? undefined :
      (inlineApiKey ?? (credentialKey ? undefined : (apiKeyEnv ? envValue(env, apiKeyEnv) : undefined)));
    const headersEnv = stringOrUndefined(obj.headers_env);
    const headersFromEnv = headersEnv
      ? parseHeadersJson(envValue(env, headersEnv))
      : {};
    const inlineHeaders =
      obj.headers === undefined
        ? {}
        : headersFromObject(
            obj.headers as Record<string, unknown>,
            `LLM_PROVIDERS_JSON[${index}].headers`,
          );
    return {
      name,
      type,
      endpoint,
      model,
      apiKey,
      credentialKey,
      headers: configurationOnly ? {} : { ...headersFromEnv, ...inlineHeaders },
      aliases: stringArray(obj.aliases, `LLM_PROVIDERS_JSON[${index}].aliases`),
    };
  });
}

function wantsBackend(env: Env, name: string): boolean {
  return (envValue(env, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub")
    .trim()
    .toLowerCase() === name;
}

function credentialResolverFor(
  env: Env,
  key: LlmSecretKey,
  provider: string,
  configuredEndpoint: string,
  allowedActions: readonly LLMProviderCredentialAction[],
): LLMProviderCredentialResolver | undefined {
  if (!hasLLMSecretMaterial(env, key)) return undefined;
  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(configuredEndpoint).origin;
  } catch {
    return undefined;
  }
  const acceptedActions = new Set(allowedActions);
  return (use) => {
    if (use.provider !== provider || !acceptedActions.has(use.action)) return undefined;
    let requestedOrigin: string;
    try {
      requestedOrigin = new URL(use.endpoint).origin;
    } catch {
      return undefined;
    }
    if (requestedOrigin !== configuredOrigin) return undefined;
    const direct = env[key];
    if (direct) return direct;
    const reference = env[secretRefKey(key)];
    if (!reference) return undefined;
    const requireDpapiKeyMatch = key === "OPENAI_API_KEY" &&
      configuredEndpoint === SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai;
    return resolveSecretMaterial({ [secretRefKey(key)]: reference }, key,
      requireDpapiKeyMatch ? { require_dpapi_key_match: true } : {});
  };
}

function parsePositiveIntEnv(
  env: Env,
  name: string,
): number | undefined {
  const raw = envValue(env, name);
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function buildLLMRetryPolicyFromEnv(env: Env): LLMRetryPolicy {
  return {
    max_attempts: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_RETRY_ATTEMPTS") ?? 1,
    base_delay_ms: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_RETRY_BASE_MS") ?? 250,
    max_delay_ms: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_RETRY_MAX_MS") ?? 2_000,
  };
}

function parseTemperatureEnv(env: Env): number | undefined {
  const raw = envValue(env, "BLUE_TANUKI_LLM_TEMPERATURE");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("BLUE_TANUKI_LLM_TEMPERATURE must be between 0 and 2");
  }
  return value;
}

export function buildLLMBackendFromEnv(env: Env = process.env): LLMBackend {
  validateLLMSecretReferences(env);
  const configEnv = { ...env };
  for (const key of LLM_SECRET_KEYS) {
    configEnv[key] = hasLLMSecretMaterial(env, key) ? "configured-credential-placeholder" : undefined;
  }
  return buildLLMRegistry(configEnv, false, env);
}

/** Non-callable cost and routing projection. OS secret references are never opened. */
export function inspectLLMRegistryConfiguration(env: Env): {
  provider: string;
  model: string;
  maximumCostForCall: LLMRegistry["maximumCostForCall"];
  maximumCallsForRequest: LLMRegistry["maximumCallsForRequest"];
} {
  const configEnv = { ...env };
  for (const key of LLM_SECRET_KEYS) {
    configEnv[key] = hasLLMSecretMaterial(env, key) ? "configured-credential-placeholder" : undefined;
  }
  const registry = buildLLMRegistry(configEnv, true);
  const route = buildLLMCommandRouteFromEnv(env);
  const identity = registry.resolveRequestIdentity(route.backend_hint, route.model);
  if (!identity.model) throw new Error("LLMRegistry: selected backend does not expose an effective model identity");
  return {
    provider: identity.provider,
    model: identity.model,
    maximumCostForCall: registry.maximumCostForCall.bind(registry),
    maximumCallsForRequest: registry.maximumCallsForRequest.bind(registry),
  };
}

function buildLLMRegistry(
  resolvedEnv: Env,
  configurationOnly = false,
  credentialEnv: Env = resolvedEnv,
): LLMRegistry {
  const imageCapableModels = parseImageCapableModelsJson(
    envValue(resolvedEnv, "BLUE_TANUKI_LLM_IMAGE_CAPABLE_MODELS_JSON"),
  );
  const audioTranscriptionCapableModels = parseAudioTranscriptionCapableModelsJson(
    envValue(resolvedEnv, "BLUE_TANUKI_LLM_AUDIO_TRANSCRIPTION_CAPABLE_MODELS_JSON"),
  );
  const audioTaskCapableModels = parseAudioTaskCapableModelsJson(
    envValue(resolvedEnv, "BLUE_TANUKI_LLM_AUDIO_TASK_CAPABLE_MODELS_JSON"),
  );
  const imageModelsFor = (provider: string): readonly string[] => imageCapableModels.get(provider) ?? [];
  const audioModelsFor = (provider: string): readonly string[] => audioTranscriptionCapableModels.get(provider) ?? [];
  const audioTaskModelsFor = (provider: string): readonly string[] => audioTaskCapableModels.get(provider) ?? [];
  const registry = new LLMRegistry({
    retry: buildLLMRetryPolicyFromEnv(resolvedEnv),
  });
  registry.register(new StubBackend(), [], {
    capabilities: ["llm.text.generate"],
    max_cost_per_attempt: {
      amount: 0,
      currency: "USD",
    },
  });

  const syntheticPlanOptIn = resolvedEnv.BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND === "true";
  if (syntheticPlanOptIn &&
      (resolvedEnv.NODE_ENV === "production" || process.env.NODE_ENV === "production")) {
    throw new Error("Synthetic plan backend is development-only and cannot be enabled in production");
  }
  if (syntheticPlanOptIn) {
    registry.register(new SyntheticFileWritePlanBackend(resolvedEnv), [], {
      capabilities: ["llm.text.generate"],
      max_cost_per_attempt: { amount: 0, currency: "USD" },
    });
  }

  const anthropicKey = envValue(resolvedEnv, "ANTHROPIC_API_KEY");
  const anthropicEndpoint = envValue(resolvedEnv, "ANTHROPIC_ENDPOINT") ??
    SETTINGS_WRITE_ACTIVATION_DESTINATIONS.anthropic;
  const anthropicCredentialResolver = credentialResolverFor(
    credentialEnv,
    "ANTHROPIC_API_KEY",
    "anthropic",
    anthropicEndpoint,
    ["llm.text.generate"],
  );
  if (
    anthropicKey ||
    wantsBackend(resolvedEnv, "anthropic") ||
    wantsBackend(resolvedEnv, "claude")
  ) {
    registry.register(
      new AnthropicBackend(
        anthropicKey ?? "",
        envValue(resolvedEnv, "ANTHROPIC_MODEL", "LLM_MODEL") ??
          "claude-opus-4-7",
        anthropicEndpoint,
        envValue(resolvedEnv, "ANTHROPIC_API_VERSION") ?? "2023-06-01",
        imageModelsFor("anthropic"),
        configurationOnly ? undefined : anthropicCredentialResolver,
      ),
      ["claude"],
    );
  }

  const openaiEndpoint = envValue(
    resolvedEnv,
    "OPENAI_COMPAT_ENDPOINT",
    "OPENAI_ENDPOINT",
    "LLM_ENDPOINT",
  );
  const openaiModel = envValue(
    resolvedEnv,
    "OPENAI_COMPAT_MODEL",
    "OPENAI_MODEL",
    "LLM_MODEL",
  );
  const openaiKey = envValue(
    resolvedEnv,
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_API_KEY",
    "LLM_API_KEY",
  );
  const openaiCredentialKey = (["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY"] as const)
    .find((key) => hasLLMSecretMaterial(credentialEnv, key));
  const wantsNativeOpenAI =
    wantsBackend(resolvedEnv, "openai") ||
    Boolean(envValue(resolvedEnv, "OPENAI_API_KEY"));
  const wantsOpenAICompatible =
    wantsBackend(resolvedEnv, "openai-compatible") ||
    wantsBackend(resolvedEnv, "openai");
  if (
    (openaiEndpoint && openaiModel) ||
    (openaiKey && openaiModel) ||
    wantsOpenAICompatible
  ) {
    const endpoint =
      openaiEndpoint ??
      (wantsNativeOpenAI ? SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai : "");
    const headers = parseHeadersJson(envValue(resolvedEnv, "OPENAI_COMPAT_HEADERS_JSON", "LLM_HEADERS_JSON"));
    const credentialResolver = openaiCredentialKey
      ? credentialResolverFor(credentialEnv, openaiCredentialKey, "openai-compatible", endpoint,
        ["llm.text.generate", "llm.audio.transcription"])
      : undefined;
    registry.register(
      new OpenAICompatibleBackend({
        name: "openai-compatible",
        endpoint,
        defaultModel: openaiModel ?? "",
        apiKey: configurationOnly || credentialResolver ? undefined : openaiKey,
        credential_resolver: configurationOnly ? undefined : credentialResolver,
        headers: configurationOnly ? {} : headers,
        image_capable_models: imageModelsFor("openai-compatible"),
        audio_transcription_capable_models: audioModelsFor("openai-compatible"),
        audio_task_capable_models: audioTaskModelsFor("openai-compatible"),
      }),
      ["openai"],
    );
  }

  const openrouterModel = envValue(resolvedEnv, "OPENROUTER_MODEL", "LLM_MODEL");
  const openrouterKey = envValue(resolvedEnv, "OPENROUTER_API_KEY");
  const openrouterEndpoint =
    envValue(resolvedEnv, "OPENROUTER_ENDPOINT") ?? SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openrouter;
  const openrouterSelected = wantsBackend(resolvedEnv, "openrouter");
  const wantsOpenRouter = openrouterSelected || Boolean(openrouterKey && openrouterModel);
  const openrouterCredentialResolver = hasLLMSecretMaterial(credentialEnv, "OPENROUTER_API_KEY")
    ? credentialResolverFor(credentialEnv, "OPENROUTER_API_KEY", "openrouter", openrouterEndpoint,
      ["llm.text.generate", "llm.audio.transcription"])
    : undefined;
  if (wantsOpenRouter) {
    if (!openrouterModel) {
      throw new Error("openrouter requires OPENROUTER_MODEL or LLM_MODEL");
    }
    if (!openrouterKey) {
      throw new Error("openrouter requires OPENROUTER_API_KEY");
    }
    const openrouterHeaders: Record<string, string> = {};
    const siteUrl = envValue(resolvedEnv, "OPENROUTER_SITE_URL");
    const appTitle = envValue(resolvedEnv, "OPENROUTER_APP_TITLE");
    if (siteUrl) openrouterHeaders["HTTP-Referer"] = siteUrl;
    if (appTitle) openrouterHeaders["X-Title"] = appTitle;
    registry.register(
      new OpenAICompatibleBackend({
        name: "openrouter",
        endpoint: openrouterEndpoint,
        defaultModel: openrouterModel,
        apiKey: configurationOnly || openrouterCredentialResolver ? undefined : openrouterKey,
        credential_resolver: configurationOnly ? undefined : openrouterCredentialResolver,
        headers: openrouterHeaders,
        image_capable_models: imageModelsFor("openrouter"),
        audio_transcription_capable_models: audioModelsFor("openrouter"),
        audio_task_capable_models: audioTaskModelsFor("openrouter"),
      }),
    );
  }

  for (const provider of parseProvidersJson(
    envValue(resolvedEnv, "LLM_PROVIDERS_JSON"),
    resolvedEnv,
    configurationOnly,
  )) {
    registry.register(
      new OpenAICompatibleBackend({
        name: provider.name,
        endpoint: provider.endpoint,
        defaultModel: provider.model,
        apiKey: provider.credentialKey && !configurationOnly ? undefined : provider.apiKey,
        credential_resolver: provider.credentialKey && !configurationOnly
          ? credentialResolverFor(credentialEnv, provider.credentialKey, provider.name, provider.endpoint,
            ["llm.text.generate", "llm.audio.transcription"])
          : undefined,
        headers: provider.headers,
        image_capable_models: imageModelsFor(provider.name.trim().toLowerCase()),
        audio_transcription_capable_models: audioModelsFor(provider.name.trim().toLowerCase()),
        audio_task_capable_models: audioTaskModelsFor(provider.name.trim().toLowerCase()),
      }),
      provider.aliases,
    );
  }

  const defaultBackend =
    envValue(resolvedEnv, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub";
  registry.setDefault(defaultBackend);
  for (const [provider, profile] of parseFallbackProfilesJson(
    envValue(resolvedEnv, "BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON"),
  )) {
    registry.setFallbackProfile(provider, profile);
  }
  const registeredProviders = new Set(registry.list());
  for (const provider of imageCapableModels.keys()) {
    if (!registeredProviders.has(provider)) {
      throw new Error(`BLUE_TANUKI_LLM_IMAGE_CAPABLE_MODELS_JSON provider '${provider}' is not registered`);
    }
  }
  for (const [provider, models] of audioTranscriptionCapableModels) {
    if (!registeredProviders.has(provider)) {
      throw new Error(`BLUE_TANUKI_LLM_AUDIO_TRANSCRIPTION_CAPABLE_MODELS_JSON provider '${provider}' is not registered`);
    }
    const backend = registry.resolve(provider);
    if (models.some((model) => backend.supportsCapability?.("llm.audio.transcription", model) !== true)) {
      throw new Error(`BLUE_TANUKI_LLM_AUDIO_TRANSCRIPTION_CAPABLE_MODELS_JSON provider '${provider}' does not support audio transcription`);
    }
  }
  for (const [provider, models] of audioTaskCapableModels) {
    if (!registeredProviders.has(provider)) {
      throw new Error(`BLUE_TANUKI_LLM_AUDIO_TASK_CAPABLE_MODELS_JSON provider '${provider}' is not registered`);
    }
    const backend = registry.resolve(provider);
    if (models.some((model) => backend.supportsCapability?.("llm.audio.task", model) !== true)) {
      throw new Error(`BLUE_TANUKI_LLM_AUDIO_TASK_CAPABLE_MODELS_JSON provider '${provider}' requires exact-model transcription capability`);
    }
  }
  registry.setFallback(envValue(resolvedEnv, "BLUE_TANUKI_LLM_FALLBACK_BACKEND"));
  return registry;
}

export function buildLLMCommandRouteFromEnv(
  env: Env = process.env,
): LLMCommandRoute {
  const fallbackAuthorization = parseFallbackAuthorizationJson(
    envValue(env, "BLUE_TANUKI_LLM_FALLBACK_AUTHORIZATION_JSON"),
  );
  return {
    backend_hint: envValue(env, "BLUE_TANUKI_LLM_BACKEND_HINT"),
    model: envValue(env, "BLUE_TANUKI_LLM_MODEL"),
    temperature: parseTemperatureEnv(env),
    max_tokens: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_MAX_TOKENS"),
    timeout_ms: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_TIMEOUT_MS"),
    ...(fallbackAuthorization ? { fallback_authorization: fallbackAuthorization } : {}),
  };
}

/** Resolve the exact configured provider/model pair for the runtime J compute contract. */
export function resolveLLMCommandRouteFromEnv(
  env: Env = process.env,
  externalTextRequest?: Pick<InboundRequest, "id" | "content">,
): LLMCommandRoute {
  const route = buildLLMCommandRouteFromEnv(env);
  const identity = inspectLLMRegistryConfiguration(env);
  const computeCostLimit = identity.maximumCostForCall({
    backend_hint: identity.provider,
    model: identity.model,
    messages: [{ role: "user", content: "" }],
  }, route.fallback_authorization);
  if (externalTextRequest) {
    const reference = envValue(env, "OPENAI_API_KEY_REF");
    if (!reference || envValue(env, "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_API_KEY_REF",
        "LLM_API_KEY", "LLM_API_KEY_REF", "OPENAI_COMPAT_ENDPOINT", "OPENAI_ENDPOINT", "LLM_ENDPOINT",
        "OPENAI_COMPAT_HEADERS_JSON", "LLM_HEADERS_JSON", "LLM_PROVIDERS_JSON",
        "BLUE_TANUKI_SECRET_DIR", "BLUE_TANUKI_POWERSHELL")) {
      throw new Error("openai_text_egress_requires_unmodified_protected_credential_route");
    }
    validateLLMSecretReferences({ OPENAI_API_KEY_REF: reference });
    if (!wantsBackend(env, "openai") || identity.provider !== "openai-compatible" ||
        route.fallback_authorization || envValue(env, "BLUE_TANUKI_LLM_FALLBACK_BACKEND") ||
        buildLLMRetryPolicyFromEnv(env).max_attempts !== 1 ||
        !computeCostLimit || !Number.isFinite(computeCostLimit.amount) || computeCostLimit.amount <= 0) {
      throw new Error("openai_text_egress_requires_funded_single_openai_attempt");
    }
    route.external_text_egress = {
      request_id: externalTextRequest.id,
      purpose_digest: createHash("sha256").update("blue-tanuki.compute-grant.purpose.v1\0")
        .update(externalTextRequest.content, "utf8").digest("hex"),
      endpoint: SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai,
      model: identity.model,
    };
  }
  return {
    ...route,
    backend_hint: identity.provider,
    model: identity.model,
    maximum_provider_attempts: buildLLMRetryPolicyFromEnv(env).max_attempts,
    ...(envValue(env, "BLUE_TANUKI_LLM_FALLBACK_BACKEND")
      ? { configured_fallback_backend: envValue(env, "BLUE_TANUKI_LLM_FALLBACK_BACKEND") } : {}),
    ...(computeCostLimit ? { compute_cost_limit: {
      amount: computeCostLimit.amount,
      currency: computeCostLimit.currency,
    } } : {}),
  };
}

export function describeLLMCommandRoute(env: Env = process.env): {
  backend_hint: string;
  model: string;
  temperature: string;
  max_tokens: string;
  timeout_ms: string;
  compute_cost_limit: { amount: number; currency: string } | null;
  one_shot_openai_text_egress_available: boolean;
} {
  const route = buildLLMCommandRouteFromEnv(env);
  let resolvedRoute: LLMCommandRoute | undefined;
  let oneShotOpenAITextEgressAvailable = false;
  try {
    resolvedRoute = resolveLLMCommandRouteFromEnv(env);
    resolveLLMCommandRouteFromEnv(env, { id: "control-center-egress-readiness", content: "" });
    oneShotOpenAITextEgressAvailable = true;
  } catch {
    // 設定表示は継続し、保護されたOpenAI単一試行の条件が揃わない時だけ選択肢を隠す。
  }
  return {
    backend_hint: route.backend_hint ?? "(registry default)",
    model: route.model ?? "(provider default)",
    temperature:
      route.temperature === undefined ? "(provider default)" : String(route.temperature),
    max_tokens: route.max_tokens === undefined ? "1024" : String(route.max_tokens),
    timeout_ms: route.timeout_ms === undefined ? "30000" : String(route.timeout_ms),
    compute_cost_limit: resolvedRoute?.compute_cost_limit ?? null,
    one_shot_openai_text_egress_available: oneShotOpenAITextEgressAvailable,
  };
}

/** Keep request-time one-shot egress bound to the route used to construct the provider registry. */
export function isSameOneShotOpenAITextEgressRoute(
  startup: LLMCommandRoute | undefined,
  current: LLMCommandRoute,
): boolean {
  const startupEgress = startup?.external_text_egress;
  const currentEgress = current.external_text_egress;
  const sameCostLimit = startup?.compute_cost_limit?.amount === current.compute_cost_limit?.amount &&
    startup?.compute_cost_limit?.currency === current.compute_cost_limit?.currency;
  return Boolean(startup && startupEgress && currentEgress &&
    startup.backend_hint === "openai-compatible" && current.backend_hint === "openai-compatible" &&
    startup.model === current.model && startupEgress.model === startup.model && currentEgress.model === current.model &&
    startupEgress.endpoint === SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai &&
    currentEgress.endpoint === SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai &&
    startup.temperature === current.temperature && startup.max_tokens === current.max_tokens &&
    startup.timeout_ms === current.timeout_ms && sameCostLimit &&
    startup.maximum_provider_attempts === 1 && current.maximum_provider_attempts === 1 &&
    startup.configured_fallback_backend === undefined && current.configured_fallback_backend === undefined &&
    startup.fallback_authorization === undefined && current.fallback_authorization === undefined);
}

export function listConfiguredLLMProviders(env: Env = process.env): string[] {
  const names = new Set<string>(["stub"]);
  if (env.BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND === "true" &&
      env.NODE_ENV !== "production" && process.env.NODE_ENV !== "production") {
    names.add(SYNTHETIC_FILE_WRITE_PLAN_BACKEND);
  }
  if (hasLLMSecretMaterial(env, "ANTHROPIC_API_KEY") || wantsBackend(env, "anthropic")) {
    names.add("anthropic");
  }
  const openaiConfigured = Boolean(
    envValue(env, "OPENAI_COMPAT_ENDPOINT", "OPENAI_ENDPOINT", "LLM_ENDPOINT") &&
      envValue(env, "OPENAI_COMPAT_MODEL", "OPENAI_MODEL", "LLM_MODEL"),
  );
  if (
    openaiConfigured ||
    wantsBackend(env, "openai") ||
    wantsBackend(env, "openai-compatible")
  ) {
    names.add("openai-compatible");
  }
  if (
    ((hasLLMSecretMaterial(env, "OPENROUTER_API_KEY")) &&
      envValue(env, "OPENROUTER_MODEL", "LLM_MODEL")) ||
    wantsBackend(env, "openrouter")
  ) {
    names.add("openrouter");
  }
  for (const provider of parseProvidersJson(envValue(env, "LLM_PROVIDERS_JSON"), env)) {
    names.add(provider.name);
    for (const alias of provider.aliases) {
      names.add(alias);
    }
  }
  return Array.from(names).sort();
}

export function describeLLMConfig(env: Env = process.env): {
  default_backend: string;
  openai_compatible_configured: boolean;
  anthropic_configured: boolean;
  anthropic_secret_ref_configured: boolean;
  openrouter_configured: boolean;
  openrouter_secret_ref_configured: boolean;
  configured_providers: string[];
  resilience: {
    retry_policy: LLMRetryPolicy;
    fallback_backend: string | null;
    used_for_authority: false;
    evidence_source: readonly ["CONFIG"];
  };
} {
  return {
    default_backend:
      envValue(env, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub",
    openai_compatible_configured: Boolean(
      envValue(env, "OPENAI_COMPAT_ENDPOINT", "OPENAI_ENDPOINT", "LLM_ENDPOINT") &&
        envValue(env, "OPENAI_COMPAT_MODEL", "OPENAI_MODEL", "LLM_MODEL"),
    ),
    anthropic_configured: Boolean(
      envValue(env, "ANTHROPIC_API_KEY") ||
        envValue(env, secretRefKey("ANTHROPIC_API_KEY")),
    ),
    anthropic_secret_ref_configured: Boolean(
      envValue(env, secretRefKey("ANTHROPIC_API_KEY")),
    ),
    openrouter_configured: Boolean(
      (envValue(env, "OPENROUTER_API_KEY") ||
        envValue(env, secretRefKey("OPENROUTER_API_KEY"))) &&
        envValue(env, "OPENROUTER_MODEL", "LLM_MODEL"),
    ),
    openrouter_secret_ref_configured: Boolean(
      envValue(env, secretRefKey("OPENROUTER_API_KEY")),
    ),
    configured_providers: listConfiguredLLMProviders(env),
    resilience: {
      retry_policy: buildLLMRetryPolicyFromEnv(env),
      fallback_backend: envValue(env, "BLUE_TANUKI_LLM_FALLBACK_BACKEND") ?? null,
      used_for_authority: false,
      evidence_source: ["CONFIG"],
    },
  };
}
