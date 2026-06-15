import { describe, it, expect } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { MemorySessionStore } from "../src/sessions/index.js";
import type { LLMRequest, LLMResponse, LLMBackend } from "../src/llm/base.js";

const stubUpstream = {
  frame_goal: "g",
  model_abstraction: "m",
  commit_hash: "h",
  commit_decision: "ASSERT" as const,
};

const executorApproval = createExecutorApprovalAuthority();

function llmCmd(content: string, session_id?: string): ExecuteCommand {
  return {
    id: `cmd-${content}`,
    type: "llm_call",
    payload: {
      messages: [{ role: "user", content }],
      ...(session_id ? { session_id } : {}),
    },
    upstream_decision: stubUpstream,
  };
}

function llmCmdWithBackendHint(backend_hint: string): ExecuteCommand {
  return {
    id: `cmd-hint-${backend_hint}`,
    type: "llm_call",
    payload: {
      backend_hint,
      model: "hinted-model",
      temperature: 0.4,
      messages: [{ role: "user", content: "choose provider" }],
    },
    upstream_decision: stubUpstream,
  };
}

function approved(command: ExecuteCommand) {
  return executorApproval.approve(command, {
    source: "approval_gate",
    decision: "allow",
    approved_by: "test-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: command.type === "llm_call" ? "llm.call" : command.type,
    risk: "low",
    final_review_required: false,
    reason: "test approval",
  });
}

class CapturingBackend implements LLMBackend {
  readonly name = "capturing";
  readonly seen: LLMRequest[] = [];
  async call(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push({
      messages: req.messages.map((m) => ({ ...m })),
      backend_hint: req.backend_hint,
      max_tokens: req.max_tokens,
      timeout_ms: req.timeout_ms,
      model: req.model,
      temperature: req.temperature,
    });
    const last = req.messages[req.messages.length - 1];
    return {
      content: `reply-to:${last?.content ?? ""}`,
      tokens_used: 1,
      model: "capturing",
    };
  }
}

describe("Executor — SessionStore integration", () => {
  it("no session_store: payload passes through unchanged (back-compat)", async () => {
    const llm = new CapturingBackend();
    const exec = new Executor({ approval_authority: executorApproval, llm, tools: new ToolRegistry() });
    await exec.execute(approved(llmCmd("hello")));
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0].messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("session_store but no session_id: payload passes through unchanged", async () => {
    const llm = new CapturingBackend();
    const store = new MemorySessionStore();
    const exec = new Executor({ approval_authority: executorApproval, llm, tools: new ToolRegistry(), session_store: store });
    await exec.execute(approved(llmCmd("hi")));
    expect(llm.seen[0].messages).toEqual([{ role: "user", content: "hi" }]);
    expect(await store.size()).toBe(0);
  });

  it("session_id with empty history: prepends nothing, appends user+assistant", async () => {
    const llm = new CapturingBackend();
    const store = new MemorySessionStore();
    const exec = new Executor({ approval_authority: executorApproval, llm, tools: new ToolRegistry(), session_store: store });
    await exec.execute(approved(llmCmd("first", "webchat:bob")));
    expect(llm.seen[0].messages).toEqual([{ role: "user", content: "first" }]);
    const hist = await store.getMessages("webchat:bob");
    expect(hist.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:first",
      "assistant:reply-to:first",
    ]);
  });

  it("second turn: prepends history before the new user message", async () => {
    const llm = new CapturingBackend();
    const store = new MemorySessionStore();
    const exec = new Executor({ approval_authority: executorApproval, llm, tools: new ToolRegistry(), session_store: store });

    await exec.execute(approved(llmCmd("first", "s")));
    await exec.execute(approved(llmCmd("second", "s")));

    const second = llm.seen[1].messages;
    expect(second.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:first",
      "assistant:reply-to:first",
      "user:second",
    ]);

    const hist = await store.getMessages("s");
    expect(hist.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:first",
      "assistant:reply-to:first",
      "user:second",
      "assistant:reply-to:second",
    ]);
  });

  it("history_limit caps the number of prepended messages", async () => {
    const llm = new CapturingBackend();
    const store = new MemorySessionStore();
    const exec = new Executor({
      approval_authority: executorApproval,
      llm,
      tools: new ToolRegistry(),
      session_store: store,
      history_limit: 2,
    });

    // Build up 3 turns of history first.
    for (let i = 0; i < 3; i++) {
      await exec.execute(approved(llmCmd(`turn-${i}`, "s")));
    }

    // 4th call: only the last 2 history rows should be prepended.
    await exec.execute(approved(llmCmd("now", "s")));
    const last = llm.seen[3].messages;
    // last 2 of history were ["user:turn-2","assistant:reply-to:turn-2"]
    // No that's wrong — after 3 turns, history has 6 rows. Last 2 are
    // "assistant:reply-to:turn-2" preceded by "user:turn-2".
    expect(last.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:turn-2",
      "assistant:reply-to:turn-2",
      "user:now",
    ]);
  });

  it("LLM failure does not pollute history (no append on error)", async () => {
    const failing: LLMBackend = {
      name: "failing",
      async call() {
        throw new Error("boom");
      },
    };
    const store = new MemorySessionStore();
    const exec = new Executor({ approval_authority: executorApproval, llm: failing, tools: new ToolRegistry(), session_store: store });
    const fb = await exec.execute(approved(llmCmd("never-persist", "s")));
    expect(fb.status).toBe("failed");
    expect(await store.getMessages("s")).toEqual([]);
  });

  it("StubBackend output is captured under session history", async () => {
    const store = new MemorySessionStore();
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools: new ToolRegistry(),
      session_store: store,
    });
    await exec.execute(approved(llmCmd("ping", "k")));
    const hist = await store.getMessages("k");
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ role: "user", content: "ping" });
    expect(hist[1].role).toBe("assistant");
    expect(hist[1].content).toContain("ping");
  });

  it("passes backend_hint/model/temperature through to the LLM boundary", async () => {
    const llm = new CapturingBackend();
    const exec = new Executor({ approval_authority: executorApproval, llm, tools: new ToolRegistry() });
    await exec.execute(approved(llmCmdWithBackendHint("openai-compatible")));

    expect(llm.seen[0]!).toMatchObject({
      backend_hint: "openai-compatible",
      model: "hinted-model",
      temperature: 0.4,
      messages: [{ role: "user", content: "choose provider" }],
    });
  });
});
