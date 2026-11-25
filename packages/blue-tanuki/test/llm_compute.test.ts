import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "../src/llm/base.js";
import { LLMRegistry } from "../src/llm/registry.js";
import {
  LLMComputeAdapter,
  LLM_COMPUTE_PROFILE,
  digestLLMRequest,
  type ComputeBackend,
  type ComputeBudgetPort,
  type ComputeCapacityPort,
  type ComputeRequest,
} from "../src/llm/compute.js";

class CapturingBackend implements LLMBackend {
  readonly name = "fixture-provider";
  readonly seen: LLMRequest[] = [];
  lastSignal?: AbortSignal;

  async call(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    this.seen.push(request);
    this.lastSignal = signal;
    return {
      content: "fixture response",
      tokens_used: 7,
      model: "fixture-model-v1",
      provider: "untrusted-response-provider",
      raw: { private: "raw provider payload" },
    };
  }
}

function computeRequest(): ComputeRequest<LLMRequest> {
  const input: LLMRequest = {
    backend_hint: "fixture-provider",
    model: "fixture-model-v1",
    messages: [{ role: "user", content: "fixture prompt" }],
  };
  return {
    request_id: "request-1",
    current_projection_digest: "a".repeat(64),
    input_digest: digestLLMRequest(input),
    c_profile: LLM_COMPUTE_PROFILE,
    local_p_version: "blue-tanuki.c-input-rules.v1",
    data_exposure_scope: {
      input_sources: ["accepted_inbound_request", "selected_memory_references"],
      requested_egress_provider: "fixture-provider",
    },
    resource_limits: { max_tokens: 128, timeout_ms: 2_000 },
    input,
  };
}

function computeRequestWithGrant(): ComputeRequest<LLMRequest> {
  const request = computeRequest();
  const now = Date.now();
  const grantRequestId = "task-1";
  const taskIdentityDigest = createHash("sha256")
    .update(`blue-tanuki.compute-budget.task.v1\0${grantRequestId}`)
    .digest("hex");
  request.budget_scope = {
    parent_task_identity_digest: "c".repeat(64),
    task_identity_digest: taskIdentityDigest,
  };
  request.compute_grant = {
    schema_version: "blue-tanuki.compute-grant.v1",
    grant_id: "00000000-0000-4000-8000-000000000001",
    request_id: grantRequestId,
    task_identity_digest: request.budget_scope.task_identity_digest,
    projection_digest: request.current_projection_digest,
    purpose_digest: "e".repeat(64),
    local_p_version: request.local_p_version,
    provider: "fixture-provider",
    model: "fixture-model-v1",
    allowed_input_sources: [...request.data_exposure_scope.input_sources],
    max_tokens: request.resource_limits.max_tokens!,
    max_compute_ms: request.resource_limits.timeout_ms!,
    max_cost: { amount: 0.25, currency: "USD" },
    issued_at_ms: now,
    expires_at_ms: now + request.resource_limits.timeout_ms!,
    issuer: "J",
  };
  return request;
}

describe("LLMComputeAdapter", () => {
  it("accepts a current J grant only for its exact request scope and returns the grant receipt identity", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");

    const result = await new LLMComputeAdapter(registry).compute(computeRequestWithGrant());

    expect(backend.seen).toHaveLength(1);
    expect(result.execution_identity.compute_grant_id).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects expired, out-of-scope, or over-cost J grants before provider invocation", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");

    const expired = computeRequestWithGrant();
    const expiredAt = Date.now();
    expired.compute_grant!.issued_at_ms = expiredAt - 1_500;
    expired.compute_grant!.expires_at_ms = expiredAt - 500;
    await expect(new LLMComputeAdapter(registry).compute(expired)).rejects.toThrow("llm_compute_grant_expired");

    const outOfScope = computeRequestWithGrant();
    outOfScope.compute_grant!.allowed_input_sources = ["accepted_inbound_request"];
    await expect(new LLMComputeAdapter(registry).compute(outOfScope))
      .rejects.toThrow("llm_compute_grant_input_scope_exceeded");

    const overCost = computeRequestWithGrant();
    overCost.compute_grant!.max_cost.amount = 0.1;
    await expect(new LLMComputeAdapter(registry).compute(overCost))
      .rejects.toThrow("llm_compute_grant_cost_limit_exceeded");

    expect(backend.seen).toHaveLength(0);
  });

  it("rejects a provider input whose digest no longer matches before invocation", async () => {
    const backend = new CapturingBackend();
    const request = computeRequest();
    request.input.messages[0]!.content = "changed after the digest was created";

    await expect(new LLMComputeAdapter(backend).compute(request))
      .rejects.toThrow("llm_compute_input_digest_mismatch");
    expect(backend.seen).toHaveLength(0);
  });

  it("does not acquire provider capacity for an already-aborted compute", async () => {
    const backend = new CapturingBackend();
    const controller = new AbortController();
    controller.abort();
    let acquisitions = 0;
    const capacity: ComputeCapacityPort = {
      async acquire() {
        acquisitions += 1;
        return { release() {} };
      },
    };

    await expect(new LLMComputeAdapter(backend, undefined, capacity).compute(computeRequest(), controller.signal))
      .rejects.toMatchObject({ kind: "cancelled" });
    expect(acquisitions).toBe(0);
    expect(backend.seen).toHaveLength(0);
  });

  it("does not reserve a budget after provider configuration has been invalidated", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    registry.invalidateProviderConfiguration();
    const request = computeRequest();
    request.budget_scope = { parent_task_identity_digest: "c".repeat(64), task_identity_digest: "d".repeat(64) };
    let reservations = 0;
    const budget: ComputeBudgetPort = {
      reserve() {
        reservations += 1;
        throw new Error("invalidated provider must not reserve");
      },
      settle() {},
    };

    await expect(new LLMComputeAdapter(registry, budget).compute(request))
      .rejects.toMatchObject({ kind: "cancelled", retryable: false });
    expect(reservations).toBe(0);
    expect(backend.seen).toHaveLength(0);
  });

  it("settles a pending reservation as not invoked if provider configuration changes", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    const request = computeRequest();
    request.budget_scope = { parent_task_identity_digest: "c".repeat(64), task_identity_digest: "d".repeat(64) };
    let markReserveStarted!: () => void;
    const reserveStarted = new Promise<void>((resolve) => { markReserveStarted = resolve; });
    let resolveReservation!: (reservation: Awaited<ReturnType<ComputeBudgetPort["reserve"]>>) => void;
    const reservationPending = new Promise<Awaited<ReturnType<ComputeBudgetPort["reserve"]>>>((resolve) => {
      resolveReservation = resolve;
    });
    let settlement: Parameters<ComputeBudgetPort["settle"]>[1] | undefined;
    const budget: ComputeBudgetPort = {
      reserve() { markReserveStarted(); return reservationPending; },
      settle(_id, value) { settlement = value; },
    };
    const pending = new LLMComputeAdapter(registry, budget).compute(request);
    await reserveStarted;
    registry.invalidateProviderConfiguration();
    resolveReservation({
      reservation_id: "9".repeat(64), reserved_tokens: 128, reserved_compute_ms: 2_000,
      reserved_cost: { amount: 0.25, currency: "USD", source: "CONFIG" },
    });

    await expect(pending).rejects.toMatchObject({ kind: "cancelled", retryable: false });
    expect(backend.seen).toHaveLength(0);
    expect(settlement).toEqual({
      state: "settled", tokens_used: 0, tokens_usage_status: "not_invoked", compute_ms: 0,
      cost: { status: "actual", amount: 0, currency: "USD", source: "not_invoked" },
    });
  });

  it("settles a reservation as not invoked if the J grant expires while waiting for capacity", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    const request = computeRequestWithGrant();
    let settlement: Parameters<ComputeBudgetPort["settle"]>[1] | undefined;
    const budget: ComputeBudgetPort = {
      reserve(input) {
        return {
          reservation_id: "8".repeat(64), reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms, reserved_cost: input.reserved_cost,
        };
      },
      settle(_id, value) { settlement = value; },
    };
    const capacity: ComputeCapacityPort = {
      async acquire() {
        request.compute_grant!.expires_at_ms = request.compute_grant!.issued_at_ms + 1;
        return { release() {} };
      },
    };

    await expect(new LLMComputeAdapter(registry, budget, capacity).compute(request))
      .rejects.toThrow("llm_compute_grant_expired");
    expect(backend.seen).toHaveLength(0);
    expect(settlement).toEqual({
      state: "settled", tokens_used: 0, tokens_usage_status: "not_invoked", compute_ms: 0,
      cost: { status: "actual", amount: 0, currency: "USD", source: "not_invoked" },
    });
  });

  it("keeps an in-flight provider result unknown when configuration changes", async () => {
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const backend: LLMBackend = {
      name: "fixture-provider",
      async call(_request, signal) {
        markProviderStarted();
        return await new Promise<LLMResponse>((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("aborted"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    };
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    const request = computeRequest();
    request.budget_scope = { parent_task_identity_digest: "c".repeat(64), task_identity_digest: "d".repeat(64) };
    let settlement: Parameters<ComputeBudgetPort["settle"]>[1] | undefined;
    const budget: ComputeBudgetPort = {
      reserve(input) {
        return {
          reservation_id: "9".repeat(64), reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms, reserved_cost: input.reserved_cost,
        };
      },
      settle(_id, value) { settlement = value; },
    };
    const pending = new LLMComputeAdapter(registry, budget).compute(request);
    await providerStarted;
    registry.invalidateProviderConfiguration();

    await expect(pending).rejects.toThrow();
    expect(settlement).toMatchObject({
      state: "unknown", tokens_usage_status: "unknown",
      cost: { status: "unknown", reason: "provider_call_outcome_unknown" },
    });
  });

  it("releases an acquired capacity lease when cancellation arrives while admission is pending", async () => {
    const backend = new CapturingBackend();
    const controller = new AbortController();
    let resolveLease!: (lease: { release(): void }) => void;
    let released = 0;
    const capacity: ComputeCapacityPort = {
      acquire() {
        return new Promise((resolve) => { resolveLease = resolve; });
      },
    };
    const pending = new LLMComputeAdapter(backend, undefined, capacity).compute(computeRequest(), controller.signal);
    controller.abort();
    resolveLease({ release() { released += 1; } });

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(released).toBe(1);
    expect(backend.seen).toHaveLength(0);
  });

  it("cancels a pending capacity admission when provider configuration changes", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend).setDefault("fixture-provider");
    let resolveLease!: (lease: { release(): void }) => void;
    let admissionSignal: AbortSignal | undefined;
    let released = 0;
    const capacity: ComputeCapacityPort = {
      acquire({ signal }) {
        admissionSignal = signal;
        return new Promise((resolve) => { resolveLease = resolve; });
      },
    };
    const pending = new LLMComputeAdapter(registry, undefined, capacity).compute(computeRequest());
    await Promise.resolve();
    registry.invalidateProviderConfiguration();

    expect(admissionSignal?.aborted).toBe(true);
    resolveLease({ release() { released += 1; } });
    await expect(pending).rejects.toMatchObject({ kind: "cancelled", retryable: false });
    expect(released).toBe(1);
    expect(backend.seen).toHaveLength(0);
  });

  it("returns a reservation when cancellation arrives before the backend is invoked", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    const request = computeRequest();
    request.budget_scope = { parent_task_identity_digest: "c".repeat(64), task_identity_digest: "d".repeat(64) };
    let markReserveStarted!: () => void;
    const reserveStarted = new Promise<void>((resolve) => { markReserveStarted = resolve; });
    let resolveReservation!: (reservation: Awaited<ReturnType<ComputeBudgetPort["reserve"]>>) => void;
    const reservationPending = new Promise<Awaited<ReturnType<ComputeBudgetPort["reserve"]>>>((resolve) => {
      resolveReservation = resolve;
    });
    let settlement: Parameters<ComputeBudgetPort["settle"]>[1] | undefined;
    const budget: ComputeBudgetPort = {
      reserve() {
        markReserveStarted();
        return reservationPending;
      },
      settle(_id, value) { settlement = value; },
    };
    const controller = new AbortController();
    const pending = new LLMComputeAdapter(registry, budget).compute(request, controller.signal);
    await reserveStarted;
    controller.abort();
    resolveReservation({
      reservation_id: "9".repeat(64), reserved_tokens: 128, reserved_compute_ms: 2_000,
      reserved_cost: { amount: 0.25, currency: "USD", source: "CONFIG" },
    });

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(backend.seen).toHaveLength(0);
    expect(settlement).toEqual({
      state: "settled", tokens_used: 0, tokens_usage_status: "not_invoked", compute_ms: 0,
      cost: { status: "actual", amount: 0, currency: "USD", source: "not_invoked" },
    });
  });

  it("acquires provider capacity before the provider and releases it after completion", async () => {
    const events: string[] = [];
    class OrderedBackend extends CapturingBackend {
      override async call(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        events.push("provider");
        return super.call(request, signal);
      }
    }
    const capacity: ComputeCapacityPort = {
      async acquire(input) {
        expect(input.timeout_ms).toBe(2_000);
        events.push("admitted");
        return { release: () => events.push("released") };
      },
    };

    await new LLMComputeAdapter(new OrderedBackend(), undefined, capacity).compute(computeRequest());
    expect(events).toEqual(["admitted", "provider", "released"]);
  });

  it("reserves configured system/parent/task resources before the provider and settles the result", async () => {
    const events: string[] = [];
    class OrderedBackend extends CapturingBackend {
      private callCount = 0;
      override async call(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        events.push("provider");
        this.callCount += 1;
        if (this.callCount === 1) {
          throw new LLMProviderError("temporary provider outage", {
            provider: this.name,
            kind: "remote_service_unavailable",
            retryable: true,
            status: 503,
          });
        }
        return { ...(await super.call(request, signal)), tokens_usage_status: "provider_reported" };
      }
    }
    const backend = new OrderedBackend();
    const registry = new LLMRegistry({ retry: { max_attempts: 2 }, sleep: async () => {} })
      .register(backend, [], {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.25, currency: "USD" },
      })
      .setDefault("fixture-provider");
    const budget: ComputeBudgetPort = {
      reserve(input) {
        events.push("reserve");
        expect(input.scope.parent_task_identity_digest).toBe("c".repeat(64));
        expect(input.scope.task_identity_digest).toBe("d".repeat(64));
        expect(input.reserved_tokens).toBe(256);
        expect(input.reserved_compute_ms).toBe(6_000);
        expect(input.reserved_cost).toEqual({ amount: 0.5, currency: "USD", source: "CONFIG" });
        return {
          reservation_id: "e".repeat(64),
          reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms,
          reserved_cost: input.reserved_cost,
        };
      },
      settle(id, settlement) {
        events.push("settle");
        expect(id).toBe("e".repeat(64));
        expect(settlement.tokens_usage_status).toBe("unknown");
        expect(settlement.cost.status).toBe("unknown");
      },
    };
    const request = computeRequest();
    request.budget_scope = {
      parent_task_identity_digest: "c".repeat(64),
      task_identity_digest: "d".repeat(64),
    };

    await new LLMComputeAdapter(registry, budget).compute(request);
    expect(events).toEqual(["reserve", "provider", "provider", "settle"]);
  });

  it("holds before provider invocation when no configured cost upper bound exists", async () => {
    const backend = new CapturingBackend();
    const registry = new LLMRegistry().register(backend).setDefault("fixture-provider");
    let reservations = 0;
    const budget: ComputeBudgetPort = {
      reserve() {
        reservations += 1;
        throw new Error("reserve should not be reached without a cost bound");
      },
      settle() {},
    };
    const request = computeRequest();
    request.budget_scope = {
      parent_task_identity_digest: "c".repeat(64),
      task_identity_digest: "d".repeat(64),
    };

    await expect(new LLMComputeAdapter(registry, budget).compute(request))
      .rejects.toThrow("llm_compute_budget_cost_upper_bound_unavailable");
    expect(backend.seen).toHaveLength(0);
    expect(reservations).toBe(0);
  });

  it("keeps the full reservation when the provider call outcome is unknown", async () => {
    class FailingBackend implements LLMBackend {
      readonly name = "fixture-provider";
      async call(): Promise<LLMResponse> {
        throw new LLMProviderError("provider outcome uncertain", {
          provider: this.name,
          kind: "remote_service_unavailable",
          retryable: false,
          status: 503,
        });
      }
    }
    const registry = new LLMRegistry().register(new FailingBackend(), [], {
      capabilities: ["llm.text.generate"],
      max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    const events: string[] = [];
    const budget: ComputeBudgetPort = {
      reserve() {
        events.push("reserve");
        return {
          reservation_id: "f".repeat(64),
          reserved_tokens: 128,
          reserved_compute_ms: 2_000,
          reserved_cost: { amount: 0.25, currency: "USD", source: "CONFIG" },
        };
      },
      settle(id, settlement) {
        events.push("settle");
        expect(id).toBe("f".repeat(64));
        expect(settlement.state).toBe("unknown");
        expect(settlement.tokens_usage_status).toBe("unknown");
        expect(settlement.cost.status).toBe("unknown");
      },
    };
    const request = computeRequest();
    request.budget_scope = {
      parent_task_identity_digest: "c".repeat(64),
      task_identity_digest: "d".repeat(64),
    };

    await expect(new LLMComputeAdapter(registry, budget).compute(request))
      .rejects.toMatchObject({
        original_error: { kind: "remote_service_unavailable" },
        compute_resource_use: {
          schema_version: "blue-tanuki.compute-resource-use.v1",
          request_digest: createHash("sha256").update("blue-tanuki.compute-resource-use.request.v1\0request-1").digest("hex"),
          charged_compute_ms: 2_000,
          charged_tokens: 128,
          tokens_usage_status: "unknown",
          cost_status: "unknown",
          charged_cost_amount: 0.25,
          currency: "USD",
          charge_basis: "reserved_upper_bound",
          used_for_authority: false,
          may_execute: false,
        },
      });
    expect(events).toEqual(["reserve", "settle"]);
  });

  it("returns budget-settled resource evidence with the provider result", async () => {
    const request = computeRequest();
    request.budget_scope = { parent_task_identity_digest: "c".repeat(64), task_identity_digest: "d".repeat(64) };
    let settled = false;
    const budget: ComputeBudgetPort = {
      reserve(input) {
        return { reservation_id: "a".repeat(64), reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms, reserved_cost: input.reserved_cost };
      },
      settle(_id, settlement) {
        settled = true;
        expect(settlement.state).toBe("settled");
        expect(settlement.tokens_usage_status).toBe("unknown");
      },
    };
    const registry = new LLMRegistry().register(new CapturingBackend(), [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.4, currency: "USD" },
    }).setDefault("fixture-provider");
    const result = await new LLMComputeAdapter(registry, budget).compute(request);
    expect(settled).toBe(true);
    expect(result.compute_resource_use).toMatchObject({
      request_digest: createHash("sha256").update("blue-tanuki.compute-resource-use.request.v1\0request-1").digest("hex"),
      charged_compute_ms: expect.any(Number),
      charged_tokens: 128,
      tokens_usage_status: "unknown",
      cost_status: "unknown",
      charged_cost_amount: 0.4,
      currency: "USD",
      charge_basis: "reserved_upper_bound",
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("binds provider execution identity and keeps compute metadata local", async () => {
    const backend = new CapturingBackend();
    const controller = new AbortController();
    const request = computeRequest();
    const result = await new LLMComputeAdapter(backend).compute(request, controller.signal);

    expect(backend.seen).toEqual([request.input]);
    expect(backend.lastSignal).toBe(controller.signal);
    expect(backend.seen[0]).not.toHaveProperty("execution_identity");
    expect(result).not.toHaveProperty("raw");
    expect(result.provider).toBe("fixture-provider");
    expect(result.execution_identity).toMatchObject({
      request_id: "request-1",
      current_projection_digest: "a".repeat(64),
      input_digest: request.input_digest,
      output_digest: createHash("sha256").update(JSON.stringify({
        content: "fixture response",
        tokens_used: 7,
        model: "fixture-model-v1",
        provider: "fixture-provider",
      })).digest("hex"),
      local_p_version: "blue-tanuki.c-input-rules.v1",
      provider: { requested: "fixture-provider", actual: "fixture-provider" },
      model: { requested: "fixture-model-v1", actual: "fixture-model-v1" },
      resource_limits: { max_tokens: 128, timeout_ms: 2_000 },
    });
    expect(result.cost).toEqual({
      status: "unknown",
      reason: "provider_did_not_report_monetary_cost",
    });
    expect(result.authority_boundary).toEqual({
      compute_output_used_for_authority: false,
      provider_metadata_used_for_authority: false,
      used_for_authority: false,
    });
    expect(result.execution_identity.provider.fallback).toEqual({ used: false });
  });

  it("settles a bounded backend cost estimate without exposing the estimate in the response", async () => {
    const backend: LLMBackend = {
      name: "fixture-provider",
      async call(): Promise<LLMResponse> {
        return {
          content: "estimated response",
          tokens_used: 7,
          model: "fixture-model-v1",
          resource_cost_estimate: { amount: 0, currency: "USD", source: "local_synthetic_backend" },
        };
      },
    };
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"],
      max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    const request = computeRequest();
    request.budget_scope = {
      parent_task_identity_digest: "c".repeat(64),
      task_identity_digest: "d".repeat(64),
    };
    let settledCost: unknown;
    const budget: ComputeBudgetPort = {
      reserve(input) {
        return {
          reservation_id: "9".repeat(64),
          reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms,
          reserved_cost: input.reserved_cost,
        };
      },
      settle(_id, settlement) {
        settledCost = settlement.cost;
      },
    };

    const result = await new LLMComputeAdapter(registry, budget).compute(request);

    expect(settledCost).toEqual({
      status: "estimated",
      amount: 0,
      currency: "USD",
      source: "local_synthetic_backend",
    });
    expect(result.cost).toEqual(settledCost);
    expect(result).not.toHaveProperty("resource_cost_estimate");
    expect(result.compute_resource_use).toMatchObject({
      cost_status: "estimated",
      charged_cost_amount: 0,
      currency: "USD",
      charge_basis: "configured_estimate",
      used_for_authority: false,
      may_execute: false,
    });
  });

  it.each([
    ["over the configured bound", { amount: 0.26, currency: "USD", source: "provider" }],
    ["in another currency", { amount: 0.1, currency: "EUR", source: "provider" }],
    ["without a source", { amount: 0.1, currency: "USD", source: "  " }],
  ] as const)("keeps a cost estimate unknown when it is %s", async (_reason, estimate) => {
    const backend: LLMBackend = {
      name: "fixture-provider",
      async call(): Promise<LLMResponse> {
        return {
          content: "estimated response",
          tokens_used: 7,
          model: "fixture-model-v1",
          resource_cost_estimate: estimate,
        };
      },
    };
    const registry = new LLMRegistry().register(backend, [], {
      capabilities: ["llm.text.generate"],
      max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");

    const result = await new LLMComputeAdapter(registry).compute(computeRequest());

    expect(result.cost).toEqual({
      status: "unknown",
      reason: "provider_did_not_report_monetary_cost",
    });
    expect(result).not.toHaveProperty("resource_cost_estimate");
  });

  it("records a permitted provider switch and bounded estimated cost in execution identity", async () => {
    class Primary implements LLMBackend {
      readonly name = "primary";
      calls = 0;
      async call(): Promise<LLMResponse> {
        this.calls += 1;
        throw new LLMProviderError("primary unavailable", {
          provider: this.name,
          kind: "remote_service_unavailable",
          retryable: true,
          status: 503,
        });
      }
    }
    class Backup implements LLMBackend {
      readonly name = "backup";
      readonly seen: LLMRequest[] = [];
      async call(request: LLMRequest): Promise<LLMResponse> {
        this.seen.push(request);
        return { content: "backup response", tokens_used: 2, model: "backup-model" };
      }
    }
    const primary = new Primary();
    const backup = new Backup();
    const registry = new LLMRegistry({ retry: { max_attempts: 2, max_delay_ms: 37 }, sleep: async () => {} })
      .register(primary)
      .register(backup)
      .setDefault("primary")
      .setFallback("backup")
      .setFallbackProfile("primary", {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.1, currency: "USD" },
      })
      .setFallbackProfile("backup", {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.05, currency: "USD" },
      });
    const request = computeRequest();
    request.data_exposure_scope.requested_egress_provider = "registry-default";
    request.input.backend_hint = undefined;
    request.input_digest = digestLLMRequest(request.input);
    request.fallback_authorization = {
      allowed_providers: ["backup"],
      allowed_input_sources: ["accepted_inbound_request", "selected_memory_references"],
      required_capabilities: ["llm.text.generate"],
      max_total_cost: { amount: 0.3, currency: "USD" },
    };
    expect(registry.maximumCostForCall(request.input, request.fallback_authorization)).toEqual({
      amount: 0.3,
      currency: "USD",
      source: "CONFIG",
    });
    expect(registry.maximumCallsForRequest(request.input, request.fallback_authorization)).toBe(4);
    expect(registry.maximumComputeMsForRequest(request.input, 2_000, request.fallback_authorization)).toBe(8_074);
    request.budget_scope = {
      parent_task_identity_digest: "c".repeat(64),
      task_identity_digest: "d".repeat(64),
    };
    let reserved: Parameters<ComputeBudgetPort["reserve"]>[0] | undefined;
    let reservationCount = 0;
    const budget: ComputeBudgetPort = {
      reserve(input) {
        reservationCount += 1;
        reserved = input;
        return {
          reservation_id: "f".repeat(64),
          reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms,
          reserved_cost: input.reserved_cost,
        };
      },
      settle() {},
    };

    const result = await new LLMComputeAdapter(registry, budget).compute(request);

    expect(primary.calls).toBe(2);
    expect(backup.seen).toHaveLength(1);
    expect(reserved).toMatchObject({ reserved_tokens: 512, reserved_compute_ms: 8_074 });
    expect(backup.seen[0]).toEqual(request.input);
    expect(result.execution_identity.provider).toEqual({
      requested: "registry-default",
      actual: "backup",
      fallback: {
        used: true,
        from_provider: "primary",
        failure_kind: "remote_service_unavailable",
        allowed_providers: ["backup"],
        allowed_input_sources: ["accepted_inbound_request", "selected_memory_references"],
        required_capabilities: ["llm.text.generate"],
        max_total_cost: { amount: 0.3, currency: "USD" },
        estimated_total_cost: {
          amount: 0.3,
          currency: "USD",
          source: "CONFIG",
        },
      },
    });
    expect(result.cost).toEqual({
      status: "estimated",
      amount: 0.3,
      currency: "USD",
      source: "CONFIG",
    });
    expect(result.authority_boundary.used_for_authority).toBe(false);

    const overflowRequest: ComputeRequest<LLMRequest> = {
      ...request,
      request_id: "request-overflow",
      resource_limits: { ...request.resource_limits, timeout_ms: Number.MAX_SAFE_INTEGER },
    };
    await expect(new LLMComputeAdapter(registry, budget).compute(overflowRequest))
      .rejects.toThrow("llm_compute_budget_compute_upper_bound_unavailable");
    expect(reservationCount).toBe(1);
    expect(primary.calls).toBe(2);
    expect(backup.seen).toHaveLength(1);

    const historyRequest = computeRequest();
    historyRequest.data_exposure_scope = {
      ...historyRequest.data_exposure_scope,
      requested_egress_provider: "registry-default",
      input_sources: ["accepted_inbound_request", "session_history"],
    };
    historyRequest.input.backend_hint = undefined;
    historyRequest.input_digest = digestLLMRequest(historyRequest.input);
    historyRequest.fallback_authorization = {
      allowed_providers: ["backup"],
      allowed_input_sources: ["accepted_inbound_request"],
      required_capabilities: ["llm.text.generate"],
      max_total_cost: { amount: 0.3, currency: "USD" },
    };
    await expect(new LLMComputeAdapter(registry).compute(historyRequest))
      .rejects.toMatchObject({ provider: "primary", kind: "remote_service_unavailable" });
    expect(backup.seen).toHaveLength(1);

    const failureReviewRequest = computeRequest();
    failureReviewRequest.data_exposure_scope = {
      requested_egress_provider: "registry-default",
      input_sources: ["accepted_inbound_request", "failure_memory_digest_projection"],
    };
    failureReviewRequest.input.backend_hint = undefined;
    failureReviewRequest.input_digest = digestLLMRequest(failureReviewRequest.input);
    failureReviewRequest.fallback_authorization = {
      allowed_providers: ["backup"],
      allowed_input_sources: ["accepted_inbound_request"],
      required_capabilities: ["llm.text.generate"],
      max_total_cost: { amount: 0.3, currency: "USD" },
    };
    await expect(new LLMComputeAdapter(registry).compute(failureReviewRequest))
      .rejects.toMatchObject({ provider: "primary", kind: "remote_service_unavailable" });
    expect(backup.seen).toHaveLength(1);
  });

  it("rejects provider-route mismatch before making a provider call", async () => {
    const backend = new CapturingBackend();
    const request = computeRequest();
    request.data_exposure_scope.requested_egress_provider = "other-provider";

    await expect(new LLMComputeAdapter(backend).compute(request)).rejects.toThrow(
      /does not match its data exposure scope/,
    );
    expect(backend.seen).toHaveLength(0);
  });

  it("rejects a profile intended for another Compute implementation", async () => {
    const backend = new CapturingBackend();
    const request = computeRequest();
    request.c_profile = { id: "blue-tanuki.mini-dora", version: "1" };

    await expect(new LLMComputeAdapter(backend).compute(request)).rejects.toThrow(
      /profile does not match this adapter/,
    );
    expect(backend.seen).toHaveLength(0);
  });

  it("allows a non-LLM Mini Dora fixture to use the same non-authority contract", async () => {
    const miniDora: ComputeBackend<
      { candidate_count: number },
      { candidate_count: number }
    > = {
      async compute(request) {
        return {
          candidate_count: request.input.candidate_count,
          execution_identity: {
            request_id: request.request_id,
            current_projection_digest: request.current_projection_digest,
            input_digest: request.input_digest,
            output_digest: "f".repeat(64),
            c_profile: request.c_profile,
            local_p_version: request.local_p_version,
            provider: { requested: "mini-dora-local", actual: "mini-dora-local", fallback: { used: false } },
            model: { requested: null, actual: "mini-dora-v1" },
            data_exposure_scope: request.data_exposure_scope,
            resource_limits: { max_tokens: null, timeout_ms: null },
          },
          cost: { status: "unknown", reason: "local_fixture_has_no_monetary_cost" },
          authority_boundary: {
            compute_output_used_for_authority: false,
            provider_metadata_used_for_authority: false,
            used_for_authority: false,
          },
        };
      },
    };
    const result = await miniDora.compute({
      request_id: "mini-dora-fixture-1",
      current_projection_digest: "d".repeat(64),
      input_digest: "e".repeat(64),
      c_profile: { id: "blue-tanuki.mini-dora", version: "1" },
      local_p_version: "blue-tanuki.c-input-rules.v1",
      data_exposure_scope: {
        input_sources: ["accepted_inbound_request"],
        requested_egress_provider: "mini-dora-local",
      },
      resource_limits: {},
      input: { candidate_count: 2 },
    });

    expect(result.candidate_count).toBe(2);
    expect(result.execution_identity.c_profile).toEqual({ id: "blue-tanuki.mini-dora", version: "1" });
    expect(result.authority_boundary.used_for_authority).toBe(false);
  });
});
