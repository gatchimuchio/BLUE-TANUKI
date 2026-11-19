import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { composioStatus, type SettingsWritePort } from "@blue-tanuki/core";
import type { WebChatSettingsSurface } from "@blue-tanuki/channel-webchat";
import { parseEnvFile, writeEnvFileAtomic } from "./env_file.js";
import { llmSettingsWriteEnvPatch, settingsWriteRequiresNativeCredentialEntry,
  SETTINGS_WRITE_GOOGLE_READ_CREDENTIAL_TARGETS, SettingsWriteGoogleReadCredentialScopeSchema,
  type SettingsWriteGoogleReadCredentialScope, type SettingsWriteLlmProvider, type SettingsWritePatch,
  type TelegramInboundGrant } from "@blue-tanuki/protocol";
import {
  setupConfigFromEnv,
  type SetupProviderKind,
} from "./setup_config.js";
import {
  describeLLMCommandRoute,
  describeLLMConfig,
} from "./llm_config.js";
import type { PluginRuntime } from "./plugin_loader.js";
import {
  assessLlmComputeReadiness,
  type LlmComputeReadiness,
  verifyLlmConfiguration,
} from "./control_center/setup/api_settings.js";
import { LLM_VERIFY_ROUTE } from "./control_center/setup/setup_page.js";
import { connectorSecretStorageStatus, isTelegramBotToken, llmApiKeyForProvider, llmSecretStorageStatus, secretRefKey,
  StagedSecretCleanupError, stageRuntimeBlueTanukiSecret, type LlmSecretStoreResult } from "./secret_store.js";
import { inspectLlmCredentialRotation, prepareLlmProviderActivation } from "./llm_provider_activation.js";
import { parseSlackInboundGrants } from "./slack_inbound_grants.js";
import { parseTelegramInboundGrants } from "./telegram_inbound_grants.js";
import { inspectMcpCatalogFromSettings, type McpCatalogProjection } from "./mcp_connection_client.js";
import { parseLoopbackMcpEndpoint } from "./mcp_endpoint.js";
import { mcpRuntimeObservationStore, type McpRuntimeObservationSnapshot,
  type McpRuntimeObservationStore } from "./mcp_connection_observation.js";

type Env = Record<string, string | undefined>;

export interface SettingsSurfaceOptions {
  env?: NodeJS.ProcessEnv;
  plugins: PluginRuntime;
  mcpRuntimeObservations?: McpRuntimeObservationStore;
  nativeCredentialPromptAvailable?: () => boolean;
  inspectCredentialRotation?: (provider: SettingsWriteLlmProvider) => Promise<boolean>;
  inspectGoogleReadCredentialRegistration?: (scope: SettingsWriteGoogleReadCredentialScope) => Promise<boolean>;
  inspectGitHubWriteCredentialRegistration?: () => Promise<boolean>;
  inspectTelegramBotCredentialRegistration?: () => Promise<boolean>;
  inspectTelegramBotInitialGrantRegistration?: () => Promise<boolean>;
}

function describeMcpRuntimeObservation(observation: McpRuntimeObservationSnapshot): string {
  switch (observation.last_call.state) {
    case "outcome_unknown":
      return "The last recorded MCP call may have taken effect, but no response was observed. Do not retry automatically. Inspect the target and service evidence before making a new reviewed decision.";
    case "dispatching":
      return "The last MCP call is in progress or its response has not been observed. Do not retry until its outcome is known.";
    case "response_received":
      break;
    case "not_observed":
      break;
  }
  if (observation.connection.state === "preflight_failed") {
    return "The latest MCP preflight failed before tool dispatch. Check the owner-managed local service and endpoint, then use a fresh Operation Plan.";
  }
  if (observation.last_call.state === "response_received") {
    return "The MCP server returned a valid response. This is not independent proof of an external effect; inspect the operation receipt and target state.";
  }
  if (observation.connection.state === "catalog_reachable") {
    return "The MCP catalog was reachable at the recorded time. This is not a live health monitor; use Load to refresh after a normal runtime call.";
  }
  return "No saved MCP runtime observation is available for this endpoint. This page does not probe the endpoint.";
}

export interface SettingsSnapshot {
  schema_version: 1;
  env_file: string | null;
  writable: false;
  write_block_reason: "settings_write_requires_hds_l3_final_review";
  google_read_credential_registration_available?: SettingsWriteGoogleReadCredentialScope[];
  github_write_credential_registration_available?: true;
  telegram_bot_credential_registration_available?: true;
  telegram_bot_initial_grant_registration_available?: true;
  approval: {
    mode: ReturnType<typeof setupConfigFromEnv>["approval"]["mode"];
    final_review_remains_required: true;
    used_for_authority: false;
  };
  llm: {
    provider: SetupProviderKind;
    model: string | null;
    endpoint: string | null;
    api_key_set: boolean;
    native_credential_prompt_available?: true;
    native_credential_rotation_available?: true;
    secret_storage: ReturnType<typeof llmSecretStorageStatus>;
    temperature: number | null;
    max_tokens: number | null;
    timeout_ms: number | null;
    compute_budget_policy_json: string;
    provider_cost_profiles_json: string;
    compute_readiness: LlmComputeReadiness;
    site_url: string | null;
    app_title: string | null;
    configured_providers: string[];
    command_route: ReturnType<typeof describeLLMCommandRoute>;
  };
  integrations: {
    native_first: true;
    slack: {
      status:
        | "plugin_unavailable"
        | "not_configured"
        | "incomplete_credentials"
        | "invalid_inbound_grants"
        | "inbound_denied"
        | "configured_unverified";
      plugin_available: boolean;
      bot_token_set: boolean;
      app_token_set: boolean;
      inbound_grants: "deny_all" | "invalid" | "configured";
      preview_only: true;
      live_connection_checked: false;
      used_for_authority: false;
      next_action: string;
    };
    mcp: {
      status: "not_configured" | "configured_unverified" | "invalid_endpoint";
      endpoint: string | null;
      live_connection_checked: false;
      used_for_authority: false;
      next_action: string;
      runtime_observation: McpRuntimeObservationSnapshot & { next_action: string };
    };
    openrouter: {
      configured: boolean;
      api_key_set: boolean;
      model: string | null;
      site_url: string | null;
      app_title: string | null;
      used_for_authority: false;
    };
    composio: ReturnType<typeof composioStatus> & {
      last_tool_call: null;
    };
    d4_runtime: {
      status: "not_configured" | "incomplete_credentials" | "configured_unverified";
      runtime_id_set: boolean;
      token_set: boolean;
      secret_storage: ReturnType<typeof connectorSecretStorageStatus>;
      live_connection_checked: false;
      used_for_authority: false;
      next_action: string;
    };
  };
  webchat: {
    host: string;
    port: number;
    token_set: boolean;
    resume_token_set: boolean;
    maintenance_token_set: boolean;
    settings_token_set: boolean;
  };
  paths: {
    file_root: string;
    shell_root: string | null;
    session_dir: string;
    audit_dir: string;
  };
  plugins: Array<{
    name: string;
    kind: string;
    permissions: string[];
  }>;
}


function boolEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function settingsSurfaceAllowed(env: Env): boolean {
  if (!envValue(env, "BLUE_TANUKI_SETTINGS_TOKEN")) return false;
  if (isLoopbackHost(env.WEBCHAT_HOST)) return true;
  return boolEnv(env.BLUE_TANUKI_ENABLE_SETTINGS);
}

function envValue(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

async function readEnvFileEnv(filePath: string | undefined): Promise<Env> {
  if (!filePath) return {};
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw ? parseEnvFile(raw).values : {};
}

function envFilePath(env: Env): string | undefined {
  const raw = env.BLUE_TANUKI_ENV_FILE;
  return raw && raw.trim().length > 0 ? path.resolve(raw) : undefined;
}

type NativeCredentialRegistration = {
  available(): boolean;
  request(provider: "anthropic" | "openai" | "openrouter", signal: AbortSignal): Promise<Buffer | null>;
  requestGoogleRead?(scope: SettingsWriteGoogleReadCredentialScope, signal: AbortSignal): Promise<Buffer | null>;
  requestGitHubWrite?(signal: AbortSignal): Promise<Buffer | null>;
  requestTelegramBot?(signal: AbortSignal): Promise<Buffer | null>;
  readTelegramInitialInboundGrant?(digest: string): Readonly<TelegramInboundGrant> | undefined;
  assertCurrent(commandDigest: string): void;
};

async function assertLocalCredentialTarget(target: string, file: { mode: number; uid: number }, env: Env): Promise<void> {
  const parent = path.dirname(path.resolve(target));
  const physicalParent = await fs.realpath(parent);
  if (process.platform !== "win32") {
    const directory = await fs.stat(physicalParent);
    const owner = process.geteuid?.();
    if (physicalParent !== parent || owner === undefined || owner === 0 ||
        file.uid !== owner || (file.mode & 0o077) !== 0 || directory.uid !== owner || (directory.mode & 0o022) !== 0) {
      throw new Error("llm_credential_registration_target_unavailable");
    }
    return;
  }
  if (physicalParent.toLowerCase() !== parent.toLowerCase() || !/^[A-Za-z]:\\/u.test(physicalParent)) {
    throw new Error("llm_credential_registration_target_unavailable");
  }
  const syncedRoots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial];
  if (syncedRoots.some((root) => {
    if (!root) return false;
    const relative = path.relative(path.resolve(root).toLowerCase(), physicalParent.toLowerCase());
    return !relative || (!relative.startsWith("..\\") && relative !== ".." && !path.isAbsolute(relative));
  })) throw new Error("llm_credential_registration_target_unavailable");
  try {
    const directory = await fs.lstat(path.join(physicalParent, "secrets"));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("llm_credential_registration_target_unavailable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createGatewaySettingsWritePort(env: Env = process.env,
  inheritedEnvKeys: readonly string[] = [], nativeRegistration?: NativeCredentialRegistration): SettingsWritePort {
  const bindingKey = randomBytes(32);
  let writeTail: Promise<void> = Promise.resolve();
  const serializeWrite = async <T>(write: () => Promise<T>): Promise<T> => {
    const previous = writeTail;
    let release!: () => void;
    writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await write();
    } finally {
      release();
    }
  };
  const managedLlmKeys = /^(?:LLM_(?:BACKEND|DEFAULT_BACKEND|MODEL)|ANTHROPIC_MODEL|OPENAI_MODEL|OPENAI_COMPAT_MODEL|OPENROUTER_MODEL|BLUE_TANUKI_LLM_(?:BACKEND_HINT|MODEL|TEMPERATURE|MAX_TOKENS|TIMEOUT_MS))$/i;
  const hasInheritedLlmSettings = inheritedEnvKeys.some((key) => managedLlmKeys.test(key));
  const defaultLlmProvider = (config: Env) => (envValue(config, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub").trim().toLowerCase();
  const hasAlternateLlmRoute = (config: Env) => Boolean(envValue(config, "BLUE_TANUKI_LLM_BACKEND_HINT", "LLM_PROVIDERS_JSON",
    "BLUE_TANUKI_LLM_FALLBACK_BACKEND", "BLUE_TANUKI_LLM_FALLBACK_AUTHORIZATION_JSON"));
  const inspectCurrent = async (expectedLlmProvider?: SettingsWriteLlmProvider,
    llmPatch?: NonNullable<SettingsWritePatch["llm"]>, googleScope?: SettingsWriteGoogleReadCredentialScope,
    githubWriteRegistration?: true, telegramBotRegistration?: true | string, telegramInitialReadiness?: true) => {
    const target = envFilePath(env);
    if (!target) throw new Error("settings_write_env_file_unavailable");
    const before = await fs.lstat(target).catch(() => undefined);
    if (!before || !before.isFile() || before.isSymbolicLink()) {
      throw new Error("settings_write_target_not_regular_file");
    }
    const rawBytes = await fs.readFile(target);
    const after = await fs.lstat(target).catch(() => undefined);
    if (!after || !after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        rawBytes.byteLength !== after.size) {
      throw new Error("settings_write_target_changed_during_observation");
    }
    const raw = rawBytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(rawBytes)) throw new Error("settings_write_env_file_not_utf8");
    let parsed: ReturnType<typeof parseEnvFile>;
    try { parsed = parseEnvFile(raw); }
    catch { throw new Error("settings_write_env_file_malformed"); }
    if (parsed.warnings.length > 0) throw new Error("settings_write_env_file_malformed");
    const configuredEnv = { ...env, ...parsed.values };
    const config = setupConfigFromEnv(configuredEnv);
    const boundModel = expectedLlmProvider !== undefined
      ? envValue(configuredEnv, "BLUE_TANUKI_LLM_MODEL") ?? config.llm.model ??
        (config.llm.provider === "stub" ? envValue(configuredEnv, "LLM_MODEL") : undefined)
      : config.llm.model;
    const targetStateDigest = createHmac("sha256", bindingKey)
      .update(JSON.stringify([path.resolve(target), String(after.dev), String(after.ino), after.size,
        after.mtimeMs, after.ctimeMs]), "utf8")
      .update(rawBytes)
      .digest("hex");
    const managedLlmSettings = env.BLUE_TANUKI_SAFE_MODE !== "1" && !hasInheritedLlmSettings &&
      !hasAlternateLlmRoute(env) && !hasAlternateLlmRoute(configuredEnv) &&
      defaultLlmProvider(env) === config.llm.provider && defaultLlmProvider(configuredEnv) === config.llm.provider;
    const managedTarget = expectedLlmProvider === config.llm.provider && managedLlmSettings;
    if (llmPatch && settingsWriteRequiresNativeCredentialEntry({ llm: llmPatch }) && managedTarget) {
      if (!nativeRegistration?.available()) throw new Error("llm_credential_registration_unavailable");
      await assertLocalCredentialTarget(target, after, env);
    }
    const telegramRegistrationRequested = Boolean(telegramBotRegistration || telegramInitialReadiness);
    const firstRegistration = telegramRegistrationRequested ? {
      key: "TELEGRAM_BOT_TOKEN" as const, prefix: "telegram_bot_credential_registration",
    } : githubWriteRegistration ? {
      key: "GITHUB_TOKEN" as const, prefix: "github_write_credential_registration",
    } : googleScope !== undefined ? {
      key: SETTINGS_WRITE_GOOGLE_READ_CREDENTIAL_TARGETS[SettingsWriteGoogleReadCredentialScopeSchema.parse(googleScope)].key,
      prefix: "google_read_credential_registration",
    } : undefined;
    let initialTelegramInboundGrant: Readonly<TelegramInboundGrant> | undefined;
    if (firstRegistration) {
      const { key, prefix } = firstRegistration;
      const prompt = telegramRegistrationRequested ? nativeRegistration?.requestTelegramBot :
        githubWriteRegistration ? nativeRegistration?.requestGitHubWrite : nativeRegistration?.requestGoogleRead;
      if (env.BLUE_TANUKI_SAFE_MODE === "1" || !prompt || !nativeRegistration?.available()) {
        throw new Error(`${prefix}_unavailable`);
      }
      const settingsKeys = Object.keys(parsed.values).map((name) => process.platform === "win32" ? name.toUpperCase() : name);
      const assignments = raw.split(/\r?\n/u).filter((line) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(line));
      if (new Set(settingsKeys).size !== assignments.length) throw new Error("settings_write_target_key_duplicated");
      const referenceKey = secretRefKey(key);
      const occupied = [...Object.keys(parsed.values), ...Object.keys(env), ...inheritedEnvKeys]
        .some((name) => name.toUpperCase() === key || name.toUpperCase() === referenceKey);
      if (occupied) throw new Error(`${prefix}_slot_configured`);
      if (telegramRegistrationRequested) {
        const grantsKey = "TELEGRAM_INBOUND_GRANTS_JSON";
        if (inheritedEnvKeys.some(name => name.toUpperCase() === grantsKey) ||
            Object.keys(parsed.values).some(name => name !== grantsKey && name.toUpperCase() === grantsKey)) {
          throw new Error("telegram_bot_credential_registration_grants_conflict");
        }
        const grants = parseTelegramInboundGrants(parsed.values[grantsKey]);
        if (telegramBotRegistration === true) {
          if (grants.length === 0) throw new Error("telegram_bot_credential_registration_saved_grants_required");
        } else {
          if (grants.length > 0) throw new Error("telegram_bot_credential_registration_grants_configured");
          if (typeof telegramBotRegistration === "string") {
            initialTelegramInboundGrant = nativeRegistration?.readTelegramInitialInboundGrant?.(telegramBotRegistration);
            if (!initialTelegramInboundGrant) throw new Error("telegram_bot_credential_registration_grant_unavailable");
          }
        }
      }
      await assertLocalCredentialTarget(target, after, env);
    }
    const activationUpdates = llmPatch?.activation && managedTarget
      ? prepareLlmProviderActivation(llmPatch, config.llm.provider, parsed.values, configuredEnv, inheritedEnvKeys)
      : undefined;
    const credentialRotation = llmPatch?.rotate_credential && managedTarget
      ? inspectLlmCredentialRotation(llmPatch, config.llm.provider, target, parsed.values, configuredEnv, env, inheritedEnvKeys)
      : undefined;
    if (credentialRotation) {
      // Confirm the reviewed reference is uniquely addressed before opening the native input dialog.
      replaceCredentialRefLine(raw, credentialRotation.referenceKey);
    }
    return {
      target,
      raw,
      target_state_digest: targetStateDigest,
      llm_provider: config.llm.provider,
      managed_llm_settings: managedLlmSettings,
      activationUpdates,
      credentialRotation,
      firstRegistration,
      initialTelegramInboundGrant,
      values: {
        model: boundModel ?? null,
        temperature: config.llm.temperature ?? null,
        max_tokens: config.llm.max_tokens ?? null,
        timeout_ms: config.llm.timeout_ms ?? null,
        composio: {
          api_key_configured: Boolean(config.composio.api_key || config.composio.api_key_ref),
          user_id: config.composio.user_id || null,
          allowed_toolkits: config.composio.allowed_toolkits || null,
          allowed_actions: config.composio.allowed_actions || null,
          revoked_actions: config.composio.revoked_actions || null,
          api_base_url: config.composio.api_base_url || null,
          dry_run: config.composio.dry_run,
          live_execution: config.composio.live_execution,
        },
      },
    };
  };
  return {
    inspect: async (expectedLlmProvider, llmPatch, googleScope, githubWriteRegistration, telegramBotRegistration,
      telegramInitialReadiness) => {
      const { target_state_digest, llm_provider, managed_llm_settings, values, activationUpdates, credentialRotation,
        firstRegistration } = await inspectCurrent(expectedLlmProvider, llmPatch, googleScope, githubWriteRegistration,
        telegramBotRegistration, telegramInitialReadiness);
      return { target_state_digest, llm_provider, managed_llm_settings, values,
        ...(activationUpdates ? { provider_activation_ready: true as const } : {}),
        ...(credentialRotation ? { credential_rotation_ready: true as const } : {}),
        ...(firstRegistration?.key === "TELEGRAM_BOT_TOKEN" ? { telegram_bot_registration_ready: true as const } :
          firstRegistration?.key === "GITHUB_TOKEN" ? { github_write_registration_ready: true as const } :
          firstRegistration ? { google_read_registration_ready: true as const } : {}) };
    },
    apply: async (patch: SettingsWritePatch, expectedTargetStateDigest: string, expectedLlmProvider, context) => serializeWrite(async () => {
      const llmPatch = patch.llm;
      const activation = llmPatch?.activation;
      const googleScope = patch.google_read?.register_credential;
      const githubWriteRegistration = patch.github_write?.register_credential;
      const telegramBotRegistration = patch.telegram?.initial_inbound_grant_digest ?? patch.telegram?.register_credential;
      const state = await inspectCurrent(expectedLlmProvider, llmPatch, googleScope, githubWriteRegistration, telegramBotRegistration);
      if (!/^[a-f0-9]{64}$/.test(expectedTargetStateDigest) ||
          state.target_state_digest !== expectedTargetStateDigest) {
        throw new Error("settings_write_target_changed_before_invoke");
      }
      if (expectedLlmProvider !== undefined &&
          (!patch.llm || state.llm_provider !== expectedLlmProvider || !state.managed_llm_settings)) {
        throw new Error("settings_write_bound_llm_target_unavailable");
      }
      if (activation && !state.activationUpdates) throw new Error("llm_activation_not_ready");
      if (llmPatch?.rotate_credential && !state.credentialRotation) throw new Error("llm_credential_rotation_not_ready");
      const credentialProvider = state.credentialRotation?.provider ?? (activation?.register_credential ? activation.provider : undefined);
      const credentialKey = state.firstRegistration?.key ?? (credentialProvider ? llmApiKeyForProvider(credentialProvider) : undefined);
      const registrationPrefix = state.firstRegistration?.prefix ?? "llm_credential_registration";
      const updates = state.activationUpdates ??
        (patch.llm ? llmSettingsWriteEnvPatch(patch.llm, state.llm_provider, expectedLlmProvider !== undefined) : {});
      const composio = patch.composio;
      if (composio) {
        if (composio.user_id !== undefined) updates.COMPOSIO_USER_ID = composio.user_id ?? "";
        if (composio.allowed_toolkits !== undefined) updates.COMPOSIO_ALLOWED_TOOLKITS = composio.allowed_toolkits ?? "";
        if (composio.allowed_actions !== undefined) updates.COMPOSIO_ALLOWED_ACTIONS = composio.allowed_actions ?? "";
        if (composio.revoked_actions !== undefined) updates.COMPOSIO_REVOKED_ACTIONS = composio.revoked_actions ?? "";
        if (composio.api_base_url !== undefined) updates.COMPOSIO_API_BASE_URL = composio.api_base_url ?? "";
        if (composio.clear_api_key === true) {
          updates.COMPOSIO_API_KEY = "";
          updates.COMPOSIO_API_KEY_REF = "";
          updates.COMPOSIO_DRY_RUN = "true";
          updates.COMPOSIO_LIVE_EXECUTION = "false";
        } else {
          if (composio.dry_run !== undefined) updates.COMPOSIO_DRY_RUN = String(composio.dry_run);
          if (composio.live_execution !== undefined) updates.COMPOSIO_LIVE_EXECUTION = String(composio.live_execution);
        }
      }
      if (!credentialKey && Object.keys(updates).length === 0) throw new Error("settings_write_patch_has_no_effect");
      const recheckTarget = async () => {
        const latest = await inspectCurrent(expectedLlmProvider, llmPatch, googleScope, githubWriteRegistration, telegramBotRegistration);
        if (latest.target_state_digest !== expectedTargetStateDigest || latest.target !== state.target) {
          throw new Error("settings_write_target_changed_before_persist");
        }
        if (expectedLlmProvider !== undefined &&
            (latest.llm_provider !== expectedLlmProvider || !latest.managed_llm_settings)) {
          throw new Error("settings_write_bound_llm_target_unavailable");
        }
        if (activation && !latest.activationUpdates) throw new Error("llm_activation_not_ready");
        if (llmPatch?.rotate_credential && !latest.credentialRotation) throw new Error("llm_credential_rotation_not_ready");
      };
      let stored: LlmSecretStoreResult<boolean | Promise<boolean>> | undefined;
      let replacementAttempted = false;
      let content: string;
      const recheckRegistration = () => {
        if (!nativeRegistration || !context?.signal || context.signal.aborted) {
          throw new Error(`${registrationPrefix}_not_authorized`);
        }
        nativeRegistration.assertCurrent(context.command_digest);
        context.assert_current();
      };
      try {
        if (credentialKey) {
          if (!nativeRegistration || !context?.signal) throw new Error(`${registrationPrefix}_not_authorized`);
          recheckRegistration();
          const credential = telegramBotRegistration ? await nativeRegistration.requestTelegramBot?.(context.signal)
            : githubWriteRegistration ? await nativeRegistration.requestGitHubWrite?.(context.signal)
            : googleScope !== undefined
            ? await nativeRegistration.requestGoogleRead?.(googleScope, context.signal)
            : credentialProvider && await nativeRegistration.request(credentialProvider, context.signal);
          if (!credential) throw new Error(`${registrationPrefix}_cancelled`);
          try {
            await recheckTarget();
            recheckRegistration();
            const secret = credential.toString("utf8");
            if (telegramBotRegistration && !isTelegramBotToken(secret)) {
              throw new Error("telegram_bot_credential_registration_token_invalid");
            }
            try {
              stored = await stageRuntimeBlueTanukiSecret(credentialKey, secret, state.target);
            } catch (error) {
              if (error instanceof StagedSecretCleanupError) {
                throw new Error(`${registrationPrefix}_outcome_unknown`);
              }
              throw new Error(`${registrationPrefix}_storage_failed`);
            }
            if (state.firstRegistration && stored.ref_key !== secretRefKey(state.firstRegistration.key)) {
              throw new Error(`${registrationPrefix}_storage_binding_mismatch`);
            }
            if (state.credentialRotation && (stored.ref_key !== state.credentialRotation.referenceKey || stored.ref === state.credentialRotation.reference)) {
              // Keep the existing credential even if storage unexpectedly returns its identity.
              if (stored.ref === state.credentialRotation.reference) stored = undefined;
              throw new Error("llm_credential_rotation_storage_binding_mismatch");
            }
            updates[stored.ref_key] = stored.ref;
          } finally { credential.fill(0); }
        }
        if (state.credentialRotation) {
          if (!stored) throw new Error("llm_credential_rotation_storage_binding_mismatch");
          content = replaceCredentialRefLine(state.raw, state.credentialRotation.referenceKey, stored.ref);
        } else if (state.initialTelegramInboundGrant && stored) {
          updates.TELEGRAM_INBOUND_GRANTS_JSON = JSON.stringify([state.initialTelegramInboundGrant]);
          content = patchEnvDocument(state.raw, updates);
        } else if (state.firstRegistration && stored) {
          const newline = state.raw.includes("\r\n") ? "\r\n" : "\n";
          const separator = state.raw && !state.raw.endsWith("\n") ? newline : "";
          content = `${state.raw}${separator}${stored.ref_key}=${JSON.stringify(stored.ref)}${newline}`;
        } else {
          content = patchEnvDocument(state.raw, updates);
        }
        await recheckTarget();
        if (stored) recheckRegistration();
        await writeEnvFileAtomic(state.target, content, { mode: 0o600, backup: true, backup_label: "settings-write",
          ...(stored ? { before_replace: async () => {
            await recheckTarget();
            recheckRegistration();
            replacementAttempted = true;
          } } : {}) });
      } catch (error) {
        if (stored) {
          const current = replacementAttempted ? await inspectCurrent(expectedLlmProvider).catch(() => undefined) : undefined;
          if ((replacementAttempted && current?.target_state_digest !== expectedTargetStateDigest) || !(await stored.discard_uncommitted())) {
            throw new Error(`${registrationPrefix}_outcome_unknown`);
          }
        }
        if (credentialKey) {
          const message = error instanceof Error ? error.message : "";
          throw new Error(/^(?:(?:llm_credential_(?:prompt|registration|rotation)|(?:google_read|github_write|telegram_bot)_credential_(?:prompt|registration))_[a-z_]+|settings_write_target_changed_before_persist)$/u.test(message)
            ? message : `${registrationPrefix}_failed`);
        }
        throw error;
      }
      const saved = await inspectCurrent(expectedLlmProvider).catch((error: unknown) => {
        if (stored) throw new Error(`${registrationPrefix}_outcome_unknown`);
        throw error;
      });
      if (state.credentialRotation && (saved.raw !== content || saved.llm_provider !== state.credentialRotation.provider)) {
        throw new Error("llm_credential_rotation_outcome_unknown");
      }
      if (state.firstRegistration && saved.raw !== content) {
        throw new Error(`${registrationPrefix}_outcome_unknown`);
      }
      if (activation) {
        const observed = parseEnvFile(saved.raw);
        if (saved.llm_provider !== activation.provider ||
            Object.entries(updates).some(([key, value]) => observed.values[key] !== value)) {
          throw new Error(stored ? "llm_credential_registration_outcome_unknown" : "llm_activation_readback_mismatch");
        }
      }
      const expectedValues = {
        model: patch.llm?.model ?? state.values.model,
        temperature: patch.llm?.temperature ?? state.values.temperature,
        max_tokens: patch.llm?.max_tokens ?? state.values.max_tokens,
        timeout_ms: patch.llm?.timeout_ms ?? state.values.timeout_ms,
        composio: {
          ...state.values.composio,
          ...(composio?.clear_api_key === true ? { api_key_configured: false, dry_run: true, live_execution: false } : {}),
          ...(composio?.user_id !== undefined ? { user_id: composio.user_id } : {}),
          ...(composio?.allowed_toolkits !== undefined ? { allowed_toolkits: composio.allowed_toolkits } : {}),
          ...(composio?.allowed_actions !== undefined ? { allowed_actions: composio.allowed_actions } : {}),
          ...(composio?.revoked_actions !== undefined ? { revoked_actions: composio.revoked_actions } : {}),
          ...(composio?.api_base_url !== undefined ? { api_base_url: composio.api_base_url } : {}),
          ...(composio?.clear_api_key !== true && composio?.dry_run !== undefined ? { dry_run: composio.dry_run } : {}),
          ...(composio?.clear_api_key !== true && composio?.live_execution !== undefined
            ? { live_execution: composio.live_execution } : {}),
        },
      };
      if (JSON.stringify(saved.values) !== JSON.stringify(expectedValues)) {
        throw new Error(stored ? `${registrationPrefix}_outcome_unknown` : "settings_write_readback_mismatch");
      }
      return { changed_keys: Object.keys(updates).sort(), restart_required: true as const };
    }),
  };
}

function replaceCredentialRefLine(raw: string, referenceKey: string, replacement?: string): string {
  let matches = 0;
  const content = raw.split(/(\r?\n)/u).map((line) => {
    const entry = /^(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)/u.exec(line);
    if (entry?.[2] !== referenceKey) return line;
    matches += 1;
    return replacement === undefined ? line : `${entry[1]}${JSON.stringify(replacement)}`;
  }).join("");
  if (matches > 1) throw new Error("settings_write_target_key_duplicated");
  if (matches !== 1) throw new Error("llm_credential_rotation_target_unavailable");
  return content;
}

function patchEnvDocument(raw: string, updates: Record<string, string>): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/u);
  if (finalNewline) lines.pop();
  const seen = new Set<string>();
  const remaining = new Map(Object.entries(updates));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    const key = match?.[1];
    if (!key || !remaining.has(key)) continue;
    if (seen.has(key)) throw new Error("settings_write_target_key_duplicated");
    seen.add(key);
    lines[index] = `${key}=${JSON.stringify(remaining.get(key))}`;
    remaining.delete(key);
  }
  for (const [key, value] of remaining) lines.push(`${key}=${JSON.stringify(value)}`);
  return lines.join(newline) + (finalNewline || lines.length > 0 ? newline : "");
}

function apiKeySet(env: Env, provider: SetupProviderKind): boolean {
  if (provider === "anthropic") {
    return Boolean(envValue(env, "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_REF"));
  }
  if (provider === "openai") {
    return Boolean(
      envValue(
        env,
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_REF",
        "LLM_API_KEY",
        "LLM_API_KEY_REF",
      ),
    );
  }
  if (provider === "openai-compatible") {
    return Boolean(
      envValue(
        env,
        "OPENAI_COMPAT_API_KEY",
        "OPENAI_COMPAT_API_KEY_REF",
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_REF",
        "LLM_API_KEY",
        "LLM_API_KEY_REF",
      ),
    );
  }
  if (provider === "openrouter") {
    return Boolean(envValue(env, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_REF"));
  }
  return false;
}

export function buildSettingsSnapshot(
  env: Env,
  plugins: PluginRuntime,
  mcpObservations: McpRuntimeObservationStore = mcpRuntimeObservationStore,
): SettingsSnapshot {
  const config = setupConfigFromEnv(env);
  const composio = composioStatus(env);
  const composioKeyConfigured = composio.configured || Boolean(envValue(env, "COMPOSIO_API_KEY_REF"));
  const slackPluginAvailable = plugins.plugins.some(
    (plugin) => plugin.manifest.name === "@blue-tanuki/channel-slack",
  );
  const slackBotTokenSet = Boolean(envValue(env, "SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN_REF"));
  const slackAppTokenSet = Boolean(envValue(env, "SLACK_APP_TOKEN", "SLACK_APP_TOKEN_REF"));
  let slackInboundGrants: SettingsSnapshot["integrations"]["slack"]["inbound_grants"] = "deny_all";
  if (envValue(env, "SLACK_INBOUND_GRANTS_JSON")) {
    try {
      slackInboundGrants = parseSlackInboundGrants(env.SLACK_INBOUND_GRANTS_JSON).length > 0
        ? "configured"
        : "deny_all";
    } catch {
      slackInboundGrants = "invalid";
    }
  }
  const slackCredentialsComplete = slackBotTokenSet && slackAppTokenSet;
  const slackStatus: SettingsSnapshot["integrations"]["slack"]["status"] = !slackPluginAvailable
    ? "plugin_unavailable"
    : !slackBotTokenSet && !slackAppTokenSet
      ? "not_configured"
      : !slackCredentialsComplete
        ? "incomplete_credentials"
        : slackInboundGrants === "invalid"
          ? "invalid_inbound_grants"
          : slackInboundGrants === "deny_all"
            ? "inbound_denied"
            : "configured_unverified";
  const slackNextAction = slackStatus === "plugin_unavailable"
    ? "Install or enable @blue-tanuki/channel-slack, then reload this status."
    : slackStatus === "not_configured"
      ? "To configure Slack, set both protected SLACK_BOT_TOKEN_REF and SLACK_APP_TOKEN_REF values, then restart the Gateway."
      : slackStatus === "incomplete_credentials"
        ? "Configure both Slack tokens through protected local secret references, then restart the Gateway."
        : slackStatus === "invalid_inbound_grants"
          ? "Correct SLACK_INBOUND_GRANTS_JSON; invalid grants fail closed and are not admitted."
          : slackStatus === "inbound_denied"
            ? "Inbound is deny-all. Add exact owner-maintained grants only if Slack inbound is intended."
            : "Configuration is present but unverified. Use an approved dedicated Slack test workspace to check connect, receive, reply, recovery, and disconnect.";
  const mcpEndpointRaw = envValue(env, "BLUE_TANUKI_MCP_ENDPOINT");
  let mcpStatus: SettingsSnapshot["integrations"]["mcp"]["status"] = "not_configured";
  let mcpEndpoint: string | null = null;
  let mcpNextAction = "Set a credentialless loopback Streamable HTTP endpoint, start its dedicated local MCP server, then restart Gateway. No connection has been tested.";
  if (mcpEndpointRaw) {
    try {
      mcpEndpoint = parseLoopbackMcpEndpoint(mcpEndpointRaw).href;
      mcpStatus = "configured_unverified";
      mcpNextAction = "The endpoint is configured. This page does not probe connectivity. If settings changed, restart Gateway; otherwise use the last runtime observation below and select an MCP tool, fixed resource, or prompt only through an Operation Plan with High/L3 review.";
    } catch {
      mcpStatus = "invalid_endpoint";
      mcpNextAction = "The stored endpoint is invalid and is hidden. Replace it with a credentialless 127.0.0.1 or ::1 HTTP/HTTPS endpoint without userinfo, query, or fragment, then restart Gateway.";
    }
  }
  const mcpRuntimeObservation = mcpObservations.snapshot(mcpEndpoint ?? undefined);
  const mcpRuntimeNextAction = describeMcpRuntimeObservation(mcpRuntimeObservation);
  const d4RuntimeIdSet = Boolean(envValue(env, "BLUE_TANUKI_D4_RUNTIME_ID"));
  const d4RuntimeTokenSet = Boolean(envValue(
    env,
    "BLUE_TANUKI_D4_RUNTIME_TOKEN",
    "BLUE_TANUKI_D4_RUNTIME_TOKEN_REF",
  ));
  const d4RuntimeStatus = d4RuntimeIdSet && d4RuntimeTokenSet
    ? "configured_unverified" as const
    : d4RuntimeIdSet || d4RuntimeTokenSet
      ? "incomplete_credentials" as const
      : "not_configured" as const;
  const d4RuntimeNextAction = d4RuntimeStatus === "configured_unverified"
    ? "Dedicated Gateway credentials are present. Connectivity is not probed here, and the D4 application consumer still needs its own integration. Restart Gateway after changing the credentials."
    : d4RuntimeStatus === "incomplete_credentials"
      ? "Configure BLUE_TANUKI_D4_RUNTIME_ID and BLUE_TANUKI_D4_RUNTIME_TOKEN together, store the token through setup or the OS-protected secret reference, then restart Gateway."
      : "D4 Runtime endpoints remain disabled until a matching runtime ID and protected token are configured.";
  return {
    schema_version: 1,
    env_file: envFilePath(env) ?? null,
    writable: false,
    write_block_reason: "settings_write_requires_hds_l3_final_review",
    approval: {
      mode: config.approval.mode,
      final_review_remains_required: true,
      used_for_authority: false,
    },
    llm: {
      provider: config.llm.provider,
      model: config.llm.model ?? null,
      endpoint: config.llm.endpoint ?? null,
      api_key_set: apiKeySet(env, config.llm.provider),
      secret_storage: llmSecretStorageStatus(env, config.llm.provider),
      temperature: config.llm.temperature ?? null,
      max_tokens: config.llm.max_tokens ?? null,
      timeout_ms: config.llm.timeout_ms ?? null,
      compute_budget_policy_json: config.llm.compute_budget_policy_json ?? "",
      provider_cost_profiles_json: config.llm.provider_cost_profiles_json ?? "",
      compute_readiness: assessLlmComputeReadiness(env),
      site_url: config.llm.site_url ?? null,
      app_title: config.llm.app_title ?? null,
      configured_providers: describeLLMConfig(env).configured_providers,
      command_route: describeLLMCommandRoute(env),
    },
    integrations: {
      native_first: true,
      slack: {
        status: slackStatus,
        plugin_available: slackPluginAvailable,
        bot_token_set: slackBotTokenSet,
        app_token_set: slackAppTokenSet,
        inbound_grants: slackInboundGrants,
        preview_only: true,
        live_connection_checked: false,
        used_for_authority: false,
        next_action: slackNextAction,
      },
      mcp: {
        status: mcpStatus,
        endpoint: mcpEndpoint,
        live_connection_checked: false,
        used_for_authority: false,
        next_action: mcpNextAction,
        runtime_observation: { ...mcpRuntimeObservation, next_action: mcpRuntimeNextAction },
      },
      openrouter: {
        configured: Boolean(
          envValue(env, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_REF") &&
            envValue(env, "OPENROUTER_MODEL", "LLM_MODEL"),
        ),
        api_key_set: Boolean(envValue(env, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_REF")),
        model: envValue(env, "OPENROUTER_MODEL", "LLM_MODEL") ?? null,
        site_url: envValue(env, "OPENROUTER_SITE_URL") ?? null,
        app_title: envValue(env, "OPENROUTER_APP_TITLE") ?? null,
        used_for_authority: false,
      },
      composio: {
        ...composio,
        configured: composioKeyConfigured,
        connection_revoke_available: composio.connection_revoke_available || composioKeyConfigured,
        last_tool_call: null,
      },
      d4_runtime: {
        status: d4RuntimeStatus,
        runtime_id_set: d4RuntimeIdSet,
        token_set: d4RuntimeTokenSet,
        secret_storage: connectorSecretStorageStatus(env, "BLUE_TANUKI_D4_RUNTIME_TOKEN"),
        live_connection_checked: false,
        used_for_authority: false,
        next_action: d4RuntimeNextAction,
      },
    },
    webchat: {
      host: config.webchat.host,
      port: config.webchat.port,
      token_set: Boolean(envValue(env, "WEBCHAT_TOKEN")),
      resume_token_set: Boolean(envValue(env, "WEBCHAT_RESUME_TOKEN")),
      maintenance_token_set: Boolean(envValue(env, "BLUE_TANUKI_MAINTENANCE_TOKEN")),
      settings_token_set: Boolean(envValue(env, "BLUE_TANUKI_SETTINGS_TOKEN")),
    },
    paths: {
      file_root: config.paths.file_root,
      shell_root: config.paths.shell_root ?? null,
      session_dir: config.paths.session_dir,
      audit_dir: config.paths.audit_dir,
    },
    plugins: plugins.plugins.map((plugin) => ({
      name: plugin.manifest.name,
      kind: plugin.manifest.kind,
      permissions: [...plugin.manifest.permissions].sort(),
    })),
  };
}

export function createWebChatSettingsSurface(
  opts: SettingsSurfaceOptions,
): WebChatSettingsSurface | undefined {
  const env = opts.env ?? process.env;
  const token = env.BLUE_TANUKI_SETTINGS_TOKEN;
  if (!settingsSurfaceAllowed(env) || !token) return undefined;
  const mcpObservations = opts.mcpRuntimeObservations ?? mcpRuntimeObservationStore;
  return {
    token,
    html: renderSettingsHtml,
    getSnapshot: async () => {
      const persistedEnv = await readEnvFileEnv(envFilePath(env));
      const snapshot = buildSettingsSnapshot({ ...env, ...persistedEnv }, opts.plugins, mcpObservations);
      if (opts.nativeCredentialPromptAvailable?.()) snapshot.llm.native_credential_prompt_available = true;
      if (snapshot.llm.native_credential_prompt_available && await opts.inspectCredentialRotation?.(snapshot.llm.provider)) {
        snapshot.llm.native_credential_rotation_available = true;
      }
      if (snapshot.llm.native_credential_prompt_available && opts.inspectGoogleReadCredentialRegistration) {
        const scopes = SettingsWriteGoogleReadCredentialScopeSchema.options;
        const readiness = await Promise.all(scopes.map(opts.inspectGoogleReadCredentialRegistration));
        const available = scopes.filter((_scope, index) => readiness[index]);
        if (available.length > 0) snapshot.google_read_credential_registration_available = available;
      }
      if (snapshot.llm.native_credential_prompt_available && await opts.inspectGitHubWriteCredentialRegistration?.()) {
        snapshot.github_write_credential_registration_available = true;
      }
      if (snapshot.llm.native_credential_prompt_available && await opts.inspectTelegramBotCredentialRegistration?.()) {
        snapshot.telegram_bot_credential_registration_available = true;
      } else if (snapshot.llm.native_credential_prompt_available && await opts.inspectTelegramBotInitialGrantRegistration?.()) {
        snapshot.telegram_bot_initial_grant_registration_available = true;
      }
      return snapshot;
    },
    verifyLlm: async (body) => verifyLlmConfiguration(body, env, opts.plugins),
    inspectMcpEndpoint: async (endpointInput) => {
      const endpoint = parseLoopbackMcpEndpoint(endpointInput);
      let catalog: McpCatalogProjection;
      try {
        catalog = await inspectMcpCatalogFromSettings(endpoint, AbortSignal.timeout(5_000));
      } catch {
        mcpObservations.recordPreflightFailed(endpoint);
        const observation = mcpObservations.snapshot(endpoint);
        return {
          status: "preflight_failed",
          connection: observation.connection,
          next_action: "No MCP request was sent. Check that the owner-managed local server is running at this endpoint, then run this catalog check again. This check does not inspect or stop a previous request.",
          source_is_untrusted: true,
          used_for_authority: false,
          may_execute: false,
        };
      }
      mcpObservations.recordCatalogReachable(endpoint);
      const observation = mcpObservations.snapshot(endpoint);
      return {
        status: "catalog_reachable",
        connection: observation.connection,
        server_info: catalog.server_info,
        item_counts: {
          tools: catalog.tools.length,
          resources: catalog.resources.length,
          resource_templates: catalog.resource_templates.length,
          prompts: catalog.prompts.length,
        },
        catalog_digest: catalog.catalog_digest,
        truncated: catalog.truncated,
        next_action: "The catalog was readable at the recorded time; no MCP request was sent. Select a tool, fixed resource, supported scalar resource template, or prompt only through an Operation Plan with High/L3 review and fresh catalog validation. This is not a live health monitor.",
        source_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    },
  };
}

export function renderSettingsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BLUE-TANUKI Settings</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f6;
      --ink: #18201c;
      --muted: #66706a;
      --line: #d9dfd8;
      --panel: #ffffff;
      --accent: #146c5a;
      --accent-2: #234a84;
      --warn: #8a5a00;
      --bad: #9f2b2b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .wrap {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
    }
    header .wrap {
      min-height: 68px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }
    h1 {
      font-size: 22px;
      line-height: 1.2;
      margin: 0;
      letter-spacing: 0;
    }
    main {
      padding: 24px 0 36px;
    }
    .statusbar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .stat {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 12px;
      min-height: 74px;
    }
    .stat b {
      display: block;
      font-size: 12px;
      color: var(--muted);
      font-weight: 650;
    }
    .stat span {
      display: block;
      margin-top: 8px;
      font-size: 15px;
      overflow-wrap: anywhere;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    nav {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 8px;
      position: sticky;
      top: 16px;
    }
    nav button {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--ink);
      text-align: left;
      padding: 10px 12px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    nav button[aria-selected="true"] {
      background: #e5f0eb;
      color: var(--accent);
      font-weight: 700;
    }
    section {
      display: none;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 18px;
    }
    section.active { display: block; }
    h2 {
      margin: 0 0 14px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    label {
      display: grid;
      gap: 7px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    textarea {
      width: 100%;
      min-height: 150px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      background: #fff;
      color: var(--ink);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    textarea:focus {
      outline: 2px solid #b9d6cc;
      border-color: var(--accent);
    }
    .grid .wide { grid-column: 1 / -1; }
    .muted {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.5;
    }
    input:focus, select:focus {
      outline: 2px solid #b9d6cc;
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 18px;
      flex-wrap: wrap;
    }
    button.primary, button.secondary {
      min-height: 38px;
      border-radius: 6px;
      padding: 8px 14px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      font-weight: 700;
    }
    button.secondary {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
    }
    .notice {
      min-height: 24px;
      margin-top: 12px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .notice.ok { color: var(--accent); }
    .notice.warn { color: var(--warn); }
    .notice.bad { color: var(--bad); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--muted); font-size: 12px; }
    code {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 760px) {
      .statusbar, .layout, .grid {
        grid-template-columns: 1fr;
      }
      nav { position: static; }
      header .wrap {
        align-items: flex-start;
        flex-direction: column;
        padding: 14px 0;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>BLUE-TANUKI Settings</h1>
      <label style="width:min(420px,100%)">
        Settings token
        <input id="settings-token" type="password" autocomplete="current-password">
      </label>
    </div>
  </header>
  <main class="wrap">
    <div class="statusbar">
      <div class="stat"><b>Provider</b><span id="stat-provider">-</span></div>
      <div class="stat"><b>Model</b><span id="stat-model">-</span></div>
      <div class="stat"><b>Env File</b><span id="stat-env">-</span></div>
      <div class="stat"><b>Plugins</b><span id="stat-plugins">-</span></div>
    </div>
    <div class="layout">
      <nav aria-label="Settings sections">
        <button type="button" data-tab="llm" aria-selected="true">LLM</button>
        <button type="button" data-tab="connections" aria-selected="false">Connections</button>
        <button type="button" data-tab="paths" aria-selected="false">Paths</button>
        <button type="button" data-tab="plugins" aria-selected="false">Plugins</button>
      </nav>
      <div>
        <section id="tab-llm" class="active">
          <h2>LLM</h2>
          <div class="grid">
            <label>Provider
              <select id="llm-provider" disabled>
                <option value="stub">stub</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="openai-compatible">openai-compatible</option>
                <option value="openrouter">openrouter</option>
              </select>
            </label>
            <label>Model
              <input id="llm-model" readonly>
            </label>
            <label>Endpoint
              <input id="llm-endpoint" readonly>
            </label>
            <label>API key status
              <input id="llm-api-key-status" readonly>
            </label>
            <label>Temperature
              <input id="llm-temperature" type="number" min="0" max="2" step="0.1" readonly>
            </label>
            <label>Max tokens
              <input id="llm-max-tokens" type="number" min="1" step="1" readonly>
            </label>
            <label>Timeout ms
              <input id="llm-timeout-ms" type="number" min="1" step="1" readonly>
            </label>
            <label>OpenRouter site URL
              <input id="llm-site-url" readonly>
            </label>
            <label>OpenRouter app title
              <input id="llm-app-title" readonly>
            </label>
            <label>Approval mode
              <select id="approval-mode" disabled>
                <option value="ask_every_time">ask_every_time</option>
                <option value="remember_this_decision">remember_this_decision</option>
                <option value="full_access">full_access</option>
              </select>
            </label>
            <label class="wide">Provider maximum-cost profiles (JSON)
              <textarea id="llm-provider-cost-profiles" spellcheck="false" readonly></textarea>
              <span class="muted">Owner-configured upper bound per provider attempt, not a fetched price. Example: {"openai-compatible":{"capabilities":["llm.text.generate"],"max_cost_per_attempt":{"amount":0.02,"currency":"USD"}}}. Use the selected provider's exact maximum and currency; an empty value clears profiles.</span>
            </label>
            <label class="wide">Compute budget policy (JSON)
              <textarea id="llm-compute-budget-policy" spellcheck="false" readonly></textarea>
              <span class="muted">The configured window must cover one normal request in system, parent, and task scopes. The runtime ledger still checks current usage. An empty value restores the offline default, which sets monetary limits to zero.</span>
            </label>
            <p id="llm-compute-readiness" class="notice warn wide" role="status"></p>
          </div>
        </section>
        <section id="tab-connections">
          <h2>Connections</h2>
          <div class="grid">
            <label>Composio API key status
              <input id="composio-api-key-status" readonly>
            </label>
            <label>Composio user identity
              <input id="composio-user-id-status" readonly>
            </label>
            <label>Composio allowed toolkits
              <input id="composio-allowed-toolkits-status" readonly>
            </label>
            <label>Composio allowed actions
              <input id="composio-allowed-actions-status" readonly>
            </label>
            <label>Composio revoked actions
              <input id="composio-revoked-actions-status" readonly>
            </label>
            <label>Composio API base URL
              <input id="composio-api-base-url-status" readonly>
            </label>
            <label>Composio dry-run / live execution
              <input id="composio-execution-status" readonly>
            </label>
            <label>MCP loopback Streamable HTTP endpoint
              <input id="mcp-endpoint" autocomplete="off" placeholder="http://127.0.0.1:3000/mcp">
            </label>
            <button class="secondary" id="inspect-mcp-btn" type="button">Check local MCP catalog</button>
            <label>MCP setup status
              <input id="mcp-status" readonly>
            </label>
            <label>MCP last catalog observation
              <input id="mcp-runtime-connection" readonly>
            </label>
            <label>MCP last call observation
              <input id="mcp-runtime-call" readonly>
            </label>
            <label>Composio status
              <input id="composio-status" readonly>
            </label>
            <label>D4 Runtime pairing
              <input id="d4-runtime-status" readonly>
            </label>
            <label>D4 Runtime token storage
              <input id="d4-runtime-secret-storage" readonly>
            </label>
            <label>OpenRouter configured
              <input id="openrouter-status" readonly>
            </label>
            <label>Native-first policy
              <input id="native-first-status" readonly>
            </label>
            <label>Slack setup status
              <input id="slack-status" readonly>
            </label>
            <label>Slack bot token
              <input id="slack-bot-token-status" readonly>
            </label>
            <label>Slack app token
              <input id="slack-app-token-status" readonly>
            </label>
            <label>Slack inbound grants
              <input id="slack-inbound-grants-status" readonly>
            </label>
          </div>
          <p id="slack-next-action" role="status"></p>
          <p class="muted">This is configuration status only. It does not test Slack connectivity or change Slack preview status.</p>
          <p id="mcp-next-action" role="status"></p>
          <p id="composio-next-action" class="muted" role="status">Composio settings are read-only here. Prepare changes through Owner Task settings.write and review the no-store L3 change list; provision or replace keys through OS-protected setup.</p>
          <p id="d4-runtime-next-action" role="status"></p>
          <p id="mcp-runtime-next-action" role="status"></p>
          <p id="mcp-inspection-result" role="status"></p>
          <p class="muted">Runtime observations are saved locally from normal MCP use, not a live health check. They contain no endpoint path, tool name, or response body and do not grant authority.</p>
          <p class="muted">MCP accepts credentialless loopback HTTP/HTTPS only. This explicit check reads bounded catalog metadata from the entered local endpoint; it does not send credentials, call a tool, read a resource, get a prompt, or start/stop the server. Saving requires a Gateway restart. Catalog data is untrusted, and every selected tool/resource/scalar-template/prompt request still uses HDS and High/L3 review. Resource templates are limited to supported scalar URI-template variables; the raw template URI is kept out of C input.</p>
        </section>
        <section id="tab-paths">
          <h2>Paths</h2>
          <div class="grid">
            <label>WebChat host
              <input id="webchat-host" autocomplete="off">
            </label>
            <label>WebChat port
              <input id="webchat-port" type="number" min="1" max="65535" step="1">
            </label>
            <label>File sandbox root
              <input id="path-file-root" autocomplete="off">
            </label>
            <label>Isolated process workspace (optional)
              <input id="path-shell-root" autocomplete="off">
            </label>
            <button id="path-use-file-root" type="button">Use file sandbox root</button>
            <p class="muted">Set this to the File sandbox root to run an owner-reviewed edit and its isolated test in the same workspace. Leave empty to keep shell.exec disabled.</p>
            <label>Session directory
              <input id="path-session-dir" autocomplete="off">
            </label>
            <label>Audit directory
              <input id="path-audit-dir" autocomplete="off">
            </label>
          </div>
        </section>
        <section id="tab-plugins">
          <h2>Plugins</h2>
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Permissions</th></tr></thead>
            <tbody id="plugin-rows"></tbody>
          </table>
        </section>
        <div class="actions">
          <button class="secondary" id="load-btn" type="button">Load</button>
          <button class="secondary" id="verify-llm-btn" type="button">稼働中の計算構成を確認</button>
        </div>
        <div class="notice warn">This page does not save settings. Supported non-secret LLM values can be changed from a Developer task through HDS Operation Plan and no-store L3 review. <a href="/" target="_blank" rel="noopener">Open WebChat to create a Developer task</a>. Provider, endpoint, credentials, approval mode, paths, and connector settings remain unavailable here.</div>
        <div class="notice" id="notice"></div>
      </div>
    </div>
  </main>
  <script>
    const tokenInput = document.querySelector("#settings-token");
    const notice = document.querySelector("#notice");
    const fields = {
      provider: document.querySelector("#llm-provider"),
      model: document.querySelector("#llm-model"),
      endpoint: document.querySelector("#llm-endpoint"),
      apiKeyStatus: document.querySelector("#llm-api-key-status"),
      temperature: document.querySelector("#llm-temperature"),
      maxTokens: document.querySelector("#llm-max-tokens"),
      timeoutMs: document.querySelector("#llm-timeout-ms"),
      providerCostProfiles: document.querySelector("#llm-provider-cost-profiles"),
      computeBudgetPolicy: document.querySelector("#llm-compute-budget-policy"),
      computeReadiness: document.querySelector("#llm-compute-readiness"),
      siteUrl: document.querySelector("#llm-site-url"),
      appTitle: document.querySelector("#llm-app-title"),
      approvalMode: document.querySelector("#approval-mode"),
      composioApiKeyStatus: document.querySelector("#composio-api-key-status"),
      composioUserIdStatus: document.querySelector("#composio-user-id-status"),
      composioAllowedToolkitsStatus: document.querySelector("#composio-allowed-toolkits-status"),
      composioAllowedActionsStatus: document.querySelector("#composio-allowed-actions-status"),
      composioRevokedActionsStatus: document.querySelector("#composio-revoked-actions-status"),
      composioApiBaseUrlStatus: document.querySelector("#composio-api-base-url-status"),
      composioExecutionStatus: document.querySelector("#composio-execution-status"),
      composioStatus: document.querySelector("#composio-status"),
      d4RuntimeStatus: document.querySelector("#d4-runtime-status"),
      d4RuntimeSecretStorage: document.querySelector("#d4-runtime-secret-storage"),
      d4RuntimeNextAction: document.querySelector("#d4-runtime-next-action"),
      openrouterStatus: document.querySelector("#openrouter-status"),
      nativeFirstStatus: document.querySelector("#native-first-status"),
      slackStatus: document.querySelector("#slack-status"),
      slackBotTokenStatus: document.querySelector("#slack-bot-token-status"),
      slackAppTokenStatus: document.querySelector("#slack-app-token-status"),
      slackInboundGrantsStatus: document.querySelector("#slack-inbound-grants-status"),
      slackNextAction: document.querySelector("#slack-next-action"),
      mcpEndpoint: document.querySelector("#mcp-endpoint"),
      mcpInspectButton: document.querySelector("#inspect-mcp-btn"),
      mcpStatus: document.querySelector("#mcp-status"),
      mcpNextAction: document.querySelector("#mcp-next-action"),
      mcpRuntimeConnection: document.querySelector("#mcp-runtime-connection"),
      mcpRuntimeCall: document.querySelector("#mcp-runtime-call"),
      mcpRuntimeNextAction: document.querySelector("#mcp-runtime-next-action"),
      mcpInspectionResult: document.querySelector("#mcp-inspection-result"),
      host: document.querySelector("#webchat-host"),
      port: document.querySelector("#webchat-port"),
      fileRoot: document.querySelector("#path-file-root"),
      shellRoot: document.querySelector("#path-shell-root"),
      sessionDir: document.querySelector("#path-session-dir"),
      auditDir: document.querySelector("#path-audit-dir")
    };
    tokenInput.value = sessionStorage.getItem("blueTanukiSettingsToken") || "";
    tokenInput.addEventListener("change", () => {
      sessionStorage.setItem("blueTanukiSettingsToken", tokenInput.value);
    });
    document.querySelector("#path-use-file-root").addEventListener("click", () => {
      fields.shellRoot.value = fields.fileRoot.value;
    });
    document.querySelectorAll("nav button").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("nav button").forEach((b) => b.setAttribute("aria-selected", "false"));
        document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
        button.setAttribute("aria-selected", "true");
        document.querySelector("#tab-" + button.dataset.tab).classList.add("active");
      });
    });
    function setNotice(text, kind = "") {
      notice.textContent = text;
      notice.className = "notice " + kind;
    }
    async function api(path, options = {}) {
      const token = tokenInput.value.trim();
      const res = await fetch(path, {
        ...options,
        headers: {
          "authorization": "Bearer " + token,
          "content-type": "application/json",
          ...(options.headers || {})
        }
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(body?.error || "request failed");
      return body;
    }
    function fill(snapshot) {
      document.querySelector("#stat-provider").textContent = snapshot.llm.provider;
      document.querySelector("#stat-model").textContent = snapshot.llm.model || "(provider default)";
      document.querySelector("#stat-env").textContent = snapshot.env_file || "(read-only)";
      document.querySelector("#stat-plugins").textContent = String(snapshot.plugins.length);
      fields.provider.value = snapshot.llm.provider;
      fields.model.value = snapshot.llm.model || "";
      fields.endpoint.value = snapshot.llm.endpoint || "";
      fields.apiKeyStatus.value = snapshot.llm.api_key_set ? "設定済み" : "未設定";
      fields.temperature.value = snapshot.llm.temperature ?? "";
      fields.maxTokens.value = snapshot.llm.max_tokens ?? "";
      fields.timeoutMs.value = snapshot.llm.timeout_ms ?? "";
      fields.providerCostProfiles.value = snapshot.llm.provider_cost_profiles_json || "";
      fields.computeBudgetPolicy.value = snapshot.llm.compute_budget_policy_json || "";
      showComputeReadiness(snapshot.llm.compute_readiness);
      fields.siteUrl.value = snapshot.llm.site_url || "";
      fields.appTitle.value = snapshot.llm.app_title || "";
      fields.approvalMode.value = snapshot.approval?.mode || "full_access";
      fields.composioApiKeyStatus.value = snapshot.integrations.composio.configured ? "configured; value hidden" : "not set";
      fields.composioUserIdStatus.value = snapshot.integrations.composio.user_id_set ? "configured; value hidden" : "not set";
      fields.composioAllowedToolkitsStatus.value = snapshot.integrations.composio.allowed_toolkits.join(", ") || "(none)";
      fields.composioAllowedActionsStatus.value = snapshot.integrations.composio.allowed_actions.join(", ") || "(none)";
      fields.composioRevokedActionsStatus.value = snapshot.integrations.composio.revoked_actions.join(", ") || "(none)";
      fields.composioApiBaseUrlStatus.value = snapshot.integrations.composio.api_base_url || "(default)";
      fields.composioExecutionStatus.value = "dry_run=" + snapshot.integrations.composio.dry_run +
        "; live_execution_enabled=" + snapshot.integrations.composio.live_execution_enabled;
      fields.composioStatus.value =
        (snapshot.integrations.composio.configured ? "configured" : "missing") +
        "; dry_run=" + snapshot.integrations.composio.dry_run +
        "; live=" + snapshot.integrations.composio.live_execution_available;
      fields.d4RuntimeStatus.value = snapshot.integrations.d4_runtime.status.replaceAll("_", " ");
      fields.d4RuntimeSecretStorage.value = snapshot.integrations.d4_runtime.secret_storage.storage.replaceAll("_", " ");
      fields.d4RuntimeNextAction.textContent = snapshot.integrations.d4_runtime.next_action;
      fields.openrouterStatus.value =
        (snapshot.integrations.openrouter.configured ? "configured" : "missing") +
        "; key=" + (snapshot.integrations.openrouter.api_key_set ? "set" : "missing");
      fields.nativeFirstStatus.value = snapshot.integrations.native_first ? "native/direct paths remain canonical" : "invalid";
      fields.slackStatus.value = snapshot.integrations.slack.status.replaceAll("_", " ");
      fields.slackBotTokenStatus.value = snapshot.integrations.slack.bot_token_set ? "configured; value hidden" : "not set";
      fields.slackAppTokenStatus.value = snapshot.integrations.slack.app_token_set ? "configured; value hidden" : "not set";
      fields.slackInboundGrantsStatus.value = snapshot.integrations.slack.inbound_grants.replaceAll("_", " ");
      fields.slackNextAction.textContent = snapshot.integrations.slack.next_action;
      fields.mcpEndpoint.value = snapshot.integrations.mcp.endpoint || "";
      fields.mcpStatus.value = snapshot.integrations.mcp.status.replaceAll("_", " ");
      fields.mcpNextAction.textContent = snapshot.integrations.mcp.next_action;
      const runtimeObservation = snapshot.integrations.mcp.runtime_observation;
      fields.mcpRuntimeConnection.value = runtimeObservation.connection.state.replaceAll("_", " ") +
        (runtimeObservation.connection.observed_at ? " at " + runtimeObservation.connection.observed_at : "");
      fields.mcpRuntimeCall.value = runtimeObservation.last_call.state.replaceAll("_", " ") +
        (runtimeObservation.last_call.observed_at ? " at " + runtimeObservation.last_call.observed_at : "");
      fields.mcpRuntimeNextAction.textContent = runtimeObservation.next_action;
      fields.host.value = snapshot.webchat.host;
      fields.port.value = snapshot.webchat.port;
      fields.fileRoot.value = snapshot.paths.file_root;
      fields.shellRoot.value = snapshot.paths.shell_root || "";
      fields.sessionDir.value = snapshot.paths.session_dir;
      fields.auditDir.value = snapshot.paths.audit_dir;
      const rows = document.querySelector("#plugin-rows");
      rows.innerHTML = "";
      for (const plugin of snapshot.plugins) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td><code></code></td><td></td><td><code></code></td>";
        tr.children[0].firstChild.textContent = plugin.name;
        tr.children[1].textContent = plugin.kind;
        tr.children[2].firstChild.textContent = plugin.permissions.join(", ");
        rows.appendChild(tr);
      }
    }
    async function load() {
      try {
        fill(await api("/settings/config"));
        setNotice("Loaded", "ok");
      } catch (e) {
        setNotice(e.message, "bad");
      }
    }
    async function verifyLlm() {
      try {
        const body = await api("${LLM_VERIFY_ROUTE}", {
          method: "POST",
          body: JSON.stringify({})
        });
        const result = body.result;
        if (!result || result.provider_connection_checked !== false || result.credential_access_checked !== false ||
            result.changed !== false || result.used_for_authority !== false || result.may_execute !== false ||
            !Array.isArray(result.evidence_source) || result.evidence_source.length !== 1 || result.evidence_source[0] !== "CONFIG") {
          throw new Error("構成の確認結果を読み取れませんでした。");
        }
        showComputeReadiness(result.compute_readiness);
        const kind = result.status === "fail" ? "bad" : result.compute_readiness.status === "blocked" ? "warn" : "ok";
        setNotice(result.detail + " " + result.next_action, kind);
      } catch (e) {
        setNotice(e.message, "bad");
      }
    }
    async function inspectMcpEndpoint() {
      fields.mcpInspectButton.disabled = true;
      fields.mcpInspectionResult.textContent = "Checking the local MCP catalog…";
      try {
        const body = await api("/settings/mcp/inspect", {
          method: "POST",
          body: JSON.stringify({ endpoint: fields.mcpEndpoint.value })
        });
        const result = body.result;
        fields.mcpRuntimeConnection.value = result.connection.state.replaceAll("_", " ") +
          (result.connection.observed_at ? " at " + result.connection.observed_at : "");
        fields.mcpRuntimeNextAction.textContent = result.next_action;
        if (result.status === "catalog_reachable") {
          const counts = result.item_counts;
          const server = result.server_info ? result.server_info.name + " " + result.server_info.version : "unnamed server";
          fields.mcpInspectionResult.textContent = "Catalog reachable: " + server + "; " +
            counts.tools + " tools, " + counts.resources + " resources, " +
            counts.resource_templates + " resource templates, " + counts.prompts + " prompts" +
            (result.truncated ? " (bounded listing; more entries may exist)" : "") + ".";
          setNotice("MCP catalog read completed; no tool was called.", "ok");
        } else {
          fields.mcpInspectionResult.textContent = "MCP catalog was not reachable. No tool was called.";
          setNotice("MCP catalog check failed before tool dispatch.", "warn");
        }
      } catch (e) {
        fields.mcpInspectionResult.textContent = "The endpoint was not inspected. Confirm it is a credentialless loopback HTTP/HTTPS URL.";
        setNotice(e.message, "bad");
      } finally {
        fields.mcpInspectButton.disabled = false;
      }
    }
    function showComputeReadiness(readiness) {
      fields.computeReadiness.textContent = "Normal Compute configuration: " + readiness.status + ". " + readiness.detail + " Current window usage is not checked here.";
      fields.computeReadiness.className = "notice wide " + (readiness.status === "ready" ? "ok" : "warn");
    }
    document.querySelector("#load-btn").addEventListener("click", load);
    document.querySelector("#verify-llm-btn").addEventListener("click", verifyLlm);
    fields.mcpInspectButton.addEventListener("click", inspectMcpEndpoint);
    if (tokenInput.value) load();
  </script>
</body>
</html>`;
}
