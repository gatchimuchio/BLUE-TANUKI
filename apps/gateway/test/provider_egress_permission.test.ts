import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SETTINGS_WRITE_ACTIVATION_DESTINATIONS, type ComputeGrant } from "@blue-tanuki/protocol";
import { createOneShotOpenAITextEgressPermission } from "../src/provider_egress_permission.js";

const request = { id: "cli-request-1", content: "send this one request" };

function makeGrant(overrides: Partial<ComputeGrant> = {}): ComputeGrant {
  const issuedAt = Date.now();
  return {
    schema_version: "blue-tanuki.compute-grant.v1",
    grant_id: "5f5f8a10-2905-4ab6-a895-d94dbf89621a",
    request_id: request.id,
    task_identity_digest: "a".repeat(64),
    projection_digest: "b".repeat(64),
    purpose_digest: createHash("sha256")
      .update("blue-tanuki.compute-grant.purpose.v1\0")
      .update(request.content, "utf8")
      .digest("hex"),
    local_p_version: "blue-tanuki.c-input-rules.v1",
    provider: "openai-compatible",
    model: "synthetic-model",
    egress: { endpoint: SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai },
    allowed_input_sources: ["accepted_inbound_request"],
    max_tokens: 64,
    max_compute_ms: 30_000,
    max_cost: { amount: 0.01, currency: "USD" },
    issued_at_ms: issuedAt,
    expires_at_ms: issuedAt + 30_000,
    issuer: "J",
    ...overrides,
  };
}

describe("one-shot OpenAI text egress permission", () => {
  it("accepts only the current owner request's bounded J grant", () => {
    const permission = createOneShotOpenAITextEgressPermission(request);

    expect(permission.request_id).toBe(request.id);
    expect(permission.endpoint).toBe(SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai);
    expect(permission.assertCurrent(makeGrant())).toBeUndefined();
  });

  it.each([
    ["another request", { request_id: "cli-request-2" }],
    ["another purpose", { purpose_digest: "c".repeat(64) }],
    ["another provider", { provider: "other-provider" }],
    ["another endpoint", { egress: { endpoint: "https://provider.example/v1" } }],
    ["a broader input scope", { allowed_input_sources: ["accepted_inbound_request", "session_history"] }],
    ["another local policy", { local_p_version: "blue-tanuki.other-policy.v1" }],
  ])("rejects a grant with %s", (_label, changes) => {
    const permission = createOneShotOpenAITextEgressPermission(request);

    expect(() => permission.assertCurrent(makeGrant(changes))).toThrow("openai_text_egress_permission_not_current");
  });

  it("rejects expired and revoked permissions", () => {
    const permission = createOneShotOpenAITextEgressPermission(request);
    const expiredAt = Date.now() - 1;
    expect(() => permission.assertCurrent(makeGrant({
      issued_at_ms: expiredAt - 1,
      expires_at_ms: expiredAt,
      max_compute_ms: 1,
    }))).toThrow("openai_text_egress_permission_not_current");

    permission.revoke();
    expect(() => permission.assertCurrent(makeGrant())).toThrow("openai_text_egress_permission_not_current");
  });
});
