import { createHash } from "node:crypto";
import {
  createGatewayInternalInboundRequest,
  runtimeSchedulePayloadHash,
  type GatewayInternalAuthorityMetadata,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import type { InboundChannel, InboundHandler } from "@blue-tanuki/channel-base";
import type { RuntimeScheduleDelegation } from "@blue-tanuki/hds-brain";
import {
  createCronEventIdentity,
  GOOGLE_DAILY_BRIEF_DUE_SOURCE,
  type CronEventIdentity,
  type CronLocalAcquisitionDue,
  type GatewayCronEventStore,
} from "./cron_event_store.js";
import type { CronEventResultReceipt } from "./cron_event_result_receipt.js";
import { googleDailyBriefSourceConfigured, parseGoogleServices } from "./google_daily_brief.js";

type CronContentSourceHold = "google_authorized_acquisition_not_wired";

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
  /** Stable schedule-version digest for the durable occurrence claim. */
  payload_hash?: string;
  /** Durable creation time used to detect an initial missed occurrence after restart. */
  created_at_ms?: number;
  delegation?: RuntimeScheduleDelegation;
  content_source_hold?: CronContentSourceHold;
  google_service_scope_digest?: string;
}

export interface CronSchedulerOptions {
  tasks: CronTaskOptions[];
  log?: (line: string) => void;
  now?: () => Date;
  onFire?: (task: CronTaskSnapshot, event: CronEventIdentity, delegation?: RuntimeScheduleDelegation) => void;
  onHandlerReturned?: (event: CronEventIdentity) => CronEventResultReceipt;
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
  content_source_hold?: CronContentSourceHold;
  google_service_scope_digest?: string;
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
  catch_up_hold?: {
    readonly reason: "catch_up_policy_unresolved";
    readonly event_id: string;
    readonly payload_digest: string;
    readonly scheduled_at_ms: number;
    readonly detected_at_ms: number;
    readonly persisted: boolean;
  };
  recovery_hold: "restore_observation_unverified" | null;
  content_source_hold?: CronContentSourceHold;
  local_acquisition_due?: CronLocalAcquisitionDue;
  used_for_authority?: false;
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
  created_at_ms?: number;
  payload_hash: string;
  delegation?: RuntimeScheduleDelegation;
  content_source_hold?: CronContentSourceHold;
  google_service_scope_digest?: string;
  local_acquisition_due_only: boolean;
}

interface CronTaskRuntime {
  task: NormalizedCronTask;
  timer: NodeJS.Timeout | null;
  running: boolean;
  nextFireAtMs: number | null;
  lastFireAtMs: number | null;
  scheduledTimeZone: string | null;
  catchUpHold?: CronTaskSnapshot["catch_up_hold"];
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
  private readonly onHandlerReturned?: (event: CronEventIdentity) => CronEventResultReceipt;
  private readonly eventStore?: GatewayCronEventStore;
  private recoveryHold: CronTaskSnapshot["recovery_hold"] = null;
  private recoveryRestorePause: { readonly handler: InboundHandler | null } | null = null;
  private recoveryRestoreQuiescing = false;

  constructor(opts: CronSchedulerOptions) {
    this.logLine = opts.log;
    this.nowFn = opts.now;
    this.onFire = opts.onFire;
    this.onHandlerReturned = opts.onHandlerReturned;
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
      if (runtime.task.content_source_hold && !runtime.task.local_acquisition_due_only) {
        this.log(`[cron] task held id=${runtime.task.id} reason=${runtime.task.content_source_hold}`);
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
    return Array.from(this.runtimes.values()).map((runtime) => this.snapshotForRuntime(runtime));
  }

  isEventInFlight(event_id: string): boolean {
    return this.inFlightEventIds.has(event_id);
  }

  /** Resume only the exact source hold after its owner-approved skip is visible in HDS audit. */
  resumeAfterCatchUpSkip(event_id: string, payload_digest: string): boolean {
    if (!this.started || this.recoveryHold || this.recoveryRestorePause || this.recoveryRestoreQuiescing || !this.handler) {
      return false;
    }
    let resumed = false;
    for (const runtime of this.runtimes.values()) {
      const held = runtime.catchUpHold;
      if (!held || held.event_id !== event_id || held.payload_digest !== payload_digest ||
          !runtime.task.enabled || (runtime.task.content_source_hold && !runtime.task.local_acquisition_due_only)) {
        continue;
      }
      const source = cronTaskEventSource(runtime.task);
      if (this.eventStore?.latestCatchUpHoldForSource(source)) continue;
      runtime.catchUpHold = undefined;
      this.scheduleTask(runtime, this.handler);
      resumed = true;
    }
    return resumed;
  }

  upsertTask(task: CronTaskOptions): CronTaskSnapshot {
    const [normalized] = normalizeCronTasks([task]);
    if (!normalized) throw new Error("cron upsertTask received no task");
    const existing = this.runtimes.get(normalized.id);
    if (existing) this.stopRuntime(existing);
    const runtime = createRuntime(normalized);
    this.runtimes.set(normalized.id, runtime);
    if (this.started && !this.recoveryHold && normalized.enabled &&
        (!normalized.content_source_hold || normalized.local_acquisition_due_only) && this.handler) {
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
    const source = cronTaskEventSource(task);
    const persistedHold = this.eventStore?.latestCatchUpHoldForSource(source) ?? null;
    if (persistedHold) {
      runtime.catchUpHold = {
        reason: "catch_up_policy_unresolved",
        event_id: persistedHold.event_id,
        payload_digest: persistedHold.payload_digest,
        scheduled_at_ms: persistedHold.sequence,
        detected_at_ms: persistedHold.updated_at_ms,
        persisted: true,
      };
      this.stopRuntime(runtime);
      this.log(`[cron] task held id=${task.id} reason=catch_up_policy_unresolved event_id=${persistedHold.event_id}`);
      return;
    }
    const lastScheduledAt = this.eventStore?.latestSequenceForSource(source) ?? null;
    runtime.lastFireAtMs = lastScheduledAt;
    runtime.running = true;
    if (task.interval_ms && task.interval_ms > 0) {
      const anchor = lastScheduledAt ?? task.created_at_ms ?? this.nowMs();
      const nextAt = anchor + task.interval_ms;
      if (!Number.isSafeInteger(nextAt)) throw new Error("cron interval schedule exceeds safe timestamp range");
      if (nextAt < this.nowMs()) {
        this.holdMissedOccurrence(runtime, nextAt);
        return;
      }
      runtime.nextFireAtMs = nextAt;
      this.scheduleNextInterval(runtime, handler);
      this.log(`[cron] task interval enabled id=${task.id} interval_ms=${task.interval_ms}`);
      return;
    }
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
      if (nowMs - scheduledAtMs >= intervalMs) {
        this.holdMissedOccurrence(runtime, scheduledAtMs);
        return;
      }
      runtime.lastFireAtMs = scheduledAtMs;
      runtime.nextFireAtMs = scheduledAtMs + intervalMs;
      void this.enqueueFire(runtime, handler, scheduledAtMs);
      this.scheduleNextInterval(runtime, handler);
    }, delay);
    runtime.timer.unref?.();
  }

  private scheduleNextDaily(runtime: CronTaskRuntime, handler: InboundHandler): void {
    const task = runtime.task;
    if (!this.started || !runtime.running || this.runtimes.get(task.id) !== runtime) return;
    const nowMs = this.nowMs();
    const timeZone = task.time_zone ?? systemCronTimeZone();
    const anchor = runtime.lastFireAtMs ?? task.created_at_ms ?? null;
    const scheduledAtMs = anchor === null
      ? nextDailyFireAtMs(nowMs, task.time, timeZone, null)
      : nextDailyFireAtMs(anchor + 1, task.time, timeZone, anchor);
    if (scheduledAtMs < nowMs) {
      this.holdMissedOccurrence(runtime, scheduledAtMs);
      return;
    }
    runtime.scheduledTimeZone = timeZone;
    runtime.nextFireAtMs = scheduledAtMs;
    const delay = Math.max(0, Math.min(DAILY_CLOCK_RECHECK_MS, scheduledAtMs - nowMs));
    runtime.timer = setTimeout(() => {
      if (!this.started || !runtime.running || !task.enabled || this.runtimes.get(task.id) !== runtime) return;
      const firedAtMs = this.nowMs();
      const currentTimeZone = task.time_zone ?? systemCronTimeZone();
      const targetAtMs = runtime.nextFireAtMs;
      if (targetAtMs === null || firedAtMs < targetAtMs) {
        // Re-evaluate wall time after clock changes, early timer wakeups, or suspend/resume.
        this.scheduleNextDaily(runtime, handler);
        return;
      }
      if (currentTimeZone !== runtime.scheduledTimeZone) {
        this.holdMissedOccurrence(runtime, targetAtMs);
        return;
      }
      if (firedAtMs - targetAtMs > DAILY_CLOCK_RECHECK_MS) {
        this.holdMissedOccurrence(runtime, targetAtMs);
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
    const source = cronTaskEventSource(runtime.task);
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

  private holdMissedOccurrence(runtime: CronTaskRuntime, scheduledAtMs: number): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    runtime.running = false;
    runtime.nextFireAtMs = null;
    const event = createCronEventIdentity(cronTaskEventSource(runtime.task), scheduledAtMs, runtime.task.payload_hash);
    const detectedAtMs = this.nowMs();
    let persisted = false;
    try {
      const result = this.eventStore?.holdForCatchUpPolicy(event, detectedAtMs);
      persisted = result?.status === "held" || result?.status === "already_held";
      if (result && !persisted) {
        this.log(`[cron] catch-up hold persistence status id=${runtime.task.id} status=${result.status}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`[cron] catch-up hold persistence failed id=${runtime.task.id} reason=${truncateMetadata(reason)}`);
    }
    let savedHold: ReturnType<GatewayCronEventStore["latestCatchUpHoldForSource"]> = null;
    try {
      savedHold = this.eventStore?.latestCatchUpHoldForSource(event.source) ?? null;
    } catch {
      // The local snapshot still blocks this runtime; the durable store error is logged above.
    }
    runtime.catchUpHold = {
      reason: "catch_up_policy_unresolved",
      event_id: savedHold?.event_id ?? event.event_id,
      payload_digest: savedHold?.payload_digest ?? event.payload_digest,
      scheduled_at_ms: savedHold?.sequence ?? scheduledAtMs,
      detected_at_ms: savedHold?.updated_at_ms ?? detectedAtMs,
      persisted: persisted || savedHold !== null,
    };
    this.log(`[cron] task held id=${runtime.task.id} reason=catch_up_policy_unresolved event_id=${runtime.catchUpHold.event_id}`);
  }

  private async fire(runtime: CronTaskRuntime, handler: InboundHandler, scheduledAtMs: number): Promise<void> {
    const task = runtime.task;
    if (task.local_acquisition_due_only &&
        (!this.started || !runtime.running || this.runtimes.get(task.id) !== runtime || this.recoveryHold)) return;
    // Bind the durable occurrence to its schedule version before choosing the consumer.
    const event = createCronEventIdentity(cronTaskEventSource(task), scheduledAtMs, task.payload_hash);
    const eventStore = this.eventStore;
    if (!eventStore) {
      this.log(`[cron] event not dispatched id=${task.id} status=durable_store_unavailable`);
      return;
    }
    const claim = eventStore.claim(event);
    if (claim.status !== "accepted") {
      this.log(`[cron] event not dispatched id=${task.id} status=${claim.status}${claim.status === "duplicate" || claim.status === "blocked_unresolved" ? ` delivery_state=${claim.delivery_state}` : ""}`);
      return;
    }
    runtime.lastFireAtMs = scheduledAtMs;
    this.inFlightEventIds.add(event.event_id);
    try {
      if (task.local_acquisition_due_only) {
        try {
          // A due marker is local observation only. Never build an inbound request for it.
          eventStore.recordLocalAcquisitionDue(event);
        } catch (error) {
          eventStore.settle(event, "outcome_unknown");
          throw error;
        }
        return;
      }
      const payloadHash = cronPayloadHash(task);
      try {
        this.onFire?.(this.snapshotForRuntime(runtime, payloadHash), event, task.delegation);
      } catch (error) {
        eventStore.settle(event, "outcome_unknown");
        throw error;
      }
      const metadata: GatewayInternalAuthorityMetadata = {
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
          ...(task.delegation.goal_version_binding ? {
            "blue_tanuki.cron.delegation.goal_id_digest": task.delegation.goal_version_binding.goal_id_digest,
            "blue_tanuki.cron.delegation.purpose_version": task.delegation.goal_version_binding.purpose_version,
            "blue_tanuki.cron.delegation.purpose_digest": task.delegation.goal_version_binding.purpose_digest,
          } : {}),
        } : {}),
        "blue_tanuki.cron.event_source": event.source,
        "blue_tanuki.cron.event_id": event.event_id,
        "blue_tanuki.cron.event_sequence": String(event.sequence),
        "blue_tanuki.cron.content_source": "static",
        "blue_tanuki.channel_send.channel": task.channel,
        "blue_tanuki.channel_send.target": task.target,
        "blue_tanuki.channel_send.content": task.content,
      };
      const inbound: InboundRequest = createGatewayInternalInboundRequest({
        id: event.event_id,
        channel: "cron",
        user: "blue-tanuki-cron",
        content: task.content,
        timestamp: runtime.lastFireAtMs,
        session_id: cronTaskSessionId(task),
        metadata,
      });
      this.log(`[cron] firing task id=${task.id} channel=${task.channel} target=${task.target}`);
      try {
        await handler(inbound);
        const completionReceipt = this.onHandlerReturned?.(event);
        eventStore.settle(event, "handler_returned", completionReceipt?.observed_at_ms, completionReceipt);
      } catch (error) {
        eventStore.settle(event, "outcome_unknown");
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

  private stopRuntime(runtime: CronTaskRuntime): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    runtime.running = false;
    runtime.nextFireAtMs = null;
  }

  private snapshotForRuntime(runtime: CronTaskRuntime, payloadHash?: string): CronTaskSnapshot {
    let localAcquisitionDue: CronLocalAcquisitionDue | null = null;
    if (runtime.task.local_acquisition_due_only && !this.recoveryHold && this.eventStore && !this.eventStore.isClosed()) {
      try {
        localAcquisitionDue = this.eventStore.latestLocalAcquisitionDue(runtime.task.payload_hash);
      } catch {
        this.log("[cron] local Daily Brief occurrence unavailable");
      }
    }
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
      ...(runtime.catchUpHold ? { catch_up_hold: runtime.catchUpHold } : {}),
      recovery_hold: this.recoveryHold,
      ...(runtime.task.content_source_hold ? {
        content_source_hold: runtime.task.content_source_hold,
        used_for_authority: false as const,
      } : {}),
      ...(localAcquisitionDue ? { local_acquisition_due: localAcquisitionDue } : {}),
    };
  }
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
  const googleEnabled = googleDailyBriefSourceConfigured(env);
  let googleServiceScopeDigest: string | undefined;
  if (googleEnabled) {
    try {
      const services = Array.from(new Set(parseGoogleServices(env.BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES))).sort();
      googleServiceScopeDigest = createHash("sha256").update(JSON.stringify(services)).digest("hex");
    } catch {
      // Retain the configuration hold for unsupported service selections.
    }
  }
  return {
    enabled,
    channel,
    target,
    content: env.BLUE_TANUKI_DAILY_BRIEF_CONTENT ?? "Daily Brief: scheduled smoke from BLUE-TANUKI v1.0 RC.",
    time: env.BLUE_TANUKI_DAILY_BRIEF_TIME ?? "07:00",
    time_zone: env.BLUE_TANUKI_DAILY_BRIEF_TIME_ZONE,
    interval_ms: parsePositiveInt(env.BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS),
    ...(googleEnabled ? { content_source_hold: "google_authorized_acquisition_not_wired" } : {}),
    ...(googleServiceScopeDigest ? { google_service_scope_digest: googleServiceScopeDigest } : {}),
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
    content_source_hold: opts.content_source_hold,
    google_service_scope_digest: opts.google_service_scope_digest,
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
    const createdAt = task.created_at_ms;
    if (createdAt !== undefined && (!Number.isSafeInteger(createdAt) || createdAt < 0)) {
      throw new Error(`cron task ${id} created_at_ms must be a non-negative safe integer`);
    }
    const channel = requireTrimmed(task.channel, `cron task ${id} channel`);
    const target = requireTrimmed(task.target, `cron task ${id} target`);
    const content = requireTrimmed(task.content, `cron task ${id} content`);
    const googleServiceScopeDigest = task.google_service_scope_digest;
    const localAcquisitionDueOnly = id === "daily_brief" && task.name === "daily_brief" &&
      (task.origin === undefined || task.origin === "boot") &&
      task.content_source_hold === "google_authorized_acquisition_not_wired" &&
      googleServiceScopeDigest !== undefined && /^[a-f0-9]{64}$/u.test(googleServiceScopeDigest);
    const payloadHash = localAcquisitionDueOnly
      ? createHash("sha256").update(JSON.stringify([
        GOOGLE_DAILY_BRIEF_DUE_SOURCE,
        cronPayloadHash({ channel, target, content, time, interval_ms: task.interval_ms, time_zone: timeZone }),
        googleServiceScopeDigest,
      ])).digest("hex")
      : task.payload_hash ?? cronPayloadHash(task);
    return {
      id,
      name: task.name ?? "scheduled_message",
      origin: task.origin ?? "boot",
      enabled: task.enabled !== false,
      channel,
      target,
      content,
      time,
      time_zone: timeZone,
      interval_ms: task.interval_ms,
      created_at_ms: createdAt,
      payload_hash: payloadHash,
      delegation: task.delegation,
      content_source_hold: task.content_source_hold,
      google_service_scope_digest: googleServiceScopeDigest,
      local_acquisition_due_only: localAcquisitionDueOnly,
    };
  });
}

function cronTaskEventSource(task: NormalizedCronTask): string {
  return task.local_acquisition_due_only ? GOOGLE_DAILY_BRIEF_DUE_SOURCE : `cron:${task.origin}:${task.id}`;
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
  return runtimeSchedulePayloadHash(task);
}

/** Stable executor-history scope for one persistent schedule; this is context, never HDS authority. */
function cronTaskSessionId(task: Pick<NormalizedCronTask, "origin" | "id" | "payload_hash">): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      "blue-tanuki.cron-task-session.v1",
      task.origin,
      task.id,
      task.payload_hash,
    ]), "utf8")
    .digest("hex");
  return `cron-task:${digest}`;
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
