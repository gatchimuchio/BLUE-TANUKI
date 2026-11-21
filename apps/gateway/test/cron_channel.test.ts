import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CronSchedulerChannel,
  DailyBriefCronChannel,
  cronRestoreObservationRequiresHold,
  cronPayloadHash,
  cronSchedulesFromEnv,
  dailyBriefCronFromEnv,
  nextDailyFireAtMs,
} from "../src/cron_channel.js";
import {
  createCronEventIdentity,
  GatewayCronEventStore,
  GOOGLE_DAILY_BRIEF_DUE_SOURCE,
} from "../src/cron_event_store.js";
import { createCronEventResultReceipt } from "../src/cron_event_result_receipt.js";
import { InboundRouter } from "@blue-tanuki/channel-base";

function makeTestEventStore(prefix: string): { root: string; store: GatewayCronEventStore } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, store: new GatewayCronEventStore(join(root, "private", "cron-events.sqlite")) };
}

describe("DailyBriefCronChannel snapshot", () => {
  it("exposes the next daily fire time without exposing content", async () => {
    const now = new Date(2026, 4, 9, 6, 30, 0, 0);
    const expected = new Date(2026, 4, 9, 7, 0, 0, 0).getTime();
    const ch = new DailyBriefCronChannel({
      enabled: true,
      channel: "telegram",
      target: "chat-1",
      content: "private brief content",
      time: "07:00",
      now: () => now,
      log: () => undefined,
    });

    await ch.start(async () => undefined);
    try {
      const snapshot = ch.snapshot();
      expect(snapshot).toMatchObject({
        name: "daily_brief",
        enabled: true,
        running: true,
        channel: "telegram",
        target: "chat-1",
        time: "07:00",
        next_fire_at_ms: expected,
        last_fire_at_ms: null,
      });
      expect(JSON.stringify(snapshot)).not.toContain("private brief content");
    } finally {
      await ch.stop();
    }
  });

  it("exposes interval-mode schedule state", async () => {
    const now = new Date(2026, 4, 9, 1, 0, 0, 0);
    const ch = new DailyBriefCronChannel({
      enabled: true,
      channel: "webchat",
      target: "local-user",
      content: "interval smoke",
      interval_ms: 60_000,
      now: () => now,
      log: () => undefined,
    });

    await ch.start(async () => undefined);
    try {
      expect(ch.snapshot()).toMatchObject({
        enabled: true,
        running: true,
        interval_ms: 60_000,
        next_fire_at_ms: now.getTime() + 60_000,
        last_fire_at_ms: null,
      });
    } finally {
      await ch.stop();
    }
  });
});

describe("dailyBriefCronFromEnv", () => {
  it("returns null when Daily Brief is disabled", () => {
    expect(dailyBriefCronFromEnv({})).toBeNull();
  });
});

describe("daily wall-clock scheduling", () => {
  it("resolves DST gaps forward and uses only the first instant in an overlap", () => {
    const beforeSpringChange = Date.UTC(2026, 2, 7, 12, 0);
    expect(nextDailyFireAtMs(beforeSpringChange, "02:30", "America/Los_Angeles", null))
      .toBe(Date.UTC(2026, 2, 8, 10, 30)); // 02:30 does not exist; shift by the one-hour gap.

    const beforeFallChange = Date.UTC(2026, 9, 31, 12, 0);
    expect(nextDailyFireAtMs(beforeFallChange, "01:30", "America/Los_Angeles", null))
      .toBe(Date.UTC(2026, 10, 1, 8, 30));
    expect(nextDailyFireAtMs(Date.UTC(2026, 10, 1, 8, 45), "01:30", "America/Los_Angeles", null))
      .toBe(Date.UTC(2026, 10, 2, 9, 30)); // The repeated second 01:30 is skipped.
  });

  it("persists a catch-up policy hold after a forward clock jump and survives restart", async () => {
    vi.useFakeTimers();
    const targetAt = Date.UTC(2026, 4, 9, 7, 0);
    vi.setSystemTime(targetAt - 5 * 60_000);
    const { root, store } = makeTestEventStore("blue-tanuki-cron-clock-jump-");
    const received: number[] = [];
    const ch = new CronSchedulerChannel({
      tasks: [{
        id: "clock-jump",
        channel: "webchat",
        target: "local-user",
        content: "synthetic daily event",
        time: "07:00",
        time_zone: "UTC",
      }],
      event_store: store,
      log: () => undefined,
    });
    try {
      await ch.start(async (request) => { received.push(request.timestamp); });
      expect(ch.snapshot()[0]?.next_fire_at_ms).toBe(targetAt);
      vi.setSystemTime(targetAt + 2 * 24 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(received).toEqual([]);
      expect(ch.snapshot()[0]).toMatchObject({
        running: false,
        last_fire_at_ms: null,
        next_fire_at_ms: null,
        catch_up_hold: {
          reason: "catch_up_policy_unresolved",
          scheduled_at_ms: targetAt,
          persisted: true,
        },
      });
      const heldEvent = store.unresolvedEvents().find((event) => event.delivery_state === "held_catch_up_policy");
      expect(heldEvent).toMatchObject({ sequence: targetAt, resolution_state: "policy_unresolved" });
      expect(heldEvent && store.resultReceipt({ ...heldEvent, source: "cron:boot:clock-jump" })).toBeNull();

      const restarted = new CronSchedulerChannel({
        tasks: [{ id: "clock-jump", channel: "webchat", target: "local-user", content: "synthetic daily event", time: "07:00", time_zone: "UTC" }],
        event_store: store,
        log: () => undefined,
      });
      await restarted.start(async (request) => { received.push(request.timestamp); });
      expect(restarted.snapshot()[0]).toMatchObject({ running: false, next_fire_at_ms: null, catch_up_hold: { persisted: true } });
      expect(received).toEqual([]);
      await restarted.stop();
    } finally {
      await ch.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});

describe("CronSchedulerChannel", () => {
  it("holds scheduled consumers when Cron restore is not cleanly observed or its store is ambiguous", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const received: unknown[] = [];
    const heldObservation = {
      operation: "restore",
      store_key: "cron_events",
      status: "failed",
      store_ledger_status: null,
      store_ledger_residual_count: null,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    expect(cronRestoreObservationRequiresHold(heldObservation)).toBe(true);
    expect(cronRestoreObservationRequiresHold({
      ...heldObservation,
      status: "matched",
      store_ledger_status: "verified",
      store_ledger_residual_count: 0,
    })).toBe(false);
    expect(cronRestoreObservationRequiresHold({
      ...heldObservation,
      store_key: "operation_plans",
    })).toBe(false);
    expect(cronRestoreObservationRequiresHold({
      ...heldObservation,
      store_key: null,
      status: "unverified",
    })).toBe(true);

    const ch = new CronSchedulerChannel({
      tasks: [{ id: "smoke", channel: "webchat", target: "local-user", content: "must stay held", interval_ms: 1000 }],
      log: () => undefined,
    });
    ch.holdForUnverifiedRestoreObservation();
    try {
      await ch.start(async (request) => { received.push(request); });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(received).toHaveLength(0);
      expect(ch.snapshot()).toMatchObject([{
        running: false,
        next_fire_at_ms: null,
        recovery_hold: "restore_observation_unverified",
      }]);
    } finally {
      await ch.stop();
      vi.useRealTimers();
    }
  });

  it("pauses and resumes scheduled work only after recovery observation", async () => {
    vi.useFakeTimers();
    const received: unknown[] = [];
    const ch = new CronSchedulerChannel({
      tasks: [{ id: "restore", channel: "webchat", target: "local-user", content: "scheduled", interval_ms: 60_000 }],
      log: () => undefined,
    });
    const handler = async (request: InboundRequest) => { received.push(request); };
    try {
      await ch.start(handler);
      expect(ch.snapshot()[0]).toMatchObject({ running: true, recovery_hold: null });
      expect(await ch.quiesceForRecoveryRestore()).toBe(true);
      expect(ch.snapshot()[0]).toMatchObject({ running: false, recovery_hold: null });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(received).toHaveLength(0);

      await ch.resumeAfterRecoveryRestore({ restore_attempted: true, observation_verified: false });
      expect(ch.snapshot()[0]).toMatchObject({ running: false, recovery_hold: "restore_observation_unverified" });
      expect(await ch.quiesceForRecoveryRestore()).toBe(true);
      await ch.resumeAfterRecoveryRestore({ restore_attempted: true, observation_verified: true });
      expect(ch.snapshot()[0]).toMatchObject({ running: true, recovery_hold: null });
    } finally {
      await ch.stop();
      vi.useRealTimers();
    }
  });

  it("exposes multiple scheduled-message snapshots without exposing content", async () => {
    const now = new Date(2026, 4, 9, 6, 30, 0, 0);
    const ch = new CronSchedulerChannel({
      tasks: [
        {
          id: "morning",
          channel: "telegram",
          target: "chat-1",
          content: "private morning content",
          time: "07:00",
        },
        {
          id: "smoke",
          channel: "webchat",
          target: "local-user",
          content: "private smoke content",
          interval_ms: 60_000,
        },
      ],
      now: () => now,
      log: () => undefined,
    });

    await ch.start(async () => undefined);
    try {
      const snapshot = ch.snapshot();
      expect(snapshot).toHaveLength(2);
      expect(snapshot[0]).toMatchObject({
        id: "morning",
        name: "scheduled_message",
        enabled: true,
        running: true,
        channel: "telegram",
        target: "chat-1",
        time: "07:00",
      });
      expect(snapshot[1]).toMatchObject({
        id: "smoke",
        running: true,
        interval_ms: 60_000,
        next_fire_at_ms: now.getTime() + 60_000,
      });
      expect(JSON.stringify(snapshot)).not.toContain("private morning content");
      expect(JSON.stringify(snapshot)).not.toContain("private smoke content");
    } finally {
      await ch.stop();
    }
  });

  it("fires scheduled messages through trusted cron metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const { root, store } = makeTestEventStore("blue-tanuki-cron-metadata-");
    const received: unknown[] = [];
    const ch = new CronSchedulerChannel({
      tasks: [
        {
          id: "smoke",
          channel: "webchat",
          target: "local-user",
          content: "scheduled hello",
          interval_ms: 1000,
        },
      ],
      event_store: store,
      log: () => undefined,
    });

    try {
      await ch.start(async (req) => {
        received.push(req);
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "cron",
        user: "blue-tanuki-cron",
        content: "scheduled hello",
        session_id: expect.stringMatching(/^cron-task:[a-f0-9]{64}$/),
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.actor_kind": "cron",
          "blue_tanuki.process_kind": "cron",
          "blue_tanuki.cron.task_id": "smoke",
          "blue_tanuki.channel_send.channel": "webchat",
          "blue_tanuki.channel_send.target": "local-user",
          "blue_tanuki.channel_send.content": "scheduled hello",
        },
      });
      expect(ch.snapshot()[0]?.last_fire_at_ms).toBe(new Date(2026, 4, 9, 6, 30, 1, 0).getTime());
    } finally {
      await ch.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("wakes only at scheduled events and keeps executor context stable per schedule", async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 4, 9, 6, 30);
    vi.setSystemTime(base);
    const { root, store } = makeTestEventStore("blue-tanuki-cron-schedule-wake-");
    const received: Array<{ task_id: string; session_id: string | undefined }> = [];
    const ch = new CronSchedulerChannel({
      tasks: [
        { id: "wait-task-a", channel: "webchat", target: "local-user", content: "event a", interval_ms: 1000 },
        { id: "wait-task-b", channel: "webchat", target: "local-user", content: "event b", interval_ms: 1000 },
      ],
      event_store: store,
      log: () => undefined,
    });

    try {
      await ch.start(async (request) => {
        received.push({
          task_id: String(request.metadata?.["blue_tanuki.cron.task_id"]),
          session_id: request.session_id,
        });
      });
      expect(received).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toHaveLength(4);

      const sessionsByTask = new Map<string, Set<string>>();
      for (const item of received) {
        expect(item.session_id).toMatch(/^cron-task:[a-f0-9]{64}$/);
        const sessions = sessionsByTask.get(item.task_id) ?? new Set<string>();
        sessions.add(item.session_id!);
        sessionsByTask.set(item.task_id, sessions);
      }
      expect(sessionsByTask.size).toBe(2);
      expect(sessionsByTask.get("wait-task-a")?.size).toBe(1);
      expect(sessionsByTask.get("wait-task-b")?.size).toBe(1);
      const distinctSessions = new Set([...sessionsByTask.values()].map((sessions) => [...sessions][0]));
      expect(distinctSessions.size).toBe(2);
    } finally {
      await ch.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("persists Cron handler exceptions as outcome_unknown through the shared inbound router", async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 4, 9, 6, 30, 0, 0).getTime();
    vi.setSystemTime(base);
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-handler-failure-"));
    const store = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"));
    const router = new InboundRouter({ propagateHandlerErrorsForChannels: ["cron"] });
    const cron = new CronSchedulerChannel({
      tasks: [{
        id: "handler-failure",
        origin: "runtime",
        channel: "webchat",
        target: "local-user",
        content: "synthetic scheduled content",
        interval_ms: 1000,
      }],
      event_store: store,
      log: () => undefined,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    router.register(cron);

    try {
      await router.start(async () => {
        throw new Error("private synthetic failure detail");
      });
      await vi.advanceTimersByTimeAsync(2000);

      const unresolved = store.unresolvedEvents();
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({
        delivery_state: "outcome_unknown",
        resolution_state: "unacknowledged",
      });
      expect(JSON.stringify(unresolved)).not.toContain("private synthetic failure detail");
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      await router.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stores the digest-only result observation when the Cron handler returns", async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 4, 9, 6, 30, 0, 0).getTime();
    vi.setSystemTime(base);
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-result-callback-"));
    const store = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"));
    const observedEvents: Array<Parameters<typeof createCronEventResultReceipt>[0]> = [];
    const cron = new CronSchedulerChannel({
      tasks: [{
        id: "result-observation",
        origin: "runtime",
        channel: "webchat",
        target: "local-user",
        content: "private synthetic content",
        interval_ms: 1000,
      }],
      event_store: store,
      onHandlerReturned: (event) => {
        observedEvents.push(event);
        return createCronEventResultReceipt(event, {
          schema_version: "operation-plan-projection.v1",
          used_for_authority: false,
          raw_payload_exposed: false,
          recovery_refresh_status: "ready",
          result_memory: { configured: false, status: "not_configured", used_for_authority: false },
          plans: [],
        }, {
          entries: [], chain_valid: true, skipped_count: 0,
        });
      },
      log: () => undefined,
    });

    try {
      await cron.start(async () => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(observedEvents).toHaveLength(1);
      const receipt = store.resultReceipt(observedEvents[0]!);
      expect(receipt).toMatchObject({
        task_outcome_status: "unobserved",
        used_for_authority: false,
        may_execute: false,
      });
      expect(store.unresolvedEvents()).toEqual([]);
    } finally {
      await cron.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("serializes same-source deliveries and carries the scheduled event identity", async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 4, 9, 6, 30, 0, 0).getTime();
    vi.setSystemTime(base);
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-channel-"));
    const store = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"));
    const seen: Array<{ id: string; sequence: string | undefined }> = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const ch = new CronSchedulerChannel({
      tasks: [{
        id: "ordered",
        origin: "runtime",
        channel: "webchat",
        target: "local-user",
        content: "synthetic scheduled content",
        interval_ms: 1000,
      }],
      event_store: store,
      log: () => undefined,
    });

    try {
      await ch.start(async (req) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push({
          id: req.id,
          sequence: req.metadata?.["blue_tanuki.cron.event_sequence"],
        });
        try {
          if (seen.length === 1) await firstGate;
        } finally {
          active -= 1;
        }
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(seen).toHaveLength(1);
      expect(ch.isEventInFlight(seen[0]!.id)).toBe(true);
      releaseFirst();
      await ch.stop();

      expect(seen).toHaveLength(3);
      expect(ch.isEventInFlight(seen[0]!.id)).toBe(false);
      expect(seen.map(({ sequence }) => Number(sequence))).toEqual([base + 1000, base + 2000, base + 3000]);
      expect(new Set(seen.map(({ id }) => id)).size).toBe(3);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await ch.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("does not redeliver a persisted scheduled identity after scheduler restart", async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 4, 9, 6, 30, 0, 0).getTime();
    vi.setSystemTime(base);
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-restart-"));
    const store = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"));
    const received: unknown[] = [];
    const makeChannel = () => new CronSchedulerChannel({
      tasks: [{
        id: "restart-stable",
        origin: "runtime",
        channel: "webchat",
        target: "local-user",
        content: "synthetic restart content",
        interval_ms: 1000,
      }],
      now: () => new Date(base),
      event_store: store,
      log: () => undefined,
    });

    try {
      const first = makeChannel();
      await first.start(async (req) => { received.push(req); });
      await vi.advanceTimersByTimeAsync(1000);
      await first.stop();

      const restarted = makeChannel();
      await restarted.start(async (req) => { received.push(req); });
      await vi.advanceTimersByTimeAsync(1000);
      await restarted.stop();

      expect(received).toHaveLength(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("preserves an interval cadence but holds after restart when a tick was missed", async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 4, 9, 6, 30, 0, 0).getTime();
    vi.setSystemTime(base);
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-interval-restart-"));
    const store = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"));
    const received: number[] = [];
    const makeChannel = () => new CronSchedulerChannel({
      tasks: [{
        id: "interval-restart",
        origin: "runtime",
        channel: "webchat",
        target: "local-user",
        content: "synthetic interval content",
        interval_ms: 1000,
      }],
      now: () => new Date(),
      event_store: store,
      log: () => undefined,
    });

    try {
      const first = makeChannel();
      await first.start(async (req) => { received.push(Number(req.metadata?.["blue_tanuki.cron.event_sequence"])); });
      await vi.advanceTimersByTimeAsync(1000);
      await first.stop();

      await vi.advanceTimersByTimeAsync(2500);
      const restarted = makeChannel();
      await restarted.start(async (req) => { received.push(Number(req.metadata?.["blue_tanuki.cron.event_sequence"])); });
      expect(restarted.snapshot()[0]).toMatchObject({
        running: false,
        next_fire_at_ms: null,
        catch_up_hold: { reason: "catch_up_policy_unresolved", scheduled_at_ms: base + 2000, persisted: true },
      });
      await vi.advanceTimersByTimeAsync(500);
      await restarted.stop();

      expect(received).toEqual([base + 1000]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("holds the first runtime interval occurrence missed before the scheduler's first start", async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 4, 9, 6, 30, 0, 0).getTime();
    vi.setSystemTime(base + 3500);
    const { root, store } = makeTestEventStore("blue-tanuki-cron-first-fire-missed-");
    const received: unknown[] = [];
    const ch = new CronSchedulerChannel({
      tasks: [{
        id: "created-before-start",
        origin: "runtime",
        created_at_ms: base,
        channel: "webchat",
        target: "local-user",
        content: "synthetic created schedule",
        interval_ms: 1000,
      }],
      event_store: store,
      log: () => undefined,
    });
    try {
      await ch.start(async (request) => { received.push(request); });
      expect(ch.snapshot()[0]).toMatchObject({
        running: false,
        next_fire_at_ms: null,
        catch_up_hold: { scheduled_at_ms: base + 1000, persisted: true },
      });
      expect(received).toEqual([]);
      expect(store.latestSequenceForSource("cron:runtime:created-before-start")).toBe(base + 1000);
    } finally {
      await ch.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("binds the static Daily Brief payload and version without exposing its content in snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const { root, store } = makeTestEventStore("blue-tanuki-cron-private-payload-");
    const received: unknown[] = [];
    const fired: { snapshot: unknown; event: unknown }[] = [];
    const configuredBrief = "synthetic daily brief content";
    const ch = new CronSchedulerChannel({
      tasks: [
        {
          id: "daily_brief",
          name: "daily_brief",
          channel: "webchat",
          target: "local-user",
          content: configuredBrief,
          interval_ms: 1000,
        },
      ],
      log: () => undefined,
      onFire: (snapshot, event) => fired.push({ snapshot, event }),
      event_store: store,
    });

    try {
      await ch.start(async (req) => {
        received.push(req);
      });
      await vi.advanceTimersByTimeAsync(1000);
      const expectedHash = cronPayloadHash({
        channel: "webchat",
        target: "local-user",
        content: configuredBrief,
        interval_ms: 1000,
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        content: configuredBrief,
        metadata: {
          "blue_tanuki.cron.payload_hash": expectedHash,
          "blue_tanuki.cron.content_source": "static",
          "blue_tanuki.channel_send.content": configuredBrief,
        },
      });
      expect(fired[0]).toMatchObject({ snapshot: { payload_hash: expectedHash }, event: { payload_digest: expectedHash } });
      expect(JSON.stringify(ch.snapshot())).not.toContain(configuredBrief);
    } finally {
      await ch.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("persists a Google Daily Brief occurrence without admitting it to the inbound handler", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 4, 9, 7, 0);
    vi.setSystemTime(now);
    const { root, store } = makeTestEventStore("blue-tanuki-cron-local-due-");
    const env = {
      BLUE_TANUKI_DAILY_BRIEF_ENABLED: "1",
      BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED: "1",
      BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES: "gmail,calendar,gmail",
      BLUE_TANUKI_DAILY_BRIEF_TARGET: "synthetic-destination",
      BLUE_TANUKI_DAILY_BRIEF_CONTENT: "synthetic private payload",
      BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS: "1000",
    };
    const handler = vi.fn(async () => undefined);
    const makeChannel = (eventStore: GatewayCronEventStore, services: string) => new CronSchedulerChannel({
      tasks: cronSchedulesFromEnv({ ...env, BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES: services }),
      event_store: eventStore,
      onFire: vi.fn(() => { throw new Error("normal occurrence hook must not be called"); }),
      onHandlerReturned: vi.fn(() => { throw new Error("no inbound handler returned"); }),
      log: () => undefined,
    });
    const channel = makeChannel(store, env.BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES);
    let reopened: GatewayCronEventStore | undefined;
    try {
      await channel.start(handler);
      expect(channel.snapshot()[0]).toMatchObject({ running: true, next_fire_at_ms: now + 1000 });
      expect(channel.snapshot()[0]?.local_acquisition_due).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      const snapshot = channel.snapshot()[0]!;
      expect(snapshot).toMatchObject({ used_for_authority: false, local_acquisition_due: {
        status: "awaiting_authorized_acquisition",
        occurrence_id_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        schedule_payload_digest: snapshot.payload_hash,
        scheduled_at_ms: now + 1000,
        recorded_at_ms: now + 1000,
        used_for_authority: false,
        may_execute: false,
      } });
      expect(handler).not.toHaveBeenCalled();
      expect(JSON.stringify(snapshot)).not.toContain(env.BLUE_TANUKI_DAILY_BRIEF_CONTENT);
      const event = createCronEventIdentity(GOOGLE_DAILY_BRIEF_DUE_SOURCE, now + 1000, snapshot.payload_hash);
      expect(store.claim(event)).toEqual({ status: "duplicate", delivery_state: "handler_returned" });
      expect(store.resultReceipt(event)).toBeNull();
      expect(store.latestSequenceForSource("cron:boot:daily_brief")).toBeNull();

      await channel.stop();
      store.close();
      reopened = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"));
      const sameScope = makeChannel(reopened, " Calendar GMAIL ");
      await sameScope.start(handler);
      try {
        expect(sameScope.snapshot()[0]).toMatchObject({
          next_fire_at_ms: now + 2000, local_acquisition_due: snapshot.local_acquisition_due,
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(sameScope.snapshot()[0]?.local_acquisition_due).toEqual(snapshot.local_acquisition_due);
        await vi.advanceTimersByTimeAsync(1);
        const nextOccurrence = sameScope.snapshot()[0]?.local_acquisition_due;
        expect(nextOccurrence?.scheduled_at_ms).toBe(now + 2000);
        expect(nextOccurrence?.occurrence_id_digest).not.toBe(snapshot.local_acquisition_due?.occurrence_id_digest);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await sameScope.stop();
      }
      const differentScope = makeChannel(reopened, "drive");
      expect(differentScope.snapshot()[0]?.payload_hash).not.toBe(snapshot.payload_hash);
      expect(differentScope.snapshot()[0]?.local_acquisition_due).toBeUndefined();

      const invalidScope = makeChannel(reopened, "gmail,unsupported");
      await invalidScope.start(handler);
      try {
        expect(invalidScope.snapshot()[0]).toMatchObject({
          content_source_hold: "google_authorized_acquisition_not_wired", running: false, next_fire_at_ms: null,
        });
        expect(invalidScope.snapshot()[0]?.local_acquisition_due).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1000);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await invalidScope.stop();
      }
    } finally {
      await channel.stop();
      store.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});

describe("cronSchedulesFromEnv", () => {
  it("parses generic scheduled messages alongside Daily Brief compatibility", () => {
    const tasks = cronSchedulesFromEnv({
      BLUE_TANUKI_DAILY_BRIEF_ENABLED: "1",
      BLUE_TANUKI_DAILY_BRIEF_TARGET: "telegram-chat",
      BLUE_TANUKI_DAILY_BRIEF_TIME_ZONE: "UTC",
      BLUE_TANUKI_SCHEDULES_JSON: JSON.stringify([
        {
          id: "ops-smoke",
          channel: "webchat",
          target: "local-user",
          content: "ops smoke",
          interval_ms: 60000,
        },
      ]),
    });
    expect(tasks).toMatchObject([
      {
        id: "daily_brief",
        name: "daily_brief",
        channel: "telegram",
        target: "telegram-chat",
        time_zone: "UTC",
      },
      {
        id: "ops-smoke",
        name: "scheduled_message",
        channel: "webchat",
        target: "local-user",
        interval_ms: 60000,
      },
    ]);
  });

  it("fails closed on malformed or duplicate generic schedules", () => {
    expect(() => cronSchedulesFromEnv({
      BLUE_TANUKI_SCHEDULES_JSON: "{nope",
    })).toThrow(/valid JSON/);
    expect(() => cronSchedulesFromEnv({
      BLUE_TANUKI_SCHEDULES_JSON: JSON.stringify([
        { id: "dup", channel: "webchat", target: "a", content: "one" },
        { id: "dup", channel: "webchat", target: "b", content: "two" },
      ]),
    })).toThrow(/duplicate cron task id/);
  });
});
