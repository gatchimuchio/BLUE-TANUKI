import { describe, it, expect } from "vitest";
import { LLMRegistry } from "../src/llm/registry.js";
import {
  LLMProviderError,
  type LLMBackend,
  type LLMRequest,
  type LLMResponse,
} from "../src/llm/base.js";

class NamedBackend implements LLMBackend {
  readonly seen: LLMRequest[] = [];

  constructor(readonly name: string) {}

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req);
    return {
      content: `from:${this.name}`,
      tokens_used: 0,
      model: this.name,
    };
  }
}

class FlakyBackend implements LLMBackend {
  readonly seen: LLMRequest[] = [];

  constructor(
    readonly name: string,
    private failuresRemaining: number,
  ) {}

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new LLMProviderError(`${this.name} unavailable`, {
        provider: this.name,
        kind: "remote_service_unavailable",
        retryable: true,
        status: 503,
      });
    }
    return {
      content: `from:${this.name}`,
      tokens_used: 1,
      model: this.name,
    };
  }
}

class FailingBackend implements LLMBackend {
  readonly seen: LLMRequest[] = [];

  constructor(
    readonly name: string,
    private readonly kind: LLMProviderError["kind"],
    private readonly retryable: boolean,
  ) {}

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req);
    throw new LLMProviderError(`${this.name} failed`, {
      provider: this.name,
      kind: this.kind,
      retryable: this.retryable,
    });
  }
}

describe("LLMRegistry", () => {
  it("routes to the default backend when no hint is present", async () => {
    const stub = new NamedBackend("stub");
    const fast = new NamedBackend("fast");
    const registry = new LLMRegistry()
      .register(stub)
      .register(fast)
      .setDefault("fast");

    const res = await registry.call({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.content).toBe("from:fast");
    expect(res.provider).toBe("fast");
    expect(stub.seen).toHaveLength(0);
    expect(fast.seen).toHaveLength(1);
  });

  it("routes backend_hint aliases without leaking the hint downstream", async () => {
    const claude = new NamedBackend("anthropic");
    const registry = new LLMRegistry().register(claude, ["claude"]);

    const res = await registry.call({
      backend_hint: "claude",
      messages: [{ role: "user", content: "hi" }],
      model: "m",
    });

    expect(claude.seen).toHaveLength(1);
    expect(claude.seen[0].backend_hint).toBeUndefined();
    expect(claude.seen[0].model).toBe("m");
    expect(res.provider).toBe("anthropic");
  });

  it("fails closed on unknown hints", async () => {
    const registry = new LLMRegistry().register(new NamedBackend("stub"));
    await expect(
      registry.call({
        backend_hint: "missing",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/missing/);
  });

  it("retries retryable provider errors and records non-authority health", async () => {
    const fast = new FlakyBackend("fast", 1);
    const registry = new LLMRegistry({
      retry: { max_attempts: 2, base_delay_ms: 0, max_delay_ms: 0 },
      sleep: async () => undefined,
      now: () => Date.parse("2026-06-13T00:00:00.000Z"),
    }).register(fast);

    const res = await registry.call({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.content).toBe("from:fast");
    expect(fast.seen).toHaveLength(2);
    expect(registry.healthSnapshot()).toMatchObject({
      surface: "llm_registry_health",
      retry_policy: { max_attempts: 2 },
      authority_boundary: {
        llm_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
        health_metadata_used_for_authority: false,
        used_for_authority: false,
      },
      providers: [
        {
          name: "fast",
          state: "pass",
          consecutive_failures: 0,
          used_for_authority: false,
        },
      ],
    });
  });

  it("uses an explicit fallback only for default routing", async () => {
    const primary = new FlakyBackend("primary", 2);
    const fallback = new NamedBackend("stub");
    const registry = new LLMRegistry({
      retry: { max_attempts: 1 },
      sleep: async () => undefined,
    })
      .register(primary)
      .register(fallback)
      .setDefault("primary")
      .setFallback("stub");

    const res = await registry.call({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.content).toBe("from:stub");
    expect(res.provider).toBe("stub");
    expect(primary.seen).toHaveLength(1);
    expect(fallback.seen).toHaveLength(1);

    await expect(
      registry.call({
        backend_hint: "primary",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/primary unavailable/);
    expect(fallback.seen).toHaveLength(1);
  });

  it("does not hide non-retryable credential failures behind fallback", async () => {
    const primary = new FailingBackend("primary", "auth", false);
    const fallback = new NamedBackend("stub");
    const registry = new LLMRegistry({
      retry: { max_attempts: 1 },
      sleep: async () => undefined,
    })
      .register(primary)
      .register(fallback)
      .setDefault("primary")
      .setFallback("stub");

    await expect(
      registry.call({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
    });
    expect(fallback.seen).toHaveLength(0);
  });
});
