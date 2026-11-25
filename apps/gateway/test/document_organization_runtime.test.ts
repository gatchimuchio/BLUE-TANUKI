import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Executor, ToolRegistry, createExecutorApprovalAuthority } from "@blue-tanuki/core";
import { AuditLog, DocumentOrganizationCoordinator, FailureMemoryStore, HDSUpperController, LongTermMemoryStore } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, type InboundRequest } from "@blue-tanuki/protocol";
import { buildApprovalRuntime } from "../src/approval_runtime.js";
import { DocumentOrganizationCheckpointStore } from "../src/document_organization_checkpoint_store.js";
import { documentOrganizationMemoryStorage } from "../src/operation_result_memory_config.js";
import {
  createDocumentOrganizationCoordinator,
  prepareDocumentOrganizationSession,
  runDocumentOrganizationTask,
} from "../src/document_organization_runtime.js";

const firstQuote = "決定事項:青";
const secondQuote = "未確認:期限";
const source = `${firstQuote}\n${secondQuote}`;

function candidate(start: number, quote: string): string {
  return JSON.stringify({
    schema_version: "blue-tanuki.document-organization.candidate.v1",
    sections: [{ label: "対象資料", excerpts: [{ start, end: start + quote.length, quote }] }],
  });
}

function authenticatedD4Request(sessionDigest: string): InboundRequest {
  return createGatewayInternalInboundRequest({
    id: randomUUID(), channel: "webchat", user: "d4-runtime-adapter-token-holder", content: `/organize\n${source}`,
    timestamp: Date.now(), metadata: {
      "blue_tanuki.actor_kind": "user",
      "blue_tanuki.trust_level": "limited",
      "blue_tanuki.process_kind": "chat",
      "blue_tanuki.runtime_ingress.version": "d4-runtime-intent.v1",
      "blue_tanuki.runtime_ingress.runtime_id_digest": "a".repeat(64),
      "blue_tanuki.runtime_ingress.session_id_digest": sessionDigest,
      "blue_tanuki.runtime_ingress.used_for_authority": false,
    },
  });
}

describe("document organization runtime cancellation", () => {
  it.each(["explicit_cancel", "shutdown"])("discards a late successful C result on %s", async (mode) => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "bt-organize-cancel-"));
    const hds = new HDSUpperController({
      audit: new AuditLog({ filepath: join(temporaryRoot, "audit.jsonl") }),
      memory: new LongTermMemoryStore(),
      document_organization_memory: documentOrganizationMemoryStorage({
        BLUE_TANUKI_STATE_ROOT: join(temporaryRoot, "state"),
      }),
    });
    try {
    const memoryBefore = hds.documentOrganizationMemoryVersion();
    const origin = authenticatedD4Request("b".repeat(64));
    const coordinator = createDocumentOrganizationCoordinator(origin, source, memoryBefore);
    const firstDecision = hds.decide({ ...origin, content: coordinator.buildComputePrompt() }, {
      transient_content: "document_organization",
    });
    const authority = createExecutorApprovalAuthority();
    const executor = new Executor({
      approval_authority: authority,
      tools: new ToolRegistry(),
      llm: { name: "fixture", call: async () => { throw new Error("fixture must use stubbed Executor feedback"); } },
    });
    const controller = new AbortController();
    const execute = vi.spyOn(executor, "execute");
    execute.mockImplementationOnce(async (command) => ({
      command_id: command.id, status: "success", metrics: { duration_ms: 1 },
      result: { content: candidate(0, firstQuote) },
    }));
    const lateResult = {
      content: candidate(firstQuote.length + 1, secondQuote),
      discarded_provider_marker: "fixture-late/provider-private",
    };
    execute.mockImplementationOnce(async (command, context) => {
      await Promise.resolve();
      controller.abort();
      expect(context?.signal?.aborted).toBe(true);
      return { command_id: command.id, status: "success", metrics: { duration_ms: 3 }, result: lateResult };
    });
    const checkpoints: ReturnType<DocumentOrganizationCoordinator["checkpoint"]>[] = [];
    const review = vi.spyOn(hds, "reviewMemoryCitations");
    const feedback = vi.spyOn(hds, "onFeedback");
    const started = vi.fn();
    const cycleTasks = vi.fn();
    const settled = vi.fn();

    const result = await runDocumentOrganizationTask({
      coordinator, origin, hds, executor, executorApproval: authority,
      approval: buildApprovalRuntime({}), failureMemory: new FailureMemoryStore(), target_surface: "channel",
      first_decision: firstDecision,
      persist_checkpoint: () => checkpoints.push(coordinator.checkpoint()),
      current_memory_version: () => hds.documentOrganizationMemoryVersion(),
      execution: {
        signal: controller.signal, onCycleStart: started, onCycleTask: cycleTasks, onCycleSettled: settled,
        retainCheckpointOnAbort: () => mode === "shutdown",
      },
    });

    expect(started).toHaveBeenCalledTimes(2);
    expect(cycleTasks).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([, context]) => context?.signal === controller.signal)).toBe(true);
    const cancelledCommand = started.mock.calls[1]?.[0];
    expect(cancelledCommand).toBeDefined();
    expect(settled).toHaveBeenNthCalledWith(2, cancelledCommand, "success");
    expect(review).toHaveBeenCalledTimes(1);
    expect(feedback).toHaveBeenCalledTimes(2);
    expect(feedback).toHaveBeenNthCalledWith(2, {
      command_id: cancelledCommand.id, status: "suspended",
      error: "document_organization_result_discarded_after_task_cancel", metrics: { duration_ms: 3 },
    });
    expect(hds.documentOrganizationMemoryVersion()).toEqual(memoryBefore);
    expect(checkpoints[0]).toMatchObject({
      status: "memory_pending", completed_cycles: 1, revision: 1,
      accepted_spans: [{ start: 0, end: firstQuote.length }], memory_receipts: [],
    });
    expect(checkpoints[1]).toMatchObject({
      status: "continuing", completed_cycles: 1, revision: 1, memory_receipts: [{ task_revision: 1 }],
    });

    if (mode === "shutdown") {
      expect(result).toBeNull();
      expect(checkpoints).toHaveLength(2);
      expect(coordinator.checkpoint()).toEqual(checkpoints[1]);
    } else {
      expect(result).toMatchObject({ status: "held", command_id: null, projection: { terminal_reason: "task_cancelled" } });
      expect(result?.rendered_output).not.toContain(firstQuote);
      expect(result?.rendered_output).not.toContain(secondQuote);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[2]).toEqual({
        ...checkpoints[1], status: "held", issue_codes: ["task_cancelled"], terminal_reason: "task_cancelled",
      });
      const restored = DocumentOrganizationCoordinator.restore({ source_text: source }, checkpoints[2]);
      expect(restored.snapshot().accepted_excerpts.map(({ quote }) => quote)).toEqual([firstQuote]);
      expect(() => restored.buildComputePrompt()).toThrow("not accepting another C cycle");
    }
    } finally {
      hds.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("restores a D4 checkpoint only for its exact internal receipt identity", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "bt-organize-d4-"));
    const store = new DocumentOrganizationCheckpointStore(join(temporaryRoot, "checkpoint.sqlite"));
    const hds = new HDSUpperController({ memory: new LongTermMemoryStore() });
    const prepare = (request: InboundRequest) => prepareDocumentOrganizationSession({ request, source_text: source, hds, store });
    const first = authenticatedD4Request("b".repeat(64));
    try {
      const cancelled = prepare(first);
      cancelled.coordinator.cancel();
      cancelled.persist_checkpoint();

      expect(prepare(first).restored_terminal_state).toBe(true);
      for (const other of [authenticatedD4Request("b".repeat(64)), authenticatedD4Request("c".repeat(64)), { ...first }]) {
        const session = prepare(other);
        expect(session.restored_terminal_state).toBe(false);
        expect(session.coordinator.snapshot()).toMatchObject({ status: "ready", revision: 0 });
      }
    } finally {
      store.close();
      hds.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("waits for a verified M receipt before issuing the next C cycle and resumes by the same task identity", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "bt-organize-memory-receipt-"));
    const store = new DocumentOrganizationCheckpointStore(join(temporaryRoot, "checkpoint.sqlite"));
    const memoryStorage = documentOrganizationMemoryStorage({
      BLUE_TANUKI_STATE_ROOT: join(temporaryRoot, "state"),
    });
    const hds = new HDSUpperController({
      audit: new AuditLog({ filepath: join(temporaryRoot, "audit.jsonl") }),
      memory: new LongTermMemoryStore(),
      document_organization_memory: memoryStorage,
    });
    try {
      const origin = authenticatedD4Request("d".repeat(64));
      const session = prepareDocumentOrganizationSession({ request: origin, source_text: source, hds, store });
      const authority = createExecutorApprovalAuthority();
      const executor = new Executor({
        approval_authority: authority,
        tools: new ToolRegistry(),
        llm: { name: "fixture", call: async () => { throw new Error("fixture must use stubbed Executor feedback"); } },
      });
      const execute = vi.spyOn(executor, "execute");
      execute.mockImplementationOnce(async (command) => ({
        command_id: command.id, status: "success", metrics: { duration_ms: 1 },
        result: { content: candidate(0, firstQuote) },
      }));
      execute.mockImplementationOnce(async (command) => ({
        command_id: command.id, status: "success", metrics: { duration_ms: 1 },
        result: { content: candidate(firstQuote.length + 1, secondQuote) },
      }));

      const firstDecision = hds.decide({ ...origin, content: session.coordinator.buildComputePrompt() }, {
        transient_content: "document_organization",
      });
      const completeReceipt = hds.completeDocumentOrganizationMemoryReceipt.bind(hds);
      vi.spyOn(hds, "completeDocumentOrganizationMemoryReceipt").mockImplementationOnce((input) => {
        expect(completeReceipt(input).status).toBe("ready");
        return { status: "pending", reason: "document_organization_m_receipt_pending" };
      });
      const firstRun = await runDocumentOrganizationTask({
        coordinator: session.coordinator,
        origin,
        hds,
        executor,
        executorApproval: authority,
        approval: buildApprovalRuntime({}),
        failureMemory: new FailureMemoryStore(),
        target_surface: "channel",
        first_decision: firstDecision,
        persist_checkpoint: session.persist_checkpoint,
        current_memory_version: () => hds.documentOrganizationMemoryVersion(),
      });

      expect(firstRun).toMatchObject({ status: "pending", projection: { status: "memory_pending", revision: 1 } });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(session.coordinator.checkpoint().memory_receipts).toHaveLength(0);
      const pendingProjection = session.coordinator.snapshot();
      const checkpoint = session.coordinator.checkpoint();
      const mismatchedReceipt = hds.completeDocumentOrganizationMemoryReceipt({
        projection: pendingProjection,
        prior_receipts: checkpoint.memory_receipts,
        command_id: "wrong-compute-command",
        command_request_id: checkpoint.pending_memory_command_request_id!,
        allow_new_commit: false,
      });
      expect(mismatchedReceipt).toMatchObject({ status: "blocked", reason: "document_organization_m_record_conflict" });

      const resumed = prepareDocumentOrganizationSession({ request: origin, source_text: source, hds, store });
      expect(resumed.coordinator.snapshot()).toMatchObject({ status: "continuing", revision: 1, memory_receipt_status: "confirmed" });
      expect(resumed.coordinator.checkpoint().memory_receipts).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);

      const secondDecision = hds.decide({
        ...origin,
        id: randomUUID(),
        content: resumed.coordinator.buildComputePrompt(),
      }, { transient_content: "document_organization" });
      const secondRun = await runDocumentOrganizationTask({
        coordinator: resumed.coordinator,
        origin,
        hds,
        executor,
        executorApproval: authority,
        approval: buildApprovalRuntime({}),
        failureMemory: new FailureMemoryStore(),
        target_surface: "channel",
        first_decision: secondDecision,
        persist_checkpoint: resumed.persist_checkpoint,
        current_memory_version: () => hds.documentOrganizationMemoryVersion(),
      });

      expect(secondRun).toMatchObject({ status: "completed", projection: { status: "completed", revision: 2 } });
      expect(secondRun?.projection.memory_receipt_status).toBe("confirmed");
      expect(secondRun?.projection.accepted_excerpts.map((item) => item.quote)).toEqual([firstQuote, secondQuote]);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(readFileSync(memoryStorage.memory_database_path).includes(Buffer.from(source))).toBe(false);
      expect(readFileSync(join(temporaryRoot, "audit.jsonl"), "utf8")).not.toContain(source);
    } finally {
      store.close();
      hds.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
