import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { requireToolOperationDescriptor, type OperationAdapterKind, type OperationState } from "@blue-tanuki/protocol";
import type { Tool, ToolContext } from "./registry.js";

type Env = Record<string, string | undefined>;

export interface ShellExecOptions {
  env?: Env;
  signal?: AbortSignal;
}

export interface ShellOperationAdapterMetadata {
  role: "execution_adapter";
  adapter: OperationAdapterKind;
  operation: "tool.shell.exec";
  state: Extract<OperationState, "succeeded" | "failed">;
  adapter_is_authority: false;
  command_generated_by_adapter_only: true;
  raw_command_is_core_operation: false;
  adapter_result_used_for_authority: false;
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
  validateShellCommand(cmd, argv);
  const timeoutMs = positiveIntArg(args, "timeout_ms", 15_000, 60_000);
  const maxBytes = positiveIntArg(args, "max_bytes", 64_000, 512_000);
  const signal = opts.signal;

  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("shell.exec aborted before spawn"));
      return;
    }
    const child = spawn(cmd, argv, {
      cwd,
      env: safeProcessEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
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
      killChildTree(child.pid);
      done({
        cwd: displayPath(path.relative(shellRoot, cwd) || "."),
        exit_code: null,
        signal: "timeout",
        timed_out: true,
        stdout,
        stderr,
        truncated: true,
        operation_core: shellOperationAdapterMetadata("failed"),
      });
    }, timeoutMs);
    const onAbort = (): void => {
      killChildTree(child.pid);
      done({
        cwd: displayPath(path.relative(shellRoot, cwd) || "."),
        exit_code: null,
        signal: "aborted",
        timed_out: true,
        stdout,
        stderr,
        truncated: true,
        operation_core: shellOperationAdapterMetadata("failed"),
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.on("error", fail);
    child.on("close", (code, signal) => {
      opts.signal?.removeEventListener("abort", onAbort);
      done({
        cwd: displayPath(path.relative(shellRoot, cwd) || "."),
        exit_code: code,
        signal,
        timed_out: false,
        stdout,
        stderr,
        truncated,
        operation_core: shellOperationAdapterMetadata(code === 0 ? "succeeded" : "failed"),
      });
    });
  });
}

export const shellExecTool: Tool = {
  name: "shell.exec",
  description: "Run a bounded non-shell command under BLUE_TANUKI_SHELL_ROOT.",
  required_capabilities: requireToolOperationDescriptor("shell.exec").required_capabilities,
  async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    return await invokeShellExec(args, { signal: ctx.signal });
  },
};

function validateShellCommand(cmd: string, argv: readonly string[]): void {
  if (path.isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    throw new Error("shell.exec cmd must be a command name on PATH, not an absolute or relative path");
  }
  const deniedCommands = new Set([
    "rm",
    "rmdir",
    "del",
    "erase",
    "shred",
    "dd",
    "mkfs",
    "format",
    "diskpart",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "sudo",
    "su",
  ]);
  if (deniedCommands.has(cmd.toLowerCase())) {
    throw new Error(`shell.exec command denied by destructive-command policy: ${cmd}`);
  }
  for (const arg of argv) {
    const normalized = arg.trim().toLowerCase();
    if (
      normalized === "/" ||
      normalized === "\\" ||
      normalized === "--no-preserve-root" ||
      normalized === "-rf" ||
      normalized === "-fr" ||
      normalized.includes("..")
    ) {
      throw new Error(`shell.exec argument denied by destructive-argument policy: ${arg}`);
    }
  }
}

function killChildTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid);
      return;
    }
    process.kill(-pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 250).unref();
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone or not killable.
    }
  }
}

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

function shellOperationAdapterMetadata(
  state: Extract<OperationState, "succeeded" | "failed">,
): ShellOperationAdapterMetadata {
  return {
    role: "execution_adapter",
    adapter: "shell",
    operation: "tool.shell.exec",
    state,
    adapter_is_authority: false,
    command_generated_by_adapter_only: true,
    raw_command_is_core_operation: false,
    adapter_result_used_for_authority: false,
  };
}
