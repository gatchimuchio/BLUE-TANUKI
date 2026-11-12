#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/blue-tanuki-resident-autostart.XXXXXX")
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT HUP INT TERM

INSTALL_ROOT="$TMP_ROOT/install root & percent % dollar \$ backslash \\ quote \""
HOME="$TMP_ROOT/home & percent % dollar \$ equals = backslash \\ quote \""
ENV_FILE="$TMP_ROOT/config/blue-tanuki.env"
DATA_ROOT="$TMP_ROOT/data"
LAUNCHER="$HOME/.local/bin/blue tanuki % \$"
RESIDENT_SCRIPT="$INSTALL_ROOT/install/resident/blue-tanuki-resident.sh"
MOCK_BIN="$TMP_ROOT/mock-bin"
SYSTEMCTL_LOG="$TMP_ROOT/systemctl.log"
LAUNCHCTL_LOG="$TMP_ROOT/launchctl.log"
export INSTALL_ROOT HOME ENV_FILE DATA_ROOT LAUNCHER SYSTEMCTL_LOG LAUNCHCTL_LOG
export SYSTEMCTL_MODE=ok UNAME_MODE=Linux
export PATH="$MOCK_BIN:/usr/bin:/bin"

mkdir -p "$INSTALL_ROOT/install/resident" "$INSTALL_ROOT/install/unix" \
  "$INSTALL_ROOT/apps/gateway/dist" "$HOME/.local/bin" "$TMP_ROOT/config" "$DATA_ROOT" "$MOCK_BIN"
cp "$REPO_ROOT/install/resident/blue-tanuki-resident.sh" "$RESIDENT_SCRIPT"
cp "$REPO_ROOT/install/unix/safe-target.sh" "$INSTALL_ROOT/install/unix/safe-target.sh"
printf 'synthetic env\n' > "$ENV_FILE"
printf '#!/bin/sh\nexit 0\n' > "$LAUNCHER"
printf '#!/bin/sh\nexit 0\n' > "$MOCK_BIN/node"
chmod +x "$LAUNCHER" "$MOCK_BIN/node"

cat > "$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
printf '%s\n' "$UNAME_MODE"
EOF
cat > "$MOCK_BIN/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "${1:-}" = "--user" ] && [ "${2:-}" = "--version" ] && [ "${SYSTEMCTL_MODE:-ok}" = "no-version" ]; then
  exit 1
fi
if [ "${1:-}" = "--user" ] && [ "${2:-}" = "disable" ] && [ "${SYSTEMCTL_MODE:-ok}" = "disable-fail" ]; then
  exit 1
fi
exit 0
EOF
cat > "$MOCK_BIN/launchctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCHCTL_LOG"
if [ "${1:-}" = "print" ]; then exit 1; fi
exit 0
EOF
chmod +x "$MOCK_BIN/uname" "$MOCK_BIN/systemctl" "$MOCK_BIN/launchctl"

expect_fail() {
  label=$1
  shift
  if "$@" > "$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
}

run_resident() {
  command=$1
  shift
  env "$@" sh "$RESIDENT_SCRIPT" "$command"
}

SYSTEMD_UNIT="$HOME/.config/systemd/user/blue-tanuki.service"
run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-enable.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/systemd-enable.out" || exit 2
grep -Fq 'WorkingDirectory=' "$SYSTEMD_UNIT" || exit 3
grep -Fq '\s' "$SYSTEMD_UNIT" || exit 38
grep -Fq 'ExecStart="' "$SYSTEMD_UNIT" || exit 4
cp "$SYSTEMD_UNIT" "$TMP_ROOT/systemd-generated.service"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/systemd-status.out" || exit 5
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-disable.out"
[ ! -e "$SYSTEMD_UNIT" ] && [ ! -L "$SYSTEMD_UNIT" ] || exit 6
grep -Fq 'disable --now blue-tanuki.service' "$SYSTEMCTL_LOG" || exit 7
. "$INSTALL_ROOT/install/unix/safe-target.sh"
render_legacy_managed_dev_linux_systemd_user_service "$INSTALL_ROOT" "$ENV_FILE" "$MOCK_BIN/node" > "$SYSTEMD_UNIT"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-legacy-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/systemd-legacy-status.out" || exit 39
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > /dev/null
[ ! -e "$SYSTEMD_UNIT" ] && [ ! -L "$SYSTEMD_UNIT" ] || exit 40

. "$INSTALL_ROOT/install/unix/safe-target.sh"
render_legacy_managed_dev_linux_systemd_user_service "$INSTALL_ROOT" "$ENV_FILE" "$MOCK_BIN/node" > "$SYSTEMD_UNIT"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-legacy-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/systemd-legacy-status.out" || exit 39
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > /dev/null
[ ! -e "$SYSTEMD_UNIT" ] && [ ! -L "$SYSTEMD_UNIT" ] || exit 40

run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > /dev/null
printf '\n# user modification\n' >> "$SYSTEMD_UNIT"
cp "$SYSTEMD_UNIT" "$TMP_ROOT/systemd-modified.backup"
: > "$SYSTEMCTL_LOG"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-modified-status.out"
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/systemd-modified-status.out" || exit 8
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-modified-disable.out"
cmp -s "$SYSTEMD_UNIT" "$TMP_ROOT/systemd-modified.backup" || exit 9
[ ! -s "$SYSTEMCTL_LOG" ] || exit 10

printf '[Unit]\nDescription=User-owned service\n' > "$SYSTEMD_UNIT"
cp "$SYSTEMD_UNIT" "$TMP_ROOT/systemd-unowned.backup"
expect_fail 'unowned systemd enable' run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=ok
grep -Fqx -- '--user --version' "$SYSTEMCTL_LOG" || exit 31
: > "$SYSTEMCTL_LOG"
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-unowned-disable.out"
cmp -s "$SYSTEMD_UNIT" "$TMP_ROOT/systemd-unowned.backup" || exit 11
grep -Fq 'autostart_entry_preserved=' "$TMP_ROOT/systemd-unowned-disable.out" || exit 12
[ ! -s "$SYSTEMCTL_LOG" ] || exit 13

rm -f -- "$SYSTEMD_UNIT"
SYMLINK_TARGET="$TMP_ROOT/user-owned.service"
printf '[Unit]\nDescription=Symlink target\n' > "$SYMLINK_TARGET"
ln -s "$SYMLINK_TARGET" "$SYSTEMD_UNIT"
expect_fail 'symlink systemd enable' run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=ok
grep -Fqx -- '--user --version' "$SYSTEMCTL_LOG" || exit 45
: > "$SYSTEMCTL_LOG"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-symlink-status.out"
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/systemd-symlink-status.out" || exit 46
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > "$TMP_ROOT/systemd-symlink-disable.out"
[ -L "$SYSTEMD_UNIT" ] && [ "$(readlink "$SYSTEMD_UNIT")" = "$SYMLINK_TARGET" ] || exit 47
[ ! -s "$SYSTEMCTL_LOG" ] || exit 48

rm -f -- "$SYSTEMD_UNIT"
SYSTEMCTL_MODE=no-version
export SYSTEMCTL_MODE
DESKTOP_ENTRY="$HOME/.config/autostart/blue-tanuki.desktop"
mkdir -p "$(dirname -- "$DESKTOP_ENTRY")"
printf '[Desktop Entry]\nName=User-owned\nExec=other-app\n' > "$DESKTOP_ENTRY"
cp "$DESKTOP_ENTRY" "$TMP_ROOT/xdg-unowned.backup"
expect_fail 'unowned XDG enable' run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=no-version
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > "$TMP_ROOT/xdg-unowned-disable.out"
cmp -s "$DESKTOP_ENTRY" "$TMP_ROOT/xdg-unowned.backup" || exit 14
grep -Fq 'autostart_entry_preserved=' "$TMP_ROOT/xdg-unowned-disable.out" || exit 15
rm -f -- "$DESKTOP_ENTRY"
run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > "$TMP_ROOT/xdg-enable.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/xdg-enable.out" || exit 16
grep -Fq 'Exec="' "$DESKTOP_ENTRY" || exit 17
grep -Fq '\\' "$DESKTOP_ENTRY" || exit 32
grep -Fq 'equals = backslash' "$DESKTOP_ENTRY" || exit 33
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > "$TMP_ROOT/xdg-disable.out"
[ ! -e "$DESKTOP_ENTRY" ] && [ ! -L "$DESKTOP_ENTRY" ] || exit 18
render_legacy_managed_dev_linux_xdg_autostart_entry "$LAUNCHER" > "$DESKTOP_ENTRY"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > "$TMP_ROOT/xdg-legacy-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/xdg-legacy-status.out" || exit 41
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > /dev/null
[ ! -e "$DESKTOP_ENTRY" ] && [ ! -L "$DESKTOP_ENTRY" ] || exit 42
render_legacy_managed_dev_linux_xdg_autostart_entry "$LAUNCHER" > "$DESKTOP_ENTRY"
run_resident resident-autostart-status UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > "$TMP_ROOT/xdg-legacy-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/xdg-legacy-status.out" || exit 41
run_resident resident-autostart-disable UNAME_MODE=Linux SYSTEMCTL_MODE=no-version > /dev/null
[ ! -e "$DESKTOP_ENTRY" ] && [ ! -L "$DESKTOP_ENTRY" ] || exit 42

PLIST="$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist"
export UNAME_MODE=Darwin SYSTEMCTL_MODE=ok
run_resident resident-autostart-enable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-enable.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/macos-enable.out" || exit 19
grep -Fq '&amp;' "$PLIST" || exit 20
cp "$PLIST" "$TMP_ROOT/macos-generated.plist"
run_resident resident-autostart-status UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/macos-status.out" || exit 21
printf '\n<!-- user modification -->\n' >> "$PLIST"
cp "$PLIST" "$TMP_ROOT/macos-modified.backup"
: > "$LAUNCHCTL_LOG"
run_resident resident-autostart-status UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-modified-status.out"
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-modified-status.out" || exit 22
run_resident resident-autostart-disable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-modified-disable.out"
cmp -s "$PLIST" "$TMP_ROOT/macos-modified.backup" || exit 23
[ ! -s "$LAUNCHCTL_LOG" ] || exit 24

printf 'user-owned plist\n' > "$PLIST"
cp "$PLIST" "$TMP_ROOT/macos-unowned.backup"
expect_fail 'unowned macOS enable' run_resident resident-autostart-enable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok
run_resident resident-autostart-disable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-unowned-disable.out"
cmp -s "$PLIST" "$TMP_ROOT/macos-unowned.backup" || exit 25
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-unowned-disable.out" || exit 26
[ ! -s "$LAUNCHCTL_LOG" ] || exit 27

rm -f -- "$PLIST"
run_resident resident-autostart-enable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > /dev/null
run_resident resident-autostart-disable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-disable.out"
[ ! -e "$PLIST" ] && [ ! -L "$PLIST" ] || exit 28
grep -Fq 'autostart_status=disabled' "$TMP_ROOT/macos-disable.out" || exit 29
grep -Fq 'disable gui/' "$LAUNCHCTL_LOG" || exit 30
render_legacy_managed_dev_macos_autostart_entry "$INSTALL_ROOT" "$ENV_FILE" "$MOCK_BIN/node" "$DATA_ROOT/logs/blue-tanuki.out.log" "$DATA_ROOT/logs/blue-tanuki.err.log" > "$PLIST"
run_resident resident-autostart-status UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-legacy-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/macos-legacy-status.out" || exit 43
run_resident resident-autostart-disable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > /dev/null
[ ! -e "$PLIST" ] && [ ! -L "$PLIST" ] || exit 44
render_legacy_managed_dev_macos_autostart_entry "$INSTALL_ROOT" "$ENV_FILE" "$MOCK_BIN/node" "$DATA_ROOT/logs/blue-tanuki.out.log" "$DATA_ROOT/logs/blue-tanuki.err.log" > "$PLIST"
run_resident resident-autostart-status UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > "$TMP_ROOT/macos-legacy-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/macos-legacy-status.out" || exit 43
run_resident resident-autostart-disable UNAME_MODE=Darwin SYSTEMCTL_MODE=ok > /dev/null
[ ! -e "$PLIST" ] && [ ! -L "$PLIST" ] || exit 44

export UNAME_MODE=Linux SYSTEMCTL_MODE=ok
run_resident resident-autostart-enable UNAME_MODE=Linux SYSTEMCTL_MODE=ok > /dev/null
if env \
  HOME="$HOME" \
  INSTALL_ROOT="$INSTALL_ROOT" \
  DATA_ROOT="$DATA_ROOT" \
  CONFIG_ROOT="$TMP_ROOT/config" \
  BIN_ROOT="$HOME/.local/bin" \
  UNAME_MODE=Linux \
  SYSTEMCTL_MODE=disable-fail \
  sh "$REPO_ROOT/install/linux/uninstall.sh" > "$TMP_ROOT/uninstall-autostart-failure.out" 2>&1; then
  echo 'Linux development uninstall continued after managed autostart disable failed' >&2
  exit 34
fi
if ! grep -Fq 'could not disable the managed unit' "$TMP_ROOT/uninstall-autostart-failure.out"; then
  cat "$TMP_ROOT/uninstall-autostart-failure.out" >&2
  exit 35
fi
[ -d "$INSTALL_ROOT" ] && [ -d "$DATA_ROOT" ] && [ -d "$TMP_ROOT/config" ] || exit 36
[ -f "$SYSTEMD_UNIT" ] && [ -f "$LAUNCHER" ] || exit 37

echo "resident_autostart_ownership=pass"
