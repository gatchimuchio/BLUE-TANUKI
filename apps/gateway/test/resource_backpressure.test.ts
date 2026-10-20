import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY,
  GatewayResourceBackpressure,
  type GatewayResourceBackpressurePolicy,
  type GatewayResourceSnapshot,
} from "../src/resource_backpressure.js";

const ampleResources: GatewayResourceSnapshot = {
  available_memory_bytes: 2 * 1024 * 1024 * 1024,
  available_disk_bytes: [2 * 1024 * 1024 * 1024],
};

function policy(overrides: Partial<GatewayResourceBackpressurePolicy> = {}): GatewayResourceBackpressurePolicy {
  return { ...DEFAULT_GATEWAY_RESOURCE_BACKPRESSURE_POLICY, ...overrides };
}

describe("GatewayResourceBackpressure", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds work while retaining execution and approval capacity for protected paths", () => {
    const backpressure = new GatewayResourceBackpressure(policy({
      max_active_executions: 2,
      reserved_control_execution_slots: 1,
      max_pending_approvals: 4,
      reserved_final_review_approvals: 2,
    }), () => ampleResources);

    const execution = backpressure.tryAcquireExecution();
    expect(execution.ok).toBe(true);
    if (!execution.ok) return;
    expect(backpressure.tryAcquireExecution()).toMatchObject({ ok: false, reason: "gateway_execution_capacity_reserved" });
    execution.lease.release();
    execution.lease.release();
    expect(backpressure.activeExecutionCount()).toBe(0);

    const ordinary = [
      backpressure.reservePendingApprovalSlot(0, false),
      backpressure.reservePendingApprovalSlot(0, false),
    ];
    expect(ordinary.every((result) => result.ok)).toBe(true);
    expect(backpressure.reservePendingApprovalSlot(0, false)).toMatchObject({
      ok: false, reason: "gateway_approval_queue_capacity_reserved",
    });
    const finalReview = [
      backpressure.reservePendingApprovalSlot(0, true),
      backpressure.reservePendingApprovalSlot(0, true),
    ];
    expect(finalReview.every((result) => result.ok)).toBe(true);
    expect(backpressure.reservePendingApprovalSlot(0, true).ok).toBe(false);
    for (const result of [...ordinary, ...finalReview]) if (result.ok) result.lease.release();
    expect(backpressure.pendingApprovalReservationCount()).toBe(0);
  });

  it("refuses work before consuming the control memory or disk reserve", () => {
    const probe = vi.fn<() => GatewayResourceSnapshot>(() => ({
      available_memory_bytes: 100 * 1024 * 1024,
      available_disk_bytes: [1024 * 1024 * 1024],
    }));
    const lowMemory = new GatewayResourceBackpressure(undefined, probe);
    expect(lowMemory.tryAcquireExecution()).toMatchObject({
      ok: false, reason: "gateway_memory_backpressure_reserved",
    });

    probe.mockReturnValue({ available_memory_bytes: ampleResources.available_memory_bytes, available_disk_bytes: [1] });
    const lowDisk = new GatewayResourceBackpressure(undefined, probe);
    expect(lowDisk.tryAcquireExecution()).toMatchObject({
      ok: false, reason: "gateway_disk_backpressure_reserved",
    });

    probe.mockImplementation(() => { throw new Error("probe unavailable"); });
    expect(new GatewayResourceBackpressure(undefined, probe).tryAcquireExecution()).toMatchObject({
      ok: false, reason: "gateway_resource_capacity_unavailable",
    });
  });

  it("bounds provider concurrency and the wait queue, then releases waiters FIFO", async () => {
    const backpressure = new GatewayResourceBackpressure(policy({
      max_active_provider_calls: 1,
      max_queued_provider_calls: 1,
      provider_queue_timeout_ms: 1_000,
    }), () => ampleResources);
    const first = await backpressure.acquire({ timeout_ms: 2_000 });
    const secondPending = backpressure.acquire({ timeout_ms: 2_000 });
    expect(backpressure.activeProviderCallCount()).toBe(1);
    expect(backpressure.queuedProviderCallCount()).toBe(1);
    await expect(backpressure.acquire({ timeout_ms: 2_000 })).rejects.toThrow("gateway_provider_queue_capacity_reached");

    first.release();
    first.release();
    const second = await secondPending;
    expect(backpressure.activeProviderCallCount()).toBe(1);
    expect(backpressure.queuedProviderCallCount()).toBe(0);
    second.release();
    expect(backpressure.activeProviderCallCount()).toBe(0);
  });

  it("removes cancelled provider waiters without consuming a slot", async () => {
    const backpressure = new GatewayResourceBackpressure(policy({ max_active_provider_calls: 1 }), () => ampleResources);
    const first = await backpressure.acquire({ timeout_ms: 2_000 });
    const controller = new AbortController();
    const pending = backpressure.acquire({ timeout_ms: 2_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("gateway_provider_capacity_cancelled");
    expect(backpressure.queuedProviderCallCount()).toBe(0);
    first.release();
    expect(backpressure.activeProviderCallCount()).toBe(0);
  });
});
