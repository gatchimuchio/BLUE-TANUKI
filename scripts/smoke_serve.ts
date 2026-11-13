/**
 * E2E smoke test for `pnpm gateway:serve:dev`.
 * Boots the gateway via `tsx ./apps/gateway/src/main.ts --serve`,
 * waits for /healthz, opens a WS, POSTs an inbound message, and asserts
 * that a channel_send is echoed back over WS.
 *
 * Phase 4-S3 additions:
 *   - Sets BLUE_TANUKI_AUDIT_DIR to a tmp dir before boot.
 *   - After the channel_send echo arrives, kills the gateway and verifies
 *     that audit.jsonl exists and is non-empty, then runs
 *     `tsx apps/gateway/src/main.ts --audit-dump --json` against the same
 *     dir and asserts exit_code=0 with at least one entry. This pins the
 *     end-to-end persistence path AND the dump CLI in one go.
 *
 * Run from repo root with `pnpm smoke:serve`.
 * The spawned Gateway receives only OS support variables and synthetic smoke
 * settings; ambient provider/channel credentials and env-file selectors are not forwarded.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = 40000 + Math.floor(Math.random() * 1000);
// Gateway initializes several private stores before it starts listening.
const STARTUP_TIMEOUT_MS = 60_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const TOKEN = "smoke-token-1234";
const RESUME_TOKEN = "smoke-resume-token-1234";
const TSX_CLI = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const INHERITED_OS_ENV_KEYS =
  process.platform === "win32"
    ? [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
      ]
    : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"];

// Keep secrets, env-file selectors, Node preload hooks, proxy settings, and
// user-specific Gateway configuration out of both child processes.
function createBaseChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_OS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function createGatewayEnvironment(auditDir: string, stateRoot: string): NodeJS.ProcessEnv {
  return {
    ...createBaseChildEnvironment(),
    WEBCHAT_PORT: String(PORT),
    WEBCHAT_TOKEN: TOKEN,
    WEBCHAT_RESUME_TOKEN: RESUME_TOKEN,
    BLUE_TANUKI_MAINTENANCE_TOKEN: "smoke-maintenance-token-1234",
    WEBCHAT_HOST: "127.0.0.1",
    LLM_BACKEND: "stub",
    BLUE_TANUKI_AUDIT_DIR: auditDir,
    BLUE_TANUKI_STATE_ROOT: stateRoot,
  };
}

function createAuditDumpEnvironment(auditDir: string): NodeJS.ProcessEnv {
  return {
    ...createBaseChildEnvironment(),
    BLUE_TANUKI_AUDIT_DIR: auditDir,
  };
}

function spawnGateway(options: Parameters<typeof spawn>[2]) {
  return spawn(process.execPath, [TSX_CLI, "apps/gateway/src/main.ts", "--serve"], options);
}

function spawnAuditDump(options: Parameters<typeof spawnSync>[2]) {
  return spawnSync(
    process.execPath,
    [TSX_CLI, "apps/gateway/src/main.ts", "--audit-dump", "--json"],
    options,
  );
}

function runAuditDumpToFiles(env: NodeJS.ProcessEnv, auditDir: string) {
  const stdoutFile = join(auditDir, "audit-dump.stdout.json");
  const stderrFile = join(auditDir, "audit-dump.stderr.log");
  const stdoutFd = openSync(stdoutFile, "w");
  const stderrFd = openSync(stderrFile, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnAuditDump({
      env,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return {
    result,
    stdout: existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : "",
    stderr: existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : "",
  };
}

async function waitFor(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "smoke-serve-"));
  const auditDir = join(tempRoot, "audit");
  const stateRoot = join(tempRoot, "state");
  mkdirSync(auditDir, { recursive: true });
  const gatewayEnv = createGatewayEnvironment(auditDir, stateRoot);

  console.log(`[smoke] booting gateway on :${PORT}`);
  console.log(`[smoke] audit dir: ${auditDir}`);
  const child = spawnGateway({ env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"] });

  const cleanup = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  };
  const stopGateway = async (): Promise<boolean> => {
    cleanup();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const onClose = (): void => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          child.off("close", onClose);
          resolve();
        }, CHILD_SHUTDOWN_TIMEOUT_MS);
        child.once("close", onClose);
      });
    }
    if (child.exitCode === null && child.signalCode === null) {
      console.error(`[smoke] temp state retained because gateway did not exit: ${tempRoot}`);
      return false;
    }
    return true;
  };
  process.on("exit", cleanup);

  child.stdout?.on("data", (d) => process.stdout.write(`[gw] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[gw!] ${d}`));

  const up = await waitFor(`http://127.0.0.1:${PORT}/healthz`, STARTUP_TIMEOUT_MS);
  if (!up) {
    console.error("[smoke] FAIL — gateway did not come up");
    if (await stopGateway()) rmSync(tempRoot, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  console.log("[smoke] gateway is up");

  // Phase 3: get a one-time WS ticket first.
  const tRes = await fetch(`http://127.0.0.1:${PORT}/ws-ticket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ user: "alice" }),
  });
  if (!tRes.ok) {
    console.error("[smoke] FAIL — could not obtain WS ticket");
    if (await stopGateway()) rmSync(tempRoot, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  const { ticket } = (await tRes.json()) as { ticket: string };

  // Open WS first so we don't miss the channel_send reply.
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/ws?ticket=${encodeURIComponent(ticket)}`,
  );
  const messages: Array<{ kind: string; [k: string]: unknown }> = [];
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
  // Allow hello to flush
  await new Promise((r) => setTimeout(r, 100));

  // Post an inbound benign message
  const res = await fetch(`http://127.0.0.1:${PORT}/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ user: "alice", content: "Hello smoke" }),
  });
  const body = await res.json();
  console.log("[post]", JSON.stringify(body));

  // Wait for the LLM stub round-trip + channel_send echo
  await new Promise((r) => setTimeout(r, 2500));
  ws.close();

  const hello = messages.filter((m) => m.kind === "hello");
  const sends = messages.filter((m) => m.kind === "channel_send");
  let ok = true;
  if (hello.length === 0) {
    console.error("[smoke] FAIL — no hello received");
    ok = false;
  }
  if (sends.length === 0) {
    console.error("[smoke] FAIL — no channel_send echo received");
    ok = false;
  }

  const gatewayStopped = await stopGateway();
  if (!gatewayStopped) {
    process.exitCode = 1;
    return;
  }

  // Phase 4-S3: verify audit.jsonl was written after the Gateway flushes it.
  const auditFile = join(auditDir, "audit.jsonl");
  if (!existsSync(auditFile)) {
    console.error(`[smoke] FAIL — audit file not written at ${auditFile}`);
    ok = false;
  } else if (statSync(auditFile).size === 0) {
    console.error(`[smoke] FAIL — audit file is empty`);
    ok = false;
  } else {
    // Sanity: each line is valid JSON with the expected shape.
    const lines = readFileSync(auditFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    let parsedAll = true;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (
          typeof obj.index !== "number" ||
          typeof obj.entry_hash !== "string" ||
          typeof obj.prev_hash !== "string"
        ) {
          parsedAll = false;
          break;
        }
      } catch {
        parsedAll = false;
        break;
      }
    }
    if (!parsedAll) {
      console.error(`[smoke] FAIL — audit lines did not parse cleanly`);
      ok = false;
    } else {
      console.log(`[smoke] audit raw OK — ${lines.length} JSONL lines`);
    }
  }

  // Phase 4-S3: also exercise the audit-dump CLI end-to-end.
  if (ok) {
    const { result: dump, stdout: dumpStdout, stderr: dumpStderr } =
      runAuditDumpToFiles(createAuditDumpEnvironment(auditDir), auditDir);
    if (dump.status !== 0) {
      console.error(
        `[smoke] FAIL — audit-dump exit=${dump.status} stderr=${dumpStderr}${dump.error ? ` error=${dump.error.message}` : ""}`,
      );
      ok = false;
    } else {
      // Last non-empty line of stdout should be the JSON report.
      const dumpLines = dumpStdout.split("\n").filter((l) => l.trim().length > 0);
      const lastLine = dumpLines[dumpLines.length - 1] ?? "";
      try {
        // The report is multi-line pretty-JSON, so reparse the whole stdout
        // by extracting from the first '{' to the end.
        const idx = dumpStdout.indexOf("{");
        const parsed = JSON.parse(dumpStdout.slice(idx));
        if (parsed.status !== "ok") {
          console.error(
            `[smoke] FAIL — audit-dump status=${parsed.status} detail=${parsed.detail}`,
          );
          ok = false;
        } else if (!parsed.chain_valid || parsed.entry_count < 1) {
          console.error(
            `[smoke] FAIL — audit-dump chain_valid=${parsed.chain_valid} entries=${parsed.entry_count}`,
          );
          ok = false;
        } else {
          console.log(
            `[smoke] audit-dump OK — ${parsed.entry_count} entries, chain verified`,
          );
        }
      } catch (e) {
        console.error(
          `[smoke] FAIL — audit-dump output not parseable: ${(e as Error).message}, last=${lastLine}`,
        );
        ok = false;
      }
    }
  }

  if (gatewayStopped) {
    try { rmSync(tempRoot, { recursive: true, force: true }); }
    catch (error) {
      console.error(`[smoke] temp state retained because cleanup failed: ${tempRoot}`);
      console.error(`[smoke] cleanup error: ${(error as Error).message}`);
      ok = false;
    }
  }

  if (ok) {
    console.log(
      "[smoke] PASS — hello + channel_send + audit persistence + audit-dump CLI all green",
    );
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] crashed:", e);
  process.exit(1);
});
