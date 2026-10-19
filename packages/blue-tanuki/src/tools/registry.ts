import { requireToolOperationDescriptor, type FileSearchTargetVersionObservation,
  type FileWriteTargetVersionObservation, type FileDeleteTargetVersionObservation,
  type GmailWriteTargetVersionObservation } from "@blue-tanuki/protocol";

export type BrokerTargetVersionObservation = FileSearchTargetVersionObservation | FileWriteTargetVersionObservation |
  FileDeleteTargetVersionObservation | GmailWriteTargetVersionObservation;

/** Resume-authenticated, no-store-only projection of a fetched existing Gmail draft. */
export interface GmailDraftContentReview {
  account_email: string;
  from: string;
  to?: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  subject: string;
  body_text: string;
  provider_state_digest: string;
  provider_raw_digest: string;
  request_payload_digest: string;
}

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
  /** 実行権限を与えず、HDS発行commandへ結ぶBroker観測。 */
  target_version_observation?: BrokerTargetVersionObservation;
  signal?: AbortSignal;
}

export type ToolCapability = string;

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly required_capabilities?: readonly ToolCapability[];
  /** Read-only target resolver; Executor only trusts registered built-in adapters. */
  inspect_target_version?(args: Record<string, unknown>, options?: {
    env?: Readonly<Record<string, string | undefined>>;
    operation_plan_binding_digest?: string;
    command_digest?: string;
  }): Promise<BrokerTargetVersionObservation>;
  /** Exact plain-text-only content projection for a resume-authenticated draft review. */
  inspect_content_review?(args: Record<string, unknown>, options?: {
    env?: Readonly<Record<string, string | undefined>>;
  }): Promise<GmailDraftContentReview>;
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
