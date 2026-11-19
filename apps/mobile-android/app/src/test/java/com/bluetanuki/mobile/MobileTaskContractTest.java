package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import org.junit.Test;

public final class MobileTaskContractTest {
    private static final String SESSION = "0123456789abcdef0123456789abcdef";
    private static final String REQUEST = "abcdef0123456789abcdef0123456789";
    private static final String HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
    public void acceptedOperationRequiresExactNonceOperationAndLiveEvidence() throws Exception {
        String response = "{\"request_id\":\"" + SESSION + "\",\"operation\":\"AgentTask端末状態\"," +
                "\"status\":\"accepted\",\"evidence_source\":\"LIVE_RUNTIME\",\"audit_event_id\":\"evt-1\"," +
                "\"error\":null,\"health\":null,\"body\":{\"状態\":\"ok\"},\"shutdown_requested\":false}";
        PairingResponseParser.AcceptedResponse live = PairingResponseParser.acceptedResponse(response, SESSION,
                "AgentTask端末状態", Collections.singleton("LIVE_RUNTIME"));
        assertEquals("ok", StrictJson.string(live.body, "状態"));
        assertTrue(live.liveRuntime);

        String internal = response.replace("LIVE_RUNTIME", "INTERNAL_STATE");
        PairingResponseParser.AcceptedResponse observed = PairingResponseParser.acceptedResponse(internal, SESSION,
                "AgentTask端末状態", new HashSet<>(Arrays.asList("LIVE_RUNTIME", "INTERNAL_STATE")));
        assertEquals("ok", StrictJson.string(observed.body, "状態"));
        assertFalse(observed.liveRuntime);

        String fixture = response.replace("LIVE_RUNTIME", "FIXTURE");
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.acceptedResponse(fixture, SESSION,
                        "AgentTask端末状態", Collections.singleton("LIVE_RUNTIME")));
    }
}
