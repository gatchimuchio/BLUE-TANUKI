package com.bluetanuki.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class LocalNetworkPermissionPolicyTest {
    @Test
    public void runtimePermissionIsRequiredStartingAtAndroid17() {
        assertFalse(MainActivity.requiresLocalNetworkRuntimePermission(36));
        assertTrue(MainActivity.requiresLocalNetworkRuntimePermission(37));
        assertTrue(MainActivity.requiresLocalNetworkRuntimePermission(38));
    }
}
