import { createHash } from "node:crypto";
import {
  GOAL_GOVERNANCE_SCHEMA_VERSION,
  parseGoalGovernanceAtBoundary,
  type GoalGovernanceAuthorization,
  type GoalGovernanceConfig,
  type GoalGovernanceEvent,
  type GoalGovernanceGoal,
} from "@blue-tanuki/protocol";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export interface GoalGovernanceVersionProjection {
  version: number;
  purpose_digest: string;
  effective_from: number;
  source_event_ref?: string;
}

export interface GoalGovernanceInterpretationProjection {
  revision: number;
  status: "identified" | "unidentified";
  interpretation_digest?: string;
  effective_from: number;
  source_event_ref?: string;
}

export interface GoalGovernanceGoalProjection {
  goal_ref: string;
  goal_kind: GoalGovernanceGoal["goal_kind"];
  source_ref: string;
  parent_goal_ref?: string;
  parent_goal_version?: number;
  current_parent_goal_version?: number;
  parent_alignment_status: "not_applicable" | "aligned" | "requires_review";
  current_version: number;
  current_purpose_digest: string;
  current_interpretation_revision: number;
  current_interpretation_digest?: string;
  effective_from: number;
  purpose_versions: GoalGovernanceVersionProjection[];
  interpretation_revisions: GoalGovernanceInterpretationProjection[];
}

export interface GoalGovernanceEventProjection {
  event_ref: string;
  event_kind: GoalGovernanceEvent["event_kind"];
  goal_ref: string;
  authority_kind: "owner" | "hds_j";
  authorization_ref: string;
  recorded_at: number;
  effective_from: number;
  status: "effective" | "pending_effective";
}

export interface GoalGovernanceProjection {
  schema_version: typeof GOAL_GOVERNANCE_SCHEMA_VERSION;
  as_of: number;
  used_for_authority: false;
  goals: GoalGovernanceGoalProjection[];
  events: GoalGovernanceEventProjection[];
}

export type ReadonlyGoalGovernanceProjection = DeepReadonly<GoalGovernanceProjection>;
export type ReadonlyGoalGovernanceVersionProjection = DeepReadonly<GoalGovernanceVersionProjection>;

export type GoalGovernanceBuildResult =
  | { ok: true; ledger: GoalGovernanceLedger }
  | { ok: false; issue_codes: string[] };

interface CompiledGoal {
  goal: GoalGovernanceGoal;
  events: GoalGovernanceEvent[];
}

/**
 * Immutable HDS configuration ledger. It accepts only events whose exact event digest
 * matches a separately supplied, prevalidated authorization record.
 */
export class GoalGovernanceLedger {
  private constructor(private readonly goals: readonly CompiledGoal[]) {}

  static create(input: unknown): GoalGovernanceBuildResult {
    const parsed = parseGoalGovernanceAtBoundary(input);
    if (!parsed.ok) return { ok: false, issue_codes: parsed.issue_codes };

    const validation = validateAuthorizations(parsed.config);
    if (!validation.ok) return validation;
    const compiledGoals = compileGoals(parsed.config);
    deepFreeze(compiledGoals);
    return { ok: true, ledger: new GoalGovernanceLedger(compiledGoals) };
  }

  project(asOf: number): ReadonlyGoalGovernanceProjection {
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error("invalid goal governance projection time");
    const projectedGoals = this.goals.map(({ goal, events }) => projectGoal(goal, events, asOf));
    projectedGoals.sort((left, right) => left.goal_ref.localeCompare(right.goal_ref));
    const projectedByRef = new Map(projectedGoals.map((goal) => [goal.goal_ref, goal]));
    const parentStatus = (goal: GoalGovernanceGoalProjection, visiting = new Set<string>()): "not_applicable" | "aligned" | "requires_review" => {
      if (!goal.parent_goal_ref) return "not_applicable";
      if (visiting.has(goal.goal_ref)) return "requires_review";
      const parent = projectedByRef.get(goal.parent_goal_ref);
      if (!parent || goal.parent_goal_version === undefined) return "requires_review";
      visiting.add(goal.goal_ref);
      const ancestorStatus = parentStatus(parent, visiting);
      visiting.delete(goal.goal_ref);
      goal.current_parent_goal_version = parent.current_version;
      return ancestorStatus === "requires_review" || goal.parent_goal_version !== parent.current_version
        ? "requires_review"
        : "aligned";
    };
    for (const goal of projectedGoals) goal.parent_alignment_status = parentStatus(goal);
    const projectedEvents = this.goals.flatMap(({ events }) => events.map((event) => ({
      event_ref: event.event_ref,
      event_kind: event.event_kind,
      goal_ref: event.goal_ref,
      authority_kind: event.authority_kind,
      authorization_ref: event.authorization_ref,
      recorded_at: event.recorded_at,
      effective_from: event.effective_from,
      status: (event.effective_from <= asOf ? "effective" : "pending_effective") as "effective" | "pending_effective",
    })));
    projectedEvents.sort((left, right) => left.effective_from - right.effective_from || left.event_ref.localeCompare(right.event_ref));
    return deepFreeze({
      schema_version: GOAL_GOVERNANCE_SCHEMA_VERSION,
      as_of: asOf,
      used_for_authority: false,
      goals: projectedGoals,
      events: projectedEvents,
    });
  }
}

/** A stable SHA-256 binding for a validated event, independent of object key order. */
export function goalGovernanceEventDigest(event: GoalGovernanceEvent): string {
  return createHash("sha256").update(canonicalJson(event), "utf8").digest("hex");
}

/** Resolves a delayed result against the purpose version effective when its work occurred. */
export function purposeVersionForEventTime(
  projection: ReadonlyGoalGovernanceProjection,
  goalRef: string,
  occurredAt: number,
): ReadonlyGoalGovernanceVersionProjection | undefined {
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > projection.as_of) return undefined;
  const goal = projection.goals.find((candidate) => candidate.goal_ref === goalRef);
  if (!goal) return undefined;
  let selected: ReadonlyGoalGovernanceVersionProjection | undefined;
  for (const version of goal.purpose_versions) {
    if (version.effective_from > occurredAt) break;
    selected = version;
  }
  return selected;
}

function validateAuthorizations(config: GoalGovernanceConfig): GoalGovernanceBuildResult | { ok: true } {
  const goals = new Map(config.goals.map((goal) => [goal.goal_ref, goal]));
  const authorizations = new Map<string, GoalGovernanceAuthorization>();
  const usedAuthorizationRefs = new Set<string>();
  const eventRefs = new Set<string>();
  const issueCodes = new Set<string>();

  for (const authorization of config.authorizations) {
    if (authorizations.has(authorization.authorization_ref)) issueCodes.add("duplicate_authorization_ref");
    authorizations.set(authorization.authorization_ref, authorization);
  }

  for (const event of config.events) {
    if (eventRefs.has(event.event_ref)) issueCodes.add("duplicate_event_ref");
    eventRefs.add(event.event_ref);
    const goal = goals.get(event.goal_ref);
    if (!goal || goal.source_ref !== event.source_ref) issueCodes.add("goal_source_mismatch");
    if (event.effective_from < event.recorded_at || (goal && event.recorded_at < goal.adopted_at)) {
      issueCodes.add("invalid_event_time");
    }
    if (event.event_kind === "purpose_change" && (!goal || event.goal_kind !== goal.goal_kind)) {
      issueCodes.add("goal_kind_mismatch");
    }

    const expectedAuthority = event.event_kind === "interpretation_correction"
      ? "hds_j"
      : goal?.goal_kind === "delegated" ? "owner" : "hds_j";
    if (event.authority_kind !== expectedAuthority) issueCodes.add("unexpected_authority");

    const authorization = authorizations.get(event.authorization_ref);
    if (!authorization) {
      issueCodes.add("authorization_missing");
      continue;
    }
    if (usedAuthorizationRefs.has(event.authorization_ref)) issueCodes.add("authorization_reused");
    usedAuthorizationRefs.add(event.authorization_ref);
    if (
      authorization.event_ref !== event.event_ref ||
      authorization.event_digest !== goalGovernanceEventDigest(event) ||
      authorization.goal_ref !== event.goal_ref ||
      authorization.event_kind !== event.event_kind ||
      authorization.authority_kind !== expectedAuthority ||
      authorization.authority_kind !== event.authority_kind ||
      authorization.authorized_at > event.recorded_at ||
      authorization.authorized_at > event.effective_from ||
      (goal !== undefined && authorization.authorized_at < goal.adopted_at)
    ) {
      issueCodes.add("authorization_mismatch");
    }
  }

  if (usedAuthorizationRefs.size !== authorizations.size) issueCodes.add("unmatched_authorization");
  for (const authorization of config.authorizations) {
    if (!eventRefs.has(authorization.event_ref)) issueCodes.add("authorization_event_missing");
  }

  for (const goal of config.goals) {
    if (
      goal.parent_goal_ref &&
      goal.parent_goal_version !== parentGoalVersionAt(config, goal.parent_goal_ref, goal.adopted_at)
    ) issueCodes.add("parent_version_mismatch");
    const events = config.events.filter((event) => event.goal_ref === goal.goal_ref)
      .sort((left, right) => left.effective_from - right.effective_from || left.event_ref.localeCompare(right.event_ref));
    let previousEffectiveFrom = goal.adopted_at;
    let previousRecordedAt = goal.adopted_at;
    let version = 1;
    let purposeDigest = goal.initial_purpose_digest;
    let interpretationDigest: string | null = goal.initial_interpretation_digest;
    let interpretationRevision = 1;
    let boundParentVersion = goal.parent_goal_version;
    for (const event of events) {
      if (event.effective_from <= previousEffectiveFrom || event.recorded_at < previousRecordedAt) {
        issueCodes.add("event_order_invalid");
      }
      if (event.event_kind === "interpretation_correction") {
        if (
          event.goal_version !== version ||
          event.prior_interpretation_digest !== interpretationDigest ||
          event.preserved_purpose_digest !== purposeDigest ||
          (goal.parent_goal_ref !== undefined && boundParentVersion !== parentGoalVersionAt(config, goal.parent_goal_ref, event.effective_from))
        ) issueCodes.add("interpretation_transition_mismatch");
        interpretationDigest = event.corrected_interpretation_digest;
        interpretationRevision = interpretationRevision === 0 ? 1 : interpretationRevision + 1;
      } else {
        if (
          event.prior_version !== version ||
          event.new_version !== version + 1 ||
          event.prior_purpose_digest !== purposeDigest ||
          (goal.parent_goal_ref !== undefined && event.parent_goal_version !== parentGoalVersionAt(config, goal.parent_goal_ref, event.effective_from))
        ) issueCodes.add("purpose_transition_mismatch");
        version = event.new_version;
        purposeDigest = event.new_purpose_digest;
        interpretationDigest = null;
        interpretationRevision = 0;
        boundParentVersion = event.parent_goal_version;
      }
      previousEffectiveFrom = event.effective_from;
      previousRecordedAt = event.recorded_at;
    }
  }

  return issueCodes.size === 0
    ? { ok: true }
    : { ok: false, issue_codes: [...issueCodes].sort() };
}

function compileGoals(config: GoalGovernanceConfig): CompiledGoal[] {
  return config.goals.map((goal) => ({
    goal,
    events: config.events.filter((event) => event.goal_ref === goal.goal_ref)
      .sort((left, right) => left.effective_from - right.effective_from || left.event_ref.localeCompare(right.event_ref)),
  }));
}

function parentGoalVersionAt(config: GoalGovernanceConfig, goalRef: string, asOf: number): number {
  let version = 1;
  const events = config.events.filter((event): event is Extract<GoalGovernanceEvent, { event_kind: "purpose_change" }> =>
    event.goal_ref === goalRef && event.event_kind === "purpose_change")
    .sort((left, right) => left.effective_from - right.effective_from);
  for (const event of events) {
    if (event.effective_from > asOf) break;
    version = event.new_version;
  }
  return version;
}

function projectGoal(goal: GoalGovernanceGoal, events: readonly GoalGovernanceEvent[], asOf: number): GoalGovernanceGoalProjection {
  let currentVersion = 1;
  let currentPurposeDigest = goal.initial_purpose_digest;
  let parentGoalVersion = goal.parent_goal_version;
  let currentInterpretationRevision = 1;
  let currentInterpretationDigest: string | undefined = goal.initial_interpretation_digest;
  let effectiveFrom = goal.adopted_at;
  const purposeVersions: GoalGovernanceVersionProjection[] = [{
    version: 1,
    purpose_digest: goal.initial_purpose_digest,
    effective_from: goal.adopted_at,
  }];
  const interpretationRevisions: GoalGovernanceInterpretationProjection[] = [{
    revision: 1,
    status: "identified",
    interpretation_digest: goal.initial_interpretation_digest,
    effective_from: goal.adopted_at,
  }];

  for (const event of events) {
    if (event.effective_from > asOf) break;
    effectiveFrom = event.effective_from;
    if (event.event_kind === "interpretation_correction") {
      currentInterpretationRevision = currentInterpretationRevision === 0 ? 1 : currentInterpretationRevision + 1;
      currentInterpretationDigest = event.corrected_interpretation_digest;
      interpretationRevisions.push({
        revision: currentInterpretationRevision,
        status: "identified",
        interpretation_digest: currentInterpretationDigest,
        effective_from: event.effective_from,
        source_event_ref: event.event_ref,
      });
    } else {
      currentVersion = event.new_version;
      currentPurposeDigest = event.new_purpose_digest;
      currentInterpretationRevision = 0;
      currentInterpretationDigest = undefined;
      parentGoalVersion = event.parent_goal_version;
      purposeVersions.push({
        version: currentVersion,
        purpose_digest: currentPurposeDigest,
        effective_from: event.effective_from,
        source_event_ref: event.event_ref,
      });
      interpretationRevisions.push({
        revision: 0,
        status: "unidentified",
        effective_from: event.effective_from,
        source_event_ref: event.event_ref,
      });
    }
  }

  return {
    goal_ref: goal.goal_ref,
    goal_kind: goal.goal_kind,
    source_ref: goal.source_ref,
    ...(goal.parent_goal_ref ? { parent_goal_ref: goal.parent_goal_ref } : {}),
    ...(parentGoalVersion !== undefined ? { parent_goal_version: parentGoalVersion } : {}),
    parent_alignment_status: goal.parent_goal_ref ? "requires_review" : "not_applicable",
    current_version: currentVersion,
    current_purpose_digest: currentPurposeDigest,
    current_interpretation_revision: currentInterpretationRevision,
    ...(currentInterpretationDigest ? { current_interpretation_digest: currentInterpretationDigest } : {}),
    effective_from: effectiveFrom,
    purpose_versions: purposeVersions,
    interpretation_revisions: interpretationRevisions,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
