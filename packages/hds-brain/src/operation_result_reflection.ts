import { createHash } from "node:crypto";
import { OperationPlanReflectionCandidateSchema, type ExecuteCommand, type ExecuteFeedback } from "@blue-tanuki/protocol";

export interface ResultObservationCitation {
  record_id: string; record_digest: string; memory_revision: number; receipt_digest: string;
  source_revision_digest: string; step_digest: string; delivery_digest: string;
  observed_at_ms: number; expires_at_ms: number; operation: "file.search";
  observation: { reported_status: "succeeded"; match_count: number; visited_files: number; completeness: "unknown" };
  adoption_status: "observation_only"; counterevidence_status: "not_assessed";
  used_as_world_truth: false; used_for_authority: false; may_execute: false;
}
export interface ResultObservationProjection {
  schema_version: "operation-result-current-projection.v1";
  scope: { plan_handle: string; revision_digest: string; owner_digest: string; channel_digest: string };
  citations: ResultObservationCitation[];
  used_for_authority: false; memory_adoption: false; may_execute: false;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** ExecutorのCompute対応を照合する。provider自己申告は権限・意味の正しさを証明しない。 */
function computeMatches(command: Extract<ExecuteCommand, { type: "llm_call" }>, result: unknown): boolean {
  if (!record(result) || !record(result.execution_identity) || !record(result.authority_boundary)) return false;
  const context = command.payload.compute_context;
  if (!context || command.payload.session_id || context.fallback_authorization) return false;
  const i = result.execution_identity;
  const providerRequest = { messages: command.payload.messages,
    ...(command.payload.backend_hint !== undefined ? { backend_hint: command.payload.backend_hint } : {}),
    ...(command.payload.model !== undefined ? { model: command.payload.model } : {}),
    ...(command.payload.temperature !== undefined ? { temperature: command.payload.temperature } : {}),
    ...(command.constraints?.max_tokens !== undefined ? { max_tokens: command.constraints.max_tokens } : {}),
    ...(command.constraints?.timeout_ms !== undefined ? { timeout_ms: command.constraints.timeout_ms } : {}) };
  const { execution_identity: _identity, cost: _cost, authority_boundary: _boundary, ...output } = result;
  return i.request_id === command.id && i.current_projection_digest === context.projection_digest &&
    i.input_digest === hash(providerRequest) && i.output_digest === hash(output) &&
    record(i.c_profile) && i.c_profile.id === "blue-tanuki.llm-call" && i.c_profile.version === "1" &&
    i.local_p_version === context.local_p_version && record(i.provider) && record(i.provider.fallback) &&
    i.provider.fallback.used === false && i.provider.requested === context.data_exposure.requested_egress_provider &&
    typeof i.provider.actual === "string" && i.provider.actual.length > 0 && i.provider.actual === result.provider &&
    record(i.model) && i.model.requested === (command.payload.model ?? null) &&
    typeof i.model.actual === "string" && i.model.actual.length > 0 && i.model.actual === result.model &&
    record(i.data_exposure_scope) && hash(i.data_exposure_scope) === hash({ input_sources: context.data_exposure.input_sources,
      requested_egress_provider: context.data_exposure.requested_egress_provider }) &&
    record(i.resource_limits) && i.resource_limits.max_tokens === (command.constraints?.max_tokens ?? null) &&
    i.resource_limits.timeout_ms === (command.constraints?.timeout_ms ?? null) &&
    result.authority_boundary.compute_output_used_for_authority === false &&
    result.authority_boundary.provider_metadata_used_for_authority === false && result.authority_boundary.used_for_authority === false;
}

/** 表示前の引用照合。失敗内容やCの任意metadataを返さず、解釈候補のみ保持する。 */
export function reviewResultReflection(command: ExecuteCommand, feedback: ExecuteFeedback,
  projection: ResultObservationProjection | undefined, projectionDigest: string | undefined): { content: string; accepted: boolean } {
  const rejected = { content: "観測の解釈候補を採用できませんでした。仕事の現在版・観測期限・保存状態を確認して再要求してください。記憶や作用は変更していません。", accepted: false };
  try {
    if (command.type !== "llm_call" || feedback.command_id !== command.id || feedback.status !== "success" ||
        !projection || !projectionDigest || feedback.llm_tool_candidates !== undefined ||
        feedback.meaning_update_proposal !== undefined || feedback.skeptical_review !== undefined ||
        !record(feedback.result) || Object.keys(feedback.result).some((key) =>
          !["content", "model", "tokens_used", "provider", "execution_identity", "cost", "authority_boundary"].includes(key)) ||
        !computeMatches(command, feedback.result) || typeof feedback.result.content !== "string" || feedback.result.content.length > 32000) return rejected;
    const candidate = OperationPlanReflectionCandidateSchema.parse(JSON.parse(feedback.result.content));
    if (candidate.projection_digest !== projectionDigest) return rejected;
    const ids = new Set<string>();
    for (const citation of candidate.citations) {
      if (ids.has(citation.record_id) || !projection.citations.some((source) => source.record_id === citation.record_id &&
          source.record_digest === citation.record_digest)) return rejected;
      ids.add(citation.record_id);
    }
    return { accepted: true, content: JSON.stringify({ schema_version: "operation-result-reflection-review.v1",
      status: "references_verified_interpretation_unverified", projection_digest: projectionDigest,
      citations: candidate.citations.map((citation) => ({ ...citation,
        source: projection.citations.find((source) => source.record_id === citation.record_id)! })),
      interpretation_status: "candidate_only", memory_adoption: false, used_as_world_truth: false,
      used_for_authority: false, may_execute: false }, null, 2) };
  } catch { return rejected; }
}
