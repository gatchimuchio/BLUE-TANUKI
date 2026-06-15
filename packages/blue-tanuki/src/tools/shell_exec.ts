import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Tool } from "./registry.js";

type Env = Record<string, string | undefined>;

export interface ShellExecOptions {
  env?: Env;
}

export async function invokeShellExec(
  args: Record<string, unknown>,
  opts: ShellExecOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const shellRoot = await shellRootFromEnv(env);
  const cwd = await resolveShellCwd(stringArg(args, "cwd", false), shellRoot);
  const cmd = stringArg(args, "cmd", false) ?? stringArg(args, "command")!;
  const argv = shellArgs(args);
  const timeoutMs = positiveIntArg(args, "timeout_ms", 15_000, 60_000);
  const maxBytes = positiveIntArg(args, "max_bytes", 64_000, 512_000);

  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd,
      env: safeProcessEnv(),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let keptBytes = 0;
    let truncated = false;
    let settled = false;
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const bytes = Buffer.byteLength(text, "utf8");
      if (keptBytes < maxBytes) {
        const remaining = maxBytes - keptBytes;
        const keep = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
        if (stream === "stdout") stdout += keep;
        else stderr += keep;
        keptBytes += Buffer.byteLength(keep, "utf8");
      }
      if (keptBytes + bytes > maxBytes) truncated = true;
    };
    const done = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      done({
        cwd: displayPath(path.relative(shellRoot, cwd) || "."),
        exit_code: null,
        signal: "timeout",
        timed_out: true,
        stdout,
        stderr,
        truncated: true,
      });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.on("error", fail);
    child.on("close", (code, signal) => {
      done({
        cwd: displayPath(path.relative(shellRoot, cwd) || "."),
        exit_code: code,
        signal,
        timed_out: false,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

export const shellExecTool: Tool = {
  name: "shell.exec",
  description: "Run a bounded non-shell command under BLUE_TANUKI_SHELL_ROOT.",
  required_capabilities: ["tool:shell.exec", "shell:exec"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeShellExec(args);
  },
};

async function shellRootFromEnv(env: Env): Promise<string> {
  const raw = env.BLUE_TANUKI_SHELL_ROOT;
  if (!raw || raw.trim().length === 0) {
    throw new Error("BLUE_TANUKI_SHELL_ROOT is required for shell.exec");
  }
  const resolved = path.resolve(raw);
  const real = await fs.realpath(resolved);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new Error("BLUE_TANUKI_SHELL_ROOT must be a directory");
  }
  return real;
}

async function resolveShellCwd(cwdArg: string | undefined, shellRoot: string): Promise<string> {
  const lexical = path.resolve(shellRoot, cwdArg ?? ".");
  if (!pathInside(shellRoot, lexical)) {
    throw new Error("shell.exec cwd must stay within BLUE_TANUKI_SHELL_ROOT");
  }
  const real = await fs.realpath(lexical);
  if (!pathInside(shellRoot, real)) {
    throw new Error("shell.exec cwd escapes BLUE_TANUKI_SHELL_ROOT via symlink");
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new Error("shell.exec cwd must be a directory");
  }
  return real;
}

function shellArgs(args: Record<string, unknown>): string[] {
  const raw = args.args;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error("args must be an array of strings");
  }
  return raw;
}

function safeProcessEnv(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "Path",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name]) out[name] = process.env[name];
  }
  return out;
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`${name} must be a non-empty string`);
  return undefined;
}

function positiveIntArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, max);
}

function pathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function displayPath(filepath: string): string {
  return filepath.replace(/\\/g, "/");
}
