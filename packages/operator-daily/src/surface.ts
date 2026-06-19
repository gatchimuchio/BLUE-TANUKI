import type { DailyOperationKind, DailyOperationSpec, DailySurfaceSnapshot } from "./types.js";
import { dailyBriefSnapshotFromEnv } from "./daily_brief_integration.js";
import { buildDailyOperationCoreProjection } from "./operation_core.js";

type Env = Record<string, string | undefined>;

export const DAILY_SURFACE_NAME = "daily" as const;

export const DAILY_OPERATOR_REQUIRED_PERMISSIONS = [
  "tool:schedule.list",
  "tool:schedule.create",
  "tool:schedule.update",
  "tool:schedule.delete",
  "schedule:read",
  "schedule:create",
  "schedule:update",
  "schedule:delete",
  "tool:gmail.read",
  "tool:google.calendar.read",
  "tool:google.drive.read",
  "tool:gmail.write",
  "tool:google.calendar.write",
  "tool:google.drive.write",
  "network:googleapis.com",
  "secrets:GOOGLE_ACCESS_TOKEN",
  "secrets:GMAIL_ACCESS_TOKEN",
  "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
  "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
  "google:gmail.read",
  "google:calendar.read",
  "google:drive.read",
  "google:gmail.write",
  "google:calendar.write",
  "google:drive.write",
  "channel:send",
  "external:send",
  "email:send",
] as const;

export const DAILY_OPERATION_SPECS: readonly DailyOperationSpec[] = [
  {
    kind: "daily_brief.status",
    label: "Inspect Daily Brief state",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["cron.process"],
    capabilities: [],
    audit_trace: ["surface", "daily_brief_enabled", "payload_hash"],
  },
  {
    kind: "google.gmail.read",
    label: "Read bounded Gmail summary",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["gmail.read"],
    capabilities: ["tool:gmail.read", "network:googleapis.com", "secrets:GMAIL_ACCESS_TOKEN", "google:gmail.read"],
    audit_trace: ["surface", "google_service", "result_digest"],
  },
  {
    kind: "google.calendar.read",
    label: "Read bounded Google Calendar summary",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["google.calendar.read"],
    capabilities: ["tool:google.calendar.read", "network:googleapis.com", "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN", "google:calendar.read"],
    audit_trace: ["surface", "google_service", "result_digest"],
  },
  {
    kind: "google.drive.read",
    label: "Read bounded Google Drive summary",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["google.drive.read"],
    capabilities: ["tool:google.drive.read", "network:googleapis.com", "secrets:GOOGLE_DRIVE_ACCESS_TOKEN", "google:drive.read"],
    audit_trace: ["surface", "google_service", "result_digest"],
  },
  {
    kind: "schedule.list",
    label: "List safe runtime schedule metadata",
    approval_level: "L1_observe",
    approval_risk: "low",
    final_review_required: false,
    downstream_tools: ["schedule.list"],
    capabilities: ["tool:schedule.list", "schedule:read"],
    audit_trace: ["surface", "schedule_id", "payload_hash"],
  },
  {
    kind: "reminder.draft",
    label: "Draft a reminder without activating future execution",
    approval_level: "L2_operate",
    approval_risk: "medium",
    final_review_required: false,
    downstream_tools: ["llm_call"],
    capabilities: [],
    audit_trace: ["surface", "source_type", "llm_input_digest", "llm_output_digest"],
  },
  {
    kind: "schedule.create",
    label: "Create runtime schedule through Approval Gate",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["schedule.create"],
    capabilities: ["tool:schedule.create", "schedule:create"],
    audit_trace: ["surface", "schedule_id", "payload_hash", "final_review_result"],
  },
  {
    kind: "schedule.update",
    label: "Update runtime schedule through Approval Gate",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["schedule.update"],
    capabilities: ["tool:schedule.update", "schedule:update"],
    audit_trace: ["surface", "schedule_id", "payload_hash", "final_review_result"],
  },
  {
    kind: "schedule.delete",
    label: "Delete runtime schedule through Approval Gate",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["schedule.delete"],
    capabilities: ["tool:schedule.delete", "schedule:delete"],
    audit_trace: ["surface", "schedule_id", "payload_hash", "final_review_result"],
  },
  {
    kind: "gmail.write",
    label: "Prepare Gmail external write",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["gmail.write"],
    capabilities: ["tool:gmail.write", "network:googleapis.com", "secrets:GMAIL_ACCESS_TOKEN", "google:gmail.write", "external:send", "email:send"],
    audit_trace: ["surface", "google_service", "external_target_summary", "final_review_result"],
  },
  {
    kind: "google.calendar.write",
    label: "Prepare Google Calendar external write",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["google.calendar.write"],
    capabilities: ["tool:google.calendar.write", "network:googleapis.com", "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN", "google:calendar.write"],
    audit_trace: ["surface", "google_service", "external_target_summary", "final_review_result"],
  },
  {
    kind: "google.drive.write",
    label: "Prepare Google Drive external write",
    approval_level: "L3_final_review",
    approval_risk: "high",
    final_review_required: true,
    downstream_tools: ["google.drive.write"],
    capabilities: ["tool:google.drive.write", "network:googleapis.com", "secrets:GOOGLE_DRIVE_ACCESS_TOKEN", "google:drive.write"],
    audit_trace: ["surface", "google_service", "external_target_summary", "final_review_result"],
  },
  {
    kind: "daily_brief.channel_send",
    label: "Send Daily Brief through existing channel path",
    approval_level: "existing_channel_path",
    approval_risk: "contextual",
    final_review_required: false,
    downstream_tools: ["channel_send"],
    capabilities: ["channel:send"],
    audit_trace: ["surface", "channel_target_summary", "payload_hash"],
  },
] as const;

export function getDailyOperationSpec(kind: DailyOperationKind): DailyOperationSpec {
  const spec = DAILY_OPERATION_SPECS.find((operation) => operation.kind === kind);
  if (!spec) throw new Error(`unknown Daily Operator operation: ${kind}`);
  return spec;
}

export function getDailySurfaceSnapshot(input: {
  env?: Env;
  scheduled_tasks?: readonly unknown[];
  runtime_schedules?: readonly unknown[];
} = {}): DailySurfaceSnapshot {
  return {
    surface: DAILY_SURFACE_NAME,
    layer: "A",
    status: "enabled",
    authority: "hds_brain_downstream_device",
    replaces_authority: false,
    raw_authority_added: false,
    daily_brief: dailyBriefSnapshotFromEnv(input.env),
    scheduled_tasks: input.scheduled_tasks ?? [],
    runtime_schedules: input.runtime_schedules ?? [],
    operations: DAILY_OPERATION_SPECS,
    operation_core_projection: buildDailyOperationCoreProjection(DAILY_OPERATION_SPECS),
    next_recommended_action: "Use existing cron, schedule, Google, Approval Gate, and channel-send paths for daily operations.",
  };
}
