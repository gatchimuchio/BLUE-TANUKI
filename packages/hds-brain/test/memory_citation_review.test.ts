import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";
import { buildMemoryCitationSystemMessages } from "../src/memory_citation_review.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
