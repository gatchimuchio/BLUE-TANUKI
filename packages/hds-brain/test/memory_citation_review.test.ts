import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import {
  MEANING_UPDATE_PROPOSAL_V1_SCHEMA_VERSION,
  meaningUpdateCandidateDigest,
} from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import {
  canonicalizeMemoryEntry,
  encodeMemoryEntry,
  LongTermMemoryStore,
  type MemoryEntry,
  type MemoryEntryHashInput,
} from "../src/long-term-memory/index.js";
import { buildMemoryCitationSystemMessages } from "../src/memory_citation_review.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function inbound(content: string, id: string): InboundRequest {
  return { id, channel: "test", user: "fixture-user", content, timestamp: Date.now() };
}

function setup(memory = new LongTermMemoryStore()) {
  const hds = new HDSUpperController({ memory });
  hds.decide(inbound("first source fact", "citation-support"));
  hds.decide(inbound("second source counterpoint", "citation-counter"));
  const decided = hds.decide(inbound(
    "compare F:citation-support with F:citation-counter",
    "citation-current-request",
  ));
  if (!decided.command || decided.command.type !== "llm_call") {
    throw new Error("expected an HDS-routed LLM command");
  }
  const support = decided.log.frame.memory_trace.hits.find((hit) => hit.memory_id === "citation-support");
  const counter = decided.log.frame.memory_trace.hits.find((hit) => hit.memory_id === "citation-counter");
  const searchPlan = decided.log.frame.memory_trace.search_plan;
  if (!support || !counter || !searchPlan) throw new Error("expected two scoped memory candidates");
  return { hds, memory, command: decided.command, support, counter,
    scopeId: searchPlan.application_scope_id, scopePlanDigest: searchPlan.plan_id };
}

function rewriteMemoryRecord(filepath: string, requestId: string, goal: string): void {
  const sourceEntries = readFileSync(filepath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as MemoryEntry);
  let previousHash = "GENESIS";
  const rewritten = sourceEntries.map((entry) => {
    const updated = { ...entry, ...(entry.request_id === requestId ? { goal } : {}), prev_hash: previousHash };
    const canonical = canonicalizeMemoryEntry(updated as MemoryEntryHashInput);
    const entryHash = createHash("sha256")
      .update(`${updated.index}|${previousHash}|${canonical}`, "utf8")
      .digest("hex");
    previousHash = entryHash;
    const hashed = { ...updated, entry_hash: entryHash };
    return encodeMemoryEntry(hashed);
  });
  writeFileSync(filepath, `${rewritten.join("\n")}\n`, "utf8");
}

function feedback(command_id: string, content: string): ExecuteFeedback {
  return {
    command_id,
    status: "success",
    result: { content, model: "fixture-model", tokens_used: 7 },
    metrics: { duration_ms: 2, tokens_used: 7, tool_calls: 0 },
  };
}

function envelope(
  support: { record_id: string; version: string },
  counter: { record_id: string; version: string },
  application_scope_id: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema_version: "blue-tanuki.memory-citation-response.v1",
    answer: "記録F:citation-supportとF:inventedを比べます。",
    citations: [{
      claim: "二つの記録を比較する提案",
      supporting: support,
      counterevidence: counter,
      application_scope_id,
    }],
    ...extra,
  });
}

function meaningUpdateProposal(
  support: { f_reference: string; entry_hash: string },
  counter: { f_reference: string; entry_hash: string },
  scopeId: string,
  scopePlanDigest: string,
) {
  return {
    schema_version: "blue-tanuki.meaning-update-proposal.v2",
    record_type: "meaning_update_proposal",
    proposal_ref: "proposal-citation-review-001",
    candidate_ref: "candidate:citation-review-001",
    candidate_digest: "c".repeat(64),
    target_reference: { record_id: support.f_reference, version: support.entry_hash },
    prior_version_ref: "version:citation-review-1",
    supporting_evidence: [{ reference: support.f_reference, digest: support.entry_hash }],
    counterevidence_review: {
      status: "reviewed_with_references",
      review_scope: { reference: scopeId, digest: scopePlanDigest },
      references: [{ reference: counter.f_reference, digest: counter.entry_hash }],
    },
    applicability_scope: { reference: scopeId, digest: scopePlanDigest },
    reflection_target_ref: "reflection:citation-review-001",
    proposal_status: "unverified",
    adoption_status: "not_adopted",
    may_apply: false,
    used_for_authority: false,
  };
}

describe("J-side memory citation review", () => {
  it("keeps citations current after an unrelated append to the file-backed M store", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-current-reference-append-"));
    tempDirectories.push(directory);
    const memory = new LongTermMemoryStore({ filepath: join(directory, "memory.jsonl") });
    const { hds, command, support, counter, scopeId } = setup(memory);
    hds.decide(inbound("unrelated later record", "citation-unrelated-later"));

    const current = memory.currentReferenceVersions([support.memory_id, counter.memory_id]);
    expect(current).toMatchObject({
      status: "verified",
      records: [
        { request_id: support.memory_id, version: support.entry_hash },
        { request_id: counter.memory_id, version: counter.entry_hash },
      ],
    });
    const reviewed = hds.reviewMemoryCitations(command, feedback(command.id, envelope(
      { record_id: support.f_reference, version: support.entry_hash },
      { record_id: counter.f_reference, version: counter.entry_hash },
      scopeId,
    )));
    expect((reviewed.result as { content: string }).content).toContain("【HDS照合済みの記憶参照】");
    expect(hds.getAudit().list().some(({ log }) => "kind" in log && log.kind === "memory_citation_review" && log.status === "accepted")).toBe(true);
  });

  it("rejects a citation when its exact persisted M dependency changed after C received the projection", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-current-reference-change-"));
    tempDirectories.push(directory);
    const filepath = join(directory, "memory.jsonl");
    const memory = new LongTermMemoryStore({ filepath });
    const { hds, command, support, counter, scopeId } = setup(memory);
    rewriteMemoryRecord(filepath, counter.memory_id, "updated source version");

    const current = memory.currentReferenceVersions([support.memory_id, counter.memory_id]);
    expect(current.status).toBe("verified");
    expect(current.records.find((record) => record.request_id === support.memory_id)?.version).toBe(support.entry_hash);
    expect(current.records.find((record) => record.request_id === counter.memory_id)?.version).not.toBe(counter.entry_hash);

    const reviewed = hds.reviewMemoryCitations(command, feedback(command.id, envelope(
      { record_id: support.f_reference, version: support.entry_hash },
      { record_id: counter.f_reference, version: counter.entry_hash },
      scopeId,
    )));
    const content = (reviewed.result as { content: string }).content;
    expect(content).not.toContain("【HDS照合済みの記憶参照】");
    const review = hds.getAudit().list().map((entry) => entry.log).find((entry) =>
      "kind" in entry && entry.kind === "memory_citation_review",
    );
    expect(review && "rejection_reasons" in review ? review.rejection_reasons : [])
      .toContain("memory_dependency_version_changed");
  });

  it("checks proposal record versions against the current M projection without assessing meaning or adoption", () => {
    const { hds, command, support, counter, scopeId, scopePlanDigest } = setup();
    hds.onFeedback({
      ...feedback(command.id, { content: "synthetic" }),
      meaning_update_proposal: meaningUpdateProposal(support, counter, scopeId, scopePlanDigest),
    });

    const entry = hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === command.id,
    );
    expect(entry && "kind" in entry && entry.kind === "executor_feedback" ? entry.feedback : undefined).toMatchObject({
      meaning_update_proposal_contract_status: "passed",
      meaning_update_proposal_reference_review: {
        review_status: "prior_version_unverified",
        supporting_reference_count: 1,
        supporting_references_verified: 1,
        counterevidence_reference_count: 1,
        counterevidence_references_verified: 1,
        applicability_scope_matches_current: true,
        counterevidence_scope_matches_current: true,
        applicability_scope_digest_matches_current: true,
        counterevidence_scope_digest_matches_current: true,
        counterevidence_claim_status: "references_verified",
        scope_digests_verified: true,
        target_reference_matches_current_projection: true,
        target_and_prior_version_verified: false,
        semantic_relation_status: "not_assessed",
        adoption_status: "not_adopted",
        may_apply: false,
        used_for_authority: false,
      },
      meaning_update_proposal_applied: false,
      meaning_update_proposal_used_for_authority: false,
    });
    const feedbackAuditText = JSON.stringify(entry && "kind" in entry && entry.kind === "executor_feedback"
      ? entry.feedback : {});
    expect(feedbackAuditText).not.toContain(support.f_reference);
    expect(feedbackAuditText).not.toContain(counter.f_reference);
    expect(feedbackAuditText).not.toContain(support.entry_hash);
    expect(feedbackAuditText).not.toContain(scopePlanDigest);
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("checks v3 content-bound proposal targets against current M without assessing meaning or adoption", () => {
    const { hds, command, support, counter, scopeId, scopePlanDigest } = setup();
    const candidateMeaning = "候補の意味内容";
    const proposal = {
      ...meaningUpdateProposal(support, counter, scopeId, scopePlanDigest),
      schema_version: "blue-tanuki.meaning-update-proposal.v3",
      candidate_meaning: candidateMeaning,
      candidate_digest: meaningUpdateCandidateDigest(candidateMeaning),
    };
    hds.onFeedback({
      ...feedback(command.id, { content: "synthetic" }),
      meaning_update_proposal: proposal,
    });

    const entry = hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === command.id,
    );
    expect(entry && "kind" in entry && entry.kind === "executor_feedback" ? entry.feedback : undefined).toMatchObject({
      meaning_update_proposal_contract_status: "passed",
      meaning_update_proposal_reference_review: {
        review_status: "prior_version_unverified",
        target_reference_matches_current_projection: true,
        candidate_content_digest_status: "verified",
        semantic_relation_status: "not_assessed",
        adoption_status: "not_adopted",
        may_apply: false,
        used_for_authority: false,
      },
      meaning_update_proposal_applied: false,
      meaning_update_proposal_used_for_authority: false,
    });
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("rechecks meaning-update evidence against current M without invalidating unchanged dependencies", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-current-meaning-update-"));
    tempDirectories.push(directory);
    const filepath = join(directory, "memory.jsonl");
    const memory = new LongTermMemoryStore({ filepath });
    const { hds, command, support, counter, scopeId, scopePlanDigest } = setup(memory);
    rewriteMemoryRecord(filepath, counter.memory_id, "updated counterevidence version");
    hds.onFeedback({
      ...feedback(command.id, { content: "synthetic" }),
      meaning_update_proposal: meaningUpdateProposal(support, counter, scopeId, scopePlanDigest),
    });

    const entry = hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === command.id,
    );
    expect(entry && "kind" in entry && entry.kind === "executor_feedback" ? entry.feedback : undefined).toMatchObject({
      meaning_update_proposal_reference_review: {
        review_status: "evidence_version_mismatch",
        supporting_references_verified: 1,
        counterevidence_references_verified: 0,
        target_reference_matches_current_projection: true,
        target_and_prior_version_verified: false,
        semantic_relation_status: "not_assessed",
        adoption_status: "not_adopted",
        may_apply: false,
        used_for_authority: false,
      },
      meaning_update_proposal_applied: false,
    });
  });

  it("requires an exact current M target version in v2 while leaving the prior version unverified", () => {
    const { hds, command, support, counter, scopeId, scopePlanDigest } = setup();
    const proposal = meaningUpdateProposal(support, counter, scopeId, scopePlanDigest);
    proposal.target_reference = { record_id: support.f_reference, version: "0".repeat(64) };
    hds.onFeedback({
      ...feedback(command.id, { content: "synthetic" }),
      meaning_update_proposal: proposal,
    });

    const entry = hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === command.id,
    );
    expect(entry && "kind" in entry && entry.kind === "executor_feedback" ? entry.feedback : undefined).toMatchObject({
      meaning_update_proposal_reference_review: {
        review_status: "target_reference_mismatch",
        target_reference_matches_current_projection: false,
        target_and_prior_version_verified: false,
        semantic_relation_status: "not_assessed",
        adoption_status: "not_adopted",
        may_apply: false,
        used_for_authority: false,
      },
    });
  });

  it("keeps legacy v1 target and prior-version claims explicitly unverified", () => {
    const { hds, command, support, counter, scopeId, scopePlanDigest } = setup();
    const current = meaningUpdateProposal(support, counter, scopeId, scopePlanDigest);
    const { target_reference: _targetReference, ...legacy } = current;
    hds.onFeedback({
      ...feedback(command.id, { content: "synthetic" }),
      meaning_update_proposal: {
        ...legacy,
        schema_version: MEANING_UPDATE_PROPOSAL_V1_SCHEMA_VERSION,
        target_ref: "memory:citation-review-target",
      },
    });

    const entry = hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === command.id,
    );
    expect(entry && "kind" in entry && entry.kind === "executor_feedback" ? entry.feedback : undefined).toMatchObject({
      meaning_update_proposal_contract_status: "passed",
      meaning_update_proposal_reference_review: {
        review_status: "target_reference_unverified",
        target_reference_matches_current_projection: false,
        target_and_prior_version_verified: false,
        semantic_relation_status: "not_assessed",
        adoption_status: "not_adopted",
        may_apply: false,
        used_for_authority: false,
      },
    });
  });

  it("does not validate failed feedback proposals or claims that no counterevidence was found", () => {
    const failed = setup();
    failed.hds.onFeedback({
      ...feedback(failed.command.id, { content: "synthetic" }),
      status: "failed",
      meaning_update_proposal: meaningUpdateProposal(failed.support, failed.counter, failed.scopeId, failed.scopePlanDigest),
    });
    const failedEntry = failed.hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === failed.command.id,
    );
    expect(failedEntry && "kind" in failedEntry && failedEntry.kind === "executor_feedback"
      ? failedEntry.feedback.meaning_update_proposal_reference_review : undefined).toMatchObject({
      review_status: "not_reviewed",
      counterevidence_claim_status: "not_reviewed",
      used_for_authority: false,
      may_apply: false,
    });

    const noCounter = setup();
    const proposal = meaningUpdateProposal(noCounter.support, noCounter.counter, noCounter.scopeId, noCounter.scopePlanDigest);
    proposal.counterevidence_review.status = "reviewed_none_found";
    proposal.counterevidence_review.references = [];
    noCounter.hds.onFeedback({
      ...feedback(noCounter.command.id, { content: "synthetic" }),
      meaning_update_proposal: proposal,
    });
    const noCounterEntry = noCounter.hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === noCounter.command.id,
    );
    expect(noCounterEntry && "kind" in noCounterEntry && noCounterEntry.kind === "executor_feedback"
      ? noCounterEntry.feedback.meaning_update_proposal_reference_review : undefined).toMatchObject({
      review_status: "counterevidence_absence_unverified",
      counterevidence_reference_count: 0,
      counterevidence_references_verified: 0,
      counterevidence_claim_status: "none_found_unverified",
      may_apply: false,
    });
  });

  it("marks stale evidence versions and mismatched scope references without adopting the proposal", () => {
    const stale = setup();
    const staleProposal = meaningUpdateProposal(stale.support, stale.counter, stale.scopeId, stale.scopePlanDigest);
    staleProposal.supporting_evidence[0]!.digest = "a".repeat(64);
    staleProposal.counterevidence_review.references[0]!.digest = "b".repeat(64);
    stale.hds.onFeedback({
      ...feedback(stale.command.id, { content: "synthetic" }),
      meaning_update_proposal: staleProposal,
    });
    const staleEntry = stale.hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === stale.command.id,
    );
    expect(staleEntry && "kind" in staleEntry && staleEntry.kind === "executor_feedback"
      ? staleEntry.feedback.meaning_update_proposal_reference_review : undefined).toMatchObject({
      review_status: "evidence_version_mismatch",
      supporting_reference_count: 1,
      supporting_references_verified: 0,
      counterevidence_references_verified: 0,
      counterevidence_claim_status: "references_unverified",
      adoption_status: "not_adopted",
      may_apply: false,
    });

    const wrongScope = setup();
    const wrongScopeProposal = meaningUpdateProposal(wrongScope.support, wrongScope.counter, wrongScope.scopeId, wrongScope.scopePlanDigest);
    wrongScopeProposal.applicability_scope.reference = "scope:not-current";
    wrongScope.hds.onFeedback({
      ...feedback(wrongScope.command.id, { content: "synthetic" }),
      meaning_update_proposal: wrongScopeProposal,
    });
    const wrongScopeEntry = wrongScope.hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === wrongScope.command.id,
    );
    expect(wrongScopeEntry && "kind" in wrongScopeEntry && wrongScopeEntry.kind === "executor_feedback"
      ? wrongScopeEntry.feedback.meaning_update_proposal_reference_review : undefined).toMatchObject({
      review_status: "scope_reference_mismatch",
      applicability_scope_matches_current: false,
      counterevidence_scope_matches_current: true,
      applicability_scope_digest_matches_current: true,
      counterevidence_scope_digest_matches_current: true,
      scope_digests_verified: true,
      may_apply: false,
    });
  });

  it("keeps proposal scopes unverified when either scope digest is not bound to the current J plan", () => {
    const { hds, command, support, counter, scopeId, scopePlanDigest } = setup();
    const proposal = meaningUpdateProposal(support, counter, scopeId, scopePlanDigest);
    proposal.counterevidence_review.review_scope.digest = "e".repeat(64);
    hds.onFeedback({
      ...feedback(command.id, { content: "synthetic" }),
      meaning_update_proposal: proposal,
    });
    const entry = hds.getAudit().list().map((item) => item.log).find((log) =>
      "kind" in log && log.kind === "executor_feedback" && log.command_id === command.id,
    );
    expect(entry && "kind" in entry && entry.kind === "executor_feedback"
      ? entry.feedback.meaning_update_proposal_reference_review : undefined).toMatchObject({
      review_status: "scope_digest_mismatch",
      applicability_scope_matches_current: true,
      counterevidence_scope_matches_current: true,
      applicability_scope_digest_matches_current: true,
      counterevidence_scope_digest_matches_current: false,
      scope_digests_verified: false,
      adoption_status: "not_adopted",
      may_apply: false,
      used_for_authority: false,
    });
  });

  it("admits an exact retrieved support/counterevidence pair for this request only", () => {
    const { hds, command, support, counter, scopeId } = setup();
    const raw = envelope(
      { record_id: support.f_reference, version: support.entry_hash },
      { record_id: counter.f_reference, version: counter.entry_hash },
      scopeId,
    );

    const reviewed = hds.reviewMemoryCitations(command, feedback(command.id, raw));
    const content = (reviewed.result as { content: string }).content;
    const answer = content.split("【HDS照合済みの記憶参照】")[0]!;
    expect(answer).not.toContain("F:citation-support");
    expect(answer).not.toContain("F:invented");
    expect(content).toContain(`record=F:citation-support; version=${support.entry_hash}`);
    expect(content).toContain(`record=F:citation-counter; version=${counter.entry_hash}`);
    expect(content).toContain("反証候補");
    expect(content).toContain(`scope_id=${scopeId}`);
    expect(content).toContain("意味関係はCの提案");

    const review = hds.getAudit().list().map((entry) => entry.log).find((entry) =>
      "kind" in entry && entry.kind === "memory_citation_review",
    );
    expect(review).toMatchObject({
      kind: "memory_citation_review",
      status: "accepted",
      candidate_count: 2,
      accepted_citations: [{
        supporting: { record_id: support.f_reference, version: support.entry_hash },
        counterevidence: { record_id: counter.f_reference, version: counter.entry_hash },
      }],
      dependency_versions: [
        { record_id: support.f_reference, version: support.entry_hash },
        { record_id: counter.f_reference, version: counter.entry_hash },
      ],
      rejected_proposal_count: 0,
      used_for_authority: false,
    });
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("keeps only exact projected record versions as dependencies after an unrelated append", () => {
    const { hds, support, counter } = setup();
    const previousVersions = [
      { record_id: support.f_reference, version: support.entry_hash },
      { record_id: counter.f_reference, version: counter.entry_hash },
    ];
    hds.decide(inbound("unrelated memory source", "citation-unrelated-update"));

    const refreshed = hds.decide(inbound(
      "compare F:citation-support with F:citation-counter",
      "citation-after-unrelated-update",
    ));
    if (!refreshed.command || refreshed.command.type !== "llm_call") {
      throw new Error("expected a refreshed HDS-routed LLM command");
    }
    const trace = refreshed.log.frame.memory_trace;
    const messages = buildMemoryCitationSystemMessages(trace);
    const contextMessage = messages[1];
    if (!contextMessage) throw new Error("expected current memory context");
    const context = JSON.parse(contextMessage.content.slice(contextMessage.content.indexOf("\n") + 1));
    expect(context.dependency_versions).toEqual(previousVersions);
    expect(context.records.map((record: { record_id: string }) => record.record_id)).toEqual([
      "F:citation-support",
      "F:citation-counter",
    ]);
    expect(context.records.every((record: { provenance: { decision_role: string } }) =>
      record.provenance.decision_role === "historical_evidence_only",
    )).toBe(true);
    expect(messages[0]?.content).toContain("今回の承認、権限、許可、grantではありません");

    const raw = envelope(
      previousVersions[0]!,
      previousVersions[1]!,
      trace.search_plan!.application_scope_id,
    );
    const reviewed = hds.reviewMemoryCitations(refreshed.command, feedback(refreshed.command.id, raw));
    expect((reviewed.result as { content: string }).content).toContain("履歴証拠のみで");
    expect((reviewed.result as { content: string }).content).toContain("historical_decision_evidence=");
    const review = hds.getAudit().list().map((entry) => entry.log).find((entry) =>
      "kind" in entry && entry.kind === "memory_citation_review" && entry.command_id === refreshed.command!.id,
    );
    expect(review && "dependency_versions" in review ? review.dependency_versions : []).toEqual(previousVersions);
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("rejects forged records, stale versions, and a mismatched application scope", () => {
    const cases = [
      {
        label: "forged record",
        support: { record_id: "F:not-retrieved", version: "a".repeat(64) },
        counter: { record_id: "F:citation-counter", version: "" },
        scope: "",
        reason: "not_in_retrieved_scope",
      },
      {
        label: "stale version",
        support: { record_id: "F:citation-support", version: "b".repeat(64) },
        counter: { record_id: "F:citation-counter", version: "" },
        scope: "",
        reason: "version_mismatch",
      },
      {
        label: "wrong scope",
        support: { record_id: "F:citation-support", version: "" },
        counter: { record_id: "F:citation-counter", version: "" },
        scope: "c".repeat(64),
        reason: "scope_mismatch",
      },
    ];

    for (const testCase of cases) {
      const { hds, command, support, counter, scopeId } = setup();
      const supportRef = testCase.support.version
        ? testCase.support
        : { record_id: support.f_reference, version: support.entry_hash };
      const counterRef = testCase.counter.version
        ? testCase.counter
        : { record_id: counter.f_reference, version: counter.entry_hash };
      const raw = envelope(supportRef, counterRef, testCase.scope || scopeId);
      const reviewed = hds.reviewMemoryCitations(command, feedback(command.id, raw));
      const content = (reviewed.result as { content: string }).content;
      expect(content, testCase.label).not.toContain("【HDS照合済みの記憶参照】");
      expect(content, testCase.label).not.toContain("F:not-retrieved");
      const review = hds.getAudit().list().map((entry) => entry.log).find((entry) =>
        "kind" in entry && entry.kind === "memory_citation_review",
      );
      expect(review && "rejection_reasons" in review ? review.rejection_reasons : []).toContain(testCase.reason);
    }
  });

  it("does not treat C self-scores or incomplete counterevidence as an admission basis", () => {
    const { hds, command, support, counter, scopeId } = setup();
    const scored = envelope(
      { record_id: support.f_reference, version: support.entry_hash },
      { record_id: counter.f_reference, version: counter.entry_hash },
      scopeId,
      { score: 1 },
    );
    const scoredResult = hds.reviewMemoryCitations(command, feedback(command.id, scored));
    expect((scoredResult.result as { content: string }).content).toContain("記憶引用を検証できなかったため");
    expect((scoredResult.result as { content: string }).content).not.toContain("二つの記録を比較する提案");
    expect((scoredResult.result as { content: string }).content).not.toContain("【HDS照合済みの記憶参照】");

    const incomplete = {
      schema_version: "blue-tanuki.memory-citation-response.v1",
      answer: "引用案",
      citations: [{
        claim: "反証欄を省略した案",
        supporting: { record_id: support.f_reference, version: support.entry_hash },
        application_scope_id: scopeId,
      }],
    };
    const incompleteResult = hds.reviewMemoryCitations(command, feedback(command.id, JSON.stringify(incomplete)));
    expect((incompleteResult.result as { content: string }).content).not.toContain("【HDS照合済みの記憶参照】");
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("fails closed on duplicate-key response JSON and does not expose the unreviewed citation body", () => {
    const { hds, command } = setup();
    const reviewed = hds.reviewMemoryCitations(
      command,
      feedback(command.id, '{"schema_version":"x","schema_version":"y","answer":"private F:citation-support","citations":[]}'),
    );
    const content = (reviewed.result as { content: string }).content;
    expect(content).toContain("記憶引用を検証できなかったため");
    expect(content).not.toContain("private");
    expect(content).not.toContain("F:citation-support");
    expect(hds.getAudit().list().some((entry) =>
      "kind" in entry.log && entry.log.kind === "memory_citation_review" && entry.log.status === "invalid_output",
    )).toBe(true);
  });

  it("records truncation differences and separates adopted, non-adopted, and excluded records without deleting sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-projection-"));
    tempDirectories.push(directory);
    const filepath = join(directory, "memory.jsonl");
    const memory = new LongTermMemoryStore({ filepath });
    const hds = new HDSUpperController({ memory });
    hds.decide(inbound("primary support source", "projection-support"));
    hds.decide(inbound("counter evidence source", "projection-counter"));
    hds.decide(inbound("unreferenced recent source", "projection-excluded"));

    const current = hds.decide(inbound(
      "compare F:projection-support with F:projection-counter",
      "projection-current",
    ));
    if (!current.command || current.command.type !== "llm_call") throw new Error("expected llm command");
    const trace = current.log.frame.memory_trace;
    const projectionTrace = structuredClone(trace);
    const supportProjection = projectionTrace.hits.find((hit) => hit.memory_id === "projection-support")!;
    const syntheticSummary = {
      goal: "g".repeat(450),
      problem_definition_id: supportProjection.summary!.problem_definition_id,
      abstraction: supportProjection.summary!.abstraction,
    };
    supportProjection.summary = syntheticSummary;
    supportProjection.summary_projection.included_source_digest = createHash("sha256")
      .update(JSON.stringify(syntheticSummary))
      .digest("hex");
    const contextMessage = buildMemoryCitationSystemMessages(projectionTrace)[1];
    if (!contextMessage) throw new Error("expected current memory context");
    const context = JSON.parse(contextMessage.content.slice(contextMessage.content.indexOf("\n") + 1));
    expect(context.records.map((record: { record_id: string }) => record.record_id)).toEqual([
      "F:projection-support",
      "F:projection-counter",
    ]);
    expect(context.records[0].summary.goal).toHaveLength(400);
    expect(context.records[0].summary_difference).toMatchObject({
      semantic_difference: "not_assessed",
      truncations: [{
        field: "goal",
        source_char_count: 450,
        projected_char_count: 400,
        omitted_suffix_digest: createHash("sha256").update("g".repeat(51)).digest("hex"),
      }],
    });
    expect(contextMessage.content).not.toContain("g".repeat(450));

    const support = trace.hits.find((hit) => hit.memory_id === "projection-support")!;
    const counter = trace.hits.find((hit) => hit.memory_id === "projection-counter")!;
    const scopeId = trace.search_plan!.application_scope_id;
    const response = JSON.stringify({
      schema_version: "blue-tanuki.memory-citation-response.v1",
      answer: "二記録の比較案",
      citations: [],
    });
    const sizeBeforeReview = memory.size();
    hds.reviewMemoryCitations(current.command, feedback(current.command.id, response));

    const review = hds.getAudit().list().map((entry) => entry.log).find((entry) =>
      "kind" in entry && entry.kind === "memory_citation_review",
    );
    if (!review || !("projection_records" in review)) throw new Error("expected projection review audit");
    expect(review.projection_records ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reference: { record_id: "F:projection-support", version: support.entry_hash },
        disposition: "not_adopted",
      }),
      expect.objectContaining({
        reference: { record_id: "F:projection-counter", version: counter.entry_hash },
        disposition: "not_adopted",
        reason: "not_used_by_accepted_citation",
      }),
      expect.objectContaining({
        reference: expect.objectContaining({ record_id: "F:projection-excluded" }),
        disposition: "excluded_from_context",
        reason: "explicit_reference_scope",
      }),
    ]));
    expect(JSON.stringify(review)).not.toContain("unreferenced recent source");
    expect(memory.size()).toBe(sizeBeforeReview);
    expect(memory.verify()).toBe(true);
    expect(memory.findByRequestId("projection-excluded")?.f_reference).toBe("F:projection-excluded");

    const reloaded = new LongTermMemoryStore({ filepath });
    expect(reloaded.size()).toBe(sizeBeforeReview);
    expect(reloaded.findByRequestId("projection-excluded")?.entry_hash).toBe(
      memory.findByRequestId("projection-excluded")?.entry_hash,
    );
    expect(reloaded.verify()).toBe(true);
    expect(readFileSync(filepath, "utf8").split("\n").filter(Boolean)).toHaveLength(sizeBeforeReview);
  });
});
