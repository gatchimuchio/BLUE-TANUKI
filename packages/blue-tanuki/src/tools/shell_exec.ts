import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { requireToolOperationDescriptor } from "@blue-tanuki/protocol";
import type { Tool, ToolContext } from "./registry.js";
import { isSecretLikeRelativePath } from "./file_safety.js";

type Env = Record<string, string | undefined>;

export interface ShellExecOptions {
  env?: Env;
  signal?: AbortSignal;
  /** Native test seam; production uses the package-local, built helper. */
  nativeProviderPath?: string;
}

export interface ShellOperationAdapterMetadata {
  role: "execution_adapter";
  adapter: "shell";
  operation: "tool.shell.exec";
  state: "succeeded" | "failed";
  adapter_is_authority: false;
  command_generated_by_adapter_only: true;
  raw_command_is_core_operation: false;
  adapter_result_used_for_authority: false;
}

interface NativeShellResult {
  exit_code: number | null;
  signal: "timeout" | "aborted" | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  process_tree_empty: true;
  descendants_terminated: boolean;
}

const WINDOWS_ISOLATOR_FILENAME = "blue-tanuki-windows-isolation.exe";
const LINUX_ISOLATOR_FILENAME = "blue-tanuki-linux-isolation";
const MAX_NATIVE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_ERROR_BYTES = 16 * 1024;
const PROCESS_TREE_SHUTDOWN_GRACE_MS = 5_000;
const SHELL_EXEC_DISABLED_REASON =
  "shell.exec is disabled because no verified OS-level process isolation provider is connected; no process was started";

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

  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error(SHELL_EXEC_DISABLED_REASON);
  }
  if (opts.signal?.aborted) {
    throw new Error("shell.exec aborted before isolated process creation");
  }

  const providerPath = opts.nativeProviderPath ??
    (process.platform === "win32" ? packagedWindowsProviderPath() : packagedLinuxProviderPath());
  await assertProviderOutsideRoot(providerPath, shellRoot, process.platform);
  const safeEnv = process.platform === "win32"
    ? safeHelperEnvironment(env, shellRoot)
    : safeLinuxHelperEnvironment();
  const native = await invokeNativeProvider(
    providerPath,
    {
      root: shellRoot,
      cwd,
      command: cmd,
      args: argv,
      timeoutMs,
      maxBytes,
    },
    safeEnv,
    opts.signal,
    process.platform,
  );

  return {
    cwd: displayPath(path.relative(shellRoot, cwd) || "."),
    exit_code: native.exit_code,
    signal: native.signal,
    timed_out: native.timed_out,
    stdout: native.stdout,
    stderr: native.stderr,
    truncated: native.truncated,
    process_tree_empty: native.process_tree_empty,
    descendants_terminated: native.descendants_terminated,
    operation_core: shellOperationAdapterMetadata(
      native.signal === null && native.exit_code === 0 ? "succeeded" : "failed",
    ),
  };
}

export async function shellExecIsolationProviderAvailable(): Promise<boolean> {
  if (process.platform === "win32") {
    return await fs
      .stat(packagedWindowsProviderPath())
      .then((stat) => stat.isFile())
      .catch(() => false);
  }
  if (process.platform !== "linux" || typeof process.getuid !== "function") return false;
  const uid = process.getuid();
  const runtimeDirectory = `/run/user/${uid}`;
  const required = [
    packagedLinuxProviderPath(),
    "/usr/bin/bwrap",
    "/usr/bin/systemd-run",
    "/usr/bin/systemctl",
    `${runtimeDirectory}/bus`,
    `${runtimeDirectory}/systemd/private`,
  ];
  const available = await Promise.all(required.map(async (filepath, index) => {
    const stat = await fs.stat(filepath).catch(() => null);
    if (!stat) return false;
    return index >= required.length - 2 ? stat.isSocket() : stat.isFile();
  }));
  if (available.some((value) => !value)) return false;
  const controllers = await fs.readFile("/sys/fs/cgroup/cgroup.controllers", "utf8").catch(() => "");
  return ["cpu", "memory", "pids"].every((controller) => controllers.split(/\s+/u).includes(controller));
}

export const shellExecTool: Tool = {
  name: "shell.exec",
  description:
    "Run a bounded command inside the verified Windows or Linux isolation provider; unavailable when native isolation is not built.",
  required_capabilities: requireToolOperationDescriptor("shell.exec").required_capabilities,
  async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    return await invokeShellExec(args, { signal: ctx.signal });
  },
};

function packagedWindowsProviderPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../native",
    WINDOWS_ISOLATOR_FILENAME,
  );
}

function packagedLinuxProviderPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../native",
    LINUX_ISOLATOR_FILENAME,
  );
}

async function assertProviderOutsideRoot(
  providerPath: string,
  shellRoot: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const platformLabel = isolationPlatformLabel(platform);
  const realProvider = await fs.realpath(providerPath).catch(() => {
    throw new Error(`shell.exec ${platformLabel} isolation provider is not installed; no process was started`);
  });
  const stat = await fs.stat(realProvider);
  if (!stat.isFile() || pathInside(shellRoot, realProvider)) {
    throw new Error(`shell.exec ${platformLabel} isolation provider path is invalid; no process was started`);
  }
}

function isolationPlatformLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function safeLinuxHelperEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("shell.exec Linux isolation requires a user session");
  const runtimeDirectory = `/run/user/${uid}`;
  return {
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
    LANG: "C.UTF-8",
  };
}

function safeHelperEnvironment(env: Env, shellRoot: string): NodeJS.ProcessEnv {
  const pathValue = envValue(env, "PATH") ?? envValue(env, "Path");
  const systemRoot = envValue(env, "SystemRoot") ?? envValue(env, "WINDIR");
  if (!pathValue || !systemRoot) {
    throw new Error("shell.exec requires PATH and SystemRoot for isolated command startup");
  }
  const safe: NodeJS.ProcessEnv = {
    PATH: pathValue,
    SystemRoot: systemRoot,
    TEMP: shellRoot,
    TMP: shellRoot,
    HOME: shellRoot,
    USERPROFILE: shellRoot,
  };
  const drive = path.parse(shellRoot).root;
  if (/^[a-z]:\\$/i.test(drive)) {
    safe[`=${drive[0]}:`] = shellRoot;
  }
  return safe;
}

function envValue(env: Env, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

interface NativeRequest {
  root: string;
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
  maxBytes: number;
}

function invokeNativeProvider(
  providerPath: string,
  request: NativeRequest,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<NativeShellResult> {
  const child = spawn(
    providerPath,
    [
      "--root",
      request.root,
      "--cwd",
      request.cwd,
      "--timeout-ms",
      String(request.timeoutMs),
      "--max-output-bytes",
      String(request.maxBytes),
      "--",
      request.command,
      ...request.args,
    ],
    {
      cwd: request.root,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let watchdog: NodeJS.Timeout | undefined;
    let cancelFallback: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (watchdog) clearTimeout(watchdog);
      if (cancelFallback) clearTimeout(cancelFallback);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = (): void => {
      if (settled) return;
      try {
        child.stdin?.write("cancel\n");
      } catch {
        child.kill();
      }
      cancelFallback = setTimeout(() => child.kill(), PROCESS_TREE_SHUTDOWN_GRACE_MS);
    };
    const onAbort = (): void => cancel();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > MAX_NATIVE_RESPONSE_BYTES) {
        fail(new Error("shell.exec native isolation response exceeded its bound"));
        child.kill();
        return;
      }
      stdout.push(buffer);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_NATIVE_ERROR_BYTES - stderrBytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        stderr.push(kept);
        stderrBytes += kept.byteLength;
      }
    });
    child.on("error", () => fail(new Error("shell.exec native isolation provider could not start")));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        const workspaceLockFailure = linuxWorkspaceLockFailure(platform, diagnostic);
        if (workspaceLockFailure) {
          reject(new Error(workspaceLockFailure));
          return;
        }
        const safeDiagnostic = /^[a-zA-Z0-9_:.-]{1,256}$/.test(diagnostic) ? ` (${diagnostic})` : "";
        reject(new Error(`shell.exec ${isolationPlatformLabel(platform)} isolation failed before a verified result was produced${safeDiagnostic}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reject(new Error("shell.exec Windows isolation returned an invalid result"));
        return;
      }
      try {
        resolve(validateNativeResult(parsed));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("shell.exec Windows isolation result was invalid"));
      }
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    watchdog = setTimeout(cancel, request.timeoutMs + PROCESS_TREE_SHUTDOWN_GRACE_MS);
    if (signal?.aborted) onAbort();
  });
}

function linuxWorkspaceLockFailure(platform: NodeJS.Platform, diagnostic: string): string | undefined {
  if (platform !== "linux") return undefined;
  if (diagnostic === "linux_sandbox_start_or_shutdown_failed:workspace_lock_busy") {
    return "shell.exec Linux workspace is in use by another isolated operation; this command was not started. Retry after that operation finishes.";
  }
  if (diagnostic === "linux_sandbox_start_or_shutdown_failed:workspace_lock_unavailable") {
    return "shell.exec could not establish exclusive access to the Linux workspace; this command was not started. Check workspace access and filesystem lock support, then retry.";
  }
  return undefined;
}

function validateNativeResult(value: unknown): NativeShellResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("shell.exec Windows isolation returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  const keys = [
    "exit_code",
    "signal",
    "timed_out",
    "stdout",
    "stderr",
    "truncated",
    "process_tree_empty",
    "descendants_terminated",
  ];
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key)) ||
    !(result.exit_code === null || (Number.isInteger(result.exit_code) && Number(result.exit_code) >= 0)) ||
    !(result.signal === null || result.signal === "timeout" || result.signal === "aborted") ||
    typeof result.timed_out !== "boolean" ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.truncated !== "boolean" ||
    result.process_tree_empty !== true ||
    typeof result.descendants_terminated !== "boolean" ||
    (result.signal === null && result.exit_code === null) ||
    (result.signal !== null && result.exit_code !== null) ||
    result.timed_out !== (result.signal !== null)
  ) {
    throw new Error("shell.exec Windows isolation returned an invalid or unconfirmed result");
  }
  return result as unknown as NativeShellResult;
}

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

function shellArgs(args: Record<string, unknown>): string[] {
  const raw = args.args;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error("args must be an array of strings");
  }
  return raw;
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

async function shellRootFromEnv(env: Env): Promise<string> {
  const raw = envValue(env, "BLUE_TANUKI_SHELL_ROOT");
  if (!raw || raw.trim().length === 0) {
    throw new Error("BLUE_TANUKI_SHELL_ROOT is required for shell.exec");
  }
  const resolved = path.resolve(raw);
  const real = await fs.realpath(resolved);
  const stat = await fs.stat(real);
  if (!stat.isDirectory() || isSecretLikeRelativePath(path.relative(path.parse(real).root, real))) {
    throw new Error("BLUE_TANUKI_SHELL_ROOT must be a dedicated, non-secret directory");
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
  if (isSecretLikeRelativePath(path.relative(shellRoot, real))) {
    throw new Error("shell.exec cwd is inside a secret-like path");
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new Error("shell.exec cwd must be a directory");
  }
  return real;
}

function pathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function displayPath(filepath: string): string {
  return filepath.replace(/\\/g, "/");
}

function shellOperationAdapterMetadata(
  state: "succeeded" | "failed",
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
