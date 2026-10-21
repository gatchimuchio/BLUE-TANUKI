/** 開発専用。実providerを使わず、build済みGatewayの結果不明照合をloopbackだけで通す。 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { HDSUpperController, evaluateApproval, operationPlanDigest } from "../packages/hds-brain/dist/index.js";
import { createGmailWriteTool, Executor, createExecutorApprovalAuthority, executorCommandDigest, LLMComputeAdapter,
  LLMRegistry, ToolRegistry, type AgentWorkerLifecycleEvent, type ComputeBudgetPort } from "../packages/blue-tanuki/dist/index.js";
import { createGatewayInternalInboundRequest, type ExecuteCommand, type InboundRequest, type OperationPlan } from "../packages/protocol/dist/index.js";
import { GatewayExecutionIntentStore } from "../apps/gateway/src/execution_intent_store.js";
import { GatewayRuntimeOwnerLease } from "../apps/gateway/src/runtime_owner_lease.js";
import { OperationPlanStateStore } from "../apps/gateway/src/operation_plan_store.js";
import { finalizeCommandOutput } from "../apps/gateway/src/finalize_command_output.js";
import { executionAdmissionForCommand } from "../apps/gateway/src/reconcile_execution_results.js";

const FIXTURE_TOKEN = "receipt-smoke-local-fixture-only";
const GATEWAY_WORKER_PATH = fileURLToPath(new URL("./fixtures/gateway_serve_worker.mjs", import.meta.url));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

interface AcceptedMutation {
  idempotency_key: string;
  command_digest: string;
  payload_digest: string;
  receipt_id: string;
}

interface InspectionFixture {
  server: Server;
  endpoint: Promise<string>;
  status: () => { effects: number; read_queries: number; accepted: AcceptedMutation[] };
}

function inspectionFixture(): InspectionFixture {
  const accepted: AcceptedMutation[] = [];
  let effects = 0;
  let readQueries = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && /^\/reconcile\/[a-f0-9]{64}$/.test(url.pathname)) {
        readQueries += 1;
        const key = url.pathname.slice("/reconcile/".length);
        const matches = accepted.filter((record) => record.idempotency_key === key);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: matches.length === 1 ? "accepted" : matches.length === 0 ? "not_found" : "ambiguous", matches }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/send" ||
          request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}` ||
          request.headers["x-google-path"] !== "/gmail/v1/users/me/messages/send") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request as IncomingMessage) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const key = request.headers["idempotency-key"];
      const commandDigest = request.headers["x-command-digest"];
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) ||
          typeof commandDigest !== "string" || !/^[a-f0-9]{64}$/.test(commandDigest) || !body) {
        response.writeHead(400).end();
        return;
      }
      effects += 1;
      accepted.push({ idempotency_key: key, command_digest: commandDigest, payload_digest: digest(body), receipt_id: `fixture-receipt-${effects}` });
      // 受理後に応答を破棄し、Gateway側では作用結果を不明にする。
      response.destroy();
    })().catch(() => { if (!response.destroyed) response.destroy(); });
  });
  const endpoint = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("inspection_fixture_address_unavailable")); return; }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, endpoint, status: () => ({ effects, read_queries: readQueries, accepted: [...accepted] }) };
}

function internalRequest(content: string): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner", timestamp: Date.now(), content,
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
}

function candidate(requestId: string): OperationPlan {
  const target = { kind: "external_service" as const, id: "gmail" };
  const parameters = { operation: "message.send", to: "inspection@example.invalid", subject: "synthetic D08.01",
    body_text: "local inspection fixture only" };
  return {
    version: "operation-core.v1", plan_id: `receipt-smoke-${requestId}`, request_id: requestId, state: "planned",
    steps: [{ step_id: "send-one", operation: "gmail.write", target, state: "planned", effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api", adapter_is_authority: false, command_generated_by_adapter_only: false, parameters,
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "synthetic-accepted", method: "result_equals", target, expected: { mutation_status: "confirmed" } }],
        compensation: { available: false, reason: "an external send cannot be recalled" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true,
  };
}

type FixtureAuthority = ReturnType<typeof createExecutorApprovalAuthority>;
function approvedFixture(command: ExecuteCommand, authority: FixtureAuthority,
  hdsBinding?: Parameters<FixtureAuthority["approve"]>[3],
  targetVersion?: Parameters<FixtureAuthority["approve"]>[4]) {
  const evaluation = evaluateApproval(command, [], { actor: "fixture-owner", default_mode: "full_access" });
  return authority.approve(command, {
    source: evaluation.final_review_required ? "human_final_review" : "approval_gate",
    decision: evaluation.final_review_required ? "approve" : "allow", approved_by: "fixture-owner", approved_at_ms: Date.now(),
    upstream_commit_hash: command.upstream_decision.commit_hash, operation: evaluation.context.operation, risk: evaluation.risk,
    final_review_required: evaluation.final_review_required, reason: "synthetic local smoke fixture",
  }, executorCommandDigest(command), hdsBinding, targetVersion);
}

async function seedOutcomeUnknown(stateRoot: string, inspectionEndpoint: string, env: NodeJS.ProcessEnv): Promise<void> {
  const ownerLease = GatewayRuntimeOwnerLease.fromEnvironment(env);
  let planStore: OperationPlanStateStore | undefined;
  let executionStore: GatewayExecutionIntentStore | undefined;
  try {
    planStore = new OperationPlanStateStore(join(stateRoot, "private-state", "operation-plans", "j-state.sqlite"));
    executionStore = new GatewayExecutionIntentStore(
      join(stateRoot, "private-state", "execution-intents", "executor.sqlite"), ownerLease.executionEpoch);
    const hds = new HDSUpperController({ operation_plan_state: planStore });
    const tools = new ToolRegistry();
    const gmailTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: FIXTURE_TOKEN }, request: async (target) => {
      const response = await fetch(new URL("/send", inspectionEndpoint), { method: target.method,
        headers: { authorization: `Bearer ${target.token}`, "content-type": target.contentType ?? "application/json",
          "idempotency-key": target.idempotency_key!, "x-command-digest": target.command_digest!, "x-google-path": target.path },
        body: target.body ?? "" });
      return { status: response.status, ok: response.ok, content_type: response.headers.get("content-type"),
        body: await response.text(), truncated: false, request_id: response.headers.get("x-request-id") };
    } });
    tools.register(gmailTool);
    const authority = createExecutorApprovalAuthority({ execution_store: executionStore,
      execution_epoch: ownerLease.executionEpoch, require_hds_execution_binding: true });
    const source = internalRequest("plan:compute send one synthetic message and retain its uncertain outcome");
    const plan = candidate(source.id);
    const candidateBackend = { name: "fixture-candidate-only", call: async () => ({
      content: JSON.stringify(plan), model: "fixture", tokens_used: 0,
    }) };
    const candidateRegistry = new LLMRegistry({ defaultName: candidateBackend.name }).register(candidateBackend, [], {
      capabilities: ["llm_compute_candidate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
    });
    const computeBudget: ComputeBudgetPort = {
      reserve: (input) => ({ reservation_id: `fixture:${input.request_id}`, reserved_tokens: input.reserved_tokens,
        reserved_compute_ms: input.reserved_compute_ms, reserved_cost: { ...input.reserved_cost } }),
      settle: () => {},
    };
    const candidateLifecycleEvents: AgentWorkerLifecycleEvent[] = [];
    const executor = new Executor({ approval_authority: authority, tools, llm: candidateRegistry,
      compute: new LLMComputeAdapter(candidateRegistry, computeBudget),
      on_agent_worker_lifecycle: (event) => { candidateLifecycleEvents.push(event); return true; } });

    const compute = hds.decide(source).command;
    if (!compute || compute.type !== "llm_call") throw new Error("fixture_plan_candidate_not_requested");
    const computeBinding = hds.createExecutionAuthorityBinding(compute);
    const computeFeedback = await executor.execute(approvedFixture(compute, authority, computeBinding));
    if (computeFeedback.result?.operation_core?.status !== "valid_plan") throw new Error("fixture_plan_candidate_rejected");
    finalizeCommandOutput({ hds, command: compute, feedback: computeFeedback, request_id: source.id, target_surface: "channel" });

    const saved = hds.getRuntimeSnapshot().operation_plans.plans[0];
    if (!saved) throw new Error("fixture_plan_not_persisted");
    const reviewRequest = internalRequest(`plan:review ${JSON.stringify({ plan_id: saved.plan_id,
      revision_digest: saved.revision_digest, step_id: operationPlanDigest("send-one") })}`);
    const review = hds.decide(reviewRequest);
    const command = review.command;
    if (!command || command.type !== "tool_call") throw new Error("fixture_send_not_selected_by_j");
    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
    if (!operationPlanBindingDigest) throw new Error("fixture_operation_plan_source_unavailable");
    const targetVersion = await gmailTool.inspect_target_version?.(command.payload.arguments, {
      env: { GMAIL_ACCESS_TOKEN: FIXTURE_TOKEN }, operation_plan_binding_digest: operationPlanBindingDigest,
      command_digest: operationPlanDigest(command),
    });
    if (!targetVersion) throw new Error("fixture_gmail_target_observation_unavailable");
    const hdsBinding = hds.createExecutionAuthorityBinding(command, targetVersion);
    const approved = approvedFixture(command, authority, hdsBinding, targetVersion);
    const admission = executionAdmissionForCommand(command, authority.receipt(approved));
    if (!hds.beginOperationPlanAttempt(command, admission)) throw new Error("fixture_execution_not_admitted");
    const feedback = await executor.execute(approved, { save_result_delivery: true });
    if (feedback.status !== "failed" || feedback.operation_core_result?.action_outcome !== "unknown") {
      throw new Error("fixture_action_did_not_reach_outcome_unknown");
    }
    if (!feedback.operation_core_result || feedback.operation_core_result.used_for_authority !== false) {
      throw new Error("fixture_result_crossed_authority_boundary");
    }
    finalizeCommandOutput({ hds, command, feedback, target_surface: "channel", request_id: review.log.request_id });
    if (hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status !== "outcome_unknown") {
      throw new Error("fixture_hds_did_not_retain_outcome_unknown");
    }
  } finally {
    executionStore?.close();
    planStore?.close();
    ownerLease.close();
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("gateway_fixture_port_unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

type RuntimeSnapshot = {
  hds: { operation_plans: { plans: Array<{ plan_id: string; revision_digest: string; status: string;
    steps: Array<{ step_id: string; status: string; external_receipt_observation?: string }> }> } };
};

async function runScenario(name: "matched" | "endpoint-unset"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `blue-receipt-${name}-`));
  const stateRoot = join(root, "state");
  const inspection = inspectionFixture();
  const inspectionEndpoint = await inspection.endpoint;
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let diagnostics = "";
  const token = `receipt-smoke-${name}-token`;
  const resumeToken = `receipt-smoke-${name}-resume`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { WEBCHAT_PORT: String(port), WEBCHAT_HOST: "127.0.0.1", WEBCHAT_TOKEN: token,
    WEBCHAT_RESUME_TOKEN: resumeToken, BLUE_TANUKI_MAINTENANCE_TOKEN: `receipt-smoke-${name}-maintenance`,
    BLUE_TANUKI_FILE_ROOT: join(root, "workspace"), BLUE_TANUKI_STATE_ROOT: stateRoot,
    BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_SCHEDULES_DIR: join(root, "schedules"),
    BLUE_TANUKI_SESSION_DIR: join(root, "sessions"), BLUE_TANUKI_MEMORY_DIR: join(root, "memory"),
    BLUE_TANUKI_FAILURE_MEMORY_DIR: join(root, "failure-memory"), BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl") });
  if (name === "matched") env.BLUE_TANUKI_LOCAL_INSPECTION_ENDPOINT = inspectionEndpoint;
  const received: string[] = [];

  async function stopChild(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) { child = undefined; return; }
    const activeChild = child;
    const closed = once(activeChild, "close") as Promise<[number | null, NodeJS.Signals | null]>;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timeoutHandle = setTimeout(() => resolve(null), 10_000); });
    if (activeChild.connected) activeChild.send({ type: "shutdown" }, (error) => { if (error) activeChild.kill(); });
    else activeChild.kill();
    const result = await Promise.race([closed, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (result === null) {
      activeChild.kill();
      await closed;
      child = undefined;
      throw new Error("gateway_fixture_graceful_shutdown_timed_out");
    }
    const [code, signal] = result;
    child = undefined;
    if (code !== 0) throw new Error(`gateway_fixture_shutdown_failed:${code ?? signal ?? "unknown"}`);
  }
  async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) throw new Error(`${label}: gateway exited (${child.exitCode}); ${diagnostics}`);
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label}: timed out; ${diagnostics}`);
  }
  async function requestJson<T>(path: string, body?: unknown, resume = false): Promise<T> {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${resume ? resumeToken : token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const responseText = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${responseText}`);
    return JSON.parse(responseText) as T;
  }
  const snapshot = () => requestJson<RuntimeSnapshot>("/runtime/snapshot");
  async function waitForChat(predicate: (message: string) => boolean): Promise<string> {
    await waitFor(async () => received.some(predicate), `${name} chat result`);
    return received.find(predicate)!;
  }

  try {
    await mkdir(join(root, "workspace"), { recursive: true });
    await seedOutcomeUnknown(stateRoot, inspectionEndpoint, env);
    assert.equal(inspection.status().effects, 1, "the seed should create exactly one synthetic local effect");
    assert.equal(inspection.status().read_queries, 0);

    child = fork(GATEWAY_WORKER_PATH, [],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data) => {
      diagnostics = (diagnostics + String(data)).slice(-12000);
    });
    await waitFor(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, `${name} Gateway health`);

    const ticket = await requestJson<{ ticket: string }>("/ws-ticket", { user: "fixture-owner" });
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket.ticket)}`);
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data)) as { kind?: string; content?: string };
        if (message.kind === "channel_send" && typeof message.content === "string") received.push(message.content);
      } catch { /* ignore non-JSON socket frames */ }
    });
    await once(socket, "open");

    const current = await snapshot();
    const plan = current.hds.operation_plans.plans[0];
    const step = plan?.steps[0];
    assert.ok(plan && step, "seeded plan must be visible through runtime snapshot");
    assert.equal(step.status, "outcome_unknown");
    const accepted = await requestJson<{ accepted: boolean; request_id: string }>("/operators/developer/invoke", {
      user: "fixture-owner", content: `plan:reconcile ${JSON.stringify({ plan_id: plan.plan_id,
        revision_digest: plan.revision_digest, step_id: step.step_id })}`,
    });
    assert.equal(accepted.accepted, true);

    if (name === "matched") {
      const message = await waitForChat((text) => text.includes("照合を1回記録しました"));
      assert.ok(message.includes("観測=matched"));
      assert.ok(message.includes("outcome_unknownのままです"));
      assert.ok(!message.includes(inspection.status().accepted[0]!.receipt_id));
      await waitFor(async () => {
        const state = await snapshot();
        const receiptStep = state.hds.operation_plans.plans[0]?.steps[0];
        return receiptStep?.status === "outcome_unknown" && receiptStep.external_receipt_observation === "matched";
      }, "matched receipt projection");
      const state = await snapshot();
      assert.equal(state.hds.operation_plans.plans[0]?.steps[0]?.status, "outcome_unknown");
      assert.ok(!JSON.stringify(state).includes(inspection.status().accepted[0]!.receipt_id));
      assert.equal(inspection.status().effects, 1, "receipt reconciliation must not repeat the external effect");
      assert.equal(inspection.status().read_queries, 1, "one owner request must issue one loopback read");
    } else {
      const message = await waitForChat((text) => text.includes("local_inspection_endpoint_not_configured"));
      assert.ok(message.includes("照合は未実施です"));
      assert.ok(message.includes("outcome_unknownのままです"));
      await waitFor(async () => (await snapshot()).hds.operation_plans.plans[0]?.steps[0]?.status === "outcome_unknown",
        "endpoint-unset status projection");
      assert.equal(inspection.status().effects, 1);
      assert.equal(inspection.status().read_queries, 0, "unset endpoint must not contact the inspection fixture");
    }
  } catch (error) {
    const safeDiagnostics = diagnostics.replaceAll(FIXTURE_TOKEN, "[redacted]");
    throw new Error(`${name} Gateway receipt reconciliation smoke failed: ${String(error)}\n${safeDiagnostics}`);
  } finally {
    socket?.terminate();
    try { await stopChild(); }
    finally {
      await new Promise<void>((resolve, reject) => inspection.server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

await runScenario("matched");
await runScenario("endpoint-unset");
console.log("PASS: build済みGatewayのDeveloper HTTP→HDS→loopback GET→digest-only status projection。endpoint未設定は通信なし。synthetic effectは1回のままで結果不明を維持。");
