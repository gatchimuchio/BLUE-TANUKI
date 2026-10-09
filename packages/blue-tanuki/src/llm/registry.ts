import {
  classifyLLMError,
  createLLMAbortError,
  LLM_ROUTING_TRACE,
  type LLMBackend,
  type LLMFallbackCostBound,
  type LLMFallbackProfile,
  type LLMErrorKind,
  type LLMRequest,
  type LLMResponse,
} from "./base.js";
import { LLMFallbackAuthorizationSchema, type LLMFallbackAuthorization } from "@blue-tanuki/protocol";

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export interface LLMRetryPolicy {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
}

export interface LLMRegistryOptions {
  defaultName?: string;
  fallbackName?: string;
  retry?: Partial<LLMRetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LLMBackendHealth {
  name: string;
  state: "untested" | "pass" | "fail";
  consecutive_failures: number;
  last_checked_at: string | null;
  last_error_kind: LLMErrorKind | null;
  last_error_retryable: boolean | null;
  retry_after_ms: number | null;
  used_for_authority: false;
  evidence_source: readonly ["INTERNAL_STATE"];
}

export interface LLMRegistryHealthSnapshot {
  schema_version: 1;
  surface: "llm_registry_health";
  default_backend: string | null;
  fallback_backend: string | null;
  fallback_profiles: Array<{
    provider: string;
    capabilities: string[];
    max_cost_per_attempt: LLMFallbackCostBound;
    used_for_authority: false;
  }>;
  retry_policy: LLMRetryPolicy;
  providers: LLMBackendHealth[];
  authority_boundary: {
    llm_output_used_for_authority: false;
    provider_metadata_used_for_authority: false;
    health_metadata_used_for_authority: false;
    used_for_authority: false;
  };
  evidence_source: readonly ["INTERNAL_STATE"];
}

const DEFAULT_RETRY_POLICY: LLMRetryPolicy = {
  max_attempts: 1,
  base_delay_ms: 250,
  max_delay_ms: 2_000,
};

function normalizeRetryPolicy(policy: Partial<LLMRetryPolicy> | undefined): LLMRetryPolicy {
  return {
    max_attempts: Math.max(1, Math.floor(policy?.max_attempts ?? DEFAULT_RETRY_POLICY.max_attempts)),
    base_delay_ms: Math.max(0, Math.floor(policy?.base_delay_ms ?? DEFAULT_RETRY_POLICY.base_delay_ms)),
    max_delay_ms: Math.max(0, Math.floor(policy?.max_delay_ms ?? DEFAULT_RETRY_POLICY.max_delay_ms)),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runtime-selectable backend registry.
 *
 * The registry itself implements LLMBackend so Executor can keep depending on
 * one narrow interface. HDS-BRAIN may attach backend_hint to a command; the
 * registry then resolves that hint to a concrete downstream provider.
 */
export class LLMRegistry implements LLMBackend {
  readonly name = "registry";
  readonly canonical_provider_identity = true as const;
  private readonly backends = new Map<string, LLMBackend>();
  private readonly primaryNames = new Set<string>();
  private readonly fallbackProfiles = new Map<string, LLMFallbackProfile>();
  private readonly health = new Map<string, LLMBackendHealth>();
  private readonly retryPolicy: LLMRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private defaultName: string | undefined;
  private fallbackName: string | undefined;

  constructor(defaultNameOrOptions?: string | LLMRegistryOptions) {
    const opts =
      typeof defaultNameOrOptions === "string"
        ? { defaultName: defaultNameOrOptions }
        : defaultNameOrOptions ?? {};
    this.defaultName = opts.defaultName ? normalizeName(opts.defaultName) : undefined;
    this.fallbackName = opts.fallbackName ? normalizeName(opts.fallbackName) : undefined;
    this.retryPolicy = normalizeRetryPolicy(opts.retry);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  register(
    backend: LLMBackend,
    aliases: readonly string[] = [],
    fallbackProfile?: LLMFallbackProfile,
  ): this {
    const primary = normalizeName(backend.name);
    if (!primary) {
      throw new Error("LLMRegistry: backend name is required");
    }
    this.backends.set(primary, backend);
    this.primaryNames.add(primary);
    if (!this.health.has(primary)) {
      this.health.set(primary, {
        name: primary,
        state: "untested",
        consecutive_failures: 0,
        last_checked_at: null,
        last_error_kind: null,
        last_error_retryable: null,
        retry_after_ms: null,
        used_for_authority: false,
        evidence_source: ["INTERNAL_STATE"],
      });
    }
    for (const alias of aliases) {
      const key = normalizeName(alias);
      if (key) this.backends.set(key, backend);
    }
    if (fallbackProfile) this.setFallbackProfile(primary, fallbackProfile);
    if (!this.defaultName) this.defaultName = primary;
    return this;
  }

  setFallbackProfile(name: string, profile: LLMFallbackProfile): this {
    const key = normalizeName(name);
    const registered = this.backends.get(key);
    if (!registered) {
      throw new Error(`LLMRegistry: fallback profile provider '${name}' is not registered`);
    }
    const canonical = normalizeName(registered.name);
    if (this.fallbackProfiles.has(canonical)) {
      throw new Error(`LLMRegistry: fallback profile for '${canonical}' is already configured`);
    }
    if (!isValidFallbackProfile(profile)) {
      throw new Error(`LLMRegistry: fallback profile for '${canonical}' is invalid`);
    }
    this.fallbackProfiles.set(canonical, {
      capabilities: [...profile.capabilities],
      max_cost_per_attempt: { ...profile.max_cost_per_attempt },
    });
    return this;
  }

  setDefault(name: string): this {
    const key = normalizeName(name);
    if (!this.backends.has(key)) {
      throw new Error(
        `LLMRegistry: default backend '${name}' is not registered; available=${this.list().join(", ")}`,
      );
    }
    this.defaultName = key;
    return this;
  }

  setFallback(name: string | undefined): this {
    if (!name) {
      this.fallbackName = undefined;
      return this;
    }
    const key = normalizeName(name);
    if (!this.backends.has(key)) {
      throw new Error(
        `LLMRegistry: fallback backend '${name}' is not registered; available=${this.list().join(", ")}`,
      );
    }
    this.fallbackName = key;
    return this;
  }

  list(): string[] {
    return Array.from(this.primaryNames).sort();
  }

  resolve(hint?: string): LLMBackend {
    return this.resolveWithName(hint).backend;
  }

  healthSnapshot(): LLMRegistryHealthSnapshot {
    return {
      schema_version: 1,
      surface: "llm_registry_health",
      default_backend: this.defaultName ?? null,
      fallback_backend: this.fallbackName ?? null,
      fallback_profiles: Array.from(this.fallbackProfiles.entries())
        .map(([provider, profile]) => ({
          provider,
          capabilities: [...profile.capabilities],
          max_cost_per_attempt: { ...profile.max_cost_per_attempt, source: "CONFIG" as const },
          used_for_authority: false as const,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
      retry_policy: { ...this.retryPolicy },
      providers: Array.from(this.health.values())
        .map((entry) => ({ ...entry }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      authority_boundary: {
        llm_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
        health_metadata_used_for_authority: false,
        used_for_authority: false,
      },
      evidence_source: ["INTERNAL_STATE"],
    };
  }

  private resolveWithName(hint?: string): { backend: LLMBackend; name: string } {
    const key = normalizeName(hint ?? this.defaultName ?? "");
    if (!key) {
      throw new Error("LLMRegistry: no default backend configured");
    }
    const backend = this.backends.get(key);
    if (!backend) {
      throw new Error(
        `LLMRegistry: backend '${hint ?? key}' is not registered; available=${this.list().join(", ")}`,
      );
    }
    return { backend, name: normalizeName(backend.name) };
  }

  async call(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    return this.callWithFallbackAuthorization(req, signal);
  }

  /** @internal HDS fallback authorization is consumed here and never forwarded to a provider. */
  async callWithFallbackAuthorization(
    req: LLMRequest,
    signal: AbortSignal | undefined,
    fallbackAuthorization?: LLMFallbackAuthorization,
  ): Promise<LLMResponse> {
    const selected = this.resolveWithName(req.backend_hint);
    if (signal?.aborted) throw createLLMAbortError(selected.name, signal);
    try {
      const response = await this.callWithRetry(selected.backend, selected.name, req, signal);
      return withoutRoutingTrace(response);
    } catch (error) {
      // Cancellation and command deadlines must not start another provider call.
      if (signal?.aborted) throw error;
      const classification = classifyLLMError(error);
      if (this.fallbackName && classification.retryable) {
        const fallback = this.resolveWithName(this.fallbackName);
        const estimatedTotalCost = this.authorizedFallbackCost(
          selected.name,
          fallback.name,
          req,
          fallbackAuthorization,
        );
        if (fallback.name !== selected.name && estimatedTotalCost) {
          const response = withoutRoutingTrace(
            await this.callWithRetry(fallback.backend, fallback.name, req, signal),
          );
          return {
            ...response,
            provider: fallback.name,
            [LLM_ROUTING_TRACE]: {
              from_provider: selected.name,
              failure_kind: classification.kind,
              estimated_total_cost: estimatedTotalCost,
            },
          };
        }
      }
      throw error;
    }
  }

  private authorizedFallbackCost(
    primaryName: string,
    fallbackName: string,
    request: LLMRequest,
    fallbackAuthorization: LLMFallbackAuthorization | undefined,
  ): LLMFallbackCostBound | undefined {
    const parsed = LLMFallbackAuthorizationSchema.safeParse(fallbackAuthorization);
    if (!parsed.success) return undefined;
    const authorization = parsed.data;
    if (!authorization.allowed_providers.some((name) => normalizeName(name) === fallbackName)) {
      return undefined;
    }

    const primaryProfile = this.fallbackProfiles.get(primaryName);
    const fallbackProfile = this.fallbackProfiles.get(fallbackName);
    if (!primaryProfile || !fallbackProfile) return undefined;
    if (request.max_tokens !== undefined && request.max_tokens <= 0) return undefined;
    if (authorization.required_capabilities.some(
      (capability) => !fallbackProfile.capabilities.includes(capability),
    )) return undefined;

    const primaryCost = primaryProfile.max_cost_per_attempt;
    const fallbackCost = fallbackProfile.max_cost_per_attempt;
    if (primaryCost.currency !== fallbackCost.currency || primaryCost.currency !== authorization.max_total_cost.currency) {
      return undefined;
    }
    const total = boundedCostSum(
      primaryCost.amount,
      fallbackCost.amount,
      this.retryPolicy.max_attempts,
      authorization.max_total_cost.amount,
    );
    if (total === undefined) return undefined;
    return { amount: total, currency: primaryCost.currency, source: "CONFIG" };
  }

  private async callWithRetry(
    backend: LLMBackend,
    name: string,
    req: LLMRequest,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryPolicy.max_attempts; attempt += 1) {
      if (signal?.aborted) throw createLLMAbortError(name, signal);
      try {
        const response = await backend.call({
          ...req,
          backend_hint: undefined,
        }, signal);
        this.recordSuccess(name);
        return { ...response, provider: name };
      } catch (error) {
        lastError = error;
        const classification = classifyLLMError(error);
        this.recordFailure(name, classification.kind, classification.retryable, classification.retry_after_ms);
        if (signal?.aborted) throw error;
        const mayRetry = classification.retryable && attempt < this.retryPolicy.max_attempts;
        if (!mayRetry) break;
        await this.sleep(this.retryDelayMs(attempt, classification.retry_after_ms));
      }
    }
    throw lastError;
  }

  private retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.retryPolicy.max_delay_ms);
    const scaled = this.retryPolicy.base_delay_ms * 2 ** Math.max(0, attempt - 1);
    return Math.min(scaled, this.retryPolicy.max_delay_ms);
  }

  private recordSuccess(name: string): void {
    const entry = this.health.get(name);
    if (!entry) return;
    entry.state = "pass";
    entry.consecutive_failures = 0;
    entry.last_checked_at = new Date(this.now()).toISOString();
    entry.last_error_kind = null;
    entry.last_error_retryable = null;
    entry.retry_after_ms = null;
  }

  private recordFailure(
    name: string,
    kind: LLMErrorKind,
    retryable: boolean,
    retryAfterMs: number | undefined,
  ): void {
    const entry = this.health.get(name);
    if (!entry) return;
    entry.state = "fail";
    entry.consecutive_failures += 1;
    entry.last_checked_at = new Date(this.now()).toISOString();
    entry.last_error_kind = kind;
    entry.last_error_retryable = retryable;
    entry.retry_after_ms = retryAfterMs ?? null;
  }
}

function isValidFallbackProfile(profile: LLMFallbackProfile): boolean {
  if (!profile || Object.getPrototypeOf(profile) !== Object.prototype) return false;
  if (Object.keys(profile).sort().join(",") !== "capabilities,max_cost_per_attempt") return false;
  if (!profile || !Array.isArray(profile.capabilities) || profile.capabilities.length === 0 || profile.capabilities.length > 16) {
    return false;
  }
  if (profile.capabilities.some((capability) => typeof capability !== "string" || !capability.trim() || capability.length > 120)) {
    return false;
  }
  if (new Set(profile.capabilities).size !== profile.capabilities.length) return false;
  const cost = profile.max_cost_per_attempt;
  if (!cost || Object.getPrototypeOf(cost) !== Object.prototype || Object.keys(cost).sort().join(",") !== "amount,currency") return false;
  return Boolean(
    Number.isFinite(cost.amount) &&
    cost.amount >= 0 &&
    /^[A-Z]{3}$/.test(cost.currency),
  );
}

function boundedCostSum(
  primary: number,
  fallback: number,
  attemptsPerProvider: number,
  maximum: number,
): number | undefined {
  if (!Number.isSafeInteger(attemptsPerProvider) || attemptsPerProvider < 1) return undefined;
  const values = [primary, fallback, maximum].map(decimalUnits);
  const scale = Math.max(...values.map((value) => value.scale));
  const [primaryUnits, fallbackUnits, maximumUnits] = values.map((value) =>
    value.units * (10n ** BigInt(scale - value.scale)),
  );
  const totalUnits = (primaryUnits! + fallbackUnits!) * BigInt(attemptsPerProvider);
  if (totalUnits > maximumUnits!) return undefined;
  const total = Number(formatDecimalUnits(totalUnits, scale));
  return Number.isFinite(total) ? total : undefined;
}

function decimalUnits(value: number): { units: bigint; scale: number } {
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? "0");
  const [whole, fraction = ""] = (coefficient ?? "0").split(".");
  const digits = `${whole ?? "0"}${fraction}`.replace(/^0+(?=\d)/, "");
  let scale = fraction.length - exponent;
  let units = BigInt(digits || "0");
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units, scale };
}

function formatDecimalUnits(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const padded = units.toString().padStart(scale + 1, "0");
  const splitAt = padded.length - scale;
  return `${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
}

function withoutRoutingTrace(response: LLMResponse): LLMResponse {
  const sanitized = { ...response };
  delete sanitized[LLM_ROUTING_TRACE];
  return sanitized;
}
