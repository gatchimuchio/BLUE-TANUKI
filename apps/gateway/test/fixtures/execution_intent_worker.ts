/** 開発試験専用。資格を継承せず、親が指定した一時領域の合成作用だけを行う。 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { approvalContextFromCommand, finalReviewRequired } from "@blue-tanuki/hds-brain";
import { Executor, createExecutorApprovalAuthority, ToolRegistry } from "@blue-tanuki/core";
import { GatewayExecutionIntentStore } from "../../src/execution_intent_store.js";

const [root, id, mode, executionEpoch] = process.argv.slice(2);
if (!root || !id || !executionEpoch || !["complete", "hold"].includes(mode)) throw new Error("invalid fixture arguments");
process.send?.("ready"); await once(process, "message");
const store = new GatewayExecutionIntentStore(join(root, "executor.sqlite"), executionEpoch);
try {
  const authority = createExecutorApprovalAuthority({ execution_store: store, execution_epoch: executionEpoch });
  const tools = new ToolRegistry();
  tools.register({ name: "synthetic.read", description: "合成process作用", required_capabilities: ["tool:synthetic.read"],
    invoke: async () => {
      appendFileSync(join(root, "calls.txt"), `${id}\n`);
      if (mode === "hold") { process.send?.("invoked"); await new Promise(() => {}); }
      return "青";
    } });
  const executor = new Executor({ approval_authority: authority, tools, llm: { name: "fixture", call: async () => { throw new Error("not used"); } } });
  const command = { id, type: "tool_call" as const, payload: { tool_name: "synthetic.read", arguments: { target: "青" } },
    constraints: { allowed_tools: ["synthetic.read"], allowed_capabilities: ["tool:synthetic.read"] },
    upstream_decision: { request_id: "fixture-task", frame_goal: "合成対象を読む", model_abstraction: "fixture", commit_hash: "fixture-commit", commit_decision: "ASSERT" as const } };
  const context = approvalContextFromCommand(command);
  const final_review_required = finalReviewRequired(context);
  const approved = authority.approve(command, { source: final_review_required ? "human_final_review" : "approval_gate",
    decision: final_review_required ? "approve" : "allow", approved_by: "fixture-owner", approved_at_ms: Date.now(),
    upstream_commit_hash: "fixture-commit", operation: context.operation, risk: context.risk, final_review_required, reason: "fixture" });
  const result = await executor.execute(approved);
  process.exitCode = result.status === "success" ? 0 : 1;
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("command already issued")) throw error;
  process.exitCode = 2;
} finally { store.close(); process.disconnect?.(); }
