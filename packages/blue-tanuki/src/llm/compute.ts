import { createHash } from "node:crypto";
import type { LLMBackend, LLMRequest, LLMResponse } from "./base.js";

export const LLM_COMPUTE_PROFILE = Object.freeze({
  id: "blue-tanuki.llm-call",
  version: "1",
} as const);

export interface ComputeProfile {
  id: string;
  version: string;
}

export type ComputeInputSource =
  | "accepted_inbound_request"
  | "selected_memory_references"
  | "session_history";

export interface ComputeDataExposureScope {
  input_sources: readonly ComputeInputSource[];
  requested_egress_provider: string;
}

export interface ComputeRequest<TInput extends object = Record<string, never>> {
  request_id: string;
  current_projection_digest: string;
  input_digest: string;
  c_profile: ComputeProfile;
  local_p_version: string;
  data_exposure_scope: ComputeDataExposureScope;
  resource_limits: {
    max_tokens?: number;
    timeout_ms?: number;
  };
  input: TInput;
}

export type ComputeCost =
  | { status: "actual" | "estimated"; amount: number; currency: string; source: string }
  | { status: "unknown"; reason: string };

export type ComputeResult<TOutput extends object = Record<string, never>> = TOutput & {
  execution_identity: {
    request_id: string;
    current_projection_digest: string;
    input_digest: string;
    output_digest: string;
    c_profile: ComputeProfile;
    local_p_version: string;
    provider: {
      requested: string;
      actual: string;
    };
    model: {
      requested: string | null;
      actual: string;
    };
    data_exposure_scope: ComputeDataExposureScope;
    resource_limits: {
      max_tokens: number | null;
      timeout_ms: number | null;
    };
  };
  cost: ComputeCost;
  authority_boundary: {
    compute_output_used_for_authority: false;
    provider_metadata_used_for_authority: false;
    used_for_authority: false;
  };
};

/** Cの計算契約。権限・承認・操作発行はこの境界に含めない。 */
export interface ComputeBackend<
  TInput extends object = Record<string, never>,
  TOutput extends object = Record<string, never>,
> {
  compute(request: ComputeRequest<TInput>): Promise<ComputeResult<TOutput>>;
}

/** 既存のLLM providerを共通Compute契約へ接続するadapter。 */
export class LLMComputeAdapter implements ComputeBackend<LLMRequest, LLMResponse> {
  constructor(private readonly backend: LLMBackend) {}

  async compute(request: ComputeRequest<LLMRequest>): Promise<ComputeResult<LLMResponse>> {
    validateComputeRequest(request);
    const response = await this.backend.call(request.input);
    const provider = this.backend.canonical_provider_identity === true
      ? (response.provider ?? "").trim()
      : this.backend.name.trim();
    const model = response.model.trim();
    if (!provider) throw new Error("compute backend returned no provider identity");
    if (!model) throw new Error("compute backend returned no model identity");
    const normalizedResponse = { ...response, provider, model };

    return {
      ...normalizedResponse,
      execution_identity: {
        request_id: request.request_id,
        current_projection_digest: request.current_projection_digest,
        input_digest: request.input_digest,
        output_digest: createHash("sha256").update(JSON.stringify(normalizedResponse)).digest("hex"),
        c_profile: { ...request.c_profile },
        local_p_version: request.local_p_version,
        provider: {
          requested: request.data_exposure_scope.requested_egress_provider,
          actual: provider,
        },
        model: {
          requested: request.input.model ?? null,
          actual: model,
        },
        data_exposure_scope: {
          input_sources: [...request.data_exposure_scope.input_sources],
          requested_egress_provider: request.data_exposure_scope.requested_egress_provider,
        },
        resource_limits: {
          max_tokens: request.resource_limits.max_tokens ?? null,
          timeout_ms: request.resource_limits.timeout_ms ?? null,
        },
      },
      cost: {
        status: "unknown",
        reason: "provider_did_not_report_monetary_cost",
      },
      authority_boundary: {
        compute_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
        used_for_authority: false,
      },
    };
  }
}

function validateComputeRequest(request: ComputeRequest<LLMRequest>): void {
  const digest = /^[a-f0-9]{64}$/;
  if (!request.request_id.trim()) throw new Error("compute request_id is required");
  if (!digest.test(request.current_projection_digest)) {
    throw new Error("compute projection digest must be a SHA-256 hex digest");
  }
  if (!digest.test(request.input_digest)) {
    throw new Error("compute input digest must be a SHA-256 hex digest");
  }
  if (!request.local_p_version.trim()) throw new Error("compute local P version is required");
  if (
    request.c_profile.id !== LLM_COMPUTE_PROFILE.id ||
    request.c_profile.version !== LLM_COMPUTE_PROFILE.version
  ) {
    throw new Error("LLM compute profile does not match this adapter");
  }
  if (request.data_exposure_scope.input_sources.length === 0) {
    throw new Error("compute data exposure sources are required");
  }
  if (new Set(request.data_exposure_scope.input_sources).size !== request.data_exposure_scope.input_sources.length) {
    throw new Error("compute data exposure sources must be unique");
  }
  if (!request.data_exposure_scope.requested_egress_provider.trim()) {
    throw new Error("compute requested egress provider is required");
  }
  const requestedProvider = request.input.backend_hint?.trim() || "registry-default";
  if (requestedProvider !== request.data_exposure_scope.requested_egress_provider) {
    throw new Error("compute requested provider does not match its data exposure scope");
  }
  for (const [name, value] of Object.entries(request.resource_limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`compute resource limit ${name} must be a positive safe integer`);
    }
  }
}
