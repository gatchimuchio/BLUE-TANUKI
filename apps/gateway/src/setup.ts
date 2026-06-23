import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { writeEnvFileAtomic } from "./env_file.js";
import {
  createDefaultSetupConfig,
  renderSetupEnvFile,
  setupConfigToEnv,
  validateSetupConfig,
  type BlueTanukiSetupConfig,
  type SetupProviderKind,
} from "./setup_config.js";
import { formatTextReport, runDoctor, type DoctorReport } from "./doctor.js";
import {
  llmApiKeyForProvider,
  secretRefKey,
  storeLlmApiKeySecret,
  type SecretProtector,
  type LlmSecretStoreResult,
} from "./secret_store.js";

export interface SetupCliOptions {
  yes?: boolean;
  force?: boolean;
  no_doctor?: boolean;
  json?: boolean;
  output?: string;
  base_dir?: string;
  provider?: SetupProviderKind;
  model?: string;
  endpoint?: string;
  api_key?: string;
  api_key_env?: string;
  host?: string;
  port?: number;
  file_root?: string;
  session_dir?: string;
  audit_dir?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface SetupCommandIO {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  secret_storage?: SetupSecretStorageOptions;
}

export interface SetupSecretStorageOptions {
  platform?: NodeJS.Platform;
  protector?: SecretProtector;
}

export interface SetupSecretStorageResult {
  status: "not_supplied" | "stored" | "plaintext_env_fallback";
  key: string | null;
  storage: "win32_dpapi_current_user" | "env_file" | "unavailable";
  os_protected: boolean;
  used_for_authority: false;
  evidence_source: readonly ("CONFIG" | "EXTERNAL_EVIDENCE")[];
  detail: string;
}

export interface SetupResult {
  output_path: string;
  backup_path?: string;
  config: BlueTanukiSetupConfig;
  env_keys: string[];
  secret_storage: {
    llm_api_key: SetupSecretStorageResult;
  };
  doctor?: DoctorReport;
}

function writeLine(stream: NodeJS.WritableStream, text = ""): void {
  stream.write(`${text}\n`);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseIntOption(value: string, flag: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNumberOption(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number`);
  }
  return parsed;
}

function parseProvider(value: string): SetupProviderKind {
  const provider = value.trim().toLowerCase();
  if (
    provider === "stub" ||
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "openrouter"
  ) {
    return provider;
  }
  throw new Error(
    "--provider must be stub | anthropic | openai | openai-compatible | openrouter",
  );
}

function readFlagValue(arg: string, flag: string): string | undefined {
  return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
}

export function parseSetupArgs(args: string[]): SetupCliOptions {
  const opts: SetupCliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--setup") continue;
    if (arg === "--yes" || arg === "-y") {
      opts.yes = true;
      continue;
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--no-doctor") {
      opts.no_doctor = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }

    const outputInline = readFlagValue(arg, "--output");
    if (arg === "--output" || outputInline !== undefined) {
      opts.output = outputInline ?? requireValue(args, i++, "--output");
      continue;
    }
    const baseInline = readFlagValue(arg, "--base-dir");
    if (arg === "--base-dir" || baseInline !== undefined) {
      opts.base_dir = baseInline ?? requireValue(args, i++, "--base-dir");
      continue;
    }
    const providerInline = readFlagValue(arg, "--provider");
    if (arg === "--provider" || providerInline !== undefined) {
      opts.provider = parseProvider(
        providerInline ?? requireValue(args, i++, "--provider"),
      );
      continue;
    }
    const modelInline = readFlagValue(arg, "--model");
    if (arg === "--model" || modelInline !== undefined) {
      opts.model = modelInline ?? requireValue(args, i++, "--model");
      continue;
    }
    const endpointInline = readFlagValue(arg, "--endpoint");
    if (arg === "--endpoint" || endpointInline !== undefined) {
      opts.endpoint = endpointInline ?? requireValue(args, i++, "--endpoint");
      continue;
    }
    const keyInline = readFlagValue(arg, "--api-key");
    if (arg === "--api-key" || keyInline !== undefined) {
      opts.api_key = keyInline ?? requireValue(args, i++, "--api-key");
      continue;
    }
    const keyEnvInline = readFlagValue(arg, "--api-key-env");
    if (arg === "--api-key-env" || keyEnvInline !== undefined) {
      opts.api_key_env = keyEnvInline ?? requireValue(args, i++, "--api-key-env");
      continue;
    }
    const hostInline = readFlagValue(arg, "--host");
    if (arg === "--host" || hostInline !== undefined) {
      opts.host = hostInline ?? requireValue(args, i++, "--host");
      continue;
    }
    const portInline = readFlagValue(arg, "--port");
    if (arg === "--port" || portInline !== undefined) {
      opts.port = parseIntOption(portInline ?? requireValue(args, i++, "--port"), "--port");
      continue;
    }
    const fileRootInline = readFlagValue(arg, "--file-root");
    if (arg === "--file-root" || fileRootInline !== undefined) {
      opts.file_root = fileRootInline ?? requireValue(args, i++, "--file-root");
      continue;
    }
    const sessionInline = readFlagValue(arg, "--session-dir");
    if (arg === "--session-dir" || sessionInline !== undefined) {
      opts.session_dir = sessionInline ?? requireValue(args, i++, "--session-dir");
      continue;
    }
    const auditInline = readFlagValue(arg, "--audit-dir");
    if (arg === "--audit-dir" || auditInline !== undefined) {
      opts.audit_dir = auditInline ?? requireValue(args, i++, "--audit-dir");
      continue;
    }
    const tempInline = readFlagValue(arg, "--temperature");
    if (arg === "--temperature" || tempInline !== undefined) {
      opts.temperature = parseNumberOption(
        tempInline ?? requireValue(args, i++, "--temperature"),
        "--temperature",
      );
      continue;
    }
    const maxInline = readFlagValue(arg, "--max-tokens");
    if (arg === "--max-tokens" || maxInline !== undefined) {
      opts.max_tokens = parseIntOption(
        maxInline ?? requireValue(args, i++, "--max-tokens"),
        "--max-tokens",
      );
      continue;
    }
    const timeoutInline = readFlagValue(arg, "--timeout-ms");
    if (arg === "--timeout-ms" || timeoutInline !== undefined) {
      opts.timeout_ms = parseIntOption(
        timeoutInline ?? requireValue(args, i++, "--timeout-ms"),
        "--timeout-ms",
      );
      continue;
    }
    throw new Error(`unknown setup option '${arg}'`);
  }
  return opts;
}

function resolveFrom(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

export function buildSetupConfigFromOptions(
  opts: SetupCliOptions,
  cwd = process.cwd(),
): BlueTanukiSetupConfig {
  const baseDir = resolveFrom(cwd, opts.base_dir ?? ".blue-tanuki");
  const config = createDefaultSetupConfig({ base_dir: baseDir });
  if (opts.provider) config.llm.provider = opts.provider;
  if (opts.model) config.llm.model = opts.model;
  if (opts.endpoint) config.llm.endpoint = opts.endpoint;
  if (opts.api_key) config.llm.api_key = opts.api_key;
  if (opts.api_key_env) config.llm.api_key_env = opts.api_key_env;
  if (opts.temperature !== undefined) config.llm.temperature = opts.temperature;
  if (opts.max_tokens !== undefined) config.llm.max_tokens = opts.max_tokens;
  if (opts.timeout_ms !== undefined) config.llm.timeout_ms = opts.timeout_ms;
  if (opts.host) config.webchat.host = opts.host;
  if (opts.port !== undefined) config.webchat.port = opts.port;
  if (opts.file_root) config.paths.file_root = resolveFrom(cwd, opts.file_root);
  if (opts.session_dir) config.paths.session_dir = resolveFrom(cwd, opts.session_dir);
  if (opts.audit_dir) config.paths.audit_dir = resolveFrom(cwd, opts.audit_dir);
  return validateSetupConfig(config);
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue || "";
}

async function promptForConfig(
  opts: SetupCliOptions,
  io: Required<Pick<SetupCommandIO, "cwd" | "env" | "stdin" | "stdout">>,
): Promise<BlueTanukiSetupConfig> {
  const baseDir = resolveFrom(io.cwd, opts.base_dir ?? ".blue-tanuki");
  const config = createDefaultSetupConfig({ base_dir: baseDir });
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const providerAnswer = await ask(
      rl,
      "LLM provider (stub/openai/anthropic/openai-compatible/openrouter)",
      opts.provider ?? "stub",
    );
    config.llm.provider = parseProvider(providerAnswer);

    if (config.llm.provider === "anthropic") {
      config.llm.model = await ask(rl, "Anthropic model", opts.model ?? "");
      config.llm.endpoint =
        (await ask(rl, "Anthropic endpoint", opts.endpoint ?? "")) || undefined;
      config.llm.api_key =
        (opts.api_key ?? (await ask(rl, "Anthropic API key", ""))) || undefined;
    } else if (config.llm.provider === "openai") {
      config.llm.model = await ask(rl, "OpenAI model", opts.model ?? "");
      config.llm.endpoint =
        (await ask(rl, "OpenAI endpoint", opts.endpoint ?? "")) || undefined;
      config.llm.api_key =
        (opts.api_key ?? (await ask(rl, "OpenAI API key", ""))) || undefined;
    } else if (config.llm.provider === "openai-compatible") {
      config.llm.model = await ask(rl, "OpenAI-compatible model", opts.model ?? "");
      config.llm.endpoint = await ask(
        rl,
        "OpenAI-compatible endpoint",
        opts.endpoint ?? "http://localhost:11434/v1",
      );
      config.llm.api_key =
        (opts.api_key ?? (await ask(rl, "API key (blank if not required)", ""))) ||
        undefined;
    } else if (config.llm.provider === "openrouter") {
      config.llm.model = await ask(rl, "OpenRouter model", opts.model ?? "");
      config.llm.endpoint =
        (await ask(rl, "OpenRouter endpoint", opts.endpoint ?? "")) || undefined;
      config.llm.api_key =
        (opts.api_key ?? (await ask(rl, "OpenRouter API key", ""))) || undefined;
    }

    const host = await ask(rl, "WebChat host", opts.host ?? config.webchat.host);
    config.webchat.host = host;
    const port = await ask(
      rl,
      "WebChat port",
      String(opts.port ?? config.webchat.port),
    );
    config.webchat.port = parseIntOption(port, "webchat.port");
    config.paths.file_root = resolveFrom(
      io.cwd,
      await ask(rl, "File sandbox root", opts.file_root ?? config.paths.file_root),
    );
    config.paths.session_dir = resolveFrom(
      io.cwd,
      await ask(rl, "Session directory", opts.session_dir ?? config.paths.session_dir),
    );
    config.paths.audit_dir = resolveFrom(
      io.cwd,
      await ask(rl, "Audit directory", opts.audit_dir ?? config.paths.audit_dir),
    );
    if (opts.temperature !== undefined) config.llm.temperature = opts.temperature;
    if (opts.max_tokens !== undefined) config.llm.max_tokens = opts.max_tokens;
    if (opts.timeout_ms !== undefined) config.llm.timeout_ms = opts.timeout_ms;
    if (opts.api_key_env) config.llm.api_key_env = opts.api_key_env;
    return validateSetupConfig(config);
  } finally {
    rl.close();
  }
}

async function ensureWritableTarget(outputPath: string, force: boolean): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const exists = await fs
    .stat(outputPath)
    .then(() => true)
    .catch(() => false);
  if (exists && !force) {
    throw new Error(`${outputPath} already exists; pass --force to overwrite it`);
  }
}

async function ensureRuntimeDirs(config: BlueTanukiSetupConfig): Promise<void> {
  await fs.mkdir(config.paths.file_root, { recursive: true });
  await fs.mkdir(config.paths.session_dir, { recursive: true });
  await fs.mkdir(config.paths.audit_dir, { recursive: true });
}

function protectSetupLlmApiKey(
  config: BlueTanukiSetupConfig,
  outputPath: string,
  env: NodeJS.ProcessEnv,
  opts: SetupSecretStorageOptions = {},
): SetupSecretStorageResult {
  const key = llmApiKeyForProvider(config.llm.provider);
  const plaintext =
    config.llm.api_key ??
    (config.llm.api_key_env ? env[config.llm.api_key_env] : undefined);

  if (!key || !plaintext) {
    return {
      status: "not_supplied",
      key: key ?? null,
      storage: "unavailable",
      os_protected: false,
      used_for_authority: false,
      evidence_source: ["CONFIG"],
      detail: "No LLM API key was supplied during setup.",
    };
  }

  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      status: "plaintext_env_fallback",
      key,
      storage: "env_file",
      os_protected: false,
      used_for_authority: false,
      evidence_source: ["CONFIG"],
      detail: "OS-protected LLM secret storage is available only on Windows in this release.",
    };
  }

  let stored: LlmSecretStoreResult;
  try {
    stored = storeLlmApiKeySecret(key, plaintext, {
      envFilePath: outputPath,
      env,
      platform,
      protector: opts.protector,
    });
  } catch (error) {
    throw new Error(
      `Windows LLM secret storage failed; refusing to write plaintext ${key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  delete config.llm.api_key;
  delete config.llm.api_key_env;
  config.llm.api_key_ref = stored.ref;
  return {
    status: "stored",
    key,
    storage: stored.storage,
    os_protected: true,
    used_for_authority: false,
    evidence_source: ["CONFIG", "EXTERNAL_EVIDENCE"],
    detail: `${key} stored via ${secretRefKey(key)} using Windows DPAPI CurrentUser.`,
  };
}

export async function runSetupCommand(
  args: string[] = process.argv.slice(2),
  io: SetupCommandIO = {},
): Promise<SetupResult> {
  const opts = parseSetupArgs(args);
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const config = opts.yes
    ? buildSetupConfigFromOptions(opts, cwd)
    : await promptForConfig(opts, { cwd, env, stdin, stdout });
  const outputPath = resolveFrom(
    cwd,
    opts.output ?? path.join(".blue-tanuki", "blue-tanuki.env"),
  );

  await ensureWritableTarget(outputPath, opts.force === true);
  await ensureRuntimeDirs(config);
  const secretStorage = protectSetupLlmApiKey(
    config,
    outputPath,
    env,
    io.secret_storage,
  );
  const envFile = renderSetupEnvFile(config, { source_env: env });
  const writeResult = await writeEnvFileAtomic(outputPath, envFile, {
    mode: 0o600,
    backup: opts.force === true,
    backup_label: "setup",
  });
  const setupEnv = setupConfigToEnv(config, { source_env: env });

  const doctor = opts.no_doctor
    ? undefined
    : await runDoctor({
        env: { ...env, ...setupEnv },
        probe_port: false,
      });

  return {
    output_path: outputPath,
    backup_path: writeResult.backup_path,
    config,
    env_keys: Object.keys(setupEnv).sort(),
    secret_storage: {
      llm_api_key: secretStorage,
    },
    doctor,
  };
}

function resultJson(result: SetupResult): string {
  return JSON.stringify(
    {
      output_path: result.output_path,
      backup_path: result.backup_path,
      provider: result.config.llm.provider,
      env_keys: result.env_keys,
      secret_storage: result.secret_storage,
      doctor_exit_code: result.doctor?.exit_code,
      doctor_ok: result.doctor?.ok,
    },
    null,
    2,
  );
}

export async function runSetupCli(
  args: string[] = process.argv.slice(2),
  io: SetupCommandIO = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const opts = parseSetupArgs(args);
    const result = await runSetupCommand(args, io);
    if (opts.json) {
      writeLine(stdout, resultJson(result));
    } else {
      writeLine(stdout, `blue-tanuki setup wrote ${result.output_path}`);
      if (result.backup_path) {
        writeLine(stdout, `previous env backed up to ${result.backup_path}`);
      }
      writeLine(stdout, `provider=${result.config.llm.provider}`);
      writeLine(
        stdout,
        `llm_secret_storage=${result.secret_storage.llm_api_key.status}`,
      );
      writeLine(stdout, "Use this file with --env-file or BLUE_TANUKI_ENV_FILE.");
      if (result.doctor) {
        writeLine(stdout);
        writeLine(stdout, formatTextReport(result.doctor));
      }
    }
    if (result.doctor?.exit_code === 2) {
      process.exitCode = 2;
    }
  } catch (e) {
    writeLine(stderr, `blue-tanuki setup failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await runSetupCli();
}
