#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
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

abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$(pwd)/$1" ;;
  esac
}

safe_target() {
  target=$(abs_path "$1")
  case "$target" in
    "/"|"."|"") fail "$2 points to an unsafe path: $target" ;;
    "$HOME"|"$HOME/"|"$HOME/.local"|"$HOME/.local/share"|"$HOME/.local/bin"|"$HOME/.config"|"$HOME/Library"|"$HOME/Library/Application Support")
      fail "$2 points to a broad user directory: $target"
      ;;
  esac
  printf '%s\n' "$target"
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
  target=$(abs_path "$1")
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

launcher="$INSTALL_ROOT/BlueTanukiLauncher.sh"
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

remove_file "$BIN_ROOT/blue-tanuki" "launcher"
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
