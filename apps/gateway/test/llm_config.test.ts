import { describe, expect, it } from "vitest";
import { LLMRegistry } from "@blue-tanuki/core";
import {
  buildLLMBackendFromEnv,
  buildLLMCommandRouteFromEnv,
  describeLLMCommandRoute,
  describeLLMConfig,
} from "../src/llm_config.js";
import { approvalContextFromCommand } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand } from "@blue-tanuki/protocol";

describe("buildLLMBackendFromEnv", () => {
  it("defaults to an offline stub registry", async () => {
    const llm = buildLLMBackendFromEnv({});
    expect(llm).toBeInstanceOf(LLMRegistry);
    const res = await llm.call({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.content).toContain("hello");
    expect(describeLLMConfig({}).default_backend).toBe("stub");
  });

  it("registers OpenAI-compatible APIs without making them the only option", () => {
    const llm = buildLLMBackendFromEnv({
      LLM_BACKEND: "stub",
      LLM_ENDPOINT: "http://localhost:11434/v1",
      LLM_MODEL: "local-model",
    });
    const registry = llm as LLMRegistry;
    expect(registry.list()).toEqual(["openai-compatible", "stub"]);
    expect(registry.resolve("openai").name).toBe("openai-compatible");
  });

  it("registers OpenRouter as an optional model provider without replacing stub", () => {
    const llm = buildLLMBackendFromEnv({
      LLM_BACKEND: "stub",
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENROUTER_MODEL: "openrouter/model",
      OPENROUTER_SITE_URL: "https://blue-tanuki.local",
      OPENROUTER_APP_TITLE: "BLUE-TANUKI",
    });
    const registry = llm as LLMRegistry;

    expect(registry.list()).toEqual(["openrouter", "stub"]);
    expect(registry.resolve().name).toBe("stub");
    expect(registry.resolve("openrouter").name).toBe("openrouter");
    expect(describeLLMConfig({
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENROUTER_MODEL: "openrouter/model",
    }).openrouter_configured).toBe(true);
  });

  it("fails closed when OpenRouter is selected without an API key", () => {
    expect(() =>
      buildLLMBackendFromEnv({
        LLM_BACKEND: "openrouter",
        OPENROUTER_MODEL: "openrouter/model",
      }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it("fails closed when the default backend is requested but incomplete", () => {
    expect(() =>
      buildLLMBackendFromEnv({
        LLM_BACKEND: "openai-compatible",
        LLM_MODEL: "model-without-endpoint",
      }),
    ).toThrow(/endpoint/);
  });

  it("registers named OpenAI-compatible providers from LLM_PROVIDERS_JSON", () => {
    const providers = JSON.stringify([
      {
        name: "local-fast",
        type: "openai-compatible",
        endpoint: "http://localhost:11434/v1",
        model: "llama-local",
        aliases: ["fast"],
        headers: { "X-Route": "local" },
      },
    ]);
    const llm = buildLLMBackendFromEnv({
      LLM_BACKEND: "fast",
      LLM_PROVIDERS_JSON: providers,
    });
    const registry = llm as LLMRegistry;

    expect(registry.resolve().name).toBe("local-fast");
    expect(registry.resolve("local-fast").name).toBe("local-fast");
    expect(registry.resolve("fast").name).toBe("local-fast");
    expect(describeLLMConfig({ LLM_PROVIDERS_JSON: providers }).configured_providers).toEqual([
      "fast",
      "local-fast",
      "stub",
    ]);
  });

  it("configures explicit LLM retry and fallback without making health authority", () => {
    const llm = buildLLMBackendFromEnv({
      LLM_BACKEND: "openai-compatible",
      LLM_ENDPOINT: "http://localhost:11434/v1",
      LLM_MODEL: "local-model",
      BLUE_TANUKI_LLM_FALLBACK_BACKEND: "stub",
      BLUE_TANUKI_LLM_RETRY_ATTEMPTS: "3",
      BLUE_TANUKI_LLM_RETRY_BASE_MS: "10",
      BLUE_TANUKI_LLM_RETRY_MAX_MS: "50",
    });
    const registry = llm as LLMRegistry;

    expect(registry.healthSnapshot()).toMatchObject({
      fallback_backend: "stub",
      retry_policy: {
        max_attempts: 3,
        base_delay_ms: 10,
        max_delay_ms: 50,
      },
      authority_boundary: {
        llm_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
        health_metadata_used_for_authority: false,
        used_for_authority: false,
      },
    });
    expect(describeLLMConfig({
      BLUE_TANUKI_LLM_FALLBACK_BACKEND: "stub",
      BLUE_TANUKI_LLM_RETRY_ATTEMPTS: "3",
    }).resilience).toMatchObject({
      fallback_backend: "stub",
      retry_policy: { max_attempts: 3 },
      used_for_authority: false,
    });
  });

  it("rejects malformed provider catalog entries", () => {
    expect(() =>
      buildLLMBackendFromEnv({
        LLM_PROVIDERS_JSON: JSON.stringify([{ name: "broken", model: "m" }]),
      }),
    ).toThrow(/endpoint/);
  });

  it("builds an upstream LLM command route from explicit BLUE_TANUKI env", () => {
    const route = buildLLMCommandRouteFromEnv({
      BLUE_TANUKI_LLM_BACKEND_HINT: "fast",
      BLUE_TANUKI_LLM_MODEL: "route-model",
      BLUE_TANUKI_LLM_TEMPERATURE: "0.3",
      BLUE_TANUKI_LLM_MAX_TOKENS: "123",
      BLUE_TANUKI_LLM_TIMEOUT_MS: "4567",
    });

    expect(route).toEqual({
      backend_hint: "fast",
      model: "route-model",
      temperature: 0.3,
      max_tokens: 123,
      timeout_ms: 4567,
    });
    expect(describeLLMCommandRoute({}).backend_hint).toBe("(registry default)");
  });

  it("rejects invalid upstream LLM route env", () => {
    expect(() =>
      buildLLMCommandRouteFromEnv({
        BLUE_TANUKI_LLM_TEMPERATURE: "3",
      }),
    ).toThrow(/TEMPERATURE/);
    expect(() =>
      buildLLMCommandRouteFromEnv({
        BLUE_TANUKI_LLM_MAX_TOKENS: "0",
      }),
    ).toThrow(/MAX_TOKENS/);
  });

  it("keeps provider routing hints out of authority policy", () => {
    const command: ExecuteCommand = {
      id: "cmd-openrouter",
      type: "llm_call",
      payload: {
        backend_hint: "openrouter",
        model: "openrouter/model",
        messages: [{ role: "user", content: "hello" }],
      },
      constraints: {},
      upstream_decision: {
        frame_goal: "chat",
        model_abstraction: "llm",
        commit_hash: "abc123",
        commit_decision: "ASSERT",
      },
    };

    const ctx = approvalContextFromCommand(command);
    expect(ctx.operation).toBe("llm.call");
    expect(ctx.risk).toBe("low");
  });
});
