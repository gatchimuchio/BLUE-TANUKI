import { Buffer } from "node:buffer";
import {
  LLMProviderError,
  createLLMToolCallCandidate,
  LLM_IMAGE_INPUT_CAPABILITY,
  validateLLMImageInputs,
  type LLMBackend,
  type LLMRequest,
  type LLMResponse,
} from "./base.js";
import { fetchWithProviderTimeout, readProviderJson } from "./fetch_timeout.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalidStructuredOutput(provider: string): never {
  throw new LLMProviderError("Provider returned invalid structured output.", {
    provider,
    kind: "invalid_structured_output",
    retryable: false,
  });
}

function parseResponse(provider: string, data: unknown, requestedModel: string): LLMResponse {
  if (!isRecord(data) || !Array.isArray(data.content) || !isRecord(data.usage)) {
    invalidStructuredOutput(provider);
  }
  const inputTokens = data.usage.input_tokens;
  const outputTokens = data.usage.output_tokens;
  if (
    typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0
  ) {
    invalidStructuredOutput(provider);
  }
  const tokensUsed = inputTokens + outputTokens;
  if (!Number.isSafeInteger(tokensUsed)) invalidStructuredOutput(provider);
  if (data.stop_reason === "max_tokens") {
    throw new LLMProviderError("Provider returned a partial response.", {
      provider,
      kind: "partial_response",
      retryable: false,
    });
  }
  if (
    data.stop_reason !== undefined && data.stop_reason !== null &&
    data.stop_reason !== "end_turn" && data.stop_reason !== "tool_use" &&
    data.stop_reason !== "stop_sequence"
  ) {
    invalidStructuredOutput(provider);
  }

  let content = "";
  const toolCalls: NonNullable<LLMResponse["tool_calls"]> = [];
  for (const block of data.content) {
    if (!isRecord(block) || typeof block.type !== "string") invalidStructuredOutput(provider);
    if (block.type === "text") {
      if (typeof block.text !== "string") invalidStructuredOutput(provider);
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push(createLLMToolCallCandidate(provider, block.id, block.name, block.input));
      if (toolCalls.length > 32) invalidStructuredOutput(provider);
    }
  }
  if (data.stop_reason === "tool_use" && toolCalls.length === 0) invalidStructuredOutput(provider);
  if (!content && toolCalls.length === 0) invalidStructuredOutput(provider);

  if (data.model !== undefined && (typeof data.model !== "string" || !data.model.trim())) {
    invalidStructuredOutput(provider);
  }
  return {
    content,
    tokens_used: tokensUsed,
    tokens_usage_status: "provider_reported",
    model: typeof data.model === "string" ? data.model : requestedModel,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(604_800_000, Math.round(seconds * 1000));
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.min(604_800_000, Math.max(0, dateMs - Date.now()));
  return undefined;
}

function errorKindForStatus(status: number): {
  kind: LLMProviderError["kind"];
  retryable: boolean;
} {
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { kind: "remote_service_unavailable", retryable: true };
  }
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status >= 400 && status < 500) return { kind: "bad_request", retryable: false };
  return { kind: "unknown", retryable: false };
}

/** Anthropic raw-fetch adapter. Returned tool_use blocks remain candidates. */
export class AnthropicBackend implements LLMBackend {
  readonly name = "anthropic";
  readonly capabilities = ["llm.text.generate"] as const;
  private readonly imageCapableModels: ReadonlySet<string>;

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string = "claude-opus-4-7",
    private readonly endpoint: string = "https://api.anthropic.com/v1/messages",
    private readonly apiVersion: string = "2023-06-01",
    imageCapableModels: readonly string[] = [],
  ) {
    if (!apiKey) throw new Error("AnthropicBackend: apiKey is required");
    if (!Array.isArray(imageCapableModels) || imageCapableModels.length > 64 ||
        imageCapableModels.some((model) => typeof model !== "string" || !model.trim() || model.length > 200) ||
        new Set(imageCapableModels).size !== imageCapableModels.length) {
      throw new Error("AnthropicBackend: imageCapableModels is invalid");
    }
    this.imageCapableModels = new Set(imageCapableModels.map((model) => model.trim()));
  }

  supportsCapability(capability: string, model?: string): boolean {
    if (capability === "llm.text.generate") return true;
    return capability === LLM_IMAGE_INPUT_CAPABILITY && this.imageCapableModels.has(model ?? this.defaultModel);
  }

  async call(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const images = validateLLMImageInputs(req.ephemeral_images);
    if (images.length > 0 && !this.supportsCapability(LLM_IMAGE_INPUT_CAPABILITY, req.model)) {
      throw new LLMProviderError("Image input is not configured for the selected model.", {
        provider: this.name,
        kind: "bad_request",
        retryable: false,
      });
    }
    const system = req.messages.find((message) => message.role === "system")?.content;
    let lastUserIndex = -1;
    for (let index = 0; index < req.messages.length; index += 1) {
      if (req.messages[index]?.role === "user") lastUserIndex = index;
    }
    if (images.length > 0 && lastUserIndex < 0) throw new Error("llm_image_input_user_message_missing");
    const messages = req.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role !== "system")
      .map(({ message, index }) => ({
        role: message.role,
        content: index === lastUserIndex && images.length > 0
          ? [
              { type: "text", text: message.content },
              ...images.map((image) => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.media_type,
                  data: Buffer.from(image.data).toString("base64"),
                },
              })),
            ]
          : message.content,
      }));

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      max_tokens: req.max_tokens ?? 1024,
      messages,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    return fetchWithProviderTimeout(
      this.name,
      this.endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify(body),
      },
      req.timeout_ms,
      async (response) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const classified = errorKindForStatus(response.status);
          throw new LLMProviderError(
            `AnthropicBackend: API error ${response.status}; response body omitted.`,
            {
              provider: this.name,
              status: response.status,
              retry_after_ms: retryAfterMs(response.headers),
              ...classified,
            },
          );
        }
        return parseResponse(this.name, await readProviderJson(this.name, response), String(body.model));
      },
      signal,
    );
  }
}
