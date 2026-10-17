import type { HDSUpperController, OperationPlanReceiptReconciliationAuthorization } from "@blue-tanuki/hds-brain";
import { gmailWriteRequestPayloadDigest } from "@blue-tanuki/core";
import type { ExecuteCommand, InboundRequest, OperationPlanExternalReceiptObservation } from "@blue-tanuki/protocol";
import { ingestLocalInspectionReceipt } from "./external_receipt_observation.js";
import { queryLocalInspectionReceipt } from "./local_inspection_adapter.js";

export type LocalInspectionReconciliationResult =
  | { readonly status: "observed"; readonly observation: OperationPlanExternalReceiptObservation }
  | { readonly status: "not_run"; readonly reason: "local_inspection_endpoint_not_configured" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: "plan_receipt_reconciliation_authorization_expired_or_stale" };

type ReconciliationHDS = Pick<HDSUpperController,
  "takeOperationPlanReceiptReconciliationAuthorization" | "recordOperationPlanExternalReceiptObservation">;

/** Consume one fresh J permit, issue at most one loopback GET, and retain digest-only evidence. */
export async function runLocalInspectionReconciliation(input: {
  hds: ReconciliationHDS;
  command: ExecuteCommand;
  caller: InboundRequest;
  endpoint?: string;
  now_ms?: number;
}): Promise<LocalInspectionReconciliationResult> {
  const authorization = input.hds.takeOperationPlanReceiptReconciliationAuthorization(
    input.command, input.caller, input.now_ms,
  );
  if (!authorization) return { status: "rejected", reason: "plan_receipt_reconciliation_authorization_expired_or_stale" };
  if (!input.endpoint?.trim()) return { status: "not_run", reason: "local_inspection_endpoint_not_configured" };
  try {
    return await queryAndRecord(input.hds, authorization, input.caller, input.endpoint);
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
  endpoint: string,
): Promise<LocalInspectionReconciliationResult> {
  const requestPayloadDigest = gmailWriteRequestPayloadDigest(authorization.parameters);
  const response = await queryLocalInspectionReceipt(endpoint, authorization.command_key);
  const observation = ingestLocalInspectionReceipt(hds, {
    caller,
    command_id: authorization.command_id,
    command_digest: authorization.command_digest,
    executor_command_digest: authorization.executor_command_digest,
    plan_id_digest: authorization.plan_id_digest,
    revision_digest: authorization.revision_digest,
    step_id_digest: authorization.step_id_digest,
    request_payload_digest: requestPayloadDigest,
    response,
  });
  return { status: "observed", observation };
}
