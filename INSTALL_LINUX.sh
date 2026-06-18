#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELEASE_DIR="${BLUE_TANUKI_RELEASE_DIR:-$SCRIPT_DIR/release/linux}"
WORK_ROOT="${BLUE_TANUKI_INSTALL_WORK_ROOT:-$SCRIPT_DIR/.codex-tmp/linux-install-entrypoint}"
LOG_PATH="$WORK_ROOT/install.log"
DRY_RUN=0
BUILD_FROM_SOURCE=0
INSTALLER_ARCHIVE=""
LAUNCH_AFTER_INSTALL="${LAUNCH_AFTER_INSTALL:-1}"
GITHUB_REPOSITORY="${BLUE_TANUKI_GITHUB_REPOSITORY:-gatchimuchio/blue-tanuki}"

usage() {
  cat <<'USAGE'
Usage: sh ./INSTALL_LINUX.sh [--dry-run] [--no-launch] [--build-from-source] [--installer-archive FILE] [--release-dir DIR] [--work-root DIR]

Normal Linux users should not run source builds. Download
blue-tanuki-<version>-linux-x64-installer.tar.gz, extract it, and run
BlueTanukiSetup.sh.

Developer build only:
  sh ./INSTALL_LINUX.sh --build-from-source
USAGE
}

fail_wrong_asset() {
  reason="$1"
  echo "" >&2
  echo "BLUE-TANUKI Linux install did not complete." >&2
  echo "Reason: $reason" >&2
  echo "Log: $LOG_PATH" >&2
  echo "" >&2
  echo "missing_installer_artifact=fail" >&2
  echo "wrong_asset=source_zip" >&2
  echo "" >&2
  echo "This is a source tree/source zip, not the Linux one-click installer artifact." >&2
  echo "For normal Linux install, download blue-tanuki-<version>-linux-x64-installer.tar.gz from the release page." >&2
  echo "Developer build only: run INSTALL_LINUX.sh --build-from-source." >&2
  exit 1
}

fail_developer() {
  reason="$1"
  echo "" >&2
  echo "BLUE-TANUKI developer Linux source build did not complete." >&2
  echo "Reason: $reason" >&2
  echo "Log: $LOG_PATH" >&2
  echo "" >&2
  echo "Developer prerequisites: Node.js 22.14.0+, Corepack/pnpm or npm-based pnpm execution." >&2
  echo "Normal Linux users should not run source builds." >&2
  echo "Download blue-tanuki-<version>-linux-x64-installer.tar.gz, extract it, and run BlueTanukiSetup.sh." >&2
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
    --build-from-source|-BuildFromSource)
      BUILD_FROM_SOURCE=1
      ;;
    --installer-archive)
      shift
      [ "$#" -gt 0 ] || fail_wrong_asset "--installer-archive requires a value"
      INSTALLER_ARCHIVE="$1"
      ;;
    --installer-archive=*)
      INSTALLER_ARCHIVE=${1#--installer-archive=}
      ;;
    --release-dir)
      shift
      [ "$#" -gt 0 ] || fail_wrong_asset "--release-dir requires a value"
      RELEASE_DIR="$1"
      ;;
    --release-dir=*)
      RELEASE_DIR=${1#--release-dir=}
      ;;
    --work-root)
      shift
      [ "$#" -gt 0 ] || fail_wrong_asset "--work-root requires a value"
      WORK_ROOT="$1"
      LOG_PATH="$WORK_ROOT/install.log"
      ;;
    --work-root=*)
      WORK_ROOT=${1#--work-root=}
      LOG_PATH="$WORK_ROOT/install.log"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail_wrong_asset "unknown argument: $1"
      ;;
  esac
  shift
done

if [ "${NO_LAUNCH:-0}" = "1" ]; then
  LAUNCH_AFTER_INSTALL=0
  export LAUNCH_AFTER_INSTALL
fi

package_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/package.json" | sed -n '1p'
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
    return
  fi
  fail_wrong_asset "cannot verify SHA-256; sha256sum, shasum, or openssl is required"
}

read_sha256_sidecar() {
  [ -f "$1" ] || fail_wrong_asset "missing sha256 sidecar: $1"
  awk '{print $1; exit}' "$1"
}

verify_manifest() {
  manifest="$1"
  package_type="$2"
  [ -f "$manifest" ] || fail_wrong_asset "missing manifest sidecar: $manifest"
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"blue-tanuki"' "$manifest" || fail_wrong_asset "manifest name must be blue-tanuki"
  grep -Eq "\"package_type\"[[:space:]]*:[[:space:]]*\"$package_type\"" "$manifest" || fail_wrong_asset "manifest package_type mismatch"
  grep -Eq '"bundled"[[:space:]]*:[[:space:]]*true' "$manifest" || fail_wrong_asset "manifest must declare node_runtime.bundled=true"
  grep -Eq '"requires_node_pnpm_git_from_user"[[:space:]]*:[[:space:]]*false' "$manifest" || fail_wrong_asset "manifest must declare user_experience.requires_node_pnpm_git_from_user=false"
}

verify_installer() {
  archive="$1"
  package_type="linux-x64-tar-installer"
  [ -f "$archive" ] || fail_wrong_asset "installer archive not found: $archive"
  expected=$(read_sha256_sidecar "$archive.sha256")
  actual=$(sha256_file "$archive")
  [ "$expected" = "$actual" ] || fail_wrong_asset "installer archive SHA-256 mismatch"
  verify_manifest "$archive.manifest.json" "$package_type"
}

find_local_installer() {
  version=$(package_version)
  expected="$RELEASE_DIR/blue-tanuki-$version-linux-x64-installer.tar.gz"
  if [ -n "$INSTALLER_ARCHIVE" ]; then
    printf '%s\n' "$INSTALLER_ARCHIVE"
    return
  fi
  if [ -f "$expected" ]; then
    printf '%s\n' "$expected"
    return
  fi
  find "$RELEASE_DIR" -maxdepth 1 -type f -name 'blue-tanuki-*-linux-x64-installer.tar.gz' 2>/dev/null | sort | sed -n '1p'
}

download_release_installer() {
  version=$(package_version)
  archive_name="blue-tanuki-$version-linux-x64-installer.tar.gz"
  tag="v$version"
  base="https://github.com/$GITHUB_REPOSITORY/releases/download/$tag"
  mkdir -p "$WORK_ROOT/download"
  archive="$WORK_ROOT/download/$archive_name"
  if ! command -v curl >/dev/null 2>&1; then
    fail_wrong_asset "no packaged installer found and curl is unavailable for verified release download"
  fi
  curl -fL "$base/$archive_name" -o "$archive" || fail_wrong_asset "could not download release installer: $base/$archive_name"
  curl -fL "$base/$archive_name.sha256" -o "$archive.sha256" || fail_wrong_asset "could not download release sha256 sidecar"
  curl -fL "$base/$archive_name.manifest.json" -o "$archive.manifest.json" || fail_wrong_asset "could not download release manifest sidecar"
  verify_installer "$archive"
  printf '%s\n' "$archive"
}

run_packaged_installer() {
  archive="$1"
  extract_dir="$WORK_ROOT/extracted"
  rm -rf -- "$extract_dir"
  mkdir -p "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir"
  LAUNCH_AFTER_INSTALL="$LAUNCH_AFTER_INSTALL" sh "$extract_dir/BlueTanukiSetup.sh"
}

mkdir -p "$WORK_ROOT"
: > "$LOG_PATH"

echo "[BLUE-TANUKI] Linux install entrypoint"
echo "[BLUE-TANUKI] Repository root: $SCRIPT_DIR"
echo "[BLUE-TANUKI] Release dir: $RELEASE_DIR"
echo "[BLUE-TANUKI] Log: $LOG_PATH"

if [ "$BUILD_FROM_SOURCE" = "1" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "developer_build_from_source=true"
    echo "would_run=sh ./install/linux/install.sh"
    echo "would_launch_after_install=$LAUNCH_AFTER_INSTALL"
    echo "linux_source_entrypoint_build_from_source_dry_run=pass"
    exit 0
  fi
  [ "$(uname -s)" = "Linux" ] || fail_developer "INSTALL_LINUX.sh --build-from-source must be run on Linux."
  (
    set +e
    cd "$SCRIPT_DIR" && sh ./install/linux/install.sh
    code=$?
    printf '%s\n' "$code" > "$WORK_ROOT/status"
    exit 0
  ) 2>&1 | tee -a "$LOG_PATH"
  status=$(sed -n '1p' "$WORK_ROOT/status" 2>/dev/null || printf '1')
  rm -f "$WORK_ROOT/status"
  [ "$status" = "0" ] || fail_developer "install/linux/install.sh failed with exit code $status"
  exit 0
fi

local_installer=$(find_local_installer)

if [ "$DRY_RUN" = "1" ]; then
  if [ -n "$local_installer" ]; then
    echo "would_verify_installer=$local_installer"
    echo "would_run=BlueTanukiSetup.sh"
  else
    version=$(package_version)
    echo "missing_installer_artifact=fail"
    echo "wrong_asset=source_zip"
    echo "would_download_release_installer=https://github.com/$GITHUB_REPOSITORY/releases/download/v$version/blue-tanuki-$version-linux-x64-installer.tar.gz"
    echo "This is a source tree/source zip, not the Linux one-click installer artifact."
  fi
  echo "would_launch_after_install=$LAUNCH_AFTER_INSTALL"
  echo "linux_source_entrypoint_dry_run=pass"
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || fail_wrong_asset "INSTALL_LINUX.sh must be run on Linux."

if [ -z "$local_installer" ]; then
  local_installer=$(download_release_installer)
fi

verify_installer "$local_installer"
(
  set +e
  run_packaged_installer "$local_installer"
  code=$?
  printf '%s\n' "$code" > "$WORK_ROOT/status"
  exit 0
) 2>&1 | tee -a "$LOG_PATH"
status=$(sed -n '1p' "$WORK_ROOT/status" 2>/dev/null || printf '1')
rm -f "$WORK_ROOT/status"
[ "$status" = "0" ] || fail_wrong_asset "BlueTanukiSetup.sh failed with exit code $status"

echo ""
echo "BLUE-TANUKI Linux install entrypoint completed."
