import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  CompleteHistoryStore,
  FailureMemoryStore,
  assessFailureReviewCandidate,
  candidateFromCommand,
  createFailureReviewProjection,
  extractFailureSignatures,
  failureReviewProjectionDigest,
  sha256Hex,
  runPeriodicFailureMemoryVerification,
} from "../src/index.js";

function toolCommand(id = "cmd-1", requestId = "req-1", tool = "file.search", args: Record<string, unknown> = { query: "needle" }): ExecuteCommand {
  return {
    id,
    type: "tool_call",
    payload: {
      tool_name: tool,
      arguments: args,
    },
    constraints: {
      allowed_tools: [tool],
      allowed_capabilities: ["fs:read"],
    },
    upstream_decision: {
      frame_goal: "test command",
      model_abstraction: "test",
      commit_hash: `hash-${requestId}`,
      commit_decision: "ASSERT",
    },
  };
}

describe("FailureMemoryStore", () => {
  it("creates signatures, updates hit count, preserves evidence, transitions state, and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-memory-"));
    const file = join(dir, "failure-memory.json");
    try {
      const store = new FailureMemoryStore({ filepath: file, now: () => new Date("2026-01-01T00:00:00.000Z") });
      const candidate = candidateFromCommand(toolCommand());
      const signature = store.addSignature({
        scope: candidate.scope,
        failure_type: "bad_command",
        input_pattern: candidate.input_pattern,
        action_pattern: candidate.action_pattern,
        context_pattern: candidate.context_pattern,
        evidence_log_ids: ["log-1"],
        state: "draft",
        confidence: 0.6,
        severity: "medium",
      });

      expect(signature.evidence_log_ids).toEqual(["log-1"]);
      store.updateHitCount(signature.id, 2, ["log-2"]);
      store.markState(signature.id, "shadow");
      store.markState(signature.id, "active");
      store.markState(signature.id, "retired");

      const reloaded = new FailureMemoryStore({ filepath: file });
      const loaded = reloaded.get(signature.id);
      expect(loaded?.hit_count).toBe(2);
      expect(loaded?.state).toBe("retired");
      expect(loaded?.evidence_log_ids).toEqual(["log-1", "log-2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects stale rules and decays non-critical confidence", () => {
    const store = new FailureMemoryStore({ now: () => new Date("2026-01-20T00:00:00.000Z") });
    const signature = store.addSignature({
      scope: "tool",
      failure_type: "repeat_error",
      input_pattern: "tool",
      action_pattern: "tool",
      context_pattern: "{}",
      state: "active",
      severity: "low",
      confidence: 0.8,
      last_seen_at: "2026-01-01T00:00:00.000Z",
    });

    expect(store.staleRules().map((rule) => rule.id)).toContain(signature.id);
    const decayed = store.decayOldRules();
    expect(decayed[0]?.confidence).toBeLessThan(0.8);
  });
});

describe("FailureReview independent observation binding", () => {
  it("binds only scope review to complete-history evidence and keeps cause unadopted", () => {
    const signature = new FailureMemoryStore().addSignature({
      scope: "repo",
      failure_type: "logic_drift",
      input_pattern: "input",
      action_pattern: "action",
      context_pattern: "context",
      evidence_log_ids: ["history-entry-1"],
    });
    const projection = createFailureReviewProjection(signature, [{
      source: "complete_history",
      entry_id_digest: sha256Hex("history-entry-1"),
      entry_hash: "e".repeat(64),
      payload_digest: "f".repeat(64),
      entry_kind: "execution_history",
      observed_failures: [{ scope: "repo", failure_type: "logic_drift" }],
    }], "verified");
    const candidate = {
      schema_version: "blue-tanuki.failure-review-candidate.v1",
      signature_id: projection.signature_id,
      signature_digest: projection.signature_digest,
      projection_digest: failureReviewProjectionDigest(projection),
      cause_hypotheses: [{ category: "logic_drift", rationale: "unverified cause" }],
      alternative_hypotheses: ["alternative"],
      observation_error_hypotheses: ["observation error"],
      scope_assessment: "same_scope",
      counterexamples: ["counterexample candidate"],
      resume_conditions: ["resume condition candidate"],
      additional_observations: ["more evidence"],
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    };

    const trace = assessFailureReviewCandidate({ projection, candidate, source_bound: true });
    expect(trace).toMatchObject({
      status: "recorded",
      scope_disposition: "bound_to_independent_observation",
      independent_observation_count: 1,
      counterexample_review_target_status: "retained_for_future_observation",
      resume_condition_review_target_status: "retained_for_future_observation",
      cause_adoption: "not_adopted",
      may_execute: false,
      used_for_authority: false,
    });
  });

  it("holds scope review when linked history observations are missing", () => {
    const signature = new FailureMemoryStore().addSignature({
      scope: "repo",
      failure_type: "logic_drift",
      input_pattern: "input",
      action_pattern: "action",
      context_pattern: "context",
      evidence_log_ids: ["history-entry-1"],
    });
    const projection = createFailureReviewProjection(signature, [], "verified");
    const candidate = {
      schema_version: "blue-tanuki.failure-review-candidate.v1",
      signature_id: projection.signature_id,
      signature_digest: projection.signature_digest,
      projection_digest: failureReviewProjectionDigest(projection),
      cause_hypotheses: [],
      alternative_hypotheses: [],
      observation_error_hypotheses: [],
      scope_assessment: "same_scope",
      counterexamples: [],
      resume_conditions: [],
      additional_observations: [],
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    };

    expect(assessFailureReviewCandidate({ projection, candidate, source_bound: true })).toMatchObject({
      scope_disposition: "held_for_independent_observation",
      cause_adoption: "not_adopted",
      may_execute: false,
    });
  });
});

describe("Pre-execution failure gate", () => {
  it("enforces exact match blocks as configured", () => {
    const store = new FailureMemoryStore();
    const candidate = candidateFromCommand(toolCommand());
    store.addSignature({
      scope: candidate.scope,
      failure_type: "bad_command",
      input_pattern: candidate.input_pattern,
      action_pattern: candidate.action_pattern,
      context_pattern: candidate.context_pattern,
      state: "active",
      suppression_policy: "block",
      severity: "critical",
      confidence: 0.95,
      match_level: 0,
      notes: "never_probe_justification:test permanent exact block",
    });

    expect(store.evaluateGate(candidate).decision).toBe("block");
  });

  it("does not carry a command failure across a different target", () => {
    const store = new FailureMemoryStore();
    const ruleCandidate = candidateFromCommand(toolCommand("cmd-a", "req-a", "file.search", {
      path: "/tmp/a/550e8400-e29b-41d4-a716-446655440000/input.txt",
    }), { actor: "fixture-owner", channel: "webchat", request_id: "req-a" });
    const nextCandidate = candidateFromCommand(toolCommand("cmd-b", "req-b", "file.search", {
      path: "/tmp/a/550e8400-e29b-41d4-a716-446655440001/input.txt",
    }), { actor: "fixture-owner", channel: "webchat", request_id: "req-b" });
    store.addSignature({
      scope: ruleCandidate.scope,
      failure_type: "wrong_file",
      input_pattern: ruleCandidate.input_pattern,
      action_pattern: ruleCandidate.action_pattern,
      context_pattern: ruleCandidate.context_pattern,
      state: "active",
      suppression_policy: "require_approval",
      severity: "high",
      confidence: 0.9,
      match_level: 1,
    });

    const result = store.evaluateGate(nextCandidate);
    expect(result.decision).toBe("allow");
    expect(result.matches).toHaveLength(0);
  });

  it("matches the same target and goal across request ids while retaining actor and channel conditions", () => {
    const command = toolCommand("cmd-a", "req-a", "file.search", { path: "/tmp/a/input.txt" });
    const sourceContext = { actor: "fixture-owner", channel: "webchat", request_id: "req-a", surface: "webchat" };
    const extracted = extractFailureSignatures({
      kind: "command_result",
      command,
      context: sourceContext,
      feedback: { command_id: command.id, status: "failed", error: "target unavailable", metrics: { duration_ms: 1 } },
    })[0]!;
    const store = new FailureMemoryStore();
    store.addSignature({
      ...extracted,
      state: "active",
      suppression_policy: "require_approval",
      severity: "high",
      confidence: 0.9,
      match_level: 1,
    });

    const sameTarget = toolCommand("cmd-b", "req-b", "file.search", { path: "/tmp/a/input.txt" });
    const sameConditions = store.evaluateCommandGate(sameTarget, {
      actor: "fixture-owner", channel: "webchat", request_id: "req-b", surface: "webchat",
    });
    const differentGoal = toolCommand("cmd-c", "req-c", "file.search", { path: "/tmp/a/input.txt" });
    differentGoal.upstream_decision.frame_goal = "different purpose";
    const differentActor = store.evaluateCommandGate(sameTarget, {
      actor: "another-owner", channel: "webchat", request_id: "req-b", surface: "webchat",
    });
    const differentChannel = store.evaluateCommandGate(sameTarget, {
      actor: "fixture-owner", channel: "cli", request_id: "req-b", surface: "cli",
    });

    expect(sameConditions.decision).toBe("require_approval");
    expect(sameConditions.matches[0]?.match_level).toBe(1);
    expect(store.evaluateCommandGate(differentGoal, sourceContext).decision).toBe("allow");
    expect(differentActor.decision).toBe("allow");
    expect(differentChannel.decision).toBe("allow");
  });

  it("persists digest-only command failure observations and keeps v2 optional fields backward compatible", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-memory-redaction-"));
    const file = join(dir, "failure-memory.json");
    const privateTarget = "PRIVATE_TARGET_SENTINEL";
    const privateGoal = "PRIVATE_GOAL_SENTINEL";
    const privateError = "PRIVATE_ERROR_SENTINEL";
    try {
      const command = toolCommand("cmd-private", "req-private", "file.search", {
        path: privateTarget,
        query: "PRIVATE_ARGUMENT_SENTINEL",
      });
      command.upstream_decision.frame_goal = privateGoal;
      const observation = extractFailureSignatures({
        kind: "command_result",
        command,
        context: { actor: "PRIVATE_ACTOR_SENTINEL", channel: "webchat", request_id: "PRIVATE_REQUEST_SENTINEL" },
        feedback: { command_id: command.id, status: "failed", error: privateError, metrics: { duration_ms: 1 } },
      })[0]!;
      expect(observation.cause_candidates).toBeUndefined();
      expect(observation.unknowns).toEqual(expect.arrayContaining([
        "root_cause_unconfirmed", "predicted_difference_not_observed",
      ]));
      expect(observation.result_pattern).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(createFailureReviewProjection({ ...observation, id: "123e4567-e89b-42d3-a456-426614174000" })).toMatchObject({
        failure_type: "repeat_error",
        cause_candidates: [],
        unknowns: expect.arrayContaining(["root_cause_unconfirmed"]),
      });

      const store = new FailureMemoryStore({ filepath: file });
      store.addSignature(observation);
      const persisted = readFileSync(file, "utf8");
      for (const sentinel of [privateTarget, privateGoal, privateError, "PRIVATE_ARGUMENT_SENTINEL", "PRIVATE_ACTOR_SENTINEL", "PRIVATE_REQUEST_SENTINEL"]) {
        expect(persisted).not.toContain(sentinel);
      }

      const legacyPath = join(dir, "legacy-v2.json");
      const legacySnapshot = {
        schema_version: "failure-memory-v2",
        exported_at: "2026-01-01T00:00:00.000Z",
        signatures: [{
          id: "legacy-signature", scope: "tool", failure_type: "repeat_error",
          input_pattern: "legacy input", action_pattern: "legacy action", context_pattern: "{}",
          evidence_log_ids: [], match_level: 1, suppression_policy: "warn", confidence: 0.5,
          severity: "medium", state: "shadow", created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z", last_seen_at: "2026-01-01T00:00:00.000Z",
          hit_count: 1, allow_probe: true, probe_policy: "shadow_only",
        }],
      };
      writeFileSync(legacyPath, JSON.stringify(legacySnapshot), "utf8");
      const legacyStore = new FailureMemoryStore({ filepath: legacyPath });
      const legacy = legacyStore.get("legacy-signature");
      expect(legacy?.cause_candidates).toBeUndefined();
      expect(legacy?.unknowns).toBeUndefined();
      expect(legacyStore.evaluateCommandGate(toolCommand("legacy-candidate", "legacy-request", "echo")).decision).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never auto-blocks broad semantic matches", () => {
    const store = new FailureMemoryStore();
    store.addSignature({
      scope: "llm_output",
      failure_type: "hallucination",
      input_pattern: "invented package version and fabricated release note",
      action_pattern: "summarize dependency release",
      context_pattern: "release note summary",
      state: "active",
      suppression_policy: "block",
      severity: "critical",
      confidence: 1,
      match_level: 3,
    });

    const result = store.evaluateGate({
      scope: "llm_output",
      input_pattern: "fabricated package version in release summary",
      action_pattern: "draft release summary",
      context_pattern: "release note summary",
    });
    expect(result.decision).not.toBe("block");
    expect(["warn", "downrank"]).toContain(result.decision);
  });

  it("uses conservative defaults for boundary violations and low-confidence rules", () => {
    const store = new FailureMemoryStore();
    const boundary = store.addSignature({
      scope: "boundary",
      failure_type: "boundary_violation",
      input_pattern: "invalid inbound",
      action_pattern: "authority boundary",
      context_pattern: "{}",
      state: "active",
      severity: "critical",
      confidence: 0.95,
      match_level: 0,
      notes: "never_probe_justification:boundary safety",
    });
    const low = store.addSignature({
      scope: "tool",
      failure_type: "repeat_error",
      input_pattern: "flaky command",
      action_pattern: "flaky command",
      context_pattern: "{}",
      state: "active",
      severity: "high",
      confidence: 0.2,
      match_level: 0,
    });

    expect(store.get(boundary.id)?.suppression_policy).toBe("block");
    expect(store.get(low.id)?.suppression_policy).toBe("warn");
  });

  it("does not enforce retired rules", () => {
    const store = new FailureMemoryStore();
    const candidate = candidateFromCommand(toolCommand());
    store.addSignature({
      scope: candidate.scope,
      failure_type: "bad_command",
      input_pattern: candidate.input_pattern,
      action_pattern: candidate.action_pattern,
      context_pattern: candidate.context_pattern,
      state: "retired",
      suppression_policy: "block",
      severity: "critical",
      confidence: 1,
      match_level: 0,
    });

    expect(store.evaluateGate(candidate).decision).toBe("allow");
  });
});

describe("Failure signature extraction and periodic verifier", () => {
  it("extracts failed command results into structured signatures", () => {
    const command = toolCommand("cmd-fail");
    const signatures = extractFailureSignatures({
      kind: "command_result",
      command,
      feedback: {
        command_id: command.id,
        status: "failed",
        error: "Tool not registered: file.search",
        metrics: { duration_ms: 1 },
      },
      evidence_log_id: "evidence-1",
    });

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      failure_type: "bad_command",
      evidence_log_ids: ["evidence-1"],
    });
  });

  it("detects repeated failures, unconverted events, stale blocks, and emits a structured report", () => {
    const history = new CompleteHistoryStore();
    history.append({
      kind: "execution_history",
      request_id: "req-1",
      command_id: "cmd-1",
      payload: {
        command: { type: "tool_call", operation: "file.search" },
        status: "failed",
        error: "Tool not registered: file.search",
      },
    });
    history.append({
      kind: "execution_history",
      request_id: "req-2",
      command_id: "cmd-2",
      payload: {
        command: { type: "tool_call", operation: "file.search" },
        status: "failed",
        error: "Tool not registered: file.search",
      },
    });
    const staleStore = new FailureMemoryStore({ now: () => new Date("2026-02-10T00:00:00.000Z") });
    staleStore.addSignature({
      scope: "tool",
      failure_type: "bad_command",
      input_pattern: "old blocked command",
      action_pattern: "old blocked command",
      context_pattern: "{}",
      state: "active",
      suppression_policy: "block",
      severity: "high",
      confidence: 0.9,
      match_level: 0,
      last_seen_at: "2026-01-01T00:00:00.000Z",
      next_revalidation_at: "2026-01-31T00:00:00.000Z",
    });

    const report = runPeriodicFailureMemoryVerification({
      entries: history.all(),
      existing_rules: staleStore.list(),
      trigger: "before_release",
      now: new Date("2026-02-10T00:00:00.000Z"),
    });

    expect(report.detected_failures.length).toBe(2);
    expect(report.repeated_failures).toHaveLength(1);
    expect(report.recommended_rules.length).toBeGreaterThan(0);
    expect(report.recommended_rules[0]?.evidence_log_ids.length).toBeGreaterThan(0);
    expect(report.stale_rules).toHaveLength(1);
    expect(report.unresolved_risks.join("\n")).toContain("failure event not converted");
  });
});

describe("Failure rule revalidation and safety boundaries", () => {
  it("revalidates sandbox block rules and preserves never-probe critical rules", () => {
    const store = new FailureMemoryStore({ now: () => new Date("2026-03-01T00:00:00.000Z") });
    const sandbox = store.addSignature({
      scope: "test",
      failure_type: "test_regression",
      input_pattern: "test fail",
      action_pattern: "pnpm test",
      context_pattern: "{}",
      state: "active",
      suppression_policy: "block",
      severity: "high",
      confidence: 0.9,
      match_level: 0,
      probe_policy: "sandbox",
      next_revalidation_at: "2026-02-28T00:00:00.000Z",
    });
    const never = store.addSignature({
      scope: "boundary",
      failure_type: "boundary_violation",
      input_pattern: "credential exfil",
      action_pattern: "external send",
      context_pattern: "{}",
      state: "active",
      suppression_policy: "block",
      severity: "critical",
      confidence: 1,
      match_level: 0,
      probe_policy: "never",
      notes: "never_probe_justification:credential boundary",
    });

    const sandboxResult = store.applyRevalidation(sandbox.id, "still_valid", "sandbox still fails");
    const neverResult = store.applyRevalidation(never.id, "still_valid", "should not probe");

    expect(sandboxResult.probed).toBe(true);
    expect(store.get(sandbox.id)?.last_validated_at).toBe("2026-03-01T00:00:00.000Z");
    expect(neverResult.probed).toBe(false);
    expect(store.get(never.id)?.state).toBe("active");
  });

  it("moves false positives to probation or retired and does not auto-retire critical rules", () => {
    const store = new FailureMemoryStore({ now: () => new Date("2026-04-20T00:00:00.000Z") });
    const falsePositive = store.addSignature({
      scope: "tool",
      failure_type: "repeat_error",
      input_pattern: "too broad",
      action_pattern: "too broad",
      context_pattern: "{}",
      state: "active",
      suppression_policy: "block",
      severity: "medium",
      confidence: 0.8,
      match_level: 0,
      probe_policy: "sandbox",
    });
    const critical = store.addSignature({
      scope: "authority",
      failure_type: "boundary_violation",
      input_pattern: "critical authority",
      action_pattern: "critical authority",
      context_pattern: "{}",
      state: "active",
      suppression_policy: "block",
      severity: "critical",
      confidence: 1,
      match_level: 0,
      last_seen_at: "2025-01-01T00:00:00.000Z",
      probe_policy: "never",
      notes: "never_probe_justification:authority safety",
    });

    const result = store.applyRevalidation(falsePositive.id, "false_positive", "matched unrelated action");
    store.decayOldRules();

    expect(result.next_state).toBe("probation");
    expect(store.get(falsePositive.id)?.suppression_policy).toBe("warn");
    expect(store.get(critical.id)?.state).toBe("active");
    expect(store.get(critical.id)?.confidence).toBe(1);
  });

  it("keeps LLM proposals non-authoritative", () => {
    const store = new FailureMemoryStore();
    const proposed = store.addLLMProposal({
      scope: "llm_output",
      failure_type: "hallucination",
      input_pattern: "summary",
      action_pattern: "summarize",
      context_pattern: "release",
      proposed_severity: "critical",
      proposed_confidence: 1,
      proposed_suppression_policy: "block",
    });

    expect(proposed.state).toBe("draft");
    expect(proposed.match_level).toBe(3);
    expect(proposed.suppression_policy).not.toBe("block");
    expect(proposed.notes).toContain("llm_proposal_non_authoritative");
  });
});
