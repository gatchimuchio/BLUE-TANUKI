import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayWebChatOwnerTaskStore } from "../src/webchat_owner_task_store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GatewayWebChatOwnerTaskStore D4 Runtime submissions", () => {
  it("deduplicates by session across restart and keeps outcome-unknown work non-replayable", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-d4-runtime-submission-"));
    roots.push(root);
    const filepath = join(root, "inbox.sqlite");
    const scopeDigest = sha256("runtime-session-scope");
    const otherScopeDigest = sha256("another-runtime-session");
    const submissionId = "c50d591d-8034-4a38-a094-6d9f6eaa3e8c";
    const requestId = "d3c678b0-86ed-4f71-a9ef-5948aa04bdb7";

    let store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("content-free payload digest"),
        scope_digest: scopeDigest,
        request_id: requestId,
      })).toEqual({ status: "accepted", request_id: requestId });
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: otherScopeDigest }))
        .toBeNull();
    } finally {
      store.close();
    }

    store = new GatewayWebChatOwnerTaskStore(filepath);
    try {
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: scopeDigest }))
        .toEqual({ request_id: requestId, state: "outcome_unknown" });
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("content-free payload digest"),
        scope_digest: scopeDigest,
        request_id: "3d98331e-a630-4fda-a47d-8a8d845e29e0",
      })).toEqual({ status: "duplicate", request_id: requestId, state: "outcome_unknown" });
      expect(store.claimD4RuntimeIntent({
        submission_id: submissionId,
        payload_digest: sha256("different payload"),
        scope_digest: scopeDigest,
        request_id: "9479cb4c-a286-421b-b9aa-81c324001ada",
      })).toEqual({ status: "identity_conflict", request_id: requestId });
      expect(store.getD4RuntimeIntentStatus({ submission_id: submissionId, scope_digest: scopeDigest }))
        .toEqual({ request_id: requestId, state: "outcome_unknown" });
    } finally {
      store.close();
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
