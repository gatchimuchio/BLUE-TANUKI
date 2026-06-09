import { randomBytes } from "node:crypto";
import * as path from "node:path";

export type SetupProviderKind =
  | "stub"
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "openrouter";

export interface SetupLlmConfig {
  provider: SetupProviderKind;
  model?: string;
  endpoint?: string;
  api_key?: string;
  api_key_env?: string;
  backend_hint?: string;
  site_url?: string;
  app_title?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface SetupWebChatConfig {
  host: string;
  port: number;
  token: string;
  resume_token: string;
}

export interface SetupPathConfig {
  file_root: string;
  session_dir: string;
  audit_dir: string;
}

export interface BlueTanukiSetupConfig {
  schema_version: 1;
  llm: SetupLlmConfig;
  composio: {
    api_key?: string;
    allowed_toolkits?: string;
    dry_run: boolean;
  };
  webchat: SetupWebChatConfig;
  paths: SetupPathConfig;
  settings: {
    token: string;
  };
}

export interface SetupDefaultsOptions {
  base_dir?: string;
  token_bytes?: number;
}

export interface RenderEnvOptions {
  include_header?: boolean;
  source_env?: Record<string, string | undefined>;
}

const DEFAULT_TOKEN_BYTES = 32;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeProvider(provider: string): SetupProviderKind {
  const normalized = provider.trim().toLowerCase();
  if (
    normalized === "stub" ||
    normalized === "anthropic" ||
    normalized === "openai" ||
    normalized === "openai-compatible" ||
    normalized === "openrouter"
  ) {
    return normalized;
  }
  throw new Error(
    "llm.provider must be one of stub | anthropic | openai | openai-compatible | openrouter",
  );
}

function validateOptionalPositiveInt(
  value: number | undefined,
  field: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function validateOptionalTemperature(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("llm.temperature must be between 0 and 2");
  }
}

function validatePath(value: string, field: string): void {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty path`);
  }
}

function validateToken(value: string, field: string): void {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} is required`);
  }
  if (value.length < 16) {
    throw new Error(`${field} must be at least 16 characters`);
  }
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function addEnvLine(lines: string[], key: string, value: string | undefined): void {
  if (value === undefined) return;
  lines.push(`${key}=${quoteEnv(value)}`);
}

export function generateSetupToken(bytes = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new Error("token bytes must be an integer >= 16");
  }
  return randomBytes(bytes).toString("base64url");
}

export function createDefaultSetupConfig(
  options: SetupDefaultsOptions = {},
): BlueTanukiSetupConfig {
  const base = path.resolve(options.base_dir ?? ".blue-tanuki");
  const tokenBytes = options.token_bytes ?? DEFAULT_TOKEN_BYTES;
  return {
    schema_version: 1,
    llm: {
      provider: "stub",
    },
    composio: {
      dry_run: true,
    },
    webchat: {
      host: "127.0.0.1",
      port: 8787,
      token: generateSetupToken(tokenBytes),
      resume_token: generateSetupToken(tokenBytes),
    },
    paths: {
      file_root: path.join(base, "files"),
      session_dir: path.join(base, "sessions"),
      audit_dir: path.join(base, "audit"),
    },
    settings: {
      token: generateSetupToken(tokenBytes),
    },
  };
}

export function validateSetupConfig(
  config: BlueTanukiSetupConfig,
): BlueTanukiSetupConfig {
  if (!config || typeof config !== "object") {
    throw new Error("setup config must be an object");
  }
  if (config.schema_version !== 1) {
    throw new Error("schema_version must be 1");
  }

  const provider = normalizeProvider(config.llm.provider);
  config.llm.provider = provider;
  config.composio ??= { dry_run: true };
  config.composio.dry_run = config.composio.dry_run !== false;
  validateOptionalTemperature(config.llm.temperature);
  validateOptionalPositiveInt(config.llm.max_tokens, "llm.max_tokens");
  validateOptionalPositiveInt(config.llm.timeout_ms, "llm.timeout_ms");

  if (provider === "anthropic") {
    if (!isNonEmptyString(config.llm.api_key_env) && !isNonEmptyString(config.llm.api_key)) {
      throw new Error("anthropic setup requires llm.api_key or llm.api_key_env");
    }
    if (!isNonEmptyString(config.llm.model)) {
      throw new Error("anthropic setup requires llm.model");
    }
  }

  if (provider === "openai") {
    if (!isNonEmptyString(config.llm.api_key_env) && !isNonEmptyString(config.llm.api_key)) {
      throw new Error("openai setup requires llm.api_key or llm.api_key_env");
    }
    if (!isNonEmptyString(config.llm.model)) {
      throw new Error("openai setup requires llm.model");
    }
  }

  if (provider === "openai-compatible") {
    if (!isNonEmptyString(config.llm.endpoint)) {
      throw new Error("openai-compatible setup requires llm.endpoint");
    }
    if (!isNonEmptyString(config.llm.model)) {
      throw new Error("openai-compatible setup requires llm.model");
    }
  }

  if (provider === "openrouter") {
    if (!isNonEmptyString(config.llm.api_key_env) && !isNonEmptyString(config.llm.api_key)) {
      throw new Error("openrouter setup requires llm.api_key or llm.api_key_env");
    }
    if (!isNonEmptyString(config.llm.model)) {
      throw new Error("openrouter setup requires llm.model");
    }
  }

  if (!isNonEmptyString(config.webchat.host)) {
    throw new Error("webchat.host is required");
  }
  if (!Number.isInteger(config.webchat.port) || config.webchat.port <= 0) {
    throw new Error("webchat.port must be a positive integer");
  }
  if (config.webchat.port > 65_535) {
    throw new Error("webchat.port must be <= 65535");
  }
  validateToken(config.webchat.token, "webchat.token");
  validateToken(config.webchat.resume_token, "webchat.resume_token");
  if (config.webchat.token === config.webchat.resume_token) {
    throw new Error("webchat.resume_token must differ from webchat.token");
  }

  validatePath(config.paths.file_root, "paths.file_root");
  validatePath(config.paths.session_dir, "paths.session_dir");
  validatePath(config.paths.audit_dir, "paths.audit_dir");
  validateToken(config.settings.token, "settings.token");
  if (
    config.settings.token === config.webchat.token ||
    config.settings.token === config.webchat.resume_token
  ) {
    throw new Error("settings.token must differ from WebChat tokens");
  }

  return config;
}

export function setupConfigFromEnv(
  env: Record<string, string | undefined>,
): BlueTanukiSetupConfig {
  const config = createDefaultSetupConfig();
  const backend = (env.LLM_BACKEND ?? env.LLM_DEFAULT_BACKEND ?? "stub")
    .trim()
    .toLowerCase();
  config.llm.provider = normalizeProvider(
      backend === "openai-compatible" || backend === "openai" ||
      backend === "anthropic" ||
      backend === "openrouter"
      ? backend
      : "stub",
  );
  if (config.llm.provider === "anthropic") {
    config.llm.model = env.ANTHROPIC_MODEL ?? env.LLM_MODEL;
    config.llm.endpoint = env.ANTHROPIC_ENDPOINT;
    config.llm.api_key = env.ANTHROPIC_API_KEY;
  } else if (config.llm.provider === "openai") {
    config.llm.model = env.OPENAI_MODEL ?? env.LLM_MODEL;
    config.llm.endpoint = env.OPENAI_ENDPOINT;
    config.llm.api_key = env.OPENAI_API_KEY ?? env.LLM_API_KEY;
  } else if (config.llm.provider === "openai-compatible") {
    config.llm.model =
      env.OPENAI_COMPAT_MODEL ?? env.OPENAI_MODEL ?? env.LLM_MODEL;
    config.llm.endpoint =
      env.OPENAI_COMPAT_ENDPOINT ?? env.OPENAI_ENDPOINT ?? env.LLM_ENDPOINT;
    config.llm.api_key =
      env.OPENAI_COMPAT_API_KEY ?? env.OPENAI_API_KEY ?? env.LLM_API_KEY;
  } else if (config.llm.provider === "openrouter") {
    config.llm.model = env.OPENROUTER_MODEL ?? env.LLM_MODEL;
    config.llm.endpoint = env.OPENROUTER_ENDPOINT;
    config.llm.api_key = env.OPENROUTER_API_KEY;
    config.llm.site_url = env.OPENROUTER_SITE_URL;
    config.llm.app_title = env.OPENROUTER_APP_TITLE;
  }
  config.llm.backend_hint = env.BLUE_TANUKI_LLM_BACKEND_HINT;
  config.llm.temperature = parseOptionalNumber(env.BLUE_TANUKI_LLM_TEMPERATURE);
  config.llm.max_tokens = parseOptionalInt(env.BLUE_TANUKI_LLM_MAX_TOKENS);
  config.llm.timeout_ms = parseOptionalInt(env.BLUE_TANUKI_LLM_TIMEOUT_MS);

  config.webchat.host = env.WEBCHAT_HOST ?? "127.0.0.1";
  config.webchat.port = parseOptionalInt(env.WEBCHAT_PORT) ?? 8787;
  config.webchat.token = env.WEBCHAT_TOKEN ?? config.webchat.token;
  config.webchat.resume_token =
    env.WEBCHAT_RESUME_TOKEN ?? config.webchat.resume_token;
  config.paths.file_root =
    env.BLUE_TANUKI_FILE_ROOT ?? config.paths.file_root;
  config.paths.session_dir =
    env.BLUE_TANUKI_SESSION_DIR ?? config.paths.session_dir;
  config.paths.audit_dir =
    env.BLUE_TANUKI_AUDIT_DIR ?? config.paths.audit_dir;
  config.settings.token =
    env.BLUE_TANUKI_SETTINGS_TOKEN ?? config.settings.token;
  config.composio.api_key = env.COMPOSIO_API_KEY;
  config.composio.allowed_toolkits = env.COMPOSIO_ALLOWED_TOOLKITS;
  config.composio.dry_run = parseOptionalBool(env.COMPOSIO_DRY_RUN) ?? true;

  return validateSetupConfig(config);
}

export function setupConfigToEnv(
  config: BlueTanukiSetupConfig,
  options: RenderEnvOptions = {},
): Record<string, string> {
  validateSetupConfig(config);
  const sourceEnv = options.source_env ?? {};
  const apiKey =
    config.llm.api_key ??
    (config.llm.api_key_env ? sourceEnv[config.llm.api_key_env] : undefined);
  if (config.llm.api_key_env && !apiKey) {
    throw new Error(`llm.api_key_env '${config.llm.api_key_env}' is not set`);
  }
  const env: Record<string, string> = {
    WEBCHAT_HOST: config.webchat.host,
    WEBCHAT_PORT: String(config.webchat.port),
    WEBCHAT_TOKEN: config.webchat.token,
    WEBCHAT_RESUME_TOKEN: config.webchat.resume_token,
    BLUE_TANUKI_SETTINGS_TOKEN: config.settings.token,
    BLUE_TANUKI_FILE_ROOT: path.resolve(config.paths.file_root),
    BLUE_TANUKI_SESSION_DIR: path.resolve(config.paths.session_dir),
    BLUE_TANUKI_AUDIT_DIR: path.resolve(config.paths.audit_dir),
    LLM_BACKEND: config.llm.provider,
  };

  if (config.llm.provider === "stub") {
    env.LLM_BACKEND = "stub";
  }

  if (config.llm.provider === "anthropic") {
    env.LLM_BACKEND = "anthropic";
    if (config.llm.model) env.ANTHROPIC_MODEL = config.llm.model;
    if (config.llm.endpoint) env.ANTHROPIC_ENDPOINT = config.llm.endpoint;
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  }

  if (config.llm.provider === "openai") {
    env.LLM_BACKEND = "openai";
    if (config.llm.model) env.OPENAI_MODEL = config.llm.model;
    if (config.llm.endpoint) env.OPENAI_ENDPOINT = config.llm.endpoint;
    if (apiKey) env.OPENAI_API_KEY = apiKey;
  }

  if (config.llm.provider === "openai-compatible") {
    env.LLM_BACKEND = "openai-compatible";
    if (config.llm.model) env.OPENAI_COMPAT_MODEL = config.llm.model;
    if (config.llm.endpoint) env.OPENAI_COMPAT_ENDPOINT = config.llm.endpoint;
    if (apiKey) env.OPENAI_COMPAT_API_KEY = apiKey;
  }

  if (config.llm.provider === "openrouter") {
    env.LLM_BACKEND = "openrouter";
    if (config.llm.model) env.OPENROUTER_MODEL = config.llm.model;
    if (config.llm.endpoint) env.OPENROUTER_ENDPOINT = config.llm.endpoint;
    if (apiKey) env.OPENROUTER_API_KEY = apiKey;
    if (config.llm.site_url) env.OPENROUTER_SITE_URL = config.llm.site_url;
    if (config.llm.app_title) env.OPENROUTER_APP_TITLE = config.llm.app_title;
  }

  if (config.llm.backend_hint) {
    env.BLUE_TANUKI_LLM_BACKEND_HINT = config.llm.backend_hint;
  }
  if (config.llm.model) {
    env.BLUE_TANUKI_LLM_MODEL = config.llm.model;
  }
  if (config.llm.temperature !== undefined) {
    env.BLUE_TANUKI_LLM_TEMPERATURE = String(config.llm.temperature);
  }
  if (config.llm.max_tokens !== undefined) {
    env.BLUE_TANUKI_LLM_MAX_TOKENS = String(config.llm.max_tokens);
  }
  if (config.llm.timeout_ms !== undefined) {
    env.BLUE_TANUKI_LLM_TIMEOUT_MS = String(config.llm.timeout_ms);
  }
  if (config.composio.api_key) {
    env.COMPOSIO_API_KEY = config.composio.api_key;
  }
  if (config.composio.allowed_toolkits) {
    env.COMPOSIO_ALLOWED_TOOLKITS = config.composio.allowed_toolkits;
  }
  env.COMPOSIO_DRY_RUN = config.composio.dry_run ? "true" : "false";

  return env;
}

export function renderSetupEnvFile(
  config: BlueTanukiSetupConfig,
  options: RenderEnvOptions = {},
): string {
  const env = setupConfigToEnv(config, options);
  const lines: string[] = [];
  if (options.include_header !== false) {
    lines.push("# BLUE-TANUKI local setup env");
    lines.push("# Generated by blue-tanuki setup. Keep this file private.");
    lines.push("");
  }
  for (const key of [
    "LLM_BACKEND",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_ENDPOINT",
    "ANTHROPIC_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_ENDPOINT",
    "OPENAI_API_KEY",
    "OPENAI_COMPAT_MODEL",
    "OPENAI_COMPAT_ENDPOINT",
    "OPENAI_COMPAT_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_ENDPOINT",
    "OPENROUTER_API_KEY",
    "OPENROUTER_SITE_URL",
    "OPENROUTER_APP_TITLE",
    "BLUE_TANUKI_LLM_BACKEND_HINT",
    "BLUE_TANUKI_LLM_MODEL",
    "BLUE_TANUKI_LLM_TEMPERATURE",
    "BLUE_TANUKI_LLM_MAX_TOKENS",
    "BLUE_TANUKI_LLM_TIMEOUT_MS",
    "WEBCHAT_HOST",
    "WEBCHAT_PORT",
    "WEBCHAT_TOKEN",
    "WEBCHAT_RESUME_TOKEN",
    "BLUE_TANUKI_SETTINGS_TOKEN",
    "BLUE_TANUKI_FILE_ROOT",
    "BLUE_TANUKI_SESSION_DIR",
    "BLUE_TANUKI_AUDIT_DIR",
    "COMPOSIO_API_KEY",
    "COMPOSIO_ALLOWED_TOOLKITS",
    "COMPOSIO_DRY_RUN",
  ]) {
    addEnvLine(lines, key, env[key]);
  }
  return `${lines.join("\n")}\n`;
}

function parseOptionalInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  return Number.isInteger(value) ? value : undefined;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseOptionalBool(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}
