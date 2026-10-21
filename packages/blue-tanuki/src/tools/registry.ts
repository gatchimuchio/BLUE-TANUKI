import { requireToolOperationDescriptor, type FileSearchTargetVersionObservation,
  type FileWriteTargetVersionObservation, type FileDeleteTargetVersionObservation,
  type FileEditTargetVersionObservation, type GmailWriteTargetVersionObservation } from "@blue-tanuki/protocol";
import type { ShellExecTargetVersionObservation } from "@blue-tanuki/protocol";

export type BrokerTargetVersionObservation = FileSearchTargetVersionObservation | FileWriteTargetVersionObservation |
  FileDeleteTargetVersionObservation | FileEditTargetVersionObservation | ShellExecTargetVersionObservation |
  GmailWriteTargetVersionObservation;

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

/** Exact plan-bound replacement diff revealed only through the authenticated owner-review endpoint. */
export interface FileEditDiffContentReview {
  path: string;
  diff: string;
  replacement_count: number;
  before_content_digest: string;
  after_content_digest: string;
  target_version_digest: string;
  operation_plan_binding_digest: string;
  request_payload_digest: string;
  command_digest: string;
  review_digest: string;
  used_for_authority: false;
  may_execute: false;
}

export type ToolContentReview = GmailDraftContentReview | FileEditDiffContentReview;

/** Non-authority observations for an existing tool worker and its local stop result. */
export interface ToolExecutionLifecycleObservation {
  schema_version: "blue-tanuki.tool-execution-lifecycle.v1";
  source: "executor_tool_adapter" | "native_shell_process_provider";
  state: "cancel_requested" | "worker_started" | "worker_exit_observed" |
    "process_tree_empty_confirmed" | "provider_state_unknown" | "late_result_discarded";
  observed_at_ms: number;
  worker_pid?: number;
  worker_platform?: string;
  signal?: "timeout" | "aborted" | null;
  descendants_terminated?: boolean;
  used_for_authority: false;
  may_execute: false;
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
  /** Local worker lifecycle only; the observer cannot authorize or complete a command. */
  on_execution_lifecycle?: (event: ToolExecutionLifecycleObservation) => void;
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
    operation_plan_binding_digest?: string;
    command_digest?: string;
  }): Promise<ToolContentReview>;
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
