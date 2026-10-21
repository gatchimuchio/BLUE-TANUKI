import { describe, expect, it } from "vitest";
import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";
import { renderCommandOutput } from "../src/result_render.js";

const upstream = {
  frame_goal: "g",
  model_abstraction: "m",
  commit_hash: "h",
  commit_decision: "ASSERT" as const,
};

function feedback(result: unknown): ExecuteFeedback {
  return {
    command_id: "cmd",
    status: "success",
    result,
    metrics: { duration_ms: 1 },
  };
}

describe("renderCommandOutput", () => {
  it("renders LLM content directly", () => {
    const cmd: ExecuteCommand = {
      id: "cmd",
      type: "llm_call",
      payload: { messages: [{ role: "user", content: "hi" }] },
      upstream_decision: upstream,
    };

    expect(renderCommandOutput(cmd, feedback({ content: "hello" }))).toBe("hello");
  });

  it("renders tool results with stable JSON", () => {
    const cmd: ExecuteCommand = {
      id: "cmd",
      type: "tool_call",
      payload: { tool_name: "file.search", arguments: {} },
      upstream_decision: upstream,
    };

    expect(
      renderCommandOutput(cmd, feedback({ z: 1, a: { b: true } })),
    ).toBe('[tool:file.search]\n{\n  "a": {\n    "b": true\n  },\n  "z": 1\n}');
  });

  it("renders noop reason and failures", () => {
    const noop: ExecuteCommand = {
      id: "cmd",
      type: "noop",
      payload: { reason: "unsupported tool: shell.exec" },
      upstream_decision: upstream,
    };
    expect(renderCommandOutput(noop, feedback(null))).toBe(
      "[noop] unsupported tool: shell.exec",
    );

    const failed: ExecuteFeedback = {
      command_id: "cmd",
      status: "failed",
      error: "boom",
      metrics: { duration_ms: 1 },
    };
    expect(renderCommandOutput(noop, failed)).toBe("[failed:noop] boom");
  });

  it("renders the audited saved Operation Plan result projection", () => {
    const command: ExecuteCommand = { id: "cmd", type: "noop",
      payload: { control_event: "operation_plan_result_return", result_projection_digest: "a".repeat(64) },
      upstream_decision: upstream };
    expect(renderCommandOutput(command, feedback({ content: "保存時点の結果。検索完全性は不明です。" })))
      .toBe("保存時点の結果。検索完全性は不明です。");
  });

  it("does not echo channel_send commands and truncates output", () => {
    const channel: ExecuteCommand = {
      id: "cmd",
      type: "channel_send",
      payload: { channel: "webchat", target: "u", content: "hi" },
      upstream_decision: upstream,
    };
    expect(renderCommandOutput(channel, feedback({ sent: true }))).toBeNull();

    const llm: ExecuteCommand = {
      id: "cmd",
      type: "llm_call",
      payload: { messages: [{ role: "user", content: "hi" }] },
      upstream_decision: upstream,
    };
    expect(
      renderCommandOutput(llm, feedback({ content: "abcdef" }), { max_chars: 5 }),
    ).toContain("[truncated");
  });
});
