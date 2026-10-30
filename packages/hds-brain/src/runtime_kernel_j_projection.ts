import type { Decision } from "@blue-tanuki/protocol";
import type { DecisionLog, PolicyConfig, ScoringResult } from "./types.js";
import { evaluateDecision } from "./policy.js";

const SCALE = 1_000_000;
const MAX_AXES = 128;
const AXIS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface RuntimeKernelJAxisProjection {
  axis: string;
  score_micros: number;
  weight_micros: number;
  lifecycle_ok: boolean;
}

export interface RuntimeKernelJThresholdProjection {
  axis: string;
  threshold_micros: number;
}

/** Sanitized numeric inputs for a non-authoritative Rust J comparison. */
export interface RuntimeKernelJProjection {
  schema_version: "blue-tanuki.hds-runtime-j-projection.v1";
  typescript_decision: Decision;
  axes: RuntimeKernelJAxisProjection[];
  thresholds: {
    aggregate_assert_micros: number;
    out_of_scope_below_micros: number;
    per_axis_fail: RuntimeKernelJThresholdProjection[];
    per_axis_suspend_below: RuntimeKernelJThresholdProjection[];
  };
}

export type RuntimeKernelJProjectionUnavailableReason =
  | "controller_override"
  | "axis_shape_mismatch"
  | "unsupported_policy_value"
  | "precision_boundary"
  | "quantization_changes_decision"
  | "projection_error";

export type RuntimeKernelJProjectionResult =
  | { status: "comparable"; projection: RuntimeKernelJProjection }
  | { status: "not_comparable"; reason: RuntimeKernelJProjectionUnavailableReason };

/**
 * Build the minimum fixed-point projection needed to independently evaluate
 * the policy decision. Raw input, detector evidence, command data and M are
 * deliberately excluded. Non-policy controller decisions are not projected.
 */
export function projectRuntimeKernelJDecision(
  log: DecisionLog,
  policy: PolicyConfig,
): RuntimeKernelJProjectionResult {
  const scoring = log.model.scoring;
  const typescript = evaluateDecision(scoring, policy);
  if (log.commit.decision !== typescript.decision || log.commit.reason !== typescript.reason ||
      !sameStrings(log.commit.triggered_thresholds, typescript.triggered_thresholds)) {
    return { status: "not_comparable", reason: "controller_override" };
  }
  if (policy.axes.length === 0 || policy.axes.length > MAX_AXES || scoring.axis_scores.length !== policy.axes.length) {
    return { status: "not_comparable", reason: "axis_shape_mismatch" };
  }

  const aggregateAssert = toUnits(policy.thresholds.aggregate_assert, -1, 2);
  const outOfScopeBelow = toUnits(policy.thresholds.out_of_scope_below, -1, 2);
  if (aggregateAssert === undefined || outOfScopeBelow === undefined) {
    return { status: "not_comparable", reason: "unsupported_policy_value" };
  }

  const axes: RuntimeKernelJAxisProjection[] = [];
  for (let index = 0; index < policy.axes.length; index += 1) {
    const configuredAxis = policy.axes[index]!;
    const score = scoring.axis_scores[index]!;
    if (configuredAxis.name !== score.axis || !AXIS_NAME_PATTERN.test(configuredAxis.name)) {
      return { status: "not_comparable", reason: "axis_shape_mismatch" };
    }
    const scoreUnits = toUnits(score.score, 0, 1);
    const weightUnits = toUnits(configuredAxis.weight, 0, 1_000);
    if (scoreUnits === undefined || weightUnits === undefined) {
      return { status: "not_comparable", reason: "unsupported_policy_value" };
    }
    axes.push({
      axis: configuredAxis.name,
      score_micros: scoreUnits,
      weight_micros: weightUnits,
      lifecycle_ok: (score.lifecycle?.status ?? "ok") === "ok",
    });
  }

  const perAxisFail = thresholdEntries(policy.thresholds.per_axis_fail);
  const perAxisSuspendBelow = thresholdEntries(policy.thresholds.per_axis_suspend_below);
  if (perAxisFail === undefined || perAxisSuspendBelow === undefined) {
    return { status: "not_comparable", reason: "unsupported_policy_value" };
  }

  const scoreByAxis = new Map(axes.map((axis) => [axis.axis, axis.score_micros]));
  if (axes.some((axis) => !axis.lifecycle_ok)) {
    // Lifecycle escalation precedes numeric thresholds on both implementations.
  } else {
    for (const entry of [...perAxisFail, ...perAxisSuspendBelow]) {
      const score = scoreByAxis.get(entry.axis);
      if (score !== undefined && Math.abs(score - entry.threshold_micros) <= 2) {
        return { status: "not_comparable", reason: "precision_boundary" };
      }
    }
    const quantizedScoring = quantizedScoringForProjection(scoring, axes);
    const aggregateUnits = toUnits(quantizedScoring.aggregate, 0, 1);
    if (aggregateUnits === undefined || Math.abs(aggregateUnits - outOfScopeBelow) <= 2 ||
        Math.abs(aggregateUnits - aggregateAssert) <= 2) {
      return { status: "not_comparable", reason: "precision_boundary" };
    }
    const quantizedPolicy = quantizedPolicyForProjection(
      policy,
      aggregateAssert,
      outOfScopeBelow,
      perAxisFail,
      perAxisSuspendBelow,
    );
    if (evaluateDecision(quantizedScoring, quantizedPolicy).decision !== typescript.decision) {
      return { status: "not_comparable", reason: "quantization_changes_decision" };
    }
  }

  return {
    status: "comparable",
    projection: {
      schema_version: "blue-tanuki.hds-runtime-j-projection.v1",
      typescript_decision: typescript.decision,
      axes,
      thresholds: {
        aggregate_assert_micros: aggregateAssert,
        out_of_scope_below_micros: outOfScopeBelow,
        per_axis_fail: perAxisFail,
        per_axis_suspend_below: perAxisSuspendBelow,
      },
    },
  };
}

function thresholdEntries(
  values: Record<string, number> | undefined,
): RuntimeKernelJThresholdProjection[] | undefined {
  const entries = Object.entries(values ?? {});
  if (entries.length > MAX_AXES) return undefined;
  const result: RuntimeKernelJThresholdProjection[] = [];
  for (const [axis, threshold] of entries) {
    const thresholdUnits = toUnits(threshold, -1, 2);
    if (!AXIS_NAME_PATTERN.test(axis) || thresholdUnits === undefined) return undefined;
    result.push({ axis, threshold_micros: thresholdUnits });
  }
  return result;
}

function quantizedScoringForProjection(
  scoring: ScoringResult,
  axes: RuntimeKernelJAxisProjection[],
): ScoringResult {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const axis of axes) {
    const score = axis.score_micros / SCALE;
    const weight = axis.weight_micros / SCALE;
    weightedSum += score * weight;
    weightTotal += weight;
  }
  return {
    ...scoring,
    axis_scores: scoring.axis_scores.map((score, index) => ({
      ...score,
      score: axes[index]!.score_micros / SCALE,
    })),
    aggregate: weightTotal > 0 ? weightedSum / weightTotal : 0,
  };
}

function quantizedPolicyForProjection(
  policy: PolicyConfig,
  aggregateAssert: number,
  outOfScopeBelow: number,
  perAxisFail: RuntimeKernelJThresholdProjection[],
  perAxisSuspendBelow: RuntimeKernelJThresholdProjection[],
): PolicyConfig {
  return {
    ...policy,
    thresholds: {
      aggregate_assert: aggregateAssert / SCALE,
      out_of_scope_below: outOfScopeBelow / SCALE,
      per_axis_fail: Object.fromEntries(perAxisFail.map(({ axis, threshold_micros }) => [axis, threshold_micros / SCALE])),
      per_axis_suspend_below: Object.fromEntries(perAxisSuspendBelow.map(({ axis, threshold_micros }) => [axis, threshold_micros / SCALE])),
    },
  };
}

function toUnits(value: number, minimum: number, maximum: number): number | undefined {
  if (!Number.isFinite(value) || value < minimum || value > maximum) return undefined;
  const units = Math.round(value * SCALE);
  return Number.isSafeInteger(units) ? units : undefined;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
