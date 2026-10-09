import { createHash } from "node:crypto";
import { GoalCriteriaSchema } from "@blue-tanuki/protocol";
import type { InboundRequest } from "@blue-tanuki/protocol";
import type { CandidateGoalCriteriaAssessment, RequestGoalCriteriaProjection } from "./types.js";

/** Build a request-bound, digest-only view of the caller's optional criteria. */
export function projectRequestGoalCriteria(
  request: InboundRequest,
  originalContent: string,
): RequestGoalCriteriaProjection {
  const contentSha256 = createHash("sha256").update(originalContent, "utf8").digest("hex");
  if (request.goal_criteria === undefined) {
    return freezeDeep<RequestGoalCriteriaProjection>({
      status: "not_provided",
      request_id: request.id,
      content_sha256: contentSha256,
      criteria: [],
      used_for_authority: false,
    });
  }

  const parsed = GoalCriteriaSchema.safeParse(request.goal_criteria);
  if (!parsed.success) {
    return freezeDeep<RequestGoalCriteriaProjection>({
      status: "invalid",
      request_id: request.id,
      content_sha256: contentSha256,
      criteria: [],
      used_for_authority: false,
    });
  }

  const criteria = parsed.data.criteria.map((criterion) => ({
    criterion_ref_digest: digest(criterion.criterion_ref),
    criterion_kind: criterion.criterion_kind,
    tool_relations: criterion.tool_relations.map((relation) => ({
      tool_name_digest: digest(canonicalToolName(relation.tool_name)),
      relation: relation.relation,
    })).sort((left, right) => left.tool_name_digest.localeCompare(right.tool_name_digest)),
  })).sort((left, right) => left.criterion_ref_digest.localeCompare(right.criterion_ref_digest));

  return freezeDeep<RequestGoalCriteriaProjection>({
    status: "provided",
    request_id: request.id,
    content_sha256: contentSha256,
    criteria_digest: digest(parsed.data),
    criteria,
    used_for_authority: false,
  });
}

/** Compare a candidate's tool identifier with criteria bound to its source request. */
export function assessCandidateGoalCriteria(
  toolName: string,
  projection: RequestGoalCriteriaProjection | undefined,
  expectedBinding?: { request_id: string; content_sha256: string },
): CandidateGoalCriteriaAssessment {
  if (!projection || projection.status === "not_provided" || projection.status === "invalid") {
    return {
      outcome: "unknown",
      evidence_status: "unknown",
      risk_status: "unverified",
      criterion_ref_digests: [],
      reason_code: projection?.status === "invalid" ? "criteria_invalid" : "criteria_unavailable",
    };
  }
  if (
    expectedBinding &&
    (projection.request_id !== expectedBinding.request_id || projection.content_sha256 !== expectedBinding.content_sha256)
  ) {
    return {
      outcome: "unknown",
      evidence_status: "unknown",
      risk_status: "unverified",
      criterion_ref_digests: [],
      reason_code: "criteria_invalid",
    };
  }

  const toolNameDigest = digest(canonicalToolName(toolName));
  const matches = projection.criteria.flatMap((criterion) =>
    criterion.tool_relations
      .filter((relation) => relation.tool_name_digest === toolNameDigest)
      .map((relation) => ({
        criterion_ref_digest: criterion.criterion_ref_digest,
        relation: relation.relation,
      })),
  );

  if (matches.some((match) => match.relation === "conflicts")) {
    return {
      outcome: "conflicts",
      evidence_status: "assumed",
      risk_status: "unverified",
      criterion_ref_digests: matches
        .filter((match) => match.relation === "conflicts")
        .map((match) => match.criterion_ref_digest),
      reason_code: "request_declares_criterion_conflict",
    };
  }
  if (matches.some((match) => match.relation === "supports")) {
    return {
      outcome: "supports",
      evidence_status: "assumed",
      risk_status: "unverified",
      criterion_ref_digests: matches
        .filter((match) => match.relation === "supports")
        .map((match) => match.criterion_ref_digest),
      reason_code: "request_declares_criterion_support_risk_unverified",
    };
  }

  return {
    outcome: "unknown",
    evidence_status: "unknown",
    risk_status: "unverified",
    criterion_ref_digests: [],
    reason_code: "no_matching_goal_criterion",
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

function canonicalToolName(value: string): string {
  return value.trim().normalize("NFKC");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}
