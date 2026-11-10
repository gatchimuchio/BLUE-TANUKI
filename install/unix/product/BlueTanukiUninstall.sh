#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
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

fail() {
  echo "error: $*" >&2
  exit 2
}

OWNER_MARKER="$SCRIPT_DIR/.blue-tanuki-owner"
if [ ! -f "$OWNER_MARKER" ] || [ -L "$OWNER_MARKER" ]; then
  fail "product ownership marker is missing; no files were changed. Automatic migration or removal is unavailable without independently verified ownership and version evidence. Preserve the old install and verify its contents. Install the current version only to a separate verified-empty install target with separately verified data/config paths. Back up and verify old files and user data before any manual removal; --force does not bypass ownership or inventory checks."
fi
[ "$(wc -l < "$OWNER_MARKER" | tr -d '[:space:]')" = 10 ] || fail "product ownership marker has an unexpected shape; no files were changed"

owner_value() {
  owner_key=$1
  owner_count=$(grep -c "^$owner_key=" "$OWNER_MARKER" || true)
  [ "$owner_count" = 1 ] || fail "product ownership marker field is missing or duplicated: $owner_key"
  sed -n "s/^$owner_key=//p" "$OWNER_MARKER"
}

INSTALL_ROOT=$(owner_value install_root)
DATA_ROOT=$(owner_value data_root)
CONFIG_ROOT=$(owner_value config_root)
RUNTIME_ROOT=$(owner_value runtime_root)
BIN_ROOT=$(owner_value bin_root)
PLATFORM=$(owner_value platform)
SURFACE_FILE=$(owner_value surface_file)
MARKER_KIND=$(owner_value root_kind)
[ "$MARKER_KIND" = install ] || fail "product ownership marker does not identify an install root"
for pair in "INSTALL_ROOT:$INSTALL_ROOT" "DATA_ROOT:$DATA_ROOT" "CONFIG_ROOT:$CONFIG_ROOT" "RUNTIME_ROOT:$RUNTIME_ROOT" "BIN_ROOT:$BIN_ROOT" "SURFACE_FILE:$SURFACE_FILE"; do
  owner_key=${pair%%:*}
  owner_path=${pair#*:}
  assert_metadata_path_value "$owner_path" "$owner_key"
done

INSTALL_ROOT=$(safe_destructive_target "$INSTALL_ROOT" INSTALL_ROOT)
DATA_ROOT=$(safe_container_target "$DATA_ROOT" DATA_ROOT)
CONFIG_ROOT=$(safe_container_target "$CONFIG_ROOT" CONFIG_ROOT)
RUNTIME_ROOT=$(safe_destructive_target "$RUNTIME_ROOT" RUNTIME_ROOT)
BIN_ROOT=$(safe_user_bin_target "$BIN_ROOT" BIN_ROOT)
SURFACE_FILE=$(safe_file_target "$SURFACE_FILE" SURFACE_FILE)
[ "$INSTALL_ROOT" = "$SCRIPT_DIR" ] || fail "uninstaller location does not match its recorded install root"
case "$(uname -s 2>/dev/null || printf unknown):$PLATFORM" in
  Linux:linux|Darwin:macos) ;;
  *) fail "product platform does not match this operating system" ;;
esac
assert_not_same_target "$INSTALL_ROOT" "$DATA_ROOT" INSTALL_ROOT DATA_ROOT
assert_not_same_target "$INSTALL_ROOT" "$CONFIG_ROOT" INSTALL_ROOT CONFIG_ROOT
assert_no_overlap_target "$INSTALL_ROOT" "$RUNTIME_ROOT" INSTALL_ROOT RUNTIME_ROOT
assert_not_ancestor_target "$RUNTIME_ROOT" "$DATA_ROOT" RUNTIME_ROOT DATA_ROOT
assert_not_ancestor_target "$RUNTIME_ROOT" "$CONFIG_ROOT" RUNTIME_ROOT CONFIG_ROOT
assert_same_or_disjoint_target "$DATA_ROOT" "$CONFIG_ROOT" DATA_ROOT CONFIG_ROOT
assert_no_overlap_target "$BIN_ROOT" "$INSTALL_ROOT" BIN_ROOT INSTALL_ROOT
assert_no_overlap_target "$BIN_ROOT" "$DATA_ROOT" BIN_ROOT DATA_ROOT
assert_no_overlap_target "$BIN_ROOT" "$CONFIG_ROOT" BIN_ROOT CONFIG_ROOT
assert_no_overlap_target "$BIN_ROOT" "$RUNTIME_ROOT" BIN_ROOT RUNTIME_ROOT
assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"

PURGE="${PURGE:-0}"
DRY_RUN="${DRY_RUN:-0}"
QUIET="${QUIET:-0}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge|-PurgeData) PURGE=1 ;;
    --dry-run|-DryRun) DRY_RUN=1 ;;
    --quiet|-Quiet) QUIET=1 ;;
    -h|--help)
      echo "Usage: BlueTanukiUninstall.sh [--purge] [--dry-run] [--quiet]"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

say() {
  if [ "$QUIET" != "1" ]; then printf '%s\n' "$*"; fi
}

if [ "$PURGE" = "1" ]; then
  assert_no_symlinks_in_tree "$DATA_ROOT" DATA_ROOT
  if [ "$CONFIG_ROOT" != "$DATA_ROOT" ]; then assert_no_symlinks_in_tree "$CONFIG_ROOT" CONFIG_ROOT; fi
fi

remove_target() {
  target=$(safe_destructive_target "$1" "$2")
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    say "Skip missing $2: $target"
    return
  fi
  assert_no_symlinks_in_tree "$target" "$2"
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove $2: $target"
    return
  fi
  rm -rf -- "$target"
  say "Removed $2: $target"
}

remove_file_if_owned() {
  owned_file=$1
  identity_line=$2
  identity_value=$3
  owned_label=$4
  if [ ! -e "$owned_file" ] && [ ! -L "$owned_file" ]; then return; fi
  if [ ! -f "$owned_file" ] || [ -L "$owned_file" ]; then
    say "Preserved $owned_label because it is not a regular file: $owned_file"
    return
  fi
  if [ -n "$identity_line" ]; then
    grep -Fqx "$identity_line" "$owned_file" || {
      say "Preserved unrelated $owned_label: $owned_file"
      return
    }
  fi
  if [ -n "$identity_value" ]; then
    grep -Fq "$identity_value" "$owned_file" || {
      say "Preserved unrelated $owned_label: $owned_file"
      return
    }
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove managed $owned_label: $owned_file"
    return
  fi
  rm -f -- "$owned_file"
  say "Removed managed $owned_label: $owned_file"
}

remove_linux_autostart_if_owned() {
  owned_file=$1
  if [ ! -e "$owned_file" ] && [ ! -L "$owned_file" ]; then return; fi
  if ! is_managed_linux_autostart_entry "$owned_file" "$INSTALL_ROOT"; then
    say "Preserved unrelated autostart_entry: $owned_file"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove managed autostart_entry: $owned_file"
    return
  fi
  rm -f -- "$owned_file"
  say "Removed managed autostart_entry: $owned_file"
}

LAUNCHER="$INSTALL_ROOT/BlueTanukiLauncher.sh"
BIN_LAUNCHER=$(safe_file_target "$BIN_ROOT/blue-tanuki" BIN_LAUNCHER)
if [ -f "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "Would stop resident gateway and remove only an owned autostart entry."
  else
    if ! sh "$LAUNCHER" resident-stop >/dev/null 2>&1; then
      fail "resident shutdown was not confirmed; install, runtime, and user data were retained"
    fi
  fi
fi

remove_file_if_owned "$BIN_LAUNCHER" "exec \"$LAUNCHER\" \"\$@\"" "" launcher
if [ "$PLATFORM" = macos ]; then
  remove_file_if_owned "$SURFACE_FILE" "exec \"$BIN_LAUNCHER\" launch" "" application_command
  macos_autostart="$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist"
  remove_file_if_owned "$macos_autostart" "<string>$INSTALL_ROOT/BlueTanukiLauncher.sh</string>" "" autostart_entry
else
  remove_file_if_owned "$SURFACE_FILE" "Exec=$BIN_LAUNCHER launch" "" desktop_launcher
  linux_autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/blue-tanuki.desktop"
  remove_linux_autostart_if_owned "$linux_autostart"
fi

cd /
remove_target "$INSTALL_ROOT" app
remove_target "$RUNTIME_ROOT" runtime

if [ "$PURGE" = "1" ]; then
  remove_target "$DATA_ROOT" data_root
  if [ "$CONFIG_ROOT" != "$DATA_ROOT" ]; then remove_target "$CONFIG_ROOT" config_root; fi
  say "BLUE-TANUKI uninstalled with data purge."
else
  say "BLUE-TANUKI app removed. Data retained at: $DATA_ROOT"
  say "Config retained at: $CONFIG_ROOT"
  say "Re-run with --purge to remove env, audit, session, and local data."
fi

printf 'uninstall_result=pass\n'
