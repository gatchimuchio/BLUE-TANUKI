import { requireToolOperationDescriptor, type FileSearchTargetVersionObservation } from "@blue-tanuki/protocol";

/**
 * Tool registry.
 *
 * Phase 0 ships an empty registry plus a tiny `echo` tool for smoke testing.
 * Phase 1+ will register OpenClaw-equivalent tools:
 *   - browser, canvas, file_ops, web_fetch, sessions, cron, channels.*
 */

export interface ToolContext {
  command_id: string;
  upstream_commit_hash: string;
  /** Stable digest for downstream duplicate lookup; it grants no authority. */
  idempotency_key?: string;
  /** Digest of the exact approved command; adapters may bind external receipts to it. */
  command_digest?: string;
  /** Broker evidence bound to the exact HDS-issued file.search command. */
  target_version_observation?: FileSearchTargetVersionObservation;
  signal?: AbortSignal;
}

export type ToolCapability = string;

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly required_capabilities?: readonly ToolCapability[];
  /** Read-only target resolver; Executor only trusts the registered built-in file.search adapter. */
  inspect_target_version?(args: Record<string, unknown>, options?: {
    env?: Readonly<Record<string, string | undefined>>;
  }): Promise<FileSearchTargetVersionObservation>;
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool[] {
    return Array.from(this.tools.values());
  }

  listCapabilities(): readonly ToolCapability[] {
    const caps = new Set<ToolCapability>();
    for (const tool of this.tools.values()) {
      for (const cap of tool.required_capabilities ?? []) {
        caps.add(cap);
      }
    }
    return Array.from(caps).sort();
  }
}

/**
 * Phase 0 sample tool. Removed/replaced in Phase 1.
 */
export const echoTool: Tool = {
  name: "echo",
  description: "Returns its arguments verbatim. Phase 0 smoke test only.",
  required_capabilities: requireToolOperationDescriptor("echo").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return { echoed: args };
  },
};
