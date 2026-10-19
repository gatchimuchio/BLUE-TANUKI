import * as path from "node:path";
import { requireToolOperationDescriptor } from "@blue-tanuki/protocol";
import type { Tool, ToolContext } from "./registry.js";

export interface ShellExecOptions {
  signal?: AbortSignal;
}

const SHELL_EXEC_DISABLED_REASON =
  "shell.exec is disabled because no verified OS-level process isolation provider is connected; no process was started";

export async function invokeShellExec(
  args: Record<string, unknown>,
  opts: ShellExecOptions = {},
): Promise<unknown> {
  const cmd = stringArg(args, "cmd", false) ?? stringArg(args, "command")!;
  const argv = shellArgs(args);
  validateShellCommand(cmd, argv);

  if (opts.signal?.aborted) {
    throw new Error("shell.exec aborted before spawn");
  }

  // A cwd check and non-shell spawn do not isolate filesystem, network, environment,
  // or descendant processes. Keep this adapter closed until an OS-enforced provider
  // is connected to the production consumer.
  throw new Error(SHELL_EXEC_DISABLED_REASON);
}

export const shellExecTool: Tool = {
  name: "shell.exec",
  description:
    "Unavailable until a verified OS-level process isolation provider is connected; calls fail closed.",
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
