import { describe, expect, it } from "vitest";
import {
  buildResidentNotificationsSnapshot,
  interruptedApprovalsFromAudit,
  readCronNotificationState,
} from "../src/resident_notifications.js";

describe("buildResidentNotificationsSnapshot", () => {
  it("surfaces only prior unresolved approval lifecycles without restoring a token", () => {
    const lifecycle = (command_id: string, phase: string, timestamp: number) => ({
      kind: "command_lifecycle", command_id, phase, request_id: `request-${command_id}`, timestamp,
    });
    const interrupted = interruptedApprovalsFromAudit([
      { index: 0, log: lifecycle("resolved-before-restart", "approval_pending", 10) },
      { index: 1, log: lifecycle("resolved-before-restart", "approval_cancelled", 11) },
      { index: 2, log: lifecycle("stale-pending", "approval_pending", 20) },
      { index: 3, log: lifecycle("active-pending", "approval_pending", 30) },
      { index: 4, log: lifecycle("resolved-after-start", "approval_pending", 40) },
      { index: 5, log: lifecycle("resolved-after-start", "approval_rejected", 50) },
      { index: 6, log: lifecycle("new-pending", "approval_pending", 60) },
      { index: 7, log: { ...lifecycle("invalid", "approval_pending", 70), secret: "must-not-project" } },
    ], 5, new Set(["active-pending"]));

    expect(interrupted).toEqual([{
      command_id: "stale-pending",
      request_id: "request-stale-pending",
      timestamp_ms: 20,
    }]);
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 100,
      audit_chain_valid: true,
      pending_approvals: [],
      interrupted_approvals: interrupted,
      authority_trace: [],
    });
    expect(notifications).toContainEqual(expect.objectContaining({
      kind: "approval_interrupted",
      source: "approval_lifecycle",
      request_id: "request-stale-pending",
      command_id: "stale-pending",
      read_only: true,
      authority: "display_only",
      timestamp: 20,
      next_action: expect.stringContaining("submit a new request"),
    }));
    expect(JSON.stringify(notifications)).not.toContain("approval_token");
    expect(JSON.stringify(notifications)).not.toContain("must-not-project");
  });

  it("keeps verified Cron projections and unrelated notices when one Cron projection fails", () => {
    const approval = {
      source_digest: "d".repeat(64),
      sequence: 8,
      event_id: `cron-${"e".repeat(64)}`,
      payload_digest: "f".repeat(64),
      command_id_digest: "1".repeat(64),
      state: "interrupted" as const,
      updated_at_ms: 950,
    };
    let executionReads = 0;
    const state = readCronNotificationState({
      inspectUnresolvedEventsForNotification() {
        throw new Error("RAW_CRON_CURSOR_ERROR");
      },
      interruptedApprovalHandoffs() {
        executionReads += 1;
        return [approval];
      },
    });
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: false,
      pending_approvals: [{
        command_id: "pending-command",
        request_id: "pending-request",
        operation: "file.read",
        risk: "low",
        final_review_required: false,
        reason: "owner_review",
      }],
      authority_trace: [],
      unresolved_cron_events: state.unresolved_events,
      interrupted_cron_approvals: state.interrupted_approvals,
      cron_state_read_failures: state.read_failures,
    });

    expect(executionReads).toBe(1);
    expect(state.read_failures).toEqual(["unresolved_events"]);
    expect(notifications.map((item) => item.kind)).toEqual([
      "approval_required",
      "audit_warning",
      "cron_recovery_state_unavailable",
      "approval_interrupted",
    ]);
    expect(notifications.find((item) => item.kind === "cron_recovery_state_unavailable")).toMatchObject({
      severity: "warning",
      source: "cron_event_cursor",
      read_only: true,
      authority: "display_only",
      message: expect.stringContaining("state may be incomplete"),
    });
    expect(JSON.stringify(notifications)).not.toContain("RAW_CRON_CURSOR_ERROR");
    expect(notifications.some((item) => item.kind === "schedule_delivery_unknown")).toBe(false);
  });

  it("retains unresolved events if interrupted approvals cannot be read", () => {
    const event = {
      source_digest: "a".repeat(64), sequence: 7, event_id: `cron-${"b".repeat(64)}`,
      payload_digest: "c".repeat(64), delivery_state: "outcome_unknown" as const,
      resolution_state: "unacknowledged" as const, updated_at_ms: 900,
    };
    const state = readCronNotificationState({
      inspectUnresolvedEventsForNotification: () => ({ events: [event], invalid_record_count: 0 }),
      interruptedApprovalHandoffs() {
        throw new Error("RAW_CRON_APPROVAL_ERROR");
      },
    });
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      unresolved_cron_events: state.unresolved_events,
      interrupted_cron_approvals: state.interrupted_approvals,
      cron_state_read_failures: state.read_failures,
    });

    expect(state.read_failures).toEqual(["interrupted_approvals"]);
    expect(notifications.map((item) => item.kind)).toEqual([
      "cron_recovery_state_unavailable",
      "schedule_delivery_unknown",
    ]);
    expect(notifications.find((item) => item.kind === "cron_recovery_state_unavailable")).toMatchObject({
      source: "cron_approval_handoff",
      read_only: true,
      authority: "display_only",
    });
    expect(JSON.stringify(notifications)).not.toContain("RAW_CRON_APPROVAL_ERROR");
  });

  it("reports both Cron projections unavailable without replacing unrelated notices", () => {
    const state = readCronNotificationState({
      inspectUnresolvedEventsForNotification() { throw new Error("RAW_CURSOR_ERROR"); },
      interruptedApprovalHandoffs() { throw new Error("RAW_APPROVAL_ERROR"); },
    });
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [{
        index: 1, entry_hash: "trace", kind: "schedule_lifecycle", event: "schedule.lifecycle.fired",
        request_id: "request-firing", timestamp: 900,
      }],
      unresolved_cron_events: state.unresolved_events,
      interrupted_cron_approvals: state.interrupted_approvals,
      cron_state_read_failures: state.read_failures,
    });

    expect(state.read_failures).toEqual(["unresolved_events", "interrupted_approvals"]);
    expect(notifications.map((item) => item.kind)).toEqual([
      "cron_recovery_state_unavailable",
      "cron_recovery_state_unavailable",
      "schedule_fired",
    ]);
    expect(JSON.stringify(notifications)).not.toMatch(/RAW_(CURSOR|APPROVAL)_ERROR/);
  });

  it("keeps verified schedule events visible and warns when invalid cursor rows were omitted", () => {
    const event = {
      source_digest: "a".repeat(64), sequence: 17, event_id: `cron-${"b".repeat(64)}`,
      payload_digest: "c".repeat(64), delivery_state: "outcome_unknown" as const,
      resolution_state: "unacknowledged" as const, updated_at_ms: 950,
    };
    const state = readCronNotificationState({
      inspectUnresolvedEventsForNotification: () => ({ events: [event], invalid_record_count: 2 }),
      interruptedApprovalHandoffs: () => [],
    });
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      unresolved_cron_events: state.unresolved_events,
      interrupted_cron_approvals: state.interrupted_approvals,
      cron_state_read_failures: state.read_failures,
    });

    expect(state.read_failures).toEqual(["unresolved_events_partial"]);
    expect(notifications.map((item) => item.kind)).toEqual([
      "cron_recovery_state_unavailable",
      "schedule_delivery_unknown",
    ]);
    expect(notifications[0]).toMatchObject({
      source: "cron_event_cursor",
      read_only: true,
      authority: "display_only",
      message: expect.stringContaining("Some unresolved schedule-event records could not be verified and were omitted"),
    });
    expect(notifications[1]).toMatchObject({ kind: "schedule_delivery_unknown", request_id: event.event_id });
  });

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
        resolution_state: "unacknowledged",
        updated_at_ms: 950,
      }],
      operation_plan_projection: {
        schema_version: "operation-plan-projection.v1",
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: [{
          request_id: "cron-event-42",
          goal: "private goal text",
          bindings: [{
            request_id: "cron-event-42",
            command_id: "private-command-id",
            status: "verified",
            result_digest: "d".repeat(64),
            delivery_digest: "c".repeat(64),
            memory_status: "receipt_confirmed",
          }],
        }],
      } as never,
    });

    expect(notifications).toContainEqual(expect.objectContaining({
      kind: "schedule_delivery_unknown",
      severity: "warning",
      read_only: true,
      authority: "display_only",
      request_id: "cron-event-42",
      payload_hash: "b".repeat(64),
      result_correlation_status: "saved_result_linked",
      result_memory_status: "receipt_confirmed",
      timestamp: 950,
    }));
    const notice = notifications.find((item) => item.kind === "schedule_delivery_unknown");
    expect(notice?.message).toContain("sequence 42 remains outcome_unknown");
    expect(notice).not.toHaveProperty("schedule_id");
    expect(JSON.stringify(notifications)).not.toContain("a".repeat(64));
    expect(JSON.stringify(notifications)).not.toContain("private schedule content");
    expect(JSON.stringify(notifications)).not.toContain("private target");
    expect(JSON.stringify(notifications)).not.toContain("private-command-id");
    expect(JSON.stringify(notifications)).not.toContain("private goal text");
    expect(JSON.stringify(notifications)).not.toContain("c".repeat(64));
  });

  it.each([
    [undefined, "projection_unavailable"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [] }, "no_matching_plan"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [{ request_id: "cron-event-42", bindings: [] }] }, "no_bound_command"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [{ request_id: "cron-event-42", bindings: [{ request_id: "cron-event-42", status: "outcome_unknown" }] }] }, "execution_unresolved"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [{ request_id: "cron-event-42", bindings: [{ request_id: "cron-event-42", status: "verified" }] }] }, "saved_result_missing"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [{ request_id: "cron-event-42", bindings: [{ request_id: "cron-event-42", status: "unexpected" }] }] }, "ambiguous"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [{ request_id: "cron-event-42", bindings: [{ request_id: "different-request", status: "verified" }] }] }, "ambiguous"],
    [{ schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false, plans: [
      { request_id: "cron-event-42", bindings: [] }, { request_id: "cron-event-42", bindings: [] },
    ] }, "ambiguous"],
  ] as const)("keeps missing or uncertain plan/result links explicit", (operation_plan_projection, status) => {
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      unresolved_cron_events: [{
        source_digest: "a".repeat(64), sequence: 42, event_id: "cron-event-42", payload_digest: "b".repeat(64),
        delivery_state: "outcome_unknown", resolution_state: "unacknowledged", updated_at_ms: 950,
      }],
      operation_plan_projection: operation_plan_projection as never,
    });
    expect(notifications[0]).toMatchObject({
      kind: "schedule_delivery_unknown",
      result_correlation_status: status,
      read_only: true,
      authority: "display_only",
    });
    expect(JSON.stringify(notifications)).not.toContain("private-command-id");
  });

  it("keeps a linked result with pending memory receipt distinct from external success", () => {
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      unresolved_cron_events: [{
        source_digest: "a".repeat(64), sequence: 42, event_id: "cron-event-42", payload_digest: "b".repeat(64),
        delivery_state: "outcome_unknown", resolution_state: "unacknowledged", updated_at_ms: 950,
      }],
      operation_plan_projection: {
        schema_version: "operation-plan-projection.v1",
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: [{
          request_id: "cron-event-42",
          bindings: [{
            request_id: "cron-event-42",
            status: "verified",
            result_digest: "d".repeat(64),
            delivery_digest: "c".repeat(64),
            memory_status: "memory_commit_pending",
          }],
        }],
      },
    });

    expect(notifications[0]).toMatchObject({
      result_correlation_status: "saved_result_linked",
      result_memory_status: "commit_pending",
      read_only: true,
      authority: "display_only",
    });
    expect(notifications[0]?.message).toContain("not proof of external success");
  });

  it.each([
    ["owner_acknowledged_no_replay", "later events may proceed", "original outcome remains unknown"],
    ["verification_unavailable", "later events remain blocked", "no-replay disposition could not be verified"],
  ] as const)("keeps Cron no-replay state visible without converting it to success", (resolution_state, message, detail) => {
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      unresolved_cron_events: [{
        source_digest: "a".repeat(64),
        sequence: 43,
        event_id: "cron-event-no-replay",
        payload_digest: "b".repeat(64),
        delivery_state: "outcome_unknown",
        resolution_state,
        updated_at_ms: 950,
      }],
    });

    expect(notifications[0]).toMatchObject({
      kind: "schedule_delivery_unknown",
      cron_resolution_state: resolution_state,
      read_only: true,
      authority: "display_only",
      next_action: expect.any(String),
    });
    expect(notifications[0]?.message).toContain(message);
    expect(notifications[0]?.message).toContain(detail);
    expect(notifications[0]?.message).not.toContain("delivery confirmed");
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

  it("shows interrupted Cron approvals as read-only notices without restoring approval data", () => {
    const eventId = `cron-${"a".repeat(64)}`;
    const payloadDigest = "b".repeat(64);
    const commandDigest = "c".repeat(64);
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      interrupted_cron_approvals: [{
        source_digest: "d".repeat(64),
        sequence: 17,
        event_id: eventId,
        payload_digest: payloadDigest,
        command_id_digest: commandDigest,
        state: "interrupted",
        updated_at_ms: 900,
      }],
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "approval_interrupted",
      severity: "warning",
      request_id: eventId,
      payload_hash: payloadDigest,
      timestamp: 900,
      read_only: true,
      authority: "display_only",
      next_action: expect.stringContaining("fresh approval"),
    });
    expect(notifications[0]?.message).toContain("was not restored");
    expect(JSON.stringify(notifications)).not.toContain(commandDigest);
  });

  it("correlates Cron and interrupted-approval notices without exposing receipt digests", () => {
    const eventId = `cron-${"a".repeat(64)}`;
    const payloadDigest = "b".repeat(64);
    const evidenceDigest = "d".repeat(64);
    const receiptDigest = "e".repeat(64);
    const projection = {
      schema_version: "operation-plan-projection.v1",
      used_for_authority: false,
      raw_payload_exposed: false,
      plans: [{
        request_id: eventId,
        steps: [{
          status: "outcome_unknown",
          external_receipt_observation: "matched",
          external_receipt: {
            source: "local_inspection",
            match_count: 1,
            evidence_digest: evidenceDigest,
            receipt_digest: receiptDigest,
            observed_at_ms: 800,
            used_for_authority: false,
            raw_receipt_exposed: false,
          },
        }],
        bindings: [{ request_id: eventId, status: "outcome_unknown" }],
      }],
    };
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      unresolved_cron_events: [{
        source_digest: "f".repeat(64), sequence: 17, event_id: eventId, payload_digest: payloadDigest,
        delivery_state: "outcome_unknown", resolution_state: "unacknowledged", updated_at_ms: 900,
      }],
      interrupted_cron_approvals: [{
        source_digest: "c".repeat(64), sequence: 17, event_id: eventId, payload_digest: payloadDigest,
        command_id_digest: "9".repeat(64), state: "interrupted", updated_at_ms: 950,
      }],
      operation_plan_projection: projection,
    });

    expect(notifications).toHaveLength(2);
    for (const notice of notifications) {
      expect(notice).toMatchObject({
        result_correlation_status: "execution_unresolved",
        external_receipt_observation_status: "matched",
        external_receipt_observation_source: "local_inspection",
        read_only: true,
        authority: "display_only",
      });
      expect(notice.message).toContain("does not settle delivery or establish action success");
    }
    const interrupted = notifications.find((notice) => notice.kind === "approval_interrupted");
    expect(interrupted?.next_action).toContain("fresh approval");
    const visible = JSON.stringify(notifications);
    expect(visible).not.toContain(evidenceDigest);
    expect(visible).not.toContain(receiptDigest);
    expect(visible).not.toContain("raw_receipt");
  });

  it("keeps malformed external receipt observations mixed and non-authoritative", () => {
    const eventId = `cron-${"a".repeat(64)}`;
    const notifications = buildResidentNotificationsSnapshot({
      now_ms: 1000,
      audit_chain_valid: true,
      pending_approvals: [],
      authority_trace: [],
      interrupted_cron_approvals: [{
        source_digest: "c".repeat(64), sequence: 17, event_id: eventId, payload_digest: "b".repeat(64),
        command_id_digest: "9".repeat(64), state: "interrupted", updated_at_ms: 950,
      }],
      operation_plan_projection: {
        schema_version: "operation-plan-projection.v1",
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: [{
          request_id: eventId,
          steps: [{
            status: "outcome_unknown",
            external_receipt_observation: "matched",
            external_receipt: {
              source: "local_inspection", match_count: 2, evidence_digest: "d".repeat(64),
              receipt_digest: "e".repeat(64), observed_at_ms: 800, used_for_authority: false, raw_receipt_exposed: false,
            },
          }],
          bindings: [{ request_id: eventId, status: "outcome_unknown" }],
        }],
      },
    });

    expect(notifications[0]).toMatchObject({
      kind: "approval_interrupted",
      external_receipt_observation_status: "mixed_or_unknown",
      read_only: true,
      authority: "display_only",
    });
    expect(notifications[0]).not.toHaveProperty("external_receipt_observation_source");
    expect(notifications[0]?.message).toContain("Receipt observation state=mixed_or_unknown");
    expect(notifications[0]?.message).not.toContain("local receipt observation");
    expect(notifications[0]?.next_action).toContain("fresh approval");
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
