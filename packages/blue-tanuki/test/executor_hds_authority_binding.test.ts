import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, HDSUpperController } from "@blue-tanuki/hds-brain";
import type { ExecutionIntentStore, ExecutionIntentTicket } from "../src/execution_intent.js";
import { createExecutorApprovalAuthority, executorCommandDigest, type ExecutorApprovalProof } from "../src/executor.js";

function issuedCommand(id: string) {
  const hds = new HDSUpperController();
  const result = hds.decide({ id, channel: "webchat", user: "fixture-owner", content: "hello world", timestamp: 1 });
  if (!result.command || result.log.commit.decision !== "ASSERT") throw new Error("fixture HDS did not issue an ASSERT command");
  return { hds, command: result.command };
}

function proofFor(command: ReturnType<typeof issuedCommand>["command"]): ExecutorApprovalProof {
  const context = approvalContextFromCommand(command, { actor: "fixture-owner" });
  return {
    source: "approval_gate",
    decision: "allow",
    approved_by: "fixture-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: context.operation,
    risk: context.risk,
    final_review_required: context.risk === "high",
    reason: "synthetic approval fixture",
  };
}

function recordingIntentStore(tickets: ExecutionIntentTicket[]): ExecutionIntentStore {
  return {
    issue(ticket) { tickets.push({ ...ticket }); },
    consume() { throw new Error("not used by approval-only fixture"); },
    markInvocation() { throw new Error("not used by approval-only fixture"); },
    complete() { throw new Error("not used by approval-only fixture"); },
    lookup() { return null; },
  };
}

describe("HDSからExecutorへの非直列化source binding", () => {
  it("正確なHDS発行commandのsource digestをcanonical command/proofと同じticketへ結合する", () => {
    const { hds, command } = issuedCommand("source-binding-1");
    const binding = hds.createExecutionAuthorityBinding(command);
    const digest = executorCommandDigest(command);
    const tickets: ExecutionIntentTicket[] = [];
    const authority = createExecutorApprovalAuthority({
      execution_store: recordingIntentStore(tickets),
      require_hds_execution_binding: true,
    });
    const proof = proofFor(command);

    expect(Object.keys(binding).sort()).toEqual(["schema_version", "source_context_digest"]);
    expect(JSON.stringify(binding)).not.toContain("fixture-owner");
    expect(JSON.stringify(binding)).not.toContain("hello world");
    expect(() => authority.approve(command, proof, digest)).toThrow(/binding is required/);

    authority.approve(command, proof, digest, binding);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.command_digest).toBe(digest);
    expect(tickets[0]!.proof_digest).toBe(createHash("sha256").update(JSON.stringify({
      schema_version: "blue-tanuki.executor-authority-content-binding.v1",
      command_digest: digest,
      proof,
      hds_source_context_digest: binding.source_context_digest,
    })).digest("hex"));
    expect(() => authority.approve(command, proof, digest, binding)).toThrow(/already consumed/);
  });

  it("copyしたcommandや直列化したsealは発行元のHDS tokenとして使えない", () => {
    const { hds, command } = issuedCommand("source-binding-2");
    const binding = hds.createExecutionAuthorityBinding(command);
    const tickets: ExecutionIntentTicket[] = [];
    const authority = createExecutorApprovalAuthority({
      execution_store: recordingIntentStore(tickets),
      require_hds_execution_binding: true,
    });
    const proof = proofFor(command);
    const copiedCommand = structuredClone(command);
    const copiedBinding = JSON.parse(JSON.stringify(binding)) as typeof binding;

    expect(() => hds.createExecutionAuthorityBinding(copiedCommand)).toThrow(/source is unavailable/);
    expect(() => authority.approve(copiedCommand, proof, executorCommandDigest(copiedCommand), binding)).toThrow(/binding is invalid/);
    expect(() => authority.approve(command, proof, executorCommandDigest(command), copiedBinding)).toThrow(/binding is invalid/);
    expect(tickets).toHaveLength(0);

    authority.approve(command, proof, executorCommandDigest(command), binding);
    expect(tickets).toHaveLength(1);
  });
});
