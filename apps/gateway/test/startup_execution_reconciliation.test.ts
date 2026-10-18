import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { HDSUpperController } from "@blue-tanuki/hds-brain";
import type { ExecutionResultDelivery } from "@blue-tanuki/protocol";
import type { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { reconcileStartupExecutionState } from "../src/reconcile_execution_results.js";

function fixture(deliveryEpoch?: string) {
  let acknowledged = false;
  let attempts = 0;
  const currentEpoch = randomUUID();
  const delivery = {
    admission: { ticket_id: "00000000-0000-4000-8000-000000000001", execution_epoch: deliveryEpoch ?? currentEpoch },
    feedback: { command_id: "command-1" },
  } as unknown as ExecutionResultDelivery;
  const store = {
    pendingResults: vi.fn(() => acknowledged ? [] : [{ delivery, delivery_digest: "d".repeat(64) }]),
    acknowledgeResult: vi.fn(() => { acknowledged = true; }),
    archiveStaleGenerationResult: vi.fn(() => { throw new Error("fixture archive unavailable"); }),
  } as unknown as GatewayExecutionIntentStore;
  return {
    store,
    currentEpoch,
    get attempts() { return attempts; },
    controller(resultForAttempt: (attempt: number) => boolean, memoryReady: () => boolean) {
      return {
        reconcileOperationPlanResult: vi.fn(() => resultForAttempt(++attempts)),
        reconcileOperationPlanMemory: vi.fn(memoryReady),
      } as unknown as HDSUpperController;
    },
  };
}

describe("Gateway startup execution reconciliation", () => {
  it("retries the same pending receipt once after M recovery and becomes ready only after acknowledgement", () => {
    const f = fixture();
    const hds = f.controller((attempt) => attempt > 1, () => true);

    const status = reconcileStartupExecutionState(hds, f.store, f.currentEpoch);

    expect(status).toEqual({ ready: true, adopted: 1, deferred: 0, stale_generation_archived: 0, memory_ready: true, result_store_readable: true });
    expect(f.attempts).toBe(2);
    expect(f.store.acknowledgeResult).toHaveBeenCalledTimes(1);
  });

  it("keeps startup blocked when the exact pending receipt still cannot be reconciled", () => {
    const f = fixture();
    const hds = f.controller(() => false, () => true);

    const status = reconcileStartupExecutionState(hds, f.store, f.currentEpoch);

    expect(status).toEqual({ ready: false, adopted: 0, deferred: 1, stale_generation_archived: 0, memory_ready: true, result_store_readable: true });
    expect(f.attempts).toBe(2);
    expect(f.store.acknowledgeResult).not.toHaveBeenCalled();
  });

  it("keeps startup blocked and does not retry results while M recovery is unavailable", () => {
    const f = fixture();
    const hds = f.controller(() => false, () => false);

    const status = reconcileStartupExecutionState(hds, f.store, f.currentEpoch);

    expect(status).toEqual({ ready: false, adopted: 0, deferred: 1, stale_generation_archived: 0, memory_ready: false, result_store_readable: true });
    expect(f.attempts).toBe(1);
    expect(f.store.acknowledgeResult).not.toHaveBeenCalled();
  });

  it("fails closed when the persisted result outbox cannot be read", () => {
    const f = fixture();
    vi.mocked(f.store.pendingResults).mockImplementation(() => { throw new Error("private store failure"); });
    const hds = f.controller(() => true, () => true);

    const status = reconcileStartupExecutionState(hds, f.store, f.currentEpoch);

    expect(status).toEqual({ ready: false, adopted: 0, deferred: 0, stale_generation_archived: 0, memory_ready: true, result_store_readable: false });
    expect(f.store.acknowledgeResult).not.toHaveBeenCalled();
    expect(f.attempts).toBe(0);
  });

  it("fails startup closed when a stale-generation result cannot be archived", () => {
    const f = fixture(randomUUID());
    const hds = f.controller(() => true, () => true);

    const status = reconcileStartupExecutionState(hds, f.store, f.currentEpoch);

    expect(status).toEqual({ ready: false, adopted: 0, deferred: 1, stale_generation_archived: 0,
      memory_ready: true, result_store_readable: true });
    expect(f.store.archiveStaleGenerationResult).toHaveBeenCalled();
    expect(hds.reconcileOperationPlanResult).not.toHaveBeenCalled();
  });
});
