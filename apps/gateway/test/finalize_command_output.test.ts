import { describe, expect, it } from "vitest";
import type { ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import { HDSUpperController, LongTermMemoryStore } from "@blue-tanuki/hds-brain";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";

function inbound(content: string, id: string): InboundRequest {
  return { id, channel: "test", user: "gateway-fixture", content, timestamp: Date.now() };
}

function success(command_id: string, content: string): ExecuteFeedback {
  return {
    command_id,
    status: "success",
    result: { content, model: "fixture-model", tokens_used: 4 },
    metrics: { duration_ms: 3, tokens_used: 4, tool_calls: 0 },
  };
}

describe("finalizeCommandOutput", () => {
  it("renders only HDS-admitted citations and audits review before release", () => {
    const hds = new HDSUpperController({ memory: new LongTermMemoryStore() });
    hds.decide(inbound("first gateway record", "gateway-support"));
    hds.decide(inbound("counter gateway record", "gateway-counter"));
    const decision = hds.decide(inbound(
      "compare F:gateway-support with F:gateway-counter",
      "gateway-current",
    ));
    if (!decision.command || decision.command.type !== "llm_call") throw new Error("expected llm_call");
    const support = decision.log.frame.memory_trace.hits.find((hit) => hit.memory_id === "gateway-support")!;
    const counter = decision.log.frame.memory_trace.hits.find((hit) => hit.memory_id === "gateway-counter")!;
    const scopeId = decision.log.frame.memory_trace.search_plan!.application_scope_id;
    const raw = JSON.stringify({
      schema_version: "blue-tanuki.memory-citation-response.v1",
      answer: "回答にF:gateway-supportとF:forgedを含めないでください。",
      citations: [{
        claim: "二つの記録を対照する案",
        supporting: { record_id: support.f_reference, version: support.entry_hash },
        counterevidence: { record_id: counter.f_reference, version: counter.entry_hash },
        application_scope_id: scopeId,
      }],
    });
    const original = success(decision.command.id, raw);

    const finalized = finalizeCommandOutput({
      hds,
      command: decision.command,
      feedback: original,
      target_surface: "channel",
      request_id: decision.log.request_id,
    });

    expect(finalized.rendered_output).toContain(`record=F:gateway-support; version=${support.entry_hash}`);
    expect(finalized.rendered_output).toContain(`record=F:gateway-counter; version=${counter.entry_hash}`);
    expect(finalized.rendered_output).not.toContain("F:forged");
    expect((finalized.reviewed_feedback.result as { content: string }).content).not.toContain("F:forged");
    expect((original.result as { content: string }).content).toBe(raw);
    expect(finalized.output_audit).toMatchObject({
      command_id: decision.command.id,
      request_id: decision.log.request_id,
      target_surface: "channel",
      user_visible_output: true,
      used_for_authority: false,
    });
    expect(finalized.output_audit.rendered_output_digest).toBeTruthy();

    const entries = hds.getAudit().list();
    const reviewIndex = entries.findIndex((entry) => "kind" in entry.log && entry.log.kind === "memory_citation_review");
    const feedbackIndex = entries.findIndex((entry) => "kind" in entry.log && entry.log.kind === "executor_feedback");
    const outputIndex = entries.findIndex((entry) => "kind" in entry.log && entry.log.kind === "output_audit");
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(reviewIndex).toBeLessThan(feedbackIndex);
    expect(feedbackIndex).toBeLessThan(outputIndex);
    expect(hds.getAudit().verify()).toBe(true);
  });
});
