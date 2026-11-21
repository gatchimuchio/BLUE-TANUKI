import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, finalReviewRequired, HDSUpperController, operationPlanDigest,
  type HDSExecutionAuthorityBinding, type OperationPlanStatePort } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, OperationPlanCheckpointSchema, requireToolOperationDescriptor,
  type ExecuteCommand, type FileWriteTargetVersionObservation, type ShellExecTargetVersionObservation } from "@blue-tanuki/protocol";
import { createExecutorApprovalAuthority, Executor, executorCommandDigest } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { ToolRegistry, type Tool } from "../src/tools/registry.js";
import { inspectShellExecTargetVersion } from "../src/tools/shell_exec.js";

const upstream = { frame_goal: "fixture", model_abstraction: "fixture", commit_hash: "a".repeat(64),
  commit_decision: "ASSERT" as const };

function approved(authority: ReturnType<typeof createExecutorApprovalAuthority>, command: ExecuteCommand,
  targetVersionObservation?: ShellExecTargetVersionObservation | FileWriteTargetVersionObservation,
  hdsBinding?: HDSExecutionAuthorityBinding) {
  const context = approvalContextFromCommand(command, { actor: "fixture-owner" });
  const finalReview = finalReviewRequired(context);
  return authority.approve(command, {
    source: finalReview ? "human_final_review" : "approval_gate",
    decision: finalReview ? "approve" : "allow",
    approved_by: "fixture-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: context.operation,
    risk: context.risk,
    final_review_required: finalReview,
    reason: "isolated target-lock fixture",
  }, executorCommandDigest(command), hdsBinding, targetVersionObservation);
}

describe("Executor shared target resource lock", () => {
  it("rejects a stale planned file.write through the registered adapter after a competing create", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-planned-write-lock-"));
    const previousRoot = process.env.BLUE_TANUKI_FILE_ROOT;
    process.env.BLUE_TANUKI_FILE_ROOT = root;
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const activeHds: HDSUpperController[] = [];

    const makeReviewedWrite = async (id: string, content: string) => {
      const requestId = `planned-write-${id}`;
      const planId = `planned-write-plan-${id}`;
      const stepId = `planned-write-step-${id}`;
      const goal = "Create one synthetic file in the isolated target-lock fixture.";
      const plan = {
        version: "operation-core.v1" as const,
        plan_id: planId,
        request_id: requestId,
        state: "planned" as const,
        steps: [{
          step_id: stepId,
          operation: "file.write",
          target: { kind: "file" as const, id: "shared.txt" },
          state: "planned" as const,
          effects: ["write" as const],
          permission: { risk: "medium" as const, approval_level: "L2_operate" as const,
            final_review_required: false, hds_brain_authority_required: true as const, approval_gate_required: true },
          adapter: "internal_runtime" as const,
          adapter_is_authority: false as const,
          command_generated_by_adapter_only: false,
          parameters: { path: "shared.txt", content, mode: "create", max_bytes: 1024 },
          preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{
            check_id: `write-created-${id}`,
            method: "result_equals" as const,
            target: { kind: "file" as const, id: "shared.txt" },
            expected: { created: true },
          }], compensation: { available: false as const, reason: "The fixture file is isolated and disposable." } },
        }],
        rollback: { available: false },
        raw_command_policy: { raw_command_is_core_operation: false as const, command_generation_location: "not_applicable" as const },
        planner_output_used_for_authority: false as const,
        hds_brain_authority_required: true as const,
      };
      const revisionDigest = operationPlanDigest(plan);
      let checkpoint = OperationPlanCheckpointSchema.parse({
        schema_version: "operation-plan-state.v1",
        plans: [{
          owner: "fixture-owner",
          channel: "webchat",
          goal,
          request_goal_criteria: {
            status: "not_provided",
            request_id: requestId,
            content_sha256: createHash("sha256").update(goal, "utf8").digest("hex"),
            criteria: [],
            used_for_authority: false,
          },
          revisions: [{ digest: revisionDigest, plan }],
          receipt_observations: [],
          bindings: [],
          results: [],
        }],
      });
      let savedDigest: string | null = operationPlanDigest(checkpoint);
      const statePort: OperationPlanStatePort = {
        load: () => checkpoint,
        compareAndSet(expectedDigest, next) {
          if (expectedDigest !== savedDigest) throw new Error("fixture operation-plan revision changed");
          checkpoint = OperationPlanCheckpointSchema.parse(next);
          savedDigest = operationPlanDigest(checkpoint);
        },
        loadRecoveryHoldState: () => null,
        compareAndSetRecoveryHoldState() { throw new Error("not used by planned-write target fixture"); },
      };
      const hds = new HDSUpperController({ operation_plan_state: statePort });
      activeHds.push(hds);
      const request = createGatewayInternalInboundRequest({
        id: `plan-review-${id}`,
        channel: "webchat",
        user: "fixture-owner",
        content: `plan:review ${JSON.stringify({ plan_id: planId, revision_digest: revisionDigest, step_id: stepId })}`,
        timestamp: 1,
        metadata: { "blue_tanuki.operator_surface": "developer" },
      });
      const decision = hds.decide(request);
      if (decision.command?.type !== "tool_call" || decision.command.payload.tool_name !== "file.write" ||
          decision.log.commit.decision !== "ASSERT") {
        throw new Error(`fixture HDS did not issue the selected file.write command: ${decision.log.commit.reason}`);
      }
      const command = decision.command;
      const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
      if (!operationPlanBindingDigest) throw new Error("fixture file.write has no selected Operation Plan binding");
      const observation = await executors[0]!.inspectCommandTargetVersion(command, process.env,
        operationPlanBindingDigest) as FileWriteTargetVersionObservation | undefined;
      if (!observation) throw new Error("Broker did not inspect the planned file.write target");
      const hdsBinding = hds.createExecutionAuthorityBinding(command, observation);
      return { command, observation, hdsBinding };
    };

    try {
      const reviewed = await Promise.all([
        makeReviewedWrite("first", "first synthetic payload"),
        makeReviewedWrite("second", "second synthetic payload"),
      ]);
      const executions = reviewed.map((entry, index) => executors[index]!.execute(
        approved(authority, entry.command, entry.observation, entry.hdsBinding),
      ));
      const feedback = await Promise.all(executions);
      expect(feedback.map((entry) => entry.status).sort()).toEqual(["failed", "success"]);
      const rejected = feedback.find((entry) => entry.status === "failed");
      expect(JSON.stringify(rejected)).toMatch(/target version changed|planned create target must be absent/);
      const written = await fs.readFile(path.join(root, "shared.txt"), "utf8");
      const successfulIndex = feedback.findIndex((entry) => entry.status === "success");
      const successfulPayload = reviewed[successfulIndex]?.command.payload.tool_name === "file.write"
        ? reviewed[successfulIndex].command.payload.arguments.content : undefined;
      expect(written).toBe(successfulPayload);
      expect(["first synthetic payload", "second synthetic payload"]).toContain(written);
    } finally {
      activeHds.forEach((hds) => hds.close());
      if (previousRoot === undefined) delete process.env.BLUE_TANUKI_FILE_ROOT;
      else process.env.BLUE_TANUKI_FILE_ROOT = previousRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent file.write commands that resolve to the same physical target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-target-lock-"));
    const previousRoot = process.env.BLUE_TANUKI_FILE_ROOT;
    process.env.BLUE_TANUKI_FILE_ROOT = root;
    await fs.writeFile(path.join(root, "shared.txt"), "fixture", "utf8");

    let active = 0;
    let maxActive = 0;
    let started = 0;
    let notifyFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const invoke = async (): Promise<unknown> => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) {
        notifyFirstStarted();
        await firstGate;
      }
      active -= 1;
      return { completed: true };
    };
    const tool = (): Tool => ({
      name: "file.write",
      adapter_version: requireToolOperationDescriptor("file.write").adapter_version,
      description: "fixture target mutation",
      required_capabilities: requireToolOperationDescriptor("file.write").required_capabilities,
      invoke,
    });
    const tools = new ToolRegistry();
    tools.register(tool());
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const makeCommand = (id: string): ExecuteCommand => ({
      id,
      type: "tool_call",
      payload: { tool_name: "file.write", arguments: { path: "shared.txt" } },
      constraints: {
        allowed_tools: ["file.write"],
        allowed_capabilities: [...(tools.get("file.write")?.required_capabilities ?? [])],
      },
      upstream_decision: upstream,
    });
    const firstCommand = approved(authority, makeCommand("target-lock-write-1"));
    const secondCommand = approved(authority, makeCommand("target-lock-write-2"));
    let executions: Promise<unknown>[] = [];

    try {
      const firstExecution = executors[0]!.execute(firstCommand);
      const secondExecution = executors[1]!.execute(secondCommand);
      executions = [firstExecution, secondExecution];
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toBe(1);
      releaseFirst();
      const feedback = await Promise.all([firstExecution, secondExecution]);
      expect(feedback.map((entry) => entry.status)).toEqual(["success", "success"]);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.allSettled(executions);
      if (previousRoot === undefined) delete process.env.BLUE_TANUKI_FILE_ROOT;
      else process.env.BLUE_TANUKI_FILE_ROOT = previousRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes shell.exec against file mutations in the same reviewed workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-workspace-lock-"));
    const previousFileRoot = process.env.BLUE_TANUKI_FILE_ROOT;
    const previousShellRoot = process.env.BLUE_TANUKI_SHELL_ROOT;
    process.env.BLUE_TANUKI_FILE_ROOT = root;
    process.env.BLUE_TANUKI_SHELL_ROOT = root;

    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    let notifyFileStarted!: () => void;
    let releaseFile!: () => void;
    const fileStarted = new Promise<void>((resolve) => { notifyFileStarted = resolve; });
    const fileGate = new Promise<void>((resolve) => { releaseFile = resolve; });
    const invoke = (label: string, waitForFileGate = false) => async (): Promise<unknown> => {
      active += 1;
      started.push(label);
      maxActive = Math.max(maxActive, active);
      if (waitForFileGate) {
        notifyFileStarted();
        await fileGate;
      }
      if (label === "file.write") {
        try {
          await fs.writeFile(path.join(root, "shared.txt"), "updated-before-error", "utf8");
        } finally {
          active -= 1;
        }
        throw new Error("fixture adapter reported an uncertain result after changing the workspace");
      }
      active -= 1;
      return { completed: true };
    };
    let executions: Promise<unknown>[] = [];
    let activeHds: HDSUpperController | undefined;
    try {
      await fs.writeFile(path.join(root, "shared.txt"), "fixture", "utf8");
      const tools = new ToolRegistry();
      tools.register({
        name: "file.write",
        adapter_version: requireToolOperationDescriptor("file.write").adapter_version,
        description: "fixture workspace mutation",
        required_capabilities: requireToolOperationDescriptor("file.write").required_capabilities,
        invoke: invoke("file.write", true),
      });
      tools.register({
        name: "shell.exec",
        adapter_version: requireToolOperationDescriptor("shell.exec").adapter_version,
        description: "fixture workspace process",
        required_capabilities: requireToolOperationDescriptor("shell.exec").required_capabilities,
        invoke: invoke("shell.exec"),
      });

      const authority = createExecutorApprovalAuthority();
      const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
      const makeFileCommand = (id: string): ExecuteCommand => ({
        id,
        type: "tool_call",
        payload: { tool_name: "file.write", arguments: { path: "shared.txt" } },
        constraints: {
          allowed_tools: ["file.write"],
          allowed_capabilities: [...(tools.get("file.write")?.required_capabilities ?? [])],
        },
        upstream_decision: upstream,
      });
      const fileCommand = makeFileCommand("workspace-lock-file");
      activeHds = new HDSUpperController();
      const shellRequest = createGatewayInternalInboundRequest({
        id: "workspace-lock-shell-request",
        channel: "webchat",
        user: "fixture-owner",
        content: `tool:shell.exec ${JSON.stringify({ cmd: "node", args: ["-v"], cwd: ".",
          same_workspace_as_file_root: true, summary_only: true })}`,
        timestamp: 1,
        metadata: { "blue_tanuki.operator_surface": "developer" },
      });
      const shellDecision = activeHds.decide(shellRequest);
      if (shellDecision.command?.type !== "tool_call" || shellDecision.command.payload.tool_name !== "shell.exec" ||
          shellDecision.log.commit.decision !== "ASSERT") {
        throw new Error("fixture HDS did not issue the reviewed shell command");
      }
      const shellCommand = shellDecision.command;
      const shellObservation = await inspectShellExecTargetVersion(shellCommand.payload.arguments, {
        env: { ...process.env, BLUE_TANUKI_FILE_ROOT: root, BLUE_TANUKI_SHELL_ROOT: root },
        command_digest: operationPlanDigest(shellCommand),
        platform: "win32",
        isolationProviderAvailable: async () => true,
      });
      const hdsBinding = activeHds.createExecutionAuthorityBinding(shellCommand, shellObservation);
      const fileExecution = executors[0]!.execute(approved(authority, fileCommand));
      executions = [fileExecution];
      await fileStarted;
      const shellExecution = executors[1]!.execute(approved(authority, shellCommand, shellObservation, hdsBinding));
      executions.push(shellExecution);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toEqual(["file.write"]);
      releaseFile();
      const staleFeedback = await Promise.all(executions);
      expect(staleFeedback.map((entry) => entry.status)).toEqual(["failed", "failed"]);
      expect(JSON.stringify(staleFeedback[0])).toMatch(/uncertain result after changing the workspace/);
      expect(JSON.stringify(staleFeedback[1])).toMatch(/workspace version changed after review/);
      expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("updated-before-error");
      expect(started).toEqual(["file.write"]);
      expect(maxActive).toBe(1);

      const freshShellRequest = createGatewayInternalInboundRequest({
        id: "workspace-lock-shell-request-fresh",
        channel: "webchat",
        user: "fixture-owner",
        content: `tool:shell.exec ${JSON.stringify({ cmd: "node", args: ["-v"], cwd: ".",
          same_workspace_as_file_root: true, summary_only: true })}`,
        timestamp: 2,
        metadata: { "blue_tanuki.operator_surface": "developer" },
      });
      const freshShellDecision = activeHds.decide(freshShellRequest);
      if (freshShellDecision.command?.type !== "tool_call" || freshShellDecision.command.payload.tool_name !== "shell.exec" ||
          freshShellDecision.log.commit.decision !== "ASSERT") {
        throw new Error("fixture HDS did not issue the fresh reviewed shell command");
      }
      const freshShellCommand = freshShellDecision.command;
      const freshShellObservation = await inspectShellExecTargetVersion(freshShellCommand.payload.arguments, {
        env: { ...process.env, BLUE_TANUKI_FILE_ROOT: root, BLUE_TANUKI_SHELL_ROOT: root },
        command_digest: operationPlanDigest(freshShellCommand),
        platform: "win32",
        isolationProviderAvailable: async () => true,
      });
      const freshHdsBinding = activeHds.createExecutionAuthorityBinding(freshShellCommand, freshShellObservation);
      const freshShellExecution = executors[1]!.execute(
        approved(authority, freshShellCommand, freshShellObservation, freshHdsBinding),
      );
      executions = [freshShellExecution];
      const freshFeedback = await Promise.all(executions);
      expect(freshFeedback.map((entry) => entry.status)).toEqual(["success"]);
      expect(started).toEqual(["file.write", "shell.exec"]);
      expect(maxActive).toBe(1);
    } finally {
      releaseFile();
      await Promise.allSettled(executions);
      activeHds?.close();
      if (previousFileRoot === undefined) delete process.env.BLUE_TANUKI_FILE_ROOT;
      else process.env.BLUE_TANUKI_FILE_ROOT = previousFileRoot;
      if (previousShellRoot === undefined) delete process.env.BLUE_TANUKI_SHELL_ROOT;
      else process.env.BLUE_TANUKI_SHELL_ROOT = previousShellRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
