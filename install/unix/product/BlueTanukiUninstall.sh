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

remove_exact_managed_file() {
  owned_file=$1
  owned_label=$2
  owned_predicate=$3
  shift 3
  if [ ! -e "$owned_file" ] && [ ! -L "$owned_file" ]; then return; fi
  if ! "$owned_predicate" "$owned_file" "$@"; then
    say "Preserved unrelated or modified $owned_label: $owned_file"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove managed $owned_label: $owned_file"
    return
  fi
  rm -f -- "$owned_file"
  say "Removed managed $owned_label: $owned_file"
}

assert_regular_autostart_parent_chain() {
  bt_autostart_parent=$1
  while [ "$bt_autostart_parent" != "/" ]; do
    [ ! -L "$bt_autostart_parent" ] || fail "autostart parent path contains a symlink; no product files were removed: $bt_autostart_parent"
    if [ -e "$bt_autostart_parent" ] && [ ! -d "$bt_autostart_parent" ]; then
      fail "autostart parent path is not a directory; no product files were removed: $bt_autostart_parent"
    fi
    bt_autostart_parent=${bt_autostart_parent%/*}
    [ -n "$bt_autostart_parent" ] || bt_autostart_parent=/
  done
}

configure_product_autostart_target() {
  case "$PLATFORM" in
    macos)
      [ -n "${HOME:-}" ] || fail "HOME is unavailable; cannot inspect macOS autostart safely"
      AUTOSTART_FILE="$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist"
      ;;
    linux)
      [ -n "${HOME:-}" ] || fail "HOME is unavailable; cannot inspect Linux autostart safely"
      bt_autostart_config_home=${XDG_CONFIG_HOME:-$HOME/.config}
      assert_absolute_single_line_path "Linux XDG config home" "$bt_autostart_config_home"
      AUTOSTART_FILE="$bt_autostart_config_home/autostart/blue-tanuki.desktop"
      ;;
    *)
      fail "unsupported platform for autostart inspection: $PLATFORM"
      ;;
  esac
  AUTOSTART_FILE=$(safe_file_target "$AUTOSTART_FILE" AUTOSTART_FILE)
  AUTOSTART_PARENT=${AUTOSTART_FILE%/*}
  assert_regular_autostart_parent_chain "$AUTOSTART_PARENT"
}

product_autostart_is_managed() {
  case "$PLATFORM" in
    linux) is_managed_linux_autostart_entry "$AUTOSTART_FILE" "$INSTALL_ROOT" ;;
    macos)
      is_managed_macos_autostart_entry "$AUTOSTART_FILE" "$INSTALL_ROOT" \
        "$DATA_ROOT/logs/blue-tanuki.out.log" "$DATA_ROOT/logs/blue-tanuki.err.log"
      ;;
  esac
}

product_autostart_references_install() {
  case "$PLATFORM" in
    linux) linux_autostart_entry_references_install "$AUTOSTART_FILE" "$INSTALL_ROOT" ;;
    macos) macos_autostart_entry_references_install "$AUTOSTART_FILE" "$INSTALL_ROOT" ;;
  esac
}

preflight_product_autostart() {
  if [ ! -e "$AUTOSTART_FILE" ] && [ ! -L "$AUTOSTART_FILE" ]; then return; fi
  assert_regular_autostart_parent_chain "$AUTOSTART_PARENT"
  [ -f "$AUTOSTART_FILE" ] && [ ! -L "$AUTOSTART_FILE" ] && [ -r "$AUTOSTART_FILE" ] ||
    fail "autostart entry cannot be safely classified; no product files were removed: $AUTOSTART_FILE"
  if product_autostart_is_managed; then return; fi
  if product_autostart_references_install; then
    fail "modified autostart entry references this installation; no product files were removed: $AUTOSTART_FILE"
  else
    bt_autostart_status=$?
  fi
  case "$bt_autostart_status" in
    1) return ;;
    *) fail "autostart entry could not be inspected safely; no product files were removed: $AUTOSTART_FILE" ;;
  esac
}

remove_product_autostart() {
  if [ ! -e "$AUTOSTART_FILE" ] && [ ! -L "$AUTOSTART_FILE" ]; then return; fi
  assert_regular_autostart_parent_chain "$AUTOSTART_PARENT"
  [ -f "$AUTOSTART_FILE" ] && [ ! -L "$AUTOSTART_FILE" ] && [ -r "$AUTOSTART_FILE" ] ||
    fail "autostart entry changed to an unsafe object; product files were preserved: $AUTOSTART_FILE"
  if product_autostart_is_managed; then
    if [ "$DRY_RUN" = "1" ]; then
      say "Would remove managed autostart_entry: $AUTOSTART_FILE"
      return
    fi
    rm -f -- "$AUTOSTART_FILE"
    say "Removed managed autostart_entry: $AUTOSTART_FILE"
    return
  fi
  if product_autostart_references_install; then
    fail "autostart entry now references this installation; product files were preserved: $AUTOSTART_FILE"
  else
    bt_autostart_status=$?
  fi
  case "$bt_autostart_status" in
    1) say "Preserved unrelated autostart_entry: $AUTOSTART_FILE" ;;
    *) fail "autostart entry could not be inspected safely; product files were preserved: $AUTOSTART_FILE" ;;
  esac
}

assert_product_autostart_clear() {
  if [ ! -e "$AUTOSTART_FILE" ] && [ ! -L "$AUTOSTART_FILE" ]; then return; fi
  assert_regular_autostart_parent_chain "$AUTOSTART_PARENT"
  [ -f "$AUTOSTART_FILE" ] && [ ! -L "$AUTOSTART_FILE" ] && [ -r "$AUTOSTART_FILE" ] ||
    fail "autostart entry appeared in an unsafe form; product files were preserved: $AUTOSTART_FILE"
  if product_autostart_references_install; then
    fail "autostart entry still references this installation; product files were preserved: $AUTOSTART_FILE"
  else
    bt_autostart_status=$?
  fi
  case "$bt_autostart_status" in
    1) return ;;
    *) fail "autostart entry could not be inspected safely; product files were preserved: $AUTOSTART_FILE" ;;
  esac
}

LAUNCHER="$INSTALL_ROOT/BlueTanukiLauncher.sh"
BIN_LAUNCHER=$(safe_file_target "$BIN_ROOT/blue-tanuki" BIN_LAUNCHER)
configure_product_autostart_target
preflight_product_autostart
if [ -f "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "Would stop resident gateway and remove only an owned autostart entry."
  else
    if ! sh "$LAUNCHER" resident-stop >/dev/null 2>&1; then
      fail "resident shutdown was not confirmed; install, runtime, and user data were retained"
    fi
    assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  fi
fi

remove_product_autostart
remove_exact_managed_file "$BIN_LAUNCHER" launcher is_managed_unix_launcher_wrapper "$LAUNCHER"
if [ "$PLATFORM" = macos ]; then
  remove_exact_managed_file "$SURFACE_FILE" application_command is_managed_macos_application_command "$BIN_LAUNCHER"
else
  remove_exact_managed_file "$SURFACE_FILE" desktop_launcher is_managed_linux_desktop_entry "$BIN_LAUNCHER"
fi

if [ "$DRY_RUN" != "1" ]; then assert_product_autostart_clear; fi
cd /
remove_target "$INSTALL_ROOT" app
remove_target "$RUNTIME_ROOT" runtime

if [ "$PURGE" = "1" ]; then
  if [ "$DRY_RUN" != "1" ]; then
    assert_product_data_root_markers "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  fi
  if [ "$CONFIG_ROOT" != "$DATA_ROOT" ]; then
    remove_target "$CONFIG_ROOT" config_root
    if [ "$DRY_RUN" != "1" ]; then
      assert_product_owner_marker "$DATA_ROOT/.blue-tanuki-owner" data "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
    fi
  fi
  remove_target "$DATA_ROOT" data_root
  say "BLUE-TANUKI uninstalled with data purge."
else
  say "BLUE-TANUKI app removed. Data retained at: $DATA_ROOT"
  say "Config retained at: $CONFIG_ROOT"
  say "Re-run with --purge to remove env, audit, session, and local data."
fi

printf 'uninstall_result=pass\n'
