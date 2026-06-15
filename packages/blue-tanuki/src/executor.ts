import type {
  ExecuteCommand,
  ExecuteFeedback,
  LLMCallPayload,
  ToolCallPayload,
  ChannelSendPayload,
  ToolCapability,
} from "@blue-tanuki/protocol";
import type { LLMBackend } from "./llm/base.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { SessionStore } from "./sessions/types.js";

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
  tools: ToolRegistry;
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

const APPROVED_COMMAND_BRAND: unique symbol = Symbol("blue_tanuki.executor.approved_command.v1");

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

export type ApprovedCommand = ExecuteCommand & {
  readonly [APPROVED_COMMAND_BRAND]: ExecutorApprovalProof;
};

export function approveCommandForExecution(
  command: ExecuteCommand,
  proof: ExecutorApprovalProof,
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
    value: { ...proof },
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

  async execute(cmd: ApprovedCommand): Promise<ExecuteFeedback> {
    const start = Date.now();
    try {
      this.assertExecutionApproved(cmd);
      switch (cmd.type) {
        case "llm_call":
          return await this.executeLLMCall(cmd.id, cmd.payload, cmd.constraints, start);
        case "tool_call":
          return await this.executeToolCall(cmd.id, cmd.payload, cmd.constraints, start, cmd.upstream_decision.commit_hash);
        case "channel_send":
          return await this.executeChannelSend(cmd.id, cmd.payload, start, cmd.upstream_decision.commit_hash);
        case "noop":
          return {
            command_id: cmd.id,
            status: "success",
            result: null,
            metrics: { duration_ms: Date.now() - start },
          };
      }
    } catch (e) {
      return {
        command_id: cmd.id,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        metrics: { duration_ms: Date.now() - start },
      };
    }
  }

  private async executeLLMCall(
    id: string,
    payload: LLMCallPayload,
    constraints: ExecuteCommand["constraints"],
    start: number,
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
    if (session_store && session_id) {
      const history = await session_store.getMessages(session_id, {
        limit: this.deps.history_limit,
      });
      if (history.length > 0) {
        effectiveMessages = [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          ...payload.messages,
        ];
      }
    }

    const resp = await this.withTimeout(
      this.deps.llm.call({
        messages: effectiveMessages,
        backend_hint: payload.backend_hint,
        model: payload.model,
        temperature: payload.temperature,
        max_tokens: constraints?.max_tokens,
        timeout_ms: constraints?.timeout_ms,
      }),
      constraints?.timeout_ms,
    );

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
      await session_store.append(session_id, {
        role: "assistant",
        content: resp.content,
        timestamp: Date.now(),
      });
    }

    return {
      command_id: id,
      status: "success",
      result: resp,
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

    const result = await this.withTimeout(
      tool.invoke(payload.arguments, {
        command_id: id,
        upstream_commit_hash: commit_hash,
      }),
      constraints?.timeout_ms,
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

  private async withTimeout<T>(p: Promise<T>, timeout_ms: number | undefined): Promise<T> {
    if (!timeout_ms) return p;
    return await Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeout_ms}ms`)), timeout_ms),
      ),
    ]);
  }

  private assertExecutionApproved(cmd: ApprovedCommand): void {
    const proof = approvalProofFromCommand(cmd);
    if (!proof) {
      throw new Error("Executor rejected unapproved command: ApprovedCommand proof is required");
    }
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
  }
}

function approvalProofFromCommand(command: ExecuteCommand): ExecutorApprovalProof | null {
  const proof = (command as { [APPROVED_COMMAND_BRAND]?: ExecutorApprovalProof })[APPROVED_COMMAND_BRAND];
  return proof ?? null;
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
