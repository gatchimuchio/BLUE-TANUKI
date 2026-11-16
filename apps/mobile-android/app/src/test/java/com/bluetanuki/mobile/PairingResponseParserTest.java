package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class PairingResponseParserTest {
    private static final String NONCE = "1".repeat(32);
    private static final String HOST_ID = "a".repeat(32);
    private static final String CERTIFICATE = "b".repeat(64);
    private static final String DEVICE_ID = "c".repeat(32);
    private static final String INVITATION_ID = "d".repeat(32);
    private static final String INVITATION_SECRET = "e".repeat(64);
    private static final String CREDENTIAL_ID = "f".repeat(32);
    private static final String CREDENTIAL_SECRET = "0".repeat(64);

    private DeviceInvitation invitation() throws Exception {
        return DeviceInvitation.create("192.168.1.10", "7443", HOST_ID, CERTIFICATE,
                DEVICE_ID, DEVICE_ID, "1300", INVITATION_ID, INVITATION_SECRET, 1000);
    }

    @Test
    public void acceptsOnlyTheCredentialBoundToTheInvitation() throws Exception {
        String response = pairingEnvelope(NONCE, "accepted", body());
        DeviceCredential credential = PairingResponseParser.parse(response, invitation(), NONCE, 1001);
        assertEquals(DEVICE_ID, credential.deviceId);
        assertEquals(CREDENTIAL_ID, credential.credentialId);
        assertEquals(CREDENTIAL_SECRET, credential.credentialSecret);
        assertEquals("192.168.1.10", credential.host);
    }

    @Test
    public void rejectsAValidEnvelopeForAnotherRequestAsUnknown() throws Exception {
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.parse(pairingEnvelope("2".repeat(32), "accepted", body()),
                        invitation(), NONCE, 1001));
    }

    @Test
    public void refusesChangedHostFingerprintOrDeviceAndUnknownBodyFields() throws Exception {
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.parse(pairingEnvelope(NONCE, "accepted",
                        body().replace(CERTIFICATE, "9".repeat(64))), invitation(), NONCE, 1001));
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.parse(pairingEnvelope(NONCE, "accepted",
                        body().replace("\"端末ID\":\"" + DEVICE_ID + "\"",
                                "\"端末ID\":\"" + "9".repeat(32) + "\"")),
                        invitation(), NONCE, 1001));
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.parse(pairingEnvelope(NONCE, "accepted",
                        body().replace("\"端末秘密\"", "\"extra\":\"x\",\"端末秘密\"")),
                        invitation(), NONCE, 1001));
    }

    @Test
    public void refusesDuplicateKeysAndExplicitlyClassifiesBrokerRejection() throws Exception {
        String duplicate = pairingEnvelope(NONCE, "accepted", body())
                .replace("\"request_id\":\"" + NONCE + "\"",
                        "\"request_id\":\"" + NONCE + "\",\"request_id\":\"" + NONCE + "\"");
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.parse(duplicate, invitation(), NONCE, 1001));

        String rejected = "{\"request_id\":\"" + NONCE + "\",\"operation\":\"端末結合\"," +
                "\"status\":\"rejected\",\"evidence_source\":\"LIVE_RUNTIME\"," +
                "\"audit_event_id\":\"event-1\",\"error\":{" +
                "\"code\":\"拒否\",\"message\":\"Desktop拒否\",\"recoverable\":false," +
                "\"audit_event_required\":true,\"fail_closed\":true}," +
                "\"health\":null,\"body\":null,\"shutdown_requested\":false}";
        assertThrows(PairingResponseParser.PairingRejectedException.class,
                () -> PairingResponseParser.parse(rejected, invitation(), NONCE, 1001));
        String malformed = rejected.replace("\"fail_closed\":true", "\"fail_closed\":\"true\"");
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.parse(malformed, invitation(), NONCE, 1001));
    }

    @Test
    public void terminalCheckRequiresExactRequestAndConnectionProjection() throws Exception {
        String accepted = "{\"request_id\":\"" + NONCE + "\",\"operation\":\"端末確認\"," +
                "\"status\":\"accepted\",\"evidence_source\":\"INTERNAL_STATE\"," +
                "\"audit_event_id\":\"event-2\",\"error\":null,\"health\":null," +
                "\"body\":{\"状態\":\"接続中\"},\"shutdown_requested\":false}";
        PairingResponseParser.requireConnectedResponse(accepted, NONCE);
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.requireConnectedResponse(
                        accepted.replace("\"接続中\"", "\"許可\""), NONCE));
    }

    @Test
    public void terminalLeaveRequiresExactRequestAndRevokedProjection() throws Exception {
        String accepted = "{\"request_id\":\"" + NONCE + "\",\"operation\":\"端末離脱\"," +
                "\"status\":\"accepted\",\"evidence_source\":\"LIVE_RUNTIME\"," +
                "\"audit_event_id\":\"event-3\",\"error\":null,\"health\":null," +
                "\"body\":{\"状態\":\"失効\"},\"shutdown_requested\":false}";
        PairingResponseParser.requireDisconnectedResponse(accepted, NONCE);
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.requireDisconnectedResponse(
                        accepted.replace("\"失効\"", "\"接続中\""), NONCE));
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.requireDisconnectedResponse(accepted,
                        "2".repeat(32)));
        assertThrows(PairingResponseParser.PairingUnknownException.class,
                () -> PairingResponseParser.requireDisconnectedResponse(
                        accepted.replace("LIVE_RUNTIME", "FIXTURE"), NONCE));

        String rejected = "{\"request_id\":\"" + NONCE + "\",\"operation\":\"端末離脱\"," +
                "\"status\":\"rejected\",\"evidence_source\":\"LIVE_RUNTIME\"," +
                "\"audit_event_id\":\"event-4\",\"error\":{\"code\":\"拒否\"," +
                "\"message\":\"Desktop拒否\",\"recoverable\":false," +
                "\"audit_event_required\":true,\"fail_closed\":true}," +
                "\"health\":null,\"body\":null,\"shutdown_requested\":false}";
        assertThrows(PairingResponseParser.PairingRejectedException.class,
                () -> PairingResponseParser.requireDisconnectedResponse(rejected, NONCE));
    }

    private String body() {
        return "{\"版\":1,\"HostID\":\"" + HOST_ID + "\",\"接続先Host\":\"192.168.1.10\"," +
                "\"port\":7443,\"証明書hash\":\"" + CERTIFICATE + "\",\"端末ID\":\"" +
                DEVICE_ID + "\",\"有効期限\":29800,\"結合ID\":\"" + CREDENTIAL_ID +
                "\",\"端末秘密\":\"" + CREDENTIAL_SECRET + "\"}";
    }

    private String pairingEnvelope(String nonce, String status, String body) {
        return "{\"request_id\":\"" + nonce + "\",\"operation\":\"端末結合\"," +
                "\"status\":\"" + status + "\",\"evidence_source\":\"LIVE_RUNTIME\"," +
                "\"audit_event_id\":\"event-1\",\"error\":null,\"health\":null," +
                "\"body\":" + body + ",\"shutdown_requested\":false}";
    }
}
