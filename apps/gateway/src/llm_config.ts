import {
  AnthropicBackend,
  LLMRegistry,
  OpenAICompatibleBackend,
  StubBackend,
  type LLMBackend,
  type LLMRetryPolicy,
} from "@blue-tanuki/core";
import type { LLMCommandRoute } from "@blue-tanuki/hds-brain";
import {
  hasLLMSecretMaterial,
  resolveLLMSecretRefs,
  secretRefKey,
} from "./secret_store.js";

type Env = Record<string, string | undefined>;

interface ProviderSpec {
  name: string;
  type: "openai-compatible";
  endpoint: string;
  model: string;
  apiKey?: string;
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

function parseProvidersJson(raw: string | undefined, env: Env): ProviderSpec[] {
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
    const apiKey =
      stringOrUndefined(obj.api_key) ??
      (apiKeyEnv ? envValue(env, apiKeyEnv) : undefined);
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
      headers: { ...headersFromEnv, ...inlineHeaders },
      aliases: stringArray(obj.aliases, `LLM_PROVIDERS_JSON[${index}].aliases`),
    };
  });
}

function wantsBackend(env: Env, name: string): boolean {
  return (envValue(env, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub")
    .trim()
    .toLowerCase() === name;
}

const OPENROUTER_DEFAULT_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";

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
  const resolvedEnv = resolveLLMSecretRefs(env);
  const registry = new LLMRegistry({
    retry: buildLLMRetryPolicyFromEnv(resolvedEnv),
  });
  registry.register(new StubBackend());

  const anthropicKey = envValue(resolvedEnv, "ANTHROPIC_API_KEY");
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
        envValue(resolvedEnv, "ANTHROPIC_ENDPOINT") ??
          "https://api.anthropic.com/v1/messages",
        envValue(resolvedEnv, "ANTHROPIC_API_VERSION") ?? "2023-06-01",
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
      (wantsNativeOpenAI ? "https://api.openai.com/v1/chat/completions" : "");
    registry.register(
      new OpenAICompatibleBackend({
        name: "openai-compatible",
        endpoint,
        defaultModel: openaiModel ?? "",
        apiKey: openaiKey,
        headers: parseHeadersJson(
          envValue(
            resolvedEnv,
            "OPENAI_COMPAT_HEADERS_JSON",
            "LLM_HEADERS_JSON",
          ),
        ),
      }),
      ["openai"],
    );
  }

  const openrouterModel = envValue(resolvedEnv, "OPENROUTER_MODEL", "LLM_MODEL");
  const openrouterKey = envValue(resolvedEnv, "OPENROUTER_API_KEY");
  const openrouterEndpoint =
    envValue(resolvedEnv, "OPENROUTER_ENDPOINT") ?? OPENROUTER_DEFAULT_ENDPOINT;
  const openrouterSelected = wantsBackend(resolvedEnv, "openrouter");
  const wantsOpenRouter = openrouterSelected || Boolean(openrouterKey && openrouterModel);
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
        apiKey: openrouterKey,
        headers: openrouterHeaders,
      }),
    );
  }

  for (const provider of parseProvidersJson(
    envValue(resolvedEnv, "LLM_PROVIDERS_JSON"),
    resolvedEnv,
  )) {
    registry.register(
      new OpenAICompatibleBackend({
        name: provider.name,
        endpoint: provider.endpoint,
        defaultModel: provider.model,
        apiKey: provider.apiKey,
        headers: provider.headers,
      }),
      provider.aliases,
    );
  }

  const defaultBackend =
    envValue(resolvedEnv, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub";
  registry.setDefault(defaultBackend);
  registry.setFallback(envValue(resolvedEnv, "BLUE_TANUKI_LLM_FALLBACK_BACKEND"));
  return registry;
}

export function buildLLMCommandRouteFromEnv(
  env: Env = process.env,
): LLMCommandRoute {
  return {
    backend_hint: envValue(env, "BLUE_TANUKI_LLM_BACKEND_HINT"),
    model: envValue(env, "BLUE_TANUKI_LLM_MODEL"),
    temperature: parseTemperatureEnv(env),
    max_tokens: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_MAX_TOKENS"),
    timeout_ms: parsePositiveIntEnv(env, "BLUE_TANUKI_LLM_TIMEOUT_MS"),
  };
}

export function describeLLMCommandRoute(env: Env = process.env): {
  backend_hint: string;
  model: string;
  temperature: string;
  max_tokens: string;
  timeout_ms: string;
} {
  const route = buildLLMCommandRouteFromEnv(env);
  return {
    backend_hint: route.backend_hint ?? "(registry default)",
    model: route.model ?? "(provider default)",
    temperature:
      route.temperature === undefined ? "(provider default)" : String(route.temperature),
    max_tokens: route.max_tokens === undefined ? "1024" : String(route.max_tokens),
    timeout_ms: route.timeout_ms === undefined ? "30000" : String(route.timeout_ms),
  };
}

export function listConfiguredLLMProviders(env: Env = process.env): string[] {
  const names = new Set<string>(["stub"]);
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
