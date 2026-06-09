import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SetupProviderKind } from "../../../apps/gateway/src/setup_config.js";
import { runInstallerFlow, type InstallerFlowOptions } from "./setup_flow.js";

function value(args: string[], index: number, flag: string): string {
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) throw new Error(`${flag} requires a value`);
  return raw;
}

function inline(arg: string, flag: string): string | undefined {
  return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
}

function parseProvider(raw: string): SetupProviderKind {
  if (
    raw === "stub" ||
    raw === "anthropic" ||
    raw === "openai" ||
    raw === "openai-compatible" ||
    raw === "openrouter"
  ) {
    return raw;
  }
  throw new Error("--provider must be stub | anthropic | openai | openai-compatible | openrouter");
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNumber(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number`);
  return parsed;
}

export function parseInstallerArgs(args: string[]): InstallerFlowOptions {
  const opts: InstallerFlowOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") continue;
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--skip-install") {
      opts.skip_install = true;
      continue;
    }
    if (arg === "--skip-build") {
      opts.skip_build = true;
      continue;
    }
    if (arg === "--no-doctor") {
      opts.no_doctor = true;
      continue;
    }
    if (arg === "--no-serve") {
      opts.no_serve = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    const envFile = inline(arg, "--env-file");
    if (arg === "--env-file" || envFile !== undefined) {
      opts.env_file = envFile ?? value(args, i++, "--env-file");
      continue;
    }
    const baseDir = inline(arg, "--base-dir");
    if (arg === "--base-dir" || baseDir !== undefined) {
      opts.base_dir = baseDir ?? value(args, i++, "--base-dir");
      continue;
    }
    const provider = inline(arg, "--provider");
    if (arg === "--provider" || provider !== undefined) {
      opts.provider = parseProvider(provider ?? value(args, i++, "--provider"));
      continue;
    }
    const model = inline(arg, "--model");
    if (arg === "--model" || model !== undefined) {
      opts.model = model ?? value(args, i++, "--model");
      continue;
    }
    const endpoint = inline(arg, "--endpoint");
    if (arg === "--endpoint" || endpoint !== undefined) {
      opts.endpoint = endpoint ?? value(args, i++, "--endpoint");
      continue;
    }
    const apiKey = inline(arg, "--api-key");
    if (arg === "--api-key" || apiKey !== undefined) {
      opts.api_key = apiKey ?? value(args, i++, "--api-key");
      continue;
    }
    const apiKeyEnv = inline(arg, "--api-key-env");
    if (arg === "--api-key-env" || apiKeyEnv !== undefined) {
      opts.api_key_env = apiKeyEnv ?? value(args, i++, "--api-key-env");
      continue;
    }
    const temperature = inline(arg, "--temperature");
    if (arg === "--temperature" || temperature !== undefined) {
      opts.temperature = parseNumber(
        temperature ?? value(args, i++, "--temperature"),
        "--temperature",
      );
      continue;
    }
    const maxTokens = inline(arg, "--max-tokens");
    if (arg === "--max-tokens" || maxTokens !== undefined) {
      opts.max_tokens = parsePositiveInt(
        maxTokens ?? value(args, i++, "--max-tokens"),
        "--max-tokens",
      );
      continue;
    }
    const timeoutMs = inline(arg, "--timeout-ms");
    if (arg === "--timeout-ms" || timeoutMs !== undefined) {
      opts.timeout_ms = parsePositiveInt(
        timeoutMs ?? value(args, i++, "--timeout-ms"),
        "--timeout-ms",
      );
      continue;
    }
    const host = inline(arg, "--host");
    if (arg === "--host" || host !== undefined) {
      opts.host = host ?? value(args, i++, "--host");
      continue;
    }
    const port = inline(arg, "--port");
    if (arg === "--port" || port !== undefined) {
      opts.port = parsePositiveInt(port ?? value(args, i++, "--port"), "--port");
      continue;
    }
    throw new Error(`unknown installer option '${arg}'`);
  }
  return opts;
}

export async function runInstallerCli(args = process.argv.slice(2)): Promise<void> {
  try {
    const opts = parseInstallerArgs(args);
    const result = await runInstallerFlow(opts);
    if (opts.json) {
      console.log(JSON.stringify({
        env_file: result.setup.output_path,
        backup_path: result.setup.backup_path,
        provider: result.setup.config.llm.provider,
        doctor_ok: result.doctor?.ok,
        settings_url: result.settings_url,
        serve_started: result.serve_started,
        next_action: result.next_action,
      }, null, 2));
      return;
    }
    console.log(`blue-tanuki guided installer wrote ${result.setup.output_path}`);
    if (result.setup.backup_path) console.log(`previous env backed up to ${result.setup.backup_path}`);
    console.log(`provider=${result.setup.config.llm.provider}`);
    console.log(`settings=${result.settings_url}`);
    console.log(`serve_started=${result.serve_started}`);
    console.log(`next_action=${result.next_action}`);
  } catch (e) {
    console.error(`blue-tanuki guided installer failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await runInstallerCli();
}
