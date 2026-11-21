import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { evaluateApproval, HDSUpperController } from "@blue-tanuki/hds-brain";
import {
  createExecutorApprovalAuthority,
  Executor,
  LLMComputeAdapter,
  LLMRegistry,
  SyntheticFileWritePlanBackend,
  SYNTHETIC_FILE_WRITE_PLAN_TASK,
  ToolRegistry,
  type LLMBackend,
  type AgentWorkerLifecycleEvent,
  type ComputeBudgetPort,
} from "@blue-tanuki/core";
import { createCliInboundRequest } from "../src/cli_goal_completion_rules.js";

describe("CLIから合成Cへの計画候補接続", () => {
  it.each([
    { label: "全役割候補", rejectedRole: undefined },
    { label: "不正な子出力を除いた兄弟候補", rejectedRole: "audit" },
    { label: "親taskと結び付かない子digestを拒否", rejectedRole: undefined, tamperDigest: "child_task_digest" as const },
    { label: "形式不正の資源使用digestを拒否", rejectedRole: undefined, tamperDigest: "resource_use_digest" as const },
  ])("$label", async ({ rejectedRole, tamperDigest }) => {
    const sandbox = await mkdtemp(join(tmpdir(), "blue-synthetic-cli-compute-"));
    const hds = new HDSUpperController();
    const lifecycle: AgentWorkerLifecycleEvent[] = [];
    try {
      const request = createCliInboundRequest({
        id: randomUUID(),
        content: SYNTHETIC_FILE_WRITE_PLAN_TASK,
        timestamp: Date.now(),
        goal_completion_rules: {
          schema_version: "blue-tanuki.goal-completion-rules.v1",
          rules: [{ rule_id: "created", operation: "file.write", output_pointer: "/bytes_written",
            expected_value: Buffer.byteLength("BLUE-TANUKI synthetic create-only operation completed.\n", "utf8") }],
        },
      });
      const decision = hds.decide(request);
      const command = decision.command;
      expect(command?.type).toBe("llm_call");
      if (command?.type !== "llm_call") throw new Error("CLI request did not reach HDS compute");
      expect(command.payload.messages.some((message) => message.role === "user" &&
        message.content === `plan:compute ${SYNTHETIC_FILE_WRITE_PLAN_TASK}`)).toBe(true);

      const syntheticBackend = new SyntheticFileWritePlanBackend({ BLUE_TANUKI_FILE_ROOT: sandbox });
      const candidateSetMessages: string[] = [];
      const backend: LLMBackend = {
        name: syntheticBackend.name,
        capabilities: ["llm.text.generate"],
        async call(providerRequest, signal) {
          const childMessage = providerRequest.messages.find((message) =>
            message.role === "system" && message.content.startsWith("C child role="));
          const childRole = /^C child role=([a-z_]+)\./u.exec(childMessage?.content ?? "")?.[1];
          if (childRole === rejectedRole && rejectedRole !== undefined) {
            return { content: "", tokens_used: 0, model: "synthetic-file-write-plan-v1", provider: syntheticBackend.name };
          }
          const candidateSet = providerRequest.messages.find((message) =>
            message.role === "user" && message.content.includes("blue-tanuki.agent-candidate-set.v3"));
          if (candidateSet) {
            candidateSetMessages.push(candidateSet.content);
            if (tamperDigest) {
              const separator = candidateSet.content.indexOf("\n") + 1;
              const candidateSetValue = JSON.parse(candidateSet.content.slice(separator)) as {
                candidates: Array<{ child_task_digest: string; resource_use_digest?: string }>;
              };
              if (tamperDigest === "child_task_digest") {
                candidateSetValue.candidates[0]!.child_task_digest = "f".repeat(64);
              } else {
                candidateSetValue.candidates[0]!.resource_use_digest = "invalid-digest";
              }
              const messages = providerRequest.messages.map((message) => message === candidateSet
                ? { ...message, content: `${candidateSet.content.slice(0, separator)}${JSON.stringify(candidateSetValue)}` }
                : message);
              return syntheticBackend.call({ ...providerRequest, messages }, signal);
            }
          }
          return syntheticBackend.call(providerRequest, signal);
        },
      };
      const registry = new LLMRegistry({ defaultName: backend.name }).register(backend, [], {
        capabilities: ["llm_compute_candidate"],
        max_cost_per_attempt: { amount: 0, currency: "USD" },
      });
      const budget: ComputeBudgetPort = {
        reserve: (input) => ({ reservation_id: `fixture:${input.request_id}`,
          reserved_tokens: input.reserved_tokens, reserved_compute_ms: input.reserved_compute_ms,
          reserved_cost: { ...input.reserved_cost } }),
        settle: () => {},
      };
      const authority = createExecutorApprovalAuthority();
      const executor = new Executor({
        llm: registry,
        compute: new LLMComputeAdapter(registry, budget),
        tools: new ToolRegistry(),
        approval_authority: authority,
        on_agent_worker_lifecycle: (event) => { lifecycle.push(event); return true; },
      });
      const approval = evaluateApproval(command, [], { actor: request.user, default_mode: "full_access" });
      const approved = authority.approve(command, {
        source: approval.final_review_required ? "human_final_review" : "approval_gate",
        decision: "allow",
        approved_by: request.user,
        approved_at_ms: Date.now(),
        upstream_commit_hash: command.upstream_decision.commit_hash,
        operation: approval.context.operation,
        risk: approval.risk,
        final_review_required: approval.final_review_required,
        reason: "isolated synthetic CLI compute fixture",
      });
      const feedback = await executor.execute(approved);
      if (tamperDigest) {
        expect(feedback.status).toBe("failed");
        expect(candidateSetMessages).toHaveLength(1);
        return;
      }
      expect(feedback.status, feedback.error ?? JSON.stringify(feedback.llm_failure)).toBe("success");
      expect(candidateSetMessages).toHaveLength(1);
      const candidateSet = JSON.parse(candidateSetMessages[0]!.slice(candidateSetMessages[0]!.indexOf("\n") + 1)) as {
        parent_task_identity_digest: string;
        candidates: Array<{ role: string; child_task_digest: string; resource_use_digest?: string; outcome: string }>;
      };
      expect(candidateSet.candidates.filter((candidate) => candidate.outcome === "candidate")).toHaveLength(
        rejectedRole ? 3 : 4,
      );
      for (const candidate of candidateSet.candidates) {
        const expectedChildDigest = createHash("sha256").update("blue-tanuki.agent.child-task.v1\0")
          .update(candidateSet.parent_task_identity_digest).update("\0").update(candidate.role).digest("hex");
        expect(candidate.child_task_digest).toBe(expectedChildDigest);
        expect(candidate.resource_use_digest).toMatch(/^[a-f0-9]{64}$/u);
        const settledEvent = lifecycle.find((event) => event.state === "settled" && event.role === candidate.role);
        expect(candidate.resource_use_digest).toBe(settledEvent?.resource_use_digest);
      }
      if (rejectedRole) {
        expect(candidateSet.candidates.find((candidate) => candidate.role === rejectedRole)?.outcome).toBe("rejected");
      }
      const responseContent = (feedback.result as { content?: unknown } | undefined)?.content;
      expect(typeof responseContent).toBe("string");
      if (typeof responseContent !== "string") throw new Error("Synthetic C returned no candidate content");

      const candidate = JSON.parse(responseContent) as {
        plan?: { steps?: Array<{ operation?: string; state?: string; permission?: { hds_brain_authority_required?: boolean } }> };
        goal_purpose_relation?: { outcome?: string; evidence?: unknown[] };
      };
      expect(candidate.plan?.steps).toHaveLength(1);
      expect(candidate.plan?.steps?.[0]).toMatchObject({
        operation: "file.write",
        state: "planned",
        permission: { hds_brain_authority_required: true },
      });
      expect(candidate.goal_purpose_relation).toEqual({ outcome: "unknown", evidence: [] });
      expect(lifecycle.filter((event) => event.state === "started")).toHaveLength(4);
      expect(lifecycle.filter((event) => event.state === "settled")).toHaveLength(4);
      expect(new Set(lifecycle.map((event) => event.role))).toEqual(
        new Set(["division", "independent_comparison", "audit", "redundancy"]));
      expect(lifecycle.every((event) => event.used_for_authority === false && event.may_execute === false)).toBe(true);
    } finally {
      hds.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
