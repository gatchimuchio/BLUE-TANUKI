import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCronEventResolutionTool } from "../src/cron_event_resolution_tool.js";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeEvent(source: string, sequence: number, payload: string) {
  return createCronEventIdentity(source, sequence, createHash("sha256").update(payload).digest("hex"));
}

function makeStore(opts: ConstructorParameters<typeof GatewayCronEventStore>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-resolution-"));
  roots.push(root);
  const store = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"), opts);
  return { root, store };
}

const context = { command_id: "owner-resolution-command", upstream_commit_hash: "a".repeat(64) };

describe("schedule.resolve_event tool", () => {
  it("validates one exact unresolved identity without changing the cursor or releasing the next event", async () => {
    const { store } = makeStore();
    const current = makeEvent("cron:runtime:review", 1_000, "synthetic original event");
    const next = makeEvent("cron:runtime:review", 2_000, "synthetic next event");
    try {
      expect(store.claim(current)).toEqual({ status: "accepted" });
      store.settle(current, "outcome_unknown");
      const tool = createCronEventResolutionTool(store, { isEventInFlight: () => false });

      await expect(tool.invoke({
        event_id: current.event_id,
        payload_digest: current.payload_digest,
        disposition: "acknowledge_no_replay",
      }, context)).resolves.toEqual({
        status: "validated_for_hds_disposition",
        event_id: current.event_id,
        payload_digest: current.payload_digest,
        original_delivery_state: "outcome_unknown",
        disposition: "acknowledge_no_replay",
        external_outcome: "unknown",
      });
      expect(store.unresolvedEvents()).toEqual([expect.objectContaining({
        event_id: current.event_id,
        payload_digest: current.payload_digest,
        delivery_state: "outcome_unknown",
        resolution_state: "unacknowledged",
      })]);
      expect(store.claim(next)).toEqual({ status: "blocked_unresolved", delivery_state: "outcome_unknown" });
    } finally {
      store.close();
    }
  });

  it("rejects an in-flight event, stale digest, and any extra argument", async () => {
    const { store } = makeStore();
    const current = makeEvent("cron:runtime:in-flight", 1_000, "synthetic action");
    expect(store.claim(current)).toEqual({ status: "accepted" });
    store.settle(current, "outcome_unknown");
    const args = {
      event_id: current.event_id,
      payload_digest: current.payload_digest,
      disposition: "acknowledge_no_replay",
    };
    try {
      const inFlightTool = createCronEventResolutionTool(store, { isEventInFlight: () => true });
      await expect(inFlightTool.invoke(args, context)).rejects.toThrow(/still in flight/);
      const idleTool = createCronEventResolutionTool(store, { isEventInFlight: () => false });
      await expect(idleTool.invoke({ ...args, payload_digest: "f".repeat(64) }, context))
        .rejects.toThrow(/stale or not unresolved/);
      await expect(idleTool.invoke({ ...args, replay: true }, context))
        .rejects.toThrow(/requires exact/);
    } finally {
      store.close();
    }
  });

  it("rejects when the HDS disposition cannot be verified", async () => {
    const { root, store } = makeStore();
    const current = makeEvent("cron:runtime:audit-unavailable", 1_000, "synthetic action");
    expect(store.claim(current)).toEqual({ status: "accepted" });
    store.settle(current, "outcome_unknown");
    store.close();
    const unavailable = new GatewayCronEventStore(join(root, "private", "cron-events.sqlite"), {
      verifyNoReplayDisposition: () => { throw new Error("audit unavailable"); },
    });
    try {
      const tool = createCronEventResolutionTool(unavailable, { isEventInFlight: () => false });
      await expect(tool.invoke({
        event_id: current.event_id,
        payload_digest: current.payload_digest,
        disposition: "acknowledge_no_replay",
      }, context)).rejects.toThrow(/present or cannot be verified/);
    } finally {
      unavailable.close();
    }
  });
});
