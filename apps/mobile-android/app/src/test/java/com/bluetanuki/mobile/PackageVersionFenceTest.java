package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class PackageVersionFenceTest {
    @Test
    public void firstInstallAndUpgradePersistTheHighestVersion() {
        MemoryStore store = new MemoryStore();

        assertEquals(PackageVersionFence.Result.READY, PackageVersionFence.verify(1, store));
        assertEquals(1, store.versionCode);
        assertEquals(PackageVersionFence.Result.READY, PackageVersionFence.verify(3, store));
        assertEquals(3, store.versionCode);
    }

    @Test
    public void downgradeIsHeldAndDoesNotLowerTheHighWaterMark() {
        MemoryStore store = new MemoryStore();
        store.versionCode = 3;

        assertEquals(PackageVersionFence.Result.ROLLBACK_DETECTED, PackageVersionFence.verify(2, store));
        assertEquals(3, store.versionCode);
    }

    @Test
    public void failedWriteOrReadbackFailsClosed() {
        MemoryStore store = new MemoryStore();
        store.writeSucceeds = false;
        assertEquals(PackageVersionFence.Result.PERSISTENCE_UNCERTAIN, PackageVersionFence.verify(1, store));

        store.writeSucceeds = true;
        store.returnStaleReadback = true;
        assertEquals(PackageVersionFence.Result.PERSISTENCE_UNCERTAIN, PackageVersionFence.verify(1, store));
    }

    @Test
    public void invalidVersionAndUnreadableStateAreHeld() {
        MemoryStore store = new MemoryStore();
        assertEquals(PackageVersionFence.Result.INVALID_INSTALLED_VERSION, PackageVersionFence.verify(0, store));

        store.readFails = true;
        assertEquals(PackageVersionFence.Result.PERSISTENCE_UNCERTAIN, PackageVersionFence.verify(1, store));
    }

    private static final class MemoryStore implements PackageVersionFence.HighWaterStore {
        long versionCode;
        boolean writeSucceeds = true;
        boolean returnStaleReadback;
        boolean readFails;

        @Override
        public long read() {
            if (readFails) throw new IllegalStateException("synthetic read failure");
            return returnStaleReadback ? 0 : versionCode;
        }

        @Override
        public boolean write(long versionCode) {
            if (!writeSucceeds) return false;
            this.versionCode = versionCode;
            return true;
        }
    }
}
