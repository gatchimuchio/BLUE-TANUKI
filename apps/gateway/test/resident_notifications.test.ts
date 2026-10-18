import { describe, expect, it } from "vitest";
import { buildResidentNotificationsSnapshot } from "../src/resident_notifications.js";

describe("buildResidentNotificationsSnapshot", () => {
  it("shows only unsettled cron cursor identity and digest as a read-only notice", () => {
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [
        {
          index: 1,
          entry_hash: "trace-entry",
          kind: "schedule_lifecycle",
          event: "schedule.lifecycle.fired",
          request_id: "cron-event-42",
          timestamp: 900,
        },
      ],
      unresolved_cron_events: [{
        source_digest: "a".repeat(64),
        sequence: 42,
        event_id: "cron-event-42",
        payload_digest: "b".repeat(64),
        delivery_state: "outcome_unknown",
        updated_at_ms: 950,
      }],
    });

    expect(notifications).toContainEqual(expect.objectContaining({
      kind: "schedule_delivery_unknown",
      severity: "warning",
      read_only: true,
      authority: "display_only",
      request_id: "cron-event-42",
      payload_hash: "b".repeat(64),
      timestamp: 950,
    }));
    const notice = notifications.find((item) => item.kind === "schedule_delivery_unknown");
    expect(notice?.message).toContain("sequence 42 remains outcome_unknown");
    expect(notice).not.toHaveProperty("schedule_id");
    expect(JSON.stringify(notifications)).not.toContain("a".repeat(64));
    expect(JSON.stringify(notifications)).not.toContain("private schedule content");
    expect(JSON.stringify(notifications)).not.toContain("private target");
  });

  it("projects approval, schedule, connector, and audit warnings as display-only notifications", () => {
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: false,
      pending_approvals: [
        {
          command_id: "cmd-approval",
          request_id: "req-approval",
          operation: "tool.shell.exec",
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
          reason: "final_review_required",
          approval_token: "do-not-emit",
          approval_token_expires_at_ms: 2000,
        },
      ],
      authority_trace: [
        {
          index: 1,
          entry_hash: "hash-fire",
          kind: "schedule_lifecycle",
          event: "schedule.lifecycle.fired",
          request_id: null,
          schedule_id: "daily",
          payload_hash: "payload-hash",
          timestamp: 900,
        },
        {
          index: 2,
          entry_hash: "hash-cron-fail",
          kind: "executor_feedback",
          event: "executor.failed",
          request_id: "req-cron",
          command_id: "cmd-cron",
          status: "failed",
          error: "channel_dispatch_failed",
          source_process_kind: "cron",
          source_channel: "cron",
          timestamp: 950,
        },
        {
          index: 3,
          entry_hash: "hash-connector-fail",
          kind: "executor_feedback",
          event: "executor.failed",
          request_id: "req-send",
          command_id: "cmd-send",
          status: "failed",
          error: "slack_not_configured",
          source_process_kind: "chat",
          source_channel: "webchat",
          timestamp: 925,
        },
      ],
    });

    expect(notifications.map((n) => n.kind)).toEqual([
      "approval_required",
      "audit_warning",
      "schedule_failed",
      "connector_failure",
      "schedule_fired",
    ]);
    expect(notifications.every((n) => n.read_only === true)).toBe(true);
    expect(notifications.every((n) => n.authority === "display_only")).toBe(true);
    expect(JSON.stringify(notifications)).not.toContain("do-not-emit");
  });

  it("limits and sorts notifications by newest timestamp", () => {
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      limit: 1,
      authority_trace: [
        {
          index: 1,
          entry_hash: "old",
          kind: "schedule_lifecycle",
          event: "schedule.lifecycle.fired",
          request_id: null,
          schedule_id: "old",
          timestamp: 1,
        },
        {
          index: 2,
          entry_hash: "new",
          kind: "schedule_lifecycle",
          event: "schedule.lifecycle.rejected",
          request_id: null,
          schedule_id: "new",
          timestamp: 2,
        },
      ],
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "schedule_failed",
      schedule_id: "new",
    });
  });
});
