import {
  LLMProviderError,
  LLM_EXECUTION_TIMEOUT_REASON,
  createLLMAbortError,
} from "./base.js";

const DEFAULT_PROVIDER_HTTP_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function fetchWithProviderTimeout<T>(
  provider: string,
  input: string,
  init: RequestInit,
  timeout_ms: number | undefined,
  consumeResponse: (response: Response) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (callerSignal?.aborted) throw createLLMAbortError(provider, callerSignal);
  const timeoutMs = timeout_ms ?? DEFAULT_PROVIDER_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  const relayCallerAbort = () => {
    callerCancelled = true;
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener("abort", relayCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(LLM_EXECUTION_TIMEOUT_REASON);
  }, timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return await consumeResponse(response);
  } catch (error) {
    if (timedOut) throw createLLMAbortError(provider, controller.signal);
    if (callerCancelled || callerSignal?.aborted) {
      throw createLLMAbortError(provider, callerSignal);
    }
    if (error instanceof LLMProviderError) throw error;
    if (isAbortError(error)) throw createLLMAbortError(provider, controller.signal);
    if (isDisconnectError(error)) {
      throw new LLMProviderError("Provider disconnected before the response completed.", {
        provider,
        kind: "disconnected",
        retryable: true,
        cause: error,
      });
    }
    throw new LLMProviderError("Provider request failed.", {
      provider,
      kind: "unknown",
      retryable: false,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", relayCallerAbort);
  }
}

export async function readProviderJson(provider: string, response: Response): Promise<unknown> {
  if (!response.body) throw invalidStructuredOutput(provider);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_PROVIDER_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw invalidStructuredOutput(provider);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidStructuredOutput(provider);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidStructuredOutput(provider);
  }
}

function invalidStructuredOutput(provider: string): LLMProviderError {
  return new LLMProviderError("Provider returned invalid structured output.", {
    provider,
    kind: "invalid_structured_output",
    retryable: false,
  });
}

function isAbortError(error: unknown): error is Error {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}

function isDisconnectError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return new Set([
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ECONNREFUSED",
    "UND_ERR_SOCKET",
  ]).has(String((error as { code?: unknown }).code));
}
