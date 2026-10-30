import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseBoundaryExchangeAtBoundary } from "@blue-tanuki/protocol";
import { runStandaloneHDSBrain } from "../src/standalone_harness.js";

const IPC_VERSION = "blue-tanuki.runtime-kernel-ipc.v1";
const REQUEST_CONTRACT_VERSION = "blue-tanuki.runtime-kernel-request.v2";
const SCHEMA_VERSION = "blue-tanuki.boundary-exchange.v1";
const CANONICALIZATION_VERSION = "blue-tanuki.jcs-safe-integer.v1";
const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const manifestPath = join(repositoryRoot, "packages", "hds-brain", "runtime-kernel-rust", "Cargo.toml");
const binaryPath = join(
  repositoryRoot,
  "packages",
  "hds-brain",
  "runtime-kernel-rust",
  "target",
  "debug",
  process.platform === "win32"
    ? "blue-tanuki-runtime-kernel-shadow.exe"
    : "blue-tanuki-runtime-kernel-shadow",
);

type JsonObject = Record<string, unknown>;

describe("Rust Runtime Kernelの無作用shadow IPC", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "--locked", "--manifest-path", manifestPath], {
      cwd: repositoryRoot,
      stdio: "pipe",
      timeout: 600_000,
    });
  }, 600_000);

  it("実プロセスで認証・canonical request/decision/receipt・拒否・安全停止を往復する", async () => {
    const key = randomBytes(32);
    const sessionId = randomUUID();
    const rawInput = "BLUE-TANUKI synthetic runtime shadow input sentinel";
    const hdsResult = runStandaloneHDSBrain({
      id: "runtime-shadow-synthetic-task",
      channel: "webchat",
      user: "synthetic-owner",
      content: rawInput,
    });
    expect(hdsResult.runtime_kernel_j_projection.status).toBe("comparable");
    if (hdsResult.runtime_kernel_j_projection.status !== "comparable") throw new Error("synthetic J projection unavailable");
    const shadowObservation = JSON.stringify(hdsResult.runtime_kernel_j_projection.projection);
    expect(hdsResult.audit_chain_valid).toBe(true);
    expect(shadowObservation).not.toContain(rawInput);
    const process = startKernel(key, sessionId);
    try {
      const ready = await process.nextFrame();
      const readyContent = verifyFrame(ready, key);
      expect(readyContent.message_kind).toBe("runtime_kernel_ready");
      expect(readyContent.sequence).toBe(0);
      expect(readyContent.payload).toMatchObject({
        status: "ready",
        capability: "shadow_only",
        effect_capability: false,
        memory_writer: false,
      });

      const firstRequest = makeDecisionRequest(sessionId, 1, 0, shadowObservation);
      await process.send(signFrame(firstRequest, key));
      const first = verifyFrame(await process.nextFrame(), key);
      expect(first.message_kind).toBe("decision_result");
      expect(first.sequence).toBe(1);
      expect(first.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_matched",
        decision: "hold",
        comparison_status: "matched",
        typescript_decision: hdsResult.decision,
        runtime_kernel_j_decision: hdsResult.decision,
        content_digest: createHash("sha256").update(shadowObservation, "utf8").digest("hex"),
        shadow_revision: 1,
        memory_revision: 0,
        effect_started: false,
        m_written: false,
        used_for_authority: false,
        may_execute: false,
      });

      await process.send(signFrame(firstRequest, key));
      const replay = verifyFrame(await process.nextFrame(), key);
      expect(replay.payload).toMatchObject({
        accepted_for_shadow: false,
        reason: "replayed_or_duplicate_sequence",
        shadow_revision: 1,
        effect_started: false,
        m_written: false,
      });

      await process.send(signFrame(makeDecisionRequest(sessionId, 2, 0, shadowObservation), key));
      const stale = verifyFrame(await process.nextFrame(), key);
      expect(stale.payload).toMatchObject({
        accepted_for_shadow: false,
        reason: "expected_revision_mismatch",
        shadow_revision: 1,
      });

      const expired = makeDecisionRequest(sessionId, 3, 1, shadowObservation);
      expired.payload.expires_at_utc = new Date(Date.now() - 1_000).toISOString();
      expired.payload.content_digest = createHash("sha256").update(shadowObservation, "utf8").digest("hex");
      await process.send(signFrame(expired, key));
      const expiry = verifyFrame(await process.nextFrame(), key);
      expect(expiry.payload).toMatchObject({
        accepted_for_shadow: false,
        reason: "request_expired",
        shadow_revision: 1,
      });

      await process.send(signFrame(makeDecisionRequest(sessionId, 4, 1, shadowObservation), key));
      const second = verifyFrame(await process.nextFrame(), key);
      expect(second.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_matched",
        comparison_status: "matched",
        typescript_decision: hdsResult.decision,
        runtime_kernel_j_decision: hdsResult.decision,
        shadow_revision: 2,
        memory_revision: 0,
        effect_started: false,
        m_written: false,
      });

      const mismatchedDecision = hdsResult.decision === "ASSERT" ? "SUSPEND" : "ASSERT";
      const mismatchedObservation = JSON.stringify({
        ...hdsResult.runtime_kernel_j_projection.projection,
        typescript_decision: mismatchedDecision,
      });
      await process.send(signFrame(makeDecisionRequest(sessionId, 5, 2, mismatchedObservation), key));
      const mismatch = verifyFrame(await process.nextFrame(), key);
      expect(mismatch.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_mismatched",
        decision: "hold",
        comparison_status: "mismatched",
        typescript_decision: mismatchedDecision,
        runtime_kernel_j_decision: hdsResult.decision,
        shadow_revision: 3,
        memory_revision: 0,
        effect_started: false,
        m_written: false,
        used_for_authority: false,
        may_execute: false,
      });

      await process.send(signFrame({
        protocol_version: IPC_VERSION,
        direction: "parent_to_kernel",
        session_id: sessionId,
        sequence: 6,
        message_kind: "shutdown",
        payload: {},
      }, key));
      const stopped = verifyFrame(await process.nextFrame(), key);
      expect(stopped.message_kind).toBe("shutdown_result");
      expect(stopped.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "safe_stop_acknowledged",
        effect_started: false,
        m_written: false,
        used_for_authority: false,
        may_execute: false,
      });
      expect(await process.exitCode()).toBe(0);
      expect(readFileSync(process.databasePath).includes(Buffer.from(rawInput))).toBe(false);
    } finally {
      await process.close();
    }
  }, 120_000);

  it("署名済みframeの改ざんを拒否してfail-closedで停止する", async () => {
    const key = randomBytes(32);
    const sessionId = randomUUID();
    const process = startKernel(key, sessionId);
    try {
      const ready = verifyFrame(await process.nextFrame(), key);
      expect(ready.message_kind).toBe("runtime_kernel_ready");

      const signed = signFrame(makeDecisionRequest(sessionId, 1, 0, "tamper sentinel"), key);
      const tampered = JSON.parse(signed) as JsonObject;
      const content = tampered.content as JsonObject;
      const payload = content.payload as JsonObject;
      payload.input_text = "modified after signing";
      await process.send(JSON.stringify(tampered));

      expect(await process.exitCode()).toBe(1);
      expect(process.stdoutText().split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      await process.close();
    }
  }, 120_000);

});

function startKernel(key: Buffer, sessionId: string) {
  const databaseDirectory = mkdtempSync(join(tmpdir(), "blue-tanuki-runtime-shadow-"));
  const databasePath = join(databaseDirectory, "shadow.sqlite3");
  const child = spawn(binaryPath, [], {
    cwd: repositoryRoot,
    env: {
      ...runtimeEnvironment(),
      BLUE_TANUKI_RUNTIME_KERNEL_SESSION_KEY: key.toString("hex"),
      BLUE_TANUKI_RUNTIME_KERNEL_SESSION_ID: sessionId,
      BLUE_TANUKI_RUNTIME_KERNEL_SHADOW_DB: databasePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let stdoutText = "";
  child.stdout.on("data", (chunk: Buffer) => { stdoutText += chunk.toString("utf8"); });
  let stderrText = "";
  child.stderr.on("data", (chunk: Buffer) => { stderrText += chunk.toString("utf8"); });
  let exitPromise: Promise<number> | undefined;
  const getExitCode = (): Promise<number> => {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    exitPromise ??= new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code ?? -1));
    });
    return exitPromise;
  };

  return {
    databasePath,
    async nextFrame(timeoutMs = 10_000): Promise<string> {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Rust Runtime Kernel response timeout. ${stderrText}`)), timeoutMs);
        });
        const result = await Promise.race([iterator.next(), timeout]);
        if (result.done) throw new Error(`Rust Runtime Kernel closed stdout. ${stderrText}`);
        return result.value;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async send(frame: string): Promise<void> {
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(`${frame}\n`, "utf8", (error) => error ? rejectWrite(error) : resolveWrite());
      });
    },
    exitCode(): Promise<number> {
      return getExitCode();
    },
    stdoutText(): string {
      return stdoutText;
    },
    async close(): Promise<void> {
      lines.close();
      if (child.exitCode === null) {
        const stopped = getExitCode().catch(() => -1);
        child.kill();
        await stopped;
      }
      rmSync(databaseDirectory, { recursive: true, force: true });
    },
  };
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  const required = [
    ["PATH", process.env.PATH ?? process.env.Path],
    ["SYSTEMROOT", process.env.SystemRoot ?? process.env.SYSTEMROOT],
    ["WINDIR", process.env.WINDIR],
    ["TEMP", process.env.TEMP],
    ["TMP", process.env.TMP],
    ["TMPDIR", process.env.TMPDIR],
    ["HOME", process.env.HOME],
    ["LANG", process.env.LANG],
  ] as const;
  for (const [name, value] of required) {
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function makeDecisionRequest(
  sessionId: string,
  sequence: number,
  expectedRevision: number,
  inputText: string,
): { protocol_version: string; direction: string; session_id: string; sequence: number; message_kind: string; payload: JsonObject } {
  return {
    protocol_version: IPC_VERSION,
    direction: "parent_to_kernel",
    session_id: sessionId,
    sequence,
    message_kind: "decision_request",
    payload: {
      contract_version: REQUEST_CONTRACT_VERSION,
      source_id: "typescript-hds-brain",
      target_id: "blue-tanuki-runtime-kernel-shadow",
      goal_id: "synthetic-goal",
      goal_version: 1,
      expected_revision: expectedRevision,
      input_text: inputText,
      content_digest: createHash("sha256").update(inputText, "utf8").digest("hex"),
      expires_at_utc: new Date(Date.now() + 60_000).toISOString(),
      budget: { max_steps: 1 },
    },
  };
}

function signFrame(
  content: JsonObject,
  key: Buffer,
): string {
  const issuedAt = new Date().toISOString();
  const unsigned = canonicalBoundaryExchange({
    schema_version: SCHEMA_VERSION,
    canonicalization_version: CANONICALIZATION_VERSION,
    issued_at_utc: issuedAt,
    content,
  });
  const mac = createHmac("sha256", key).update(unsigned).digest("hex");
  return Buffer.from(canonicalBoundaryExchange({
    schema_version: SCHEMA_VERSION,
    canonicalization_version: CANONICALIZATION_VERSION,
    issued_at_utc: issuedAt,
    content: { ...content, mac },
  })).toString("utf8");
}

function verifyFrame(frame: string, key: Buffer): JsonObject {
  const parsed = parseBoundaryExchangeAtBoundary(Buffer.from(frame, "utf8"));
  if (parsed.ok === false) throw new Error(`Rust Runtime Kernel returned invalid boundary exchange: ${parsed.reason}`);
  const envelope = JSON.parse(parsed.canonical_json) as JsonObject;
  const content = envelope.content as JsonObject;
  const macHex = content.mac;
  if (typeof macHex !== "string" || !/^[0-9a-f]{64}$/.test(macHex)) {
    throw new Error("Rust Runtime Kernel returned an invalid MAC field");
  }
  const unsignedContent = { ...content };
  delete unsignedContent.mac;
  const expectedMac = createHmac("sha256", key).update(canonicalBoundaryExchange({
    schema_version: envelope.schema_version,
    canonicalization_version: envelope.canonicalization_version,
    issued_at_utc: envelope.issued_at_utc,
    content: unsignedContent,
  })).digest();
  const providedMac = Buffer.from(macHex, "hex");
  if (providedMac.length !== expectedMac.length || !timingSafeEqual(providedMac, expectedMac)) {
    throw new Error("Rust Runtime Kernel response authentication failed");
  }
  return content;
}

function canonicalBoundaryExchange(value: JsonObject): Buffer {
  const result = parseBoundaryExchangeAtBoundary(Buffer.from(JSON.stringify(value), "utf8"));
  if (result.ok === false) throw new Error(`TypeScript boundary exchange rejected: ${result.reason}`);
  return Buffer.from(result.canonical_bytes);
}
