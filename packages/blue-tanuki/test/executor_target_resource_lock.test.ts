import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, finalReviewRequired, HDSUpperController, operationPlanDigest,
  AuditLog, type HDSExecutionAuthorityBinding, type OperationPlanStatePort } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, GoogleCalendarWriteTargetVersionObservationSchema,
  GoogleDriveWriteTargetVersionObservationSchema, googleDriveWriteRequestPayloadDigest,
  googleDriveWriteTargetIdentityDigest, OperationPlanCheckpointSchema, requireToolOperationDescriptor,
  type ExecuteCommand } from "@blue-tanuki/protocol";
import { createExecutorApprovalAuthority, Executor, executorCommandDigest } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { createMemoryPersonalizationStopTool } from "../src/tools/memory_personalization.js";
import { inspectFileWriteMutationTargetVersion, registerBuiltinTools } from "../src/tools/builtin.js";
import { ToolRegistry, type BrokerTargetVersionObservation, type Tool } from "../src/tools/registry.js";
import { googleCalendarCreateEventId, googleCalendarWriteRequestPayloadDigest,
  googleCalendarWriteTargetIdentityDigest } from "../src/tools/google_write.js";
import { inspectShellExecTargetVersion } from "../src/tools/shell_exec.js";
import { createSettingsWriteTool } from "../src/tools/settings_write.js";

const upstream = { frame_goal: "fixture", model_abstraction: "fixture", commit_hash: "a".repeat(64),
  commit_decision: "ASSERT" as const };

function approved(authority: ReturnType<typeof createExecutorApprovalAuthority>, command: ExecuteCommand,
  targetVersionObservation?: BrokerTargetVersionObservation,
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

  it("rejects the second direct overwrite when two reviewed commands target the same current file version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-direct-write-lock-"));
    const previousRoot = process.env.BLUE_TANUKI_FILE_ROOT;
    process.env.BLUE_TANUKI_FILE_ROOT = root;
    const hds = new HDSUpperController();
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    try {
      await fs.writeFile(path.join(root, "shared.txt"), "initial reviewed target", "utf8");
      const commands = ["candidate-first", "candidate-second"].map((content, index) => {
        const request = createGatewayInternalInboundRequest({
          id: `direct-file-write-${index + 1}`,
          channel: "webchat",
          user: "fixture-owner",
          content: `tool:file.write path=shared.txt content=${content} mode=overwrite`,
          timestamp: index + 1,
          metadata: { "blue_tanuki.operator_surface": "developer" },
        });
        const decision = hds.decide(request);
        if (decision.command?.type !== "tool_call" || decision.command.payload.tool_name !== "file.write" ||
            decision.log.commit.decision !== "ASSERT") {
          throw new Error(`fixture HDS did not issue direct file.write: ${decision.log.commit.reason}`);
        }
        return decision.command;
      });
      expect(() => hds.createExecutionAuthorityBinding(commands[0]!))
        .toThrow(/HDS file.write target version observation is required/);
      const observations = await Promise.all(commands.map(async (command) => {
        const observation = await executors[0]!.inspectCommandTargetVersion(command,
          { BLUE_TANUKI_FILE_ROOT: root });
        if (observation?.schema_version !== "blue-tanuki.file-write-target-version.v2") {
          throw new Error("Broker did not inspect direct file.write mutation target");
        }
        return observation;
      }));
      const bindings = commands.map((command, index) => hds.createExecutionAuthorityBinding(command, observations[index]));
      const executions = commands.map((command, index) => executors[index]!.execute(
        approved(authority, command, observations[index], bindings[index]),
      ));
      const feedback = await Promise.all(executions);
      expect(feedback.map((entry) => entry.status).sort()).toEqual(["failed", "success"]);
      expect(feedback.find((entry) => entry.status === "failed")?.error).toMatch(/target version changed/);
      expect(["candidate-first", "candidate-second"]).toContain(await fs.readFile(path.join(root, "shared.txt"), "utf8"));
    } finally {
      hds.close();
      if (previousRoot === undefined) delete process.env.BLUE_TANUKI_FILE_ROOT;
      else process.env.BLUE_TANUKI_FILE_ROOT = previousRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the second direct create when two reviewed commands target the same absent file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-direct-create-lock-"));
    const previousRoot = process.env.BLUE_TANUKI_FILE_ROOT;
    process.env.BLUE_TANUKI_FILE_ROOT = root;
    const hds = new HDSUpperController();
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    try {
      const commands = ["candidate-first", "candidate-second"].map((content, index) => {
        const request = createGatewayInternalInboundRequest({
          id: `direct-file-create-${index + 1}`,
          channel: "webchat",
          user: "fixture-owner",
          content: `tool:file.write path=shared.txt content=${content} mode=create`,
          timestamp: index + 1,
          metadata: { "blue_tanuki.operator_surface": "developer" },
        });
        const decision = hds.decide(request);
        if (decision.command?.type !== "tool_call" || decision.command.payload.tool_name !== "file.write" ||
            decision.log.commit.decision !== "ASSERT") {
          throw new Error(`fixture HDS did not issue direct file.write create: ${decision.log.commit.reason}`);
        }
        return decision.command;
      });
      const observations = await Promise.all(commands.map(async (command) => {
        const observation = await executors[0]!.inspectCommandTargetVersion(command,
          { BLUE_TANUKI_FILE_ROOT: root });
        if (observation?.schema_version !== "blue-tanuki.file-write-target-version.v2" ||
            observation.mode !== "create" || observation.target_state !== "absent") {
          throw new Error("Broker did not inspect the absent direct file.write create target");
        }
        return observation;
      }));
      const bindings = commands.map((command, index) => hds.createExecutionAuthorityBinding(command, observations[index]));
      expect(() => approved(authority, commands[0]!))
        .toThrow(/direct file.write requires current target version evidence/);
      const feedback = await Promise.all(commands.map((command, index) => executors[index]!.execute(
        approved(authority, command, observations[index], bindings[index]),
      )));
      expect(feedback.map((entry) => entry.status).sort()).toEqual(["failed", "success"]);
      expect(feedback.find((entry) => entry.status === "failed")?.error).toMatch(/create target must be absent|target version changed/);
      const written = await fs.readFile(path.join(root, "shared.txt"), "utf8");
      expect(["candidate-first", "candidate-second"]).toContain(written);
      expect(written).toBe(commands.find((command, index) => feedback[index]?.status === "success")?.payload.arguments.content);
    } finally {
      hds.close();
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
      payload: { tool_name: "file.write", arguments: { path: "shared.txt", content: "reviewed replacement", mode: "overwrite" } },
      constraints: {
        allowed_tools: ["file.write"],
        allowed_capabilities: [...(tools.get("file.write")?.required_capabilities ?? [])],
      },
      upstream_decision: upstream,
    });
    let executions: Promise<unknown>[] = [];

    try {
      const makeApprovedCommand = async (id: string) => {
        const command = makeCommand(id);
        const observation = await inspectFileWriteMutationTargetVersion(command.payload.arguments, {
          env: { BLUE_TANUKI_FILE_ROOT: root }, command_digest: operationPlanDigest(command),
        });
        return approved(authority, command, observation);
      };
      const firstCommand = await makeApprovedCommand("target-lock-write-1");
      const secondCommand = await makeApprovedCommand("target-lock-write-2");
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

  it("serializes Calendar mutations that resolve to the same event ID", async () => {
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
    const descriptor = requireToolOperationDescriptor("google.calendar.write");
    const tools = new ToolRegistry();
    tools.register({ name: "google.calendar.write", adapter_version: descriptor.adapter_version,
      description: "isolated Calendar target-lock fixture", required_capabilities: descriptor.required_capabilities, invoke });
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const eventObservation = {
      schema_version: "blue-tanuki.google-calendar-event-target.v3" as const,
      service: "calendar" as const,
      view: "event" as const,
      mode: "read_only" as const,
      calendar_id: "primary",
      calendar_id_original: "primary",
      event_id: "shared-event-id",
      event_state_digest: "a".repeat(64),
      event_etag_digest: "b".repeat(64),
      status: "confirmed",
      summary: "before",
      event_start: "2026-12-01T10:00:00Z",
      event_end: "2026-12-01T10:30:00Z",
      event_time_kind: "date_time" as const,
      event_time_zone: null,
      organizer_self: true,
      other_attendee_count: 0,
      attendee_inventory_complete: true as const,
      recurrence_scope: "single_event" as const,
      recurrence_rules: [],
      recurring_event_id: null,
      original_start: null,
      observed_at: new Date().toISOString(),
      observed_at_source: "client_response_received" as const,
      result_complete: true as const,
      mutation_sent: false as const,
      trust_boundary: { provider_data_is_untrusted: true as const,
        calendar_data_can_authorize_operation: false as const, used_for_authority: false as const },
    };
    const makeCommand = (id: string, summary: string): ExecuteCommand => ({
      id,
      type: "tool_call",
      payload: { tool_name: "google.calendar.write", arguments: {
        operation: "event.update", event_id: "shared-event-id", summary, event_observation: eventObservation,
      } },
      constraints: { allowed_tools: ["google.calendar.write"], allowed_capabilities: [...descriptor.required_capabilities] },
      upstream_decision: upstream,
    });
    const makeApprovedCommand = (command: ExecuteCommand) => {
      const args = command.type === "tool_call" ? command.payload.arguments : {};
      const commandDigest = operationPlanDigest(command);
      const targetVersion = GoogleCalendarWriteTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.google-calendar-write-target-version.v3",
        operation: "event.update",
        target_scope: "single_event",
        target_identity_digest: googleCalendarWriteTargetIdentityDigest(args),
        request_payload_digest: googleCalendarWriteRequestPayloadDigest(args),
        calendar_id: "primary",
        event_id: "shared-event-id",
        event_state_digest: eventObservation.event_state_digest,
        event_etag_digest: eventObservation.event_etag_digest,
        command_digest: commandDigest,
        used_for_authority: false,
        may_execute: false,
      });
      return approved(authority, command, targetVersion);
    };
    const firstCommand = makeApprovedCommand(makeCommand("calendar-lock-1", "after-first"));
    const secondCommand = makeApprovedCommand(makeCommand("calendar-lock-2", "after-second"));
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
    }
  });

  it("serializes duplicate Calendar creates by their stable provider event ID", async () => {
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
    const descriptor = requireToolOperationDescriptor("google.calendar.write");
    const tools = new ToolRegistry();
    tools.register({ name: "google.calendar.write", adapter_version: descriptor.adapter_version,
      description: "isolated Calendar create-lock fixture", required_capabilities: descriptor.required_capabilities, invoke });
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const now = Date.now();
    const eventStart = new Date(now + 60 * 60_000).toISOString();
    const eventEnd = new Date(now + 90 * 60_000).toISOString();
    const windowStart = new Date(now + 55 * 60_000).toISOString();
    const windowEnd = new Date(now + 95 * 60_000).toISOString();
    const observedAt = new Date(now).toISOString();
    const availabilityResultDigest = operationPlanDigest({ calendar_id: "primary", calendar_id_original: "primary",
      time_min: windowStart, time_max: windowEnd, time_zone: "UTC", availability_status: "observed", busy: [],
      provider_error_count: 0, result_complete: true, has_more_results: false });
    const availabilityObservation = {
      service: "calendar", view: "freebusy", mode: "read_only", calendar_id: "primary",
      calendar_id_original: "primary", time_min: windowStart, time_max: windowEnd, time_zone: "UTC",
      observed_at: observedAt, observed_at_source: "client_response_received", availability_status: "observed",
      result_complete: true, has_more_results: false, provider_error_count: 0, truncated: false, mutation_sent: false,
      busy: [], result_digest: availabilityResultDigest,
      observation_digest: operationPlanDigest({ result_digest: availabilityResultDigest, observed_at: observedAt }),
      trust_boundary: { provider_data_is_untrusted: true, availability_can_authorize_operation: false,
        used_for_authority: false },
    };
    const args = { operation: "event.create", calendar_id: "primary", summary: "stable event",
      start: eventStart, end: eventEnd, availability_observation: availabilityObservation };
    const eventId = googleCalendarCreateEventId(args);
    const makeCommand = (id: string): ExecuteCommand => ({ id, type: "tool_call",
      payload: { tool_name: "google.calendar.write", arguments: args },
      constraints: { allowed_tools: ["google.calendar.write"], allowed_capabilities: [...descriptor.required_capabilities] },
      upstream_decision: upstream });
    const makeApprovedCommand = (command: ExecuteCommand) => {
      const commandDigest = operationPlanDigest(command);
      const targetVersion = GoogleCalendarWriteTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.google-calendar-write-target-version.v3",
        operation: "event.create",
        target_identity_digest: googleCalendarWriteTargetIdentityDigest(args),
        request_payload_digest: googleCalendarWriteRequestPayloadDigest(args),
        availability_observation_digest: availabilityObservation.observation_digest,
        availability_result_digest: availabilityResultDigest,
        availability_observed_at: observedAt,
        availability_window_start: windowStart,
        availability_window_end: windowEnd,
        event_start: eventStart,
        event_end: eventEnd,
        command_digest: commandDigest,
        used_for_authority: false,
        may_execute: false,
      });
      return approved(authority, command, targetVersion);
    };
    const commands = [makeApprovedCommand(makeCommand("calendar-create-lock-1")),
      makeApprovedCommand(makeCommand("calendar-create-lock-2"))];
    let executions: Promise<unknown>[] = [];
    try {
      const pending = commands.map((command, index) => executors[index]!.execute(command));
      executions = pending;
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toBe(1);
      releaseFirst();
      const feedback = await Promise.all(pending);
      expect(feedback.map((entry) => entry.status)).toEqual(["success", "success"]);
      expect(eventId).toMatch(/^[a-f0-9]{64}$/);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.allSettled(executions);
    }
  });

  it("serializes duplicate Drive creates by their parent folder and name", async () => {
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
    const descriptor = requireToolOperationDescriptor("google.drive.write");
    const tools = new ToolRegistry();
    tools.register({ name: "google.drive.write", adapter_version: descriptor.adapter_version,
      description: "isolated Drive create-lock fixture", required_capabilities: descriptor.required_capabilities, invoke });
    const authority = createExecutorApprovalAuthority();
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const activeHds: HDSUpperController[] = [];
    const parentId = "fixture-parent-folder";
    const name = "same-name.txt";

    const makeReviewedCreate = async (id: string, content: string) => {
      const requestId = `drive-create-${id}`;
      const planId = `drive-create-plan-${id}`;
      const stepId = `drive-create-step-${id}`;
      const goal = "Create one synthetic Drive file in the isolated target-lock fixture.";
      const parameters = { operation: "file.create", parent_id: parentId, name, mime_type: "text/plain",
        content, max_bytes: 1024, max_content_bytes: 512 };
      const plan = {
        version: "operation-core.v1" as const,
        plan_id: planId,
        request_id: requestId,
        state: "planned" as const,
        steps: [{
          step_id: stepId,
          operation: "google.drive.write",
          target: { kind: "external_service" as const, id: "drive" },
          state: "planned" as const,
          effects: ["external_send" as const, "write" as const, "credential_access" as const],
          permission: { risk: "high" as const, approval_level: "L3_final_review" as const,
            final_review_required: true, hds_brain_authority_required: true as const, approval_gate_required: true },
          adapter: "external_api" as const,
          adapter_is_authority: false as const,
          command_generated_by_adapter_only: false,
          parameters,
          preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{
            check_id: `drive-created-${id}`,
            method: "result_equals" as const,
            target: { kind: "external_service" as const, id: "drive" },
            expected: { created: true },
          }],
            compensation: { available: false as const, reason: "The provider is isolated behind a fixture adapter." } },
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
        compareAndSetRecoveryHoldState() { throw new Error("not used by Drive target-lock fixture"); },
      };
      const hds = new HDSUpperController({ operation_plan_state: statePort });
      activeHds.push(hds);
      const request = createGatewayInternalInboundRequest({
        id: `drive-plan-review-${id}`,
        channel: "webchat",
        user: "fixture-owner",
        content: `plan:review ${JSON.stringify({ plan_id: planId, revision_digest: revisionDigest, step_id: stepId })}`,
        timestamp: 1,
        metadata: { "blue_tanuki.operator_surface": "developer" },
      });
      const decision = hds.decide(request);
      if (decision.command?.type !== "tool_call" || decision.command.payload.tool_name !== "google.drive.write" ||
          decision.log.commit.decision !== "ASSERT") {
        throw new Error(`fixture HDS did not issue the selected Drive create command: ${decision.log.commit.reason}`);
      }
      const command = decision.command;
      const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
      if (!operationPlanBindingDigest) throw new Error("fixture Drive create has no selected Operation Plan binding");
      const observation = GoogleDriveWriteTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.google-drive-write-target-version.v1",
        operation: "file.create",
        target_identity_digest: googleDriveWriteTargetIdentityDigest(parentId, name),
        request_payload_digest: googleDriveWriteRequestPayloadDigest({ ...parameters, parent_id: parentId, name,
          mime_type: "text/plain", max_bytes: 1024, max_content_bytes: 512 }),
        parent_folder_id: parentId,
        parent_folder_state_digest: "b".repeat(64),
        parent_access_scope_digest: "c".repeat(64),
        parent_access_scope_complete: true,
        parent_access_scope_entry_count: 1,
        target_name_absent: true,
        command_digest: operationPlanDigest(command),
        operation_plan_binding_digest: operationPlanBindingDigest,
        used_for_authority: false,
        may_execute: false,
      });
      const hdsBinding = hds.createExecutionAuthorityBinding(command, observation);
      return { command, observation, hdsBinding };
    };

    let executions: Promise<unknown>[] = [];
    try {
      const reviewed = await Promise.all([
        makeReviewedCreate("first", "first synthetic Drive payload"),
        makeReviewedCreate("second", "second synthetic Drive payload"),
      ]);
      const commands = reviewed.map((entry) => approved(authority, entry.command, entry.observation, entry.hdsBinding));
      const pending = commands.map((command, index) => executors[index]!.execute(command));
      executions = pending;
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toBe(1);
      releaseFirst();
      const feedback = await Promise.all(pending);
      expect(feedback.map((entry) => entry.status)).toEqual(["success", "success"]);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.allSettled(executions);
      activeHds.forEach((hds) => hds.close());
    }
  });

  it("serializes settings.write operations that share the Gateway settings target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-settings-target-lock-"));
    let targetStateDigest = "a".repeat(64);
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let notifyFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const port = {
      async inspect() {
        return {
          target_state_digest: targetStateDigest,
          llm_provider: "stub" as const,
          managed_llm_settings: true,
          values: {
            model: "fixture-model",
            temperature: 0.25,
            max_tokens: 512,
            timeout_ms: 30_000,
            composio: { api_key_configured: false, user_id: null, allowed_toolkits: null, allowed_actions: null,
              revoked_actions: null, api_base_url: null, dry_run: true, live_execution: false },
          },
        };
      },
      async apply(_patch: unknown, expectedTargetStateDigest: string) {
        active += 1;
        started += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 1) {
          notifyFirstStarted();
          await firstGate;
        }
        try {
          if (expectedTargetStateDigest !== targetStateDigest) throw new Error("settings_target_version_changed");
          targetStateDigest = "b".repeat(64);
          return { changed_keys: ["llm.model"], restart_required: true as const };
        } finally {
          active -= 1;
        }
      },
    };
    const tools = new ToolRegistry();
    tools.register(createSettingsWriteTool(port));
    const authority = createExecutorApprovalAuthority({ require_hds_execution_binding: true });
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const hdsInstances: HDSUpperController[] = [];
    const executions: Promise<unknown>[] = [];
    const args = { expected_llm_provider: "stub" as const, patch: { llm: { model: "fixture-model-next" } } };

    const makeOwnerRequest = (id: string, content: string) => createGatewayInternalInboundRequest({
      id,
      channel: "webchat",
      user: "webchat-owner-token-holder",
      content,
      timestamp: Date.now(),
      metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.source_interface": "gui" },
    });

    try {
      const reviewed = await Promise.all([0, 1].map(async (index) => {
        const hds = new HDSUpperController({ audit: new AuditLog({ filepath: path.join(root, `audit-${index}.jsonl`) }) });
        hdsInstances.push(hds);
        const candidate = hds.prepareSettingsWritePlan(makeOwnerRequest(`settings-origin-${index}`, "prepare owner settings"), args);
        const selection = hds.decide(makeOwnerRequest(`settings-review-${index}`, `plan:review ${JSON.stringify({
          plan_id: candidate.plan_id_digest, revision_digest: candidate.revision_digest, step_id: candidate.step_id_digest,
        })}`));
        const command = selection.command;
        if (command?.type !== "tool_call" || command.payload.tool_name !== "settings.write") {
          throw new Error(`fixture HDS did not issue settings.write: ${selection.log.commit.reason}`);
        }
        const bindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
        if (!bindingDigest) throw new Error("fixture settings.write had no Operation Plan binding");
        const observation = await executors[index]!.inspectCommandTargetVersion(command, process.env, bindingDigest);
        if (!observation) throw new Error("Broker did not observe the Gateway settings target");
        const hdsBinding = hds.createExecutionAuthorityBinding(command, observation);
        return approved(authority, command, observation, hdsBinding);
      }));

      const pending = reviewed.map((command, index) => executors[index]!.execute(command));
      executions.push(...pending);
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toBe(1);
      releaseFirst();
      const feedback = await Promise.all(pending);
      expect(feedback.map((entry) => entry.status).sort()).toEqual(["failed", "success"]);
      expect(maxActive).toBe(1);
      expect(targetStateDigest).toBe("b".repeat(64));
    } finally {
      releaseFirst();
      await Promise.allSettled(executions);
      hdsInstances.forEach((hds) => hds.close());
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes memory.personalization.stop operations that target the same retained entry", async () => {
    const entryHash = "a".repeat(64);
    const initialRevision = "b".repeat(64);
    const result = { status: "excluded" as const, entry_hash: entryHash, exclusion_digest: "c".repeat(64),
      exclusion_revision_digest: "d".repeat(64), historical_record_retained: true as const, physical_deletion: false as const,
      used_for_authority: false as const, may_execute: false as const };
    let targetAvailable = true;
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let notifyFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = {
      inspectPersonalizationTarget(requestId: string, requestedEntryHash: string) {
        if (requestId !== "memory-17" || requestedEntryHash !== entryHash) throw new Error("unexpected memory fixture target");
        return { status: targetAvailable ? "available" as const : "already_excluded" as const,
          entry_hash: targetAvailable ? entryHash : null,
          exclusion_revision_digest: targetAvailable ? initialRevision : result.exclusion_revision_digest };
      },
      stopPersonalizationUse(input: { expected_entry_hash: string; expected_exclusion_revision_digest: string }) {
        if (!targetAvailable || input.expected_entry_hash !== entryHash ||
            input.expected_exclusion_revision_digest !== initialRevision) throw new Error("memory_target_version_changed");
        targetAvailable = false;
        return result;
      },
    };
    const tool = createMemoryPersonalizationStopTool(store);
    const invoke = tool.invoke.bind(tool);
    tool.invoke = async (rawArgs, context) => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) {
        notifyFirstStarted();
        await firstGate;
      }
      try {
        return await invoke(rawArgs, context);
      } finally {
        active -= 1;
      }
    };
    const tools = new ToolRegistry();
    tools.register(tool);
    const authority = createExecutorApprovalAuthority({ require_hds_execution_binding: true });
    const executors = [0, 1].map(() => new Executor({ approval_authority: authority, tools, llm: new StubBackend() }));
    const hdsInstances: HDSUpperController[] = [];
    const executions: Promise<unknown>[] = [];
    const planId = (index: number) => `memory-stop-plan-${index}`;
    const stepId = (index: number) => `stop-personalization-${index}`;
    const goal = "Stop future personalization use of the retained synthetic entry F:memory-17.";
    const target = { kind: "settings" as const, id: "memory.personalization", scope: "F:memory-17" };

    try {
      const reviewed = await Promise.all([0, 1].map(async (index) => {
        const requestId = `memory-stop-request-${index}`;
        const plan = {
          version: "operation-core.v1" as const,
          plan_id: planId(index),
          request_id: requestId,
          state: "planned" as const,
          steps: [{
            step_id: stepId(index),
            operation: "memory.personalization.stop",
            target,
            state: "planned" as const,
            effects: ["settings_change" as const, "write" as const],
            permission: { risk: "high" as const, approval_level: "L3_final_review" as const,
              final_review_required: true, hds_brain_authority_required: true as const, approval_gate_required: true },
            adapter: "internal_runtime" as const,
            adapter_is_authority: false as const,
            command_generated_by_adapter_only: false,
            parameters: { reference: "F:memory-17", entry_hash: entryHash },
            preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{ check_id: `stop-confirmed-${index}`,
              method: "result_equals" as const, target, expected: result }],
              compensation: { available: false as const, reason: "A renewed preference requires a separate owner-reviewed operation." } },
          }],
          rollback: { available: false },
          raw_command_policy: { raw_command_is_core_operation: false as const, command_generation_location: "not_applicable" as const },
          planner_output_used_for_authority: false,
          hds_brain_authority_required: true,
        };
        const revisionDigest = operationPlanDigest(plan);
        let checkpoint = OperationPlanCheckpointSchema.parse({
          schema_version: "operation-plan-state.v1",
          plans: [{ owner: "fixture-owner", channel: "webchat", goal,
            request_goal_criteria: { status: "not_provided", request_id: requestId,
              content_sha256: createHash("sha256").update(goal, "utf8").digest("hex"), criteria: [], used_for_authority: false },
            revisions: [{ digest: revisionDigest, plan }], receipt_observations: [], bindings: [], results: [] }],
        });
        let savedDigest: string | null = operationPlanDigest(checkpoint);
        const statePort: OperationPlanStatePort = {
          load: () => checkpoint,
          compareAndSet(expectedDigest, next) {
            if (expectedDigest !== savedDigest) throw new Error("fixture Operation Plan revision changed");
            checkpoint = OperationPlanCheckpointSchema.parse(next);
            savedDigest = operationPlanDigest(checkpoint);
          },
          loadRecoveryHoldState: () => null,
          compareAndSetRecoveryHoldState() { throw new Error("not used by memory target-lock fixture"); },
        };
        const hds = new HDSUpperController({ operation_plan_state: statePort });
        hdsInstances.push(hds);
        const selection = hds.decide(createGatewayInternalInboundRequest({
          id: `memory-stop-review-${index}`,
          channel: "webchat",
          user: "fixture-owner",
          content: `plan:review ${JSON.stringify({ plan_id: planId(index), revision_digest: revisionDigest, step_id: stepId(index) })}`,
          timestamp: Date.now(),
          metadata: { "blue_tanuki.operator_surface": "developer" },
        }));
        const command = selection.command;
        if (command?.type !== "tool_call" || command.payload.tool_name !== "memory.personalization.stop") {
          throw new Error(`fixture HDS did not issue memory.personalization.stop: ${selection.log.commit.reason}`);
        }
        const bindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
        if (!bindingDigest) throw new Error("fixture memory stop had no Operation Plan binding");
        const observation = await executors[index]!.inspectCommandTargetVersion(command, process.env, bindingDigest);
        if (!observation) throw new Error("Broker did not observe the retained memory entry");
        const hdsBinding = hds.createExecutionAuthorityBinding(command, observation);
        return approved(authority, command, observation, hdsBinding);
      }));

      const pending = reviewed.map((command, index) => executors[index]!.execute(command));
      executions.push(...pending);
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(started).toBe(1);
      releaseFirst();
      const feedback = await Promise.all(pending);
      expect(feedback.map((entry) => entry.status).sort()).toEqual(["failed", "success"]);
      expect(maxActive).toBe(1);
      expect(targetAvailable).toBe(false);
      expect(result.physical_deletion).toBe(false);
    } finally {
      releaseFirst();
      await Promise.allSettled(executions);
      hdsInstances.forEach((hds) => hds.close());
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
        payload: { tool_name: "file.write", arguments: { path: "shared.txt", content: "updated-before-error", mode: "overwrite" } },
        constraints: {
          allowed_tools: ["file.write"],
          allowed_capabilities: [...(tools.get("file.write")?.required_capabilities ?? [])],
        },
        upstream_decision: upstream,
      });
      const fileCommand = makeFileCommand("workspace-lock-file");
      const fileObservation = await inspectFileWriteMutationTargetVersion(fileCommand.payload.arguments, {
        env: { BLUE_TANUKI_FILE_ROOT: root }, command_digest: operationPlanDigest(fileCommand),
      });
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
      const fileExecution = executors[0]!.execute(approved(authority, fileCommand, fileObservation));
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
