import type { LLMBackend, LLMRequest, LLMResponse } from "./base.js";

/**
 * StubBackend: deterministic echo. Used for Phase 0 smoke tests
 * and for offline development when no API key is available.
 */
export class StubBackend implements LLMBackend {
  readonly name = "stub";

  async call(req: LLMRequest): Promise<LLMResponse> {
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
