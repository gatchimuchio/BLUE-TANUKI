import { describe, expect, it } from "vitest";
import { buildMemoryJudgmentReassessmentProposals } from "../src/memory_judgment_reassessment_candidate.js";

describe("memory judgment reassessment candidate semantics", () => {
  it("binds each verified target once and sorts prior judgments without mutating dependencies", () => {
    const verifiedDependencies = [
      { reference: { record_id: "F:trip", version: "a".repeat(64) },
        interpretation_id: "interpretation:current", judgment_ref: "judgment:current",
        reassesses_judgment_refs: ["judgment:z", "judgment:a"] },
      { reference: { record_id: "F:trip", version: "a".repeat(64) },
        interpretation_id: "interpretation:duplicate", judgment_ref: "judgment:duplicate",
        reassesses_judgment_refs: ["judgment:ignored"] },
      { reference: { record_id: "F:other", version: "b".repeat(64) },
        interpretation_id: "interpretation:other", judgment_ref: "judgment:other" },
    ] as const;

    const proposals = buildMemoryJudgmentReassessmentProposals({
      citation_request_id: "citation-request",
      citation_command_id: "citation-command",
      citation_audit_digest: "c".repeat(64),
      verified_dependencies: verifiedDependencies,
    });

    expect(proposals).toEqual([{
      args: {
        citation_request_id: "citation-request",
        citation_command_id: "citation-command",
        target_record_id: "F:trip",
        target_version: "a".repeat(64),
        interpretation_id: "interpretation:current",
        judgment_ref: "judgment:current",
        citation_audit_digest: "c".repeat(64),
      },
      reassesses_judgment_refs: ["judgment:a", "judgment:z"],
    }]);
    expect(verifiedDependencies[0].reassesses_judgment_refs).toEqual(["judgment:z", "judgment:a"]);
    expect(Object.isFrozen(proposals[0]?.args)).toBe(true);
    expect(Object.isFrozen(proposals[0]?.reassesses_judgment_refs)).toBe(true);
  });
});
