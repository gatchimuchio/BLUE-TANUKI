import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex, stableJson } from "../complete-history/codec.js";
import {
  candidateFromCommand,
  changedCommandConditionDimensions,
  commandPatternsMatch,
  failureSignatureIdentityKey,
  normalizeFailurePattern,
  semanticOverlap,
  structuralKey,
} from "./normalize.js";
import {
  clampConfidence,
  defaultDecayRate,
  defaultProbePolicy,
  defaultSuppressionPolicy,
  defaultTtlDays,
  effectivePolicyForState,
  enforceableState,
  needsBlockRevalidation,
  policyToGateDecision,
  stateAppliesInShadow,
} from "./policy.js";
import type {
  FailureConditionChangeMatch,
  FailureGateCandidate,
  FailureGateDecision,
  FailureGateMatch,
  FailureGateResult,
  FailureLearningLineageRecord,
  FailureMemorySnapshot,
  FailureRuleState,
  FailureSignature,
  FailureSignatureInput,
  FailureSignatureUpdate,
  MatchLevel,
  RevalidationOutcome,
  RevalidationResult,
  SuppressionPolicy,
} from "./types.js";
import {
  FAILURE_MEMORY_SCHEMA_VERSION,
  FailureLearningLineageRecordSchema,
} from "./types.js";
import { failureSignatureDigest, failureSignaturePreStateDigest } from "./review.js";

export interface FailureMemoryStoreOptions {
  filepath?: string;
  now?: () => Date;
}

export interface LLMFailureSignatureProposal {
  scope: FailureSignatureInput["scope"];
  failure_type: FailureSignatureInput["failure_type"];
  input_pattern: string;
  action_pattern: string;
  context_pattern: string;
  result_pattern?: string;
  evidence_log_ids?: readonly string[];
  proposed_severity?: FailureSignatureInput["severity"];
  proposed_confidence?: number;
  proposed_suppression_policy?: SuppressionPolicy;
  notes?: string;
}

export class FailureMemoryStore {
  private readonly filepath?: string;
  private readonly now: () => Date;
  private signatures: FailureSignature[] = [];
  private learningLineageRecords: FailureLearningLineageRecord[] = [];

  constructor(opts: FailureMemoryStoreOptions = {}) {
    this.filepath = opts.filepath;
    this.now = opts.now ?? (() => new Date());
    if (this.filepath && existsSync(this.filepath)) {
      this.loadFromFile();
    } else if (this.filepath) {
      const dir = dirname(this.filepath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.persist();
    }
  }

  addSignature(input: FailureSignatureInput): FailureSignature {
    const now = this.now().toISOString();
    const severity = input.severity ?? "medium";
    const confidence = clampConfidence(input.confidence, 0.5);
    const match_level = input.match_level ?? 0;
    const suppression_policy = input.suppression_policy ?? defaultSuppressionPolicy({
      severity,
      confidence,
      match_level,
      scope: input.scope,
      failure_type: input.failure_type,
    });
    const probe_policy = input.probe_policy ?? defaultProbePolicy({
      scope: input.scope,
      failure_type: input.failure_type,
      severity,
      suppression_policy,
    });
    const signature: FailureSignature = {
      id: randomUUID(),
      scope: input.scope,
      failure_type: input.failure_type,
      input_pattern: input.input_pattern,
      action_pattern: input.action_pattern,
      context_pattern: input.context_pattern,
      predicted_difference_digest: input.predicted_difference_digest,
      result_pattern: input.result_pattern,
      cause_candidates: input.cause_candidates ? [...new Set(input.cause_candidates)] : undefined,
      unknowns: input.unknowns ? uniqueStrings(input.unknowns) : undefined,
      evidence_log_ids: uniqueStrings(input.evidence_log_ids ?? []),
      match_level,
      suppression_policy,
      confidence,
      severity,
      state: input.state ?? "draft",
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
      last_seen_at: input.last_seen_at ?? now,
      last_validated_at: input.last_validated_at,
      next_revalidation_at: input.next_revalidation_at ?? defaultNextRevalidation(now, severity, suppression_policy, probe_policy),
      hit_count: Math.max(0, Math.floor(input.hit_count ?? 0)),
      ttl_days: input.ttl_days ?? defaultTtlDays(severity),
      decay_rate: input.decay_rate ?? defaultDecayRate(severity),
      allow_probe: input.allow_probe ?? probe_policy !== "never",
      probe_policy,
      notes: input.notes,
    };
    this.signatures.push(signature);
    this.persist();
    return cloneSignature(signature);
  }

  addLLMProposal(proposal: LLMFailureSignatureProposal): FailureSignature {
    const severity = proposal.proposed_severity ?? "medium";
    const confidence = clampConfidence(proposal.proposed_confidence, 0.45);
    return this.addSignature({
      scope: proposal.scope,
      failure_type: proposal.failure_type,
      input_pattern: proposal.input_pattern,
      action_pattern: proposal.action_pattern,
      context_pattern: proposal.context_pattern,
      result_pattern: proposal.result_pattern,
      evidence_log_ids: proposal.evidence_log_ids,
      confidence,
      severity,
      state: "draft",
      match_level: 3,
      suppression_policy: defaultSuppressionPolicy({
        severity,
        confidence,
        match_level: 3,
        scope: proposal.scope,
        failure_type: proposal.failure_type,
      }),
      notes: [proposal.notes, "llm_proposal_non_authoritative"].filter(Boolean).join("; "),
    });
  }

  upsertSignature(input: FailureSignatureInput): FailureSignature {
    const existing = this.findEquivalent(input);
    if (!existing) return this.addSignature(input);
    return this.updateSignature(existing.id, {
      evidence_log_ids: input.evidence_log_ids,
      cause_candidates: [...new Set([...(existing.cause_candidates ?? []), ...(input.cause_candidates ?? [])])],
      unknowns: uniqueStrings([...(existing.unknowns ?? []), ...(input.unknowns ?? [])]),
      predicted_difference_digest: input.predicted_difference_digest ?? existing.predicted_difference_digest,
      last_seen_at: this.now().toISOString(),
      hit_count: existing.hit_count + 1,
      confidence: Math.max(existing.confidence, clampConfidence(input.confidence, existing.confidence)),
      severity: strongerSeverity(existing.severity, input.severity ?? existing.severity),
    });
  }

  updateSignature(id: string, update: FailureSignatureUpdate): FailureSignature {
    const index = this.signatures.findIndex((signature) => signature.id === id);
    if (index < 0) throw new Error(`FailureMemoryStore: unknown signature ${id}`);
    const current = this.signatures[index]!;
    const next: FailureSignature = {
      ...current,
      ...update,
      evidence_log_ids: uniqueStrings([
        ...current.evidence_log_ids,
        ...(update.evidence_log_ids ?? []),
      ]),
      confidence: update.confidence === undefined ? current.confidence : clampConfidence(update.confidence),
      hit_count: update.hit_count === undefined ? current.hit_count : Math.max(0, Math.floor(update.hit_count)),
      updated_at: this.now().toISOString(),
    };
    this.signatures[index] = next;
    this.persist();
    return cloneSignature(next);
  }

  updateHitCount(id: string, delta = 1, evidence_log_ids: readonly string[] = []): FailureSignature {
    const current = this.requireSignature(id);
    return this.updateSignature(id, {
      hit_count: current.hit_count + delta,
      last_seen_at: this.now().toISOString(),
      evidence_log_ids,
    });
  }

  markState(id: string, state: FailureRuleState): FailureSignature {
    return this.updateSignature(id, { state });
  }

  get(id: string): FailureSignature | null {
    const signature = this.signatures.find((item) => item.id === id);
    return signature ? cloneSignature(signature) : null;
  }

  list(filter: { state?: FailureRuleState } = {}): FailureSignature[] {
    return this.signatures
      .filter((signature) => filter.state === undefined || signature.state === filter.state)
      .map(cloneSignature);
  }

  listLearningLineageForSignature(signatureId: string): FailureLearningLineageRecord[] {
    const signatureIdDigest = sha256Hex(signatureId);
    return this.learningLineageRecords
      .filter((record) => record.signature_id_digest === signatureIdDigest)
      .map(cloneLearningLineageRecord);
  }

  getLearningLineage(recordId: string): FailureLearningLineageRecord | null {
    const record = this.learningLineageRecords.find((item) => item.record_id === recordId);
    return record ? cloneLearningLineageRecord(record) : null;
  }

  /** J-reviewed candidate evidence only; this record is never consulted by evaluateGate. */
  appendLearningLineage(recordInput: FailureLearningLineageRecord):
    | { readonly status: "stored" | "replayed"; readonly record: FailureLearningLineageRecord }
    | { readonly status: "source_unavailable" | "pre_state_changed" | "record_conflict" } {
    const parsed = FailureLearningLineageRecordSchema.safeParse(recordInput);
    if (!parsed.success || !hasValidLearningLineageRecordId(parsed.data)) return { status: "record_conflict" };
    const record = parsed.data;
    const signature = this.signatures.find((item) => sha256Hex(item.id) === record.signature_id_digest);
    if (!signature) return { status: "source_unavailable" };
    if (failureSignatureDigest(signature) !== record.signature_digest ||
        failureSignaturePreStateDigest(signature) !== record.pre_state_digest) {
      return { status: "pre_state_changed" };
    }
    const existing = this.learningLineageRecords.find((item) => item.record_id === record.record_id);
    if (existing) {
      return canonicalJson(existing) === canonicalJson(record)
        ? { status: "replayed", record: cloneLearningLineageRecord(existing) }
        : { status: "record_conflict" };
    }
    const priorDerivation = this.learningLineageRecords.find((item) =>
      item.signature_id_digest === record.signature_id_digest && item.signature_digest === record.signature_digest &&
      item.experience_digest === record.experience_digest && item.derivation_digest === record.derivation_digest);
    if (priorDerivation) return { status: "replayed", record: cloneLearningLineageRecord(priorDerivation) };
    this.learningLineageRecords.push(cloneLearningLineageRecord(record));
    this.persist();
    return { status: "stored", record: cloneLearningLineageRecord(record) };
  }

  evaluateGate(candidate: FailureGateCandidate): FailureGateResult {
    const matches: FailureGateMatch[] = [];
    const conditionChangeMatches: FailureConditionChangeMatch[] = [];
    for (const signature of this.signatures) {
      if (!stateAppliesInShadow(signature.state)) continue;
      const level = matchSignature(signature, candidate);
      if (level === null) {
        if (signature.state === "active" &&
            (signature.suppression_policy === "block" || signature.suppression_policy === "require_approval")) {
          const changedConditions = changedCommandConditionDimensions(signature, candidate);
          if (changedConditions) {
            conditionChangeMatches.push({
              signature_id: signature.id,
              changed_conditions: changedConditions,
              decision: signature.suppression_policy === "block" && signature.probe_policy === "never"
                ? "block"
                : "require_approval",
            });
          }
        }
        continue;
      }
      const policy = effectivePolicyForState(signature, level);
      const enforced = enforceableState(signature.state);
      matches.push({
        signature_id: signature.id,
        match_level: level,
        policy,
        state: signature.state,
        severity: signature.severity,
        confidence: signature.confidence,
        enforced,
        reason: `${signature.failure_type}:${policy}:level_${level}`,
      });
    }
    const enforced = matches.filter((match) => match.enforced);
    if (enforced.length === 0 && conditionChangeMatches.length === 0) {
      return {
        decision: "allow",
        matches,
        condition_change_matches: conditionChangeMatches,
        highest_match_level: matches[0]?.match_level,
        applied_signature_ids: [],
        requires_human_review: false,
        reason: matches.length > 0 ? "shadow_or_probation_only" : "no_failure_memory_match",
      };
    }
    const decision = strongestDecision([
      ...enforced.map((match) => policyToGateDecision(match.policy)),
      ...conditionChangeMatches.map((match) => match.decision),
    ]);
    const conditionChangeReasons = conditionChangeMatches.map((match) =>
      `condition_changed:${match.changed_conditions.join("+")}:${match.decision}`);
    return {
      decision,
      matches,
      condition_change_matches: conditionChangeMatches,
      highest_match_level: enforced.reduce<MatchLevel | undefined>((best, match) => best === undefined || match.match_level < best ? match.match_level : best, undefined),
      applied_signature_ids: [...new Set([
        ...enforced.map((match) => match.signature_id),
        ...conditionChangeMatches.map((match) => match.signature_id),
      ])],
      requires_human_review: decision === "require_approval" || decision === "block",
      rewritten_candidate: decision === "rewrite" ? candidate : undefined,
      reason: [...enforced.map((match) => match.reason), ...conditionChangeReasons].join("; "),
    };
  }

  evaluateCommandGate(command: Parameters<typeof candidateFromCommand>[0], context: Record<string, unknown> = {}): FailureGateResult {
    return this.evaluateGate(candidateFromCommand(command, context));
  }

  staleRules(now: Date = this.now()): FailureSignature[] {
    return this.signatures
      .filter((signature) => signature.state !== "retired")
      .filter((signature) => isStale(signature, now) || needsBlockRevalidation(signature, now))
      .map(cloneSignature);
  }

  decayOldRules(now: Date = this.now()): FailureSignature[] {
    const changed: FailureSignature[] = [];
    for (const signature of this.signatures) {
      if (signature.severity === "critical" || signature.state === "retired") continue;
      if (!isStale(signature, now)) continue;
      const nextConfidence = clampConfidence(signature.confidence - (signature.decay_rate ?? defaultDecayRate(signature.severity)));
      const nextState: FailureRuleState = nextConfidence < 0.3 ? "probation" : signature.state;
      changed.push(this.updateSignature(signature.id, {
        confidence: nextConfidence,
        state: nextState,
      }));
    }
    return changed;
  }

  applyRevalidation(id: string, outcome: RevalidationOutcome, reason: string): RevalidationResult {
    const current = this.requireSignature(id);
    if (current.probe_policy === "never") {
      return {
        rule_id: id,
        outcome,
        probe_policy: current.probe_policy,
        probed: false,
        next_state: current.state,
        reason: "never_probe_rule_not_probed",
      };
    }
    const now = this.now().toISOString();
    if (outcome === "still_valid") {
      const next = this.updateSignature(id, {
        last_validated_at: now,
        next_revalidation_at: defaultNextRevalidation(now, current.severity, current.suppression_policy, current.probe_policy),
        confidence: Math.min(1, current.confidence + 0.05),
      });
      return {
        rule_id: id,
        outcome,
        probe_policy: current.probe_policy,
        probed: current.probe_policy === "sandbox",
        next_state: next.state,
        next_policy: next.suppression_policy,
        reason,
      };
    }
    if (outcome === "false_positive" || outcome === "no_longer_reproducible") {
      const next = this.updateSignature(id, {
        state: outcome === "false_positive" ? "probation" : "retired",
        suppression_policy: "warn",
        last_validated_at: now,
        confidence: Math.max(0, current.confidence - 0.3),
        notes: appendNote(current.notes, `revalidation:${outcome}:${reason}`),
      });
      return {
        rule_id: id,
        outcome,
        probe_policy: current.probe_policy,
        probed: current.probe_policy === "sandbox",
        next_state: next.state,
        next_policy: next.suppression_policy,
        reason,
      };
    }
    const next = this.updateSignature(id, {
      state: outcome === "superseded" ? "retired" : "probation",
      last_validated_at: now,
      notes: appendNote(current.notes, `revalidation:${outcome}:${reason}`),
    });
    return {
      rule_id: id,
      outcome,
      probe_policy: current.probe_policy,
      probed: current.probe_policy === "sandbox",
      next_state: next.state,
      next_policy: next.suppression_policy,
      reason,
    };
  }

  exportSnapshot(opts: { exported_at?: string } = {}): FailureMemorySnapshot {
    return {
      schema_version: FAILURE_MEMORY_SCHEMA_VERSION,
      exported_at: opts.exported_at ?? this.now().toISOString(),
      signatures: this.list(),
      learning_lineage_records: this.learningLineageRecords.map(cloneLearningLineageRecord),
    };
  }

  size(): number {
    return this.signatures.length;
  }

  private requireSignature(id: string): FailureSignature {
    const signature = this.signatures.find((item) => item.id === id);
    if (!signature) throw new Error(`FailureMemoryStore: unknown signature ${id}`);
    return signature;
  }

  private findEquivalent(input: FailureSignatureInput): FailureSignature | null {
    const key = equivalentKey(input);
    return this.signatures.find((signature) => equivalentKey(signature) === key) ?? null;
  }

  private loadFromFile(): void {
    if (!this.filepath) return;
    const raw = readFileSync(this.filepath, "utf8").trim();
    if (!raw) {
      this.signatures = [];
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isSnapshot(parsed)) {
      throw new Error(`FailureMemoryStore: malformed snapshot ${this.filepath}`);
    }
    this.signatures = parsed.signatures.map((signature) => ({ ...signature }));
    this.learningLineageRecords = (parsed.learning_lineage_records ?? []).map(cloneLearningLineageRecord);
  }

  private persist(): void {
    if (!this.filepath) return;
    writeFileSync(this.filepath, JSON.stringify(this.exportSnapshot(), null, 2) + "\n");
  }
}

export function matchSignature(signature: FailureSignature, candidate: FailureGateCandidate): MatchLevel | null {
  if (signature.scope !== candidate.scope) return null;
  if (candidate.command) {
    if (!commandPatternsMatch(signature.input_pattern, signature.action_pattern, signature.context_pattern) ||
      !commandPatternsMatch(candidate.input_pattern, candidate.action_pattern, candidate.context_pattern)) return null;
    const sameConditions =
      signature.input_pattern === candidate.input_pattern &&
      signature.action_pattern === candidate.action_pattern &&
      signature.context_pattern === candidate.context_pattern;
    if (!sameConditions) return null;
    if (
      signature.result_pattern === candidate.result_pattern &&
      0 <= signature.match_level
    ) return 0;
    return signature.match_level >= 1 ? 1 : null;
  }
  if (
    signature.input_pattern === candidate.input_pattern &&
    signature.action_pattern === candidate.action_pattern &&
    signature.context_pattern === candidate.context_pattern &&
    (signature.result_pattern ?? "") === (candidate.result_pattern ?? "")
  ) {
    return 0 <= signature.match_level ? 0 : null;
  }
  if (signature.match_level >= 1) {
    const normalizedEqual =
      normalizeFailurePattern(signature.input_pattern) === normalizeFailurePattern(candidate.input_pattern) &&
      normalizeFailurePattern(signature.action_pattern) === normalizeFailurePattern(candidate.action_pattern) &&
      normalizeFailurePattern(signature.context_pattern) === normalizeFailurePattern(candidate.context_pattern);
    if (normalizedEqual) return 1;
  }
  if (signature.match_level >= 2) {
    if (structuralKey(signature.scope, signature.action_pattern) === structuralKey(candidate.scope, candidate.action_pattern)) {
      return 2;
    }
  }
  if (signature.match_level >= 3) {
    const overlap =
      semanticOverlap(signature.input_pattern, candidate.input_pattern) +
      semanticOverlap(signature.action_pattern, candidate.action_pattern) +
      semanticOverlap(signature.context_pattern, candidate.context_pattern);
    if (overlap >= 3) return 3;
  }
  return null;
}

function strongestDecision(decisions: readonly FailureGateDecision[]): FailureGateDecision {
  const rank: Record<FailureGateDecision, number> = {
    allow: 0,
    warn: 1,
    downrank: 2,
    rewrite: 3,
    require_approval: 4,
    block: 5,
  };
  return decisions.reduce<FailureGateDecision>((best, decision) => rank[decision] > rank[best] ? decision : best, "allow");
}

function equivalentKey(input: Pick<FailureSignature, "scope" | "failure_type" | "input_pattern" | "action_pattern" | "context_pattern" | "predicted_difference_digest" | "result_pattern">): string {
  return failureSignatureIdentityKey(input);
}

function defaultNextRevalidation(
  nowIso: string,
  severity: FailureSignature["severity"],
  suppression_policy: SuppressionPolicy,
  probe_policy: FailureSignature["probe_policy"],
): string | undefined {
  if (suppression_policy !== "block" || probe_policy === "never") return undefined;
  const days = defaultTtlDays(severity);
  if (days === undefined) return undefined;
  const next = new Date(Date.parse(nowIso));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function isStale(signature: FailureSignature, now: Date): boolean {
  if (signature.severity === "critical") return false;
  const ttl = signature.ttl_days ?? defaultTtlDays(signature.severity);
  if (ttl === undefined) return false;
  const last = Date.parse(signature.last_seen_at || signature.updated_at);
  return now.getTime() - last > ttl * 24 * 60 * 60 * 1000;
}

function strongerSeverity(left: FailureSignature["severity"], right: FailureSignature["severity"]): FailureSignature["severity"] {
  const order: FailureSignature["severity"][] = ["low", "medium", "high", "critical"];
  return order.indexOf(right) > order.indexOf(left) ? right : left;
}

function appendNote(existing: string | undefined, note: string): string {
  return [existing, note].filter(Boolean).join("; ");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function cloneSignature(signature: FailureSignature): FailureSignature {
  return structuredClone(signature);
}

function isSnapshot(value: unknown): value is FailureMemorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<FailureMemorySnapshot>;
  return snapshot.schema_version === FAILURE_MEMORY_SCHEMA_VERSION && Array.isArray(snapshot.signatures) &&
    (snapshot.learning_lineage_records === undefined ||
      (Array.isArray(snapshot.learning_lineage_records) && snapshot.learning_lineage_records.every((record) => {
        const parsed = FailureLearningLineageRecordSchema.safeParse(record);
        return parsed.success && hasValidLearningLineageRecordId(parsed.data);
      }) && new Set(snapshot.learning_lineage_records.map((record) => (record as FailureLearningLineageRecord).record_id)).size ===
        snapshot.learning_lineage_records.length));
}

function hasValidLearningLineageRecordId(record: FailureLearningLineageRecord): boolean {
  const { record_id, ...content } = record;
  return sha256Hex(stableJson(content)) === record_id;
}

function cloneLearningLineageRecord(record: FailureLearningLineageRecord): FailureLearningLineageRecord {
  return structuredClone(record);
}

function canonicalJson(value: unknown): string {
  return stableJson(value);
}
