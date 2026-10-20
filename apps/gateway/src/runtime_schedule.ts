import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Tool } from "@blue-tanuki/core";
import { runtimeScheduleScopeDigest, type ApprovalEvaluation, type RuntimeScheduleDelegation } from "@blue-tanuki/hds-brain";
import { requireToolOperationDescriptor, type ExecuteCommand } from "@blue-tanuki/protocol";
import {
  canonicalizeCronTimeZone,
  cronPayloadHash,
  systemCronTimeZone,
  type CronSchedulerChannel,
  type CronTaskOptions,
} from "./cron_channel.js";

type Env = Record<string, string | undefined>;
type RuntimeScheduleOperation = "create" | "update" | "delete";

export interface RuntimeSchedule {
  id: string;
  origin: "runtime";
  enabled: boolean;
  channel: string;
  target: string;
  content: string;
  time?: string;
  time_zone?: string;
  interval_ms?: number;
  created_at_ms: number;
  updated_at_ms: number;
  payload_hash: string;
  delegation?: RuntimeScheduleDelegation;
  status: "pending" | "active" | "disabled" | "deleted" | "rejected";
}

export interface RuntimeScheduleSnapshot {
  id: string;
  origin: "runtime";
  enabled: boolean;
  channel: string;
  target: string;
  time: string;
  time_zone?: string;
  interval_ms?: number;
  created_at_ms: number;
  updated_at_ms: number;
  payload_hash: string;
  status: RuntimeSchedule["status"];
  pending_operation?: RuntimeScheduleOperation;
  pending_command_id?: string;
  approval_expires_at_ms?: number;
}

export interface RuntimeScheduleLifecycle {
  schedule_id: string;
  origin: "runtime";
  operation: RuntimeScheduleOperation | "list" | "fire";
  actor: string;
  approval_level?: ApprovalEvaluation["approval_level"];
  risk?: ApprovalEvaluation["risk"];
  payload_hash?: string;
  previous_payload_hash?: string;
  command_id?: string;
  request_id?: string | null;
  delegation?: RuntimeScheduleDelegation;
}

interface PendingRuntimeScheduleOperation {
  command_id: string;
  request_id: string | null;
  actor: string;
  operation: RuntimeScheduleOperation;
  schedule_id: string;
  proposed: RuntimeSchedule;
  previous?: RuntimeSchedule;
  approval_level: ApprovalEvaluation["approval_level"];
  risk: ApprovalEvaluation["risk"];
  expires_at_ms: number;
}

export interface RuntimeScheduleManagerOptions {
  env?: Env;
  now?: () => number;
  onLifecycle?: (
    event:
      | "schedule.lifecycle.requested"
      | "schedule.lifecycle.approved"
      | "schedule.lifecycle.rejected"
      | "schedule.lifecycle.activated"
      | "schedule.lifecycle.updated"
      | "schedule.lifecycle.deleted",
    lifecycle: RuntimeScheduleLifecycle,
  ) => void;
}

export class RuntimeScheduleManager {
  private readonly schedules = new Map<string, RuntimeSchedule>();
  private readonly pending = new Map<string, PendingRuntimeScheduleOperation>();
  private readonly pendingBySchedule = new Map<string, string>();
  private scheduler: CronSchedulerChannel | null = null;
  private readonly now: () => number;
  private readonly file: string;
  private readonly approvalTimeoutMs: number;
  private readonly onLifecycle?: RuntimeScheduleManagerOptions["onLifecycle"];

  private constructor(
    file: string,
    schedules: readonly RuntimeSchedule[],
    opts: Required<Pick<RuntimeScheduleManagerOptions, "now">> & Pick<RuntimeScheduleManagerOptions, "onLifecycle"> & { approvalTimeoutMs: number },
  ) {
    this.file = file;
    this.now = opts.now;
    this.onLifecycle = opts.onLifecycle;
    this.approvalTimeoutMs = opts.approvalTimeoutMs;
    for (const schedule of schedules) {
      this.schedules.set(schedule.id, schedule);
    }
  }

  static async open(opts: RuntimeScheduleManagerOptions = {}): Promise<RuntimeScheduleManager> {
    const env = opts.env ?? process.env;
    const dir = path.resolve(env.BLUE_TANUKI_SCHEDULES_DIR ?? ".blue-tanuki/schedules");
    const file = path.join(dir, "runtime-schedules.json");
    const approvalTimeoutMs = positiveEnvInt(env.BLUE_TANUKI_SCHEDULE_APPROVAL_TIMEOUT_MS, 86_400_000);
    const schedules = await readSchedulesFile(file);
    return new RuntimeScheduleManager(file, schedules, {
      now: opts.now ?? (() => Date.now()),
      onLifecycle: opts.onLifecycle,
      approvalTimeoutMs,
    });
  }

  attachScheduler(scheduler: CronSchedulerChannel): void {
    this.scheduler = scheduler;
  }

  activeCronTasks(): CronTaskOptions[] {
    return Array.from(this.schedules.values())
      .filter((schedule) => schedule.status === "active" && schedule.enabled && schedule.delegation !== undefined)
      .map((schedule) => this.toCronTask(schedule));
  }

  tools(): Tool[] {
    return [
      {
        name: "schedule.list",
        description: "List runtime schedules without exposing schedule content.",
        required_capabilities: requireToolOperationDescriptor("schedule.list").required_capabilities,
        invoke: async () => this.list(),
      },
      {
        name: "schedule.create",
        description: "Activate a previously approved runtime schedule create request. Daily time schedules bind an IANA time_zone; omitted values capture the host local zone.",
        required_capabilities: requireToolOperationDescriptor("schedule.create").required_capabilities,
        invoke: async (_args, ctx) => this.approvePending(ctx.command_id),
      },
      {
        name: "schedule.update",
        description: "Activate a previously approved runtime schedule update request. Daily time schedules bind an IANA time_zone; omitted values capture the host local zone.",
        required_capabilities: requireToolOperationDescriptor("schedule.update").required_capabilities,
        invoke: async (_args, ctx) => this.approvePending(ctx.command_id),
      },
      {
        name: "schedule.delete",
        description: "Activate a previously approved runtime schedule delete request.",
        required_capabilities: requireToolOperationDescriptor("schedule.delete").required_capabilities,
        invoke: async (_args, ctx) => this.approvePending(ctx.command_id),
      },
    ];
  }

  list(): { schedules: RuntimeScheduleSnapshot[]; pending_count: number } {
    this.pruneExpiredPending("system");
    const snapshots = Array.from(this.schedules.values()).map((schedule) => this.scheduleSnapshot(schedule));
    for (const op of this.pending.values()) {
      if (!this.schedules.has(op.schedule_id)) snapshots.push(this.scheduleSnapshot(op.proposed, op));
    }
    return {
      schedules: snapshots.sort((a, b) => a.id.localeCompare(b.id)),
      pending_count: this.pending.size,
    };
  }

  snapshot(): RuntimeScheduleSnapshot[] {
    return this.list().schedules;
  }

  activeCount(): number {
    return Array.from(this.schedules.values()).filter((schedule) =>
      schedule.status === "active" && schedule.enabled && schedule.delegation !== undefined).length;
  }

  pendingCount(): number {
    this.pruneExpiredPending("system");
    return this.pending.size;
  }

  hasPending(command_id: string): boolean {
    this.pruneExpiredPending("system");
    return this.pending.has(command_id);
  }

  preparePending(
    command: ExecuteCommand,
    evaluation: ApprovalEvaluation,
    opts: { request_id?: string | null; actor?: string },
  ): { ok: true; pending: PendingRuntimeScheduleOperation } | { ok: false; message: string } {
    this.pruneExpiredPending(opts.actor ?? evaluation.context.actor);
    if (command.type !== "tool_call") {
      return { ok: false, message: "schedule operation rejected: command is not a tool_call; nothing was activated; retry with tool:schedule.*" };
    }
    const tool = command.payload.tool_name;
    if (tool !== "schedule.create" && tool !== "schedule.update" && tool !== "schedule.delete") {
      return { ok: false, message: "schedule operation rejected: unsupported schedule tool; nothing was activated; retry with schedule.create/update/delete" };
    }
    const expectedOperation = tool;
    const actor = opts.actor?.trim() || evaluation.context.actor;
    if (
      evaluation.decision !== "ask" ||
      evaluation.context.command_id !== command.id ||
      evaluation.context.operation !== expectedOperation ||
      evaluation.context.command_type !== "tool_call" ||
      evaluation.context.actor !== actor ||
      evaluation.context.risk !== "high" ||
      evaluation.risk !== "high" ||
      evaluation.approval_level !== "L3_final_review" ||
      !evaluation.final_review_required ||
      typeof opts.request_id !== "string" || opts.request_id.trim().length === 0
    ) {
      return {
        ok: false,
        message: "schedule operation rejected: a fresh L3 final-review evaluation bound to this command and request is required; activated=false can_fire=false next_action=Submit a new schedule request for owner review.",
      };
    }

    try {
      const pending = this.buildPending(tool, command, evaluation, opts);
      this.pending.set(command.id, pending);
      this.pendingBySchedule.set(pending.schedule_id, command.id);
      this.onLifecycle?.("schedule.lifecycle.requested", lifecycleFromPending(pending));
      return { ok: true, pending };
    } catch (e) {
      const pending = this.pending.get(command.id);
      if (pending) {
        this.pending.delete(command.id);
        if (this.pendingBySchedule.get(pending.schedule_id) === command.id) {
          this.pendingBySchedule.delete(pending.schedule_id);
        }
      }
      return {
        ok: false,
        message: scheduleErrorMessage(e instanceof Error ? e.message : String(e)),
      };
    }
  }

  rejectPending(command_id: string, actor: string, _reason: string): PendingRuntimeScheduleOperation | null {
    const pending = this.pending.get(command_id);
    if (!pending) return null;
    this.pending.delete(command_id);
    this.pendingBySchedule.delete(pending.schedule_id);
    if (pending.operation === "create") {
      const rejected: RuntimeSchedule = {
        ...pending.proposed,
        enabled: false,
        status: "rejected",
        updated_at_ms: this.now(),
      };
      this.schedules.set(rejected.id, rejected);
      this.persistSoon();
    }
    this.onLifecycle?.("schedule.lifecycle.rejected", {
      ...lifecycleFromPending(pending),
      actor,
      operation: pending.operation,
      command_id,
    });
    return pending;
  }

  private async approvePending(command_id: string): Promise<unknown> {
    this.pruneExpiredPending("system");
    const pending = this.pending.get(command_id);
    if (!pending) {
      throw new Error("schedule approval missing or expired; nothing was activated; submit the schedule request again and approve the new command_id");
    }
    this.pending.delete(command_id);
    this.pendingBySchedule.delete(pending.schedule_id);

    if (pending.operation === "delete") {
      const previous = pending.previous;
      if (!previous || previous.status !== "active") {
        throw new Error("schedule.delete target is no longer active; nothing was deleted; run tool:schedule.list and retry");
      }
      this.onLifecycle?.("schedule.lifecycle.approved", lifecycleFromPending(pending));
      const deleted: RuntimeSchedule = {
        ...previous,
        enabled: false,
        status: "deleted",
        updated_at_ms: this.now(),
      };
      const nextSchedules = new Map(this.schedules);
      nextSchedules.set(deleted.id, deleted);
      await this.persist(nextSchedules.values());
      this.schedules.set(deleted.id, deleted);
      this.scheduler?.removeTask(deleted.id);
      this.onLifecycle?.("schedule.lifecycle.deleted", lifecycleFromPending(pending));
      return {
        schedule_id: deleted.id,
        status: "deleted",
        active: false,
        can_fire: false,
        next_action: "No further action is needed. Recreate the schedule if it should run again.",
      };
    }

    const activated: RuntimeSchedule = {
      ...pending.proposed,
      status: "active",
      enabled: true,
      updated_at_ms: this.now(),
    };
    this.onLifecycle?.("schedule.lifecycle.approved", lifecycleFromPending(pending));
    const nextSchedules = new Map(this.schedules);
    nextSchedules.set(activated.id, activated);
    await this.persist(nextSchedules.values());
    this.schedules.set(activated.id, activated);
    this.onLifecycle?.(
      pending.operation === "create" ? "schedule.lifecycle.activated" : "schedule.lifecycle.updated",
      lifecycleFromPending(pending),
    );
    const schedulerSnapshot = this.scheduler?.upsertTask(this.toCronTask(activated));
    return {
      schedule_id: activated.id,
      status: "active",
      operation: pending.operation,
      payload_hash: activated.payload_hash,
      next_fire_at_ms: schedulerSnapshot?.next_fire_at_ms ?? null,
      can_fire: true,
      next_action: "Use tool:schedule.list to inspect safe metadata, or tool:schedule.delete id=<id> to request removal.",
    };
  }

  private buildPending(
    tool: "schedule.create" | "schedule.update" | "schedule.delete",
    command: Extract<ExecuteCommand, { type: "tool_call" }>,
    evaluation: ApprovalEvaluation,
    opts: { request_id?: string | null; actor?: string },
  ): PendingRuntimeScheduleOperation {
    const now = this.now();
    const actor = opts.actor ?? evaluation.context.actor;
    const operation: RuntimeScheduleOperation = tool === "schedule.create" ? "create" : tool === "schedule.update" ? "update" : "delete";
    const args = command.payload.arguments;
    const id = operation === "create"
      ? optionalId(args.id) ?? `runtime-${now}-${randomUUID().slice(0, 8)}`
      : requiredId(args.id, "id");
    if (this.pendingBySchedule.has(id)) {
      throw new Error(`schedule ${id} already has a pending ${this.pending.get(this.pendingBySchedule.get(id)!)?.operation ?? "operation"}; nothing was activated`);
    }

    const previous = this.schedules.get(id);
    if (operation === "create") {
      if (previous && previous.status === "active") throw new Error(`schedule ${id} is already active; nothing was activated`);
      const schedule = buildScheduleFromArgs(id, args, now, undefined);
      return this.pendingFromSchedule(command, evaluation, operation, schedule, previous, opts.request_id ?? null, actor);
    }
    if (!previous || previous.status !== "active") {
      throw new Error(`schedule ${id} is not active; nothing was changed`);
    }
    if (operation === "delete") {
      const proposed: RuntimeSchedule = {
        ...previous,
        enabled: false,
        status: "pending",
        updated_at_ms: now,
      };
      return this.pendingFromSchedule(command, evaluation, operation, proposed, previous, opts.request_id ?? null, actor);
    }
    if (!previous.delegation) {
      const hasFullScope = ["channel", "target", "content"].every((key) =>
        typeof args[key] === "string" && (args[key] as string).trim().length > 0);
      const hasTime = args.time !== undefined && args.time !== null;
      const hasInterval = args.interval_ms !== undefined && args.interval_ms !== null;
      if (!hasFullScope || hasTime === hasInterval || (hasTime && typeof args.time_zone !== "string")) {
        throw new Error("legacy schedule has no durable approved scope; repeat channel, target, content and exactly one trigger (include time_zone for daily schedules) before requesting update");
      }
    }
    const schedule = buildScheduleFromArgs(id, args, now, previous);
    return this.pendingFromSchedule(command, evaluation, operation, schedule, previous, opts.request_id ?? null, actor);
  }

  private pendingFromSchedule(
    command: ExecuteCommand,
    evaluation: ApprovalEvaluation,
    operation: RuntimeScheduleOperation,
    schedule: RuntimeSchedule,
    previous: RuntimeSchedule | undefined,
    request_id: string | null,
    actor: string,
  ): PendingRuntimeScheduleOperation {
    let proposed = schedule;
    if (operation !== "delete") {
      if (typeof request_id !== "string" || !request_id.trim()) {
        throw new Error("schedule mutation requires a request id before delegation can be recorded");
      }
      const delegation: RuntimeScheduleDelegation = {
        command_id: command.id,
        request_id,
        scope_digest: runtimeScheduleScopeDigest({
          schedule_id: schedule.id,
          channel: schedule.channel,
          target: schedule.target,
          content: schedule.content,
          payload_hash: schedule.payload_hash,
        }),
      };
      proposed = { ...schedule, delegation };
    }
    return {
      command_id: command.id,
      request_id,
      actor,
      operation,
      schedule_id: schedule.id,
      proposed,
      previous,
      approval_level: evaluation.approval_level,
      risk: evaluation.risk,
      expires_at_ms: this.now() + this.approvalTimeoutMs,
    };
  }

  private toCronTask(schedule: RuntimeSchedule): CronTaskOptions {
    return {
      id: schedule.id,
      name: "scheduled_message",
      origin: "runtime",
      enabled: schedule.enabled && schedule.status === "active",
      channel: schedule.channel,
      target: schedule.target,
      content: schedule.content,
      time: schedule.time,
      time_zone: schedule.time_zone,
      interval_ms: schedule.interval_ms,
      payload_hash: schedule.payload_hash,
      delegation: schedule.delegation,
    };
  }

  private scheduleSnapshot(schedule: RuntimeSchedule, pending?: PendingRuntimeScheduleOperation): RuntimeScheduleSnapshot {
    const op = pending ?? this.pending.get(this.pendingBySchedule.get(schedule.id) ?? "");
    const legacyUnbound = schedule.status === "active" && schedule.delegation === undefined;
    return {
      id: schedule.id,
      origin: "runtime",
      enabled: legacyUnbound ? false : schedule.enabled,
      channel: schedule.channel,
      target: schedule.target,
      time: schedule.time ?? "07:00",
      time_zone: schedule.time_zone,
      interval_ms: schedule.interval_ms,
      created_at_ms: schedule.created_at_ms,
      updated_at_ms: schedule.updated_at_ms,
      payload_hash: schedule.payload_hash,
      status: op ? "pending" : legacyUnbound ? "disabled" : schedule.status,
      pending_operation: op?.operation,
      pending_command_id: op?.command_id,
      approval_expires_at_ms: op?.expires_at_ms,
    };
  }

  private pruneExpiredPending(actor: string): void {
    const now = this.now();
    for (const pending of Array.from(this.pending.values())) {
      if (pending.expires_at_ms <= now) {
        this.rejectPending(pending.command_id, actor, "schedule approval timed out");
      }
    }
  }

  private async persist(schedules: Iterable<RuntimeSchedule> = this.schedules.values()): Promise<void> {
    const records = Array.from(schedules).sort((a, b) => a.id.localeCompare(b.id));
    const directory = path.dirname(this.file);
    const temporary = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true });
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.file);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private persistSoon(): void {
    void this.persist().catch(() => undefined);
  }
}

function buildScheduleFromArgs(
  id: string,
  args: Record<string, unknown>,
  now: number,
  previous: RuntimeSchedule | undefined,
): RuntimeSchedule {
  const channel = stringArg(args, "channel", previous?.channel);
  const target = stringArg(args, "target", previous?.target);
  const content = stringArg(args, "content", previous?.content);
  const time = optionalTime(args.time, previous?.time);
  const interval_ms = optionalInterval(args.interval_ms, previous?.interval_ms);
  const requestedTimeZone = optionalTimeZone(args.time_zone, previous?.time_zone);
  const timeWasProvided = args.time !== undefined;
  const intervalWasProvided = args.interval_ms !== undefined;
  const selectedTime = timeWasProvided && args.time !== null ? time :
    intervalWasProvided && args.interval_ms !== null && !timeWasProvided ? undefined : time;
  const selectedInterval = intervalWasProvided && args.interval_ms !== null ? interval_ms :
    timeWasProvided && args.time !== null && !intervalWasProvided ? undefined : interval_ms;
  if ((selectedTime === undefined) === (selectedInterval === undefined)) {
    throw new Error("schedule requires exactly one trigger: time=HH:MM or interval_ms; nothing was activated");
  }
  if (selectedTime === undefined && args.time_zone !== undefined && args.time_zone !== null) {
    throw new Error("time_zone applies only to daily time schedules; nothing was activated");
  }
  const time_zone = selectedTime === undefined ? undefined : requestedTimeZone ?? systemCronTimeZone();
  return {
    id,
    origin: "runtime",
    enabled: true,
    channel,
    target,
    content,
    time: selectedTime,
    time_zone,
    interval_ms: selectedInterval,
    created_at_ms: previous?.created_at_ms ?? now,
    updated_at_ms: now,
    payload_hash: cronPayloadHash({ channel, target, content, time: selectedTime, time_zone, interval_ms: selectedInterval }),
    status: "pending",
  };
}

function lifecycleFromPending(pending: PendingRuntimeScheduleOperation): RuntimeScheduleLifecycle {
  return {
    schedule_id: pending.schedule_id,
    origin: "runtime",
    operation: pending.operation,
    actor: pending.actor,
    approval_level: pending.approval_level,
    risk: pending.risk,
    payload_hash: pending.proposed.payload_hash,
    previous_payload_hash: pending.previous?.payload_hash,
    command_id: pending.command_id,
    request_id: pending.request_id,
    ...(pending.operation !== "delete" && pending.proposed.delegation
      ? { delegation: pending.proposed.delegation }
      : {}),
  };
}

function scheduleErrorMessage(reason: string): string {
  return [
    `[schedule-rejected] ${reason}`,
    "activated=false",
    "can_fire=false",
    "next_action=Run tool:schedule.list, fix the schedule request, and submit it again for approval.",
  ].join(" ");
}

async function readSchedulesFile(file: string): Promise<RuntimeSchedule[]> {
  const raw = await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "[]";
    throw e;
  });
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("runtime schedule store must contain an array");
  const schedules = parsed.map(parseStoredSchedule);
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) throw new Error("runtime schedule store contains a duplicate id");
    ids.add(schedule.id);
  }
  return schedules;
}

function parseStoredSchedule(value: unknown): RuntimeSchedule {
  if (!isRecord(value)) throw new Error("runtime schedule store entry must be an object");
  const id = requiredId(value.id, "id");
  if (id !== value.id) throw new Error("runtime schedule store id is not canonical");
  if (value.origin !== undefined && value.origin !== "runtime") throw new Error("runtime schedule store origin is invalid");
  const channel = requiredString(value.channel, "channel");
  const target = requiredString(value.target, "target");
  const content = requiredString(value.content, "content");
  const time = optionalTime(value.time, undefined);
  const time_zone = optionalTimeZone(value.time_zone, undefined);
  const interval_ms = optionalInterval(value.interval_ms, undefined);
  const status = runtimeStatus(value.status);
  if (typeof value.enabled !== "boolean" || value.enabled !== (status === "active")) {
    throw new Error("runtime schedule store enabled/status state is inconsistent");
  }
  if ((time === undefined) === (interval_ms === undefined)) {
    throw new Error("runtime schedule store must contain exactly one trigger");
  }
  if (time === undefined && time_zone !== undefined) {
    throw new Error("runtime schedule store time_zone requires a daily time trigger");
  }
  const created_at_ms = storedTimestamp(value.created_at_ms, "created_at_ms");
  const updated_at_ms = storedTimestamp(value.updated_at_ms, "updated_at_ms");
  const expectedPayloadHash = cronPayloadHash({ channel, target, content, time, time_zone, interval_ms });
  if (typeof value.payload_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.payload_hash) || value.payload_hash !== expectedPayloadHash) {
    throw new Error("runtime schedule store payload hash does not match its trigger content");
  }
  const delegation = value.delegation === undefined ? undefined : parseRuntimeScheduleDelegation(value.delegation);
  if (delegation && delegation.scope_digest !== runtimeScheduleScopeDigest({
    schedule_id: id,
    channel,
    target,
    content,
    payload_hash: value.payload_hash,
  })) throw new Error("runtime schedule store delegation does not match its persisted scope");
  return {
    id,
    origin: "runtime",
    enabled: value.enabled,
    channel,
    target,
    content,
    time,
    time_zone,
    interval_ms,
    created_at_ms,
    updated_at_ms,
    payload_hash: value.payload_hash,
    ...(delegation ? { delegation } : {}),
    status,
  };
}

function parseRuntimeScheduleDelegation(value: unknown): RuntimeScheduleDelegation {
  if (!isRecord(value) || typeof value.command_id !== "string" || !value.command_id.trim() ||
      typeof value.request_id !== "string" || !value.request_id.trim() ||
      typeof value.scope_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.scope_digest)) {
    throw new Error("runtime schedule store delegation is invalid");
  }
  return {
    command_id: value.command_id,
    request_id: value.request_id,
    scope_digest: value.scope_digest,
  };
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredId(value, "id");
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.trim())) {
    throw new Error(`${label} must match /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/`);
  }
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalTime(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(\d{1,2}):(\d{2})$/.test(value)) {
    throw new Error("time must use HH:MM local time");
  }
  const [, hh, mm] = /^(\d{1,2}):(\d{2})$/.exec(value)!;
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("time must use HH:MM local time");
  }
  return value;
}

function optionalInterval(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("interval_ms must be a positive integer no greater than 2147483647");
  }
  return value;
}

function optionalTimeZone(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback;
  if (value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("time_zone must be a valid IANA time zone when set");
  }
  return canonicalizeCronTimeZone(value);
}

function runtimeStatus(value: unknown): RuntimeSchedule["status"] {
  if (value === "pending" || value === "active" || value === "disabled" || value === "deleted" || value === "rejected") return value;
  throw new Error("runtime schedule store status is invalid");
}

function positiveEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function storedTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`runtime schedule store ${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runtimeScheduleCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && (
    command.payload.tool_name === "schedule.list" ||
    command.payload.tool_name === "schedule.create" ||
    command.payload.tool_name === "schedule.update" ||
    command.payload.tool_name === "schedule.delete"
  );
}

export function runtimeScheduleMutationCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && (
    command.payload.tool_name === "schedule.create" ||
    command.payload.tool_name === "schedule.update" ||
    command.payload.tool_name === "schedule.delete"
  );
}
