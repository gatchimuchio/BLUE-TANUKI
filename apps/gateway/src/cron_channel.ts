import { createHash, randomUUID } from "node:crypto";
import {
  createGatewayInternalInboundRequest,
  metadataKeyReservedForInternalAuthority,
  type GatewayInternalAuthorityMetadata,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import type { InboundChannel, InboundHandler } from "@blue-tanuki/channel-base";

export interface CronTaskOptions {
  id: string;
  name?: "daily_brief" | "scheduled_message";
  origin?: "boot" | "runtime";
  enabled?: boolean;
  channel: string;
  target: string;
  content: string;
  /** HH:MM local time. Default 07:00. */
  time?: string;
  /** For tests or smoke. If set, triggers every N ms instead of daily. */
  interval_ms?: number;
  payload_hash?: string;
}

export interface CronSchedulerOptions {
  tasks: CronTaskOptions[];
  log?: (line: string) => void;
  now?: () => Date;
  onFire?: (task: CronTaskSnapshot) => void;
  content_provider?: CronContentProvider;
}

export interface DailyBriefCronOptions {
  enabled?: boolean;
  channel: string;
  target: string;
  content: string;
  /** HH:MM local time. Default 07:00. */
  time?: string;
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
  interval_ms?: number;
  payload_hash: string;
  next_fire_at_ms: number | null;
  last_fire_at_ms: number | null;
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
  interval_ms?: number;
  payload_hash: string;
}

interface CronTaskRuntime {
  task: NormalizedCronTask;
  timer: NodeJS.Timeout | null;
  running: boolean;
  nextFireAtMs: number | null;
  lastFireAtMs: number | null;
}

/**
 * Runtime cron source.
 *
 * It emits internal cron InboundRequests. HDS-BRAIN still owns authority:
 * a cron request must pass cron.process and becomes a channel_send only via
 * the trusted gateway-internal metadata marker.
 */
export class CronSchedulerChannel implements InboundChannel {
  readonly name = "cron";
  private started = false;
  private readonly runtimes = new Map<string, CronTaskRuntime>();
  private readonly logLine?: (line: string) => void;
  private readonly nowFn?: () => Date;
  private handler: InboundHandler | null = null;
  private readonly onFire?: (task: CronTaskSnapshot) => void;
  private readonly contentProvider?: CronContentProvider;

  constructor(opts: CronSchedulerOptions) {
    this.logLine = opts.log;
    this.nowFn = opts.now;
    this.onFire = opts.onFire;
    this.contentProvider = opts.content_provider;
    for (const task of normalizeCronTasks(opts.tasks)) {
      this.runtimes.set(task.id, createRuntime(task));
    }
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.handler = handler;

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
      interval_ms: runtime.task.interval_ms,
      payload_hash: runtime.task.payload_hash,
      next_fire_at_ms: runtime.nextFireAtMs,
      last_fire_at_ms: runtime.lastFireAtMs,
    }));
  }

  upsertTask(task: CronTaskOptions): CronTaskSnapshot {
    const [normalized] = normalizeCronTasks([task]);
    if (!normalized) throw new Error("cron upsertTask received no task");
    const existing = this.runtimes.get(normalized.id);
    if (existing) this.stopRuntime(existing);
    const runtime = createRuntime(normalized);
    this.runtimes.set(normalized.id, runtime);
    if (this.started && normalized.enabled && this.handler) {
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
      runtime.nextFireAtMs = this.nowMs() + task.interval_ms;
      runtime.timer = setInterval(() => {
        runtime.nextFireAtMs = this.nowMs() + task.interval_ms!;
        void this.fire(runtime, handler);
      }, task.interval_ms);
      runtime.timer.unref?.();
      this.log(`[cron] task interval enabled id=${task.id} interval_ms=${task.interval_ms}`);
      return;
    }
    this.scheduleNextDaily(runtime, handler);
  }

  private scheduleNextDaily(runtime: CronTaskRuntime, handler: InboundHandler): void {
    const task = runtime.task;
    const now = this.now();
    const delay = delayUntilLocalTime(task.time, now);
    runtime.nextFireAtMs = now.getTime() + delay;
    runtime.timer = setTimeout(() => {
      void this.fire(runtime, handler).finally(() => {
        if (this.started && task.enabled) this.scheduleNextDaily(runtime, handler);
      });
    }, delay);
    runtime.timer.unref?.();
    this.log(`[cron] task scheduled id=${task.id} time=${task.time} delay_ms=${delay}`);
  }

  private async fire(runtime: CronTaskRuntime, handler: InboundHandler): Promise<void> {
    const task = runtime.task;
    runtime.lastFireAtMs = this.nowMs();
    const resolved = await this.resolveContent(task);
    const resolvedMetadata = safeCronProviderMetadata(resolved.metadata ?? {});
    const payloadHash = cronPayloadHash({ ...task, content: resolved.content });
    this.onFire?.(this.snapshotForRuntime(runtime, payloadHash));
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
      "blue_tanuki.cron.content_source": resolvedMetadata["blue_tanuki.cron.content_source"] ?? "static",
      "blue_tanuki.channel_send.channel": task.channel,
      "blue_tanuki.channel_send.target": task.target,
      "blue_tanuki.channel_send.content": resolved.content,
    };
    const inbound: InboundRequest = createGatewayInternalInboundRequest({
      id: randomUUID(),
      channel: "cron",
      user: "blue-tanuki-cron",
      content: resolved.content,
      timestamp: runtime.lastFireAtMs,
      metadata,
    });
    this.log(`[cron] firing task id=${task.id} channel=${task.channel} target=${task.target}`);
    await handler(inbound);
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

  private async resolveContent(task: NormalizedCronTask): Promise<CronContentProviderResult> {
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
      interval_ms: runtime.task.interval_ms,
      payload_hash: payloadHash ?? runtime.task.payload_hash,
      next_fire_at_ms: runtime.nextFireAtMs,
      last_fire_at_ms: runtime.lastFireAtMs,
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
    return {
      id,
      name: task.name ?? "scheduled_message",
      origin: task.origin ?? "boot",
      enabled: task.enabled !== false,
      channel: requireTrimmed(task.channel, `cron task ${id} channel`),
      target: requireTrimmed(task.target, `cron task ${id} target`),
      content: requireTrimmed(task.content, `cron task ${id} content`),
      time,
      interval_ms: task.interval_ms,
      payload_hash: task.payload_hash ?? cronPayloadHash(task),
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
  };
}

export function cronPayloadHash(task: Pick<CronTaskOptions, "channel" | "target" | "content" | "time" | "interval_ms">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      channel: task.channel,
      target: task.target,
      content: task.content,
      time: task.time ?? "07:00",
      interval_ms: task.interval_ms,
    }))
    .digest("hex");
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
