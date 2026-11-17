package com.bluetanuki.mobile;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class MobileTaskClient {
    private static final Set<String> RUNTIME_EVIDENCE = new HashSet<>(Arrays.asList("INTERNAL_STATE", "LIVE_RUNTIME"));
    private static final Set<String> LIVE_OR_INTERNAL_EVIDENCE = new HashSet<>(Arrays.asList("LIVE_RUNTIME", "INTERNAL_STATE"));
    private static final Set<String> LIVE_EVIDENCE = Collections.singleton("LIVE_RUNTIME");

    private final AndroidCredentialStore store;
    private final DeviceLinkTransport transport;

    MobileTaskClient(AndroidCredentialStore store, DeviceLinkTransport transport) {
        this.store = store;
        this.transport = transport;
    }

    Catalog refreshCatalog(DeviceLinkTransport.SendGuard canSend) throws Exception {
        DeviceCredential credential = requireCredential();
        Map<String, Object> runtimeBody = body(credential, "実行系列挙", Collections.emptyMap(), RUNTIME_EVIDENCE, canSend, null);
        List<String> runtimes = MobileTaskContract.runtimes(runtimeBody);
        Map<String, Object> workspaceBody = body(credential, "作業領域一覧", Collections.emptyMap(),
                Collections.singleton("INTERNAL_STATE"), canSend, null);
        List<MobileTaskContract.Workspace> workspaces = MobileTaskContract.workspaces(workspaceBody);
        for (MobileTaskContract.Workspace workspace : workspaces) {
            if (!runtimes.contains(workspace.runtimeID)) throw new StrictJson.JsonException();
        }
        return new Catalog(runtimes, workspaces);
    }

    OwnedRequests refreshOwnedRequests(DeviceLinkTransport.SendGuard canSend) throws Exception {
        DeviceCredential credential = requireCredential();
        Map<String, Object> response = body(credential, "AgentTask端末申請一覧", Collections.emptyMap(),
                LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
        List<MobileTaskContract.Draft> entries = MobileTaskContract.ownRequests(response);
        String pendingSessionID = store.pendingTaskSessionID();
        boolean reconciled = false;
        if (pendingSessionID != null) {
            for (MobileTaskContract.Draft entry : entries) {
                if (pendingSessionID.equals(entry.sessionID)) {
                    reconciled = true;
                    break;
                }
            }
        }
        if (reconciled) store.clearTaskSubmissionPending(pendingSessionID);
        Map<String, MobileTaskContract.TaskStatus> statuses = new LinkedHashMap<>();
        boolean allStatusesObserved = true;
        for (MobileTaskContract.Draft entry : entries) {
            try {
                statuses.put(entry.id, refreshStatus(entry, canSend));
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                allStatusesObserved = false;
                break;
            } catch (Exception exception) {
                allStatusesObserved = false;
                break;
            }
        }
        return new OwnedRequests(entries, reconciled ? null : pendingSessionID, reconciled,
                statuses, allStatusesObserved);
    }

    MobileTaskContract.McpSnapshot refreshMcpSnapshot(DeviceLinkTransport.SendGuard canSend)
            throws Exception {
        DeviceCredential credential = requireCredential();
        Map<String, Object> response = body(credential, "AgentTask端末MCP能力取得", Collections.emptyMap(),
                LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
        return MobileTaskContract.mcpSnapshot(response);
    }

    Submission submit(String runtimeID, String workspaceID, String instruction, boolean includeMcp,
                      DeviceLinkTransport.SendGuard canSend) throws TaskSubmissionFailure {
        Attempt attempt = new Attempt();
        String sessionID = null;
        boolean checkpointRecorded = false;
        try {
            MobileTaskContract.validateInstruction(instruction);
            if (store.pendingTaskSessionID() != null) throw new StrictJson.JsonException();
            DeviceCredential credential = requireCredential();
            Catalog catalog = refreshCatalog(canSend);
            boolean workspaceStillRegistered = false;
            for (MobileTaskContract.Workspace workspace : catalog.workspaces) {
                if (workspace.id.equals(workspaceID) && workspace.runtimeID.equals(runtimeID)) {
                    workspaceStillRegistered = true;
                    break;
                }
            }
            if (!catalog.runtimes.contains(runtimeID) || !workspaceStillRegistered) {
                throw new StrictJson.JsonException();
            }

            String mcpHash = null;
            if (includeMcp) {
                MobileTaskContract.McpSnapshot snapshot = refreshMcpSnapshot(canSend);
                if (!snapshot.usable()) throw new StrictJson.JsonException();
                mcpHash = snapshot.hash;
            }

            Map<String, Object> sessionBody = body(credential, "対話開始",
                    Collections.singletonMap("実行系ID", runtimeID), LIVE_EVIDENCE, canSend, null);
            sessionID = MobileTaskContract.sessionID(sessionBody, runtimeID);
            Map<String, Object> request = MobileTaskContract.requestPayload(
                    runtimeID, sessionID, workspaceID, instruction, mcpHash);
            store.markTaskSubmissionPending(sessionID);
            checkpointRecorded = true;
            Map<String, Object> response = body(credential, "AgentTask端末申請", request,
                    LIVE_EVIDENCE, canSend, attempt);
            MobileTaskContract.Draft draft = MobileTaskContract.submission(
                    response, runtimeID, sessionID, workspaceID);
            return new Submission(draft, sessionID);
        } catch (Exception error) {
            boolean rejected = error instanceof PairingResponseParser.PairingRejectedException;
            boolean mayHaveReached = attempt.taskSubmissionMayHaveReachedDesktop;
            boolean sessionCloseConfirmed = false;
            boolean checkpointCleared = false;
            if (sessionID != null && (!mayHaveReached || rejected) && canSend != null && canSend.canSend()) {
                try {
                    DeviceCredential credential = requireCredential();
                    Map<String, Object> close = body(credential, "対話終了",
                            Collections.singletonMap("対話セッションID", sessionID), LIVE_EVIDENCE, canSend, null);
                    sessionCloseConfirmed = StrictJson.hasExactKeys(close, "対話セッションID", "状態") &&
                            sessionID.equals(StrictJson.string(close, "対話セッションID")) &&
                            "終了".equals(StrictJson.string(close, "状態"));
                } catch (Exception ignored) {
                    sessionCloseConfirmed = false;
                }
            }
            if (checkpointRecorded && sessionID != null && (!mayHaveReached || rejected)) {
                try {
                    store.clearTaskSubmissionPending(sessionID);
                    checkpointCleared = true;
                } catch (Exception ignored) {
                    checkpointCleared = false;
                }
            }
            throw new TaskSubmissionFailure(error, attempt.taskSubmissionMayHaveReachedDesktop,
                    checkpointRecorded && !checkpointCleared, sessionCloseConfirmed);
        }
    }

    MobileTaskContract.TaskStatus refreshStatus(MobileTaskContract.Draft draft,
                                                 DeviceLinkTransport.SendGuard canSend) throws Exception {
        DeviceCredential credential = requireCredential();
        Map<String, Object> response = body(credential, "AgentTask端末状態",
                Collections.singletonMap("申請ID", draft.id), LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
        return MobileTaskContract.status(response, draft);
    }

    StartResult start(MobileTaskContract.Draft draft,
                      DeviceLinkTransport.SendGuard canSend) throws Exception {
        MobileTaskContract.TaskStatus status = refreshStatus(draft, canSend);
        if (!MobileTaskContract.TaskStatus.START_CANDIDATE.equals(status.kind)) return new StartResult(status, false);
        DeviceCredential credential = requireCredential();
        Map<String, Object> response = body(credential, "AgentTask端末実行",
                Collections.singletonMap("申請ID", draft.id), LIVE_EVIDENCE, canSend, null);
        return new StartResult(MobileTaskContract.TaskStatus.task(
                MobileTaskContract.started(response, draft)), true);
    }

    Cancellation cancel(MobileTaskContract.Draft draft, DeviceLinkTransport.SendGuard canSend) throws Exception {
        MobileTaskContract.TaskStatus status = refreshStatus(draft, canSend);
        if (!MobileTaskContract.TaskStatus.TASK.equals(status.kind) ||
                !Arrays.asList("pending", "running").contains(status.task.state)) {
            return new Cancellation(status, false);
        }
        DeviceCredential credential = requireCredential();
        Map<String, Object> response = body(credential, "AgentTask端末取消",
                Collections.singletonMap("申請ID", draft.id), LIVE_EVIDENCE, canSend, null);
        MobileTaskContract.TaskRecord record = MobileTaskContract.cancellationRequested(response, draft);
        return new Cancellation(MobileTaskContract.TaskStatus.task(record), true);
    }

    private Map<String, Object> body(DeviceCredential credential, String operation, Map<String, Object> content,
                                     Set<String> allowedEvidence, DeviceLinkTransport.SendGuard canSend,
                                     Attempt submissionAttempt) throws Exception {
        DeviceLinkTransport.Exchange exchange;
        try {
            exchange = transport.taskOperation(credential, operation, content, canSend);
        } catch (DeviceLinkTransport.TransportException exception) {
            if (submissionAttempt != null && exception.requestMayHaveReachedDesktop) {
                submissionAttempt.taskSubmissionMayHaveReachedDesktop = true;
            }
            throw exception;
        }
        if (submissionAttempt != null) submissionAttempt.taskSubmissionMayHaveReachedDesktop = true;
        Map<String, Object> response = PairingResponseParser.requireAcceptedResponse(
                exchange.response, exchange.nonce, operation, allowedEvidence);
        if (canSend == null || !canSend.canSend()) {
            throw new DeviceLinkTransport.TransportException(true);
        }
        return response;
    }

    private DeviceCredential requireCredential() throws Exception {
        DeviceCredential credential = store.read();
        if (credential == null || credential.expiresAt <= System.currentTimeMillis() / 1000L) {
            throw new StrictJson.JsonException();
        }
        return credential;
    }

    static final class Catalog {
        final List<String> runtimes;
        final List<MobileTaskContract.Workspace> workspaces;
        Catalog(List<String> runtimes, List<MobileTaskContract.Workspace> workspaces) {
            this.runtimes = runtimes; this.workspaces = workspaces;
        }
    }

    static final class OwnedRequests {
        final List<MobileTaskContract.Draft> entries;
        final String pendingSessionID;
        final boolean didReconcilePendingRequest;
        final Map<String, MobileTaskContract.TaskStatus> statuses;
        final boolean allStatusesObserved;
        OwnedRequests(List<MobileTaskContract.Draft> entries, String pendingSessionID, boolean reconciled,
                      Map<String, MobileTaskContract.TaskStatus> statuses, boolean allStatusesObserved) {
            this.entries = entries; this.pendingSessionID = pendingSessionID;
            this.didReconcilePendingRequest = reconciled;
            this.statuses = statuses; this.allStatusesObserved = allStatusesObserved;
        }
    }

    static final class Submission {
        final MobileTaskContract.Draft draft;
        final String sessionID;
        Submission(MobileTaskContract.Draft draft, String sessionID) {
            this.draft = draft; this.sessionID = sessionID;
        }
    }

    static final class Cancellation {
        final MobileTaskContract.TaskStatus status;
        final boolean requestSent;
        Cancellation(MobileTaskContract.TaskStatus status, boolean requestSent) {
            this.status = status; this.requestSent = requestSent;
        }
    }

    static final class StartResult {
        final MobileTaskContract.TaskStatus status;
        final boolean requestSent;
        StartResult(MobileTaskContract.TaskStatus status, boolean requestSent) {
            this.status = status; this.requestSent = requestSent;
        }
    }

    static final class Attempt {
        boolean taskSubmissionMayHaveReachedDesktop;
    }

    static final class TaskSubmissionFailure extends Exception {
        final boolean taskSubmissionMayHaveReachedDesktop;
        final boolean checkpointPending;
        final boolean sessionCloseConfirmed;
        final boolean definitiveRejection;

        TaskSubmissionFailure(Exception cause, boolean mayHaveReached, boolean checkpointPending,
                              boolean sessionCloseConfirmed) {
            super("mobile_task_submission_failed", cause);
            this.taskSubmissionMayHaveReachedDesktop = mayHaveReached;
            this.checkpointPending = checkpointPending;
            this.sessionCloseConfirmed = sessionCloseConfirmed;
            this.definitiveRejection = cause instanceof PairingResponseParser.PairingRejectedException;
        }
    }
}
