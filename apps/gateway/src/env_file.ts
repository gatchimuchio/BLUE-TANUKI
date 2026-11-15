import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ParsedEnvFile {
  values: Record<string, string>;
  warnings: string[];
}

export interface LoadEnvFileOptions {
  env?: NodeJS.ProcessEnv;
  override?: boolean;
}

export interface LoadEnvFileResult {
  path: string;
  applied: string[];
  skipped: string[];
  warnings: string[];
}

export interface WriteEnvFileOptions {
  mode?: number;
  backup?: boolean;
  backup_label?: string;
}

export interface WriteEnvFileResult {
  path: string;
  backup_path?: string;
}

function parseEnvValue(raw: string, lineNo: number): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== "string") {
        throw new Error("quoted value did not parse to a string");
      }
      return parsed;
    } catch (e) {
      throw new Error(
        `line ${lineNo}: invalid double-quoted value (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvFile(raw: string): ParsedEnvFile {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      warnings.push(`line ${lineNo}: ignored malformed env entry`);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push(`line ${lineNo}: ignored invalid env key '${key}'`);
      continue;
    }
    values[key] = parseEnvValue(trimmed.slice(eq + 1), lineNo);
  }
  return { values, warnings };
}

export async function loadEnvFile(
  filePath: string,
  options: LoadEnvFileOptions = {},
): Promise<LoadEnvFileResult> {
  const env = options.env ?? process.env;
  const resolved = path.resolve(filePath);
  const parsed = parseEnvFile(await fs.readFile(resolved, "utf8"));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed.values)) {
    if (!options.override && env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return {
    path: resolved,
    applied,
    skipped,
    warnings: parsed.warnings,
  };
}

function backupSuffix(label: string): string {
  const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, "-") || "backup";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}.${process.pid}.${safeLabel}.bak`;
}

export async function backupEnvFileIfExists(
  filePath: string,
  label = "backup",
): Promise<string | undefined> {
  const resolved = path.resolve(filePath);
  const exists = await fs
    .stat(resolved)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!exists) return undefined;
  const backupPath = `${resolved}.${backupSuffix(label)}`;
  await fs.copyFile(resolved, backupPath);
  return backupPath;
}

export async function writeEnvFileAtomic(
  filePath: string,
  content: string,
  options: WriteEnvFileOptions = {},
): Promise<WriteEnvFileResult> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const backupPath = options.backup
    ? await backupEnvFileIfExists(resolved, options.backup_label)
    : undefined;
  const tmpPath = `${resolved}.tmp-${process.pid}-${randomUUID()}`;
  let tmpHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let ownsTempFile = false;
  let renamed = false;
  try {
    tmpHandle = await fs.open(tmpPath, "wx", options.mode ?? 0o600);
    ownsTempFile = true;
    await tmpHandle.writeFile(content, "utf8");
    await tmpHandle.chmod(options.mode ?? 0o600).catch(() => undefined);
    // Flush the complete replacement before making it visible at the target path.
    await tmpHandle.sync();
    await tmpHandle.close();
    tmpHandle = undefined;
    await fs.rename(tmpPath, resolved);
    renamed = true;
    return backupPath
      ? { path: resolved, backup_path: backupPath }
      : { path: resolved };
  } catch (e) {
    await tmpHandle?.close().catch(() => undefined);
    if (ownsTempFile && !renamed) await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }
}

export function envFilePathFromArgv(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env-file") {
      const value = argv[i + 1];
      if (!value) throw new Error("--env-file requires a path");
      return value;
    }
    if (arg?.startsWith("--env-file=")) {
      const value = arg.slice("--env-file=".length);
      if (!value) throw new Error("--env-file requires a path");
      return value;
    }
  }
  return env.BLUE_TANUKI_ENV_FILE;
}

export function stripEnvFileArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--env-file") {
      i += 1;
      continue;
    }
    if (arg?.startsWith("--env-file=")) continue;
    out.push(arg);
  }
  return out;
}

export async function loadEnvFileFromArgv(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadEnvFileResult | undefined> {
  const envFile = envFilePathFromArgv(argv, env);
  if (!envFile) return undefined;
  return loadEnvFile(envFile, { env });
}
