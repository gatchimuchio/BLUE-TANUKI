package com.bluetanuki.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Key;
import java.security.KeyStore;
import java.util.List;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AndroidCredentialStore {
    private static final String KEY_ALIAS = "blue-tanuki-device-link-aes-v1";
    private static final String PREFS_NAME = "device_link_encrypted_v1";
    private static final String DEVICE_ID_KEY = "device_id";
    private static final String VALUE_KEY = "credential";
    private static final String ACTIVE_DIGEST_KEY = "active_credential_sha256";
    private static final String RECOVERY_AUDIT_KEY = "local_recovery_audit";
    private static final String RECOVERY_AUDIT_DIGEST_KEY = "local_recovery_audit_sha256";
    private static final String AAD = "com.bluetanuki.mobile/device-link/v1";
    private static final String RECOVERY_AUDIT_AAD = "com.bluetanuki.mobile/device-link/recovery-audit/v1";

    private final SharedPreferences preferences;

    AndroidCredentialStore(Context context) {
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    synchronized String loadOrCreateDeviceId() throws CredentialStoreException {
        String stored = preferences.getString(DEVICE_ID_KEY, null);
        if (stored != null) {
            validateDeviceId(stored);
            return stored;
        }

        if (preferences.contains(VALUE_KEY) || preferences.contains(ACTIVE_DIGEST_KEY)) {
            DeviceCredential credential = read();
            if (credential == null) {
                throw new CredentialStoreException();
            }
            return persistDeviceId(credential.deviceId);
        }
        return persistDeviceId(DeviceInvitation.newDeviceId());
    }

    synchronized String rotateDeviceId() throws CredentialStoreException {
        if (preferences.contains(VALUE_KEY) || preferences.contains(ACTIVE_DIGEST_KEY)) {
            throw new CredentialStoreException();
        }
        return persistDeviceId(DeviceInvitation.newDeviceId());
    }

    private String persistDeviceId(String deviceId) throws CredentialStoreException {
        validateDeviceId(deviceId);
        if (!preferences.edit().putString(DEVICE_ID_KEY, deviceId).commit()) {
            throw new CredentialStoreException();
        }
        String readBack = preferences.getString(DEVICE_ID_KEY, null);
        validateDeviceId(readBack);
        if (!deviceId.equals(readBack)) {
            throw new CredentialStoreException();
        }
        return readBack;
    }

    private static void validateDeviceId(String deviceId) throws CredentialStoreException {
        try {
            DeviceInvitation.requireHex(deviceId, 32);
        } catch (DeviceInvitation.InvitationException exception) {
            throw new CredentialStoreException();
        }
    }

    synchronized DeviceCredential read() throws CredentialStoreException {
        String encoded = preferences.getString(VALUE_KEY, null);
        String activeDigest = preferences.getString(ACTIVE_DIGEST_KEY, null);
        if (encoded == null && activeDigest == null) {
            return null;
        }
        if (encoded == null || activeDigest == null || !activeDigest.equals(digest(encoded))) {
            throw new CredentialStoreException();
        }
        DeviceCredential credential = decrypt(encoded);
        String deviceId = preferences.getString(DEVICE_ID_KEY, null);
        if (deviceId != null) {
            validateDeviceId(deviceId);
            if (!deviceId.equals(credential.deviceId)) {
                throw new CredentialStoreException();
            }
        }
        return credential;
    }

    private DeviceCredential decrypt(String encoded) throws CredentialStoreException {
        byte[] envelope = null;
        byte[] plaintext = null;
        try {
            envelope = Base64.decode(encoded, Base64.NO_WRAP);
            if (envelope.length < 12 + 16 || envelope.length > 16 * 1024) {
                throw new CredentialStoreException();
            }
            byte[] iv = Arrays.copyOfRange(envelope, 0, 12);
            byte[] ciphertext = Arrays.copyOfRange(envelope, 12, envelope.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            plaintext = cipher.doFinal(ciphertext);
            String json = new String(plaintext, StandardCharsets.UTF_8);
            return DeviceCredential.decodeFromStorage(json);
        } catch (Exception exception) {
            throw new CredentialStoreException();
        } finally {
            if (envelope != null) Arrays.fill(envelope, (byte) 0);
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    synchronized void saveAndVerify(DeviceCredential credential) throws CredentialStoreException {
        byte[] plaintext = null;
        byte[] envelope = null;
        try {
            if (!credential.deviceId.equals(loadOrCreateDeviceId())) {
                throw new CredentialStoreException();
            }
            if (preferences.contains(VALUE_KEY) || preferences.contains(ACTIVE_DIGEST_KEY)) {
                throw new CredentialStoreException();
            }
            plaintext = credential.encodeForStorage().getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(plaintext);
            envelope = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, envelope, 0, iv.length);
            System.arraycopy(ciphertext, 0, envelope, iv.length, ciphertext.length);
            String encoded = Base64.encodeToString(envelope, Base64.NO_WRAP);
            if (!preferences.edit().putString(VALUE_KEY, encoded)
                    .remove(ACTIVE_DIGEST_KEY).commit()) {
                throw new CredentialStoreException();
            }
            DeviceCredential readBack = decrypt(encoded);
            if (!credential.sameValue(readBack)) {
                throw new CredentialStoreException();
            }
            if (!preferences.edit().putString(ACTIVE_DIGEST_KEY, digest(encoded)).commit()) {
                throw new CredentialStoreException();
            }
            readBack = read();
            if (!credential.sameValue(readBack)) {
                throw new CredentialStoreException();
            }
        } catch (Exception exception) {
            preferences.edit().remove(VALUE_KEY).remove(ACTIVE_DIGEST_KEY).commit();
            throw new CredentialStoreException();
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (envelope != null) Arrays.fill(envelope, (byte) 0);
        }
    }

    /** Revoke the Desktop credential first, then remove and read back its local copy. */
    synchronized void clearRevokedCredential() throws CredentialStoreException {
        if (read() == null) throw new CredentialStoreException();
        if (!preferences.edit().remove(VALUE_KEY).remove(ACTIVE_DIGEST_KEY).commit()) {
            throw new CredentialStoreException();
        }
        if (read() != null || contains()) throw new CredentialStoreException();
    }

    /** Remove only the local credential and atomically append a non-authority recovery record. */
    synchronized DeviceLinkLocalRecoveryAudit.Event deleteCredentialLocally()
            throws CredentialStoreException {
        if (read() == null) return null;
        List<DeviceLinkLocalRecoveryAudit.Event> existing = readLocalRecoveryAudit();
        DeviceLinkLocalRecoveryAudit.Event event = DeviceLinkLocalRecoveryAudit.create();
        List<DeviceLinkLocalRecoveryAudit.Event> updated;
        try {
            updated = DeviceLinkLocalRecoveryAudit.appendBounded(existing, event);
        } catch (IllegalArgumentException exception) {
            throw new CredentialStoreException();
        }
        String auditJson = DeviceLinkLocalRecoveryAudit.encode(updated);
        String encryptedAudit = encryptRecoveryAudit(auditJson);
        String auditDigest = digest(encryptedAudit);
        boolean committed = preferences.edit()
                .remove(VALUE_KEY)
                .remove(ACTIVE_DIGEST_KEY)
                .putString(RECOVERY_AUDIT_KEY, encryptedAudit)
                .putString(RECOVERY_AUDIT_DIGEST_KEY, auditDigest)
                .commit();
        if (!committed || contains() || read() != null) throw new CredentialStoreException();
        List<DeviceLinkLocalRecoveryAudit.Event> readBack = readLocalRecoveryAudit();
        if (!DeviceLinkLocalRecoveryAudit.contains(readBack, event.eventId)) {
            throw new CredentialStoreException();
        }
        return event;
    }

    synchronized List<DeviceLinkLocalRecoveryAudit.Event> readLocalRecoveryAudit()
            throws CredentialStoreException {
        String encoded = preferences.getString(RECOVERY_AUDIT_KEY, null);
        String activeDigest = preferences.getString(RECOVERY_AUDIT_DIGEST_KEY, null);
        if (encoded == null && activeDigest == null) return java.util.Collections.emptyList();
        if (encoded == null || activeDigest == null || !activeDigest.equals(digest(encoded))) {
            throw new CredentialStoreException();
        }
        return decryptRecoveryAudit(encoded);
    }

    private String encryptRecoveryAudit(String value) throws CredentialStoreException {
        byte[] plaintext = null;
        byte[] envelope = null;
        try {
            plaintext = value.getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(RECOVERY_AUDIT_AAD.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(plaintext);
            envelope = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, envelope, 0, iv.length);
            System.arraycopy(ciphertext, 0, envelope, iv.length, ciphertext.length);
            return Base64.encodeToString(envelope, Base64.NO_WRAP);
        } catch (Exception exception) {
            throw new CredentialStoreException();
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (envelope != null) Arrays.fill(envelope, (byte) 0);
        }
    }

    private List<DeviceLinkLocalRecoveryAudit.Event> decryptRecoveryAudit(String encoded)
            throws CredentialStoreException {
        byte[] envelope = null;
        byte[] plaintext = null;
        try {
            envelope = Base64.decode(encoded, Base64.NO_WRAP);
            if (envelope.length < 12 + 16 || envelope.length > 64 * 1024) {
                throw new CredentialStoreException();
            }
            byte[] iv = Arrays.copyOfRange(envelope, 0, 12);
            byte[] ciphertext = Arrays.copyOfRange(envelope, 12, envelope.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(RECOVERY_AUDIT_AAD.getBytes(StandardCharsets.UTF_8));
            plaintext = cipher.doFinal(ciphertext);
            String json = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(plaintext)).toString();
            return DeviceLinkLocalRecoveryAudit.parse(json);
        } catch (Exception exception) {
            throw new CredentialStoreException();
        } finally {
            if (envelope != null) Arrays.fill(envelope, (byte) 0);
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    synchronized boolean contains() {
        return preferences.contains(VALUE_KEY) || preferences.contains(ACTIVE_DIGEST_KEY);
    }

    private SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        Key stored = keyStore.getKey(KEY_ALIAS, null);
        if (stored instanceof SecretKey) {
            return (SecretKey) stored;
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKey();
    }

    private static String digest(String encoded) throws CredentialStoreException {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(encoded.getBytes(StandardCharsets.UTF_8));
            return DeviceInvitation.hex(digest);
        } catch (Exception exception) {
            throw new CredentialStoreException();
        }
    }

    static final class CredentialStoreException extends Exception {
        CredentialStoreException() {
            super("device_credential_store_failed");
        }
    }
}
