import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RuntimeScheduleCreateArgumentsSchema,
  RuntimeScheduleCreateProposalSchema,
  RuntimeScheduleCreateReviewSchema,
  RuntimeScheduleUpdatePlanArgumentsSchema,
  RuntimeScheduleUpdateProposalSchema,
  RuntimeScheduleUpdateReviewSchema,
  runtimeSchedulePayloadHash,
} from "../src/runtime_schedule.js";

const base = {
  id: "morning-note",
  channel: "webchat",
  target: "owner",
  content: "今日の確認事項",
};

describe("owner runtime schedule-create contract", () => {
  it("requires one explicit trigger and an explicit canonical timezone for daily schedules", () => {
    expect(RuntimeScheduleCreateArgumentsSchema.safeParse({ ...base, time: "08:30", time_zone: "Asia/Tokyo" }).success).toBe(true);
    expect(RuntimeScheduleCreateArgumentsSchema.safeParse({ ...base, interval_ms: 120_000 }).success).toBe(true);
    expect(RuntimeScheduleCreateArgumentsSchema.safeParse({ ...base, time: "08:30" }).success).toBe(false);
    expect(RuntimeScheduleCreateArgumentsSchema.safeParse({ ...base, interval_ms: 120_000, time_zone: "UTC" }).success).toBe(false);
    expect(RuntimeScheduleCreateArgumentsSchema.safeParse({ ...base, time: "08:30", time_zone: "Asia/Tokyo",
      interval_ms: 120_000 }).success).toBe(false);
  });

  it("binds the exact schedule body, purpose version and no-store review flags", () => {
    const proposal = RuntimeScheduleCreateProposalSchema.parse({ ...base, interval_ms: 120_000,
      goal_ref: "goal_0123456789abcdef", purpose_version: 3 });
    const review = {
      kind: "schedule_create" as const,
      operation: "schedule.create" as const,
      command_id: "cmd-schedule-create",
      command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64),
      schedule_id: proposal.id,
      channel: proposal.channel,
      target: proposal.target,
      content: proposal.content,
      interval_ms: proposal.interval_ms,
      payload_hash: runtimeSchedulePayloadHash(proposal),
      goal_ref: proposal.goal_ref,
      purpose_version: proposal.purpose_version,
      purpose_digest: "c".repeat(64),
      purpose_text: "毎朝の確認事項を owner に案内する。",
      no_store: true as const,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    expect(RuntimeScheduleCreateReviewSchema.safeParse({ ...review, review_digest: "d".repeat(64) }).success).toBe(true);
    expect(RuntimeScheduleCreateReviewSchema.safeParse({ ...review, review_digest: "d".repeat(64), may_execute: true }).success).toBe(false);
    expect(RuntimeScheduleCreateReviewSchema.safeParse({ ...review, review_digest: "d".repeat(64), time: "08:30" }).success).toBe(false);
  });

  it("preserves the legacy cron payload digest shape when timezone was absent", () => {
    const legacyPayload = { channel: "webchat", target: "owner", content: "今日の確認事項", time: "07:00", interval_ms: undefined };
    const expected = createHash("sha256").update(JSON.stringify(legacyPayload), "utf8").digest("hex");
    expect(runtimeSchedulePayloadHash(base)).toBe(expected);
  });
});

describe("owner runtime schedule-update contract", () => {
  const update = {
    id: "morning-note",
    expected_revision_digest: "a".repeat(64),
    channel: "webchat",
    target: "owner",
    content: "更新後の確認事項",
  };

  it("requires a current revision and a complete replacement with one explicit trigger", () => {
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, interval_ms: 120_000 }).success).toBe(true);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, time: "08:30", time_zone: "Asia/Tokyo" }).success).toBe(true);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, time: "08:30" }).success).toBe(false);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, time: "08:30", time_zone: "Asia/Tokyo",
      interval_ms: 120_000 }).success).toBe(false);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, interval_ms: 120_000, time_zone: "UTC" }).success).toBe(false);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, expected_revision_digest: "stale" }).success).toBe(false);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, content: undefined, interval_ms: 120_000 }).success).toBe(false);
    expect(RuntimeScheduleUpdatePlanArgumentsSchema.safeParse({ ...update, interval_ms: 120_000, extra: true }).success).toBe(false);
  });

  it("binds the full replacement, selected purpose and a non-authoritative no-store review", () => {
    const proposal = RuntimeScheduleUpdateProposalSchema.parse({ ...update, interval_ms: 120_000,
      goal_ref: "goal_0123456789abcdef", purpose_version: 3 });
    const review = {
      kind: "schedule_update" as const,
      operation: "schedule.update" as const,
      command_id: "cmd-schedule-update",
      command_digest: "b".repeat(64),
      operation_plan_binding_digest: "c".repeat(64),
      schedule_id: proposal.id,
      expected_revision_digest: proposal.expected_revision_digest,
      channel: proposal.channel,
      target: proposal.target,
      content: proposal.content,
      interval_ms: proposal.interval_ms,
      payload_hash: runtimeSchedulePayloadHash(proposal),
      goal_ref: proposal.goal_ref,
      purpose_version: proposal.purpose_version,
      purpose_digest: "d".repeat(64),
      purpose_text: "毎朝の確認事項を owner に案内する。",
      no_store: true as const,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    expect(RuntimeScheduleUpdateReviewSchema.safeParse({ ...review, review_digest: "e".repeat(64) }).success).toBe(true);
    expect(RuntimeScheduleUpdateReviewSchema.safeParse({ ...review, review_digest: "e".repeat(64), may_execute: true }).success).toBe(false);
    expect(RuntimeScheduleUpdateReviewSchema.safeParse({ ...review, review_digest: "e".repeat(64), expected_revision_digest: "f".repeat(64) }).success).toBe(true);
    expect(RuntimeScheduleUpdateReviewSchema.safeParse({ ...review, review_digest: "e".repeat(64), time: "08:30" }).success).toBe(false);
  });
});
