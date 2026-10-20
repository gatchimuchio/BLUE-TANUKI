import { statfsSync } from "node:fs";
import { freemem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import type { ComputeCapacityLease, ComputeCapacityPort } from "@blue-tanuki/core";

export interface GatewayResourceBackpressurePolicy {
  max_active_executions: number;
  reserved_control_execution_slots: number;
  max_pending_approvals: number;
  reserved_final_review_approvals: number;
  max_active_provider_calls: number;
  max_queued_provider_calls: number;
  provider_queue_timeout_ms: number;
  reserved_control_memory_bytes: number;
  reserved_control_disk_bytes: number;
  memory_per_execution_bytes: number;
  memory_per_pending_approval_bytes: number;
  memory_per_provider_call_bytes: number;
  memory_per_queued_provider_call_bytes: number;
  disk_per_execution_bytes: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY: GatewayResourceBackpressurePolicy = Object.freeze({
  max_active_executions: 8,
  reserved_control_execution_slots: 1,
  max_pending_approvals: 128,
  reserved_final_review_approvals: 16,
  max_active_provider_calls: 2,
  max_queued_provider_calls: 4,
  provider_queue_timeout_ms: 15_000,
  reserved_control_memory_bytes: 128 * MiB,
  reserved_control_disk_bytes: 32 * MiB,
  memory_per_execution_bytes: 8 * MiB,
  memory_per_pending_approval_bytes: 128 * 1024,
  memory_per_provider_call_bytes: 32 * MiB,
  memory_per_queued_provider_call_bytes: 1 * MiB,
  disk_per_execution_bytes: 256 * 1024,
});

export interface GatewayResourceSnapshot {
  available_memory_bytes: number;
  available_disk_bytes: readonly number[];
}

export type GatewayResourceProbe = () => GatewayResourceSnapshot;

export type AdmissionResult =
  | { ok: true; lease: { release(): void } }
  | { ok: false; reason: string };

interface ProviderWaiter {
  resolve: (lease: ComputeCapacityLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

/**
 * Bounds new execution/provider work and leaves measured headroom for control,
 * receipts, and audit. Protected control endpoints do not acquire work slots.
 */
export class GatewayResourceBackpressure implements ComputeCapacityPort {
  private activeExecutions = 0;
  private activeProviderCalls = 0;
  private readonly providerWaiters: ProviderWaiter[] = [];
  private pendingApprovalReservations = 0;

  constructor(
    readonly policy: GatewayResourceBackpressurePolicy = DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY,
    private readonly probe: GatewayResourceProbe = () => ({ available_memory_bytes: 0, available_disk_bytes: [] }),
  ) {
    validatePolicy(policy);
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
  ): GatewayResourceBackpressure {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? join(cwd, ".blue-tanuki"));
    const auditDirectory = nonEmpty(env.BLUE_TANUKI_AUDIT_DIR);
    const historyFile = nonEmpty(env.BLUE_TANUKI_COMPLETE_HISTORY_FILE);
    const diskPaths = Array.from(new Set([
      stateRoot,
      ...(auditDirectory ? [resolve(auditDirectory)] : []),
      ...(historyFile ? [dirname(resolve(historyFile))] : []),
    ]));
    return new GatewayResourceBackpressure(
      parseGatewayResourceBackpressurePolicy(env.BLUE_TANUKI_RESOURCE_BACKPRESSURE_POLICY_JSON),
      () => sampleResources(diskPaths),
    );
  }

  tryAcquireExecution(): AdmissionResult {
    const workLimit = this.policy.max_active_executions - this.policy.reserved_control_execution_slots;
    if (this.activeExecutions >= workLimit) return { ok: false, reason: "gateway_execution_capacity_reserved" };
    const blocked = this.resourceFailure(1, this.activeProviderCalls, this.providerWaiters.length);
    if (blocked) return { ok: false, reason: blocked };
    this.activeExecutions += 1;
    let released = false;
    return { ok: true, lease: { release: () => {
      if (released) return;
      released = true;
      this.activeExecutions = Math.max(0, this.activeExecutions - 1);
    } } };
  }

  reservePendingApprovalSlot(
    pendingCount: number,
    finalReviewRequired: boolean,
  ): AdmissionResult {
    const total = pendingCount + this.pendingApprovalReservations;
    const limit = finalReviewRequired
      ? this.policy.max_pending_approvals
      : this.policy.max_pending_approvals - this.policy.reserved_final_review_approvals;
    if (total >= limit) return { ok: false, reason: "gateway_approval_queue_capacity_reserved" };
    const blocked = this.resourceFailure(0, this.activeProviderCalls, this.providerWaiters.length);
    if (blocked) return { ok: false, reason: blocked };
    this.pendingApprovalReservations += 1;
    let released = false;
    return { ok: true, lease: { release: () => {
      if (released) return;
      released = true;
      this.pendingApprovalReservations = Math.max(0, this.pendingApprovalReservations - 1);
    } } };
  }

  pendingApprovalReservationCount(): number {
    return this.pendingApprovalReservations;
  }

  activeExecutionCount(): number {
    return this.activeExecutions;
  }

  activeProviderCallCount(): number {
    return this.activeProviderCalls;
  }

  queuedProviderCallCount(): number {
    return this.providerWaiters.filter((waiter) => !waiter.settled).length;
  }

  async acquire(input: { timeout_ms: number; signal?: AbortSignal }): Promise<ComputeCapacityLease> {
    if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms <= 0) {
      throw new Error("gateway_provider_capacity_timeout_invalid");
    }
    if (input.signal?.aborted) throw new Error("gateway_provider_capacity_cancelled");
    const hasProviderSlot = this.activeProviderCalls < this.policy.max_active_provider_calls;
    const blocked = this.resourceFailure(0,
      this.activeProviderCalls + (hasProviderSlot ? 1 : 0),
      this.providerWaiters.length + (hasProviderSlot ? 0 : 1));
    if (blocked) throw new Error(blocked);
    if (hasProviderSlot) {
      this.activeProviderCalls += 1;
      return this.providerLease();
    }
    if (this.providerWaiters.length >= this.policy.max_queued_provider_calls) {
      throw new Error("gateway_provider_queue_capacity_reached");
    }
    const timeoutMs = Math.min(input.timeout_ms, this.policy.provider_queue_timeout_ms);
    return await new Promise<ComputeCapacityLease>((resolvePromise, rejectPromise) => {
      const waiter: ProviderWaiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        ...(input.signal ? { signal: input.signal } : {}),
        timer: setTimeout(() => this.rejectProviderWaiter(waiter, "gateway_provider_queue_timeout"), timeoutMs),
        settled: false,
      };
      if (input.signal) {
        waiter.abortListener = () => this.rejectProviderWaiter(waiter, "gateway_provider_capacity_cancelled");
        input.signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.providerWaiters.push(waiter);
    });
  }

  private providerLease(): ComputeCapacityLease {
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.releaseProviderSlot();
    } };
  }

  private releaseProviderSlot(): void {
    this.activeProviderCalls = Math.max(0, this.activeProviderCalls - 1);
    while (this.providerWaiters.length > 0) {
      const waiter = this.providerWaiters.shift()!;
      if (waiter.settled) continue;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.settled = true;
        waiter.reject(new Error("gateway_provider_capacity_cancelled"));
        continue;
      }
      const blocked = this.resourceFailure(0, this.activeProviderCalls + 1, this.providerWaiters.length);
      if (blocked) {
        waiter.settled = true;
        waiter.reject(new Error(blocked));
        continue;
      }
      waiter.settled = true;
      this.activeProviderCalls += 1;
      waiter.resolve(this.providerLease());
      return;
    }
  }

  private rejectProviderWaiter(waiter: ProviderWaiter, reason: string): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.providerWaiters.indexOf(waiter);
    if (index >= 0) this.providerWaiters.splice(index, 1);
    this.cleanupWaiter(waiter);
    waiter.reject(new Error(reason));
  }

  private cleanupWaiter(waiter: ProviderWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
  }

  private resourceFailure(
    additionalExecutions: number,
    providerCalls: number,
    queuedProviderCalls: number,
  ): string | null {
    let snapshot: GatewayResourceSnapshot;
    try { snapshot = this.probe(); }
    catch { return "gateway_resource_capacity_unavailable"; }
    if (!Number.isSafeInteger(snapshot.available_memory_bytes) || snapshot.available_memory_bytes < 0 ||
        snapshot.available_disk_bytes.length === 0 || snapshot.available_disk_bytes.some((value) =>
          !Number.isSafeInteger(value) || value < 0)) {
      return "gateway_resource_capacity_unavailable";
    }
    const memoryRequired = this.policy.reserved_control_memory_bytes +
      (this.activeExecutions + additionalExecutions) * this.policy.memory_per_execution_bytes +
      this.policy.max_pending_approvals * this.policy.memory_per_pending_approval_bytes +
      providerCalls * this.policy.memory_per_provider_call_bytes +
      queuedProviderCalls * this.policy.memory_per_queued_provider_call_bytes;
    if (snapshot.available_memory_bytes < memoryRequired) return "gateway_memory_backpressure_reserved";
    const diskRequired = this.policy.reserved_control_disk_bytes +
      (this.activeExecutions + additionalExecutions) * this.policy.disk_per_execution_bytes;
    if (snapshot.available_disk_bytes.some((value) => value < diskRequired)) {
      return "gateway_disk_backpressure_reserved";
    }
    return null;
  }
}

export function parseGatewayResourceBackpressurePolicy(raw: string | undefined): GatewayResourceBackpressurePolicy {
  if (!raw?.trim()) return structuredClone(DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("gateway resource backpressure policy JSON is invalid"); }
  if (!isRecord(value) || Object.keys(value).length !== Object.keys(DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY).length) {
    throw new Error("gateway resource backpressure policy fields are invalid");
  }
  const parsed = {} as GatewayResourceBackpressurePolicy;
  for (const key of Object.keys(DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY) as Array<keyof GatewayResourceBackpressurePolicy>) {
    const field = value[key];
    if (typeof field !== "number") throw new Error("gateway resource backpressure policy fields are invalid");
    parsed[key] = field;
  }
  validatePolicy(parsed);
  return parsed;
}

function validatePolicy(policy: GatewayResourceBackpressurePolicy): void {
  const positive = [
    policy.max_active_executions, policy.max_pending_approvals, policy.max_active_provider_calls,
    policy.provider_queue_timeout_ms, policy.reserved_control_memory_bytes,
    policy.reserved_control_disk_bytes, policy.memory_per_execution_bytes,
    policy.memory_per_pending_approval_bytes, policy.memory_per_provider_call_bytes,
    policy.memory_per_queued_provider_call_bytes, policy.disk_per_execution_bytes,
  ];
  if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      !Number.isSafeInteger(policy.max_queued_provider_calls) || policy.max_queued_provider_calls < 0 ||
      !Number.isSafeInteger(policy.reserved_control_execution_slots) || policy.reserved_control_execution_slots < 0 ||
      policy.reserved_control_execution_slots >= policy.max_active_executions ||
      !Number.isSafeInteger(policy.reserved_final_review_approvals) || policy.reserved_final_review_approvals < 0 ||
      policy.reserved_final_review_approvals >= policy.max_pending_approvals ||
      Object.keys(policy).some((key) => !Object.hasOwn(DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY, key))) {
    throw new Error("gateway resource backpressure policy is invalid");
  }
}

function sampleResources(paths: readonly string[]): GatewayResourceSnapshot {
  const heap = getHeapStatistics();
  const processHeap = process.memoryUsage().heapUsed;
  const memory = Math.min(freemem(), Math.max(0, heap.heap_size_limit - processHeap));
  const disks = paths.map((path) => {
    const stats = statfsSync(path);
    return Math.max(0, Math.floor(stats.bavail * stats.bsize));
  });
  return { available_memory_bytes: Math.floor(memory), available_disk_bytes: disks };
}

function nonEmpty(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
