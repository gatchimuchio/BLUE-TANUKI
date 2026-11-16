package com.bluetanuki.mobile;

import java.security.SecureRandom;
import java.util.Locale;

final class DeviceInvitation {
    final String host;
    final int port;
    final String hostId;
    final String certificateSha256;
    final String deviceId;
    final long expiresAt;
    final String invitationId;
    final String invitationSecret;

    private DeviceInvitation(String host, int port, String hostId, String certificateSha256,
                             String deviceId, long expiresAt, String invitationId,
                             String invitationSecret) {
        this.host = host;
        this.port = port;
        this.hostId = hostId;
        this.certificateSha256 = certificateSha256;
        this.deviceId = deviceId;
        this.expiresAt = expiresAt;
        this.invitationId = invitationId;
        this.invitationSecret = invitationSecret;
    }

    static String newDeviceId() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        return hex(bytes);
    }

    static DeviceInvitation create(String host, String portText, String hostId,
                                   String certificateSha256, String invitationDeviceId,
                                   String currentDeviceId,
                                   String expiryText, String invitationId,
                                   String invitationSecret, long nowSeconds)
            throws InvitationException {
        String normalizedHost = requirePrivateIpv4(host);
        int port = parsePort(portText);
        requireHex(hostId, 32);
        requireHex(certificateSha256, 64);
        requireHex(invitationDeviceId, 32);
        requireHex(currentDeviceId, 32);
        if (!currentDeviceId.equals(invitationDeviceId)) {
            throw new InvitationException("この招待は現在の端末ID向けではありません。Desktop ownerにこの端末ID向けの招待を発行してもらってください。");
        }
        requireHex(invitationId, 32);
        requireHex(invitationSecret, 64);
        long expiresAt = parsePositiveLong(expiryText);
        if (expiresAt <= nowSeconds || expiresAt > nowSeconds + 360) {
            throw new InvitationException("招待の期限が切れているか、300秒を超えています。Desktopで新しい招待を発行してください。");
        }
        return new DeviceInvitation(normalizedHost, port, hostId, certificateSha256,
                invitationDeviceId, expiresAt, invitationId, invitationSecret);
    }

    static String requirePrivateIpv4(String value) throws InvitationException {
        if (value == null || !value.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) {
            throw new InvitationException("接続先は数値形式のprivate IPv4またはloopbackにしてください。");
        }
        String[] octets = value.split("\\.", -1);
        int[] parts = new int[4];
        StringBuilder canonical = new StringBuilder();
        for (int index = 0; index < octets.length; index++) {
            try {
                parts[index] = Integer.parseInt(octets[index]);
            } catch (NumberFormatException exception) {
                throw new InvitationException("接続先IPv4が不正です。");
            }
            if (parts[index] < 0 || parts[index] > 255 ||
                    !Integer.toString(parts[index]).equals(octets[index])) {
                throw new InvitationException("接続先IPv4が不正です。");
            }
            if (index > 0) {
                canonical.append('.');
            }
            canonical.append(parts[index]);
        }
        boolean loopback = parts[0] == 127;
        boolean privateAddress = parts[0] == 10 ||
                (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] == 192 && parts[1] == 168);
        if ((!loopback && !privateAddress) || (parts[0] == 255 && parts[1] == 255 &&
                parts[2] == 255 && parts[3] == 255)) {
            throw new InvitationException("接続先は数値形式のprivate IPv4またはloopbackにしてください。");
        }
        return canonical.toString();
    }

    private static int parsePort(String value) throws InvitationException {
        if (value == null || !value.matches("[0-9]{1,5}")) {
            throw new InvitationException("portが不正です。");
        }
        try {
            int parsed = Integer.parseInt(value);
            if (parsed < 1 || parsed > 65535) {
                throw new InvitationException("portが不正です。");
            }
            return parsed;
        } catch (NumberFormatException exception) {
            throw new InvitationException("portが不正です。");
        }
    }

    private static long parsePositiveLong(String value) throws InvitationException {
        if (value == null || !value.matches("[0-9]{1,12}")) {
            throw new InvitationException("招待期限が不正です。");
        }
        try {
            long parsed = Long.parseLong(value);
            if (parsed <= 0) {
                throw new InvitationException("招待期限が不正です。");
            }
            return parsed;
        } catch (NumberFormatException exception) {
            throw new InvitationException("招待期限が不正です。");
        }
    }

    static void requireHex(String value, int length) throws InvitationException {
        if (value == null || value.length() != length ||
                !value.matches("[0-9a-f]{" + length + "}")) {
            throw new InvitationException("招待の識別子または秘密の形式が不正です。");
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return result.toString();
    }

    static final class InvitationException extends Exception {
        InvitationException(String message) {
            super(message);
        }
    }
}
