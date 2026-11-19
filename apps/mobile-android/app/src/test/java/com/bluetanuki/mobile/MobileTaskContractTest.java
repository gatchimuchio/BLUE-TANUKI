package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public final class MobileTaskContractTest {
    private static final String SESSION = "0123456789abcdef0123456789abcdef";
    private static final String REQUEST = "abcdef0123456789abcdef0123456789";
    private static final String HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    public void dialogueSessionStartsWithTheRegisteredRuntimeAndWorkspace() throws Exception {
        Map<String, Object> scope = MobileTaskContract.sessionStartPayload("runtime-1", "workspace-2");
        assertEquals(Map.of("実行系ID", "runtime-1", "作業領域ID", "workspace-2"), scope);
        assertThrows(StrictJson.JsonException.class,
                () -> MobileTaskContract.sessionStartPayload("runtime-1", ""));
        assertThrows(StrictJson.JsonException.class,
                () -> MobileTaskContract.sessionStartPayload("runtime-1", "../workspace"));
    }

    @Test
    public void requestContainsOnlyBoundTaskFieldsAndPreservesUnicode() throws Exception {
        Map<String, Object> request = MobileTaskContract.requestPayload(
                "runtime:windows", SESSION, "workspace-1", "資料を整理して😀", HASH);
        assertTrue(StrictJson.hasExactKeys(request, "agent_runtime_id", "session_id", "workspace_id",
                "instruction", "mcp_capability_snapshot_hash"));
        assertEquals("runtime:windows", StrictJson.string(request, "agent_runtime_id"));
        assertEquals("資料を整理して😀", StrictJson.string(request, "instruction"));
        assertThrows(StrictJson.JsonException.class,
                () -> MobileTaskContract.validateInstruction(" \n\t "));
    }

    @Test
    public void submissionReceiptBindsTheExactInstructionBytesAndScope() throws Exception {
        String submitted = "  資料😀e\u0301\r\n";
        String instructionHash = MobileTaskContract.instructionHash(submitted);
        assertEquals("sha256:d46f34ba58c50cc80fd267ad86e436c9092eb19c135036d83fdceeaa19c3ec93", instructionHash);
        assertFalse(instructionHash.equals(MobileTaskContract.instructionHash(submitted.trim())));
        assertThrows(StrictJson.JsonException.class, () -> MobileTaskContract.instructionHash("依頼\uD800"));

        String receipt = "{\"版\":1,\"申請ID\":\"" + REQUEST + "\",\"状態\":\"Owner確認待ち\",\"実行系ID\":\"runtime\"," +
                "\"対話セッションID\":\"" + SESSION + "\",\"作業領域ID\":\"workspace\",\"指示hash\":\"" +
                instructionHash + "\",\"期限\":2000}";
        MobileTaskContract.Draft accepted = MobileTaskContract.submission(StrictJson.object(StrictJson.parse(receipt)),
                "runtime", SESSION, "workspace", instructionHash);
        assertEquals(instructionHash, accepted.instructionHash);
        for (String mismatch : List.of(receipt.replace(instructionHash, HASH), receipt.replace(SESSION, REQUEST),
                receipt.replace("\"runtime\"", "\"other-runtime\""), receipt.replace("\"workspace\"", "\"other-workspace\""))) {
            assertThrows(StrictJson.JsonException.class, () -> MobileTaskContract.submission(
                    StrictJson.object(StrictJson.parse(mismatch)), "runtime", SESSION, "workspace", instructionHash));
        }
    }

    @Test
    public void pendingSubmissionRequiresAUniqueMatchFromTheSameDesktopAndScope() throws Exception {
        DeviceCredential desktop = new DeviceCredential("127.0.0.1", 8443, SESSION, "a".repeat(64),
                REQUEST, 2000, REQUEST, "b".repeat(64));
        PendingTaskSubmission checkpoint = PendingTaskSubmission.forRequest(desktop, "runtime", SESSION, "workspace", HASH);
        PendingTaskSubmission restored = PendingTaskSubmission.decode(checkpoint.encode());
        assertEquals(checkpoint.encode(), restored.encode());
        MobileTaskContract.Draft matching = new MobileTaskContract.Draft(
                REQUEST, "runtime", SESSION, "workspace", HASH, 1000, 2000, null);
        MobileTaskContract.Draft unrelated = new MobileTaskContract.Draft(
                SESSION, "runtime", REQUEST, "workspace", HASH, 1000, 2000, null);
        assertTrue(restored.matchesOwnedRequest(desktop, List.of(unrelated, matching)));
        assertFalse(restored.matchesOwnedRequest(desktop, List.of(unrelated)));
        MobileTaskContract.Draft secondMatch = new MobileTaskContract.Draft(
                SESSION, "runtime", SESSION, "workspace", HASH, 1000, 2000, null);
        assertFalse(restored.matchesOwnedRequest(desktop, List.of(matching, secondMatch)));
        for (MobileTaskContract.Draft mismatch : List.of(
                new MobileTaskContract.Draft(SESSION, "other-runtime", SESSION, "workspace", HASH, 1000, 2000, null),
                new MobileTaskContract.Draft(SESSION, "runtime", SESSION, "different", HASH, 1000, 2000, null),
                new MobileTaskContract.Draft(SESSION, "runtime", SESSION, "workspace", "sha256:" + "c".repeat(64), 1000, 2000, null))) {
            assertFalse(restored.matchesOwnedRequest(desktop, List.of(mismatch)));
            assertFalse(restored.matchesOwnedRequest(desktop, List.of(matching, mismatch)));
        }
        DeviceCredential differentPin = new DeviceCredential("127.0.0.1", 8443, SESSION, "c".repeat(64),
                REQUEST, 2000, REQUEST, "b".repeat(64));
        assertFalse(restored.matchesOwnedRequest(differentPin, List.of(matching)));
        PendingTaskSubmission legacy = PendingTaskSubmission.decode(SESSION);
        assertEquals(SESSION, legacy.encode());
        assertFalse(legacy.matchesOwnedRequest(desktop, List.of(matching)));
        assertThrows(StrictJson.JsonException.class, () -> PendingTaskSubmission.decode("v2:" + SESSION + ":unexpected"));
    }

    @Test
    public void runtimeAndWorkspaceListsRejectDuplicatesAndUnknownFields() throws Exception {
        Map<String, Object> runtimes = StrictJson.object(StrictJson.parse(
                "{\"実行系\":[\"runtime-1\",\"runtime-2\"]}"));
        assertEquals(2, MobileTaskContract.runtimes(runtimes).size());
        Map<String, Object> duplicate = StrictJson.object(StrictJson.parse(
                "{\"実行系\":[\"runtime-1\",\"runtime-1\"]}"));
        assertThrows(StrictJson.JsonException.class, () -> MobileTaskContract.runtimes(duplicate));
        Map<String, Object> extra = StrictJson.object(StrictJson.parse(
                "{\"作業領域\":[],\"authority\":true}"));
        assertThrows(StrictJson.JsonException.class, () -> MobileTaskContract.workspaces(extra));
    }

    @Test
    public void taskProjectionBindsTheRequestAndNeverAcceptsResultText() throws Exception {
        String json = "{\"申請ID\":\"" + REQUEST + "\",\"状態\":\"Task状態\",\"Task\":{" +
                "\"task_id\":\"" + SESSION + "\",\"実行系ID\":\"runtime-1\",\"対話セッションID\":\"" + SESSION + "\"," +
                "\"作業領域ID\":\"workspace-1\",\"指示hash\":\"" + HASH + "\",\"状態\":\"completed\"," +
                "\"結果hash\":null,\"結果本文あり\":true}}";
        MobileTaskContract.Draft draft = new MobileTaskContract.Draft(
                REQUEST, "runtime-1", SESSION, "workspace-1", HASH, 100, 200, SESSION);
        MobileTaskContract.TaskStatus status = MobileTaskContract.status(
                StrictJson.object(StrictJson.parse(json)), draft);
        assertEquals(MobileTaskContract.TaskStatus.TASK, status.kind);
        assertTrue(status.task.resultContentAvailable);
        assertEquals(null, status.task.resultHash);

        String withResultText = json.replace("\"結果hash\":null", "\"結果本文\":\"private\",\"結果hash\":null");
        assertThrows(StrictJson.JsonException.class, () -> MobileTaskContract.status(
                StrictJson.object(StrictJson.parse(withResultText)), draft));
    }

    @Test
    public void mcpSnapshotAllowsOnlyMetadataAndKnownStates() throws Exception {
        Map<String, Object> available = StrictJson.object(StrictJson.parse(
                "{\"版\":1,\"Agent能力hash\":\"" + HASH + "\",\"Agent能力件数\":2," +
                        "\"Agent能力状態\":\"available\",\"公開範囲\":\"metadata_only\"}"));
        assertTrue(MobileTaskContract.mcpSnapshot(available).usable());
        Map<String, Object> named = StrictJson.object(StrictJson.parse(
                "{\"版\":1,\"Agent能力hash\":\"" + HASH + "\",\"Agent能力件数\":2," +
                        "\"Agent能力状態\":\"available\",\"公開範囲\":\"metadata_only\",\"tools\":[\"x\"]}"));
        assertThrows(StrictJson.JsonException.class, () -> MobileTaskContract.mcpSnapshot(named));
        Map<String, Object> unsupported = StrictJson.object(StrictJson.parse(
                "{\"版\":1,\"Agent能力hash\":null,\"Agent能力件数\":0," +
                        "\"Agent能力状態\":\"unsupported\",\"公開範囲\":\"metadata_only\"}"));
        assertFalse(MobileTaskContract.mcpSnapshot(unsupported).usable());
    }

    @Test
    public void acceptedOperationRequiresExactNonceOperationAndAllowedEvidence() throws Exception {
        String response = "{\"request_id\":\"" + SESSION + "\",\"operation\":\"AgentTask端末状態\"," +
                "\"status\":\"accepted\",\"evidence_source\":\"LIVE_RUNTIME\",\"audit_event_id\":\"evt-1\"," +
                "\"error\":null,\"health\":null,\"body\":{\"状態\":\"ok\"},\"shutdown_requested\":false}";
        PairingResponseParser.AcceptedResponse live = PairingResponseParser.acceptedResponse(response, SESSION,
                "AgentTask端末状態", Collections.singleton("LIVE_RUNTIME"));
        assertEquals("ok", StrictJson.string(live.body, "状態"));
        assertEquals("LIVE_RUNTIME", live.evidenceSource);

        String internal = response.replace("LIVE_RUNTIME", "INTERNAL_STATE");
        Set<String> allowedEvidence = Set.of("LIVE_RUNTIME", "INTERNAL_STATE");
        PairingResponseParser.AcceptedResponse observed = PairingResponseParser.acceptedResponse(internal, SESSION,
                "AgentTask端末状態", allowedEvidence);
        assertEquals("ok", StrictJson.string(observed.body, "状態"));
        assertEquals("INTERNAL_STATE", observed.evidenceSource);
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.acceptedResponse(internal, REQUEST, "AgentTask端末状態", allowedEvidence));
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.acceptedResponse(internal, SESSION, "AgentTask端末取消", allowedEvidence));

        String fixture = response.replace("LIVE_RUNTIME", "FIXTURE");
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.acceptedResponse(fixture, SESSION,
                        "AgentTask端末状態", allowedEvidence));
    }
}
