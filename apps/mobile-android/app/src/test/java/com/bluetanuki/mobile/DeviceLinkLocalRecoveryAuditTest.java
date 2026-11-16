package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public final class DeviceLinkLocalRecoveryAuditTest {
    private static final String TIMESTAMP = "2026-11-17T03:04:05.678Z";

    @Test
    public void roundTripsOnlyTheFixedNonAuthorityRecord() throws Exception {
        DeviceLinkLocalRecoveryAudit.Event event = DeviceLinkLocalRecoveryAudit.event(
                "a".repeat(32), TIMESTAMP);
        List<DeviceLinkLocalRecoveryAudit.Event> events =
                DeviceLinkLocalRecoveryAudit.appendBounded(List.of(), event);

        List<DeviceLinkLocalRecoveryAudit.Event> decoded =
                DeviceLinkLocalRecoveryAudit.parse(DeviceLinkLocalRecoveryAudit.encode(events));
        assertEquals(1, decoded.size());
        assertEquals(event.eventId, decoded.get(0).eventId);
        assertEquals(event.timestamp, decoded.get(0).timestamp);
        assertTrue(DeviceLinkLocalRecoveryAudit.contains(decoded, event.eventId));
    }

    @Test
    public void rejectsNoncanonicalTimeChangedFieldsAndRepeatedIds() throws Exception {
        DeviceLinkLocalRecoveryAudit.Event event = DeviceLinkLocalRecoveryAudit.event(
                "b".repeat(32), TIMESTAMP);
        String encoded = DeviceLinkLocalRecoveryAudit.encode(List.of(event));
        assertThrows(StrictJson.JsonException.class,
                () -> DeviceLinkLocalRecoveryAudit.parse(encoded.replace("mobile_local_recovery", "authority")));
        assertThrows(IllegalArgumentException.class,
                () -> DeviceLinkLocalRecoveryAudit.event("c".repeat(32), "2026-02-30T03:04:05.678Z"));
        assertThrows(IllegalArgumentException.class,
                () -> DeviceLinkLocalRecoveryAudit.appendBounded(List.of(event), event));
    }

    @Test
    public void rotatesOldestEntryAtTheBoundedLimit() {
        List<DeviceLinkLocalRecoveryAudit.Event> events = new ArrayList<>();
        for (int index = 0; index < DeviceLinkLocalRecoveryAudit.MAX_EVENTS; index++) {
            events.add(DeviceLinkLocalRecoveryAudit.event(String.format("%032x", index), TIMESTAMP));
        }
        List<DeviceLinkLocalRecoveryAudit.Event> appended = DeviceLinkLocalRecoveryAudit.appendBounded(
                events, DeviceLinkLocalRecoveryAudit.event("f".repeat(32), TIMESTAMP));
        assertEquals(DeviceLinkLocalRecoveryAudit.MAX_EVENTS, appended.size());
        assertEquals("00000000000000000000000000000001", appended.get(0).eventId);
        assertEquals("f".repeat(32), appended.get(appended.size() - 1).eventId);
    }
}
