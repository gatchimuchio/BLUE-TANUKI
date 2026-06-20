import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  AuditLog,
  HDSUpperController,
  evaluateApproval,
  runStandaloneHDSBrain,
  evaluateHDSBrainHealth,
  FINAL_REVIEW_OPERATIONS,
} from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function readSourceFiles(dir: string): Array<{ rel: string; text: string }> {
    const out: Array<{ rel: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readSourceFiles(full));
      continue;
    }
    if (!/\.(ts|json)$/.test(entry.name)) continue;
      out.push({
      rel: relative(packageRoot, full).replaceAll("\\", "/"),
      text: readFileSync(full, "utf8"),
    });
  }
  return out;
}

function inbound(content: string) {
  return {
    id: "standalone-req",
    channel: "cli",
    user: "local-user",
    content,
    timestamp: 1,
    metadata: {},
  };
}

describe("HDS-BRAIN standalone boundary", () => {
  it("does not import gateway, core, channel, operator, plugin loader, or downstream clients", () => {
    const banned = [
      "apps/gateway",
      "@blue-tanuki/core",
      "@blue-tanuki/channel-",
      "@blue-tanuki/operator-",
      "plugin_loader",
      "LLMBackend",
      "browser implementation",
      "@googleapis/",
      "google-auth-library",
      "api.github.com",
    ];
    const offenders: string[] = [];
    for (const file of readSourceFiles(packageRoot)) {
      if (!file.rel.startsWith("src/") && !file.rel.startsWith("package.json")) continue;
      for (const needle of banned) {
        if (file.text.includes(needle)) offenders.push(`${file.rel}:${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports public exports in isolation and decides without gateway", () => {
    expect(typeof HDSUpperController).toBe("function");
    expect(typeof AuditLog).toBe("function");
    expect(typeof runStandaloneHDSBrain).toBe("function");
    expect(FINAL_REVIEW_OPERATIONS.has("tool.shell.exec")).toBe(true);

    const controller = new HDSUpperController();
    const result = controller.decide(inbound("hello"));

    expect(result.log.commit.decision).toBe("ASSERT");
    expect(result.command?.type).toBe("llm_call");
    expect(controller.getRuntimeSnapshot().invariants.hds_calls_llm).toBe(false);
  });

  it("runs approval evaluation and audit verification standalone", () => {
    const controller = new HDSUpperController();
    const result = controller.decide(inbound("tool:shell.exec {\"cmd\":\"git\",\"args\":[\"status\"],\"cwd\":\".\"}"));
    expect(result.command?.type).toBe("tool_call");

    const approval = evaluateApproval(result.command as ExecuteCommand, [], {
      actor: "local-user",
      now: 1,
      default_mode: "full_access",
    });
    controller.onApprovalEvaluation(approval, { request_id: "standalone-req" });

    expect(approval.context.operation).toBe("tool.shell.exec");
    expect(approval.approval_level).toBe("L3_final_review");
    expect(approval.final_review_required).toBe(true);
    expect(approval.decision).toBe("ask");
    expect(controller.getAudit().verify()).toBe(true);
  });

  it("returns a standalone harness result for ordinary LLM and explicit tool envelopes", () => {
    const llm = runStandaloneHDSBrain({
      id: "req-llm",
      channel: "cli",
      user: "local-user",
      content: "hello",
      metadata: {},
      timestamp: 1,
    });
    expect(llm.decision).toBe("ASSERT");
    expect(llm.command_type).toBe("llm_call");
    expect(llm.operation).toBe("llm.call");
    expect(llm.approval_level).toBe("L1_observe");
    expect(llm.final_review_required).toBe(false);
    expect(llm.audit_chain_valid).toBe(true);
    expect(llm.memory_used_for_authority).toBe(false);
    expect(llm.complete_history_used_for_authority).toBe(false);
    expect(llm.runtime_invariants.all_ok).toBe(true);
    expect(llm.runtime_invariants.runtime_invariants_used_for_authority).toBe(false);
    expect(llm.health.status).toBe("ok");

    const tool = runStandaloneHDSBrain({
      id: "req-tool",
      channel: "cli",
      user: "local-user",
      content: "tool:file.search root=. query=needle max_results=5",
      metadata: {},
      timestamp: 1,
    });
    expect(tool.decision).toBe("ASSERT");
    expect(tool.command_type).toBe("tool_call");
    expect(tool.operation).toBe("tool.file.search");
    expect(tool.approval_level).toBe("L1_observe");
    expect(tool.audit_chain_valid).toBe(true);
  });

  it("exposes standalone runtime health from runtime snapshot", () => {
    const snapshot = new HDSUpperController().getRuntimeSnapshot();
    const health = evaluateHDSBrainHealth(snapshot, {
      now: 1,
      required_directories: [],
      storage_paths: [],
      optional_dependencies: [],
      audit_appendable: "memory_only",
    });
    expect(health.status).toBe("ok");
    expect(health.runtime_health_observed).toBe(true);
    expect(health.hds_calls_llm).toBe(false);
    expect(health.downstream_limbs_are_authority).toBe(false);
    expect(health.fail_safe).toBe(false);
  });
});
