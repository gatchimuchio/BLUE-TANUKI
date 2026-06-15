import { afterEach, describe, expect, it } from "vitest";
import type { LLMProviderError } from "../src/llm/base.js";
import { OpenAICompatibleBackend } from "../src/llm/openai_compatible.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAICompatibleBackend", () => {
  it("calls a chat-completions-compatible endpoint", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          model: "provider-model",
          choices: [{ message: { content: "hello from api" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const backend = new OpenAICompatibleBackend({
      endpoint: "https://example.test/v1",
      defaultModel: "configured-model",
      apiKey: "secret",
      headers: { "X-Test": "yes" },
    });

    const res = await backend.call({
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 99,
      temperature: 0.2,
    });

    expect(res).toMatchObject({
      content: "hello from api",
      model: "provider-model",
      tokens_used: 5,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://example.test/v1/chat/completions");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret",
    );
    expect((seen[0]!.init.headers as Record<string, string>)["X-Test"]).toBe(
      "yes",
    );
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      model: "configured-model",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 99,
      temperature: 0.2,
    });
  });

  it("surfaces provider errors without making the provider authoritative", async () => {
    globalThis.fetch = (async () =>
      new Response("bad request", { status: 400 })) as typeof fetch;

    const backend = new OpenAICompatibleBackend({
      endpoint: "http://localhost:11434/v1",
      defaultModel: "local-model",
    });

    await expect(
      backend.call({ messages: [{ role: "user", content: "ping" }] }),
    ).rejects.toThrow(/API error 400/);
  });

  it("classifies rate limits as retryable non-authority provider errors", async () => {
    globalThis.fetch = (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "2" },
      })) as typeof fetch;

    const backend = new OpenAICompatibleBackend({
      endpoint: "http://localhost:11434/v1",
      defaultModel: "local-model",
    });

    await expect(
      backend.call({ messages: [{ role: "user", content: "ping" }] }),
    ).rejects.toMatchObject({
      name: "LLMProviderError",
      kind: "rate_limited",
      retryable: true,
      status: 429,
      retry_after_ms: 2000,
      used_for_authority: false,
    } satisfies Partial<LLMProviderError>);
  });

  it("passes timeout_ms to fetch and classifies AbortError as timeout", async () => {
    let signalSeen = false;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      signalSeen = signal instanceof AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const backend = new OpenAICompatibleBackend({
      endpoint: "https://example.test/v1",
      defaultModel: "configured-model",
    });

    await expect(
      backend.call({
        messages: [{ role: "user", content: "ping" }],
        timeout_ms: 1,
      }),
    ).rejects.toMatchObject({
      name: "LLMProviderError",
      kind: "timeout",
      retryable: true,
      used_for_authority: false,
    } satisfies Partial<LLMProviderError>);
    expect(signalSeen).toBe(true);
  });
});
