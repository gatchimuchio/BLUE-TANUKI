import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGatewayInternalInboundRequest,
  meaningUpdateCandidateDigest,
  type ExecuteCommand,
  type ExecuteFeedback,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import { HDSUpperController } from "../src/controller.js";
import { createFailureReviewProjection, FailureMemoryStore, failureLearningLineageReference,
  failureReviewProjectionDigest } from "../src/failure-memory/index.js";
import { AuditLog, type AuditEntry } from "../src/audit.js";
import { DEFAULT_POLICY, determineCandidateAdoptionDisposition } from "../src/policy.js";
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

function meaningUpdateProposal() {
  return {
    schema_version: "blue-tanuki.meaning-update-proposal.v1",
    record_type: "meaning_update_proposal",
    proposal_ref: "proposal-controller-001",
    candidate_ref: "candidate:001",
    candidate_digest: "c".repeat(64),
    target_ref: "memory:fact-001",
    prior_version_ref: "version:4",
    supporting_evidence: [{ reference: "evidence:support-001", digest: "d".repeat(64) }],
    counterevidence_review: {
      status: "reviewed_with_references",
      review_scope: { reference: "scope:counterevidence-001", digest: "e".repeat(64) },
      references: [{ reference: "evidence:counter-001", digest: "f".repeat(64) }],
    },
    applicability_scope: { reference: "scope:applicability-001", digest: "1".repeat(64) },
    reflection_target_ref: "reflection:goal-001",
    proposal_status: "unverified",
    adoption_status: "not_adopted",
    may_apply: false,
    used_for_authority: false,
  };
}

function contentMeaningUpdateProposal() {
  const candidateMeaning = "Synthetic HDS candidate meaning.";
  return {
    schema_version: "blue-tanuki.meaning-update-proposal.v3",
    record_type: "meaning_update_proposal",
    proposal_ref: "proposal-controller-content-001",
    candidate_ref: "candidate:content-001",
    candidate_digest: meaningUpdateCandidateDigest(candidateMeaning),
    candidate_meaning: candidateMeaning,
    target_reference: { record_id: "F:fact-001", version: "2".repeat(64) },
    prior_version_ref: "version:4",
    supporting_evidence: [{ reference: "evidence:support-001", digest: "d".repeat(64) }],
    counterevidence_review: {
      status: "reviewed_with_references",
      review_scope: { reference: "scope:counterevidence-001", digest: "e".repeat(64) },
      references: [{ reference: "evidence:counter-001", digest: "f".repeat(64) }],
    },
    applicability_scope: { reference: "scope:applicability-001", digest: "1".repeat(64) },
    reflection_target_ref: "reflection:goal-001",
    proposal_status: "unverified",
    adoption_status: "not_adopted",
    may_apply: false,
    used_for_authority: false,
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
  it("passes a trusted Gateway event's explicit session scope only to C context", () => {
    const sessionId = `cron-task:${"a".repeat(64)}`;
    const { log, command } = new HDSUpperController().decide(createGatewayInternalInboundRequest({
      id: "event-bound-session-request",
      channel: "webchat",
      user: "gateway-event",
      content: "continue from this event",
      timestamp: Date.now(),
      session_id: sessionId,
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1" },
    }));

    expect(command?.type).toBe("llm_call");
    if (!command || command.type !== "llm_call") return;
    expect(command.payload.session_id).toBe(sessionId);
    expect(JSON.stringify(log)).not.toContain(sessionId);
  });

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

  it("copies an explicit fallback grant into the HDS compute context", () => {
    const grant = {
      allowed_providers: ["backup"],
      allowed_input_sources: ["accepted_inbound_request"],
      required_capabilities: ["llm.text.generate"],
      max_total_cost: { amount: 0.5, currency: "USD" },
    };
    const controller = new HDSUpperController({
      llm_route: { fallback_authorization: grant },
    });
    grant.allowed_providers[0] = "changed-after-controller-start";

    const { command } = controller.decide(inbound("fallback fixture"));
    expect(command?.type).toBe("llm_call");
    if (command?.type === "llm_call") {
      expect(command.payload.compute_context?.fallback_authorization).toEqual({
        allowed_providers: ["backup"],
        allowed_input_sources: ["accepted_inbound_request"],
        required_capabilities: ["llm.text.generate"],
        max_total_cost: { amount: 0.5, currency: "USD" },
      });
    }
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

describe("HDS Cron no-replay disposition", () => {
  function dispositionCommand(event_id: string, payload_digest: string): ExecuteCommand {
    return {
      id: "cron-disposition-command-1",
      type: "tool_call",
      payload: {
        tool_name: "schedule.resolve_event",
        arguments: { event_id, payload_digest, disposition: "acknowledge_no_replay" },
      },
      constraints: {
        allowed_tools: ["schedule.resolve_event"],
        allowed_capabilities: ["tool:schedule.resolve_event", "schedule:resolve_event"],
      },
      upstream_decision: {
        frame_goal: "owner no-replay decision",
        model_abstraction: "test",
        commit_hash: "a".repeat(64),
        commit_decision: "ASSERT",
      },
    };
  }

  it("records only a current explicit L3 human approval in the verified HDS audit chain", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-disposition-audit-"));
    const filepath = join(root, "audit.jsonl");
    const event_id = `cron-${"a".repeat(64)}`;
    const payload_digest = "b".repeat(64);
    const command = dispositionCommand(event_id, payload_digest);
    const evaluation = evaluateApproval(command, [], { actor: "requester", default_mode: "full_access" });

    try {
      const hds = new HDSUpperController({ audit: new AuditLog({ filepath }) });
      expect(evaluation.decision).toBe("ask");
      expect(evaluation.context.operation).toBe("schedule.resolve_event");
      expect(evaluation.risk).toBe("high");
      expect(evaluation.approval_level).toBe("L3_final_review");
      hds.onApprovalEvaluation(evaluation, { request_id: "owner-request" });
      hds.onCommandLifecycle(command.id, "approval_approved", {
        actor: "owner",
        reason: "human_approval:approve",
        request_id: "owner-request",
      });

      expect(hds.acknowledgeCronEventNoReplay(command, evaluation, "owner", "owner-request")).toEqual({
        event_id,
        payload_digest,
        disposition: "acknowledge_no_replay",
      });
      expect(hds.isCronEventNoReplayAcknowledged(event_id, payload_digest)).toBe(true);
      expect(hds.isCronEventNoReplayAcknowledged(event_id, "c".repeat(64))).toBe(false);
      expect(hds.getAudit().verify()).toBe(true);
      expect(() => hds.acknowledgeCronEventNoReplay(command, evaluation, "owner", "owner-request"))
        .toThrow(/already has/);

      const restarted = new HDSUpperController({ audit: new AuditLog({ filepath }) });
      expect(restarted.isCronEventNoReplayAcknowledged(event_id, payload_digest)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an operation that lacks the matching human approval lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-disposition-audit-"));
    const filepath = join(root, "audit.jsonl");
    const command = dispositionCommand(`cron-${"d".repeat(64)}`, "e".repeat(64));
    const evaluation = evaluateApproval(command, [], { actor: "owner", default_mode: "full_access" });
    try {
      const hds = new HDSUpperController({ audit: new AuditLog({ filepath }) });
      hds.onApprovalEvaluation(evaluation, { request_id: "owner-request" });
      hds.onCommandLifecycle(command.id, "approval_approved", {
        actor: "owner",
        reason: "approval policy default",
        request_id: "owner-request",
      });

      expect(() => hds.acknowledgeCronEventNoReplay(command, evaluation, "owner", "owner-request"))
        .toThrow(/recorded human L3 approval/);
      expect(hds.isCronEventNoReplayAcknowledged(`cron-${"d".repeat(64)}`, "e".repeat(64))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not trust a bare audit marker without the matching L3 ask and human approval", () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-disposition-audit-"));
    const filepath = join(root, "audit.jsonl");
    const event_id = `cron-${"f".repeat(64)}`;
    const payload_digest = "0".repeat(64);
    const command = dispositionCommand(event_id, payload_digest);
    const evaluation = evaluateApproval(command, [], { actor: "owner", default_mode: "full_access" });
    try {
      const hds = new HDSUpperController({ audit: new AuditLog({ filepath }) });
      hds.getAudit().append({
        kind: "authority_event",
        event: "cron_event_no_replay_acknowledged",
        request_id: "owner-request",
        command_id: command.id,
        actor: "owner",
        reason: "owner_l3_approved_no_replay; original outcome remains unknown",
        operation: "schedule.resolve_event",
        risk: "high",
        authority_trace: evaluation.authority_trace,
        cron_event_id: event_id,
        cron_payload_digest: payload_digest,
        cron_disposition: "acknowledge_no_replay",
        timestamp: Date.now(),
      });

      expect(hds.isCronEventNoReplayAcknowledged(event_id, payload_digest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it("projects the original policy SUSPEND and owner resume without exposing request data", () => {
    const policy = structuredClone(DEFAULT_POLICY);
    policy.thresholds = {
      ...policy.thresholds,
      per_axis_suspend_below: { ...policy.thresholds.per_axis_suspend_below, input_validity: 2 },
    };
    const c = new HDSUpperController({ policy });
    const content = "ordinary synthetic input";
    const requestId = "r-resume-shadow-projection";
    const { log: suspended } = c.decide(inbound(content, requestId));
    expect(suspended.commit.decision).toBe("SUSPEND");

    const { log, command, runtime_kernel_j_projection } = c.resume(requestId, "approve", {
      actor: "synthetic-owner-identity",
      token_kind: "resume",
    });
    expect(log.commit.decision).toBe("ASSERT");
    expect(command).not.toBeNull();
    expect(runtime_kernel_j_projection.status).toBe("comparable");
    if (runtime_kernel_j_projection.status !== "comparable") throw new Error("resume projection unavailable");
    expect(runtime_kernel_j_projection.projection.schema_version).toBe("blue-tanuki.hds-runtime-j-projection.v6");
    expect(runtime_kernel_j_projection.projection.typescript_decision).toBe("SUSPEND");
    expect(runtime_kernel_j_projection.projection.typescript_policy_rule_id).toBe("per_axis_suspend_below");
    expect(runtime_kernel_j_projection.projection.typescript_policy_rule_axis).toBe("input_validity");
    expect(runtime_kernel_j_projection.projection.resume_transition).toEqual({
      owner_verdict: "approve",
      resume_allowed: true,
      typescript_result_decision: "ASSERT",
      command_present: true,
    });
    const encoded = JSON.stringify(runtime_kernel_j_projection.projection);
    expect(encoded).not.toContain(content);
    expect(encoded).not.toContain(requestId);
    expect(encoded).not.toContain("synthetic-owner-identity");
  });

  it("projects bounded owner-memory outcomes without adding identities or content", () => {
    const c = new HDSUpperController();
    const source = "synthetic decision content must remain private";
    const requestId = "r-memory-shadow-projection";
    const { log } = c.decide(inbound(source, requestId));
    const adoption = c.runtimeKernelJMemoryTransitionProjection(log, {
      kind: "meaning_update_adoption",
      reference_review_status: "prior_version_unverified",
      pending_reassessment_required_count: 2,
    });
    expect(adoption.status).toBe("comparable");
    if (adoption.status !== "comparable") throw new Error("memory adoption projection unavailable");
    expect(adoption.projection.schema_version).toBe("blue-tanuki.hds-runtime-j-projection.v6");
    expect(adoption.projection.memory_transition).toMatchObject({
      kind: "meaning_update_adoption",
      semantic_relation_status: "not_assessed",
      pending_reassessment_required_count: 2,
      typescript_residual_status: "meaning_unverified_with_reassessment_pending",
      used_for_authority: false,
      may_execute: false,
    });
    const reassessment = c.runtimeKernelJMemoryTransitionProjection(log, {
      kind: "memory_judgment_reassessment",
      requested_judgment_count: 2,
      reassessed_judgment_count: 2,
      remaining_reassessment_required_count: 0,
    });
    expect(reassessment.status).toBe("comparable");
    if (reassessment.status !== "comparable") throw new Error("memory reassessment projection unavailable");
    expect(reassessment.projection.memory_transition).toMatchObject({
      kind: "memory_judgment_reassessment",
      typescript_residual_status: "named_judgments_reassessed",
      used_for_authority: false,
      may_execute: false,
    });
    const encoded = JSON.stringify([adoption.projection, reassessment.projection]);
    expect(encoded).not.toContain(source);
    expect(encoded).not.toContain(requestId);
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
  it("reviews an explicit failure signature as digest-only, non-authority C feedback", () => {
    const store = new FailureMemoryStore();
    const signature = store.addSignature({
      scope: "repo",
      failure_type: "logic_drift",
      input_pattern: "FAILURE_REVIEW_RAW_GOAL_SENTINEL",
      action_pattern: "FAILURE_REVIEW_RAW_ACTION_SENTINEL",
      context_pattern: "FAILURE_REVIEW_RAW_CONTEXT_SENTINEL",
      result_pattern: "FAILURE_REVIEW_RAW_RESULT_SENTINEL",
      notes: "FAILURE_REVIEW_RAW_NOTE_SENTINEL",
    });
    const projection = createFailureReviewProjection(signature);
    const c = new HDSUpperController({ failure_memory_store: store });
    const { log, command } = c.decide(createGatewayInternalInboundRequest({
      id: "failure-review-controller-request",
      channel: "webchat",
      user: "u1",
      content: `failure:review ${signature.id}`,
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.failure_review.version": "blue-tanuki.failure-review.v1",
        "blue_tanuki.failure_review.signature_id": projection.signature_id,
        "blue_tanuki.failure_review.projection_json": JSON.stringify(projection),
      },
    }));

    expect(log.commit.decision).toBe("ASSERT");
    expect(log.memory_retrieval_suppressed_for).toBe("failure_review");
    expect(command?.type).toBe("llm_call");
    if (!command || command.type !== "llm_call") return;
    expect(command.payload.compute_context?.local_p_version).toBe("blue-tanuki.failure-review.v1");
    expect(command.payload.compute_context?.projection_digest).toBe(failureReviewProjectionDigest(projection));
    const issued = JSON.stringify(command);
    for (const sentinel of ["FAILURE_REVIEW_RAW_GOAL_SENTINEL", "FAILURE_REVIEW_RAW_ACTION_SENTINEL", "FAILURE_REVIEW_RAW_CONTEXT_SENTINEL", "FAILURE_REVIEW_RAW_RESULT_SENTINEL", "FAILURE_REVIEW_RAW_NOTE_SENTINEL"]) {
      expect(issued).not.toContain(sentinel);
    }

    const rationale = "C_ONLY_UNVERIFIED_CAUSE_RATIONALE";
    const candidate = {
      schema_version: "blue-tanuki.failure-review-candidate.v1",
      signature_id: projection.signature_id,
      signature_digest: projection.signature_digest,
      projection_digest: failureReviewProjectionDigest(projection),
      cause_hypotheses: [{ category: "logic_drift", rationale }],
      alternative_hypotheses: ["C_ONLY_ALTERNATIVE_HYPOTHESIS"],
      observation_error_hypotheses: ["C_ONLY_OBSERVATION_ERROR"],
      scope_assessment: "uncertain",
      counterexamples: ["C_ONLY_COUNTEREXAMPLE"],
      resume_conditions: ["C_ONLY_RESUME_CONDITION"],
      additional_observations: ["C_ONLY_ADDITIONAL_OBSERVATION"],
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    };
    const rawFeedback = feedback(command.id, {
      content: JSON.stringify(candidate),
      operation_core: { status: "valid_plan", plan: { planner_output_used_for_authority: false } },
    });
    const reviewed = c.reviewMemoryCitations(command, rawFeedback);
    expect(JSON.stringify(reviewed.result)).toContain(rationale);
    expect(JSON.stringify(reviewed.result)).toContain("C_ONLY_ALTERNATIVE_HYPOTHESIS");
    expect(JSON.stringify(reviewed.result)).toContain("cause_adoption");
    expect(JSON.stringify(reviewed.result)).toContain("unverified_candidate_only");

    const developmentHandoff = c.onFeedback(rawFeedback);
    expect(developmentHandoff).toMatchObject({
      candidate_kind: "runtime_learning_signal",
      candidate_content_digest: expect.any(String),
      source_state: {
        learning_action_status: "candidate_derivation_recorded",
        validity_status: "not_assessed",
        improvement_status: "not_measured",
        generalization_status: "not_assessed",
        internal_derivation_attribution_status: "not_established",
        external_change_contribution_status: "not_assessed",
        teacher_input_contribution_status: "excluded_from_c_projection",
      },
      development_status: "awaiting_development_review",
      may_promote_version: false,
      used_for_authority: false,
      may_execute: false,
    });
    expect(developmentHandoff?.candidate).toEqual(candidate);
    expect(JSON.stringify(developmentHandoff)).toContain(rationale);
    expect(JSON.stringify(developmentHandoff)).not.toContain("FAILURE_REVIEW_RAW_GOAL_SENTINEL");
    const feedbackEntry = c.getAudit().list().find((entry) => "kind" in entry.log && entry.log.kind === "executor_feedback")?.log;
    expect(feedbackEntry && "kind" in feedbackEntry && feedbackEntry.kind === "executor_feedback"
      ? feedbackEntry.feedback.failure_review : undefined).toMatchObject({
      status: "recorded",
      cause_adoption: "not_adopted",
      follow_up_required: "independent_observation",
      may_execute: false,
      used_for_authority: false,
    });
    expect(feedbackEntry && "kind" in feedbackEntry && feedbackEntry.kind === "executor_feedback"
      ? feedbackEntry.feedback.failure_learning_lineage : undefined).toMatchObject({
      status: "stored",
      learning_action_status: "candidate_derivation_recorded",
      validity_status: "not_assessed",
      improvement_status: "not_measured",
      generalization_status: "not_assessed",
      c_result_binding_status: "request_bound",
      internal_derivation_attribution_status: "not_established",
      external_change_contribution_status: "not_assessed",
      teacher_input_contribution_status: "excluded_from_c_projection",
      adoption_status: "not_adopted",
      approval_status: "not_requested",
      memory_application_status: "stored_for_future_reference",
      follow_up_action_status: "unconfirmed",
      cross_store_atomic: false,
      used_for_authority: false,
      may_execute: false,
    });
    const retainedLineages = store.listLearningLineageForSignature(signature.id);
    expect(retainedLineages).toHaveLength(1);
    expect(retainedLineages[0]).toMatchObject({
      signature_digest: projection.signature_digest,
      pre_state_digest: projection.pre_state_digest,
      experience_reference_digests: projection.evidence_log_id_digests,
      derivation_categories: ["logic_drift"],
      application_target: "failure-memory.learning-lineage.v1",
      adoption_status: "not_adopted",
      approval_status: "not_requested",
      memory_application_status: "stored_for_future_reference",
      follow_up_action_status: "unconfirmed",
    });
    expect(JSON.stringify(retainedLineages)).not.toContain(rationale);
    expect(JSON.stringify(feedbackEntry)).not.toContain(rationale);
    expect(c.getAudit().list().some((entry) => "kind" in entry.log && entry.log.kind === "operation_plan")).toBe(false);
    expect(c.getAudit().verify()).toBe(true);

    const replayProjection = createFailureReviewProjection(signature, [], "unavailable",
      retainedLineages.map(failureLearningLineageReference));
    expect(replayProjection.prior_learning_lineages).toHaveLength(1);
    expect(replayProjection.prior_learning_lineages[0]).toMatchObject({
      learning_action_status: "candidate_derivation_recorded",
      validity_status: "not_assessed",
      improvement_status: "not_measured",
      generalization_status: "not_assessed",
      external_change_contribution_status: "not_assessed",
      teacher_input_contribution_status: "excluded_from_c_projection",
    });
    const replayController = new HDSUpperController({ failure_memory_store: store });
    const replayDecision = replayController.decide(createGatewayInternalInboundRequest({
      id: "failure-review-replay-request",
      channel: "webchat",
      user: "u1",
      content: `failure:review ${signature.id}`,
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.failure_review.version": "blue-tanuki.failure-review.v1",
        "blue_tanuki.failure_review.signature_id": replayProjection.signature_id,
        "blue_tanuki.failure_review.projection_json": JSON.stringify(replayProjection),
      },
    }));
    expect(replayDecision.command?.type).toBe("llm_call");
    if (!replayDecision.command || replayDecision.command.type !== "llm_call") return;
    expect(JSON.stringify(replayDecision.command.payload.messages)).toContain("妥当性・改善・汎化");
    expect(JSON.stringify(replayDecision.command.payload.messages)).toContain("外部改修");
    expect(JSON.stringify(replayDecision.command.payload.messages)).toContain("教師入力");
    const replayCandidate = { ...candidate, projection_digest: failureReviewProjectionDigest(replayProjection) };
    const replayHandoff = replayController.onFeedback(feedback(replayDecision.command.id, { content: JSON.stringify(replayCandidate) }));
    expect(replayHandoff).toBeUndefined();
    const replayFeedbackEntry = replayController.getAudit().list().find((entry) =>
      "kind" in entry.log && entry.log.kind === "executor_feedback")?.log;
    expect(replayFeedbackEntry && "kind" in replayFeedbackEntry && replayFeedbackEntry.kind === "executor_feedback"
      ? replayFeedbackEntry.feedback.failure_learning_lineage : undefined).toMatchObject({
      status: "replayed_prior_derivation",
      learning_action_status: "candidate_derivation_recorded",
      memory_application_status: "stored_for_future_reference",
    });
    expect(replayFeedbackEntry && "kind" in replayFeedbackEntry && replayFeedbackEntry.kind === "executor_feedback"
      ? replayFeedbackEntry.feedback.failure_review : undefined).toMatchObject({
      prior_learning_lineage_digests: [retainedLineages[0]?.record_id],
      prior_learning_lineage_connection_status: "candidate_bound_to_projection",
    });
    expect(store.listLearningLineageForSignature(signature.id)).toHaveLength(1);
  });

  it("fails closed for external or malformed failure review commands", () => {
    const external = new HDSUpperController();
    const denied = external.decide(inbound("failure:review latest", "external-failure-review"));
    expect(denied.command).toBeNull();
    expect(denied.log.commit.decision).not.toBe("ASSERT");

    const malformed = new HDSUpperController();
    const invalid = malformed.decide(createGatewayInternalInboundRequest({
      id: "malformed-failure-review",
      channel: "webchat",
      user: "u1",
      content: "failure:review",
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
      },
    }));
    expect(invalid.command).toBeNull();
    expect(invalid.log.commit.decision).not.toBe("ASSERT");

    const missingSignature = new HDSUpperController().decide(createGatewayInternalInboundRequest({
      id: "missing-failure-review-signature",
      channel: "webchat",
      user: "u1",
      content: "failure:review 00000000-0000-4000-8000-000000000000",
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
      },
    }));
    expect(missingSignature.command).toBeNull();
    expect(missingSignature.log.commit.decision).not.toBe("ASSERT");
  });

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

  it("BT-U-C07.01-P: validates and digest-audits a meaning proposal without adopting it", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(createGatewayInternalInboundRequest({
      id: "r-c07-positive",
      channel: "webchat",
      user: "u1",
      content: "hello proposal",
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
      },
    }));
    expect(command?.type).toBe("llm_call");

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      meaning_update_proposal: contentMeaningUpdateProposal(),
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[1]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.feedback.meaning_update_proposal_contract_status).toBe("passed");
      expect(entry.feedback.meaning_update_proposal_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.feedback.meaning_update_proposal_reference_review.candidate_content_digest_status).toBe("verified");
      expect(entry.feedback.meaning_update_proposal_used_for_authority).toBe(false);
      expect(entry.feedback.meaning_update_proposal_applied).toBe(false);
      expect(entry.known_command).toBe(true);
    }
    const auditText = JSON.stringify(c.getAudit().list());
    expect(auditText).not.toContain("candidate:001");
    expect(auditText).not.toContain("Synthetic HDS candidate meaning.");
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C07.01-N: rejects malformed and unmatched proposals without retaining their content", () => {
    const c = new HDSUpperController();
    const rawSentinel = "C07-RAW-PROPOSAL-PRIVATE-SENTINEL";
    c.onFeedback({
      command_id: "unknown-command-c07",
      status: "success",
      meaning_update_proposal: { ...meaningUpdateProposal(), raw_candidate_text: rawSentinel },
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[0]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.feedback.meaning_update_proposal_contract_status).toBe("failed");
      expect(entry.feedback.meaning_update_proposal_digest).toBeUndefined();
      expect(entry.feedback.meaning_update_proposal_used_for_authority).toBe(false);
      expect(entry.feedback.meaning_update_proposal_applied).toBe(false);
      expect(entry.known_command).toBe(false);
    }
    expect(JSON.stringify(c.getAudit().list())).not.toContain(rawSentinel);
    expect(c.getAudit().verify()).toBe(true);

    const unmatched = new HDSUpperController();
    unmatched.onFeedback({
      command_id: "unmatched-valid-proposal-c07",
      status: "success",
      meaning_update_proposal: meaningUpdateProposal(),
      metrics: { duration_ms: 1 },
    });
    const unmatchedEntry = unmatched.getAudit().list()[0]!.log;
    if ("kind" in unmatchedEntry && unmatchedEntry.kind === "executor_feedback") {
      expect(unmatchedEntry.feedback.meaning_update_proposal_contract_status).toBe("failed");
      expect(unmatchedEntry.feedback.meaning_update_proposal_digest).toBeUndefined();
      expect(unmatchedEntry.known_command).toBe(false);
    }
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
      expect(entry.feedback.llm_tool_candidate_contract_status).toBe("passed");
      expect(entry.feedback.llm_tool_candidate_assessments).toHaveLength(1);
      expect(entry.feedback.llm_tool_candidate_assessments[0]).toMatchObject({
        candidate_origin_status: "inferred",
        mechanical_contract: { outcome: "pass", evidence_status: "observed" },
        domain_validation: { outcome: "unknown", evidence_status: "unknown" },
        semantic_judgment: { outcome: "not_assessed", evidence_status: "unknown" },
        adoption_disposition: "held",
        may_execute: false,
        used_for_authority: false,
      });
      expect(entry.feedback.result_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(c.getAudit().list())).not.toContain(rawArgument);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.01-P: separates checks and holds an allowed LLM proposal while meaning remains unknown", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(inbound("hello candidate review", "r-c06-positive"));
    expect(command?.type).toBe("llm_call");

    const rawArgument = "candidate-argument-c06-private-sentinel";
    c.onFeedback({
      command_id: command!.id,
      status: "success",
      result: { text: "done" },
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-c06-positive",
        tool_name: "echo",
        arguments: { text: rawArgument },
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }],
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[1]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.known_command).toBe(true);
      expect(entry.feedback.llm_tool_candidate_assessments[0]).toMatchObject({
        mechanical_contract: { outcome: "pass", evidence_status: "observed" },
        domain_validation: { outcome: "pass", evidence_status: "observed" },
        semantic_judgment: { outcome: "not_assessed", evidence_status: "unknown" },
        adoption_disposition: "held",
        may_execute: false,
        used_for_authority: false,
      });
    }
    expect(JSON.stringify(c.getAudit().list())).not.toContain(rawArgument);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.02-P: binds a criterion support relation to the current request and holds it while risk is unverified", () => {
    const c = new HDSUpperController();
    const rawCriterionRef = "criterion-c06-private-sentinel";
    const rawArgument = "candidate-c06-criteria-argument-sentinel";
    const { log, command } = c.decide({
      ...inbound("prepare the reviewed output", "r-c06-criteria-positive"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [{
          criterion_ref: rawCriterionRef,
          criterion_kind: "objective",
          tool_relations: [{ tool_name: "echo", relation: "supports" }],
        }],
      },
    });
    expect(command?.type).toBe("llm_call");
    expect(log.frame.candidate_goal_criteria.status).toBe("provided");
    expect(log.frame.candidate_goal_criteria.request_id).toBe(log.request_id);
    expect(log.frame.candidate_goal_criteria.used_for_authority).toBe(false);
    expect(log.frame.goal_projection.evaluation_rules).toEqual({ status: "unknown" });

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-c06-criteria-positive",
        tool_name: "echo",
        arguments: { text: rawArgument },
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }],
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[1]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.request_id).toBe(log.request_id);
      expect(entry.feedback.llm_tool_candidate_assessments[0]).toMatchObject({
        goal_criteria: {
          outcome: "supports",
          evidence_status: "assumed",
          risk_status: "unverified",
          reason_code: "request_declares_criterion_support_risk_unverified",
        },
        adoption_disposition: "held",
        may_execute: false,
        used_for_authority: false,
      });
    }
    const auditJson = JSON.stringify(c.getAudit().list());
    expect(auditJson).not.toContain(rawCriterionRef);
    expect(auditJson).not.toContain(rawArgument);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.02-N: rejects an explicit criterion conflict without score compensation", () => {
    const c = new HDSUpperController();
    const { command } = c.decide({
      ...inbound("prepare the reviewed output", "r-c06-criteria-negative"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [{
          criterion_ref: "criterion-c06-conflict",
          criterion_kind: "safety",
          tool_relations: [{ tool_name: "echo", relation: "conflicts" }],
        }],
      },
    });
    expect(command?.type).toBe("llm_call");

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-c06-criteria-negative",
        tool_name: "echo",
        arguments: { text: "safe proposal" },
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }],
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[1]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if ("kind" in entry && entry.kind === "executor_feedback") {
      expect(entry.feedback.llm_tool_candidate_assessments[0]).toMatchObject({
        goal_criteria: {
          outcome: "conflicts",
          evidence_status: "assumed",
          risk_status: "unverified",
          reason_code: "request_declares_criterion_conflict",
        },
        adoption_disposition: "rejected",
        may_execute: false,
        used_for_authority: false,
      });
    }
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.03-P: reopens only contradictory criterion scope and retains observed checks", () => {
    const c = new HDSUpperController();
    const affectedRef = "criterion-c06-skeptical-affected";
    const unaffectedRef = "criterion-c06-skeptical-unaffected";
    const rawFindingA = "skeptical-finding-private-sentinel-a";
    const rawFindingB = "skeptical-finding-private-sentinel-b";
    const rawHypothesis = "skeptical-hypothesis-private-sentinel";
    const { log, command } = c.decide({
      ...inbound("review the requested research summary", "r-c06-skeptical-positive"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [
          {
            criterion_ref: unaffectedRef,
            criterion_kind: "objective",
            tool_relations: [{ tool_name: "echo", relation: "supports" }],
          },
          {
            criterion_ref: affectedRef,
            criterion_kind: "safety",
            tool_relations: [
              { tool_name: "file.search", relation: "supports" },
              { tool_name: "unregistered.skeptical-probe", relation: "conflicts" },
            ],
          },
        ],
      },
    });
    expect(command?.type).toBe("llm_call");

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [
        {
          schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
          call_id: "call-c06-skeptical-echo",
          tool_name: "echo",
          arguments: { text: "synthetic" },
          authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
        },
        {
          schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
          call_id: "call-c06-skeptical-search",
          tool_name: "file.search",
          arguments: { root: ".", query: "synthetic", max_results: 1 },
          authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
        },
        {
          schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
          call_id: "call-c06-skeptical-unregistered",
          tool_name: "unregistered.skeptical-probe",
          arguments: { value: "synthetic" },
          authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
        },
      ],
      skeptical_review: {
        schema_version: "blue-tanuki.skeptical-review.v1",
        observation_reports: [
          { criterion_ref: affectedRef, finding: rawFindingA, relation: "supports" },
          { criterion_ref: affectedRef, finding: rawFindingB, relation: "conflicts" },
        ],
        alternative_hypotheses: [rawHypothesis],
      },
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[1]!.log;
    expect("kind" in entry && entry.kind).toBe("executor_feedback");
    if (!("kind" in entry) || entry.kind !== "executor_feedback") throw new Error("expected feedback audit");
    expect(entry.feedback.skeptical_review_contract_status).toBe("passed");
    expect(entry.feedback.skeptical_review).toMatchObject({
      status: "recorded",
      observation_claim_status: "assumed",
      affected_criterion_ref_digests: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      conflicting_report_criterion_ref_digests: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      goal_scope_returns: [{
        criterion_ref_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        scope_basis: "current_request_goal_criteria",
        criterion_kind: "safety",
        observation_report_digests: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
        reported_relations: ["conflicts", "supports"],
      }],
      alternative_hypothesis_count: 1,
      follow_up_required: "independent_observation",
      frame_correction: {
        status: "not_proposed",
        original_goal_projection_id: log.frame.goal_projection.projection_id,
        original_goal_content_sha256: log.frame.goal_projection.original_request_ref.content_sha256,
        original_goal_binding_preserved: true,
      },
      may_execute: false,
      used_for_authority: false,
    });
    expect(entry.feedback.skeptical_review?.candidate_reviews).toHaveLength(3);
    expect(entry.feedback.skeptical_review?.candidate_reviews[0]).toMatchObject({
      scope_status: "preserved",
      scope_reason_code: "no_candidate_relation_to_reported_scope",
      scope_relation_paths: [],
      prior_adoption_disposition: "held",
      review_disposition: "held",
      retained_checks: {
        mechanical_contract: { outcome: "pass", evidence_status: "observed" },
        domain_validation: { outcome: "pass", evidence_status: "observed" },
      },
    });
    expect(entry.feedback.skeptical_review?.candidate_reviews[1]).toMatchObject({
      scope_status: "affected",
      scope_reason_code: "reported_current_goal_criterion_relation",
      scope_relation_paths: [{
        criterion_ref_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        observation_report_digests: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
        relation_source: "current_request_goal_criteria",
      }],
      prior_adoption_disposition: "held",
      review_disposition: "held",
      retained_checks: {
        mechanical_contract: { outcome: "pass", evidence_status: "observed" },
        domain_validation: { outcome: "pass", evidence_status: "observed" },
      },
    });
    expect(entry.feedback.skeptical_review?.candidate_reviews[2]).toMatchObject({
      scope_status: "affected",
      scope_reason_code: "reported_current_goal_criterion_relation",
      prior_adoption_disposition: "rejected",
      review_disposition: "held",
      scope_relation_paths: [expect.objectContaining({ relation_source: "current_request_goal_criteria" })],
    });
    const auditJson = JSON.stringify(c.getAudit().list());
    expect(auditJson).not.toContain(rawFindingA);
    expect(auditJson).not.toContain(rawFindingB);
    expect(auditJson).not.toContain(rawHypothesis);
    expect(auditJson).not.toContain(affectedRef);
    expect(auditJson).not.toContain(unaffectedRef);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.03-P: previews a frame correction against the unchanged original goal binding", () => {
    const c = new HDSUpperController();
    const criterionRef = "criterion-c06-frame-correction";
    const rawFinding = "frame-correction-finding-private-sentinel";
    const rawHypothesis = "frame-correction-hypothesis-private-sentinel";
    const { log, command } = c.decide({
      ...inbound("find the required source material", "r-c06-frame-correction"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [{
          criterion_ref: criterionRef,
          criterion_kind: "objective",
          tool_relations: [{ tool_name: "file.search", relation: "conflicts" }],
        }],
      },
    });
    expect(command?.type).toBe("llm_call");

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-c06-frame-correction",
        tool_name: "file.search",
        arguments: { root: ".", query: "synthetic", max_results: 1 },
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }],
      skeptical_review: {
        schema_version: "blue-tanuki.skeptical-review.v1",
        observation_reports: [{ criterion_ref: criterionRef, finding: rawFinding, relation: "supports" }],
        alternative_hypotheses: [rawHypothesis],
        proposed_goal_criteria: {
          schema_version: "blue-tanuki.goal-criteria.v1",
          criteria: [{
            criterion_ref: "criterion-c06-proposed-unreported",
            criterion_kind: "objective",
            tool_relations: [{ tool_name: "file.search", relation: "supports" }],
          }],
        },
      },
      metrics: { duration_ms: 1 },
    });

    const entry = c.getAudit().list()[1]!.log;
    if (!("kind" in entry) || entry.kind !== "executor_feedback") throw new Error("expected feedback audit");
    expect(entry.feedback.llm_tool_candidate_assessments[0]?.adoption_disposition).toBe("rejected");
    expect(entry.feedback.skeptical_review).toMatchObject({
      status: "recorded",
      frame_correction: {
        status: "proposed_unverified",
        original_goal_projection_id: log.frame.goal_projection.projection_id,
        original_goal_content_sha256: log.frame.goal_projection.original_request_ref.content_sha256,
        original_goal_binding_preserved: true,
      },
      follow_up_required: "independent_observation",
      may_execute: false,
      used_for_authority: false,
    });
    expect(entry.feedback.skeptical_review?.candidate_reviews[0]).toMatchObject({
      scope_status: "affected",
      scope_reason_code: "reported_current_goal_criterion_relation",
      prior_adoption_disposition: "rejected",
      review_disposition: "held",
      scope_relation_paths: [expect.objectContaining({ relation_source: "current_request_goal_criteria" })],
      retained_checks: {
        mechanical_contract: { outcome: "pass", evidence_status: "observed" },
        domain_validation: { outcome: "pass", evidence_status: "observed" },
      },
    });
    expect(entry.feedback.skeptical_review?.candidate_reviews[0]).not.toHaveProperty("proposed_goal_criteria");
    const auditJson = JSON.stringify(c.getAudit().list());
    expect(auditJson).not.toContain(rawFinding);
    expect(auditJson).not.toContain(rawHypothesis);
    expect(auditJson).not.toContain(criterionRef);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.03-N: leaves all candidate checks unchanged for malformed or unmatched review input", () => {
    const c = new HDSUpperController();
    const { command } = c.decide({
      ...inbound("review the bounded task", "r-c06-skeptical-negative"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [{
          criterion_ref: "criterion-c06-known",
          criterion_kind: "objective",
          tool_relations: [{ tool_name: "echo", relation: "supports" }],
        }],
      },
    });
    const candidate = {
      schema_version: "blue-tanuki.llm-tool-call-candidate.v1" as const,
      call_id: "call-c06-skeptical-negative",
      tool_name: "echo",
      arguments: { text: "synthetic" },
      authority_boundary: { candidate_only: true as const, may_execute: false as const, used_for_authority: false as const },
    };
    const invalidFinding = "invalid-review-private-sentinel";
    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [candidate],
      skeptical_review: {
        schema_version: "blue-tanuki.skeptical-review.v1",
        observation_reports: [{ criterion_ref: "criterion-c06-known", finding: invalidFinding, relation: "supports" }],
        unexpected: true,
      },
      metrics: { duration_ms: 1 },
    } as unknown as ExecuteFeedback);
    const invalid = c.getAudit().list()[1]!.log;
    if (!("kind" in invalid) || invalid.kind !== "executor_feedback") throw new Error("expected invalid feedback audit");
    expect(invalid.feedback.skeptical_review_contract_status).toBe("failed");
    expect(invalid.feedback.skeptical_review?.status).toBe("invalid");
    expect(invalid.feedback.llm_tool_candidate_assessments[0]?.adoption_disposition).toBe("held");
    expect(JSON.stringify(c.getAudit().list())).not.toContain(invalidFinding);

    const c2 = new HDSUpperController();
    const { command: command2 } = c2.decide({
      ...inbound("review the bounded task", "r-c06-skeptical-unmatched"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [{
          criterion_ref: "criterion-c06-known",
          criterion_kind: "objective",
          tool_relations: [{ tool_name: "echo", relation: "supports" }],
        }],
      },
    });
    c2.onFeedback({
      command_id: command2!.id,
      status: "success",
      llm_tool_candidates: [candidate],
      skeptical_review: {
        schema_version: "blue-tanuki.skeptical-review.v1",
        observation_reports: [{ criterion_ref: "unmatched-criterion", finding: "synthetic", relation: "conflicts" }],
      },
      metrics: { duration_ms: 1 },
    });
    const unmatched = c2.getAudit().list()[1]!.log;
    if (!("kind" in unmatched) || unmatched.kind !== "executor_feedback") throw new Error("expected unmatched feedback audit");
    expect(unmatched.feedback.skeptical_review?.status).toBe("unmatched_scope");
    expect(unmatched.feedback.skeptical_review?.follow_up_required).toBe("none");
    expect(unmatched.feedback.skeptical_review?.candidate_reviews[0]).toMatchObject({
      scope_status: "preserved",
      prior_adoption_disposition: "held",
      review_disposition: "held",
      retained_checks: {
        mechanical_contract: { outcome: "pass", evidence_status: "observed" },
        domain_validation: { outcome: "pass", evidence_status: "observed" },
      },
    });
    expect(c.getAudit().verify()).toBe(true);
    expect(c2.getAudit().verify()).toBe(true);
  });

  it("fails closed on malformed criteria without retaining their raw payload", () => {
    const c = new HDSUpperController();
    const invalidCriteriaMarker = "invalid-criteria-private-sentinel";
    const { log, command } = c.decide({
      ...inbound("prepare the reviewed output", "r-c06-criteria-malformed"),
      goal_criteria: {
        schema_version: "blue-tanuki.goal-criteria.v1",
        criteria: [{
          criterion_ref: invalidCriteriaMarker,
          criterion_kind: "objective",
          tool_relations: [{ tool_name: "echo", relation: "supports" }],
        }],
        unexpected: true,
      },
    });

    expect(command).toBeNull();
    expect(log.commit.decision).toBe("SUSPEND");
    expect(JSON.stringify(c.getAudit().list())).not.toContain(invalidCriteriaMarker);
    expect(c.getAudit().verify()).toBe(true);
  });

  it("BT-U-C06.01-N: rejects out-of-process and malformed candidates without retaining their payload", () => {
    const c = new HDSUpperController();
    const { command } = c.decide(inbound("hello candidate rejection", "r-c06-negative"));
    const rawArgument = "candidate-c06-private-sentinel";
    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-c06-negative",
        tool_name: "unregistered.c06-probe",
        arguments: { value: rawArgument },
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }],
      metrics: { duration_ms: 1 },
    });

    const outOfScope = c.getAudit().list()[1]!.log;
    expect("kind" in outOfScope && outOfScope.kind).toBe("executor_feedback");
    if ("kind" in outOfScope && outOfScope.kind === "executor_feedback") {
      expect(outOfScope.feedback.llm_tool_candidate_assessments[0]).toMatchObject({
        domain_validation: { outcome: "fail", reason_code: "process_allowlist_mismatch" },
        adoption_disposition: "rejected",
        may_execute: false,
      });
    }

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "call-c06-malformed",
        tool_name: "echo",
        arguments: { value: rawArgument },
        authority_boundary: { candidate_only: true, may_execute: true, used_for_authority: false },
      }],
      metrics: { duration_ms: 1 },
    } as unknown as ExecuteFeedback);

    const malformed = c.getAudit().list()[2]!.log;
    expect("kind" in malformed && malformed.kind).toBe("executor_feedback");
    if ("kind" in malformed && malformed.kind === "executor_feedback") {
      expect(malformed.feedback.llm_tool_candidate_contract_status).toBe("failed");
      expect(malformed.feedback.llm_tool_candidate_assessments).toEqual([]);
      expect(malformed.feedback.llm_tool_candidates_digest).toBeUndefined();
    }

    c.onFeedback({
      command_id: command!.id,
      status: "success",
      llm_tool_candidates: ["first", "second"].map((value) => ({
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1" as const,
        call_id: "duplicate-call-c06",
        tool_name: "echo",
        arguments: { value },
        authority_boundary: { candidate_only: true as const, may_execute: false as const, used_for_authority: false as const },
      })),
      metrics: { duration_ms: 1 },
    });

    const duplicate = c.getAudit().list()[3]!.log;
    expect("kind" in duplicate && duplicate.kind).toBe("executor_feedback");
    if ("kind" in duplicate && duplicate.kind === "executor_feedback") {
      expect(duplicate.feedback.llm_tool_candidate_assessments).toHaveLength(2);
      expect(duplicate.feedback.llm_tool_candidate_assessments[0]).toMatchObject({
        mechanical_contract: { outcome: "fail", reason_code: "duplicate_call_id" },
        adoption_disposition: "rejected",
      });
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

describe("candidate adoption evidence status", () => {
  it.each([
    ["observed", "eligible_for_goal_review"],
    ["inferred", "held"],
    ["assumed", "held"],
    ["unknown", "held"],
  ] as const)("maps %s semantic evidence to %s", (status, expected) => {
    expect(determineCandidateAdoptionDisposition({
      mechanical_contract: "pass",
      domain_validation: "pass",
      semantic_outcome: "supports",
      semantic_evidence_status: status,
    })).toBe(expected);
  });

  it("rejects failed contract or domain checks and conflicting evidence", () => {
    expect(determineCandidateAdoptionDisposition({
      mechanical_contract: "fail",
      domain_validation: "pass",
      semantic_outcome: "supports",
      semantic_evidence_status: "observed",
    })).toBe("rejected");
    expect(determineCandidateAdoptionDisposition({
      mechanical_contract: "pass",
      domain_validation: "fail",
      semantic_outcome: "supports",
      semantic_evidence_status: "observed",
    })).toBe("rejected");
    expect(determineCandidateAdoptionDisposition({
      mechanical_contract: "pass",
      domain_validation: "pass",
      semantic_outcome: "conflicts",
      semantic_evidence_status: "observed",
    })).toBe("rejected");
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
      content: "Owner submitted a delegated goal purpose change for L3 review.",
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner",
        "blue_tanuki.process_kind": "approval",
        "blue_tanuki.goal_purpose_change.version": "v1",
        "blue_tanuki.tool_call": {
          tool_name: "goal.governance.change",
          arguments: {
            goal_ref: `goal_${"1".repeat(16)}`,
            prior_version: 1,
            prior_purpose_digest: "a".repeat(64),
            new_purpose_digest: "b".repeat(64),
          },
        },
      },
    }));

    expect(log.frame.actor.actor_kind).toBe("owner");
    expect(log.frame.process.process_id).toBe("approval.process");
    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("tool_call");
    if (command?.type === "tool_call") expect(command.payload.tool_name).toBe("goal.governance.change");
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
