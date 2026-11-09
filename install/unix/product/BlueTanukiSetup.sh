#!/usr/bin/env sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UNAME_S=$(uname -s 2>/dev/null || printf unknown)

case "$UNAME_S" in
  Darwin)
    PLATFORM="macos"
    PLATFORM_LABEL="macOS"
    DEFAULT_DATA_ROOT="$HOME/Library/Application Support/BlueTanuki"
    DEFAULT_INSTALL_ROOT="$DEFAULT_DATA_ROOT/app"
    DEFAULT_CONFIG_ROOT="$DEFAULT_DATA_ROOT"
    RUNTIME_GLOB="node-v*-darwin-*.tar.gz"
    ;;
  Linux)
    PLATFORM="linux"
    PLATFORM_LABEL="Linux"
    DEFAULT_DATA_ROOT="$HOME/.local/share/blue-tanuki"
    DEFAULT_INSTALL_ROOT="$DEFAULT_DATA_ROOT/app"
    DEFAULT_CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/blue-tanuki"
    RUNTIME_GLOB="node-v*-linux-x64.tar.xz"
    ;;
  *)
    echo "error: BlueTanukiSetup supports only macOS and Linux. detected=$UNAME_S" >&2
    exit 2
    ;;
esac

INSTALL_ROOT="${INSTALL_ROOT:-${BLUE_TANUKI_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}}"
DATA_ROOT="${DATA_ROOT:-${BLUE_TANUKI_DATA_ROOT:-$DEFAULT_DATA_ROOT}}"
CONFIG_ROOT="${CONFIG_ROOT:-${BLUE_TANUKI_CONFIG_ROOT:-$DEFAULT_CONFIG_ROOT}}"
RUNTIME_ROOT="${RUNTIME_ROOT:-${BLUE_TANUKI_RUNTIME_ROOT:-$DATA_ROOT/runtime}}"
BIN_ROOT="${BIN_ROOT:-${BLUE_TANUKI_BIN_ROOT:-$HOME/.local/bin}}"
CONTROL_CENTER_URL="${BLUE_TANUKI_CONTROL_CENTER_URL:-http://127.0.0.1:8787/app}"
FORCE="${FORCE:-0}"
RESET_CONFIG="${RESET_CONFIG:-0}"
RUN_DOCTOR="${RUN_DOCTOR:-1}"
LAUNCH_AFTER_INSTALL="${LAUNCH_AFTER_INSTALL:-1}"

usage() {
  cat <<USAGE
Usage: ./BlueTanukiSetup.sh [--install-root DIR] [--data-root DIR] [--config-root DIR] [--bin-root DIR] [--no-launch] [--reset-config] [--skip-doctor]

Installs BLUE-TANUKI from this packaged ${PLATFORM_LABEL} installer archive.
Normal users should not run source builds.
USAGE
}

fail() {
  echo "" >&2
  echo "BLUE-TANUKI ${PLATFORM_LABEL} setup did not complete." >&2
  echo "Reason: $*" >&2
  echo "" >&2
  exit 1
}

fail_source_tree() {
  echo "" >&2
  echo "BLUE-TANUKI ${PLATFORM_LABEL} setup did not complete." >&2
  echo "missing_installer_artifact=fail" >&2
  echo "wrong_asset=source_zip" >&2
  echo "" >&2
  echo "This setup script must be run from the packaged ${PLATFORM_LABEL} installer archive." >&2
  echo "For normal ${PLATFORM_LABEL} install, download blue-tanuki-<version>-${PLATFORM}-<arch>-installer.tar.gz from the release page." >&2
  echo "Developer build only: run INSTALL_${PLATFORM_LABEL_UPPER}.sh --build-from-source." >&2
  echo "" >&2
  exit 1
}

if [ ! -f "$PACKAGE_ROOT/safe-target.sh" ]; then
  SOURCE_GUARD=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/safe-target.sh
  [ -f "$SOURCE_GUARD" ] || fail_source_tree
  # shellcheck disable=SC1090
  . "$SOURCE_GUARD"
else
  # shellcheck disable=SC1091
  . "$PACKAGE_ROOT/safe-target.sh"
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-root)
      shift
      [ "$#" -gt 0 ] || fail "--install-root requires a value"
      INSTALL_ROOT="$1"
      ;;
    --install-root=*)
      INSTALL_ROOT=${1#--install-root=}
      ;;
    --data-root)
      shift
      [ "$#" -gt 0 ] || fail "--data-root requires a value"
      DATA_ROOT="$1"
      ;;
    --data-root=*)
      DATA_ROOT=${1#--data-root=}
      ;;
    --config-root)
      shift
      [ "$#" -gt 0 ] || fail "--config-root requires a value"
      CONFIG_ROOT="$1"
      ;;
    --config-root=*)
      CONFIG_ROOT=${1#--config-root=}
      ;;
    --bin-root)
      shift
      [ "$#" -gt 0 ] || fail "--bin-root requires a value"
      BIN_ROOT="$1"
      ;;
    --bin-root=*)
      BIN_ROOT=${1#--bin-root=}
      ;;
    --runtime-root)
      shift
      [ "$#" -gt 0 ] || fail "--runtime-root requires a value"
      RUNTIME_ROOT="$1"
      ;;
    --runtime-root=*)
      RUNTIME_ROOT=${1#--runtime-root=}
      ;;
    --no-launch)
      LAUNCH_AFTER_INSTALL=0
      ;;
    --reset-config)
      RESET_CONFIG=1
      ;;
    --skip-doctor)
      RUN_DOCTOR=0
      ;;
    --force)
      FORCE=1
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
fi

PLATFORM_LABEL_UPPER=$(printf '%s' "$PLATFORM_LABEL" | tr '[:lower:]' '[:upper:]')
INSTALL_ROOT=$(safe_destructive_target "$INSTALL_ROOT" "INSTALL_ROOT")
DATA_ROOT=$(safe_container_target "$DATA_ROOT" "DATA_ROOT")
CONFIG_ROOT=$(safe_container_target "$CONFIG_ROOT" "CONFIG_ROOT")
RUNTIME_ROOT=$(safe_destructive_target "$RUNTIME_ROOT" "RUNTIME_ROOT")
BIN_ROOT=$(safe_user_bin_target "$BIN_ROOT" "BIN_ROOT")
assert_not_same_target "$INSTALL_ROOT" "$DATA_ROOT" "INSTALL_ROOT" "DATA_ROOT"
assert_not_same_target "$INSTALL_ROOT" "$CONFIG_ROOT" "INSTALL_ROOT" "CONFIG_ROOT"
assert_not_same_target "$INSTALL_ROOT" "$RUNTIME_ROOT" "INSTALL_ROOT" "RUNTIME_ROOT"
assert_not_same_target "$RUNTIME_ROOT" "$DATA_ROOT" "RUNTIME_ROOT" "DATA_ROOT"
assert_not_same_target "$RUNTIME_ROOT" "$CONFIG_ROOT" "RUNTIME_ROOT" "CONFIG_ROOT"
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
ENV_FILE="$CONFIG_ROOT/blue-tanuki.env"
INSTALL_ENV="$INSTALL_ROOT/blue-tanuki-install.env"
INSTALL_JSON="$INSTALL_ROOT/blue-tanuki-install.json"
LAUNCHER="$INSTALL_ROOT/BlueTanukiLauncher.sh"
UNINSTALLER="$INSTALL_ROOT/BlueTanukiUninstall.sh"
BIN_LAUNCHER="$BIN_ROOT/blue-tanuki"
BIN_LAUNCHER=$(safe_file_target "$BIN_LAUNCHER" "BIN_LAUNCHER")
if [ "$PLATFORM" = "macos" ]; then
  SURFACE_FILE=$(safe_file_target "$HOME/Applications/BlueTanuki.command" "macOS_surface_file")
else
  SURFACE_FILE=$(safe_file_target "${XDG_DATA_HOME:-$HOME/.local/share}/applications/blue-tanuki.desktop" "Linux_surface_file")
fi

[ -d "$PACKAGE_ROOT/app" ] || fail_source_tree
[ -d "$PACKAGE_ROOT/runtime" ] || fail_source_tree
[ -d "$PACKAGE_ROOT/launcher" ] || fail_source_tree
[ -f "$PACKAGE_ROOT/unix-installer-manifest.json" ] && [ ! -L "$PACKAGE_ROOT/unix-installer-manifest.json" ] || fail_source_tree
[ -f "$PACKAGE_ROOT/launcher/BlueTanukiLauncher.sh" ] || fail_source_tree
[ -f "$PACKAGE_ROOT/launcher/BlueTanukiUninstall.sh" ] || fail_source_tree
assert_no_symlinks_in_tree "$PACKAGE_ROOT/app" packaged_app
assert_no_symlinks_in_tree "$PACKAGE_ROOT/runtime" packaged_runtime
assert_no_symlinks_in_tree "$PACKAGE_ROOT/launcher" packaged_launchers
PACKAGE_MANIFEST="$PACKAGE_ROOT/unix-installer-manifest.json"
[ "$(wc -c < "$PACKAGE_MANIFEST" | tr -d '[:space:]')" -le 1048576 ] || fail "installer manifest exceeds the size limit"
grep -Fqx '  "schema_version": 1,' "$PACKAGE_MANIFEST" || fail "installer manifest schema is not recognized"
grep -Fqx '  "name": "blue-tanuki",' "$PACKAGE_MANIFEST" || fail "installer manifest does not identify BLUE-TANUKI"
grep -Eq "^  \\\"package_type\\\": \\\"$PLATFORM-(x64|arm64)-tar-installer\\\",?$" "$PACKAGE_MANIFEST" || fail "installer manifest platform does not match $PLATFORM"
PACKAGE_MANIFEST_SHA256=$(sha256_file "$PACKAGE_MANIFEST")
case "$PACKAGE_MANIFEST_SHA256" in
  *[!0-9a-fA-F]*|'') fail "installer manifest SHA-256 could not be verified" ;;
esac
[ "${#PACKAGE_MANIFEST_SHA256}" -eq 64 ] || fail "installer manifest SHA-256 has an invalid length"

runtime_archive=$(find "$PACKAGE_ROOT/runtime" -type f -name "$RUNTIME_GLOB" | sort | sed -n '1p')
[ -n "$runtime_archive" ] || fail "bundled Node runtime archive not found for $PLATFORM"
manifest_runtime_archive=$(sed -n 's/^    "archive": "\([^"]*\)",$/\1/p' "$PACKAGE_MANIFEST")
manifest_runtime_sha256=$(sed -n 's/^    "sha256": "\([0-9A-Fa-f]\{64\}\)",$/\1/p' "$PACKAGE_MANIFEST")
[ "$manifest_runtime_archive" = "$(basename -- "$runtime_archive")" ] || fail "bundled Node runtime does not match the installer manifest"
[ "$(printf '%s' "$manifest_runtime_sha256" | tr '[:upper:]' '[:lower:]')" = "$(sha256_file "$runtime_archive" | tr '[:upper:]' '[:lower:]')" ] || fail "bundled Node runtime SHA-256 does not match the installer manifest"

quote_sh() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

assert_fresh_directory() {
  fresh_root=$1
  fresh_label=$2
  if [ -e "$fresh_root" ] || [ -L "$fresh_root" ]; then
    [ -d "$fresh_root" ] && [ ! -L "$fresh_root" ] || fail "$fresh_label exists but is not a regular directory: $fresh_root"
    assert_no_symlinks_in_tree "$fresh_root" "$fresh_label"
    fresh_contents=$(find "$fresh_root" ! -path "$fresh_root" -print -quit 2>/dev/null) || fail "$fresh_label could not be inspected: $fresh_root"
    [ -z "$fresh_contents" ] || fail "$fresh_label contains unowned content and cannot be adopted: $fresh_root"
  fi
}

assert_managed_external_file() {
  managed_file=$1
  expected_line=$2
  managed_label=$3
  if [ -e "$managed_file" ] || [ -L "$managed_file" ]; then
    [ -f "$managed_file" ] && [ ! -L "$managed_file" ] || fail "$managed_label is not a regular file: $managed_file"
    grep -Fqx "$expected_line" "$managed_file" || fail "$managed_label does not belong to this install: $managed_file"
  fi
}

INSTALL_PARENT=$(dirname -- "$INSTALL_ROOT")
RUNTIME_PARENT=$(dirname -- "$RUNTIME_ROOT")
INSTALL_NAME=$(basename -- "$INSTALL_ROOT")
RUNTIME_NAME=$(basename -- "$RUNTIME_ROOT")

recover_interrupted_product_update() {
  recovery_app_name_prefix=.$INSTALL_NAME.blue-tanuki-rollback-
  recovery_app_count=0
  recovery_app_candidate=
  recovery_suffix=
  for recovery_entry in "$INSTALL_PARENT"/.*; do
    [ -e "$recovery_entry" ] || [ -L "$recovery_entry" ] || continue
    recovery_entry_name=$(basename -- "$recovery_entry")
    case "$recovery_entry_name" in "$recovery_app_name_prefix"*) ;; *) continue ;; esac
    recovery_entry_suffix=${recovery_entry_name#"$recovery_app_name_prefix"}
    case "$recovery_entry_suffix" in *.*) ;; *) fail "an interrupted-update app path has an invalid suffix; no files were changed: $recovery_entry" ;; esac
    recovery_timestamp=${recovery_entry_suffix%%.*}
    recovery_pid=${recovery_entry_suffix#*.}
    case "$recovery_timestamp" in ''|*[!0-9]*) fail "an interrupted-update app path has an invalid suffix; no files were changed: $recovery_entry" ;; esac
    case "$recovery_pid" in ''|*[!0-9]*) fail "an interrupted-update app path has an invalid suffix; no files were changed: $recovery_entry" ;; esac
    recovery_app_count=$((recovery_app_count + 1))
    recovery_app_candidate=$recovery_entry
    recovery_suffix=$recovery_entry_suffix
  done
  [ "$recovery_app_count" -le 1 ] || fail "multiple interrupted-update app candidates exist; no files were changed"

  recovery_runtime_name_prefix=.$RUNTIME_NAME.blue-tanuki-rollback-
  recovery_runtime_candidate=
  recovery_runtime_count=0
  for recovery_entry in "$RUNTIME_PARENT"/.*; do
    [ -e "$recovery_entry" ] || [ -L "$recovery_entry" ] || continue
    recovery_entry_name=$(basename -- "$recovery_entry")
    case "$recovery_entry_name" in "$recovery_runtime_name_prefix"*) ;; *) continue ;; esac
    recovery_entry_suffix=${recovery_entry_name#"$recovery_runtime_name_prefix"}
    [ "$recovery_entry_suffix" = "$recovery_suffix" ] || fail "an unmatched interrupted-update runtime candidate exists; no files were changed: $recovery_entry"
    recovery_runtime_count=$((recovery_runtime_count + 1))
    recovery_runtime_candidate=$recovery_entry
  done
  [ "$recovery_runtime_count" -le 1 ] || fail "multiple interrupted-update runtime candidates exist; no files were changed"
  if [ "$recovery_app_count" = "0" ]; then
    [ "$recovery_runtime_count" = "0" ] || fail "an interrupted-update runtime candidate has no matching app candidate; all recovery paths were preserved"
    return 0
  fi

  recovery_env_backup="$CONFIG_ROOT/.blue-tanuki.env-rollback-$recovery_suffix"
  if [ -e "$recovery_env_backup" ] || [ -L "$recovery_env_backup" ]; then
    fail "an interrupted update also has a config backup; no install paths were changed. Preserve and inspect: $recovery_env_backup"
  fi

  if [ "$recovery_runtime_count" = "1" ]; then
    [ -d "$recovery_runtime_candidate" ] && [ ! -L "$recovery_runtime_candidate" ] || fail "interrupted-update runtime candidate is not a regular directory; no files were changed: $recovery_runtime_candidate"
    recovery_runtime_source=$recovery_runtime_candidate
  else
    [ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] || fail "the interrupted update has no verified runtime path; no files were changed"
    recovery_runtime_source=$RUNTIME_ROOT
  fi

  [ -d "$recovery_app_candidate" ] && [ ! -L "$recovery_app_candidate" ] || fail "interrupted-update app candidate is not a regular directory; no files were changed: $recovery_app_candidate"
  if ! (assert_managed_product_install "$recovery_app_candidate" "$DATA_ROOT" "$CONFIG_ROOT" "$recovery_runtime_source" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT") >/dev/null 2>&1; then
    fail "interrupted-update app/runtime candidate failed ownership or inventory verification; all recovery paths were preserved"
  fi

  recovery_partial_app=0
  recovery_quarantine_runtime=0
  if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
    [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] || fail "active install path is not a regular directory; no files were changed"
    if [ "$recovery_runtime_count" = "1" ]; then
      if [ -e "$RUNTIME_ROOT" ] || [ -L "$RUNTIME_ROOT" ]; then
        if ! (assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE") >/dev/null 2>&1; then
          fail "active app/runtime cannot be identified as a complete interrupted update; all recovery paths were preserved"
        fi
        recovery_quarantine_runtime=1
      else
        if ! (assert_managed_product_app_identity "$INSTALL_ROOT" "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE") >/dev/null 2>&1; then
          fail "active install path is not an identified managed partial update; it and rollback paths were preserved"
        fi
      fi
    else
      fail "a rollback app exists beside an active app without its matching runtime rollback; all paths were preserved"
    fi
    recovery_partial_app=1
  fi

  if [ -e "$RUNTIME_ROOT" ] || [ -L "$RUNTIME_ROOT" ]; then
    if [ "$recovery_runtime_count" = "1" ]; then
      if [ "$recovery_partial_app" != "1" ]; then
        fail "active runtime cannot be paired unambiguously with the interrupted update; no files were changed"
      fi
    fi
  fi

  recovery_quarantine_suffix="$(date +%s).$$"
  recovery_install_quarantine="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-interrupted-$recovery_quarantine_suffix"
  recovery_runtime_quarantine="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-interrupted-$recovery_quarantine_suffix"
  [ ! -e "$recovery_install_quarantine" ] && [ ! -L "$recovery_install_quarantine" ] || fail "interrupted-install recovery path already exists; no files were changed"
  [ ! -e "$recovery_runtime_quarantine" ] && [ ! -L "$recovery_runtime_quarantine" ] || fail "interrupted-runtime recovery path already exists; no files were changed"

  recovery_stop_launcher="$recovery_app_candidate/BlueTanukiLauncher.sh"
  if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
    recovery_stop_launcher="$INSTALL_ROOT/BlueTanukiLauncher.sh"
  fi
  if ! BLUE_TANUKI_RECOVERY=1 sh "$recovery_stop_launcher" resident-stop >/dev/null 2>&1; then
    fail "resident shutdown could not be confirmed before interrupted-update recovery; all paths were preserved"
  fi
  if ! (assert_managed_product_install "$recovery_app_candidate" "$DATA_ROOT" "$CONFIG_ROOT" "$recovery_runtime_source" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT") >/dev/null 2>&1; then
    fail "previous app/runtime changed during resident shutdown; all recovery paths were preserved"
  fi
  if [ "$recovery_partial_app" = "1" ]; then
    if [ -e "$RUNTIME_ROOT" ] || [ -L "$RUNTIME_ROOT" ]; then
      if ! (assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE") >/dev/null 2>&1; then
        fail "active app/runtime changed during resident shutdown; all recovery paths were preserved"
      fi
    elif ! (assert_managed_product_app_identity "$INSTALL_ROOT" "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE") >/dev/null 2>&1; then
      fail "active app changed during resident shutdown; all recovery paths were preserved"
    fi
  fi

  if [ "$recovery_quarantine_runtime" = "1" ]; then
    mv -- "$RUNTIME_ROOT" "$recovery_runtime_quarantine" || fail "partial runtime could not be preserved; rollback paths were retained"
  fi
  if [ "$recovery_partial_app" = "1" ]; then
    mv -- "$INSTALL_ROOT" "$recovery_install_quarantine" || fail "partial install could not be preserved; rollback paths were retained"
  fi
  if [ "$recovery_runtime_count" = "1" ]; then
    mv -- "$recovery_runtime_candidate" "$RUNTIME_ROOT" || fail "verified previous runtime could not be restored; recovery paths were preserved"
  fi
  mv -- "$recovery_app_candidate" "$INSTALL_ROOT" || fail "verified previous install could not be restored; recovery paths were preserved"
  assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  echo "warning: restored the verified previous product after an interrupted update."
  if [ "$recovery_partial_app" = "1" ]; then
    echo "warning: preserved the interrupted partial install for inspection: $recovery_install_quarantine"
  fi
  if [ "$recovery_quarantine_runtime" = "1" ]; then
    echo "warning: preserved the interrupted partial runtime for inspection: $recovery_runtime_quarantine"
  fi
}

INSTALL_EXISTS=0
recover_interrupted_product_update
if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] || fail "Install target exists but is not a regular directory: $INSTALL_ROOT"
  INSTALL_EXISTS=1
  [ "$FORCE" = "1" ] || fail "$INSTALL_ROOT already exists. Re-run with --force to replace a verified BLUE-TANUKI install."
  if [ -e "$INSTALL_ROOT/.blue-tanuki-owner" ] || [ -L "$INSTALL_ROOT/.blue-tanuki-owner" ]; then
    assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  else
    assert_legacy_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM"
  fi
else
  if [ -e "$RUNTIME_ROOT" ] || [ -L "$RUNTIME_ROOT" ]; then
    fail "Runtime target exists without a verified product install and will not be replaced: $RUNTIME_ROOT"
  fi
  if [ -e "$DATA_ROOT/.blue-tanuki-owner" ] || [ -L "$DATA_ROOT/.blue-tanuki-owner" ] || [ -e "$CONFIG_ROOT/.blue-tanuki-owner" ] || [ -L "$CONFIG_ROOT/.blue-tanuki-owner" ]; then
    assert_product_data_root_markers "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  else
    assert_fresh_directory "$DATA_ROOT" DATA_ROOT
    if [ "$CONFIG_ROOT" != "$DATA_ROOT" ]; then
      assert_fresh_directory "$CONFIG_ROOT" CONFIG_ROOT
    fi
  fi
fi

if [ "$INSTALL_EXISTS" = "1" ]; then
  assert_no_symlinks_in_tree "$INSTALL_ROOT" INSTALL_ROOT
  assert_no_symlinks_in_tree "$RUNTIME_ROOT" RUNTIME_ROOT
fi

desktop_dir=$(dirname -- "$SURFACE_FILE")
if [ "$PLATFORM" = "macos" ]; then
  assert_managed_external_file "$BIN_LAUNCHER" "exec \"$LAUNCHER\" \"\$@\"" BIN_LAUNCHER
  assert_managed_external_file "$SURFACE_FILE" "exec \"$BIN_LAUNCHER\" launch" macOS_application_command
else
  assert_managed_external_file "$BIN_LAUNCHER" "exec \"$LAUNCHER\" \"\$@\"" BIN_LAUNCHER
  assert_managed_external_file "$SURFACE_FILE" "Exec=$BIN_LAUNCHER launch" Linux_desktop_entry
fi

STAGE_SUFFIX="$(date +%s).$$"
INSTALL_STAGE="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-stage-$STAGE_SUFFIX"
RUNTIME_STAGE="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-stage-$STAGE_SUFFIX"
ROLLBACK_INSTALL="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-rollback-$STAGE_SUFFIX"
ROLLBACK_RUNTIME="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-rollback-$STAGE_SUFFIX"
ENV_FILE_STAGE="$CONFIG_ROOT/.blue-tanuki.env-stage-$STAGE_SUFFIX"
ENV_FILE_BACKUP="$CONFIG_ROOT/.blue-tanuki.env-rollback-$STAGE_SUFFIX"
INSTALL_ENV_STAGE="$INSTALL_STAGE/blue-tanuki-install.env"
INSTALL_JSON_STAGE="$INSTALL_STAGE/blue-tanuki-install.json"
STAGE_LAUNCHER="$INSTALL_STAGE/BlueTanukiLauncher.sh"
STAGE_UNINSTALLER="$INSTALL_STAGE/BlueTanukiUninstall.sh"
STAGE_BIN_WRAPPER="$INSTALL_STAGE/BlueTanuki.sh"
PREVIOUS_APP_MOVED=0
PREVIOUS_RUNTIME_MOVED=0
NEW_APP_MOVED=0
NEW_RUNTIME_MOVED=0
ENV_FILE_BACKED_UP=0
ENV_FILE_INSTALLED=0
cleanup_setup() {
  setup_status=$1
  trap - EXIT
  set +e
  if [ "$setup_status" -ne 0 ]; then
    if [ "$NEW_APP_MOVED" = "1" ] && [ "$NEW_RUNTIME_MOVED" = "1" ] && [ -d "$INSTALL_ROOT" ] && [ -d "$RUNTIME_ROOT" ]; then
      if (assert_managed_product_install_inventories "$INSTALL_ROOT" "$RUNTIME_ROOT"); then
        rm -rf -- "$RUNTIME_ROOT"
        rm -rf -- "$INSTALL_ROOT"
      fi
    elif [ "$NEW_APP_MOVED" = "1" ] && [ -d "$INSTALL_ROOT" ]; then
      if (assert_managed_product_app_inventory "$INSTALL_ROOT"); then rm -rf -- "$INSTALL_ROOT"; fi
    fi
    if [ "$PREVIOUS_APP_MOVED" = "1" ] && [ "$PREVIOUS_RUNTIME_MOVED" = "1" ] &&
        [ -d "$ROLLBACK_INSTALL" ] && [ -d "$ROLLBACK_RUNTIME" ] && [ ! -e "$INSTALL_ROOT" ] && [ ! -e "$RUNTIME_ROOT" ]; then
      if (assert_managed_product_install_inventories "$ROLLBACK_INSTALL" "$ROLLBACK_RUNTIME"); then
        mv -- "$ROLLBACK_INSTALL" "$INSTALL_ROOT" && PREVIOUS_APP_MOVED=0
        mv -- "$ROLLBACK_RUNTIME" "$RUNTIME_ROOT" && PREVIOUS_RUNTIME_MOVED=0
      fi
    elif [ "$PREVIOUS_APP_MOVED" = "1" ] && [ -d "$ROLLBACK_INSTALL" ] && [ ! -e "$INSTALL_ROOT" ]; then
      if (assert_managed_product_app_inventory "$ROLLBACK_INSTALL"); then
        mv -- "$ROLLBACK_INSTALL" "$INSTALL_ROOT" && PREVIOUS_APP_MOVED=0
      fi
    elif [ "$PREVIOUS_RUNTIME_MOVED" = "1" ] && [ -d "$ROLLBACK_RUNTIME" ] && [ ! -e "$RUNTIME_ROOT" ]; then
      runtime_metadata_root=$INSTALL_ROOT
      [ -d "$ROLLBACK_INSTALL" ] && runtime_metadata_root=$ROLLBACK_INSTALL
      if (assert_managed_product_runtime_inventory "$runtime_metadata_root" "$ROLLBACK_RUNTIME"); then
        mv -- "$ROLLBACK_RUNTIME" "$RUNTIME_ROOT" && PREVIOUS_RUNTIME_MOVED=0
      fi
    fi
    if [ "$ENV_FILE_BACKED_UP" = "1" ]; then
      if [ "$ENV_FILE_INSTALLED" = "1" ] && [ -f "$ENV_FILE" ]; then rm -f -- "$ENV_FILE"; fi
      if [ -f "$ENV_FILE_BACKUP" ] && [ ! -e "$ENV_FILE" ]; then
        mv -- "$ENV_FILE_BACKUP" "$ENV_FILE" && ENV_FILE_BACKED_UP=0
      fi
    elif [ "$ENV_FILE_INSTALLED" = "1" ] && [ -f "$ENV_FILE" ]; then
      rm -f -- "$ENV_FILE"
    fi
    if [ -d "$INSTALL_STAGE" ] && [ -d "$RUNTIME_STAGE" ]; then
      if (assert_managed_product_install_inventories "$INSTALL_STAGE" "$RUNTIME_STAGE"); then
        rm -rf -- "$RUNTIME_STAGE"
        rm -rf -- "$INSTALL_STAGE"
      fi
    elif [ -d "$INSTALL_STAGE" ] && (assert_managed_product_app_inventory "$INSTALL_STAGE"); then
      rm -rf -- "$INSTALL_STAGE"
    fi
    [ ! -f "$ENV_FILE_STAGE" ] || rm -f -- "$ENV_FILE_STAGE"
    if [ "$PREVIOUS_APP_MOVED" = "1" ] || [ "$PREVIOUS_RUNTIME_MOVED" = "1" ]; then
      echo "error: rollback could not restore every previous install path; recovery paths were preserved: $ROLLBACK_INSTALL ; $ROLLBACK_RUNTIME" >&2
    fi
  else
    if [ "$PREVIOUS_APP_MOVED" = "1" ] && [ "$PREVIOUS_RUNTIME_MOVED" = "1" ] &&
        [ -d "$ROLLBACK_INSTALL" ] && [ -d "$ROLLBACK_RUNTIME" ]; then
      if (assert_managed_product_install_inventories "$ROLLBACK_INSTALL" "$ROLLBACK_RUNTIME"); then
        rm -rf -- "$ROLLBACK_RUNTIME"
        rm -rf -- "$ROLLBACK_INSTALL"
        PREVIOUS_RUNTIME_MOVED=0
        PREVIOUS_APP_MOVED=0
      else
        echo "warning: previous app and runtime retained for recovery: $ROLLBACK_INSTALL ; $ROLLBACK_RUNTIME" >&2
      fi
    fi
    [ ! -f "$ENV_FILE_BACKUP" ] || rm -f -- "$ENV_FILE_BACKUP"
  fi
  exit "$setup_status"
}
trap 'cleanup_setup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for candidate in "$INSTALL_STAGE" "$RUNTIME_STAGE" "$ROLLBACK_INSTALL" "$ROLLBACK_RUNTIME" "$ENV_FILE_STAGE" "$ENV_FILE_BACKUP"; do
  [ ! -e "$candidate" ] && [ ! -L "$candidate" ] || fail "installer staging path already exists: $candidate"
done
mkdir -p "$INSTALL_PARENT" "$RUNTIME_PARENT" "$DATA_ROOT" "$CONFIG_ROOT" "$BIN_ROOT" "$desktop_dir"
mkdir "$INSTALL_STAGE" "$RUNTIME_STAGE"

cp -R "$PACKAGE_ROOT/app/." "$INSTALL_STAGE/"
cp "$PACKAGE_ROOT/launcher/BlueTanukiLauncher.sh" "$STAGE_LAUNCHER"
cp "$PACKAGE_ROOT/launcher/BlueTanukiUninstall.sh" "$STAGE_UNINSTALLER"
cp "$PACKAGE_MANIFEST" "$INSTALL_STAGE/blue-tanuki-package-manifest.json"
chmod +x "$STAGE_LAUNCHER" "$STAGE_UNINSTALLER"

case "$runtime_archive" in
  *.tar.xz)
    tar -xJf "$runtime_archive" -C "$RUNTIME_STAGE"
    ;;
  *.tar.gz|*.tgz)
    tar -xzf "$runtime_archive" -C "$RUNTIME_STAGE"
    ;;
  *)
    fail "unsupported runtime archive: $runtime_archive"
    ;;
esac

assert_no_symlinks_in_tree "$INSTALL_STAGE" staged_install
assert_no_symlinks_in_tree "$RUNTIME_STAGE" staged_runtime
NODE_EXE=$(find "$RUNTIME_STAGE" -type f -path "*/bin/node" | sort | sed -n '1p')
[ -n "$NODE_EXE" ] || fail "bundled node executable not found under $RUNTIME_STAGE"
chmod +x "$NODE_EXE" || true
NODE_TOP_DIRECTORY=$(basename -- "$(dirname -- "$(dirname -- "$NODE_EXE")")")
NODE_EXE_FINAL="$RUNTIME_ROOT/$NODE_TOP_DIRECTORY/bin/node"

{
  printf 'INSTALL_ROOT=%s\n' "$(quote_sh "$INSTALL_ROOT")"
  printf 'DATA_ROOT=%s\n' "$(quote_sh "$DATA_ROOT")"
  printf 'CONFIG_ROOT=%s\n' "$(quote_sh "$CONFIG_ROOT")"
  printf 'RUNTIME_ROOT=%s\n' "$(quote_sh "$RUNTIME_ROOT")"
  printf 'BIN_ROOT=%s\n' "$(quote_sh "$BIN_ROOT")"
  printf 'ENV_FILE=%s\n' "$(quote_sh "$ENV_FILE")"
  printf 'NODE_EXE=%s\n' "$(quote_sh "$NODE_EXE_FINAL")"
  printf 'CONTROL_CENTER_URL=%s\n' "$(quote_sh "$CONTROL_CENTER_URL")"
  printf 'PLATFORM=%s\n' "$(quote_sh "$PLATFORM")"
} > "$INSTALL_ENV_STAGE"
chmod 600 "$INSTALL_ENV_STAGE" || true

INSTALL_ROOT_VALUE="$INSTALL_ROOT" \
DATA_ROOT_VALUE="$DATA_ROOT" \
CONFIG_ROOT_VALUE="$CONFIG_ROOT" \
RUNTIME_ROOT_VALUE="$RUNTIME_ROOT" \
BIN_ROOT_VALUE="$BIN_ROOT" \
ENV_FILE_VALUE="$ENV_FILE" \
NODE_EXE_VALUE="$NODE_EXE_FINAL" \
PACKAGE_MANIFEST_SHA256_VALUE="$PACKAGE_MANIFEST_SHA256" \
CONTROL_CENTER_URL_VALUE="$CONTROL_CENTER_URL" \
PLATFORM_VALUE="$PLATFORM" \
"$NODE_EXE" -e '
const fs = require("fs");
const out = process.argv[1];
const keys = [
  "INSTALL_ROOT_VALUE",
  "DATA_ROOT_VALUE",
  "CONFIG_ROOT_VALUE",
  "RUNTIME_ROOT_VALUE",
  "BIN_ROOT_VALUE",
  "ENV_FILE_VALUE",
  "NODE_EXE_VALUE",
  "PACKAGE_MANIFEST_SHA256_VALUE",
  "CONTROL_CENTER_URL_VALUE",
  "PLATFORM_VALUE",
];
const data = {
  schema_version: 2,
  product_id: "blue-tanuki-product-install",
  package_manifest_sha256: process.env.PACKAGE_MANIFEST_SHA256_VALUE,
  install_root: process.env.INSTALL_ROOT_VALUE,
  data_root: process.env.DATA_ROOT_VALUE,
  config_root: process.env.CONFIG_ROOT_VALUE,
  runtime_root: process.env.RUNTIME_ROOT_VALUE,
  bin_root: process.env.BIN_ROOT_VALUE,
  env_file: process.env.ENV_FILE_VALUE,
  node_exe: process.env.NODE_EXE_VALUE,
  control_center_url: process.env.CONTROL_CENTER_URL_VALUE,
  platform: process.env.PLATFORM_VALUE,
  user_requires_node_pnpm_git: false,
  autostart_enabled_by_default: false,
};
for (const key of keys) if (!process.env[key]) throw new Error(`${key} missing`);
fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
' "$INSTALL_JSON_STAGE"

if { [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; } && { [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; }; then
  fail "Existing config path is not a regular file: $ENV_FILE"
fi
DOCTOR_ENV_FILE="$ENV_FILE"
if [ -f "$ENV_FILE" ] && [ "$RESET_CONFIG" != "1" ]; then
  echo "Existing env file retained: $ENV_FILE"
else
  if [ -f "$ENV_FILE" ] && [ "$RESET_CONFIG" = "1" ]; then
    echo "warning: RESET_CONFIG=1 is enabled. Existing env file will be regenerated: $ENV_FILE" >&2
    "$NODE_EXE" "$INSTALL_STAGE/apps/gateway/dist/main.js" --setup --yes --output "$ENV_FILE_STAGE" --base-dir "$DATA_ROOT/data" --force --no-doctor
  else
    "$NODE_EXE" "$INSTALL_STAGE/apps/gateway/dist/main.js" --setup --yes --output "$ENV_FILE_STAGE" --base-dir "$DATA_ROOT/data" --no-doctor
  fi
  DOCTOR_ENV_FILE="$ENV_FILE_STAGE"
fi

if [ "$RUN_DOCTOR" != "0" ]; then
  doctor_code=0
  "$NODE_EXE" "$INSTALL_STAGE/apps/gateway/dist/main.js" --doctor --env-file "$DOCTOR_ENV_FILE" --json || doctor_code=$?
  if [ "$doctor_code" -eq 2 ]; then
    fail "post-install doctor found blocking errors."
  fi
  if [ "$doctor_code" -ne 0 ] && [ "$doctor_code" -ne 1 ]; then
    fail "post-install doctor failed with exit code $doctor_code."
  fi
  if [ "$doctor_code" -eq 1 ]; then
    echo "warning: post-install doctor completed with warnings. Review the JSON output above." >&2
  fi
fi

cat > "$STAGE_BIN_WRAPPER" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$LAUNCHER")" "\$@"
EOF
chmod +x "$STAGE_BIN_WRAPPER"

if [ -f "$ENV_FILE_STAGE" ]; then chmod 600 "$ENV_FILE_STAGE"; fi
write_product_owner_marker "$INSTALL_STAGE/.blue-tanuki-owner" install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
INSTALL_MANAGED_FILES_SHA256=$(write_managed_tree_inventory "$INSTALL_STAGE" blue-tanuki-install.json \
  blue-tanuki-managed-files.txt blue-tanuki-product-install)
RUNTIME_MANAGED_FILES_SHA256=$(write_managed_tree_inventory "$RUNTIME_STAGE" __no_metadata__ \
  blue-tanuki-runtime-files.txt blue-tanuki-product-runtime)
INSTALL_MANAGED_FILES_SHA256_VALUE="$INSTALL_MANAGED_FILES_SHA256" \
RUNTIME_MANAGED_FILES_SHA256_VALUE="$RUNTIME_MANAGED_FILES_SHA256" \
"$NODE_EXE" -e '
const fs = require("fs");
const out = process.argv[1];
const data = JSON.parse(fs.readFileSync(out, "utf8"));
const installInventory = process.env.INSTALL_MANAGED_FILES_SHA256_VALUE;
const runtimeInventory = process.env.RUNTIME_MANAGED_FILES_SHA256_VALUE;
if (!/^[a-f0-9]{64}$/i.test(installInventory || "") || !/^[a-f0-9]{64}$/i.test(runtimeInventory || "")) {
  throw new Error("managed file inventory digest missing");
}
data.schema_version = 3;
data.managed_install_files_sha256 = installInventory;
data.managed_runtime_files_sha256 = runtimeInventory;
fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
' "$INSTALL_JSON_STAGE"

if [ "$INSTALL_EXISTS" = "1" ]; then
  assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  if ! sh "$LAUNCHER" resident-stop >/dev/null 2>&1; then
    fail "the existing resident process could not be safely stopped; the current install and runtime were retained"
  fi
  assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  mv -- "$INSTALL_ROOT" "$ROLLBACK_INSTALL"
  PREVIOUS_APP_MOVED=1
  mv -- "$RUNTIME_ROOT" "$ROLLBACK_RUNTIME"
  PREVIOUS_RUNTIME_MOVED=1
fi
mv -- "$INSTALL_STAGE" "$INSTALL_ROOT"
NEW_APP_MOVED=1
mv -- "$RUNTIME_STAGE" "$RUNTIME_ROOT"
NEW_RUNTIME_MOVED=1
assert_managed_product_install_inventories "$INSTALL_ROOT" "$RUNTIME_ROOT"

if [ -f "$ENV_FILE_STAGE" ]; then
  if [ -f "$ENV_FILE" ]; then
    mv -- "$ENV_FILE" "$ENV_FILE_BACKUP"
    ENV_FILE_BACKED_UP=1
  fi
  mv -- "$ENV_FILE_STAGE" "$ENV_FILE"
  ENV_FILE_INSTALLED=1
fi

cat > "$BIN_LAUNCHER" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$LAUNCHER")" "\$@"
EOF
chmod +x "$BIN_LAUNCHER"
if [ "$PLATFORM" = "macos" ]; then
  cat > "$SURFACE_FILE" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$BIN_LAUNCHER")" launch
EOF
  chmod +x "$SURFACE_FILE"
else
  cat > "$SURFACE_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=BLUE-TANUKI
Comment=Launch BLUE-TANUKI Control Center
Exec=$(printf '%s' "$BIN_LAUNCHER") launch
Terminal=false
Categories=Utility;
EOF
fi

if [ "$CONFIG_ROOT" = "$DATA_ROOT" ]; then
  write_product_owner_marker "$DATA_ROOT/.blue-tanuki-owner" shared-root "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
else
  write_product_owner_marker "$DATA_ROOT/.blue-tanuki-owner" data "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  write_product_owner_marker "$CONFIG_ROOT/.blue-tanuki-owner" config "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
fi
assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
ENV_FILE_BACKED_UP=0
ENV_FILE_INSTALLED=0

echo ""
echo "BLUE-TANUKI ${PLATFORM_LABEL} installed."
echo "Launcher: $BIN_LAUNCHER"
echo "Env file:  $ENV_FILE"
echo "Control:   $CONTROL_CENTER_URL"
echo "Autostart: not enabled by installer"
echo "user_requires_node_pnpm_git=false"
echo "install_result=pass"

if [ "$LAUNCH_AFTER_INSTALL" != "0" ]; then
  "$BIN_LAUNCHER" launch || echo "warning: product installed but launch failed; run $BIN_LAUNCHER launch to retry." >&2
fi
