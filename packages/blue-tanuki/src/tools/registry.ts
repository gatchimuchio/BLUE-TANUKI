import { requireToolOperationDescriptor, type FileSearchTargetVersionObservation,
  type FileWriteTargetVersionObservation, type FileDeleteTargetVersionObservation,
  type FileEditTargetVersionObservation, type GmailWriteTargetVersionObservation,
  type GoogleCalendarWriteTargetVersionObservation } from "@blue-tanuki/protocol";
import type { ShellExecTargetVersionObservation } from "@blue-tanuki/protocol";

export type BrokerTargetVersionObservation = FileSearchTargetVersionObservation | FileWriteTargetVersionObservation |
  FileDeleteTargetVersionObservation | FileEditTargetVersionObservation | ShellExecTargetVersionObservation |
  GmailWriteTargetVersionObservation | GoogleCalendarWriteTargetVersionObservation;

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

/** Exact sandbox-relative deletion target and version, revealed only on the authenticated owner-review endpoint. */
export interface FileDeleteTargetContentReview {
  kind: "file_delete_target";
  path: string;
  size_bytes: number;
  max_bytes: number;
  target_version_digest: string;
  operation_plan_binding_digest: string;
  request_payload_digest: string;
  command_digest: string;
  review_digest: string;
  used_for_authority: false;
  may_execute: false;
}

/** Exact planned Calendar event and the unchanged freebusy result shown before owner approval. */
export interface GoogleCalendarEventCreateContentReview {
  kind: "google_calendar_event_create";
  operation: "google.calendar.write.event.create";
  calendar_id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  time_zone?: string;
  source_observation_digest: string;
  availability_result_digest: string;
  availability_observed_at: string;
  availability_window_start: string;
  availability_window_end: string;
  busy_intervals: readonly { start: string; end: string }[];
  overlapping_busy_intervals: readonly { start: string; end: string }[];
  request_payload_digest: string;
  command_digest: string;
  review_digest: string;
  used_for_authority: false;
  may_execute: false;
}

/** Exact target and single-field replacement shown before an approved event update. */
export interface GoogleCalendarEventUpdateContentReview {
  kind: "google_calendar_event_update";
  operation: "google.calendar.write.event.update";
  target_scope: "single_event" | "series" | "occurrence";
  calendar_id: string;
  event_id: string;
  current_summary: string | null;
  new_summary: string;
  event_start: string;
  event_end: string;
  event_time_kind: "date" | "date_time";
  event_time_zone: string | null;
  recurrence_rules: readonly string[];
  recurring_event_id: string | null;
  original_start: { value: string; kind: "date" | "date_time"; time_zone: string | null } | null;
  organizer_self: true;
  other_attendee_count: 0;
  attendee_inventory_complete: true;
  event_state_digest: string;
  observed_at: string;
  request_payload_digest: string;
  command_digest: string;
  review_digest: string;
  used_for_authority: false;
  may_execute: false;
}

/** Exact primary-calendar event and verified ownership/impact boundary before deletion. */
export interface GoogleCalendarEventDeleteContentReview {
  kind: "google_calendar_event_delete";
  operation: "google.calendar.write.event.delete";
  target_scope: "single_event" | "series" | "occurrence";
  calendar_id: string;
  event_id: string;
  current_summary: string | null;
  event_start: string;
  event_end: string;
  event_time_kind: "date" | "date_time";
  event_time_zone: string | null;
  recurrence_rules: readonly string[];
  recurring_event_id: string | null;
  original_start: { value: string; kind: "date" | "date_time"; time_zone: string | null } | null;
  organizer_self: true;
  other_attendee_count: 0;
  attendee_inventory_complete: true;
  event_state_digest: string;
  observed_at: string;
  request_payload_digest: string;
  command_digest: string;
  review_digest: string;
  used_for_authority: false;
  may_execute: false;
}

export type ToolContentReview = GmailDraftContentReview | FileEditDiffContentReview | FileDeleteTargetContentReview |
  GoogleCalendarEventCreateContentReview | GoogleCalendarEventUpdateContentReview | GoogleCalendarEventDeleteContentReview;

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

/** Keep an already-cancelled Executor request from dispatching a new adapter request. */
export function assertToolExecutionNotCancelled(signal: AbortSignal | undefined, toolName: string): void {
  if (signal?.aborted) throw new Error(`${toolName} cancelled before request dispatch`);
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
  /** No-store content/target projection revealed only through the authenticated owner-review endpoint. */
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
