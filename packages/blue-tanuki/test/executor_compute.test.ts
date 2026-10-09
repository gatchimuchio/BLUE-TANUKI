import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority } from "../src/executor.js";
import type { ComputeBackend, ComputeRequest } from "../src/llm/compute.js";
import { LLMComputeAdapter } from "../src/llm/compute.js";
import type { LLMBackend, LLMRequest, LLMResponse } from "../src/llm/base.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { MemorySessionStore } from "../src/sessions/index.js";

const authority = createExecutorApprovalAuthority();
const upstream = {
  frame_goal: "fixture",
  model_abstraction: "fixture",
  commit_hash: "compute-test-commit",
  commit_decision: "ASSERT" as const,
};

function command(id: string, context = true, timeout_ms = 1_500): ExecuteCommand {
  return {
    id,
    type: "llm_call",
    payload: {
      backend_hint: "fixture-provider",
      messages: [{ role: "user", content: "current request" }],
      session_id: "test-session",
      ...(context ? {
        compute_context: {
          schema_version: "blue-tanuki.compute-context.v1",
          projection_digest: "c".repeat(64),
          local_p_version: "blue-tanuki.c-input-rules.v1",
          data_exposure: {
            input_sources: ["accepted_inbound_request" as const],
            requested_egress_provider: "fixture-provider",
          },
        },
      } : {}),
    },
    constraints: { max_tokens: 64, timeout_ms },
    upstream_decision: upstream,
  };
}

function approved(cmd: ExecuteCommand) {
  return authority.approve(cmd, {
    source: "approval_gate",
    decision: "allow",
    approved_by: "fixture-owner",
    approved_at_ms: 1,
    upstream_commit_hash: cmd.upstream_decision.commit_hash,
    operation: "llm.call",
    risk: "low",
    final_review_required: false,
    reason: "fixture test approval",
  });
}

class CapturingBackend implements LLMBackend {
  readonly name = "fixture-provider";
  readonly seen: LLMRequest[] = [];
  constructor(private readonly response: LLMResponse = {
    content: "fixture reply",
    tokens_used: 2,
    model: "fixture-model-v1",
  }) {}

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.seen.push(request);
    return this.response;
  }
}

class HangingBackend implements LLMBackend {
  readonly name = "fixture-provider";
  signal?: AbortSignal;
  private startedResolver!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolver = resolve; });

  async call(_request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    this.signal = signal;
    this.startedResolver();
    return new Promise<LLMResponse>(() => undefined);
  }
}

class CapturingCompute implements ComputeBackend<LLMRequest, LLMResponse> {
  readonly requests: ComputeRequest<LLMRequest>[] = [];
  constructor(private readonly adapter: LLMComputeAdapter) {}
  compute(request: ComputeRequest<LLMRequest>) {
    this.requests.push(request);
    return this.adapter.compute(request);
  }
}

describe("Executor compute boundary", () => {
  it("hashes effective provider input and records local resource and history scope", async () => {
    const backend = new CapturingBackend();
    const compute = new CapturingCompute(new LLMComputeAdapter(backend));
    const sessions = new MemorySessionStore();
    await sessions.append("test-session", { role: "user", content: "prior request", timestamp: 1 });
    const executor = new Executor({
      approval_authority: authority,
      llm: backend,
      compute,
      tools: new ToolRegistry(),
      session_store: sessions,
    });

    const result = await executor.execute(approved(command("compute-1")));
    const request = compute.requests[0]!;
    const expectedRequest = {
      messages: [
        { role: "user", content: "prior request" },
        { role: "user", content: "current request" },
      ],
      backend_hint: "fixture-provider",
      max_tokens: 64,
      timeout_ms: 1_500,
    };

    expect(result.status).toBe("success");
    expect(request.input_digest).toBe(
      createHash("sha256").update(JSON.stringify(expectedRequest)).digest("hex"),
    );
    expect(request.data_exposure_scope.input_sources).toEqual([
      "accepted_inbound_request",
      "session_history",
    ]);
    expect(request.resource_limits).toEqual({ max_tokens: 64, timeout_ms: 1_500 });
    expect(result.result).toMatchObject({
      execution_identity: {
        request_id: "compute-1",
        provider: { requested: "fixture-provider", actual: "fixture-provider" },
      },
      authority_boundary: {
        compute_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
      },
    });
    expect(backend.seen[0]).toEqual(expectedRequest);
  });

  it("blocks configured compute before the provider when HDS context is absent", async () => {
    const backend = new CapturingBackend();
    const compute = new CapturingCompute(new LLMComputeAdapter(backend));
    const executor = new Executor({
      approval_authority: authority,
      llm: backend,
      compute,
      tools: new ToolRegistry(),
    });

    const result = await executor.execute(approved(command("compute-no-context", false)));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("compute context is required");
    expect(compute.requests).toHaveLength(0);
    expect(backend.seen).toHaveLength(0);
  });

  it("returns native tool calls as candidates without invoking registered tools", async () => {
    const candidate = {
      schema_version: "blue-tanuki.llm-tool-call-candidate.v1" as const,
      call_id: "call-danger",
      tool_name: "shell.exec",
      arguments: { command: "echo must-not-run" },
      authority_boundary: {
        candidate_only: true as const,
        may_execute: false as const,
        used_for_authority: false as const,
      },
    };
    const backend = new CapturingBackend({
      content: "",
      tokens_used: 1,
      model: "fixture-model-v1",
      tool_calls: [candidate],
    });
    const invoke = vi.fn(async () => ({ executed: true }));
    const tools = new ToolRegistry();
    tools.register({ name: "shell.exec", description: "fixture", invoke });
    const executor = new Executor({
      approval_authority: authority,
      llm: backend,
      compute: new LLMComputeAdapter(backend),
      tools,
    });

    const result = await executor.execute(approved(command("compute-tool-candidate")));

    expect(result.status).toBe("success");
    expect(result.llm_tool_candidates).toHaveLength(1);
    expect(result.llm_tool_candidates?.[0]?.authority_boundary).toEqual({
      candidate_only: true,
      may_execute: false,
      used_for_authority: false,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("types malformed planner JSON and does not return the raw provider content", async () => {
    const rawSentinel = "provider-raw-response-sentinel";
    const backend = new CapturingBackend({
      content: `{"plan_id":"${rawSentinel}","steps":`,
      tokens_used: 4,
      model: "fixture-model-v1",
    });
    const executor = new Executor({
      approval_authority: authority,
      llm: backend,
      compute: new LLMComputeAdapter(backend),
      tools: new ToolRegistry(),
    });

    const result = await executor.execute(approved(command("compute-invalid-json")));

    expect(result.status).toBe("failed");
    expect(result.llm_failure).toMatchObject({ kind: "invalid_structured_output", retryable: false });
    expect(result.error).not.toContain(rawSentinel);
    expect(JSON.stringify(result)).not.toContain(rawSentinel);
  });

  it("aborts the provider and returns a typed caller cancellation", async () => {
    const backend = new HangingBackend();
    const executor = new Executor({
      approval_authority: authority,
      llm: backend,
      compute: new LLMComputeAdapter(backend),
      tools: new ToolRegistry(),
    });
    const controller = new AbortController();
    const pending = executor.execute(approved(command("compute-cancelled")), { signal: controller.signal });
    await backend.started;
    controller.abort();

    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.llm_failure).toMatchObject({ kind: "cancelled", retryable: false });
    expect(backend.signal?.aborted).toBe(true);
  });

  it("aborts provider work on the command deadline and returns a typed timeout", async () => {
    const backend = new HangingBackend();
    const executor = new Executor({
      approval_authority: authority,
      llm: backend,
      compute: new LLMComputeAdapter(backend),
      tools: new ToolRegistry(),
    });

    const result = await executor.execute(approved(command("compute-timeout", true, 15)));

    expect(result.status).toBe("failed");
    expect(result.llm_failure).toMatchObject({ kind: "timeout", retryable: true });
    expect(backend.signal?.aborted).toBe(true);
  });
});
