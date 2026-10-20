import { createHash } from "node:crypto";
import { executorCommandDigest, type ExecutionIntentReceipt } from "@blue-tanuki/core";
import { ExecutionAdmissionSchema, type ExecuteCommand, type ExecutionAdmission } from "@blue-tanuki/protocol";
import type { HDSUpperController } from "@blue-tanuki/hds-brain";
import type { GatewayExecutionIntentStore } from "./execution_intent_store.js";

/** 異なるdigest profileを直接比較せず、Executor側の実command同一性をここで照合する。 */
export function executionAdmissionForCommand(command: ExecuteCommand, receipt: ExecutionIntentReceipt | null): ExecutionAdmission {
  if (!receipt || receipt.state !== "issued" || receipt.command_digest !== executorCommandDigest(command) ||
      receipt.command_key !== createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command.id])).digest("hex")) {
    throw new Error("plan_executor_admission_mismatch");
  }
  const { ticket_id, command_key, command_digest, proof_digest, task_identity_digest, execution_epoch, issued_at_ms, expires_at_ms } = receipt;
  return ExecutionAdmissionSchema.parse({ ticket_id, command_key, command_digest, proof_digest,
    ...(task_identity_digest ? { task_identity_digest } : {}), execution_epoch, issued_at_ms, expires_at_ms });
}

/** 別DB間の配送。現世代だけJへ渡し、旧世代はprivate evidenceへ隔離する。 */
export function reconcileExecutionResults(
  hds: HDSUpperController,
  store: GatewayExecutionIntentStore,
  current_execution_epoch: string,
): {
  adopted: number; deferred: number; stale_generation_archived: number;
} {
  if (!/^[0-9a-f-]{36}$/i.test(current_execution_epoch)) throw new Error("execution_owner_epoch_invalid");
  let adopted = 0; let deferred = 0; let staleGenerationArchived = 0;
  for (const { delivery, delivery_digest } of store.pendingResults(1000)) {
    try {
      if (delivery.admission.execution_epoch !== current_execution_epoch) {
        store.archiveStaleGenerationResult(delivery.admission.ticket_id, delivery_digest, current_execution_epoch);
        staleGenerationArchived++;
        continue;
      }
      if (!hds.reconcileOperationPlanResult(delivery, delivery_digest)) { deferred++; continue; }
      store.acknowledgeResult(delivery.admission.ticket_id, delivery_digest);
      adopted++;
    } catch { deferred++; } // raw本文・エラーをログへ出さない。次の配送で同じ結果だけを再照合する。
  }
  return { adopted, deferred, stale_generation_archived: staleGenerationArchived };
}

/** 起動consumer。未決outbox/Mを回復できない場合、通常runtime開始前にfail-closedする。 */
export function reconcileStartupExecutionState(
  hds: HDSUpperController,
  store: GatewayExecutionIntentStore,
  current_execution_epoch: string,
): {
  readonly ready: boolean;
  readonly adopted: number;
  readonly deferred: number;
  readonly stale_generation_archived: number;
  readonly memory_ready: boolean;
  readonly result_store_readable: boolean;
} {
  let resultStoreReadable = true;
  const reconcile = () => {
    try { return reconcileExecutionResults(hds, store, current_execution_epoch); }
    catch { resultStoreReadable = false; return { adopted: 0, deferred: 0, stale_generation_archived: 0 }; }
  };
  const reconcileMemory = () => {
    try { return hds.reconcileOperationPlanMemory(); }
    catch { return false; }
  };
  const firstPass = reconcile();
  let adopted = firstPass.adopted;
  let deferred = firstPass.deferred;
  let staleGenerationArchived = firstPass.stale_generation_archived;
  let memoryReady = reconcileMemory();

  // M receipt回復で配送保留が解消した場合に限り、同じ不変receiptを一度だけ再照合する。
  if (deferred > 0 && memoryReady) {
    const retry = reconcile();
    adopted += retry.adopted;
    deferred = retry.deferred;
    staleGenerationArchived += retry.stale_generation_archived;
    memoryReady = reconcileMemory();
  }

  return { ready: resultStoreReadable && deferred === 0 && memoryReady, adopted, deferred,
    stale_generation_archived: staleGenerationArchived,
    memory_ready: memoryReady, result_store_readable: resultStoreReadable };
}
