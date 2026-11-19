import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Executor, ToolRegistry, createExecutorApprovalAuthority } from "@blue-tanuki/core";
import { DocumentOrganizationCoordinator, FailureMemoryStore, HDSUpperController, LongTermMemoryStore } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, type InboundRequest } from "@blue-tanuki/protocol";
import { buildApprovalRuntime } from "../src/approval_runtime.js";
import { DocumentOrganizationCheckpointStore } from "../src/document_organization_checkpoint_store.js";
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
    const hds = new HDSUpperController({ memory: new LongTermMemoryStore() });
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
      status: "continuing", completed_cycles: 1, revision: 1, accepted_spans: [{ start: 0, end: firstQuote.length }],
    });

    if (mode === "shutdown") {
      expect(result).toBeNull();
      expect(checkpoints).toHaveLength(1);
      expect(coordinator.checkpoint()).toEqual(checkpoints[0]);
    } else {
      expect(result).toMatchObject({ status: "held", command_id: null, projection: { terminal_reason: "task_cancelled" } });
      expect(result?.rendered_output).not.toContain(firstQuote);
      expect(result?.rendered_output).not.toContain(secondQuote);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[1]).toEqual({
        ...checkpoints[0], status: "held", issue_codes: ["task_cancelled"], terminal_reason: "task_cancelled",
      });
      const restored = DocumentOrganizationCoordinator.restore({ source_text: source }, checkpoints[1]);
      expect(restored.snapshot().accepted_excerpts.map(({ quote }) => quote)).toEqual([firstQuote]);
      expect(() => restored.buildComputePrompt()).toThrow("not accepting another C cycle");
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
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
