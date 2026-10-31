import { createHash } from "node:crypto";
import {
  OperationPlanComputeSourceObservationSchema,
  type OperationPlan,
} from "@blue-tanuki/protocol";
import { sandboxRootFromEnv } from "../tools/file_safety.js";
import { LLMProviderError, type LLMBackend, type LLMRequest, type LLMResponse } from "./base.js";

export const SYNTHETIC_FILE_WRITE_PLAN_BACKEND = "synthetic-file-write-plan";
export const SYNTHETIC_FILE_WRITE_PLAN_TASK = "BLUE-TANUKI synthetic create-only file-write demonstration";
const SYNTHETIC_FILE_WRITE_REPLAN_TASK = "同じtaskの検証済み結果を踏まえて、次の未実行候補計画を作成してください。";
const SYNTHETIC_FILE_CONTENT = "BLUE-TANUKI synthetic create-only operation completed.\n";

type SyntheticPlanEnv = Record<string, string | undefined>;

function reject(message: string): LLMProviderError {
  return new LLMProviderError(message, {
    provider: SYNTHETIC_FILE_WRITE_PLAN_BACKEND,
    kind: "bad_request",
    retryable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContextTail(content: string): Record<string, unknown> | undefined {
  const separator = content.lastIndexOf("\n");
  if (separator < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(content.slice(separator + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findSyntheticFixture(messages: LLMRequest["messages"]):
  { readonly request_id: string; readonly kind: "create" | "verify" } | undefined {
  const userMessages = messages.filter((message) => message.role === "user");
  const planInstructions = messages.filter((message) => message.role === "system" &&
    message.content.includes("候補だけをJSON wrapperで返してください") &&
    message.content.includes("goal_purpose_relation.outcome"));
  const purposeContexts = messages.filter((message) => message.role === "system" &&
    message.content.includes("以下は、Jが現在版と私有Mのreceiptを照合した目的本文です。"));
  const parentContexts = messages.filter((message) => message.role === "system" &&
    message.content.includes("Jが所有・現行revision・task identityを照合した親planの原目的です。"));
  const observationContexts = messages.filter((message) => message.role === "system" &&
    message.content.includes("Jが現在のcheckpoint、M receipt、M recordを再照合した明示選択済みの観測です。"));
  const citationContexts = messages.filter((message) => message.role === "system" &&
    message.content.includes("同一requestのJ受理済み引用判定"));
  if (userMessages.length !== 1 || planInstructions.length !== 1 || purposeContexts.length !== 1 ||
      citationContexts.length !== 0) return undefined;

  const requestId = /固定request_id=([^。\s]{1,200})/u.exec(planInstructions[0]!.content)?.[1];
  if (!requestId) return undefined;
  const task = userMessages[0]!.content;
  if (task === SYNTHETIC_FILE_WRITE_PLAN_TASK && parentContexts.length === 0 && observationContexts.length === 0) {
    return { request_id: requestId, kind: "create" };
  }
  if (task !== SYNTHETIC_FILE_WRITE_REPLAN_TASK || parentContexts.length !== 1 || observationContexts.length !== 1) {
    return undefined;
  }

  const parent = parseContextTail(parentContexts[0]!.content);
  const observationPayload = parseContextTail(observationContexts[0]!.content);
  const observations = observationPayload?.observations;
  const observation = Array.isArray(observations) && observations.length === 1
    ? OperationPlanComputeSourceObservationSchema.safeParse(observations[0])
    : undefined;
  if (parent?.original_task !== SYNTHETIC_FILE_WRITE_PLAN_TASK ||
      typeof parent.task_identity_digest !== "string" || !/^[a-f0-9]{64}$/.test(parent.task_identity_digest) ||
      !observation?.success || observation.data.source !== "verified_file_write_result" ||
      observation.data.operation !== "file.write" || observation.data.task_identity_digest !== parent.task_identity_digest) {
    return undefined;
  }
  return { request_id: requestId, kind: "verify" };
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

    // HDS consumes `plan:compute` before it calls C, so the provider receives
    // task text rather than the original control envelope. Accept only the
    // exact initial task or one M-receipted file.write result from that task.
    const fixture = findSyntheticFixture(req.messages);
    if (!fixture) throw reject("Synthetic plan backend accepts only its exact local task or verified one-step continuation.");
    const requestId = fixture.request_id;
    let sandboxRoot: string;
    try {
      sandboxRoot = await sandboxRootFromEnv(this.env);
    } catch {
      throw reject("Synthetic plan backend requires a valid BLUE_TANUKI_FILE_ROOT sandbox.");
    }
    if (signal?.aborted) throw signal.reason ?? new Error("synthetic_plan_call_aborted");

    const identityDigest = createHash("sha256").update(requestId, "utf8").digest("hex");
    const relativePath = `blue-tanuki-synthetic-${identityDigest.slice(0, 20)}.txt`;
    const isCreate = fixture.kind === "create";
    const target: OperationPlan["steps"][number]["target"] = isCreate
      ? { kind: "file", id: relativePath }
      : { kind: "directory", id: sandboxRoot };
    const step: OperationPlan["steps"][number] = isCreate ? {
      step_id: `create-synthetic-note-${identityDigest.slice(0, 16)}`,
      operation: "file.write",
      target,
      state: "planned" as const,
      effects: ["write"],
      permission: {
        risk: "medium" as const,
        approval_level: "L2_operate" as const,
        final_review_required: false,
        hds_brain_authority_required: true as const,
        approval_gate_required: true,
      },
      adapter: "internal_runtime" as const,
      adapter_is_authority: false as const,
      command_generated_by_adapter_only: false,
      parameters: { path: relativePath, content: SYNTHETIC_FILE_CONTENT, mode: "create" },
      preparation: {
        depends_on: [],
        bindings: [],
        preconditions: [],
        validation: [{
          check_id: "created-synthetic-note",
          method: "result_equals" as const,
          target,
          expected: {
            path: relativePath,
            sandbox_root: sandboxRoot,
            mode: "create",
            bytes_written: Buffer.byteLength(SYNTHETIC_FILE_CONTENT, "utf8"),
          },
        }],
        compensation: {
          available: false,
          reason: "a newly created file requires owner-directed cleanup",
        },
      },
    } : {
      step_id: `verify-synthetic-note-${identityDigest.slice(0, 16)}`,
      operation: "file.search",
      target,
      state: "planned" as const,
      effects: ["read"],
      permission: {
        risk: "low" as const,
        approval_level: "L1_observe" as const,
        final_review_required: false,
        hds_brain_authority_required: true as const,
        approval_gate_required: true,
      },
      adapter: "internal_runtime" as const,
      adapter_is_authority: false as const,
      command_generated_by_adapter_only: false,
      parameters: { root: sandboxRoot, query: SYNTHETIC_FILE_CONTENT.trim(), max_results: 5 },
    };
    const plan: OperationPlan = {
      version: "operation-core.v1",
      plan_id: `synthetic-plan-${identityDigest}`,
      request_id: requestId,
      state: "planned",
      steps: [step],
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
