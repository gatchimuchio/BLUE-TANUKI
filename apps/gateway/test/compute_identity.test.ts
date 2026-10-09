import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import { HDSUpperController, LongTermMemoryStore } from "@blue-tanuki/hds-brain";
import {
  Executor,
  LLMComputeAdapter,
  LLMRegistry,
  ToolRegistry,
  createExecutorApprovalAuthority,
} from "@blue-tanuki/core";
import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "@blue-tanuki/core";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";

class FixtureProvider implements LLMBackend {
  readonly name = "fixture-provider";
  readonly requests: LLMRequest[] = [];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return { content: "A local fixture response.", tokens_used: 3, model: "fixture-model-v1" };
  }
}

class ToolCandidateProvider implements LLMBackend {
  readonly name = "fixture-provider";
  readonly requests: LLMRequest[] = [];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      content: "",
      tokens_used: 2,
      model: "fixture-model-v1",
      tool_calls: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-gateway-1",
        tool_name: "shell.exec",
        arguments: { command: "gateway-tool-argument-private-sentinel" },
        authority_boundary: {
          candidate_only: true,
          may_execute: false,
          used_for_authority: false,
        },
      }],
    };
  }
}

function inbound(content: string, id: string): InboundRequest {
  return { id, channel: "test", user: "owner", content, timestamp: 1 };
}

describe("HDS to Gateway compute identity", () => {
  it("carries current projection identity through Executor and audit digest", async () => {
    const provider = new FixtureProvider();
    const registry = new LLMRegistry().register(provider);
    const hds = new HDSUpperController();
    const { log, command } = hds.decide(inbound("summarize a harmless topic", "compute-path-1"));

    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("llm_call");
    if (!command || command.type !== "llm_call") throw new Error("expected HDS llm_call");
    expect(command.payload.compute_context).toMatchObject({
      schema_version: "blue-tanuki.compute-context.v1",
      local_p_version: "blue-tanuki.c-input-rules.v1",
      data_exposure: {
        input_sources: ["accepted_inbound_request"],
        requested_egress_provider: "registry-default",
      },
    });
    expect(command.payload.compute_context?.projection_digest).toMatch(/^[a-f0-9]{64}$/);

    const authority = createExecutorApprovalAuthority();
    const executor = new Executor({
      approval_authority: authority,
      llm: registry,
      compute: new LLMComputeAdapter(registry),
      tools: new ToolRegistry(),
    });
    const approved = authority.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: "fixture-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: "llm.call",
      risk: "low",
      final_review_required: false,
      reason: "fixture integration test",
    });
    const feedback = await executor.execute(approved);

    expect(feedback.status).toBe("success");
    expect(feedback.result).toMatchObject({
      execution_identity: {
        request_id: command.id,
        current_projection_digest: command.payload.compute_context?.projection_digest,
        output_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        local_p_version: "blue-tanuki.c-input-rules.v1",
        provider: { requested: "registry-default", actual: "fixture-provider" },
        model: { requested: null, actual: "fixture-model-v1" },
      },
      cost: { status: "unknown" },
      authority_boundary: { used_for_authority: false },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).not.toHaveProperty("compute_context");

    hds.onFeedback(feedback);
    const audit = hds.getAudit().list().find((entry) =>
      entry.log.kind === "executor_feedback" && entry.log.command_id === command.id,
    );
    expect(audit?.log).toMatchObject({ kind: "executor_feedback", feedback: { result_present: true } });
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("falls back only under the HDS provider, capability, data-scope, and cost grant", async () => {
    class PrimaryProvider implements LLMBackend {
      readonly name = "primary";
      readonly requests: LLMRequest[] = [];
      async call(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        throw new LLMProviderError("primary unavailable", {
          provider: this.name,
          kind: "remote_service_unavailable",
          retryable: true,
          status: 503,
        });
      }
    }
    class BackupProvider implements LLMBackend {
      readonly name = "backup";
      readonly requests: LLMRequest[] = [];
      async call(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        return { content: "A permitted fixture response.", tokens_used: 2, model: "backup-model-v1" };
      }
    }

    const primary = new PrimaryProvider();
    const backup = new BackupProvider();
    const registry = new LLMRegistry({ retry: { max_attempts: 1 } })
      .register(primary)
      .register(backup)
      .setDefault("primary")
      .setFallback("backup")
      .setFallbackProfile("primary", {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.2, currency: "USD" },
      })
      .setFallbackProfile("backup", {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.1, currency: "USD" },
      });
    const hds = new HDSUpperController({
      llm_route: {
        backend_hint: "primary",
        fallback_authorization: {
          allowed_providers: ["backup"],
          allowed_input_sources: ["accepted_inbound_request"],
          required_capabilities: ["llm.text.generate"],
          max_total_cost: { amount: 0.3, currency: "USD" },
        },
      },
    });
    const { log, command } = hds.decide(inbound("bounded compute request", "compute-fallback-1"));
    if (!command || command.type !== "llm_call") throw new Error("expected HDS llm_call");

    const authority = createExecutorApprovalAuthority();
    const executor = new Executor({
      approval_authority: authority,
      llm: registry,
      compute: new LLMComputeAdapter(registry),
      tools: new ToolRegistry(),
    });
    const approved = authority.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: "fixture-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: "llm.call",
      risk: "low",
      final_review_required: false,
      reason: "fallback permission fixture",
    });
    const feedback = await executor.execute(approved);

    expect(feedback.status).toBe("success");
    expect(feedback.result).toMatchObject({
      execution_identity: {
        request_id: command.id,
        provider: {
          requested: "primary",
          actual: "backup",
          fallback: {
            used: true,
            from_provider: "primary",
            failure_kind: "remote_service_unavailable",
            allowed_input_sources: ["accepted_inbound_request"],
            max_total_cost: { amount: 0.3, currency: "USD" },
            estimated_total_cost: { amount: 0.3, currency: "USD", source: "CONFIG" },
          },
        },
        data_exposure_scope: {
          input_sources: ["accepted_inbound_request"],
          requested_egress_provider: "primary",
        },
      },
      cost: { status: "estimated", amount: 0.3, currency: "USD" },
      authority_boundary: { used_for_authority: false },
    });
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests).toHaveLength(1);
    expect(backup.requests[0]?.messages).toEqual(primary.requests[0]?.messages);

    const finalized = finalizeCommandOutput({
      hds,
      command,
      feedback,
      target_surface: "channel",
      request_id: log.request_id,
    });
    expect(finalized.reviewed_feedback.result).toMatchObject({
      execution_identity: {
        provider: { actual: "backup", fallback: { used: true, from_provider: "primary" } },
      },
    });
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("changes projection identity when the accepted current request changes", () => {
    const first = new HDSUpperController().decide(inbound("first benign request", "compute-path-same-id"));
    const second = new HDSUpperController().decide(inbound("different benign request", "compute-path-same-id"));
    expect(first.command?.type).toBe("llm_call");
    expect(second.command?.type).toBe("llm_call");
    if (first.command?.type !== "llm_call" || second.command?.type !== "llm_call") return;
    expect(first.command.payload.compute_context?.projection_digest).not.toBe(
      second.command.payload.compute_context?.projection_digest,
    );
  });

  it("marks selected memory references in the HDS exposure scope", () => {
    const memory = new LongTermMemoryStore();
    const hds = new HDSUpperController({ memory });
    hds.decide(inbound("remember a bounded fixture candidate", "compute-memory-seed"));
    const { command } = hds.decide({
      ...inbound("continue from the saved item", "compute-memory-read"),
      metadata: { reference_request_id: "F:compute-memory-seed" },
    });

    expect(command?.type).toBe("llm_call");
    if (command?.type !== "llm_call") return;
    expect(command.payload.messages.some((message) => message.role === "system")).toBe(true);
    expect(command.payload.compute_context?.data_exposure.input_sources).toEqual([
      "accepted_inbound_request",
      "selected_memory_references",
    ]);
  });

  it("returns candidates through the normal Gateway/HDS feedback path as non-authority data", async () => {
    const provider = new ToolCandidateProvider();
    const registry = new LLMRegistry().register(provider);
    const hds = new HDSUpperController();
    const { log, command } = hds.decide(inbound("request a candidate", "compute-tool-candidate"));
    if (!command || command.type !== "llm_call") throw new Error("expected HDS llm_call");

    const authority = createExecutorApprovalAuthority();
    const executor = new Executor({
      approval_authority: authority,
      llm: registry,
      compute: new LLMComputeAdapter(registry),
      tools: new ToolRegistry(),
    });
    const approved = authority.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: "fixture-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: "llm.call",
      risk: "low",
      final_review_required: false,
      reason: "fixture candidate path test",
    });
    const feedback = await executor.execute(approved);
    const finalized = finalizeCommandOutput({
      hds,
      command,
      feedback,
      target_surface: "channel",
      request_id: log.request_id,
    });

    expect(finalized.reviewed_feedback.llm_tool_candidates).toHaveLength(1);
    expect(finalized.reviewed_feedback.llm_tool_candidates?.[0]?.authority_boundary).toEqual({
      candidate_only: true,
      may_execute: false,
      used_for_authority: false,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).not.toHaveProperty("tools");
    const feedbackEntry = hds.getAudit().list().find((entry) =>
      "kind" in entry.log && entry.log.kind === "executor_feedback",
    );
    if (!feedbackEntry || !("kind" in feedbackEntry.log) || feedbackEntry.log.kind !== "executor_feedback") {
      throw new Error("expected executor feedback audit entry");
    }
    expect(feedbackEntry.log.feedback.llm_tool_candidate_count).toBe(1);
    expect(feedbackEntry.log.feedback.llm_tool_candidates_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(hds.getAudit().list())).not.toContain("gateway-tool-argument-private-sentinel");
    expect(hds.getAudit().verify()).toBe(true);
  });
});
