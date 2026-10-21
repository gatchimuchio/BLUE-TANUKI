import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { sha256Hex, stableJson } from "../complete-history/codec.js";
import type { FailureConditionDimension, FailureGateCandidate, FailureScope, FailureSignature } from "./types.js";

const COMMAND_ACTION_PATTERN_VERSION = "failure-command-action-v1";
const COMMAND_INPUT_PATTERN_VERSION = "failure-command-input-v1";
const COMMAND_CONTEXT_PATTERN_VERSION = "failure-command-context-v1";
const FAILURE_PATTERN_VERSION = "failure-conditioned-patterns-v1";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;
const UNIX_PATH_RE = /(?:^|\s)(\/(?:[\w.-]+\/)+[\w.-]+)/g;
const WINDOWS_PATH_RE = /\b[a-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/gi;

export function normalizeFailurePattern(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(ISO_RE, "<timestamp>")
    .replace(UUID_RE, "<id>")
    .replace(LONG_HEX_RE, "<hash>")
    .replace(WINDOWS_PATH_RE, "<path>")
    .replace(UNIX_PATH_RE, " <path>")
    .replace(/\b\d{10,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

export function commandOperation(command: ExecuteCommand): string {
  if (command.type === "tool_call") return command.payload.tool_name;
  if (command.type === "llm_call") return "llm_call";
  if (command.type === "channel_send") return `channel_send:${command.payload.channel}`;
  return "noop";
}

export function commandActionPattern(command: ExecuteCommand): string {
  const base = {
    pattern_version: COMMAND_ACTION_PATTERN_VERSION,
    type: command.type,
    operation: commandOperation(command),
    constraints: safeCommandConstraints(command),
  };
  if (command.type === "tool_call") {
    return stableJson({
      ...base,
      arguments_digest: `sha256:${sha256Hex(command.payload.arguments)}`,
    });
  }
  if (command.type === "llm_call") {
    return stableJson({
      ...base,
      messages_digest: `sha256:${sha256Hex(command.payload.messages)}`,
      backend_hint: command.payload.backend_hint,
      model: command.payload.model,
      temperature: command.payload.temperature,
    });
  }
  if (command.type === "channel_send") {
    return stableJson({
      ...base,
      channel: command.payload.channel,
      target_digest: `sha256:${sha256Hex(command.payload.target)}`,
      content_digest: `sha256:${sha256Hex(command.payload.content)}`,
    });
  }
  return stableJson(base);
}

export function commandInputPattern(command: ExecuteCommand): string {
  return stableJson({
    pattern_version: COMMAND_INPUT_PATTERN_VERSION,
    upstream_decision: command.upstream_decision.commit_decision,
    frame_goal_digest: `sha256:${sha256Hex(command.upstream_decision.frame_goal)}`,
  });
}

export function commandContextPattern(context: Record<string, unknown> = {}): string {
  const actor = typeof context.actor === "string"
    ? context.actor
    : typeof context.origin_user === "string"
      ? context.origin_user
      : undefined;
  const channel = typeof context.channel === "string" ? context.channel : undefined;
  return stableJson({
    pattern_version: COMMAND_CONTEXT_PATTERN_VERSION,
    actor_digest: actor === undefined ? undefined : `sha256:${sha256Hex(actor)}`,
    channel,
  });
}

export function commandFailurePatterns(command: ExecuteCommand): {
  version: typeof FAILURE_PATTERN_VERSION;
  input_pattern: string;
  action_pattern: string;
} {
  return {
    version: FAILURE_PATTERN_VERSION,
    input_pattern: commandInputPattern(command),
    action_pattern: commandActionPattern(command),
  };
}

export function isConditionedFailurePatterns(value: unknown): value is {
  version: typeof FAILURE_PATTERN_VERSION;
  input_pattern: string;
  action_pattern: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patterns = value as Record<string, unknown>;
  return patterns.version === FAILURE_PATTERN_VERSION &&
    isCommandInputPattern(patterns.input_pattern) &&
    isCommandActionPattern(patterns.action_pattern);
}

export function commandPatternsMatch(
  inputPattern: string,
  actionPattern: string,
  contextPattern: string,
): boolean {
  return isCommandInputPattern(inputPattern) &&
    isCommandActionPattern(actionPattern) &&
    isCommandContextPattern(contextPattern);
}

/**
 * Detect only a new HDS ASSERT for the same exact action whose goal or actor/channel
 * condition fingerprints changed. This is a re-observation candidate, not proof that
 * the external condition is resolved or permission to execute.
 */
export function changedCommandConditionDimensions(
  signature: Pick<FailureSignature, "scope" | "input_pattern" | "action_pattern" | "context_pattern">,
  candidate: FailureGateCandidate,
): FailureConditionDimension[] | null {
  if (!candidate.command || signature.scope !== candidate.scope ||
      signature.action_pattern !== candidate.action_pattern ||
      candidate.command.upstream_decision.commit_decision !== "ASSERT" ||
      !commandPatternsMatch(signature.input_pattern, signature.action_pattern, signature.context_pattern) ||
      !commandPatternsMatch(candidate.input_pattern, candidate.action_pattern, candidate.context_pattern)) {
    return null;
  }

  const current = candidateFromCommand(candidate.command, candidate.context);
  if (current.scope !== candidate.scope || current.input_pattern !== candidate.input_pattern ||
      current.action_pattern !== candidate.action_pattern || current.context_pattern !== candidate.context_pattern) {
    return null;
  }

  const previousInput = parseJsonObject(signature.input_pattern);
  const currentInput = parseJsonObject(candidate.input_pattern);
  const previousContext = parseJsonObject(signature.context_pattern);
  const currentContext = parseJsonObject(candidate.context_pattern);
  if (!previousInput || !currentInput || !previousContext || !currentContext ||
      previousInput.upstream_decision !== "ASSERT" || currentInput.upstream_decision !== "ASSERT") {
    return null;
  }

  const changed: FailureConditionDimension[] = [];
  if (previousInput.frame_goal_digest !== currentInput.frame_goal_digest) changed.push("goal");
  if (previousContext.actor_digest !== currentContext.actor_digest) changed.push("actor");
  if (previousContext.channel !== currentContext.channel) changed.push("channel");
  return changed.length > 0 ? changed : null;
}

export function failureSignatureIdentityKey(input: {
  scope: FailureScope;
  failure_type: string;
  input_pattern: string;
  action_pattern: string;
  context_pattern: string;
  predicted_difference_digest?: string;
  result_pattern?: string;
}): string {
  return stableJson({
    scope: input.scope,
    failure_type: input.failure_type,
    input: identityPattern(input.input_pattern),
    action: identityPattern(input.action_pattern),
    context: identityPattern(input.context_pattern),
    predicted_difference: identityPattern(input.predicted_difference_digest ?? ""),
    result: identityPattern(input.result_pattern ?? ""),
  });
}

export function candidateFromCommand(
  command: ExecuteCommand,
  context: Record<string, unknown> = {},
): FailureGateCandidate {
  return {
    scope: commandScope(command),
    input_pattern: commandInputPattern(command),
    action_pattern: commandActionPattern(command),
    context_pattern: commandContextPattern(context),
    command,
    context,
  };
}

export function structuralKey(scope: FailureScope, pattern: string): string {
  const normalized = normalizeFailurePattern(pattern);
  const parsed = parseJsonObject(pattern);
  if (parsed) {
    const operation = stringValue(parsed.operation);
    const type = stringValue(parsed.type);
    const tool = stringValue(parsed.tool_name);
    if (operation || type || tool) {
      return [scope, type, operation, tool].filter(Boolean).join(":");
    }
  }
  const tokens = normalized
    .split(/[^a-z0-9_.:-]+/g)
    .filter((token) => token.length >= 3 && token !== "path" && token !== "number")
    .slice(0, 5);
  return [scope, ...tokens].join(":");
}

export function semanticOverlap(left: string, right: string): number {
  const a = new Set(semanticTokens(left));
  const b = new Set(semanticTokens(right));
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function commandScope(command: ExecuteCommand): FailureScope {
  if (command.type === "tool_call") {
    const name = command.payload.tool_name;
    if (name.startsWith("file.")) return "file";
    if (name.includes("test")) return "test";
    return "tool";
  }
  if (command.type === "llm_call") return "llm_output";
  if (command.type === "channel_send") return "workflow";
  return "command";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeCommandConstraints(command: ExecuteCommand): Record<string, unknown> {
  return {
    max_tokens: command.constraints?.max_tokens,
    timeout_ms: command.constraints?.timeout_ms,
    allowed_tools: command.constraints?.allowed_tools,
    allowed_capabilities: command.constraints?.allowed_capabilities,
  };
}

function isCommandActionPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = parseJsonObject(value);
  if (!parsed || parsed.pattern_version !== COMMAND_ACTION_PATTERN_VERSION) return false;
  if (parsed.type === "tool_call") return isDigest(parsed.arguments_digest);
  if (parsed.type === "llm_call") return isDigest(parsed.messages_digest);
  if (parsed.type === "channel_send") return isDigest(parsed.target_digest) && isDigest(parsed.content_digest);
  return parsed.type === "noop";
}

function isCommandInputPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = parseJsonObject(value);
  return parsed?.pattern_version === COMMAND_INPUT_PATTERN_VERSION &&
    typeof parsed.upstream_decision === "string" &&
    isDigest(parsed.frame_goal_digest);
}

function isCommandContextPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = parseJsonObject(value);
  return parsed?.pattern_version === COMMAND_CONTEXT_PATTERN_VERSION &&
    (parsed.actor_digest === undefined || isDigest(parsed.actor_digest)) &&
    (parsed.channel === undefined || typeof parsed.channel === "string");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function identityPattern(value: string): string {
  const parsed = parseJsonObject(value);
  if (typeof parsed?.pattern_version === "string" || SHA256_RE.test(value)) return value;
  return normalizeFailurePattern(value);
}

function semanticTokens(value: string): string[] {
  return normalizeFailurePattern(value)
    .split(/[^a-z0-9_.:-]+/g)
    .filter((token) => token.length >= 4 && !["with", "from", "that", "this", "path"].includes(token));
}
