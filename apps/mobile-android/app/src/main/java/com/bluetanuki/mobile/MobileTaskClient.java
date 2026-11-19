package com.bluetanuki.mobile;

import java.util.ArrayList;
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
    private static final Object TASK_MUTATION_LOCK = new Object();

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
        PendingTaskSubmission submission = store.pendingTaskSubmission();
        boolean reconciled = submission != null && submission.matchesOwnedRequest(credential, entries);
        if (reconciled) store.clearTaskSubmissionPending(submission);
        PendingTaskMutation pending = null;
        try {
            pending = store.pendingTaskMutation();
        } catch (AndroidCredentialStore.CredentialStoreException ignored) {
            // 状態照会は継続し、端末の記録に基づく照合は保留する。
        }
        Map<String, MobileTaskContract.TaskStatus> statuses = observeOwnedStatuses(entries, credential, pending,
                canSend, entry -> refreshStatus(entry, canSend));
        return new OwnedRequests(entries, reconciled || submission == null ? null : submission.sessionID, reconciled,
                statuses, statuses.size() == entries.size());
    }

    static Map<String, MobileTaskContract.TaskStatus> observeOwnedStatuses(List<MobileTaskContract.Draft> entries,
            DeviceCredential credential, PendingTaskMutation pending, DeviceLinkTransport.SendGuard canSend,
            TaskStatusReader reader) {
        List<MobileTaskContract.Draft> readOrder = new ArrayList<>(entries);
        if (pending != null) {
            for (int index = 0; index < readOrder.size(); index++) {
                if (pending.matchesListedRequest(credential, readOrder.get(index))) {
                    readOrder.add(0, readOrder.remove(index));
                    break;
                }
            }
        }
        Map<String, MobileTaskContract.TaskStatus> statuses = new LinkedHashMap<>();
        for (MobileTaskContract.Draft entry : readOrder) {
            if (!canSend.canSend() || Thread.currentThread().isInterrupted()) break;
            try {
                statuses.put(entry.id, reader.read(entry));
            } catch (PairingResponseParser.PairingRejectedException | PairingResponseParser.PairingUnknownException |
                     StrictJson.JsonException ignored) {
                // 個別の応答を確認できない場合、その申請を不明のまま残す。
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception exception) {
                break;
            }
        }
        return statuses;
    }

    interface TaskStatusReader {
        MobileTaskContract.TaskStatus read(MobileTaskContract.Draft entry) throws Exception;
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
        PendingTaskSubmission checkpoint = null;
        boolean checkpointRecorded = false;
        try {
            String instructionHash = MobileTaskContract.instructionHash(instruction);
            if (store.pendingTaskSubmission() != null) throw new StrictJson.JsonException();
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
                    MobileTaskContract.sessionStartPayload(runtimeID, workspaceID), LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
            sessionID = MobileTaskContract.sessionID(sessionBody, runtimeID);
            Map<String, Object> request = MobileTaskContract.requestPayload(
                    runtimeID, sessionID, workspaceID, instruction, mcpHash);
            checkpoint = PendingTaskSubmission.forRequest(credential, runtimeID, sessionID, workspaceID, instructionHash);
            store.markTaskSubmissionPending(checkpoint);
            checkpointRecorded = true;
            Map<String, Object> response = body(credential, "AgentTask端末申請", request,
                    LIVE_OR_INTERNAL_EVIDENCE, canSend, attempt);
            MobileTaskContract.Draft draft = MobileTaskContract.submission(
                    response, runtimeID, sessionID, workspaceID, instructionHash);
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
                            Collections.singletonMap("対話セッションID", sessionID), LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
                    sessionCloseConfirmed = StrictJson.hasExactKeys(close, "対話セッションID", "状態") &&
                            sessionID.equals(StrictJson.string(close, "対話セッションID")) &&
                            "終了".equals(StrictJson.string(close, "状態"));
                } catch (Exception ignored) {
                    sessionCloseConfirmed = false;
                }
            }
            if (checkpointRecorded && (!mayHaveReached || rejected)) {
                try {
                    store.clearTaskSubmissionPending(checkpoint);
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
        synchronized (TASK_MUTATION_LOCK) {
            return readTaskStatus(requireCredential(), draft, canSend);
        }
    }

    private MobileTaskContract.TaskStatus readTaskStatus(DeviceCredential credential,
                                                        MobileTaskContract.Draft draft,
                                                        DeviceLinkTransport.SendGuard canSend) throws Exception {
        PairingResponseParser.AcceptedResponse response = exchange(credential, "AgentTask端末状態",
                Collections.singletonMap("申請ID", draft.id), LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
        MobileTaskContract.TaskStatus status = MobileTaskContract.status(response.body, draft);
        try {
            PendingTaskMutation pending = store.pendingTaskMutation();
            if (pending != null && pending.resolvedBy(credential, draft, status, response.evidenceSource)) {
                store.clearTaskMutationPending(pending);
            }
        } catch (AndroidCredentialStore.CredentialStoreException ignored) {
            // Keep read-only status available when the local checkpoint cannot be resolved.
        }
        return status;
    }

    TaskMutationResult mutate(PendingTaskMutation.Action action, MobileTaskContract.Draft draft,
                              DeviceLinkTransport.SendGuard canSend) throws Exception {
        synchronized (TASK_MUTATION_LOCK) {
            if (store.hasPendingTaskMutation()) throw new TaskMutationHeld();
            DeviceCredential credential = requireCredential();
            MobileTaskContract.TaskStatus status = readTaskStatus(credential, draft, canSend);
            boolean eligible = action == PendingTaskMutation.Action.START
                    ? MobileTaskContract.TaskStatus.START_CANDIDATE.equals(status.kind)
                    : status.task != null &&
                      ("pending".equals(status.task.state) || "running".equals(status.task.state));
            if (!eligible) return new TaskMutationResult(status, false);

            PendingTaskMutation pending = PendingTaskMutation.forRequest(action, credential, draft,
                    status.task == null ? null : status.task.taskID);
            store.markTaskMutationPending(pending);
            Map<String, Object> response;
            try {
                response = body(credential, action.operation, Collections.singletonMap("申請ID", draft.id),
                        LIVE_OR_INTERNAL_EVIDENCE, canSend, null);
            } catch (DeviceLinkTransport.TransportException error) {
                if (!error.requestMayHaveReachedDesktop) store.clearTaskMutationPending(pending);
                throw error;
            }
            MobileTaskContract.TaskRecord record = action == PendingTaskMutation.Action.START
                    ? MobileTaskContract.started(response, draft)
                    : MobileTaskContract.cancellationRequested(response, draft);
            if (action == PendingTaskMutation.Action.CANCEL && !status.task.taskID.equals(record.taskID)) {
                throw new StrictJson.JsonException();
            }
            // 保留の解除は、受付応答の後に同じTaskを独立した状態照会で確認してから行う。
            return new TaskMutationResult(MobileTaskContract.TaskStatus.task(record), true);
        }
    }

    private Map<String, Object> body(DeviceCredential credential, String operation, Map<String, Object> content,
                                     Set<String> allowedEvidence, DeviceLinkTransport.SendGuard canSend,
                                     Attempt submissionAttempt) throws Exception {
        return exchange(credential, operation, content, allowedEvidence, canSend, submissionAttempt).body;
    }

    private PairingResponseParser.AcceptedResponse exchange(DeviceCredential credential, String operation,
                                                             Map<String, Object> content, Set<String> allowedEvidence,
                                                             DeviceLinkTransport.SendGuard canSend,
                                                             Attempt submissionAttempt) throws Exception {
        DeviceLinkTransport.Exchange exchange;
        DeviceLinkTransport.SendGuard boundSendGuard = () -> canSend != null && canSend.canSend() &&
                store.canUseCredentialForDeviceLink(credential);
        try {
            exchange = transport.taskOperation(credential, operation, content, boundSendGuard);
        } catch (DeviceLinkTransport.TransportException exception) {
            if (submissionAttempt != null && exception.requestMayHaveReachedDesktop) {
                submissionAttempt.taskSubmissionMayHaveReachedDesktop = true;
            }
            throw exception;
        }
        if (submissionAttempt != null) submissionAttempt.taskSubmissionMayHaveReachedDesktop = true;
        PairingResponseParser.AcceptedResponse response = PairingResponseParser.acceptedResponse(
                exchange.response, exchange.nonce, operation, allowedEvidence);
        if (!boundSendGuard.canSend()) {
            throw new DeviceLinkTransport.TransportException(true);
        }
        return response;
    }

    private DeviceCredential requireCredential() throws Exception {
        DeviceCredential credential = store.readForDeviceLink();
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

    static final class TaskMutationResult {
        final MobileTaskContract.TaskStatus status;
        final boolean requestSent;
        TaskMutationResult(MobileTaskContract.TaskStatus status, boolean requestSent) {
            this.status = status; this.requestSent = requestSent;
        }
    }

    static final class TaskMutationHeld extends Exception {}

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
