import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExecutionIntentTicket, ExecutionIntentReceipt, ExecutionInvocationBoundary, ExecutionWorkerIdentity,
  ExecutorApprovalOptions, ExecutorApprovalClock, ExecutionIntentStore } from "./execution_intent.js";
import {
  BOUNDARY_EXCHANGE_SCHEMA_VERSION,
  BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION,
  canonicalFileSearchTargetVersionObservation,
  FileWriteTargetVersionObservationSchema,
  fileWritePayloadDigest,
  fileWriteTargetIdentityDigest,
  FileSearchTargetVersionObservationSchema,
  GmailWriteTargetVersionObservationSchema,
  parseBoundaryExchangeAtBoundary,
  inspectExecutionResultDelivery,
} from "@blue-tanuki/protocol";
import { approvalContextFromCommand, consumeHdsExecutionAuthorityBinding, finalReviewRequired, operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { ApprovalOperation, ApprovalRisk, HDSExecutionAuthorityBinding } from "@blue-tanuki/hds-brain";
import type {
  ExecuteCommand,
  ExecuteFeedback,
  FileSearchTargetVersionObservation,
  LLMCallFailure,
  LLMCallPayload,
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
import type { BrokerTargetVersionObservation, GmailDraftContentReview, ToolRegistry } from "./tools/registry.js";
import { fileSearchTool, fileWriteTool, gmailWriteTool } from "./tools/builtin.js";
import { gmailDraftSendRequestPayloadDigest, gmailWriteRequestPayloadDigest,
  gmailWriteTargetIdentityDigest } from "./tools/google_write.js";
import type { SessionStore } from "./sessions/types.js";
import {
  buildOperationCoreExecutorTrace,
  captureOperationCommandObservation,
  buildOperationCommandExecutionResult,
  type OperationExecutionBoundary,
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
  /** Gatewayの組込みfile.searchだけを固定workerへ送る。省略はcore開発用。 */
  file_search_worker?: FileSearchWorker;
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

export interface FileSearchWorkerRequest {
  command: Extract<ExecuteCommand, { type: "tool_call" }>;
  target_version_observation: FileSearchTargetVersionObservation;
  ticket: Readonly<ExecutionIntentTicket>;
  signal?: AbortSignal;
  on_started(worker: Readonly<ExecutionWorkerIdentity>): void;
  before_dispatch(): void;
  on_exit(worker: Readonly<ExecutionWorkerIdentity>, observed_at_ms: number): void;
}
export interface FileSearchWorker { invoke(request: FileSearchWorkerRequest): Promise<unknown>; }

export interface ExecutorExecutionContext {
  /** Caller cancellation for the current LLM request. */
  signal?: AbortSignal;
  /** worker起動待ち後にもGatewayの現在停止条件を同期検査する。 */
  before_tool_dispatch?: () => void;
  /** Gatewayの永続J bindingがあるtool adapter結果だけ、私有outboxへ渡す。 */
  save_result_delivery?: boolean;
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
  operation: ApprovalOperation;
  risk: ApprovalRisk;
  final_review_required: boolean;
  reason: string;
}

interface ApprovedCommandRecord {
  proof: Readonly<ExecutorApprovalProof>;
  authority_id: symbol;
  command_digest: string;
  consumed: boolean;
  ticket: Readonly<ExecutionIntentTicket>;
  issued_monotonic_ms: number;
  runtime: ApprovalRuntime;
  target_version_observation?: BrokerTargetVersionObservation;
}

interface ApprovalRuntime {
  authority_id: symbol;
  execution_epoch: string;
  assert_execution_owner?: () => void;
  clock: ExecutorApprovalClock;
  ttl_ms: number;
  require_hds_execution_binding: boolean;
  last_wall_ms: number;
  last_monotonic_ms: number;
  store?: ExecutionIntentStore;
}

// 権限記録をreflection可能なpropertyや直列化commandへ載せない。
const APPROVED_COMMAND_RECORDS = new WeakMap<ExecuteCommand, ApprovedCommandRecord>();

export type ApprovedCommand = ExecuteCommand & {
  readonly [APPROVED_COMMAND_BRAND]: ApprovedCommandRecord;
};

export interface ExecutorApprovalAuthority {
  approve(command: ExecuteCommand, proof: ExecutorApprovalProof, expected_command_digest?: string,
    hds_binding?: HDSExecutionAuthorityBinding, target_version_observation?: BrokerTargetVersionObservation): ApprovedCommand;
  /** 再照会は実行しない。未完の消費は結果不明として表示する。 */
  receipt(command: ApprovedCommand): ExecutionIntentReceipt | null;
}

export function createExecutorApprovalAuthority(options: ExecutorApprovalOptions = {}): ExecutorApprovalAuthority {
  const authorityId = Symbol("blue_tanuki.executor.approval_authority.instance");
  const ttl_ms = options.ticket_ttl_ms ?? 300_000;
  if (!Number.isSafeInteger(ttl_ms) || ttl_ms <= 0 || ttl_ms > 600_000) throw new Error("Executor ticket TTL is invalid");
  const execution_epoch = options.execution_epoch ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(execution_epoch)) throw new Error("Executor execution epoch is invalid");
  const runtime: ApprovalRuntime = { authority_id: authorityId, execution_epoch,
    assert_execution_owner: options.assert_execution_owner,
    clock: options.clock ?? { wallNow: Date.now, monotonicNow: () => performance.now() }, ttl_ms,
    require_hds_execution_binding: options.require_hds_execution_binding ?? false,
    last_wall_ms: 0, last_monotonic_ms: 0, store: options.execution_store };
  readApprovalClock(runtime);
  const authority = Object.freeze({
    approve(command: ExecuteCommand, proof: ExecutorApprovalProof, expected_command_digest?: string,
      hds_binding?: HDSExecutionAuthorityBinding, target_version_observation?: BrokerTargetVersionObservation): ApprovedCommand {
      return approveCommandForExecution(command, proof, runtime, expected_command_digest, hds_binding, target_version_observation);
    },
    receipt(command: ApprovedCommand): ExecutionIntentReceipt | null {
      const record = APPROVED_COMMAND_RECORDS.get(command);
      if (!record || record.authority_id !== authorityId) return null;
      const receipt = runtime.store?.lookup(record.ticket.ticket_id) ?? null;
      if (!receipt) return null;
      return Object.freeze({ ...receipt, state: receipt.state === "intent_committed" || receipt.state === "invocation_attempted"
        ? "outcome_unknown" : receipt.state });
    },
  });
  APPROVAL_AUTHORITY_IDS.set(authority, authorityId);
  return authority;
}

function approveCommandForExecution(
  command: ExecuteCommand,
  inputProof: ExecutorApprovalProof,
  runtime: ApprovalRuntime,
  expected_command_digest?: string,
  hds_binding?: HDSExecutionAuthorityBinding,
  rawTargetVersionObservation?: BrokerTargetVersionObservation,
): ApprovedCommand {
  runtime.assert_execution_owner?.();
  const snapshot = approvalCommandSnapshot(command);
  // 宣言済みのproof値を一度だけ捕捉し、保存digestと実行検査へ同じ値を渡す。
  const proof = Object.freeze({ source: inputProof.source, decision: inputProof.decision,
    approved_by: inputProof.approved_by, approved_at_ms: inputProof.approved_at_ms,
    upstream_commit_hash: inputProof.upstream_commit_hash, operation: inputProof.operation,
    risk: inputProof.risk, final_review_required: inputProof.final_review_required, reason: inputProof.reason });
  if (proof.upstream_commit_hash !== snapshot.upstream_decision.commit_hash) {
    throw new Error("approval proof commit hash does not match command upstream decision");
  }
  if (snapshot.upstream_decision.commit_decision !== "ASSERT") {
    throw new Error(`approval proof cannot execute upstream decision ${snapshot.upstream_decision.commit_decision}`);
  }
  if (!proof.approved_by.trim()) {
    throw new Error("approval proof approved_by is required");
  }
  if (!Number.isFinite(proof.approved_at_ms) || proof.approved_at_ms <= 0) {
    throw new Error("approval proof approved_at_ms must be a positive timestamp");
  }
  assertApprovalProofMatchesHdsPolicy(snapshot, proof);
  const command_digest = executorCommandDigest(snapshot);
  if (expected_command_digest !== undefined && expected_command_digest !== command_digest) {
    throw new Error("Executor approval rejected: reviewed command content changed");
  }
  let target_version_observation: BrokerTargetVersionObservation | undefined;
  if (rawTargetVersionObservation !== undefined) {
    if (snapshot.type !== "tool_call") {
      throw new Error("Executor approval rejected: target version evidence is only valid for a tool command");
    }
    if (snapshot.payload.tool_name === "file.search") {
      const observation = FileSearchTargetVersionObservationSchema.parse(rawTargetVersionObservation);
      const requestedRoot = snapshot.payload.arguments.root;
      if (typeof requestedRoot !== "string" || observation.requested_root_digest !==
          createHash("sha256").update(requestedRoot, "utf8").digest("hex")) {
        throw new Error("Executor approval rejected: file.search target version does not match command");
      }
      target_version_observation = Object.freeze(observation);
    } else if (snapshot.payload.tool_name === "file.write") {
      const observation = FileWriteTargetVersionObservationSchema.parse(rawTargetVersionObservation);
      const args = snapshot.payload.arguments;
      if (!hds_binding?.operation_plan_binding_digest || args.mode !== "create" ||
          typeof args.path !== "string" || typeof args.content !== "string" ||
          Object.keys(args).some((key) => !["path", "content", "mode", "max_bytes"].includes(key)) ||
          observation.command_digest !== operationPlanDigest(snapshot) ||
          observation.operation_plan_binding_digest !== hds_binding.operation_plan_binding_digest ||
          observation.target_identity_digest !== fileWriteTargetIdentityDigest(args.path) ||
          observation.payload_digest !== fileWritePayloadDigest(args.content)) {
        throw new Error("Executor approval rejected: file.write target version does not match command or plan source");
      }
      target_version_observation = Object.freeze(observation);
    } else if (snapshot.payload.tool_name === "gmail.write" &&
        ["draft.create", "message.send", "draft.send"].includes(String(snapshot.payload.arguments.operation))) {
      const observation = GmailWriteTargetVersionObservationSchema.parse(rawTargetVersionObservation);
      const operation = String(snapshot.payload.arguments.operation);
      const payloadMismatch = operation === "draft.send"
        ? !observation.provider_state_digest || !observation.provider_raw_digest ||
          observation.request_payload_digest !== gmailDraftSendRequestPayloadDigest(
            snapshot.payload.arguments, observation.provider_raw_digest)
        : observation.request_payload_digest !== gmailWriteRequestPayloadDigest(snapshot.payload.arguments);
      if (observation.command_digest !== operationPlanDigest(snapshot) ||
          observation.target_identity_digest !== gmailWriteTargetIdentityDigest(snapshot.payload.arguments) ||
          payloadMismatch) {
        throw new Error("Executor approval rejected: gmail.write target version does not match command");
      }
      target_version_observation = Object.freeze(observation);
    } else {
      throw new Error("Executor approval rejected: target version evidence is unsupported for this tool command");
    }
  }
  const target_version_observation_digest = target_version_observation
    ? operationPlanDigest(target_version_observation) : undefined;
  if (hds_binding && hds_binding.broker_target_version_observation_digest !== target_version_observation_digest) {
    throw new Error("Executor approval rejected: HDS target version binding does not match evidence");
  }
  if (snapshot.type === "tool_call" && snapshot.payload.tool_name === "gmail.write" &&
      ["draft.create", "message.send", "draft.send"].includes(String(snapshot.payload.arguments.operation)) &&
      target_version_observation?.schema_version !== "blue-tanuki.gmail-write-target-version.v1") {
    throw new Error("Executor approval rejected: gmail.write target version evidence is required");
  }
  if (runtime.require_hds_execution_binding && snapshot.type === "tool_call" && snapshot.payload.tool_name === "file.search" &&
      target_version_observation?.schema_version !== "blue-tanuki.file-search-target-version.v1") {
    throw new Error("Executor approval rejected: file.search target version evidence is required");
  }
  if (snapshot.type === "tool_call" && snapshot.payload.tool_name === "file.write" &&
      hds_binding?.operation_plan_binding_digest &&
      target_version_observation?.schema_version !== "blue-tanuki.file-write-target-version.v1") {
    throw new Error("Executor approval rejected: planned file.write target version evidence is required");
  }
  if (!hds_binding && runtime.require_hds_execution_binding) {
    throw new Error("Executor approval rejected: HDS execution authority binding is required");
  }
  const hds_source_context_digest = hds_binding
    ? consumeHdsExecutionAuthorityBinding(command, hds_binding)
    : null;
  const approved = snapshot as ApprovedCommand;
  const clock = readApprovalClock(runtime);
  const ticket: Readonly<ExecutionIntentTicket> = Object.freeze({
    ticket_id: randomUUID(), execution_epoch: runtime.execution_epoch,
    command_key: createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", snapshot.id])).digest("hex"),
    command_digest,
    proof_digest: createHash("sha256").update(JSON.stringify({
      schema_version: "blue-tanuki.executor-authority-content-binding.v3",
      command_digest,
      proof,
      hds_source_context_digest,
      ...(target_version_observation_digest ? { target_version_observation_digest } : {}),
    })).digest("hex"),
    issued_at_ms: clock.wall, expires_at_ms: clock.wall + runtime.ttl_ms,
  });
  runtime.store?.issue(ticket);
  APPROVED_COMMAND_RECORDS.set(approved, {
    proof, authority_id: runtime.authority_id, command_digest, consumed: false,
    ticket, issued_monotonic_ms: clock.monotonic, runtime,
    ...(target_version_observation ? { target_version_observation } : {}),
  });
  freezeApprovalContent(approved);
  return approved;
}

function readApprovalClock(runtime: ApprovalRuntime): { wall: number; monotonic: number } {
  const wall = runtime.clock.wallNow(); const monotonic = runtime.clock.monotonicNow();
  if (!Number.isSafeInteger(wall) || wall <= 0 || !Number.isFinite(monotonic) || monotonic < 0 ||
      wall < runtime.last_wall_ms || monotonic < runtime.last_monotonic_ms) {
    throw new Error("Executor rejected command: approval clock invalid or rolled back");
  }
  runtime.last_wall_ms = wall; runtime.last_monotonic_ms = monotonic;
  return { wall, monotonic };
}

function assertTicketCurrent(record: ApprovedCommandRecord): number {
  const now = readApprovalClock(record.runtime);
  if (record.ticket.execution_epoch !== record.runtime.execution_epoch || now.wall >= record.ticket.expires_at_ms ||
      now.monotonic - record.issued_monotonic_ms >= record.runtime.ttl_ms) {
    throw new Error("Executor rejected command: approval ticket expired or epoch changed");
  }
  return now.wall;
}

/** 内容の同一性だけを示す。digestは発行者を認証せず、権限を付与しない。 */
export function executorCommandDigest(command: ExecuteCommand): string {
  const content = approvalCommandSnapshot(command);
  const boundary = parseBoundaryExchangeAtBoundary(new TextEncoder().encode(JSON.stringify({
    schema_version: BOUNDARY_EXCHANGE_SCHEMA_VERSION,
    canonicalization_version: BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION,
    issued_at_utc: "1970-01-01T00:00:00.000Z",
    // 既存交換profileは整数tokenだけを許す。全値をJSON種別付きで表現し、
    // 小数を正確に固定しつつ、似たobjectや文字列との衝突を防ぐ。
    content: { profile: "executor-command-content.v1", command: approvalDigestValue(content) },
  })));
  if (!boundary.ok) throw new Error("Executor approval rejected: command content is not canonical JSON");
  return createHash("sha256").update(boundary.canonical_bytes).digest("hex");
}

function approvalDigestValue(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "number") return ["number", JSON.stringify(value)];
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  if (Array.isArray(value)) return ["array", value.map(approvalDigestValue)];
  const fields = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, approvalDigestValue(child)]));
  return ["object", fields];
}

/** HDS発行objectの内部plan対応を維持しながら内容を固定する。 */
export function captureExecutorCommandForApproval(command: ExecuteCommand): { command: ExecuteCommand; command_digest: string } {
  const snapshot = approvalCommandSnapshot(command);
  const command_digest = executorCommandDigest(snapshot);
  freezeApprovalContent(command);
  return Object.freeze({ command, command_digest });
}

function approvalCommandSnapshot(command: ExecuteCommand): ExecuteCommand {
  // 直列化前にdescriptorを検査する。JSON.stringifyだけでは非JSON値を
  // 黙って変更し、下流objectのgetterやtoJSONを呼び出してしまう。
  const optionalUndefinedFields = new Set([
    "constraints", "constraints.max_tokens", "constraints.timeout_ms", "constraints.allowed_tools", "constraints.allowed_capabilities",
    "upstream_decision.request_id", "payload.backend_hint", "payload.model", "payload.temperature", "payload.compute_context", "payload.session_id",
    "payload.compute_context.fallback_authorization",
  ]);
  const visit = (value: unknown, depth: number, path: string[] = []): unknown => {
    if (depth > 64) throw new Error("Executor approval rejected: command content is not canonical JSON");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    if (!value || typeof value !== "object" ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error("Executor approval rejected: command content is not canonical JSON");
    }
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Executor approval rejected: command content is not canonical JSON");
    if (Object.getOwnPropertyNames(value).some((key) => !(Array.isArray(value) && key === "length") && !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
      throw new Error("Executor approval rejected: command content is not canonical JSON");
    }
    if (Array.isArray(value) && Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error("Executor approval rejected: command content is not canonical JSON");
    }
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Executor approval rejected: command content is not canonical JSON");
      const nextPath = [...path, key];
      if (descriptor.value === undefined && !Array.isArray(value) && !nextPath.some((part) => part.includes(".")) &&
          optionalUndefinedFields.has(nextPath.join("."))) continue;
      Object.defineProperty(out, key, { value: visit(descriptor.value, depth + 1, nextPath), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return visit(command, 0) as ExecuteCommand;
}

function freezeApprovalContent(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeApprovalContent(child);
  Object.freeze(value);
}

function stripFileSearchTargetVersionObservation(value: unknown, expected: FileSearchTargetVersionObservation): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      canonicalFileSearchTargetVersionObservation((value as Record<string, unknown>).target_version_observation) !==
        canonicalFileSearchTargetVersionObservation(expected)) {
    throw new Error("file.search result target version does not match approved evidence");
  }
  const publicResult = { ...(value as Record<string, unknown>) };
  delete publicResult.target_version_observation;
  return publicResult;
}

function readFileSearchWorkerResult(value: unknown, expected: FileSearchTargetVersionObservation): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      canonicalFileSearchTargetVersionObservation((value as Record<string, unknown>).target_version_observation) !==
        canonicalFileSearchTargetVersionObservation(expected) || !Object.hasOwn(value, "result")) {
    throw new Error("file.search worker target version does not match approved evidence");
  }
  return (value as Record<string, unknown>).result;
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

  /** Read-only preflight for exact registered built-in target resolvers. */
  async inspectCommandTargetVersion(command: ExecuteCommand,
    env?: Readonly<Record<string, string | undefined>>,
    operationPlanBindingDigest?: string): Promise<BrokerTargetVersionObservation | undefined> {
    if (command.type !== "tool_call") return undefined;
    if (operationPlanBindingDigest !== undefined && !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
      throw new Error("Broker target version resolver received an invalid operation plan binding");
    }
    if (command.payload.tool_name === "gmail.write" &&
        ["draft.create", "message.send", "draft.send"].includes(String(command.payload.arguments.operation))) {
      const tool = this.deps.tools.get("gmail.write");
      if (tool !== gmailWriteTool || !tool.inspect_target_version) {
        throw new Error("gmail.write target version resolver requires the registered built-in adapter");
      }
      const observation = GmailWriteTargetVersionObservationSchema.parse(
        await tool.inspect_target_version(command.payload.arguments, {
          ...(env ? { env } : {}),
          ...(operationPlanBindingDigest ? { operation_plan_binding_digest: operationPlanBindingDigest } : {}),
          command_digest: operationPlanDigest(command),
        }),
      );
      const operation = String(command.payload.arguments.operation);
      const payloadMismatch = operation === "draft.send"
        ? !observation.provider_state_digest || !observation.provider_raw_digest ||
          observation.request_payload_digest !== gmailDraftSendRequestPayloadDigest(
            command.payload.arguments, observation.provider_raw_digest)
        : observation.request_payload_digest !== gmailWriteRequestPayloadDigest(command.payload.arguments);
      if (observation.command_digest !== operationPlanDigest(command) ||
          observation.target_identity_digest !== gmailWriteTargetIdentityDigest(command.payload.arguments) ||
          payloadMismatch ||
          observation.operation_plan_binding_digest !== operationPlanBindingDigest) {
        throw new Error("gmail.write target version resolver returned evidence for another command or plan source");
      }
      return Object.freeze(observation);
    }
    if (command.payload.tool_name === "file.write" && operationPlanBindingDigest !== undefined) {
      const tool = this.deps.tools.get("file.write");
      if (tool !== fileWriteTool || !tool.inspect_target_version) {
        throw new Error("file.write target version resolver requires the registered built-in adapter");
      }
      const observation = FileWriteTargetVersionObservationSchema.parse(
        await tool.inspect_target_version(command.payload.arguments, {
          ...(env ? { env } : {}),
          operation_plan_binding_digest: operationPlanBindingDigest,
          command_digest: operationPlanDigest(command),
        }),
      );
      if (command.payload.arguments.mode !== "create" || observation.command_digest !== operationPlanDigest(command) ||
          observation.target_identity_digest !== fileWriteTargetIdentityDigest(String(command.payload.arguments.path ?? "")) ||
          observation.payload_digest !== fileWritePayloadDigest(String(command.payload.arguments.content ?? "")) ||
          observation.operation_plan_binding_digest !== operationPlanBindingDigest) {
        throw new Error("file.write target version resolver returned evidence for another command or plan source");
      }
      return Object.freeze(observation);
    }
    if (command.payload.tool_name !== "file.search") return undefined;
    const tool = this.deps.tools.get("file.search");
    if (tool !== fileSearchTool || !tool.inspect_target_version) {
      throw new Error("file.search target version resolver requires the registered built-in adapter");
    }
    const observation = FileSearchTargetVersionObservationSchema.parse(
      await tool.inspect_target_version(command.payload.arguments, {
        ...(env ? { env } : {}),
        ...(operationPlanBindingDigest ? { operation_plan_binding_digest: operationPlanBindingDigest } : {}),
      }),
    );
    const requestedRoot = command.payload.arguments.root;
    if (typeof requestedRoot !== "string" || observation.requested_root_digest !==
        createHash("sha256").update(requestedRoot, "utf8").digest("hex")) {
      throw new Error("file.search target version resolver returned evidence for another command");
    }
    if (observation.operation_plan_binding_digest !== operationPlanBindingDigest) {
      throw new Error("file.search target version resolver returned evidence for another operation plan source");
    }
    return Object.freeze(observation);
  }

  /** Exact content projection for an existing draft; only the registered Gmail adapter may provide it. */
  async inspectCommandContentReview(command: ExecuteCommand,
    env?: Readonly<Record<string, string | undefined>>): Promise<GmailDraftContentReview | undefined> {
    if (command.type !== "tool_call" || command.payload.tool_name !== "gmail.write" ||
        command.payload.arguments.operation !== "draft.send") return undefined;
    const tool = this.deps.tools.get("gmail.write");
    if (tool !== gmailWriteTool || !tool.inspect_content_review) {
      throw new Error("gmail.write content review requires the registered built-in adapter");
    }
    return await tool.inspect_content_review(command.payload.arguments, env ? { env } : undefined);
  }

  async execute(cmd: ApprovedCommand, context: ExecutorExecutionContext = {}): Promise<ExecuteFeedback> {
    const start = Date.now();
    let proof: ExecutorApprovalProof | undefined;
    let observation: ReturnType<typeof captureOperationCommandObservation>;
    const execution = { boundary: "not_invoked" as OperationExecutionBoundary };
    let invocation: ExecutionInvocationBoundary | undefined;
    const markInvoked = (boundary: ExecutionInvocationBoundary): void => {
      const record = APPROVED_COMMAND_RECORDS.get(cmd)!;
      record.runtime.assert_execution_owner?.();
      const now = assertTicketCurrent(record);
      record.runtime.store?.markInvocation(record.ticket, boundary, now);
      invocation = boundary;
      if (boundary !== "llm_adapter") execution.boundary = boundary;
    };
    let feedback: ExecuteFeedback;
    try {
      proof = this.assertExecutionApproved(cmd);
      observation = captureOperationCommandObservation(cmd);
      switch (cmd.type) {
        case "llm_call":
          feedback = await this.executeLLMCall(cmd.id, cmd.payload, cmd.constraints, start, context.signal, markInvoked);
          break;
        case "tool_call":
          feedback = await this.executeToolCall(cmd, start, markInvoked, context.signal, context.before_tool_dispatch);
          break;
        case "channel_send":
          feedback = await this.executeChannelSend(cmd.id, cmd.payload, start, cmd.upstream_decision.commit_hash, markInvoked);
          break;
        case "noop":
          {
            const error = safeNoopFailure(cmd.payload);
            feedback = error
              ? {
                  command_id: cmd.id,
                  status: "failed",
                  error,
                  metrics: { duration_ms: Date.now() - start },
                }
              : {
                  command_id: cmd.id,
                  status: "success",
                  result: null,
                  metrics: { duration_ms: Date.now() - start },
                };
          }
          break;
      }
      feedback = attachOperationCoreTrace(cmd, feedback, proof, observation, execution.boundary);
    } catch (e) {
      feedback = {
        command_id: cmd.id,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        metrics: { duration_ms: Date.now() - start },
      };
      if (proof) feedback = attachOperationCoreTrace(cmd, feedback, proof, observation, execution.boundary);
    }
    if (proof) {
      const record = APPROVED_COMMAND_RECORDS.get(cmd)!;
      try {
        record.runtime.assert_execution_owner?.();
        record.runtime.store?.complete(record.ticket, {
          state: !invocation ? "not_attempted" : feedback.status === "success" ? "adapter_returned" : "outcome_unknown",
          feedback_status: feedback.status, observed_at_ms: feedback.operation_core_result?.observed_at_ms ?? Date.now(),
          output_digest: feedback.operation_core_result?.output_digest,
          error_digest: feedback.error ? createHash("sha256").update(feedback.error).digest("hex") : undefined,
        }, context.save_result_delivery && cmd.type === "tool_call" && feedback.operation_core_result
          ? inspectExecutionResultDelivery({
              profile: cmd.payload.tool_name === "file.search" && this.deps.file_search_worker
                ? "file-search-result-delivery.v1" : "tool-adapter-result-delivery.v1",
              admission: { ...record.ticket },
              feedback: { command_id: feedback.command_id, status: feedback.status,
                ...(feedback.result === undefined ? {} : { result: feedback.result }),
                metrics: { duration_ms: feedback.metrics.duration_ms }, operation_core_result: feedback.operation_core_result },
            })
          : undefined);
      } catch {
        // 保存失敗は成功へ変換しない。同じ承認の再作用も許可しない。
        feedback = attachOperationCoreTrace(cmd, { command_id: cmd.id, status: "failed",
          error: "Executor receipt persistence failed; execution outcome requires inspection",
          metrics: { duration_ms: Date.now() - start } }, proof, observation, execution.boundary);
      }
    }
    return feedback;
  }

  private async executeLLMCall(
    id: string,
    payload: LLMCallPayload,
    constraints: ExecuteCommand["constraints"],
    start: number,
    callerSignal?: AbortSignal,
    markInvoked?: (boundary: ExecutionInvocationBoundary) => void,
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
            const request = buildComputeRequest({
              request_id: id,
              context: payload.compute_context,
              provider_request: providerRequest,
              max_tokens: constraints?.max_tokens,
              timeout_ms: constraints?.timeout_ms,
              session_history_applied: sessionHistoryApplied,
            });
            markInvoked?.("llm_adapter");
            return this.deps.compute.compute(request, signal);
          }
          markInvoked?.("llm_adapter");
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

    const meaningUpdateProposalPresent = Object.prototype.hasOwnProperty.call(
      resp,
      "meaning_update_proposal",
    );
    const meaningUpdateProposal = meaningUpdateProposalPresent
      ? resp.meaning_update_proposal
      : undefined;
    if (meaningUpdateProposalPresent) {
      const safeResponse = { ...resp };
      delete safeResponse.meaning_update_proposal;
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
      ...(meaningUpdateProposalPresent ? { meaning_update_proposal: meaningUpdateProposal } : {}),
      metrics: {
        duration_ms: Date.now() - start,
        tokens_used: resp.tokens_used,
      },
    };
  }

  private async executeToolCall(
    command: Extract<ExecuteCommand, { type: "tool_call" }>,
    start: number,
    markInvoked: (boundary: ExecutionInvocationBoundary) => void,
    signal?: AbortSignal,
    before_tool_dispatch?: () => void,
  ): Promise<ExecuteFeedback> {
    const { id, payload, constraints } = command;
    const commit_hash = command.upstream_decision.commit_hash;
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

    if (payload.tool_name === "file.search" && this.deps.file_search_worker) {
      if (tool !== fileSearchTool) throw new Error("File search worker requires the registered built-in adapter");
      const record = APPROVED_COMMAND_RECORDS.get(command)!;
      if (record.target_version_observation?.schema_version !== "blue-tanuki.file-search-target-version.v1") {
        throw new Error("File search worker requires bound target version evidence");
      }
      const store = record.runtime.store;
      if (!store?.bindWorker || !store.observeWorkerExit) throw new Error("File search worker requires durable worker receipts");
      let worker: Readonly<ExecutionWorkerIdentity> | undefined;
      let dispatched = false; let exited = false;
      const workerResponse = await this.deps.file_search_worker.invoke({ command, target_version_observation: record.target_version_observation,
        ticket: record.ticket, signal,
        on_started: (identity) => {
          if (worker || exited) throw new Error("File search worker start repeated");
          record.runtime.assert_execution_owner?.();
          const now = assertTicketCurrent(record);
          const captured = Object.freeze({ worker_id: identity.worker_id, worker_pid: identity.worker_pid,
            worker_platform: identity.worker_platform, worker_started_at_ms: identity.worker_started_at_ms });
          store.bindWorker!(record.ticket, captured, now);
          worker = captured;
        },
        before_dispatch: () => {
          if (!worker || dispatched || exited || signal?.aborted) throw new Error("File search worker dispatch rejected");
          before_tool_dispatch?.();
          markInvoked("tool_adapter");
          // SQLite待機で期限を消費し得る。保存後、IPC送信前にも両clockを読む。
          assertTicketCurrent(record);
          record.runtime.assert_execution_owner?.();
          before_tool_dispatch?.();
          if (signal?.aborted) throw new Error("File search worker dispatch cancelled");
          dispatched = true;
        },
        on_exit: (identity, observed_at_ms) => {
          if (!worker || exited || Object.keys(worker).some((key) => worker![key as keyof ExecutionWorkerIdentity] !== identity[key as keyof ExecutionWorkerIdentity])) {
            throw new Error("File search worker exit identity mismatch");
          }
          record.runtime.assert_execution_owner?.();
          store.observeWorkerExit!(record.ticket, worker, observed_at_ms);
          exited = true;
        },
      });
      if (!worker || !dispatched || !exited) throw new Error("File search worker lifecycle incomplete");
      const result = readFileSearchWorkerResult(workerResponse, record.target_version_observation);
      return { command_id: id, status: "success", result, metrics: { duration_ms: Date.now() - start, tool_calls: 1 } };
    }
    const controller = new AbortController();
    markInvoked("tool_adapter");
    const result = await this.withTimeout(
      tool.invoke(payload.arguments, {
        command_id: id,
        upstream_commit_hash: commit_hash,
        idempotency_key: APPROVED_COMMAND_RECORDS.get(command)!.ticket.command_key,
        command_digest: APPROVED_COMMAND_RECORDS.get(command)!.ticket.command_digest,
        target_version_observation: APPROVED_COMMAND_RECORDS.get(command)!.target_version_observation,
        signal: controller.signal,
      }),
      constraints?.timeout_ms,
      controller,
    );
    const targetVersion = APPROVED_COMMAND_RECORDS.get(command)!.target_version_observation;
    const publicResult = targetVersion?.schema_version === "blue-tanuki.file-search-target-version.v1"
      ? stripFileSearchTargetVersionObservation(result, targetVersion) : result;
    return {
      command_id: id,
      status: "success",
      result: publicResult,
      metrics: { duration_ms: Date.now() - start, tool_calls: 1 },
    };
  }

  private async executeChannelSend(
    id: string,
    payload: ChannelSendPayload,
    start: number,
    commit_hash: string,
    markInvoked: (boundary: ExecutionInvocationBoundary) => void,
  ): Promise<ExecuteFeedback> {
    if (this.deps.dispatcher) {
      markInvoked("channel_adapter");
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
    markInvoked("console_preview");
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
    record.runtime.assert_execution_owner?.();
    if (record.authority_id !== authorityIdFor(this.deps.approval_authority)) {
      throw new Error("Executor rejected command: approval authority mismatch");
    }
    if (record.consumed) throw new Error("Executor rejected command: approval already consumed");
    if (record.command_digest !== executorCommandDigest(cmd)) {
      throw new Error("Executor rejected command: approved command content changed");
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
    assertApprovalProofMatchesHdsPolicy(cmd, proof);
    // adapter/historyのawait前に同期消費する。失敗でも承認を復活させず、
    // 次の試行には新しい上流採否を必要とする。
    const now = assertTicketCurrent(record);
    record.consumed = true;
    record.runtime.store?.consume(record.ticket, now);
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

function safeNoopFailure(payload: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(payload, "reason")) return undefined;
  const reason = payload.reason;
  if (typeof reason === "string" && reason.trim().startsWith("unsupported tool:")) {
    return "unsupported tool; no tool was executed";
  }
  return "operation could not be routed; no tool was executed";
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
  observation: ReturnType<typeof captureOperationCommandObservation>,
  execution_boundary: OperationExecutionBoundary,
): ExecuteFeedback {
  const result = buildOperationCommandExecutionResult(observation, feedback, execution_boundary);
  return {
    ...feedback,
    operation_core: buildOperationCoreExecutorTrace(command, feedback.status, proof),
    ...(result ? { operation_core_result: result } : {}),
  };
}

function approvalProofFromCommand(command: ExecuteCommand): ApprovedCommandRecord | null {
  return APPROVED_COMMAND_RECORDS.get(command) ?? null;
}

function authorityIdFor(authority: ExecutorApprovalAuthority): symbol {
  const id = APPROVAL_AUTHORITY_IDS.get(authority);
  if (!id) {
    throw new Error("Executor approval authority was not created by createExecutorApprovalAuthority");
  }
  return id;
}

function assertApprovalProofMatchesHdsPolicy(
  command: ExecuteCommand,
  proof: Readonly<ExecutorApprovalProof>,
): void {
  if (proof.source !== "approval_gate" && proof.source !== "human_final_review") {
    throw new Error("Executor rejected approval proof: proof source is invalid");
  }
  const context = approvalContextFromCommand(command);
  const final_review_required = finalReviewRequired(context);
  if (proof.operation !== context.operation) {
    throw new Error("Executor rejected approval proof: operation does not match HDS command classification");
  }
  if (proof.risk !== context.risk) {
    throw new Error("Executor rejected approval proof: risk does not match HDS command classification");
  }
  if (proof.final_review_required !== final_review_required) {
    throw new Error("Executor rejected approval proof: final-review status does not match HDS command classification");
  }
  if ((proof.source === "approval_gate" && proof.decision !== "allow") ||
      (proof.source === "human_final_review" && proof.decision !== "approve")) {
    throw new Error("Executor rejected approval proof: decision does not match proof source");
  }
  if (final_review_required && proof.source !== "human_final_review") {
    throw new Error(
      `Executor rejected high-risk command ${commandOperationLabel(command)}: human final-review proof is required`,
    );
  }
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
    ...(context.fallback_authorization
      ? { fallback_authorization: context.fallback_authorization }
      : {}),
    resource_limits: {
      ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
      ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    },
    input: input.provider_request,
  };
}
