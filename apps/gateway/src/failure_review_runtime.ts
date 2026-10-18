import {
  createFailureReviewProjection,
  resolveActor,
  type FailureMemoryStore,
} from "@blue-tanuki/hds-brain";
import {
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  type InboundRequest,
} from "@blue-tanuki/protocol";

const FAILURE_REVIEW_PREFIX = /^failure:review(?:\s|$)/i;
const FAILURE_REVIEW_COMMAND = /^failure:review\s+(\S+)$/i;

/**
 * Attach a digest-only saved-failure projection to an explicit Developer
 * review request. This never issues the compute command itself; HDS remains
 * the only component that decides whether a C command is emitted.
 */
export function prepareFailureReviewInbound(input: unknown, store: FailureMemoryStore): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const request = input as InboundRequest;
  if (!FAILURE_REVIEW_PREFIX.test(request.content.trim())) return input;
  if (!isGatewayInternalInboundRequest(input) ||
      request.metadata?.["blue_tanuki.operator_surface"] !== "developer" ||
      !["owner", "user"].includes(resolveActor(request).actor_kind)) {
    return input;
  }

  const match = FAILURE_REVIEW_COMMAND.exec(request.content.trim());
  if (!match) return input;
  const selector = match[1]!;
  const signature = selector.toLowerCase() === "latest"
    ? latestFailureSignature(store)
    : store.get(selector);
  if (!signature) return input;

  try {
    const projection = createFailureReviewProjection(signature);
    return createGatewayInternalInboundRequest({
      ...request,
      metadata: {
        ...request.metadata,
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.failure_review.version": "blue-tanuki.failure-review.v1",
        "blue_tanuki.failure_review.signature_id": projection.signature_id,
        "blue_tanuki.failure_review.projection_json": JSON.stringify(projection),
      },
    });
  } catch {
    // Malformed persisted state cannot be promoted into a C request. HDS will
    // see the explicit control command without a projection and fail closed.
    return input;
  }
}

function latestFailureSignature(store: FailureMemoryStore) {
  return store.list().sort((left, right) => {
    const updated = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (Number.isFinite(updated) && updated !== 0) return updated;
    const created = Date.parse(right.created_at) - Date.parse(left.created_at);
    if (Number.isFinite(created) && created !== 0) return created;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}
