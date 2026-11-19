package com.bluetanuki.mobile;

import java.util.Map;
import java.util.Set;

final class PairingResponseParser {
    private PairingResponseParser() {}

    static DeviceCredential parse(String json, DeviceInvitation invitation,
                                  String nonce, long nowSeconds)
            throws PairingRejectedException, PairingUnknownException {
        try {
            Map<String, Object> envelope = StrictJson.object(StrictJson.parse(json));
            String status = requireEnvelope(envelope, nonce, "端末結合");
            if ("rejected".equals(status) || "suspended".equals(status)) {
                throw new PairingRejectedException();
            }
            if (!"LIVE_RUNTIME".equals(StrictJson.string(envelope, "evidence_source"))) {
                throw new PairingUnknownException();
            }
            Map<String, Object> body = StrictJson.object(envelope.get("body"));
            if (!StrictJson.hasExactKeys(body, "版", "HostID", "接続先Host", "port",
                    "証明書hash", "端末ID", "有効期限", "結合ID", "端末秘密") ||
                    StrictJson.integer(body, "版") != 1 ||
                    !invitation.hostId.equals(StrictJson.string(body, "HostID")) ||
                    !invitation.host.equals(StrictJson.string(body, "接続先Host")) ||
                    StrictJson.integer(body, "port") != invitation.port ||
                    !invitation.certificateSha256.equals(StrictJson.string(body, "証明書hash")) ||
                    !invitation.deviceId.equals(StrictJson.string(body, "端末ID"))) {
                throw new PairingUnknownException();
            }
            long expiresAt = StrictJson.integer(body, "有効期限");
            if (expiresAt <= nowSeconds || expiresAt > nowSeconds + 8 * 60 * 60 + 60) {
                throw new PairingUnknownException();
            }
            String credentialId = StrictJson.string(body, "結合ID");
            String credentialSecret = StrictJson.string(body, "端末秘密");
            DeviceInvitation.requireHex(credentialId, 32);
            DeviceInvitation.requireHex(credentialSecret, 64);
            return new DeviceCredential(invitation.host, invitation.port, invitation.hostId,
                    invitation.certificateSha256, invitation.deviceId, expiresAt,
                    credentialId, credentialSecret);
        } catch (PairingRejectedException | PairingUnknownException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new PairingUnknownException();
        }
    }

    static void requireConnectedResponse(String json, String nonce)
            throws PairingRejectedException, PairingUnknownException {
        try {
            Map<String, Object> envelope = StrictJson.object(StrictJson.parse(json));
            String status = requireEnvelope(envelope, nonce, "端末確認");
            if ("rejected".equals(status) || "suspended".equals(status)) {
                throw new PairingRejectedException();
            }
            if (!"INTERNAL_STATE".equals(StrictJson.string(envelope, "evidence_source"))) {
                throw new PairingUnknownException();
            }
            Map<String, Object> body = StrictJson.object(envelope.get("body"));
            if (!StrictJson.hasExactKeys(body, "状態") ||
                    !"接続中".equals(StrictJson.string(body, "状態"))) {
                throw new PairingUnknownException();
            }
        } catch (PairingRejectedException | PairingUnknownException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new PairingUnknownException();
        }
    }

    static void requireDisconnectedResponse(String json, String nonce)
            throws PairingRejectedException, PairingUnknownException {
        try {
            Map<String, Object> envelope = StrictJson.object(StrictJson.parse(json));
            String status = requireEnvelope(envelope, nonce, "端末離脱");
            if ("rejected".equals(status) || "suspended".equals(status)) {
                throw new PairingRejectedException();
            }
            if (!"LIVE_RUNTIME".equals(StrictJson.string(envelope, "evidence_source"))) {
                throw new PairingUnknownException();
            }
            Map<String, Object> body = StrictJson.object(envelope.get("body"));
            if (!StrictJson.hasExactKeys(body, "状態") ||
                    !"失効".equals(StrictJson.string(body, "状態"))) {
                throw new PairingUnknownException();
            }
        } catch (PairingRejectedException | PairingUnknownException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new PairingUnknownException();
        }
    }

    static AcceptedResponse acceptedResponse(String json, String nonce, String operation,
                                             Set<String> allowedEvidence)
            throws PairingRejectedException, PairingUnknownException {
        try {
            Map<String, Object> envelope = StrictJson.object(StrictJson.parse(json));
            String status = requireEnvelope(envelope, nonce, operation);
            if ("rejected".equals(status) || "suspended".equals(status)) {
                throw new PairingRejectedException();
            }
            String evidence = StrictJson.string(envelope, "evidence_source");
            if (!allowedEvidence.contains(evidence)) {
                throw new PairingUnknownException();
            }
            return new AcceptedResponse(StrictJson.object(envelope.get("body")), "LIVE_RUNTIME".equals(evidence));
        } catch (PairingRejectedException | PairingUnknownException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new PairingUnknownException();
        }
    }

    static final class AcceptedResponse {
        final Map<String, Object> body;
        final boolean liveRuntime;

        private AcceptedResponse(Map<String, Object> body, boolean liveRuntime) {
            this.body = body;
            this.liveRuntime = liveRuntime;
        }
    }

    private static String requireEnvelope(Map<String, Object> envelope, String nonce,
                                          String operation)
            throws StrictJson.JsonException, PairingUnknownException {
        if (!StrictJson.hasExactKeys(envelope, "request_id", "operation", "status",
                "evidence_source", "audit_event_id", "error", "health", "body",
                "shutdown_requested") ||
                !nonce.equals(StrictJson.string(envelope, "request_id")) ||
                !operation.equals(StrictJson.string(envelope, "operation")) ||
                envelope.get("health") != null ||
                !Boolean.FALSE.equals(envelope.get("shutdown_requested"))) {
            throw new PairingUnknownException();
        }
        String status = StrictJson.string(envelope, "status");
        if (!"accepted".equals(status) && !"rejected".equals(status) &&
                !"suspended".equals(status)) {
            throw new PairingUnknownException();
        }
        String evidenceSource = StrictJson.string(envelope, "evidence_source");
        if (!"LIVE_RUNTIME".equals(evidenceSource) &&
                !"INTERNAL_STATE".equals(evidenceSource) &&
                !"CONFIG".equals(evidenceSource) &&
                !"EXTERNAL_EVIDENCE".equals(evidenceSource) &&
                !"FIXTURE".equals(evidenceSource)) {
            throw new PairingUnknownException();
        }
        String auditEventId = StrictJson.string(envelope, "audit_event_id");
        if (!hasIdentifierCharacters(auditEventId, 1, 256, "_.:-")) {
            throw new PairingUnknownException();
        }
        Object error = envelope.get("error");
        Object body = envelope.get("body");
        if ("accepted".equals(status)) {
            if (error != null || !(body instanceof Map<?, ?>)) {
                throw new PairingUnknownException();
            }
        } else {
            validateError(error);
            if (body != null) {
                throw new PairingUnknownException();
            }
        }
        return status;
    }

    private static void validateError(Object value) throws StrictJson.JsonException,
            PairingUnknownException {
        Map<String, Object> error = StrictJson.object(value);
        if (!StrictJson.hasExactKeys(error, "code", "message", "recoverable",
                "audit_event_required", "fail_closed")) {
            throw new PairingUnknownException();
        }
        String code = StrictJson.string(error, "code");
        String message = StrictJson.string(error, "message");
        if (!hasIdentifierCharacters(code, 1, 96, "_.-") || message.length() > 1_048_576 ||
                !(error.get("recoverable") instanceof Boolean) ||
                !(error.get("audit_event_required") instanceof Boolean) ||
                !(error.get("fail_closed") instanceof Boolean)) {
            throw new PairingUnknownException();
        }
    }

    private static boolean hasIdentifierCharacters(String value, int minLength,
                                                   int maxLength, String allowedPunctuation) {
        if (value == null || value.length() < minLength || value.length() > maxLength) {
            return false;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (!Character.isLetterOrDigit(character) &&
                    allowedPunctuation.indexOf(character) < 0) {
                return false;
            }
        }
        return true;
    }

    static final class PairingRejectedException extends Exception {
        PairingRejectedException() {
            super("device_link_rejected");
        }
    }

    static final class PairingUnknownException extends Exception {
        PairingUnknownException() {
            super("device_link_outcome_unknown");
        }
    }
}
