import { createHash } from "node:crypto";
import type { OperationPlanMemoryInterpretationDependency } from "@blue-tanuki/protocol";
import { memoryJudgmentReassessmentApprovalTarget, type ApprovalEvaluation } from "./approval_policy.js";
import type { AuditEntry } from "./audit.js";
import { sha256 } from "./controller_security.js";
import type { MemoryInterpretationRecord } from "./記憶再解釈.js";
import type { MemoryCitationReference, MemoryCitationReviewLog } from "./types.js";

export interface MemoryJudgmentReassessmentArguments {
  readonly citation_request_id: string;
  readonly citation_command_id: string;
  readonly target_record_id: string;
  readonly target_version: string;
  readonly interpretation_id: string;
  readonly judgment_ref: string;
  readonly citation_audit_digest: string;
}

export interface OwnerMemoryJudgmentReassessmentProposal {
  readonly args: MemoryJudgmentReassessmentArguments;
  readonly reassesses_judgment_refs: readonly string[];
}

export function memoryCitationReviewAuditDigest(log: MemoryCitationReviewLog): string {
  return createHash("sha256").update(JSON.stringify(log), "utf8").digest("hex");
}

export function memoryCitationJudgmentRef(requestId: string, commandId: string, recordId: string, version: string): string {
  return `memory-citation-review:${sha256({ schema_version: "memory-citation-judgment.v1", request_id: requestId,
    command_id: commandId, record_id: recordId, version })}`;
}

export function memoryCitationReviewUsesReference(log: MemoryCitationReviewLog,
  reference: MemoryCitationReviewLog["accepted_citations"][number]["supporting"]): boolean {
  return log.accepted_citations.some((citation) =>
    (citation.supporting.record_id === reference.record_id && citation.supporting.version === reference.version) ||
    (citation.counterevidence.record_id === reference.record_id && citation.counterevidence.version === reference.version));
}

export function memoryJudgmentRefsDigest(references: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...references].sort()), "utf8").digest("hex");
}

export function memoryJudgmentReassessmentApprovalEvidence(
  entries: readonly AuditEntry[],
  input: { request_id: string; command_id: string; proposal_actor: string; reviewer_actor: string;
    target: string; command_digest: string; citation_audit_digest: string; reassesses_digest: string;
    before_index?: number },
): { readonly timestamp: number; readonly evaluation: ApprovalEvaluation } | null {
  const limit = input.before_index ?? Number.POSITIVE_INFINITY;
  const ask = entries.find(({ index, log }) => index < limit && "kind" in log && log.kind === "approval_gate" &&
    log.request_id === input.request_id && log.command_id === input.command_id &&
    log.evaluation.decision === "ask" && log.evaluation.context.operation === "tool.call" &&
    log.evaluation.context.command_id === input.command_id && log.evaluation.context.actor === input.proposal_actor &&
    log.evaluation.context.target === input.target && log.evaluation.risk === "high" &&
    log.evaluation.approval_level === "L3_final_review" && log.evaluation.final_review_required);
  if (!ask || !("kind" in ask.log) || ask.log.kind !== "approval_gate") return null;
  const review = entries.find(({ index, log }) => index > ask.index && index < limit && "kind" in log &&
    log.kind === "operation_plan" && log.event === "memory_judgment_reassessment_content_reviewed" &&
    log.request_id === input.request_id && log.command_id === input.command_id &&
    log.projection_digest === input.command_digest && log.citation_audit_digest === input.citation_audit_digest &&
    log.reassesses_digest === input.reassesses_digest && log.used_for_authority === false);
  if (!review) return null;
  const approved = entries.find(({ index, log }) => index > review.index && index < limit && "kind" in log &&
    log.kind === "command_lifecycle" && log.request_id === input.request_id && log.command_id === input.command_id &&
    log.phase === "approval_approved" && log.actor === input.reviewer_actor && log.reason === "human_approval:approve");
  return approved ? { timestamp: approved.log.timestamp, evaluation: ask.log.evaluation } : null;
}

/**
 * Projects accepted C citations onto current M interpretation dependencies and
 * prior J judgments. M reads and audit-log retrieval are supplied by the caller.
 */
export function buildMemoryCitationInterpretationDependencies(input: {
  readonly request_id: string;
  readonly command_id: string;
  readonly review: Pick<MemoryCitationReviewLog, "status" | "accepted_citations">;
  readonly prior_reviews: readonly MemoryCitationReviewLog[];
  readonly current_memory: readonly { readonly reference: MemoryCitationReference;
    readonly record: MemoryInterpretationRecord | null }[];
}): OperationPlanMemoryInterpretationDependency[] {
  if (input.review.status !== "accepted" && input.review.status !== "accepted_with_rejections") return [];
  const references = new Map<string, MemoryCitationReference>();
  for (const citation of input.review.accepted_citations) {
    references.set(JSON.stringify([citation.supporting.record_id, citation.supporting.version]), citation.supporting);
    references.set(JSON.stringify([citation.counterevidence.record_id, citation.counterevidence.version]), citation.counterevidence);
  }
  const recordsByReference = new Map(input.current_memory.map(({ reference, record }) =>
    [JSON.stringify([reference.record_id, reference.version]), record] as const));
  const dependencies: OperationPlanMemoryInterpretationDependency[] = [];
  for (const [key, reference] of references) {
    const record = recordsByReference.get(key);
    const interpretationId = record?.current_interpretation_id;
    const interpretation = interpretationId
      ? record?.interpretations.find((item) => item.interpretation_id === interpretationId)
      : undefined;
    if (!record || record.application_state !== "active" || !interpretationId ||
        interpretation?.basis_ref !== `${reference.record_id}#${reference.version}`) continue;
    const reassessesJudgmentRefs = [...new Set(input.prior_reviews.flatMap((log) => {
      if (!log.request_id || (log.status !== "accepted" && log.status !== "accepted_with_rejections")) return [];
      return (log.interpretation_dependencies ?? []).filter((dependency) =>
        dependency.reference.record_id === reference.record_id && dependency.reference.version === reference.version &&
        dependency.interpretation_id !== interpretationId &&
        dependency.judgment_ref === memoryCitationJudgmentRef(log.request_id!, log.command_id,
          dependency.reference.record_id, dependency.reference.version) &&
        memoryCitationReviewUsesReference(log, dependency.reference) &&
        record.dependent_judgments.some((judgment) => judgment.judgment_ref === dependency.judgment_ref &&
          judgment.basis_interpretation_id === dependency.interpretation_id && judgment.reassessment_required))
        .map((dependency) => dependency.judgment_ref);
    }))];
    dependencies.push({ reference, interpretation_id: interpretationId,
      judgment_ref: memoryCitationJudgmentRef(input.request_id, input.command_id, reference.record_id, reference.version),
      ...(reassessesJudgmentRefs.length ? { reassesses_judgment_refs: reassessesJudgmentRefs } : {}) });
  }
  return dependencies;
}

/**
 * Evaluates whether an audited citation judgment is current using immutable audit
 * entries and an already-read M projection. This function performs no reads or writes.
 */
export function isMemoryCitationJudgmentReassessmentEligible(input: {
  readonly dependency: OperationPlanMemoryInterpretationDependency;
  readonly record: MemoryInterpretationRecord;
  readonly verified_audit_entries: readonly AuditEntry[];
}): boolean {
  const { dependency, record, verified_audit_entries: auditEntries } = input;
  const interpretation = record.interpretations.find((item) => item.interpretation_id === dependency.interpretation_id);
  if (record.application_state !== "active" || record.current_interpretation_id !== dependency.interpretation_id ||
      interpretation?.basis_ref !== `${dependency.reference.record_id}#${dependency.reference.version}`) return false;
  const entries = auditEntries.map(({ log }) => log).filter((log) => isMemoryCitationReviewLog(log) && log.request_id &&
    (log.status === "accepted" || log.status === "accepted_with_rejections") &&
    (log.interpretation_dependencies ?? []).some((candidate) =>
      candidate.reference.record_id === dependency.reference.record_id &&
      candidate.reference.version === dependency.reference.version &&
      candidate.interpretation_id === dependency.interpretation_id && candidate.judgment_ref === dependency.judgment_ref));
  if (entries.length !== 1) return false;
  const currentLog = entries[0];
  if (!isMemoryCitationReviewLog(currentLog) || !currentLog.request_id) return false;
  const currentDependencies = (currentLog.interpretation_dependencies ?? []).filter((candidate) =>
    candidate.reference.record_id === dependency.reference.record_id &&
    candidate.reference.version === dependency.reference.version &&
    candidate.interpretation_id === dependency.interpretation_id && candidate.judgment_ref === dependency.judgment_ref);
  if (currentDependencies.length !== 1) return false;
  const currentDependency = currentDependencies[0];
  if (!currentDependency ||
      currentDependency.judgment_ref !== memoryCitationJudgmentRef(currentLog.request_id, currentLog.command_id,
        dependency.reference.record_id, dependency.reference.version) ||
      !memoryCitationReviewUsesReference(currentLog, dependency.reference)) return false;
  const exactBasisRef = `${dependency.reference.record_id}#${dependency.reference.version}`;
  const priorCitationDependencies = auditEntries.flatMap(({ log }) => {
    if (!isMemoryCitationReviewLog(log) || !log.request_id ||
        (log.status !== "accepted" && log.status !== "accepted_with_rejections")) return [];
    return (log.interpretation_dependencies ?? []).filter((candidate) =>
      candidate.reference.record_id === dependency.reference.record_id &&
      candidate.reference.version === dependency.reference.version &&
      candidate.interpretation_id !== dependency.interpretation_id &&
      record.interpretations.some((item) => item.interpretation_id === candidate.interpretation_id &&
        item.basis_ref === exactBasisRef) &&
      candidate.judgment_ref === memoryCitationJudgmentRef(log.request_id!, log.command_id,
        candidate.reference.record_id, candidate.reference.version) &&
      memoryCitationReviewUsesReference(log, candidate.reference))
      .map((candidate) => ({ judgment_ref: candidate.judgment_ref, request_id: log.request_id!,
        command_id: log.command_id, citation_audit_digest: memoryCitationReviewAuditDigest(log) }));
  });
  const historicalJudgmentRefs = priorCitationDependencies.map((candidate) => candidate.judgment_ref).sort();
  if (new Set(historicalJudgmentRefs).size !== historicalJudgmentRefs.length) return false;
  const memoryCitationReassessments = record.dependent_judgments.filter((judgment) => {
    const basis = record.interpretations.find((item) => item.interpretation_id === judgment.basis_interpretation_id);
    return basis?.basis_ref === exactBasisRef && judgment.basis_interpretation_id !== dependency.interpretation_id &&
      judgment.judgment_ref.startsWith("memory-citation-review:");
  });
  const memoryReassessmentRefs = memoryCitationReassessments.map((judgment) => judgment.judgment_ref).sort();
  if (new Set(memoryReassessmentRefs).size !== memoryReassessmentRefs.length ||
      historicalJudgmentRefs.length !== memoryReassessmentRefs.length ||
      historicalJudgmentRefs.some((judgmentRef, index) => judgmentRef !== memoryReassessmentRefs[index])) return false;
  const currentCitationEntry = auditEntries.find(({ log }) => log === currentLog);
  if (!currentCitationEntry) return false;
  const priorJudgmentResolvedBeforeCurrentReview = (judgmentRef: string): boolean => {
    const prior = priorCitationDependencies.find((candidate) => candidate.judgment_ref === judgmentRef);
    if (!prior) return false;
    return auditEntries.some(({ index, log }) => {
      if (index >= currentCitationEntry.index || !("kind" in log) || log.kind !== "operation_plan" ||
          log.event !== "memory_judgment_reassessment_committed" ||
          log.target_record_id !== dependency.reference.record_id || log.target_version !== dependency.reference.version ||
          log.judgment_ref === judgmentRef || log.reassessment_status !== "applied" ||
          log.approval_status !== "approved" || log.memory_application_status !== "applied" ||
          log.used_for_authority !== false || log.may_execute !== false) return false;
      const event = record.events.find((candidate) =>
        candidate.event_id === `memory-citation-reassessed:${log.citation_audit_digest}` &&
        candidate.kind === "reassessed");
      return event !== undefined && event.reassessment_judgment_ref === log.judgment_ref &&
        event.affected_judgment_refs.includes(judgmentRef);
    });
  };
  const expectedReassessments = historicalJudgmentRefs.filter((judgmentRef) =>
    !priorJudgmentResolvedBeforeCurrentReview(judgmentRef));
  const recordedReassessments = currentDependency.reassesses_judgment_refs ?? [];
  if (new Set(recordedReassessments).size !== recordedReassessments.length) return false;
  if (expectedReassessments.length !== recordedReassessments.length ||
      !expectedReassessments.every((judgmentRef, index) => judgmentRef === [...recordedReassessments].sort()[index])) return false;
  const currentJudgment = record.dependent_judgments.find((judgment) => judgment.judgment_ref === dependency.judgment_ref);
  if (!currentJudgment) return expectedReassessments.every((judgmentRef) =>
    memoryCitationReassessments.find((judgment) => judgment.judgment_ref === judgmentRef)?.reassessment_required === true);
  if (currentJudgment.basis_interpretation_id !== dependency.interpretation_id || currentJudgment.reassessment_required ||
      memoryCitationReassessments.some((judgment) => judgment.reassessment_required)) return false;
  const reassessesDigest = memoryJudgmentRefsDigest(expectedReassessments);
  const citationAuditDigest = memoryCitationReviewAuditDigest(currentLog);
  const target = memoryJudgmentReassessmentApprovalTarget({
    citation_request_id: currentLog.request_id, citation_command_id: currentLog.command_id,
    target_record_id: dependency.reference.record_id, target_version: dependency.reference.version,
    interpretation_id: dependency.interpretation_id, judgment_ref: dependency.judgment_ref,
    citation_audit_digest: citationAuditDigest,
  });
  const committed = auditEntries.filter(({ log }) => "kind" in log && log.kind === "operation_plan" &&
    log.event === "memory_judgment_reassessment_committed" && log.judgment_ref === dependency.judgment_ref &&
    log.citation_audit_digest === citationAuditDigest &&
    log.target_record_id === dependency.reference.record_id && log.target_version === dependency.reference.version &&
    log.interpretation_id === dependency.interpretation_id && log.reassesses_digest === reassessesDigest);
  if (committed.length !== 1) return false;
  const markerEntry = committed[0]!;
  const marker = markerEntry.log;
  if (!("kind" in marker) || marker.kind !== "operation_plan" ||
      marker.event !== "memory_judgment_reassessment_committed" || !marker.request_id || !marker.command_id ||
      !marker.projection_digest || marker.reassessment_status !== "applied" || marker.approval_status !== "approved" ||
      marker.memory_application_status !== "applied" || marker.used_for_authority !== false || marker.may_execute !== false) return false;
  const event = record.events.find((item) => item.event_id === `memory-citation-reassessed:${citationAuditDigest}` &&
    item.kind === "reassessed");
  if (!event || event.reassessment_judgment_ref !== dependency.judgment_ref ||
      memoryJudgmentRefsDigest(event.affected_judgment_refs) !== reassessesDigest) return false;
  const askEntry = auditEntries.find(({ log }) => "kind" in log && log.kind === "approval_gate" &&
    log.request_id === marker.request_id && log.command_id === marker.command_id);
  const approvedEntry = auditEntries.find(({ log }) => "kind" in log && log.kind === "command_lifecycle" &&
    log.request_id === marker.request_id && log.command_id === marker.command_id && log.phase === "approval_approved");
  if (!askEntry || !("kind" in askEntry.log) || askEntry.log.kind !== "approval_gate" || !approvedEntry ||
      !("kind" in approvedEntry.log) || approvedEntry.log.kind !== "command_lifecycle") return false;
  const evidence = memoryJudgmentReassessmentApprovalEvidence(auditEntries, {
    request_id: marker.request_id, command_id: marker.command_id,
    proposal_actor: askEntry.log.evaluation.context.actor, reviewer_actor: approvedEntry.log.actor,
    target, command_digest: marker.projection_digest, citation_audit_digest: citationAuditDigest,
    reassesses_digest: reassessesDigest, before_index: markerEntry.index,
  });
  return evidence !== null && evidence.timestamp === marker.timestamp && evidence.evaluation === askEntry.log.evaluation;
}

/**
 * Builds deterministic, non-authoritative reassessment proposals from dependencies
 * whose audit and current M/J state have already been verified by HDS-BRAIN.
 */
export function buildMemoryJudgmentReassessmentProposals(input: {
  readonly citation_request_id: string;
  readonly citation_command_id: string;
  readonly citation_audit_digest: string;
  readonly verified_dependencies: readonly OperationPlanMemoryInterpretationDependency[];
}): OwnerMemoryJudgmentReassessmentProposal[] {
  const results: OwnerMemoryJudgmentReassessmentProposal[] = [];
  const seen = new Set<string>();
  for (const dependency of input.verified_dependencies) {
    const oldRefs = dependency.reassesses_judgment_refs ?? [];
    const targetKey = JSON.stringify([dependency.reference.record_id, dependency.reference.version]);
    if (oldRefs.length === 0 || seen.has(targetKey)) continue;
    seen.add(targetKey);
    results.push({
      args: Object.freeze({
        citation_request_id: input.citation_request_id,
        citation_command_id: input.citation_command_id,
        target_record_id: dependency.reference.record_id,
        target_version: dependency.reference.version,
        interpretation_id: dependency.interpretation_id,
        judgment_ref: dependency.judgment_ref,
        citation_audit_digest: input.citation_audit_digest,
      }),
      reassesses_judgment_refs: Object.freeze([...oldRefs].sort()),
    });
  }
  return results;
}

function isMemoryCitationReviewLog(value: unknown): value is MemoryCitationReviewLog {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "memory_citation_review";
}
