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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AndroidCredentialStore implements DeviceLinkRevocation.Checkpoints {
    private static final String KEY_ALIAS = "blue-tanuki-device-link-aes-v1";
    private static final String PREFS_NAME = "device_link_encrypted_v1";
    private static final String PACKAGE_VERSION_HIGH_WATER_KEY = "package_version_high_water";
    private static final String DEVICE_ID_KEY = "device_id";
    private static final String VALUE_KEY = "credential";
    private static final String ACTIVE_DIGEST_KEY = "active_credential_sha256";
    private static final String RECOVERY_AUDIT_KEY = "local_recovery_audit";
    private static final String RECOVERY_AUDIT_DIGEST_KEY = "local_recovery_audit_sha256";
    private static final String TASK_PENDING_KEY = "pending_task_session";
    private static final String TASK_PENDING_DIGEST_KEY = "pending_task_session_sha256";
    private static final String TASK_MUTATION_KEY = "pending_task_mutation";
    private static final String TASK_MUTATION_DIGEST_KEY = "pending_task_mutation_sha256";
    private static final String REVOCATION_KEY = "pending_desktop_revocation";
    private static final String REVOCATION_DIGEST_KEY = "pending_desktop_revocation_sha256";
    private static final String AAD = "com.bluetanuki.mobile/device-link/v1";
    private static final String RECOVERY_AUDIT_AAD = "com.bluetanuki.mobile/device-link/recovery-audit/v1";
    private static final String TASK_PENDING_AAD = "com.bluetanuki.mobile/device-link/task-pending/v1";
    private static final String TASK_MUTATION_AAD = "com.bluetanuki.mobile/device-link/task-mutation/v1";
    private static final int TASK_MUTATION_MAX_ENVELOPE_BYTES = 8 * 1024;
    private static final String REVOCATION_AAD = "com.bluetanuki.mobile/device-link/desktop-revocation/v1";

    private static AndroidCredentialStore instance;
    private final SharedPreferences preferences;
    private boolean packageVersionReady;

    static synchronized AndroidCredentialStore forApplication(Context context) {
        if (instance == null) instance = new AndroidCredentialStore(context.getApplicationContext());
        return instance;
    }

    private AndroidCredentialStore(Context context) {
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    synchronized PackageVersionFence.Result verifyPackageVersion(long installedVersionCode) {
        packageVersionReady = false;
        PackageVersionFence.Result result = PackageVersionFence.verify(installedVersionCode,
                new PackageVersionFence.HighWaterStore() {
                    @Override
                    public long read() {
                        return preferences.contains(PACKAGE_VERSION_HIGH_WATER_KEY)
                                ? preferences.getLong(PACKAGE_VERSION_HIGH_WATER_KEY, 0) : 0;
                    }

                    @Override
                    public boolean write(long versionCode) {
                        return preferences.edit()
                                .putLong(PACKAGE_VERSION_HIGH_WATER_KEY, versionCode)
                                .commit();
                    }
                });
        packageVersionReady = result == PackageVersionFence.Result.READY;
        return result;
    }

    synchronized boolean isPackageVersionReady() {
        return packageVersionReady;
    }

    private void requirePackageVersionReady() throws CredentialStoreException {
        if (!packageVersionReady) throw new CredentialStoreException();
    }

    synchronized String loadOrCreateDeviceId() throws CredentialStoreException {
        requirePackageVersionReady();
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
        if (hasPendingTaskCheckpoint() || hasPendingDesktopRevocation()) {
            throw new CredentialStoreException();
        }
        return persistDeviceId(DeviceInvitation.newDeviceId());
    }

    synchronized String rotateDeviceId() throws CredentialStoreException {
        if (!canRotateDeviceId()) {
            throw new CredentialStoreException();
        }
        return persistDeviceId(DeviceInvitation.newDeviceId());
    }

    synchronized boolean canRotateDeviceId() {
        return packageVersionReady && !contains() && !hasPendingTaskCheckpoint() && !hasPendingDesktopRevocation();
    }

    synchronized boolean hasPendingTaskCheckpoint() {
        return preferences.contains(TASK_PENDING_KEY) || preferences.contains(TASK_PENDING_DIGEST_KEY) ||
                hasPendingTaskMutation();
    }

    synchronized boolean hasPendingTaskMutation() {
        return preferences.contains(TASK_MUTATION_KEY) || preferences.contains(TASK_MUTATION_DIGEST_KEY);
    }

    synchronized boolean hasPendingDesktopRevocation() {
        return preferences.contains(REVOCATION_KEY) || preferences.contains(REVOCATION_DIGEST_KEY);
    }

    synchronized DeviceCredential readForDeviceLink() throws CredentialStoreException {
        requirePackageVersionReady();
        return hasPendingDesktopRevocation() ? null : read();
    }

    synchronized boolean canUseCredentialForDeviceLink(DeviceCredential expected) {
        try {
            return expected.sameValue(readForDeviceLink()) && expected.expiresAt > System.currentTimeMillis() / 1000L;
        } catch (CredentialStoreException exception) {
            return false;
        }
    }

    synchronized boolean canPair(String expectedDeviceId) {
        return packageVersionReady && expectedDeviceId.equals(preferences.getString(DEVICE_ID_KEY, null)) &&
                !contains() && !hasPendingDesktopRevocation();
    }

    private String persistDeviceId(String deviceId) throws CredentialStoreException {
        requirePackageVersionReady();
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
        requirePackageVersionReady();
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
        requirePackageVersionReady();
        if (credential == null || credential.deviceId == null ||
                !credential.deviceId.equals(loadOrCreateDeviceId()) || contains() || hasPendingDesktopRevocation()) {
            throw new CredentialStoreException();
        }

        byte[] plaintext = null;
        byte[] envelope = null;
        String encoded = null;
        String encodedDigest = null;
        boolean writeAttempted = false;
        try {
            plaintext = credential.encodeForStorage().getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(plaintext);
            envelope = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, envelope, 0, iv.length);
            System.arraycopy(ciphertext, 0, envelope, iv.length, ciphertext.length);
            encoded = Base64.encodeToString(envelope, Base64.NO_WRAP);
            encodedDigest = digest(encoded);
            writeAttempted = true;
            if (!preferences.edit().putString(VALUE_KEY, encoded)
                    .remove(ACTIVE_DIGEST_KEY).commit()) {
                throw new CredentialStoreException();
            }
            DeviceCredential readBack = decrypt(encoded);
            if (!credential.sameValue(readBack)) {
                throw new CredentialStoreException();
            }
            if (!preferences.edit().putString(ACTIVE_DIGEST_KEY, encodedDigest).commit()) {
                throw new CredentialStoreException();
            }
            readBack = read();
            if (!credential.sameValue(readBack)) {
                throw new CredentialStoreException();
            }
        } catch (Exception exception) {
            if (writeAttempted) {
                try {
                    String storedEncoded = preferences.getString(VALUE_KEY, null);
                    String storedDigest = preferences.getString(ACTIVE_DIGEST_KEY, null);
                    boolean belongsToThisAttempt = encoded.equals(storedEncoded) &&
                            (storedDigest == null || encodedDigest.equals(storedDigest));
                    if (belongsToThisAttempt &&
                            (!preferences.edit().remove(VALUE_KEY).remove(ACTIVE_DIGEST_KEY).commit() ||
                                    preferences.contains(VALUE_KEY) ||
                                    preferences.contains(ACTIVE_DIGEST_KEY))) {
                        throw new CredentialStoreException();
                    }
                } catch (Exception cleanupException) {
                    throw new CredentialStoreException();
                }
            }
            throw new CredentialStoreException();
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (envelope != null) Arrays.fill(envelope, (byte) 0);
        }
    }

    @Override
    public synchronized String begin(DeviceCredential expected) throws CredentialStoreException {
        requirePackageVersionReady();
        if (hasPendingDesktopRevocation() || !expected.sameValue(read())) throw new CredentialStoreException();
        String activeDigest = preferences.getString(ACTIVE_DIGEST_KEY, null);
        String checkpoint = encryptTaskCheckpoint(activeDigest, REVOCATION_AAD);
        if (!preferences.edit().putString(REVOCATION_KEY, checkpoint)
                .putString(REVOCATION_DIGEST_KEY, digest(checkpoint)).commit() ||
                !isCurrent(expected, checkpoint)) {
            throw new CredentialStoreException();
        }
        return checkpoint;
    }

    @Override
    public synchronized boolean isCurrent(DeviceCredential expected, String checkpoint) throws CredentialStoreException {
        requirePackageVersionReady();
        if (!checkpoint.equals(preferences.getString(REVOCATION_KEY, null)) ||
                !digest(checkpoint).equals(preferences.getString(REVOCATION_DIGEST_KEY, null)) ||
                !expected.sameValue(read())) return false;
        return decryptTaskCheckpoint(checkpoint, REVOCATION_AAD)
                .equals(preferences.getString(ACTIVE_DIGEST_KEY, null));
    }

    @Override
    public synchronized void finish(DeviceCredential expected, String checkpoint, boolean revoked) throws CredentialStoreException {
        requirePackageVersionReady();
        if (!isCurrent(expected, checkpoint)) throw new CredentialStoreException();
        SharedPreferences.Editor editor = preferences.edit().remove(REVOCATION_KEY).remove(REVOCATION_DIGEST_KEY);
        if (revoked) editor.remove(VALUE_KEY).remove(ACTIVE_DIGEST_KEY);
        if (!editor.commit() || hasPendingDesktopRevocation() ||
                (revoked ? contains() || read() != null : !expected.sameValue(read()))) {
            throw new CredentialStoreException();
        }
    }

    /** Remove only the local credential and atomically append a non-authority recovery record. */
    synchronized DeviceLinkLocalRecoveryAudit.Event deleteCredentialLocally(DeviceCredential expected)
            throws CredentialStoreException {
        if (!expected.sameValue(read())) throw new CredentialStoreException();
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
                .remove(REVOCATION_KEY)
                .remove(REVOCATION_DIGEST_KEY)
                .putString(RECOVERY_AUDIT_KEY, encryptedAudit)
                .putString(RECOVERY_AUDIT_DIGEST_KEY, auditDigest)
                .commit();
        if (!committed || contains() || read() != null || hasPendingDesktopRevocation()) {
            throw new CredentialStoreException();
        }
        List<DeviceLinkLocalRecoveryAudit.Event> readBack = readLocalRecoveryAudit();
        if (!DeviceLinkLocalRecoveryAudit.contains(readBack, event.eventId)) {
            throw new CredentialStoreException();
        }
        return event;
    }

    synchronized List<DeviceLinkLocalRecoveryAudit.Event> readLocalRecoveryAudit()
            throws CredentialStoreException {
        requirePackageVersionReady();
        String encoded = preferences.getString(RECOVERY_AUDIT_KEY, null);
        String activeDigest = preferences.getString(RECOVERY_AUDIT_DIGEST_KEY, null);
        if (encoded == null && activeDigest == null) return java.util.Collections.emptyList();
        if (encoded == null || activeDigest == null || !activeDigest.equals(digest(encoded))) {
            throw new CredentialStoreException();
        }
        return decryptRecoveryAudit(encoded);
    }

    /** 一度の送信前に依頼の照合記録を暗号化して保存する。 */
    synchronized void markTaskSubmissionPending(PendingTaskSubmission pending) throws CredentialStoreException {
        requirePackageVersionReady();
        if (pendingTaskSubmission() != null) throw new CredentialStoreException();
        String value = pending.encode();
        String encrypted = encryptTaskCheckpoint(value, TASK_PENDING_AAD);
        if (!preferences.edit().putString(TASK_PENDING_KEY, encrypted)
                .putString(TASK_PENDING_DIGEST_KEY, digest(encrypted)).commit()) {
            throw new CredentialStoreException();
        }
        PendingTaskSubmission saved = pendingTaskSubmission();
        if (saved == null || !value.equals(saved.encode())) throw new CredentialStoreException();
    }

    synchronized String pendingTaskSessionID() throws CredentialStoreException {
        PendingTaskSubmission pending = pendingTaskSubmission();
        return pending == null ? null : pending.sessionID;
    }

    synchronized PendingTaskSubmission pendingTaskSubmission() throws CredentialStoreException {
        requirePackageVersionReady();
        String encoded = preferences.getString(TASK_PENDING_KEY, null);
        String activeDigest = preferences.getString(TASK_PENDING_DIGEST_KEY, null);
        if (encoded == null && activeDigest == null) return null;
        if (encoded == null || activeDigest == null || !activeDigest.equals(digest(encoded))) {
            throw new CredentialStoreException();
        }
        try {
            return PendingTaskSubmission.decode(decryptTaskCheckpoint(encoded, TASK_PENDING_AAD));
        } catch (StrictJson.JsonException exception) {
            throw new CredentialStoreException();
        }
    }

    synchronized void clearTaskSubmissionPending(PendingTaskSubmission expected) throws CredentialStoreException {
        requirePackageVersionReady();
        PendingTaskSubmission current = pendingTaskSubmission();
        if (current == null || !expected.encode().equals(current.encode())) throw new CredentialStoreException();
        if (!preferences.edit().remove(TASK_PENDING_KEY).remove(TASK_PENDING_DIGEST_KEY).commit() ||
                pendingTaskSubmission() != null) throw new CredentialStoreException();
    }

    synchronized void markTaskMutationPending(PendingTaskMutation mutation) throws CredentialStoreException {
        requirePackageVersionReady();
        List<PendingTaskMutation> pending = new ArrayList<>(pendingTaskMutations());
        if (pending.size() >= PendingTaskMutation.MAX_PENDING) throw new CredentialStoreException();
        for (PendingTaskMutation current : pending) {
            if (mutation.conflictsWith(current)) throw new CredentialStoreException();
        }
        pending.add(mutation);
        writeTaskMutations(pending);
    }

    synchronized List<PendingTaskMutation> pendingTaskMutations() throws CredentialStoreException {
        requirePackageVersionReady();
        try {
            String encoded = preferences.getString(TASK_MUTATION_KEY, null);
            String activeDigest = preferences.getString(TASK_MUTATION_DIGEST_KEY, null);
            if (encoded == null && activeDigest == null) return Collections.emptyList();
            if (encoded == null || activeDigest == null || !activeDigest.equals(digest(encoded))) {
                throw new CredentialStoreException();
            }
            return PendingTaskMutation.decodeList(
                    decryptTaskCheckpoint(encoded, TASK_MUTATION_AAD, TASK_MUTATION_MAX_ENVELOPE_BYTES));
        } catch (StrictJson.JsonException | ClassCastException exception) {
            throw new CredentialStoreException();
        }
    }

    synchronized void clearTaskMutationPending(PendingTaskMutation expected) throws CredentialStoreException {
        requirePackageVersionReady();
        List<PendingTaskMutation> pending = new ArrayList<>(pendingTaskMutations());
        for (int index = 0; index < pending.size(); index++) {
            if (expected.encode().equals(pending.get(index).encode())) {
                pending.remove(index);
                writeTaskMutations(pending);
                return;
            }
        }
        throw new CredentialStoreException();
    }

    private void writeTaskMutations(List<PendingTaskMutation> pending) throws CredentialStoreException {
        requirePackageVersionReady();
        SharedPreferences.Editor editor = preferences.edit();
        String value = PendingTaskMutation.encodeList(pending);
        if (pending.isEmpty()) {
            editor.remove(TASK_MUTATION_KEY).remove(TASK_MUTATION_DIGEST_KEY);
        } else {
            String encrypted = encryptTaskCheckpoint(value, TASK_MUTATION_AAD);
            editor.putString(TASK_MUTATION_KEY, encrypted).putString(TASK_MUTATION_DIGEST_KEY, digest(encrypted));
        }
        if (!editor.commit() || !value.equals(PendingTaskMutation.encodeList(pendingTaskMutations()))) {
            throw new CredentialStoreException();
        }
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

    private String encryptTaskCheckpoint(String value, String aad) throws CredentialStoreException {
        byte[] plaintext = null;
        byte[] envelope = null;
        try {
            plaintext = value.getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
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

    private String decryptTaskCheckpoint(String encoded, String aad) throws CredentialStoreException {
        return decryptTaskCheckpoint(encoded, aad, 1024);
    }

    private String decryptTaskCheckpoint(String encoded, String aad, int maxEnvelopeBytes) throws CredentialStoreException {
        byte[] envelope = null;
        byte[] plaintext = null;
        byte[] iv = null;
        byte[] ciphertext = null;
        try {
            if (encoded.length() > maxEnvelopeBytes * 2) throw new CredentialStoreException();
            envelope = Base64.decode(encoded, Base64.NO_WRAP);
            if (envelope.length < 12 + 16 || envelope.length > maxEnvelopeBytes) throw new CredentialStoreException();
            iv = Arrays.copyOfRange(envelope, 0, 12);
            ciphertext = Arrays.copyOfRange(envelope, 12, envelope.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            plaintext = cipher.doFinal(ciphertext);
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(plaintext)).toString();
        } catch (Exception exception) {
            throw new CredentialStoreException();
        } finally {
            if (envelope != null) Arrays.fill(envelope, (byte) 0);
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (iv != null) Arrays.fill(iv, (byte) 0);
            if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
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
