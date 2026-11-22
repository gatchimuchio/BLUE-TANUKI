package com.bluetanuki.mobile;

/** Keeps app data from being consumed by a package older than the newest version that used it. */
final class PackageVersionFence {
    enum Result {
        READY,
        INVALID_INSTALLED_VERSION,
        ROLLBACK_DETECTED,
        PERSISTENCE_UNCERTAIN
    }

    interface HighWaterStore {
        long read();
        boolean write(long versionCode);
    }

    private PackageVersionFence() {}

    static Result verify(long installedVersionCode, HighWaterStore store) {
        if (installedVersionCode <= 0) return Result.INVALID_INSTALLED_VERSION;
        if (store == null) return Result.PERSISTENCE_UNCERTAIN;

        final long highWaterVersionCode;
        try {
            highWaterVersionCode = store.read();
        } catch (RuntimeException exception) {
            return Result.PERSISTENCE_UNCERTAIN;
        }
        if (highWaterVersionCode < 0) return Result.PERSISTENCE_UNCERTAIN;
        if (highWaterVersionCode > installedVersionCode) return Result.ROLLBACK_DETECTED;
        if (highWaterVersionCode == installedVersionCode) return Result.READY;

        try {
            if (!store.write(installedVersionCode) || store.read() != installedVersionCode) {
                return Result.PERSISTENCE_UNCERTAIN;
            }
        } catch (RuntimeException exception) {
            return Result.PERSISTENCE_UNCERTAIN;
        }
        return Result.READY;
    }
}
