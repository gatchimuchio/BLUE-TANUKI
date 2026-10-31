import type { HDSUpperController, OperationPlanReceiptReconciliationAuthorization } from "@blue-tanuki/hds-brain";
import type { ExecutionIntentReceipt } from "@blue-tanuki/core";
import { gmailWriteRequestPayloadDigest, inspectFileWriteOutcomeState } from "@blue-tanuki/core";
import { fileWritePayloadDigest, type ExecuteCommand, type InboundRequest, type OperationPlanExternalReceiptObservation } from "@blue-tanuki/protocol";
import { ingestLocalFileWriteStateObservation, ingestLocalInspectionReceipt } from "./external_receipt_observation.js";
import { queryLocalInspectionReceipt } from "./local_inspection_adapter.js";

export type LocalInspectionReconciliationResult =
  | { readonly status: "observed"; readonly observation: OperationPlanExternalReceiptObservation;
      readonly memory_status: "committed" | "pending" }
  | { readonly status: "not_run"; readonly reason: "local_inspection_endpoint_not_configured" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: "plan_receipt_reconciliation_authorization_expired_or_stale" };

/** Result text shared by the live Developer route and the local smoke boundary. */
export function localInspectionReconciliationMessage(result: LocalInspectionReconciliationResult): string {
  if (result.status === "observed") {
    const memory = result.memory_status === "committed"
      ? "digest-onlyの非権威観測をMへ保存しました。"
      : "観測はJへ記録済みですがMへの保存は未確認で、再調停が必要です。";
    const observationKind = result.observation.source === "local_file_state"
      ? "sandbox内file.write対象の状態観測" : "合成local inspectionのreceipt照合";
    return `${observationKind}を1回記録しました。観測=${result.observation.status}、候補数=${result.observation.match_count}。${memory} HDSのstep状態はoutcome_unknownのままです。これは成功・目標達成・再実行許可を意味せず、作用の再送もしていません。`;
  }
  if (result.status === "not_run") {
    return `照合は未実施です（${result.reason}）。loopback endpointが設定されていないため通信していません。HDSのstep状態はoutcome_unknownのままです。`;
  }
  if (result.status === "failed") {
    return `照合に失敗しました（${result.reason}）。この試行では結果観測を記録していません。HDSのstep状態はoutcome_unknownのままです。作用の再送はしていません。`;
  }
  return "照合許可が期限切れまたは古くなったため未実施です。HDSのstep状態はoutcome_unknownのままです。";
}

type ReconciliationHDS = Pick<HDSUpperController,
  "takeOperationPlanReceiptReconciliationAuthorization" | "recordOperationPlanExternalReceiptObservation" |
  "reconcileOperationPlanMemory" | "operationPlanReceiptObservationMemoryIsDurable">;

/** Consume one fresh J permit, perform one bounded read-only inspection, and retain digest-only evidence. */
export async function runLocalInspectionReconciliation(input: {
  hds: ReconciliationHDS;
  command: ExecuteCommand;
  caller: InboundRequest;
  lookupExecutionReceipt?: (command_key: string) => ExecutionIntentReceipt | null;
  endpoint?: string;
  now_ms?: number;
}): Promise<LocalInspectionReconciliationResult> {
  const authorization = input.hds.takeOperationPlanReceiptReconciliationAuthorization(
    input.command, input.caller, input.now_ms,
  );
  if (!authorization) return { status: "rejected", reason: "plan_receipt_reconciliation_authorization_expired_or_stale" };
  if (authorization.operation !== "file.write" && !input.endpoint?.trim()) {
    return { status: "not_run", reason: "local_inspection_endpoint_not_configured" };
  }
  try {
    let execution_receipt: ExecutionIntentReceipt | undefined;
    if (authorization.operation === "file.write") {
      if (input.lookupExecutionReceipt) {
        execution_receipt = input.lookupExecutionReceipt(authorization.command_key) ?? undefined;
        if (!execution_receipt || execution_receipt.command_key !== authorization.command_key ||
            execution_receipt.command_digest !== authorization.executor_command_digest ||
            execution_receipt.execution_epoch !== authorization.execution_epoch ||
            execution_receipt.task_identity_digest !== authorization.task_identity_digest ||
            execution_receipt.used_for_authority !== false) {
          throw new Error("local_file_state_gateway_receipt_unavailable_or_mismatched");
        }
      }
    }
    return await queryAndRecord(input.hds, authorization, input.caller, input.endpoint, execution_receipt);
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    const reason = /^[a-z0-9_]{1,100}$/.test(candidate) ? candidate : "local_inspection_failed";
    return { status: "failed", reason };
  }
}

async function queryAndRecord(
  hds: ReconciliationHDS,
  authorization: OperationPlanReceiptReconciliationAuthorization,
  caller: InboundRequest,
  endpoint?: string,
  execution_receipt?: ExecutionIntentReceipt,
): Promise<LocalInspectionReconciliationResult> {
  const common = {
    caller, command_id: authorization.command_id, command_digest: authorization.command_digest,
    executor_command_digest: authorization.executor_command_digest, plan_id_digest: authorization.plan_id_digest,
    revision_digest: authorization.revision_digest, step_id_digest: authorization.step_id_digest,
  };
  const observation = authorization.operation === "file.write"
    ? ingestLocalFileWriteStateObservation(hds, {
      ...common, parameters: authorization.parameters,
      execution_epoch: authorization.execution_epoch,
      task_identity_digest: authorization.task_identity_digest,
      execution_receipt: execution_receipt!,
      request_payload_digest: fileWritePayloadDigest(String(authorization.parameters.content ?? "")),
      inspection: await inspectFileWriteOutcomeState(authorization.parameters),
    })
    : ingestLocalInspectionReceipt(hds, {
      ...common, request_payload_digest: gmailWriteRequestPayloadDigest(authorization.parameters),
      response: await queryLocalInspectionReceipt(endpoint!, authorization.command_key),
    });
  const memory_status = hds.reconcileOperationPlanMemory() &&
      hds.operationPlanReceiptObservationMemoryIsDurable(observation.evidence_digest)
    ? "committed" : "pending";
  return { status: "observed", observation, memory_status };
}
