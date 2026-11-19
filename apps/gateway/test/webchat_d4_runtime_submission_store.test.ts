import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayWebChatOwnerTaskStore } from "../src/webchat_owner_task_store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GatewayWebChatOwnerTaskStore D4 Runtime submissions", () => {
  it("keeps an exact pre-decision cancellation terminal and non-replayable across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-d4-runtime-submission-"));
    roots.push(root);
    const filepath = join(root, "inbox.sqlite");
    const receipt = {
      submission_id: randomUUID(), request_id: randomUUID(), scope_digest: sha256("authenticated session"),
      payload_digest: sha256("private payload"), dispatch_available: true as const,
      response_target: `d4-runtime:${sha256("reply target")}`,
    };
    const foreignScope = { ...receipt, scope_digest: sha256("other session") };
    let cancelledAt: number | null = null;
    let store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.claimD4RuntimeIntent(receipt)).toEqual({ status: "accepted", request_id: receipt.request_id });
      expect(store.cancelD4RuntimeIntentBeforeDecision(foreignScope)).toBeNull();
      expect(store.cancelD4RuntimeIntentBeforeDecision({ ...receipt, request_id: randomUUID() })).toBeNull();

      cancelledAt = store.cancelD4RuntimeIntentBeforeDecision(receipt);
      expect(cancelledAt).toBeTypeOf("number");
      expect(store.readD4RuntimeIntentBeforeDecisionCancellation(foreignScope)).toBeNull();
      expect(store.cancelD4RuntimeIntentBeforeDecision(receipt)).toBe(cancelledAt);
      expect(store.beginD4RuntimeIntentDecision(receipt.request_id)).toBe(false);
      store.markD4RuntimeIntentHandlerReturned(receipt);
      store.markD4RuntimeIntentOutcomeUnknown(receipt);
      store.recordD4RuntimeIntentResult({ ...receipt, content: "must not be retained" });
      expect(store.getD4RuntimeIntentResult(receipt)).toMatchObject({ status: "unavailable", reason_code: "not_retained" });
    } finally {
      store.close();
    }

    store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.readD4RuntimeIntentBeforeDecisionCancellation(receipt)).toBe(cancelledAt);
      expect(store.cancelD4RuntimeIntentBeforeDecision(receipt)).toBe(cancelledAt);
      expect(store.beginD4RuntimeIntentDecision(receipt.request_id)).toBe(false);
      expect(store.claimD4RuntimeIntent({ ...receipt, request_id: randomUUID() }))
        .toEqual({ status: "duplicate", request_id: receipt.request_id, state: "rejected" });
      expect(store.getD4RuntimeIntentStatus(receipt)).toEqual({ request_id: receipt.request_id, state: "rejected" });
    } finally {
      store.close();
    }
  });

  it("cannot treat a started D4 handler or a direct owner receipt as stopped before decision", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-d4-runtime-submission-"));
    roots.push(root);
    const store = new GatewayWebChatOwnerTaskStore(join(root, "inbox.sqlite"));
    try {
      const receipt = {
        submission_id: randomUUID(), request_id: randomUUID(), scope_digest: sha256("authenticated session"),
        payload_digest: sha256("ordinary intent"), dispatch_available: true,
      };
      expect(store.claimD4RuntimeIntent(receipt)).toMatchObject({ status: "accepted" });
      expect(store.beginD4RuntimeIntentDecision(receipt.request_id)).toBe(true);
      expect(() => store.beginD4RuntimeIntentDecision(receipt.request_id)).toThrow("webchat_d4_runtime_intent_decision_unavailable");
      expect(store.cancelD4RuntimeIntentBeforeDecision(receipt)).toBeNull();
      store.markD4RuntimeIntentHandlerReturned(receipt);
      expect(store.getD4RuntimeIntentStatus(receipt)).toMatchObject({ state: "handler_returned" });

      const owner = { submission_id: randomUUID(), request_id: randomUUID(), payload_digest: sha256("owner intent") };
      expect(store.claim(owner)).toMatchObject({ status: "accepted" });
      expect(store.cancelD4RuntimeIntentBeforeDecision({ ...owner, scope_digest: sha256("webchat-owner-task-scope.v1") })).toBeNull();
      expect(() => store.beginD4RuntimeIntentDecision(owner.request_id)).toThrow("webchat_d4_runtime_intent_decision_unavailable");
      expect(store.recentOwnerTaskRequestIdsForNotification()).toEqual([owner.request_id]);
      store.markHandlerReturned(owner.request_id);
      expect(store.getStatus(owner)).toMatchObject({ state: "handler_returned" });
      expect(store.recentOwnerTaskRequestIdsForNotification()).toEqual([owner.request_id]);
    } finally {
      store.close();
    }
  });

  it("deduplicates by session across restart and keeps outcome-unknown work non-replayable", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-d4-runtime-submission-"));
    roots.push(root);
    const filepath = join(root, "inbox.sqlite");
    const scopeDigest = sha256("runtime-session-scope");
    const otherScopeDigest = sha256("another-runtime-session");
    const submissionId = "c50d591d-8034-4a38-a094-6d9f6eaa3e8c";
    const requestId = "d3c678b0-86ed-4f71-a9ef-5948aa04bdb7";
    const scope = { request_id: requestId, scope_digest: scopeDigest,
      runtime_ref_digest: sha256("runtime"), session_ref_digest: sha256("session") };
    const wrongSession = { ...scope, session_ref_digest: sha256("other session") };

    let store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("content-free payload digest"),
        scope_digest: scopeDigest,
        request_id: requestId,
        dispatch_available: true,
      })).toEqual({ status: "accepted", request_id: requestId });
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: otherScopeDigest }))
        .toBeNull();
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId.toUpperCase(),
        payload_digest: sha256("different session payload digest"),
        scope_digest: otherScopeDigest,
        request_id: "3d98331e-a630-4fda-a47d-8a8d845e29e0",
        dispatch_available: true,
      })).toEqual({ status: "identity_conflict", request_id: requestId });
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: otherScopeDigest }))
        .toBeNull();
      expect(store.readD4RuntimeCancellationCommands(scope)).toEqual({ matching: [], conflicting: [] });
      store.bindD4RuntimeCancellationCommand({ ...scope, scope_digest: otherScopeDigest }, "not-bound");
      store.bindD4RuntimeCancellationCommand(scope, "cancelled-command");
      store.bindD4RuntimeCancellationCommand(wrongSession, "cancelled-command");
    } finally {
      store.close();
    }

    store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: scopeDigest }))
        .toEqual({ request_id: requestId, state: "outcome_unknown" });
      expect(store.cancelD4RuntimeIntentBeforeDecision(scope)).toBeNull();
      expect(() => store.beginD4RuntimeIntentDecision(requestId)).toThrow("webchat_d4_runtime_intent_decision_unavailable");
      expect(store.readD4RuntimeCancellationCommands(scope)).toEqual({ matching: ["cancelled-command"], conflicting: [] });
      expect(store.readD4RuntimeCancellationCommands(wrongSession)).toEqual({ matching: [], conflicting: ["cancelled-command"] });
      expect(store.readD4RuntimeCancellationCommands({ ...scope, scope_digest: otherScopeDigest }))
        .toEqual({ matching: [], conflicting: [] });
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("content-free payload digest"),
        scope_digest: scopeDigest,
        request_id: "3d98331e-a630-4fda-a47d-8a8d845e29e0",
        dispatch_available: true,
      })).toEqual({ status: "duplicate", request_id: requestId, state: "outcome_unknown" });
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("different payload"),
        scope_digest: scopeDigest,
        request_id: "9479cb4c-a286-421b-b9aa-81c324001ada",
        dispatch_available: true,
      })).toEqual({ status: "identity_conflict", request_id: requestId });
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("different session payload digest"),
        scope_digest: otherScopeDigest,
        request_id: "3d98331e-a630-4fda-a47d-8a8d845e29e0",
        dispatch_available: false,
      })).toEqual({ status: "identity_conflict", request_id: requestId });
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: scopeDigest }))
        .toEqual({ request_id: requestId, state: "outcome_unknown" });
    } finally {
      store.close();
    }
  });

  it("keeps legacy conflicting receipts readable and blocks new dispatch in every scope", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-d4-runtime-submission-"));
    roots.push(root);
    const filepath = join(root, "inbox.sqlite");
    const submissionId = "c50d591d-8034-4a38-a094-6d9f6eaa3e8c";
    const payloadDigest = sha256("legacy scoped payload");
    const first = { scope_digest: sha256("legacy runtime session one"),
      request_id: "d3c678b0-86ed-4f71-a9ef-5948aa04bdb7" };
    const second = { scope_digest: sha256("legacy runtime session two"),
      request_id: "fa4199e6-c423-4ad0-b70c-cb1fd62db929" };
    const sqlite = new DatabaseSync(filepath);
    try {
      // Build the old inbox with its original composite key and no D4 decision marker.
      sqlite.exec(`CREATE TABLE webchat_owner_task_inbox (
        scope_digest TEXT NOT NULL CHECK(length(scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        request_id TEXT NOT NULL UNIQUE,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown','rejected')),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(scope_digest,event_digest)
      ) STRICT`);
      const insert = sqlite.prepare(`INSERT INTO webchat_owner_task_inbox
        (scope_digest,event_digest,payload_digest,request_id,delivery_state,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,'handler_returned',1,1)`);
      const eventDigest = sha256(`webchat-d4-runtime-intent-event.v1\0${submissionId}`);
      for (const item of [first, second]) insert.run(item.scope_digest, eventDigest, payloadDigest, item.request_id);
    } finally {
      sqlite.close();
    }

    const store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      for (const item of [first, second]) {
        const scope = { submission_id: submissionId, scope_digest: item.scope_digest };
        expect(store.getD4RuntimeIntentStatus(scope)).toEqual({ request_id: item.request_id, state: "handler_returned" });
        expect(store.cancelD4RuntimeIntentBeforeDecision(item)).toBeNull();
        expect(() => store.beginD4RuntimeIntentDecision(item.request_id)).toThrow("webchat_d4_runtime_intent_decision_unavailable");
        expect(store.claimD4RuntimeIntent({ ...scope, payload_digest: payloadDigest,
          request_id: "9479cb4c-a286-421b-b9aa-81c324001ada", dispatch_available: true }))
          .toEqual({ status: "duplicate", request_id: item.request_id, state: "handler_returned" });
        expect(store.claimD4RuntimeIntent({ ...scope, payload_digest: sha256("changed legacy payload"),
          request_id: "9479cb4c-a286-421b-b9aa-81c324001ada", dispatch_available: true }))
          .toEqual({ status: "identity_conflict", request_id: item.request_id });
      }
      expect(store.claimD4RuntimeIntent({ submission_id: submissionId, scope_digest: sha256("new runtime session"),
        payload_digest: payloadDigest, request_id: "9479cb4c-a286-421b-b9aa-81c324001ada", dispatch_available: true }))
        .toMatchObject({ status: "identity_conflict" });
      const ownerRequest = "3d98331e-a630-4fda-a47d-8a8d845e29e0";
      expect(store.claim({ submission_id: submissionId, payload_digest: payloadDigest, request_id: ownerRequest }))
        .toEqual({ status: "accepted", request_id: ownerRequest });
    } finally {
      store.close();
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
