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
} from "../src/cron_channel.js";
import { GatewayCronEventStore } from "../src/cron_event_store.js";
import { InboundRouter } from "@blue-tanuki/channel-base";

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

  it("uses a dynamic content provider without exposing content in snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const received: unknown[] = [];
    const fired: unknown[] = [];
    const ch = new CronSchedulerChannel({
      tasks: [
        {
          id: "daily_brief",
          name: "daily_brief",
          channel: "webchat",
          target: "local-user",
          content: "static fallback",
          interval_ms: 1000,
        },
      ],
      log: () => undefined,
      content_provider: async () => ({
        content: "dynamic google brief",
        metadata: {
          "blue_tanuki.cron.content_source": "google_read",
          "blue_tanuki.google.read_only": "true",
        },
      }),
      onFire: (task) => fired.push(task),
    });

    try {
      await ch.start(async (req) => {
        received.push(req);
      });
      await vi.advanceTimersByTimeAsync(1000);
      const expectedHash = cronPayloadHash({
        channel: "webchat",
        target: "local-user",
        content: "dynamic google brief",
        interval_ms: 1000,
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        content: "dynamic google brief",
        metadata: {
          "blue_tanuki.cron.payload_hash": expectedHash,
          "blue_tanuki.cron.content_source": "google_read",
          "blue_tanuki.google.read_only": "true",
          "blue_tanuki.channel_send.content": "dynamic google brief",
        },
      });
      expect(fired[0]).toMatchObject({ payload_hash: expectedHash });
      expect(JSON.stringify(ch.snapshot())).not.toContain("dynamic google brief");
    } finally {
      await ch.stop();
      vi.useRealTimers();
    }
  });
});

describe("cronSchedulesFromEnv", () => {
  it("parses generic scheduled messages alongside Daily Brief compatibility", () => {
    const tasks = cronSchedulesFromEnv({
      BLUE_TANUKI_DAILY_BRIEF_ENABLED: "1",
      BLUE_TANUKI_DAILY_BRIEF_TARGET: "telegram-chat",
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
