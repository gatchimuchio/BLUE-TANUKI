import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../src/llm/base.js";
import { AnthropicBackend } from "../src/llm/anthropic.js";
import { OpenAICompatibleBackend } from "../src/llm/openai_compatible.js";

const request: LLMRequest = {
  messages: [{ role: "user", content: "fixture request" }],
  timeout_ms: 500,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAIBackend(): OpenAICompatibleBackend {
  return new OpenAICompatibleBackend({
    defaultModel: "fixture-model",
    endpoint: "https://fixture.invalid/v1",
  });
}

function anthropicBackend(): AnthropicBackend {
  return new AnthropicBackend("fixture-key-not-a-credential", "fixture-model", "https://fixture.invalid/v1/messages");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLM provider structured responses", () => {
  it("returns OpenAI-compatible tool_calls as non-authority candidates", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      model: "fixture-model-v2",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call-openai-1",
            type: "function",
            function: { name: "local.inspect", arguments: "{\"path\":\"C:/fixture\"}" },
          }],
        },
      }],
      usage: { total_tokens: 8 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await openAIBackend().call(request);

    expect(response.tool_calls).toMatchObject([{
      call_id: "call-openai-1",
      tool_name: "local.inspect",
      arguments: { path: "C:/fixture" },
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    }]);
    expect(response).not.toHaveProperty("raw");
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent).not.toHaveProperty("tools");
  });

  it("returns Anthropic tool_use blocks as non-authority candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      id: "message-fixture",
      model: "fixture-claude-v2",
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "call-anthropic-1",
        name: "local.inspect",
        input: { path: "C:/fixture" },
      }],
      usage: { input_tokens: 4, output_tokens: 2 },
    })));

    const response = await anthropicBackend().call(request);

    expect(response.tool_calls).toMatchObject([{
      call_id: "call-anthropic-1",
      tool_name: "local.inspect",
      arguments: { path: "C:/fixture" },
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    }]);
    expect(response).not.toHaveProperty("raw");
  });

  it("types malformed JSON and malformed tool arguments without exposing provider text", async () => {
    const rawSentinel = "provider-raw-response-sentinel";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken", { status: 200 })));
    await expect(openAIBackend().call(request)).rejects.toMatchObject({
      kind: "invalid_structured_output",
      retryable: false,
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call-bad",
            type: "function",
            function: { name: "local.inspect", arguments: `{"value":"${rawSentinel}"` },
          }],
        },
      }],
    })));
    const error = await openAIBackend().call(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "invalid_structured_output", retryable: false });
    expect((error as Error).message).not.toContain(rawSentinel);
  });

  it("types OpenAI and Anthropic truncation as partial responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    })));
    await expect(openAIBackend().call(request)).rejects.toMatchObject({
      kind: "partial_response",
      retryable: false,
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      model: "fixture-model",
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    await expect(anthropicBackend().call(request)).rejects.toMatchObject({
      kind: "partial_response",
      retryable: false,
    });
  });

  it("rejects provider token totals that exceed the safe integer range", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    })));
    await expect(openAIBackend().call(request)).rejects.toMatchObject({
      kind: "invalid_structured_output",
      retryable: false,
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      model: "fixture-model",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    })));
    await expect(anthropicBackend().call(request)).rejects.toMatchObject({
      kind: "invalid_structured_output",
      retryable: false,
    });
  });

  it("types a disconnect during body reading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError("raw socket detail"));
      },
    }), { status: 200 })));

    const error = await openAIBackend().call(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "disconnected", retryable: true });
    expect((error as Error).message).not.toContain("raw socket detail");
  });

  it("keeps the provider timeout active after response headers arrive", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await openAIBackend().call({ ...request, timeout_ms: 20 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "timeout", retryable: true });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("propagates caller cancellation into an in-progress response body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = openAIBackend().call(request, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "cancelled", retryable: false });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("does not include an HTTP error body in the typed provider failure", async () => {
    const rawSentinel = "private-response-body-sentinel";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rawSentinel, { status: 401 })));

    const error = await openAIBackend().call(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "auth", status: 401, retryable: false });
    expect((error as Error).message).not.toContain(rawSentinel);
  });
});
