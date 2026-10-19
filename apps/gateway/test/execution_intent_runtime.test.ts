import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { approvalContextFromCommand, finalReviewRequired } from "@blue-tanuki/hds-brain";
import { Executor, createExecutorApprovalAuthority, ToolRegistry, fileSearchTool, type ExecutorApprovalClock,
  type ExecutionIntentStore } from "@blue-tanuki/core";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";

function command(id = "synthetic-command"): Extract<ExecuteCommand, { type: "tool_call" }> {
  return { id, type: "tool_call", payload: { tool_name: "synthetic.read", arguments: { target: "青" } },
    constraints: { allowed_tools: ["synthetic.read"], allowed_capabilities: ["tool:synthetic.read"] },
    upstream_decision: { request_id: "synthetic-task", frame_goal: "合成対象を読む", model_abstraction: "fixture",
      commit_hash: "fixture-commit", commit_decision: "ASSERT" } };
}
const proof = (source: ExecuteCommand = command()) => {
  const context = approvalContextFromCommand(source);
  const final_review_required = finalReviewRequired(context);
  return { source: final_review_required ? "human_final_review" as const : "approval_gate" as const,
    decision: final_review_required ? "approve" as const : "allow" as const, approved_by: "fixture-owner",
    approved_at_ms: Date.now(), upstream_commit_hash: source.upstream_decision.commit_hash, operation: context.operation,
    risk: context.risk, final_review_required, reason: "fixture" };
};
function rig(store: ExecutionIntentStore, clock?: ExecutorApprovalClock, invoke = async (_args: Record<string, unknown>) => "青",
  execution_epoch = store instanceof GatewayExecutionIntentStore ? store.executionEpoch : randomUUID()) {
  const authority = createExecutorApprovalAuthority({ execution_store: store, execution_epoch, clock, ticket_ttl_ms: clock ? 100 : 300_000 });
  const tools = new ToolRegistry();
  tools.register({ name: "synthetic.read", description: "合成読取り", required_capabilities: ["tool:synthetic.read"], invoke });
  const executor = new Executor({ approval_authority: authority, tools, llm: { name: "fixture", call: async () => ({ content: "青", model: "fixture", tokens_used: 0 }) } });
  return { authority, executor };
}
async function temporary(run: (store: GatewayExecutionIntentStore, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "blue-intent-"));
  const store = new GatewayExecutionIntentStore(join(root, "executor.sqlite"), randomUUID());
  try { await run(store, root); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
const key = (id: string): string => createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", id])).digest("hex");

describe("固定承認→永続消費・開始意思→実呼出し→receipt", () => {
  it("実builtin file.searchを単回で通し、同IDの再brand・別内容・別authorityから再作用しない", async () => temporary(async (store, root) => {
    const workspace = join(root, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "blue.txt"), "blue\n");
    const prior = process.env.BLUE_TANUKI_FILE_ROOT; process.env.BLUE_TANUKI_FILE_ROOT = workspace;
    try {
      const tools = new ToolRegistry(); tools.register(fileSearchTool);
      const authority = createExecutorApprovalAuthority({ execution_store: store, execution_epoch: store.executionEpoch });
      const executor = new Executor({ approval_authority: authority, tools, llm: { name: "fixture", call: async () => { throw new Error("not used"); } } });
      const source = command();
      source.payload = { tool_name: "file.search", arguments: { root: workspace, query: "blue", max_results: 1 } };
      source.constraints = { allowed_tools: ["file.search"], allowed_capabilities: [...fileSearchTool.required_capabilities!] };
      const approved = authority.approve(source, proof(source));
      const feedback = await executor.execute(approved);
      expect(feedback.status).toBe("success");
      expect(feedback.operation_core_result?.action_outcome).toBe("reported_success");
      const receipt = authority.receipt(approved)!;
      expect(receipt).toMatchObject({ state: "adapter_returned", invocation_boundary: "tool_adapter", used_for_authority: false });
      expect(receipt.output_digest).toBe(feedback.operation_core_result?.output_digest);
      expect((await executor.execute(approved)).error).toMatch(/already consumed/);
      expect(() => authority.approve(source, proof(source))).toThrow(/command already issued/);
    } finally { if (prior === undefined) delete process.env.BLUE_TANUKI_FILE_ROOT; else process.env.BLUE_TANUKI_FILE_ROOT = prior; }
    const next = rig(store);
    expect(() => next.authority.approve(command(), proof())).toThrow(/command already issued/);
    expect(store.verifyEvents()).toBe(true);
    expect(store.snapshot()).toMatchObject({ used_for_authority: false, execution_eligible: false, records: [{ state: "adapter_returned" }] });
    expect(JSON.stringify(store.snapshot())).not.toContain(workspace);
  }));

  it("wall/monotonic期限と巻戻しをそれぞれ拒否して下流を呼ばない", async () => {
    for (const kind of ["wall_expiry", "monotonic_expiry", "wall_rollback", "monotonic_rollback"]) {
      await temporary(async (store) => {
        let wall = 1000; let monotonic = 1000; let calls = 0;
        const clock = { wallNow: () => wall, monotonicNow: () => monotonic };
        const { authority, executor } = rig(store, clock, async () => { calls++; return "青"; });
        const approved = authority.approve(command(), proof());
        if (kind === "wall_expiry") wall += 100;
        if (kind === "monotonic_expiry") monotonic += 100;
        if (kind === "wall_rollback") wall--;
        if (kind === "monotonic_rollback") monotonic--;
        expect((await executor.execute(approved)).error).toMatch(/expired|rolled back/);
        expect(calls).toBe(0);
      });
    }
  });

  it("LLMのhistory待機後にも期限を再照合し、消費後の未呼出しを復活させない", async () => temporary(async (store) => {
    let wall = 1000; let monotonic = 1000; let calls = 0;
    const authority = createExecutorApprovalAuthority({ execution_store: store, execution_epoch: store.executionEpoch, ticket_ttl_ms: 100,
      clock: { wallNow: () => wall, monotonicNow: () => monotonic } });
    const executor = new Executor({ approval_authority: authority, tools: new ToolRegistry(),
      llm: { name: "fixture", call: async () => { calls++; return { content: "青", model: "fixture", tokens_used: 0 }; } },
      session_store: { getMessages: async () => { wall += 100; monotonic += 100; return []; }, append: async () => {}, clear: async () => {}, size: async () => 0 } });
    const source: ExecuteCommand = { ...command(), type: "llm_call", payload: { messages: [{ role: "user", content: "青" }], session_id: "fixture" } };
    const approved = authority.approve(source, proof(source));
    expect((await executor.execute(approved)).status).toBe("failed"); expect(calls).toBe(0);
    expect(authority.receipt(approved)?.state).toBe("not_attempted");
    expect(() => authority.approve(source, proof(source))).toThrow(/command already issued/);
  }));

  it("新owner世代の永続storeは期限内でも旧世代ticketの発行・消費・開始・確定を拒否する", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-intent-generation-"));
    const filepath = join(root, "executor.sqlite");
    const originalEpoch = randomUUID(); const currentEpoch = randomUUID();
    const original = new GatewayExecutionIntentStore(filepath, originalEpoch);
    try {
      const { authority } = rig(original);
      const approved = authority.approve(command(), proof());
      const oldTicket = authority.receipt(approved)!;
      original.close();

      const restarted = new GatewayExecutionIntentStore(filepath, currentEpoch);
      try {
        const worker = { worker_id: randomUUID(), worker_pid: process.pid + 1, worker_platform: process.platform, worker_started_at_ms: Date.now() };
        expect(restarted.lookup(oldTicket.ticket_id)?.execution_epoch).toBe(originalEpoch);
        expect(() => restarted.issue(oldTicket)).toThrow(/owner generation mismatch/);
        expect(() => restarted.consume(oldTicket, Date.now())).toThrow(/owner generation mismatch/);
        expect(() => restarted.markInvocation(oldTicket, "tool_adapter", Date.now())).toThrow(/owner generation mismatch/);
        expect(() => restarted.bindWorker(oldTicket, worker, Date.now())).toThrow(/owner generation mismatch/);
        expect(() => restarted.observeWorkerExit(oldTicket, worker, Date.now())).toThrow(/owner generation mismatch/);
        expect(() => restarted.complete(oldTicket, { state: "not_attempted", feedback_status: "failed", observed_at_ms: Date.now() }))
          .toThrow(/owner generation mismatch/);
        expect(restarted.lookup(oldTicket.ticket_id)?.state).toBe("issued");
        expect(restarted.verifyEvents()).toBe(true);
      } finally { restarted.close(); }
    } finally {
      try { original.close(); } catch { /* already closed before reopen */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("consume commit後の返却喪失では下流0、receipt保存喪失では成功を返さず再作用0", async () => {
    for (const failure of ["consume", "complete"]) await temporary(async (store) => {
      let calls = 0;
      const port: ExecutionIntentStore = {
        issue: (t) => store.issue(t), lookup: (id) => store.lookup(id), markInvocation: (t, b, n) => store.markInvocation(t, b, n),
        consume: (t, n) => { store.consume(t, n); if (failure === "consume") throw new Error("fixture commit acknowledgement lost"); },
        complete: (t, r) => { if (failure === "complete") throw new Error("fixture receipt lost"); store.complete(t, r); },
      };
      const { authority, executor } = rig(port, undefined, async () => { calls++; return "青"; }, store.executionEpoch);
      const approved = authority.approve(command(), proof());
      const feedback = await executor.execute(approved);
      expect(feedback.status).toBe("failed");
      expect(authority.receipt(approved)?.state).toBe("outcome_unknown");
      expect(calls).toBe(failure === "consume" ? 0 : 1);
      await executor.execute(approved);
      expect(calls).toBe(failure === "consume" ? 0 : 1);
      expect(() => authority.approve(command(), proof())).toThrow(/already issued/);
    });
  });

  it("監査event破損・全event削除から次の作用を始めない", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    for (const corruption of ["replace", "delete"]) await temporary(async (store, root) => {
      let calls = 0;
      const { authority, executor } = rig(store, undefined, async () => { calls++; return "青"; });
      const approved = authority.approve(command(), proof());
      const db = new DatabaseSync(join(root, "executor.sqlite"));
      db.exec(corruption === "delete" ? "DELETE FROM execution_events" : "UPDATE execution_events SET event_json='{}'"); db.close();
      expect((await executor.execute(approved)).error).toMatch(/integrity_failed/); expect(calls).toBe(0);
      expect(() => new GatewayExecutionIntentStore(join(root, "executor.sqlite"), store.executionEpoch)).toThrow(/integrity_failed/);
    });
  });

  it("別processの同ID競合と実invoke中killを私有SQLiteへ保持し、再照会は作用しない", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-intent-process-"));
    const executionEpoch = randomUUID();
    const children: ChildProcess[] = [];
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"])
      if (process.env[name]) env[name] = process.env[name];
    const spawnWorker = (id: string, mode: string) => {
      const child = fork(join(process.cwd(), "apps/gateway/test/fixtures/execution_intent_worker.ts"), [root, id, mode, executionEpoch],
        { execArgv: ["--import", "tsx"], env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.push(child); return child;
    };
    try {
      const first = spawnWorker("race", "complete"); const second = spawnWorker("race", "complete");
      const firstDone = once(first, "exit"); const secondDone = once(second, "exit");
      await Promise.all([once(first, "message"), once(second, "message")]);
      first.send("start"); second.send("start");
      const results = await Promise.all([firstDone, secondDone]);
      expect(results.map((r) => r[0]).sort()).toEqual([0, 2]);
      expect(readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n")).toEqual(["race"]);
      const interrupted = spawnWorker("crash", "hold");
      await once(interrupted, "message");
      const invoked = once(interrupted, "message"); interrupted.send("start");
      expect((await invoked)[0]).toEqual("invoked");
      const exited = once(interrupted, "exit"); interrupted.kill(); await exited;
      const reopened = new GatewayExecutionIntentStore(join(root, "executor.sqlite"), executionEpoch);
      try {
        expect(reopened.lookupCommand(key("race"))?.state).toBe("adapter_returned");
        expect(reopened.lookupCommand(key("crash"))?.state).toBe("outcome_unknown");
        const projected = reopened.snapshot();
        expect(projected.records).toHaveLength(2);
        expect(projected.records.find((r) => r.state === "outcome_unknown")?.invocation_boundary).toBe("tool_adapter");
        expect(() => rig(reopened).authority.approve(command("crash"), proof())).toThrow(/already issued/);
        expect(readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n")).toEqual(["race", "crash"]);
      } finally { reopened.close(); }
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
        const exited = once(child, "exit"); child.kill(); await exited;
      }));
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
