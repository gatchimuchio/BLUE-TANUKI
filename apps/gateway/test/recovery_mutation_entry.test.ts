import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_COMPUTE_BUDGET_POLICY } from "@blue-tanuki/core";
import { CompleteHistoryStore, operationPlanDigest, operationPlanTaskIdentityDigest } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointSchema } from "@blue-tanuki/protocol";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";
import { parseEnvFile } from "../src/env_file.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { recoveryStoreRestoreAttemptHistoryEvidence } from "../src/recovery_surface.js";
import { inspectRuntimeRecoveryFence } from "../src/runtime_owner_lease.js";
import { storeLlmApiKeySecret } from "../src/secret_store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const maintenanceToken = "recovery-l3-maintenance-test-token";
const resumeToken = "recovery-l3-owner-resume-test-token";
const inboundToken = "recovery-l3-inbound-test-token";
const secretMarker = "LOCAL_ONLY_RECOVERY_TEST_SECRET";
const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
});

describe("First-use Gateway settings", () => {
  it.runIf(process.platform === "win32").each(["existing protected reference", "fresh native registration"] as const)(
    "activates a native provider through %s only after L3 and reserves the approved budget after restart", async (mode) => {
    const register = mode === "fresh native registration";
    const root = mkdtempSync(join(realpathSync(tmpdir()), "bt-native-activation-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const preload = join(root, "capture-provider.cjs");
    const attemptsFile = join(root, "captured-provider-attempts.jsonl");
    const promptsFile = join(root, "native-prompt.log");
    const fixtureSecret = "synthetic-anthropic-credential-for-dpapi-fixture";
    const model = "fixture-native-text-model";
    const endpoint = "https://api.anthropic.com/v1/messages";
    const port = await reserveLoopbackPort();
    const ownerToken = "activation-fixture-owner-token";
    const settingsToken = "activation-fixture-settings-token";
    const env = { ...isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port),
      BLUE_TANUKI_OWNER_TOKEN: ownerToken, BLUE_TANUKI_SETTINGS_TOKEN: settingsToken };
    delete (env as NodeJS.ProcessEnv).LLM_BACKEND;
    writeFileSync(preload, `const { appendFileSync } = require("node:fs");
const cp = require("node:child_process");
const realSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const script = args?.at(-2) === "-EncodedCommand" ? Buffer.from(args.at(-1), "base64").toString("utf16le") : "";
  if (!script.includes("UseSystemPasswordChar")) return realSpawn(command, args, options);
  appendFileSync(${JSON.stringify(promptsFile)}, "native-prompt\\n");
  const child = new (require("node:events").EventEmitter)();
  child.stdout = new (require("node:stream").PassThrough)();
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.end(Buffer.from(${JSON.stringify(fixtureSecret)}));
    child.emit("close", 0);
  }, 16_000);
  return child;
};
require("node:module").syncBuiltinESMExports();
const attempts = ${JSON.stringify(attemptsFile)};
globalThis.fetch = async (url, init) => {
  if (process.env.BT_ACTIVATION_FIXTURE_COMPUTE !== "1" || url !== ${JSON.stringify(endpoint)} || init?.method !== "POST") {
    appendFileSync(attempts, JSON.stringify({unexpected:true}) + "\\n");
    throw new Error("unexpected network attempt in activation fixture");
  }
  const body = JSON.parse(init.body);
  appendFileSync(attempts, JSON.stringify({endpoint:url,model:body.model,max_tokens:body.max_tokens,
    credential_matched:new Headers(init.headers).get("x-api-key") === ${JSON.stringify(fixtureSecret)},redirect:init.redirect}) + "\\n");
  return new Response(JSON.stringify({model:body.model,content:[{type:"text",text:"青"}],usage:{input_tokens:9,output_tokens:2},stop_reason:"end_turn"}),
    {status:200,headers:{"content-type":"application/json"}});
};`);
    const base = "LLM_BACKEND=stub\nUNRELATED_SETTING=kept\n";
    // Seed the legacy fixture before opening HTTP sockets. Its DPAPI calls can block the test process.
    const stored = register ? undefined : storeLlmApiKeySecret("ANTHROPIC_API_KEY", fixtureSecret, { envFilePath: envFile, env: {} });
    writeFileSync(envFile, base);
    let gateway = spawnGateway(env, preload);
    await waitForHealth(port, gateway, 40_000);

    const activation = { provider: "anthropic", currency: "USD", max_cost_per_attempt_micros: 12_000,
      max_cost_per_24h_micros: 50_000 };
    const submit = (registerCredential = register) => requestJson(port, "/owner/llm-settings-proposal", { method: "POST", token: ownerToken,
      body: { expected_provider: "stub", patch: { llm: { model, max_tokens: 384, timeout_ms: 4_000,
        activation: { ...activation, ...(registerCredential ? { register_credential: true } : {}) } } } },
      ...(registerCredential ? { origin: `http://127.0.0.1:${port}` } : {}),
      signal: AbortSignal.timeout(10_000) });
    expect((await submit(false)).status).toBe(409);
    const eligible = stored ? base + `${stored.ref_key}=${JSON.stringify(stored.ref)}\n` : base;
    writeFileSync(envFile, eligible + 'anthropic_endpoint="https://example.invalid/v1/messages"\n');
    expect((await submit()).status).toBe(409);
    writeFileSync(envFile, eligible + 'ANTHROPIC_ENDPOINT="https://example.invalid/v1/messages"\n');
    expect((await submit()).status).toBe(409);
    writeFileSync(envFile, eligible);
    const proposal = await submit();
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(202);
    expect(proposal.body).toMatchObject({ status: "approval_required", accepted: true, command_id: expect.any(String) });
    expect(readFileSync(envFile, "utf8")).toBe(eligible);
    expect(existsSync(attemptsFile)).toBe(false);
    expect(existsSync(promptsFile)).toBe(false);
    if (register) expect(existsSync(join(root, "secrets"))).toBe(false);

    const commandId = String(proposal.body.command_id);
    const approvalRoute = `/approval/${encodeURIComponent(commandId)}`;
    const queue = await requestJson(port, "/approval", { token: resumeToken, signal: AbortSignal.timeout(10_000) });
    const pending = (queue.body.pending_approvals as Record<string, unknown>[]).find((item) => item.command_id === commandId);
    expect(pending).toMatchObject({ operation: "settings.write", approval_level: "L3_final_review", approval_token: expect.any(String) });
    const review = await fetch(`http://127.0.0.1:${port}${approvalRoute}/content`, { method: "POST",
      headers: { authorization: `Bearer ${resumeToken}` }, signal: AbortSignal.timeout(10_000) });
    expect(review.status).toBe(200);
    expect(review.headers.get("cache-control")).toBe("no-store");
    const reviewText = await review.text();
    expect(reviewText).not.toContain(fixtureSecret);
    if (stored) expect(reviewText).not.toContain(stored.ref);
    const evidence = JSON.parse(reviewText);
    expect(evidence).toMatchObject({ expected_llm_provider: "stub", activation: {
      ...activation, destination: endpoint, protected_reference_configured: !register,
      ...(register ? { credential_registration_required: true } : {}),
    }, changes: expect.arrayContaining([{ key: "llm.provider", before: "stub", after: "anthropic" }]) });
    const approvalBody = { verdict: "approve", approval_token: pending!.approval_token, content_review_digest: evidence.review_digest };
    const nativeApproval = (origin: string) => requestJson(port, `${approvalRoute}/native-credential`, { method: "POST", token: resumeToken,
      body: approvalBody, origin, signal: AbortSignal.timeout(50_000) });
    const ordinaryApproval = () => requestJson(port, approvalRoute, { method: "POST", token: resumeToken,
      body: approvalBody, signal: AbortSignal.timeout(10_000) });
    if (register) {
      expect((await ordinaryApproval()).status).toBe(409);
      expect((await nativeApproval("https://example.invalid")).status).toBe(403);
      expect(existsSync(promptsFile)).toBe(false);
      expect(readFileSync(envFile, "utf8")).toBe(eligible);
    }
    const applied = await (register ? nativeApproval(`http://127.0.0.1:${port}`) : ordinaryApproval());
    const history = readFileSync(join(root, "complete-history.jsonl"), "utf8");
    const diagnostic = `${JSON.stringify(applied.body)}; native prompt started: ${existsSync(promptsFile)}; ` +
      [...new Set(history.match(/\b(?:llm_credential_|settings_write_)[a-z_]+/gu))].join(", ");
    expect(applied.status, diagnostic).toBe(200);
    expect(applied.body).toMatchObject({ result: { approval: "approve", status: "success" } });
    const saved = readFileSync(envFile, "utf8");
    expect(saved).toContain('LLM_BACKEND="anthropic"');
    expect(saved).toContain('UNRELATED_SETTING=kept');
    if (stored) expect(saved).toContain(stored.ref);
    const savedRef = parseEnvFile(saved).values.ANTHROPIC_API_KEY_REF;
    expect(savedRef).toMatch(/^win32-dpapi-current-user:file:/u);
    expect(JSON.stringify(applied.body)).not.toContain(savedRef!);
    expect(JSON.stringify(applied.body)).not.toContain(fixtureSecret);
    expect(saved).not.toContain(fixtureSecret);
    expect(existsSync(attemptsFile)).toBe(false);
    expect(gateway.output.join("")).not.toContain(fixtureSecret);
    expect(history).not.toContain(fixtureSecret);
    expect(history).not.toContain(savedRef!);
    if (register) {
      expect((await nativeApproval(`http://127.0.0.1:${port}`)).status).toBe(409);
      expect((await submit()).status).toBe(409);
      expect(readFileSync(promptsFile, "utf8")).toBe("native-prompt\n");
      expect(readdirSync(join(root, "secrets"))).toHaveLength(1);
    }

    await stopChild(gateway.child);
    gateway = spawnGateway({ ...env, BT_ACTIVATION_FIXTURE_COMPUTE: "1" }, preload);
    await waitForHealth(port, gateway, 60_000);
    const settings = await requestJson(port, "/settings/config", { token: settingsToken, signal: AbortSignal.timeout(10_000) });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ llm: { provider: "anthropic", command_route: { model, max_tokens: "384", timeout_ms: "4000" },
      compute_readiness: { status: "ready", max_cost_amount: 0.012, maximum_provider_attempts: 1, currency: "USD" } } });
    expect(existsSync(attemptsFile)).toBe(false);

    const inbound = await requestJson(port, "/inbound", { method: "POST", token: inboundToken,
      body: { user: "activation-fixture", content: "次の文字だけを返してください。青" }, signal: AbortSignal.timeout(10_000) });
    expect(inbound.status, JSON.stringify(inbound.body)).toBe(202);
    const budgetFile = join(root, "state", "private-state", "compute-budget", "ledger.sqlite");
    const budget = new DatabaseSync(budgetFile, { readOnly: true });
    try {
      await expect.poll(() => budget.prepare(`SELECT reserved_tokens, reserved_cost_micros,
        charged_cost_micros, currency, state FROM compute_budget_reservations`).all(), { timeout: 10_000 })
        .toEqual([{ reserved_tokens: 384, reserved_cost_micros: 12_000, charged_cost_micros: 12_000,
          currency: "USD", state: "settled" }]);
    } finally { budget.close(); }
    await stopChild(gateway.child);
    expect(readFileSync(attemptsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { endpoint, model, max_tokens: 384, credential_matched: true, redirect: "error" },
    ]);
  }, 150_000);

  it.runIf(process.platform === "win32").each(["successful replacement", "failed atomic replacement"] as const)(
    "rotates an active provider credential through L3 and preserves the previous DPAPI entry on %s", async (mode) => {
    const failReplacement = mode === "failed atomic replacement";
    const root = mkdtempSync(join(realpathSync(tmpdir()), "bt-native-rotation-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const secretDir = join(root, "secrets");
    const preload = join(root, "rotation-fixture.cjs");
    const attemptsFile = join(root, "rotation-attempts.jsonl");
    const promptFile = join(root, "native-prompt.log");
    const faultFile = join(root, "rotation-fault.log");
    const oldKey = "synthetic-previous-credential-for-rotation-fixture";
    const newKey = "synthetic-replacement-credential-for-rotation-fixture";
    const model = "fixture-rotation-model";
    const endpoint = "https://api.anthropic.com/v1/messages";
    const ownerToken = "rotation-fixture-owner-token";
    const settingsToken = "rotation-fixture-settings-token";
    const stored = storeLlmApiKeySecret("ANTHROPIC_API_KEY", oldKey, { envFilePath: envFile, env: {} });
    const [oldEntry] = readdirSync(secretDir);
    const oldProtectedValue = readFileSync(join(secretDir, oldEntry!));
    const costLimit = { amount: 0.05, currency: "USD" };
    const budget = { ...DEFAULT_COMPUTE_BUDGET_POLICY,
      system: { ...DEFAULT_COMPUTE_BUDGET_POLICY.system, max_cost: costLimit },
      parent: { ...DEFAULT_COMPUTE_BUDGET_POLICY.parent, max_cost: costLimit },
      task: { ...DEFAULT_COMPUTE_BUDGET_POLICY.task, max_cost: costLimit } };
    const configured = Object.entries({ LLM_BACKEND: "anthropic", ANTHROPIC_MODEL: model, BLUE_TANUKI_LLM_MODEL: model,
      BLUE_TANUKI_LLM_MAX_TOKENS: "384", BLUE_TANUKI_LLM_TIMEOUT_MS: "4000", UNRELATED_SETTING: "kept",
      [stored.ref_key]: stored.ref, BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(budget),
      BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ anthropic: { capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.012, currency: "USD" } } }),
    }).map(([key, value], index) => `${key}=${JSON.stringify(value)}${index % 2 === 0 ? "\r\n" : "\n"}`).join("");
    writeFileSync(envFile, configured);
    writeFileSync(preload, `const fs = require("node:fs");
const cp = require("node:child_process");
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const script = args?.at(-2) === "-EncodedCommand" ? Buffer.from(args.at(-1), "base64").toString("utf16le") : "";
  if (!script.includes("UseSystemPasswordChar")) return originalSpawn(command, args, options);
  fs.appendFileSync(${JSON.stringify(promptFile)}, "native-prompt\\n");
  const child = new (require("node:events").EventEmitter)();
  child.stdout = new (require("node:stream").PassThrough)();
  child.kill = () => true;
  setImmediate(() => {
    child.stdout.end(Buffer.from(${JSON.stringify(newKey)}));
    child.emit("close", 0);
  });
  return child;
};
require("node:module").syncBuiltinESMExports();
const target = ${JSON.stringify(envFile)};
const originalRename = fs.promises.rename;
fs.promises.rename = async (source, destination) => {
  if (process.env.BT_ROTATION_FIXTURE_RENAME_FAIL === "1" && destination === target && source.startsWith(target + ".tmp-")) {
    fs.writeFileSync(${JSON.stringify(faultFile)}, String(fs.readdirSync(${JSON.stringify(secretDir)}).length));
    throw Object.assign(new Error("fixture denied atomic replacement"), { code: "EPERM" });
  }
  return originalRename(source, destination);
};
globalThis.fetch = async (url, init) => {
  const attempts = ${JSON.stringify(attemptsFile)};
  if (url !== ${JSON.stringify(endpoint)} || init?.method !== "POST") {
    fs.appendFileSync(attempts, JSON.stringify({unexpected:true}) + "\\n");
    throw new Error("unexpected network attempt in rotation fixture");
  }
  const key = new Headers(init.headers).get("x-api-key");
  const body = JSON.parse(init.body);
  fs.appendFileSync(attempts, JSON.stringify({endpoint:url, model:body.model, max_tokens:body.max_tokens, redirect:init.redirect,
    old_key_matched:key === ${JSON.stringify(oldKey)}, new_key_matched:key === ${JSON.stringify(newKey)}}) + "\\n");
  return new Response(JSON.stringify({model:body.model,content:[{type:"text",text:"青"}],usage:{input_tokens:9,output_tokens:2},stop_reason:"end_turn"}),
    {status:200,headers:{"content-type":"application/json"}});
};`);
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...isolatedRuntimeEnvironment(root, envFile, historyFile, port),
      BLUE_TANUKI_OWNER_TOKEN: ownerToken, BLUE_TANUKI_SETTINGS_TOKEN: settingsToken,
      ...(failReplacement ? { BT_ROTATION_FIXTURE_RENAME_FAIL: "1" } : {}) };
    delete env.LLM_BACKEND;
    let gateway = spawnGateway(env, preload);
    await waitForHealth(port, gateway, 60_000);
    const settings = await requestJson(port, "/settings/config", { token: settingsToken, signal: AbortSignal.timeout(10_000) });
    expect(settings.status, gateway.output.join("")).toBe(200);
    expect(settings.body).toMatchObject({ llm: { provider: "anthropic", native_credential_rotation_available: true } });
    const submit = (requestOrigin = origin) => requestJson(port, "/owner/llm-settings-proposal", {
      method: "POST", token: ownerToken, origin: requestOrigin, signal: AbortSignal.timeout(10_000),
      body: { expected_provider: "anthropic", patch: { llm: { rotate_credential: true } } },
    });
    if (!failReplacement) {
      expect((await submit("https://example.invalid")).status).toBe(403);
      for (const override of ['ANTHROPIC_ENDPOINT="https://example.invalid/v1/messages"\n',
        `ANTHROPIC_API_KEY=${JSON.stringify(oldKey)}\n`, 'BLUE_TANUKI_POWERSHELL="fixture-untrusted-helper.exe"\n']) {
        writeFileSync(envFile, configured + override);
        expect((await submit()).status).toBe(409);
        expect(readFileSync(envFile, "utf8")).toBe(configured + override);
      }
      writeFileSync(envFile, configured);
    }
    const proposal = await submit();
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(202);
    expect(proposal.body).toMatchObject({ status: "approval_required", command_id: expect.any(String) });
    const commandId = String(proposal.body.command_id);
    const approvalRoute = `/approval/${encodeURIComponent(commandId)}`;
    const queue = await requestJson(port, "/approval", { token: resumeToken, signal: AbortSignal.timeout(10_000) });
    const pending = (queue.body.pending_approvals as Record<string, unknown>[]).find((item) => item.command_id === commandId);
    expect(pending).toMatchObject({ operation: "settings.write", approval_level: "L3_final_review", approval_token: expect.any(String) });
    const review = async (): Promise<string> => {
      const response = await fetch(`${origin}${approvalRoute}/content`, { method: "POST",
        headers: { authorization: `Bearer ${resumeToken}` }, signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const evidence = JSON.parse(body) as Record<string, unknown>;
      expect(evidence).toMatchObject({ expected_llm_provider: "anthropic", no_store: true,
        review_digest: expect.any(String), credential_rotation: { provider: "anthropic", destination: endpoint,
          protected_reference_configured: true }, changes: [{ key: "llm.credential_reference", before: "protected", after: "replace_on_restart" }] });
      for (const privateValue of [oldKey, newKey, stored.ref]) expect(body).not.toContain(privateValue);
      return String(evidence.review_digest);
    };
    const approve = (digest: string, native = true, requestOrigin = origin) => requestJson(port,
      native ? `${approvalRoute}/native-credential` : approvalRoute, { method: "POST", token: resumeToken, origin: requestOrigin,
        body: { verdict: "approve", approval_token: pending!.approval_token, content_review_digest: digest },
        signal: AbortSignal.timeout(45_000) });
    let approvedEnv = configured;
    let digest = await review();
    if (!failReplacement) {
      expect((await approve(digest, false)).status).toBe(409);
      expect((await approve(digest, true, "https://example.invalid")).status).toBe(403);
      approvedEnv = configured + "# target version changed after review\n";
      writeFileSync(envFile, approvedEnv);
      expect((await approve(digest)).status).toBe(409);
      const freshDigest = await review();
      expect(freshDigest).not.toBe(digest);
      digest = freshDigest;
    }
    expect(existsSync(promptFile)).toBe(false);
    expect(existsSync(attemptsFile)).toBe(false);
    expect(readFileSync(envFile, "utf8")).toBe(approvedEnv);
    expect(readdirSync(secretDir)).toEqual([oldEntry]);

    const result = await approve(digest);
    const saved = readFileSync(envFile, "utf8");
    const savedRef = parseEnvFile(saved).values[stored.ref_key];
    expect(readFileSync(promptFile, "utf8")).toBe("native-prompt\n");
    expect(readFileSync(join(secretDir, oldEntry!))).toEqual(oldProtectedValue);
    expect(existsSync(attemptsFile)).toBe(false);
    if (failReplacement) {
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(readFileSync(faultFile, "utf8")).toBe("2");
      expect(saved).toBe(approvedEnv);
      expect(readdirSync(secretDir)).toEqual([oldEntry]);
    } else {
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ result: { approval: "approve", status: "success" } });
      expect(savedRef).toMatch(/^win32-dpapi-current-user:file:/u);
      expect(savedRef).not.toBe(stored.ref);
      expect(saved).toBe(approvedEnv.replace(JSON.stringify(stored.ref), JSON.stringify(savedRef)));
      expect(readdirSync(secretDir)).toHaveLength(2);
      const backup = readdirSync(root).find((name) => name.startsWith("product.env.") && name.endsWith(".settings-write.bak"));
      expect(backup).toEqual(expect.any(String));
      expect(readFileSync(join(root, backup!), "utf8")).toBe(approvedEnv);
      expect((await approve(digest)).status).toBe(409);
      expect((await submit()).status).toBe(409);
    }
    for (const privateValue of [oldKey, newKey, stored.ref, savedRef!]) {
      expect(JSON.stringify(result.body)).not.toContain(privateValue);
      expect(readFileSync(historyFile, "utf8")).not.toContain(privateValue);
      expect(gateway.output.join("")).not.toContain(privateValue);
    }
    for (const privateValue of [oldKey, newKey]) expect(saved).not.toContain(privateValue);

    const invoke = async (user: string, old: boolean, attemptCount: number) => {
      const inbound = await requestJson(port, "/inbound", { method: "POST", token: inboundToken,
        body: { user, content: "次の文字だけを返してください。青" }, signal: AbortSignal.timeout(10_000) });
      expect(inbound.status, JSON.stringify(inbound.body)).toBe(202);
      await expect.poll(() => existsSync(attemptsFile) ? readFileSync(attemptsFile, "utf8").split("\n").length - 1 : 0,
        { timeout: 10_000 }).toBe(attemptCount);
      expect(JSON.parse(readFileSync(attemptsFile, "utf8").trim().split("\n").at(-1)!)).toEqual({
        endpoint, model, max_tokens: 384, redirect: "error", old_key_matched: old, new_key_matched: !old,
      });
      const ledger = new DatabaseSync(join(root, "state", "private-state", "compute-budget", "ledger.sqlite"), { readOnly: true });
      try {
        await expect.poll(() => ledger.prepare("SELECT state FROM compute_budget_reservations").all(), { timeout: 10_000 })
          .toEqual(Array.from({ length: attemptCount }, () => ({ state: "settled" })));
      } finally { ledger.close(); }
    };
    await invoke("rotation-fixture-before-restart", true, 1);
    await stopChild(gateway.child);
    gateway = spawnGateway(env, preload);
    await waitForHealth(port, gateway, 60_000);
    await invoke("rotation-fixture-after-restart", failReplacement, 2);
  }, 180_000);

  it("applies exact owner-selected settings through L3 without a planning provider and uses them after restart", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "bt-first-use-settings-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const port = await reserveLoopbackPort();
    const ownerToken = "first-use-settings-owner-token";
    const settingsToken = "first-use-settings-read-token";
    const env = { ...isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port),
      BLUE_TANUKI_OWNER_TOKEN: ownerToken, BLUE_TANUKI_SETTINGS_TOKEN: settingsToken };
    delete (env as NodeJS.ProcessEnv).LLM_BACKEND;
    const configuredEnv = "LLM_BACKEND=stub\nBLUE_TANUKI_LLM_MAX_TOKENS=1024\nUNRELATED_SETTING=kept\n";
    writeFileSync(envFile, configuredEnv);
    let gateway = spawnGateway(env);
    await waitForHealth(port, gateway, 40_000);

    const route = "/owner/llm-settings-proposal";
    const patch = { llm: { model: "fixture-model", max_tokens: 512 } };
    const submit = (token: string, expected_provider = "stub") => requestJson(port, route, {
      method: "POST", token, body: { expected_provider, patch }, signal: AbortSignal.timeout(10_000),
    });
    expect((await submit(settingsToken)).status).toBe(401);
    expect((await submit(inboundToken)).status).toBe(401);
    expect((await submit(ownerToken, "openai")).status).toBe(409);
    const proposal = await submit(ownerToken);
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(202);
    expect(proposal.body).toMatchObject({ accepted: true, status: "approval_required", command_id: expect.any(String),
      used_for_authority: false, may_execute: false });
    expect(readFileSync(envFile, "utf8")).toBe(configuredEnv);

    const commandId = String(proposal.body.command_id);
    const approvalRoute = `/approval/${encodeURIComponent(commandId)}`;
    const queue = await requestJson(port, "/approval", { token: resumeToken, signal: AbortSignal.timeout(10_000) });
    const pending = (queue.body.pending_approvals as Record<string, unknown>[]).find((entry) => entry.command_id === commandId);
    expect(pending).toMatchObject({ operation: "settings.write", approval_level: "L3_final_review",
      final_review_required: true, content_review_required: true, approval_token: expect.any(String) });
    const approve = (digest?: string) => requestJson(port, approvalRoute, { method: "POST", token: resumeToken,
      body: { verdict: "approve", approval_token: pending!.approval_token,
        ...(digest ? { content_review_digest: digest } : {}) }, signal: AbortSignal.timeout(10_000) });
    const review = async () => {
      const result = await fetch(`http://127.0.0.1:${port}${approvalRoute}/content`, { method: "POST",
        headers: { authorization: `Bearer ${resumeToken}` }, signal: AbortSignal.timeout(10_000) });
      const body = await result.json() as Record<string, unknown>;
      expect(result.status, JSON.stringify(body)).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(body).toMatchObject({ expected_llm_provider: "stub", no_store: true, review_digest: expect.any(String),
        changes: expect.arrayContaining([
          { key: "llm.model", before: null, after: "fixture-model" },
          { key: "llm.max_tokens", before: 1024, after: 512 },
        ]) });
      return String(body.review_digest);
    };
    expect((await approve()).status).toBe(409);
    const staleReview = await review();
    const changedEnv = configuredEnv + "# exact target changed after review\n";
    writeFileSync(envFile, changedEnv);
    expect((await approve(staleReview)).status).toBe(409);
    expect(readFileSync(envFile, "utf8")).toBe(changedEnv);
    const freshReview = await review();
    expect(freshReview).not.toBe(staleReview);
    const accepted = await approve(freshReview);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ result: { approval: "approve", status: "success" } });
    const saved = readFileSync(envFile, "utf8");
    expect(saved).toContain('BLUE_TANUKI_LLM_MODEL="fixture-model"');
    expect(saved).toContain('BLUE_TANUKI_LLM_MAX_TOKENS="512"');
    expect(saved).toContain("UNRELATED_SETTING=kept\n# exact target changed after review");
    let replay = await approve(freshReview);
    if (replay.status === 429) {
      const delayMs = Number(replay.body.retry_after_ms);
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(2_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs + 50));
      replay = await approve(freshReview);
    }
    expect(replay.status).toBe(409);
    expect(readFileSync(envFile, "utf8")).toBe(saved);

    await stopChild(gateway.child);
    gateway = spawnGateway(env);
    await waitForHealth(port, gateway, 40_000);
    const active = await requestJson(port, "/settings/config", { token: settingsToken, signal: AbortSignal.timeout(10_000) });
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ llm: { provider: "stub", command_route: { model: "fixture-model", max_tokens: "512" } } });
    expect((await submit(ownerToken)).status).toBe(409);

    await stopChild(gateway.child);
    gateway = spawnGateway({ ...env, BLUE_TANUKI_LLM_MAX_TOKENS: "256" });
    await waitForHealth(port, gateway, 40_000);
    const overridden = await requestJson(port, route, { method: "POST", token: ownerToken,
      body: { expected_provider: "stub", patch: { llm: { max_tokens: 768 } } }, signal: AbortSignal.timeout(10_000) });
    expect(overridden.status).toBe(409);
    expect(readFileSync(envFile, "utf8")).toBe(saved);
  }, 150_000);
});

describe("Recovery mutation HDS L3 entry", () => {
  it("requires L3 and refuses a factory-reset target overlapping the active audit store", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "blue-tanuki-factory-reset-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const auditDir = join(root, "audit");
    const marker = join(auditDir, "preserve.txt");
    const configuredEnv = "LLM_BACKEND=stub\nCOMPOSIO_DRY_RUN=false\n";
    mkdirSync(auditDir);
    writeFileSync(marker, "retained audit fixture\n");
    writeFileSync(envFile, configuredEnv);
    const port = await reserveLoopbackPort();
    const runtimeEnv = {
      ...isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port),
      BLUE_TANUKI_LOG_DIR: auditDir,
    };
    const gateway = spawnGateway(runtimeEnv);
    await waitForHealth(port, gateway, 40_000);
    const queued = await requestJson(port, "/recovery/factory-reset", {
      method: "POST",
      token: maintenanceToken,
      body: { confirm: "FACTORY_RESET" },
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    expect(queued.body).toMatchObject({ result: {
      status: "approval_required", executed: false, operation: "recovery.factory_reset",
      approval_level: "L3_final_review", final_review_required: true,
    } });
    expect(readFileSync(envFile, "utf8")).toBe(configuredEnv);
    const queue = await requestJson(port, "/approval", { token: resumeToken });
    const pending = (queue.body.pending_approvals as Array<Record<string, string>>)
      .find(item => item.operation === "recovery.factory_reset")!;
    const commandId = pending.command_id!;
    const approved = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
      method: "POST",
      token: resumeToken,
      body: { verdict: "approve", approval_token: pending.approval_token },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ result: { approval: "approve", status: "failed" } });
    expect(readFileSync(envFile, "utf8")).toBe(configuredEnv);
    expect(readFileSync(marker, "utf8")).toBe("retained audit fixture\n");
    expect(existsSync(join(root, "recovery"))).toBe(false);
    expect(readdirSync(root).filter(name => name.startsWith("product.env."))).toEqual([]);
    expect(inspectRuntimeRecoveryFence(runtimeEnv).status).toBe("clear");

    const brokerPath = join(root, "state", "private-state", "execution-intents", "executor.sqlite");
    const broker = new DatabaseSync(brokerPath, { readOnly: true });
    try {
      const commandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", commandId])).digest("hex");
      const row = broker.prepare("SELECT receipt_json FROM execution_intents WHERE command_key=?").get(commandKey);
      expect(JSON.parse(String(row?.receipt_json))).toMatchObject({
        state: "outcome_unknown",
        feedback_status: "failed",
        error_digest: createHash("sha256").update("factory_reset_target_protected").digest("hex"),
      });
    } finally {
      broker.close();
    }
  }, 60_000);

  it("settles the durable hold only after a factory reset verifies its persisted changes", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "blue-tanuki-factory-reset-completed-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "fixture.txt"), "old session fixture\n");
    writeFileSync(envFile, "LLM_BACKEND=stub\nCOMPOSIO_DRY_RUN=false\n");
    const port = await reserveLoopbackPort();
    const env = isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port);
    const gateway = spawnGateway(env);
    await waitForHealth(port, gateway, 40_000);
    const queued = await requestJson(port, "/recovery/factory-reset", {
      method: "POST", token: maintenanceToken, body: { confirm: "FACTORY_RESET" },
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const queue = await requestJson(port, "/approval", { token: resumeToken });
    const pending = (queue.body.pending_approvals as Array<Record<string, string>>)
      .find(item => item.operation === "recovery.factory_reset")!;
    const approved = await requestJson(port, `/approval/${encodeURIComponent(pending.command_id!)}`, {
      method: "POST", token: resumeToken, body: { verdict: "approve", approval_token: pending.approval_token },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ result: { approval: "approve", executed: true, status: "success" } });
    expect(existsSync(sessionDir)).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain("COMPOSIO_DRY_RUN=true");
    expect(inspectRuntimeRecoveryFence(env).status).toBe("clear");
  }, 60_000);

  it("reconstructs a persisted operation-plan restore hold during Gateway startup and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-startup-plan-hold-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const seededPlan = seedOperationPlanState(planStatePath);
    const planIdDigest = seededPlan.plan_id_digest;
    const restoreCommand = {
      type: "tool_call",
      payload: {
        tool_name: "recovery.restore",
        arguments: { backup_id: "synthetic-backup-id", store_key: "operation_plans" },
      },
    };
    const restoreAttempt = recoveryStoreRestoreAttemptHistoryEvidence(restoreCommand);
    expect(restoreAttempt).toMatchObject({ schema_version: 1, store_key: "operation_plans" });
    const commandId = "synthetic-failed-plan-restore";
    const resultDigest = createHash("sha256").update("synthetic failed restore result").digest("hex");
    const timestamp = Date.now() - 10_000;
    const history = new CompleteHistoryStore({ filepath: historyFile });
    history.append({
      kind: "execution_history",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp,
      payload: {
        command: {
          operation: "recovery.restore",
          payload: {
            tool_name: "recovery.restore",
            arguments_digest: createHash("sha256").update("synthetic restore arguments").digest("hex"),
          },
        },
        status: "failed",
        result_present: true,
        result_digest: resultDigest,
        recovery_store_restore_attempt: restoreAttempt,
      },
    });
    history.append({
      kind: "final_output",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp: timestamp + 1,
      payload: {
        status: "failed",
        result_present: true,
        result_digest: resultDigest,
        used_for_authority: false,
      },
    });
    expect(history.verify()).toBe(true);
    expect(history.size()).toBe(2);
    expect(history.replay().every((entry) => entry.used_for_authority === false)).toBe(true);
    expect(JSON.stringify(history.replay())).not.toContain("synthetic-backup-id");

    let gateway: ReturnType<typeof spawnGateway> | undefined;
    let webSocket: WebSocket | undefined;
    let freshPlanRequestId: string | undefined;
    let freshReviewRequestId: string | undefined;
    try {
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(port, gateway);
      const firstRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(firstRuntime.body.hds.operation_plans, gateway.output.join("")).toMatchObject({
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: [{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }],
      });

      await stopChild(gateway.child);
      gateway = undefined;

      const persistedStore = new OperationPlanStateStore(planStatePath);
      try {
        const persistedHoldState = persistedStore.loadRecoveryHoldState();
        expect(persistedHoldState).toMatchObject({
          schema_version: "operation-plan-recovery-holds.v1",
          holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified",
            provenance: { source: "recovery_restore", restore_store_key: "operation_plans" } }],
          used_for_authority: false,
          may_execute: false,
        });
        expect(JSON.stringify(persistedHoldState)).not.toContain("synthetic-backup-id");
        expect(JSON.stringify(persistedHoldState)).not.toContain(commandId);
      } finally {
        persistedStore.close();
      }

      writeFileSync(historyFile, "", "utf8");
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(port, gateway);
      const restartedRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(restartedRuntime.body.hds.operation_plans.plans, gateway.output.join(""))
        .toMatchObject([{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }]);
      expect(restartedRuntime.body.operation_plan_status, gateway.output.join(""))
        .toMatchObject({
          schema_version: "operation-plan.status.v1",
          status: "available",
          used_for_authority: false,
          raw_payload_exposed: false,
          plans: [{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }],
        });
      const controlCenterResponse = await fetch(`http://127.0.0.1:${port}/`);
      expect(controlCenterResponse.status, gateway.output.join(""))
        .toBe(200);
      const controlCenterHtml = await controlCenterResponse.text();
      expect(controlCenterHtml).toContain("renderOperationPlanStatus(body.operation_plan_status)");
      expect(controlCenterHtml).toContain("復元履歴未確認（step選択停止中）");
      expect(controlCenterHtml).toContain("状態を確認後に続ける場合は、新しい依頼から新規計画を作成してください。");
      expect(controlCenterHtml).toContain('id="inspect-recovery-ledgers"');
      expect(controlCenterHtml).toContain('fetchJson("/recovery/inspection", token)');

      const recoveryInspection = await requestJson(port, "/recovery/inspection", { token: maintenanceToken });
      expect(recoveryInspection.status, gateway.output.join("")).toBe(200);
      expect(recoveryInspection.body, gateway.output.join("")).toMatchObject({
        surface: "recovery_inspection_operator",
        mode: "read_only",
        used_for_authority: false,
        may_execute: false,
        plan_dependency_scopes: expect.arrayContaining([
          expect.objectContaining({ plan_id_digest: planIdDigest }),
        ]),
      });
      const recoveryInspectionJson = JSON.stringify(recoveryInspection.body);
      expect(recoveryInspectionJson).not.toContain("restore-review-plan");
      expect(recoveryInspectionJson).not.toContain("synthetic-backup-id");

      const ticketResponse = await requestJson(port, "/ws-ticket", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner" },
      });
      expect(ticketResponse.status, JSON.stringify(ticketResponse.body)).toBe(200);
      const ticket = ticketResponse.body.ticket as string;
      webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
      await once(webSocket, "open");
      const displayedDecision = waitForWebChatSend(webSocket);

      const reviewContent = `plan:review ${JSON.stringify({
        plan_id: planIdDigest,
        revision_digest: seededPlan.revision_digest,
        step_id: "restore-review-step",
      })}`;
      const reviewRequest = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: reviewContent },
      });
      expect(reviewRequest.status, `${JSON.stringify(reviewRequest.body)}\n${gateway.output.join("")}`).toBe(202);
      const reviewRequestId = reviewRequest.body.request_id as string;
      expect(reviewRequestId).toEqual(expect.any(String));
      await waitForHistoryDecision(port, gateway, reviewRequestId);
      const userFacingDecision = await displayedDecision;
      expect(userFacingDecision).toContain("plan_control_denied:plan_recovery_unverified_hold");
      expect(userFacingDecision).toContain("Control Centerで復旧状態を読み取り確認してください。");
      expect(userFacingDecision).toContain("Recovery画面の「回復台帳を読み取り検査」を実行してください。");
      expect(userFacingDecision).toContain("新しい依頼から新規計画を作成してください。");
      expect(userFacingDecision).toContain("保留中の計画レビューは再試行しないでください。");

      const syntheticProvider = await startSyntheticPlanProvider();
      const freshPlanRuntimeEnv = {
        ...runtimeEnv,
        LLM_BACKEND: "synthetic-plan-provider",
          BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
          BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({
            "synthetic-plan-provider": { capabilities: ["llm.text.generate"],
              max_cost_per_attempt: { amount: 0, currency: "USD" } },
          }),
        LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "synthetic-plan-provider",
          endpoint: syntheticProvider.endpoint,
          model: "synthetic-plan-model",
        }]),
        BLUE_TANUKI_APPROVAL_MODE: "ask_every_time",
      };
      try {
        webSocket.close();
        webSocket = undefined;
        await stopChild(gateway.child);
        gateway = undefined;
        gateway = spawnGateway(freshPlanRuntimeEnv);
        await waitForHealth(port, gateway);

        const freshTicketResponse = await requestJson(port, "/ws-ticket", {
          method: "POST",
          token: inboundToken,
          body: { user: "fixture-owner" },
        });
        expect(freshTicketResponse.status, gateway.output.join("")).toBe(200);
        webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(freshTicketResponse.body.ticket as string)}`);
        await once(webSocket, "open");

        const freshPlanReply = waitForWebChatSend(webSocket);
        const freshPlanRequest = await requestJson(port, "/operators/developer/invoke", {
          method: "POST",
          token: inboundToken,
          body: { user: "fixture-owner", content: "plan:compute synthetic fresh request after recovery hold" },
        });
        expect(freshPlanRequest.status, `${JSON.stringify(freshPlanRequest.body)}\n${gateway.output.join("")}`).toBe(202);
        freshPlanRequestId = freshPlanRequest.body.request_id as string;
        await waitForHistoryDecision(port, gateway, freshPlanRequestId);
        const freshPlanMessage = await freshPlanReply;
        const providerCallsAfterCompute = syntheticProvider.callCount();
        expect(providerCallsAfterCompute,
          `${freshPlanMessage}\nprovider_request_ids=${JSON.stringify(syntheticProvider.requestIds())}\n${gateway.output.join("")}`).toBe(5);

        let freshRuntime: { body: Record<string, unknown> } | undefined;
        const planDeadline = Date.now() + 5_000;
        while (Date.now() < planDeadline) {
          freshRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
          const plans = ((freshRuntime.body.hds as { operation_plans?: { plans?: Array<Record<string, unknown>> } })
            .operation_plans?.plans ?? []);
          if (plans.length === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const retainedPlans = ((freshRuntime?.body.hds as { operation_plans?: { plans?: Array<Record<string, unknown>> } })
          .operation_plans?.plans ?? []);
        expect(retainedPlans, `${freshPlanMessage}\nprovider_calls=${syntheticProvider.callCount()} ` +
          `provider_failure=${syntheticProvider.failureReason() ?? "none"}\n${gateway.output.join("")}`).toHaveLength(2);
        const heldPlan = retainedPlans.find((plan) => plan.plan_id === planIdDigest);
        const freshPlan = retainedPlans.find((plan) => plan.plan_id !== planIdDigest);
        expect(heldPlan).toMatchObject({ recovery_hold_reason: "held_unverified" });
        expect(freshPlan).toMatchObject({ request_id: `operation-request:${freshPlanRequestId}`, status: "awaiting_step_review" });

        const freshReviewRequest = await requestJson(port, "/operators/developer/invoke", {
          method: "POST",
          token: inboundToken,
          body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
            plan_id: freshPlan!.plan_id,
            revision_digest: freshPlan!.revision_digest,
            step_id: (freshPlan!.steps as Array<Record<string, unknown>>)[0]!.step_id,
          })}` },
        });
        expect(freshReviewRequest.status, `${JSON.stringify(freshReviewRequest.body)}\n${gateway.output.join("")}`).toBe(202);
        freshReviewRequestId = freshReviewRequest.body.request_id as string;
        await waitForHistoryDecision(port, gateway, freshReviewRequestId);

        const reviewedRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
        expect(reviewedRuntime.body.pending_approvals, gateway.output.join("")).toMatchObject([
          { request_id: freshReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" },
        ]);
        expect(((reviewedRuntime.body.hds as { operation_plans: { plans: Array<Record<string, unknown>> } })
          .operation_plans.plans.find((plan) => plan.plan_id === planIdDigest)))
          .toMatchObject({ recovery_hold_reason: "held_unverified" });
        // Current plan compute uses four bounded child roles plus one parent synthesis call.
        expect(syntheticProvider.callCount(), `provider calls after compute=${providerCallsAfterCompute}`).toBe(5);

        const combinedRecoveryInspection = await requestJson(port, "/recovery/inspection", { token: maintenanceToken });
        expect(combinedRecoveryInspection.status, gateway.output.join("")).toBe(200);
        const inspectedPlanDigests = [planIdDigest, operationPlanDigest("fresh-request-plan")];
        expect(combinedRecoveryInspection.body).toMatchObject({
          surface: "recovery_inspection_operator",
          mode: "read_only",
          used_for_authority: false,
          may_execute: false,
          ledgers: { operation_plans: "verified" },
          operation_plan_residual_count: 0,
        });
        const inspectedPlanScopes = (combinedRecoveryInspection.body.plan_dependency_scopes as Array<Record<string, unknown>>)
          .filter((scope) => inspectedPlanDigests.includes(scope.plan_id_digest as string));
        expect(inspectedPlanScopes).toHaveLength(2);
        expect(inspectedPlanScopes).toEqual(expect.arrayContaining([
          expect.objectContaining({
            plan_id_digest: planIdDigest,
            status: "observed",
            integrity: "verified",
            residual_dependencies: [],
            unobserved_dependencies: [],
          }),
          expect.objectContaining({
            plan_id_digest: operationPlanDigest("fresh-request-plan"),
            status: "observed",
            integrity: "verified",
            residual_dependencies: [],
            unobserved_dependencies: [],
          }),
        ]));
        expect(JSON.stringify(combinedRecoveryInspection.body)).not.toContain("restore-review-plan");
        expect(JSON.stringify(combinedRecoveryInspection.body)).not.toContain("fresh-request-plan");

        const planInspectionDatabase = new DatabaseSync(planStatePath);
        try {
          const row = planInspectionDatabase.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id=1").get() as
            { checkpoint_json: string } | undefined;
          if (!row) throw new Error("Operation Plan checkpoint disappeared during the test");
          const currentCheckpoint = OperationPlanCheckpointSchema.parse(JSON.parse(row.checkpoint_json) as unknown);
          const damagedCheckpoint = OperationPlanCheckpointSchema.parse({
            ...currentCheckpoint,
            plans: currentCheckpoint.plans.map((planState) => planState.revisions[0]?.plan.plan_id !== "restore-review-plan"
              ? planState
              : {
                  ...planState,
                  revisions: planState.revisions.map((revision, index) => index === 0
                    ? { ...revision, digest: operationPlanDigest("synthetic-damaged-old-plan-revision") }
                    : revision),
                }),
          });
          const damagedJson = JSON.stringify(damagedCheckpoint);
          planInspectionDatabase.prepare("UPDATE operation_plan_state SET checkpoint_json=?,digest=? WHERE id=1")
            .run(damagedJson, operationPlanDigest(damagedCheckpoint));
        } finally {
          planInspectionDatabase.close();
        }
        const planInspectionStore = new OperationPlanStateStore(planStatePath);
        try {
          expect(planInspectionStore.loadRecoveryHoldState()).toMatchObject({
            holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified" }],
            used_for_authority: false,
            may_execute: false,
          });
        } finally {
          planInspectionStore.close();
        }

        const residualInspection = await requestJson(port, "/recovery/inspection", { token: maintenanceToken });
        expect(residualInspection.status, gateway.output.join("")).toBe(200);
        expect(residualInspection.body).toMatchObject({
          ledgers: { operation_plans: "residuals_present" },
          operation_plan_residual_count: 1,
          used_for_authority: false,
          may_execute: false,
        });
        const residualPlanScopes = (residualInspection.body.plan_dependency_scopes as Array<Record<string, unknown>>)
          .filter((scope) => inspectedPlanDigests.includes(scope.plan_id_digest as string));
        expect(residualPlanScopes).toHaveLength(2);
        expect(residualPlanScopes).toEqual(expect.arrayContaining([
          expect.objectContaining({
            plan_id_digest: planIdDigest,
            status: "residuals_present",
            integrity: "residuals_present",
            residual_dependencies: ["operation_plan"],
          }),
          expect.objectContaining({
            plan_id_digest: operationPlanDigest("fresh-request-plan"),
            status: "observed",
            integrity: "verified",
            residual_dependencies: [],
            unobserved_dependencies: [],
          }),
        ]));
        expect(JSON.stringify(residualInspection.body)).not.toContain("restore-review-plan");
        expect(JSON.stringify(residualInspection.body)).not.toContain("fresh-request-plan");
      } finally {
        await syntheticProvider.close();
      }

      await stopChild(gateway.child);
      gateway = undefined;

      const reviewHistory = new CompleteHistoryStore({ filepath: historyFile });
      const reviewDecisions = reviewHistory.replay({ kind: "hds_decision", request_id: reviewRequestId });
      expect(reviewDecisions).toHaveLength(1);
      expect(reviewDecisions[0]?.payload).toMatchObject({
        decision: "FAIL",
        reason: "plan_control_denied:plan_recovery_unverified_hold",
        command: null,
      });
      const reviewExecution = reviewHistory.replay({ kind: "execution_history", request_id: reviewRequestId });
      expect(reviewExecution).toHaveLength(0);

      const freshPlanHistory = reviewHistory.replay({ kind: "hds_decision", request_id: freshPlanRequestId! });
      expect(freshPlanHistory).toHaveLength(1);
      const freshReviewHistory = reviewHistory.replay({ kind: "hds_decision", request_id: freshReviewRequestId! });
      expect(freshReviewHistory).toHaveLength(1);
      const freshReviewExecution = reviewHistory.replay({ kind: "execution_history", request_id: freshReviewRequestId! });
      expect(freshReviewExecution).toHaveLength(0);

      const restartedStore = new OperationPlanStateStore(planStatePath);
      try {
        expect(restartedStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified",
            provenance: { source: "recovery_restore", restore_store_key: "operation_plans" } }],
          used_for_authority: false,
          may_execute: false,
        });
        expect(restartedStore.load()?.plans.map((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id)))
          .toEqual([operationPlanDigest("fresh-request-plan")]);
      } finally {
        restartedStore.close();
      }
    } finally {
      webSocket?.close();
      if (gateway) await stopChild(gateway.child);
    }
  }, 30_000);

  it("reconstructs a failed Broker restore as a fail-closed Operation Plan hold during Gateway startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-startup-broker-hold-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const seededPlan = seedOperationPlanState(planStatePath);
    const restoreCommand = {
      type: "tool_call",
      payload: { tool_name: "recovery.restore", arguments: { backup_id: "synthetic-broker-backup", store_key: "broker" } },
    };
    const restoreAttempt = recoveryStoreRestoreAttemptHistoryEvidence(restoreCommand);
    expect(restoreAttempt).toMatchObject({ schema_version: 1, store_key: "broker" });
    const commandId = "synthetic-failed-broker-restore";
    const resultDigest = createHash("sha256").update("synthetic failed Broker restore result").digest("hex");
    const timestamp = Date.now() - 10_000;
    const history = new CompleteHistoryStore({ filepath: historyFile });
    history.append({
      kind: "execution_history",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp,
      payload: {
        command: {
          operation: "recovery.restore",
          payload: { tool_name: "recovery.restore", arguments_digest: createHash("sha256")
            .update("synthetic Broker restore arguments").digest("hex") },
        },
        status: "failed",
        result_present: true,
        result_digest: resultDigest,
        recovery_store_restore_attempt: restoreAttempt,
      },
    });
    history.append({
      kind: "final_output",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp: timestamp + 1,
      payload: { status: "failed", result_present: true, result_digest: resultDigest, used_for_authority: false },
    });
    expect(history.verify()).toBe(true);

    let gateway: ReturnType<typeof spawnGateway> | undefined;
    try {
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(port, gateway);
      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(runtime.body.hds.operation_plans.plans, gateway.output.join("")).toMatchObject([
        { plan_id: seededPlan.plan_id_digest, recovery_hold_reason: "held_unverified" },
      ]);
      const persistedStore = new OperationPlanStateStore(planStatePath);
      try {
        expect(persistedStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: seededPlan.plan_id_digest, reason: "held_unverified",
            provenance: { source: "recovery_restore", restore_store_key: "broker" } }],
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        persistedStore.close();
      }
    } finally {
      if (gateway) await stopChild(gateway.child);
    }
  }, 30_000);

  it("quiesces, restores, reopens, and reobserves the Cron event store under L3", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-restore-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = {
      ...isolatedRuntimeEnvironment(root, envFile, historyFile, port),
      BLUE_TANUKI_SCHEDULES_JSON: JSON.stringify([{
        id: "cron-restore-test",
        channel: "webchat",
        target: "local-user",
        content: "synthetic scheduled message",
        interval_ms: 60_000,
      }]),
    };
    const event = createCronEventIdentity(
      "cron:restore-test:seed",
      1,
      createHash("sha256").update("synthetic cron recovery fixture").digest("hex"),
    );
    const seededStore = GatewayCronEventStore.fromEnvironment(runtimeEnv);
    expect(seededStore.claim(event, 100)).toEqual({ status: "accepted" });
    seededStore.settle(event, "handler_returned", 200);
    seededStore.close();

    const gateway = spawnGateway(runtimeEnv);
    let gatewayStopped = false;
    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;

      const queued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: { backup_id: backupId, store_key: "cron_events", confirm: "RESTORE" },
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.restore",
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });

      const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const pending = (approvalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.operation === "recovery.restore");
      expect(pending).toMatchObject({ risk: "high", approval_level: "L3_final_review", final_review_required: true });
      const commandId = pending?.command_id as string;
      const approvalToken = pending?.approval_token as string;
      const approved = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: approvalToken },
      });
      expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approved.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(runtime.body.scheduled_tasks, gateway.output.join(""))
        .toMatchObject([{ id: "cron-restore-test", running: true, recovery_hold: null }]);
      await stopChild(gateway);
      children.delete(gateway);
      gatewayStopped = true;
    } finally {
      if (!gatewayStopped) {
        await stopChild(gateway);
        children.delete(gateway);
      }
    }
  }, 30_000);

  it("holds an enabled Google Daily Brief without network requests while static cron keeps firing", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-daily-brief-hold-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const preload = join(root, "google-loopback.cjs");
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const port = await reserveLoopbackPort();
    let googleRequests = 0;
    const googleFixture = createServer((_request, response) => {
      googleRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"messages\":[],\"items\":[],\"files\":[]}");
    });
    const listening = once(googleFixture, "listening");
    googleFixture.listen(0, "127.0.0.1");
    await listening;
    try {
      const address = googleFixture.address();
      if (!address || typeof address === "string") throw new Error("Google fixture did not bind loopback");
      writeFileSync(preload, `
const https = require("node:https");
const http = require("node:http");
const originalRequest = https.request;
https.request = function (target, ...args) {
  if (target.hostname === "gmail.googleapis.com" || target.hostname === "www.googleapis.com") {
    return http.request({ hostname: "127.0.0.1", port: ${address.port}, path: target.path, method: target.method }, ...args);
  }
  return originalRequest.call(this, target, ...args);
};
require("node:module").syncBuiltinESMExports();
`, "utf8");
      const env = {
        ...isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port),
        BLUE_TANUKI_DAILY_BRIEF_ENABLED: "1",
        BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED: "1",
        BLUE_TANUKI_DAILY_BRIEF_TARGET: "synthetic-user",
        BLUE_TANUKI_DAILY_BRIEF_CHANNEL: "webchat",
        BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS: "100",
        GOOGLE_ACCESS_TOKEN: "synthetic-local-google-token",
        BLUE_TANUKI_SCHEDULES_JSON: JSON.stringify([{ id: "static-synthetic", channel: "webchat",
          target: "synthetic-user", content: "synthetic static reminder", interval_ms: 250 }]),
      };
      const gateway = spawnGateway(env, preload);
      await waitForHealth(port, gateway, 20_000);
      const deadline = Date.now() + 5_000;
      let scheduledTasks: unknown = [];
      let lastStaticFire: unknown;
      while (Date.now() < deadline) {
        const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
        expect(runtime.status).toBe(200);
        scheduledTasks = runtime.body.scheduled_tasks;
        lastStaticFire = (scheduledTasks as Array<Record<string, unknown>>)
          .find((item) => item.id === "static-synthetic")?.last_fire_at_ms;
        if (typeof lastStaticFire === "number") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(lastStaticFire).toBeTypeOf("number");
      expect(scheduledTasks).toEqual(expect.arrayContaining([expect.objectContaining({
        id: "daily_brief", enabled: true, running: false, next_fire_at_ms: null, last_fire_at_ms: null,
        content_source_hold: "google_authorized_acquisition_not_wired", used_for_authority: false,
      })]));
      expect(googleRequests).toBe(0);
      await stopChild(gateway.child);
    } finally {
      await new Promise<void>((resolve, reject) => googleFixture.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it("quiesces J/M and meaning-update consumers for selected restore, verifies reopened stores, and keeps existing plans held", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-jm-restore-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const planIdDigest = seedOperationPlanState(planStatePath).plan_id_digest;
    const gateway = spawnGateway(runtimeEnv);
    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", { method: "POST", token: maintenanceToken, body: {} });
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;
      for (const store_key of ["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state"] as const) {
        const queued = await requestJson(port, "/recovery/restore", {
          method: "POST",
          token: maintenanceToken,
          body: { backup_id: backupId, store_key, confirm: "RESTORE" },
        });
        expect(queued.status, JSON.stringify(queued.body)).toBe(202);
        expect(queued.body).toMatchObject({ ok: true, result: {
          status: "approval_required", operation: "recovery.restore", risk: "high",
          approval_level: "L3_final_review", final_review_required: true,
        } });

        const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
        const pending = (approvalQueue.body.pending_approvals as Array<Record<string, unknown>>)
          .find((item) => item.operation === "recovery.restore");
        expect(pending).toMatchObject({ risk: "high", approval_level: "L3_final_review", final_review_required: true });
        const approved = await requestJson(port, `/approval/${encodeURIComponent(String(pending?.command_id))}`, {
          method: "POST",
          token: resumeToken,
          body: { verdict: "approve", approval_token: pending?.approval_token },
        });
        expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
        expect(approved.body, gateway.output.join("")).toMatchObject({ ok: true, result: {
          approval: "approve", executed: true, status: "success",
        } });
      }

      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(runtime.body.hds.operation_plans.result_memory).toMatchObject({
        configured: true, status: "receipt_confirmed", used_for_authority: false,
      });
      expect(runtime.body.hds.operation_plans.plans).toMatchObject([{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }]);
    } finally {
      await stopChild(gateway.child);
    }
  }, 30_000);

  it("rejects a different valid recovery archive under the same backup ID until a fresh L3 review", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-recovery-pin-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const gateway = spawnGateway(isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port));
    const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    try {
      await waitForHealth(port, gateway, 40_000);
      const backup = await requestJson(port, "/recovery/backup", { method: "POST", token: maintenanceToken, body: {} });
      const backupId = (backup.body.result as { backup_id: string }).backup_id;
      const recoveryRoot = join(root, "recovery");
      const backupPath = join(recoveryRoot, backupId);
      const manifestPath = join(backupPath, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        canonical_state_snapshot: { entries: Array<{ store_key: string; archive_rel_path: string; sha256: string; bytes: number }> };
      };
      const storeKey = "meaning_update_j_control";
      const selected = manifest.canonical_state_snapshot.entries.find(entry => entry.store_key === storeKey)!;
      const archivePath = join(backupPath, selected.archive_rel_path);
      const originalDigest = sha256(readFileSync(archivePath));
      const restoreArguments = { backup_id: backupId, store_key: storeKey, confirm: "RESTORE" };
      const queueRestore = async (body: Record<string, unknown>) => requestJson(port, "/recovery/restore", {
        method: "POST", token: maintenanceToken, body,
      });
      expect((await queueRestore({ ...restoreArguments, expected_archive_sha256: originalDigest })).status).toBe(400);
      const queued = await queueRestore(restoreArguments);
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({ result: { executed: false, recovery_archive_sha256: originalDigest } });
      const approve = async (expectedDigest: string) => {
        const queue = await requestJson(port, "/approval", { token: resumeToken });
        const [pending] = queue.body.pending_approvals as Array<{ command_id: string; approval_token: string }>;
        expect(pending).toMatchObject({ operation: "recovery.restore", approval_level: "L3_final_review",
          recovery_archive_sha256: expectedDigest });
        return requestJson(port, `/approval/${encodeURIComponent(pending!.command_id)}`, {
          method: "POST", token: resumeToken, signal: AbortSignal.timeout(12_000),
          body: { verdict: "approve", approval_token: pending!.approval_token },
        });
      };

      // Keep SQLite and the pack internally valid while changing the bytes selected by the old approval.
      const db = new DatabaseSync(archivePath);
      try { db.exec("PRAGMA application_id = 20261119"); } finally { db.close(); }
      const replacement = readFileSync(archivePath);
      selected.sha256 = sha256(replacement);
      selected.bytes = replacement.length;
      expect(selected.sha256).not.toBe(originalDigest);
      const manifestRaw = JSON.stringify(manifest, null, 2) + "\n";
      writeFileSync(manifestPath, manifestRaw, "utf8");
      writeFileSync(`${manifestPath}.sha256`, `${sha256(manifestRaw)}  manifest.json\n`, "utf8");

      const statePath = join(root, "state", "private-state", "meaning-update-memory", "j-control.sqlite");
      const stateBefore = sha256(readFileSync(statePath));
      const packsBefore = readdirSync(recoveryRoot).sort();
      const rejected = await approve(originalDigest);
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ result: { executed: false,
        status: "canonical_state_restore_archive_changed", fresh_request_required: true } });
      expect(sha256(readFileSync(statePath))).toBe(stateBefore);
      expect(readdirSync(recoveryRoot).sort()).toEqual(packsBefore);

      const fresh = await queueRestore(restoreArguments);
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(202);
      expect(fresh.body).toMatchObject({ result: { recovery_archive_sha256: selected.sha256 } });
      const accepted = await approve(selected.sha256);
      expect(accepted.body, gateway.output.join("")).toMatchObject({ result: { executed: true, status: "success" } });
      const restored = new DatabaseSync(statePath, { readOnly: true });
      try { expect(restored.prepare("PRAGMA application_id").get()).toMatchObject({ application_id: 20261119 }); }
      finally { restored.close(); }
      for (const pack of readdirSync(recoveryRoot)) {
        expect(readdirSync(join(recoveryRoot, pack)).some(name => name.startsWith(".restore-source-"))).toBe(false);
      }
    } finally {
      await stopChild(gateway.child);
    }
  }, 65_000);

  it("drains another running command before an approved meaning-update restore without waiting on itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-meaning-restore-drain-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "", "utf8");
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    let providerWaiting = false;
    const provider = await startSyntheticPlanProvider(() => {
      providerWaiting = true;
      return providerGate;
    });
    const gateway = spawnGateway({
      ...isolatedRuntimeEnvironment(root, envFile, join(root, "complete-history.jsonl"), port),
      LLM_BACKEND: "synthetic-plan-provider",
      BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
      BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({
        "synthetic-plan-provider": { capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" } },
      }),
      LLM_PROVIDERS_JSON: JSON.stringify([
        { name: "synthetic-plan-provider", endpoint: provider.endpoint, model: "synthetic-plan-model" },
      ]),
    });
    let approvalRequest: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    try {
      await waitForHealth(port, gateway, 40_000);
      const backup = await requestJson(port, "/recovery/backup", { method: "POST", token: maintenanceToken, body: {} });
      const backupId = (backup.body.result as { backup_id: string }).backup_id;
      const manifestFile = join(root, "recovery", backupId, "manifest.json");
      const manifestBefore = readFileSync(manifestFile);
      const envBefore = readFileSync(envFile);
      const goalStores = ["goal_purpose_j_control", "goal_purpose_m_state"];
      const inspected = await requestJson(port, "/recovery/backup-inspection", { token: maintenanceToken });
      expect(inspected.status).toBe(200);
      expect(inspected.body).toMatchObject({
        canonical_state_expected_store_count: 9,
        canonical_state_stores: expect.arrayContaining(goalStores.map(store_key => ({ store_key, status: "verified" }))),
        used_for_authority: false, may_execute: false,
      });
      const planRequest = { method: "POST", body: { backup_id: backupId } };
      const disallowed = await requestJson(port, "/recovery/restore-plan", { ...planRequest, token: inboundToken });
      expect(disallowed.status).toBe(401);
      const plan = await requestJson(port, "/recovery/restore-plan", { ...planRequest, token: maintenanceToken });
      expect(plan.status).toBe(200);
      expect(plan.body).toMatchObject({
        surface: "offline_recovery_restore_plan", status: "planned",
        manifest_sha256: createHash("sha256").update(manifestBefore).digest("hex"),
        plan_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        items: expect.arrayContaining([{ role: "env_file", disposition: "preserve_current" }]),
        canonical_stores: expect.arrayContaining(goalStores.map(store_key => ({
          store_key, archive_status: "verified", disposition: "requires_store_reconciliation",
        }))),
        used_for_authority: false, may_execute: false, offline_lease_verified: false, cross_store_atomic: false,
      });
      expect(JSON.stringify(plan.body)).not.toContain("product.env");
      expect(readFileSync(envFile)).toEqual(envBefore);
      expect(readFileSync(manifestFile)).toEqual(manifestBefore);
      expect(readdirSync(join(root, "recovery"))).toEqual([backupId]);
      const fullRestore = await requestJson(port, "/recovery/restore", {
        method: "POST", token: maintenanceToken, body: { backup_id: backupId, confirm: "RESTORE" },
      });
      expect(fullRestore.body).toMatchObject({ result: {
        status: "blocked_runtime_restore_requires_offline_gateway", executed: false, l3_request_created: false,
      } });
      for (const store_key of goalStores) {
        const refused = await requestJson(port, "/recovery/restore", {
          method: "POST", token: maintenanceToken, body: { backup_id: backupId, store_key, confirm: "RESTORE" },
        });
        expect(refused).toEqual({ status: 400, body: { error: "invalid_store_key" } });
      }
      const storeRequest = {
        method: "POST", token: maintenanceToken,
        body: { backup_id: backupId, store_key: "meaning_update_j_control", confirm: "RESTORE" },
      };
      const unauthenticated = await requestJson(port, "/recovery/restore", { ...storeRequest, token: undefined });
      expect(unauthenticated.status).toBe(401);
      const queued = await requestJson(port, "/recovery/restore", storeRequest);
      expect(queued.status).toBe(202);
      const queue = await requestJson(port, "/approval", { token: resumeToken });
      const approvals = queue.body.pending_approvals as Array<{ command_id: string; operation: string; approval_token: string }>;
      expect(approvals).toHaveLength(1);
      const [pending] = approvals;
      expect(pending).toMatchObject({ operation: "recovery.restore", approval_level: "L3_final_review" });

      const compute = await requestJson(port, "/operators/developer/invoke", {
        method: "POST", token: inboundToken,
        body: { user: "fixture-owner", content: "plan:compute synthetic work overlapping the restore" },
      });
      expect(compute.status, JSON.stringify(compute.body)).toBe(202);
      await vi.waitFor(() => expect(providerWaiting, gateway.output.join("")).toBe(true), { timeout: 5_000 });

      approvalRequest = requestJson(port, `/approval/${encodeURIComponent(pending!.command_id)}`, {
        method: "POST", token: resumeToken, signal: AbortSignal.timeout(10_000),
        body: { verdict: "approve", approval_token: pending!.approval_token },
      });
      // Attach a rejection handler immediately while waiting for the lock to become observable.
      void approvalRequest.catch(() => undefined);
      await vi.waitFor(async () => {
        const overlappingRequest = await requestJson(port, "/recovery/restore", {
          method: "POST", token: maintenanceToken, body: { backup_id: backupId, confirm: "RESTORE" },
        });
        expect(overlappingRequest.body).toMatchObject({ result: {
          status: "blocked_restore_in_progress", executed: false, l3_request_created: false,
        } });
      }, { timeout: 4_000 });
      releaseProvider();
      const approved = await approvalRequest;
      expect(approved.status, gateway.output.join("")).toBe(200);
      expect(approved.body, gateway.output.join("")).toMatchObject({ ok: true, result: { executed: true, status: "success" } });
      const snapshot = await requestJson(port, "/recovery/snapshot", { token: maintenanceToken });
      expect(snapshot.body).toMatchObject({ post_action_observation: {
        operation: "restore", store_key: "meaning_update_j_control", status: "unverified", may_execute: false,
      } });
      expect((await requestJson(port, "/recovery/restore", storeRequest)).status).toBe(202);
    } finally {
      releaseProvider();
      await stopChild(gateway.child);
      await approvalRequest?.catch(() => undefined);
      await provider.close();
    }
  }, 65_000);

  it("restores one verified plan through L3, preserves the collateral plan hold, and gates dependent review on its result", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-operation-plan-restore-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const fileRoot = join(root, "file-root");
    const searchRoot = join(fileRoot, "fixture-workspace");
    const searchQuery = "qe-recovery-result-marker";
    const searchLine = `isolated recovery result: ${searchQuery}`;
    mkdirSync(searchRoot, { recursive: true });
    writeFileSync(join(searchRoot, "receipt.txt"), `${searchLine}\n`, "utf8");
    const expectedSearchResult = {
      root: realpathSync(searchRoot),
      sandbox_root: realpathSync(fileRoot),
      query: searchQuery,
      visited_files: 1,
      matches: [{ path: "receipt.txt", line_number: 1, line: searchLine }],
    };
    const runtimeEnv = {
      ...isolatedRuntimeEnvironment(root, envFile, historyFile, port),
      BLUE_TANUKI_APPROVAL_MODE: "ask_every_time",
    };
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const { cleanPlanIdDigest, cleanRevisionDigest, residualPlanIdDigest, residualRevisionDigest } =
      seedMixedOperationPlanRestoreState(planStatePath, {
        targetId: "fixture-workspace",
        root: "fixture-workspace",
        query: searchQuery,
        expectedResult: expectedSearchResult,
        dependentExpectedResult: { ...expectedSearchResult, query: searchLine },
      });
    const gateway = spawnGateway(runtimeEnv);
    let cleanPlanReviewRequestId: string | undefined;
    let residualPlanReviewRequestId: string | undefined;
    let prematureDependentReviewRequestId: string | undefined;
    let dependentReviewRequestId: string | undefined;

    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;

      // Remove only the selected plan after backup. Selective restore must preserve
      // the live collateral plan and then expose it as held residual state.
      const changedStore = new OperationPlanStateStore(planStatePath);
      try {
        const current = changedStore.load();
        expect(current?.plans).toHaveLength(2);
        const holdsBeforeRestore = changedStore.loadRecoveryHoldState();
        expect(holdsBeforeRestore?.holds).toEqual(expect.arrayContaining([
          { plan_id_digest: cleanPlanIdDigest, reason: "held_unverified", restore_scope_relation: "unknown",
            provenance: expect.any(Object) },
          { plan_id_digest: residualPlanIdDigest, reason: "held_unverified", restore_scope_relation: "unknown",
            provenance: expect.any(Object) },
        ]));
        expect(holdsBeforeRestore).toMatchObject({ used_for_authority: false, may_execute: false });
        const withoutSelectedPlan = OperationPlanCheckpointSchema.parse({
          ...current,
          plans: current?.plans.filter((plan) =>
            operationPlanDigest(plan.revisions[0]!.plan.plan_id) === residualPlanIdDigest) ?? [],
        });
        changedStore.compareAndSet(current ? operationPlanDigest(current) : null, withoutSelectedPlan);
      } finally {
        changedStore.close();
      }

      const queued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "operation_plan",
          scope_digest: cleanPlanIdDigest,
          confirm: "RESTORE",
        },
      });
      const expectedTarget =
        `recovery.restore:${backupId}:store:operation_plans:effect:selected_operation_plan:scope:operation_plan:${cleanPlanIdDigest}`;
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({ ok: true, result: {
        status: "approval_required",
        executed: false,
        target: expectedTarget,
        restore_effect_scope: "selected_operation_plan",
        scope_applicability: {
          status: "matched",
          matched_plan_id_digest: cleanPlanIdDigest,
          used_for_authority: false,
          may_execute: false,
        },
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      } });

      const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const pending = (approvalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.operation === "recovery.restore");
      expect(pending).toMatchObject({
        target: expectedTarget,
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      });
      const approved = await requestJson(port, `/approval/${encodeURIComponent(String(pending?.command_id))}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: pending?.approval_token },
      });
      expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approved.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const restoredStore = new OperationPlanStateStore(planStatePath);
      try {
        expect(restoredStore.load()?.plans.map((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id)))
          .toEqual(expect.arrayContaining([cleanPlanIdDigest, residualPlanIdDigest]));
        expect(restoredStore.load()?.plans).toHaveLength(2);
        expect(restoredStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: residualPlanIdDigest, reason: "held_unverified" }],
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        restoredStore.close();
      }
      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      const runtimePlans = runtime.body.hds.operation_plans.plans as Array<Record<string, unknown>>;
      expect(runtimePlans).toEqual(expect.arrayContaining([
        expect.objectContaining({ plan_id: cleanPlanIdDigest }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_unverified" }),
      ]));
      expect(runtimePlans.find((plan) => plan.plan_id === cleanPlanIdDigest)?.recovery_hold_reason).toBeUndefined();
      expect(runtime.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(runtime.body.hds.operation_plans.raw_payload_exposed).toBe(false);

      const cleanReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: cleanPlanIdDigest,
          revision_digest: cleanRevisionDigest,
          step_id: "restore-clean-step",
        })}` },
      });
      expect(cleanReview.status, `${JSON.stringify(cleanReview.body)}\n${gateway.output.join("")}`).toBe(202);
      cleanPlanReviewRequestId = cleanReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, cleanPlanReviewRequestId);
      const cleanReviewRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(cleanReviewRuntime.body.pending_approvals,
        `${JSON.stringify(cleanReviewRuntime.body.hds.operation_plans)}\n${gateway.output.join("")}`).toEqual(expect.arrayContaining([
        expect.objectContaining({ request_id: cleanPlanReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]));

      const residualReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: residualPlanIdDigest,
          revision_digest: residualRevisionDigest,
          step_id: "restore-residual-review-step",
        })}` },
      });
      expect(residualReview.status, `${JSON.stringify(residualReview.body)}\n${gateway.output.join("")}`).toBe(202);
      residualPlanReviewRequestId = residualReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, residualPlanReviewRequestId);
      const afterResidualReview = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterResidualReview.body.pending_approvals, gateway.output.join("")).toEqual([
        expect.objectContaining({ request_id: cleanPlanReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]);
      expect(afterResidualReview.body.hds.operation_plans.plans).toEqual(expect.arrayContaining([
        expect.objectContaining({ plan_id: cleanPlanIdDigest }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_unverified" }),
      ]));

      const prematureDependentReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: cleanPlanIdDigest,
          revision_digest: cleanRevisionDigest,
          step_id: "restore-clean-step-dependent",
        })}` },
      });
      expect(prematureDependentReview.status, `${JSON.stringify(prematureDependentReview.body)}\n${gateway.output.join("")}`).toBe(202);
      prematureDependentReviewRequestId = prematureDependentReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, prematureDependentReviewRequestId);
      const beforeSourceResult = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(beforeSourceResult.body.pending_approvals).toEqual([
        expect.objectContaining({ request_id: cleanPlanReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]);

      const cleanApprovalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const cleanPendingApproval = (cleanApprovalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.request_id === cleanPlanReviewRequestId && item.operation === "tool.file.search");
      expect(cleanApprovalQueue.body.pending_approvals).toEqual([
        expect.objectContaining({
          request_id: cleanPlanReviewRequestId,
          operation: "tool.file.search",
          approval_level: "L1_observe",
        }),
      ]);
      const approvedCleanSearch = await requestJson(port,
        `/approval/${encodeURIComponent(String(cleanPendingApproval?.command_id))}`, {
          method: "POST",
          token: resumeToken,
          body: { verdict: "approve", approval_token: cleanPendingApproval?.approval_token },
        });
      expect(approvedCleanSearch.status, `${JSON.stringify(approvedCleanSearch.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approvedCleanSearch.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const afterCleanSearch = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterCleanSearch.body.pending_approvals).toEqual([]);
      const afterSearchPlans = afterCleanSearch.body.hds.operation_plans.plans as Array<Record<string, unknown>>;
      expect(afterSearchPlans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          plan_id: cleanPlanIdDigest,
          status: "awaiting_step_review",
          steps: expect.arrayContaining([
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step"), status: "verified" }),
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step-dependent"), status: "not_selected" }),
          ]),
        }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_unverified" }),
      ]));
      expect(afterCleanSearch.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(afterCleanSearch.body.hds.operation_plans.raw_payload_exposed).toBe(false);

      const dependentReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: cleanPlanIdDigest,
          revision_digest: cleanRevisionDigest,
          step_id: "restore-clean-step-dependent",
        })}` },
      });
      expect(dependentReview.status, `${JSON.stringify(dependentReview.body)}\n${gateway.output.join("")}`).toBe(202);
      dependentReviewRequestId = dependentReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, dependentReviewRequestId);
      const afterDependentReview = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterDependentReview.body.pending_approvals).toEqual([
        expect.objectContaining({ request_id: dependentReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]);
      expect(JSON.stringify(afterDependentReview.body)).not.toContain(searchLine);
      expect(afterDependentReview.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(afterDependentReview.body.hds.operation_plans.raw_payload_exposed).toBe(false);

      const dependentApprovalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const dependentPendingApproval = (dependentApprovalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.request_id === dependentReviewRequestId && item.operation === "tool.file.search");
      expect(dependentApprovalQueue.body.pending_approvals).toEqual([
        expect.objectContaining({
          request_id: dependentReviewRequestId,
          operation: "tool.file.search",
          approval_level: "L1_observe",
        }),
      ]);
      const approvedDependentSearch = await requestJson(port,
        `/approval/${encodeURIComponent(String(dependentPendingApproval?.command_id))}`, {
          method: "POST",
          token: resumeToken,
          body: { verdict: "approve", approval_token: dependentPendingApproval?.approval_token },
        });
      expect(approvedDependentSearch.status, `${JSON.stringify(approvedDependentSearch.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approvedDependentSearch.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const afterDependentSearch = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterDependentSearch.body.pending_approvals).toEqual([]);
      expect(afterDependentSearch.body.hds.operation_plans.plans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          plan_id: cleanPlanIdDigest,
          status: "results_verified",
          steps: expect.arrayContaining([
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step"), status: "verified" }),
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step-dependent"), status: "verified" }),
          ]),
        }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_unverified" }),
      ]));
      expect(JSON.stringify(afterDependentSearch.body)).not.toContain(searchLine);
      expect(afterDependentSearch.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(afterDependentSearch.body.hds.operation_plans.raw_payload_exposed).toBe(false);
      expect(afterDependentSearch.body.operation_plan_status).toMatchObject({
        schema_version: "operation-plan.status.v1",
        status: "available",
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: expect.arrayContaining([
          expect.objectContaining({
            plan_id: cleanPlanIdDigest,
            status: "results_verified",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step_id: operationPlanDigest("restore-clean-step"),
                status: "verified",
                binding: expect.objectContaining({
                  result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                  delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
              }),
              expect.objectContaining({
                step_id: operationPlanDigest("restore-clean-step-dependent"),
                status: "verified",
                binding: expect.objectContaining({
                  result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                  delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
              }),
            ]),
          }),
          expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_unverified" }),
        ]),
      });
      expect(JSON.stringify(afterDependentSearch.body.operation_plan_status)).not.toContain(searchLine);

      const resultStore = new OperationPlanStateStore(planStatePath);
      try {
        const persisted = resultStore.load();
        const cleanPlan = persisted?.plans.find((plan) => plan.revisions[0]?.plan.plan_id === "restore-clean-plan");
        expect(cleanPlan?.bindings).toEqual(expect.arrayContaining([
          expect.objectContaining({
            step_id: "restore-clean-step",
            status: "verified",
            result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
          expect.objectContaining({
            step_id: "restore-clean-step-dependent",
            status: "verified",
            result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            prepared_step: expect.objectContaining({
              parameters: expect.objectContaining({ query: searchLine }),
            }),
          }),
        ]));
        expect(cleanPlan?.results).toEqual([
          expect.objectContaining({
            plan_id: "restore-clean-plan",
            request_id: "restore-clean-request",
            step_id: "restore-clean-step",
            operation: "file.search",
            status: "succeeded",
            output: expectedSearchResult,
          }),
          expect.objectContaining({
            plan_id: "restore-clean-plan",
            request_id: "restore-clean-request",
            step_id: "restore-clean-step-dependent",
            operation: "file.search",
            status: "succeeded",
            output: { ...expectedSearchResult, query: searchLine },
          }),
        ]);
        expect(resultStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: residualPlanIdDigest, reason: "held_unverified" }],
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        resultStore.close();
      }
    } finally {
      await stopChild(gateway.child);
    }
    const reviewHistory = new CompleteHistoryStore({ filepath: historyFile });
    expect(reviewHistory.replay({ kind: "hds_decision", request_id: cleanPlanReviewRequestId! })).toHaveLength(1);
    const cleanExecutionHistory = reviewHistory.replay({ kind: "execution_history", request_id: cleanPlanReviewRequestId! });
    expect(cleanExecutionHistory).toHaveLength(1);
    expect(cleanExecutionHistory[0]?.payload).toMatchObject({
      status: "success",
      result_present: true,
      result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(cleanExecutionHistory)).not.toContain(searchLine);
    const dependentExecutionHistory = reviewHistory.replay({ kind: "execution_history", request_id: dependentReviewRequestId! });
    expect(dependentExecutionHistory).toHaveLength(1);
    expect(dependentExecutionHistory[0]?.payload).toMatchObject({
      status: "success",
      result_present: true,
      result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(dependentExecutionHistory)).not.toContain(searchLine);
    expect(reviewHistory.replay({ kind: "hds_decision", request_id: residualPlanReviewRequestId! })[0]?.payload).toMatchObject({
      decision: "FAIL",
      reason: "plan_control_denied:plan_recovery_unverified_hold",
      command: null,
    });
    expect(reviewHistory.replay({ kind: "hds_decision", request_id: prematureDependentReviewRequestId! })[0]?.payload).toMatchObject({
      decision: "FAIL",
      reason: "plan_control_denied:plan_step_not_ready",
      command: null,
    });
    expect(reviewHistory.replay({ kind: "execution_history", request_id: residualPlanReviewRequestId! })).toHaveLength(0);
    expect(reviewHistory.replay({ kind: "execution_history", request_id: prematureDependentReviewRequestId! })).toHaveLength(0);
    expect(reviewHistory.replay({ kind: "execution_history", request_id: dependentReviewRequestId! })).toHaveLength(1);
  }, 30_000);

  it("binds plan restore to its exact L3 scope and rejects changed backup before state mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-recovery-l3-"));
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, `LLM_BACKEND=openai-compatible\nLLM_API_KEY=${secretMarker}\n`, "utf8");
    const before = readFileSync(envFile, "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const planScopeDigest = seedOperationPlanState(planStatePath).plan_id_digest;
    const gateway = spawnGateway(runtimeEnv);

    try {
      await waitForHealth(port, gateway);

      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;
      const unverifiedScope = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "operation_plan",
          scope_digest: "f".repeat(64),
          confirm: "RESTORE",
        },
      });
      expect(unverifiedScope.status).toBe(200);
      expect(unverifiedScope.body).toMatchObject({
        ok: true,
        result: {
          status: "blocked_unverified_scope",
          executed: false,
          restore_effect_scope: "selected_operation_plan",
          used_for_authority: false,
          may_execute: false,
          scope_applicability: { status: "unverified", used_for_authority: false, may_execute: false },
        },
      });
      const noRecoveryApproval = await requestJson(port, "/approval", { token: resumeToken });
      expect(noRecoveryApproval.body.pending_approvals).toEqual([]);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const planStoreBeforeReview = readFileSync(planStatePath);
      const planRestoreQueued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "operation_plan",
          scope_digest: planScopeDigest,
          confirm: "RESTORE",
        },
      });
      const expectedPlanRestoreTarget =
        `recovery.restore:${backupId}:store:operation_plans:effect:selected_operation_plan:scope:operation_plan:${planScopeDigest}`;
      expect(planRestoreQueued.status, JSON.stringify(planRestoreQueued.body)).toBe(202);
      expect(planRestoreQueued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.restore",
          target: expectedPlanRestoreTarget,
          restore_effect_scope: "selected_operation_plan",
          scope_applicability: {
            status: "matched",
            scope_digest: planScopeDigest,
            matched_plan_id_digest: planScopeDigest,
            used_for_authority: false,
            may_execute: false,
          },
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });
      expect(readFileSync(planStatePath)).toEqual(planStoreBeforeReview);

      const planApprovalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const pendingPlanRestore = (planApprovalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((pending) => pending.operation === "recovery.restore");
      expect(pendingPlanRestore).toMatchObject({
        target: expectedPlanRestoreTarget,
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      });
      const planRestoreCommandId = pendingPlanRestore?.command_id as string;
      const planRestoreApprovalToken = pendingPlanRestore?.approval_token as string;
      expect(typeof planRestoreCommandId).toBe("string");
      expect(typeof planRestoreApprovalToken).toBe("string");

      const selectedPlanArchive = join(root, "recovery", backupId, "canonical-state", "operation_plans.sqlite");
      unlinkSync(selectedPlanArchive);
      const backupPacksBeforeRejectedApply = readdirSync(join(root, "recovery")).sort();
      const rejectedPlanRestore = await requestJson(port, `/approval/${encodeURIComponent(planRestoreCommandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: planRestoreApprovalToken },
      });
      expect(rejectedPlanRestore.status).toBe(200);
      expect(rejectedPlanRestore.body).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: false, status: "canonical_state_restore_archive_changed", fresh_request_required: true },
      });
      expect(readFileSync(planStatePath)).toEqual(planStoreBeforeReview);
      expect(readdirSync(join(root, "recovery")).sort()).toEqual(backupPacksBeforeRejectedApply);

      const invalid = await requestJson(port, "/recovery/reset-provider", {
        method: "POST",
        token: maintenanceToken,
        body: { confirm: "RESET_PROVIDER", force: true },
      });
      expect(invalid.status).toBe(400);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const queued = await requestJson(port, "/recovery/reset-provider", {
        method: "POST",
        token: maintenanceToken,
        body: { confirm: "RESET_PROVIDER" },
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.reset_provider",
          target: "recovery.reset_provider:provider-configuration",
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });
      expect(JSON.stringify(queued.body)).not.toContain(secretMarker);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const wrongAuth = await requestJson(port, "/approval", { token: maintenanceToken });
      expect(wrongAuth.status).toBe(401);
      const queue = await requestJson(port, "/approval", { token: resumeToken });
      expect(queue.status).toBe(200);
      const pending = (queue.body.pending_approvals as Array<Record<string, unknown>>)[0];
      expect(pending).toMatchObject({
        operation: "recovery.reset_provider",
        target: "recovery.reset_provider:provider-configuration",
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      });
      expect(typeof pending.command_id).toBe("string");
      expect(typeof pending.approval_token).toBe("string");
      const commandId = pending.command_id as string;
      const approvalToken = pending.approval_token as string;

      const missingToken = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve" },
      });
      expect(missingToken.status).toBe(400);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const wrongApprovalToken = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: "wrong-one-time-token" },
      });
      expect(wrongApprovalToken.status).toBe(403);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const approved = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: approvalToken, remember: true, actor: "client-claimed-owner" },
      });
      expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approved.body).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });
      const after = readFileSync(envFile, "utf8");
      expect(after).toContain("LLM_BACKEND=stub");
      expect(after).not.toContain(secretMarker);

      const emptyQueue = await requestJson(port, "/approval", { token: resumeToken });
      expect(emptyQueue.body.pending_approvals).toEqual([]);
      const replay = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: approvalToken },
      });
      expect(replay.status).toBe(409);
      expect(readFileSync(envFile, "utf8")).toBe(after);

      const grants = await requestJson(port, "/approval/grants", { token: resumeToken });
      expect(grants.status).toBe(200);
      expect(JSON.stringify(grants.body)).not.toContain("recovery.reset_provider");
      const history = readFileSync(historyFile, "utf8");
      expect(history).toContain("human_resume_approved");
      expect(history).toContain("recovery.reset_provider");
      expect(history).toContain("webchat-resume-token-holder");
      expect(history).not.toContain("client-claimed-owner");
      expect(history).not.toContain(secretMarker);
    } finally {
      await stopChild(gateway.child);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("binds task-lineage restore to its exact L3 scope and identifies the selected effect", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-recovery-task-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const { task_identity_digest: taskIdentityDigest } = seedOperationPlanState(planStatePath);
    const gateway = spawnGateway(runtimeEnv);

    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;
      const before = readFileSync(planStatePath);

      const unverified = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "task_identity",
          scope_digest: "f".repeat(64),
          confirm: "RESTORE",
        },
      });
      expect(unverified.body).toMatchObject({
        ok: true,
        result: {
          status: "blocked_unverified_scope",
          executed: false,
          restore_effect_scope: "selected_task_lineage",
          used_for_authority: false,
          may_execute: false,
        },
      });

      const queued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "task_identity",
          scope_digest: taskIdentityDigest,
          confirm: "RESTORE",
        },
      });
      const expectedTarget =
        `recovery.restore:${backupId}:store:operation_plans:effect:task_lineage:scope:task_identity:${taskIdentityDigest}`;
      expect(queued.status, `${JSON.stringify(queued.body)}\n${gateway.output.join("")}`).toBe(202);
      expect(queued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.restore",
          target: expectedTarget,
          restore_effect_scope: "selected_task_lineage",
          scope_applicability: {
            status: "matched",
            scope_kind: "task_identity",
            scope_digest: taskIdentityDigest,
            used_for_authority: false,
            may_execute: false,
          },
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });
      const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
      expect(approvalQueue.body.pending_approvals).toEqual([
        expect.objectContaining({
          operation: "recovery.restore",
          target: expectedTarget,
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        }),
      ]);
      expect(readFileSync(planStatePath)).toEqual(before);
    } finally {
      await stopChild(gateway.child);
    }
  }, 30_000);
});

function seedOperationPlanState(filepath: string): {
  plan_id_digest: string;
  revision_digest: string;
  task_identity_digest: string;
} {
  mkdirSync(dirname(filepath), { recursive: true });
  const plan = syntheticOperationPlan("restore-review-request", "restore-review-plan", "restore-review-step");
  const revisionDigest = operationPlanDigest(plan);
  const checkpoint = OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [{
      owner: "fixture-owner",
      channel: "webchat",
      goal: "fixture recovery review",
      request_goal_criteria: noRequestCriteria("fixture recovery review", plan.request_id),
      revisions: [{ digest: revisionDigest, plan }],
      receipt_observations: [],
      bindings: [],
      results: [],
    }],
  });
  const store = new OperationPlanStateStore(filepath);
  let taskIdentityDigest: string | undefined;
  try {
    store.compareAndSet(null, checkpoint);
    const persisted = OperationPlanCheckpointSchema.parse(store.load());
    taskIdentityDigest = operationPlanTaskIdentityDigest(persisted.plans[0]!);
  } finally {
    store.close();
  }
  if (!taskIdentityDigest) throw new Error("fixture_task_identity_digest_missing");
  return { plan_id_digest: operationPlanDigest(plan.plan_id), revision_digest: revisionDigest,
    task_identity_digest: taskIdentityDigest };
}

function seedMixedOperationPlanRestoreState(filepath: string, cleanSearch: SyntheticFileSearchFixture): {
  cleanPlanIdDigest: string;
  cleanRevisionDigest: string;
  residualPlanIdDigest: string;
  residualRevisionDigest: string;
} {
  mkdirSync(dirname(filepath), { recursive: true });
  const cleanPlan = syntheticOperationPlan("restore-clean-request", "restore-clean-plan", "restore-clean-step", cleanSearch);
  const residualPlan = syntheticOperationPlan("restore-residual-request", "restore-residual-plan", "restore-residual-step");
  const residualStep = residualPlan.steps[0]!;
  residualPlan.steps.push({
    ...residualStep,
    step_id: "restore-residual-review-step",
    preparation: {
      ...residualStep.preparation,
      validation: residualStep.preparation.validation.map((check) => ({
        ...check,
        check_id: "restore-residual-review-step-check",
      })),
    },
  });
  const cleanRevisionDigest = operationPlanDigest(cleanPlan);
  const residualRevisionDigest = operationPlanDigest(residualPlan);
  const { state: _state, result_digest: _result, ...residualStepDefinition } = residualStep;
  const residualBinding = {
    step_id: residualStep.step_id,
    revision_digest: residualRevisionDigest,
    step_digest: operationPlanDigest(residualStepDefinition),
    prepared_step: residualStep,
    command_id: "synthetic-residual-command",
    request_id: residualPlan.request_id,
    commit_hash: "synthetic-residual-commit",
    payload_digest: createHash("sha256").update("synthetic-residual-payload").digest("hex"),
    command_digest: createHash("sha256").update("synthetic-residual-command").digest("hex"),
    operation: residualStep.operation,
    // An intent without its Broker admission is a real residual dependency for this fixture.
    status: "intent_committed" as const,
  };
  const checkpoint = OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [
      {
        owner: "fixture-owner",
        channel: "webchat",
        goal: "fixture clean collateral plan",
        request_goal_criteria: noRequestCriteria("fixture clean collateral plan", cleanPlan.request_id),
        revisions: [{ digest: cleanRevisionDigest, plan: cleanPlan }],
        receipt_observations: [],
        bindings: [],
        results: [],
      },
      {
        owner: "fixture-owner",
        channel: "webchat",
        goal: "fixture residual collateral plan",
        request_goal_criteria: noRequestCriteria("fixture residual collateral plan", residualPlan.request_id),
        revisions: [{ digest: residualRevisionDigest, plan: residualPlan }],
        receipt_observations: [],
        bindings: [residualBinding],
        results: [],
      },
    ],
  });
  const store = new OperationPlanStateStore(filepath);
  try {
    store.compareAndSet(null, checkpoint);
  } finally {
    store.close();
  }
  return {
    cleanPlanIdDigest: operationPlanDigest(cleanPlan.plan_id),
    cleanRevisionDigest,
    residualPlanIdDigest: operationPlanDigest(residualPlan.plan_id),
    residualRevisionDigest,
  };
}

type SyntheticFileSearchFixture = {
  targetId: string;
  root: string;
  query: string;
  expectedResult: Record<string, unknown>;
  dependentExpectedResult?: Record<string, unknown>;
};

function noRequestCriteria(content: string, requestId: string) {
  return {
    status: "not_provided" as const,
    request_id: requestId,
    content_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    criteria: [],
    used_for_authority: false as const,
  };
}

function syntheticOperationPlan(requestId: string, planId: string, stepId: string, search?: SyntheticFileSearchFixture) {
  const targetId = search?.targetId ?? "fixture-workspace";
  const root = search?.root ?? "fixture-workspace";
  const query = search?.query ?? "fixture";
  const step = {
    step_id: stepId,
    operation: "file.search",
    target: { kind: "directory" as const, id: targetId },
    state: "planned" as const,
    effects: ["read" as const],
    permission: {
      risk: "low" as const,
      approval_level: "L1_observe" as const,
      final_review_required: false,
      hds_brain_authority_required: true as const,
      approval_gate_required: true,
    },
    adapter: "internal_runtime" as const,
    adapter_is_authority: false as const,
    command_generated_by_adapter_only: false,
    parameters: { root, query, max_results: 1 },
    preparation: {
      depends_on: [],
      bindings: [],
      preconditions: [],
      validation: [{
        check_id: `${stepId}-check`,
        method: "result_equals" as const,
        target: { kind: "directory" as const, id: targetId },
        expected: search?.expectedResult ?? { count: 0 },
      }],
      compensation: { available: false, reason: "fixture" },
    },
  };
  const dependentStep = search?.dependentExpectedResult ? {
    ...step,
    step_id: `${stepId}-dependent`,
    parameters: { root, query: "pending:verified-search-result", max_results: 1 },
    preparation: {
      ...step.preparation,
      depends_on: [stepId],
      bindings: [{ source_step_id: stepId, output_path: ["matches", "0", "line"], field: "parameters" as const, path: ["query"] }],
      validation: [{ check_id: `${stepId}-dependent-check`, method: "result_equals" as const,
        target: { kind: "directory" as const, id: targetId }, expected: search.dependentExpectedResult }],
    },
  } : undefined;
  return {
    version: "operation-core.v1" as const,
    plan_id: planId,
    request_id: requestId,
    state: "planned" as const,
    steps: dependentStep ? [step, dependentStep] : [step],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false as const, command_generation_location: "not_applicable" as const },
    planner_output_used_for_authority: false as const,
    hds_brain_authority_required: true as const,
  };
}

async function startSyntheticPlanProvider(beforeReply?: () => Promise<void>): Promise<{
  endpoint: string;
  callCount(): number;
  requestIds(): readonly string[];
  failureReason(): string | undefined;
  close(): Promise<void>;
}> {
  let calls = 0;
  const requestIds: string[] = [];
  let failureReason: string | undefined;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      calls++;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: unknown; content?: unknown }>;
        };
        const requestId = body.messages?.flatMap((message) => {
          if (message.role !== "system" || typeof message.content !== "string") return [];
          const value = /固定request_id=([^。]+)/.exec(message.content)?.[1];
          return value ? [value] : [];
        })[0];
        if (requestId) requestIds.push(requestId);
        if (!requestId) {
          failureReason = `synthetic request binding missing at ${request.url ?? "unknown path"}`;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "synthetic request binding missing" }));
          return;
        }
        await beforeReply?.();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-synthetic-plan",
          object: "chat.completion",
          model: "synthetic-plan-model",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(
            syntheticOperationPlan(requestId, "fresh-request-plan", "fresh-request-step")) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      } catch {
        failureReason = `synthetic request invalid at ${request.url ?? "unknown path"}`;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic request invalid" }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic plan provider did not bind loopback");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    callCount: () => calls,
    requestIds: () => [...requestIds],
    failureReason: () => failureReason,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function isolatedRuntimeEnvironment(root: string, envFile: string, historyFile: string, port: number): NodeJS.ProcessEnv {
  const inheritedKeys = [
    "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of inheritedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    WEBCHAT_HOST: "127.0.0.1",
    WEBCHAT_PORT: String(port),
    WEBCHAT_TOKEN: inboundToken,
    WEBCHAT_RESUME_TOKEN: resumeToken,
    BLUE_TANUKI_MAINTENANCE_TOKEN: maintenanceToken,
    LLM_BACKEND: "stub",
    BLUE_TANUKI_ENV_FILE: envFile,
    BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"),
    BLUE_TANUKI_FILE_ROOT: join(root, "file-root"),
    BLUE_TANUKI_STATE_ROOT: join(root, "state"),
    BLUE_TANUKI_AUDIT_DIR: join(root, "audit"),
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile,
    BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
    BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"),
    BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"),
    BLUE_TANUKI_SCHEDULES_DIR: join(root, "schedules"),
    BLUE_TANUKI_APPROVALS_FILE: join(root, "approval-grants.json"),
    BLUE_TANUKI_APPROVAL_MODE: "full_access",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    DISCORD_BOT_TOKEN: "",
    TELEGRAM_BOT_TOKEN: "",
    LINE_CHANNEL_ACCESS_TOKEN: "",
    LINE_CHANNEL_SECRET: "",
  };
}

function spawnGateway(env: NodeJS.ProcessEnv, preload?: string): { child: ChildProcessWithoutNullStreams; output: string[] } {
  const args = preload ? ["--require", preload] : [];
  const child = spawn(process.execPath, [...args, "apps/gateway/dist/main.js", "--serve"], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  children.add(child);
  child.once("close", () => children.delete(child));
  return { child, output };
}

async function waitForHealth(
  port: number,
  gateway: { child: ChildProcessWithoutNullStreams; output: string[] },
  startupTimeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited early: ${gateway.output.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Wait for the isolated Gateway process to bind its loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Gateway health timed out: ${gateway.output.join("")}`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = await import("node:net").then(({ createServer }) => createServer());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback port reservation failed");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function requestJson(
  port: number,
  route: string,
  options: { method?: string; token?: string; body?: Record<string, unknown>; signal?: AbortSignal; origin?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: options.method ?? "GET",
    signal: options.signal,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitForHistoryDecision(
  port: number,
  gateway: { child: ChildProcessWithoutNullStreams; output: string[] },
  requestId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited before recording HDS decision: ${gateway.output.join("")}`);
    const response = await requestJson(port,
      `/history?kind=hds_decision&request_id=${encodeURIComponent(requestId)}`, { token: inboundToken });
    const history = response.body.history as Record<string, unknown> | undefined;
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    if (response.status === 200 && entries.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for HDS decision ${requestId}: ${gateway.output.join("")}`);
}

function waitForWebChatSend(webSocket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Developer decision delivery"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      webSocket.off("message", onMessage);
      webSocket.off("error", onError);
      webSocket.off("close", onClose);
    };
    const onMessage = (data: Buffer) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || (message as { kind?: unknown }).kind !== "channel_send") return;
      cleanup();
      resolve((message as { content?: string }).content ?? "");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("WebChat closed before Developer decision delivery"));
    webSocket.on("message", onMessage);
    webSocket.once("error", onError);
    webSocket.once("close", onClose);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!children.has(child)) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const closed = once(child, "close");
  child.kill();
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3_000);
  await closed;
  clearTimeout(timeout);
  children.delete(child);
}
