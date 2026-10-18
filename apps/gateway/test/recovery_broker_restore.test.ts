import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, finalReviewRequired } from "@blue-tanuki/hds-brain";
import { Executor, createExecutorApprovalAuthority, ToolRegistry } from "@blue-tanuki/core";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { createRecoveryBackup } from "../src/recovery_surface.js";
import { createRecoveryMutationTools } from "../src/recovery_tools.js";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const commandKey = (id: string): string => hash(JSON.stringify(["gateway-executor-command.v1", id]));

function completedFixtureReceipt(store: GatewayExecutionIntentStore, id: string, executionEpoch: string): void {
  const now = Date.now();
  const ticket = {
    ticket_id: randomUUID(),
    command_key: commandKey(id),
    command_digest: "a".repeat(64),
    proof_digest: "b".repeat(64),
    execution_epoch: executionEpoch,
    issued_at_ms: now,
    expires_at_ms: now + 60_000,
  };
  store.issue(ticket);
  store.consume(ticket, now + 1);
  store.complete(ticket, { state: "not_attempted", feedback_status: "failed", observed_at_ms: now + 2 });
}

function activeFixtureReceipt(store: GatewayExecutionIntentStore, id: string, executionEpoch: string) {
  const now = Date.now();
  const ticket = {
    ticket_id: randomUUID(),
    command_key: commandKey(id),
    command_digest: "c".repeat(64),
    proof_digest: "d".repeat(64),
    execution_epoch: executionEpoch,
    issued_at_ms: now,
    expires_at_ms: now + 60_000,
  };
  store.issue(ticket);
  store.consume(ticket, now + 1);
  store.markInvocation(ticket, "tool_adapter", now + 2);
  return ticket;
}

function restoreCommand(backupId: string, toolCapabilities: readonly string[]): Extract<ExecuteCommand, { type: "tool_call" }> {
  return {
    id: "fixture-broker-restore-command",
    type: "tool_call",
    payload: {
      tool_name: "recovery.restore",
      arguments: { backup_id: backupId, store_key: "broker", confirm: "RESTORE" },
    },
    constraints: { allowed_tools: ["recovery.restore"], allowed_capabilities: [...toolCapabilities] },
    upstream_decision: {
      request_id: "fixture-recovery-request",
      frame_goal: "隔離fixtureのBroker復元経路を確認する",
      model_abstraction: "fixture",
      commit_hash: "fixture-restore-commit",
      commit_decision: "ASSERT",
    },
  };
}

function approval(source: ExecuteCommand) {
  const context = approvalContextFromCommand(source);
  const final_review_required = finalReviewRequired(context);
  return {
    source: final_review_required ? "human_final_review" as const : "approval_gate" as const,
    decision: final_review_required ? "approve" as const : "allow" as const,
    approved_by: "fixture-owner",
    approved_at_ms: Date.now(),
    upstream_commit_hash: source.upstream_decision.commit_hash,
    operation: context.operation,
    risk: context.risk,
    final_review_required,
    reason: "isolated-fixture",
  };
}

describe("Broker canonical snapshot restore transaction", () => {
  it("routes the active Executor receipt through the restored Broker store", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-broker-restore-"));
    const stateRoot = join(root, "state");
    const recoveryRoot = join(root, "recovery");
    const envFile = join(root, "product.env");
    const env = {
      BLUE_TANUKI_STATE_ROOT: stateRoot,
      BLUE_TANUKI_RECOVERY_DIR: recoveryRoot,
      BLUE_TANUKI_ENV_FILE: envFile,
    };
    await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
    const store = GatewayExecutionIntentStore.fromEnvironment(env);
    try {
      const backup = await createRecoveryBackup(env);
      expect(backup.backup_id).toBeTruthy();

      // Add a completed entry after the selected point; full-store restore must remove it.
      completedFixtureReceipt(store, "post-snapshot-fixture", randomUUID());

      const restoreTool = createRecoveryMutationTools(env, () => store).find((tool) => tool.name === "recovery.restore");
      expect(restoreTool).toBeDefined();
      const tools = new ToolRegistry();
      tools.register(restoreTool!);
      const epoch = randomUUID();
      const authority = createExecutorApprovalAuthority({ execution_store: store, execution_epoch: epoch });
      const executor = new Executor({
        approval_authority: authority,
        tools,
        llm: { name: "fixture", call: async () => ({ content: "fixture", model: "fixture", tokens_used: 0 }) },
      });
      const command = restoreCommand(backup.backup_id!, restoreTool!.required_capabilities ?? []);
      const approved = authority.approve(command, approval(command));

      const feedback = await executor.execute(approved);

      expect(feedback.status).toBe("success");
      expect(authority.receipt(approved)).toMatchObject({
        state: "adapter_returned",
        invocation_boundary: "tool_adapter",
        execution_epoch: epoch,
        used_for_authority: false,
      });
      expect(store.lookupCommand(commandKey("post-snapshot-fixture"))).toBeNull();
      expect(store.verifyEvents()).toBe(true);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("leaves the live Broker unchanged when another current-epoch execution is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-broker-restore-active-"));
    const live = new GatewayExecutionIntentStore(join(root, "live.sqlite"));
    const archive = new GatewayExecutionIntentStore(join(root, "selected.sqlite"));
    const epoch = randomUUID();
    try {
      archive.close();
      const other = activeFixtureReceipt(live, "other-active-fixture", epoch);
      const restore = activeFixtureReceipt(live, "restore-fixture", epoch);

      expect(() => live.restoreFromCanonicalSnapshot(
        join(root, "selected.sqlite"), restore.command_key,
      )).toThrow("broker_restore_other_current_epoch_execution_active");

      expect(live.lookup(other.ticket_id)?.state).toBe("invocation_attempted");
      expect(live.lookup(restore.ticket_id)?.state).toBe("invocation_attempted");
      expect(live.verifyEvents()).toBe(true);
    } finally {
      live.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a selected snapshot carrying unfinished work from this owner epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-broker-restore-archive-active-"));
    const archive = new GatewayExecutionIntentStore(join(root, "selected.sqlite"));
    const live = new GatewayExecutionIntentStore(join(root, "live.sqlite"));
    const epoch = randomUUID();
    try {
      activeFixtureReceipt(archive, "archived-active-fixture", epoch);
      archive.close();
      const restore = activeFixtureReceipt(live, "restore-fixture", epoch);

      expect(() => live.restoreFromCanonicalSnapshot(
        join(root, "selected.sqlite"), restore.command_key,
      )).toThrow("broker_restore_archive_current_epoch_execution_active");

      expect(live.lookup(restore.ticket_id)?.state).toBe("invocation_attempted");
      expect(live.lookupCommand(commandKey("archived-active-fixture"))).toBeNull();
      expect(live.verifyEvents()).toBe(true);
    } finally {
      try { archive.close(); } catch { /* already closed before snapshot use */ }
      live.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
