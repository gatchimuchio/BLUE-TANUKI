import type { InboundRequest } from "@blue-tanuki/protocol";
import { AuditLog } from "./audit.js";
import { HDSUpperController, type HDSRuntimeSnapshot } from "./controller.js";
import {
  evaluateApproval,
  type ApprovalLevel,
  type ApprovalRisk,
  type ApprovalOperation,
  type ApprovalEvaluation,
} from "./approval_policy.js";
import {
  evaluateHDSBrainHealth,
  type HDSBrainHealth,
  type HDSBrainHealthOptions,
} from "./health.js";

export interface StandaloneHDSBrainInput {
  id: string;
  channel: string;
  user: string;
  content: string;
  timestamp?: number;
  metadata?: InboundRequest["metadata"];
}

export interface StandaloneHDSBrainResult {
  decision: "ASSERT" | "SUSPEND" | "OUT_OF_SCOPE" | "FAIL";
  command_type?: string;
  command_id?: string;
  operation?: ApprovalOperation;
  risk?: ApprovalRisk;
  approval_level?: ApprovalLevel;
  final_review_required?: boolean;
  approval_decision?: ApprovalEvaluation["decision"];
  audit_chain_valid: boolean;
  memory_used_for_authority: false;
  complete_history_used_for_authority: false;
  invariants: HDSRuntimeSnapshot["invariants"];
  runtime_invariants: HDSRuntimeSnapshot["runtime_invariants"];
  runtime_snapshot: HDSRuntimeSnapshot;
  health: HDSBrainHealth;
}

const STANDALONE_HEALTH_OPTIONS: HDSBrainHealthOptions = {
  required_directories: [],
  storage_paths: [],
  optional_dependencies: [],
  audit_appendable: "memory_only",
};

export function runStandaloneHDSBrain(
  input: StandaloneHDSBrainInput,
): StandaloneHDSBrainResult {
  const audit = new AuditLog();
  const controller = new HDSUpperController({ audit });
  const req: InboundRequest = {
    id: input.id,
    channel: input.channel,
    user: input.user,
    content: input.content,
    timestamp: input.timestamp ?? Date.now(),
    metadata: input.metadata ?? {},
  };
  const { log, command } = controller.decide(req);
  let approval: ApprovalEvaluation | undefined;
  if (command) {
    approval = evaluateApproval(command, [], { actor: input.user });
    controller.onApprovalEvaluation(approval, { request_id: req.id });
  }
  const runtime_invariants_log = controller.onRuntimeInvariantsEvidence({
    request_id: req.id,
    reason: "standalone_harness",
  });
  const runtime_snapshot = controller.getRuntimeSnapshot({
    runtime_invariants: runtime_invariants_log.report,
  });
  return {
    decision: log.commit.decision,
    command_type: command?.type,
    command_id: command?.id,
    operation: approval?.context.operation,
    risk: approval?.risk,
    approval_level: approval?.approval_level,
    final_review_required: approval?.final_review_required,
    approval_decision: approval?.decision,
    audit_chain_valid: audit.verify(),
    memory_used_for_authority: false,
    complete_history_used_for_authority: false,
    invariants: runtime_snapshot.invariants,
    runtime_invariants: runtime_snapshot.runtime_invariants,
    runtime_snapshot,
    health: evaluateHDSBrainHealth(runtime_snapshot, STANDALONE_HEALTH_OPTIONS),
  };
}
