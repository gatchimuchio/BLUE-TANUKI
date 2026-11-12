# BLUE-TANUKI Resident Integration Helpers

These helpers back the portable installer launcher commands for resident local
operation. They do not create a signed native app, do not add a second authority
path, and do not enable autostart unless the owner explicitly runs the
autostart command. This means the helper does not enable autostart during setup
or install.

Launcher command surface:

- `resident-start`
- `resident-status`
- `resident-stop`
- `resident-open`
- `resident-logs`
- `resident-autostart-enable`
- `resident-autostart-disable`
- `resident-autostart-status`

Resident mode starts the existing Gateway serve process with the generated env
file. All WebChat, Approval Gate, HDS-BRAIN, audit, Runtime Invariants, and
Control Center rules remain unchanged.

On Windows, the resident helper verifies the recorded PID against the Node
executable, Gateway entry point, serve flag, and exact env-file path before it
reports or stops a process. If process identity cannot be inspected or does not
match this installation, the helper preserves the PID record and refuses to
signal the process. A stop is reported only after the process handle confirms
exit; timeout or inspection failure keeps the record for recovery.
