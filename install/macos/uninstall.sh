#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/../unix/safe-target.sh"

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/Library/Application Support/BlueTanuki/app}"
DATA_ROOT="${DATA_ROOT:-$HOME/Library/Application Support/BlueTanuki}"
BIN_ROOT="${BIN_ROOT:-$HOME/.local/bin}"
ENV_FILE="$DATA_ROOT/blue-tanuki.env"
RESIDENT_SCRIPT="$INSTALL_ROOT/install/resident/blue-tanuki-resident.sh"
PURGE="${PURGE:-0}"
DRY_RUN="${DRY_RUN:-0}"

fail() {
  echo "error: $*" >&2
  exit 1
}

safe_target() {
  safe_destructive_target "$1" "$2"
}

remove_target() {
  target=$(safe_target "$1" "$2")
  if [ ! -e "$target" ]; then
    echo "Skip missing $2: $target"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "Would remove $2: $target"
    return
  fi
  rm -rf -- "$target"
  echo "Removed $2: $target"
}

remove_file() {
  target=$(safe_file_target "$1" "$2")
  if [ ! -e "$target" ]; then
    echo "Skip missing $2: $target"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "Would remove $2: $target"
    return
  fi
  rm -f -- "$target"
  echo "Removed $2: $target"
}

# Resolve every target and validate destructive overlaps before any stop or removal action.
INSTALL_ROOT=$(safe_destructive_target "$INSTALL_ROOT" "INSTALL_ROOT")
DATA_ROOT=$(safe_container_target "$DATA_ROOT" "DATA_ROOT")
BIN_ROOT=$(safe_user_bin_target "$BIN_ROOT" "BIN_ROOT")
assert_not_ancestor_target "$INSTALL_ROOT" "$DATA_ROOT" "INSTALL_ROOT" "DATA_ROOT"
assert_no_overlap_target "$BIN_ROOT" "$INSTALL_ROOT" "BIN_ROOT" "INSTALL_ROOT"
assert_no_overlap_target "$BIN_ROOT" "$DATA_ROOT" "BIN_ROOT" "DATA_ROOT"
LAUNCHER=$(safe_file_target "$BIN_ROOT/blue-tanuki" "LAUNCHER")
ENV_FILE="$DATA_ROOT/blue-tanuki.env"
RESIDENT_SCRIPT="$INSTALL_ROOT/install/resident/blue-tanuki-resident.sh"

if [ -f "$RESIDENT_SCRIPT" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "Would stop resident gateway and disable resident autostart."
  else
    INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" DATA_ROOT="$DATA_ROOT" LAUNCHER="$LAUNCHER" sh "$RESIDENT_SCRIPT" resident-stop || true
    INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" DATA_ROOT="$DATA_ROOT" LAUNCHER="$LAUNCHER" sh "$RESIDENT_SCRIPT" resident-autostart-disable || true
  fi
fi

remove_target "$INSTALL_ROOT" "app"
remove_file "$LAUNCHER" "launcher"

if [ "$PURGE" = "1" ]; then
  remove_target "$DATA_ROOT" "data root"
  echo "BLUE-TANUKI uninstalled with data purge."
else
  echo "BLUE-TANUKI app removed. Data retained at: $DATA_ROOT"
  echo "Re-run with PURGE=1 to remove env, audit, session, and local data."
fi
