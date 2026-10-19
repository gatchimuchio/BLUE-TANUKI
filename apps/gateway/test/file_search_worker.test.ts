import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Executor, ToolRegistry, fileSearchTool, createExecutorApprovalAuthority, executorCommandDigest,
  type ExecutionIntentStore, type FileSearchWorker } from "@blue-tanuki/core";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { createFileSearchWorker } from "../src/file_search_worker.js";
import { readWorkerPacket, workerPacket } from "../src/file_search_worker_protocol.js";

const llm = { name: "fixture", call: async () => { throw new Error("C is not used"); } };
function source(): Extract<ExecuteCommand, { type: "tool_call" }> {
  return { id: randomUUID(), type: "tool_call", payload: { tool_name: "file.search", arguments: { root: ".", query: "blue", max_results: 1 } },
    constraints: { allowed_tools: ["file.search"], allowed_capabilities: [...fileSearchTool.required_capabilities!], timeout_ms: 10_000 },
    upstream_decision: { request_id: "fixture-task", frame_goal: "合成ファイルのblueを検索", model_abstraction: "fixture",
      commit_hash: "fixture-commit", commit_decision: "ASSERT" } };
}
const proof = () => ({ source: "approval_gate" as const, decision: "allow" as const, approved_by: "fixture-owner",
  approved_at_ms: Date.now(), upstream_commit_hash: "fixture-commit", operation: "tool.file.search", risk: "low" as const,
  final_review_required: false, reason: "fixture" });
async function temporary(run: (store: GatewayExecutionIntentStore, workspace: string, filename: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "blue-search-worker-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "blue.txt"), "blue\n");
  const filename = join(root, "executor.sqlite"); const store = new GatewayExecutionIntentStore(filename);
  try { await run(store, workspace, filename); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
function rig(store: ExecutionIntentStore, workspace: string, worker?: FileSearchWorker) {
  const tools = new ToolRegistry(); tools.register(fileSearchTool);
  const authority = createExecutorApprovalAuthority({ execution_store: store });
  const executor = new Executor({ tools, approval_authority: authority, llm,
    file_search_worker: worker ?? createFileSearchWorker({ SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace,
      // 継承されたらNode自体が起動できない。資格値を出力させる試験はしない。
      NODE_OPTIONS: "--blue-forbidden-parent-option" }) });
  return { authority, executor };
}
async function approve(authority: ReturnType<typeof createExecutorApprovalAuthority>, executor: Executor,
  workspace: string, command = source()) {
  const targetVersion = await executor.inspectCommandTargetVersion(command, { BLUE_TANUKI_FILE_ROOT: workspace });
  return authority.approve(command, proof(command), undefined, undefined, targetVersion);
}

describe("Gateway組込みfile.searchの専用process境界", () => {
  it("実検索→異なるPID/世代→実exit→receiptを返し、再起動照会と再送では再作用しない", async () => temporary(async (store, workspace, filename) => {
    const { authority, executor } = rig(store, workspace);
    const command = source(); const approved = await approve(authority, executor, workspace, command);
    const feedback = await executor.execute(approved);
    expect(feedback.status).toBe("success");
    expect(feedback.result).toMatchObject({ query: "blue", visited_files: 1, matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] });
    const receipt = authority.receipt(approved)!;
    expect(receipt).toMatchObject({ state: "adapter_returned", invocation_boundary: "tool_adapter", worker_platform: process.platform });
    expect(receipt.worker_pid).toBeGreaterThan(0); expect(receipt.worker_pid).not.toBe(process.pid);
    expect(receipt.worker_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.worker_exit_observed_at_ms).toBeGreaterThanOrEqual(receipt.worker_started_at_ms!);
    expect(receipt.output_digest).toBe(feedback.operation_core_result?.output_digest);
    const reopened = new GatewayExecutionIntentStore(filename);
    try { expect(reopened.snapshot()).toEqual(store.snapshot()); expect(reopened.verifyEvents()).toBe(true); }
    finally { reopened.close(); }
    expect((await executor.execute(approved)).error).toMatch(/already consumed/);
    expect(() => authority.approve(command, proof())).toThrow(/already issued/);
    expect(JSON.stringify(store.snapshot())).not.toContain(workspace);
  }));

  it("承認ticketのtarget versionから内容が変わった場合は検索結果を返さず再確認を要求する", async () => temporary(async (store, workspace) => {
    const { authority, executor } = rig(store, workspace);
    const approved = await approve(authority, executor, workspace);
    writeFileSync(join(workspace, "blue.txt"), "blue changed after preflight\n");

    const feedback = await executor.execute(approved);
    expect(feedback.status).toBe("failed");
    expect(feedback.result).toBeUndefined();
    expect(feedback.error).toMatch(/target_version_changed.*fresh review/);
    expect(authority.receipt(approved)).toMatchObject({ state: "outcome_unknown", invocation_boundary: "tool_adapter" });
    expect(authority.receipt(approved)?.worker_exit_observed_at_ms).toBeGreaterThan(0);
  }));

  it("起動待ち後の停止確認を通らなければexecuteを送らず、実exit付き未呼出しへ戻す", async () => temporary(async (store, workspace) => {
    const { authority, executor } = rig(store, workspace);
    const approved = await approve(authority, executor, workspace);
    const feedback = await executor.execute(approved, { before_tool_dispatch: () => { throw new Error("owner emergency stop active"); } });
    expect(feedback.status).toBe("failed"); expect(feedback.error).toMatch(/emergency stop/);
    const receipt = authority.receipt(approved)!;
    expect(receipt.state).toBe("not_attempted"); expect(receipt.invocation_boundary).toBeUndefined();
    expect(receipt.worker_pid).toBeGreaterThan(0); expect(receipt.worker_exit_observed_at_ms).toBeGreaterThan(0);
    expect((await executor.execute(approved)).error).toMatch(/already consumed/);
  }));

  it("bind保存の後にもmonotonic期限を検査し、readyを検索開始として扱わない", async () => temporary(async (store, workspace) => {
    let wall = Date.now(); let monotonic = 1000;
    const wrapped: ExecutionIntentStore = {
      issue: store.issue.bind(store), consume: store.consume.bind(store), markInvocation: store.markInvocation.bind(store),
      lookup: store.lookup.bind(store), complete: store.complete.bind(store), observeWorkerExit: store.observeWorkerExit.bind(store),
      bindWorker: (ticket, worker, now) => { store.bindWorker(ticket, worker, now); monotonic += 300_000; },
    };
    const authority = createExecutorApprovalAuthority({ execution_store: wrapped,
      clock: { wallNow: () => wall, monotonicNow: () => monotonic } });
    const tools = new ToolRegistry(); tools.register(fileSearchTool);
    const executor = new Executor({ llm, tools, approval_authority: authority,
      file_search_worker: createFileSearchWorker({ SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace }) });
    const approved = await approve(authority, executor, workspace);
    expect((await executor.execute(approved)).error).toMatch(/expired/);
    expect(authority.receipt(approved)).toMatchObject({ state: "not_attempted", worker_platform: process.platform });
    expect(authority.receipt(approved)?.worker_exit_observed_at_ms).toBeGreaterThan(0);
  }));

  it("cancelは監査保存を待たずchildを止め、exit保存失敗や起動未接続を成功へ変えない", async () => temporary(async (store, workspace) => {
    const controller = new AbortController();
    const wrapped: ExecutionIntentStore = {
      issue: store.issue.bind(store), consume: store.consume.bind(store), markInvocation: store.markInvocation.bind(store),
      lookup: store.lookup.bind(store), complete: store.complete.bind(store),
      bindWorker: (ticket, worker, now) => { store.bindWorker(ticket, worker, now); controller.abort(); },
      observeWorkerExit: () => { throw new Error("fixture exit persistence failed"); },
    };
    const { authority, executor } = rig(wrapped, workspace);
    const approved = await approve(authority, executor, workspace);
    expect((await executor.execute(approved, { signal: controller.signal })).status).toBe("failed");
    expect(authority.receipt(approved)?.state).toBe("not_attempted");
    expect(authority.receipt(approved)?.worker_exit_observed_at_ms).toBeUndefined();
    const incomplete = rig(store, workspace, { invoke: async () => ({ matches: [] }) });
    expect((await incomplete.executor.execute(await approve(incomplete.authority, incomplete.executor, workspace))).error).toMatch(/lifecycle incomplete/);
  }));

  it("invocation保存の待機後にも期限を再検査し、消費済みの不明窓を復活させない", async () => temporary(async (store, workspace) => {
    const wall = Date.now(); let monotonic = 1000;
    const wrapped: ExecutionIntentStore = {
      issue: store.issue.bind(store), consume: store.consume.bind(store), lookup: store.lookup.bind(store), complete: store.complete.bind(store),
      bindWorker: store.bindWorker.bind(store), observeWorkerExit: store.observeWorkerExit.bind(store),
      markInvocation: (ticket, boundary, now) => { store.markInvocation(ticket, boundary, now); monotonic += 300_000; },
    };
    const authority = createExecutorApprovalAuthority({ execution_store: wrapped,
      clock: { wallNow: () => wall, monotonicNow: () => monotonic } });
    const tools = new ToolRegistry(); tools.register(fileSearchTool);
    const executor = new Executor({ llm, tools, approval_authority: authority,
      file_search_worker: createFileSearchWorker({ SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace }) });
    const approved = await approve(authority, executor, workspace);
    expect((await executor.execute(approved)).error).toMatch(/expired/);
    expect(authority.receipt(approved)).toMatchObject({ state: "outcome_unknown", worker_platform: process.platform });
    expect(authority.receipt(approved)?.worker_exit_observed_at_ms).toBeGreaterThan(0);
    expect((await executor.execute(approved)).error).toMatch(/already consumed/);
  }));

  it("現在のroot権限外、同名custom adapterを実built-inへ差替える経路を拒否する", async () => temporary(async (store, workspace) => {
    const { authority, executor } = rig(store, workspace);
    const outside = source(); outside.payload.arguments.root = "..";
    await expect(executor.inspectCommandTargetVersion(outside, { BLUE_TANUKI_FILE_ROOT: workspace }))
      .rejects.toThrow(/BLUE_TANUKI_FILE_ROOT/);
    const tools = new ToolRegistry(); let customCalls = 0;
    tools.register({ ...fileSearchTool, invoke: async () => { customCalls++; return {}; } });
    const custom = new Executor({ llm, tools, approval_authority: authority, file_search_worker: createFileSearchWorker({ BLUE_TANUKI_FILE_ROOT: workspace }) });
    expect((await custom.execute(authority.approve(source(), proof()))).error).toMatch(/registered built-in/);
    expect(customCalls).toBe(0);
  }));

  it("実IPC childは改変内容・別worker・期限切れのpacketから結果を返さない", async () => temporary(async (store, workspace) => {
    for (const kind of ["content", "worker", "expired"]) {
      const authority = createExecutorApprovalAuthority({ execution_store: store });
      const commandSource = source();
      const { executor } = rig(store, workspace);
      const targetVersion = await executor.inspectCommandTargetVersion(commandSource, { BLUE_TANUKI_FILE_ROOT: workspace });
      const approved = authority.approve(commandSource, proof(commandSource), undefined, undefined, targetVersion);
      const ticket = authority.receipt(approved)!;
      const worker_id = randomUUID();
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/file_search_worker_child.js", import.meta.url))], {
        env: { SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace, BLUE_TANUKI_WORKER_ID: worker_id },
        stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
      const closed = once(child, "close"); const timer = setTimeout(() => child.kill(), 10_000);
      let results = 0;
      try {
        const [value] = await once(child, "message"); expect(readWorkerPacket(value).pid).toBe(child.pid);
        child.on("message", () => results++);
        const command = structuredClone(approved);
        const packetTicket = { ticket_id: ticket.ticket_id, command_key: ticket.command_key, command_digest: executorCommandDigest(command),
          proof_digest: ticket.proof_digest, execution_epoch: ticket.execution_epoch, issued_at_ms: ticket.issued_at_ms, expires_at_ms: ticket.expires_at_ms };
        if (kind === "content") command.payload.arguments.query = "changed";
        if (kind === "expired") packetTicket.expires_at_ms = packetTicket.issued_at_ms + 1;
        child.send(workerPacket({ type: "execute", worker_id: kind === "worker" ? randomUUID() : worker_id,
          ticket: packetTicket, command, target_version_observation: targetVersion }));
        const [code] = await closed; expect(code).toBe(2); expect(results).toBe(0);
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } }
    }
  }));
});
