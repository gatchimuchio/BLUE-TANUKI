import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HDSUpperController, OperationPlanReceiptReconciliationAuthorization } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, type ExecuteCommand, type OperationPlanExternalReceiptObservation } from "@blue-tanuki/protocol";
import { localInspectionReconciliationMessage, runLocalInspectionReconciliation } from "../src/local_inspection_runtime.js";

afterEach(() => vi.unstubAllEnvs());

describe("create-only file.write unknown-result reconciliation", () => {
  it("inspects one sandbox target without endpoint, records digest evidence, and keeps outcome unknown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blue-file-state-reconcile-"));
    const content = "synthetic result\n";
    const parameters = { path: "notes.txt", content, mode: "create", max_bytes: 128 };
    await fs.writeFile(path.join(root, "notes.txt"), content, "utf8");
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", root);
    const now = Date.now();
    const authorization: OperationPlanReceiptReconciliationAuthorization = {
      authorization_id: "fixture-authorization", caller_user: "owner", caller_channel: "webchat",
      plan_id_digest: "c".repeat(64), revision_digest: "d".repeat(64), step_id_digest: "e".repeat(64),
      command_id: "file-write-command", command_digest: "a".repeat(64), executor_command_digest: "b".repeat(64),
      command_key: "f".repeat(64), operation: "file.write", parameters, issued_at_ms: now - 1, expires_at_ms: now + 30_000,
    };
    const caller = createGatewayInternalInboundRequest({ id: "reconcile-request", channel: "webchat", user: "owner",
      content: "plan:reconcile fixture", timestamp: now,
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
    const observations: OperationPlanExternalReceiptObservation[] = [];
    const hds = {
      takeOperationPlanReceiptReconciliationAuthorization: () => authorization,
      recordOperationPlanExternalReceiptObservation: (value: unknown) => { observations.push(value as OperationPlanExternalReceiptObservation); return true; },
      reconcileOperationPlanMemory: () => true,
      operationPlanReceiptObservationMemoryIsDurable: () => true,
    } as unknown as HDSUpperController;
    const command = { type: "noop", payload: { control_event: "operation_plan_receipt_reconciliation" } } as unknown as ExecuteCommand;
    try {
      const result = await runLocalInspectionReconciliation({ hds, command, caller });
      expect(result).toMatchObject({ status: "observed", observation: {
        source: "local_file_state", status: "matched", match_count: 1,
        used_for_authority: false, raw_receipt_exposed: false,
      }, memory_status: "committed" });
      expect(observations).toHaveLength(1);
      expect(JSON.stringify(observations[0])).not.toContain(content);
      expect(localInspectionReconciliationMessage(result)).toContain("outcome_unknownのままです");
      expect(localInspectionReconciliationMessage(result)).toContain("作用の再送もしていません");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
