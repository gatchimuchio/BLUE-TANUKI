import {
  LLMProviderError,
  type LLMBackend,
  type LLMRequest,
  type LLMResponse,
} from "./base.js";
import { fetchWithProviderTimeout } from "./fetch_timeout.js";

interface AnthropicAPIResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
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
 * AnthropicBackend: calls api.anthropic.com /v1/messages.
 * Default model: claude-opus-4-7. Override via constructor or per-request.
 */
export class AnthropicBackend implements LLMBackend {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string = "claude-opus-4-7",
    private readonly endpoint: string = "https://api.anthropic.com/v1/messages",
    private readonly apiVersion: string = "2023-06-01",
  ) {
    if (!apiKey) {
      throw new Error("AnthropicBackend: apiKey is required");
    }
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const system = req.messages.find((m) => m.role === "system")?.content;
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      max_tokens: req.max_tokens ?? 1024,
      messages,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetchWithProviderTimeout(this.name, this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify(body),
      }, req.timeout_ms);
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      throw new LLMProviderError("AnthropicBackend: network error", {
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
        `AnthropicBackend: API error ${res.status}: ${errText.slice(0, 500)}`,
        {
          provider: this.name,
          status: res.status,
          retry_after_ms: retryAfterMs(res.headers),
          ...classified,
        },
      );
    }

    let data: AnthropicAPIResponse;
    try {
      data = (await res.json()) as AnthropicAPIResponse;
    } catch (error) {
      throw new LLMProviderError("AnthropicBackend: invalid JSON response", {
        provider: this.name,
        kind: "bad_response",
        retryable: false,
        cause: error,
      });
    }
    const text = data.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("");

    return {
      content: text,
      tokens_used: data.usage.input_tokens + data.usage.output_tokens,
      model: data.model,
      raw: data,
    };
  }
}
