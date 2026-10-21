import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FailureMemoryStore,
  buildFailureLearningDevelopmentHandoff,
  buildFailureLearningLineageRecord,
  createFailureReviewProjection,
  failureReviewProjectionDigest,
} from "@blue-tanuki/hds-brain";
import { DevelopmentHandoffStore, developmentHandoffStoreFromEnvironment } from "../src/development_handoff_store.js";

function createHandoff() {
  const failureMemory = new FailureMemoryStore();
  const signature = failureMemory.addSignature({
    scope: "repo",
    failure_type: "logic_drift",
    input_pattern: "candidate input",
    action_pattern: "candidate action",
    context_pattern: "candidate context",
  });
  const projection = createFailureReviewProjection(signature);
  const candidate = {
    schema_version: "blue-tanuki.failure-review-candidate.v1" as const,
    signature_id: projection.signature_id,
    signature_digest: projection.signature_digest,
    projection_digest: failureReviewProjectionDigest(projection),
    cause_hypotheses: [{ category: "logic_drift" as const, rationale: "candidate rationale for development review" }],
    alternative_hypotheses: ["alternative explanation"],
    observation_error_hypotheses: ["observation may be incomplete"],
    scope_assessment: "uncertain" as const,
    counterexamples: ["possible counterexample"],
    resume_conditions: ["observe the same case again"],
    additional_observations: ["collect one independent observation"],
    authority_boundary: { candidate_only: true as const, may_execute: false as const, used_for_authority: false as const },
  };
  const record = buildFailureLearningLineageRecord({
    projection,
    candidate,
    request_id: "request-id",
    command_id: "command-id",
    derived_at: new Date("2026-10-21T01:00:00.000Z"),
  });
  return buildFailureLearningDevelopmentHandoff(record, candidate);
}

describe("DevelopmentHandoffStore", () => {
  it("persists a validated candidate separately and exposes it only as pending development review", () => {
    const dir = mkdtempSync(join(tmpdir(), "development-handoff-"));
    const filepath = join(dir, "development-handoffs.json");
    try {
      const handoff = createHandoff();
      const store = new DevelopmentHandoffStore(filepath);

      expect(store.receive(handoff)).toEqual({ status: "stored" });
      expect(store.receive(handoff)).toEqual({ status: "replayed" });
      const secondHandoff = createHandoff();
      expect(store.receive(secondHandoff)).toEqual({ status: "stored" });
      const snapshot = store.snapshot();
      expect(snapshot.status).toBe("persistent");
      expect(snapshot.count).toBe(2);
      expect(snapshot.items[0]).toMatchObject({
        handoff_id: handoff.handoff_id,
        development_status: "awaiting_development_review",
        may_promote_version: false,
        used_for_authority: false,
        may_execute: false,
      });
      expect(new DevelopmentHandoffStore(filepath).snapshot().items).toEqual([handoff, secondHandoff]);
      expect(readFileSync(filepath, "utf8")).toContain("candidate rationale for development review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects changed candidate content and leaves a corrupt inbox unavailable without overwriting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "development-handoff-corrupt-"));
    const filepath = join(dir, "development-handoffs.json");
    try {
      const handoff = createHandoff();
      const tampered = structuredClone(handoff);
      tampered.candidate.cause_hypotheses[0]!.rationale = "changed after HDS review";
      const store = new DevelopmentHandoffStore(filepath);
      expect(store.receive(tampered)).toEqual({ status: "invalid" });

      writeFileSync(filepath, "{ invalid json", "utf8");
      const unavailable = new DevelopmentHandoffStore(filepath);
      expect(unavailable.snapshot()).toMatchObject({ status: "unavailable", count: 0, items: [] });
      expect(unavailable.receive(handoff)).toEqual({ status: "unavailable" });
      expect(readFileSync(filepath, "utf8")).toBe("{ invalid json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("places the inbox beside persistent failure memory unless an explicit inbox path is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "development-handoff-path-"));
    try {
      const store = developmentHandoffStoreFromEnvironment({
        BLUE_TANUKI_FAILURE_MEMORY_FILE: join(dir, "failure-memory.json"),
      });
      expect(store.snapshot().status).toBe("persistent");
      expect(store.receive(createHandoff())).toEqual({ status: "stored" });
      expect(readFileSync(join(dir, "development-handoffs.json"), "utf8")).toContain(
        "blue-tanuki.development-handoff-store.v1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
