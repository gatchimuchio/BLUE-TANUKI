import { LLMProviderError } from "./base.js";

const DEFAULT_PROVIDER_HTTP_TIMEOUT_MS = 30_000;

export async function fetchWithProviderTimeout(
  provider: string,
  input: string,
  init: RequestInit,
  timeout_ms: number | undefined,
): Promise<Response> {
  const timeoutMs = timeout_ms ?? DEFAULT_PROVIDER_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new LLMProviderError(`${provider}: HTTP timeout after ${timeoutMs}ms`, {
        provider,
        kind: "timeout",
        retryable: true,
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): error is Error {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}
