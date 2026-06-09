import {
  buildLLMBackendFromEnv,
  buildLLMCommandRouteFromEnv,
} from "../../llm_config.js";
import type { PluginRuntime } from "../../plugin_loader.js";
import {
  setupConfigFromEnv,
  setupConfigToEnv,
  type BlueTanukiSetupConfig,
  type SetupProviderKind,
} from "../../setup_config.js";

type Env = Record<string, string | undefined>;

export interface LlmProvisioningVerifyResult {
  status: "pass" | "fail";
  provider: SetupProviderKind;
  model: string;
  changed: false;
  safe: true;
  secret_exposed: false;
  duration_ms: number;
  detail: string;
  next_action: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumberField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number`);
  }
  return parsed;
}

function optionalIntField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = optionalNumberField(obj, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function normalizeProvider(value: string): SetupProviderKind {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "stub" ||
    normalized === "anthropic" ||
    normalized === "openai" ||
    normalized === "openai-compatible" ||
    normalized === "openrouter"
  ) {
    return normalized;
  }
  throw new Error("provider must be stub | anthropic | openai | openai-compatible | openrouter");
}

export function applySettingsPatch(
  config: BlueTanukiSetupConfig,
  body: Record<string, unknown>,
): BlueTanukiSetupConfig {
  if (isRecord(body.llm)) {
    const llm = body.llm;
    const provider = stringField(llm, "provider");
    if (provider) config.llm.provider = normalizeProvider(provider);
    const model = optionalStringField(llm, "model");
    if (model !== undefined) config.llm.model = model;
    const endpoint = optionalStringField(llm, "endpoint");
    if (endpoint !== undefined) config.llm.endpoint = endpoint;
    const apiKey = optionalStringField(llm, "api_key");
    if (apiKey !== undefined) config.llm.api_key = apiKey;
    const siteUrl = optionalStringField(llm, "site_url");
    if (siteUrl !== undefined) config.llm.site_url = siteUrl;
    const appTitle = optionalStringField(llm, "app_title");
    if (appTitle !== undefined) config.llm.app_title = appTitle;
    const temperature = optionalNumberField(llm, "temperature");
    if (temperature !== undefined) config.llm.temperature = temperature;
    const maxTokens = optionalIntField(llm, "max_tokens");
    if (maxTokens !== undefined) config.llm.max_tokens = maxTokens;
    const timeoutMs = optionalIntField(llm, "timeout_ms");
    if (timeoutMs !== undefined) config.llm.timeout_ms = timeoutMs;
  }
  if (isRecord(body.webchat)) {
    const webchat = body.webchat;
    const host = optionalStringField(webchat, "host");
    if (host !== undefined) config.webchat.host = host;
    const port = optionalIntField(webchat, "port");
    if (port !== undefined) config.webchat.port = port;
  }
  if (isRecord(body.paths)) {
    const paths = body.paths;
    const fileRoot = optionalStringField(paths, "file_root");
    if (fileRoot !== undefined) config.paths.file_root = fileRoot;
    const sessionDir = optionalStringField(paths, "session_dir");
    if (sessionDir !== undefined) config.paths.session_dir = sessionDir;
    const auditDir = optionalStringField(paths, "audit_dir");
    if (auditDir !== undefined) config.paths.audit_dir = auditDir;
  }
  if (isRecord(body.composio)) {
    const composio = body.composio;
    const apiKey = optionalStringField(composio, "api_key");
    if (apiKey !== undefined) config.composio.api_key = apiKey;
    const allowedToolkits = optionalStringField(composio, "allowed_toolkits");
    if (allowedToolkits !== undefined) config.composio.allowed_toolkits = allowedToolkits;
    const dryRun = composio.dry_run;
    if (dryRun !== undefined && dryRun !== null && dryRun !== "") {
      if (typeof dryRun === "boolean") {
        config.composio.dry_run = dryRun;
      } else if (typeof dryRun === "string") {
        const normalized = dryRun.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) config.composio.dry_run = true;
        else if (["0", "false", "no", "off"].includes(normalized)) config.composio.dry_run = false;
        else throw new Error("dry_run must be a boolean");
      } else {
        throw new Error("dry_run must be a boolean");
      }
    }
  }
  setupConfigToEnv(config);
  return config;
}

function candidateEnvFromBody(body: Record<string, unknown>, env: Env): Env {
  const nextConfig = applySettingsPatch(setupConfigFromEnv(env), body);
  return { ...env, ...setupConfigToEnv(nextConfig, { source_env: env }) };
}

function redactKnownSecretValues(message: string, env: Env): string {
  let redacted = message;
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_API_KEY",
    "COMPOSIO_API_KEY",
  ]) {
    const value = env[key];
    if (value && value.length >= 6) {
      redacted = redacted.split(value).join("[redacted]");
    }
  }
  return redacted;
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function verifyLlmProvisioning(
  body: Record<string, unknown>,
  env: Env,
  plugins: PluginRuntime,
): Promise<LlmProvisioningVerifyResult> {
  const started = Date.now();
  let candidateEnv: Env = env;
  let provider: SetupProviderKind = "stub";
  let model = "(provider default)";
  try {
    candidateEnv = candidateEnvFromBody(body, env);
    const config = setupConfigFromEnv(candidateEnv);
    provider = config.llm.provider;
    model = config.llm.model ?? "(provider default)";
    plugins.enforceLLMConfig(candidateEnv);

    if (provider === "stub") {
      return {
        status: "pass",
        provider,
        model: "stub-v0",
        changed: false,
        safe: true,
        secret_exposed: false,
        duration_ms: Date.now() - started,
        detail: "stub backend verified without external network access",
        next_action: "Save settings, then restart the gateway if this is the desired provider.",
      };
    }

    const route = buildLLMCommandRouteFromEnv(candidateEnv);
    const backend = buildLLMBackendFromEnv(candidateEnv);
    const response = await withTimeout(
      "LLM provisioning check",
      backend.call({
        backend_hint: route.backend_hint,
        model: route.model,
        max_tokens: Math.min(route.max_tokens ?? 24, 24),
        temperature: 0,
        messages: [
          { role: "system", content: "Reply with exactly: BLUE-TANUKI-SETUP-OK" },
          { role: "user", content: "setup check" },
        ],
      }),
      positiveInt(candidateEnv.BLUE_TANUKI_LLM_TIMEOUT_MS, 30_000),
    );
    return {
      status: "pass",
      provider,
      model: response.model,
      changed: false,
      safe: true,
      secret_exposed: false,
      duration_ms: Date.now() - started,
      detail: `provider responded; tokens=${response.tokens_used}`,
      next_action: "Save settings, then restart the gateway so runtime uses this provider.",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "fail",
      provider,
      model,
      changed: false,
      safe: true,
      secret_exposed: false,
      duration_ms: Date.now() - started,
      detail: redactKnownSecretValues(message, candidateEnv),
      next_action: "Check provider, model, endpoint, and API key, then run this verification again before saving.",
    };
  }
}
