import {
  LLMToolCallCandidateSchema,
  type LLMCallFailureKind,
  type LLMToolCallCandidate,
} from "@blue-tanuki/protocol";

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

/** Registry-owned trace. Provider response metadata is never used to create this value. */
export const LLM_ROUTING_TRACE: unique symbol = Symbol("blue-tanuki.llm-routing-trace");

export interface LLMFallbackCostBound {
  amount: number;
  currency: string;
  source: "CONFIG";
}

export interface LLMFallbackProfile {
  capabilities: readonly string[];
  /** Owner-configured maximum estimate for one provider attempt. */
  max_cost_per_attempt: { amount: number; currency: string };
}

export interface LLMFallbackTrace {
  from_provider: string;
  failure_kind: LLMErrorKind;
  estimated_total_cost: LLMFallbackCostBound;
}

export interface LLMResponse {
  content: string;
  tokens_used: number;
  model: string;
  /** Native provider calls are data for J review, never dispatched here. */
  tool_calls?: LLMToolCallCandidate[];
  /** 未信頼の構造化C提案。Executorは表示結果から除き、HDSの検証入力へ渡す。 */
  meaning_update_proposal?: unknown;
  /** Canonical provider label selected by the local registry, when available. */
  provider?: string;
  raw?: unknown;
  [LLM_ROUTING_TRACE]?: LLMFallbackTrace;
}

export interface LLMBackend {
  readonly name: string;
  /** Set only by a local registry that stamps its selected canonical backend on responses. */
  readonly canonical_provider_identity?: true;
  call(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
}

export type LLMErrorKind = LLMCallFailureKind;

export type { LLMToolCallCandidate };

export const LLM_EXECUTION_TIMEOUT_REASON = Symbol.for("blue-tanuki.llm.execution-timeout.v1");
export const LLM_EXECUTION_CANCELLED_REASON = Symbol.for("blue-tanuki.llm.execution-cancelled.v1");

const MAX_TOOL_CALL_ARGUMENT_LENGTH = 65_536;
const MAX_TOOL_ARGUMENT_DEPTH = 20;
const MAX_TOOL_ARGUMENT_NODES = 4_096;
const MAX_TOOL_ARGUMENT_ARRAY_LENGTH = 512;
const MAX_TOOL_ARGUMENT_OBJECT_KEYS = 256;
const FORBIDDEN_TOOL_ARGUMENT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function createLLMToolCallCandidate(
  provider: string,
  callId: unknown,
  toolName: unknown,
  rawArguments: unknown,
): LLMToolCallCandidate {
  if (typeof callId !== "string" || !callId.trim() || callId.length > 200) {
    throw invalidStructuredOutput(provider);
  }
  if (typeof toolName !== "string" || !toolName.trim() || toolName.length > 200) {
    throw invalidStructuredOutput(provider);
  }

  let parsedArguments = rawArguments;
  if (typeof rawArguments === "string") {
    if (rawArguments.length > MAX_TOOL_CALL_ARGUMENT_LENGTH) {
      throw invalidStructuredOutput(provider);
    }
    try {
      parsedArguments = JSON.parse(rawArguments) as unknown;
    } catch {
      throw invalidStructuredOutput(provider);
    }
  }

  const argumentsObject = copySafeJsonObject(provider, parsedArguments);
  try {
    return LLMToolCallCandidateSchema.parse({
      schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
      call_id: callId.trim(),
      tool_name: toolName.trim(),
      arguments: argumentsObject,
      authority_boundary: {
        candidate_only: true,
        may_execute: false,
        used_for_authority: false,
      },
    });
  } catch {
    throw invalidStructuredOutput(provider);
  }
}

export function normalizeLLMToolCallCandidates(
  provider: string,
  candidates: unknown,
): LLMToolCallCandidate[] | undefined {
  if (candidates === undefined) return undefined;
  if (!Array.isArray(candidates) || candidates.length > 32) throw invalidStructuredOutput(provider);
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw invalidStructuredOutput(provider);
    }
    const record = candidate as Record<string, unknown>;
    return createLLMToolCallCandidate(provider, record.call_id, record.tool_name, record.arguments);
  });
}

function copySafeJsonObject(provider: string, value: unknown): Record<string, unknown> {
  const state = { nodes: 0 };
  const copied = copySafeJsonValue(provider, value, 0, state);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) {
    throw invalidStructuredOutput(provider);
  }
  return copied as Record<string, unknown>;
}

function copySafeJsonValue(provider: string, value: unknown, depth: number, state: { nodes: number }): unknown {
  state.nodes += 1;
  if (depth > MAX_TOOL_ARGUMENT_DEPTH || state.nodes > MAX_TOOL_ARGUMENT_NODES) {
    throw invalidStructuredOutput(provider);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_TOOL_CALL_ARGUMENT_LENGTH) throw invalidStructuredOutput(provider);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidStructuredOutput(provider);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_TOOL_ARGUMENT_ARRAY_LENGTH) throw invalidStructuredOutput(provider);
    return value.map((entry) => copySafeJsonValue(provider, entry, depth + 1, state));
  }
  if (typeof value !== "object") throw invalidStructuredOutput(provider);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidStructuredOutput(provider);
  const entries = Object.entries(value);
  if (entries.length > MAX_TOOL_ARGUMENT_OBJECT_KEYS) throw invalidStructuredOutput(provider);
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of entries) {
    if (!key || key.length > 256 || FORBIDDEN_TOOL_ARGUMENT_KEYS.has(key)) {
      throw invalidStructuredOutput(provider);
    }
    copied[key] = copySafeJsonValue(provider, entry, depth + 1, state);
  }
  return copied;
}

function invalidStructuredOutput(provider: string): LLMProviderError {
  return new LLMProviderError("Provider returned invalid structured output.", {
    provider,
    kind: "invalid_structured_output",
    retryable: false,
  });
}

export function createLLMAbortError(provider: string, signal?: AbortSignal): LLMProviderError {
  const timedOut = signal?.reason === LLM_EXECUTION_TIMEOUT_REASON;
  return new LLMProviderError(
    timedOut ? "Provider request timed out." : "Provider request was cancelled.",
    {
      provider,
      kind: timedOut ? "timeout" : "cancelled",
      retryable: timedOut,
    },
  );
}

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
    return { kind: "cancelled", retryable: false };
  }
  return { kind: "unknown", retryable: false };
}
