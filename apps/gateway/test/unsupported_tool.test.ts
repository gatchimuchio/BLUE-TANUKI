import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import { HDSUpperController } from "@blue-tanuki/hds-brain";
import {
  Executor,
  createExecutorApprovalAuthority,
  ToolRegistry,
  type LLMBackend,
  type LLMRequest,
  type LLMResponse,
} from "@blue-tanuki/core";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";

function inbound(content: string): InboundRequest {
  return { id: "unsupported-tool-e2e", channel: "test", user: "owner", content, timestamp: 1 };
}

describe("BT-U-D01.01-P unsupported tool J feedback", () => {
  it("returns an unsupported operation failure through route, Executor, and normal output audit", async () => {
    let providerCalls = 0;
    const llm: LLMBackend = {
      name: "must-not-run",
      async call(_request: LLMRequest): Promise<LLMResponse> {
        providerCalls += 1;
        return { content: "unexpected provider call", tokens_used: 1, model: "fixture" };
      },
    };
    const hds = new HDSUpperController();
    const decision = hds.decide(inbound("tool:payment.charge amount=100"));
    if (!decision.command || decision.command.type !== "noop") {
      throw new Error("unknown explicit tool must be rejected by HDS action routing");
    }

    const authority = createExecutorApprovalAuthority();
    const approved = authority.approve(decision.command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: "synthetic-owner",
      approved_at_ms: 1,
      upstream_commit_hash: decision.command.upstream_decision.commit_hash,
      operation: "noop",
      risk: "low",
      final_review_required: false,
      reason: "non-executing route result",
    });
    const executor = new Executor({ approval_authority: authority, llm, tools: new ToolRegistry() });
    const feedback = await executor.execute(approved);
    const finalized = finalizeCommandOutput({
      hds,
      command: decision.command,
      feedback,
      target_surface: "cli",
      request_id: "unsupported-tool-e2e",
    });

    expect(feedback.status).toBe("failed");
    expect(finalized.rendered_output).toBe("[failed:noop] unsupported tool; no tool was executed");
    expect(finalized.output_audit.output_kind).toBe("noop_result");
    expect(hds.getAudit().verify()).toBe(true);
    expect(providerCalls).toBe(0);
  });
});
