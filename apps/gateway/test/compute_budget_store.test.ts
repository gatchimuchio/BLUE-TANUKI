import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayComputeBudgetStore, parseComputeBudgetPolicy } from "../src/compute_budget_store.js";
import type { ComputeBudgetPolicy, ComputeBudgetSettlement } from "@blue-tanuki/core";

const tempRoots: string[] = [];

function makeStore(policy = makePolicy()): GatewayComputeBudgetStore {
  const root = mkdtempSync(join(tmpdir(), "blue-compute-budget-"));
  tempRoots.push(root);
  return new GatewayComputeBudgetStore(join(root, "ledger.sqlite"), policy);
}

function makePolicy(): ComputeBudgetPolicy {
  return {
    window_ms: 86_400_000,
    currency: "USD",
    system: { max_tokens: 100, max_compute_ms: 60_000, max_cost: { amount: 1, currency: "USD" } },
    parent: { max_tokens: 50, max_compute_ms: 30_000, max_cost: { amount: 0.5, currency: "USD" } },
    task: { max_tokens: 50, max_compute_ms: 30_000, max_cost: { amount: 0.5, currency: "USD" } },
  };
}

function digest(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

function reserve(store: GatewayComputeBudgetStore, requestId: string, parent: string, task: string, tokens: number, cost = 0.1) {
  return store.reserve({
    request_id: requestId,
    scope: { parent_task_identity_digest: digest(parent), task_identity_digest: digest(task) },
    reserved_tokens: tokens,
    reserved_compute_ms: 1_000,
    reserved_cost: { amount: cost, currency: "USD", source: "CONFIG" },
  });
}

const unknownSettlement: ComputeBudgetSettlement = {
  state: "unknown",
  tokens_used: 0,
  tokens_usage_status: "unknown",
  compute_ms: 20,
  cost: { status: "unknown", reason: "provider_call_outcome_unknown" },
};

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("GatewayComputeBudgetStore", () => {
  it("aggregates child reservations against their shared parent before a provider call", () => {
    const store = makeStore();
    try {
      reserve(store, "parent-call", "parent-1", "task-parent", 20);
      expect(() => reserve(store, "child-call", "parent-1", "task-child", 31))
        .toThrow("compute_budget_parent_exhausted");
    } finally {
      store.close();
    }
  });

  it("keeps unknown outcomes charged at the full reservation and settles idempotently", () => {
    const store = makeStore({
      ...makePolicy(),
      system: { max_tokens: 30, max_compute_ms: 60_000, max_cost: { amount: 0.3, currency: "USD" } },
    });
    try {
      const reservation = reserve(store, "uncertain-call", "parent-2", "task-2", 20, 0.2);
      store.settle(reservation.reservation_id, unknownSettlement);
      expect(() => store.settle(reservation.reservation_id, unknownSettlement)).not.toThrow();
      expect(() => reserve(store, "later-call", "parent-3", "task-3", 15, 0.05))
        .toThrow("compute_budget_system_exhausted");
      expect(() => store.settle(reservation.reservation_id, {
        ...unknownSettlement,
        compute_ms: 21,
      })).toThrow("compute_budget_settlement_conflict");
    } finally {
      store.close();
    }
  });

  it("keeps same-window consumption when the owner changes policy generation", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-compute-budget-generation-"));
    tempRoots.push(root);
    const filepath = join(root, "ledger.sqlite");
    const basePolicy = makePolicy();
    const originalPolicy: ComputeBudgetPolicy = {
      ...basePolicy,
      parent: { ...basePolicy.parent, max_tokens: 100 },
      task: { ...basePolicy.task, max_tokens: 100 },
    };
    const first = new GatewayComputeBudgetStore(filepath, originalPolicy);
    reserve(first, "generation-first", "parent-gen", "task-gen-a", 60, 0.1);
    first.close();

    const stricterPolicy: ComputeBudgetPolicy = {
      ...originalPolicy,
      system: { ...originalPolicy.system, max_tokens: 80 },
    };
    const next = new GatewayComputeBudgetStore(filepath, stricterPolicy);
    try {
      expect(() => reserve(next, "generation-second", "parent-other", "task-gen-b", 30, 0.1))
        .toThrow("compute_budget_system_exhausted");
    } finally {
      next.close();
    }
  });

  it("rejects duplicate requests and calls without an owner policy", () => {
    const store = makeStore();
    const root = mkdtempSync(join(tmpdir(), "blue-compute-budget-unconfigured-"));
    tempRoots.push(root);
    const unconfigured = new GatewayComputeBudgetStore(join(root, "ledger.sqlite"));
    try {
      reserve(store, "same-request", "parent-4", "task-4", 10);
      expect(() => reserve(store, "same-request", "parent-4", "task-4", 10))
        .toThrow("compute_budget_duplicate_request");
      expect(() => unconfigured.reserve({
        request_id: "unknown-cost",
        scope: { parent_task_identity_digest: digest("p"), task_identity_digest: digest("t") },
        reserved_tokens: 1,
        reserved_compute_ms: 1,
        reserved_cost: { amount: 0, currency: "USD", source: "CONFIG" },
      })).toThrow("compute_budget_policy_missing");
    } finally {
      store.close();
      unconfigured.close();
    }
  });

  it("validates the owner budget policy shape and currency", () => {
    const raw = JSON.stringify({
      window_ms: 86_400_000,
      currency: "USD",
      system: { max_tokens: 100, max_compute_ms: 60_000, max_cost: { amount: 1, currency: "USD" } },
      parent: { max_tokens: 50, max_compute_ms: 30_000, max_cost: { amount: 0.5, currency: "USD" } },
      task: { max_tokens: 50, max_compute_ms: 30_000, max_cost: { amount: 0.5, currency: "USD" } },
    });
    expect(parseComputeBudgetPolicy(raw)?.currency).toBe("USD");
    expect(() => parseComputeBudgetPolicy(raw.replace('"USD"', '"usd"'))).toThrow();
  });
});
