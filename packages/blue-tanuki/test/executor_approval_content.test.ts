import { describe, expect, it } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  Executor, createExecutorApprovalAuthority, captureExecutorCommandForApproval,
  executorCommandDigest, type ExecutorApprovalProof,
} from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { ToolRegistry } from "../src/tools/registry.js";

function command(toolName = "synthetic.read", capabilities: string[] = ["fs:read"]): Extract<ExecuteCommand, { type: "tool_call" }> {
  return { id: "synthetic-command", type: "tool_call",
    payload: { tool_name: toolName, arguments: { target: "one", body: { text: "青" } } },
    constraints: { allowed_tools: [toolName], allowed_capabilities: capabilities },
    upstream_decision: { frame_goal: "合成対象を読む", model_abstraction: "fixture", commit_hash: "synthetic-hds-commit", commit_decision: "ASSERT" } };
}
function proof(overrides: Partial<ExecutorApprovalProof> = {}): ExecutorApprovalProof {
  return { source: "approval_gate", decision: "allow", approved_by: "fixture-owner", approved_at_ms: 1,
    upstream_commit_hash: "synthetic-hds-commit", operation: "tool.file.read", risk: "low",
    final_review_required: false, reason: "synthetic review", ...overrides };
}
function runtime(invoke: (args: Record<string, unknown>) => Promise<unknown>, toolName = "synthetic.read", capabilities: string[] = ["fs:read"]) {
  const approval = createExecutorApprovalAuthority();
  const tools = new ToolRegistry();
  tools.register({ name: toolName, description: "合成の内容固定確認", required_capabilities: capabilities, invoke });
  return { approval, executor: new Executor({ approval_authority: approval, tools, llm: new StubBackend() }) };
}

describe("承認内容からExecutorへの固定", () => {
  it("承認後の元引数・許可・proof変更は実adapterへ届かず、固定した内容だけが届く", async () => {
    const seen: unknown[] = [];
    const { approval, executor } = runtime(async (args) => { seen.push(args); return args; });
    const source = command(); const decision = proof();
    const approved = approval.approve(source, decision, executorCommandDigest(source));
    source.payload.arguments.target = "two";
    (source.payload.arguments.body as { text: string }).text = "赤";
    source.constraints!.allowed_capabilities!.push("external:send");
    decision.decision = "approve";
    expect(() => { approved.payload.arguments.target = "three"; }).toThrow();
    expect((await executor.execute(approved)).status).toBe("success");
    expect(seen).toEqual([{ target: "one", body: { text: "青" } }]);
  });

  it("受付時のHDS command identityを保持し、浅いfreezeの内側も固定する", () => {
    const source = command(); Object.freeze(source);
    const captured = captureExecutorCommandForApproval(source);
    expect(captured.command).toBe(source);
    expect(captured.command_digest).toBe(executorCommandDigest(source));
    expect(() => { source.payload.arguments.target = "two"; }).toThrow();
    expect(Object.isFrozen(source.constraints!.allowed_tools)).toBe(true);
  });

  it("同じcommitでもreview後の対象・内容・constraints・目的・ID差替えを発行時に拒否する", () => {
    const { approval } = runtime(async () => null);
    const mutations = [
      (c: ReturnType<typeof command>) => { c.payload.arguments.target = "two"; },
      (c: ReturnType<typeof command>) => { (c.payload.arguments.body as { text: string }).text = "赤"; },
      (c: ReturnType<typeof command>) => { c.constraints!.allowed_capabilities!.push("external:send"); },
      (c: ReturnType<typeof command>) => { c.upstream_decision.frame_goal = "別目的"; },
      (c: ReturnType<typeof command>) => { c.id = "another-command"; },
    ];
    for (const mutate of mutations) {
      const source = command(); const digest = executorCommandDigest(source); mutate(source);
      expect(() => approval.approve(source, proof(), digest)).toThrow(/reviewed command content changed/);
    }
  });

  it("reflection・JSON・別objectへのコピーからauthorityを復活させない", async () => {
    let calls = 0;
    const { approval, executor } = runtime(async () => { calls++; return null; });
    const approved = approval.approve(command(), proof());
    const reflected = Object.defineProperties({}, Object.getOwnPropertyDescriptors(approved));
    const serialized = JSON.parse(JSON.stringify(approved));
    for (const copy of [reflected, serialized]) {
      const result = await executor.execute(copy as never);
      expect(result.error).toMatch(/ApprovedCommand proof is required/);
    }
    expect(calls).toBe(0);
    expect(Object.getOwnPropertySymbols(approved)).toEqual([]);
  });

  it("adapter待機中の同じ承認再送と、完了後の再送から二回目の作用を起動しない", async () => {
    let finish!: () => void; let calls = 0;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const { approval, executor } = runtime(async () => { calls++; await wait; return null; });
    const approved = approval.approve(command(), proof());
    const first = executor.execute(approved);
    expect((await executor.execute(approved)).error).toMatch(/approval already consumed/);
    finish(); expect((await first).status).toBe("success");
    expect((await executor.execute(approved)).error).toMatch(/approval already consumed/);
    expect(calls).toBe(1);
  });

  it("作用後の失敗で同じ承認を再利用せず、非JSON・getterも無作用で拒否する", async () => {
    let calls = 0; let getterCalls = 0;
    const { approval, executor } = runtime(async () => { calls++; throw new Error("synthetic adapter failure"); });
    const approved = approval.approve(command(), proof());
    expect((await executor.execute(approved)).status).toBe("failed");
    expect((await executor.execute(approved)).error).toMatch(/approval already consumed/);
    for (const invalid of [NaN, Infinity, -0, 9007199254740992, () => "secret", new Date(), { missing: undefined }]) {
      const source = command(); source.payload.arguments.invalid = invalid;
      expect(() => approval.approve(source, proof())).toThrow(/not canonical JSON/);
    }
    const source = command();
    Object.defineProperty(source.payload.arguments, "getter", { enumerable: true, get() { getterCalls++; return "secret"; } });
    expect(() => approval.approve(source, proof())).toThrow(/not canonical JSON/);
    expect(getterCalls).toBe(0); expect(calls).toBe(1);
    const invalidNoop: ExecuteCommand = { id: "synthetic-noop", type: "noop", payload: { reason: undefined }, upstream_decision: command().upstream_decision };
    expect(() => approval.approve(invalidNoop, proof())).toThrow(/not canonical JSON/);
  });

  it("JSON key順序は同一内容とし、日本語の異なるUnicode内容は同一化しない", () => {
    const a = command(); const b = command();
    b.payload.arguments = { body: { text: "青" }, target: "one" };
    expect(executorCommandDigest(a)).toBe(executorCommandDigest(b));
    a.payload.arguments.text = "ガ"; b.payload.arguments.text = "カ\u3099";
    expect(executorCommandDigest(a)).not.toBe(executorCommandDigest(b));
  });

  it("正規LLMの小数temperatureを維持し、数値と似た文字列・objectを同一化しない", async () => {
    let temperature: number | undefined;
    const authority = createExecutorApprovalAuthority();
    const executor = new Executor({ approval_authority: authority, tools: new ToolRegistry(),
      llm: { name: "synthetic", async call(request) { temperature = request.temperature; return { content: "blue", model: "synthetic", tokens_used: 1 }; } } });
    const source: ExecuteCommand = { id: "synthetic-llm", type: "llm_call", payload: { messages: [{ role: "user", content: "青" }], temperature: 0.7 }, upstream_decision: command().upstream_decision };
    const reviewed = captureExecutorCommandForApproval(source);
    expect((await executor.execute(authority.approve(source, { ...proof(), operation: "llm.call" }, reviewed.command_digest))).status).toBe("success");
    expect(temperature).toBe(0.7);
    const variants = [0.7, "0.7", { $number: "0.7" }, ["number", "0.7"]].map((value) => {
      const c = command(); c.payload.arguments.number = value; return executorCommandDigest(c);
    });
    expect(new Set(variants).size).toBe(4);
  });

  it("HDS正本のoperation・riskと一致しないproofを拒否する", () => {
    const { approval } = runtime(async () => null);
    const unknown = command("synthetic.unknown", ["tool:synthetic.unknown"]);
    expect(() => approval.approve(unknown, proof({ source: "untrusted" as ExecutorApprovalProof["source"] })))
      .toThrow(/proof source is invalid/);
    expect(() => approval.approve(unknown, proof())).toThrow(/operation does not match HDS/);
    expect(() => approval.approve(unknown, proof({ operation: "tool.call" }))).toThrow(/risk does not match HDS/);
    expect(() => approval.approve(unknown, proof({ operation: "tool.call", risk: "high" }))).toThrow(/final-review status does not match HDS/);
  });

  it.each([
    { toolName: "synthetic.unknown", capability: "tool:synthetic.unknown", operation: "tool.call" },
    { toolName: "synthetic.credential", capability: "credential:read", operation: "credential.access" },
    { toolName: "synthetic.payment", capability: "payment:charge", operation: "payment.charge" },
  ] as const)("HDSのL3分類 $operation にはExecutorでhuman final-reviewを要求する", async ({ toolName, capability, operation }) => {
    let calls = 0;
    const { approval } = runtime(async () => { calls++; return null; }, toolName, [capability]);
    const source = command(toolName, [capability]);
    const proofWithoutHumanReview = proof({ operation, risk: "high", final_review_required: true });
    expect(() => approval.approve(source, proofWithoutHumanReview)).toThrow(/human final-review proof is required/);
    expect(calls).toBe(0);
  });

  it("HDS分類と内容が一致したhuman final-review proofだけを合成Executorへ通す", async () => {
    let calls = 0;
    const toolName = "synthetic.unknown";
    const capability = "tool:synthetic.unknown";
    const { approval, executor } = runtime(async () => { calls++; return { completed: true }; }, toolName, [capability]);
    const source = command(toolName, [capability]);
    const approved = approval.approve(source, proof({ source: "human_final_review", decision: "approve",
      operation: "tool.call", risk: "high", final_review_required: true }));
    expect((await executor.execute(approved)).status).toBe("success");
    expect(calls).toBe(1);
  });
});
