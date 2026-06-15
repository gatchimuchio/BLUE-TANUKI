/**
 * LLM backend abstraction.
 *
 * BLUE-TANUKI treats LLMs as one tool among many. Any provider (Anthropic,
 * OpenAI, Google, local Ollama, etc.) implements this interface and becomes
 * pluggable.
 *
 * Key design point vs OpenClaw: in BLUE-TANUKI, the LLM is invoked downstream,
 * after upstream HDS-BRAIN has already decided ASSERT. The LLM does not control
 * the agent's state — HDS-BRAIN does.
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  backend_hint?: string;
  max_tokens?: number;
  temperature?: number;
  model?: string;
  /**
   * HTTP provider timeout for a single downstream request. The executor may
   * still enforce a separate overall command timeout around the backend call.
   */
  timeout_ms?: number;
}

export interface LLMResponse {
  content: string;
  tokens_used: number;
  model: string;
  raw?: unknown;
}

export interface LLMBackend {
  readonly name: string;
  call(req: LLMRequest): Promise<LLMResponse>;
}

export type LLMErrorKind =
  | "rate_limited"
  | "temporary_network"
  | "remote_service_unavailable"
  | "auth"
  | "bad_request"
  | "bad_response"
  | "timeout"
  | "unknown";

export interface LLMErrorClassification {
  kind: LLMErrorKind;
  retryable: boolean;
  status?: number;
  retry_after_ms?: number;
}

export interface LLMProviderErrorOptions extends LLMErrorClassification {
  provider: string;
  cause?: unknown;
}

export class LLMProviderError extends Error {
  readonly provider: string;
  readonly kind: LLMErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retry_after_ms?: number;
  readonly used_for_authority = false;

  constructor(message: string, options: LLMProviderErrorOptions) {
    super(message);
    this.name = "LLMProviderError";
    this.provider = options.provider;
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retry_after_ms = options.retry_after_ms;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function classifyLLMError(error: unknown): LLMErrorClassification {
  if (error instanceof LLMProviderError) {
    return {
      kind: error.kind,
      retryable: error.retryable,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.retry_after_ms !== undefined
        ? { retry_after_ms: error.retry_after_ms }
        : {}),
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "timeout", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}
