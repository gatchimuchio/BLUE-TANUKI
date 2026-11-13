import { goalCompletionRulesDigest } from "@blue-tanuki/hds-brain";
import type { HDSUpperController } from "@blue-tanuki/hds-brain";
import type { GoalCompletionRules } from "@blue-tanuki/protocol";
import { digestString, projectOperationPlanStatus } from "./serve_projection.js";

export function renderCurrentCliGoalCompletionProjection(input: {
  hds: Pick<HDSUpperController, "getRuntimeSnapshot" | "reconcileOperationPlanMemory">;
  request_id: string;
  rules: GoalCompletionRules;
}): string {
  if (!input.hds.reconcileOperationPlanMemory()) {
    return "達成判定: 未確認（M receiptを現在状態へ反映できませんでした）";
  }
  return renderCliGoalCompletionProjection({
    operation_plans: input.hds.getRuntimeSnapshot().operation_plans,
    request_id: input.request_id,
    rules: input.rules,
  });
}

export function renderCurrentCliGoalCompletionStatusProjection(input: {
  hds: Pick<HDSUpperController, "getRuntimeSnapshot" | "reconcileOperationPlanMemory">;
  request_id_digest: string;
}): string {
  const fallback = "達成判定: 未確認（このCLI照会に対応する検証済みJ状態を確認できません）";
  if (!/^[a-f0-9]{64}$/.test(input.request_id_digest) || !input.hds.reconcileOperationPlanMemory()) return fallback;
  try {
    const projection = projectOperationPlanStatus(input.hds.getRuntimeSnapshot().operation_plans);
    if (projection.status !== "available" || projection.used_for_authority !== false ||
        projection.raw_payload_exposed !== false) return fallback;
    const matchingPlans = projection.plans.filter((candidate) => candidate.request_id_digest === input.request_id_digest);
    if (matchingPlans.length !== 1) return fallback;
    const plan = matchingPlans[0];
    const outcome = plan?.task_outcome;
    const assessment = outcome?.goal_assessment;
    if (!outcome || !assessment || outcome.used_for_authority || outcome.may_execute ||
        assessment.used_for_authority || assessment.may_execute || !assessment.rules_digest ||
        !/^[a-f0-9]{64}$/.test(assessment.rules_digest) || assessment.rule_count < 1) return fallback;
    const verifiedAchievement = outcome.status === "achieved" &&
      outcome.reason_code === "goal_completion_rules_satisfied" && assessment.status === "rules_satisfied" &&
      assessment.reason_code === "rules_satisfied" && assessment.satisfied_rule_count === assessment.rule_count &&
      typeof assessment.evidence_digest === "string" && /^[a-f0-9]{64}$/.test(assessment.evidence_digest);
    const label = verifiedAchievement ? "達成" : outcome.status === "in_progress" ? "進行中" : "保留";
    const lines = [
      `達成判定: ${label}`,
      `計画照会ID digest: ${input.request_id_digest}`,
      `理由: ${outcome.reason_code}`,
      `検証済み規則: ${assessment.satisfied_rule_count}/${assessment.rule_count}`,
      `規則digest: ${assessment.rules_digest}`,
    ];
    if (verifiedAchievement) lines.push(`根拠digest: ${assessment.evidence_digest}`);
    lines.push("この照会は外部作用や計画実行を行わず、達成判定は権限を付与しません。");
    return lines.join("\n");
  } catch {
    return fallback;
  }
}

export function renderCliGoalCompletionProjection(input: {
  operation_plans: unknown;
  request_id: string;
  rules: GoalCompletionRules;
}): string {
  const fallback = "達成判定: 未確認（このCLI要求に対応する検証済みJ結果を確認できません）";
  try {
    const projection = projectOperationPlanStatus(input.operation_plans);
    if (projection.status !== "available" || projection.used_for_authority !== false ||
        projection.raw_payload_exposed !== false) return fallback;
    const requestDigest = digestString(input.request_id);
    const matchingPlans = projection.plans.filter((candidate) => candidate.request_id_digest === requestDigest);
    if (matchingPlans.length !== 1) return fallback;
    const plan = matchingPlans[0];
    if (!plan) return fallback;

    const outcome = plan.task_outcome;
    if (!outcome) return fallback;
    const assessment = outcome.goal_assessment;
    const expectedRulesDigest = goalCompletionRulesDigest(input.rules);
    const assessmentMatches = assessment?.rules_digest === expectedRulesDigest &&
      assessment.rule_count === input.rules.rules.length;
    const verifiedAchievement = outcome.status === "achieved" &&
      outcome.reason_code === "goal_completion_rules_satisfied" &&
      assessmentMatches && assessment?.status === "rules_satisfied" &&
      assessment.satisfied_rule_count === input.rules.rules.length &&
      typeof assessment.evidence_digest === "string" && /^[a-f0-9]{64}$/.test(assessment.evidence_digest);
    const label = verifiedAchievement
      ? "達成"
      : outcome.status === "in_progress" ? "進行中" : "保留";
    const lines = [
      `達成判定: ${label}`,
      `計画照会ID digest: ${requestDigest}`,
      `理由: ${outcome.reason_code}`,
      `検証済み規則: ${assessmentMatches ? assessment!.satisfied_rule_count : 0}/${input.rules.rules.length}`,
    ];
    if (verifiedAchievement) lines.push(`根拠digest: ${assessment!.evidence_digest}`);
    lines.push("この判定は実行権限を付与しません。");
    return lines.join("\n");
  } catch {
    return fallback;
  }
}
