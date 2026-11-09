import { createHash } from "node:crypto";
import {
  GOAL_PROJECTION_SCHEMA_VERSION,
  GoalProjectionSchema,
  type GoalProjection,
} from "@blue-tanuki/protocol";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ReadonlyGoalProjection = DeepReadonly<GoalProjection>;
export type GoalProjectionSourceKind = GoalProjection["original_request_ref"]["source_kind"];
export type GoalEvaluationRulesReference = Extract<GoalProjection["evaluation_rules"], { status: "referenced" }>;

/** 原文は保持せず、受入済み入力への参照とdigestから未同定射影を作る。 */
export function createUnidentifiedGoalProjection(input: {
  request_id: string;
  original_content: string;
  source_kind?: GoalProjectionSourceKind;
  evaluation_rules_reference?: Omit<GoalEvaluationRulesReference, "status">;
}): ReadonlyGoalProjection {
  const content_sha256 = createHash("sha256").update(input.original_content, "utf8").digest("hex");
  const projectionIdentity = `${GOAL_PROJECTION_SCHEMA_VERSION}|${input.request_id}|${content_sha256}` +
    (input.evaluation_rules_reference ? `|evaluation_rules:${input.evaluation_rules_reference.rules_digest}` : "");
  const projection_id = createHash("sha256")
    .update(projectionIdentity, "utf8")
    .digest("hex");

  const parsed = GoalProjectionSchema.parse({
    schema_version: GOAL_PROJECTION_SCHEMA_VERSION,
    projection_id,
    state: "identifying",
    original_request_ref: {
      source_kind: input.source_kind ?? "accepted_inbound_request",
      request_id: input.request_id,
      content_sha256,
      immutable: true,
    },
    necessity: { status: "unknown" },
    target_state: { status: "unknown" },
    evaluation_rules: input.evaluation_rules_reference
      ? { status: "referenced", ...input.evaluation_rules_reference }
      : { status: "unknown" },
    validity_period: { status: "unknown" },
    authority: { status: "unknown" },
  });

  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
