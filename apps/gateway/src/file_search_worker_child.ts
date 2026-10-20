import { invokeFileSearch } from "@blue-tanuki/core";
import { FILE_SEARCH_WORKER_PROFILE, readWorkerPacket, validateWorkerRequest, workerPacket } from "./file_search_worker_protocol.js";
import { currentHostAudienceDigest, isHostAudienceDigest } from "./host_audience_identity.js";

// 通常Gatewayから固定artifactと専用の継承IPCでだけ起動する。一般CLIではない。
const worker_id = process.env.BLUE_TANUKI_WORKER_ID ?? "";
const execution_epoch = process.env.BLUE_TANUKI_EXECUTION_EPOCH ?? "";
const task_identity_digest = process.env.BLUE_TANUKI_TASK_IDENTITY_DIGEST || undefined;
const configured_host_audience_digest = process.env.BLUE_TANUKI_HOST_AUDIENCE_DIGEST ?? "";
let host_audience_digest = "";
try { host_audience_digest = currentHostAudienceDigest(); } catch { process.exit(2); }
if (!process.send || !process.connected || !/^[0-9a-f-]{36}$/.test(worker_id) ||
    !/^[0-9a-f-]{36}$/i.test(execution_epoch) ||
    !isHostAudienceDigest(configured_host_audience_digest) || configured_host_audience_digest !== host_audience_digest ||
    (task_identity_digest !== undefined && !/^[a-f0-9]{64}$/.test(task_identity_digest)) ||
    !["win32", "linux", "darwin"].includes(process.platform)) process.exit(2);
let accepted = false;
process.on("disconnect", () => process.exit(2));
process.on("message", async (value: unknown) => {
  // awaitへ入る前に一回だけを捕捉する。再送を作用へ通さない。
  if (accepted) { process.exit(2); return; }
  accepted = true;
  let request: ReturnType<typeof validateWorkerRequest>;
  try { request = validateWorkerRequest(readWorkerPacket(value), worker_id, execution_epoch, Date.now(), task_identity_digest,
    host_audience_digest); }
  catch { process.exit(2); return; }
  const { command, ticket, target_version_observation, operation_plan_binding_digest,
    task_identity_digest: accepted_task_identity_digest } = request;
  let result: unknown;
  try { result = await invokeFileSearch(command.payload.arguments, {
    expected_target_version: target_version_observation,
    include_target_version_observation: true,
  }); }
  catch (error) {
    if (error instanceof Error && error.message === "file.search target version changed; request fresh review" && process.connected) {
      process.send!(workerPacket({ type: "error", worker_id, pid: process.pid, ticket_id: ticket.ticket_id,
        execution_epoch: ticket.execution_epoch, command_digest: ticket.command_digest,
        host_audience_digest,
        ...(operation_plan_binding_digest ? { operation_plan_binding_digest } : {}),
        ...(accepted_task_identity_digest ? { task_identity_digest: accepted_task_identity_digest } : {}), code: "target_version_changed" }),
      () => process.exit(4));
      return;
    }
    process.exit(3);
    return;
  }
  if (!process.connected) { process.exit(2); return; }
  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("file_search_worker_result_invalid");
    const { target_version_observation: observedTargetVersion, ...publicResult } = result as Record<string, unknown>;
    if (!observedTargetVersion) throw new Error("file_search_worker_target_version_invalid");
    process.send!(workerPacket({ type: "result", worker_id, pid: process.pid, execution_epoch: ticket.execution_epoch,
      ticket_id: ticket.ticket_id, command_digest: ticket.command_digest, result: publicResult,
      target_version_observation: observedTargetVersion,
      host_audience_digest,
      ...(operation_plan_binding_digest ? { operation_plan_binding_digest } : {}),
      ...(accepted_task_identity_digest ? { task_identity_digest: accepted_task_identity_digest } : {}) }), (error) => {
      process.exit(error ? 2 : 0);
    });
  } catch { process.exit(2); }
});
process.send!(JSON.stringify({ profile: FILE_SEARCH_WORKER_PROFILE, type: "ready", worker_id,
  pid: process.pid, platform: process.platform, host_audience_digest,
  ...(task_identity_digest ? { task_identity_digest } : {}) }));
