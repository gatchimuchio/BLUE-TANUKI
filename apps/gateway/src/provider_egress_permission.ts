import { createHash } from "node:crypto";
import { SETTINGS_WRITE_ACTIVATION_DESTINATIONS, type ComputeGrant } from "@blue-tanuki/protocol";

export interface OneShotOpenAITextEgressPermission {
  readonly request_id: string;
  readonly purpose_digest: string;
  readonly endpoint: string;
  readonly model: string;
  readonly binding: Readonly<{ request_id: string; purpose_digest: string; endpoint: string; model: string }>;
  assertCurrent(grant: ComputeGrant | undefined): void;
  revoke(): void;
}

/** The authenticated owner's one-shot choice is request-scoped and separate from provider configuration and credentials. */
export function createOneShotOpenAITextEgressPermission(
  request: { id: string; content: string },
  model: string,
): OneShotOpenAITextEgressPermission {
  if (!model || model.trim() !== model || model.length > 256) {
    throw new Error("openai_text_egress_model_unavailable");
  }
  const requestId = request.id;
  const purposeDigest = createHash("sha256")
    .update("blue-tanuki.compute-grant.purpose.v1\0")
    .update(request.content, "utf8")
    .digest("hex");
  const endpoint = SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai;
  const binding = Object.freeze({ request_id: requestId, purpose_digest: purposeDigest, endpoint, model });
  let active = true;

  return Object.freeze({
    request_id: requestId,
    purpose_digest: purposeDigest,
    endpoint,
    model,
    binding,
    assertCurrent(grant: ComputeGrant | undefined): void {
      const now = Date.now();
      if (!active || !grant || grant.issuer !== "J" || grant.request_id !== requestId ||
          grant.purpose_digest !== purposeDigest || grant.provider !== "openai-compatible" ||
          grant.model !== model || grant.egress?.endpoint !== endpoint || grant.local_p_version !== "blue-tanuki.c-input-rules.v1" ||
          grant.allowed_input_sources.length !== 1 || grant.allowed_input_sources[0] !== "accepted_inbound_request" ||
          grant.issued_at_ms > now || grant.expires_at_ms <= now ||
          grant.expires_at_ms - grant.issued_at_ms > grant.max_compute_ms) {
        throw new Error("openai_text_egress_permission_not_current");
      }
    },
    revoke(): void {
      active = false;
    },
  });
}
