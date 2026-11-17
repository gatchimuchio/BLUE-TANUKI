import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { Entry } from "@napi-rs/keyring";
import { windowsSystemChildEnvironment } from "./child_process_environment.js";

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
  | "LINE_CHANNEL_ACCESS_TOKEN"
  | "BLUE_TANUKI_D4_RUNTIME_TOKEN";

export type BlueTanukiSecretKey = LlmSecretKey | ConnectorSecretKey;

export interface SecretProtector {
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
}

export interface SecretKeyringPort {
  setPassword(plaintext: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

export type SecretKeyringFactory = (
  platform: NodeJS.Platform,
  key: BlueTanukiSecretKey,
  entryId?: string,
) => SecretKeyringPort;

export interface LlmSecretStorageStatus {
  configured_key: BlueTanukiSecretKey | null;
  raw_env_present: boolean;
  secret_ref_present: boolean;
  os_protected: boolean;
  storage: "win32_dpapi_current_user" | "os_keyring_current_user" | "env_file" | "unavailable" | "unknown";
  reason: string;
  used_for_authority: false;
  evidence_source: readonly ["CONFIG"];
}

export interface LlmSecretStoreResult {
  key: BlueTanukiSecretKey;
  ref_key: string;
  ref: string;
  storage: "win32_dpapi_current_user" | "os_keyring_current_user";
  os_protected: true;
  used_for_authority: false;
  evidence_source: readonly ["EXTERNAL_EVIDENCE"];
  /** Remove only this newly created value if its reference was never committed. */
  discard_uncommitted: () => boolean;
}

interface StoreOptions {
  envFilePath: string;
  env?: Env;
  platform?: NodeJS.Platform;
  protector?: SecretProtector;
  keyringFactory?: SecretKeyringFactory;
}

interface ResolveOptions {
  platform?: NodeJS.Platform;
  protector?: SecretProtector;
  keyringFactory?: SecretKeyringFactory;
}

const SECRET_REF_PREFIX = "win32-dpapi-current-user:file:";
const OS_KEYRING_REF_PREFIX = "os-keyring:v1:";
const OS_KEYRING_REF_V2_PREFIX = "os-keyring:v2:";
const OS_KEYRING_SERVICE = "blue-tanuki";

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
  "BLUE_TANUKI_D4_RUNTIME_TOKEN",
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

function secretPathForKey(envFilePath: string, key: BlueTanukiSecretKey, env: Env, entryId: string): string {
  return path.join(secretDirForEnvFile(envFilePath, env), `${key.toLowerCase()}.${entryId}.dpapi`);
}

function refForPath(secretPath: string): string {
  return `${SECRET_REF_PREFIX}${encodePath(path.resolve(secretPath))}`;
}

function pathFromRef(ref: string): string {
  if (!ref.startsWith(SECRET_REF_PREFIX)) {
    throw new Error("unsupported secret ref format");
  }
  const encoded = ref.slice(SECRET_REF_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("unsupported secret ref format");
  }
  const decoded = decodePath(encoded);
  if (!path.isAbsolute(decoded)) {
    throw new Error("unsupported secret ref path");
  }
  return path.resolve(decoded);
}

function powershellCommand(): string {
  return process.env.BLUE_TANUKI_POWERSHELL ?? "powershell.exe";
}

function dpapiScript(commands: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
    ...commands,
  ].join("; ");
}

function protectWithDpapi(plaintext: string): string {
  const script = dpapiScript([
    "$plain = [Console]::In.ReadToEnd()",
    "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
    "ConvertFrom-SecureString -SecureString $secure",
  ]);
  const result = spawnSync(
    powershellCommand(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: windowsSystemChildEnvironment(),
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
  const script = dpapiScript([
    "$cipher = [Console]::In.ReadToEnd()",
    "$secure = ConvertTo-SecureString -String $cipher",
    "$credential = New-Object System.Management.Automation.PSCredential('blue-tanuki', $secure)",
    "$credential.GetNetworkCredential().Password",
  ]);
  const result = spawnSync(
    powershellCommand(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: windowsSystemChildEnvironment(),
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

function defaultKeyringFactory(
  platform: NodeJS.Platform,
  key: BlueTanukiSecretKey,
  entryId?: string,
): SecretKeyringPort {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`OS keyring secret storage is unsupported on ${platform}`);
  }
  if (platform !== process.platform) {
    throw new Error(`cannot access the ${platform} keyring from a ${process.platform} runtime`);
  }
  const account = entryId ? `${key}:${entryId}` : key;
  const entry = platform === "linux"
    ? new Entry(OS_KEYRING_SERVICE, account, { linux: { store: "secret-service" } })
    : new Entry(OS_KEYRING_SERVICE, account);
  return {
    setPassword: (plaintext) => entry.setPassword(plaintext),
    getPassword: () => entry.getPassword(),
    deletePassword: () => entry.deletePassword(),
  };
}

function osKeyringRef(platform: NodeJS.Platform, key: BlueTanukiSecretKey, entryId: string): string {
  return `os-keyring:v2:${platform}:${key}:${entryId}`;
}

function osKeyringEntryId(
  ref: string,
  platform: NodeJS.Platform,
  key: BlueTanukiSecretKey,
): string | undefined | null {
  if (platform !== "linux" && platform !== "darwin") return null;
  if (ref === `${OS_KEYRING_REF_PREFIX}${platform}:${key}`) return undefined;
  const match = /^os-keyring:v2:(linux|darwin):([A-Z0-9_]+):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(ref);
  if (!match || match[1] !== platform || match[2] !== key ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(match[3]!)) {
    return null;
  }
  return match[3];
}

function isMatchingOsKeyringRef(
  ref: string,
  platform: NodeJS.Platform,
  key: BlueTanukiSecretKey,
): boolean {
  return (platform === "linux" || platform === "darwin") && osKeyringEntryId(ref, platform, key) !== null;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function fileIsAbsent(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return false;
  } catch (error) {
    return isNodeErrorCode(error, "ENOENT");
  }
}

function discardStagedSecretFile(filePath: string): boolean {
  try {
    unlinkSync(filePath);
  } catch {
    // Verify absence below; a failed unlink is not treated as success.
  }
  return fileIsAbsent(filePath);
}

function discardStagedKeyringEntry(keyring: SecretKeyringPort): boolean {
  try {
    keyring.deletePassword();
  } catch { /* Verify absence below; a failed delete is not treated as success. */ }
  try {
    return keyring.getPassword() === null;
  } catch { return false; }
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
  if (!plaintext) throw new Error("refusing to store an empty secret");
  if (platform === "win32") {
    const protector = opts.protector ?? defaultProtector();
    const secretPath = secretPathForKey(opts.envFilePath, key, opts.env ?? {}, randomUUID());
    mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    let fileDescriptor: number | undefined;
    let ownsFile = false;
    try {
      const protectedValue = protector.protect(plaintext);
      fileDescriptor = openSync(secretPath, "wx", 0o600);
      ownsFile = true;
      writeFileSync(fileDescriptor, `${protectedValue}\n`, "utf8");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        // Windows ACLs are enforced by DPAPI CurrentUser; chmod is best-effort.
      }
      const readback = readFileSync(secretPath, "utf8").trim();
      if (!readback || protector.unprotect(readback) !== plaintext) {
        throw new Error("DPAPI secret readback did not match the supplied value");
      }
      return {
        key,
        ref_key: secretRefKey(key),
        ref: refForPath(secretPath),
        storage: "win32_dpapi_current_user",
        os_protected: true,
        used_for_authority: false,
        evidence_source: ["EXTERNAL_EVIDENCE"],
        discard_uncommitted: () => discardStagedSecretFile(secretPath),
      };
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try { closeSync(fileDescriptor); } catch { /* The descriptor may already be closed. */ }
      }
      if (ownsFile && !discardStagedSecretFile(secretPath)) {
        throw new Error("DPAPI secret storage failed and the staged secret file could not be removed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  if (opts.protector) {
    throw new Error("Windows DPAPI protector cannot be used as an OS keyring on this platform");
  }
  if (platform === "linux" || platform === "darwin") {
    const entryId = randomUUID();
    const keyring = (opts.keyringFactory ?? defaultKeyringFactory)(platform, key, entryId);
    try {
      keyring.setPassword(plaintext);
      if (keyring.getPassword() !== plaintext) {
        throw new Error("OS keyring secret readback did not match the supplied value");
      }
      return {
        key,
        ref_key: secretRefKey(key),
        ref: osKeyringRef(platform, key, entryId),
        storage: "os_keyring_current_user",
        os_protected: true,
        used_for_authority: false,
        evidence_source: ["EXTERNAL_EVIDENCE"],
        discard_uncommitted: () => discardStagedKeyringEntry(keyring),
      };
    } catch (error) {
      if (!discardStagedKeyringEntry(keyring)) {
        throw new Error("OS keyring secret storage failed and the staged entry could not be removed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  throw new Error(`OS-protected BLUE-TANUKI secret storage is unsupported on ${platform}`);
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

export function resolveSecretMaterial(
  env: Env,
  key: BlueTanukiSecretKey,
  opts: ResolveOptions = {},
): string | undefined {
  return resolveSecretRefs(env, opts, [key])[key];
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
    if (ref.startsWith(SECRET_REF_PREFIX)) {
      if (platform !== "win32") {
        throw new Error(`${secretRefKey(key)} requires Windows DPAPI secret storage`);
      }
      const secretPath = pathFromRef(ref);
      const protectedValue = readFileSync(secretPath, "utf8").trim();
      if (!protectedValue) {
        throw new Error(`${secretRefKey(key)} points to an empty secret file`);
      }
      next[key] = (protector ?? defaultProtector()).unprotect(protectedValue);
      continue;
    }

    if (ref.startsWith(OS_KEYRING_REF_PREFIX) || ref.startsWith(OS_KEYRING_REF_V2_PREFIX)) {
      const entryId = osKeyringEntryId(ref, platform, key);
      if (entryId === null) {
        throw new Error(`${secretRefKey(key)} does not match this platform or secret key`);
      }
      const keyring = (opts.keyringFactory ?? defaultKeyringFactory)(platform, key, entryId);
      const secret = keyring.getPassword();
      if (!secret) throw new Error(`${secretRefKey(key)} is not available in the OS keyring`);
      next[key] = secret;
      continue;
    }

    throw new Error(`${secretRefKey(key)} uses an unsupported secret ref format`);
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
  const refValue = key ? env[secretRefKey(key)] : undefined;
  const dpapi = !raw && ref && platform === "win32" && refValue?.startsWith(SECRET_REF_PREFIX) === true;
  const osKeyring = !raw && key !== null && refValue !== undefined && isMatchingOsKeyringRef(refValue, platform, key);
  const protectedStorage = dpapi
    ? "win32_dpapi_current_user"
    : osKeyring
    ? "os_keyring_current_user"
    : null;
  return {
    configured_key: key,
    raw_env_present: raw,
    secret_ref_present: ref,
    os_protected: protectedStorage !== null,
    storage: protectedStorage ?? (raw ? "env_file" : ref ? "unknown" : "unavailable"),
    reason: dpapi
      ? "LLM API key is stored as a Windows DPAPI CurrentUser secret reference"
      : osKeyring
      ? platform === "linux"
        ? "LLM API key is configured for the Linux Secret Service keyring"
        : "LLM API key is configured for the macOS Keychain"
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
  const refValue = env[secretRefKey(key)];
  const dpapi = !raw && ref && platform === "win32" && refValue?.startsWith(SECRET_REF_PREFIX) === true;
  const osKeyring = !raw && refValue !== undefined && isMatchingOsKeyringRef(refValue, platform, key);
  const protectedStorage = dpapi
    ? "win32_dpapi_current_user"
    : osKeyring
    ? "os_keyring_current_user"
    : null;
  return {
    configured_key: key,
    raw_env_present: raw,
    secret_ref_present: ref,
    os_protected: protectedStorage !== null,
    storage: protectedStorage ?? (raw ? "env_file" : ref ? "unknown" : "unavailable"),
    reason: dpapi
      ? `${key} is stored as a Windows DPAPI CurrentUser secret reference`
      : osKeyring
      ? platform === "linux"
        ? `${key} is configured for the Linux Secret Service keyring`
        : `${key} is configured for the macOS Keychain`
      : raw
      ? `${key} is present in process/env-file material`
      : ref
      ? `${key} reference is present but this platform cannot verify DPAPI protection`
      : `${key} is not configured`,
    used_for_authority: false,
    evidence_source: ["CONFIG"],
  };
}
