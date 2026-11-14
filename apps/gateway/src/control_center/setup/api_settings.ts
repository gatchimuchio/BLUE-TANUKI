import {
  buildLLMBackendFromEnv,
  buildLLMCommandRouteFromEnv,
} from "../../llm_config.js";
import {
  DEFAULT_COMPUTE_BUDGET_POLICY,
  LLMRegistry,
  type LLMBackend,
} from "@blue-tanuki/core";
import { parseComputeBudgetPolicy } from "../../compute_budget_store.js";
import type { PluginRuntime } from "../../plugin_loader.js";
import {
  llmApiKeyForProvider,
  secretRefKey,
  storeBlueTanukiSecret,
  storeLlmApiKeySecret,
  type SecretKeyringFactory,
  type SecretProtector,
  type LlmSecretStoreResult,
} from "../../secret_store.js";
import {
  setupConfigFromEnv,
  setupConfigToEnv,
  type BlueTanukiSetupConfig,
  type SetupProviderKind,
} from "../../setup_config.js";
import { parseLoopbackMcpEndpoint } from "../../mcp_endpoint.js";

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
  compute_readiness: LlmComputeReadiness;
  next_action: string;
}

export interface LlmComputeReadiness {
  status: "ready" | "blocked";
  detail: string;
  max_tokens: number | null;
  max_compute_ms: number | null;
  max_cost_amount: number | null;
  currency: string | null;
  maximum_provider_attempts: number | null;
  current_window_usage_checked: false;
  evidence_source: readonly ["CONFIG"];
}

export interface SettingsSecretStorageResult {
  status: "not_supplied" | "stored";
  key: string | null;
  storage: "win32_dpapi_current_user" | "os_keyring_current_user" | "unavailable";
  os_protected: boolean;
  used_for_authority: false;
  evidence_source: readonly ("CONFIG" | "EXTERNAL_EVIDENCE")[];
  detail: string;
}

export interface SettingsSecretStorageOptions {
  platform?: NodeJS.Platform;
  protector?: SecretProtector;
  keyringFactory?: SecretKeyringFactory;
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

function optionalBooleanField(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`${key} must be a boolean`);
}

function jsonTextField(
  obj: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
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

function normalizeApprovalMode(value: string): BlueTanukiSetupConfig["approval"]["mode"] {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "ask_every_time" ||
    normalized === "remember_this_decision" ||
    normalized === "full_access"
  ) {
    return normalized;
  }
  throw new Error("approval.mode must be ask_every_time | remember_this_decision | full_access");
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
    const computeBudgetPolicy = jsonTextField(llm, "compute_budget_policy_json");
    if (computeBudgetPolicy !== undefined) {
      config.llm.compute_budget_policy_json = computeBudgetPolicy
        ? computeBudgetPolicy
        : JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY);
    }
    const providerCostProfiles = jsonTextField(llm, "provider_cost_profiles_json");
    if (providerCostProfiles !== undefined) {
      config.llm.provider_cost_profiles_json = providerCostProfiles || undefined;
    }
  }
  if (isRecord(body.approval)) {
    const approval = body.approval;
    const mode = optionalStringField(approval, "mode");
    if (mode !== undefined) config.approval.mode = normalizeApprovalMode(mode);
  }
  if (isRecord(body.webchat)) {
    const webchat = body.webchat;
    const host = optionalStringField(webchat, "host");
    if (host !== undefined) config.webchat.host = host;
    const port = optionalIntField(webchat, "port");
    if (port !== undefined) config.webchat.port = port;
  }
  if (isRecord(body.integrations) && isRecord(body.integrations.mcp) &&
      Object.hasOwn(body.integrations.mcp, "endpoint")) {
    const endpoint = body.integrations.mcp.endpoint;
    if (endpoint === null || (typeof endpoint === "string" && endpoint.trim().length === 0)) {
      config.mcp.endpoint = undefined;
    } else if (typeof endpoint === "string") {
      config.mcp.endpoint = parseLoopbackMcpEndpoint(endpoint.trim()).href;
    } else {
      throw new Error("mcp.endpoint must be a credentialless loopback HTTP endpoint or empty");
    }
  }
  if (isRecord(body.paths)) {
    const paths = body.paths;
    const fileRoot = optionalStringField(paths, "file_root");
    if (fileRoot !== undefined) config.paths.file_root = fileRoot;
    if (Object.hasOwn(paths, "shell_root")) {
      const rawShellRoot = paths.shell_root;
      if (rawShellRoot === null || (typeof rawShellRoot === "string" && rawShellRoot.trim().length === 0)) {
        delete config.paths.shell_root;
      } else {
        const shellRoot = optionalStringField(paths, "shell_root");
        if (shellRoot === undefined) throw new Error("shell_root must be a non-empty path or empty");
        config.paths.shell_root = shellRoot;
      }
    }
    const sessionDir = optionalStringField(paths, "session_dir");
    if (sessionDir !== undefined) config.paths.session_dir = sessionDir;
    const auditDir = optionalStringField(paths, "audit_dir");
    if (auditDir !== undefined) config.paths.audit_dir = auditDir;
  }
  if (isRecord(body.composio)) {
    const composio = body.composio;
    const clearApiKey = optionalBooleanField(composio, "clear_api_key");
    const apiKey = optionalStringField(composio, "api_key");
    if (apiKey !== undefined && clearApiKey !== true) {
      config.composio.api_key = apiKey;
      delete config.composio.api_key_ref;
    }
    const allowedToolkits = optionalStringField(composio, "allowed_toolkits");
    if (allowedToolkits !== undefined) config.composio.allowed_toolkits = allowedToolkits;
    const allowedActions = optionalStringField(composio, "allowed_actions");
    if (allowedActions !== undefined) config.composio.allowed_actions = allowedActions;
    const revokedActions = optionalStringField(composio, "revoked_actions");
    if (revokedActions !== undefined) config.composio.revoked_actions = revokedActions;
    const userId = optionalStringField(composio, "user_id");
    if (userId !== undefined) config.composio.user_id = userId;
    const apiBaseUrl = optionalStringField(composio, "api_base_url");
    if (apiBaseUrl !== undefined) config.composio.api_base_url = apiBaseUrl;
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
    const liveExecution = composio.live_execution;
    if (liveExecution !== undefined && liveExecution !== null && liveExecution !== "") {
      if (typeof liveExecution === "boolean") {
        config.composio.live_execution = liveExecution;
      } else if (typeof liveExecution === "string") {
        const normalized = liveExecution.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) config.composio.live_execution = true;
        else if (["0", "false", "no", "off"].includes(normalized)) config.composio.live_execution = false;
        else throw new Error("live_execution must be a boolean");
      } else {
        throw new Error("live_execution must be a boolean");
      }
    }
    if (clearApiKey === true) {
      config.composio.api_key = undefined;
      delete config.composio.api_key_ref;
      config.composio.dry_run = true;
      config.composio.live_execution = false;
    }
  }
  setupConfigToEnv(config);
  return config;
}

export function protectLlmApiKeyForEnvFile(
  config: BlueTanukiSetupConfig,
  envFilePath: string,
  env: Env,
  opts: SettingsSecretStorageOptions | NodeJS.Platform = {},
): SettingsSecretStorageResult {
  const options = typeof opts === "string" ? { platform: opts } : opts;
  const platform = options.platform ?? process.platform;
  const key = llmApiKeyForProvider(config.llm.provider);
  if (!key || !config.llm.api_key) {
    return {
      status: "not_supplied",
      key: key ?? null,
      storage: "unavailable",
      os_protected: false,
      used_for_authority: false,
      evidence_source: ["CONFIG"],
      detail: "No new LLM API key was supplied in this settings update.",
    };
  }
  let stored: LlmSecretStoreResult;
  try {
    stored = storeLlmApiKeySecret(key, config.llm.api_key, {
      envFilePath,
      env,
      platform,
      protector: options.protector,
      keyringFactory: options.keyringFactory,
    });
  } catch (error) {
    throw new Error(
      `OS-protected LLM secret storage failed; refusing to write plaintext ${key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  delete config.llm.api_key;
  config.llm.api_key_ref = stored.ref;
  return {
    status: "stored",
    key,
    storage: stored.storage,
    os_protected: true,
    used_for_authority: false,
    evidence_source: ["CONFIG", "EXTERNAL_EVIDENCE"],
    detail: `${key} stored via ${secretRefKey(key)} using ${stored.storage}.`,
  };
}

export function protectComposioApiKeyForEnvFile(
  config: BlueTanukiSetupConfig,
  envFilePath: string,
  env: Env,
  opts: SettingsSecretStorageOptions | NodeJS.Platform = {},
): SettingsSecretStorageResult {
  const options = typeof opts === "string" ? { platform: opts } : opts;
  const plaintext = config.composio.api_key;
  if (!plaintext) {
    return {
      status: "not_supplied",
      key: "COMPOSIO_API_KEY",
      storage: "unavailable",
      os_protected: false,
      used_for_authority: false,
      evidence_source: ["CONFIG"],
      detail: "No new Composio API key was supplied in this settings update.",
    };
  }
  const platform = options.platform ?? process.platform;
  let stored: LlmSecretStoreResult;
  try {
    stored = storeBlueTanukiSecret("COMPOSIO_API_KEY", plaintext, {
      envFilePath,
      env,
      platform,
      protector: options.protector,
      keyringFactory: options.keyringFactory,
    });
  } catch (error) {
    throw new Error(
      `OS-protected secret storage failed; refusing to write plaintext COMPOSIO_API_KEY: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  delete config.composio.api_key;
  config.composio.api_key_ref = stored.ref;
  return {
    status: "stored",
    key: "COMPOSIO_API_KEY",
    storage: stored.storage,
    os_protected: true,
    used_for_authority: false,
    evidence_source: ["CONFIG", "EXTERNAL_EVIDENCE"],
    detail: `COMPOSIO_API_KEY stored via ${secretRefKey("COMPOSIO_API_KEY")} using ${stored.storage}.`,
  };
}

export function protectD4RuntimeTokenForEnvFile(
  config: BlueTanukiSetupConfig,
  envFilePath: string,
  env: Env,
  opts: SettingsSecretStorageOptions | NodeJS.Platform = {},
): SettingsSecretStorageResult {
  const options = typeof opts === "string" ? { platform: opts } : opts;
  const key = "BLUE_TANUKI_D4_RUNTIME_TOKEN" as const;
  const plaintext = config.d4_runtime?.token;
  if (!plaintext) {
    return {
      status: "not_supplied",
      key,
      storage: "unavailable",
      os_protected: false,
      used_for_authority: false,
      evidence_source: ["CONFIG"],
      detail: "No new D4 Runtime token was supplied in this settings update.",
    };
  }
  const platform = options.platform ?? process.platform;
  let stored: LlmSecretStoreResult;
  try {
    stored = storeBlueTanukiSecret(key, plaintext, {
      envFilePath,
      env,
      platform,
      protector: options.protector,
      keyringFactory: options.keyringFactory,
    });
  } catch (error) {
    throw new Error(
      `OS-protected secret storage failed; refusing to write plaintext ${key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  config.d4_runtime ??= {};
  delete config.d4_runtime.token;
  config.d4_runtime.token_ref = stored.ref;
  return {
    status: "stored",
    key,
    storage: stored.storage,
    os_protected: true,
    used_for_authority: false,
    evidence_source: ["CONFIG", "EXTERNAL_EVIDENCE"],
    detail: `${key} stored via ${secretRefKey(key)} using ${stored.storage}.`,
  };
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
    "BLUE_TANUKI_D4_RUNTIME_TOKEN",
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

const blockedComputeReadiness = (detail: string): LlmComputeReadiness => ({
  status: "blocked",
  detail,
  max_tokens: null,
  max_compute_ms: null,
  max_cost_amount: null,
  currency: null,
  maximum_provider_attempts: null,
  current_window_usage_checked: false,
  evidence_source: ["CONFIG"],
});

/**
 * Evaluates whether saved settings can admit one maximum-size normal Compute
 * reservation. This is configuration evidence only; the durable runtime
 * ledger still decides whether the current window has room.
 */
export function assessLlmComputeReadiness(
  env: Env,
  backend?: LLMBackend,
): LlmComputeReadiness {
  try {
    const route = buildLLMCommandRouteFromEnv(env);
    const registry = backend ?? buildLLMBackendFromEnv(env);
    if (!(registry instanceof LLMRegistry)) {
      return blockedComputeReadiness("The selected provider does not use the budgeted LLM registry.");
    }

    const maxTokens = route.max_tokens ?? 1024;
    const maxComputeMs = route.timeout_ms ?? 30_000;
    const input = {
      backend_hint: route.backend_hint,
      model: route.model,
      max_tokens: maxTokens,
      messages: [],
    };
    const maxCost = registry.maximumCostForCall(input, route.fallback_authorization);
    if (!maxCost) {
      return blockedComputeReadiness(
        "No configured maximum cost profile covers the selected provider and authorized fallback route.",
      );
    }
    const maximumProviderAttempts = registry.maximumCallsForRequest(input, route.fallback_authorization);
    const reservedTokens = maxTokens * maximumProviderAttempts;
    if (!Number.isSafeInteger(reservedTokens) || reservedTokens <= 0) {
      return blockedComputeReadiness("The configured token reservation is outside the supported range.");
    }

    const policy = parseComputeBudgetPolicy(env.BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON);
    const limits = [
      ["system", policy.system],
      ["parent", policy.parent],
      ["task", policy.task],
    ] as const;
    const blockers: string[] = [];
    if (maxCost.currency !== policy.currency) {
      blockers.push("The provider cost profile currency does not match the compute budget currency.");
    }
    for (const [scope, limit] of limits) {
      if (limit.max_tokens < reservedTokens) {
        blockers.push(`The ${scope} token limit cannot admit one maximum-size Compute request.`);
      }
      if (limit.max_compute_ms < maxComputeMs) {
        blockers.push(`The ${scope} compute-time limit cannot admit one normal timeout window.`);
      }
      if (limit.max_cost.currency !== maxCost.currency || limit.max_cost.amount < maxCost.amount) {
        blockers.push(`The ${scope} cost limit cannot admit the configured provider reservation.`);
      }
    }

    const detail = blockers.length > 0
      ? blockers.join(" ")
      : `Configured limits admit one request up to ${reservedTokens} tokens, ${maxComputeMs} ms, and ${maxCost.amount} ${maxCost.currency}; current window usage is checked by the runtime ledger.`;
    return {
      status: blockers.length > 0 ? "blocked" : "ready",
      detail,
      max_tokens: reservedTokens,
      max_compute_ms: maxComputeMs,
      max_cost_amount: maxCost.amount,
      currency: maxCost.currency,
      maximum_provider_attempts: maximumProviderAttempts,
      current_window_usage_checked: false,
      evidence_source: ["CONFIG"],
    };
  } catch {
    return blockedComputeReadiness("The provider cost profile or compute budget configuration is invalid or unavailable.");
  }
}

export async function verifyLlmProvisioning(
  body: Record<string, unknown>,
  env: Env,
  plugins: PluginRuntime,
): Promise<LlmProvisioningVerifyResult> {
  const started = performance.now();
  let candidateEnv: Env = env;
  let provider: SetupProviderKind = "stub";
  let model = "(provider default)";
  let computeReadiness = blockedComputeReadiness("Normal Compute settings were not evaluated.");
  try {
    candidateEnv = candidateEnvFromBody(body, env);
    const config = setupConfigFromEnv(candidateEnv);
    provider = config.llm.provider;
    model = config.llm.model ?? "(provider default)";
    plugins.enforceLLMConfig(candidateEnv);
    const backend = buildLLMBackendFromEnv(candidateEnv);
    computeReadiness = assessLlmComputeReadiness(candidateEnv, backend);

    if (provider === "stub") {
      return {
        status: "pass",
        provider,
        model: "stub-v0",
        changed: false,
        safe: true,
        secret_exposed: false,
        duration_ms: Math.max(0, Math.ceil(performance.now() - started)),
        detail: "stub backend verified without external network access",
        compute_readiness: computeReadiness,
        next_action: computeReadiness.status === "ready"
          ? "Save settings and restart the Gateway. Runtime still checks current budget usage before each Compute reservation."
          : "Save a cost profile and budget that admit one maximum normal Compute request, then verify again.",
      };
    }

    const route = buildLLMCommandRouteFromEnv(candidateEnv);
    const verifyTimeoutMs = positiveInt(candidateEnv.BLUE_TANUKI_LLM_TIMEOUT_MS, 30_000);
    const response = await withTimeout(
      "LLM provisioning check",
      backend.call({
        backend_hint: route.backend_hint,
        model: route.model,
        max_tokens: Math.min(route.max_tokens ?? 24, 24),
        temperature: 0,
        timeout_ms: verifyTimeoutMs,
        messages: [
          { role: "system", content: "Reply with exactly: BLUE-TANUKI-SETUP-OK" },
          { role: "user", content: "setup check" },
        ],
      }),
      verifyTimeoutMs,
    );
    return {
      status: "pass",
      provider,
      model: response.model,
      changed: false,
      safe: true,
      secret_exposed: false,
      duration_ms: Math.max(0, Math.ceil(performance.now() - started)),
      detail: `provider responded; tokens=${response.tokens_used}`,
      compute_readiness: computeReadiness,
      next_action: computeReadiness.status === "ready"
        ? "Save settings and restart the Gateway. Runtime still checks current budget usage before each Compute reservation."
        : "Provider connectivity passed, but normal Compute is blocked. Configure a cost profile and budget that admit one maximum request, then verify again.",
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
      duration_ms: Math.max(0, Math.ceil(performance.now() - started)),
      detail: redactKnownSecretValues(message, candidateEnv),
      compute_readiness: computeReadiness,
      next_action: "Check provider, model, endpoint, and API key, then run this verification again before saving.",
    };
  }
}
