#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK_ROOT="${BLUE_TANUKI_INSTALL_WORK_ROOT:-$SCRIPT_DIR/.codex-tmp/linux-install-entrypoint}"
LOG_PATH="$WORK_ROOT/install.log"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: sh ./INSTALL_LINUX.sh [--dry-run] [--no-launch]

Installs BLUE-TANUKI from this source or release bundle on Linux, then starts
the resident app and opens the Control Center. Use --no-launch to install only.
USAGE
}

fail() {
  echo ""
  echo "BLUE-TANUKI Linux install did not complete." >&2
  echo "Reason: $*" >&2
  echo "Log: $LOG_PATH" >&2
  echo "" >&2
  echo "Recommended:" >&2
  echo "  1. Re-run INSTALL_LINUX.sh from the extracted BLUE-TANUKI folder." >&2
  echo "  2. If the build failed, open the log above and fix the first failed command." >&2
  echo "  3. If you want install-only behavior, run: LAUNCH_AFTER_INSTALL=0 sh ./INSTALL_LINUX.sh" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --no-launch)
      LAUNCH_AFTER_INSTALL=0
      export LAUNCH_AFTER_INSTALL
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

if [ "${NO_LAUNCH:-0}" = "1" ]; then
  LAUNCH_AFTER_INSTALL=0
  export LAUNCH_AFTER_INSTALL
fi

LAUNCH_AFTER_INSTALL="${LAUNCH_AFTER_INSTALL:-1}"
export LAUNCH_AFTER_INSTALL

mkdir -p "$WORK_ROOT"
: > "$LOG_PATH"

echo "[BLUE-TANUKI] Linux install entrypoint"
echo "[BLUE-TANUKI] Repository root: $SCRIPT_DIR"
echo "[BLUE-TANUKI] Log: $LOG_PATH"

if [ "$DRY_RUN" = "1" ]; then
  echo "would_run=sh ./install/linux/install.sh"
  echo "would_launch_after_install=$LAUNCH_AFTER_INSTALL"
  echo "linux_source_entrypoint_dry_run=pass"
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  fail "INSTALL_LINUX.sh must be run on Linux."
fi

status_file="$WORK_ROOT/status"
rm -f "$status_file"
(
  set +e
  cd "$SCRIPT_DIR" && sh ./install/linux/install.sh
  code=$?
  printf '%s\n' "$code" > "$status_file"
  exit 0
) 2>&1 | tee -a "$LOG_PATH"

status=$(sed -n '1p' "$status_file" 2>/dev/null || printf '1')
rm -f "$status_file"
if [ "$status" != "0" ]; then
  fail "install/linux/install.sh failed with exit code $status"
fi

echo ""
echo "BLUE-TANUKI Linux install entrypoint completed."
