import { createHash } from "node:crypto";
import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";

export type OutputAuditKind =
  | "llm_raw_output"
  | "tool_result"
  | "external_action_result"
  | "scheduler_result"
  | "plugin_result"
  | "noop_result";

export type OutputTargetSurface =
  | "cli"
  | "channel"
  | "control_center"
  | "audit_viewer"
  | "external"
  | "unknown";

export interface OutputAuditInput {
  command: ExecuteCommand;
  feedback: ExecuteFeedback;
  request_id?: string | null;
  rendered_output?: string | null;
  target_surface?: OutputTargetSurface;
  timestamp?: number;
}

export interface OutputAuditLog {
  kind: "output_audit";
  request_id: string | null;
  command_id: string;
  command_type: ExecuteCommand["type"];
  upstream_commit_hash: string;
  upstream_decision: ExecuteCommand["upstream_decision"]["commit_decision"];
  output_kind: OutputAuditKind;
  target_surface: OutputTargetSurface;
  status: ExecuteFeedback["status"];
  result_present: boolean;
  result_digest?: string;
  rendered_output_present: boolean;
  rendered_output_digest?: string;
  rendered_output_chars?: number;
  user_visible_output: boolean;
  external_side_effect_result: boolean;
  used_for_authority: false;
  release_decision: "allow" | "none";
  reason: string;
  timestamp: number;
}

/** Digest-only audit for displaying a terminal J projection without executing C. */
export interface ProjectionOutputAuditLog {
  kind: "j_projection_output_audit";
  request_id: string | null;
  upstream_commit_hash: string;
  task_id: string;
  projection_revision: number;
  projection_status: "completed" | "held";
  target_surface: OutputTargetSurface;
  rendered_output_digest: string;
  rendered_output_chars: number;
  user_visible_output: boolean;
  external_side_effect_result: false;
  used_for_authority: false;
  may_execute: false;
  may_commit_to_memory: false;
  reason: "terminal_j_projection_reviewed_before_display";
  timestamp: number;
}

export interface ProjectionOutputAuditInput {
  readonly request_id: string;
  readonly upstream_commit_hash: string;
  readonly task_id: string;
  readonly projection_revision: number;
  readonly projection_status: "completed" | "held";
  readonly rendered_output: string;
  readonly target_surface: OutputTargetSurface;
  readonly timestamp?: number;
}

export function buildOutputAuditLog(input: OutputAuditInput): OutputAuditLog {
  const output = input.rendered_output ?? null;
  const outputKind = classifyOutputKind(input.command);
  const targetSurface = input.target_surface ?? "unknown";
  const renderedOutputPresent = typeof output === "string" && output.length > 0;
  const resultPresent = input.feedback.result !== undefined;
  const userVisibleOutput = renderedOutputPresent && isUserVisibleSurface(targetSurface);
  const externalSideEffectResult =
    outputKind === "external_action_result" || targetSurface === "external";

  return {
    kind: "output_audit",
    request_id: input.request_id ?? null,
    command_id: input.command.id,
    command_type: input.command.type,
    upstream_commit_hash: input.command.upstream_decision.commit_hash,
    upstream_decision: input.command.upstream_decision.commit_decision,
    output_kind: outputKind,
    target_surface: targetSurface,
    status: input.feedback.status,
    result_present: resultPresent,
    result_digest: resultPresent ? sha256(input.feedback.result) : undefined,
    rendered_output_present: renderedOutputPresent,
    rendered_output_digest: renderedOutputPresent ? sha256(output) : undefined,
    rendered_output_chars: renderedOutputPresent ? output.length : undefined,
    user_visible_output: userVisibleOutput,
    external_side_effect_result: externalSideEffectResult,
    used_for_authority: false,
    release_decision: renderedOutputPresent || externalSideEffectResult ? "allow" : "none",
    reason: outputAuditReason(outputKind, input.feedback.status, renderedOutputPresent),
    timestamp: input.timestamp ?? Date.now(),
  };
}

export function buildProjectionOutputAuditLog(input: ProjectionOutputAuditInput): ProjectionOutputAuditLog {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.request_id) ||
      !/^[a-f0-9]{64}$/u.test(input.upstream_commit_hash) ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.task_id) ||
      !Number.isInteger(input.projection_revision) || input.projection_revision < 0 ||
      typeof input.rendered_output !== "string" || input.rendered_output.length === 0) {
    throw new Error("invalid_j_projection_output_audit_input");
  }
  return {
    kind: "j_projection_output_audit",
    request_id: input.request_id,
    upstream_commit_hash: input.upstream_commit_hash,
    task_id: input.task_id,
    projection_revision: input.projection_revision,
    projection_status: input.projection_status,
    target_surface: input.target_surface,
    rendered_output_digest: sha256(input.rendered_output),
    rendered_output_chars: input.rendered_output.length,
    user_visible_output: isUserVisibleSurface(input.target_surface),
    external_side_effect_result: false,
    used_for_authority: false,
    may_execute: false,
    may_commit_to_memory: false,
    reason: "terminal_j_projection_reviewed_before_display",
    timestamp: input.timestamp ?? Date.now(),
  };
}

export function classifyOutputKind(command: ExecuteCommand): OutputAuditKind {
  if (command.type === "llm_call") return "llm_raw_output";
  if (command.type === "channel_send") return "external_action_result";
  if (command.type === "noop") return "noop_result";

  const toolName = command.payload.tool_name;
  const caps = command.constraints?.allowed_capabilities ?? [];
  if (toolName.startsWith("schedule.")) return "scheduler_result";
  if (toolName.startsWith("plugin.") || caps.some((cap) => cap.startsWith("plugin:"))) return "plugin_result";
  if (isExternalActionTool(toolName, caps)) return "external_action_result";
  return "tool_result";
}

function isExternalActionTool(toolName: string, caps: readonly string[]): boolean {
  if (
    toolName === "github.write" ||
    toolName === "gmail.write" ||
    toolName === "google.calendar.write" ||
    toolName === "google.drive.write" ||
    toolName === "browser.automation"
  ) {
    return true;
  }
  return caps.some((cap) =>
    cap === "external:send" ||
    cap === "email:send" ||
    cap === "slack:send" ||
    cap === "discord:send" ||
    cap.startsWith("github:") ||
    cap.endsWith(".write") ||
    cap === "browser:act",
  );
}

function isUserVisibleSurface(surface: OutputTargetSurface): boolean {
  return surface === "cli" || surface === "channel" || surface === "control_center";
}

function outputAuditReason(
  kind: OutputAuditKind,
  status: ExecuteFeedback["status"],
  renderedOutputPresent: boolean,
): string {
  return `output_audit:${kind}:${status}:${renderedOutputPresent ? "rendered" : "not_rendered"}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === undefined) return "[undefined]";
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => normalize(item));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}
