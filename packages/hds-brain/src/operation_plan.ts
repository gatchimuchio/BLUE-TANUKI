import { createHash } from "node:crypto";
import {
  getOperationDescriptor, inspectOperationCommandExecutionResult,
  OperationJsonValueSchema, OperationPlanCheckpointSchema, OperationPlanSchema, prepareOperationPlan,
  type ExecuteCommand, type ExecuteFeedback, type InboundRequest, type OperationPlan,
  type OperationPlanCheckpoint, type OperationPlanControl, type OperationStep,
  ExecutionAdmissionSchema, inspectExecutionResultDelivery, type ExecutionAdmission, type ExecutionResultDelivery,
} from "@blue-tanuki/protocol";

type PlanState = OperationPlanCheckpoint["plans"][number];
type Binding = PlanState["bindings"][number];
/** 私有の回復状態。保存内容は現在の承認・実行権限ではない。 */
export interface OperationPlanStatePort {
  load(): unknown | null;
  compareAndSet(expected_digest: string | null, checkpoint: OperationPlanCheckpoint): void;
}

export function operationPlanDigest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function stepDigest(step: OperationStep): string {
  const { state: _state, result_digest: _result, ...definition } = step;
  return operationPlanDigest(definition);
}
function commandPayloadDigest(command: ExecuteCommand): string {
  return createHash("sha256").update(JSON.stringify(command.payload)).digest("hex");
}
function freezeCommand(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeCommand((value as Record<PropertyKey, unknown>)[key], seen);
  if (!Object.isFrozen(value)) Object.freeze(value);
}
function candidatePlan(value: unknown): OperationPlan {
  const plan = OperationPlanSchema.parse(value);
  if (!["planned", "draft"].includes(plan.state) || plan.steps.some((s) =>
    !["planned", "draft"].includes(s.state) || s.result_digest !== undefined)) throw new Error("plan_claimed_execution_state");
  const inspected = prepareOperationPlan(plan, { now_ms: Date.now(), results: [], observations: [] });
  if (inspected.kind === "rejected") throw new Error(`plan_${inspected.code}`);
  return plan;
}

/** J所有の計画・版・単回試行。LLM、I/O作用、Approvalの代行は行わない。 */
export class OperationPlanLedger {
  private state: OperationPlanCheckpoint = { schema_version: "operation-plan-state.v1", plans: [] };
  private savedDigest: string | null = null;
  private readonly issuedBindings = new WeakMap<ExecuteCommand, string>();
  constructor(private readonly port?: OperationPlanStatePort) {
    const saved = port?.load();
    if (saved == null) return;
    this.state = OperationPlanCheckpointSchema.parse(saved);
    this.savedDigest = operationPlanDigest(this.state);
    const ids = new Set<string>();
    const commands = new Set<string>();
    const tickets = new Set<string>();
    for (const p of this.state.plans) {
      const first = p.revisions[0]!.plan;
      if (ids.has(first.plan_id)) throw new Error("plan_checkpoint_duplicate_identity");
      ids.add(first.plan_id);
      for (const revision of p.revisions) {
        candidatePlan(revision.plan);
        if (revision.digest !== operationPlanDigest(revision.plan) || revision.plan.plan_id !== first.plan_id ||
            revision.plan.request_id !== first.request_id) throw new Error("plan_checkpoint_revision_mismatch");
      }
      for (const b of p.bindings) {
        const revision = p.revisions.find((r) => r.digest === b.revision_digest);
        const step = revision?.plan.steps.find((s) => s.step_id === b.step_id);
        if (!step || stepDigest(step) !== b.step_digest || commands.has(b.command_id) ||
            b.prepared_step.step_id !== b.step_id || b.prepared_step.operation !== b.operation ||
            b.prepared_step.operation !== step.operation) throw new Error("plan_checkpoint_binding_mismatch");
        commands.add(b.command_id);
        if (b.execution_admission) {
          if (tickets.has(b.execution_admission.ticket_id) || b.execution_admission.command_key !==
              createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", b.command_id])).digest("hex") ||
              b.status === "selected" || b.status === "invalidated") throw new Error("plan_checkpoint_admission_mismatch");
          tickets.add(b.execution_admission.ticket_id);
        }
        if (b.delivery_digest && (!b.execution_admission || !b.result_digest)) throw new Error("plan_checkpoint_delivery_mismatch");
      }
      for (const result of p.results) {
        const binding = p.bindings.find((b) => b.step_id === result.step_id && b.status === "verified");
        if (!binding || result.plan_id !== first.plan_id || result.request_id !== first.request_id ||
            result.operation !== binding.operation || result.expires_at_ms !== result.observed_at_ms + 600_000 ||
            operationPlanDigest(result.target) !== operationPlanDigest(binding.prepared_step.target) ||
            !binding.prepared_step.preparation?.validation.length ||
            !binding.prepared_step.preparation.validation.every((v) => v.method === "result_equals" &&
              operationPlanDigest(v.target) === operationPlanDigest(result.target) &&
              operationPlanDigest(v.expected) === operationPlanDigest(result.output))) throw new Error("plan_checkpoint_result_mismatch");
      }
    }
    // 過去の承認は復活させない。開始意思があれば未起動と断定しない。
    this.change((state) => {
      for (const p of state.plans) for (const b of p.bindings) {
        if (b.status === "selected") b.status = "invalidated";
        if (b.status === "intent_committed") b.status = "outcome_unknown";
      }
    });
  }

  retainCandidate(value: unknown, origin: InboundRequest): void {
    const plan = candidatePlan(value);
    const expected = origin.metadata?.["blue_tanuki.operation_core.request_id"] ?? origin.id;
    if (plan.request_id !== expected || this.state.plans.some((p) => p.revisions[0]!.plan.plan_id === plan.plan_id)) {
      throw new Error("plan_source_binding_mismatch");
    }
    this.change((state) => state.plans.push({ owner: origin.user, channel: origin.channel, goal: origin.content,
      revisions: [{ digest: operationPlanDigest(plan), plan }], bindings: [], results: [] }));
  }

  inspectControl(control: OperationPlanControl, caller: InboundRequest): {
    plan_id: string; revision_digest: string; step?: OperationStep; goal: string;
  } {
    const p = this.ownedPlan(control.plan_id, caller);
    const current = p.revisions.at(-1)!;
    const expected = control.action === "review" ? control.revision_digest : control.expected_revision_digest;
    if (expected !== current.digest) throw new Error("plan_revision_changed");
    if (control.action === "revise") {
      this.revisionImpact(p, control.plan);
      return { plan_id: control.plan_id, revision_digest: expected, goal: p.goal };
    }
    const steps = current.plan.steps.filter((s) => s.step_id === control.step_id || operationPlanDigest(s.step_id) === control.step_id);
    if (steps.length !== 1) throw new Error("plan_step_identity_mismatch");
    const stepId = steps[0]!.step_id;
    if (p.bindings.some((b) => b.step_id === stepId && !["invalidated", "not_attempted"].includes(b.status))) {
      throw new Error("plan_step_already_selected_or_attempted");
    }
    const inspected = prepareOperationPlan(current.plan, { now_ms: Date.now(), results: p.results, observations: [] });
    if (inspected.kind === "rejected") throw new Error(`plan_${inspected.code}`);
    const step = inspected.plan.steps.find((s) => s.step_id === stepId);
    if (!step || inspected.summary.steps.find((s) => s.step_id === stepId)?.status !== "ready") throw new Error("plan_step_not_ready");
    // 対象resolverの実接続がある範囲だけ候補commandへ具体化する。
    if (step.operation !== "file.search" || step.target.kind !== "directory" || step.parameters?.root !== step.target.id) {
      throw new Error("plan_target_resolver_not_connected");
    }
    return { plan_id: current.plan.plan_id, revision_digest: expected, step, goal: p.goal };
  }

  bind(control: Extract<OperationPlanControl, { action: "review" }>, caller: InboundRequest, command: ExecuteCommand): void {
    const prepared = this.inspectControl(control, caller);
    const step = prepared.step!;
    const descriptor = getOperationDescriptor(step.operation)!;
    if (command.type !== "tool_call" || command.payload.tool_name !== descriptor.tool_name ||
        operationPlanDigest(command.payload.arguments) !== operationPlanDigest(step.parameters)) throw new Error("plan_command_content_changed");
    this.change((state) => {
      const p = state.plans.find((p) => p.revisions[0]!.plan.plan_id === prepared.plan_id)!;
      p.bindings.push({ step_id: step.step_id, revision_digest: prepared.revision_digest,
        step_digest: stepDigest(p.revisions.at(-1)!.plan.steps.find((s) => s.step_id === step.step_id)!),
        prepared_step: step,
        command_id: command.id, request_id: command.upstream_decision.request_id!,
        commit_hash: command.upstream_decision.commit_hash, payload_digest: commandPayloadDigest(command),
        command_digest: operationPlanDigest(command),
        operation: descriptor.operation_id, status: "selected" });
    });
    this.issuedBindings.set(command, command.id);
  }

  revise(control: Extract<OperationPlanControl, { action: "revise" }>, caller: InboundRequest): string[] {
    this.inspectControl(control, caller);
    const p = this.ownedPlan(control.plan_id, caller);
    const affected = this.revisionImpact(p, control.plan);
    const invalidated = p.bindings.filter((b) => b.status === "selected" && affected.has(b.step_id)).map((b) => b.command_id);
    this.change((state) => {
      const target = state.plans.find((entry) => entry.revisions[0]!.plan.plan_id === p.revisions[0]!.plan.plan_id)!;
      target.revisions.push({ digest: operationPlanDigest(control.plan), plan: candidatePlan(control.plan) });
      for (const b of target.bindings) if (invalidated.includes(b.command_id)) b.status = "invalidated";
    });
    return invalidated;
  }

  isBound(command_id: string): boolean { return this.binding(command_id) !== undefined; }
  canExecute(command: ExecuteCommand): boolean {
    const match = this.binding(this.issuedBindings.get(command) ?? command.id);
    if (!match) return true;
    const { p, b } = match;
    const step = p.revisions.at(-1)!.plan.steps.find((s) => s.step_id === b.step_id);
    const prepared = prepareOperationPlan(p.revisions.at(-1)!.plan, { now_ms: Date.now(), results: p.results, observations: [] });
    const current = prepared.kind === "inspected" ? prepared.plan.steps.find((s) => s.step_id === b.step_id) : undefined;
    return command.id === b.command_id && b.status === "selected" && !!step && stepDigest(step) === b.step_digest &&
      prepared.kind === "inspected" && prepared.summary.steps.find((s) => s.step_id === b.step_id)?.status === "ready" &&
      !!current && stepDigest(current) === stepDigest(b.prepared_step) &&
      command.upstream_decision.request_id === b.request_id && command.upstream_decision.commit_hash === b.commit_hash &&
      command.upstream_decision.commit_decision === "ASSERT" && command.type === "tool_call" &&
      command.payload.tool_name === b.operation && commandPayloadDigest(command) === b.payload_digest &&
      operationPlanDigest(command) === b.command_digest;
  }
  beginAttempt(command: ExecuteCommand, admission?: ExecutionAdmission): boolean {
    if (!this.canExecute(command)) return false;
    if (!this.isBound(command.id)) return true;
    const admitted = admission === undefined ? undefined : ExecutionAdmissionSchema.parse(admission);
    if (admitted && (admitted.command_key !== createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command.id])).digest("hex") ||
        Date.now() < admitted.issued_at_ms || Date.now() >= admitted.expires_at_ms)) return false;
    this.change((state) => { for (const p of state.plans) {
      const b = p.bindings.find((b) => b.command_id === command.id);
      if (b) { b.status = "intent_committed"; if (admitted) b.execution_admission = admitted; }
    } });
    freezeCommand(command);
    return true;
  }
  abandon(command_id: string): void {
    if (!this.binding(command_id) || this.binding(command_id)!.b.status !== "selected") return;
    this.change((state) => { for (const p of state.plans) {
      const b = p.bindings.find((b) => b.command_id === command_id); if (b?.status === "selected") b.status = "invalidated";
    } });
  }

  recordResult(feedback: ExecuteFeedback): void {
    const match = this.binding(feedback.command_id);
    if (!match || match.b.status !== "intent_committed") return;
    this.applyResult(match, feedback);
  }

  /** 起動時の私有結果調停。inflightや承認を復元せず、作用を一切呼ばない。 */
  reconcileResult(value: ExecutionResultDelivery, delivery_digest: string): boolean {
    const delivery = inspectExecutionResultDelivery(value);
    if (createHash("sha256").update(JSON.stringify(delivery)).digest("hex") !== delivery_digest) throw new Error("plan_delivery_digest_mismatch");
    const match = this.binding(delivery.feedback.command_id);
    if (!match?.b.execution_admission) return false;
    const { b, p } = match;
    if (operationPlanDigest(b.execution_admission) !== operationPlanDigest(delivery.admission)) throw new Error("plan_delivery_admission_mismatch");
    if (b.delivery_digest) {
      if (b.delivery_digest !== delivery_digest) throw new Error("plan_delivery_identity_conflict");
      return true;
    }
    const fb = delivery.feedback;
    const result = inspectOperationCommandExecutionResult(fb.operation_core_result, {
      request_id: b.request_id, command_id: b.command_id, upstream_commit_hash: b.commit_hash, status: fb.status, operation: b.operation,
    });
    if (!result || result.command_payload_digest !== b.payload_digest || result.observed_at_ms < delivery.admission.issued_at_ms ||
        result.observed_at_ms > Date.now() || (fb.result === undefined ? result.output_digest !== undefined :
          createHash("sha256").update(JSON.stringify(fb.result)).digest("hex") !== result.output_digest)) throw new Error("plan_delivery_result_mismatch");
    if (["intent_committed", "outcome_unknown"].includes(b.status) && !b.result_digest) {
      this.applyResult(match, fb, delivery_digest);
      return true;
    }
    if (b.result_digest !== operationPlanDigest(result)) throw new Error("plan_delivery_result_conflict");
    if (b.status === "verified") {
      const saved = p.results.find((r) => r.step_id === b.step_id && r.result_id === result.result_id);
      if (!saved || saved.observed_at_ms !== result.observed_at_ms ||
          operationPlanDigest(saved.output) !== operationPlanDigest(fb.result)) throw new Error("plan_delivery_result_conflict");
    } else if (!["not_attempted", "outcome_unknown", "verification_failed"].includes(b.status)) return false;
    this.change((state) => { state.plans.flatMap((p) => p.bindings).find((b) => b.command_id === fb.command_id)!.delivery_digest = delivery_digest; });
    return true;
  }

  private applyResult({ p, b }: { p: PlanState; b: Binding }, feedback: ExecuteFeedback, delivery_digest?: string): void {
    const result = inspectOperationCommandExecutionResult(feedback.operation_core_result, {
      request_id: b.request_id, command_id: b.command_id, upstream_commit_hash: b.commit_hash,
      operation: b.operation, status: feedback.status,
    });
    const step = b.prepared_step;
    const output = OperationJsonValueSchema.safeParse(feedback.result);
    const verified = !!result && result.command_payload_digest === b.payload_digest && result.action_outcome === "reported_success" &&
      output.success && result.output_digest === createHash("sha256").update(JSON.stringify(feedback.result)).digest("hex") &&
      !!step.preparation?.validation.length && step.preparation.validation.every((v) => v.method === "result_equals" &&
        operationPlanDigest(v.target) === operationPlanDigest(step.target) && operationPlanDigest(v.expected) === operationPlanDigest(output.data));
    this.change((state) => {
      const target = state.plans.find((entry) => entry.bindings.some((binding) => binding.command_id === b.command_id))!;
      const binding = target.bindings.find((binding) => binding.command_id === b.command_id)!;
      binding.status = !result || result.command_payload_digest !== b.payload_digest ? "outcome_unknown"
        : result.action_outcome === "not_attempted" ? "not_attempted"
          : verified ? "verified" : result.action_outcome === "reported_success" ? "verification_failed" : "outcome_unknown";
      if (result) binding.result_digest = operationPlanDigest(result);
      if (delivery_digest) binding.delivery_digest = delivery_digest;
      if (verified && output.success && result) target.results.push({ plan_id: p.revisions[0]!.plan.plan_id,
        request_id: p.revisions[0]!.plan.request_id, step_id: b.step_id, result_id: result.result_id, operation: b.operation,
        status: "succeeded", target: step.target, output: output.data, observed_at_ms: result.observed_at_ms,
        expires_at_ms: result.observed_at_ms + 600_000 });
    });
  }

  projection() {
    return { schema_version: "operation-plan-projection.v1", used_for_authority: false as const, raw_payload_exposed: false as const,
      plans: this.state.plans.map((p) => ({ plan_id: operationPlanDigest(p.revisions[0]!.plan.plan_id),
        request_id: p.revisions[0]!.plan.request_id, revision: p.revisions.length,
        revision_digest: p.revisions.at(-1)!.digest, previous_revision_digests: p.revisions.slice(0, -1).map((r) => r.digest),
        status: p.revisions.at(-1)!.plan.steps.every((s) => p.bindings.some((b) => b.step_id === s.step_id && b.status === "verified"))
          ? "results_verified" : "awaiting_step_review",
        steps: p.revisions.at(-1)!.plan.steps.map((step) => ({ step_id: operationPlanDigest(step.step_id),
          operation: step.operation, definition_digest: stepDigest(step),
          status: p.bindings.filter((b) => b.step_id === step.step_id).at(-1)?.status ?? "not_selected" })),
        bindings: p.bindings.map((b) => ({ step_id: operationPlanDigest(b.step_id), revision_digest: b.revision_digest,
          step_digest: b.step_digest, command_id: b.command_id, request_id: b.request_id, commit_hash: b.commit_hash,
          payload_digest: b.payload_digest, command_digest: b.command_digest, operation: b.operation,
          status: b.status, result_digest: b.result_digest, delivery_digest: b.delivery_digest })),
      })) };
  }

  private ownedPlan(id: string, caller: InboundRequest): PlanState {
    const matches = this.state.plans.filter((p) => p.revisions[0]!.plan.plan_id === id || operationPlanDigest(p.revisions[0]!.plan.plan_id) === id);
    const p = matches[0];
    if (matches.length !== 1 || !p || p.owner !== caller.user || p.channel !== caller.channel) throw new Error("plan_owner_or_identity_mismatch");
    return p;
  }
  private binding(id: string): { p: PlanState; b: Binding } | undefined {
    for (const p of this.state.plans) { const b = p.bindings.find((b) => b.command_id === id); if (b) return { p, b }; }
    return undefined;
  }
  private revisionImpact(p: PlanState, input: unknown): Set<string> {
    const next = candidatePlan(input);
    const old = p.revisions.at(-1)!.plan;
    if (next.plan_id !== old.plan_id || next.request_id !== old.request_id) throw new Error("plan_revision_identity_changed");
    if (operationPlanDigest(next) === operationPlanDigest(old)) throw new Error("plan_revision_unchanged");
    const affected = new Set<string>();
    for (const s of [...old.steps, ...next.steps]) {
      const previous = old.steps.find((step) => step.step_id === s.step_id);
      const current = next.steps.find((step) => step.step_id === s.step_id);
      if (!previous || !current || stepDigest(previous) !== stepDigest(current)) affected.add(s.step_id);
    }
    let changed = true;
    while (changed) { changed = false; for (const s of [...old.steps, ...next.steps]) {
      if (!affected.has(s.step_id) && s.preparation?.depends_on.some((id) => affected.has(id))) { affected.add(s.step_id); changed = true; }
    } }
    for (const b of p.bindings) if (!["selected", "invalidated", "not_attempted"].includes(b.status) && affected.has(b.step_id)) {
      throw new Error("plan_attempted_step_or_dependency_changed");
    }
    return affected;
  }
  private change(mutate: (state: OperationPlanCheckpoint) => void): void {
    const next = OperationPlanCheckpointSchema.parse(this.state);
    mutate(next);
    const checked = OperationPlanCheckpointSchema.parse(next);
    if (JSON.stringify(checked).length > 4_000_000) throw new Error("plan_checkpoint_capacity_reached");
    this.port?.compareAndSet(this.savedDigest, checked);
    this.state = checked;
    this.savedDigest = operationPlanDigest(checked);
  }
}
