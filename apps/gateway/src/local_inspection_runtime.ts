import type { HDSUpperController, OperationPlanReceiptReconciliationAuthorization } from "@blue-tanuki/hds-brain";
import type { ExecutionIntentReceipt } from "@blue-tanuki/core";
import { gmailWriteRequestPayloadDigest, googleCalendarCreateEventId, googleCalendarWriteRequestPayloadDigest,
  googleCalendarWriteTargetIdentityDigest, inspectFileWriteOutcomeState, readGoogleCalendarEventReceipt } from "@blue-tanuki/core";
import { fileWritePayloadDigest, type ExecuteCommand, type InboundRequest, type OperationPlanExternalReceiptObservation } from "@blue-tanuki/protocol";
import { createLocalFileWriteStateObservation, ingestLocalFileWriteStateObservation,
  ingestGoogleCalendarReceiptObservation, ingestLocalInspectionReceipt,
  type LocalInspectionReceiptInput } from "./external_receipt_observation.js";
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
      ? "sandbox内file.write対象の状態観測"
      : result.observation.source === "google_calendar_read"
        ? "Google Calendarの対象event読取" : "合成local inspectionのreceipt照合";
    const inviteNotice = result.observation.provider_operation === "event.invite"
      ? result.observation.status === "matched"
        ? " Calendarの参加者一覧に要求宛先が含まれることを確認しました。招待通知の配信・到達は確認できず、event.inviteは再送していません。"
        : " Calendarの参加者一覧に要求宛先全員が含まれることを確認できませんでした。招待通知の配信・到達も確認できず、event.inviteは再送していません。"
      : "";
    return `${observationKind}を1回記録しました。観測=${result.observation.status}、候補数=${result.observation.match_count}。${memory} HDSのstep状態はoutcome_unknownのままです。これは成功・目標達成・再実行許可を意味せず、作用の再送もしていません。${inviteNotice}`;
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

type OwnerSelectedFileStateRefreshHDS = Pick<HDSUpperController,
  "issueOwnerSelectedFileStateObservationAuthorizations" | "recordOwnerSelectedFileStateObservationAuthorization" |
  "reconcileOperationPlanMemory" | "operationPlanReceiptObservationMemoryIsDurable">;

export type OwnerSelectedFileStateRefreshFailureReason =
  | "plan_compute_source_observation_authorization_failed"
  | "plan_compute_source_observation_inspection_failed"
  | "plan_compute_source_observation_memory_unavailable";

export type OwnerSelectedFileStateRefreshResult =
  | { readonly status: "none" | "refreshed" }
  | { readonly status: "failed"; readonly reason: OwnerSelectedFileStateRefreshFailureReason };

/** Refresh explicitly selected file-state context before plan computation; this path only observes and stores digests. */
export async function refreshOwnerSelectedFileStateObservations(input: {
  hds: OwnerSelectedFileStateRefreshHDS;
  caller: InboundRequest;
  lookupExecutionReceipt: (command_key: string) => ExecutionIntentReceipt | null;
}): Promise<OwnerSelectedFileStateRefreshResult> {
  if (!/^plan:compute(?:\s|$)/i.test(input.caller.content.trim())) return { status: "none" };
  let authorizations: ReturnType<OwnerSelectedFileStateRefreshHDS["issueOwnerSelectedFileStateObservationAuthorizations"]>;
  try {
    authorizations = input.hds.issueOwnerSelectedFileStateObservationAuthorizations(input.caller);
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    return { status: "failed", reason: candidate.includes("memory") || candidate === "owner_gateway_receipt_recheck_unavailable"
      ? "plan_compute_source_observation_memory_unavailable"
      : "plan_compute_source_observation_authorization_failed" };
  }
  if (!authorizations?.length) return { status: "none" };
  const observations: OperationPlanExternalReceiptObservation[] = [];
  try {
    for (const authorization of authorizations) {
      const receipt = input.lookupExecutionReceipt(authorization.command_key);
      if (!receipt || receipt.command_key !== authorization.command_key ||
          receipt.command_digest !== authorization.executor_command_digest ||
          receipt.execution_epoch !== authorization.execution_epoch ||
          receipt.task_identity_digest !== authorization.task_identity_digest || receipt.used_for_authority !== false ||
          authorization.parameters.mode !== "create" || typeof authorization.parameters.path !== "string" ||
          typeof authorization.parameters.content !== "string") {
        throw new Error("plan_compute_source_observation_authorization_failed");
      }
      let inspection: Awaited<ReturnType<typeof inspectFileWriteOutcomeState>>;
      try { inspection = await inspectFileWriteOutcomeState(authorization.parameters); }
      catch { throw new Error("plan_compute_source_observation_inspection_failed"); }
      let observation: OperationPlanExternalReceiptObservation;
      try {
        observation = createLocalFileWriteStateObservation({
          caller: input.caller,
          command_id: authorization.command_id,
          command_digest: authorization.command_digest,
          executor_command_digest: authorization.executor_command_digest,
          plan_id_digest: authorization.plan_id_digest,
          revision_digest: authorization.revision_digest,
          step_id_digest: authorization.step_id_digest,
          parameters: authorization.parameters,
          execution_epoch: authorization.execution_epoch,
          task_identity_digest: authorization.task_identity_digest,
          execution_receipt: receipt,
          request_payload_digest: fileWritePayloadDigest(authorization.parameters.content),
          inspection,
        });
      } catch { throw new Error("plan_compute_source_observation_authorization_failed"); }
      if (!input.hds.recordOwnerSelectedFileStateObservationAuthorization(
        authorization.authorization_id, observation, input.caller,
      )) throw new Error("plan_compute_source_observation_authorization_failed");
      observations.push(observation);
    }
    if (!input.hds.reconcileOperationPlanMemory() ||
        observations.some((observation) => !input.hds.operationPlanReceiptObservationMemoryIsDurable(observation.evidence_digest))) {
      throw new Error("plan_compute_source_observation_memory_unavailable");
    }
    return { status: "refreshed" };
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    const reason: OwnerSelectedFileStateRefreshFailureReason = candidate === "plan_compute_source_observation_memory_unavailable"
      ? "plan_compute_source_observation_memory_unavailable"
      : candidate === "plan_compute_source_observation_inspection_failed"
        ? "plan_compute_source_observation_inspection_failed"
        : "plan_compute_source_observation_authorization_failed";
    return { status: "failed", reason };
  }
}

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
  if (authorization.operation !== "file.write" && authorization.operation !== "google.calendar.write" && !input.endpoint?.trim()) {
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
    : authorization.operation === "google.calendar.write"
      ? await reconcileGoogleCalendarWriteReceipt(hds, authorization, caller, common)
      : ingestLocalInspectionReceipt(hds, {
        ...common, request_payload_digest: gmailWriteRequestPayloadDigest(authorization.parameters),
        response: await queryLocalInspectionReceipt(endpoint!, authorization.command_key),
      });
  const memory_status = hds.reconcileOperationPlanMemory() &&
      hds.operationPlanReceiptObservationMemoryIsDurable(observation.evidence_digest)
    ? "committed" : "pending";
  return { status: "observed", observation, memory_status };
}

async function reconcileGoogleCalendarWriteReceipt(
  hds: ReconciliationHDS,
  authorization: OperationPlanReceiptReconciliationAuthorization,
  caller: InboundRequest,
  common: Pick<LocalInspectionReceiptInput, "command_id" | "command_digest" | "executor_command_digest" |
    "plan_id_digest" | "revision_digest" | "step_id_digest">,
): Promise<OperationPlanExternalReceiptObservation> {
  const parameters = authorization.parameters;
  const operation = parameters.operation;
  const calendarId = typeof parameters.calendar_id === "string" && parameters.calendar_id.trim()
    ? parameters.calendar_id.trim()
    : operation === "event.invite" && parameters.event_observation && typeof parameters.event_observation === "object" &&
        !Array.isArray(parameters.event_observation) && typeof (parameters.event_observation as Record<string, unknown>).calendar_id === "string"
      ? String((parameters.event_observation as Record<string, unknown>).calendar_id) : "primary";
  const eventId = operation === "event.create"
    ? googleCalendarCreateEventId(parameters)
    : typeof parameters.event_id === "string" ? parameters.event_id.trim() : "";
  if ((operation !== "event.create" && operation !== "event.invite") || !eventId || !calendarId) {
    throw new Error("google_calendar_receipt_parameters_invalid");
  }
  const expectedInvitees = operation === "event.invite"
    ? Array.isArray(parameters.attendees) && parameters.attendees.every((entry) => typeof entry === "string")
      ? parameters.attendees as string[]
      : (() => { throw new Error("google_calendar_receipt_parameters_invalid"); })()
    : undefined;
  const lookup = await readGoogleCalendarEventReceipt(calendarId, eventId, {
    maxBytes: 32_768,
    ...(expectedInvitees ? { expectedInvitees } : {}),
  });
  return ingestGoogleCalendarReceiptObservation(hds, {
    ...common,
    caller,
    parameters,
    target_identity_digest: googleCalendarWriteTargetIdentityDigest(parameters),
    request_payload_digest: googleCalendarWriteRequestPayloadDigest(parameters),
    lookup,
  });
}
