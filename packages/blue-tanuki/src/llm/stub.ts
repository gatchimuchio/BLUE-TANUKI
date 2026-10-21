import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "./base.js";

/**
 * StubBackend: deterministic echo. Used for Phase 0 smoke tests
 * and for offline development when no API key is available.
 */
export class StubBackend implements LLMBackend {
  readonly name = "stub";
  readonly capabilities = ["llm.text.generate"] as const;

  async call(req: LLMRequest): Promise<LLMResponse> {
    if (req.ephemeral_images?.length || req.ephemeral_audio?.length) {
      throw new LLMProviderError("Stub backend does not consume media input.", {
        provider: this.name,
        kind: "bad_request",
        retryable: false,
      });
    }
    const last = req.messages[req.messages.length - 1];
    const echo = last ? last.content : "(empty)";
    return {
      content: `[STUB:${this.name}] ${echo}`,
      tokens_used: 0,
      tokens_usage_status: "provider_reported",
      model: "stub-v0",
    };
  }
}
