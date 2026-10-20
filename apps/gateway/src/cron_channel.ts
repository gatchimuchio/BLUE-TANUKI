import { createHash } from "node:crypto";
import {
  createGatewayInternalInboundRequest,
  metadataKeyReservedForInternalAuthority,
  type GatewayInternalAuthorityMetadata,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import type { InboundChannel, InboundHandler } from "@blue-tanuki/channel-base";
import type { RuntimeScheduleDelegation } from "@blue-tanuki/hds-brain";
import {
  createCronEventIdentity,
  type CronEventIdentity,
  type GatewayCronEventStore,
} from "./cron_event_store.js";

export interface CronTaskOptions {
  id: string;
  name?: "daily_brief" | "scheduled_message";
  origin?: "boot" | "runtime";
  enabled?: boolean;
  channel: string;
  target: string;
  content: string;
  /** HH:MM wall-clock time. Default 07:00. */
  time?: string;
  /** IANA time zone for daily schedules. Omitted boot schedules follow the host local zone. */
  time_zone?: string;
  /** For tests or smoke. If set, triggers every N ms instead of daily. */
  interval_ms?: number;
  payload_hash?: string;
  delegation?: RuntimeScheduleDelegation;
}

export interface CronSchedulerOptions {
  tasks: CronTaskOptions[];
  log?: (line: string) => void;
  now?: () => Date;
  onFire?: (task: CronTaskSnapshot, event: CronEventIdentity, delegation?: RuntimeScheduleDelegation) => void;
  content_provider?: CronContentProvider;
  event_store?: GatewayCronEventStore;
}

export interface DailyBriefCronOptions {
  enabled?: boolean;
  channel: string;
  target: string;
  content: string;
  /** HH:MM wall-clock time. Default 07:00. */
  time?: string;
  /** IANA time zone for daily schedules. Omitted values follow the host local zone. */
  time_zone?: string;
  /** For tests or smoke. If set, triggers every N ms instead of daily. */
  interval_ms?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface CronTaskSnapshot {
  id: string;
  name: "daily_brief" | "scheduled_message";
  origin: "boot" | "runtime";
  enabled: boolean;
  running: boolean;
  channel: string;
  target: string;
  time: string;
  time_zone?: string;
  interval_ms?: number;
  payload_hash: string;
  next_fire_at_ms: number | null;
  last_fire_at_ms: number | null;
  recovery_hold: "restore_observation_unverified" | null;
}

export function cronRestoreObservationRequiresHold(observation: {
  readonly operation: string | null;
  readonly store_key: string | null;
  readonly status: string;
  readonly store_ledger_status: string | null;
  readonly store_ledger_residual_count: number | null;
  readonly used_for_authority: false;
  readonly may_execute: false;
}): boolean {
  if (observation.operation !== "restore") return false;
  if (observation.store_key === null) return observation.status === "unverified";
  if (observation.store_key !== "cron_events") return false;
  return observation.status !== "matched" || observation.store_ledger_status !== "verified" ||
    observation.store_ledger_residual_count !== 0 || observation.used_for_authority || observation.may_execute;
}

export type DailyBriefCronSnapshot = CronTaskSnapshot;

export interface CronContentProviderTask {
  id: string;
  name: "daily_brief" | "scheduled_message";
  origin: "boot" | "runtime";
  channel: string;
  target: string;
  content: string;
  time: string;
  time_zone?: string;
  interval_ms?: number;
}

export interface CronContentProviderResult {
  content: string;
  metadata?: Record<string, string>;
}

export type CronContentProvider = (
  task: CronContentProviderTask,
) => Promise<CronContentProviderResult | string | null | undefined>;

interface NormalizedCronTask {
  id: string;
  name: "daily_brief" | "scheduled_message";
  origin: "boot" | "runtime";
  enabled: boolean;
  channel: string;
  target: string;
  content: string;
  time: string;
  time_zone?: string;
  interval_ms?: number;
  payload_hash: string;
  delegation?: RuntimeScheduleDelegation;
}

interface CronTaskRuntime {
  task: NormalizedCronTask;
  timer: NodeJS.Timeout | null;
  running: boolean;
  nextFireAtMs: number | null;
  lastFireAtMs: number | null;
  scheduledTimeZone: string | null;
}

const DAILY_CLOCK_RECHECK_MS = 60_000;

/**
 * Runtime cron source.
 *
 * It emits internal cron InboundRequests. HDS-BRAIN still owns authority:
 * runtime schedules carry their approved scope reference and become channel_send
 * only after J verifies the durable L3 delegation; boot schedules retain their
 * existing trusted internal route.
 */
export class CronSchedulerChannel implements InboundChannel {
  readonly name = "cron";
  private started = false;
  private readonly runtimes = new Map<string, CronTaskRuntime>();
  private readonly pendingBySource = new Map<string, Promise<void>>();
  private readonly pendingFires = new Set<Promise<void>>();
  private readonly inFlightEventIds = new Set<string>();
  private readonly logLine?: (line: string) => void;
  private readonly nowFn?: () => Date;
  private handler: InboundHandler | null = null;
  private readonly onFire?: (task: CronTaskSnapshot, event: CronEventIdentity, delegation?: RuntimeScheduleDelegation) => void;
  private readonly contentProvider?: CronContentProvider;
  private readonly eventStore?: GatewayCronEventStore;
  private recoveryHold: CronTaskSnapshot["recovery_hold"] = null;
  private recoveryRestorePause: { readonly handler: InboundHandler | null } | null = null;
  private recoveryRestoreQuiescing = false;

  constructor(opts: CronSchedulerOptions) {
    this.logLine = opts.log;
    this.nowFn = opts.now;
    this.onFire = opts.onFire;
    this.contentProvider = opts.content_provider;
    this.eventStore = opts.event_store;
    for (const task of normalizeCronTasks(opts.tasks)) {
      this.runtimes.set(task.id, createRuntime(task));
    }
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.handler = handler;

    if (this.recoveryHold) {
      this.log("[cron] scheduler held because canonical restore observation is not clean");
      return;
    }

    let active = 0;
    for (const runtime of this.runtimes.values()) {
      if (!runtime.task.enabled) {
        this.log(`[cron] task disabled id=${runtime.task.id}`);
        continue;
      }
      active += 1;
      this.scheduleTask(runtime, handler);
    }
    if (active === 0) this.log("[cron] no enabled scheduled tasks");
  }

  async stop(): Promise<void> {
    for (const runtime of this.runtimes.values()) this.stopRuntime(runtime);
    this.started = false;
    this.handler = null;
    while (this.pendingFires.size > 0) await Promise.all(Array.from(this.pendingFires));
  }

  async quiesceForRecoveryRestore(): Promise<boolean> {
    if (this.recoveryRestorePause || this.recoveryRestoreQuiescing) return false;
    this.recoveryRestoreQuiescing = true;
    const handler = this.handler;
    try {
      await this.stop();
      this.recoveryRestorePause = { handler };
      return true;
    } finally {
      this.recoveryRestoreQuiescing = false;
    }
  }

  async resumeAfterRecoveryRestore(options: {
    readonly restore_attempted: boolean;
    readonly observation_verified: boolean;
  }): Promise<void> {
    const pause = this.recoveryRestorePause;
    if (!pause) throw new Error("cron_recovery_restore_not_quiesced");
    if (options.restore_attempted && !options.observation_verified) {
      this.holdForUnverifiedRestoreObservation();
    } else if (options.restore_attempted && options.observation_verified &&
        this.recoveryHold === "restore_observation_unverified") {
      this.recoveryHold = null;
    }
    this.recoveryRestorePause = null;
    if (pause.handler) await this.start(pause.handler);
  }

  holdForUnverifiedRestoreObservation(): void {
    if (this.started) throw new Error("cron recovery hold must be set before scheduler start");
    this.recoveryHold = "restore_observation_unverified";
  }

  snapshot(): CronTaskSnapshot[] {
    return Array.from(this.runtimes.values()).map((runtime) => ({
      id: runtime.task.id,
      name: runtime.task.name,
      origin: runtime.task.origin,
      enabled: runtime.task.enabled,
      running: runtime.running,
      channel: runtime.task.channel,
      target: runtime.task.target,
      time: runtime.task.time,
      time_zone: runtime.scheduledTimeZone ?? runtime.task.time_zone,
      interval_ms: runtime.task.interval_ms,
      payload_hash: runtime.task.payload_hash,
      next_fire_at_ms: runtime.nextFireAtMs,
      last_fire_at_ms: runtime.lastFireAtMs,
      recovery_hold: this.recoveryHold,
    }));
  }

  isEventInFlight(event_id: string): boolean {
    return this.inFlightEventIds.has(event_id);
  }

  upsertTask(task: CronTaskOptions): CronTaskSnapshot {
    const [normalized] = normalizeCronTasks([task]);
    if (!normalized) throw new Error("cron upsertTask received no task");
    const existing = this.runtimes.get(normalized.id);
    if (existing) this.stopRuntime(existing);
    const runtime = createRuntime(normalized);
    this.runtimes.set(normalized.id, runtime);
    if (this.started && !this.recoveryHold && normalized.enabled && this.handler) {
      this.scheduleTask(runtime, this.handler);
    }
    return this.snapshotForRuntime(runtime);
  }

  removeTask(id: string): boolean {
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;
    this.stopRuntime(runtime);
    this.runtimes.delete(id);
    return true;
  }

  private scheduleTask(runtime: CronTaskRuntime, handler: InboundHandler): void {
    const task = runtime.task;
    runtime.running = true;
    if (task.interval_ms && task.interval_ms > 0) {
      const source = `cron:${task.origin}:${task.id}`;
      const lastScheduledAt = this.eventStore?.latestSequenceForSource(source) ?? null;
      runtime.lastFireAtMs = lastScheduledAt;
      runtime.nextFireAtMs = nextIntervalFireAtMs(this.nowMs(), task.interval_ms, lastScheduledAt);
      this.scheduleNextInterval(runtime, handler);
      this.log(`[cron] task interval enabled id=${task.id} interval_ms=${task.interval_ms}`);
      return;
    }
    const source = `cron:${task.origin}:${task.id}`;
    runtime.lastFireAtMs = this.eventStore?.latestSequenceForSource(source) ?? null;
    this.scheduleNextDaily(runtime, handler);
  }

  private scheduleNextInterval(runtime: CronTaskRuntime, handler: InboundHandler): void {
    const intervalMs = runtime.task.interval_ms;
    const scheduledAtMs = runtime.nextFireAtMs;
    if (!intervalMs || scheduledAtMs === null || !this.started || !runtime.running ||
        this.runtimes.get(runtime.task.id) !== runtime) return;
    const delay = Math.max(0, scheduledAtMs - this.nowMs());
    runtime.timer = setTimeout(() => {
      if (!this.started || !runtime.running || this.runtimes.get(runtime.task.id) !== runtime) return;
      const nowMs = this.nowMs();
      const actualScheduledAtMs = scheduledAtMs + Math.floor(Math.max(0, nowMs - scheduledAtMs) / intervalMs) * intervalMs;
      runtime.lastFireAtMs = actualScheduledAtMs;
      runtime.nextFireAtMs = actualScheduledAtMs + intervalMs;
      void this.enqueueFire(runtime, handler, actualScheduledAtMs);
      this.scheduleNextInterval(runtime, handler);
    }, delay);
    runtime.timer.unref?.();
  }

  private scheduleNextDaily(runtime: CronTaskRuntime, handler: InboundHandler): void {
    const task = runtime.task;
    if (!this.started || !runtime.running || this.runtimes.get(task.id) !== runtime) return;
    const nowMs = this.nowMs();
    const timeZone = task.time_zone ?? systemCronTimeZone();
    const scheduledAtMs = nextDailyFireAtMs(nowMs, task.time, timeZone, runtime.lastFireAtMs);
    runtime.scheduledTimeZone = timeZone;
    runtime.nextFireAtMs = scheduledAtMs;
    const delay = Math.max(0, Math.min(DAILY_CLOCK_RECHECK_MS, scheduledAtMs - nowMs));
    runtime.timer = setTimeout(() => {
      if (!this.started || !runtime.running || !task.enabled || this.runtimes.get(task.id) !== runtime) return;
      const firedAtMs = this.nowMs();
      const currentTimeZone = task.time_zone ?? systemCronTimeZone();
      const targetAtMs = runtime.nextFireAtMs;
      if (currentTimeZone !== runtime.scheduledTimeZone || targetAtMs === null || firedAtMs < targetAtMs) {
        // Re-evaluate wall time after clock changes, early timer wakeups, or suspend/resume.
        this.scheduleNextDaily(runtime, handler);
        return;
      }
      runtime.timer = null;
      runtime.lastFireAtMs = targetAtMs;
      this.enqueueFire(runtime, handler, targetAtMs).finally(() => {
        if (this.started && runtime.running && task.enabled && this.runtimes.get(task.id) === runtime) {
          this.scheduleNextDaily(runtime, handler);
        }
      });
    }, delay);
    runtime.timer.unref?.();
    this.log(`[cron] task scheduled id=${task.id} time=${task.time} time_zone=${timeZone} delay_ms=${delay}`);
  }

  private enqueueFire(runtime: CronTaskRuntime, handler: InboundHandler, scheduledAtMs: number): Promise<void> {
    const source = `cron:${runtime.task.origin}:${runtime.task.id}`;
    const queued = (this.pendingBySource.get(source) ?? Promise.resolve())
      .then(() => this.fire(runtime, handler, scheduledAtMs))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`[cron] dispatch failed id=${runtime.task.id} reason=${truncateMetadata(reason)}`);
      });
    this.pendingBySource.set(source, queued);
    this.pendingFires.add(queued);
    void queued.then(() => {
      this.pendingFires.delete(queued);
      if (this.pendingBySource.get(source) === queued) this.pendingBySource.delete(source);
    });
    return queued;
  }

  private async fire(runtime: CronTaskRuntime, handler: InboundHandler, scheduledAtMs: number): Promise<void> {
    const task = runtime.task;
    runtime.lastFireAtMs = scheduledAtMs;
    const resolved = await this.resolveContent(task, runtime.scheduledTimeZone ?? task.time_zone);
    const resolvedMetadata = safeCronProviderMetadata(resolved.metadata ?? {});
    const payloadHash = cronPayloadHash({ ...task, content: resolved.content });
    const event = createCronEventIdentity(`cron:${task.origin}:${task.id}`, scheduledAtMs, payloadHash);
    const claim = this.eventStore?.claim(event) ?? { status: "accepted" as const };
    if (claim.status !== "accepted") {
      this.log(`[cron] event not dispatched id=${task.id} status=${claim.status}${claim.status === "duplicate" || claim.status === "blocked_unresolved" ? ` delivery_state=${claim.delivery_state}` : ""}`);
      return;
    }
    this.inFlightEventIds.add(event.event_id);
    try {
      try {
        this.onFire?.(this.snapshotForRuntime(runtime, payloadHash), event, task.delegation);
      } catch (error) {
        this.eventStore?.settle(event, "outcome_unknown");
        throw error;
      }
      const metadata: GatewayInternalAuthorityMetadata = {
        ...resolvedMetadata,
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "cron",
        "blue_tanuki.trust_level": "trusted",
        "blue_tanuki.process_kind": "cron",
        ...(task.name === "daily_brief" ? { "blue_tanuki.operator_surface": "daily" as const } : {}),
        "blue_tanuki.cron.task_id": task.id,
        "blue_tanuki.cron.origin": task.origin,
        "blue_tanuki.cron.payload_hash": payloadHash,
        ...(task.delegation ? {
          "blue_tanuki.cron.delegation.command_id": task.delegation.command_id,
          "blue_tanuki.cron.delegation.request_id": task.delegation.request_id,
          "blue_tanuki.cron.delegation.scope_digest": task.delegation.scope_digest,
        } : {}),
        "blue_tanuki.cron.event_source": event.source,
        "blue_tanuki.cron.event_id": event.event_id,
        "blue_tanuki.cron.event_sequence": String(event.sequence),
        "blue_tanuki.cron.content_source": resolvedMetadata["blue_tanuki.cron.content_source"] ?? "static",
        "blue_tanuki.channel_send.channel": task.channel,
        "blue_tanuki.channel_send.target": task.target,
        "blue_tanuki.channel_send.content": resolved.content,
      };
      const inbound: InboundRequest = createGatewayInternalInboundRequest({
        id: event.event_id,
        channel: "cron",
        user: "blue-tanuki-cron",
        content: resolved.content,
        timestamp: runtime.lastFireAtMs,
        metadata,
      });
      this.log(`[cron] firing task id=${task.id} channel=${task.channel} target=${task.target}`);
      try {
        await handler(inbound);
        this.eventStore?.settle(event, "handler_returned");
      } catch (error) {
        this.eventStore?.settle(event, "outcome_unknown");
        throw error;
      }
    } finally {
      this.inFlightEventIds.delete(event.event_id);
    }
  }

  private log(line: string): void {
    (this.logLine ?? console.log)(line);
  }

  private now(): Date {
    return this.nowFn?.() ?? new Date();
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  private async resolveContent(task: NormalizedCronTask, timeZone?: string): Promise<CronContentProviderResult> {
    if (!this.contentProvider) {
      return { content: task.content, metadata: { "blue_tanuki.cron.content_source": "static" } };
    }
    try {
      const resolved = await this.contentProvider({
        id: task.id,
        name: task.name,
        origin: task.origin,
        channel: task.channel,
        target: task.target,
        content: task.content,
        time: task.time,
        time_zone: timeZone,
        interval_ms: task.interval_ms,
      });
      if (resolved === null || resolved === undefined) {
        return { content: task.content, metadata: { "blue_tanuki.cron.content_source": "static" } };
      }
      if (typeof resolved === "string") {
        return {
          content: requireTrimmed(resolved, `cron task ${task.id} resolved content`),
          metadata: { "blue_tanuki.cron.content_source": "dynamic" },
        };
      }
      return {
        content: requireTrimmed(resolved.content, `cron task ${task.id} resolved content`),
        metadata: {
          "blue_tanuki.cron.content_source": "dynamic",
          ...(resolved.metadata ?? {}),
        },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[cron] content provider failed id=${task.id} reason=${truncateMetadata(message)}`);
      const label = task.name === "daily_brief" ? "Daily Brief" : "Scheduled message";
      return {
        content: `${label}: source unavailable; reason=${truncateMetadata(message)}; mutation_sent=false; safe_to_ignore=false`,
        metadata: {
          "blue_tanuki.cron.content_source": "provider_error",
        },
      };
    }
  }

  private stopRuntime(runtime: CronTaskRuntime): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    runtime.running = false;
    runtime.nextFireAtMs = null;
  }

  private snapshotForRuntime(runtime: CronTaskRuntime, payloadHash?: string): CronTaskSnapshot {
    return {
      id: runtime.task.id,
      name: runtime.task.name,
      origin: runtime.task.origin,
      enabled: runtime.task.enabled,
      running: runtime.running,
      channel: runtime.task.channel,
      target: runtime.task.target,
      time: runtime.task.time,
      time_zone: runtime.scheduledTimeZone ?? runtime.task.time_zone,
      interval_ms: runtime.task.interval_ms,
      payload_hash: payloadHash ?? runtime.task.payload_hash,
      next_fire_at_ms: runtime.nextFireAtMs,
      last_fire_at_ms: runtime.lastFireAtMs,
      recovery_hold: this.recoveryHold,
    };
  }
}

function safeCronProviderMetadata(metadata: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (metadataKeyReservedForInternalAuthority(key)) continue;
    safe[key.normalize("NFKC").trim()] = value.normalize("NFKC");
  }
  return safe;
}

export class DailyBriefCronChannel implements InboundChannel {
  readonly name = "cron";
  private readonly scheduler: CronSchedulerChannel;

  constructor(private readonly opts: DailyBriefCronOptions) {
    this.scheduler = new CronSchedulerChannel({
      tasks: [dailyBriefTaskFromOptions(opts)],
      log: opts.log,
      now: opts.now,
    });
  }

  async start(handler: InboundHandler): Promise<void> {
    await this.scheduler.start(handler);
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
  }

  snapshot(): DailyBriefCronSnapshot {
    const [snapshot] = this.scheduler.snapshot();
    if (!snapshot) throw new Error("daily brief scheduler has no task");
    return snapshot;
  }
}

export function dailyBriefCronFromEnv(env: Record<string, string | undefined> = process.env): DailyBriefCronOptions | null {
  const enabled = env.BLUE_TANUKI_DAILY_BRIEF_ENABLED === "1" || env.BLUE_TANUKI_DAILY_BRIEF_ENABLED === "true";
  if (!enabled) return null;
  const channel = env.BLUE_TANUKI_DAILY_BRIEF_CHANNEL ?? "telegram";
  const target = env.BLUE_TANUKI_DAILY_BRIEF_TARGET;
  if (!target) throw new Error("BLUE_TANUKI_DAILY_BRIEF_TARGET is required when daily brief is enabled");
  return {
    enabled,
    channel,
    target,
    content: env.BLUE_TANUKI_DAILY_BRIEF_CONTENT ?? "Daily Brief: scheduled smoke from BLUE-TANUKI v1.0 RC.",
    time: env.BLUE_TANUKI_DAILY_BRIEF_TIME ?? "07:00",
    time_zone: env.BLUE_TANUKI_DAILY_BRIEF_TIME_ZONE,
    interval_ms: parsePositiveInt(env.BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS),
  };
}

export function cronSchedulesFromEnv(env: Record<string, string | undefined> = process.env): CronTaskOptions[] {
  const tasks: CronTaskOptions[] = [];
  const daily = dailyBriefCronFromEnv(env);
  if (daily) tasks.push(dailyBriefTaskFromOptions(daily));

  const raw = env.BLUE_TANUKI_SCHEDULES_JSON?.trim();
  if (raw) {
    const parsed = parseSchedulesJson(raw);
    tasks.push(...parsed);
  }

  return normalizeCronTasks(tasks);
}

function dailyBriefTaskFromOptions(opts: DailyBriefCronOptions): CronTaskOptions {
  return {
    id: "daily_brief",
    name: "daily_brief",
    enabled: opts.enabled,
    channel: opts.channel,
    target: opts.target,
    content: opts.content,
    time: opts.time ?? "07:00",
    time_zone: opts.time_zone,
    interval_ms: opts.interval_ms,
  };
}

function parseSchedulesJson(raw: string): CronTaskOptions[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`BLUE_TANUKI_SCHEDULES_JSON must be valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("BLUE_TANUKI_SCHEDULES_JSON must be an array");
  }
  return parsed.map((item, index) => parseScheduleObject(item, index));
}

function parseScheduleObject(item: unknown, index: number): CronTaskOptions {
  if (!isRecord(item)) {
    throw new Error(`BLUE_TANUKI_SCHEDULES_JSON[${index}] must be an object`);
  }
  return {
    id: requiredString(item.id, `BLUE_TANUKI_SCHEDULES_JSON[${index}].id`),
    name: "scheduled_message",
    enabled: optionalBoolean(item.enabled, `BLUE_TANUKI_SCHEDULES_JSON[${index}].enabled`),
    channel: requiredString(item.channel, `BLUE_TANUKI_SCHEDULES_JSON[${index}].channel`),
    target: requiredString(item.target, `BLUE_TANUKI_SCHEDULES_JSON[${index}].target`),
    content: requiredString(item.content, `BLUE_TANUKI_SCHEDULES_JSON[${index}].content`),
    time: optionalString(item.time, `BLUE_TANUKI_SCHEDULES_JSON[${index}].time`),
    time_zone: optionalString(item.time_zone, `BLUE_TANUKI_SCHEDULES_JSON[${index}].time_zone`),
    interval_ms: optionalPositiveInteger(item.interval_ms, `BLUE_TANUKI_SCHEDULES_JSON[${index}].interval_ms`),
  };
}

function normalizeCronTasks(tasks: CronTaskOptions[]): NormalizedCronTask[] {
  const seen = new Set<string>();
  return tasks.map((task, index) => {
    const id = requireTrimmed(task.id, `cron task ${index} id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) {
      throw new Error(`cron task id '${id}' must match /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/`);
    }
    if (seen.has(id)) throw new Error(`duplicate cron task id: ${id}`);
    seen.add(id);
    const time = task.time ?? "07:00";
    parseLocalTime(time);
    const timeZone = task.time_zone === undefined ? undefined : canonicalizeCronTimeZone(task.time_zone);
    if (task.interval_ms !== undefined && timeZone !== undefined) {
      throw new Error(`cron task ${id} cannot set time_zone for an interval schedule`);
    }
    return {
      id,
      name: task.name ?? "scheduled_message",
      origin: task.origin ?? "boot",
      enabled: task.enabled !== false,
      channel: requireTrimmed(task.channel, `cron task ${id} channel`),
      target: requireTrimmed(task.target, `cron task ${id} target`),
      content: requireTrimmed(task.content, `cron task ${id} content`),
      time,
      time_zone: timeZone,
      interval_ms: task.interval_ms,
      payload_hash: task.payload_hash ?? cronPayloadHash(task),
      delegation: task.delegation,
    };
  });
}

function createRuntime(task: NormalizedCronTask): CronTaskRuntime {
  return {
    task,
    timer: null,
    running: false,
    nextFireAtMs: null,
    lastFireAtMs: null,
    scheduledTimeZone: null,
  };
}

export function cronPayloadHash(task: Pick<CronTaskOptions, "channel" | "target" | "content" | "time" | "interval_ms" | "time_zone">): string {
  const payload: Record<string, unknown> = {
    channel: task.channel,
    target: task.target,
    content: task.content,
    time: task.time ?? "07:00",
    interval_ms: task.interval_ms,
  };
  // Preserve hashes of schedules written before timezone was added.
  if (task.time_zone !== undefined) payload.time_zone = canonicalizeCronTimeZone(task.time_zone);
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function canonicalizeCronTimeZone(timeZone: string): string {
  const normalized = timeZone.trim();
  if (!normalized) throw new Error("time_zone must be a valid IANA time zone");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error("time_zone must be a valid IANA time zone");
  }
}

export function systemCronTimeZone(): string {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) throw new Error("host local time zone could not be determined");
  return canonicalizeCronTimeZone(timeZone);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when set`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean when set`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer when set`);
  }
  return Number(value);
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  return trimmed;
}

function truncateMetadata(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseLocalTime(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid scheduled time: ${hhmm}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`invalid scheduled time: ${hhmm}`);
  return { hour, minute };
}

export function delayUntilLocalTime(hhmm: string, now: Date): number {
  const { hour, minute } = parseLocalTime(hhmm);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Returns the next daily wall-clock occurrence. Missed occurrences are skipped;
 * overlap dates use their first instant and gaps move forward by the gap size.
 */
export function nextDailyFireAtMs(
  nowMs: number,
  hhmm: string,
  timeZone: string,
  lastScheduledAtMs: number | null,
): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
      (lastScheduledAtMs !== null && (!Number.isSafeInteger(lastScheduledAtMs) || lastScheduledAtMs < 0))) {
    throw new Error("invalid cron daily schedule state");
  }
  const zone = canonicalizeCronTimeZone(timeZone);
  const { hour, minute } = parseLocalTime(hhmm);
  const cutoff = Math.max(nowMs, lastScheduledAtMs ?? nowMs);
  const localNow = wallPartsAt(cutoff, zone);
  let date = { year: localNow.year, month: localNow.month, day: localNow.day };
  for (let attempt = 0; attempt < 370; attempt += 1) {
    const occurrence = dailyOccurrenceForDate(date, hour, minute, zone);
    if (occurrence > cutoff) return occurrence;
    date = addCivilDays(date, 1);
  }
  throw new Error("could not find the next daily cron occurrence");
}

interface WallDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function wallPartsAt(timestampMs: number, timeZone: string): WallDateTime {
  let formatter = timeZoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    timeZoneFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function wallTimestamp(value: WallDateTime): number {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second, 0);
  return date.getTime();
}

function wallDateTimestamp(year: number, month: number, day: number, hour: number, minute: number): number {
  return wallTimestamp({ year, month, day, hour, minute, second: 0 });
}

function addCivilDays(date: Pick<WallDateTime, "year" | "month" | "day">, days: number): Pick<WallDateTime, "year" | "month" | "day"> {
  const next = new Date(0);
  next.setUTCFullYear(date.year, date.month - 1, date.day + days);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function dailyOccurrenceForDate(
  date: Pick<WallDateTime, "year" | "month" | "day">,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const targetWall = wallDateTimestamp(date.year, date.month, date.day, hour, minute);
  const offsets = new Set<number>();
  for (const offsetHours of [-48, -36, -24, -12, -6, 0, 6, 12, 24, 36, 48]) {
    offsets.add(timeZoneOffsetAt(targetWall + offsetHours * 60 * 60 * 1000, timeZone));
  }
  const exact: number[] = [];
  const afterGap: Array<{ instant: number; wall: number }> = [];
  for (const offset of offsets) {
    const instant = targetWall - offset;
    const actualWall = wallTimestamp(wallPartsAt(instant, timeZone));
    if (actualWall === targetWall) exact.push(instant);
    else if (actualWall > targetWall) afterGap.push({ instant, wall: actualWall });
  }
  if (exact.length > 0) return Math.min(...exact);
  afterGap.sort((a, b) => a.wall - b.wall || a.instant - b.instant);
  const shifted = afterGap[0]?.instant;
  if (shifted !== undefined) return shifted;
  throw new Error("could not resolve daily cron time in its IANA time zone");
}

function timeZoneOffsetAt(timestampMs: number, timeZone: string): number {
  const wall = wallPartsAt(timestampMs, timeZone);
  return wallTimestamp(wall) - Math.floor(timestampMs / 1000) * 1000;
}

/** Keeps a persisted interval cadence across restarts while skipping missed ticks. */
export function nextIntervalFireAtMs(nowMs: number, intervalMs: number, lastScheduledAtMs: number | null): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 ||
      (lastScheduledAtMs !== null && (!Number.isSafeInteger(lastScheduledAtMs) || lastScheduledAtMs < 0))) {
    throw new Error("invalid cron interval schedule state");
  }
  const firstAfterLast = (lastScheduledAtMs ?? nowMs) + intervalMs;
  if (!Number.isSafeInteger(firstAfterLast)) throw new Error("cron interval schedule exceeds safe timestamp range");
  if (firstAfterLast > nowMs) return firstAfterLast;
  const skippedTicks = Math.floor((nowMs - firstAfterLast) / intervalMs) + 1;
  const next = firstAfterLast + skippedTicks * intervalMs;
  if (!Number.isSafeInteger(next)) throw new Error("cron interval schedule exceeds safe timestamp range");
  return next;
}
