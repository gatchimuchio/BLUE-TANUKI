import { describe, it, expect, vi } from "vitest";
import {
  createGatewayInternalInboundRequest,
  type ExecuteFeedback,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import type { AuditEntry } from "../src/audit.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { PolicyConfig } from "../src/types.js";
import { LongTermMemoryStore } from "../src/long-term-memory/index.js";
import { evaluateApproval } from "../src/approval_policy.js";


function asDecisionLog(entry: AuditEntry) {
  if (!("commit" in entry.log)) {
    throw new Error(`expected decision audit entry, got ${entry.log.kind}`);
  }
  return entry.log;
}

function feedback(command_id: string, result: unknown = { ok: true }): ExecuteFeedback {
  return {
    command_id,
    status: "success",
    result,
    metrics: { duration_ms: 12, tokens_used: 3, tool_calls: 0 },
  };
}

function inbound(content: string, id = "req-1"): InboundRequest {
  return {
    id,
    channel: "test",
    user: "u1",
    content,
    timestamp: Date.now(),
  };
}

function inboundWithMetadata(
  content: string,
  metadata: Record<string, unknown>,
  id = "req-meta",
): InboundRequest {
  return {
    ...inbound(content, id),
    metadata,
  };
}

describe("HDSUpperController.decide()", () => {
  it("ASSERTs benign requests and emits a command", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(inbound("hello world"));
    expect(log.commit.decision).toBe("ASSERT");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("llm_call");
    expect(command!.upstream_decision.commit_decision).toBe("ASSERT");
    expect(c.getState()).toBe("DECIDED");
  });

  it("FAILs on hard danger keywords", () => {
    const c = new HDSUpperController();
    // Two danger patterns to push risk_safety to 0 (≤ fail threshold 0.2)
    const { log, command } = c.decide(
      inbound("rm -rf / and DROP TABLE users"),
    );
    expect(log.commit.decision).toBe("FAIL");
    expect(command).toBeNull();
  });

  it("SUSPENDs on a single danger keyword (risk_safety=0.3 < suspend 0.5)", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(inbound("please run rm -rf foo"));
    expect(log.commit.decision).toBe("SUSPEND");
    expect(command).toBeNull();
    expect(c.getState()).toBe("SUSPENDED");
    expect(c.listSuspended()).toHaveLength(1);
  });

  it("normalizes detector input while preserving raw content in audit", () => {
    const c = new HDSUpperController();
    const raw = "please run r\u200Bm -rf foo";
    const { log, command } = c.decide(inbound(raw, "r-unicode-risk"));

    expect(log.commit.decision).toBe("SUSPEND");
    expect(command).toBeNull();
    expect(log.input).toMatchObject({
      raw_content: raw,
      normalized_content: "please run rm -rf foo",
      changed: true,
    });
    expect(log.frame.goal).toBe("please run rm -rf foo");
    expect(log.input?.controls).toEqual([
      expect.objectContaining({
        index: 12,
        code_point: "U+200B",
        kind: "zero_width",
      }),
    ]);
    expect(
      log.model.scoring.axis_scores.find((axis) => axis.axis === "risk_safety")?.score,
    ).toBeCloseTo(0.3, 2);
    expect(asDecisionLog(c.getAudit().list()[0]!).input?.raw_content).toBe(raw);
  });

  it("uses NFKC-normalized content for compliance keyword matching", () => {
    const c = new HDSUpperController();
    const raw = "my ｐａｓｓｐｏｒｔ\u202E number is 123";
    const { log, command } = c.decide(inbound(raw, "r-unicode-compliance"));

    expect(log.commit.decision).toBe("SUSPEND");
    expect(command).toBeNull();
    expect(log.input?.normalized_content).toBe("my passport number is 123");
    expect(log.frame.goal).toBe("my passport number is 123");
    expect(log.input?.controls).toEqual([
      expect.objectContaining({
        code_point: "U+202E",
        kind: "bidi_control",
      }),
    ]);
    expect(
      log.model.scoring.axis_scores.find((axis) => axis.axis === "compliance")?.score,
    ).toBe(0);
  });

  it("passes normalized content to Frame and downstream command payloads", () => {
    const c = new HDSUpperController();
    const raw = "hello \uFF30\uFF21\uFF33\uFF33\u200B";
    const { log, command } = c.decide(inbound(raw, "r-unicode-llm"));

    expect(log.commit.decision).toBe("ASSERT");
    expect(log.input?.raw_content).toBe("hello PASS\u200B");
    expect(log.input?.normalized_content).toBe("hello PASS");
    expect(log.frame.goal).toBe("hello PASS");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("llm_call");
    if (command!.type === "llm_call") {
      expect(command!.payload.messages).toEqual([
        { role: "user", content: "hello PASS" },
      ]);
    }
  });

  it("audit chain stays valid across multiple decides", () => {
    const c = new HDSUpperController();
    c.decide(inbound("hello", "r1"));
    c.decide(inbound("rm -rf /", "r2"));
    c.decide(inbound("world", "r3"));
    expect(c.getAudit().size()).toBe(3);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("attaches configured LLM route hints to ASSERT commands", () => {
    const c = new HDSUpperController({
      llm_route: {
        backend_hint: "fast",
        model: "route-model",
        temperature: 0.2,
        max_tokens: 256,
        timeout_ms: 5_000,
      },
    });
    const { command } = c.decide(inbound("hello route"));
    expect(command).not.toBeNull();
    expect(command!.type).toBe("llm_call");
    if (command!.type === "llm_call") {
      expect(command!.payload).toMatchObject({
        backend_hint: "fast",
        model: "route-model",
        temperature: 0.2,
      });
    }
    expect(command!.constraints).toEqual({
      max_tokens: 256,
      timeout_ms: 5_000,
    });
  });

  it("routes explicit file.search requests to tool_call with capability envelope", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(
      inbound('tool:file.search root=. query="needle here" max_results=5'),
    );

    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "file.search",
        arguments: {
          root: ".",
          query: "needle here",
          max_results: 5,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["file.search"],
      allowed_capabilities: ["tool:file.search", "fs:read"],
      timeout_ms: 10_000,
    });
  });

  it("routes explicit file.write requests with write capability", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:file.write path=notes/today.md content="hello world" mode=create max_bytes=4096'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "file.write",
        arguments: {
          path: "notes/today.md",
          content: "hello world",
          mode: "create",
          max_bytes: 4096,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["file.write"],
      allowed_capabilities: ["tool:file.write", "fs:write"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit file.edit requests with read/write capability", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:file.edit path=notes/today.md search=hello replace=hi expected_replacements=1 max_bytes=4096'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "file.edit",
        arguments: {
          path: "notes/today.md",
          search: "hello",
          replace: "hi",
          expected_replacements: 1,
          max_bytes: 4096,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["file.edit"],
      allowed_capabilities: ["tool:file.edit", "fs:read", "fs:write"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit schedule.create requests with runtime automation capability", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "schedule.create",
        arguments: {
          channel: "webchat",
          target: "local-user",
          content: "runtime smoke",
          interval_ms: 120000,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["schedule.create"],
      allowed_capabilities: ["tool:schedule.create", "schedule:create"],
      timeout_ms: 5_000,
    });
  });

  it("routes structured metadata tool_call requests", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(
      inboundWithMetadata("please fetch", {
        "blue_tanuki.tool_call": {
          tool_name: "http.fetch",
          arguments: {
            url: "https://example.com",
            method: "head",
            max_bytes: "2048",
          },
        },
      }),
    );

    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload.tool_name).toBe("http.fetch");
      expect(command!.payload.arguments).toMatchObject({
        url: "https://example.com",
        method: "HEAD",
        max_bytes: 2048,
      });
    }
    expect(command!.constraints?.allowed_capabilities).toEqual([
      "tool:http.fetch",
      "network:http",
    ]);
  });

  it("routes explicit web.search requests to tool_call with network capability", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(
      inbound('tool:web.search query="blue tanuki" max_results=3 max_bytes=4096'),
    );

    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "web.search",
        arguments: {
          query: "blue tanuki",
          max_results: 3,
          max_bytes: 4096,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["web.search"],
      allowed_capabilities: ["tool:web.search", "network:http"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit github.read requests to tool_call with GitHub network capability", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound("tool:github.read resource=issues owner=gatchimuchio repo=blue-tanuki state=open max_results=3"),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "github.read",
        arguments: {
          resource: "issues",
          owner: "gatchimuchio",
          repo: "blue-tanuki",
          state: "open",
          max_results: 3,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["github.read"],
      allowed_capabilities: ["tool:github.read", "network:github.com"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit github.write requests to L3-capable tool_call constraints", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:github.write operation=issue.create owner=gatchimuchio repo=blue-tanuki title="Phase smoke" body="hello"'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "github.write",
        arguments: {
          operation: "issue.create",
          owner: "gatchimuchio",
          repo: "blue-tanuki",
          title: "Phase smoke",
          body: "hello",
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["github.write"],
      allowed_capabilities: [
        "tool:github.write",
        "network:github.com",
        "secrets:GITHUB_TOKEN",
        "github:issue.write",
        "github:pr.write",
        "github:comment.write",
      ],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit Google read requests to credential-scoped tool_call constraints", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:gmail.read query="newer_than:1d" max_results=3 max_bytes=8192'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "gmail.read",
        arguments: {
          query: "newer_than:1d",
          max_results: 3,
          max_bytes: 8192,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["gmail.read"],
      allowed_capabilities: [
        "tool:gmail.read",
        "network:googleapis.com",
        "secrets:GMAIL_ACCESS_TOKEN",
        "secrets:GOOGLE_ACCESS_TOKEN",
        "google:gmail.read",
      ],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit Google write requests to L3-capable tool_call constraints", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:google.calendar.write operation=event.create calendar_id=primary summary="Standup" start=2026-05-12T09:00:00Z end=2026-05-12T09:15:00Z max_bytes=8192'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "google.calendar.write",
        arguments: {
          operation: "event.create",
          calendar_id: "primary",
          summary: "Standup",
          start: "2026-05-12T09:00:00Z",
          end: "2026-05-12T09:15:00Z",
          max_bytes: 8192,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["google.calendar.write"],
      allowed_capabilities: [
        "tool:google.calendar.write",
        "network:googleapis.com",
        "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
        "secrets:GOOGLE_ACCESS_TOKEN",
        "google:calendar.write",
      ],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit browser.read requests to tool_call with HTTP network capability", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound("tool:browser.read url=https://example.com max_chars=4000 max_bytes=8192"),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "browser.read",
        arguments: {
          url: "https://example.com",
          max_chars: 4000,
          max_bytes: 8192,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["browser.read"],
      allowed_capabilities: ["tool:browser.read", "network:http"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit browser.snapshot requests to preview snapshot capabilities", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound("tool:browser.snapshot url=https://example.com max_chars=4000 timeout_ms=5000"),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "browser.snapshot",
        arguments: {
          url: "https://example.com",
          max_chars: 4000,
          timeout_ms: 5000,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["browser.snapshot"],
      allowed_capabilities: ["tool:browser.snapshot", "browser:snapshot", "network:http"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit browser.automation requests to L3-capable browser action constraints", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound("tool:browser.automation action=click url=https://example.com selector=#go timeout_ms=5000"),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "browser.automation",
        arguments: {
          action: "click",
          url: "https://example.com",
          selector: "#go",
          timeout_ms: 5000,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["browser.automation"],
      allowed_capabilities: ["tool:browser.automation", "browser:act", "network:http"],
      timeout_ms: 15_000,
    });
  });

  it("routes explicit shell.exec requests to final-review shell capability", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(
      inbound('tool:shell.exec {"cmd":"git","args":["status","-sb"],"cwd":".","timeout_ms":5000}'),
    );

    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("tool_call");
    if (command!.type === "tool_call") {
      expect(command!.payload).toEqual({
        tool_name: "shell.exec",
        arguments: {
          cmd: "git",
          args: ["status", "-sb"],
          cwd: ".",
          timeout_ms: 5000,
        },
      });
    }
    expect(command!.constraints).toEqual({
      allowed_tools: ["shell.exec"],
      allowed_capabilities: ["tool:shell.exec", "shell:exec"],
      timeout_ms: 15_000,
    });
  });

  it("does not send unsupported explicit tool requests to the LLM", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(inbound("tool:payment.charge amount=100"));

    expect(command).not.toBeNull();
    expect(command!.type).toBe("noop");
    if (command!.type === "noop") {
      expect(command!.payload).toMatchObject({
        reason: "unsupported tool: payment.charge",
      });
    }
  });
});

describe("HDSUpperController.resume()", () => {
  it("approve lifts SUSPEND to ASSERT and emits command", () => {
    const c = new HDSUpperController();
    const { log: log1 } = c.decide(inbound("please run rm -rf foo", "rA"));
    expect(log1.commit.decision).toBe("SUSPEND");

    const { log: log2, command } = c.resume("rA", "approve");
    expect(log2.commit.decision).toBe("ASSERT");
    expect(log2.commit.reason).toContain("human_resume:approve");
    expect(command).not.toBeNull();
    expect(c.listSuspended()).toHaveLength(0);
    expect(c.getAudit().size()).toBe(2);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("reject becomes FAIL with no command", () => {
    const c = new HDSUpperController();
    c.decide(inbound("please run rm -rf foo", "rB"));
    const { log, command } = c.resume("rB", "reject");
    expect(log.commit.decision).toBe("FAIL");
    expect(command).toBeNull();
  });

  it("block becomes OUT_OF_SCOPE with no command", () => {
    const c = new HDSUpperController();
    c.decide(inbound("please run rm -rf foo", "rC"));
    const { log, command } = c.resume("rC", "block");
    expect(log.commit.decision).toBe("OUT_OF_SCOPE");
    expect(command).toBeNull();
  });

  it("throws when resuming a non-suspended id", () => {
    const c = new HDSUpperController();
    expect(() => c.resume("nonexistent", "approve")).toThrow();
  });

  it("triggered_thresholds carries the human verdict marker", () => {
    const c = new HDSUpperController();
    c.decide(inbound("please run rm -rf foo", "rD"));
    const { log } = c.resume("rD", "approve", {
      actor: "alice",
      token_kind: "resume",
    });
    expect(log.commit.triggered_thresholds.some((t) => t.includes("human_resume"))).toBe(true);
    expect(log.resume).toEqual({
      verdict: "approve",
      actor: "alice",
      token_kind: "resume",
    });
  });

  it("returns originating request on approve so callers can route output", () => {
    const c = new HDSUpperController();
    const orig = inbound("please run rm -rf foo", "rE");
    c.decide(orig);
    const { request, command } = c.resume("rE", "approve");
    expect(request).toBeDefined();
    expect(request.id).toBe("rE");
    expect(request.user).toBe("u1");
    expect(request.channel).toBe("test");
    expect(command).not.toBeNull();
  });

  it("returns originating request on reject too (for symmetric routing)", () => {
    const c = new HDSUpperController();
    c.decide(inbound("please run rm -rf foo", "rF"));
    const { request, command } = c.resume("rF", "reject");
    expect(request.id).toBe("rF");
    expect(command).toBeNull();
  });

  it("returns originating request on block too", () => {
    const c = new HDSUpperController();
    c.decide(inbound("please run rm -rf foo", "rG"));
    const { request, command } = c.resume("rG", "block");
    expect(request.id).toBe("rG");
    expect(command).toBeNull();
  });

  it("preserves configured LLM route hints after human approve", () => {
    const c = new HDSUpperController({
      llm_route: {
        backend_hint: "careful",
        model: "review-model",
      },
    });
    c.decide(inbound("please run rm -rf foo", "r-route"));
    const { command } = c.resume("r-route", "approve");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("llm_call");
    if (command!.type === "llm_call") {
      expect(command!.payload.backend_hint).toBe("careful");
      expect(command!.payload.model).toBe("review-model");
    }
  });

  it("re-emits normalized content after human approve", () => {
    const c = new HDSUpperController();
    const raw = "please run r\u200Bm -rf foo";
    c.decide(inbound(raw, "r-resume-unicode"));

    const { log, command } = c.resume("r-resume-unicode", "approve");

    expect(log.input?.raw_content).toBe(raw);
    expect(log.input?.normalized_content).toBe("please run rm -rf foo");
    expect(command).not.toBeNull();
    expect(command!.type).toBe("llm_call");
    if (command!.type === "llm_call") {
      expect(command!.payload.messages).toEqual([
        { role: "user", content: "please run rm -rf foo" },
      ]);
    }
  });
});

describe("HDSUpperController invariants", () => {
  it("uses DEFAULT_POLICY when none is provided", () => {
    const c = new HDSUpperController();
    const { log } = c.decide(inbound("ok"));
    expect(log.frame.problem_definition_id).toBe(DEFAULT_POLICY.problem_definition_id);
  });

  it("records SUSPEND in audit before any human input", () => {
    const c = new HDSUpperController();
    c.decide(inbound("please run rm -rf foo", "r-aud"));
    const entries = c.getAudit().list();
    expect(entries).toHaveLength(1);
    expect(asDecisionLog(entries[0]!).commit.decision).toBe("SUSPEND");
  });
});

describe("HDSUpperController.onFeedback()", () => {
  it("appends executor feedback to the same audit hash-chain", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(inbound("hello feedback", "r-feedback"));
    expect(command).not.toBeNull();

    c.onFeedback(feedback(command!.id, { text: "done" }));

    const entries = c.getAudit().list();
    expect(entries).toHaveLength(2);
    expect(asDecisionLog(entries[0]!).commit.decision).toBe("ASSERT");
    const fbEntry = entries[1]!.log;
    expect("kind" in fbEntry && fbEntry.kind).toBe("executor_feedback");
    if ("kind" in fbEntry && fbEntry.kind === "executor_feedback") {
      expect(fbEntry.request_id).toBe("r-feedback");
      expect(fbEntry.command_id).toBe(command!.id);
      expect(fbEntry.known_command).toBe(true);
      expect(fbEntry.upstream_commit_hash).toBe(command!.upstream_decision.commit_hash);
      expect(fbEntry.feedback.result_present).toBe(true);
      expect(fbEntry.feedback.result_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(c.getAudit().verify()).toBe(true);
  });

  it("records unknown feedback attempts without granting authority", () => {
    const c = new HDSUpperController();
    c.onFeedback({
      command_id: "unknown-command",
      status: "failed",
      error: "stale or spoofed feedback",
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[0]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.request_id).toBeNull();
      expect(entry.known_command).toBe(false);
      expect(entry.upstream_commit_hash).toBeNull();
      expect(entry.feedback.status).toBe("failed");
    }
    expect(c.getAudit().verify()).toBe(true);
  });

  it("audit-binds tool candidates by digest without persisting their arguments", () => {
    const c = new HDSUpperController();
    const rawArgument = "candidate-argument-private-sentinel";
    c.onFeedback({
      command_id: "candidate-command",
      status: "success",
      result: { response_digest: "a".repeat(64) },
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-1",
        tool_name: "shell.exec",
        arguments: { command: rawArgument },
        authority_boundary: {
          candidate_only: true,
          may_execute: false,
          used_for_authority: false,
        },
      }],
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[0]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.feedback.llm_tool_candidate_count).toBe(1);
      expect(entry.feedback.llm_tool_candidates_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.feedback.result_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(c.getAudit().list())).not.toContain(rawArgument);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("records typed provider failure metadata without raw response text", () => {
    const c = new HDSUpperController();
    c.onFeedback({
      command_id: "timeout-command",
      status: "failed",
      error: "The provider request timed out.",
      llm_failure: {
        schema_version: "blue-tanuki.llm-failure.v1",
        kind: "timeout",
        retryable: true,
        provider: "fixture-provider",
        authority_boundary: { used_for_authority: false },
      },
      metrics: { duration_ms: 10 },
    });

    const entry = c.getAudit().list()[0]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.feedback.llm_failure).toMatchObject({ kind: "timeout", retryable: true });
    }
    expect(c.getAudit().verify()).toBe(true);
  });
});

describe("HDSUpperController long-term memory integration", () => {
  it("behaves the same when memory is omitted", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(inbound("hello memory-free", "r-no-memory"));

    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("llm_call");
    expect(c.getAudit().verify()).toBe(true);
  });

  it("captures only ASSERT decisions into memory", () => {
    const memory = new LongTermMemoryStore();
    const outOfScopePolicy: PolicyConfig = {
      problem_definition_id: "out_scope_policy",
      axes: [
        {
          name: "input_validity",
          detector: "length",
          weight: 1,
          detector_args: { min_chars: 1, max_chars: 5000 },
        },
      ],
      thresholds: {
        aggregate_assert: 2,
        out_of_scope_below: 1.1,
      },
    };

    new HDSUpperController({ memory }).decide(inbound("hello", "r-assert"));
    new HDSUpperController({ memory }).decide(inbound("please run rm -rf foo", "r-suspend"));
    new HDSUpperController({ memory }).decide(
      inbound("rm -rf / and DROP TABLE users", "r-fail"),
    );
    new HDSUpperController({ memory, policy: outOfScopePolicy }).decide(
      inbound("hello", "r-out"),
    );

    expect(memory.size()).toBe(1);
    expect(memory.all()[0]!.request_id).toBe("r-assert");
    expect(memory.verify()).toBe(true);
  });

  it("captures resume() only when human approve produces ASSERT", () => {
    const memory = {
      capture: vi.fn(() => null),
      recent: vi.fn(() => []),
    } as unknown as LongTermMemoryStore;

    const rejected = new HDSUpperController({ memory });
    rejected.decide(inbound("please run rm -rf foo", "r-reject-memory"));
    vi.mocked(memory.capture).mockClear();
    rejected.resume("r-reject-memory", "reject");
    expect(memory.capture).not.toHaveBeenCalled();

    const blocked = new HDSUpperController({ memory });
    blocked.decide(inbound("please run rm -rf foo", "r-block-memory"));
    vi.mocked(memory.capture).mockClear();
    blocked.resume("r-block-memory", "block");
    expect(memory.capture).not.toHaveBeenCalled();

    const approved = new HDSUpperController({ memory });
    approved.decide(inbound("please run rm -rf foo", "r-approve-memory"));
    vi.mocked(memory.capture).mockClear();
    approved.resume("r-approve-memory", "approve");
    expect(memory.capture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(memory.capture).mock.calls[0]![0].commit.decision).toBe("ASSERT");
  });
});


describe("HDS process / memory closure", () => {
  it("frames actor, process, and non-authority memory trace", () => {
    const memory = new LongTermMemoryStore();
    const c = new HDSUpperController({ memory });

    c.decide(inbound("hello alpha", "hds-mem-1"));
    const { log } = c.decide({
      ...inbound("continue alpha", "hds-mem-2"),
      metadata: { reference_request_id: "hds-mem-1" },
    });

    expect(log.frame.actor.actor_kind).toBe("user");
    expect(log.frame.process.process_id).toBe("chat.process");
    expect(log.frame.memory_trace.used_for_authority).toBe(false);
    expect(log.frame.memory_trace.hits.some((h) => h.memory_id === "hds-mem-1")).toBe(true);
    expect(log.frame.memory_trace.hits.some((h) => h.f_reference === "F:hds-mem-1")).toBe(true);
  });

  it("sends only the J-scoped memory candidates to C as non-authority context", () => {
    const memory = new LongTermMemoryStore();
    const c = new HDSUpperController({ memory });
    c.decide(inbound("remember alpha", "hds-search-alpha"));
    c.decide(inbound("remember beta", "hds-search-beta"));
    c.decide(inbound("remember unrelated gamma", "hds-search-gamma"));

    const { log, command } = c.decide(inbound(
      "compare F:hds-search-alpha and F:hds-search-beta",
      "hds-search-current",
    ));

    expect(command?.type).toBe("llm_call");
    expect(log.frame.memory_trace.search_plan).toMatchObject({
      purpose: "current_request_citation_context",
      request_id: "hds-search-current",
      process_id: "chat.process",
      allowed_sources: ["hds_ltm"],
      source_integrity_verified: true,
      explicit_references_requested: true,
      used_for_authority: false,
    });
    expect(log.frame.memory_trace.search_plan?.query_digest).not.toContain("compare F:");
    expect(log.frame.memory_trace.hits.map((hit) => hit.memory_id)).toContain("hds-search-gamma");
    expect(log.frame.memory_trace.hits.map((hit) => hit.memory_id)).toEqual(expect.arrayContaining([
      "hds-search-alpha",
      "hds-search-beta",
    ]));
    const messages = command!.payload.messages;
    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
    expect(messages[0]!.content).toContain("score、rank、承認、真偽の判定は出力しない");
    expect(messages[1]!.content).toContain("F:hds-search-alpha");
    expect(messages[1]!.content).toContain(log.frame.memory_trace.search_plan!.application_scope_id);
    expect(messages[1]!.content).toContain(log.frame.memory_trace.hits[0]!.entry_hash);
    expect(messages[1]!.content).not.toContain("hds-search-gamma");
    const context = JSON.parse(messages[1]!.content.slice(messages[1]!.content.indexOf("\n") + 1));
    expect(context.records.map((record: { record_id: string }) => record.record_id)).toEqual([
      "F:hds-search-alpha",
      "F:hds-search-beta",
    ]);
    expect(context.records[0].summary_difference).toMatchObject({
      included_fields: ["goal", "problem_definition_id", "abstraction"],
      omitted_source_fields: expect.arrayContaining(["closure.x", "commit.reason"]),
      semantic_difference: "not_assessed",
    });
    expect(context.records[0].summary_difference.difference_note).toContain("意味上の影響は未評価");
    expect(messages[1]!.content).not.toContain("compare F:hds-search-alpha");
    expect(log.frame.memory_trace.used_for_authority).toBe(false);
  });

  it("does not fall back to unrelated memory when an explicit F reference is unresolved", () => {
    const memory = new LongTermMemoryStore();
    const c = new HDSUpperController({ memory });
    c.decide(inbound("remember a safe candidate", "hds-unresolved-seed"));

    const { log, command } = c.decide(inbound("recall F:missing-record", "hds-unresolved-query"));
    expect(log.frame.memory_trace.search_plan?.explicit_references_requested).toBe(true);
    expect(log.frame.memory_trace.hits.length).toBeGreaterThan(0);
    expect(command?.type).toBe("llm_call");
    expect(command!.payload.messages.map((message) => message.role)).toEqual(["user"]);

    const reviewed = c.reviewMemoryCitations(command!, feedback(command!.id, JSON.stringify({
      schema_version: "blue-tanuki.memory-citation-response.v1",
      answer: "F:hds-unresolved-seedを使う回答",
      citations: [],
    })));
    const reviewedContent = typeof reviewed.result === "string"
      ? reviewed.result
      : (reviewed.result as { content: string }).content;
    expect(reviewedContent).not.toContain("F:hds-unresolved-seed");
    const audit = c.getAudit().list().map((entry) => entry.log).find((entry) =>
      "kind" in entry && entry.kind === "memory_citation_review",
    );
    expect(audit && "projection_records" in audit ? audit.projection_records ?? [] : []).toContainEqual(expect.objectContaining({
      reference: expect.objectContaining({ record_id: "F:hds-unresolved-seed" }),
      disposition: "excluded_from_context",
      reason: "explicit_reference_scope",
    }));
    expect(c.getAudit().verify()).toBe(true);
  });

  it("does not create citation candidates from a reader without verified integrity", () => {
    const source = new LongTermMemoryStore();
    new HDSUpperController({ memory: source }).decide(inbound("remember verifiable item", "unverified-source-seed"));
    const unverifiedReader = {
      capture: () => null,
      recent: (count: number) => source.recent(count),
      all: () => source.all(),
    } as unknown as LongTermMemoryStore;
    const c = new HDSUpperController({ memory: unverifiedReader });
    const { log, command } = c.decide(inbound("recall F:unverified-source-seed", "unverified-source-query"));

    expect(log.frame.memory_trace.search_plan).toMatchObject({
      source_integrity_verified: false,
      allowed_sources: [],
      used_for_authority: false,
    });
    expect(log.frame.memory_trace.hits).toEqual([]);
    expect(command?.type).toBe("llm_call");
    expect(command!.payload.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("records memory write and read references as F references without authority use", () => {
    const memory = new LongTermMemoryStore();
    const c = new HDSUpperController({ memory });

    c.decide(inbound("hello alpha", "hds-f-write"));
    const { log } = c.decide({
      ...inbound("continue from F:hds-f-write", "hds-f-read"),
      metadata: { reference_request_id: "F:hds-f-write" },
    });

    expect(memory.all()[0]!.f_reference).toBe("F:hds-f-write");
    expect(log.frame.memory_trace.hits[0]).toMatchObject({
      memory_id: "hds-f-write",
      f_reference: "F:hds-f-write",
    });
    expect(log.frame.memory_trace.used_for_authority).toBe(false);

    const memoryEvents = c.getAudit().list().filter((entry) => {
      const record = entry.log;
      return "kind" in record && record.kind === "memory_reference";
    });
    expect(memoryEvents.some((entry) => {
      const record = entry.log;
      return "kind" in record &&
        record.kind === "memory_reference" &&
        record.event === "memory.write" &&
        record.f_reference === "F:hds-f-write" &&
        record.used_for_authority === false;
    })).toBe(true);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("does not let F-references bypass Approval Gate final review", () => {
    const memory = new LongTermMemoryStore();
    const c = new HDSUpperController({ memory });

    c.decide(inbound("remember shell context", "hds-f-approval-seed"));
    const { log, command } = c.decide({
      ...inbound('tool:shell.exec {"cmd":"node","args":["-v"]}', "hds-f-approval-action"),
      metadata: { reference_request_id: "F:hds-f-approval-seed" },
    });

    const priorMemory = log.frame.memory_trace.hits.find((hit) => hit.f_reference === "F:hds-f-approval-seed");
    expect(priorMemory).toBeDefined();
    expect(priorMemory?.provenance?.source_decision).toBe("ASSERT");
    expect(priorMemory?.provenance?.source_decision_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(command?.type).toBe("tool_call");
    const approval = evaluateApproval(command!, [], {
      actor: "alice",
      now: 1,
      default_mode: "full_access",
    });
    expect(approval.context.operation).toBe("tool.shell.exec");
    expect(approval.approval_level).toBe("L3_final_review");
    expect(approval.final_review_required).toBe(true);
    expect(approval.decision).toBe("ask");
  });

  it("routes explicit tool input into tool.process", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(inbound('tool:file.search root=. query="needle"', "hds-tool-process"));
    expect(log.frame.process.process_id).toBe("tool.process");
    expect(command?.type).toBe("tool_call");
  });

  it("records authority_event after approval evaluation", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(inbound("hello approval", "hds-auth-event"));
    expect(command).not.toBeNull();
    c.onApprovalEvaluation({
      decision: "allow",
      mode: "full_access",
      risk: "low",
      reason: "test_allow",
      final_review_required: false,
      context: {
        operation: "llm.call",
        target_scope: "task_type",
        target: "llm_call",
        risk: "low",
        actor: "u1",
        capabilities: [],
        command_type: command!.type,
        command_id: command!.id,
        upstream_commit_hash: log.commit.hash,
        created_at: Date.now(),
      },
      authority_trace: {
        authority_model: "owner_operated_full_access",
        control_plane_black_boxes: [],
        black_box_boundary: "none_in_hds_authority_path",
        hds_position: "upper_control_self_norm",
        full_access_default: true,
        final_review_boundary: [],
        resolved_factors: {
          operation: "llm.call",
          target_scope: "task_type",
          risk: "low",
          actor: "u1",
          final_review_required: false,
          reason: "test_allow",
        },
        audit_closure: {
          decision: "hash_chain",
          approval: "hash_chain",
          execution_feedback: "hash_chain",
        },
      },
    });
    const kinds = c.getAudit().list().map((e) => ("kind" in e.log ? e.log.kind : "decision"));
    expect(kinds).toContain("approval_gate");
    expect(kinds).toContain("authority_event");
    expect(c.getAudit().verify()).toBe(true);
  });
});

describe("HDS process/memory authority hardening", () => {
  it("does not allow external metadata to upgrade actor authority", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(inboundWithMetadata("hello", {
      "blue_tanuki.actor_kind": "owner",
      "blue_tanuki.trust_level": "owner",
      "blue_tanuki.process_kind": "approval",
    }, "r-spoof-owner"));

    expect(log.frame.actor.actor_kind).toBe("user");
    expect(log.frame.actor.trust_level).toBe("limited");
    expect(log.frame.process.process_id).toBe("chat.process");
    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("llm_call");
  });

  it("honors gateway-internal authority context for actor/process metadata", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide(createGatewayInternalInboundRequest({
      id: "r-internal-owner",
      channel: "webchat",
      user: "u1",
      content: "approve pending",
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner",
        "blue_tanuki.process_kind": "approval",
      },
    }));

    expect(log.frame.actor.actor_kind).toBe("owner");
    expect(log.frame.process.process_id).toBe("approval.process");
    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("llm_call");
  });

  it("enforces process execution policy before emitting commands", () => {
    const c = new HDSUpperController();
    const { log, command } = c.decide({
      id: "r-webhook-no-llm",
      channel: "webhook",
      user: "hook-1",
      content: "summarize this payload",
      timestamp: Date.now(),
    });

    expect(log.frame.actor.actor_kind).toBe("webhook");
    expect(log.frame.process.process_id).toBe("webhook.process");
    expect(log.commit.decision).toBe("FAIL");
    expect(log.commit.reason).toContain("process_execution_policy_denied");
    expect(command).toBeNull();
    expect(c.getAudit().verify()).toBe(true);
  });

  it("exposes runtime invariants for the Control Center", () => {
    const c = new HDSUpperController();
    const snap = c.getRuntimeSnapshot();
    expect(snap.invariants).toEqual({
      hds_calls_llm: false,
      process_policy_enforced: true,
      external_metadata_can_escalate_authority: false,
      memory_used_for_authority: false,
      complete_history_used_for_authority: false,
      final_review_boundary_enforced_by_approval_gate: true,
    });
  });
});
