package com.bluetanuki.mobile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.X509TrustManager;

final class DeviceLinkTransport {
    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 5_000;
    private static final int MAX_REQUEST_BYTES = 64 * 1024;
    private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

    private final AtomicReference<SSLSocket> activeSocket = new AtomicReference<>();

    Exchange pair(DeviceInvitation invitation, SendGuard canSend) throws TransportException {
        String nonce = DeviceInvitation.newDeviceId();
        String request = request(invitation.hostId, invitation.deviceId, invitation.invitationId,
                invitation.invitationSecret, nonce, System.currentTimeMillis() / 1000L,
                "端末結合");
        return new Exchange(nonce, exchange(invitation.host, invitation.port,
                invitation.certificateSha256, request, canSend));
    }

    Exchange check(DeviceCredential credential, SendGuard canSend) throws TransportException {
        String nonce = DeviceInvitation.newDeviceId();
        String request = request(credential.hostId, credential.deviceId, credential.credentialId,
                credential.credentialSecret, nonce, System.currentTimeMillis() / 1000L,
                "端末確認");
        return new Exchange(nonce, exchange(credential.host, credential.port,
                credential.certificateSha256, request, canSend));
    }

    Exchange leave(DeviceCredential credential, SendGuard canSend) throws TransportException {
        String nonce = DeviceInvitation.newDeviceId();
        String request = request(credential.hostId, credential.deviceId, credential.credentialId,
                credential.credentialSecret, nonce, System.currentTimeMillis() / 1000L,
                "端末離脱");
        return new Exchange(nonce, exchange(credential.host, credential.port,
                credential.certificateSha256, request, canSend));
    }

    void closeActive() {
        SSLSocket socket = activeSocket.getAndSet(null);
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // A closed socket is the intended cancellation mechanism.
            }
        }
    }

    private String exchange(String host, int port, String certificateSha256, String request,
                            SendGuard canSend)
            throws TransportException {
        boolean dispatchAttempted = false;
        SSLSocket tls = null;
        byte[] requestBytes = null;
        try {
            if (canSend == null || !canSend.canSend()) {
                throw new IOException("request_cancelled_before_connect");
            }
            DeviceInvitation.requirePrivateIpv4(host);
            DeviceInvitation.requireHex(certificateSha256, 64);
            requestBytes = (request + "\n").getBytes(StandardCharsets.UTF_8);
            if (requestBytes.length > MAX_REQUEST_BYTES) {
                throw new IOException("request_too_large");
            }
            tls = createSocket(host, port, certificateSha256);
            if (!activeSocket.compareAndSet(null, tls)) {
                throw new IOException("device_link_busy");
            }
            tls.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            tls.setSoTimeout(READ_TIMEOUT_MS);
            tls.setTcpNoDelay(true);
            tls.startHandshake();
            if (!canSend.canSend()) {
                throw new IOException("request_cancelled_before_send");
            }

            OutputStream output = tls.getOutputStream();
            dispatchAttempted = true;
            output.write(requestBytes);
            output.flush();

            byte[] responseBytes = readOneResponse(tls.getInputStream());
            return decodeUtf8(responseBytes);
        } catch (Exception exception) {
            throw new TransportException(dispatchAttempted);
        } finally {
            if (requestBytes != null) Arrays.fill(requestBytes, (byte) 0);
            if (tls != null) {
                activeSocket.compareAndSet(tls, null);
                try {
                    tls.close();
                } catch (IOException ignored) {
                    // The connection has already completed or failed.
                }
            }
        }
    }

    private static SSLSocket createSocket(String host, int port, String certificateSha256)
            throws GeneralSecurityException, IOException {
        X509TrustManager pinningTrustManager = new PinningTrustManager(certificateSha256);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new X509TrustManager[] { pinningTrustManager }, new SecureRandom());
        SSLSocketFactory factory = context.getSocketFactory();
        SSLSocket tls = (SSLSocket) factory.createSocket();
        String[] supported = tls.getSupportedProtocols();
        boolean hasTls12 = Arrays.asList(supported).contains("TLSv1.2");
        boolean hasTls13 = Arrays.asList(supported).contains("TLSv1.3");
        if (!hasTls12 && !hasTls13) {
            tls.close();
            throw new IOException("tls_version_unavailable");
        }
        tls.setEnabledProtocols(hasTls13 && hasTls12
                ? new String[] { "TLSv1.3", "TLSv1.2" }
                : hasTls13 ? new String[] { "TLSv1.3" } : new String[] { "TLSv1.2" });
        tls.setSoTimeout(READ_TIMEOUT_MS);
        return tls;
    }

    private static byte[] readOneResponse(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean foundNewline = false;
        while (!foundNewline) {
            int value = input.read();
            if (value < 0) {
                throw new IOException("response_incomplete");
            }
            if (value == '\n') {
                foundNewline = true;
                break;
            }
            if (value == '\r' || bytes.size() >= MAX_RESPONSE_BYTES) {
                throw new IOException("response_invalid_or_too_large");
            }
            bytes.write(value);
        }
        if (!foundNewline || input.read() != -1) {
            throw new IOException("response_trailing_data");
        }
        return bytes.toByteArray();
    }

    private static String decodeUtf8(byte[] bytes) throws IOException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException exception) {
            throw new IOException("response_not_utf8");
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private static String request(String hostId, String deviceId, String credentialId,
                                  String credentialSecret, String nonce, long issuedAt,
                                  String operation) {
        return "{\"版\":1,\"HostID\":\"" + hostId + "\",\"端末ID\":\"" + deviceId +
                "\",\"資格ID\":\"" + credentialId + "\",\"資格秘密\":\"" +
                credentialSecret + "\",\"nonce\":\"" + nonce + "\",\"発行時刻\":" +
                issuedAt + ",\"操作\":\"" + operation + "\",\"内容\":{}}";
    }

    static final class TransportException extends Exception {
        final boolean requestMayHaveReachedDesktop;

        TransportException(boolean requestMayHaveReachedDesktop) {
            super("device_link_transport_failed");
            this.requestMayHaveReachedDesktop = requestMayHaveReachedDesktop;
        }
    }

    interface SendGuard {
        boolean canSend();
    }

    static final class Exchange {
        final String nonce;
        final String response;

        Exchange(String nonce, String response) {
            this.nonce = nonce;
            this.response = response;
        }
    }

    private static final class PinningTrustManager implements X509TrustManager {
        private final byte[] expected;

        PinningTrustManager(String expectedHex) throws GeneralSecurityException {
            this.expected = hexBytes(expectedHex);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            throw new CertificateException("client_certificate_not_used");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            if (chain == null || chain.length == 0) {
                throw new CertificateException("server_certificate_missing");
            }
            try {
                for (X509Certificate certificate : chain) {
                    certificate.checkValidity();
                }
                byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                boolean matches = MessageDigest.isEqual(expected, actual);
                Arrays.fill(actual, (byte) 0);
                if (!matches) {
                    throw new CertificateException("server_certificate_pin_mismatch");
                }
            } catch (GeneralSecurityException exception) {
                throw new CertificateException("server_certificate_invalid");
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }

        private static byte[] hexBytes(String value) throws GeneralSecurityException {
            if (value == null || value.length() != 64) {
                throw new GeneralSecurityException("certificate_pin_invalid");
            }
            byte[] result = new byte[32];
            for (int index = 0; index < result.length; index++) {
                int high = Character.digit(value.charAt(index * 2), 16);
                int low = Character.digit(value.charAt(index * 2 + 1), 16);
                if (high < 0 || low < 0) {
                    throw new GeneralSecurityException("certificate_pin_invalid");
                }
                result[index] = (byte) ((high << 4) | low);
            }
            return result;
        }
    }
}
