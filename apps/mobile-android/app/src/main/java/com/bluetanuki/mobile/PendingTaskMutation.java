package com.bluetanuki.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Local result reconciliation record. It carries no credential or authority. */
final class PendingTaskMutation {
    static final int MAX_PENDING = 32;
    private static final String LIST_VERSION = "v2\n";
    private static final String REQUEST_SCOPE = "blue-tanuki.mobile-task-mutation-scope.v1";
    private static final String DIGEST_FORMAT = "[a-f0-9]{64}";

    enum Action {
        START("AgentTask端末実行"),
        CANCEL("AgentTask端末取消");

        final String operation;

        Action(String operation) {
            this.operation = operation;
        }
    }

    final Action action;
    private final String requestDigest;
    private final String scopeDigest;

    private PendingTaskMutation(Action action, String requestDigest, String scopeDigest) {
        this.action = action;
        this.requestDigest = requestDigest;
        this.scopeDigest = scopeDigest;
    }

    static PendingTaskMutation forRequest(Action action, DeviceCredential credential,
                                          MobileTaskContract.Draft draft, String taskID) {
        if (action == Action.CANCEL && taskID == null) throw new IllegalArgumentException();
        return new PendingTaskMutation(action, requestDigest(credential, draft), scopeDigest(action, credential, draft, taskID));
    }

    private static String scopeDigest(Action action, DeviceCredential credential,
                                      MobileTaskContract.Draft draft, String taskID) {
        String binding = credential.hostId + "|" + credential.certificateSha256 + "|" +
                credential.deviceId + "|" + draft.id + "|" + draft.runtimeID + "|" + draft.sessionID +
                "|" + draft.workspaceID + "|" + draft.instructionHash +
                "|" + (action == Action.CANCEL ? taskID : "");
        return digest(binding);
    }

    private static String requestDigest(DeviceCredential credential, MobileTaskContract.Draft draft) {
        return digest(REQUEST_SCOPE + "|" + credential.hostId + "|" + credential.certificateSha256 +
                "|" + credential.deviceId + "|" + draft.id);
    }

    private static String digest(String binding) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8));
            return DeviceInvitation.hex(digest);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }

    static PendingTaskMutation decode(String value) throws StrictJson.JsonException {
        String[] fields = value.split(":", -1);
        if ((fields.length != 2 && fields.length != 3) || !fields[1].matches(DIGEST_FORMAT) ||
                (fields.length == 3 && !fields[2].matches(DIGEST_FORMAT))) {
            throw new StrictJson.JsonException();
        }
        try {
            return new PendingTaskMutation(Action.valueOf(fields[0]), fields.length == 3 ? fields[2] : null, fields[1]);
        } catch (IllegalArgumentException exception) {
            throw new StrictJson.JsonException();
        }
    }

    String encode() {
        return action.name() + ":" + scopeDigest + (requestDigest == null ? "" : ":" + requestDigest);
    }

    static String encodeList(List<PendingTaskMutation> pending) {
        StringBuilder value = new StringBuilder(LIST_VERSION);
        for (PendingTaskMutation mutation : pending) {
            if (value.length() > LIST_VERSION.length()) value.append('\n');
            value.append(mutation.encode());
        }
        return value.toString();
    }

    static List<PendingTaskMutation> decodeList(String value) throws StrictJson.JsonException {
        if (!value.startsWith(LIST_VERSION)) {
            PendingTaskMutation legacy = decode(value);
            if (legacy.requestDigest != null) throw new StrictJson.JsonException();
            return Collections.singletonList(legacy);
        }
        String[] records = value.substring(LIST_VERSION.length()).split("\n", -1);
        if (records.length > MAX_PENDING) throw new StrictJson.JsonException();
        List<PendingTaskMutation> pending = new ArrayList<>();
        Set<String> requests = new HashSet<>();
        for (String record : records) {
            PendingTaskMutation mutation = decode(record);
            if (mutation.requestDigest == null || !requests.add(mutation.requestDigest)) {
                throw new StrictJson.JsonException();
            }
            pending.add(mutation);
        }
        return pending;
    }

    static boolean blocks(List<PendingTaskMutation> pending, DeviceCredential credential, MobileTaskContract.Draft draft) {
        if (pending.size() >= MAX_PENDING) return true;
        for (PendingTaskMutation mutation : pending) {
            if (mutation.requestDigest == null || mutation.matchesTarget(credential, draft)) return true;
        }
        return false;
    }

    boolean conflictsWith(PendingTaskMutation pending) {
        return requestDigest == null || pending.requestDigest == null || requestDigest.equals(pending.requestDigest);
    }

    boolean matchesTarget(DeviceCredential credential, MobileTaskContract.Draft draft) {
        return requestDigest == null
                ? matchesListedRequest(credential, draft)
                : requestDigest.equals(requestDigest(credential, draft));
    }

    boolean matchesListedRequest(DeviceCredential credential, MobileTaskContract.Draft draft) {
        return matchesRequest(credential, draft, draft.taskID);
    }

    private boolean matchesRequest(DeviceCredential credential, MobileTaskContract.Draft draft, String taskID) {
        return (action != Action.CANCEL || taskID != null) &&
                scopeDigest.equals(scopeDigest(action, credential, draft, taskID));
    }

    boolean resolvedBy(DeviceCredential credential, MobileTaskContract.Draft draft,
                       MobileTaskContract.TaskStatus status, String evidenceSource) {
        if (!("INTERNAL_STATE".equals(evidenceSource) || "LIVE_RUNTIME".equals(evidenceSource)) ||
                status.task == null || !MobileTaskContract.matches(status.task, draft) ||
                !matchesRequest(credential, draft, status.task.taskID) ||
                (requestDigest != null && !requestDigest.equals(requestDigest(credential, draft)))) {
            return false;
        }
        String state = status.task.state;
        return (action == Action.START && "running".equals(state)) ||
                "cancelled".equals(state) || "completed".equals(state) || "failed".equals(state);
    }
}
