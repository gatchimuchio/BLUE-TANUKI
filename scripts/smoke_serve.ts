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
 * Run from repo root:
 *   pnpm tsx scripts/smoke_serve.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = 40000 + Math.floor(Math.random() * 1000);
const TOKEN = "smoke-token-1234";
const RESUME_TOKEN = "smoke-resume-token-1234";
const PNPM = process.env.PNPM_BIN;
const TSX = process.env.TSX_BIN ?? "tsx";

function spawnPnpm(args: string[], options: Parameters<typeof spawn>[2]) {
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", PNPM!, ...args], options);
  }
  return spawn(PNPM!, args, options);
}

function spawnPnpmSync(args: string[], options: Parameters<typeof spawnSync>[2]) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", PNPM!, ...args], options);
  }
  return spawnSync(PNPM!, args, options);
}

function spawnGateway(options: Parameters<typeof spawn>[2]) {
  if (PNPM) {
    return spawnPnpm(["--filter", "@blue-tanuki/gateway", "serve:dev"], options);
  }
  return spawn(TSX, ["apps/gateway/src/main.ts", "--serve"], options);
}

function spawnAuditDump(options: Parameters<typeof spawnSync>[2]) {
  if (PNPM) {
    return spawnPnpmSync(
      [
        "--filter",
        "@blue-tanuki/gateway",
        "exec",
        "tsx",
        "src/main.ts",
        "--audit-dump",
        "--json",
      ],
      options,
    );
  }
  return spawnSync(
    TSX,
    ["apps/gateway/src/main.ts", "--audit-dump", "--json"],
    options,
  );
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
  const auditDir = mkdtempSync(join(tmpdir(), "smoke-audit-"));
  const env = {
    ...process.env,
    WEBCHAT_PORT: String(PORT),
    WEBCHAT_TOKEN: TOKEN,
    WEBCHAT_RESUME_TOKEN: RESUME_TOKEN,
    WEBCHAT_HOST: "127.0.0.1",
    LLM_BACKEND: "stub",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    DISCORD_BOT_TOKEN: "",
    BLUE_TANUKI_AUDIT_DIR: auditDir,
  };

  console.log(`[smoke] booting gateway on :${PORT}`);
  console.log(`[smoke] audit dir: ${auditDir}`);
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

  const up = await waitFor(`http://127.0.0.1:${PORT}/healthz`, 15000);
  if (!up) {
    console.error("[smoke] FAIL — gateway did not come up");
    cleanup();
    rmSync(auditDir, { recursive: true, force: true });
    process.exit(1);
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
    cleanup();
    rmSync(auditDir, { recursive: true, force: true });
    process.exit(1);
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

  cleanup();
  // Give the child a moment to die so file writes flush
  await new Promise((r) => setTimeout(r, 400));

  // Phase 4-S3: verify audit.jsonl was written.
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
    const dump = spawnAuditDump({ env, encoding: "utf8" });
    if (dump.status !== 0) {
      console.error(
        `[smoke] FAIL — audit-dump exit=${dump.status} stderr=${dump.stderr}`,
      );
      ok = false;
    } else {
      // Last non-empty line of stdout should be the JSON report.
      const dumpLines = dump.stdout.split("\n").filter((l) => l.trim().length > 0);
      const lastLine = dumpLines[dumpLines.length - 1] ?? "";
      try {
        // The report is multi-line pretty-JSON, so reparse the whole stdout
        // by extracting from the first '{' to the end.
        const idx = dump.stdout.indexOf("{");
        const parsed = JSON.parse(dump.stdout.slice(idx));
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

  rmSync(auditDir, { recursive: true, force: true });

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
