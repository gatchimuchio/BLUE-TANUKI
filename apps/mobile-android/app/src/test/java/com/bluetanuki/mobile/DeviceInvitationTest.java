package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class DeviceInvitationTest {
    private static final String HOST_ID = "a".repeat(32);
    private static final String CERTIFICATE = "b".repeat(64);
    private static final String DEVICE_ID = "c".repeat(32);
    private static final String INVITATION_ID = "d".repeat(32);
    private static final String SECRET = "e".repeat(64);

    @Test
    public void acceptsOnlyPrivateIpv4OrLoopback() throws Exception {
        assertEquals("10.0.2.2", DeviceInvitation.requirePrivateIpv4("10.0.2.2"));
        assertEquals("172.16.0.1", DeviceInvitation.requirePrivateIpv4("172.16.0.1"));
        assertEquals("192.168.1.10", DeviceInvitation.requirePrivateIpv4("192.168.1.10"));
        assertEquals("127.0.0.1", DeviceInvitation.requirePrivateIpv4("127.0.0.1"));

        for (String invalid : new String[] {
                "8.8.8.8", "172.32.0.1", "169.254.1.1", "0.0.0.0", "255.255.255.255",
                "localhost", "::1", "192.168.1.999", "192.168.01.1"
        }) {
            assertThrows(DeviceInvitation.InvitationException.class,
                    () -> DeviceInvitation.requirePrivateIpv4(invalid));
        }
    }

    @Test
    public void requiresFreshWellFormedInvitationBoundToCurrentDevice() throws Exception {
        DeviceInvitation invitation = DeviceInvitation.create("192.168.1.10", "7443",
                HOST_ID, CERTIFICATE, DEVICE_ID, DEVICE_ID, "1300", INVITATION_ID, SECRET, 1000);
        assertEquals(7443, invitation.port);
        assertEquals(1300L, invitation.expiresAt);
        assertThrows(DeviceInvitation.InvitationException.class, () ->
                DeviceInvitation.create("192.168.1.10", "7443", HOST_ID, CERTIFICATE,
                        "f".repeat(32), DEVICE_ID, "1300", INVITATION_ID, SECRET, 1000));
        assertThrows(DeviceInvitation.InvitationException.class, () ->
                DeviceInvitation.create("192.168.1.10", "7443", HOST_ID, CERTIFICATE,
                        DEVICE_ID, DEVICE_ID, "1000", INVITATION_ID, SECRET, 1000));
        assertThrows(DeviceInvitation.InvitationException.class, () ->
                DeviceInvitation.create("192.168.1.10", "7443", HOST_ID, CERTIFICATE,
                        DEVICE_ID, DEVICE_ID, "1400", INVITATION_ID, SECRET, 1000));
    }
}
