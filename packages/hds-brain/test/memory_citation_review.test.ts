import { describe, expect, it } from "vitest";
import type { ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";

function inbound(content: string, id: string): InboundRequest {
  return { id, channel: "test", user: "fixture-user", content, timestamp: Date.now() };
}

function setup() {
  const memory = new LongTermMemoryStore();
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
  const scopeId = decided.log.frame.memory_trace.search_plan?.application_scope_id;
  if (!support || !counter || !scopeId) throw new Error("expected two scoped memory candidates");
  return { hds, command: decided.command, support, counter, scopeId };
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

describe("J-side memory citation review", () => {
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
      rejected_proposal_count: 0,
      used_for_authority: false,
    });
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
});
