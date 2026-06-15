import {
  LLMProviderError,
  type LLMBackend,
  type LLMMessage,
  type LLMRequest,
  type LLMResponse,
} from "./base.js";
import { fetchWithProviderTimeout } from "./fetch_timeout.js";

type OpenAIContentPart = {
  type?: string;
  text?: string;
};

type OpenAIChoice = {
  message?: {
    content?: string | OpenAIContentPart[];
  };
  text?: string;
};

type OpenAICompatibleAPIResponse = {
  choices?: OpenAIChoice[];
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  model?: string;
};

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

function extractText(choice: OpenAIChoice | undefined): string {
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

function tokenCount(data: OpenAICompatibleAPIResponse): number {
  const usage = data.usage;
  if (!usage) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
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
 * Backend for OpenAI-compatible chat completion APIs.
 *
 * This covers OpenAI-compatible SaaS providers, OpenRouter-style routers,
 * vLLM, llama.cpp servers, Ollama's OpenAI endpoint, and similar local or
 * self-hosted runtimes. It is intentionally downstream-only: it answers a
 * request after HDS-BRAIN has already decided the command may run.
 */
export class OpenAICompatibleBackend implements LLMBackend {
  readonly name: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: OpenAICompatibleBackendOptions) {
    if (!opts.defaultModel) {
      throw new Error("OpenAICompatibleBackend: defaultModel is required");
    }
    if (!opts.endpoint) {
      throw new Error("OpenAICompatibleBackend: endpoint is required");
    }
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

  async call(req: LLMRequest): Promise<LLMResponse> {
    const body: {
      model: string;
      messages: LLMMessage[];
      max_tokens?: number;
      temperature?: number;
    } = {
      model: req.model ?? this.opts.defaultModel,
      messages: req.messages,
    };
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetchWithProviderTimeout(this.name, this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      }, req.timeout_ms);
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      throw new LLMProviderError(`${this.name}: network error`, {
        provider: this.name,
        kind: "temporary_network",
        retryable: true,
        cause: error,
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      const classified = errorKindForStatus(res.status);
      throw new LLMProviderError(
        `${this.name}: API error ${res.status}: ${errText.slice(0, 500)}`,
        {
          provider: this.name,
          status: res.status,
          retry_after_ms: retryAfterMs(res.headers),
          ...classified,
        },
      );
    }

    let data: OpenAICompatibleAPIResponse;
    try {
      data = (await res.json()) as OpenAICompatibleAPIResponse;
    } catch (error) {
      throw new LLMProviderError(`${this.name}: invalid JSON response`, {
        provider: this.name,
        kind: "bad_response",
        retryable: false,
        cause: error,
      });
    }
    return {
      content: extractText(data.choices?.[0]),
      tokens_used: tokenCount(data),
      model: data.model ?? body.model,
      raw: data,
    };
  }
}
