import type { OperationCoreProjection, ToolCapability } from "@blue-tanuki/protocol";

export type DailyOperationKind =
  | "daily_brief.status"
  | "google.gmail.read"
  | "google.calendar.read"
  | "google.drive.read"
  | "schedule.list"
  | "reminder.draft"
  | "schedule.create"
  | "schedule.update"
  | "schedule.delete"
  | "gmail.write"
  | "google.calendar.write"
  | "google.drive.write"
  | "daily_brief.channel_send";

export type DailyApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review"
  | "existing_channel_path";

export type DailyApprovalRisk = "low" | "medium" | "high" | "contextual";

export interface DailyOperationSpec {
  kind: DailyOperationKind;
  label: string;
  approval_level: DailyApprovalLevel;
  approval_risk: DailyApprovalRisk;
  final_review_required: boolean;
  downstream_tools: readonly string[];
  capabilities: readonly ToolCapability[];
  audit_trace: readonly string[];
}

export interface DailyBriefEnvSnapshot {
  enabled: boolean;
  channel: string;
  target_configured: boolean;
  time: string;
  interval_ms?: number;
  google_source_enabled: boolean;
  google_services: readonly string[];
}

export interface DailySurfaceSnapshot {
  surface: "daily";
  layer: "A";
  status: "enabled";
  authority: "hds_brain_downstream_device";
  replaces_authority: false;
  raw_authority_added: false;
  daily_brief: DailyBriefEnvSnapshot;
  scheduled_tasks: readonly unknown[];
  runtime_schedules: readonly unknown[];
  operations: readonly DailyOperationSpec[];
  operation_core_projection: OperationCoreProjection;
  next_recommended_action: string;
}
