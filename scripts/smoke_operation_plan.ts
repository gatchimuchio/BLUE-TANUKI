/** 開発専用。実providerを使わず、loopbackの合成Cと実file.searchをGatewayへ接続する。 */
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import type { OperationPlan, OperationStep } from "@blue-tanuki/protocol";
import type { HDSUpperController } from "@blue-tanuki/hds-brain";

type PlanProjection = ReturnType<HDSUpperController["getRuntimeSnapshot"]>["operation_plans"];
type Pending = { command_id: string; approval_token: string; approval_level: string };
type Snapshot = { hds: { operation_plans: PlanProjection }; pending_approvals: Pending[];
  execution_receipts: { used_for_authority: false; execution_eligible: false; records: Array<{
    ticket_digest: string; command_digest: string; execution_epoch_digest: string; state: string; invocation_boundary?: string }> } };

const root = await mkdtemp(join(tmpdir(), "blue-plan-http-"));
const workspace = join(root, "workspace");
await mkdir(workspace); await writeFile(join(workspace, "blue.txt"), "blue\n");
let candidate: OperationPlan;
let calls = 0;
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    let body = ""; for await (const part of req) body += String(part);
    const messages = JSON.parse(body).messages as Array<{ role: string; content: string }>;
    const requestId = messages.find((message) => message.role === "system" && message.content.includes("固定request_id="))
      ?.content.match(/固定request_id=([^。]+)\u3002/)?.[1];
    assert.ok(requestId);
    const target = { kind: "directory" as const, id: workspace };
    const expected = { root: workspace, sandbox_root: workspace, query: "blue", visited_files: 1,
      matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
    const step = (step_id: string): OperationStep => ({ step_id, operation: "file.search", target, parameters: { root: workspace, query: "blue", max_results: 1 },
      effects: ["read"], state: "planned", permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
        hds_brain_authority_required: true, approval_gate_required: true }, adapter: "internal_runtime", adapter_is_authority: false,
      command_generated_by_adapter_only: false, preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: `check-${step_id}`, method: "result_equals", target, expected }],
        compensation: { available: false, reason: "read-only fixture" } } });
    const dependent = step("dependent"); dependent.preparation!.depends_on = ["search"];
    dependent.preparation!.bindings = [{ source_step_id: "search", output_path: ["matches", "0", "line"], field: "parameters", path: ["query"] }];
    dependent.parameters!.query = "${search.line}";
    candidate = { version: "operation-core.v1", plan_id: "loopback-plan", request_id: requestId, state: "planned",
      steps: [step("search"), dependent], rollback: { available: false },
      raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
      planner_output_used_for_authority: false, hds_brain_authority_required: true };
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(candidate) }, finish_reason: "stop" }], model: "fixture", usage: { total_tokens: 0 } }));
  } catch { res.writeHead(500); res.end("fixture input rejected"); }
});
provider.listen(0, "127.0.0.1"); await once(provider, "listening");
const providerPort = (provider.address() as { port: number }).port;
const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
const gatewayPort = (portProbe.address() as { port: number }).port;
await new Promise<void>((resolve) => portProbe.close(() => resolve()));
const token = "fixture-inbound-plan"; const resumeToken = "fixture-resume-plan";
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { WEBCHAT_PORT: String(gatewayPort), WEBCHAT_HOST: "127.0.0.1", WEBCHAT_TOKEN: token,
  WEBCHAT_RESUME_TOKEN: resumeToken, BLUE_TANUKI_MAINTENANCE_TOKEN: "fixture-maintenance-plan",
  LLM_BACKEND: "openai-compatible", OPENAI_COMPAT_MODEL: "fixture", OPENAI_COMPAT_ENDPOINT: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
  BLUE_TANUKI_FILE_ROOT: workspace, BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"),
  BLUE_TANUKI_SCHEDULES_DIR: join(root, "schedules"), BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
  BLUE_TANUKI_MEMORY_DIR: join(root, "memory"), BLUE_TANUKI_FAILURE_MEMORY_DIR: join(root, "failure-memory"),
  BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl") });
// 既知file.searchはL1。承認失効の疎通には既存ask_every_timeを明示使用する。
env.BLUE_TANUKI_APPROVAL_MODE = "ask_every_time";
const base = `http://127.0.0.1:${gatewayPort}`;
let child: ChildProcess | undefined;
let diagnostics = "";
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
}
async function boot() {
  child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "apps/gateway/src/main.ts", "--serve"],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data) => { diagnostics = (diagnostics + String(data)).slice(-16000); });
  await waitFor(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } });
}
async function json<T>(path: string, body?: unknown, resume = false): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${resume ? resumeToken : token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json() as Promise<T>;
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("local plan smoke did not reach expected state");
}
const invoke = (content: string) => json("/operators/developer/invoke", { user: "fixture-owner", content });
const snapshot = () => json<Snapshot>("/runtime/snapshot");
async function select(step: PlanProjection["plans"][number]["steps"][number]) {
  const state = await snapshot(); const plan = state.hds.operation_plans.plans[0];
  await invoke(`plan:review ${JSON.stringify({ plan_id: plan.plan_id, revision_digest: plan.revision_digest, step_id: step.step_id })}`);
  await waitFor(async () => (await snapshot()).pending_approvals.length === 1);
  return (await snapshot()).pending_approvals[0];
}
const approve = async (pending: Pending) => (await json<{ result: { executed: boolean; status: string } }>("/resume",
  { request_id: pending.command_id, verdict: "approve", approval_token: pending.approval_token }, true)).result;
try {
  await boot(); await invoke("plan:compute 合成ファイルのblueを検索し、その結果から次の検索語を具体化する");
  await waitFor(async () => (await snapshot()).hds.operation_plans.plans.length === 1);
  let state = await snapshot(); const first = await select(state.hds.operation_plans.plans[0].steps[0]);
  assert.equal(first.approval_level, "L1_observe");
  await approve(first);
  await waitFor(async () => (await snapshot()).hds.operation_plans.plans[0].steps[0].status === "verified");
  state = await snapshot(); const stale = await select(state.hds.operation_plans.plans[0].steps[1]);
  const revised = structuredClone(candidate!); revised.steps[1]!.parameters!.max_results = 2;
  await invoke(`plan:revise ${JSON.stringify({ plan_id: state.hds.operation_plans.plans[0].plan_id,
    expected_revision_digest: state.hds.operation_plans.plans[0].revision_digest, plan: revised })}`);
  await waitFor(async () => (await snapshot()).hds.operation_plans.plans[0].revision === 2);
  assert.equal((await snapshot()).pending_approvals.length, 0);
  assert.equal((await approve(stale)).executed, false);
  state = await snapshot(); await approve(await select(state.hds.operation_plans.plans[0].steps[1]));
  await waitFor(async () => (await snapshot()).hds.operation_plans.plans[0].status === "results_verified");
  const projection = (await snapshot()).hds.operation_plans;
  assert.ok(!JSON.stringify(projection).includes(workspace)); assert.ok(!JSON.stringify(projection).includes("loopback-plan"));
  const receipts = (await snapshot()).execution_receipts;
  assert.equal(receipts.used_for_authority, false); assert.equal(receipts.execution_eligible, false);
  const actions = receipts.records.filter((receipt) => receipt.invocation_boundary === "tool_adapter");
  assert.equal(actions.length, 2); assert.ok(actions.every((receipt) => receipt.state === "adapter_returned"));
  assert.ok(receipts.records.some((receipt) => receipt.invocation_boundary === "llm_adapter"));
  assert.ok(!JSON.stringify(receipts).includes(workspace)); assert.ok(!JSON.stringify(receipts).includes("fixture-owner"));
  await stop(); await boot(); state = await snapshot();
  assert.equal(state.hds.operation_plans.plans[0].status, "results_verified"); assert.equal(state.pending_approvals.length, 0);
  assert.equal(calls, 1);
  assert.deepEqual(state.execution_receipts.records, receipts.records);
  const denied = await fetch(`${base}/runtime/snapshot`); assert.equal(denied.status, 401);
  console.log("PASS: loopback C → Developer HTTP → HDS → Approval Gate → durable intent → real file.search → dependent result; revision invalidation; authenticated digest-only receipt after restart");
} catch (error) { console.error(diagnostics); throw error; }
finally { await stop(); await new Promise<void>((resolve) => provider.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
