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

  it("keeps transcription disabled by default and uses only the explicitly configured exact model", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(JSON.stringify({ text: "fixture transcript" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const audio = { format: "ogg" as const, data: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01]) };
    const defaultOff = new OpenAICompatibleBackend({
      endpoint: "https://example.test/v1",
      defaultModel: "transcribe-v1",
    });
    await expect(defaultOff.call({ messages: [{ role: "user", content: "transcribe" }], ephemeral_audio: [audio] }))
      .rejects.toMatchObject({ kind: "bad_request", retryable: false });
    expect(requests).toBe(0);

    let seen: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ text: "fixture transcript" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const enabled = new OpenAICompatibleBackend({
      endpoint: "https://example.test/v1/chat/completions",
      defaultModel: "transcribe-v1",
      apiKey: "secret",
      audio_transcription_capable_models: ["transcribe-v1"],
    });
    const result = await enabled.call({
      messages: [{ role: "user", content: "transcribe" }],
      ephemeral_audio: [audio],
    });
    expect(result).toMatchObject({
      content: expect.stringContaining("確度情報はproviderから報告されていません"),
      tokens_used: 0,
      tokens_usage_status: "unknown",
      model: "transcribe-v1",
    });
    expect(result.content).toContain("fixture transcript");
    expect(seen?.url).toBe("https://example.test/v1/audio/transcriptions");
    expect(seen?.init.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(Object.keys(seen?.init.headers as Record<string, string>).some((key) => key.toLowerCase() === "content-type")).toBe(false);
    const form = seen?.init.body as FormData;
    expect(form.get("model")).toBe("transcribe-v1");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(file.type).toBe("audio/ogg");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...audio.data]);
  });

  it("does not treat a missing usage object as reported zero tokens", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: "provider-model",
      choices: [{ message: { content: "usage omitted" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const backend = new OpenAICompatibleBackend({ endpoint: "https://example.test/v1", defaultModel: "configured-model" });
    const response = await backend.call({ messages: [{ role: "user", content: "ping" }] });
    expect(response.tokens_used).toBe(0);
    expect(response.tokens_usage_status).toBe("unknown");
  });

  it("preserves an optional meaning-update candidate extension for HDS review", async () => {
    const proposal = { schema_version: "blue-tanuki.meaning-update-proposal.v3", candidate_meaning: "synthetic" };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: "provider-model",
      choices: [{ message: { content: "safe user-facing answer", meaning_update_proposal: proposal } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const backend = new OpenAICompatibleBackend({ endpoint: "https://example.test/v1", defaultModel: "configured-model" });
    const response = await backend.call({ messages: [{ role: "user", content: "ping" }] });

    expect(response).toMatchObject({ content: "safe user-facing answer", meaning_update_proposal: proposal });
  });

  it("preserves an optional skeptical review extension as untrusted structured data", async () => {
    const proposal = {
      schema_version: "blue-tanuki.skeptical-review.v1",
      observation_reports: [{ criterion_ref: "criterion-1", finding: "synthetic conflict", relation: "conflicts" }],
      goal_purpose_change_proposal: { goal_ref: "goal_0000000000000001", purpose_text: "synthetic purpose" },
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: "provider-model",
      choices: [{ message: { content: "safe user-facing answer", skeptical_review: proposal } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const backend = new OpenAICompatibleBackend({ endpoint: "https://example.test/v1", defaultModel: "configured-model" });
    const response = await backend.call({ messages: [{ role: "user", content: "ping" }] });

    expect(response).toMatchObject({ content: "safe user-facing answer", skeptical_review: proposal });
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
