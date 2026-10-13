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
  const { ticket_id, command_key, command_digest, proof_digest, execution_epoch, issued_at_ms, expires_at_ms } = receipt;
  return ExecutionAdmissionSchema.parse({ ticket_id, command_key, command_digest, proof_digest, execution_epoch, issued_at_ms, expires_at_ms });
}

/** 別DB間の配送。J保存→ackの順とし、失敗はpendingを保持する。作用・承認を呼ばない。 */
export function reconcileExecutionResults(hds: HDSUpperController, store: GatewayExecutionIntentStore): {
  adopted: number; deferred: number;
} {
  let adopted = 0; let deferred = 0;
  for (const { delivery, delivery_digest } of store.pendingResults(1000)) {
    try {
      if (!hds.reconcileOperationPlanResult(delivery, delivery_digest)) { deferred++; continue; }
      store.acknowledgeResult(delivery.admission.ticket_id, delivery_digest);
      adopted++;
    } catch { deferred++; } // raw本文・エラーをログへ出さない。次の配送で同じ結果だけを再照合する。
  }
  return { adopted, deferred };
}
