import {
  CompleteHistoryStore,
  createFailureReviewProjection,
  extractFailureSignatures,
  resolveActor,
  sha256Hex,
  type FailureMemoryStore,
} from "@blue-tanuki/hds-brain";
import {
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  type InboundRequest,
  type FailureReviewIndependentObservation,
} from "@blue-tanuki/protocol";

const FAILURE_REVIEW_PREFIX = /^failure:review(?:\s|$)/i;
const FAILURE_REVIEW_COMMAND = /^failure:review\s+(\S+)$/i;

/**
 * Attach a digest-only saved-failure and linked-history projection to an
 * explicit Developer review request. This never issues the compute command
 * itself; HDS remains the only component that decides whether C is called.
 */
export function prepareFailureReviewInbound(
  input: unknown,
  store: FailureMemoryStore,
  completeHistory?: CompleteHistoryStore,
): unknown {
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
    const chainValid = completeHistory?.verify() ?? false;
    const independentObservations = chainValid
      ? linkedIndependentObservations(signature.evidence_log_ids, completeHistory!)
      : [];
    const projection = createFailureReviewProjection(
      signature,
      independentObservations,
      chainValid ? "verified" : completeHistory ? "invalid" : "unavailable",
    );
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

function linkedIndependentObservations(
  evidenceLogIds: readonly string[],
  completeHistory: CompleteHistoryStore,
): FailureReviewIndependentObservation[] {
  const evidence = new Set(evidenceLogIds);
  if (evidence.size === 0) return [];
  return completeHistory.all()
    .filter((entry) => evidence.has(entry.id))
    .map((entry) => ({
      source: "complete_history" as const,
      entry_id_digest: sha256Hex(entry.id),
      entry_hash: entry.entry_hash,
      payload_digest: entry.payload_digest,
      entry_kind: entry.kind,
      observed_failures: extractFailureSignatures({ kind: "complete_history", entry })
        .map(({ scope, failure_type }) => ({ scope, failure_type })),
    }));
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
