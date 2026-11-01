import { requireToolOperationDescriptor, type FileSearchTargetVersionObservation,
  type FileWriteTargetVersionObservation, type FileDeleteTargetVersionObservation,
  type FileEditTargetVersionObservation, type GmailWriteTargetVersionObservation,
  type GoogleCalendarWriteTargetVersionObservation, type GoogleDriveWriteTargetVersionObservation,
  type GoogleDriveUpdateTargetVersionObservation,
  type GoogleDrivePermissionCreateTargetVersionObservation,
  type GoogleDriveTrashTargetVersionObservation } from "@blue-tanuki/protocol";
import type { ShellExecTargetVersionObservation } from "@blue-tanuki/protocol";

export type BrokerTargetVersionObservation = FileSearchTargetVersionObservation | FileWriteTargetVersionObservation |
  FileDeleteTargetVersionObservation | FileEditTargetVersionObservation | ShellExecTargetVersionObservation |
  GmailWriteTargetVersionObservation | GoogleCalendarWriteTargetVersionObservation |
  GoogleDriveWriteTargetVersionObservation | GoogleDriveUpdateTargetVersionObservation |
  GoogleDrivePermissionCreateTargetVersionObservation | GoogleDriveTrashTargetVersionObservation;

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
  attendees: readonly string[];
  invite_notifications_requested: boolean;
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

/** No-store view of retained attendees, new invitees, and all guests receiving Calendar update notices. */
export interface GoogleCalendarEventInviteContentReview {
  kind: "google_calendar_event_invite";
  operation: "google.calendar.write.event.invite";
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
  other_attendee_count: number;
  attendee_inventory_complete: true;
  retained_attendees: readonly string[];
  retained_attendee_count: number;
  invitees: readonly string[];
  notification_recipients: readonly string[];
  notification_recipient_count: number;
  notification_effect: "send_calendar_update_notifications_to_all_attendees";
  event_state_digest: string;
  observed_at: string;
  request_payload_digest: string;
  command_digest: string;
  review_digest: string;
  used_for_authority: false;
  may_execute: false;
}

export interface GoogleDrivePermissionDetailReview {
  permission_type: string | null;
  role: string | null;
  inherited: boolean | null;
  inherited_from: string | null;
}

export interface GoogleDrivePermissionReview {
  type: "user" | "group" | "domain" | "anyone";
  role: string;
  email_address: string | null;
  domain: string | null;
  allow_file_discovery: boolean | null;
  expiration_time: string | null;
  deleted: boolean;
  permission_details: readonly GoogleDrivePermissionDetailReview[];
}

/** No-store owner projection of an exact create payload and the folder's effective Drive access scope. */
export interface GoogleDriveFileCreateContentReview {
  kind: "google_drive_file_create";
  operation: "google.drive.write.file.create";
  command_digest: string;
  review_digest: string;
  request_payload_digest: string;
  target_version_digest: string;
  operation_plan_binding_digest: string;
  parent_folder_id: string;
  parent_folder_name: string;
  parent_folder_drive_id: string | null;
  parent_folder_version: string | null;
  parent_folder_modified_time: string | null;
  parent_folder_shared: boolean | null;
  parent_inherited_permissions_disabled: boolean | null;
  parent_access_scope_complete: true;
  parent_access_scope_digest: string;
  target_name_absent: true;
  permissions: readonly GoogleDrivePermissionReview[];
  name: string;
  mime_type: "text/plain";
  content: string;
  content_bytes: number;
  used_for_authority: false;
  may_execute: false;
}

/** No-store owner projection of the exact old/new text and target file access scope for file.update. */
export interface GoogleDriveFileUpdateContentReview {
  kind: "google_drive_file_update";
  operation: "google.drive.write.file.update";
  command_digest: string;
  review_digest: string;
  request_payload_digest: string;
  target_version_digest: string;
  operation_plan_binding_digest: string;
  file_id: string;
  file_name: string;
  parent_ids: readonly string[];
  drive_id: string | null;
  file_version: string;
  file_modified_time: string | null;
  file_shared: boolean | null;
  inherited_permissions_disabled: boolean | null;
  file_mime_type: "text/plain";
  target_access_scope_complete: true;
  target_access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
  current_content_digest: string;
  current_content: string;
  current_content_bytes: number;
  replacement_content: string;
  replacement_content_bytes: number;
  used_for_authority: false;
  may_execute: false;
}

/** No-store owner projection of one exact direct-user Drive permission grant. */
export interface GoogleDrivePermissionCreateContentReview {
  kind: "google_drive_permission_create";
  operation: "google.drive.write.permissions.create";
  command_digest: string;
  review_digest: string;
  request_payload_digest: string;
  target_version_digest: string;
  operation_plan_binding_digest: string;
  file_id: string;
  file_name: string;
  parent_ids: readonly string[];
  drive_id: string | null;
  file_version: string;
  file_modified_time: string | null;
  file_mime_type: "text/plain";
  file_shared: boolean | null;
  inherited_permissions_disabled: boolean | null;
  target_access_scope_complete: true;
  target_access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
  recipient_email: string;
  recipient_role: "reader" | "writer";
  notification_email_sent: false;
  ownership_transfer: false;
  used_for_authority: false;
  may_execute: false;
}

/** No-store owner projection of moving one exact owned Drive text file to trash. */
export interface GoogleDriveFileTrashContentReview {
  kind: "google_drive_file_trash";
  operation: "google.drive.write.file.trash";
  command_digest: string;
  review_digest: string;
  request_payload_digest: string;
  target_version_digest: string;
  operation_plan_binding_digest: string;
  file_id: string;
  file_name: string;
  parent_ids: readonly string[];
  drive_id: null;
  file_version: string;
  file_modified_time: string | null;
  file_mime_type: "text/plain";
  owner_confirmed: true;
  file_shared: boolean | null;
  inherited_permissions_disabled: boolean | null;
  target_access_scope_complete: true;
  target_access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
  reversible_trash_only: true;
  permanently_deletes: false;
  used_for_authority: false;
  may_execute: false;
}

export type ToolContentReview = GmailDraftContentReview | FileEditDiffContentReview | FileDeleteTargetContentReview |
  GoogleCalendarEventCreateContentReview | GoogleCalendarEventUpdateContentReview | GoogleCalendarEventDeleteContentReview |
  GoogleCalendarEventInviteContentReview | GoogleDriveFileCreateContentReview | GoogleDriveFileUpdateContentReview |
  GoogleDrivePermissionCreateContentReview | GoogleDriveFileTrashContentReview;

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
