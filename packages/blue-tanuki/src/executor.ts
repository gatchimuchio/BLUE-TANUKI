import { createHash } from "node:crypto";
import type {
  ExecuteCommand,
  ExecuteFeedback,
  LLMCallFailure,
  LLMCallPayload,
  ToolCallPayload,
  ChannelSendPayload,
  ToolCapability,
} from "@blue-tanuki/protocol";
import {
  classifyLLMError,
  createLLMAbortError,
  LLMProviderError,
  LLM_EXECUTION_CANCELLED_REASON,
  LLM_EXECUTION_TIMEOUT_REASON,
  normalizeLLMToolCallCandidates,
  type LLMBackend,
  type LLMErrorKind,
  type LLMRequest,
  type LLMResponse,
} from "./llm/base.js";
import {
  LLM_COMPUTE_PROFILE,
  type ComputeBackend,
  type ComputeInputSource,
  type ComputeRequest,
} from "./llm/compute.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { SessionStore } from "./sessions/types.js";
import {
  buildOperationCoreExecutorTrace,
  inspectOperationCorePlannerOutput,
} from "./operation_core.js";

/**
 * Minimal dispatcher contract used by the Executor for channel_send.
 * Kept structurally minimal so this package does not have to depend on
 * @blue-tanuki/channel-base directly. Anything implementing this shape works.
 */
export interface ChannelDispatcher {
  dispatch(
    payload: ChannelSendPayload,
    meta: { command_id: string; upstream_commit_hash: string },
  ): Promise<{
    delivered: boolean;
    external_id?: string;
    error?: string;
    error_kind?: "recoverable" | "non_recoverable";
    error_code?: string;
    retry_after_ms?: number;
    next_action?: string;
  }>;
}

export interface ExecutorDeps {
  llm: LLMBackend;
  /** Gateway configures this for the governed HDS-to-provider path. */
  compute?: ComputeBackend<LLMRequest, LLMResponse>;
  tools: ToolRegistry;
  /**
   * Required authority instance for approving commands for this Executor.
   * A proof object alone is not execution authority; the command must be
   * branded by the same authority instance captured here.
   */
  approval_authority: ExecutorApprovalAuthority;
  /**
   * Optional. When omitted, channel_send falls back to console.log
   * (Phase 0/1 behavior). When present, channel_send is routed via the
   * dispatcher and translates the result into ExecuteFeedback.
   */
  dispatcher?: ChannelDispatcher;
  /**
   * Optional. When present and an llm_call payload carries a session_id,
   * the executor (a) prepends retained history to the messages array
   * before invoking the LLM and (b) appends the current user message
   * and the assistant reply on success.
   *
   * When omitted, llm_call behaves as in Phase 1-3: messages are passed
   * through to the backend unchanged and nothing is persisted.
   */
  session_store?: SessionStore;
  /**
   * Optional. Maximum history messages to retrieve per llm_call. When
   * omitted, all retained history is prepended. Useful when the cap on
   * the SessionStore is large but per-call context should be smaller.
   */
  history_limit?: number;
}

export interface ExecutorExecutionContext {
  /** Caller cancellation for the current LLM request. */
  signal?: AbortSignal;
}

const APPROVED_COMMAND_BRAND: unique symbol = Symbol("blue_tanuki.executor.approved_command.v1");
const APPROVAL_AUTHORITY_IDS = new WeakMap<ExecutorApprovalAuthority, symbol>();

export type ExecutorApprovalSource = "approval_gate" | "human_final_review";
export type ExecutorApprovalDecision = "allow" | "approve";

export interface ExecutorApprovalProof {
  source: ExecutorApprovalSource;
  decision: ExecutorApprovalDecision;
  approved_by: string;
  approved_at_ms: number;
  upstream_commit_hash: string;
  operation: string;
  risk: "low" | "medium" | "high";
  final_review_required: boolean;
  reason: string;
}

interface ApprovedCommandRecord {
  proof: ExecutorApprovalProof;
  authority_id: symbol;
}

export type ApprovedCommand = ExecuteCommand & {
  readonly [APPROVED_COMMAND_BRAND]: ApprovedCommandRecord;
};

export interface ExecutorApprovalAuthority {
  approve(command: ExecuteCommand, proof: ExecutorApprovalProof): ApprovedCommand;
}

export function createExecutorApprovalAuthority(): ExecutorApprovalAuthority {
  const authorityId = Symbol("blue_tanuki.executor.approval_authority.instance");
  const authority = Object.freeze({
    approve(command: ExecuteCommand, proof: ExecutorApprovalProof): ApprovedCommand {
      return approveCommandForExecution(command, proof, authorityId);
    },
  });
  APPROVAL_AUTHORITY_IDS.set(authority, authorityId);
  return authority;
}

function approveCommandForExecution(
  command: ExecuteCommand,
  proof: ExecutorApprovalProof,
  authority_id: symbol,
): ApprovedCommand {
  if (proof.upstream_commit_hash !== command.upstream_decision.commit_hash) {
    throw new Error("approval proof commit hash does not match command upstream decision");
  }
  if (command.upstream_decision.commit_decision !== "ASSERT") {
    throw new Error(`approval proof cannot execute upstream decision ${command.upstream_decision.commit_decision}`);
  }
  if (!proof.approved_by.trim()) {
    throw new Error("approval proof approved_by is required");
  }
  if (!Number.isFinite(proof.approved_at_ms) || proof.approved_at_ms <= 0) {
    throw new Error("approval proof approved_at_ms must be a positive timestamp");
  }
  const approved = command as ApprovedCommand;
  Object.defineProperty(approved, APPROVED_COMMAND_BRAND, {
    value: { proof: { ...proof }, authority_id },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return approved;
}

/**
 * Executor: the top-level dispatcher for BLUE-TANUKI.
 *
 * Receives ExecuteCommand from HDS-BRAIN, switches on command type,
 * routes to the right subsystem, returns ExecuteFeedback.
 *
 * Critical: this layer enforces command constraints (timeout, allowed_tools,
 * allowed_capabilities). Upstream HDS-BRAIN sets the policy; the Executor is
 * the gatekeeper that applies it at the moment of execution.
 */
export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(cmd: ApprovedCommand, context: ExecutorExecutionContext = {}): Promise<ExecuteFeedback> {
    const start = Date.now();
    let proof: ExecutorApprovalProof | undefined;
    try {
      proof = this.assertExecutionApproved(cmd);
      let feedback: ExecuteFeedback;
      switch (cmd.type) {
        case "llm_call":
          feedback = await this.executeLLMCall(cmd.id, cmd.payload, cmd.constraints, start, context.signal);
          break;
        case "tool_call":
          feedback = await this.executeToolCall(cmd.id, cmd.payload, cmd.constraints, start, cmd.upstream_decision.commit_hash);
          break;
        case "channel_send":
          feedback = await this.executeChannelSend(cmd.id, cmd.payload, start, cmd.upstream_decision.commit_hash);
          break;
        case "noop":
          feedback = {
            command_id: cmd.id,
            status: "success",
            result: null,
            metrics: { duration_ms: Date.now() - start },
          };
          break;
      }
      return attachOperationCoreTrace(cmd, feedback, proof);
    } catch (e) {
      const feedback: ExecuteFeedback = {
        command_id: cmd.id,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        metrics: { duration_ms: Date.now() - start },
      };
      return proof ? attachOperationCoreTrace(cmd, feedback, proof) : feedback;
    }
  }

  private async executeLLMCall(
    id: string,
    payload: LLMCallPayload,
    constraints: ExecuteCommand["constraints"],
    start: number,
    callerSignal?: AbortSignal,
  ): Promise<ExecuteFeedback> {
    // History merge: when a session_store is configured AND the payload
    // declares a session_id, prepend retained history before invoking
    // the LLM. The current user message (typically payload.messages[-1])
    // is NOT pre-appended here — it is appended only on success below,
    // together with the assistant reply, so that failed calls don't
    // pollute the history.
    const session_store = this.deps.session_store;
    const session_id = payload.session_id;

    let effectiveMessages = payload.messages;
    let sessionHistoryApplied = false;
    if (session_store && session_id) {
      const history = await session_store.getMessages(session_id, {
        limit: this.deps.history_limit,
      });
      if (history.length > 0) {
        sessionHistoryApplied = true;
        effectiveMessages = [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          ...payload.messages,
        ];
      }
    }

    const providerRequest: LLMRequest = {
      messages: effectiveMessages,
      ...(payload.backend_hint !== undefined ? { backend_hint: payload.backend_hint } : {}),
      ...(payload.model !== undefined ? { model: payload.model } : {}),
      ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
      ...(constraints?.max_tokens !== undefined ? { max_tokens: constraints.max_tokens } : {}),
      ...(constraints?.timeout_ms !== undefined ? { timeout_ms: constraints.timeout_ms } : {}),
    };
    const requestedProvider = safeProviderLabel(payload.backend_hint ?? this.deps.llm.name);
    let resp: LLMResponse;
    try {
      resp = await withLLMCallGuard(
        requestedProvider,
        constraints?.timeout_ms,
        callerSignal,
        async (signal) => {
          if (this.deps.compute) {
            return this.deps.compute.compute(buildComputeRequest({
              request_id: id,
              context: payload.compute_context,
              provider_request: providerRequest,
              max_tokens: constraints?.max_tokens,
              timeout_ms: constraints?.timeout_ms,
              session_history_applied: sessionHistoryApplied,
            }), signal);
          }
          return this.deps.llm.call(providerRequest, signal);
        },
      );
    } catch (error) {
      return buildLLMFailureFeedback(id, error, requestedProvider, Date.now() - start);
    }

    // Provider adapters and custom backends may attach raw diagnostic payloads.
    // They are never part of the operator-facing result or session history.
    if (Object.hasOwn(resp, "raw")) {
      const safeResponse = { ...resp };
      delete safeResponse.raw;
      resp = safeResponse;
    }

    let toolCandidates: NonNullable<LLMResponse["tool_calls"]> | undefined;
    try {
      toolCandidates = normalizeLLMToolCallCandidates(
        safeProviderLabel(resp.provider ?? requestedProvider),
        resp.tool_calls,
      );
      if (toolCandidates) resp = { ...resp, tool_calls: toolCandidates };
    } catch (error) {
      return buildLLMFailureFeedback(id, error, requestedProvider, Date.now() - start);
    }

    const plannerInspection = inspectOperationCorePlannerOutput(resp.content);
    if (plannerInspection.kind === "rejected") {
      return {
        command_id: id,
        status: "failed",
        error: safeOperationPlanRejection(plannerInspection.rejection.reason),
        llm_failure: {
          schema_version: "blue-tanuki.llm-failure.v1",
          kind: "invalid_structured_output",
          retryable: false,
          provider: safeProviderLabel(resp.provider ?? requestedProvider),
          authority_boundary: { used_for_authority: false },
        },
        result: { operation_core: { status: "rejected", planner_output_used_for_authority: false } },
        metrics: {
          duration_ms: Date.now() - start,
          tokens_used: resp.tokens_used,
        },
      };
    }

    // Append on success. We persist the messages that the *current call*
    // contributed (i.e. payload.messages, not the prepended history,
    // which is already on disk) plus the assistant reply.
    if (session_store && session_id) {
      const now = Date.now();
      for (const m of payload.messages) {
        await session_store.append(session_id, {
          role: m.role,
          content: m.content,
          timestamp: now,
        });
      }
      if (resp.content) {
        await session_store.append(session_id, {
          role: "assistant",
          content: resp.content,
          timestamp: Date.now(),
        });
      }
    }

    return {
      command_id: id,
      status: "success",
      result: plannerInspection.kind === "valid_plan"
        ? { ...resp, operation_core: plannerInspection.evidence }
        : resp,
      ...(toolCandidates?.length ? { llm_tool_candidates: toolCandidates } : {}),
      metrics: {
        duration_ms: Date.now() - start,
        tokens_used: resp.tokens_used,
      },
    };
  }

  private async executeToolCall(
    id: string,
    payload: ToolCallPayload,
    constraints: ExecuteCommand["constraints"],
    start: number,
    commit_hash: string,
  ): Promise<ExecuteFeedback> {
    if (constraints?.allowed_tools && !constraints.allowed_tools.includes(payload.tool_name)) {
      return {
        command_id: id,
        status: "failed",
        error: `Tool not in allowed_tools: ${payload.tool_name}`,
        metrics: { duration_ms: Date.now() - start },
      };
    }

    const tool = this.deps.tools.get(payload.tool_name);
    if (!tool) {
      return {
        command_id: id,
        status: "failed",
        error: `Tool not registered: ${payload.tool_name}`,
        metrics: { duration_ms: Date.now() - start },
      };
    }

    const required = tool.required_capabilities ?? [];
    const allowed = new Set(constraints?.allowed_capabilities ?? []);
    const missing = required.filter((cap) => !allowed.has(cap));
    if (missing.length > 0) {
      return {
        command_id: id,
        status: "failed",
        error:
          `Tool capability not allowed: ${payload.tool_name} requires ` +
          missing.join(", "),
        metrics: { duration_ms: Date.now() - start },
      };
    }

    const controller = new AbortController();
    const result = await this.withTimeout(
      tool.invoke(payload.arguments, {
        command_id: id,
        upstream_commit_hash: commit_hash,
        signal: controller.signal,
      }),
      constraints?.timeout_ms,
      controller,
    );
    return {
      command_id: id,
      status: "success",
      result,
      metrics: { duration_ms: Date.now() - start, tool_calls: 1 },
    };
  }

  private async executeChannelSend(
    id: string,
    payload: ChannelSendPayload,
    start: number,
    commit_hash: string,
  ): Promise<ExecuteFeedback> {
    if (this.deps.dispatcher) {
      const r = await this.deps.dispatcher.dispatch(payload, {
        command_id: id,
        upstream_commit_hash: commit_hash,
      });
      if (r.delivered) {
        return {
          command_id: id,
          status: "success",
          result: {
            sent: true,
            channel: payload.channel,
            target: payload.target,
            external_id: r.external_id,
          },
          metrics: { duration_ms: Date.now() - start },
        };
      }
      return {
        command_id: id,
        status: "failed",
        error: r.error ?? "channel_dispatch_failed",
        result: {
          sent: false,
          channel: payload.channel,
          target: payload.target,
          error_kind: r.error_kind,
          error_code: r.error_code,
          retry_after_ms: r.retry_after_ms,
          next_action: r.next_action,
        },
        metrics: { duration_ms: Date.now() - start },
      };
    }

    // Fallback: Phase 0/1 behavior — log only.
    // eslint-disable-next-line no-console
    console.log(
      `[channel:${payload.channel}] -> ${payload.target}: ${payload.content}`,
    );
    return {
      command_id: id,
      status: "success",
      result: { sent: true, channel: payload.channel, target: payload.target },
      metrics: { duration_ms: Date.now() - start },
    };
  }

  private async withTimeout<T>(
    p: Promise<T>,
    timeout_ms: number | undefined,
    controller?: AbortController,
  ): Promise<T> {
    if (!timeout_ms) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`timeout after ${timeout_ms}ms`));
            controller?.abort();
          }, timeout_ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertExecutionApproved(cmd: ApprovedCommand): ExecutorApprovalProof {
    const record = approvalProofFromCommand(cmd);
    if (!record) {
      throw new Error("Executor rejected unapproved command: ApprovedCommand proof is required");
    }
    if (record.authority_id !== authorityIdFor(this.deps.approval_authority)) {
      throw new Error("Executor rejected command: approval authority mismatch");
    }
    const { proof } = record;
    if (proof.upstream_commit_hash !== cmd.upstream_decision.commit_hash) {
      throw new Error("Executor rejected command: approval proof commit hash mismatch");
    }
    if (cmd.upstream_decision.commit_decision !== "ASSERT") {
      throw new Error(`Executor rejected command: upstream decision is ${cmd.upstream_decision.commit_decision}`);
    }
    if (proof.decision !== "allow" && proof.decision !== "approve") {
      throw new Error("Executor rejected command: approval proof decision is not executable");
    }
    if (commandRequiresHumanFinalReview(cmd)) {
      if (proof.source !== "human_final_review" || proof.final_review_required !== true || proof.risk !== "high") {
        throw new Error(
          `Executor rejected high-risk command ${commandOperationLabel(cmd)}: human final-review proof is required`,
        );
      }
    }
    return proof;
  }
}

function safeOperationPlanRejection(reason: string): string {
  if (reason.startsWith("raw command field is not allowed in planner output:")) {
    return "Operation Core planner output rejected: raw command field.";
  }
  if (reason.startsWith("OperationPlanSchema rejected planner output")) {
    return "Operation Core planner output rejected: OperationPlanSchema rejected planner output.";
  }
  if (/^adapter registry rejected planner output: adapter registry rejected [A-Za-z0-9._:-]+: shell requires command_generated_by_adapter_only=true$/.test(reason)) {
    return "Operation Core planner output rejected: adapter registry rejected planner output: shell requires command_generated_by_adapter_only=true";
  }
  return "Model output did not satisfy the OperationPlan structure.";
}

function safeProviderLabel(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : "configured-provider";
}

function safeLLMFailureMessage(kind: LLMErrorKind): string {
  switch (kind) {
    case "rate_limited": return "The provider rate limit was reached.";
    case "temporary_network":
    case "disconnected": return "The provider connection ended before a complete response.";
    case "remote_service_unavailable": return "The provider is temporarily unavailable.";
    case "auth": return "Provider authentication failed.";
    case "bad_request": return "The provider rejected the request.";
    case "bad_response":
    case "invalid_structured_output": return "The provider returned an invalid response structure.";
    case "timeout": return "The provider request timed out.";
    case "cancelled": return "The provider request was cancelled.";
    case "partial_response": return "The provider returned a partial response.";
    case "unknown": return "The LLM request failed.";
  }
}

function buildLLMFailureFeedback(
  commandId: string,
  error: unknown,
  requestedProvider: string,
  durationMs: number,
): ExecuteFeedback {
  const classification = classifyLLMError(error);
  const provider = error instanceof LLMProviderError
    ? safeProviderLabel(error.provider)
    : requestedProvider;
  const failure: LLMCallFailure = {
    schema_version: "blue-tanuki.llm-failure.v1",
    kind: classification.kind,
    retryable: classification.retryable,
    provider,
    ...(classification.status !== undefined ? { status: classification.status } : {}),
    ...(classification.retry_after_ms !== undefined
      ? { retry_after_ms: Math.min(604_800_000, classification.retry_after_ms) }
      : {}),
    authority_boundary: { used_for_authority: false },
  };
  return {
    command_id: commandId,
    status: "failed",
    error: safeLLMLocalError(error) ?? safeLLMFailureMessage(classification.kind),
    llm_failure: failure,
    metrics: { duration_ms: durationMs },
  };
}

function safeLLMLocalError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const exactMessages = new Set([
    "LLM compute context is required when a compute adapter is configured",
    "compute request_id is required",
    "compute projection digest must be a SHA-256 hex digest",
    "compute input digest must be a SHA-256 hex digest",
    "compute local P version is required",
    "LLM compute profile does not match this adapter",
    "compute data exposure sources are required",
    "compute data exposure sources must be unique",
    "compute requested egress provider is required",
    "compute requested provider does not match its data exposure scope",
    "compute backend returned no provider identity",
    "compute backend returned no model identity",
  ]);
  if (exactMessages.has(error.message)) return error.message;
  if (/^compute resource limit (?:max_tokens|timeout_ms) must be a positive safe integer$/.test(error.message)) {
    return error.message;
  }
  return undefined;
}

async function withLLMCallGuard<T>(
  provider: string,
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (callerSignal?.aborted) {
    const controller = new AbortController();
    controller.abort(LLM_EXECUTION_CANCELLED_REASON);
    throw createLLMAbortError(provider, controller.signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callerAbortHandler: (() => void) | undefined;
  const guards: Promise<never>[] = [];

  if (timeoutMs !== undefined && timeoutMs > 0) {
    guards.push(new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(LLM_EXECUTION_TIMEOUT_REASON);
        reject(createLLMAbortError(provider, controller.signal));
      }, timeoutMs);
    }));
  }

  if (callerSignal) {
    guards.push(new Promise<never>((_, reject) => {
      callerAbortHandler = () => {
        controller.abort(LLM_EXECUTION_CANCELLED_REASON);
        reject(createLLMAbortError(provider, controller.signal));
      };
      callerSignal.addEventListener("abort", callerAbortHandler, { once: true });
      if (callerSignal.aborted) callerAbortHandler();
    }));
  }

  const operation = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw createLLMAbortError(provider, controller.signal);
    return invoke(controller.signal);
  });

  try {
    return await Promise.race([operation, ...guards]);
  } finally {
    if (timer) clearTimeout(timer);
    if (callerAbortHandler) callerSignal?.removeEventListener("abort", callerAbortHandler);
  }
}

function attachOperationCoreTrace(
  command: ExecuteCommand,
  feedback: ExecuteFeedback,
  proof: ExecutorApprovalProof,
): ExecuteFeedback {
  return {
    ...feedback,
    operation_core: buildOperationCoreExecutorTrace(command, feedback.status, proof),
  };
}

function approvalProofFromCommand(command: ExecuteCommand): ApprovedCommandRecord | null {
  const proof = (command as { [APPROVED_COMMAND_BRAND]?: ApprovedCommandRecord })[APPROVED_COMMAND_BRAND];
  return proof ?? null;
}

function authorityIdFor(authority: ExecutorApprovalAuthority): symbol {
  const id = APPROVAL_AUTHORITY_IDS.get(authority);
  if (!id) {
    throw new Error("Executor approval authority was not created by createExecutorApprovalAuthority");
  }
  return id;
}

function commandRequiresHumanFinalReview(command: ExecuteCommand): boolean {
  if (command.type !== "tool_call") return false;
  const tool = command.payload.tool_name;
  if (
    tool === "shell.exec" ||
    tool === "github.write" ||
    tool === "gmail.write" ||
    tool === "google.calendar.write" ||
    tool === "google.drive.write" ||
    tool === "composio.execute" ||
    tool === "browser.automation" ||
    tool === "schedule.create" ||
    tool === "schedule.update" ||
    tool === "schedule.delete"
  ) {
    return true;
  }
  const caps = command.constraints?.allowed_capabilities ?? [];
  return hasAnyCapability(caps, [
    "shell:exec",
    "process:exec",
    "settings:write",
    "schedule:create",
    "schedule:update",
    "schedule:delete",
    "automation:create",
    "automation:update",
    "automation:delete",
    "tool:github.write",
    "tool:gmail.write",
    "tool:google.calendar.write",
    "tool:google.drive.write",
    "tool:composio.execute",
    "tool:browser.automation",
    "browser:act",
    "external:send",
    "email:send",
  ]);
}

function hasAnyCapability(caps: readonly ToolCapability[], expected: readonly string[]): boolean {
  const set = new Set(caps);
  return expected.some((cap) => set.has(cap));
}

function commandOperationLabel(command: ExecuteCommand): string {
  if (command.type === "tool_call") return command.payload.tool_name;
  return command.type;
}

function buildComputeRequest(input: {
  request_id: string;
  context: LLMCallPayload["compute_context"];
  provider_request: LLMRequest;
  max_tokens?: number;
  timeout_ms?: number;
  session_history_applied: boolean;
}): ComputeRequest<LLMRequest> {
  const context = input.context;
  if (!context) {
    throw new Error("LLM compute context is required when a compute adapter is configured");
  }
  const input_sources: ComputeInputSource[] = [...context.data_exposure.input_sources];
  if (input.session_history_applied) input_sources.push("session_history");
  return {
    request_id: input.request_id,
    current_projection_digest: context.projection_digest,
    input_digest: createHash("sha256")
      .update(JSON.stringify(input.provider_request))
      .digest("hex"),
    c_profile: LLM_COMPUTE_PROFILE,
    local_p_version: context.local_p_version,
    data_exposure_scope: {
      input_sources,
      requested_egress_provider: context.data_exposure.requested_egress_provider,
    },
    resource_limits: {
      ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
      ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    },
    input: input.provider_request,
  };
}
