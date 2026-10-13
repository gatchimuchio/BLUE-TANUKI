import { invokeFileSearch } from "@blue-tanuki/core";
import { FILE_SEARCH_WORKER_PROFILE, readWorkerPacket, validateWorkerRequest, workerPacket } from "./file_search_worker_protocol.js";

// 通常Gatewayから固定artifactと専用の継承IPCでだけ起動する。一般CLIではない。
const worker_id = process.env.BLUE_TANUKI_WORKER_ID ?? "";
if (!process.send || !process.connected || !/^[0-9a-f-]{36}$/.test(worker_id) ||
    !["win32", "linux", "darwin"].includes(process.platform)) process.exit(2);
let accepted = false;
process.on("disconnect", () => process.exit(2));
process.on("message", async (value: unknown) => {
  // awaitへ入る前に一回だけを捕捉する。再送を作用へ通さない。
  if (accepted) { process.exit(2); return; }
  accepted = true;
  let request: ReturnType<typeof validateWorkerRequest>;
  try { request = validateWorkerRequest(readWorkerPacket(value), worker_id, Date.now()); }
  catch { process.exit(2); return; }
  const { command, ticket } = request;
  let result: unknown;
  try { result = await invokeFileSearch(command.payload.arguments); }
  catch { process.exit(3); return; }
  if (!process.connected) { process.exit(2); return; }
  try {
    process.send!(workerPacket({ type: "result", worker_id, pid: process.pid, execution_epoch: ticket.execution_epoch,
      ticket_id: ticket.ticket_id, command_digest: ticket.command_digest, result }), (error) => {
      process.exit(error ? 2 : 0);
    });
  } catch { process.exit(2); }
});
process.send!(JSON.stringify({ profile: FILE_SEARCH_WORKER_PROFILE, type: "ready", worker_id,
  pid: process.pid, platform: process.platform }));
