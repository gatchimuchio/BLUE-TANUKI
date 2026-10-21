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

export interface OpenAICompatibleBackendOptions {
  apiKey?: string;
  defaultModel: string;
  endpoint: string;
  headers?: Record<string, string>;
  name?: string;
  /** Exact model IDs explicitly configured for image input. */
  image_capable_models?: readonly string[];
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return trimmed;
}

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

function extractText(provider: string, content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const part of content) {
      if (!isRecord(part) || typeof part.type !== "string") invalidStructuredOutput(provider);
      if (part.type === "text") {
        if (typeof part.text !== "string") invalidStructuredOutput(provider);
        text += part.text;
      }
    }
    return text;
  }
  if (content === null || content === undefined) return "";
  return invalidStructuredOutput(provider);
}

function tokenUsage(provider: string, usage: unknown): { count: number; status: "provider_reported" | "unknown" } {
  if (usage === undefined || usage === null) return { count: 0, status: "unknown" };
  if (!isRecord(usage)) invalidStructuredOutput(provider);
  const read = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      invalidStructuredOutput(provider);
    }
    return value;
  };
  const total = read(usage.total_tokens);
  if (total !== undefined) return { count: total, status: "provider_reported" };
  const sum = (read(usage.prompt_tokens) ?? 0) + (read(usage.completion_tokens) ?? 0);
  if (!Number.isSafeInteger(sum)) invalidStructuredOutput(provider);
  const status = usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined
    ? "provider_reported"
    : "unknown";
  return { count: sum, status };
}

function parseToolCalls(provider: string, raw: unknown): NonNullable<LLMResponse["tool_calls"]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 32) invalidStructuredOutput(provider);
  return raw.map((entry) => {
    if (!isRecord(entry) || entry.type !== "function" || !isRecord(entry.function)) {
      return invalidStructuredOutput(provider);
    }
    return createLLMToolCallCandidate(
      provider,
      entry.id,
      entry.function.name,
      entry.function.arguments,
    );
  });
}

function parseResponse(provider: string, data: unknown, requestedModel: string): LLMResponse {
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    invalidStructuredOutput(provider);
  }
  const choice = data.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) invalidStructuredOutput(provider);

  if (choice.finish_reason === "length" || choice.finish_reason === null) {
    throw new LLMProviderError("Provider returned a partial response.", {
      provider,
      kind: "partial_response",
      retryable: false,
    });
  }
  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== "stop" &&
    choice.finish_reason !== "tool_calls" &&
    choice.finish_reason !== "function_call"
  ) {
    invalidStructuredOutput(provider);
  }

  const content = extractText(provider, choice.message.content);
  const toolCalls = parseToolCalls(provider, choice.message.tool_calls);
  if (choice.finish_reason === "tool_calls" && toolCalls.length === 0) {
    invalidStructuredOutput(provider);
  }
  if (!content && toolCalls.length === 0) invalidStructuredOutput(provider);

  const responseModel = data.model;
  if (responseModel !== undefined && (typeof responseModel !== "string" || !responseModel.trim())) {
    invalidStructuredOutput(provider);
  }
  const usage = tokenUsage(provider, data.usage);
  return {
    content,
    tokens_used: usage.count,
    tokens_usage_status: usage.status,
    model: typeof responseModel === "string" ? responseModel : requestedModel,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(Object.hasOwn(choice.message, "skeptical_review")
      ? { skeptical_review: choice.message.skeptical_review }
      : {}),
    // Optional provider extension carrying an untrusted C candidate. Executor
    // removes it from user-visible content and HDS remains its only consumer.
    ...(Object.hasOwn(choice.message, "meaning_update_proposal")
      ? { meaning_update_proposal: choice.message.meaning_update_proposal }
      : {}),
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

/**
 * Raw-fetch adapter for OpenAI-compatible chat completion APIs. Native tool
 * calls are parsed as non-authority candidates; no SDK or tool executor runs.
 */
export class OpenAICompatibleBackend implements LLMBackend {
  readonly name: string;
  readonly capabilities = ["llm.text.generate"] as const;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly imageCapableModels: ReadonlySet<string>;

  constructor(private readonly opts: OpenAICompatibleBackendOptions) {
    if (!opts.defaultModel) throw new Error("OpenAICompatibleBackend: defaultModel is required");
    if (!opts.endpoint) throw new Error("OpenAICompatibleBackend: endpoint is required");
    this.name = opts.name ?? "openai-compatible";
    this.endpoint = normalizeEndpoint(opts.endpoint);
    const imageModels = opts.image_capable_models ?? [];
    if (!Array.isArray(imageModels) || imageModels.length > 64 || imageModels.some((model) =>
      typeof model !== "string" || !model.trim() || model.length > 200) ||
      new Set(imageModels).size !== imageModels.length) {
      throw new Error("OpenAICompatibleBackend: image_capable_models is invalid");
    }
    this.imageCapableModels = new Set(imageModels.map((model) => model.trim()));
    this.headers = {
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.apiKey && !this.headers.Authorization) {
      this.headers.Authorization = `Bearer ${opts.apiKey}`;
    }
  }

  supportsCapability(capability: string, model?: string): boolean {
    if (capability === "llm.text.generate") return true;
    return capability === LLM_IMAGE_INPUT_CAPABILITY && this.imageCapableModels.has(model ?? this.opts.defaultModel);
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
    const messages = images.length > 0
      ? openAICompatibleMessages(req.messages, images)
      : req.messages;
    const body: {
      model: string;
      messages: unknown;
      max_tokens?: number;
      temperature?: number;
    } = {
      model: req.model ?? this.opts.defaultModel,
      messages,
    };
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    return fetchWithProviderTimeout(
      this.name,
      this.endpoint,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      },
      req.timeout_ms,
      async (response) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const classified = errorKindForStatus(response.status);
          throw new LLMProviderError(
            `${this.name}: API error ${response.status}; response body omitted.`,
            {
              provider: this.name,
              status: response.status,
              retry_after_ms: retryAfterMs(response.headers),
              ...classified,
            },
          );
        }
        return parseResponse(this.name, await readProviderJson(this.name, response), body.model);
      },
      signal,
    );
  }
}

function openAICompatibleMessages(
  messages: LLMRequest["messages"],
  images: NonNullable<LLMRequest["ephemeral_images"]>,
): unknown[] {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") lastUserIndex = index;
  }
  if (lastUserIndex < 0) throw new Error("llm_image_input_user_message_missing");
  return messages.map((message, index) => index !== lastUserIndex ? message : {
    role: "user",
    content: [
      { type: "text", text: message.content },
      ...images.map((image) => ({
        type: "image_url",
        image_url: {
          url: `data:${image.media_type};base64,${Buffer.from(image.data).toString("base64")}`,
          detail: "auto",
        },
      })),
    ],
  });
}
