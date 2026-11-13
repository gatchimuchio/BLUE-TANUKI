import {
  GoalCompletionRulesSchema,
  normalizeInboundRequestForAuthority,
  type GoalCompletionRules,
  type InboundRequest,
} from "@blue-tanuki/protocol";

export const CLI_GOAL_COMPLETION_RULES_STDIN_FLAG = "--goal-completion-rules-stdin";
export const CLI_GOAL_COMPLETION_STATUS_FLAG = "--goal-completion-status";
export const CLI_GOAL_COMPLETION_RULES_MAX_BYTES = 128 * 1024;

export interface CliGoalCompletionStatusArguments {
  request_id_digest: string;
  remaining_args: string[];
}

export function createCliInboundRequest(input: {
  id: string;
  content: string;
  timestamp: number;
  goal_completion_rules?: GoalCompletionRules;
}): InboundRequest {
  const hasCompletionRules = input.goal_completion_rules !== undefined;
  if (hasCompletionRules && input.content.trim().length === 0) {
    throw new Error("cli_goal_completion_rules_task_required");
  }
  const taskContent = hasCompletionRules && input.content.trimStart().startsWith("{")
    ? `task:\n${input.content}`
    : input.content;
  const content = hasCompletionRules
    ? `plan:compute ${taskContent}`
    : input.content;
  return normalizeInboundRequestForAuthority({
    id: input.id,
    content,
    timestamp: input.timestamp,
    channel: "cli",
    user: "local-user",
    ...(input.goal_completion_rules ? { goal_completion_rules: input.goal_completion_rules } : {}),
    ...(hasCompletionRules ? { metadata: {
      "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.actor_kind": "owner",
      "blue_tanuki.trust_level": "owner",
      "blue_tanuki.operator_surface": "developer",
      "blue_tanuki.operation_core.used_for_authority": false,
    } } : {}),
  }, { internal_authority_metadata: hasCompletionRules });
}

export function createCliGoalCompletionStatusRequest(input: {
  id: string;
  timestamp: number;
  request_id_digest: string;
}): InboundRequest {
  if (!/^[a-f0-9]{64}$/i.test(input.request_id_digest)) {
    throw new Error("cli_goal_completion_status_digest_invalid");
  }
  return normalizeInboundRequestForAuthority({
    id: input.id,
    content: `plan:status ${JSON.stringify({ request_id_digest: input.request_id_digest.toLowerCase() })}`,
    timestamp: input.timestamp,
    channel: "cli",
    user: "local-user",
    metadata: {
      "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.actor_kind": "owner",
      "blue_tanuki.trust_level": "owner",
      "blue_tanuki.operator_surface": "developer",
      "blue_tanuki.operation_core.used_for_authority": false,
    },
  }, { internal_authority_metadata: true });
}

export function parseCliGoalCompletionStatusArguments(args: readonly string[]): CliGoalCompletionStatusArguments | null {
  const positions = args.flatMap((arg, index) => arg === CLI_GOAL_COMPLETION_STATUS_FLAG ? [index] : []);
  if (positions.length > 1) throw new Error("cli_goal_completion_status_flag_repeated");
  const position = positions[0];
  if (position === undefined) return null;
  const digest = args[position + 1];
  if (!digest || !/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("cli_goal_completion_status_digest_required");
  }
  return {
    request_id_digest: digest.toLowerCase(),
    remaining_args: [...args.slice(0, position), ...args.slice(position + 2)],
  };
}

export function cliGoalCompletionRulesRequested(args: readonly string[]): boolean {
  const count = args.filter((arg) => arg === CLI_GOAL_COMPLETION_RULES_STDIN_FLAG).length;
  if (count > 1) throw new Error("cli_goal_completion_rules_flag_repeated");
  return count === 1;
}

export function parseCliGoalCompletionRulesInput(input: Uint8Array): GoalCompletionRules {
  if (input.byteLength === 0) throw new Error("cli_goal_completion_rules_input_empty");
  if (input.byteLength > CLI_GOAL_COMPLETION_RULES_MAX_BYTES) {
    throw new Error("cli_goal_completion_rules_input_too_large");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new Error("cli_goal_completion_rules_input_invalid_utf8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("cli_goal_completion_rules_input_invalid_json");
  }
  const parsed = GoalCompletionRulesSchema.safeParse(value);
  if (!parsed.success) throw new Error("cli_goal_completion_rules_input_invalid");
  return parsed.data;
}

export async function readCliGoalCompletionRulesInput(
  input: AsyncIterable<Uint8Array>,
): Promise<GoalCompletionRules> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    totalBytes += chunk.byteLength;
    if (totalBytes > CLI_GOAL_COMPLETION_RULES_MAX_BYTES) {
      throw new Error("cli_goal_completion_rules_input_too_large");
    }
    chunks.push(chunk);
  }
  const complete = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    complete.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseCliGoalCompletionRulesInput(complete);
}
