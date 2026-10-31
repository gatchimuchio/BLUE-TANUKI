import { createHash } from "node:crypto";
import {
  OperationPlanComputeInputSchema,
  type OperationPlan,
} from "@blue-tanuki/protocol";
import { sandboxRootFromEnv } from "../tools/file_safety.js";
import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "./base.js";

export const SYNTHETIC_FILE_WRITE_PLAN_BACKEND = "synthetic-file-write-plan";
export const SYNTHETIC_FILE_WRITE_PLAN_TASK = "BLUE-TANUKI synthetic create-only file-write demonstration";

type SyntheticPlanEnv = Record<string, string | undefined>;

function reject(message: string): LLMProviderError {
  return new LLMProviderError(message, {
    provider: SYNTHETIC_FILE_WRITE_PLAN_BACKEND,
    kind: "bad_request",
    retryable: false,
  });
}

function findRequestId(messages: LLMRequest["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "system") continue;
    const match = /固定request_id=([^。\s]{1,200})/u.exec(message.content);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Local development-only C fixture. It can propose one exact create-only
 * operation; HDS, Approval Gate, Broker, Executor, and the file sandbox keep
 * their existing authority and execution responsibilities.
 */
export class SyntheticFileWritePlanBackend implements LLMBackend {
  readonly name = SYNTHETIC_FILE_WRITE_PLAN_BACKEND;
  readonly capabilities = ["llm.text.generate"] as const;

  constructor(private readonly env: SyntheticPlanEnv) {}

  async call(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    if (signal?.aborted) throw signal.reason ?? new Error("synthetic_plan_call_aborted");
    if (req.ephemeral_images?.length || req.ephemeral_audio?.length) {
      throw reject("Synthetic plan backend does not consume media input.");
    }

    let userMessage: LLMRequest["messages"][number] | undefined;
    for (let index = req.messages.length - 1; index >= 0; index -= 1) {
      if (req.messages[index]?.role === "user") {
        userMessage = req.messages[index];
        break;
      }
    }
    const prefix = "plan:compute ";
    if (!userMessage?.content.startsWith(prefix)) {
      throw reject("Synthetic plan backend accepts only the exact local plan-compute fixture.");
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(userMessage.content.slice(prefix.length));
    } catch {
      throw reject("Synthetic plan input is not valid JSON.");
    }
    const parsedInput = OperationPlanComputeInputSchema.safeParse(rawInput);
    if (!parsedInput.success || parsedInput.data.task !== SYNTHETIC_FILE_WRITE_PLAN_TASK ||
        !parsedInput.data.goal_purpose_binding || parsedInput.data.parent_plan ||
        parsedInput.data.source_citation_request_id || (parsedInput.data.source_observation_refs?.length ?? 0) > 0) {
      throw reject("Synthetic plan backend accepts only its exact create-only task without inherited observations.");
    }

    const requestId = findRequestId(req.messages);
    if (!requestId) throw reject("Synthetic plan request identity is unavailable.");
    let sandboxRoot: string;
    try {
      sandboxRoot = await sandboxRootFromEnv(this.env);
    } catch {
      throw reject("Synthetic plan backend requires a valid BLUE_TANUKI_FILE_ROOT sandbox.");
    }
    if (signal?.aborted) throw signal.reason ?? new Error("synthetic_plan_call_aborted");

    const identityDigest = createHash("sha256").update(requestId, "utf8").digest("hex");
    const relativePath = `blue-tanuki-synthetic-${identityDigest.slice(0, 20)}.txt`;
    const content = "BLUE-TANUKI synthetic create-only operation completed.\n";
    const target = { kind: "file" as const, id: relativePath };
    const plan: OperationPlan = {
      version: "operation-core.v1",
      plan_id: `synthetic-plan-${identityDigest}`,
      request_id: requestId,
      state: "planned",
      steps: [{
        step_id: `create-synthetic-note-${identityDigest.slice(0, 16)}`,
        operation: "file.write",
        target,
        state: "planned",
        effects: ["write"],
        permission: {
          risk: "medium",
          approval_level: "L2_operate",
          final_review_required: false,
          hds_brain_authority_required: true,
          approval_gate_required: true,
        },
        adapter: "internal_runtime",
        adapter_is_authority: false,
        command_generated_by_adapter_only: false,
        parameters: { path: relativePath, content, mode: "create" },
        preparation: {
          depends_on: [],
          bindings: [],
          preconditions: [],
          validation: [{
            check_id: "created-synthetic-note",
            method: "result_equals",
            target,
            expected: {
              path: relativePath,
              sandbox_root: sandboxRoot,
              mode: "create",
              bytes_written: Buffer.byteLength(content, "utf8"),
            },
          }],
          compensation: {
            available: false,
            reason: "a newly created file requires owner-directed cleanup",
          },
        },
      }],
      rollback: { available: false },
      raw_command_policy: {
        raw_command_is_core_operation: false,
        command_generation_location: "not_applicable",
      },
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
    };

    return {
      content: JSON.stringify({
        plan,
        goal_purpose_relation: { outcome: "unknown", evidence: [] },
      }),
      tokens_used: 0,
      tokens_usage_status: "provider_reported",
      model: "synthetic-file-write-plan-v1",
      provider: this.name,
    };
  }
}
