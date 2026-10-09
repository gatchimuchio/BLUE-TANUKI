import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LLMBackend, LLMRequest, LLMResponse } from "../src/llm/base.js";
import {
  LLMComputeAdapter,
  LLM_COMPUTE_PROFILE,
  type ComputeBackend,
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
            provider: { requested: "mini-dora-local", actual: "mini-dora-local" },
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
