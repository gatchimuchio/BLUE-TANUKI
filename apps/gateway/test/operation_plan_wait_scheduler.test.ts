import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationPlanWaitStateSchema } from "@blue-tanuki/protocol";
import { OperationPlanWaitDeadlineScheduler } from "../src/operation_plan_wait_scheduler.js";

describe("J永続waitのdeadline consumer", () => {
  afterEach(() => vi.useRealTimers());

  it("期限まではイベントもC起動も出さず、到達後は同じwaitにつき一度だけhandlerへ渡す", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const wait = OperationPlanWaitStateSchema.parse({
      wait_id: "a".repeat(64), plan_id_digest: "b".repeat(64), task_identity_digest: "c".repeat(64),
      revision_digest: "d".repeat(64), owner_digest: "e".repeat(64), channel_digest: "f".repeat(64),
      session_id_digest: "1".repeat(64), deadline_at_ms: 1_100, created_at_ms: 900,
      state: "waiting", used_for_authority: false, may_execute: false,
    });
    const dispatch = vi.fn(async () => undefined);
    const scheduler = new OperationPlanWaitDeadlineScheduler({
      list_waits: () => [wait],
      wait_context: () => ({ goal: "synthetic", owner: "owner", channel: "webchat" }),
      dispatch,
      now: () => Date.now(),
    });
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(99);
      expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
    }
  });

  it("復元hold中は期限eventを出さず、解除後のrefreshで期限済みwaitを再度armする", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const wait = OperationPlanWaitStateSchema.parse({
      wait_id: "2".repeat(64), plan_id_digest: "3".repeat(64), task_identity_digest: "4".repeat(64),
      revision_digest: "5".repeat(64), owner_digest: "6".repeat(64), channel_digest: "7".repeat(64),
      session_id_digest: "8".repeat(64), deadline_at_ms: 1_100, created_at_ms: 900,
      state: "waiting", used_for_authority: false, may_execute: false,
    });
    let contextAvailable = false;
    const dispatch = vi.fn(async () => undefined);
    const scheduler = new OperationPlanWaitDeadlineScheduler({
      list_waits: () => [wait],
      wait_context: () => contextAvailable ? { goal: "synthetic", owner: "owner", channel: "webchat" } : null,
      dispatch,
      now: () => Date.now(),
    });
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(dispatch).not.toHaveBeenCalled();

      contextAvailable = true;
      scheduler.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
    }
  });
});
