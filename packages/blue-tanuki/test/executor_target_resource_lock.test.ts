import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, finalReviewRequired } from "@blue-tanuki/hds-brain";
import { requireToolOperationDescriptor, type ExecuteCommand } from "@blue-tanuki/protocol";
import { createExecutorApprovalAuthority, Executor, executorCommandDigest } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { ToolRegistry, type Tool } from "../src/tools/registry.js";

const upstream = { frame_goal: "fixture", model_abstraction: "fixture", commit_hash: "a".repeat(64),
  commit_decision: "ASSERT" as const };

function approved(authority: ReturnType<typeof createExecutorApprovalAuthority>, command: ExecuteCommand) {
  const context = approvalContextFromCommand(command, { actor: "fixture-owner" });
  const finalReview = finalReviewRequired(context);
  return authority.approve(command, {
    source: finalReview ? "human_final_review" : "approval_gate",
    decision: finalReview ? "approve" : "allow",
    approved_by: "fixture-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: context.operation,
    risk: context.risk,
    final_review_required: finalReview,
    reason: "isolated target-lock fixture",
  }, executorCommandDigest(command));
}

describe("Executor shared target resource lock", () => {
  it("serializes concurrent file.write commands that resolve to the same physical target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-target-lock-"));
    const previousRoot = process.env.BLUE_TANUKI_FILE_ROOT;
    process.env.BLUE_TANUKI_FILE_ROOT = root;
    await fs.writeFile(path.join(root, "shared.txt"), "fixture", "utf8");

    let active = 0;
    let maxActive = 0;
    let started = 0;
    let notifyFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const invoke = async (): Promise<unknown> => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) {
        notifyFirstStarted();
        await firstGate;
      }
      active -= 1;
      return { completed: true };
    };
    const tool = (): Tool => ({
      name: "file.write",
      description: "fixture target mutation",
      required_capabilities: requireToolOperationDescriptor("file.write").required_capabilities,
      invoke,
    });
    const tools = new ToolRegistry();
    tools.register(tool());
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const makeCommand = (id: string): ExecuteCommand => ({
      id,
      type: "tool_call",
      payload: { tool_name: "file.write", arguments: { path: "shared.txt" } },
      constraints: {
        allowed_tools: ["file.write"],
        allowed_capabilities: [...(tools.get("file.write")?.required_capabilities ?? [])],
      },
      upstream_decision: upstream,
    });
    const firstCommand = approved(authority, makeCommand("target-lock-write-1"));
    const secondCommand = approved(authority, makeCommand("target-lock-write-2"));
    let executions: Promise<unknown>[] = [];

    try {
      const firstExecution = executors[0]!.execute(firstCommand);
      const secondExecution = executors[1]!.execute(secondCommand);
      executions = [firstExecution, secondExecution];
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toBe(1);
      releaseFirst();
      const feedback = await Promise.all([firstExecution, secondExecution]);
      expect(feedback.map((entry) => entry.status)).toEqual(["success", "success"]);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.allSettled(executions);
      if (previousRoot === undefined) delete process.env.BLUE_TANUKI_FILE_ROOT;
      else process.env.BLUE_TANUKI_FILE_ROOT = previousRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
