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
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AndroidCredentialStore {
    private static final String KEY_ALIAS = "blue-tanuki-device-link-aes-v1";
    private static final String PREFS_NAME = "device_link_encrypted_v1";
    private static final String VALUE_KEY = "credential";
    private static final String ACTIVE_DIGEST_KEY = "active_credential_sha256";
    private static final String AAD = "com.bluetanuki.mobile/device-link/v1";

    private final SharedPreferences preferences;

    AndroidCredentialStore(Context context) {
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
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
        return decrypt(encoded);
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

    synchronized boolean contains() {
        return preferences.contains(VALUE_KEY);
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
