package com.bluetanuki.mobile;

import java.util.List;

/** 保護済みの端末内照合記録。依頼本文や資格は保存しない。 */
final class PendingTaskSubmission {
    final String sessionID;
    private final String scopeDigest;

    private PendingTaskSubmission(String sessionID, String scopeDigest) {
        this.sessionID = sessionID;
        this.scopeDigest = scopeDigest;
    }

    static PendingTaskSubmission forRequest(DeviceCredential credential, String runtimeID,
                                            String sessionID, String workspaceID, String instructionHash) {
        String scope = "blue-tanuki.mobile.task-submission.v1|" + credential.hostId + "|" +
                credential.certificateSha256 + "|" + credential.deviceId + "|" + runtimeID + "|" +
                sessionID + "|" + workspaceID + "|" + instructionHash;
        return new PendingTaskSubmission(sessionID, MobileTaskContract.sha256(scope));
    }

    static PendingTaskSubmission decode(String value) throws StrictJson.JsonException {
        if (MobileTaskContract.validRequestID(value)) return new PendingTaskSubmission(value, null);
        String[] fields = value.split(":", -1);
        if (fields.length != 3 || !"v2".equals(fields[0]) || !MobileTaskContract.validRequestID(fields[1]) ||
                !fields[2].matches("[a-f0-9]{64}")) throw new StrictJson.JsonException();
        return new PendingTaskSubmission(fields[1], fields[2]);
    }

    String encode() {
        return scopeDigest == null ? sessionID : "v2:" + sessionID + ":" + scopeDigest;
    }

    boolean matchesOwnedRequest(DeviceCredential credential, List<MobileTaskContract.Draft> entries) {
        // 旧session ID単体からは、同じ依頼か判断できない。
        if (scopeDigest == null) return false;
        MobileTaskContract.Draft candidate = null;
        for (MobileTaskContract.Draft entry : entries) {
            if (!sessionID.equals(entry.sessionID)) continue;
            if (candidate != null) return false;
            candidate = entry;
        }
        return candidate != null && scopeDigest.equals(forRequest(credential, candidate.runtimeID,
                candidate.sessionID, candidate.workspaceID, candidate.instructionHash).scopeDigest);
    }
}
