import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CompleteHistoryStore, operationPlanDigest, operationPlanTaskIdentityDigest } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointSchema } from "@blue-tanuki/protocol";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { recoveryStoreRestoreAttemptHistoryEvidence } from "../src/recovery_surface.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const maintenanceToken = "recovery-l3-maintenance-test-token";
const resumeToken = "recovery-l3-owner-resume-test-token";
const inboundToken = "recovery-l3-inbound-test-token";
const secretMarker = "LOCAL_ONLY_RECOVERY_TEST_SECRET";
const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
});

describe("Recovery mutation HDS L3 entry", () => {
  it("reconstructs a persisted operation-plan restore hold during Gateway startup and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-startup-plan-hold-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const seededPlan = seedOperationPlanState(planStatePath);
    const planIdDigest = seededPlan.plan_id_digest;
    const restoreCommand = {
      type: "tool_call",
      payload: {
        tool_name: "recovery.restore",
        arguments: { backup_id: "synthetic-backup-id", store_key: "operation_plans" },
      },
    };
    const restoreAttempt = recoveryStoreRestoreAttemptHistoryEvidence(restoreCommand);
    expect(restoreAttempt).toMatchObject({ schema_version: 1, store_key: "operation_plans" });
    const commandId = "synthetic-failed-plan-restore";
    const resultDigest = createHash("sha256").update("synthetic failed restore result").digest("hex");
    const timestamp = Date.now() - 10_000;
    const history = new CompleteHistoryStore({ filepath: historyFile });
    history.append({
      kind: "execution_history",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp,
      payload: {
        command: {
          operation: "recovery.restore",
          payload: {
            tool_name: "recovery.restore",
            arguments_digest: createHash("sha256").update("synthetic restore arguments").digest("hex"),
          },
        },
        status: "failed",
        result_present: true,
        result_digest: resultDigest,
        recovery_store_restore_attempt: restoreAttempt,
      },
    });
    history.append({
      kind: "final_output",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp: timestamp + 1,
      payload: {
        status: "failed",
        result_present: true,
        result_digest: resultDigest,
        used_for_authority: false,
      },
    });
    expect(history.verify()).toBe(true);
    expect(history.size()).toBe(2);
    expect(history.replay().every((entry) => entry.used_for_authority === false)).toBe(true);
    expect(JSON.stringify(history.replay())).not.toContain("synthetic-backup-id");

    let gateway: ReturnType<typeof spawnGateway> | undefined;
    let webSocket: WebSocket | undefined;
    let freshPlanRequestId: string | undefined;
    let freshReviewRequestId: string | undefined;
    try {
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(port, gateway);
      const firstRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(firstRuntime.body.hds.operation_plans, gateway.output.join("")).toMatchObject({
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: [{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }],
      });

      await stopChild(gateway.child);
      gateway = undefined;

      const persistedStore = new OperationPlanStateStore(planStatePath);
      try {
        const persistedHoldState = persistedStore.loadRecoveryHoldState();
        expect(persistedHoldState).toMatchObject({
          schema_version: "operation-plan-recovery-holds.v1",
          holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified",
            provenance: { source: "recovery_restore", restore_store_key: "operation_plans" } }],
          used_for_authority: false,
          may_execute: false,
        });
        expect(JSON.stringify(persistedHoldState)).not.toContain("synthetic-backup-id");
        expect(JSON.stringify(persistedHoldState)).not.toContain(commandId);
      } finally {
        persistedStore.close();
      }

      writeFileSync(historyFile, "", "utf8");
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(port, gateway);
      const restartedRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(restartedRuntime.body.hds.operation_plans.plans, gateway.output.join(""))
        .toMatchObject([{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }]);
      expect(restartedRuntime.body.operation_plan_status, gateway.output.join(""))
        .toMatchObject({
          schema_version: "operation-plan.status.v1",
          status: "available",
          used_for_authority: false,
          raw_payload_exposed: false,
          plans: [{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }],
        });
      const controlCenterResponse = await fetch(`http://127.0.0.1:${port}/`);
      expect(controlCenterResponse.status, gateway.output.join(""))
        .toBe(200);
      const controlCenterHtml = await controlCenterResponse.text();
      expect(controlCenterHtml).toContain("renderOperationPlanStatus(body.operation_plan_status)");
      expect(controlCenterHtml).toContain("復元履歴未確認（step選択停止中）");
      expect(controlCenterHtml).toContain("状態を確認後に続ける場合は、新しい依頼から新規計画を作成してください。");
      expect(controlCenterHtml).toContain('id="inspect-recovery-ledgers"');
      expect(controlCenterHtml).toContain('fetchJson("/recovery/inspection", token)');

      const recoveryInspection = await requestJson(port, "/recovery/inspection", { token: maintenanceToken });
      expect(recoveryInspection.status, gateway.output.join("")).toBe(200);
      expect(recoveryInspection.body, gateway.output.join("")).toMatchObject({
        surface: "recovery_inspection_operator",
        mode: "read_only",
        used_for_authority: false,
        may_execute: false,
        plan_dependency_scopes: expect.arrayContaining([
          expect.objectContaining({ plan_id_digest: planIdDigest }),
        ]),
      });
      const recoveryInspectionJson = JSON.stringify(recoveryInspection.body);
      expect(recoveryInspectionJson).not.toContain("restore-review-plan");
      expect(recoveryInspectionJson).not.toContain("synthetic-backup-id");

      const ticketResponse = await requestJson(port, "/ws-ticket", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner" },
      });
      expect(ticketResponse.status, JSON.stringify(ticketResponse.body)).toBe(200);
      const ticket = ticketResponse.body.ticket as string;
      webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
      await once(webSocket, "open");
      const displayedDecision = waitForWebChatSend(webSocket);

      const reviewContent = `plan:review ${JSON.stringify({
        plan_id: planIdDigest,
        revision_digest: seededPlan.revision_digest,
        step_id: "restore-review-step",
      })}`;
      const reviewRequest = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: reviewContent },
      });
      expect(reviewRequest.status, `${JSON.stringify(reviewRequest.body)}\n${gateway.output.join("")}`).toBe(202);
      const reviewRequestId = reviewRequest.body.request_id as string;
      expect(reviewRequestId).toEqual(expect.any(String));
      await waitForHistoryDecision(port, gateway, reviewRequestId);
      const userFacingDecision = await displayedDecision;
      expect(userFacingDecision).toContain("plan_control_denied:plan_recovery_unverified_hold");
      expect(userFacingDecision).toContain("Control Centerで復旧状態を読み取り確認してください。");
      expect(userFacingDecision).toContain("Recovery画面の「回復台帳を読み取り検査」を実行してください。");
      expect(userFacingDecision).toContain("新しい依頼から新規計画を作成してください。");
      expect(userFacingDecision).toContain("保留中の計画レビューは再試行しないでください。");

      const syntheticProvider = await startSyntheticPlanProvider();
      const freshPlanRuntimeEnv = {
        ...runtimeEnv,
        LLM_BACKEND: "synthetic-plan-provider",
        LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "synthetic-plan-provider",
          endpoint: syntheticProvider.endpoint,
          model: "synthetic-plan-model",
        }]),
        BLUE_TANUKI_APPROVAL_MODE: "ask_every_time",
      };
      try {
        webSocket.close();
        webSocket = undefined;
        await stopChild(gateway.child);
        gateway = undefined;
        gateway = spawnGateway(freshPlanRuntimeEnv);
        await waitForHealth(port, gateway);

        const freshTicketResponse = await requestJson(port, "/ws-ticket", {
          method: "POST",
          token: inboundToken,
          body: { user: "fixture-owner" },
        });
        expect(freshTicketResponse.status, gateway.output.join("")).toBe(200);
        webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(freshTicketResponse.body.ticket as string)}`);
        await once(webSocket, "open");

        const freshPlanReply = waitForWebChatSend(webSocket);
        const freshPlanRequest = await requestJson(port, "/operators/developer/invoke", {
          method: "POST",
          token: inboundToken,
          body: { user: "fixture-owner", content: "plan:compute synthetic fresh request after recovery hold" },
        });
        expect(freshPlanRequest.status, `${JSON.stringify(freshPlanRequest.body)}\n${gateway.output.join("")}`).toBe(202);
        freshPlanRequestId = freshPlanRequest.body.request_id as string;
        await waitForHistoryDecision(port, gateway, freshPlanRequestId);
        await freshPlanReply;

        let freshRuntime: { body: Record<string, unknown> } | undefined;
        const planDeadline = Date.now() + 5_000;
        while (Date.now() < planDeadline) {
          freshRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
          const plans = ((freshRuntime.body.hds as { operation_plans?: { plans?: Array<Record<string, unknown>> } })
            .operation_plans?.plans ?? []);
          if (plans.length === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const retainedPlans = ((freshRuntime?.body.hds as { operation_plans?: { plans?: Array<Record<string, unknown>> } })
          .operation_plans?.plans ?? []);
        expect(retainedPlans, gateway.output.join("")).toHaveLength(2);
        const heldPlan = retainedPlans.find((plan) => plan.plan_id === planIdDigest);
        const freshPlan = retainedPlans.find((plan) => plan.plan_id !== planIdDigest);
        expect(heldPlan).toMatchObject({ recovery_hold_reason: "held_unverified" });
        expect(freshPlan).toMatchObject({ request_id: `operation-request:${freshPlanRequestId}`, status: "awaiting_step_review" });

        const freshReviewRequest = await requestJson(port, "/operators/developer/invoke", {
          method: "POST",
          token: inboundToken,
          body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
            plan_id: freshPlan!.plan_id,
            revision_digest: freshPlan!.revision_digest,
            step_id: (freshPlan!.steps as Array<Record<string, unknown>>)[0]!.step_id,
          })}` },
        });
        expect(freshReviewRequest.status, `${JSON.stringify(freshReviewRequest.body)}\n${gateway.output.join("")}`).toBe(202);
        freshReviewRequestId = freshReviewRequest.body.request_id as string;
        await waitForHistoryDecision(port, gateway, freshReviewRequestId);

        const reviewedRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
        expect(reviewedRuntime.body.pending_approvals, gateway.output.join("")).toMatchObject([
          { request_id: freshReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" },
        ]);
        expect(((reviewedRuntime.body.hds as { operation_plans: { plans: Array<Record<string, unknown>> } })
          .operation_plans.plans.find((plan) => plan.plan_id === planIdDigest)))
          .toMatchObject({ recovery_hold_reason: "held_unverified" });
        expect(syntheticProvider.callCount()).toBe(1);

        const combinedRecoveryInspection = await requestJson(port, "/recovery/inspection", { token: maintenanceToken });
        expect(combinedRecoveryInspection.status, gateway.output.join("")).toBe(200);
        const inspectedPlanDigests = [planIdDigest, operationPlanDigest("fresh-request-plan")];
        expect(combinedRecoveryInspection.body).toMatchObject({
          surface: "recovery_inspection_operator",
          mode: "read_only",
          used_for_authority: false,
          may_execute: false,
          ledgers: { operation_plans: "verified" },
          operation_plan_residual_count: 0,
        });
        const inspectedPlanScopes = (combinedRecoveryInspection.body.plan_dependency_scopes as Array<Record<string, unknown>>)
          .filter((scope) => inspectedPlanDigests.includes(scope.plan_id_digest as string));
        expect(inspectedPlanScopes).toHaveLength(2);
        expect(inspectedPlanScopes).toEqual(expect.arrayContaining([
          expect.objectContaining({
            plan_id_digest: planIdDigest,
            status: "observed",
            integrity: "verified",
            residual_dependencies: [],
            unobserved_dependencies: [],
          }),
          expect.objectContaining({
            plan_id_digest: operationPlanDigest("fresh-request-plan"),
            status: "observed",
            integrity: "verified",
            residual_dependencies: [],
            unobserved_dependencies: [],
          }),
        ]));
        expect(JSON.stringify(combinedRecoveryInspection.body)).not.toContain("restore-review-plan");
        expect(JSON.stringify(combinedRecoveryInspection.body)).not.toContain("fresh-request-plan");

        const planInspectionStore = new OperationPlanStateStore(planStatePath);
        try {
          const currentCheckpoint = planInspectionStore.load();
          if (!currentCheckpoint) throw new Error("Operation Plan checkpoint disappeared during the test");
          const damagedCheckpoint = OperationPlanCheckpointSchema.parse({
            ...currentCheckpoint,
            plans: currentCheckpoint.plans.map((planState) => planState.revisions[0]?.plan.plan_id !== "restore-review-plan"
              ? planState
              : {
                  ...planState,
                  revisions: planState.revisions.map((revision, index) => index === 0
                    ? { ...revision, digest: operationPlanDigest("synthetic-damaged-old-plan-revision") }
                    : revision),
                }),
          });
          planInspectionStore.compareAndSet(operationPlanDigest(currentCheckpoint), damagedCheckpoint);
          expect(planInspectionStore.loadRecoveryHoldState()).toMatchObject({
            holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified" }],
            used_for_authority: false,
            may_execute: false,
          });
        } finally {
          planInspectionStore.close();
        }

        const residualInspection = await requestJson(port, "/recovery/inspection", { token: maintenanceToken });
        expect(residualInspection.status, gateway.output.join("")).toBe(200);
        expect(residualInspection.body).toMatchObject({
          ledgers: { operation_plans: "residuals_present" },
          operation_plan_residual_count: 1,
          used_for_authority: false,
          may_execute: false,
        });
        const residualPlanScopes = (residualInspection.body.plan_dependency_scopes as Array<Record<string, unknown>>)
          .filter((scope) => inspectedPlanDigests.includes(scope.plan_id_digest as string));
        expect(residualPlanScopes).toHaveLength(2);
        expect(residualPlanScopes).toEqual(expect.arrayContaining([
          expect.objectContaining({
            plan_id_digest: planIdDigest,
            status: "residuals_present",
            integrity: "residuals_present",
            residual_dependencies: ["operation_plan"],
          }),
          expect.objectContaining({
            plan_id_digest: operationPlanDigest("fresh-request-plan"),
            status: "observed",
            integrity: "verified",
            residual_dependencies: [],
            unobserved_dependencies: [],
          }),
        ]));
        expect(JSON.stringify(residualInspection.body)).not.toContain("restore-review-plan");
        expect(JSON.stringify(residualInspection.body)).not.toContain("fresh-request-plan");
      } finally {
        await syntheticProvider.close();
      }

      await stopChild(gateway.child);
      gateway = undefined;

      const reviewHistory = new CompleteHistoryStore({ filepath: historyFile });
      const reviewDecisions = reviewHistory.replay({ kind: "hds_decision", request_id: reviewRequestId });
      expect(reviewDecisions).toHaveLength(1);
      expect(reviewDecisions[0]?.payload).toMatchObject({
        decision: "FAIL",
        reason: "plan_control_denied:plan_recovery_unverified_hold",
        command: null,
      });
      const reviewExecution = reviewHistory.replay({ kind: "execution_history", request_id: reviewRequestId });
      expect(reviewExecution).toHaveLength(0);

      const freshPlanHistory = reviewHistory.replay({ kind: "hds_decision", request_id: freshPlanRequestId! });
      expect(freshPlanHistory).toHaveLength(1);
      const freshReviewHistory = reviewHistory.replay({ kind: "hds_decision", request_id: freshReviewRequestId! });
      expect(freshReviewHistory).toHaveLength(1);
      const freshReviewExecution = reviewHistory.replay({ kind: "execution_history", request_id: freshReviewRequestId! });
      expect(freshReviewExecution).toHaveLength(0);

      const restartedStore = new OperationPlanStateStore(planStatePath);
      try {
        expect(restartedStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: planIdDigest, reason: "held_unverified",
            provenance: { source: "recovery_restore", restore_store_key: "operation_plans" } }],
          used_for_authority: false,
          may_execute: false,
        });
        expect(restartedStore.load()?.plans.map((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id)))
          .toEqual(expect.arrayContaining([planIdDigest, operationPlanDigest("fresh-request-plan")]));
      } finally {
        restartedStore.close();
      }
    } finally {
      webSocket?.close();
      if (gateway) await stopChild(gateway.child);
    }
  }, 30_000);

  it("reconstructs a failed Broker restore as a fail-closed Operation Plan hold during Gateway startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-startup-broker-hold-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const seededPlan = seedOperationPlanState(planStatePath);
    const restoreCommand = {
      type: "tool_call",
      payload: { tool_name: "recovery.restore", arguments: { backup_id: "synthetic-broker-backup", store_key: "broker" } },
    };
    const restoreAttempt = recoveryStoreRestoreAttemptHistoryEvidence(restoreCommand);
    expect(restoreAttempt).toMatchObject({ schema_version: 1, store_key: "broker" });
    const commandId = "synthetic-failed-broker-restore";
    const resultDigest = createHash("sha256").update("synthetic failed Broker restore result").digest("hex");
    const timestamp = Date.now() - 10_000;
    const history = new CompleteHistoryStore({ filepath: historyFile });
    history.append({
      kind: "execution_history",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp,
      payload: {
        command: {
          operation: "recovery.restore",
          payload: { tool_name: "recovery.restore", arguments_digest: createHash("sha256")
            .update("synthetic Broker restore arguments").digest("hex") },
        },
        status: "failed",
        result_present: true,
        result_digest: resultDigest,
        recovery_store_restore_attempt: restoreAttempt,
      },
    });
    history.append({
      kind: "final_output",
      command_id: commandId,
      actor: "synthetic-test-fixture",
      source: "recovery-startup-test",
      timestamp: timestamp + 1,
      payload: { status: "failed", result_present: true, result_digest: resultDigest, used_for_authority: false },
    });
    expect(history.verify()).toBe(true);

    let gateway: ReturnType<typeof spawnGateway> | undefined;
    try {
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(port, gateway);
      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(runtime.body.hds.operation_plans.plans, gateway.output.join("")).toMatchObject([
        { plan_id: seededPlan.plan_id_digest, recovery_hold_reason: "held_unverified" },
      ]);
      const persistedStore = new OperationPlanStateStore(planStatePath);
      try {
        expect(persistedStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: seededPlan.plan_id_digest, reason: "held_unverified",
            provenance: { source: "recovery_restore", restore_store_key: "broker" } }],
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        persistedStore.close();
      }
    } finally {
      if (gateway) await stopChild(gateway.child);
    }
  }, 30_000);

  it("quiesces, restores, reopens, and reobserves the Cron event store under L3", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-restore-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = {
      ...isolatedRuntimeEnvironment(root, envFile, historyFile, port),
      BLUE_TANUKI_SCHEDULES_JSON: JSON.stringify([{
        id: "cron-restore-test",
        channel: "webchat",
        target: "local-user",
        content: "synthetic scheduled message",
        interval_ms: 60_000,
      }]),
    };
    const event = createCronEventIdentity(
      "cron:restore-test:seed",
      1,
      createHash("sha256").update("synthetic cron recovery fixture").digest("hex"),
    );
    const seededStore = GatewayCronEventStore.fromEnvironment(runtimeEnv);
    expect(seededStore.claim(event, 100)).toEqual({ status: "accepted" });
    seededStore.settle(event, "handler_returned", 200);
    seededStore.close();

    const gateway = spawnGateway(runtimeEnv);
    let gatewayStopped = false;
    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;

      const queued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: { backup_id: backupId, store_key: "cron_events", confirm: "RESTORE" },
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.restore",
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });

      const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const pending = (approvalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.operation === "recovery.restore");
      expect(pending).toMatchObject({ risk: "high", approval_level: "L3_final_review", final_review_required: true });
      const commandId = pending?.command_id as string;
      const approvalToken = pending?.approval_token as string;
      const approved = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: approvalToken },
      });
      expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approved.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(runtime.body.scheduled_tasks, gateway.output.join(""))
        .toMatchObject([{ id: "cron-restore-test", running: true, recovery_hold: null }]);
      await stopChild(gateway);
      children.delete(gateway);
      gatewayStopped = true;
    } finally {
      if (!gatewayStopped) {
        await stopChild(gateway);
        children.delete(gateway);
      }
    }
  }, 30_000);

  it("quiesces J/M and meaning-update consumers for selected restore, verifies reopened stores, and keeps existing plans held", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-jm-restore-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const planIdDigest = seedOperationPlanState(planStatePath).plan_id_digest;
    const gateway = spawnGateway(runtimeEnv);
    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", { method: "POST", token: maintenanceToken, body: {} });
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;
      for (const store_key of ["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state"] as const) {
        const queued = await requestJson(port, "/recovery/restore", {
          method: "POST",
          token: maintenanceToken,
          body: { backup_id: backupId, store_key, confirm: "RESTORE" },
        });
        expect(queued.status, JSON.stringify(queued.body)).toBe(202);
        expect(queued.body).toMatchObject({ ok: true, result: {
          status: "approval_required", operation: "recovery.restore", risk: "high",
          approval_level: "L3_final_review", final_review_required: true,
        } });

        const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
        const pending = (approvalQueue.body.pending_approvals as Array<Record<string, unknown>>)
          .find((item) => item.operation === "recovery.restore");
        expect(pending).toMatchObject({ risk: "high", approval_level: "L3_final_review", final_review_required: true });
        const approved = await requestJson(port, `/approval/${encodeURIComponent(String(pending?.command_id))}`, {
          method: "POST",
          token: resumeToken,
          body: { verdict: "approve", approval_token: pending?.approval_token },
        });
        expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
        expect(approved.body, gateway.output.join("")).toMatchObject({ ok: true, result: {
          approval: "approve", executed: true, status: "success",
        } });
      }

      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(runtime.body.hds.operation_plans.result_memory).toMatchObject({
        configured: true, status: "receipt_confirmed", used_for_authority: false,
      });
      expect(runtime.body.hds.operation_plans.plans).toMatchObject([{ plan_id: planIdDigest, recovery_hold_reason: "held_unverified" }]);
    } finally {
      await stopChild(gateway.child);
    }
  }, 30_000);

  it("restores a verified Operation Plan store through L3, gates dependent review on its result, and holds only the residual collateral plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-operation-plan-restore-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const fileRoot = join(root, "file-root");
    const searchRoot = join(fileRoot, "fixture-workspace");
    const searchQuery = "qe-recovery-result-marker";
    const searchLine = `isolated recovery result: ${searchQuery}`;
    mkdirSync(searchRoot, { recursive: true });
    writeFileSync(join(searchRoot, "receipt.txt"), `${searchLine}\n`, "utf8");
    const expectedSearchResult = {
      root: realpathSync(searchRoot),
      sandbox_root: realpathSync(fileRoot),
      query: searchQuery,
      visited_files: 1,
      matches: [{ path: "receipt.txt", line_number: 1, line: searchLine }],
    };
    const runtimeEnv = {
      ...isolatedRuntimeEnvironment(root, envFile, historyFile, port),
      BLUE_TANUKI_APPROVAL_MODE: "ask_every_time",
    };
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const { cleanPlanIdDigest, cleanRevisionDigest, residualPlanIdDigest, residualRevisionDigest } =
      seedMixedOperationPlanRestoreState(planStatePath, {
        targetId: "fixture-workspace",
        root: "fixture-workspace",
        query: searchQuery,
        expectedResult: expectedSearchResult,
        dependentExpectedResult: { ...expectedSearchResult, query: searchLine },
      });
    const gateway = spawnGateway(runtimeEnv);
    let cleanPlanReviewRequestId: string | undefined;
    let residualPlanReviewRequestId: string | undefined;
    let prematureDependentReviewRequestId: string | undefined;
    let dependentReviewRequestId: string | undefined;

    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;

      // Change only the fixture's selected SQLite store after backup. The running
      // Gateway then has to consume the restored checkpoint through its HDS refresh.
      const changedStore = new OperationPlanStateStore(planStatePath);
      try {
        const current = changedStore.load();
        expect(current?.plans).toHaveLength(2);
        const empty = OperationPlanCheckpointSchema.parse({
          schema_version: "operation-plan-state.v1",
          plans: [],
        });
        changedStore.compareAndSet(current ? operationPlanDigest(current) : null, empty);
      } finally {
        changedStore.close();
      }

      const queued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "operation_plan",
          scope_digest: cleanPlanIdDigest,
          confirm: "RESTORE",
        },
      });
      const expectedTarget =
        `recovery.restore:${backupId}:store:operation_plans:effect:whole_store:scope:operation_plan:${cleanPlanIdDigest}`;
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({ ok: true, result: {
        status: "approval_required",
        executed: false,
        target: expectedTarget,
        restore_effect_scope: "entire_selected_store",
        scope_applicability: {
          status: "matched",
          matched_plan_id_digest: cleanPlanIdDigest,
          used_for_authority: false,
          may_execute: false,
        },
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      } });

      const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const pending = (approvalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.operation === "recovery.restore");
      expect(pending).toMatchObject({
        target: expectedTarget,
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      });
      const approved = await requestJson(port, `/approval/${encodeURIComponent(String(pending?.command_id))}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: pending?.approval_token },
      });
      expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approved.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const restoredStore = new OperationPlanStateStore(planStatePath);
      try {
        expect(restoredStore.load()?.plans.map((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id)))
          .toEqual([cleanPlanIdDigest, residualPlanIdDigest]);
        expect(restoredStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: residualPlanIdDigest, reason: "held_residual" }],
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        restoredStore.close();
      }
      const runtime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      const runtimePlans = runtime.body.hds.operation_plans.plans as Array<Record<string, unknown>>;
      expect(runtimePlans).toEqual(expect.arrayContaining([
        expect.objectContaining({ plan_id: cleanPlanIdDigest }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_residual" }),
      ]));
      expect(runtimePlans.find((plan) => plan.plan_id === cleanPlanIdDigest)?.recovery_hold_reason).toBeUndefined();
      expect(runtime.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(runtime.body.hds.operation_plans.raw_payload_exposed).toBe(false);

      const cleanReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: cleanPlanIdDigest,
          revision_digest: cleanRevisionDigest,
          step_id: "restore-clean-step",
        })}` },
      });
      expect(cleanReview.status, `${JSON.stringify(cleanReview.body)}\n${gateway.output.join("")}`).toBe(202);
      cleanPlanReviewRequestId = cleanReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, cleanPlanReviewRequestId);
      const cleanReviewRuntime = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(cleanReviewRuntime.body.pending_approvals, gateway.output.join("")).toEqual(expect.arrayContaining([
        expect.objectContaining({ request_id: cleanPlanReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]));

      const residualReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: residualPlanIdDigest,
          revision_digest: residualRevisionDigest,
          step_id: "restore-residual-review-step",
        })}` },
      });
      expect(residualReview.status, `${JSON.stringify(residualReview.body)}\n${gateway.output.join("")}`).toBe(202);
      residualPlanReviewRequestId = residualReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, residualPlanReviewRequestId);
      const afterResidualReview = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterResidualReview.body.pending_approvals, gateway.output.join("")).toEqual([
        expect.objectContaining({ request_id: cleanPlanReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]);
      expect(afterResidualReview.body.hds.operation_plans.plans).toEqual(expect.arrayContaining([
        expect.objectContaining({ plan_id: cleanPlanIdDigest }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_residual" }),
      ]));

      const prematureDependentReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: cleanPlanIdDigest,
          revision_digest: cleanRevisionDigest,
          step_id: "restore-clean-step-dependent",
        })}` },
      });
      expect(prematureDependentReview.status, `${JSON.stringify(prematureDependentReview.body)}\n${gateway.output.join("")}`).toBe(202);
      prematureDependentReviewRequestId = prematureDependentReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, prematureDependentReviewRequestId);
      const beforeSourceResult = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(beforeSourceResult.body.pending_approvals).toEqual([
        expect.objectContaining({ request_id: cleanPlanReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]);

      const cleanApprovalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const cleanPendingApproval = (cleanApprovalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.request_id === cleanPlanReviewRequestId && item.operation === "tool.file.search");
      expect(cleanApprovalQueue.body.pending_approvals).toEqual([
        expect.objectContaining({
          request_id: cleanPlanReviewRequestId,
          operation: "tool.file.search",
          approval_level: "L1_observe",
        }),
      ]);
      const approvedCleanSearch = await requestJson(port,
        `/approval/${encodeURIComponent(String(cleanPendingApproval?.command_id))}`, {
          method: "POST",
          token: resumeToken,
          body: { verdict: "approve", approval_token: cleanPendingApproval?.approval_token },
        });
      expect(approvedCleanSearch.status, `${JSON.stringify(approvedCleanSearch.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approvedCleanSearch.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const afterCleanSearch = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterCleanSearch.body.pending_approvals).toEqual([]);
      const afterSearchPlans = afterCleanSearch.body.hds.operation_plans.plans as Array<Record<string, unknown>>;
      expect(afterSearchPlans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          plan_id: cleanPlanIdDigest,
          status: "awaiting_step_review",
          steps: expect.arrayContaining([
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step"), status: "verified" }),
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step-dependent"), status: "not_selected" }),
          ]),
        }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_residual" }),
      ]));
      expect(afterCleanSearch.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(afterCleanSearch.body.hds.operation_plans.raw_payload_exposed).toBe(false);

      const dependentReview = await requestJson(port, "/operators/developer/invoke", {
        method: "POST",
        token: inboundToken,
        body: { user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: cleanPlanIdDigest,
          revision_digest: cleanRevisionDigest,
          step_id: "restore-clean-step-dependent",
        })}` },
      });
      expect(dependentReview.status, `${JSON.stringify(dependentReview.body)}\n${gateway.output.join("")}`).toBe(202);
      dependentReviewRequestId = dependentReview.body.request_id as string;
      await waitForHistoryDecision(port, gateway, dependentReviewRequestId);
      const afterDependentReview = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterDependentReview.body.pending_approvals).toEqual([
        expect.objectContaining({ request_id: dependentReviewRequestId, operation: "tool.file.search", approval_level: "L1_observe" }),
      ]);
      expect(JSON.stringify(afterDependentReview.body)).not.toContain(searchLine);
      expect(afterDependentReview.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(afterDependentReview.body.hds.operation_plans.raw_payload_exposed).toBe(false);

      const dependentApprovalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const dependentPendingApproval = (dependentApprovalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((item) => item.request_id === dependentReviewRequestId && item.operation === "tool.file.search");
      expect(dependentApprovalQueue.body.pending_approvals).toEqual([
        expect.objectContaining({
          request_id: dependentReviewRequestId,
          operation: "tool.file.search",
          approval_level: "L1_observe",
        }),
      ]);
      const approvedDependentSearch = await requestJson(port,
        `/approval/${encodeURIComponent(String(dependentPendingApproval?.command_id))}`, {
          method: "POST",
          token: resumeToken,
          body: { verdict: "approve", approval_token: dependentPendingApproval?.approval_token },
        });
      expect(approvedDependentSearch.status, `${JSON.stringify(approvedDependentSearch.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approvedDependentSearch.body, gateway.output.join("")).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });

      const afterDependentSearch = await requestJson(port, "/runtime/snapshot", { token: inboundToken });
      expect(afterDependentSearch.body.pending_approvals).toEqual([]);
      expect(afterDependentSearch.body.hds.operation_plans.plans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          plan_id: cleanPlanIdDigest,
          status: "results_verified",
          steps: expect.arrayContaining([
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step"), status: "verified" }),
            expect.objectContaining({ step_id: operationPlanDigest("restore-clean-step-dependent"), status: "verified" }),
          ]),
        }),
        expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_residual" }),
      ]));
      expect(JSON.stringify(afterDependentSearch.body)).not.toContain(searchLine);
      expect(afterDependentSearch.body.hds.operation_plans.used_for_authority).toBe(false);
      expect(afterDependentSearch.body.hds.operation_plans.raw_payload_exposed).toBe(false);
      expect(afterDependentSearch.body.operation_plan_status).toMatchObject({
        schema_version: "operation-plan.status.v1",
        status: "available",
        used_for_authority: false,
        raw_payload_exposed: false,
        plans: expect.arrayContaining([
          expect.objectContaining({
            plan_id: cleanPlanIdDigest,
            status: "results_verified",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step_id: operationPlanDigest("restore-clean-step"),
                status: "verified",
                binding: expect.objectContaining({
                  result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                  delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
              }),
              expect.objectContaining({
                step_id: operationPlanDigest("restore-clean-step-dependent"),
                status: "verified",
                binding: expect.objectContaining({
                  result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                  delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
              }),
            ]),
          }),
          expect.objectContaining({ plan_id: residualPlanIdDigest, recovery_hold_reason: "held_residual" }),
        ]),
      });
      expect(JSON.stringify(afterDependentSearch.body.operation_plan_status)).not.toContain(searchLine);

      const resultStore = new OperationPlanStateStore(planStatePath);
      try {
        const persisted = resultStore.load();
        const cleanPlan = persisted?.plans.find((plan) => plan.revisions[0]?.plan.plan_id === "restore-clean-plan");
        expect(cleanPlan?.bindings).toEqual(expect.arrayContaining([
          expect.objectContaining({
            step_id: "restore-clean-step",
            status: "verified",
            result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
          expect.objectContaining({
            step_id: "restore-clean-step-dependent",
            status: "verified",
            result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            prepared_step: expect.objectContaining({
              parameters: expect.objectContaining({ query: searchLine }),
            }),
          }),
        ]));
        expect(cleanPlan?.results).toEqual([
          expect.objectContaining({
            plan_id: "restore-clean-plan",
            request_id: "restore-clean-request",
            step_id: "restore-clean-step",
            operation: "file.search",
            status: "succeeded",
            output: expectedSearchResult,
          }),
          expect.objectContaining({
            plan_id: "restore-clean-plan",
            request_id: "restore-clean-request",
            step_id: "restore-clean-step-dependent",
            operation: "file.search",
            status: "succeeded",
            output: { ...expectedSearchResult, query: searchLine },
          }),
        ]);
        expect(resultStore.loadRecoveryHoldState()).toMatchObject({
          holds: [{ plan_id_digest: residualPlanIdDigest, reason: "held_residual" }],
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        resultStore.close();
      }
    } finally {
      await stopChild(gateway.child);
    }
    const reviewHistory = new CompleteHistoryStore({ filepath: historyFile });
    expect(reviewHistory.replay({ kind: "hds_decision", request_id: cleanPlanReviewRequestId! })).toHaveLength(1);
    const cleanExecutionHistory = reviewHistory.replay({ kind: "execution_history", request_id: cleanPlanReviewRequestId! });
    expect(cleanExecutionHistory).toHaveLength(1);
    expect(cleanExecutionHistory[0]?.payload).toMatchObject({
      status: "success",
      result_present: true,
      result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(cleanExecutionHistory)).not.toContain(searchLine);
    const dependentExecutionHistory = reviewHistory.replay({ kind: "execution_history", request_id: dependentReviewRequestId! });
    expect(dependentExecutionHistory).toHaveLength(1);
    expect(dependentExecutionHistory[0]?.payload).toMatchObject({
      status: "success",
      result_present: true,
      result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(dependentExecutionHistory)).not.toContain(searchLine);
    expect(reviewHistory.replay({ kind: "hds_decision", request_id: residualPlanReviewRequestId! })[0]?.payload).toMatchObject({
      decision: "FAIL",
      reason: "plan_control_denied:plan_recovery_residual_hold",
      command: null,
    });
    expect(reviewHistory.replay({ kind: "hds_decision", request_id: prematureDependentReviewRequestId! })[0]?.payload).toMatchObject({
      decision: "FAIL",
      reason: "plan_control_denied:plan_step_not_ready",
      command: null,
    });
    expect(reviewHistory.replay({ kind: "execution_history", request_id: residualPlanReviewRequestId! })).toHaveLength(0);
    expect(reviewHistory.replay({ kind: "execution_history", request_id: prematureDependentReviewRequestId! })).toHaveLength(0);
    expect(reviewHistory.replay({ kind: "execution_history", request_id: dependentReviewRequestId! })).toHaveLength(1);
  }, 30_000);

  it("binds plan restore to its exact L3 scope and rejects changed backup before state mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-recovery-l3-"));
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, `LLM_BACKEND=openai-compatible\nLLM_API_KEY=${secretMarker}\n`, "utf8");
    const before = readFileSync(envFile, "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const planScopeDigest = seedOperationPlanState(planStatePath).plan_id_digest;
    const gateway = spawnGateway(runtimeEnv);

    try {
      await waitForHealth(port, gateway);

      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;
      const unverifiedScope = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "operation_plan",
          scope_digest: "f".repeat(64),
          confirm: "RESTORE",
        },
      });
      expect(unverifiedScope.status).toBe(200);
      expect(unverifiedScope.body).toMatchObject({
        ok: true,
        result: {
          status: "blocked_unverified_scope",
          executed: false,
          restore_effect_scope: "entire_selected_store",
          used_for_authority: false,
          may_execute: false,
          scope_applicability: { status: "unverified", used_for_authority: false, may_execute: false },
        },
      });
      const noRecoveryApproval = await requestJson(port, "/approval", { token: resumeToken });
      expect(noRecoveryApproval.body.pending_approvals).toEqual([]);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const planStoreBeforeReview = readFileSync(planStatePath);
      const planRestoreQueued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "operation_plan",
          scope_digest: planScopeDigest,
          confirm: "RESTORE",
        },
      });
      const expectedPlanRestoreTarget =
        `recovery.restore:${backupId}:store:operation_plans:effect:whole_store:scope:operation_plan:${planScopeDigest}`;
      expect(planRestoreQueued.status, JSON.stringify(planRestoreQueued.body)).toBe(202);
      expect(planRestoreQueued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.restore",
          target: expectedPlanRestoreTarget,
          restore_effect_scope: "entire_selected_store",
          scope_applicability: {
            status: "matched",
            scope_digest: planScopeDigest,
            matched_plan_id_digest: planScopeDigest,
            used_for_authority: false,
            may_execute: false,
          },
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });
      expect(readFileSync(planStatePath)).toEqual(planStoreBeforeReview);

      const planApprovalQueue = await requestJson(port, "/approval", { token: resumeToken });
      const pendingPlanRestore = (planApprovalQueue.body.pending_approvals as Array<Record<string, unknown>>)
        .find((pending) => pending.operation === "recovery.restore");
      expect(pendingPlanRestore).toMatchObject({
        target: expectedPlanRestoreTarget,
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      });
      const planRestoreCommandId = pendingPlanRestore?.command_id as string;
      const planRestoreApprovalToken = pendingPlanRestore?.approval_token as string;
      expect(typeof planRestoreCommandId).toBe("string");
      expect(typeof planRestoreApprovalToken).toBe("string");

      const selectedPlanArchive = join(root, "recovery", backupId, "canonical-state", "operation_plans.sqlite");
      unlinkSync(selectedPlanArchive);
      const backupPacksBeforeRejectedApply = readdirSync(join(root, "recovery")).sort();
      const rejectedPlanRestore = await requestJson(port, `/approval/${encodeURIComponent(planRestoreCommandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: planRestoreApprovalToken },
      });
      expect(rejectedPlanRestore.status).toBe(200);
      expect(rejectedPlanRestore.body).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "failed" },
      });
      expect(readFileSync(planStatePath)).toEqual(planStoreBeforeReview);
      expect(readdirSync(join(root, "recovery")).sort()).toEqual(backupPacksBeforeRejectedApply);

      const invalid = await requestJson(port, "/recovery/reset-provider", {
        method: "POST",
        token: maintenanceToken,
        body: { confirm: "RESET_PROVIDER", force: true },
      });
      expect(invalid.status).toBe(400);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const queued = await requestJson(port, "/recovery/reset-provider", {
        method: "POST",
        token: maintenanceToken,
        body: { confirm: "RESET_PROVIDER" },
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.reset_provider",
          target: "recovery.reset_provider:provider-configuration",
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });
      expect(JSON.stringify(queued.body)).not.toContain(secretMarker);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const wrongAuth = await requestJson(port, "/approval", { token: maintenanceToken });
      expect(wrongAuth.status).toBe(401);
      const queue = await requestJson(port, "/approval", { token: resumeToken });
      expect(queue.status).toBe(200);
      const pending = (queue.body.pending_approvals as Array<Record<string, unknown>>)[0];
      expect(pending).toMatchObject({
        operation: "recovery.reset_provider",
        target: "recovery.reset_provider:provider-configuration",
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
      });
      expect(typeof pending.command_id).toBe("string");
      expect(typeof pending.approval_token).toBe("string");
      const commandId = pending.command_id as string;
      const approvalToken = pending.approval_token as string;

      const missingToken = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve" },
      });
      expect(missingToken.status).toBe(400);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const wrongApprovalToken = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: "wrong-one-time-token" },
      });
      expect(wrongApprovalToken.status).toBe(403);
      expect(readFileSync(envFile, "utf8")).toBe(before);

      const approved = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: approvalToken, remember: true, actor: "client-claimed-owner" },
      });
      expect(approved.status, `${JSON.stringify(approved.body)}\n${gateway.output.join("")}`).toBe(200);
      expect(approved.body).toMatchObject({
        ok: true,
        result: { approval: "approve", executed: true, status: "success" },
      });
      const after = readFileSync(envFile, "utf8");
      expect(after).toContain("LLM_BACKEND=stub");
      expect(after).not.toContain(secretMarker);

      const emptyQueue = await requestJson(port, "/approval", { token: resumeToken });
      expect(emptyQueue.body.pending_approvals).toEqual([]);
      const replay = await requestJson(port, `/approval/${encodeURIComponent(commandId)}`, {
        method: "POST",
        token: resumeToken,
        body: { verdict: "approve", approval_token: approvalToken },
      });
      expect(replay.status).toBe(409);
      expect(readFileSync(envFile, "utf8")).toBe(after);

      const grants = await requestJson(port, "/approval/grants", { token: resumeToken });
      expect(grants.status).toBe(200);
      expect(JSON.stringify(grants.body)).not.toContain("recovery.reset_provider");
      const history = readFileSync(historyFile, "utf8");
      expect(history).toContain("human_resume_approved");
      expect(history).toContain("recovery.reset_provider");
      expect(history).toContain("webchat-resume-token-holder");
      expect(history).not.toContain("client-claimed-owner");
      expect(history).not.toContain(secretMarker);
    } finally {
      await stopChild(gateway.child);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("binds task-lineage restore to its exact L3 scope and identifies the selected effect", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-recovery-task-l3-"));
    temporaryRoots.push(root);
    const envFile = join(root, "product.env");
    const historyFile = join(root, "complete-history.jsonl");
    const port = await reserveLoopbackPort();
    writeFileSync(envFile, "LLM_BACKEND=stub\n", "utf8");
    const runtimeEnv = isolatedRuntimeEnvironment(root, envFile, historyFile, port);
    const planStatePath = join(root, "state", "private-state", "operation-plans", "j-state.sqlite");
    const { task_identity_digest: taskIdentityDigest } = seedOperationPlanState(planStatePath);
    const gateway = spawnGateway(runtimeEnv);

    try {
      await waitForHealth(port, gateway);
      const backup = await requestJson(port, "/recovery/backup", {
        method: "POST",
        token: maintenanceToken,
        body: {},
      });
      expect(backup.status).toBe(200);
      const backupId = (backup.body.result as Record<string, unknown>).backup_id as string;
      const before = readFileSync(planStatePath);

      const unverified = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "task_identity",
          scope_digest: "f".repeat(64),
          confirm: "RESTORE",
        },
      });
      expect(unverified.body).toMatchObject({
        ok: true,
        result: {
          status: "blocked_unverified_scope",
          executed: false,
          restore_effect_scope: "selected_task_lineage",
          used_for_authority: false,
          may_execute: false,
        },
      });

      const queued = await requestJson(port, "/recovery/restore", {
        method: "POST",
        token: maintenanceToken,
        body: {
          backup_id: backupId,
          store_key: "operation_plans",
          scope_kind: "task_identity",
          scope_digest: taskIdentityDigest,
          confirm: "RESTORE",
        },
      });
      const expectedTarget =
        `recovery.restore:${backupId}:store:operation_plans:effect:task_lineage:scope:task_identity:${taskIdentityDigest}`;
      expect(queued.status, `${JSON.stringify(queued.body)}\n${gateway.output.join("")}`).toBe(202);
      expect(queued.body).toMatchObject({
        ok: true,
        result: {
          status: "approval_required",
          executed: false,
          operation: "recovery.restore",
          target: expectedTarget,
          restore_effect_scope: "selected_task_lineage",
          scope_applicability: {
            status: "matched",
            scope_kind: "task_identity",
            scope_digest: taskIdentityDigest,
            used_for_authority: false,
            may_execute: false,
          },
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        },
      });
      const approvalQueue = await requestJson(port, "/approval", { token: resumeToken });
      expect(approvalQueue.body.pending_approvals).toEqual([
        expect.objectContaining({
          operation: "recovery.restore",
          target: expectedTarget,
          risk: "high",
          approval_level: "L3_final_review",
          final_review_required: true,
        }),
      ]);
      expect(readFileSync(planStatePath)).toEqual(before);
    } finally {
      await stopChild(gateway.child);
    }
  }, 30_000);
});

function seedOperationPlanState(filepath: string): {
  plan_id_digest: string;
  revision_digest: string;
  task_identity_digest: string;
} {
  mkdirSync(dirname(filepath), { recursive: true });
  const plan = syntheticOperationPlan("restore-review-request", "restore-review-plan", "restore-review-step");
  const revisionDigest = operationPlanDigest(plan);
  const checkpoint = OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [{
      owner: "fixture-owner",
      channel: "webchat",
      goal: "fixture recovery review",
      revisions: [{ digest: revisionDigest, plan }],
      receipt_observations: [],
      bindings: [],
      results: [],
    }],
  });
  const store = new OperationPlanStateStore(filepath);
  let taskIdentityDigest: string | undefined;
  try {
    store.compareAndSet(null, checkpoint);
    const persisted = OperationPlanCheckpointSchema.parse(store.load());
    taskIdentityDigest = operationPlanTaskIdentityDigest(persisted.plans[0]!);
  } finally {
    store.close();
  }
  if (!taskIdentityDigest) throw new Error("fixture_task_identity_digest_missing");
  return { plan_id_digest: operationPlanDigest(plan.plan_id), revision_digest: revisionDigest,
    task_identity_digest: taskIdentityDigest };
}

function seedMixedOperationPlanRestoreState(filepath: string, cleanSearch: SyntheticFileSearchFixture): {
  cleanPlanIdDigest: string;
  cleanRevisionDigest: string;
  residualPlanIdDigest: string;
  residualRevisionDigest: string;
} {
  mkdirSync(dirname(filepath), { recursive: true });
  const cleanPlan = syntheticOperationPlan("restore-clean-request", "restore-clean-plan", "restore-clean-step", cleanSearch);
  const residualPlan = syntheticOperationPlan("restore-residual-request", "restore-residual-plan", "restore-residual-step");
  const residualStep = residualPlan.steps[0]!;
  residualPlan.steps.push({
    ...residualStep,
    step_id: "restore-residual-review-step",
    preparation: {
      ...residualStep.preparation,
      validation: residualStep.preparation.validation.map((check) => ({
        ...check,
        check_id: "restore-residual-review-step-check",
      })),
    },
  });
  const cleanRevisionDigest = operationPlanDigest(cleanPlan);
  const residualRevisionDigest = operationPlanDigest(residualPlan);
  const { state: _state, result_digest: _result, ...residualStepDefinition } = residualStep;
  const residualBinding = {
    step_id: residualStep.step_id,
    revision_digest: residualRevisionDigest,
    step_digest: operationPlanDigest(residualStepDefinition),
    prepared_step: residualStep,
    command_id: "synthetic-residual-command",
    request_id: residualPlan.request_id,
    commit_hash: "synthetic-residual-commit",
    payload_digest: createHash("sha256").update("synthetic-residual-payload").digest("hex"),
    command_digest: createHash("sha256").update("synthetic-residual-command").digest("hex"),
    operation: residualStep.operation,
    // An intent without its Broker admission is a real residual dependency for this fixture.
    status: "intent_committed" as const,
  };
  const checkpoint = OperationPlanCheckpointSchema.parse({
    schema_version: "operation-plan-state.v1",
    plans: [
      {
        owner: "fixture-owner",
        channel: "webchat",
        goal: "fixture clean collateral plan",
        revisions: [{ digest: cleanRevisionDigest, plan: cleanPlan }],
        receipt_observations: [],
        bindings: [],
        results: [],
      },
      {
        owner: "fixture-owner",
        channel: "webchat",
        goal: "fixture residual collateral plan",
        revisions: [{ digest: residualRevisionDigest, plan: residualPlan }],
        receipt_observations: [],
        bindings: [residualBinding],
        results: [],
      },
    ],
  });
  const store = new OperationPlanStateStore(filepath);
  try {
    store.compareAndSet(null, checkpoint);
  } finally {
    store.close();
  }
  return {
    cleanPlanIdDigest: operationPlanDigest(cleanPlan.plan_id),
    cleanRevisionDigest,
    residualPlanIdDigest: operationPlanDigest(residualPlan.plan_id),
    residualRevisionDigest,
  };
}

type SyntheticFileSearchFixture = {
  targetId: string;
  root: string;
  query: string;
  expectedResult: Record<string, unknown>;
  dependentExpectedResult?: Record<string, unknown>;
};

function syntheticOperationPlan(requestId: string, planId: string, stepId: string, search?: SyntheticFileSearchFixture) {
  const targetId = search?.targetId ?? "fixture-workspace";
  const root = search?.root ?? "fixture-workspace";
  const query = search?.query ?? "fixture";
  const step = {
    step_id: stepId,
    operation: "file.search",
    target: { kind: "directory" as const, id: targetId },
    state: "planned" as const,
    effects: ["read" as const],
    permission: {
      risk: "low" as const,
      approval_level: "L1_observe" as const,
      final_review_required: false,
      hds_brain_authority_required: true as const,
      approval_gate_required: true,
    },
    adapter: "internal_runtime" as const,
    adapter_is_authority: false as const,
    command_generated_by_adapter_only: false,
    parameters: { root, query, max_results: 1 },
    preparation: {
      depends_on: [],
      bindings: [],
      preconditions: [],
      validation: [{
        check_id: `${stepId}-check`,
        method: "result_equals" as const,
        target: { kind: "directory" as const, id: targetId },
        expected: search?.expectedResult ?? { count: 0 },
      }],
      compensation: { available: false, reason: "fixture" },
    },
  };
  const dependentStep = search?.dependentExpectedResult ? {
    ...step,
    step_id: `${stepId}-dependent`,
    parameters: { root, query: "pending:verified-search-result", max_results: 1 },
    preparation: {
      ...step.preparation,
      depends_on: [stepId],
      bindings: [{ source_step_id: stepId, output_path: ["matches", "0", "line"], field: "parameters" as const, path: ["query"] }],
      validation: [{ check_id: `${stepId}-dependent-check`, method: "result_equals" as const,
        target: { kind: "directory" as const, id: targetId }, expected: search.dependentExpectedResult }],
    },
  } : undefined;
  return {
    version: "operation-core.v1" as const,
    plan_id: planId,
    request_id: requestId,
    state: "planned" as const,
    steps: dependentStep ? [step, dependentStep] : [step],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false as const, command_generation_location: "not_applicable" as const },
    planner_output_used_for_authority: false as const,
    hds_brain_authority_required: true as const,
  };
}

async function startSyntheticPlanProvider(): Promise<{
  endpoint: string;
  callCount(): number;
  close(): Promise<void>;
}> {
  let calls = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls++;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: unknown; content?: unknown }>;
        };
        const system = body.messages?.find((message) => message.role === "system")?.content;
        const requestId = typeof system === "string" ? /固定request_id=([^。]+)/.exec(system)?.[1] : undefined;
        if (!requestId) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "synthetic request binding missing" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-synthetic-plan",
          object: "chat.completion",
          model: "synthetic-plan-model",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(
            syntheticOperationPlan(requestId, "fresh-request-plan", "fresh-request-step")) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic request invalid" }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic plan provider did not bind loopback");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    callCount: () => calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function isolatedRuntimeEnvironment(root: string, envFile: string, historyFile: string, port: number): NodeJS.ProcessEnv {
  const inheritedKeys = [
    "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of inheritedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    WEBCHAT_HOST: "127.0.0.1",
    WEBCHAT_PORT: String(port),
    WEBCHAT_TOKEN: inboundToken,
    WEBCHAT_RESUME_TOKEN: resumeToken,
    BLUE_TANUKI_MAINTENANCE_TOKEN: maintenanceToken,
    LLM_BACKEND: "stub",
    BLUE_TANUKI_ENV_FILE: envFile,
    BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"),
    BLUE_TANUKI_FILE_ROOT: join(root, "file-root"),
    BLUE_TANUKI_STATE_ROOT: join(root, "state"),
    BLUE_TANUKI_AUDIT_DIR: join(root, "audit"),
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile,
    BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
    BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"),
    BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"),
    BLUE_TANUKI_SCHEDULES_DIR: join(root, "schedules"),
    BLUE_TANUKI_APPROVALS_FILE: join(root, "approval-grants.json"),
    BLUE_TANUKI_APPROVAL_MODE: "full_access",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    DISCORD_BOT_TOKEN: "",
    TELEGRAM_BOT_TOKEN: "",
    LINE_CHANNEL_ACCESS_TOKEN: "",
    LINE_CHANNEL_SECRET: "",
  };
}

function spawnGateway(env: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; output: string[] } {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/gateway/src/main.ts", "--serve"], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  children.add(child);
  child.once("close", () => children.delete(child));
  return { child, output };
}

async function waitForHealth(port: number, gateway: { child: ChildProcessWithoutNullStreams; output: string[] }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited early: ${gateway.output.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Wait for the isolated Gateway process to bind its loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Gateway health timed out: ${gateway.output.join("")}`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = await import("node:net").then(({ createServer }) => createServer());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback port reservation failed");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function requestJson(
  port: number,
  route: string,
  options: { method?: string; token?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitForHistoryDecision(
  port: number,
  gateway: { child: ChildProcessWithoutNullStreams; output: string[] },
  requestId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited before recording HDS decision: ${gateway.output.join("")}`);
    const response = await requestJson(port,
      `/history?kind=hds_decision&request_id=${encodeURIComponent(requestId)}`, { token: inboundToken });
    const history = response.body.history as Record<string, unknown> | undefined;
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    if (response.status === 200 && entries.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for HDS decision ${requestId}: ${gateway.output.join("")}`);
}

function waitForWebChatSend(webSocket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Developer decision delivery"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      webSocket.off("message", onMessage);
      webSocket.off("error", onError);
      webSocket.off("close", onClose);
    };
    const onMessage = (data: Buffer) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || (message as { kind?: unknown }).kind !== "channel_send") return;
      cleanup();
      resolve((message as { content?: string }).content ?? "");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("WebChat closed before Developer decision delivery"));
    webSocket.on("message", onMessage);
    webSocket.once("error", onError);
    webSocket.once("close", onClose);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!children.has(child)) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const closed = once(child, "close");
  child.kill();
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3_000);
  await closed;
  clearTimeout(timeout);
  children.delete(child);
}
