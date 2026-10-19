import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { FileSearchWorker, FileSearchWorkerRequest, ExecutionWorkerIdentity } from "@blue-tanuki/core";
import { readWorkerPacket, workerPacket, validateWorkerResult } from "./file_search_worker_protocol.js";

/** 限定read-only worker。OS sandboxや独立D4 Broker Permissionを代替しない。 */
export function createFileSearchWorker(env: NodeJS.ProcessEnv = process.env): FileSearchWorker {
  // 親の資格・NODE_OPTIONS・任意loader・plugin registryは継承しない。
  const workerEnv: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (env[key]) workerEnv[key] = env[key];
  if (env.BLUE_TANUKI_FILE_ROOT) workerEnv.BLUE_TANUKI_FILE_ROOT = resolve(env.BLUE_TANUKI_FILE_ROOT);
  return Object.freeze({ invoke: (request: FileSearchWorkerRequest) => invoke(request, workerEnv) });
}

function invoke(request: FileSearchWorkerRequest, env: NodeJS.ProcessEnv): Promise<unknown> {
  if (request.signal?.aborted) return Promise.reject(new Error("file_search_worker_cancelled"));
  const worker_id = randomUUID();
  const started_at_ms = Date.now();
  const started_monotonic = performance.now();
  const remaining = request.ticket.expires_at_ms - started_at_ms;
  if (remaining <= 0) return Promise.reject(new Error("file_search_worker_ticket_expired"));
  // built artifactだけを使用。srcへ黙示fallbackしない。
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/file_search_worker_child.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../dist/", import.meta.url)), env: { ...env, BLUE_TANUKI_WORKER_ID: worker_id },
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
  });
  return new Promise((resolveResult, reject) => {
    let worker: Readonly<ExecutionWorkerIdentity> | undefined;
    let result: unknown; let received = false; let dispatched = false;
    let failure: Error | undefined; let closed = false;
    let timer: ReturnType<typeof setTimeout>; let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: string): void => {
      failure ??= new Error(code);
      if (closed) return;
      child.kill();
      forceTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 1_500);
    };
    const abort = (): void => fail("file_search_worker_cancelled; inspect receipt before retry");
    const arm = (ms: number): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail("file_search_worker_timeout; inspect receipt before retry"), ms);
    };
    arm(Math.min(10_000, remaining));
    request.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => fail("file_search_worker_start_or_transport_failed"));
    child.on("disconnect", () => { if (!received && !failure) fail("file_search_worker_disconnected; inspect receipt before retry"); });
    child.on("message", (value: unknown) => {
      try {
        if (failure || closed) return;
        const packet = readWorkerPacket(value);
        if (packet.worker_id !== worker_id || packet.pid !== child.pid) throw new Error("file_search_worker_identity_mismatch");
        if (!worker) {
          if (packet.type !== "ready" || packet.platform !== process.platform || !child.pid ||
              Object.keys(packet).some((key) => !["profile", "type", "worker_id", "pid", "platform"].includes(key))) throw new Error("file_search_worker_ready_invalid");
          const identity = Object.freeze({ worker_id, worker_pid: child.pid, worker_platform: process.platform, worker_started_at_ms: started_at_ms });
          request.on_started(identity);
          worker = identity;
          // 同期保存や起動待機で消費した時間を送信直前に再照合する。
          if (request.signal?.aborted || Date.now() >= request.ticket.expires_at_ms || performance.now() - started_monotonic >= remaining) {
            throw new Error("file_search_worker_ticket_expired");
          }
          const execute = workerPacket({ type: "execute", worker_id, ticket: request.ticket, command: request.command,
            target_version_observation: request.target_version_observation });
          request.before_dispatch();
          if (failure || request.signal?.aborted) throw new Error("file_search_worker_cancelled");
          dispatched = true;
          arm(request.command.constraints?.timeout_ms ?? 30_000);
          child.send(execute, (error) => { if (error) fail("file_search_worker_transport_failed"); });
        } else {
          if (packet.type === "error" && packet.code === "target_version_changed" &&
              packet.ticket_id === request.ticket.ticket_id && packet.execution_epoch === request.ticket.execution_epoch &&
              packet.command_digest === request.ticket.command_digest &&
              Object.keys(packet).every((key) => ["profile", "type", "worker_id", "pid", "ticket_id", "execution_epoch", "command_digest", "code"].includes(key))) {
            throw new Error("file_search_worker_target_version_changed; request fresh review");
          }
          if (!dispatched || received || packet.type !== "result" || packet.ticket_id !== request.ticket.ticket_id ||
              packet.execution_epoch !== request.ticket.execution_epoch || packet.command_digest !== request.ticket.command_digest ||
              Object.keys(packet).some((key) => !["profile", "type", "worker_id", "pid", "ticket_id", "execution_epoch", "command_digest", "result", "target_version_observation"].includes(key))) {
            throw new Error("file_search_worker_result_mismatch");
          }
          const targetVersionObservation = validateWorkerResult(packet.result, request.command,
            packet.target_version_observation, request.target_version_observation);
          result = { result: packet.result, target_version_observation: targetVersionObservation }; received = true;
          // 結果を受けても実exit確認までは成功を返さない。
          arm(5_000);
        }
      } catch (error) { fail(error instanceof Error ? error.message : "file_search_worker_rejected"); }
    });
    child.on("close", (code) => {
      closed = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
      request.signal?.removeEventListener("abort", abort);
      try { if (worker) request.on_exit(worker, Date.now()); }
      catch { failure ??= new Error("file_search_worker_exit_receipt_failed"); }
      if (failure) reject(failure);
      else if (code === 4 && dispatched) reject(new Error("file_search_worker_target_version_changed; request fresh review"));
      else if (code !== 0 || !received || !dispatched) reject(new Error(`file_search_worker_failed (${code ?? "signal"}); inspect configured file root and receipt`));
      else resolveResult(result);
    });
    if (request.signal?.aborted) abort();
  });
}
