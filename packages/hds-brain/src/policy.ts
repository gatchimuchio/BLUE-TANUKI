import { readFileSync } from "node:fs";
import type { Decision } from "@blue-tanuki/protocol";
import type {
  AxisScore,
  CandidateAdoptionDisposition,
  CandidateCheckOutcome,
  CandidateEvidenceStatus,
  CandidateSemanticOutcome,
  PolicyConfig,
  ScoringResult,
} from "./types.js";
import type { Detector, DetectorContext, DetectorLifecycleTrace, DetectorRegistry } from "./detectors/index.js";
import {
  detectorLifecycleEscalation,
  detectorLifecycleOk,
} from "./detectors/index.js";
import { evaluateUnknownEscalation } from "./boundary_policy.js";

/**
 * Run all detectors declared in a policy against the given context,
 * producing per-axis scores and an aggregate.
 *
 * Aggregate is the weighted average of axis scores, normalized by
 * the sum of weights (so policies need not pre-normalize to 1.0).
 */
export function runScoring(
  policy: PolicyConfig,
  ctx: DetectorContext,
  registry: DetectorRegistry,
): ScoringResult {
  const axis_scores: AxisScore[] = [];
  const weights: Record<string, number> = {};
  let weightedSum = 0;
  let weightTotal = 0;
  const seenAxes = new Set<string>();

  for (const ax of policy.axes) {
    if (seenAxes.has(ax.name)) {
      const lifecycle = detectorLifecycleEscalation(
        "detector_conflict",
        `duplicate policy axis: ${ax.name}`,
      );
      axis_scores.push(axisScore(ax.name, 0, ax.detector, lifecycle.reason, lifecycle));
      weights[ax.name] = ax.weight;
      weightTotal += ax.weight;
      continue;
    }
    seenAxes.add(ax.name);

    const det: Detector | undefined = registry.get(ax.detector);
    if (!det) {
      const lifecycle = detectorLifecycleEscalation(
        "missing_detector",
        `detector not registered: ${ax.detector}`,
      );
      axis_scores.push(axisScore(ax.name, 0, ax.detector, lifecycle.reason, lifecycle));
      weights[ax.name] = ax.weight;
      weightTotal += ax.weight;
      continue;
    }

    let out: ReturnType<Detector["evaluate"]>;
    try {
      out = det.evaluate(ax.detector_args ?? {}, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lifecycle = detectorLifecycleEscalation(
        "detector_exception",
        `detector threw: ${ax.detector}: ${message}`,
      );
      axis_scores.push(axisScore(ax.name, 0, ax.detector, lifecycle.reason, lifecycle));
      weights[ax.name] = ax.weight;
      weightTotal += ax.weight;
      continue;
    }

    const outputLifecycle = out.lifecycle ?? detectorLifecycleOk(`detector_output_ok:${ax.detector}`);
    if (outputLifecycle.status !== "ok") {
      axis_scores.push(axisScore(ax.name, 0, ax.detector, out.evidence ?? outputLifecycle.reason, outputLifecycle));
      weights[ax.name] = ax.weight;
      weightTotal += ax.weight;
      continue;
    }

    if (typeof out.score !== "number" || !Number.isFinite(out.score) || out.score < 0 || out.score > 1) {
      const lifecycle = detectorLifecycleEscalation(
        "invalid_output",
        `detector returned invalid score: ${ax.detector}`,
      );
      axis_scores.push(axisScore(ax.name, 0, ax.detector, out.evidence ?? lifecycle.reason, lifecycle));
      weights[ax.name] = ax.weight;
      weightTotal += ax.weight;
      continue;
    }

    axis_scores.push(axisScore(ax.name, out.score, ax.detector, out.evidence, outputLifecycle));
    weights[ax.name] = ax.weight;
    weightedSum += out.score * ax.weight;
    weightTotal += ax.weight;
  }

  const aggregate = weightTotal > 0 ? weightedSum / weightTotal : 0;
  return { axis_scores, weights, aggregate };
}

/**
 * Apply Operational Policy thresholds to a ScoringResult.
 *
 * Decision order (first match wins):
 *   1. per_axis_fail        : axis score ≤ threshold → FAIL
 *   2. per_axis_suspend_below: axis score < threshold → SUSPEND
 *   3. aggregate < out_of_scope_below → OUT_OF_SCOPE
 *   4. aggregate ≥ aggregate_assert   → ASSERT
 *   5. otherwise                       → SUSPEND
 *
 * Returns the decision plus a list of human-readable rule labels that fired.
 */
export function evaluateDecision(
  scoring: ScoringResult,
  policy: PolicyConfig,
): { decision: Decision; reason: string; triggered_thresholds: string[] } {
  const t = policy.thresholds;
  const byName = new Map(scoring.axis_scores.map((a) => [a.axis, a]));
  const triggered: string[] = [];

  const lifecycleIssue = scoring.axis_scores.find((a) => (a.lifecycle?.status ?? "ok") !== "ok");
  if (lifecycleIssue) {
    const escalationReason = lifecycleIssue.lifecycle.escalation_reason ?? "detector_conflict";
    const escalation = evaluateUnknownEscalation(escalationReason);
    triggered.push(`unknown_escalation:${escalationReason}`);
    triggered.push(`detector_lifecycle:${lifecycleIssue.axis}:${lifecycleIssue.lifecycle.status}`);
    return {
      decision: "SUSPEND",
      reason: `${escalation.reason}:axis=${lifecycleIssue.axis}:detector=${lifecycleIssue.detector}:status=${lifecycleIssue.lifecycle.status}`,
      triggered_thresholds: triggered,
    };
  }

  // 1. FAIL: any axis at-or-below its hard fail threshold
  if (t.per_axis_fail) {
    for (const [axis, thr] of Object.entries(t.per_axis_fail)) {
      const a = byName.get(axis);
      if (a && a.score <= thr) {
        triggered.push(`per_axis_fail:${axis}<=${thr}`);
        return {
          decision: "FAIL",
          reason: `axis '${axis}' at ${a.score.toFixed(2)} ≤ fail threshold ${thr}`,
          triggered_thresholds: triggered,
        };
      }
    }
  }

  // 2. SUSPEND on per-axis softness
  if (t.per_axis_suspend_below) {
    for (const [axis, thr] of Object.entries(t.per_axis_suspend_below)) {
      const a = byName.get(axis);
      if (a && a.score < thr) {
        triggered.push(`per_axis_suspend_below:${axis}<${thr}`);
        return {
          decision: "SUSPEND",
          reason: `axis '${axis}' at ${a.score.toFixed(2)} < suspend threshold ${thr}`,
          triggered_thresholds: triggered,
        };
      }
    }
  }

  // 3. OUT_OF_SCOPE if aggregate is too low
  if (scoring.aggregate < t.out_of_scope_below) {
    triggered.push(`out_of_scope_below:${t.out_of_scope_below}`);
    return {
      decision: "OUT_OF_SCOPE",
      reason: `aggregate ${scoring.aggregate.toFixed(2)} < out_of_scope_below ${t.out_of_scope_below}`,
      triggered_thresholds: triggered,
    };
  }

  // 4. ASSERT
  if (scoring.aggregate >= t.aggregate_assert) {
    triggered.push(`aggregate_assert:${t.aggregate_assert}`);
    return {
      decision: "ASSERT",
      reason: `aggregate ${scoring.aggregate.toFixed(2)} ≥ aggregate_assert ${t.aggregate_assert}`,
      triggered_thresholds: triggered,
    };
  }

  // 5. Default: SUSPEND
  triggered.push("default_suspend");
  return {
    decision: "SUSPEND",
    reason: `aggregate ${scoring.aggregate.toFixed(2)} below assert threshold; default suspend`,
    triggered_thresholds: triggered,
  };
}

/**
 * Reduce independent candidate checks to a bounded review disposition.
 * Passing this gate admits a candidate only to later goal review; it never
 * makes the candidate executable or grants authority.
 */
export function determineCandidateAdoptionDisposition(input: {
  mechanical_contract: CandidateCheckOutcome;
  domain_validation: CandidateCheckOutcome;
  semantic_outcome: CandidateSemanticOutcome;
  semantic_evidence_status: CandidateEvidenceStatus;
}): CandidateAdoptionDisposition {
  if (
    input.mechanical_contract === "fail" ||
    input.domain_validation === "fail" ||
    input.semantic_outcome === "conflicts"
  ) return "rejected";

  if (
    input.mechanical_contract !== "pass" ||
    input.domain_validation !== "pass" ||
    input.semantic_outcome !== "supports" ||
    input.semantic_evidence_status !== "observed"
  ) return "held";

  return "eligible_for_goal_review";
}

function axisScore(
  axis: string,
  score: number,
  detector: string,
  evidence: string | undefined,
  lifecycle: DetectorLifecycleTrace,
): AxisScore {
  return {
    axis,
    score,
    detector,
    evidence,
    lifecycle,
  };
}

/**
 * Load a policy config from a JSON file path.
 * Throws on parse errors — policy load failures should be loud.
 */
export function loadPolicyFromFile(filepath: string): PolicyConfig {
  const raw = readFileSync(filepath, "utf8");
  const parsed = JSON.parse(raw) as PolicyConfig;
  validatePolicy(parsed);
  return parsed;
}

/**
 * Lightweight structural validation. Catches typical config mistakes early.
 */
export function validatePolicy(p: PolicyConfig): void {
  if (!p.problem_definition_id) {
    throw new Error("policy: problem_definition_id is required");
  }
  if (!Array.isArray(p.axes) || p.axes.length === 0) {
    throw new Error("policy: at least one axis is required");
  }
  for (const ax of p.axes) {
    if (!ax.name || !ax.detector) {
      throw new Error(`policy: axis missing name or detector: ${JSON.stringify(ax)}`);
    }
    if (typeof ax.weight !== "number" || ax.weight < 0) {
      throw new Error(`policy: axis '${ax.name}' has invalid weight ${ax.weight}`);
    }
  }
  if (!p.thresholds) {
    throw new Error("policy: thresholds are required");
  }
  if (typeof p.thresholds.aggregate_assert !== "number") {
    throw new Error("policy: thresholds.aggregate_assert must be a number");
  }
  if (typeof p.thresholds.out_of_scope_below !== "number") {
    throw new Error("policy: thresholds.out_of_scope_below must be a number");
  }
}

/**
 * Built-in default policy, embedded for convenience.
 * The same content is also available as policies/default.json so it can be
 * edited without a recompile in non-bundled deployments.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  problem_definition_id: "default_v1",
  description: "Phase 1 default operational policy",
  axes: [
    {
      name: "input_validity",
      detector: "length",
      weight: 0.2,
      detector_args: { min_chars: 1, max_chars: 5000 },
    },
    {
      name: "risk_safety",
      detector: "risk_keyword",
      weight: 0.5,
      detector_args: {
        danger_patterns: [
          "rm\\s+-rf",
          "shutdown\\s+-",
          "DROP\\s+TABLE",
          "DROP\\s+DATABASE",
          "format\\s+c:",
          "mkfs\\.",
          "dd\\s+if=.*of=/dev/",
          ":(){ :\\|:& };:",
          "wget\\s+.*\\|\\s*sh",
          "curl\\s+.*\\|\\s*sh",
        ],
      },
    },
    {
      name: "compliance",
      detector: "keyword_match",
      weight: 0.3,
      detector_args: {
        blocked_terms: [
          "social security number",
          "credit card number",
          "passport number",
        ],
      },
    },
  ],
  thresholds: {
    aggregate_assert: 0.6,
    out_of_scope_below: 0.2,
    per_axis_fail: { risk_safety: 0.2 },
    per_axis_suspend_below: { risk_safety: 0.5, compliance: 0.5 },
  },
};
