package com.bluetanuki.mobile;

import java.util.Map;

final class DeviceCredential {
    final String host;
    final int port;
    final String hostId;
    final String certificateSha256;
    final String deviceId;
    final long expiresAt;
    final String credentialId;
    final String credentialSecret;

    DeviceCredential(String host, int port, String hostId, String certificateSha256,
                     String deviceId, long expiresAt, String credentialId,
                     String credentialSecret) {
        this.host = host;
        this.port = port;
        this.hostId = hostId;
        this.certificateSha256 = certificateSha256;
        this.deviceId = deviceId;
        this.expiresAt = expiresAt;
        this.credentialId = credentialId;
        this.credentialSecret = credentialSecret;
    }

    String encodeForStorage() {
        return "{\"host\":\"" + host + "\",\"port\":" + port +
                ",\"HostID\":\"" + hostId + "\",\"証明書hash\":\"" + certificateSha256 +
                "\",\"端末ID\":\"" + deviceId + "\",\"有効期限\":" + expiresAt +
                ",\"結合ID\":\"" + credentialId + "\",\"端末秘密\":\"" +
                credentialSecret + "\"}";
    }

    static DeviceCredential decodeFromStorage(String json) throws StrictJson.JsonException,
            DeviceInvitation.InvitationException {
        Map<String, Object> value = StrictJson.object(StrictJson.parse(json));
        if (!StrictJson.hasExactKeys(value, "host", "port", "HostID", "証明書hash",
                "端末ID", "有効期限", "結合ID", "端末秘密")) {
            throw new StrictJson.JsonException();
        }
        String host = StrictJson.string(value, "host");
        String hostId = StrictJson.string(value, "HostID");
        String certificate = StrictJson.string(value, "証明書hash");
        String deviceId = StrictJson.string(value, "端末ID");
        String credentialId = StrictJson.string(value, "結合ID");
        String secret = StrictJson.string(value, "端末秘密");
        int port = Math.toIntExact(StrictJson.integer(value, "port"));
        long expiresAt = StrictJson.integer(value, "有効期限");
        host = DeviceInvitation.requirePrivateIpv4(host);
        if (port < 1 || port > 65535 || expiresAt <= 0) {
            throw new StrictJson.JsonException();
        }
        DeviceInvitation.requireHex(hostId, 32);
        DeviceInvitation.requireHex(certificate, 64);
        DeviceInvitation.requireHex(deviceId, 32);
        DeviceInvitation.requireHex(credentialId, 32);
        DeviceInvitation.requireHex(secret, 64);
        return new DeviceCredential(host, port, hostId, certificate, deviceId,
                expiresAt, credentialId, secret);
    }

    boolean sameValue(DeviceCredential other) {
        return other != null && host.equals(other.host) && port == other.port &&
                hostId.equals(other.hostId) && certificateSha256.equals(other.certificateSha256) &&
                deviceId.equals(other.deviceId) && expiresAt == other.expiresAt &&
                credentialId.equals(other.credentialId) && credentialSecret.equals(other.credentialSecret);
    }
}
