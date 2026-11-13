import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalRecoveryCommandIdDigest, GatewayApprovalRecoveryStore } from "../src/approval_recovery_store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): { filepath: string; store: GatewayApprovalRecoveryStore } {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-approval-recovery-"));
  roots.push(root);
  const filepath = join(root, "private-state", "approval-recovery.sqlite");
  return { filepath, store: new GatewayApprovalRecoveryStore(filepath) };
}

describe("GatewayApprovalRecoveryStore", () => {
  it("recovers only digest metadata and never restores an approval after restart", () => {
    const commandId = "synthetic-command-secret-sentinel";
    const requestId = "synthetic-request-secret-sentinel";
    const first = makeStore();
    first.store.recordPending(commandId, requestId);
    first.store.close();

    const bytes = readFileSync(first.filepath);
    expect(bytes.includes(Buffer.from(commandId))).toBe(false);
    expect(bytes.includes(Buffer.from(requestId))).toBe(false);

    const reopened = new GatewayApprovalRecoveryStore(first.filepath);
    try {
      expect(reopened.state(commandId)).toBe("interrupted");
      expect(reopened.listInterrupted()).toEqual([expect.objectContaining({
        command_id_digest: approvalRecoveryCommandIdDigest(commandId),
        state: "interrupted",
        timestamp_ms: expect.any(Number),
      })]);
    } finally {
      reopened.close();
    }
  });

  it("uses an atomic one-time resolving transition and recovers a crash as outcome unknown", () => {
    const { filepath, store } = makeStore();
    const commandId = "synthetic-command-resolution";
    store.recordPending(commandId, "synthetic-request-resolution");
    expect(store.beginResolution(commandId)).toBe(true);
    expect(store.beginResolution(commandId)).toBe(false);
    store.close();

    const reopened = new GatewayApprovalRecoveryStore(filepath);
    try {
      expect(reopened.state(commandId)).toBe("outcome_unknown");
      expect(reopened.beginResolution(commandId)).toBe(false);
      expect(reopened.listInterrupted()).toEqual([expect.objectContaining({ state: "outcome_unknown" })]);
    } finally {
      reopened.close();
    }
  });

  it("records an in-process resolution exception as outcome unknown", () => {
    const { store } = makeStore();
    const commandId = "synthetic-command-exception";
    store.recordPending(commandId, "synthetic-request-exception");
    expect(store.beginResolution(commandId)).toBe(true);
    store.markOutcomeUnknown(commandId);
    expect(store.state(commandId)).toBe("outcome_unknown");
    expect(store.listInterrupted()).toEqual([expect.objectContaining({ state: "outcome_unknown" })]);
    store.close();
  });

  it("clears cancelled pending records and completed resolutions", () => {
    const { store } = makeStore();
    store.recordPending("synthetic-command-cancelled", "synthetic-request-cancelled");
    store.clearPending("synthetic-command-cancelled");
    expect(store.state("synthetic-command-cancelled")).toBeNull();

    store.recordPending("synthetic-command-completed", "synthetic-request-completed");
    expect(store.beginResolution("synthetic-command-completed")).toBe(true);
    store.completeResolution("synthetic-command-completed");
    expect(store.state("synthetic-command-completed")).toBeNull();
    store.close();
  });
});
