import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { requireToolOperationDescriptor, ShellExecTargetVersionObservationSchema,
  type ShellExecTargetVersionObservation } from "@blue-tanuki/protocol";
import type { Tool, ToolContext, ToolExecutionLifecycleObservation } from "./registry.js";
import { isSecretLikeRelativePath, sandboxRootFromEnv } from "./file_safety.js";

type Env = Record<string, string | undefined>;

export interface ShellExecOptions {
  env?: Env;
  signal?: AbortSignal;
  /** Native test seam; production uses the package-local, built helper. */
  nativeProviderPath?: string;
  targetVersionObservation?: ShellExecTargetVersionObservation;
  onExecutionLifecycle?: (event: ToolExecutionLifecycleObservation) => void;
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
  await assertSameFileWorkspaceWhenRequested(args, env, shellRoot);
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
  if (opts.targetVersionObservation) {
    const expected = ShellExecTargetVersionObservationSchema.parse(opts.targetVersionObservation);
    const current = await inspectShellExecTargetVersion(args, {
      env,
      command_digest: expected.command_digest,
      ...(expected.operation_plan_binding_digest
        ? { operation_plan_binding_digest: expected.operation_plan_binding_digest } : {}),
    });
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("shell.exec sandbox root or cwd changed after owner review; request fresh review");
    }
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
    opts.onExecutionLifecycle,
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
    "Run a bounded command inside the verified Windows or Linux isolation provider; unavailable when native isolation is not built. For a test of files under BLUE_TANUKI_FILE_ROOT, set same_workspace_as_file_root=true so review and execution reject a different workspace root.",
  required_capabilities: requireToolOperationDescriptor("shell.exec").required_capabilities,
  async inspect_target_version(args, options = {}) {
    return await inspectShellExecTargetVersion(args, options);
  },
  async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    if (ctx.target_version_observation?.schema_version !== "blue-tanuki.shell-exec-target-version.v1") {
      throw new Error("shell.exec requires Broker target version evidence; no process was started");
    }
    return await invokeShellExec(args, { signal: ctx.signal, targetVersionObservation: ctx.target_version_observation,
      onExecutionLifecycle: ctx.on_execution_lifecycle });
  },
};

export async function inspectShellExecTargetVersion(
  args: Record<string, unknown>,
  options: { env?: Readonly<Env>; operation_plan_binding_digest?: string; command_digest?: string } = {},
): Promise<ShellExecTargetVersionObservation> {
  const commandDigest = options.command_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest)) {
    throw new Error("shell.exec target resolver requires the exact command digest");
  }
  const operationPlanBindingDigest = options.operation_plan_binding_digest;
  if (operationPlanBindingDigest !== undefined && !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("shell.exec target resolver received an invalid Operation Plan binding");
  }
  const env = options.env ?? process.env;
  const command = stringArg(args, "cmd", false) ?? stringArg(args, "command")!;
  const argv = shellArgs(args);
  validateShellCommand(command, argv);
  positiveIntArg(args, "timeout_ms", 15_000, 60_000);
  positiveIntArg(args, "max_bytes", 64_000, 512_000);
  const shellRoot = await shellRootFromEnv(env);
  await assertSameFileWorkspaceWhenRequested(args, env, shellRoot);
  const cwd = await resolveShellCwd(stringArg(args, "cwd", false), shellRoot);
  const [rootIdentityDigest, cwdIdentityDigest] = await Promise.all([
    directoryIdentityDigest(shellRoot), directoryIdentityDigest(cwd),
  ]);
  return ShellExecTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.shell-exec-target-version.v1",
    command_digest: commandDigest,
    root_identity_digest: rootIdentityDigest,
    cwd_identity_digest: cwdIdentityDigest,
    operation_plan_binding_digest: operationPlanBindingDigest ?? null,
    used_for_authority: false,
    may_execute: false,
  });
}

async function directoryIdentityDigest(directory: string): Promise<string> {
  const real = await fs.realpath(directory);
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isDirectory() || stat.ino <= 0n) {
    throw new Error("shell.exec cannot establish a stable sandbox directory identity");
  }
  const canonicalPath = process.platform === "win32" ? path.win32.normalize(real).toLowerCase() : path.posix.normalize(real);
  return createHash("sha256").update(JSON.stringify({
    schema_version: "blue-tanuki.shell-directory-identity.v1",
    path: canonicalPath,
    device: stat.dev.toString(),
    file_id: stat.ino.toString(),
  }), "utf8").digest("hex");
}

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
  onExecutionLifecycle?: (event: ToolExecutionLifecycleObservation) => void,
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

  const report = (event: Omit<ToolExecutionLifecycleObservation, "schema_version" | "source" | "used_for_authority" | "may_execute">): void => {
    try {
      onExecutionLifecycle?.({ schema_version: "blue-tanuki.tool-execution-lifecycle.v1",
        source: "native_shell_process_provider", ...event, used_for_authority: false, may_execute: false });
    } catch { /* lifecycle evidence must never delay or suppress process cancellation */ }
  };

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closeObserved = false;
    let processTreeConfirmed = false;
    let providerStateUnknownReported = false;
    let watchdog: NodeJS.Timeout | undefined;
    let cancelFallback: NodeJS.Timeout | undefined;

    const reportProviderStateUnknown = (): void => {
      if (providerStateUnknownReported || processTreeConfirmed) return;
      providerStateUnknownReported = true;
      report({ state: "provider_state_unknown", observed_at_ms: Date.now(), worker_pid: child.pid,
        worker_platform: platform, signal: signal?.aborted ? "aborted" : null });
    };

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
      cancelFallback = setTimeout(() => {
        if (!closeObserved) {
          child.kill();
          reportProviderStateUnknown();
        }
      }, PROCESS_TREE_SHUTDOWN_GRACE_MS);
    };
    const onAbort = (): void => {
      cancel();
      report({ state: "cancel_requested", observed_at_ms: Date.now(), worker_pid: child.pid, worker_platform: platform,
        signal: "aborted" });
    };

    child.once("spawn", () => report({ state: "worker_started", observed_at_ms: Date.now(),
      worker_pid: child.pid, worker_platform: platform }));

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
      closeObserved = true;
      report({ state: "worker_exit_observed", observed_at_ms: Date.now(), worker_pid: child.pid, worker_platform: platform });
      if (settled) {
        reportProviderStateUnknown();
        return;
      }
      settled = true;
      cleanup();
      if (code !== 0) {
        reportProviderStateUnknown();
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        const safeDiagnostic = /^[a-zA-Z0-9_:.-]{1,256}$/.test(diagnostic) ? ` (${diagnostic})` : "";
        reject(new Error(`shell.exec ${isolationPlatformLabel(platform)} isolation failed before a verified result was produced${safeDiagnostic}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reportProviderStateUnknown();
        reject(new Error("shell.exec Windows isolation returned an invalid result"));
        return;
      }
      try {
        const validated = validateNativeResult(parsed);
        processTreeConfirmed = validated.process_tree_empty;
        report({ state: "process_tree_empty_confirmed", observed_at_ms: Date.now(), worker_pid: child.pid,
          worker_platform: platform, signal: validated.signal, descendants_terminated: validated.descendants_terminated });
        resolve(validated);
      } catch (error) {
        reportProviderStateUnknown();
        reject(error instanceof Error ? error : new Error("shell.exec Windows isolation result was invalid"));
      }
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    watchdog = setTimeout(cancel, request.timeoutMs + PROCESS_TREE_SHUTDOWN_GRACE_MS);
    if (signal?.aborted) onAbort();
  });
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

async function assertSameFileWorkspaceWhenRequested(
  args: Record<string, unknown>,
  env: Readonly<Env>,
  shellRoot: string,
): Promise<void> {
  const required = args.same_workspace_as_file_root;
  if (required !== undefined && typeof required !== "boolean") {
    throw new Error("shell.exec same_workspace_as_file_root must be a boolean");
  }
  if (required !== true) return;
  let fileRoot: string;
  try {
    fileRoot = await sandboxRootFromEnv(env);
  } catch {
    throw new Error("shell.exec same-workspace review requires a valid BLUE_TANUKI_FILE_ROOT");
  }
  if (fileRoot !== shellRoot) {
    throw new Error("shell.exec same-workspace review requires BLUE_TANUKI_FILE_ROOT and BLUE_TANUKI_SHELL_ROOT to resolve to the same directory");
  }
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
