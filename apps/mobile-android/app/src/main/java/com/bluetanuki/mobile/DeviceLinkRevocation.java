package com.bluetanuki.mobile;

/** 端末離脱の再送を防ぎ、証拠が揃った場合だけ保護済み記録を閉じる。 */
final class DeviceLinkRevocation {
    enum Outcome {
        REVOKED, UNSENT, UNKNOWN, CHECKPOINT_UNVERIFIED, REVOKED_CLEANUP_UNVERIFIED, UNSENT_CLEANUP_UNVERIFIED
    }

    interface Checkpoints {
        String begin(DeviceCredential expected) throws AndroidCredentialStore.CredentialStoreException;
        boolean isCurrent(DeviceCredential expected, String checkpoint) throws AndroidCredentialStore.CredentialStoreException;
        void finish(DeviceCredential expected, String checkpoint, boolean revoked) throws AndroidCredentialStore.CredentialStoreException;
    }

    interface LeaveTransport {
        DeviceLinkTransport.Exchange leave(DeviceCredential credential, DeviceLinkTransport.SendGuard guard)
                throws DeviceLinkTransport.TransportException;
    }

    private DeviceLinkRevocation() {}

    static Outcome run(DeviceCredential credential, DeviceLinkTransport.SendGuard guard,
                       Checkpoints checkpoints, LeaveTransport transport) {
        if (!canSend(credential, guard)) return Outcome.UNSENT;
        final String checkpoint;
        try {
            checkpoint = checkpoints.begin(credential);
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            return Outcome.CHECKPOINT_UNVERIFIED;
        }

        try {
            DeviceLinkTransport.Exchange response = transport.leave(credential, () -> {
                try {
                    return canSend(credential, guard) && checkpoints.isCurrent(credential, checkpoint);
                } catch (AndroidCredentialStore.CredentialStoreException exception) {
                    return false;
                }
            });
            PairingResponseParser.requireDisconnectedResponse(response.response, response.nonce);
        } catch (DeviceLinkTransport.TransportException exception) {
            return exception.requestMayHaveReachedDesktop ? Outcome.UNKNOWN :
                    finish(credential, checkpoint, checkpoints, false);
        } catch (PairingResponseParser.PairingRejectedException | PairingResponseParser.PairingUnknownException exception) {
            return Outcome.UNKNOWN;
        }
        return finish(credential, checkpoint, checkpoints, true);
    }

    private static boolean canSend(DeviceCredential credential, DeviceLinkTransport.SendGuard guard) {
        return guard.canSend() && credential.expiresAt > System.currentTimeMillis() / 1000L;
    }

    private static Outcome finish(DeviceCredential credential, String checkpoint, Checkpoints checkpoints, boolean revoked) {
        try {
            checkpoints.finish(credential, checkpoint, revoked);
            return revoked ? Outcome.REVOKED : Outcome.UNSENT;
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            return revoked ? Outcome.REVOKED_CLEANUP_UNVERIFIED : Outcome.UNSENT_CLEANUP_UNVERIFIED;
        }
    }
}
