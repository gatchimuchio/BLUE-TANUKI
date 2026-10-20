import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateApproval } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { cronPayloadHash, CronSchedulerChannel } from "../src/cron_channel.js";
import {
  RuntimeScheduleManager,
  runtimeScheduleMutationCommand,
} from "../src/runtime_schedule.js";

const upstream = {
  frame_goal: "goal",
  model_abstraction: "model",
  commit_hash: "abc123",
  commit_decision: "ASSERT" as const,
};

function command(
  tool_name: "schedule.list" | "schedule.create" | "schedule.update" | "schedule.delete",
  args: Record<string, unknown>,
): Extract<ExecuteCommand, { type: "tool_call" }> {
  const cap = tool_name.split(".")[1]!;
  return {
    id: `cmd-${tool_name}-${Math.random().toString(16).slice(2)}`,
    type: "tool_call",
    payload: { tool_name, arguments: args },
    constraints: {
      allowed_tools: [tool_name],
      allowed_capabilities: [`tool:${tool_name}`, `schedule:${cap === "list" ? "read" : cap}`],
    },
    upstream_decision: upstream,
  };
}

async function manager(opts: { now?: () => number; timeout_ms?: number; lifecycle?: unknown[] } = {}): Promise<RuntimeScheduleManager> {
  const dir = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-"));
  return await RuntimeScheduleManager.open({
    env: {
      BLUE_TANUKI_SCHEDULES_DIR: dir,
      BLUE_TANUKI_SCHEDULE_APPROVAL_TIMEOUT_MS: String(opts.timeout_ms ?? 86_400_000),
    },
    now: opts.now,
    onLifecycle: (event, lifecycle) => {
      opts.lifecycle?.push({ event, ...lifecycle });
    },
  });
}

async function approve(m: RuntimeScheduleManager, cmd: ExecuteCommand): Promise<unknown> {
  const tool = m.tools().find((candidate) => candidate.name === (cmd as Extract<ExecuteCommand, { type: "tool_call" }>).payload.tool_name);
  if (!tool) throw new Error("tool not found");
  return await tool.invoke({}, { command_id: cmd.id, upstream_commit_hash: "abc123" });
}

function evaluation(cmd: ExecuteCommand) {
  return evaluateApproval(cmd, [], { actor: "alice", now: 1, default_mode: "full_access" });
}

describe("RuntimeScheduleManager", () => {
  it("creates a pending schedule only after approval and never exposes content in snapshots", async () => {
    const lifecycle: unknown[] = [];
    const m = await manager({ lifecycle });
    const cmd = command("schedule.create", {
      id: "runtime-smoke",
      channel: "webchat",
      target: "local-user",
      content: "private runtime content",
      interval_ms: 120000,
    });

    expect(runtimeScheduleMutationCommand(cmd)).toBe(true);
    const prepared = m.preparePending(cmd, evaluation(cmd), { request_id: "req-1", actor: "alice" });
    expect(prepared.ok).toBe(true);
    expect(m.pendingCount()).toBe(1);
    expect(m.activeCount()).toBe(0);
    expect(JSON.stringify(m.snapshot())).not.toContain("private runtime content");

    const result = await approve(m, cmd);
    expect(result).toMatchObject({ schedule_id: "runtime-smoke", status: "active", can_fire: true });
    expect(m.pendingCount()).toBe(0);
    expect(m.activeCount()).toBe(1);
    expect(m.snapshot()[0]).toMatchObject({
      id: "runtime-smoke",
      status: "active",
      origin: "runtime",
      interval_ms: 120000,
    });
    expect(JSON.stringify(m.snapshot())).not.toContain("private runtime content");
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "schedule.lifecycle.requested", operation: "create", approval_level: "L3_final_review" }),
      expect.objectContaining({ event: "schedule.lifecycle.approved", operation: "create" }),
      expect.objectContaining({ event: "schedule.lifecycle.activated", operation: "create" }),
    ]));
  });

  it("requires a fresh L3 evaluation bound to the same schedule command", async () => {
    const m = await manager();
    const cmd = command("schedule.create", {
      id: "review-bound",
      channel: "webchat",
      target: "local-user",
      content: "scheduled content",
      interval_ms: 120000,
    });
    const valid = evaluation(cmd);
    const mismatched = {
      ...valid,
      context: { ...valid.context, command_id: "another-command" },
    };
    expect(m.preparePending(cmd, mismatched, { request_id: "req-review", actor: "alice" })).toMatchObject({ ok: false });

    const downgraded = { ...valid, approval_level: "L2_operate" as const };
    expect(m.preparePending(cmd, downgraded, { request_id: "req-review", actor: "alice" })).toMatchObject({ ok: false });
    expect(m.pendingCount()).toBe(0);
    expect(m.activeCount()).toBe(0);
  });

  it("binds a daily IANA time zone into the approved schedule and payload identity", async () => {
    const m = await manager();
    const cmd = command("schedule.create", {
      id: "daily-zone",
      channel: "webchat",
      target: "local-user",
      content: "synthetic daily content",
      time: "08:30",
      time_zone: "America/New_York",
    });
    const prepared = m.preparePending(cmd, evaluation(cmd), { request_id: "req-daily-zone", actor: "alice" });
    expect(prepared).toMatchObject({ ok: true, pending: { approval_level: "L3_final_review" } });
    await approve(m, cmd);
    expect(m.snapshot()[0]).toMatchObject({
      id: "daily-zone",
      time: "08:30",
      time_zone: "America/New_York",
      status: "active",
    });
    expect(m.snapshot()[0]?.payload_hash).toBe(cronPayloadHash({
      channel: "webchat",
      target: "local-user",
      content: "synthetic daily content",
      time: "08:30",
      time_zone: "America/New_York",
    }));

    const defaultZone = command("schedule.create", {
      id: "daily-zone-default",
      channel: "webchat",
      target: "local-user",
      content: "synthetic local daily content",
      time: "09:00",
    });
    expect(m.preparePending(defaultZone, evaluation(defaultZone), { request_id: "req-daily-zone-default", actor: "alice" }).ok).toBe(true);
    await approve(m, defaultZone);
    expect(m.snapshot().find((schedule) => schedule.id === "daily-zone-default")?.time_zone)
      .toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("continues to load a legacy daily schedule without a stored time zone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-legacy-daily-"));
    const env = { BLUE_TANUKI_SCHEDULES_DIR: dir };
    const entry = {
      id: "legacy-daily",
      origin: "runtime",
      enabled: true,
      channel: "webchat",
      target: "local-user",
      content: "legacy content",
      time: "07:00",
      created_at_ms: 1,
      updated_at_ms: 1,
      payload_hash: cronPayloadHash({ channel: "webchat", target: "local-user", content: "legacy content", time: "07:00" }),
      status: "active",
    };
    writeFileSync(join(dir, "runtime-schedules.json"), `${JSON.stringify([entry])}\n`, "utf8");
    try {
      const m = await RuntimeScheduleManager.open({ env });
      expect(m.activeCount()).toBe(1);
      expect(m.snapshot()[0]).toMatchObject({ id: "legacy-daily", time: "07:00", status: "active" });
      expect(m.activeCronTasks()[0]?.time_zone).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate active schedules and pending conflicts without activation", async () => {
    const m = await manager();
    const create = command("schedule.create", {
      id: "dup",
      channel: "webchat",
      target: "local-user",
      content: "first",
      interval_ms: 120000,
    });
    expect(m.preparePending(create, evaluation(create), { request_id: "req-1", actor: "alice" }).ok).toBe(true);
    await approve(m, create);

    const duplicate = command("schedule.create", {
      id: "dup",
      channel: "webchat",
      target: "local-user",
      content: "second",
      interval_ms: 120000,
    });
    expect(m.preparePending(duplicate, evaluation(duplicate), { request_id: "req-2", actor: "alice" })).toMatchObject({ ok: false });

    const update = command("schedule.update", { id: "dup", content: "updated" });
    expect(m.preparePending(update, evaluation(update), { request_id: "req-3", actor: "alice" }).ok).toBe(true);
    const del = command("schedule.delete", { id: "dup" });
    expect(m.preparePending(del, evaluation(del), { request_id: "req-4", actor: "alice" })).toMatchObject({ ok: false });
  });

  it("keeps the old schedule active while update/delete waits for approval", async () => {
    const m = await manager();
    const create = command("schedule.create", {
      id: "updatable",
      channel: "webchat",
      target: "local-user",
      content: "old",
      interval_ms: 120000,
    });
    m.preparePending(create, evaluation(create), { request_id: "req-1", actor: "alice" });
    await approve(m, create);
    const oldHash = m.snapshot()[0]?.payload_hash;

    const update = command("schedule.update", { id: "updatable", content: "new" });
    expect(m.preparePending(update, evaluation(update), { request_id: "req-2", actor: "alice" }).ok).toBe(true);
    expect(m.activeCount()).toBe(1);
    expect(m.snapshot().find((s) => s.id === "updatable")?.payload_hash).toBe(oldHash);
    await approve(m, update);
    expect(m.snapshot().find((s) => s.id === "updatable")?.payload_hash).not.toBe(oldHash);

    const del = command("schedule.delete", { id: "updatable" });
    expect(m.preparePending(del, evaluation(del), { request_id: "req-3", actor: "alice" }).ok).toBe(true);
    expect(m.activeCount()).toBe(1);
    await approve(m, del);
    expect(m.activeCount()).toBe(0);
    expect(m.snapshot().find((s) => s.id === "updatable")?.status).toBe("deleted");
  });

  it("switches a trigger mode only through the newly approved update", async () => {
    const m = await manager();
    const create = command("schedule.create", {
      id: "trigger-switch",
      channel: "webchat",
      target: "local-user",
      content: "scheduled content",
      time: "07:15",
    });
    expect(m.preparePending(create, evaluation(create), { request_id: "req-trigger-create", actor: "alice" }).ok).toBe(true);
    await approve(m, create);
    expect(m.activeCronTasks()[0]).toMatchObject({ time: "07:15", interval_ms: undefined });

    const update = command("schedule.update", { id: "trigger-switch", interval_ms: 60000 });
    expect(m.preparePending(update, evaluation(update), { request_id: "req-trigger-update", actor: "alice" }).ok).toBe(true);
    expect(m.activeCronTasks()[0]?.time).toBe("07:15");
    await approve(m, update);
    expect(m.activeCronTasks()[0]).toMatchObject({ time: undefined, interval_ms: 60000 });
  });

  it("reloads only exact persisted schedules and rejects an unknown state instead of activating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-reload-"));
    const env = { BLUE_TANUKI_SCHEDULES_DIR: dir };
    const m = await RuntimeScheduleManager.open({ env });
    const create = command("schedule.create", {
      id: "reload-safe",
      channel: "webchat",
      target: "local-user",
      content: "scheduled content",
      interval_ms: 120000,
    });
    expect(m.preparePending(create, evaluation(create), { request_id: "req-reload", actor: "alice" }).ok).toBe(true);
    await approve(m, create);

    const reopened = await RuntimeScheduleManager.open({ env });
    expect(reopened.activeCount()).toBe(1);
    expect(reopened.activeCronTasks()).toMatchObject([{ id: "reload-safe", interval_ms: 120000 }]);

    const update = command("schedule.update", { id: "reload-safe", interval_ms: 60000 });
    expect(reopened.preparePending(update, evaluation(update), { request_id: "req-reload-update", actor: "alice" }).ok).toBe(true);
    await approve(reopened, update);
    const updated = await RuntimeScheduleManager.open({ env });
    expect(updated.activeCronTasks()).toMatchObject([{ id: "reload-safe", interval_ms: 60000 }]);

    const deletion = command("schedule.delete", { id: "reload-safe" });
    expect(updated.preparePending(deletion, evaluation(deletion), { request_id: "req-reload-delete", actor: "alice" }).ok).toBe(true);
    await approve(updated, deletion);
    const deleted = await RuntimeScheduleManager.open({ env });
    expect(deleted.activeCount()).toBe(0);
    expect(deleted.snapshot()).toMatchObject([{ id: "reload-safe", status: "deleted", enabled: false }]);

    const file = join(dir, "runtime-schedules.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    stored[0]!.status = "unrecognized";
    writeFileSync(file, `${JSON.stringify(stored)}\n`, "utf8");
    await expect(RuntimeScheduleManager.open({ env })).rejects.toThrow(/status is invalid/);

    stored[0]!.status = "active";
    stored[0]!.enabled = true;
    stored[0]!.payload_hash = "0".repeat(64);
    writeFileSync(file, `${JSON.stringify(stored)}\n`, "utf8");
    await expect(RuntimeScheduleManager.open({ env })).rejects.toThrow(/payload hash does not match/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not activate an approved change when atomic persistence fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-write-failure-"));
    const env = { BLUE_TANUKI_SCHEDULES_DIR: dir };
    const m = await RuntimeScheduleManager.open({ env });
    const cron = new CronSchedulerChannel({ tasks: [], log: () => undefined });
    m.attachScheduler(cron);
    const create = command("schedule.create", {
      id: "persist-before-fire",
      channel: "webchat",
      target: "local-user",
      content: "original content",
      interval_ms: 120000,
    });
    expect(m.preparePending(create, evaluation(create), { request_id: "req-persist-create", actor: "alice" }).ok).toBe(true);
    await approve(m, create);
    const oldHash = m.snapshot()[0]?.payload_hash;
    const store = join(dir, "runtime-schedules.json");
    renameSync(store, join(dir, "runtime-schedules.before-failure.json"));
    mkdirSync(store);

    const update = command("schedule.update", { id: "persist-before-fire", content: "uncommitted content" });
    expect(m.preparePending(update, evaluation(update), { request_id: "req-persist-update", actor: "alice" }).ok).toBe(true);
    await expect(approve(m, update)).rejects.toThrow();
    expect(m.activeCount()).toBe(1);
    expect(m.snapshot()[0]?.payload_hash).toBe(oldHash);
    expect(cron.snapshot()[0]?.payload_hash).toBe(oldHash);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid schedule create fields with owner-actionable output", async () => {
    const m = await manager();
    for (const args of [
      { id: "../bad", channel: "webchat", target: "local-user", content: "x", interval_ms: 1 },
      { id: "bad-time", channel: "webchat", target: "local-user", content: "x", time: "25:00" },
      { id: "bad-time-zone", channel: "webchat", target: "local-user", content: "x", time: "07:00", time_zone: "Mars/Olympus" },
      { id: "interval-time-zone", channel: "webchat", target: "local-user", content: "x", interval_ms: 1000, time_zone: "UTC" },
      { id: "bad-interval", channel: "webchat", target: "local-user", content: "x", interval_ms: 0 },
      { id: "missing-content", channel: "webchat", target: "local-user", interval_ms: 1 },
    ]) {
      const cmd = command("schedule.create", args);
      const prepared = m.preparePending(cmd, evaluation(cmd), { request_id: "req-invalid", actor: "alice" });
      expect(prepared).toMatchObject({ ok: false });
      expect(prepared.ok === false ? prepared.message : "").toContain("activated=false");
      expect(prepared.ok === false ? prepared.message : "").toContain("next_action=");
    }
  });

  it("expires pending approval without activating the schedule", async () => {
    let now = 1;
    const lifecycle: unknown[] = [];
    const m = await manager({ now: () => now, timeout_ms: 10, lifecycle });
    const cmd = command("schedule.create", {
      id: "timeout",
      channel: "webchat",
      target: "local-user",
      content: "will not run",
      interval_ms: 120000,
    });
    expect(m.preparePending(cmd, evaluation(cmd), { request_id: "req-timeout", actor: "alice" }).ok).toBe(true);
    now = 12;
    expect(m.pendingCount()).toBe(0);
    expect(m.activeCount()).toBe(0);
    await expect(approve(m, cmd)).rejects.toThrow(/approval missing or expired/);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "schedule.lifecycle.rejected", operation: "create" }),
    ]));
  });

  it("fires approved runtime schedules through the cron lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const received: unknown[] = [];
    const m = await manager();
    const cron = new CronSchedulerChannel({ tasks: [], log: () => undefined });
    m.attachScheduler(cron);
    await cron.start(async (req) => {
      received.push(req);
    });
    try {
      const cmd = command("schedule.create", {
        id: "runtime-fire",
        channel: "webchat",
        target: "local-user",
        content: "runtime hello",
        interval_ms: 1000,
      });
      m.preparePending(cmd, evaluation(cmd), { request_id: "req-fire", actor: "alice" });
      await approve(m, cmd);
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "cron",
        metadata: {
          "blue_tanuki.cron.task_id": "runtime-fire",
          "blue_tanuki.cron.origin": "runtime",
          "blue_tanuki.channel_send.content": "runtime hello",
        },
      });
    } finally {
      await cron.stop();
      vi.useRealTimers();
    }
  });
});

