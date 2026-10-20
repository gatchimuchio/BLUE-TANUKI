import { createHash } from "node:crypto";
import { LLMFallbackAuthorizationSchema, type LLMFallbackAuthorization } from "@blue-tanuki/protocol";
import {
  LLM_ROUTING_TRACE,
  normalizeLLMToolCallCandidates,
  type LLMBackend,
  type LLMErrorKind,
  type LLMRequest,
  type LLMResponse,
} from "./base.js";
import { LLMRegistry } from "./registry.js";

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
  | "selected_operation_result_observations"
  | "failure_memory_digest_projection"
  | "session_history";

export interface ComputeDataExposureScope {
  input_sources: readonly ComputeInputSource[];
  requested_egress_provider: string;
}

export interface ComputeBudgetScope {
  parent_task_identity_digest: string;
  task_identity_digest: string;
}

export interface ComputeBudgetCostBound {
  amount: number;
  currency: string;
  source: "CONFIG";
}

export interface ComputeBudgetLimit {
  max_tokens: number;
  max_compute_ms: number;
  max_cost: { amount: number; currency: string };
}

/** Owner-configured cumulative resource caps, rotated by a fixed accounting window. */
export interface ComputeBudgetPolicy {
  window_ms: number;
  currency: string;
  system: ComputeBudgetLimit;
  parent: ComputeBudgetLimit;
  task: ComputeBudgetLimit;
}

/** Offline default: finite usage windows and no monetary spend. */
export const DEFAULT_COMPUTE_BUDGET_POLICY: ComputeBudgetPolicy = Object.freeze({
  window_ms: 86_400_000,
  currency: "USD",
  system: Object.freeze({
    max_tokens: 1_000_000,
    max_compute_ms: 86_400_000,
    max_cost: Object.freeze({ amount: 0, currency: "USD" }),
  }),
  parent: Object.freeze({
    max_tokens: 100_000,
    max_compute_ms: 3_600_000,
    max_cost: Object.freeze({ amount: 0, currency: "USD" }),
  }),
  task: Object.freeze({
    max_tokens: 10_000,
    max_compute_ms: 300_000,
    max_cost: Object.freeze({ amount: 0, currency: "USD" }),
  }),
});

export interface ComputeBudgetReservation {
  reservation_id: string;
  reserved_tokens: number;
  reserved_compute_ms: number;
  reserved_cost: ComputeBudgetCostBound;
}

export interface ComputeBudgetSettlement {
  state: "settled" | "unknown";
  tokens_used: number;
  tokens_usage_status: "provider_reported" | "unknown";
  compute_ms: number;
  cost: ComputeCost;
}

/** Durable resource ledger port; it records non-authority resource evidence only. */
export interface ComputeBudgetPort {
  reserve(input: {
    request_id: string;
    scope: ComputeBudgetScope;
    reserved_tokens: number;
    reserved_compute_ms: number;
    reserved_cost: ComputeBudgetCostBound;
  }): Promise<ComputeBudgetReservation> | ComputeBudgetReservation;
  settle(reservation_id: string, settlement: ComputeBudgetSettlement): Promise<void> | void;
}

export interface ComputeRequest<TInput extends object = Record<string, never>> {
  request_id: string;
  current_projection_digest: string;
  input_digest: string;
  c_profile: ComputeProfile;
  local_p_version: string;
  data_exposure_scope: ComputeDataExposureScope;
  budget_scope?: ComputeBudgetScope;
  fallback_authorization?: LLMFallbackAuthorization;
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
      fallback: { used: false } | {
        used: true;
        from_provider: string;
        failure_kind: LLMErrorKind;
        allowed_input_sources: string[];
        required_capabilities: string[];
        max_total_cost: { amount: number; currency: string };
        estimated_total_cost: { amount: number; currency: string; source: string };
      };
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
  compute(request: ComputeRequest<TInput>, signal?: AbortSignal): Promise<ComputeResult<TOutput>>;
}

/** 既存のLLM providerを共通Compute契約へ接続するadapter。 */
export class LLMComputeAdapter implements ComputeBackend<LLMRequest, LLMResponse> {
  constructor(
    private readonly backend: LLMBackend,
    private readonly budget?: ComputeBudgetPort,
  ) {}

  async compute(request: ComputeRequest<LLMRequest>, signal?: AbortSignal): Promise<ComputeResult<LLMResponse>> {
    const fallbackAuthorization = validateComputeRequest(request);
    let reservation: ComputeBudgetReservation | undefined;
    let maximumCalls = 1;
    if (this.budget) {
      if (!request.budget_scope) throw new Error("llm_compute_budget_scope_missing");
      const maxCost = this.backend instanceof LLMRegistry
        ? this.backend.maximumCostForCall(request.input, fallbackAuthorization)
        : undefined;
      if (!maxCost) throw new Error("llm_compute_budget_cost_upper_bound_unavailable");
      const maxTokens = request.resource_limits.max_tokens;
      const timeoutMs = request.resource_limits.timeout_ms;
      if (maxTokens === undefined || timeoutMs === undefined) {
        throw new Error("llm_compute_budget_resource_limit_missing");
      }
      maximumCalls = this.backend instanceof LLMRegistry
        ? this.backend.maximumCallsForRequest(request.input, fallbackAuthorization)
        : 1;
      reservation = await this.budget.reserve({
        request_id: request.request_id,
        scope: request.budget_scope,
        reserved_tokens: maxTokens * maximumCalls,
        reserved_compute_ms: timeoutMs,
        reserved_cost: maxCost,
      });
    }
    const startedAt = Date.now();
    let response: LLMResponse;
    try {
      response = this.backend instanceof LLMRegistry
        ? await this.backend.callWithFallbackAuthorization(request.input, signal, fallbackAuthorization)
        : await this.backend.call(request.input, signal);
    } catch (error) {
      if (reservation) {
        await this.budget!.settle(reservation.reservation_id, {
          state: "unknown",
          tokens_used: 0,
          tokens_usage_status: "unknown",
          compute_ms: Math.max(0, Date.now() - startedAt),
          cost: { status: "unknown", reason: "provider_call_outcome_unknown" },
        });
      }
      throw error;
    }
    const fallbackTrace = this.backend instanceof LLMRegistry
      ? response[LLM_ROUTING_TRACE]
      : undefined;
    const provider = this.backend.canonical_provider_identity === true
      ? (response.provider ?? "").trim()
      : this.backend.name.trim();
    const model = response.model.trim();
    if (!provider) throw new Error("compute backend returned no provider identity");
    if (!model) throw new Error("compute backend returned no model identity");
    const toolCalls = normalizeLLMToolCallCandidates(provider, response.tool_calls);
    const tokensUsageStatus = response.tokens_usage_status ?? "unknown";
    const normalizedResponse = { ...response };
    delete normalizedResponse.raw;
    delete normalizedResponse.tokens_usage_status;
    delete normalizedResponse[LLM_ROUTING_TRACE];
    Object.assign(normalizedResponse, {
      provider,
      model,
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
    });

    const cost: ComputeCost = fallbackTrace
      ? { status: "estimated", ...fallbackTrace.estimated_total_cost }
      : { status: "unknown", reason: "provider_did_not_report_monetary_cost" };
    if (reservation) {
      await this.budget!.settle(reservation.reservation_id, {
        state: "settled",
        tokens_used: response.tokens_used,
        tokens_usage_status: maximumCalls === 1 ? tokensUsageStatus : "unknown",
        compute_ms: Math.max(0, Date.now() - startedAt),
        cost,
      });
    }

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
          fallback: fallbackTrace && fallbackAuthorization
            ? {
                used: true,
                from_provider: fallbackTrace.from_provider,
                failure_kind: fallbackTrace.failure_kind,
                allowed_input_sources: [...fallbackAuthorization.allowed_input_sources],
                required_capabilities: [...fallbackAuthorization.required_capabilities],
                max_total_cost: { ...fallbackAuthorization.max_total_cost },
                estimated_total_cost: { ...fallbackTrace.estimated_total_cost },
              }
            : { used: false },
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
      cost,
      authority_boundary: {
        compute_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
        used_for_authority: false,
      },
    };
  }
}

function validateComputeRequest(request: ComputeRequest<LLMRequest>): LLMFallbackAuthorization | undefined {
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
  const parsedFallbackAuthorization = request.fallback_authorization === undefined
    ? undefined
    : LLMFallbackAuthorizationSchema.safeParse(request.fallback_authorization);
  if (parsedFallbackAuthorization && !parsedFallbackAuthorization.success) {
    throw new Error("compute fallback authorization is invalid");
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
  if (!parsedFallbackAuthorization?.success) return undefined;
  const authorization = parsedFallbackAuthorization.data;
  const allowedInputSources = new Set<string>(authorization.allowed_input_sources);
  if (!request.data_exposure_scope.input_sources.every(
    (source) => allowedInputSources.has(source),
  )) return undefined;
  return authorization;
}
