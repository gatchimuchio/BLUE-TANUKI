import { createHash } from "node:crypto";
import { GoalCompletionRulesSchema } from "@blue-tanuki/protocol";

/** 同一のowner規則集合をJ policyと非権威projectionで結ぶcanonical digest。 */
export function goalCompletionRulesDigest(input: unknown): string {
  const rules = GoalCompletionRulesSchema.parse(input);
  return createHash("sha256").update(stable(rules)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
