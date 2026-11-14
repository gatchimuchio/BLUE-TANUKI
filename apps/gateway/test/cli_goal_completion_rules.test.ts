import { describe, expect, it } from "vitest";
import { isGatewayInternalInboundRequest } from "@blue-tanuki/protocol";
import {
  CLI_GOAL_COMPLETION_RULES_MAX_BYTES,
  createCliGoalCompletionStatusRequest,
  createCliInboundRequest,
  cliGoalCompletionRulesRequested,
  cliRequestNeedsOperationPlanState,
  parseCliGoalCompletionStatusArguments,
  parseCliGoalCompletionRulesInput,
  readCliGoalCompletionRulesInput,
} from "../src/cli_goal_completion_rules.js";

const validRules = {
  schema_version: "blue-tanuki.goal-completion-rules.v1",
  rules: [{
    rule_id: "saved",
    operation: "file.write",
    output_pointer: "/status",
    expected_value: "success",
  }],
};

describe("CLI goal completion rules input", () => {
  it("recognizes one explicit stdin flag and rejects duplicates", () => {
    expect(cliGoalCompletionRulesRequested(["task"])).toBe(false);
    expect(cliGoalCompletionRulesRequested(["task", "--goal-completion-rules-stdin"])).toBe(true);
    expect(() => cliGoalCompletionRulesRequested([
      "--goal-completion-rules-stdin",
      "--goal-completion-rules-stdin",
    ])).toThrow("cli_goal_completion_rules_flag_repeated");
  });

  it("opens durable plan state for explicit CLI plan computation and readback", () => {
    expect(cliRequestNeedsOperationPlanState(["ordinary question"])).toBe(false);
    expect(cliRequestNeedsOperationPlanState(["plan:compute", "read the selected local source"])).toBe(true);
    expect(cliRequestNeedsOperationPlanState(["plan:compute read the selected local source"])).toBe(true);
    expect(cliRequestNeedsOperationPlanState(["--goal-completion-rules-stdin", "read the selected local source"]))
      .toBe(true);
    expect(cliRequestNeedsOperationPlanState(["--goal-completion-status", "a".repeat(64)])).toBe(true);
    expect(cliRequestNeedsOperationPlanState(["--organize", "plan:compute is only document source text"]))
      .toBe(false);
    expect(cliRequestNeedsOperationPlanState(["question mentions plan:compute as data"]))
      .toBe(false);
  });

  it("accepts one digest-only readback selector and creates an owner-bound CLI status request", () => {
    const digest = "a".repeat(64);
    expect(parseCliGoalCompletionStatusArguments(["--goal-completion-status", digest])).toEqual({
      request_id_digest: digest,
      remaining_args: [],
    });
    expect(() => parseCliGoalCompletionStatusArguments(["--goal-completion-status", digest,
      "--goal-completion-status", digest])).toThrow("cli_goal_completion_status_flag_repeated");
    expect(() => parseCliGoalCompletionStatusArguments(["--goal-completion-status"])
      ).toThrow("cli_goal_completion_status_digest_required");
    expect(() => parseCliGoalCompletionStatusArguments(["--goal-completion-status", "not-a-digest"])
      ).toThrow("cli_goal_completion_status_digest_required");

    const request = createCliGoalCompletionStatusRequest({ id: "status-request", timestamp: 3,
      request_id_digest: digest.toUpperCase() });
    expect(request.content).toBe(`plan:status ${JSON.stringify({ request_id_digest: digest })}`);
    expect(request.channel).toBe("cli");
    expect(request.user).toBe("local-user");
    expect(request.goal_completion_rules).toBeUndefined();
    expect(isGatewayInternalInboundRequest(request)).toBe(true);
    expect(request.metadata).toMatchObject({
      "blue_tanuki.actor_kind": "owner",
      "blue_tanuki.trust_level": "owner",
      "blue_tanuki.operator_surface": "developer",
      "blue_tanuki.operation_core.used_for_authority": false,
    });
  });

  it("parses only bounded, schema-valid UTF-8 JSON without echoing input", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(validRules));
    expect(parseCliGoalCompletionRulesInput(bytes)).toEqual(validRules);
    expect(() => parseCliGoalCompletionRulesInput(new TextEncoder().encode("{")))
      .toThrow("cli_goal_completion_rules_input_invalid_json");
    expect(() => parseCliGoalCompletionRulesInput(new TextEncoder().encode(JSON.stringify({ ...validRules, rules: [] }))))
      .toThrow("cli_goal_completion_rules_input_invalid");
    expect(() => parseCliGoalCompletionRulesInput(new Uint8Array([0xff])))
      .toThrow("cli_goal_completion_rules_input_invalid_utf8");
    expect(() => parseCliGoalCompletionRulesInput(new Uint8Array(CLI_GOAL_COMPLETION_RULES_MAX_BYTES + 1)))
      .toThrow("cli_goal_completion_rules_input_too_large");
  });

  it("reads split stdin chunks and stops as soon as the byte limit is exceeded", async () => {
    async function* validChunks(): AsyncGenerator<Uint8Array> {
      const input = new TextEncoder().encode(JSON.stringify(validRules));
      yield input.subarray(0, 9);
      yield input.subarray(9);
    }
    expect(await readCliGoalCompletionRulesInput(validChunks())).toEqual(validRules);

    async function* oversizedChunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(CLI_GOAL_COMPLETION_RULES_MAX_BYTES);
      yield new Uint8Array(1);
    }
    await expect(readCliGoalCompletionRulesInput(oversizedChunks()))
      .rejects.toThrow("cli_goal_completion_rules_input_too_large");
  });

  it("preserves owner rules only on the Gateway-internal CLI request", () => {
    const rules = parseCliGoalCompletionRulesInput(new TextEncoder().encode(JSON.stringify(validRules)));
    const request = createCliInboundRequest({
      id: "request-1",
      content: "save the requested result",
      timestamp: 1,
      goal_completion_rules: rules,
    });
    expect(request.channel).toBe("cli");
    expect(request.content).toBe("plan:compute save the requested result");
    expect(request.goal_completion_rules).toEqual(validRules);
    expect(isGatewayInternalInboundRequest(request)).toBe(true);
    expect(request.metadata).toMatchObject({
      "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.actor_kind": "owner",
      "blue_tanuki.trust_level": "owner",
      "blue_tanuki.operator_surface": "developer",
      "blue_tanuki.operation_core.used_for_authority": false,
    });

    const ordinaryRequest = createCliInboundRequest({
      id: "request-2",
      content: "ordinary request",
      timestamp: 2,
    });
    expect(ordinaryRequest.goal_completion_rules).toBeUndefined();
    expect(isGatewayInternalInboundRequest(ordinaryRequest)).toBe(false);
    expect(ordinaryRequest.content).toBe("ordinary request");
  });

  it("does not turn an empty CLI input into an implicit completion task", () => {
    const rules = parseCliGoalCompletionRulesInput(new TextEncoder().encode(JSON.stringify(validRules)));
    expect(() => createCliInboundRequest({ id: "request-3", content: "  ", timestamp: 3, goal_completion_rules: rules }))
      .toThrow("cli_goal_completion_rules_task_required");
    expect(createCliInboundRequest({ id: "request-4", content: "{\"task\":\"quoted JSON task\"}", timestamp: 4,
      goal_completion_rules: rules }).content)
      .toBe("plan:compute task:\n{\"task\":\"quoted JSON task\"}");
  });
});
