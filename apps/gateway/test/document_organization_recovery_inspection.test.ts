import { createHash } from "node:crypto";
import { createRequire as createModuleRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentOrganizationCoordinator } from "@blue-tanuki/hds-brain";
import { DocumentOrganizationCheckpointStore } from "../src/document_organization_checkpoint_store.js";
import { inspectDocumentOrganizationCheckpointLedger } from "../src/document_organization_recovery_inspection.js";
import { inspectGatewayRecoveryState, projectGatewayRecoveryInspectionForOperator } from "../src/recovery_inspection.js";

const { DatabaseSync } = createModuleRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("read-only document organization checkpoint recovery inspection", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("inspects persisted checkpoint rows without treating unfinished work as recoverable", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-document-checkpoint-inspection-"));
    const databasePath = await createCheckpointRows(temporaryRoot, [
      { actor: "PRIVATE_ACTOR_ONE", requestId: "PRIVATE_REQUEST_ONE", source: "PRIVATE_SOURCE_ONE" },
      { actor: "PRIVATE_ACTOR_TWO", requestId: "PRIVATE_REQUEST_TWO", source: "PRIVATE_SOURCE_TWO" },
    ]);
    const before = await readFile(databasePath);

    const inspection = inspectDocumentOrganizationCheckpointLedger({ BLUE_TANUKI_FILE_ROOT: temporaryRoot });
    expect(inspection).toMatchObject({
      status: "residuals_present",
      reason: "unfinished_checkpoints",
      checkpoint_count: 2,
      verified_checkpoint_count: 2,
      residual_checkpoint_count: 0,
      omitted_checkpoint_count: 0,
      unresolved_checkpoint_count: 2,
      residual_count: 2,
      used_for_authority: false,
      records: [
        { integrity: "verified", reason: null, checkpoint_status: "ready" },
        { integrity: "verified", reason: null, checkpoint_status: "ready" },
      ],
    });
    expect(inspection.records.every((record) => /^[a-f0-9]{64}$/.test(record.checkpoint_ref_digest ?? ""))).toBe(true);
    expect(await readFile(databasePath)).toEqual(before);
    const serialized = JSON.stringify(inspection);
    for (const value of ["PRIVATE_ACTOR_ONE", "PRIVATE_ACTOR_TWO", "PRIVATE_REQUEST_ONE", "PRIVATE_REQUEST_TWO", "PRIVATE_SOURCE_ONE", "PRIVATE_SOURCE_TWO"]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toContain(databasePath);

    const recovery = inspectGatewayRecoveryState({
      BLUE_TANUKI_STATE_ROOT: path.join(temporaryRoot, "missing-state"),
      BLUE_TANUKI_FILE_ROOT: temporaryRoot,
    });
    const operator = projectGatewayRecoveryInspectionForOperator(recovery);
    expect(recovery.ledgers.document_organization_checkpoints).toMatchObject({
      status: "residuals_present", checkpoint_count: 2, unresolved_checkpoint_count: 2, used_for_authority: false,
    });
    expect(operator.boundary_valid).toBe(true);
    expect(operator.document_organization_checkpoint_summary.records).toHaveLength(2);
    expect(operator.document_organization_checkpoint_residual_count).toBe(2);
    const records = recovery.ledgers.document_organization_checkpoints.records;
    const duplicateReferenceReport = {
      ...recovery,
      ledgers: {
        ...recovery.ledgers,
        document_organization_checkpoints: {
          ...recovery.ledgers.document_organization_checkpoints,
          records: [records[0]!, records[0]!],
        },
      },
    };
    expect(projectGatewayRecoveryInspectionForOperator(duplicateReferenceReport).boundary_valid).toBe(false);
  });

  it("isolates a checkpoint digest mismatch to its row and leaves the database unchanged", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-document-checkpoint-corrupt-"));
    const databasePath = await createCheckpointRows(temporaryRoot, [
      { actor: "PRIVATE_ACTOR_GOOD", requestId: "PRIVATE_REQUEST_GOOD", source: "PRIVATE_SOURCE_GOOD" },
      { actor: "PRIVATE_ACTOR_BAD", requestId: "PRIVATE_REQUEST_BAD", source: "PRIVATE_SOURCE_BAD" },
    ]);
    const badSourceDigest = sha256("PRIVATE_SOURCE_BAD");
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE document_organization_checkpoints SET checkpoint_json=? WHERE source_sha256=?")
      .run("{}", badSourceDigest);
    database.close();
    const beforeInspection = await readFile(databasePath);

    const inspection = inspectDocumentOrganizationCheckpointLedger({ BLUE_TANUKI_FILE_ROOT: temporaryRoot });
    expect(inspection.status).toBe("residuals_present");
    expect(inspection.reason).toBe("ledger_corrupt");
    expect(inspection.checkpoint_count).toBe(2);
    expect(inspection.verified_checkpoint_count).toBe(1);
    expect(inspection.residual_checkpoint_count).toBe(1);
    expect(inspection.unresolved_checkpoint_count).toBe(1);
    expect(inspection.records.filter((record) => record.integrity === "residuals_present")).toMatchObject([
      { integrity: "residuals_present", reason: "checkpoint_digest_mismatch", checkpoint_status: null },
    ]);
    expect(await readFile(databasePath)).toEqual(beforeInspection);
    const serialized = JSON.stringify(inspection);
    for (const value of ["PRIVATE_ACTOR_GOOD", "PRIVATE_ACTOR_BAD", "PRIVATE_REQUEST_GOOD", "PRIVATE_REQUEST_BAD", "PRIVATE_SOURCE_GOOD", "PRIVATE_SOURCE_BAD"]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toContain(databasePath);
  });

  it("does not create missing roots or open a store with recovery sidecars", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-document-checkpoint-unavailable-"));
    const missingRoot = path.join(temporaryRoot, "not-created");
    expect(inspectDocumentOrganizationCheckpointLedger({ BLUE_TANUKI_FILE_ROOT: missingRoot })).toMatchObject({
      status: "unavailable", reason: "store_unavailable", residual_count: 1, used_for_authority: false,
    });
    await expect(stat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const databasePath = await createCheckpointRows(temporaryRoot, [
      { actor: "PRIVATE_ACTOR_SIDECAR", requestId: "PRIVATE_REQUEST_SIDECAR", source: "PRIVATE_SOURCE_SIDECAR" },
    ]);
    const before = await readFile(databasePath);
    const sidecarPath = `${databasePath}-wal`;
    await writeFile(sidecarPath, "synthetic recovery sidecar", "utf8");
    expect(inspectDocumentOrganizationCheckpointLedger({ BLUE_TANUKI_FILE_ROOT: temporaryRoot })).toMatchObject({
      status: "unavailable", reason: "store_unavailable", checkpoint_count: null, residual_count: 1,
    });
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readFile(sidecarPath, "utf8")).toBe("synthetic recovery sidecar");
  });

  it("reports omitted rows at the inspection bound without claiming a complete inventory", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-document-checkpoint-limit-"));
    const rows = Array.from({ length: 129 }, (_, index) => ({
      actor: `PRIVATE_ACTOR_${index}`,
      requestId: `PRIVATE_REQUEST_${index}`,
      source: `PRIVATE_SOURCE_${index}`,
    }));
    const databasePath = await createCheckpointRows(temporaryRoot, rows.slice(0, 128));
    const finalRow = rows[128]!;
    const finalSourceDigest = sha256(finalRow.source);
    const finalCheckpoint = new DocumentOrganizationCoordinator({
      task_id: `document-organization:${finalRow.requestId}`,
      request_id: finalRow.requestId,
      source_text: finalRow.source,
    }).checkpoint();
    const finalActorDigest = sha256(`3:cli|${finalRow.actor.length}:${finalRow.actor}`);
    const finalCheckpointJson = JSON.stringify(finalCheckpoint);
    const database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO document_organization_checkpoints
        (actor_digest, source_sha256, status, checkpoint_json, checkpoint_digest, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(finalActorDigest, finalSourceDigest, finalCheckpoint.status, finalCheckpointJson,
      sha256(`${finalActorDigest}|${finalSourceDigest}|${finalCheckpointJson}`), Date.now());
    database.close();
    const before = await readFile(databasePath);

    const inspection = inspectDocumentOrganizationCheckpointLedger({ BLUE_TANUKI_FILE_ROOT: temporaryRoot });
    expect(inspection).toMatchObject({
      status: "residuals_present",
      reason: "row_limit_reached",
      checkpoint_count: 129,
      verified_checkpoint_count: 128,
      residual_checkpoint_count: 0,
      omitted_checkpoint_count: 1,
      unresolved_checkpoint_count: 128,
      residual_count: 129,
    });
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("fails closed when the checkpoint table schema differs", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-document-checkpoint-schema-"));
    const directory = path.join(temporaryRoot, "document-organization");
    await mkdir(directory, { recursive: true });
    const databasePath = path.join(directory, "j-checkpoints.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE unexpected (value TEXT) STRICT");
    database.close();
    const before = await readFile(databasePath);

    expect(inspectDocumentOrganizationCheckpointLedger({ BLUE_TANUKI_FILE_ROOT: temporaryRoot })).toMatchObject({
      status: "schema_mismatch", reason: "schema_mismatch", checkpoint_count: null,
      residual_count: 1, used_for_authority: false,
    });
    expect(await readFile(databasePath)).toEqual(before);
  });
});

async function createCheckpointRows(
  fileRoot: string,
  rows: readonly { readonly actor: string; readonly requestId: string; readonly source: string }[],
): Promise<string> {
  await mkdir(fileRoot, { recursive: true });
  const databasePath = path.join(fileRoot, "document-organization", "j-checkpoints.sqlite");
  const store = new DocumentOrganizationCheckpointStore(databasePath);
  try {
    for (const row of rows) {
      const sourceDigest = sha256(row.source);
      const coordinator = new DocumentOrganizationCoordinator({
        task_id: `document-organization:${row.requestId}`,
        request_id: row.requestId,
        source_text: row.source,
      });
      store.getOrCreate({ channel: "cli", actor: row.actor, source_sha256: sourceDigest }, coordinator.checkpoint());
    }
  } finally {
    store.close();
  }
  return databasePath;
}
