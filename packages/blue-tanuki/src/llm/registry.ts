import {
  classifyLLMError,
  type LLMBackend,
  type LLMErrorKind,
  type LLMRequest,
  type LLMResponse,
} from "./base.js";

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

  register(backend: LLMBackend, aliases: readonly string[] = []): this {
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
    if (!this.defaultName) this.defaultName = primary;
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

  async call(req: LLMRequest): Promise<LLMResponse> {
    const selected = this.resolveWithName(req.backend_hint);
    try {
      return await this.callWithRetry(selected.backend, selected.name, req);
    } catch (error) {
      const classification = classifyLLMError(error);
      if (!req.backend_hint && this.fallbackName && classification.retryable) {
        const fallback = this.resolveWithName(this.fallbackName);
        if (fallback.name !== selected.name) {
          return await this.callWithRetry(fallback.backend, fallback.name, req);
        }
      }
      throw error;
    }
  }

  private async callWithRetry(
    backend: LLMBackend,
    name: string,
    req: LLMRequest,
  ): Promise<LLMResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryPolicy.max_attempts; attempt += 1) {
      try {
        const response = await backend.call({
          ...req,
          backend_hint: undefined,
        });
        this.recordSuccess(name);
        return { ...response, provider: name };
      } catch (error) {
        lastError = error;
        const classification = classifyLLMError(error);
        this.recordFailure(name, classification.kind, classification.retryable, classification.retry_after_ms);
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
