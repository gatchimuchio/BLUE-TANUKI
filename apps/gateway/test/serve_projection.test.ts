import { describe, expect, it } from "vitest";
import { CompleteHistoryStore } from "@blue-tanuki/hds-brain";
import { projectOperationCoreExecutionHistory } from "../src/serve_projection.js";

describe("Operation Core execution projection", () => {
  it("projects execution history as display-only digest metadata", () => {
    const history = new CompleteHistoryStore();
    history.append({
      kind: "execution_history",
      request_id: "req-1",
      command_id: "cmd-1",
      actor: "owner",
      source: "executor",
      timestamp: 12345,
      payload: {
        command: {
          type: "tool_call",
          operation: "shell.exec",
          upstream_decision: "ASSERT",
          upstream_commit_hash: "commit-hash",
          constraints: {
            allowed_tools: ["shell.exec"],
            allowed_capabilities: ["fs:read:workspace"],
            secret_constraint: "SECRET-CONSTRAINT",
          },
          payload: {
            tool_name: "shell.exec",
            argument_keys: ["cmd", "args"],
            arguments_digest: "argument-digest",
            raw_arguments: { cmd: "SECRET-RAW-COMMAND" },
          },
        },
        origin_channel: "webchat",
        status: "failed",
        result_present: true,
        result_digest: "result-digest",
        error: "SECRET-ERROR-DETAIL",
        metrics: { duration_ms: 12 },
        raw_result: "SECRET-RAW-RESULT",
      },
    });

    const projection = projectOperationCoreExecutionHistory(history.replay({ kind: "execution_history" }), {
      chain_valid: history.verify(),
      skipped_count: history.skippedCount(),
    });
    const text = JSON.stringify(projection);

    expect(projection).toMatchObject({
      schema_version: "operation-core.execution.v1",
      used_for_authority: false,
      adapter_result_used_for_authority: false,
      execution_history_used_for_authority: false,
      raw_payload_exposed: false,
      chain_valid: true,
      entries_count: 1,
      displayed_count: 1,
    });
    expect(projection.latest_results[0]).toMatchObject({
      request_id: "req-1",
      command_id: "cmd-1",
      status: "failed",
      result_digest: "result-digest",
      error_present: true,
      command: {
        type: "tool_call",
        operation: "shell.exec",
        payload: {
          tool_name: "shell.exec",
          argument_keys: ["cmd", "args"],
          arguments_digest: "argument-digest",
        },
      },
      diff: {
        available: false,
        used_for_authority: false,
      },
      rollback: {
        available: false,
        used_for_authority: false,
      },
    });
    expect(text).toContain("error_digest");
    expect(text).not.toContain("SECRET-RAW-COMMAND");
    expect(text).not.toContain("SECRET-RAW-RESULT");
    expect(text).not.toContain("SECRET-ERROR-DETAIL");
    expect(text).not.toContain("SECRET-CONSTRAINT");
  });
});
