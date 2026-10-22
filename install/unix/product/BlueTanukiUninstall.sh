#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/install/unix/safe-target.sh" ]; then
  SAFE_TARGET_LIB="$SCRIPT_DIR/install/unix/safe-target.sh"
elif [ -f "$SCRIPT_DIR/../safe-target.sh" ]; then
  SAFE_TARGET_LIB="$SCRIPT_DIR/../safe-target.sh"
else
  echo "error: shared Unix target guard is missing; refusing uninstall" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$SAFE_TARGET_LIB"
INSTALL_ENV="$SCRIPT_DIR/blue-tanuki-install.env"

if [ -f "$INSTALL_ENV" ]; then
  # shellcheck disable=SC1090
  . "$INSTALL_ENV"
else
  INSTALL_ROOT="${INSTALL_ROOT:-$SCRIPT_DIR}"
  DATA_ROOT="${DATA_ROOT:-$HOME/.local/share/blue-tanuki}"
  CONFIG_ROOT="${CONFIG_ROOT:-$HOME/.config/blue-tanuki}"
  RUNTIME_ROOT="${RUNTIME_ROOT:-$DATA_ROOT/runtime}"
  BIN_ROOT="${BIN_ROOT:-$HOME/.local/bin}"
  PLATFORM="${PLATFORM:-linux}"
fi

PURGE="${PURGE:-0}"
DRY_RUN="${DRY_RUN:-0}"
QUIET="${QUIET:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge|-PurgeData)
      PURGE=1
      ;;
    --dry-run|-DryRun)
      DRY_RUN=1
      ;;
    --quiet|-Quiet)
      QUIET=1
      ;;
    -h|--help)
      echo "Usage: BlueTanukiUninstall.sh [--purge] [--dry-run] [--quiet]"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

say() {
  if [ "$QUIET" != "1" ]; then
    printf '%s\n' "$*"
  fi
}

fail() {
  echo "error: $*" >&2
  exit 2
}

safe_target() {
  safe_destructive_target "$1" "$2"
}

remove_target() {
  target=$(safe_target "$1" "$2")
  if [ ! -e "$target" ]; then
    say "Skip missing $2: $target"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove $2: $target"
    return
  fi
  rm -rf -- "$target"
  say "Removed $2: $target"
}

remove_file() {
  target=$(safe_file_target "$1" "$2")
  if [ ! -e "$target" ]; then
    say "Skip missing $2: $target"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove $2: $target"
    return
  fi
  rm -f -- "$target"
  say "Removed $2: $target"
}

INSTALL_ROOT=$(safe_destructive_target "$INSTALL_ROOT" "INSTALL_ROOT")
DATA_ROOT=$(safe_container_target "$DATA_ROOT" "DATA_ROOT")
CONFIG_ROOT=$(safe_container_target "$CONFIG_ROOT" "CONFIG_ROOT")
RUNTIME_ROOT=$(safe_destructive_target "$RUNTIME_ROOT" "RUNTIME_ROOT")
BIN_ROOT=$(safe_user_bin_target "$BIN_ROOT" "BIN_ROOT")
assert_not_ancestor_target "$INSTALL_ROOT" "$DATA_ROOT" "INSTALL_ROOT" "DATA_ROOT"
assert_not_ancestor_target "$INSTALL_ROOT" "$CONFIG_ROOT" "INSTALL_ROOT" "CONFIG_ROOT"
assert_no_overlap_target "$INSTALL_ROOT" "$RUNTIME_ROOT" "INSTALL_ROOT" "RUNTIME_ROOT"
assert_not_ancestor_target "$RUNTIME_ROOT" "$DATA_ROOT" "RUNTIME_ROOT" "DATA_ROOT"
assert_not_ancestor_target "$RUNTIME_ROOT" "$CONFIG_ROOT" "RUNTIME_ROOT" "CONFIG_ROOT"
assert_same_or_disjoint_target "$DATA_ROOT" "$CONFIG_ROOT" "DATA_ROOT" "CONFIG_ROOT"
assert_no_overlap_target "$BIN_ROOT" "$INSTALL_ROOT" "BIN_ROOT" "INSTALL_ROOT"
assert_no_overlap_target "$BIN_ROOT" "$DATA_ROOT" "BIN_ROOT" "DATA_ROOT"
assert_no_overlap_target "$BIN_ROOT" "$CONFIG_ROOT" "BIN_ROOT" "CONFIG_ROOT"
assert_no_overlap_target "$BIN_ROOT" "$RUNTIME_ROOT" "BIN_ROOT" "RUNTIME_ROOT"
launcher=$(safe_file_target "$INSTALL_ROOT/BlueTanukiLauncher.sh" "launcher")
BIN_LAUNCHER=$(safe_file_target "$BIN_ROOT/blue-tanuki" "BIN_LAUNCHER")
if [ -f "$launcher" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "Would stop resident gateway and disable resident autostart."
  else
    sh "$launcher" resident-stop >/dev/null 2>&1 || true
    sh "$launcher" resident-autostart-disable >/dev/null 2>&1 || true
  fi
fi

case "$PLATFORM" in
  macos)
    remove_file "$HOME/Applications/BlueTanuki.command" "application command"
    remove_file "$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist" "autostart entry"
    ;;
  linux)
    remove_file "${XDG_DATA_HOME:-$HOME/.local/share}/applications/blue-tanuki.desktop" "desktop launcher"
    remove_file "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/blue-tanuki.desktop" "autostart entry"
    ;;
esac

remove_file "$BIN_LAUNCHER" "launcher"
cd /
remove_target "$INSTALL_ROOT" "app"
remove_target "$RUNTIME_ROOT" "runtime"

if [ "$PURGE" = "1" ]; then
  remove_target "$DATA_ROOT" "data root"
  if [ "$CONFIG_ROOT" != "$DATA_ROOT" ]; then
    remove_target "$CONFIG_ROOT" "config root"
  fi
  say "BLUE-TANUKI uninstalled with data purge."
else
  say "BLUE-TANUKI app removed. Data retained at: $DATA_ROOT"
  say "Config retained at: $CONFIG_ROOT"
  say "Re-run with --purge to remove env, audit, session, and local data."
fi

printf 'uninstall_result=pass\n'
