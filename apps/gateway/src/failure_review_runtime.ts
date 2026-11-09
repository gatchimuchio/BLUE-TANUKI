import {
  CompleteHistoryStore,
  commandContextPattern,
  commandPatternsMatch,
  createFailureReviewProjection,
  failureLearningLineageReference,
  failureSignatureDigest,
  resolveActor,
  sha256Hex,
  type CompleteHistoryEntry,
  type FailureSignature,
  type FailureMemoryStore,
} from "@blue-tanuki/hds-brain";
import {
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  type FailureReviewIndependentObservation,
  type InboundRequest,
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
    const signatureDigest = failureSignatureDigest(signature);
    const priorLearningLineages = store.listLearningLineageForSignature(signature.id)
      .filter((record) => record.signature_digest === signatureDigest)
      .slice(-32)
      .map(failureLearningLineageReference);
    const independentReadOnlyEvidence = completeHistory && chainValid
      ? latestPostSignatureFileSearchObservation(signature, completeHistory)
      : { baselineLastIndex: undefined, observation: undefined };
    const sourceStatus = !completeHistory || !chainValid
      ? completeHistory && !chainValid ? "invalid" : "unavailable"
      : independentReadOnlyEvidence.observation ? "verified" : "unavailable";
    const projection = createFailureReviewProjection(
      signature,
      independentReadOnlyEvidence.observation ? [independentReadOnlyEvidence.observation] : [],
      sourceStatus,
      priorLearningLineages,
      independentReadOnlyEvidence.baselineLastIndex,
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

/**
 * Find one actual, later read-only observation of the same exact file.search
 * under the same goal and actor/channel. It can inform scope review, but it is
 * not evidence that a failure cause was resolved or authority to resume work.
 */
function latestPostSignatureFileSearchObservation(
  signature: FailureSignature,
  history: CompleteHistoryStore,
): { baselineLastIndex?: number; observation?: FailureReviewIndependentObservation } {
  const baselineIds = new Set(signature.evidence_log_ids);
  if (signature.scope !== "file" || baselineIds.size === 0 || !commandPatternsMatch(
    signature.input_pattern,
    signature.action_pattern,
    signature.context_pattern,
  )) return { baselineLastIndex: undefined, observation: undefined };

  const entries = history.replay();
  const baselineEntries = entries.filter((entry) => baselineIds.has(entry.id));
  if (baselineEntries.length !== baselineIds.size) return { baselineLastIndex: undefined, observation: undefined };
  const baselineLastIndex = Math.max(...baselineEntries.map((entry) => entry.index));
  const laterObservation = [...entries].reverse().find((entry) =>
    isMatchingFileSearchObservation(entry, signature, baselineIds, baselineLastIndex));
  if (!laterObservation) return { baselineLastIndex, observation: undefined };

  const payload = asRecord(laterObservation.payload)!;
  return {
    baselineLastIndex,
    observation: {
      source: "complete_history",
      entry_id_digest: sha256Hex(laterObservation.id),
      entry_hash: laterObservation.entry_hash,
      payload_digest: laterObservation.payload_digest,
      entry_kind: laterObservation.kind,
      observed_failures: [],
      observation_kind: "post_signature_read_only",
      operation: "file.search",
      result_status: "success",
      entry_index: laterObservation.index,
      observed_at_ms: laterObservation.timestamp,
      action_pattern_digest: sha256Hex(signature.action_pattern),
      input_pattern_digest: sha256Hex(signature.input_pattern),
      context_pattern_digest: sha256Hex(signature.context_pattern),
      result_digest: sha256Hex(String(payload.result_digest)),
    },
  };
}

function isMatchingFileSearchObservation(
  entry: CompleteHistoryEntry,
  signature: FailureSignature,
  baselineIds: ReadonlySet<string>,
  baselineLastIndex: number,
): boolean {
  if (entry.kind !== "execution_history" || entry.index <= baselineLastIndex ||
      baselineIds.has(entry.id) || entry.source !== "executor" || !entry.actor) return false;
  const payload = asRecord(entry.payload);
  const command = asRecord(payload?.command);
  const commandPayload = asRecord(command?.payload);
  const failurePatterns = asRecord(command?.failure_patterns);
  const channel = payload?.origin_channel;
  if (payload?.status !== "success" || payload.result_present !== true ||
      typeof payload.result_digest !== "string" || !/^[a-f0-9]{64}$/i.test(payload.result_digest) ||
      command?.type !== "tool_call" || command.operation !== "file.search" ||
      commandPayload?.tool_name !== "file.search" ||
      typeof failurePatterns?.input_pattern !== "string" || typeof failurePatterns.action_pattern !== "string" ||
      typeof channel !== "string") return false;
  if (!commandPatternsMatch(
    failurePatterns.input_pattern,
    failurePatterns.action_pattern,
    signature.context_pattern,
  )) return false;
  return failurePatterns.input_pattern === signature.input_pattern &&
    failurePatterns.action_pattern === signature.action_pattern &&
    commandContextPattern({ actor: entry.actor, channel }) === signature.context_pattern;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
