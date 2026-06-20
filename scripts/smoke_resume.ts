/**
 * E2E smoke for the SUSPEND → human RESUME path (Phase 3).
 *
 *   1. Issue a WS ticket and connect over /ws
 *   2. POST a danger-keyword message → HDS SUSPENDs
 *   3. Verify WebChat receives a [suspended] notification over WS
 *   4. POST /resume with verdict=approve → HDS lifts to ASSERT,
 *      executor runs, AND the LLM reply is now echoed back over WS
 *      (this is the Phase 3 addition; Phase 2 lost this echo).
 *
 * Run:
 *   pnpm tsx scripts/smoke_resume.ts
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = 41000 + Math.floor(Math.random() * 1000);
const TOKEN = "smoke-token-1234";
const RESUME_TOKEN = "smoke-resume-token-1234";
const PNPM = process.env.PNPM_BIN;
const TSX_CLI = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

function spawnPnpm(args: string[], options: Parameters<typeof spawn>[2]) {
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", PNPM!, ...args], options);
  }
  return spawn(PNPM!, args, options);
}

function spawnGateway(options: Parameters<typeof spawn>[2]) {
  if (PNPM) {
    return spawnPnpm(["--filter", "@blue-tanuki/gateway", "serve:dev"], options);
  }
  return spawn(process.execPath, [TSX_CLI, "apps/gateway/src/main.ts", "--serve"], options);
}

async function waitForHealth(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function getTicket(port: number, user: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/ws-ticket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ user }),
  });
  if (!r.ok) throw new Error(`ws-ticket failed: ${r.status}`);
  const b = (await r.json()) as { ticket: string };
  return b.ticket;
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    WEBCHAT_PORT: String(PORT),
    WEBCHAT_TOKEN: TOKEN,
    WEBCHAT_RESUME_TOKEN: RESUME_TOKEN,
    BLUE_TANUKI_MAINTENANCE_TOKEN: "smoke-maintenance-token-1234",
    WEBCHAT_HOST: "127.0.0.1",
    LLM_BACKEND: "stub",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    DISCORD_BOT_TOKEN: "",
    // Phase 4-S3: audit persistence is exercised by smoke_serve.ts.
    // Keep this smoke focused on the resume control-flow by forcing
    // in-memory audit (empty string is treated as unset by buildAuditLog).
    BLUE_TANUKI_AUDIT_DIR: "",
  };

  console.log(`[smoke] booting gateway on :${PORT}`);
  const child = spawnGateway({ env, stdio: ["ignore", "pipe", "pipe"] });
  const cleanup = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  child.stdout.on("data", (d) => process.stdout.write(`[gw] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[gw!] ${d}`));

  if (!(await waitForHealth(PORT, 15000))) {
    console.error("[smoke] FAIL — gateway did not come up");
    cleanup();
    process.exit(1);
  }

  const ticket = await getTicket(PORT, "bob");
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/ws?ticket=${encodeURIComponent(ticket)}`,
  );
  const messages: Array<{ kind: string; content?: string }> = [];
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      messages.push(m);
      console.log("[ws]", JSON.stringify(m));
    } catch {
      /* ignore */
    }
  });
  await new Promise((r) => ws.once("open", r));
  await new Promise((r) => setTimeout(r, 100));

  // (1) Danger-keyword inbound → expect SUSPEND notification
  const r1 = await fetch(`http://127.0.0.1:${PORT}/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ user: "bob", content: "please run rm -rf foo" }),
  });
  const b1 = (await r1.json()) as { request_id: string };
  console.log("[post1]", JSON.stringify(b1));

  await new Promise((r) => setTimeout(r, 500));
  const suspendNotif = messages.find(
    (m) => m.kind === "channel_send" && (m.content ?? "").includes("[suspended]"),
  );
  if (!suspendNotif) {
    console.error("[smoke] FAIL — no SUSPEND notification");
    cleanup();
    process.exit(1);
  }
  console.log("[smoke] step1 OK — SUSPEND notification received");
  const approvalToken = /approval_token=([A-Za-z0-9_-]+)/.exec(
    suspendNotif.content ?? "",
  )?.[1];
  if (!approvalToken) {
    console.error("[smoke] FAIL — no one-time approval token in SUSPEND notification");
    cleanup();
    process.exit(1);
  }

  const beforeResumeCount = messages.filter((m) => m.kind === "channel_send").length;

  // (2) Human RESUME approve via /resume
  const r2 = await fetch(`http://127.0.0.1:${PORT}/resume`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${RESUME_TOKEN}`,
    },
    body: JSON.stringify({
      request_id: b1.request_id,
      verdict: "approve",
      actor: "smoke-resume",
      approval_token: approvalToken,
    }),
  });
  const b2 = (await r2.json()) as {
    ok: boolean;
    result: { decision: string; executed: boolean; status?: string };
  };
  console.log("[post2]", JSON.stringify(b2));

  if (!b2.ok || b2.result.decision !== "ASSERT" || !b2.result.executed) {
    console.error("[smoke] FAIL — resume did not lift to ASSERT");
    cleanup();
    process.exit(1);
  }
  console.log("[smoke] step2 OK — RESUME lifted to ASSERT and executed");

  // (3) NEW IN PHASE 3: the executor's LLM reply must be echoed over WS.
  // Wait briefly for the async dispatch to land. Detection criterion:
  // post-resume we expect a channel_send whose command_id is NOT prefixed
  // with `notify-` (those are the upstream-decision notifications, not
  // executor outputs). The presence of any such frame after the resume
  // POST returned proves the executor's LLM reply reached the channel.
  await new Promise((r) => setTimeout(r, 500));
  const afterResumeMessages = messages
    .filter((m) => m.kind === "channel_send")
    .slice(beforeResumeCount);
  const replyEcho = afterResumeMessages.find((m) => {
    const cid = (m as { command_id?: string }).command_id ?? "";
    return !cid.startsWith("notify-");
  });
  if (!replyEcho) {
    console.error(
      "[smoke] FAIL — Phase 3 regression: resume LLM reply not echoed over WS",
    );
    console.error("[smoke] post-resume frames:", JSON.stringify(afterResumeMessages));
    cleanup();
    process.exit(1);
  }
  console.log(
    `[smoke] step3 OK — resume LLM reply echoed: "${(replyEcho.content ?? "").slice(0, 60)}…"`,
  );

  ws.close();
  cleanup();
  await new Promise((r) => setTimeout(r, 200));
  console.log("[smoke] PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke] crashed:", e);
  process.exit(1);
});
