package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public final class PendingTaskMutationTest {
    private static final String HASH = "sha256:" + "a".repeat(64);
    private static final String ID = "abcdef0123456789abcdef0123456789";
    private static final String OTHER = "0123456789abcdef0123456789abcdef";
    private static final DeviceCredential DESKTOP = credential(ID, ID, "a".repeat(64));

    @Test
    public void restartRecordRetainsHoldUntilSameLiveTaskIsObserved() throws Exception {
        MobileTaskContract.Draft draft = draft(ID, null);
        PendingTaskMutation beforeRestart = PendingTaskMutation.forRequest(
                PendingTaskMutation.Action.START, DESKTOP, draft, null);
        PendingTaskMutation restored = PendingTaskMutation.decode(beforeRestart.encode());
        assertEquals(beforeRestart.encode(), restored.encode());
        assertFalse(restored.resolvedBy(DESKTOP, draft, MobileTaskContract.TaskStatus.startCandidate(), true));
        assertFalse(restored.resolvedBy(DESKTOP, draft, task("running", ID), false));
        assertFalse(restored.resolvedBy(DESKTOP, draft(OTHER, ID), task("running", ID), true));
        assertFalse(restored.resolvedBy(credential(OTHER, ID, "a".repeat(64)), draft, task("running", ID), true));
        assertFalse(restored.resolvedBy(credential(ID, OTHER, "a".repeat(64)), draft, task("running", ID), true));
        assertFalse(restored.resolvedBy(credential(ID, ID, "b".repeat(64)), draft, task("running", ID), true));
        assertTrue(restored.resolvedBy(DESKTOP, draft(ID, ID), task("running", ID), true));
    }

    @Test
    public void cancellationStatusRequiresAResolvedTaskAndAnExactTaskID() throws Exception {
        MobileTaskContract.Draft draft = draft(ID, ID);
        PendingTaskMutation pending = PendingTaskMutation.forRequest(
                PendingTaskMutation.Action.CANCEL, DESKTOP, draft, ID);
        assertFalse(pending.resolvedBy(DESKTOP, draft, task("pending", ID), true));
        assertFalse(pending.resolvedBy(DESKTOP, draft, task("running", ID), true));
        assertFalse(pending.resolvedBy(DESKTOP, draft, task("quarantined", ID), true));
        assertFalse(pending.resolvedBy(DESKTOP, draft, task("cancelled", ID), false));
        assertFalse(pending.resolvedBy(DESKTOP, draft, task("cancelled", OTHER), true));
        assertTrue(pending.resolvedBy(DESKTOP, draft, task("cancelled", ID), true));
        assertTrue(pending.resolvedBy(DESKTOP, draft, task("completed", ID), true));
    }

    @Test
    public void malformedStoredRecordNeverBecomesAnAction() {
        assertThrows(StrictJson.JsonException.class, () -> PendingTaskMutation.decode("CANCEL:invalid"));
        assertThrows(StrictJson.JsonException.class, () -> PendingTaskMutation.decode("RESEND:" + "a".repeat(64)));
    }

    @Test
    public void listRefreshReconcilesTheMatchingRequestAndKeepsIndependentFailuresUnknown() throws Exception {
        String laterID = "f".repeat(32);
        MobileTaskContract.Draft held = draft(ID, ID);
        List<MobileTaskContract.Draft> entries = List.of(draft(OTHER, null), held, draft(laterID, null));
        PendingTaskMutation pending = PendingTaskMutation.decode(PendingTaskMutation.forRequest(
                PendingTaskMutation.Action.CANCEL, DESKTOP, held, ID).encode());
        List<String> queried = new ArrayList<>();
        List<String> resolved = new ArrayList<>();
        Map<String, MobileTaskContract.TaskStatus> statuses = MobileTaskClient.observeOwnedStatuses(
                entries, DESKTOP, pending, () -> true, entry -> {
                    queried.add(entry.id);
                    if (OTHER.equals(entry.id)) throw new PairingResponseParser.PairingRejectedException();
                    MobileTaskContract.TaskStatus status = ID.equals(entry.id)
                            ? task("cancelled", ID) : MobileTaskContract.TaskStatus.startCandidate();
                    if (pending.resolvedBy(DESKTOP, entry, status, true)) resolved.add(entry.id);
                    return status;
                });
        assertEquals(List.of(ID, OTHER, laterID), queried);
        assertEquals(List.of(ID), resolved);
        assertEquals(List.of(ID, laterID), new ArrayList<>(statuses.keySet()));
        assertFalse(pending.matchesListedRequest(DESKTOP, draft(ID, OTHER)));
        assertFalse(pending.matchesListedRequest(DESKTOP, draft(ID, null)));
    }

    @Test
    public void listRefreshStopsReadingWhenTheTransportOrForegroundIsLost() {
        List<MobileTaskContract.Draft> entries = List.of(draft(OTHER, null), draft(ID, ID));
        List<String> queried = new ArrayList<>();
        assertTrue(MobileTaskClient.observeOwnedStatuses(entries, DESKTOP, null, () -> true, entry -> {
            queried.add(entry.id);
            throw new DeviceLinkTransport.TransportException(false);
        }).isEmpty());
        assertEquals(List.of(OTHER), queried);
        assertTrue(MobileTaskClient.observeOwnedStatuses(entries, DESKTOP, null, () -> false, entry -> {
            throw new AssertionError("background read");
        }).isEmpty());
    }

    private static DeviceCredential credential(String hostID, String deviceID, String fingerprint) {
        return new DeviceCredential("127.0.0.1", 443, hostID, fingerprint, deviceID, 999, ID, "fixture");
    }

    private static MobileTaskContract.Draft draft(String id, String taskID) {
        return new MobileTaskContract.Draft(id, "runtime", OTHER, "workspace", HASH, 10, 20, taskID);
    }

    private static MobileTaskContract.TaskStatus task(String state, String taskID) {
        return MobileTaskContract.TaskStatus.task(new MobileTaskContract.TaskRecord(
                taskID, "runtime", OTHER, "workspace", HASH, state, null, false));
    }
}
