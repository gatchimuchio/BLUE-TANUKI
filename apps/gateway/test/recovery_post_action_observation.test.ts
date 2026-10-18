import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRecoveryPostActionObservation,
  type RecoveryHistoryEvidenceEntry,
} from "../src/recovery_surface.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);

function historyFor(
  operation: string,
  status: "success" | "failed" | "suspended" = "success",
  resultDigest: string | null = digest("b"),
  finalOutputDigest: string | null = resultDigest,
): RecoveryHistoryEvidenceEntry[] {
  const commandId = "recovery-command-1";
  return [
    {
      kind: "execution_history",
      command_id: commandId,
      index: 4,
      timestamp: Date.now(),
      used_for_authority: false,
      payload: {
        command: {
          operation,
          payload: {
            tool_name: operation,
            arguments_digest: digest("a"),
          },
        },
        status,
        result_digest: resultDigest,
      },
    },
    {
      kind: "final_output",
      command_id: commandId,
      index: 5,
      timestamp: Date.now(),
      used_for_authority: false,
      payload: {
        status,
        result_present: status === "success",
        result_digest: finalOutputDigest,
        used_for_authority: false,
      },
    },
  ];
}

describe("buildRecoveryPostActionObservation", () => {
  it("confirms only provider configuration observed in both the env file and current process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const observation = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider"),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });

      expect(observation).toMatchObject({
        status: "changed",
        operation: "provider_reset",
        configuration_state: "provider_stub",
        evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
        used_for_authority: false,
        may_execute: false,
      });
      expect(observation.operation_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.result_digest).toBe(digest("b"));
      expect(JSON.stringify(observation)).not.toContain("product.env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when history is incomplete, the output digest does not match, or restore scope is broader than observation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const incomplete = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider"), chain_valid: true, skipped_count: 1,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const digestMismatch = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider", "success", digest("b"), digest("c")),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const prototypeOperation = await buildRecoveryPostActionObservation({
        entries: historyFor("toString"), chain_valid: true, skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const previousProcessHistory = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider").map((entry) => ({ ...entry, timestamp: 10 })),
        chain_valid: true,
        skipped_count: 0,
        not_before_timestamp_ms: 11,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const mismatchedFailure = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider", "failed", digest("b"), digest("c")),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });
      const restore = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.restore"), chain_valid: true, skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile, LLM_BACKEND: "stub" });

      expect(incomplete.status).toBe("unverified");
      expect(incomplete.operation).toBeNull();
      expect(digestMismatch.status).toBe("unverified");
      expect(prototypeOperation.status).toBe("no_record");
      expect(previousProcessHistory).toMatchObject({
        status: "unverified",
        operation: "provider_reset",
        configuration_state: "not_observed",
      });
      expect(mismatchedFailure.status).toBe("unverified");
      expect(restore).toMatchObject({
        status: "unverified",
        operation: "restore",
        evidence_source: "COMPLETE_HISTORY",
        configuration_state: "not_observed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a failed execution distinct and never treats factory-reset configuration as full verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\nCOMPOSIO_DRY_RUN=true\nCOMPOSIO_LIVE_EXECUTION=false\n", "utf8");
      const failed = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_connector", "failed", null, null),
        chain_valid: true,
        skipped_count: 0,
      }, { BLUE_TANUKI_ENV_FILE: envFile });
      const factory = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.factory_reset"),
        chain_valid: true,
        skipped_count: 0,
      }, {
        BLUE_TANUKI_ENV_FILE: envFile,
        LLM_BACKEND: "stub",
        COMPOSIO_DRY_RUN: "true",
        COMPOSIO_LIVE_EXECUTION: "false",
      });

      expect(failed).toMatchObject({ status: "failed", operation: "connector_reset" });
      expect(factory).toMatchObject({
        status: "unverified",
        operation: "factory_reset",
        configuration_state: "provider_connector_dry_run",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not confirm a reset while provider keys remain in process environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-observation-"));
    try {
      const envFile = path.join(root, "product.env");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const observation = await buildRecoveryPostActionObservation({
        entries: historyFor("recovery.reset_provider"),
        chain_valid: true,
        skipped_count: 0,
      }, {
        BLUE_TANUKI_ENV_FILE: envFile,
        LLM_BACKEND: "stub",
        OPENAI_API_KEY: "must-never-be-returned",
      });

      expect(observation.status).toBe("unverified");
      expect(observation.configuration_state).toBe("not_observed");
      expect(JSON.stringify(observation)).not.toContain("must-never-be-returned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
