import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const maintenanceToken = "recovery-l3-maintenance-test-token";
const resumeToken = "recovery-l3-owner-resume-test-token";
const inboundToken = "recovery-l3-inbound-test-token";
const secretMarker = "LOCAL_ONLY_RECOVERY_TEST_SECRET";
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
});

describe("Recovery mutation HDS L3 entry", () => {
  it("keeps state unchanged while queued, then executes once after owner resume approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-recovery-l3-"));
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, `LLM_BACKEND=openai-compatible\nLLM_API_KEY=${secretMarker}\n`, "utf8");
    const before = readFileSync(envFile, "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
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
          restore_effect_scope: "entire_selected_store",
          used_for_authority: false,
          may_execute: false,
          scope_applicability: { status: "unverified", used_for_authority: false, may_execute: false },
        },
      });
      const noRecoveryApproval = await requestJson(port, "/approval", { token: resumeToken });
      expect(noRecoveryApproval.body.pending_approvals).toEqual([]);
      expect(readFileSync(envFile, "utf8")).toBe(before);

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
      expect(approved.status).toBe(200);
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
});

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

function spawnGateway(env: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; output: string[] } {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/gateway/src/main.ts", "--serve"], {
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

async function waitForHealth(port: number, gateway: { child: ChildProcessWithoutNullStreams; output: string[] }): Promise<void> {
  const deadline = Date.now() + 15_000;
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
  options: { method?: string; token?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
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
