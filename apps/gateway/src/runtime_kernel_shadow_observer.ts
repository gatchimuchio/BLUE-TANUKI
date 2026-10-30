import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoundaryExchangeAtBoundary } from "@blue-tanuki/protocol";
import type {
  RuntimeKernelJProjectionResult,
  RuntimeKernelJProjectionUnavailableReason,
} from "@blue-tanuki/hds-brain";

const IPC_VERSION = "blue-tanuki.runtime-kernel-ipc.v1";
const REQUEST_CONTRACT_VERSION = "blue-tanuki.runtime-kernel-request.v2";
const SCHEMA_VERSION = "blue-tanuki.boundary-exchange.v1";
const CANONICALIZATION_VERSION = "blue-tanuki.jcs-safe-integer.v1";
const RESPONSE_TIMEOUT_MS = 1_000;
const MAX_PENDING_OBSERVATIONS = 8;

type JsonObject = Record<string, unknown>;

export interface RuntimeKernelShadowObservation {
  j_projection: RuntimeKernelJProjectionResult;
  command_present: boolean;
}

type ShadowDecision = "ASSERT" | "SUSPEND" | "OUT_OF_SCOPE" | "FAIL";
type ShadowRuleId =
  | "detector_lifecycle"
  | "per_axis_fail"
  | "per_axis_suspend_below"
  | "out_of_scope_below"
  | "aggregate_assert"
  | "default_suspend";

export type RuntimeKernelShadowObserverEvent =
  | { kind: "ready" }
  | {
    kind: "observation";
    sequence: number;
    shadow_revision: number;
    comparison_status: "matched" | "mismatched";
    typescript_decision: ShadowDecision;
    runtime_kernel_j_decision: ShadowDecision;
    rule_id: ShadowRuleId;
    rule_axis?: string;
    command_present: boolean;
  }
  | { kind: "comparison_unavailable"; reason: RuntimeKernelJProjectionUnavailableReason }
  | { kind: "dropped"; reason: "queue_full" }
  | { kind: "disabled" | "stopped"; reason: "binary_missing" | "startup_failed" | "ipc_exchange_failed" | "production_environment" };

export interface RuntimeKernelShadowObserver {
  observe(observation: RuntimeKernelShadowObservation): void;
  shutdown(): Promise<void>;
}

export async function startRuntimeKernelShadowObserver(options: {
  enabled: boolean;
  production: boolean;
  onEvent?: (event: RuntimeKernelShadowObserverEvent) => void;
}): Promise<RuntimeKernelShadowObserver | undefined> {
  const emit = (event: RuntimeKernelShadowObserverEvent): void => {
    try { options.onEvent?.(event); } catch { /* shadow telemetry must not affect the authority path */ }
  };
  if (!options.enabled) return undefined;
  if (options.production) {
    emit({ kind: "disabled", reason: "production_environment" });
    return undefined;
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const kernelDirectory = join(repositoryRoot, "packages", "hds-brain", "runtime-kernel-rust");
  const binaryPath = join(
    kernelDirectory,
    "target",
    "debug",
    process.platform === "win32"
      ? "blue-tanuki-runtime-kernel-shadow.exe"
      : "blue-tanuki-runtime-kernel-shadow",
  );
  if (!existsSync(binaryPath)) {
    emit({ kind: "disabled", reason: "binary_missing" });
    return undefined;
  }

  const key = randomBytes(32);
  const sessionId = randomUUID();
  let databaseDirectory: string;
  try {
    databaseDirectory = mkdtempSync(join(tmpdir(), "blue-tanuki-runtime-shadow-"));
  } catch {
    emit({ kind: "disabled", reason: "startup_failed" });
    return undefined;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binaryPath, [], {
      cwd: repositoryRoot,
      env: runtimeEnvironment({
        BLUE_TANUKI_RUNTIME_KERNEL_SESSION_KEY: key.toString("hex"),
        BLUE_TANUKI_RUNTIME_KERNEL_SESSION_ID: sessionId,
        BLUE_TANUKI_RUNTIME_KERNEL_SHADOW_DB: join(databaseDirectory, "shadow.sqlite3"),
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    removeTemporaryDatabase(databaseDirectory);
    emit({ kind: "disabled", reason: "startup_failed" });
    return undefined;
  }

  child.stderr.resume();
  let childError = false;
  child.on("error", () => { childError = true; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const readFrame = async (timeoutMs: number): Promise<string> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("response_timeout")), timeoutMs);
      });
      const next = iterator.next().then((result) => {
        if (result.done || childError) throw new Error("process_closed");
        return result.value;
      });
      return await Promise.race([next, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let cleaned = false;
  let failed = false;
  let accepting = true;
  let sequence = 0;
  let revision = 0;
  let pending = 0;
  let queue = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (!cleaned) {
      cleaned = true;
      lines.close();
      await terminateChild(child);
      removeTemporaryDatabase(databaseDirectory);
    }
  };
  const fail = async (): Promise<void> => {
    if (failed) return;
    failed = true;
    accepting = false;
    emit({ kind: "stopped", reason: "ipc_exchange_failed" });
    await cleanup();
  };

  try {
    const ready = verifyResponse(await readFrame(RESPONSE_TIMEOUT_MS), key, sessionId, 0, "runtime_kernel_ready");
    if (ready.status !== "ready" || ready.capability !== "shadow_only" ||
        ready.effect_capability !== false || ready.memory_writer !== false) {
      throw new Error("invalid_ready_receipt");
    }
  } catch {
    accepting = false;
    await cleanup();
    emit({ kind: "disabled", reason: "startup_failed" });
    return undefined;
  }
  emit({ kind: "ready" });

  const enqueueObservation = (observation: RuntimeKernelShadowObservation): void => {
    if (!accepting || failed) return;
    if (observation.j_projection.status !== "comparable") {
      emit({ kind: "comparison_unavailable", reason: observation.j_projection.reason });
      return;
    }
    const projection = observation.j_projection.projection;
    if (pending >= MAX_PENDING_OBSERVATIONS) {
      emit({ kind: "dropped", reason: "queue_full" });
      return;
    }
    pending += 1;
    queue = queue.then(async () => {
      if (failed) return;
      const nextSequence = sequence + 1;
      let inputText: string;
      try { inputText = JSON.stringify(projection); }
      catch { await fail(); return; }
      const inputBytes = Buffer.byteLength(inputText, "utf8");
      if (inputBytes > 65_536) {
        await fail();
        return;
      }
      const content: JsonObject = {
        protocol_version: IPC_VERSION,
        direction: "parent_to_kernel",
        session_id: sessionId,
        sequence: nextSequence,
        message_kind: "decision_request",
        payload: {
          contract_version: REQUEST_CONTRACT_VERSION,
          source_id: "typescript-hds-brain",
          target_id: "blue-tanuki-runtime-kernel-shadow",
          goal_id: "gateway-inbound-observation",
          goal_version: 1,
          expected_revision: revision,
          input_text: inputText,
          content_digest: createHash("sha256").update(inputText, "utf8").digest("hex"),
          expires_at_utc: new Date(Date.now() + 60_000).toISOString(),
          budget: { max_steps: 1 },
        },
      };
      try {
        await writeFrame(child, signFrame(content, key));
        const receipt = verifyResponse(
          await readFrame(RESPONSE_TIMEOUT_MS), key, sessionId, nextSequence, "decision_result",
        );
        const comparisonStatus = receipt.reason === "shadow_projection_matched"
          ? "matched"
          : receipt.reason === "shadow_projection_mismatched" ? "mismatched" : undefined;
        if (receipt.accepted_for_shadow !== true || comparisonStatus === undefined ||
            receipt.comparison_status !== comparisonStatus ||
            receipt.decision !== "hold" || receipt.shadow_revision !== revision + 1 ||
            receipt.memory_revision !== 0 || receipt.effect_started !== false || receipt.m_written !== false ||
            receipt.used_for_authority !== false || receipt.may_execute !== false ||
            receipt.typescript_decision !== projection.typescript_decision ||
            !isShadowDecision(receipt.runtime_kernel_j_decision) || !isShadowRuleId(receipt.rule_id) ||
            (receipt.rule_axis !== null && !isShadowAxis(receipt.rule_axis))) {
          throw new Error("invalid_shadow_receipt");
        }
        sequence = nextSequence;
        revision = receipt.shadow_revision as number;
        emit({
          kind: "observation",
          sequence,
          shadow_revision: revision,
          comparison_status: comparisonStatus,
          typescript_decision: projection.typescript_decision,
          runtime_kernel_j_decision: receipt.runtime_kernel_j_decision,
          rule_id: receipt.rule_id,
          ...(typeof receipt.rule_axis === "string" ? { rule_axis: receipt.rule_axis } : {}),
          command_present: observation.command_present,
        });
      } catch {
        await fail();
      }
    }).finally(() => { pending -= 1; });
  };

  return {
    observe: enqueueObservation,
    async shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      accepting = false;
      shutdownPromise = (async () => {
        await queue;
        if (!failed && child.exitCode === null && !childError) {
          try {
            const nextSequence = sequence + 1;
            const shutdownContent: JsonObject = {
              protocol_version: IPC_VERSION,
              direction: "parent_to_kernel",
              session_id: sessionId,
              sequence: nextSequence,
              message_kind: "shutdown",
              payload: {},
            };
            await writeFrame(child, signFrame(shutdownContent, key));
            const receipt = verifyResponse(
              await readFrame(RESPONSE_TIMEOUT_MS), key, sessionId, nextSequence, "shutdown_result",
            );
            if (receipt.accepted_for_shadow !== true || receipt.reason !== "safe_stop_acknowledged" ||
                receipt.decision !== "hold" || receipt.shadow_revision !== revision || receipt.memory_revision !== 0 ||
                receipt.effect_started !== false || receipt.m_written !== false ||
                receipt.used_for_authority !== false || receipt.may_execute !== false) {
              throw new Error("invalid_shutdown_receipt");
            }
            sequence = nextSequence;
          } catch {
            failed = true;
            emit({ kind: "stopped", reason: "ipc_exchange_failed" });
          }
        }
        await cleanup();
      })();
      return shutdownPromise;
    },
  };
}

function runtimeEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
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
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

function signFrame(content: JsonObject, key: Buffer): string {
  const issuedAt = new Date().toISOString();
  const unsigned = canonicalBoundaryJson({
    schema_version: SCHEMA_VERSION,
    canonicalization_version: CANONICALIZATION_VERSION,
    issued_at_utc: issuedAt,
    content,
  });
  const mac = createHmac("sha256", key).update(unsigned, "utf8").digest("hex");
  return canonicalBoundaryJson({
    schema_version: SCHEMA_VERSION,
    canonicalization_version: CANONICALIZATION_VERSION,
    issued_at_utc: issuedAt,
    content: { ...content, mac },
  });
}

function verifyResponse(
  frame: string,
  key: Buffer,
  sessionId: string,
  expectedSequence: number,
  expectedKind: string,
): JsonObject {
  const parsed = parseBoundaryExchangeAtBoundary(Buffer.from(frame, "utf8"));
  if (parsed.ok === false) throw new Error("invalid_boundary_exchange");
  const envelope = JSON.parse(parsed.canonical_json) as JsonObject;
  if (envelope.schema_version !== SCHEMA_VERSION || envelope.canonicalization_version !== CANONICALIZATION_VERSION ||
      typeof envelope.issued_at_utc !== "string" || !isObject(envelope.content)) {
    throw new Error("invalid_envelope");
  }
  const content = envelope.content;
  const macHex = content.mac;
  if (content.protocol_version !== IPC_VERSION || content.direction !== "kernel_to_parent" ||
      content.session_id !== sessionId || content.sequence !== expectedSequence ||
      content.message_kind !== expectedKind || typeof macHex !== "string" || !/^[0-9a-f]{64}$/.test(macHex) ||
      !isObject(content.payload)) {
    throw new Error("invalid_response_shape");
  }
  const unsignedContent = { ...content };
  delete unsignedContent.mac;
  const unsigned = canonicalBoundaryJson({
    schema_version: envelope.schema_version,
    canonicalization_version: envelope.canonicalization_version,
    issued_at_utc: envelope.issued_at_utc,
    content: unsignedContent,
  });
  const expectedMac = createHmac("sha256", key).update(unsigned, "utf8").digest();
  const actualMac = Buffer.from(macHex, "hex");
  if (!timingSafeEqual(expectedMac, actualMac)) throw new Error("response_authentication_failed");
  return content.payload;
}

function canonicalBoundaryJson(value: unknown): string {
  const parsed = parseBoundaryExchangeAtBoundary(Buffer.from(JSON.stringify(value), "utf8"));
  if (parsed.ok === false) throw new Error("invalid_boundary_exchange");
  return parsed.canonical_json;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isShadowDecision(value: unknown): value is ShadowDecision {
  return value === "ASSERT" || value === "SUSPEND" || value === "OUT_OF_SCOPE" || value === "FAIL";
}

function isShadowRuleId(value: unknown): value is ShadowRuleId {
  return value === "detector_lifecycle" || value === "per_axis_fail" || value === "per_axis_suspend_below" ||
    value === "out_of_scope_below" || value === "aggregate_assert" || value === "default_suspend";
}

function isShadowAxis(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value);
}

async function writeFrame(child: ChildProcessWithoutNullStreams, frame: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(`${frame}\n`, "utf8", (error) => error ? rejectWrite(error) : resolveWrite());
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (await waitForChildExit(child, 250)) return;
  try { child.kill(); } catch { /* cleanup continues for this owned shadow child */ }
  await waitForChildExit(child, 500);
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolveExit(exited);
    };
    const onExit = (): void => finish(true);
    const onError = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function removeTemporaryDatabase(directory: string): void {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* only this session-owned temporary directory */ }
}
