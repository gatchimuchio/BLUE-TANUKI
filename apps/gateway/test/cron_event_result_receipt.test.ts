import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCronEventIdentity } from "../src/cron_event_store.js";
import { createCronEventResultReceipt, parseCronEventResultReceipt } from "../src/cron_event_result_receipt.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

describe("Cron event result observation receipt", () => {
  it("records only verified digest references and preserves J outcome without inferring job success", () => {
    const source = "private-synthetic-cron-source";
    const event = createCronEventIdentity(source, 4, sha256("private-synthetic-payload"));
    const planId = sha256("private-plan-id");
    const revisionDigest = sha256("private-plan-revision");
    const memoryReceiptDigest = sha256("private-memory-receipt");
    const renderedOutputDigest = sha256("private rendered output");
    const receipt = createCronEventResultReceipt(event, {
      schema_version: "operation-plan-projection.v1",
      used_for_authority: false,
      raw_payload_exposed: false,
      recovery_refresh_status: "ready",
      result_memory: { configured: true, status: "receipt_confirmed", used_for_authority: false },
      plans: [{
        request_id: event.event_id,
        plan_id: planId,
        revision_digest: revisionDigest,
        task_outcome: { status: "in_progress", reason_code: "awaiting_step_review", used_for_authority: false, may_execute: false },
        bindings: [{
          revision_digest: revisionDigest,
          memory_status: "receipt_confirmed",
          memory_receipt_digest: memoryReceiptDigest,
        }],
      }],
    }, {
      chain_valid: true,
      skipped_count: 0,
      entries: [{
        kind: "final_output",
        request_id: event.event_id,
        payload: { rendered_output_digest: renderedOutputDigest },
      }],
    }, 123);

    expect(receipt).toMatchObject({
      plan_match_status: "matched",
      plan_id_digest: planId,
      plan_revision_digest: revisionDigest,
      task_outcome_status: "in_progress",
      result_memory_status: "receipts_observed",
      result_memory_receipt_count: 1,
      result_memory_receipt_set_digest: sha256(JSON.stringify([memoryReceiptDigest])),
      final_output_status: "observed",
      final_output_count: 1,
      latest_final_output_digest: renderedOutputDigest,
      used_for_authority: false,
      may_execute: false,
    });
    expect(parseCronEventResultReceipt(receipt)).toEqual(receipt);
    const serialized = JSON.stringify(receipt);
    for (const raw of [event.event_id, source, "private-synthetic-payload", "private rendered output"]) {
      expect(serialized).not.toContain(raw);
    }
    expect(parseCronEventResultReceipt({ ...receipt, task_outcome_status: "achieved" })).toBeNull();
  });

  it("labels a missing plan as unobserved rather than achieved", () => {
    const event = createCronEventIdentity("synthetic-no-plan", 2, sha256("synthetic payload"));
    const receipt = createCronEventResultReceipt(event, {
      schema_version: "operation-plan-projection.v1",
      used_for_authority: false,
      raw_payload_exposed: false,
      recovery_refresh_status: "ready",
      result_memory: { configured: false, status: "not_configured", used_for_authority: false },
      plans: [],
    }, {
      entries: [], chain_valid: true, skipped_count: 0,
    }, 456);

    expect(receipt).toMatchObject({
      plan_match_status: "not_found",
      task_outcome_status: "unobserved",
      result_memory_status: "not_observed",
      final_output_status: "not_observed",
    });
    expect(parseCronEventResultReceipt(receipt)).toEqual(receipt);
  });

  it("does not treat a pending J refresh or unavailable M projection as a verified absence", () => {
    const event = createCronEventIdentity("synthetic-pending-projection", 3, sha256("synthetic pending payload"));
    const plan = {
      request_id: event.event_id,
      plan_id: sha256("pending-plan-id"),
      revision_digest: sha256("pending-plan-revision"),
      task_outcome: { status: "held", reason_code: "result_memory_receipt_unconfirmed", used_for_authority: false, may_execute: false },
      bindings: [],
    };
    const planRefreshPending = createCronEventResultReceipt(event, {
      schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false,
      recovery_refresh_status: "pending",
      result_memory: { configured: true, status: "receipt_confirmed", used_for_authority: false }, plans: [plan],
    }, { entries: [], chain_valid: true, skipped_count: 0 }, 789);
    expect(planRefreshPending).toMatchObject({
      plan_match_status: "unverified", task_outcome_status: "unverified", result_memory_status: "unverified",
    });

    const memoryUnavailable = createCronEventResultReceipt(event, {
      schema_version: "operation-plan-projection.v1", used_for_authority: false, raw_payload_exposed: false,
      recovery_refresh_status: "ready",
      result_memory: { configured: true, status: "pending_or_unavailable", used_for_authority: false }, plans: [plan],
    }, { entries: [], chain_valid: true, skipped_count: 0 }, 790);
    expect(memoryUnavailable).toMatchObject({
      plan_match_status: "matched", task_outcome_status: "held", result_memory_status: "unverified",
    });
    expect(parseCronEventResultReceipt(memoryUnavailable)).toEqual(memoryUnavailable);
  });
});
