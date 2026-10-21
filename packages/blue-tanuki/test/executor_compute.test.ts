import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompleteHistoryStore } from "@blue-tanuki/hds-brain";
import type { ComputeResourceUse, ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority } from "../src/executor.js";
import type { AgentWorkerLifecycleEvent } from "../src/executor.js";
import type { ComputeBackend, ComputeBudgetPort, ComputeRequest, ComputeResult } from "../src/llm/compute.js";
import { LLMComputeAdapter, LLMComputeResourceFailure } from "../src/llm/compute.js";
import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "../src/llm/base.js";
import { LLMRegistry } from "../src/llm/registry.js";
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

function resourceUse(commandId: string): ComputeResourceUse {
  return {
    schema_version: "blue-tanuki.compute-resource-use.v1",
    request_digest: createHash("sha256").update("blue-tanuki.compute-resource-use.request.v1\0").update(commandId).digest("hex"),
    charged_compute_ms: 3,
    charged_tokens: 64,
    tokens_usage_status: "provider_reported",
    cost_status: "estimated",
    charged_cost_amount: 0.1,
    currency: "USD",
    charge_basis: "configured_estimate",
    used_for_authority: false,
    may_execute: false,
  };
}

function agentDelegationCommand(id: string, timeoutMs = 5_000): ExecuteCommand {
  const value = command(id, true, timeoutMs);
  if (value.type !== "llm_call" || !value.payload.compute_context) throw new Error("fixture command was not a contextual LLM call");
  const taskDigest = "c".repeat(64);
  const budgetDigest = "b".repeat(64);
  delete value.payload.session_id;
  value.payload.compute_context = {
    ...value.payload.compute_context,
    local_p_version: "blue-tanuki.plan-compute-agent-delegation.v1",
    budget_scope: { parent_task_identity_digest: budgetDigest, task_identity_digest: taskDigest },
  };
  value.payload.agent_delegation = {
    schema_version: "blue-tanuki.agent-delegation.v1",
    parent_goal_digest: "a".repeat(64),
    parent_task_identity_digest: taskDigest,
    parent_budget_identity_digest: budgetDigest,
    criteria_digest: "d".repeat(64),
    termination_digest: "e".repeat(64),
    roles: ["division", "independent_comparison", "audit", "redundancy"],
    max_child_tasks: 4,
    max_delegation_depth: 1,
    parent_resource_limits: { timeout_ms: 1_000 },
    child_resource_limits: { max_tokens: 16, timeout_ms: 1_000 },
    capabilities: ["llm_compute_candidate"],
    may_delegate: false,
    may_execute: false,
    used_for_authority: false,
  };
  return value;
}

function computeResult(request: ComputeRequest<LLMRequest>, content: string): ComputeResult<LLMResponse> {
  const outputDigest = createHash("sha256").update(content).digest("hex");
  return {
    content,
    provider: "fixture-provider",
    model: "fixture-model-v1",
    execution_identity: {
      request_id: request.request_id,
      current_projection_digest: request.current_projection_digest,
      input_digest: request.input_digest,
      output_digest: outputDigest,
      c_profile: { ...request.c_profile },
      local_p_version: request.local_p_version,
      provider: { requested: request.data_exposure_scope.requested_egress_provider,
        actual: "fixture-provider", fallback: { used: false } },
      model: { requested: request.input.model ?? null, actual: "fixture-model-v1" },
      data_exposure_scope: { input_sources: [...request.data_exposure_scope.input_sources],
        requested_egress_provider: request.data_exposure_scope.requested_egress_provider },
      resource_limits: { max_tokens: request.resource_limits.max_tokens ?? null,
        timeout_ms: request.resource_limits.timeout_ms ?? null },
    },
    cost: { status: "unknown", reason: "fixture" },
    compute_resource_use: resourceUse(request.request_id),
    authority_boundary: {
      compute_output_used_for_authority: false,
      provider_metadata_used_for_authority: false,
      used_for_authority: false,
    },
  };
}

function appendAgentWorkerLifecycle(history: CompleteHistoryStore, event: AgentWorkerLifecycleEvent): boolean {
  return history.append({
    kind: "audit_history",
    command_id: event.parent_command_id,
    actor: "executor",
    source: "executor_agent_worker",
    timestamp: event.observed_at_ms,
    payload: {
      schema_version: event.schema_version,
      parent_command_digest: event.parent_command_digest,
      child_task_digest: event.child_task_digest,
      role: event.role,
      state: event.state,
      observed_at_ms: event.observed_at_ms,
      ...(event.output_observed ? { output_observed: true } : {}),
      ...(event.output_characters !== undefined ? { output_characters: event.output_characters } : {}),
      ...(event.resource_use_digest ? { resource_use_digest: event.resource_use_digest } : {}),
      used_for_authority: false,
      may_execute: false,
    },
  }) !== null;
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
  constructor(private readonly adapter: LLMComputeAdapter, private readonly receipt?: ComputeResourceUse) {}
  async compute(request: ComputeRequest<LLMRequest>, signal?: AbortSignal) {
    this.requests.push(request);
    const result = await this.adapter.compute(request, signal);
    return this.receipt ? { ...result, compute_resource_use: this.receipt } : result;
  }
}

describe("Executor compute boundary", () => {
  it("hashes effective provider input and records local resource and history scope", async () => {
    const backend = new CapturingBackend();
    const receipt = resourceUse("compute-1");
    const compute = new CapturingCompute(new LLMComputeAdapter(backend), receipt);
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
    expect(result.compute_resource_use).toEqual(receipt);
    expect(result.result).not.toHaveProperty("compute_resource_use");
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

  it("runs fixed C child roles inside the parent budget and returns them only as candidates", async () => {
    const backend = new CapturingBackend({ content: "role candidate", tokens_used: 2, model: "fixture-model-v1" });
    const registry = new LLMRegistry({ retry: { max_attempts: 1 } }).register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.1, currency: "USD" },
    }).setDefault("fixture-provider");
    const reservations: Array<Parameters<ComputeBudgetPort["reserve"]>[0]> = [];
    const budget: ComputeBudgetPort = {
      reserve(input) {
        reservations.push(structuredClone(input));
        return { reservation_id: createHash("sha256").update(input.request_id).digest("hex"),
          reserved_tokens: input.reserved_tokens, reserved_compute_ms: input.reserved_compute_ms,
          reserved_cost: input.reserved_cost };
      },
      settle() {},
    };
    const compute = new LLMComputeAdapter(registry, budget);
    const lifecycle: AgentWorkerLifecycleEvent[] = [];
    const executor = new Executor({ approval_authority: authority, llm: backend,
      compute, tools: new ToolRegistry(), on_agent_worker_lifecycle: (event) => { lifecycle.push(event); return true; } });
    const taskDigest = "c".repeat(64);
    const budgetDigest = "b".repeat(64);
    const planCommand = command("agent-parent-task", true, 5_000);
    if (planCommand.type !== "llm_call") throw new Error("fixture command was not an LLM call");
    delete planCommand.payload.session_id;
    planCommand.payload.compute_context = {
      ...planCommand.payload.compute_context!,
      local_p_version: "blue-tanuki.plan-compute-agent-delegation.v1",
      budget_scope: { parent_task_identity_digest: budgetDigest, task_identity_digest: taskDigest },
    };
    planCommand.payload.agent_delegation = {
      schema_version: "blue-tanuki.agent-delegation.v1",
      parent_goal_digest: "a".repeat(64),
      parent_task_identity_digest: taskDigest,
      parent_budget_identity_digest: budgetDigest,
      criteria_digest: "d".repeat(64),
      termination_digest: "e".repeat(64),
      roles: ["division", "independent_comparison", "audit", "redundancy"],
      max_child_tasks: 4,
      max_delegation_depth: 1,
      parent_resource_limits: { timeout_ms: 1_000 },
      child_resource_limits: { max_tokens: 16, timeout_ms: 1_000 },
      capabilities: ["llm_compute_candidate"],
      may_delegate: false,
      may_execute: false,
      used_for_authority: false,
    };

    const unbudgetedBackend = new CapturingBackend();
    const unbudgetedExecutor = new Executor({ approval_authority: authority, llm: unbudgetedBackend,
      compute: new LLMComputeAdapter(unbudgetedBackend), tools: new ToolRegistry() });
    const unbudgetedResult = await unbudgetedExecutor.execute(approved(structuredClone(planCommand)));
    expect(unbudgetedResult.status).toBe("failed");
    expect(unbudgetedBackend.seen).toHaveLength(0);

    const result = await executor.execute(approved(planCommand));

    expect(result.status).toBe("success");
    expect(reservations).toHaveLength(5);
    const childReservations = reservations.slice(0, 4);
    expect(childReservations.every((reservation) =>
      reservation.scope.parent_task_identity_digest === budgetDigest &&
      reservation.scope.task_identity_digest !== taskDigest &&
      reservation.reserved_tokens === 16 && reservation.reserved_compute_ms === 1_000)).toBe(true);
    expect(new Set(childReservations.map((reservation) => reservation.scope.task_identity_digest)).size).toBe(4);
    expect(reservations[4]?.scope).toEqual({ parent_task_identity_digest: budgetDigest, task_identity_digest: taskDigest });
    expect(backend.seen).toHaveLength(5);
    expect(backend.seen.slice(0, 4).flatMap((request) => request.messages.map((message) => message.content))
      .join("\n")).toContain("C child role=");
    expect(backend.seen[4]?.messages.at(-1)?.content).toContain("blue-tanuki.agent-candidate-set.v1");
    expect(backend.seen[4]?.messages.at(-1)?.content).toContain("role candidate");
    expect(JSON.stringify(result.result)).not.toContain("agent-candidate-set");
    expect(lifecycle.filter((event) => event.state === "started")).toHaveLength(4);
    expect(lifecycle.filter((event) => event.state === "settled")).toHaveLength(4);
    expect(lifecycle.every((event) => event.used_for_authority === false && event.may_execute === false)).toBe(true);
  });

  it("cancels child computes, discards late results, and records a residual worker without starting later children", async () => {
    let releaseChildren!: () => void;
    const childRelease = new Promise<void>((resolve) => { releaseChildren = resolve; });
    const requests: ComputeRequest<LLMRequest>[] = [];
    const signals: AbortSignal[] = [];
    const lifecycle: AgentWorkerLifecycleEvent[] = [];
    const history = new CompleteHistoryStore();
    let parentComputeCalls = 0;
    const compute: ComputeBackend<LLMRequest, LLMResponse> = {
      budget_reservations_enabled: true,
      async compute(request, signal) {
        requests.push(request);
        if (request.request_id.includes(":agent:")) {
          if (signal) signals.push(signal);
          await childRelease;
          return computeResult(request, "late private child candidate");
        }
        parentComputeCalls += 1;
        return computeResult(request, "parent result");
      },
    };
    const backend = new CapturingBackend();
    const executor = new Executor({ approval_authority: authority, llm: backend, compute,
      tools: new ToolRegistry(), on_agent_worker_lifecycle: (event) => {
        lifecycle.push(event);
        return appendAgentWorkerLifecycle(history, event);
      } });
    const controller = new AbortController();
    const pending = executor.execute(approved(agentDelegationCommand("agent-cancel-parent")), { signal: controller.signal });
    await vi.waitFor(() => expect(requests.filter((request) => request.request_id.includes(":agent:")).length).toBe(2));

    controller.abort();
    const feedback = await pending;
    expect(feedback.status).toBe("failed");
    expect(feedback.llm_failure).toMatchObject({ kind: "cancelled", retryable: false });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.waitFor(() => expect(lifecycle.filter((event) => event.state === "residual_worker_observed")).toHaveLength(2),
      { timeout: 2_000 });

    releaseChildren();
    await vi.waitFor(() => expect(lifecycle.filter((event) => event.state === "late_result_discarded")).toHaveLength(2));
    expect(requests).toHaveLength(2);
    expect(parentComputeCalls).toBe(0);
    expect(backend.seen).toHaveLength(0);
    expect(JSON.stringify(lifecycle)).not.toContain("late private child candidate");
    expect(history.verify()).toBe(true);
    expect(history.replay({ kind: "audit_history" })).toHaveLength(8);
    expect(JSON.stringify(history.replay({ kind: "audit_history" }))).not.toContain("late private child candidate");
    expect(lifecycle.filter((event) => event.state === "late_result_discarded")
      .every((event) => event.output_observed === true && (event.output_characters ?? 0) > 0)).toBe(true);
  });

  it("preserves conservative C resource settlement when provider failure returns through Executor", async () => {
    class FailingBackend implements LLMBackend {
      readonly name = "fixture-provider";
      async call(): Promise<LLMResponse> {
        throw new LLMProviderError("fixture unavailable", {
          provider: this.name, kind: "remote_service_unavailable", retryable: false, status: 503,
        });
      }
    }
    const backend = new FailingBackend();
    const registry = new LLMRegistry({ retry: { max_attempts: 1 } }).register(backend, [], {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.25, currency: "USD" },
    }).setDefault("fixture-provider");
    let reserved = false;
    let resourceFailureSeen = false;
    const budget: ComputeBudgetPort = {
      reserve(input) {
        reserved = true;
        return { reservation_id: "a".repeat(64), reserved_tokens: input.reserved_tokens,
          reserved_compute_ms: input.reserved_compute_ms, reserved_cost: input.reserved_cost };
      },
      settle(_id, settlement) { expect(settlement.state).toBe("unknown"); },
    };
    const adapter = new LLMComputeAdapter(registry, budget);
    const compute: ComputeBackend<LLMRequest, LLMResponse> = {
      async compute(input, signal) {
        try { return await adapter.compute(input, signal); }
        catch (error) {
          resourceFailureSeen = error instanceof LLMComputeResourceFailure;
          throw error;
        }
      },
    };
    const executor = new Executor({ approval_authority: authority, llm: backend,
      compute, tools: new ToolRegistry() });

    const failureCommand = command("compute-provider-failure");
    if (failureCommand.type !== "llm_call") throw new Error("fixture command was not an LLM call");
    failureCommand.payload.compute_context = {
      ...failureCommand.payload.compute_context!,
      budget_scope: { parent_task_identity_digest: "b".repeat(64), task_identity_digest: "c".repeat(64) },
    };
    const result = await executor.execute(approved(failureCommand));

    expect(reserved).toBe(true);
    expect(resourceFailureSeen).toBe(true);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "failed", llm_failure: {
      kind: "remote_service_unavailable", status: 503,
    }, compute_resource_use: {
      request_digest: createHash("sha256")
        .update("blue-tanuki.compute-resource-use.request.v1\0compute-provider-failure").digest("hex"),
      charged_compute_ms: 1_500, charged_tokens: 64, tokens_usage_status: "unknown",
      cost_status: "unknown", charged_cost_amount: 0.25, currency: "USD",
      charge_basis: "reserved_upper_bound", used_for_authority: false, may_execute: false,
    } });
    expect(result.result).toBeUndefined();
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
