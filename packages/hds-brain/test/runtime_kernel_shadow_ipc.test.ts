import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseBoundaryExchangeAtBoundary } from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { runStandaloneHDSBrain } from "../src/standalone_harness.js";

const IPC_VERSION = "blue-tanuki.runtime-kernel-ipc.v1";
const REQUEST_CONTRACT_VERSION = "blue-tanuki.runtime-kernel-request.v7";
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

  it("実プロセスで認証・J比較・三種のowner復帰・拒否・安全停止を往復する", async () => {
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
        purpose_binding_matches: null,
        current_goal_purpose_binding_status: "not_bound",
        purpose_binding_current_matches: null,
        policy_decision_matches: true,
        policy_rule_matches: true,
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

      const resumeCases = [
        { verdict: "approve" as const, expected: "ASSERT", commandPresent: true },
        { verdict: "reject" as const, expected: "FAIL", commandPresent: false },
        { verdict: "block" as const, expected: "OUT_OF_SCOPE", commandPresent: false },
      ];
      for (const [index, resumeCase] of resumeCases.entries()) {
        const controller = new HDSUpperController();
        const requestId = `runtime-shadow-resume-${resumeCase.verdict}`;
        const suspended = controller.decide({
          id: requestId,
          channel: "webchat",
          user: "synthetic-owner",
          content: "credit card number",
          timestamp: Date.now(),
        });
        expect(suspended.log.commit.decision).toBe("SUSPEND");
        const resumed = controller.resume(requestId, resumeCase.verdict, {
          actor: "synthetic-owner-identity",
          token_kind: "resume",
        });
        expect(resumed.runtime_kernel_j_projection.status).toBe("comparable");
        if (resumed.runtime_kernel_j_projection.status !== "comparable") {
          throw new Error("synthetic resume projection unavailable");
        }
        const resumeObservation = JSON.stringify(resumed.runtime_kernel_j_projection.projection);
        expect(resumeObservation).not.toContain("credit card number");
        expect(resumeObservation).not.toContain(requestId);
        expect(resumeObservation).not.toContain("synthetic-owner-identity");

        const sequence = 6 + index;
        await process.send(signFrame(makeDecisionRequest(sessionId, sequence, 3 + index,
          resumeObservation), key));
        const resumeReceipt = verifyFrame(await process.nextFrame(), key);
        expect(resumeReceipt.payload).toMatchObject({
          accepted_for_shadow: true,
          reason: "shadow_projection_matched",
          decision: "hold",
          comparison_kind: "resume",
          comparison_status: "matched",
          policy_decision_matches: true,
          policy_rule_matches: true,
          lifecycle_matches: true,
          typescript_decision: resumeCase.expected,
          runtime_kernel_j_decision: resumeCase.expected,
          rule_id: "human_resume_transition",
          shadow_revision: 4 + index,
          memory_revision: 0,
          effect_started: false,
          m_written: false,
          used_for_authority: false,
          may_execute: false,
        });
        expect(resumed.command !== null).toBe(resumeCase.commandPresent);
      }

      await process.send(signFrame({
        protocol_version: IPC_VERSION,
        direction: "parent_to_kernel",
        session_id: sessionId,
        sequence: 9,
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

  it("HDS fail-safe SUSPENDをRust processが有限projectionから再判定し、停止だけを返す", async () => {
    const key = randomBytes(32);
    const sessionId = randomUUID();
    const controller = new HDSUpperController({ self_health: { hds_available: false } });
    const { log, command } = controller.decide({
      id: "runtime-shadow-self-health-task",
      channel: "webchat",
      user: "synthetic-owner",
      content: "synthetic self-health fail-safe input",
      timestamp: Date.now(),
    });
    expect(log.commit.decision).toBe("SUSPEND");
    expect(command).toBeNull();
    const projected = controller.runtimeKernelJProjection(log, command);
    expect(projected.status).toBe("comparable");
    if (projected.status !== "comparable") throw new Error("synthetic self-health projection unavailable");
    const projection = projected.projection;
    const projectionText = JSON.stringify(projection);
    expect(projection).toMatchObject({
      schema_version: "blue-tanuki.hds-runtime-j-projection.v12",
      typescript_decision: "SUSPEND",
      typescript_policy_rule_id: "detector_lifecycle",
      typescript_policy_rule_axis: "self_health",
      self_health_gate: {
        failed_precondition_count: 1,
        command_execution_allowed: false,
        downstream_execution_allowed: false,
        used_for_authority: false,
      },
    });
    expect(projectionText).not.toContain("hds_available");
    expect(projectionText).not.toContain("synthetic self-health fail-safe input");

    const process = startKernel(key, sessionId);
    try {
      await process.nextFrame();
      await process.send(signFrame(makeDecisionRequest(sessionId, 1, 0, projectionText), key));
      const compared = verifyFrame(await process.nextFrame(), key);
      expect(compared.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_matched",
        decision: "hold",
        comparison_kind: "decision",
        comparison_status: "matched",
        policy_decision_matches: true,
        policy_rule_matches: true,
        lifecycle_matches: true,
        typescript_decision: "SUSPEND",
        runtime_kernel_j_decision: "SUSPEND",
        rule_id: "detector_lifecycle",
        rule_axis: "self_health",
        effect_started: false,
        m_written: false,
        used_for_authority: false,
        may_execute: false,
        shadow_revision: 1,
      });

      const invalidProjection = JSON.stringify({
        ...projection,
        self_health_gate: { ...projection.self_health_gate, failed_precondition_count: 0 },
      });
      await process.send(signFrame(makeDecisionRequest(sessionId, 2, 1, invalidProjection), key));
      const invalid = verifyFrame(await process.nextFrame(), key);
      expect(invalid.payload).toMatchObject({
        accepted_for_shadow: false,
        reason: "projection_self_health_gate_rejected",
        decision: "hold",
        shadow_revision: 1,
        effect_started: false,
        m_written: false,
      });

      const invalidWeightProjection = JSON.stringify({
        ...projection,
        axes: [{ ...projection.axes[0], weight_micros: 1 }],
      });
      await process.send(signFrame(makeDecisionRequest(sessionId, 3, 1, invalidWeightProjection), key));
      const invalidWeight = verifyFrame(await process.nextFrame(), key);
      expect(invalidWeight.payload).toMatchObject({
        accepted_for_shadow: false,
        reason: "projection_self_health_gate_rejected",
        decision: "hold",
        shadow_revision: 1,
        effect_started: false,
        m_written: false,
      });

      await process.send(signFrame({
        protocol_version: IPC_VERSION,
        direction: "parent_to_kernel",
        session_id: sessionId,
        sequence: 4,
        message_kind: "shutdown",
        payload: {},
      }, key));
      const stopped = verifyFrame(await process.nextFrame(), key);
      expect(stopped.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "safe_stop_acknowledged",
        effect_started: false,
        m_written: false,
        used_for_authority: false,
        may_execute: false,
      });
    } finally {
      await process.close();
    }
  }, 120_000);

  it("Rust shadowは目的版・goal identity digestの不一致を比較残差として返し正本を更新しない", async () => {
    const key = randomBytes(32);
    const sessionId = randomUUID();
    const hdsResult = runStandaloneHDSBrain({
      id: "runtime-shadow-purpose-version-task",
      channel: "webchat",
      user: "synthetic-owner",
      content: "synthetic purpose-bound task",
    });
    expect(hdsResult.runtime_kernel_j_projection.status).toBe("comparable");
    if (hdsResult.runtime_kernel_j_projection.status !== "comparable") throw new Error("synthetic J projection unavailable");
    const goalIdDigest = "a".repeat(64);
    const purposeDigest = "b".repeat(64);
    const goalId = `goal-${goalIdDigest}`;
    const projectionText = JSON.stringify({
      ...hdsResult.runtime_kernel_j_projection.projection,
      purpose_binding: { goal_id_digest: goalIdDigest, purpose_version: 7, purpose_digest: purposeDigest },
      current_goal_purpose_binding: {
        status: "available",
        binding: { goal_id_digest: goalIdDigest, purpose_version: 7, purpose_digest: purposeDigest },
      },
    });
    const process = startKernel(key, sessionId);
    try {
      await process.nextFrame();
      await process.send(signFrame(makeDecisionRequest(sessionId, 1, 0, projectionText, goalId, 7), key));
      const matched = verifyFrame(await process.nextFrame(), key);
      expect(matched.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_matched",
        decision: "hold",
        comparison_status: "matched",
        purpose_binding_matches: true,
        current_goal_purpose_binding_status: "available",
        purpose_binding_current_matches: true,
        goal_id: goalId,
        goal_version: 7,
        shadow_revision: 1,
        memory_revision: 0,
        effect_started: false,
        m_written: false,
        used_for_authority: false,
        may_execute: false,
      });

      await process.send(signFrame(makeDecisionRequest(sessionId, 2, 1, projectionText, goalId, 8), key));
      const mismatch = verifyFrame(await process.nextFrame(), key);
      expect(mismatch.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_mismatched",
        decision: "hold",
        comparison_status: "mismatched",
        purpose_binding_matches: false,
        current_goal_purpose_binding_status: "available",
        purpose_binding_current_matches: true,
        policy_decision_matches: true,
        goal_id: goalId,
        goal_version: 8,
        shadow_revision: 2,
        effect_started: false,
        m_written: false,
        may_execute: false,
      });

      const differentGoalId = `goal-${"c".repeat(64)}`;
      await process.send(signFrame(makeDecisionRequest(sessionId, 3, 2, projectionText, differentGoalId, 7), key));
      const identityMismatch = verifyFrame(await process.nextFrame(), key);
      expect(identityMismatch.payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "shadow_projection_mismatched",
        decision: "hold",
        comparison_status: "mismatched",
        purpose_binding_matches: false,
        current_goal_purpose_binding_status: "available",
        purpose_binding_current_matches: true,
        goal_id: differentGoalId,
        goal_version: 7,
        shadow_revision: 3,
        effect_started: false,
        m_written: false,
        may_execute: false,
      });

      await process.send(signFrame({
        protocol_version: IPC_VERSION,
        direction: "parent_to_kernel",
        session_id: sessionId,
        sequence: 4,
        message_kind: "shutdown",
        payload: {},
      }, key));
      expect(verifyFrame(await process.nextFrame(), key).payload).toMatchObject({
        accepted_for_shadow: true,
        reason: "safe_stop_acknowledged",
        effect_started: false,
        m_written: false,
      });
      expect(await process.exitCode()).toBe(0);
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
  goalId = "synthetic-goal",
  goalVersion = 1,
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
      goal_id: goalId,
      goal_version: goalVersion,
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
