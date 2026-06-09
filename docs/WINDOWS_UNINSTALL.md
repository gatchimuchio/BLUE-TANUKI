# Windows Uninstall

The Windows installer registers BLUE-TANUKI under the current-user uninstall
registry key:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueTanuki
```

Use either:

- Windows Apps / Control Panel,
- Start Menu `Uninstall BLUE-TANUKI`,
- `%LOCALAPPDATA%\Programs\BlueTanuki\UninstallBlueTanuki.cmd`.

## Default Behavior

Default uninstall:

- stops the resident runtime,
- removes Start Menu shortcuts,
- removes the optional Desktop shortcut if present,
- removes the uninstall registry key,
- removes installed app files,
- preserves user data.

Preserved data:

```text
%APPDATA%\BlueTanuki
```

User data retained means env, logs, audit, sessions, and local state remain for
reinstall or manual review.

## Purge

To remove user data too:

```powershell
%LOCALAPPDATA%\Programs\BlueTanuki\UninstallBlueTanuki.cmd -PurgeData
```

Use purge only when the owner intentionally wants env, logs, audit, session, and
local data removed.

## Safety

The uninstaller guards against broad user-directory and filesystem-root removal.
It must not delete secrets or audit data silently through the default path.
