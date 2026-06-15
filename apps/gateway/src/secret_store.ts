import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import * as path from "node:path";

type Env = Record<string, string | undefined>;

export type LlmSecretKey =
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY"
  | "OPENAI_COMPAT_API_KEY"
  | "LLM_API_KEY"
  | "OPENROUTER_API_KEY";

export type ConnectorSecretKey =
  | "COMPOSIO_API_KEY"
  | "GITHUB_TOKEN"
  | "GOOGLE_ACCESS_TOKEN"
  | "GMAIL_ACCESS_TOKEN"
  | "GOOGLE_CALENDAR_ACCESS_TOKEN"
  | "GOOGLE_DRIVE_ACCESS_TOKEN"
  | "SLACK_BOT_TOKEN"
  | "SLACK_APP_TOKEN"
  | "DISCORD_BOT_TOKEN"
  | "TELEGRAM_BOT_TOKEN"
  | "MICROSOFT_GRAPH_ACCESS_TOKEN"
  | "LINE_CHANNEL_ACCESS_TOKEN";

export type BlueTanukiSecretKey = LlmSecretKey | ConnectorSecretKey;

export interface SecretProtector {
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
}

export interface LlmSecretStorageStatus {
  configured_key: BlueTanukiSecretKey | null;
  raw_env_present: boolean;
  secret_ref_present: boolean;
  os_protected: boolean;
  storage: "win32_dpapi_current_user" | "env_file" | "unavailable" | "unknown";
  reason: string;
  used_for_authority: false;
  evidence_source: readonly ["CONFIG"];
}

export interface LlmSecretStoreResult {
  key: BlueTanukiSecretKey;
  ref_key: string;
  ref: string;
  storage: "win32_dpapi_current_user";
  os_protected: true;
  used_for_authority: false;
  evidence_source: readonly ["EXTERNAL_EVIDENCE"];
}

interface StoreOptions {
  envFilePath: string;
  env?: Env;
  platform?: NodeJS.Platform;
  protector?: SecretProtector;
}

interface ResolveOptions {
  platform?: NodeJS.Platform;
  protector?: SecretProtector;
}

const SECRET_REF_PREFIX = "win32-dpapi-current-user:file:";

export const LLM_SECRET_KEYS: readonly LlmSecretKey[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "LLM_API_KEY",
  "OPENROUTER_API_KEY",
];

export const CONNECTOR_SECRET_KEYS: readonly ConnectorSecretKey[] = [
  "COMPOSIO_API_KEY",
  "GITHUB_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
  "GMAIL_ACCESS_TOKEN",
  "GOOGLE_CALENDAR_ACCESS_TOKEN",
  "GOOGLE_DRIVE_ACCESS_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "MICROSOFT_GRAPH_ACCESS_TOKEN",
  "LINE_CHANNEL_ACCESS_TOKEN",
];

export const BLUE_TANUKI_SECRET_KEYS: readonly BlueTanukiSecretKey[] = [
  ...LLM_SECRET_KEYS,
  ...CONNECTOR_SECRET_KEYS,
];

export function llmApiKeyForProvider(provider: string): LlmSecretKey | undefined {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic") return "ANTHROPIC_API_KEY";
  if (normalized === "openai") return "OPENAI_API_KEY";
  if (normalized === "openai-compatible") return "OPENAI_COMPAT_API_KEY";
  if (normalized === "openrouter") return "OPENROUTER_API_KEY";
  return undefined;
}

export function secretRefKey(key: BlueTanukiSecretKey): string {
  return `${key}_REF`;
}

export function hasLLMSecretMaterial(env: Env, key: LlmSecretKey): boolean {
  return hasSecretMaterial(env, key);
}

export function hasSecretMaterial(env: Env, key: BlueTanukiSecretKey): boolean {
  return Boolean(env[key] || env[secretRefKey(key)]);
}

function encodePath(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePath(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function secretDirForEnvFile(envFilePath: string, env: Env): string {
  const configured = env.BLUE_TANUKI_SECRET_DIR;
  if (configured && configured.trim().length > 0) return path.resolve(configured);
  return path.join(path.dirname(path.resolve(envFilePath)), "secrets");
}

function secretPathForKey(envFilePath: string, key: BlueTanukiSecretKey, env: Env): string {
  return path.join(secretDirForEnvFile(envFilePath, env), `${key.toLowerCase()}.dpapi`);
}

function refForPath(secretPath: string): string {
  return `${SECRET_REF_PREFIX}${encodePath(path.resolve(secretPath))}`;
}

function pathFromRef(ref: string): string {
  if (!ref.startsWith(SECRET_REF_PREFIX)) {
    throw new Error("unsupported secret ref format");
  }
  return path.resolve(decodePath(ref.slice(SECRET_REF_PREFIX.length)));
}

function powershellCommand(): string {
  return process.env.BLUE_TANUKI_POWERSHELL ?? "powershell.exe";
}

function protectWithDpapi(plaintext: string): string {
  const script = [
    "$plain = [Console]::In.ReadToEnd()",
    "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
    "ConvertFrom-SecureString -SecureString $secure",
  ].join("; ");
  const result = spawnSync(
    powershellCommand(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: plaintext,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`DPAPI protect failed: ${(result.stderr || result.error?.message || "unknown").trim()}`);
  }
  const protectedValue = result.stdout.trim();
  if (!protectedValue) throw new Error("DPAPI protect returned empty output");
  return protectedValue;
}

function unprotectWithDpapi(protectedValue: string): string {
  const script = [
    "$cipher = [Console]::In.ReadToEnd()",
    "$secure = ConvertTo-SecureString -String $cipher",
    "$credential = New-Object System.Management.Automation.PSCredential('blue-tanuki', $secure)",
    "$credential.GetNetworkCredential().Password",
  ].join("; ");
  const result = spawnSync(
    powershellCommand(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: protectedValue,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`DPAPI unprotect failed: ${(result.stderr || result.error?.message || "unknown").trim()}`);
  }
  const plaintext = result.stdout.replace(/\r?\n$/, "");
  if (!plaintext) throw new Error("DPAPI unprotect returned empty output");
  return plaintext;
}

function defaultProtector(): SecretProtector {
  return {
    protect: protectWithDpapi,
    unprotect: unprotectWithDpapi,
  };
}

export function storeLlmApiKeySecret(
  key: LlmSecretKey,
  plaintext: string,
  opts: StoreOptions,
): LlmSecretStoreResult {
  return storeBlueTanukiSecret(key, plaintext, opts);
}

export function storeBlueTanukiSecret(
  key: BlueTanukiSecretKey,
  plaintext: string,
  opts: StoreOptions,
): LlmSecretStoreResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" && !opts.protector) {
    throw new Error("OS-protected BLUE-TANUKI secret storage is only available on Windows in this release");
  }
  const protector = opts.protector ?? defaultProtector();
  const secretPath = secretPathForKey(opts.envFilePath, key, opts.env ?? {});
  mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  writeFileSync(secretPath, `${protector.protect(plaintext)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Windows ACLs are enforced by DPAPI CurrentUser; chmod is best-effort.
  }
  return {
    key,
    ref_key: secretRefKey(key),
    ref: refForPath(secretPath),
    storage: "win32_dpapi_current_user",
    os_protected: true,
    used_for_authority: false,
    evidence_source: ["EXTERNAL_EVIDENCE"],
  };
}

export function resolveLLMSecretRefs(
  env: Env,
  opts: ResolveOptions = {},
): Env {
  return resolveSecretRefs(env, opts, LLM_SECRET_KEYS);
}

export function resolveConnectorSecretRefs(
  env: Env,
  opts: ResolveOptions = {},
): Env {
  return resolveSecretRefs(env, opts, CONNECTOR_SECRET_KEYS);
}

export function resolveAllSecretRefs(
  env: Env,
  opts: ResolveOptions = {},
): Env {
  return resolveSecretRefs(env, opts, BLUE_TANUKI_SECRET_KEYS);
}

function resolveSecretRefs(
  env: Env,
  opts: ResolveOptions,
  keys: readonly BlueTanukiSecretKey[],
): Env {
  const platform = opts.platform ?? process.platform;
  const protector = opts.protector ?? (platform === "win32" ? defaultProtector() : undefined);
  const next: Env = { ...env };
  for (const key of keys) {
    if (next[key]) continue;
    const ref = next[secretRefKey(key)];
    if (!ref) continue;
    if (platform !== "win32" && !protector) {
      throw new Error(`${secretRefKey(key)} requires Windows DPAPI secret storage`);
    }
    const secretPath = pathFromRef(ref);
    const protectedValue = readFileSync(secretPath, "utf8").trim();
    if (!protectedValue) {
      throw new Error(`${secretRefKey(key)} points to an empty secret file`);
    }
    next[key] = (protector ?? defaultProtector()).unprotect(protectedValue);
  }
  return next;
}

export function llmSecretStorageStatus(
  env: Env,
  provider: string,
  platform: NodeJS.Platform = process.platform,
): LlmSecretStorageStatus {
  const key = llmApiKeyForProvider(provider) ?? null;
  const raw = key ? Boolean(env[key]) : false;
  const ref = key ? Boolean(env[secretRefKey(key)]) : false;
  const dpapi = ref && platform === "win32";
  return {
    configured_key: key,
    raw_env_present: raw,
    secret_ref_present: ref,
    os_protected: dpapi,
    storage: dpapi ? "win32_dpapi_current_user" : raw ? "env_file" : ref ? "unknown" : "unavailable",
    reason: dpapi
      ? "LLM API key is stored as a Windows DPAPI CurrentUser secret reference"
      : raw
      ? "LLM API key is present in process/env-file material"
      : ref
      ? "LLM API key reference is present but this platform cannot verify DPAPI protection"
      : "No LLM API key material is configured for this provider",
    used_for_authority: false,
    evidence_source: ["CONFIG"],
  };
}

export function connectorSecretStorageStatus(
  env: Env,
  key: ConnectorSecretKey,
  platform: NodeJS.Platform = process.platform,
): LlmSecretStorageStatus {
  const raw = Boolean(env[key]);
  const ref = Boolean(env[secretRefKey(key)]);
  const dpapi = ref && platform === "win32";
  return {
    configured_key: key,
    raw_env_present: raw,
    secret_ref_present: ref,
    os_protected: dpapi,
    storage: dpapi ? "win32_dpapi_current_user" : raw ? "env_file" : ref ? "unknown" : "unavailable",
    reason: dpapi
      ? `${key} is stored as a Windows DPAPI CurrentUser secret reference`
      : raw
      ? `${key} is present in process/env-file material`
      : ref
      ? `${key} reference is present but this platform cannot verify DPAPI protection`
      : `${key} is not configured`,
    used_for_authority: false,
    evidence_source: ["CONFIG"],
  };
}
