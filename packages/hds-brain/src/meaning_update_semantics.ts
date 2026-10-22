import { createHash } from "node:crypto";
import {
  parseMeaningUpdateProposal,
  type MeaningUpdateProposalV3,
} from "@blue-tanuki/protocol";
import {
  isMeaningUpdateSourceObservationBinding,
  meaningUpdateProposalDigest,
  type MeaningUpdateSourceObservationBinding,
} from "./meaning_update_candidate.js";
import {
  interpretationContentDigest,
  type MemoryInterpretation,
  type MemoryInterpretationEvidenceReference,
} from "./memory_interpretation_semantics.js";

export const MEANING_UPDATE_MEMORY_SCHEMA_VERSION = "blue-tanuki.meaning-update-memory.v1" as const;

export interface MeaningUpdateMemoryRecord {
  readonly schema_version: typeof MEANING_UPDATE_MEMORY_SCHEMA_VERSION;
  readonly record_type: "meaning_update_memory";
  readonly record_id: string;
  readonly proposal_digest: string;
  readonly candidate_digest: string;
  readonly proposal: MeaningUpdateProposalV3;
  readonly source_observation_binding?: MeaningUpdateSourceObservationBinding;
  readonly approval_status: "approved";
  readonly memory_application_status: "applied";
  readonly follow_up_action_status: "unconfirmed";
  readonly semantic_relation_status: "not_assessed";
  readonly used_for_authority: false;
  readonly may_execute: false;
}

/** Pure canonical identity for the M record created after the existing J approval path. */
export function meaningUpdateMemoryRecordId(proposalDigest: string): string {
  return "meaning-update:" + proposalDigest;
}

/** Validate the persisted representation without reading or writing the M store. */
export function isMeaningUpdateMemoryRecord(value: unknown): value is MeaningUpdateMemoryRecord {
  const requiredKeys = ["schema_version", "record_type", "record_id", "proposal_digest", "candidate_digest", "proposal",
    "approval_status", "memory_application_status", "follow_up_action_status", "semantic_relation_status",
    "used_for_authority", "may_execute"];
  if (!isRecord(value) || requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => ![...requiredKeys, "source_observation_binding"].includes(key)) ||
      (Object.hasOwn(value, "source_observation_binding") && !isMeaningUpdateSourceObservationBinding(value.source_observation_binding))) return false;
  const parsed = parseMeaningUpdateProposal(value.proposal);
  if (!parsed.ok || parsed.record.schema_version !== "blue-tanuki.meaning-update-proposal.v3") return false;
  const proposalDigest = meaningUpdateProposalDigest(parsed.record);
  return value.schema_version === MEANING_UPDATE_MEMORY_SCHEMA_VERSION && value.record_type === "meaning_update_memory" &&
    value.record_id === meaningUpdateMemoryRecordId(proposalDigest) && value.proposal_digest === proposalDigest &&
    value.candidate_digest === parsed.record.candidate_digest && value.approval_status === "approved" &&
    value.memory_application_status === "applied" && value.follow_up_action_status === "unconfirmed" &&
    value.semantic_relation_status === "not_assessed" && value.used_for_authority === false && value.may_execute === false;
}

/** Build the exact, non-authoritative M record from the candidate approved by the caller. */
export function buildMeaningUpdateMemoryRecord(
  proposal: MeaningUpdateProposalV3,
  sourceObservationBinding?: MeaningUpdateSourceObservationBinding,
): MeaningUpdateMemoryRecord {
  if (sourceObservationBinding && !isMeaningUpdateSourceObservationBinding(sourceObservationBinding)) {
    throw new Error("meaning_update_source_observation_binding_invalid");
  }
  const proposal_digest = meaningUpdateProposalDigest(proposal);
  return Object.freeze({ schema_version: MEANING_UPDATE_MEMORY_SCHEMA_VERSION, record_type: "meaning_update_memory",
    record_id: meaningUpdateMemoryRecordId(proposal_digest), proposal_digest, candidate_digest: proposal.candidate_digest,
    ...(sourceObservationBinding ? { source_observation_binding: Object.freeze({ ...sourceObservationBinding }) } : {}),
    proposal: structuredClone(proposal), approval_status: "approved", memory_application_status: "applied",
    follow_up_action_status: "unconfirmed", semantic_relation_status: "not_assessed", used_for_authority: false,
    may_execute: false });
}

/** Pure M interpretation projection; persistence and J approval remain in the existing consumer. */
export function meaningUpdateInterpretationId(record: MeaningUpdateMemoryRecord): string {
  return "meaning-update-interpretation:" + record.proposal_digest;
}

export function meaningUpdateInterpretationForRecord(record: MeaningUpdateMemoryRecord): MemoryInterpretation {
  const proposal = record.proposal;
  const meaning = Object.freeze({
    proposal_digest: record.proposal_digest,
    candidate_ref: proposal.candidate_ref,
    candidate_digest: proposal.candidate_digest,
    candidate_meaning: proposal.candidate_meaning,
    target_reference: proposal.target_reference,
    prior_version_ref: proposal.prior_version_ref,
    supporting_evidence: proposal.supporting_evidence,
    counterevidence_review: proposal.counterevidence_review,
    ...(record.source_observation_binding ? { source_observation_binding: {
      schema_version: record.source_observation_binding.schema_version,
      digest: record.source_observation_binding.digest,
      count: record.source_observation_binding.count,
      used_as_world_truth: false,
      used_for_authority: false,
      may_execute: false,
    } } : {}),
  });
  return Object.freeze({
    interpretation_id: meaningUpdateInterpretationId(record),
    basis_ref: proposal.target_reference.record_id + "#" + proposal.target_reference.version,
    meaning,
    content_digest: interpretationContentDigest(meaning),
  });
}

export function meaningUpdateInterpretationEvidence(
  record: MeaningUpdateMemoryRecord,
): readonly MemoryInterpretationEvidenceReference[] {
  const references = record.proposal.counterevidence_review.status === "reviewed_with_references"
    ? record.proposal.counterevidence_review.references
    : record.proposal.supporting_evidence;
  return [
    ...references.map((reference) => ({ reference: reference.reference, digest: reference.digest })),
    ...(record.source_observation_binding ? [{
      reference: "operation-result-observations:" + record.source_observation_binding.digest,
      digest: record.source_observation_binding.digest,
    }] : []),
  ];
}

export function meaningUpdateInterpretationReasonDigest(proposalDigest: string, sourceObservationDigest?: string): string {
  const source = sourceObservationDigest ? ":" + sourceObservationDigest : "";
  return createHash("sha256").update("approved-meaning-update-reinterpretation:" + proposalDigest + source, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
