import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayWebChatOwnerTaskStore } from "../src/webchat_owner_task_store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const roots: string[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixturePath(): string {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-webhook-event-"));
  roots.push(root);
  return join(root, "inbox.sqlite");
}

function event(sequence: number, expiresAtMs: number, source = "synthetic source") {
  return {
    source_digest: sha256(source), event_digest: sha256(`synthetic event ${sequence}`),
    payload_digest: sha256(`synthetic payload ${sequence}`), sequence, expires_at_ms: expiresAtMs, request_id: randomUUID(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable WebChat webhook claims", () => {
  it("keeps finished and interrupted events non-replayable after expiration and restart", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const filepath = fixturePath();
    const finished = event(1, 2_000);
    const interrupted = event(2, 2_000);
    const store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.claimWebhookEvent(finished)).toEqual({ status: "accepted", request_id: finished.request_id });
      expect(store.claimWebhookEvent({ ...finished, request_id: randomUUID() }))
        .toEqual({ status: "duplicate", request_id: finished.request_id, state: "dispatching" });
      expect(() => store.settleWebhookEvent({ ...finished, request_id: randomUUID(), state: "handler_returned" }))
        .toThrow("webchat_webhook_event_settlement_rejected");
      store.settleWebhookEvent({ ...finished, state: "handler_returned" });
      store.settleWebhookEvent({ ...finished, state: "handler_returned" });
      expect(() => store.settleWebhookEvent({ ...finished, state: "outcome_unknown" }))
        .toThrow("webchat_webhook_event_settlement_rejected");
      expect(store.claimWebhookEvent(interrupted)).toEqual({ status: "accepted", request_id: interrupted.request_id });
    } finally {
      store.close();
    }

    clock.mockReturnValue(3_000);
    const restarted = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(restarted.claimWebhookEvent({ ...finished, request_id: randomUUID() }))
        .toEqual({ status: "duplicate", request_id: finished.request_id, state: "handler_returned" });
      expect(restarted.claimWebhookEvent({ ...interrupted, request_id: randomUUID() }))
        .toEqual({ status: "duplicate", request_id: interrupted.request_id, state: "outcome_unknown" });
      restarted.settleWebhookEvent({ ...interrupted, state: "outcome_unknown" });
      expect(() => restarted.settleWebhookEvent({ ...interrupted, state: "handler_returned" }))
        .toThrow("webchat_webhook_event_settlement_rejected");
      expect(restarted.claimWebhookEvent(event(3, 3_000))).toEqual({ status: "expired" });
      expect(restarted.claimWebhookEvent(event(3, 3_001))).toMatchObject({ status: "accepted" });
    } finally {
      restarted.close();
    }
  });

  it("rejects competing identities, sequence reversal and invalid claims within each source", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new GatewayWebChatOwnerTaskStore(fixturePath());
    try {
      const first = event(10, 2_000);
      expect(store.claimWebhookEvent(first)).toMatchObject({ status: "accepted" });
      for (const difference of [
        { event_digest: sha256("different event") }, { payload_digest: sha256("different payload") },
        { sequence: 11 }, { expires_at_ms: 2_001 },
      ]) {
        expect(store.claimWebhookEvent({ ...first, ...difference, request_id: randomUUID() }))
          .toEqual({ status: "identity_conflict" });
      }
      expect(store.claimWebhookEvent(event(9, 2_000))).toEqual({ status: "out_of_order" });
      expect(store.claimWebhookEvent(event(15, 2_000))).toMatchObject({ status: "accepted" });
      expect(store.claimWebhookEvent({ ...first, source_digest: sha256("independent source"), request_id: randomUUID() }))
        .toMatchObject({ status: "accepted" });
      for (const invalidField of [
        { source_digest: "raw identifier" }, { event_digest: "raw identifier" }, { payload_digest: "raw payload" },
        { sequence: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { expires_at_ms: Infinity }, { request_id: "raw ID" },
      ]) {
        expect(() => store.claimWebhookEvent({ ...first, ...invalidField })).toThrow(/webchat_webhook_event_/);
      }
    } finally {
      store.close();
    }
  });

  it("stores only digests and transport state apart from existing owner and D4 submissions", () => {
    const filepath = fixturePath();
    const webhook = event(1, Date.now() + 60_000);
    const owner = { submission_id: randomUUID(), request_id: randomUUID(), payload_digest: webhook.payload_digest };
    const d4 = { ...owner, submission_id: randomUUID(), request_id: randomUUID(), scope_digest: webhook.source_digest,
      dispatch_available: true };
    const store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.claimWebhookEvent(webhook)).toMatchObject({ status: "accepted" });
      expect(store.claim(owner)).toMatchObject({ status: "accepted" });
      expect(store.claimD4RuntimeIntent(d4)).toMatchObject({ status: "accepted" });
      store.markHandlerReturned(owner.request_id);
      store.markD4RuntimeIntentHandlerReturned(d4);
      store.settleWebhookEvent({ ...webhook, state: "handler_returned" });
      expect(store.getStatus(owner)).toEqual({ request_id: owner.request_id, state: "handler_returned" });
      expect(store.getD4RuntimeIntentStatus(d4)).toEqual({ request_id: d4.request_id, state: "handler_returned" });
      expect(store.recentOwnerTaskRequestIdsForNotification()).toEqual([owner.request_id]);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(filepath, { readOnly: true });
    try {
      expect(db.prepare("SELECT * FROM webchat_webhook_events").all())
        .toEqual([{ ...webhook, delivery_state: "handler_returned", created_at_ms: expect.any(Number), updated_at_ms: expect.any(Number) }]);
    } finally {
      db.close();
    }
  });
});
