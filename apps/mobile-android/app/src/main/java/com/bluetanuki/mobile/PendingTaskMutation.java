package com.bluetanuki.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Local result reconciliation record. It carries no credential or authority. */
final class PendingTaskMutation {
    enum Action {
        START("AgentTask端末実行"),
        CANCEL("AgentTask端末取消");

        final String operation;

        Action(String operation) {
            this.operation = operation;
        }
    }

    final Action action;
    private final String scopeDigest;

    private PendingTaskMutation(Action action, String scopeDigest) {
        this.action = action;
        this.scopeDigest = scopeDigest;
    }

    static PendingTaskMutation forRequest(Action action, DeviceCredential credential,
                                          MobileTaskContract.Draft draft, String taskID) {
        if (action == Action.CANCEL && taskID == null) throw new IllegalArgumentException();
        String binding = credential.hostId + "|" + credential.certificateSha256 + "|" +
                credential.deviceId + "|" + draft.id + "|" + draft.runtimeID + "|" + draft.sessionID +
                "|" + draft.workspaceID + "|" + draft.instructionHash +
                "|" + (action == Action.CANCEL ? taskID : "");
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8));
            return new PendingTaskMutation(action, DeviceInvitation.hex(digest));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }

    static PendingTaskMutation decode(String value) throws StrictJson.JsonException {
        String[] fields = value.split(":", -1);
        if (fields.length != 2 || !fields[1].matches("[a-f0-9]{64}")) {
            throw new StrictJson.JsonException();
        }
        try {
            return new PendingTaskMutation(Action.valueOf(fields[0]), fields[1]);
        } catch (IllegalArgumentException exception) {
            throw new StrictJson.JsonException();
        }
    }

    String encode() {
        return action.name() + ":" + scopeDigest;
    }

    boolean matchesListedRequest(DeviceCredential credential, MobileTaskContract.Draft draft) {
        return matchesRequest(credential, draft, draft.taskID);
    }

    private boolean matchesRequest(DeviceCredential credential, MobileTaskContract.Draft draft, String taskID) {
        return (action != Action.CANCEL || taskID != null) &&
                scopeDigest.equals(forRequest(action, credential, draft, taskID).scopeDigest);
    }

    boolean resolvedBy(DeviceCredential credential, MobileTaskContract.Draft draft,
                       MobileTaskContract.TaskStatus status, String evidenceSource) {
        if (!("INTERNAL_STATE".equals(evidenceSource) || "LIVE_RUNTIME".equals(evidenceSource)) ||
                status.task == null || !MobileTaskContract.matches(status.task, draft) ||
                !matchesRequest(credential, draft, status.task.taskID)) {
            return false;
        }
        String state = status.task.state;
        return (action == Action.START && "running".equals(state)) ||
                "cancelled".equals(state) || "completed".equals(state) || "failed".equals(state);
    }
}
