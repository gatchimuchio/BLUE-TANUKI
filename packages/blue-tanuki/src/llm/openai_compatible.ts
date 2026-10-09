import {
  LLMProviderError,
  createLLMToolCallCandidate,
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

function tokenCount(provider: string, usage: unknown): number {
  if (usage === undefined || usage === null) return 0;
  if (!isRecord(usage)) invalidStructuredOutput(provider);
  const read = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      invalidStructuredOutput(provider);
    }
    return value;
  };
  const total = read(usage.total_tokens);
  if (total !== undefined) return total;
  const sum = (read(usage.prompt_tokens) ?? 0) + (read(usage.completion_tokens) ?? 0);
  if (!Number.isSafeInteger(sum)) invalidStructuredOutput(provider);
  return sum;
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
  return {
    content,
    tokens_used: tokenCount(provider, data.usage),
    model: typeof responseModel === "string" ? responseModel : requestedModel,
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

/**
 * Raw-fetch adapter for OpenAI-compatible chat completion APIs. Native tool
 * calls are parsed as non-authority candidates; no SDK or tool executor runs.
 */
export class OpenAICompatibleBackend implements LLMBackend {
  readonly name: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: OpenAICompatibleBackendOptions) {
    if (!opts.defaultModel) throw new Error("OpenAICompatibleBackend: defaultModel is required");
    if (!opts.endpoint) throw new Error("OpenAICompatibleBackend: endpoint is required");
    this.name = opts.name ?? "openai-compatible";
    this.endpoint = normalizeEndpoint(opts.endpoint);
    this.headers = {
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.apiKey && !this.headers.Authorization) {
      this.headers.Authorization = `Bearer ${opts.apiKey}`;
    }
  }

  async call(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const body: {
      model: string;
      messages: LLMRequest["messages"];
      max_tokens?: number;
      temperature?: number;
    } = {
      model: req.model ?? this.opts.defaultModel,
      messages: req.messages,
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
