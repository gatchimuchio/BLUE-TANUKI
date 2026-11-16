# BLUE-TANUKI Android

This is the first native Android product entry for BLUE-TANUKI. It uses the
Desktop Device Link broker contract. The Android client is a downstream
operator surface; it does not make owner decisions, grant approval, or call
BLUE-TANUKI Gateway directly.

## Current implementation

- Generate a 128-bit device ID for the owner to use when issuing a one-time
  Desktop invitation.
- Enter the invitation fields inside the native Android screen, require the
  invitation's device ID to match this installation, and explicitly compare
  the Desktop host and certificate fingerprint before pairing.
- Connect only to private or loopback IPv4 over TLS. The pinned certificate
  must match the invitation and remain within its validity period.
- On Android 17 / API 37, request the OS local-network runtime permission only
  after explaining that the app needs to connect to the manually verified
  Desktop Broker. Denial keeps all Desktop network access disabled.
- Submit one bounded Device Link request per TLS connection. The invitation
  is never retried after a request may have reached the Desktop.
- Save the returned device credential only as AES-GCM ciphertext protected by
  an Android Keystore key. If secure storage or readback fails, pairing is not
  reported as complete.
- Verify a stored credential when the app is foregrounded. Backgrounding the
  app closes the active socket.

The current slice covers initial pairing and connection verification only.
Task interaction, cancellation, lifecycle recovery, update, and removal remain
unimplemented. It is not a release build and has not been tested on a physical
Android device.

## Build

Use JDK 17 and Android SDK Platform 37 / Build Tools 36.0.0. Build from a
local Windows checkout outside OneDrive, preferably at an ASCII path, with:

    .\gradlew.bat :app:testDebugUnitTest :app:assembleDebug

On the current host, the OneDrive checkout under a Japanese path fails to load
Gradle test classes and fails to replace generated dex output. The exact source
copied to a fresh local `%TEMP%` directory passed all 10 unit tests and
`assembleDebug`. The original build outputs were retained after Gradle reported
that it could not delete them; no ACL or synchronization setting was changed.
This host difference has not been isolated further.

The debug APK is a local engineering artifact, not a release package. No
signing key or Play Store configuration is included. No emulator or physical
Android device was connected during this implementation slice.
