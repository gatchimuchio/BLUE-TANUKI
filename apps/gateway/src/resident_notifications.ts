import type {
  WebChatApprovalQueueItem,
  WebChatAuthorityTraceItem,
  WebChatNotificationItem,
} from "@blue-tanuki/channel-webchat";
import type { CronEventCursorSnapshot } from "./cron_event_store.js";

export interface ResidentNotificationInput {
  now_ms?: number;
  audit_chain_valid: boolean;
  pending_approvals: readonly WebChatApprovalQueueItem[];
  authority_trace: readonly WebChatAuthorityTraceItem[];
  unresolved_cron_events?: readonly CronEventCursorSnapshot[];
  limit?: number;
}

export function buildResidentNotificationsSnapshot(
  input: ResidentNotificationInput,
): WebChatNotificationItem[] {
  const now = input.now_ms ?? Date.now();
  const notifications: WebChatNotificationItem[] = [];

  if (!input.audit_chain_valid) {
    notifications.push({
      id: "audit:chain-invalid",
      kind: "audit_warning",
      severity: "critical",
      title: "Audit chain warning",
      message: "Hash-chain verification failed.",
      timestamp: now,
      source: "audit",
      read_only: true,
      authority: "display_only",
      next_action: "Stop normal operation, preserve the audit store, and run audit verification before continuing.",
    });
  }

  for (const item of input.pending_approvals) {
    notifications.push({
      id: `approval:${item.command_id}`,
      kind: "approval_required",
      severity: "action_required",
      title: item.final_review_required
        ? "Final review required"
        : "Approval required",
      message: `${item.operation} is waiting for an explicit owner verdict.`,
      timestamp: now,
      source: "approval_queue",
      read_only: true,
      authority: "display_only",
      request_id: item.request_id,
      command_id: item.command_id,
      approval_level: item.approval_level,
      risk: item.risk,
      expires_at_ms: item.approval_token_expires_at_ms,
      next_action: "Open Approval Queue and submit approve, reject, or block through the Approval Gate.",
    });
  }

  for (const event of input.unresolved_cron_events ?? []) {
    notifications.push({
      id: `schedule-delivery-unsettled:${event.event_id}`,
      kind: "schedule_delivery_unknown",
      severity: "warning",
      title: "Schedule delivery result is unsettled",
      message: `Cron event sequence ${event.sequence} remains ${event.delivery_state}; delivery is not confirmed, and later events from this source are blocked without automatic replay.`,
      timestamp: event.updated_at_ms,
      source: "cron_event_cursor",
      read_only: true,
      authority: "display_only",
      request_id: event.event_id,
      payload_hash: event.payload_digest,
      next_action: "Inspect Authority Trace for this event ID and verify target delivery before taking any duplicate action.",
    });
  }

  for (const trace of input.authority_trace) {
    if (trace.kind === "schedule_lifecycle") {
      if (trace.event === "schedule.lifecycle.fired") {
        notifications.push({
          id: `schedule-fired:${trace.index}:${trace.schedule_id ?? "unknown"}`,
          kind: "schedule_fired",
          severity: "info",
          title: "Schedule fired",
          message: "A runtime or boot schedule entered the cron lane.",
          timestamp: trace.timestamp,
          source: "runtime_schedule",
          read_only: true,
          authority: "display_only",
          request_id: trace.request_id,
          command_id: trace.command_id,
          schedule_id: trace.schedule_id,
          payload_hash: trace.payload_hash,
          next_action: "Inspect Runtime Schedules and Authority Trace if delivery status is unclear.",
        });
      } else if (trace.event === "schedule.lifecycle.rejected") {
        notifications.push({
          id: `schedule-failed:${trace.index}:${trace.schedule_id ?? "unknown"}`,
          kind: "schedule_failed",
          severity: "warning",
          title: "Schedule request failed",
          message: "A schedule request was rejected, expired, or failed before activation.",
          timestamp: trace.timestamp,
          source: "runtime_schedule",
          read_only: true,
          authority: "display_only",
          request_id: trace.request_id,
          command_id: trace.command_id,
          schedule_id: trace.schedule_id,
          approval_level: trace.approval_level,
          risk: trace.risk,
          payload_hash: trace.payload_hash,
          next_action: "Run schedule.list, fix the request, and submit a new approval if the schedule should still exist.",
        });
      }
      continue;
    }

    if (trace.kind !== "executor_feedback" || trace.status !== "failed") {
      continue;
    }

    if (trace.source_process_kind === "cron" || trace.source_channel === "cron") {
      notifications.push({
        id: `schedule-delivery-failed:${trace.index}:${trace.command_id ?? "unknown"}`,
        kind: "schedule_failed",
        severity: "warning",
        title: "Schedule delivery failed",
        message: trace.error ?? "Cron downstream delivery failed.",
        timestamp: trace.timestamp,
        source: "executor_feedback",
        read_only: true,
        authority: "display_only",
        request_id: trace.request_id,
        command_id: trace.command_id,
        next_action: "Inspect the target channel credentials, run doctor, and retry only after the connector is healthy.",
      });
      continue;
    }

    if (looksLikeConnectorFailure(trace.error)) {
      notifications.push({
        id: `connector-failure:${trace.index}:${trace.command_id ?? "unknown"}`,
        kind: "connector_failure",
        severity: "warning",
        title: "Connector delivery failed",
        message: trace.error ?? "Downstream connector delivery failed.",
        timestamp: trace.timestamp,
        source: "executor_feedback",
        read_only: true,
        authority: "display_only",
        request_id: trace.request_id,
        command_id: trace.command_id,
        next_action: "Inspect the connector credential and target, then rerun the relevant live smoke if needed.",
      });
    }
  }

  return dedupe(notifications)
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
    .slice(0, input.limit ?? 50);
}

function looksLikeConnectorFailure(error: string | undefined): boolean {
  if (!error) return false;
  const value = error.toLowerCase();
  return [
    "channel",
    "delivery",
    "slack",
    "discord",
    "telegram",
    "teams",
    "line",
    "not_configured",
    "rate_limited",
  ].some((needle) => value.includes(needle));
}

function dedupe(
  notifications: readonly WebChatNotificationItem[],
): WebChatNotificationItem[] {
  const byId = new Map<string, WebChatNotificationItem>();
  for (const notification of notifications) {
    byId.set(notification.id, notification);
  }
  return Array.from(byId.values());
}
