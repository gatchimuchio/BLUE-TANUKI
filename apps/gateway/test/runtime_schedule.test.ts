import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateApproval } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { cronPayloadHash, CronSchedulerChannel } from "../src/cron_channel.js";
import { GatewayCronEventStore } from "../src/cron_event_store.js";
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

const scheduleFixtures: { directory: string; manager?: RuntimeScheduleManager }[] = [];
const testGoalVersionBinding = { goal_id_digest: "a".repeat(64), purpose_version: 1, purpose_digest: "b".repeat(64) } as const;

afterEach(async () => {
  for (const fixture of scheduleFixtures.splice(0)) {
    await fixture.manager?.drain();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

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

interface ScheduleFixtureOptions {
  now?: () => number;
  timeout_ms?: number;
  lifecycle?: unknown[];
  beforePersist?: (kind: "approve" | "reject") => void;
}

async function scheduleFixture(opts: ScheduleFixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-"));
  const fixture: (typeof scheduleFixtures)[number] = { directory };
  scheduleFixtures.push(fixture);
  const env = {
    BLUE_TANUKI_SCHEDULES_DIR: directory,
    BLUE_TANUKI_SCHEDULE_APPROVAL_TIMEOUT_MS: String(opts.timeout_ms ?? 86_400_000),
  };
  const manager = await RuntimeScheduleManager.open({
    env,
    now: opts.now,
    beforePersist: opts.beforePersist,
    onLifecycle: (event, lifecycle) => {
      opts.lifecycle?.push({ event, ...lifecycle });
    },
  });
  fixture.manager = manager;
  return { manager, directory, env };
}

async function manager(opts: ScheduleFixtureOptions = {}): Promise<RuntimeScheduleManager> {
  return (await scheduleFixture(opts)).manager;
}

async function approve(m: RuntimeScheduleManager, cmd: ExecuteCommand, signal?: AbortSignal): Promise<unknown> {
  const tool = m.tools().find((candidate) => candidate.name === (cmd as Extract<ExecuteCommand, { type: "tool_call" }>).payload.tool_name);
  if (!tool) throw new Error("tool not found");
  return await tool.invoke({}, { command_id: cmd.id, upstream_commit_hash: "abc123", signal });
}

function evaluation(cmd: ExecuteCommand) {
  return evaluateApproval(cmd, [], { actor: "alice", now: 1, default_mode: "full_access" });
}

function preparePending(m: RuntimeScheduleManager, cmd: ExecuteCommand, result: ReturnType<typeof evaluation>,
  opts: Parameters<RuntimeScheduleManager["preparePending"]>[2]) {
  const scheduledMutation = cmd.type === "tool_call" &&
    (cmd.payload.tool_name === "schedule.create" || cmd.payload.tool_name === "schedule.update");
  return m.preparePending(cmd, result, {
    ...opts,
    ...(scheduledMutation && !opts.goal_version_binding ? { goal_version_binding: testGoalVersionBinding } : {}),
  });
}

describe("RuntimeScheduleManager", () => {
  it("rejects create and update when no current delegated purpose is supplied", async () => {
    const m = await manager();
    const create = command("schedule.create", { id: "purpose-required", channel: "webchat", target: "local-user",
      content: "synthetic content", interval_ms: 60_000 });
    const result = RuntimeScheduleManager.prototype.preparePending.call(m, create, evaluation(create), {
      request_id: "req-purpose-required", actor: "alice",
    });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("current delegated purpose binding") });
    expect(m.activeCronTasks()).toEqual([]);
    expect(m.pendingCount()).toBe(0);
  });

  it("stores schedules beneath the configured runtime state root by default", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-state-root-"));
    try {
      const m = await RuntimeScheduleManager.open({
        env: { BLUE_TANUKI_STATE_ROOT: stateRoot },
        now: () => 100,
      });
      const cmd = command("schedule.create", {
        id: "state-root-default",
        channel: "webchat",
        target: "local-user",
        content: "synthetic schedule content",
        interval_ms: 120000,
      });
      expect(preparePending(m, cmd, evaluation(cmd), { request_id: "req-state-root", actor: "alice" }).ok).toBe(true);
      await approve(m, cmd);

      expect(existsSync(join(stateRoot, "schedules", "runtime-schedules.json"))).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

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
    const prepared = preparePending(m, cmd, evaluation(cmd), { request_id: "req-1", actor: "alice" });
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
    expect(m.snapshot()[0]).not.toHaveProperty("time");
    expect(JSON.stringify(m.snapshot())).not.toContain("private runtime content");
    expect(m.activeCronTasks()[0]?.delegation).toMatchObject({ goal_version_binding: testGoalVersionBinding });
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "schedule.lifecycle.requested", operation: "create", approval_level: "L3_final_review" }),
      expect.objectContaining({ event: "schedule.lifecycle.approved", operation: "create", delegation: expect.objectContaining({ command_id: cmd.id, request_id: "req-1" }) }),
      expect.objectContaining({ event: "schedule.lifecycle.activated", operation: "create", delegation: expect.objectContaining({ command_id: cmd.id, request_id: "req-1" }) }),
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
    expect(preparePending(m, cmd, mismatched, { request_id: "req-review", actor: "alice" })).toMatchObject({ ok: false });

    const downgraded = { ...valid, approval_level: "L2_operate" as const };
    expect(preparePending(m, cmd, downgraded, { request_id: "req-review", actor: "alice" })).toMatchObject({ ok: false });
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
    const prepared = preparePending(m, cmd, evaluation(cmd), { request_id: "req-daily-zone", actor: "alice" });
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
    expect(preparePending(m, defaultZone, evaluation(defaultZone), { request_id: "req-daily-zone-default", actor: "alice" }).ok).toBe(true);
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
      expect(m.activeCount()).toBe(0);
      expect(m.snapshot()[0]).toMatchObject({ id: "legacy-daily", time: "07:00", status: "disabled", enabled: false });
      expect(m.activeCronTasks()).toEqual([]);
      const partialUpdate = command("schedule.update", { id: "legacy-daily", content: "new content" });
      expect(preparePending(m, partialUpdate, evaluation(partialUpdate), {
        request_id: "req-legacy-partial", actor: "alice",
      })).toMatchObject({ ok: false });
      const update = command("schedule.update", {
        id: "legacy-daily",
        expected_revision_digest: m.inspectUpdateTarget("legacy-daily")?.revision_digest,
        channel: "webchat",
        target: "local-user",
        content: "legacy content",
        time: "07:00",
        time_zone: "Asia/Tokyo",
      });
      expect(preparePending(m, update, evaluation(update), { request_id: "req-legacy-upgrade", actor: "alice" }).ok).toBe(true);
      await approve(m, update);
      expect(m.activeCount()).toBe(1);
      expect(m.activeCronTasks()[0]?.delegation).toMatchObject({
        command_id: update.id,
        request_id: "req-legacy-upgrade",
      });
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
    expect(preparePending(m, create, evaluation(create), { request_id: "req-1", actor: "alice" }).ok).toBe(true);
    await approve(m, create);

    const duplicate = command("schedule.create", {
      id: "dup",
      channel: "webchat",
      target: "local-user",
      content: "second",
      interval_ms: 120000,
    });
    expect(preparePending(m, duplicate, evaluation(duplicate), { request_id: "req-2", actor: "alice" })).toMatchObject({ ok: false });

    const update = command("schedule.update", { id: "dup", expected_revision_digest: m.inspectUpdateTarget("dup")?.revision_digest,
      content: "updated" });
    expect(preparePending(m, update, evaluation(update), { request_id: "req-3", actor: "alice" }).ok).toBe(true);
    const del = command("schedule.delete", { id: "dup" });
    expect(preparePending(m, del, evaluation(del), { request_id: "req-4", actor: "alice" })).toMatchObject({ ok: false });
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
    preparePending(m, create, evaluation(create), { request_id: "req-1", actor: "alice" });
    await approve(m, create);
    const oldHash = m.snapshot()[0]?.payload_hash;

    const update = command("schedule.update", { id: "updatable", expected_revision_digest: m.inspectUpdateTarget("updatable")?.revision_digest,
      content: "new" });
    expect(preparePending(m, update, evaluation(update), { request_id: "req-2", actor: "alice" }).ok).toBe(true);
    expect(m.activeCount()).toBe(1);
    expect(m.snapshot().find((s) => s.id === "updatable")?.payload_hash).toBe(oldHash);
    await approve(m, update);
    expect(m.snapshot().find((s) => s.id === "updatable")?.payload_hash).not.toBe(oldHash);

    const del = command("schedule.delete", { id: "updatable" });
    expect(preparePending(m, del, evaluation(del), { request_id: "req-3", actor: "alice" }).ok).toBe(true);
    expect(m.activeCount()).toBe(1);
    await approve(m, del);
    expect(m.activeCount()).toBe(0);
    expect(m.snapshot().find((s) => s.id === "updatable")?.status).toBe("deleted");
  });

  it("rejects a stale revision-bound update and exposes the current revision without schedule content", async () => {
    const m = await manager();
    const create = command("schedule.create", {
      id: "revision-bound",
      channel: "webchat",
      target: "local-user",
      content: "original private content",
      interval_ms: 120000,
    });
    expect(preparePending(m, create, evaluation(create), { request_id: "req-revision-create", actor: "alice" }).ok).toBe(true);
    await approve(m, create);

    const before = m.snapshot().find((schedule) => schedule.id === "revision-bound");
    expect(before?.revision_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(before)).not.toContain("original private content");

    const missingRevision = command("schedule.update", { id: "revision-bound", content: "unbound replacement" });
    expect(preparePending(m, missingRevision, evaluation(missingRevision), {
      request_id: "req-revision-missing", actor: "alice",
    })).toMatchObject({ ok: false, message: expect.stringContaining("current revision_digest") });

    const stale = command("schedule.update", {
      id: "revision-bound",
      expected_revision_digest: "0".repeat(64),
      content: "stale replacement",
    });
    expect(preparePending(m, stale, evaluation(stale), { request_id: "req-revision-stale", actor: "alice" }))
      .toMatchObject({ ok: false, message: expect.stringContaining("current revision_digest") });
    expect(m.snapshot().find((schedule) => schedule.id === "revision-bound")?.payload_hash).toBe(before?.payload_hash);

    const update = command("schedule.update", {
      id: "revision-bound",
      expected_revision_digest: before!.revision_digest,
      content: "approved replacement",
    });
    expect(preparePending(m, update, evaluation(update), { request_id: "req-revision-update", actor: "alice" }).ok).toBe(true);
    await approve(m, update);
    const after = m.snapshot().find((schedule) => schedule.id === "revision-bound");
    expect(after?.revision_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(after?.revision_digest).not.toBe(before?.revision_digest);
    expect(after?.payload_hash).not.toBe(before?.payload_hash);
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
    expect(preparePending(m, create, evaluation(create), { request_id: "req-trigger-create", actor: "alice" }).ok).toBe(true);
    await approve(m, create);
    expect(m.activeCronTasks()[0]).toMatchObject({ time: "07:15", interval_ms: undefined });

    const update = command("schedule.update", { id: "trigger-switch",
      expected_revision_digest: m.inspectUpdateTarget("trigger-switch")?.revision_digest, interval_ms: 60000 });
    expect(preparePending(m, update, evaluation(update), { request_id: "req-trigger-update", actor: "alice" }).ok).toBe(true);
    expect(m.activeCronTasks()[0]?.time).toBe("07:15");
    await approve(m, update);
    expect(m.activeCronTasks()[0]).toMatchObject({ time: undefined, interval_ms: 60000 });
  });

  it("reloads only exact persisted schedules and rejects an unknown state instead of activating it", async () => {
    const { manager: m, directory: dir, env } = await scheduleFixture();
    const create = command("schedule.create", {
      id: "reload-safe",
      channel: "webchat",
      target: "local-user",
      content: "scheduled content",
      interval_ms: 120000,
    });
    expect(preparePending(m, create, evaluation(create), { request_id: "req-reload", actor: "alice" }).ok).toBe(true);
    await approve(m, create);

    const reopened = await RuntimeScheduleManager.open({ env });
    expect(reopened.activeCount()).toBe(1);
    expect(reopened.activeCronTasks()).toMatchObject([{ id: "reload-safe", interval_ms: 120000 }]);

    const update = command("schedule.update", { id: "reload-safe",
      expected_revision_digest: reopened.inspectUpdateTarget("reload-safe")?.revision_digest, interval_ms: 60000 });
    expect(preparePending(reopened, update, evaluation(update), { request_id: "req-reload-update", actor: "alice" }).ok).toBe(true);
    await approve(reopened, update);
    const updated = await RuntimeScheduleManager.open({ env });
    expect(updated.activeCronTasks()).toMatchObject([{ id: "reload-safe", interval_ms: 60000 }]);

    const deletion = command("schedule.delete", { id: "reload-safe" });
    expect(preparePending(updated, deletion, evaluation(deletion), { request_id: "req-reload-delete", actor: "alice" }).ok).toBe(true);
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
  });

  it("does not activate an approved change when atomic persistence fails", async () => {
    const { manager: m, directory: dir } = await scheduleFixture();
    const cron = new CronSchedulerChannel({ tasks: [], log: () => undefined });
    m.attachScheduler(cron);
    const create = command("schedule.create", {
      id: "persist-before-fire",
      channel: "webchat",
      target: "local-user",
      content: "original content",
      interval_ms: 120000,
    });
    expect(preparePending(m, create, evaluation(create), { request_id: "req-persist-create", actor: "alice" }).ok).toBe(true);
    await approve(m, create);
    const oldHash = m.snapshot()[0]?.payload_hash;
    const store = join(dir, "runtime-schedules.json");
    renameSync(store, join(dir, "runtime-schedules.before-failure.json"));
    mkdirSync(store);

    const update = command("schedule.update", { id: "persist-before-fire",
      expected_revision_digest: m.inspectUpdateTarget("persist-before-fire")?.revision_digest, content: "uncommitted content" });
    expect(preparePending(m, update, evaluation(update), { request_id: "req-persist-update", actor: "alice" }).ok).toBe(true);
    await expect(approve(m, update)).rejects.toThrow();
    expect(m.activeCount()).toBe(1);
    expect(m.snapshot()[0]?.payload_hash).toBe(oldHash);
    expect(cron.snapshot()[0]?.payload_hash).toBe(oldHash);
  });

  it("keeps concurrent approved deletion and creation in both Cron and the reopened schedule store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const { manager: m, directory, env } = await scheduleFixture();
    const eventStore = new GatewayCronEventStore(join(directory, "cron-events.sqlite"));
    const cron = new CronSchedulerChannel({ tasks: [], event_store: eventStore, log: () => undefined });
    const received: unknown[] = [];
    m.attachScheduler(cron);
    try {
      await cron.start(async req => { received.push(req.metadata?.["blue_tanuki.cron.task_id"]); });
      const args = { channel: "webchat", target: "local-user", content: "synthetic schedule", interval_ms: 1000 };
      const original = command("schedule.create", { ...args, id: "old-schedule" });
      expect(preparePending(m, original, evaluation(original), { request_id: "initial-approval", actor: "alice" }).ok).toBe(true);
      await approve(m, original);
      expect(cron.snapshot().map(item => item.id)).toEqual(["old-schedule"]);

      const deletion = command("schedule.delete", { id: "old-schedule" });
      const creation = command("schedule.create", { ...args, id: "new-schedule" });
      expect(preparePending(m, deletion, evaluation(deletion), { request_id: "delete-approval", actor: "alice" }).ok).toBe(true);
      expect(preparePending(m, creation, evaluation(creation), { request_id: "create-approval", actor: "alice" }).ok).toBe(true);
      const [deleted, created] = await Promise.all([approve(m, deletion), approve(m, creation)]);
      expect(deleted).toMatchObject({ schedule_id: "old-schedule", status: "deleted", can_fire: false });
      expect(created).toMatchObject({ schedule_id: "new-schedule", status: "active", can_fire: true });

      const reopened = await RuntimeScheduleManager.open({ env });
      expect(reopened.snapshot()).toEqual(m.snapshot());
      expect(reopened.snapshot()).toMatchObject([
        { id: "new-schedule", status: "active", enabled: true },
        { id: "old-schedule", status: "deleted", enabled: false },
      ]);
      expect(reopened.activeCronTasks().map(item => item.id)).toEqual(["new-schedule"]);
      expect(cron.snapshot().map(item => item.id)).toEqual(["new-schedule"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toEqual(["new-schedule"]);
    } finally {
      await cron.stop();
      eventStore.close();
      vi.useRealTimers();
    }
  });

  it("reserves the same schedule through the approved update's final rename", async () => {
    let beforeCommit: (() => void) | undefined;
    let boundaries = 0;
    const { manager: m, env } = await scheduleFixture({ beforePersist(kind) {
      if (kind === "approve" && beforeCommit && ++boundaries === 2) beforeCommit();
    } });
    const create = command("schedule.create", {
      id: "reserved-id", channel: "webchat", target: "local-user", content: "previous content", interval_ms: 1000,
    });
    expect(preparePending(m, create, evaluation(create), { request_id: "initial-approval", actor: "alice" }).ok).toBe(true);
    await approve(m, create);
    const update = command("schedule.update", { id: "reserved-id",
      expected_revision_digest: m.inspectUpdateTarget("reserved-id")?.revision_digest, content: "updated content" });
    const competing = command("schedule.delete", { id: "reserved-id" });
    expect(preparePending(m, update, evaluation(update), { request_id: "update-approval", actor: "alice" }).ok).toBe(true);
    let admitted: boolean | undefined;
    beforeCommit = () => {
      admitted = preparePending(m, competing, evaluation(competing), { request_id: "competing-approval", actor: "alice" }).ok;
    };
    await approve(m, update);
    expect(admitted).toBe(false);
    expect(m.activeCronTasks()).toMatchObject([{ id: "reserved-id", content: "updated content" }]);
    const reopened = await RuntimeScheduleManager.open({ env });
    expect(reopened.activeCronTasks()).toEqual(m.activeCronTasks());
    expect(preparePending(m, competing, evaluation(competing), { request_id: "competing-approval", actor: "alice" }).ok).toBe(true);
  });

  it("persists a rejected create without discarding a distinct successful approval", async () => {
    const { manager: m, env } = await scheduleFixture();
    const args = { channel: "webchat", target: "local-user", content: "synthetic schedule", interval_ms: 1000 };
    const approved = command("schedule.create", { ...args, id: "approved-schedule" });
    const rejected = command("schedule.create", { ...args, id: "rejected-schedule" });
    expect(preparePending(m, approved, evaluation(approved), { request_id: "create-approval", actor: "alice" }).ok).toBe(true);
    expect(preparePending(m, rejected, evaluation(rejected), { request_id: "rejected-approval", actor: "alice" }).ok).toBe(true);
    const applying = approve(m, approved);
    expect(m.rejectPending(rejected.id, "alice", "owner declined")).not.toBeNull();
    await applying;
    await m.drain();
    const reopened = await RuntimeScheduleManager.open({ env });
    expect(reopened.snapshot()).toEqual(m.snapshot());
    expect(reopened.snapshot()).toMatchObject([
      { id: "approved-schedule", status: "active", enabled: true },
      { id: "rejected-schedule", status: "rejected", enabled: false },
    ]);
    expect(reopened.activeCronTasks().map(item => item.id)).toEqual(["approved-schedule"]);
  });

  it("leaves disk and attached Cron unchanged on an abort before rename and accepts a fresh approval afterward", async () => {
    const controller = new AbortController();
    let abortBeforeRename = false;
    let boundaries = 0;
    const { manager: m, directory, env } = await scheduleFixture({ beforePersist(kind) {
      if (kind === "approve" && abortBeforeRename && ++boundaries === 2) controller.abort();
    } });
    const cron = new CronSchedulerChannel({ tasks: [], log: () => undefined });
    m.attachScheduler(cron);
    const create = command("schedule.create", {
      id: "abort-target", channel: "webchat", target: "local-user", content: "previous content", interval_ms: 1000,
    });
    expect(preparePending(m, create, evaluation(create), { request_id: "initial-approval", actor: "alice" }).ok).toBe(true);
    await approve(m, create);
    const path = join(directory, "runtime-schedules.json");
    const before = readFileSync(path);
    const cronBefore = cron.snapshot();
    const update = command("schedule.update", { id: "abort-target",
      expected_revision_digest: m.inspectUpdateTarget("abort-target")?.revision_digest, content: "uncommitted content" });
    expect(preparePending(m, update, evaluation(update), { request_id: "update-approval", actor: "alice" }).ok).toBe(true);
    abortBeforeRename = true;
    await expect(approve(m, update, controller.signal)).rejects.toThrow(/abort|cancel/iu);
    await m.drain();
    expect(boundaries).toBe(2);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(directory)).toEqual(["runtime-schedules.json"]);
    expect(cron.snapshot()).toEqual(cronBefore);
    expect((await RuntimeScheduleManager.open({ env })).activeCronTasks()).toEqual(m.activeCronTasks());

    abortBeforeRename = false;
    const retry = command("schedule.update", { id: "abort-target",
      expected_revision_digest: m.inspectUpdateTarget("abort-target")?.revision_digest, content: "freshly approved content" });
    expect(preparePending(m, retry, evaluation(retry), { request_id: "fresh-approval", actor: "alice" }).ok).toBe(true);
    await approve(m, retry);
    expect((await RuntimeScheduleManager.open({ env })).activeCronTasks()).toMatchObject([
      { id: "abort-target", content: "freshly approved content" },
    ]);
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
      const prepared = preparePending(m, cmd, evaluation(cmd), { request_id: "req-invalid", actor: "alice" });
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
    expect(preparePending(m, cmd, evaluation(cmd), { request_id: "req-timeout", actor: "alice" }).ok).toBe(true);
    now = 12;
    expect(m.pendingCount()).toBe(0);
    expect(m.activeCount()).toBe(0);
    await expect(approve(m, cmd)).rejects.toThrow(/approval missing or expired/);
    await m.drain();
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "schedule.lifecycle.rejected", operation: "create" }),
    ]));
  });

  it("fires approved runtime schedules through the cron lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 9, 6, 30, 0, 0));
    const received: unknown[] = [];
    const m = await manager();
    const root = mkdtempSync(join(tmpdir(), "bt-runtime-schedules-cron-lane-"));
    const eventStore = new GatewayCronEventStore(join(root, "cron-events.sqlite"));
    const cron = new CronSchedulerChannel({ tasks: [], event_store: eventStore, log: () => undefined });
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
      preparePending(m, cmd, evaluation(cmd), { request_id: "req-fire", actor: "alice" });
      await approve(m, cmd);
      await vi.advanceTimersByTimeAsync(1000);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "cron",
        metadata: {
          "blue_tanuki.cron.task_id": "runtime-fire",
          "blue_tanuki.cron.origin": "runtime",
          "blue_tanuki.channel_send.content": "runtime hello",
          "blue_tanuki.cron.delegation.command_id": cmd.id,
          "blue_tanuki.cron.delegation.request_id": "req-fire",
          "blue_tanuki.cron.delegation.goal_id_digest": testGoalVersionBinding.goal_id_digest,
          "blue_tanuki.cron.delegation.purpose_version": testGoalVersionBinding.purpose_version,
          "blue_tanuki.cron.delegation.purpose_digest": testGoalVersionBinding.purpose_digest,
        },
      });
    } finally {
      await cron.stop();
      eventStore.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});

