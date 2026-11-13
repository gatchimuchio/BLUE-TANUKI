import { describe, expect, it } from "vitest";
import { isGatewayInternalInboundRequest } from "@blue-tanuki/protocol";
import {
  CLI_GOAL_COMPLETION_RULES_MAX_BYTES,
  createCliInboundRequest,
  cliGoalCompletionRulesRequested,
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
    expect(request.goal_completion_rules).toEqual(validRules);
    expect(isGatewayInternalInboundRequest(request)).toBe(true);

    const ordinaryRequest = createCliInboundRequest({
      id: "request-2",
      content: "ordinary request",
      timestamp: 2,
    });
    expect(ordinaryRequest.goal_completion_rules).toBeUndefined();
    expect(isGatewayInternalInboundRequest(ordinaryRequest)).toBe(false);
  });
});
