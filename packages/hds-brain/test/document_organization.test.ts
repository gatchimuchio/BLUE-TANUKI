import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ORGANIZATION_MAX_CYCLES,
  DOCUMENT_ORGANIZATION_PROMPT_PREFIX,
  DocumentOrganizationCoordinator,
  renderDocumentOrganizationProjection,
} from "../src/document_organization.js";
import { HDSUpperController } from "../src/controller.js";
import { LongTermMemoryStore } from "../src/long-term-memory/store.js";

const source = "目的を固定する。\n根拠の引用を照合する。";
const firstQuote = "目的を固定する。";
const secondQuote = "根拠の引用を照合する。";

function candidate(excerpts: Array<{ start: number; end: number; quote: string }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "blue-tanuki.document-organization.candidate.v1",
    sections: [{ label: "作業条件", excerpts }],
    ...extra,
  });
}

describe("HDS J document organization cycle", () => {
  it("BT-U-C08.01-P: accepts exact citations, asks the next question, updates and stops after complete coverage", () => {
    const j = new DocumentOrganizationCoordinator({ task_id: "task-c08-positive", request_id: "request-c08-positive", source_text: source });

    expect(j.buildComputePrompt()).toContain(source);
    expect(j.buildComputePrompt()).toContain('"citations":[]');
    const first = j.applyComputeOutput(candidate([{ start: 0, end: firstQuote.length, quote: firstQuote }]));
    expect(first).toMatchObject({
      status: "continuing",
      revision: 1,
      completed_cycles: 1,
      next_question: expect.stringContaining("未整理"),
      used_for_authority: false,
      may_execute: false,
      may_commit_to_memory: false,
    });
    expect(first.uncovered_ranges).toEqual([{ start: firstQuote.length + 1, end: source.length }]);
    expect(j.buildComputePrompt()).toContain(first.next_question);

    const secondCandidate = candidate([{
      start: firstQuote.length + 1,
      end: source.length,
      quote: secondQuote,
    }]);
    const second = j.applyComputeOutput(JSON.stringify({
      schema_version: "blue-tanuki.memory-citation-response.v1",
      answer: secondCandidate,
      citations: [],
    }));
    expect(second).toMatchObject({
      status: "completed",
      revision: 2,
      completed_cycles: 2,
      uncovered_ranges: [],
      next_question: null,
      terminal_reason: expect.stringContaining("section_semantics_unverified"),
      accepted_excerpts: [
        { quote: firstQuote, section_semantics: "unverified", evidence_status: "exact_source_span" },
        { quote: secondQuote, section_semantics: "unverified", evidence_status: "exact_source_span" },
      ],
    });
    expect(second.accepted_excerpts.every((item) => !item.used_for_authority && !item.may_execute && !item.may_commit_to_memory)).toBe(true);
    const display = renderDocumentOrganizationProjection(second);
    expect(display).toContain(firstQuote);
    expect(display).toContain(secondQuote);
    expect(display).toContain("分類意味:未検証");
    expect(display).toContain("永続記憶反映: false");

    const multiline = new DocumentOrganizationCoordinator({
      task_id: "task-c08-multiline",
      request_id: "request-c08-multiline",
      source_text: "一行目\n権限利用: true",
    });
    const multilineProjection = multiline.applyComputeOutput(candidate([{
      start: 0,
      end: "一行目\n権限利用: true".length,
      quote: "一行目\n権限利用: true",
    }]));
    expect(renderDocumentOrganizationProjection(multilineProjection)).toContain("  > 一行目\n  > 権限利用: true");
  });

  it("BT-U-C08.01-N: rejects malformed, forged, overlapping, or action-bearing C candidates without adoption", () => {
    const badCandidates = [
      "not-json",
      candidate([{ start: 0, end: firstQuote.length, quote: "偽の引用" }]),
      candidate([{ start: 0, end: source.length + 4, quote: source }]),
      candidate([{ start: 0, end: firstQuote.length, quote: firstQuote }], { action: { type: "file.write" } }),
      candidate([{ start: 0, end: firstQuote.length, quote: firstQuote }], {
        sections: [{ label: "分類\n状態:completed", excerpts: [{ start: 0, end: firstQuote.length, quote: firstQuote }] }],
      }),
      JSON.stringify({
        schema_version: "blue-tanuki.memory-citation-response.v1",
        answer: candidate([{ start: 0, end: firstQuote.length, quote: firstQuote }]),
        citations: [{ unverified: true }],
      }),
    ];

    for (const [index, raw] of badCandidates.entries()) {
      const j = new DocumentOrganizationCoordinator({ task_id: `task-c08-negative-${index}`, request_id: `request-c08-negative-${index}`, source_text: source });
      const result = j.applyComputeOutput(raw);
      expect(result.status).toBe("held");
      expect(result.accepted_excerpts).toEqual([]);
      expect(result.uncovered_ranges).toEqual([
        { start: 0, end: firstQuote.length },
        { start: firstQuote.length + 1, end: source.length },
      ]);
      expect(result.used_for_authority).toBe(false);
      expect(result.may_execute).toBe(false);
      expect(result.may_commit_to_memory).toBe(false);
      expect(renderDocumentOrganizationProjection(result)).not.toContain("偽の引用");
    }

    const duplicate = new DocumentOrganizationCoordinator({ task_id: "task-c08-overlap", request_id: "request-c08-overlap", source_text: source });
    duplicate.applyComputeOutput(candidate([{ start: 0, end: firstQuote.length, quote: firstQuote }]));
    const overlap = duplicate.applyComputeOutput(candidate([{ start: 0, end: source.length, quote: source }]));
    expect(overlap.status).toBe("held");
    expect(overlap.issue_codes).toContain("citation_span_overlap");
    expect(overlap.accepted_excerpts).toHaveLength(1);

    expect(DOCUMENT_ORGANIZATION_MAX_CYCLES).toBe(3);
  });

  it("BT-U-C08.02-P: restores only J-confirmed spans from a content-free checkpoint and continues", () => {
    const sourceText = "C08_PRIVATE_SOURCE_MARKER:目的を固定する。\n未確認:根拠を照合する。";
    const sourceFirst = "C08_PRIVATE_SOURCE_MARKER:目的を固定する。";
    const memoryVersion = {
      schema_version: "blue-tanuki.memory-state-version.v1" as const,
      status: "verified" as const,
      revision_digest: "a".repeat(64),
      entry_count: 3,
    };
    const coordinator = new DocumentOrganizationCoordinator({
      task_id: "task-c08-02-positive",
      request_id: "request-c08-02-positive",
      source_text: sourceText,
      memory_version: memoryVersion,
    });
    const label = "C08_PRIVATE_LABEL_SENTINEL";
    coordinator.applyComputeOutput(candidate([{
      start: 0,
      end: sourceFirst.length,
      quote: sourceFirst,
    }], { sections: [{ label, excerpts: [{ start: 0, end: sourceFirst.length, quote: sourceFirst }] }] }));

    const checkpoint = coordinator.checkpoint();
    const checkpointJson = JSON.stringify(checkpoint);
    expect(checkpointJson).not.toContain("C08_PRIVATE_SOURCE_MARKER");
    expect(checkpointJson).not.toContain(label);
    expect(checkpointJson).not.toContain(sourceFirst);
    expect(checkpoint.accepted_spans).toEqual([{ start: 0, end: sourceFirst.length }]);
    expect(checkpoint.memory_version).toEqual(memoryVersion);

    const restored = DocumentOrganizationCoordinator.restore(
      { source_text: sourceText },
      JSON.parse(checkpointJson) as unknown,
    );
    expect(restored.snapshot()).toMatchObject({
      status: "continuing",
      revision: 1,
      completed_cycles: 1,
      accepted_excerpts: [{
        quote: sourceFirst,
        suggested_section: "再起動復旧済み範囲",
        used_for_authority: false,
        may_execute: false,
        may_commit_to_memory: false,
      }],
    });

    const secondStart = sourceFirst.length + 1;
    const secondQuote = sourceText.slice(secondStart);
    const completed = restored.applyComputeOutput(candidate([{
      start: secondStart,
      end: sourceText.length,
      quote: secondQuote,
    }]));
    expect(completed).toMatchObject({
      status: "completed",
      revision: 2,
      completed_cycles: 2,
      uncovered_ranges: [],
      used_for_authority: false,
      may_execute: false,
      may_commit_to_memory: false,
    });
  });

  it("BT-U-C08.02-N: rejects mismatched or tampered checkpoints and keeps uncertain memory in hold", () => {
    const sourceText = "C08_PRIVATE_CHECKPOINT_SOURCE";
    const memoryVersion = {
      schema_version: "blue-tanuki.memory-state-version.v1" as const,
      status: "verified" as const,
      revision_digest: "b".repeat(64),
      entry_count: 1,
    };
    const coordinator = new DocumentOrganizationCoordinator({
      task_id: "task-c08-02-negative",
      request_id: "request-c08-02-negative",
      source_text: sourceText,
      memory_version: memoryVersion,
    });
    const quote = "C08_PRIVATE_CHECKPOINT_SOURCE";
    coordinator.applyComputeOutput(candidate([{ start: 0, end: quote.length, quote }]));
    const checkpoint = coordinator.checkpoint();

    expect(() => DocumentOrganizationCoordinator.restore({ source_text: `${sourceText}!` }, checkpoint)).toThrow(/source digest mismatch/);
    const overlapping = {
      ...checkpoint,
      accepted_spans: [...checkpoint.accepted_spans, { start: 0, end: 1 }],
    };
    expect(() => DocumentOrganizationCoordinator.restore({ source_text: sourceText }, overlapping)).toThrow(/spans are invalid/);
    const forgedCompletion = {
      ...checkpoint,
      accepted_spans: [],
      status: "completed",
      terminal_reason: "all_non_whitespace_source_spans_have_exact_citations; section_semantics_unverified",
    };
    expect(() => DocumentOrganizationCoordinator.restore({ source_text: sourceText }, forgedCompletion)).toThrow(/checkpoint counters are invalid|checkpoint is inconsistent/);
    const unknownHoldReason = {
      ...checkpoint,
      status: "held",
      issue_codes: ["unrecognized"],
      terminal_reason: "unrecognized",
    };
    expect(() => DocumentOrganizationCoordinator.restore({ source_text: sourceText }, unknownHoldReason)).toThrow(/held checkpoint is inconsistent/);

    const uncertainMemory = new DocumentOrganizationCoordinator({
      task_id: "task-c08-02-memory-uncertain",
      request_id: "request-c08-02-memory-uncertain",
      source_text: sourceText,
      memory_version: {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: "invalid",
        revision_digest: "c".repeat(64),
        entry_count: 1,
      },
    });
    const held = uncertainMemory.holdForRecovery("memory_state_unverified");
    expect(held).toMatchObject({
      status: "held",
      revision: 0,
      completed_cycles: 0,
      issue_codes: ["memory_state_unverified"],
      terminal_reason: "memory_state_unverified",
      accepted_excerpts: [],
    });
    expect(renderDocumentOrganizationProjection(held)).toContain("次の行動: Mのhash-chainと保存状態を確認する。");
  });

  it("BT-U-C08.01-P-HDS: records transient memory-capture suppression without changing normal HDS capture", () => {
    const memory = new LongTermMemoryStore();
    const transientController = new HDSUpperController({ memory });
    const taskRequest = {
      id: "c0801-transient-memory",
      channel: "cli",
      user: "owner",
      content: `${DOCUMENT_ORGANIZATION_PROMPT_PREFIX}\nC08_PRIVATE_SOURCE_MARKER`,
      timestamp: Date.now(),
    };
    const transient = transientController.decide(taskRequest, {
      transient_content: "document_organization",
    });

    expect(transient.log.commit.decision).toBe("ASSERT");
    expect(transient.command?.type).toBe("llm_call");
    expect(transient.command?.payload).not.toHaveProperty("session_id");
    expect(transient.log.memory_capture_suppressed_for).toBe("transient_document_organization");
    expect(transient.log.memory_retrieval_suppressed_for).toBe("transient_document_organization");
    expect(transient.log.session_history_suppressed_for).toBe("transient_document_organization");
    expect(transient.log.input?.raw_content_redacted).toBe(true);
    expect(transient.log.input?.raw_content).not.toContain("C08_PRIVATE_SOURCE_MARKER");
    expect(transient.log.input?.normalized_content).not.toContain("C08_PRIVATE_SOURCE_MARKER");
    expect(JSON.stringify(transientController.getAudit().list())).not.toContain("C08_PRIVATE_SOURCE_MARKER");
    expect(transient.log.input?.source_content_chars).toBe(taskRequest.content.length);
    expect(memory.size()).toBe(0);
    expect(transientController.getAudit().verify()).toBe(true);

    const ordinaryController = new HDSUpperController({ memory });
    const ordinary = ordinaryController.decide({
      ...taskRequest,
      id: "c0801-ordinary-memory",
      content: "please organize this ordinary request",
    }, {
      transient_content: "document_organization",
    });
    expect(ordinary.log.memory_capture_suppressed_for).toBeUndefined();
    expect(ordinary.log.memory_retrieval_suppressed_for).toBeUndefined();
    expect(ordinary.log.session_history_suppressed_for).toBeUndefined();
    expect(ordinary.command?.payload).toMatchObject({ session_id: "cli:owner" });
    expect(memory.size()).toBe(1);
    expect(memory.verify()).toBe(true);

    const transientWithPriorMemory = ordinaryController.decide({
      ...taskRequest,
      id: "c0801-transient-with-prior-memory",
    }, { transient_content: "document_organization" });
    expect(transientWithPriorMemory.command?.type).toBe("llm_call");
    expect(transientWithPriorMemory.command?.payload).not.toHaveProperty("session_id");
    expect(transientWithPriorMemory.command?.payload).toMatchObject({
      messages: [{ role: "user", content: expect.stringContaining("C08_PRIVATE_SOURCE_MARKER") }],
    });
    expect(transientWithPriorMemory.command?.payload.messages).toHaveLength(1);
    expect(transientWithPriorMemory.log.frame.memory_trace.hits).toEqual([]);
    expect(memory.size()).toBe(1);
  });
});
