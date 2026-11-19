package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public final class DeviceLinkRevocationTest {
    private static final String NONCE = "1".repeat(32);
    private static final DeviceCredential CREDENTIAL = new DeviceCredential("192.168.1.10", 7443,
            "a".repeat(32), "b".repeat(64), "c".repeat(32), Long.MAX_VALUE, "d".repeat(32), "e".repeat(64));
    private static final String REVOKED = "{\"request_id\":\"" + NONCE + "\",\"operation\":\"端末離脱\"," +
            "\"status\":\"accepted\",\"evidence_source\":\"INTERNAL_STATE\",\"audit_event_id\":\"event-1\"," +
            "\"error\":null,\"health\":null,\"body\":{\"状態\":\"失効\"},\"shutdown_requested\":false}";

    @Test
    public void storesAndRechecksBeforeLeaveAndClosesOnExactRevocation() {
        MemoryCheckpoints store = new MemoryCheckpoints();
        DeviceLinkRevocation.Outcome result = DeviceLinkRevocation.run(CREDENTIAL, () -> true, store, (credential, guard) -> {
            assertTrue(credential.sameValue(CREDENTIAL));
            assertTrue(store.pending);
            assertTrue(guard.canSend());
            store.steps.add("sent");
            return new DeviceLinkTransport.Exchange(NONCE, REVOKED);
        });
        assertEquals(DeviceLinkRevocation.Outcome.REVOKED, result);
        assertEquals(List.of("saved", "checked", "sent", "revoked"), store.steps);
        assertFalse(store.pending);
        assertFalse(store.hasCredential);
    }

    @Test
    public void transportProvenUnsentClearsOnlyTheCheckpoint() {
        MemoryCheckpoints store = new MemoryCheckpoints();
        DeviceLinkRevocation.Outcome result = DeviceLinkRevocation.run(CREDENTIAL, () -> true, store, (credential, guard) -> {
            assertTrue(store.pending);
            assertTrue(guard.canSend());
            throw new DeviceLinkTransport.TransportException(false);
        });
        assertEquals(DeviceLinkRevocation.Outcome.UNSENT, result);
        assertEquals(List.of("saved", "checked", "unsent"), store.steps);
        assertFalse(store.pending);
        assertTrue(store.hasCredential);
    }

    @Test
    public void lostResponseKeepsRecordAndSubsequentAttemptsNeverReachTransport() {
        MemoryCheckpoints store = new MemoryCheckpoints();
        DeviceLinkRevocation.Outcome first = DeviceLinkRevocation.run(CREDENTIAL, () -> true, store, (credential, guard) -> {
            assertTrue(guard.canSend());
            throw new DeviceLinkTransport.TransportException(true);
        });
        assertEquals(DeviceLinkRevocation.Outcome.UNKNOWN, first);
        assertTrue(store.pending);
        DeviceLinkRevocation.Outcome reopened = DeviceLinkRevocation.run(CREDENTIAL, () -> true, store, (credential, guard) -> {
            fail("未照合の端末離脱を再送してはいけない");
            return null;
        });
        assertEquals(DeviceLinkRevocation.Outcome.CHECKPOINT_UNVERIFIED, reopened);
        assertEquals(List.of("saved", "checked"), store.steps);
        assertTrue(store.pending);
        assertTrue(store.hasCredential);
    }

    @Test
    public void wrongEvidenceAndGenericRejectionRetainTheCheckpoint() {
        String rejection = "{\"request_id\":\"" + NONCE + "\",\"operation\":\"端末離脱\"," +
                "\"status\":\"rejected\",\"evidence_source\":\"INTERNAL_STATE\",\"audit_event_id\":\"event-2\"," +
                "\"error\":{\"code\":\"拒否\",\"message\":\"Desktop拒否\",\"recoverable\":false," +
                "\"audit_event_required\":true,\"fail_closed\":true},\"health\":null,\"body\":null,\"shutdown_requested\":false}";
        for (String reply : List.of(REVOKED.replace("INTERNAL_STATE", "LIVE_RUNTIME"),
                REVOKED.replace(NONCE, "2".repeat(32)), rejection)) {
            MemoryCheckpoints store = new MemoryCheckpoints();
            assertEquals(DeviceLinkRevocation.Outcome.UNKNOWN,
                    DeviceLinkRevocation.run(CREDENTIAL, () -> true, store, (credential, guard) ->
                            new DeviceLinkTransport.Exchange(NONCE, reply)));
            assertEquals(List.of("saved"), store.steps);
            assertTrue(store.pending);
            assertTrue(store.hasCredential);
        }
    }

    @Test
    public void revocationWithUnverifiedLocalCleanupIsNotComplete() {
        MemoryCheckpoints store = new MemoryCheckpoints();
        store.failCleanup = true;
        assertEquals(DeviceLinkRevocation.Outcome.REVOKED_CLEANUP_UNVERIFIED,
                DeviceLinkRevocation.run(CREDENTIAL, () -> true, store, (credential, guard) ->
                        new DeviceLinkTransport.Exchange(NONCE, REVOKED)));
        assertTrue(store.pending);
        assertTrue(store.hasCredential);
    }

    private static final class MemoryCheckpoints implements DeviceLinkRevocation.Checkpoints {
        final List<String> steps = new ArrayList<>();
        boolean pending;
        boolean hasCredential = true;
        boolean failCleanup;

        @Override
        public String begin(DeviceCredential expected) throws AndroidCredentialStore.CredentialStoreException {
            if (pending) throw new AndroidCredentialStore.CredentialStoreException();
            pending = true;
            steps.add("saved");
            return "attempt";
        }

        @Override
        public boolean isCurrent(DeviceCredential expected, String checkpoint) {
            steps.add("checked");
            return expected.sameValue(CREDENTIAL) && "attempt".equals(checkpoint) && pending;
        }

        @Override
        public void finish(DeviceCredential expected, String checkpoint, boolean revoked)
                throws AndroidCredentialStore.CredentialStoreException {
            if (failCleanup) throw new AndroidCredentialStore.CredentialStoreException();
            assertTrue(expected.sameValue(CREDENTIAL));
            assertEquals("attempt", checkpoint);
            assertTrue(pending);
            pending = false;
            hasCredential = !revoked;
            steps.add(revoked ? "revoked" : "unsent");
        }
    }
}
