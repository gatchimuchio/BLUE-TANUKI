import { describe, expect, it } from "vitest";
import {
  OperationCoreProjectionSchema,
  OPERATOR_SURFACE_OPERATION_IDS,
  requiredCapabilitiesForSurface,
} from "@blue-tanuki/protocol";
import {
  DAILY_OPERATOR_REQUIRED_PERMISSIONS,
  dailyBriefSnapshotFromEnv,
  dailyMetadataForOperation,
  digestDailyInput,
  getDailyOperationSpec,
  getDailySurfaceSnapshot,
} from "../src/index.js";

describe("Daily Operator surface", () => {
  it("declares itself as a Layer A downstream surface", () => {
    const snapshot = getDailySurfaceSnapshot();
    expect(snapshot.surface).toBe("daily");
    expect(snapshot.layer).toBe("A");
    expect(snapshot.authority).toBe("hds_brain_downstream_device");
    expect(snapshot.replaces_authority).toBe(false);
    expect(snapshot.raw_authority_added).toBe(false);
  });

  it("preserves BLUE_TANUKI_DAILY_BRIEF_* env compatibility", () => {
    const snapshot = dailyBriefSnapshotFromEnv({
      BLUE_TANUKI_DAILY_BRIEF_ENABLED: "true",
      BLUE_TANUKI_DAILY_BRIEF_CHANNEL: "webchat",
      BLUE_TANUKI_DAILY_BRIEF_TARGET: "local-user",
      BLUE_TANUKI_DAILY_BRIEF_TIME: "08:30",
      BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS: "120000",
      BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED: "1",
      BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES: "gmail calendar",
    });
    expect(snapshot).toEqual({
      enabled: true,
      channel: "webchat",
      target_configured: true,
      time: "08:30",
      interval_ms: 120000,
      google_source_enabled: true,
      google_services: ["gmail", "calendar"],
    });
  });

  it("keeps credentialed Google reads and schedule mutations at their governed boundary", () => {
    expect(getDailyOperationSpec("daily_brief.status").approval_level).toBe("L1_observe");
    expect(getDailyOperationSpec("schedule.list").approval_level).toBe("L1_observe");
    expect(getDailyOperationSpec("google.gmail.read").approval_level).toBe("L3_final_review");
    expect(getDailyOperationSpec("google.calendar.read").final_review_required).toBe(true);
    expect(getDailyOperationSpec("google.drive.read").approval_risk).toBe("high");
    expect(getDailyOperationSpec("reminder.draft").approval_level).toBe("L2_operate");
    expect(getDailyOperationSpec("schedule.create").approval_level).toBe("L3_final_review");
    expect(getDailyOperationSpec("gmail.write").final_review_required).toBe(true);
  });

  it("projects daily operations into normalized display-only Operation Core steps", () => {
    const projection = getDailySurfaceSnapshot().operation_core_projection;
    const channelSend = projection.steps.find((step) => step.operation === "daily_brief.channel_send");
    const scheduleCreate = projection.steps.find((step) => step.operation === "schedule.create");

    expect(OperationCoreProjectionSchema.safeParse(projection).success).toBe(true);
    expect(projection.source_surface).toBe("daily");
    expect(projection.ui_projection_used_for_authority).toBe(false);
    expect(projection.adapter_result_used_for_authority).toBe(false);
    expect(channelSend).toMatchObject({
      effects: ["external_send"],
      permission: {
        risk: "medium",
        approval_level: "L2_operate",
        final_review_required: false,
        approval_gate_required: false,
      },
      adapter: "external_api",
      adapter_is_authority: false,
      command_generated_by_adapter_only: false,
    });
    expect(channelSend?.parameters).toMatchObject({
      source_approval_level: "existing_channel_path",
      source_approval_risk: "contextual",
    });
    expect(scheduleCreate).toMatchObject({
      effects: ["schedule_change", "write"],
      permission: {
        risk: "high",
        approval_level: "L3_final_review",
        approval_gate_required: true,
      },
    });
  });

  it("uses existing downstream capability names and no authority capability", () => {
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).toEqual(requiredCapabilitiesForSurface("daily"));
    expect(getDailySurfaceSnapshot().operations.map((operation) => operation.kind).sort()).toEqual(
      [...OPERATOR_SURFACE_OPERATION_IDS.daily].sort(),
    );
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).toContain("tool:schedule.create");
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).toContain("tool:gmail.read");
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).toContain("tool:google.calendar.write");
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).toContain("secrets:GOOGLE_ACCESS_TOKEN");
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).not.toContain("authority:write");
    expect(DAILY_OPERATOR_REQUIRED_PERMISSIONS).not.toContain("hds:bypass");
  });

  it("emits digest and gateway-owned metadata helpers", () => {
    expect(digestDailyInput("brief")).toMatch(/^[a-f0-9]{64}$/);
    expect(dailyMetadataForOperation("schedule.delete")).toEqual({
      "blue_tanuki.operator_surface": "daily",
      "blue_tanuki.daily.operation": "schedule.delete",
      "blue_tanuki.approval_level": "L3_final_review",
      "blue_tanuki.approval_risk": "high",
      "blue_tanuki.final_review_required": "true",
    });
  });
});
