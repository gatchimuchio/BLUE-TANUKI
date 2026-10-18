import { randomUUID } from "node:crypto";
import { failureSignatureIdentityKey } from "./normalize.js";
import { needsBlockRevalidation } from "./policy.js";
import { extractFromCompleteHistory } from "./extractor.js";
import type {
  FailureMemoryVerifierInput,
  FailureSignature,
  FailureSignatureInput,
  PeriodicVerificationReport,
} from "./types.js";

export function runPeriodicFailureMemoryVerification(input: FailureMemoryVerifierInput): PeriodicVerificationReport {
  const started = input.now ?? new Date();
  const detectedInputs = input.entries.flatMap((entry) => extractFromCompleteHistory(entry));
  const detected = detectedInputs.map((item, index) => materializeRecommendation(item, started, `detected-${index}`));
  const repeated = repeatedFailures(detected);
  const existing = input.existing_rules ?? [];
  const recommended = detected.filter((signature) => !hasConvertedRule(signature, existing));
  const now = started;
  const stale = existing.filter((signature) => needsBlockRevalidation(signature, now) || staleEvidence(signature, now));
  const highHitLowConfidence = existing
    .filter((signature) => signature.hit_count >= 5 && signature.confidence < 0.5)
    .map((signature) => signature.id);
  const semanticTooAggressive = existing
    .filter((signature) => signature.match_level === 3 && (signature.suppression_policy === "block" || signature.suppression_policy === "require_approval"))
    .map((signature) => signature.id);
  const blockDowngrade = existing
    .filter((signature) => signature.suppression_policy === "block" && signature.match_level > 1)
    .map((signature) => signature.id);
  const unresolvedRisks = [
    ...highHitLowConfidence.map((id) => `${id}: high hit count but low confidence`),
    ...semanticTooAggressive.map((id) => `${id}: semantic-only rule is too aggressive`),
    ...blockDowngrade.map((id) => `${id}: block rule should be downgraded or explicitly justified`),
    ...recommended.map((signature) => `${signature.id}: failure event not converted into stored rule`),
  ];
  const review = [
    ...stale.map((signature) => signature.id),
    ...semanticTooAggressive,
    ...blockDowngrade,
    ...repeated.filter((signature) => signature.scope === "boundary" || signature.scope === "authority").map((signature) => signature.id),
  ];
  return {
    run_id: randomUUID(),
    started_at: started.toISOString(),
    completed_at: (input.now ?? new Date()).toISOString(),
    scanned_log_range: {
      from: input.entries[0]?.id ?? "none",
      to: input.entries[input.entries.length - 1]?.id ?? "none",
    },
    detected_failures: detected,
    repeated_failures: repeated,
    unresolved_risks: unresolvedRisks,
    recommended_rules: recommended,
    applied_rules: input.apply_recommendations ? recommended.map((signature) => signature.id) : [],
    requires_human_review: [...new Set(review)],
    stale_rules: stale.map((signature) => signature.id),
    revalidated_rules: [],
    retired_rules: existing.filter((signature) => signature.state === "retired").map((signature) => signature.id),
    probation_rules: existing.filter((signature) => signature.state === "probation").map((signature) => signature.id),
    notes: `trigger=${input.trigger}; complete_history_used_for_authority=false`,
  };
}

function repeatedFailures(signatures: readonly FailureSignature[]): FailureSignature[] {
  const byKey = new Map<string, FailureSignature[]>();
  for (const signature of signatures) {
    const key = signatureKey(signature);
    const group = byKey.get(key) ?? [];
    group.push(signature);
    byKey.set(key, group);
  }
  return [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      ...group[0]!,
      hit_count: group.length,
      evidence_log_ids: [...new Set(group.flatMap((signature) => signature.evidence_log_ids))],
    }));
}

function hasConvertedRule(signature: FailureSignature, existing: readonly FailureSignature[]): boolean {
  const key = signatureKey(signature);
  return existing.some((rule) => signatureKey(rule) === key);
}

function materializeRecommendation(input: FailureSignatureInput, now: Date, fallbackId: string): FailureSignature {
  const iso = now.toISOString();
  return {
    id: fallbackId,
    scope: input.scope,
    failure_type: input.failure_type,
    input_pattern: input.input_pattern,
    action_pattern: input.action_pattern,
    context_pattern: input.context_pattern,
    predicted_difference_digest: input.predicted_difference_digest,
    result_pattern: input.result_pattern,
    cause_candidates: input.cause_candidates ? [...input.cause_candidates] : undefined,
    unknowns: input.unknowns ? [...input.unknowns] : undefined,
    evidence_log_ids: [...(input.evidence_log_ids ?? [])],
    match_level: input.match_level ?? 1,
    suppression_policy: input.suppression_policy ?? "warn",
    confidence: input.confidence ?? 0.65,
    severity: input.severity ?? "medium",
    state: input.state ?? "shadow",
    created_at: input.created_at ?? iso,
    updated_at: input.updated_at ?? iso,
    last_seen_at: input.last_seen_at ?? iso,
    last_validated_at: input.last_validated_at,
    next_revalidation_at: input.next_revalidation_at,
    hit_count: input.hit_count ?? 1,
    ttl_days: input.ttl_days,
    decay_rate: input.decay_rate,
    allow_probe: input.allow_probe ?? true,
    probe_policy: input.probe_policy ?? "shadow_only",
    notes: input.notes,
  };
}

function signatureKey(signature: Pick<FailureSignature, "scope" | "failure_type" | "input_pattern" | "action_pattern" | "context_pattern" | "predicted_difference_digest" | "result_pattern">): string {
  return failureSignatureIdentityKey(signature);
}

function staleEvidence(signature: FailureSignature, now: Date): boolean {
  if (signature.severity === "critical") return false;
  const ttl = signature.ttl_days;
  if (ttl === undefined) return false;
  const last = Date.parse(signature.last_seen_at);
  return now.getTime() - last > ttl * 24 * 60 * 60 * 1000;
}
