import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "../src/llm/base.js";
import { LLMRegistry } from "../src/llm/registry.js";
import {
  LLMComputeAdapter,
  LLM_COMPUTE_PROFILE,
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
  return {
    request_id: "request-1",
    current_projection_digest: "a".repeat(64),
    input_digest: "b".repeat(64),
    c_profile: LLM_COMPUTE_PROFILE,
    local_p_version: "blue-tanuki.c-input-rules.v1",
    data_exposure_scope: {
      input_sources: ["accepted_inbound_request", "selected_memory_references"],
      requested_egress_provider: "fixture-provider",
    },
    resource_limits: { max_tokens: 128, timeout_ms: 2_000 },
    input: {
      backend_hint: "fixture-provider",
      model: "fixture-model-v1",
      messages: [{ role: "user", content: "fixture prompt" }],
    },
  };
}

describe("LLMComputeAdapter", () => {
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
      .rejects.toMatchObject({ kind: "remote_service_unavailable" });
    expect(events).toEqual(["reserve", "settle"]);
  });

  it("binds provider execution identity and keeps compute metadata local", async () => {
    const backend = new CapturingBackend();
    const controller = new AbortController();
    const result = await new LLMComputeAdapter(backend).compute(computeRequest(), controller.signal);

    expect(backend.seen).toEqual([computeRequest().input]);
    expect(backend.lastSignal).toBe(controller.signal);
    expect(backend.seen[0]).not.toHaveProperty("execution_identity");
    expect(result).not.toHaveProperty("raw");
    expect(result.provider).toBe("fixture-provider");
    expect(result.execution_identity).toMatchObject({
      request_id: "request-1",
      current_projection_digest: "a".repeat(64),
      input_digest: "b".repeat(64),
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

  it("records a permitted provider switch and bounded estimated cost in execution identity", async () => {
    class Primary implements LLMBackend {
      readonly name = "primary";
      async call(): Promise<LLMResponse> {
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
    const registry = new LLMRegistry({ retry: { max_attempts: 1 } })
      .register(primary)
      .register(backup)
      .setDefault("primary")
      .setFallback("backup")
      .setFallbackProfile("primary", {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.2, currency: "USD" },
      })
      .setFallbackProfile("backup", {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.1, currency: "USD" },
      });
    const request = computeRequest();
    request.data_exposure_scope.requested_egress_provider = "registry-default";
    request.input.backend_hint = undefined;
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
    expect(registry.maximumCallsForRequest(request.input, request.fallback_authorization)).toBe(2);

    const result = await new LLMComputeAdapter(registry).compute(request);

    expect(backup.seen).toHaveLength(1);
    expect(backup.seen[0]).toEqual(request.input);
    expect(result.execution_identity.provider).toEqual({
      requested: "registry-default",
      actual: "backup",
      fallback: {
        used: true,
        from_provider: "primary",
        failure_kind: "remote_service_unavailable",
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

    const historyRequest = computeRequest();
    historyRequest.data_exposure_scope = {
      ...historyRequest.data_exposure_scope,
      requested_egress_provider: "registry-default",
      input_sources: ["accepted_inbound_request", "session_history"],
    };
    historyRequest.input.backend_hint = undefined;
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
