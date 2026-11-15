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

version_meets_minimum() {
  version_value=$1
  minimum_major=$2
  minimum_minor=$3
  case "$version_value" in *[!0-9.]*|'') return 1 ;; esac
  version_major=${version_value%%.*}
  version_rest=${version_value#*.}
  version_minor=${version_rest%%.*}
  case "$version_major:$version_minor" in *[!0-9:]*|:|*:) return 1 ;; esac
  [ "$version_major" -gt "$minimum_major" ] ||
    { [ "$version_major" -eq "$minimum_major" ] && [ "$version_minor" -ge "$minimum_minor" ]; }
}

assert_linux_runtime_compatibility() {
  [ "$PLATFORM" = "linux" ] || return 0
  linux_arch=$(uname -m 2>/dev/null || printf unknown)
  case "$linux_arch" in
    x86_64|amd64) ;;
    *) fail "this Linux package supports x86_64 only; detected architecture: $linux_arch" ;;
  esac
  linux_kernel=$(uname -r 2>/dev/null | sed -n 's/^\([0-9][0-9]*\)\.\([0-9][0-9]*\).*$/\1.\2/p')
  version_meets_minimum "$linux_kernel" 4 18 || fail "this Linux package requires kernel >= 4.18; detected: ${linux_kernel:-unknown}"
  if ! command -v getconf >/dev/null 2>&1; then
    fail "this Linux package requires getconf to identify the system libc; no install files were changed"
  fi
  linux_libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  case "$linux_libc" in
    "glibc "*) linux_glibc_version=${linux_libc#glibc } ;;
    *) fail "this Linux package requires glibc >= 2.28 and does not support musl or an unidentified libc; detected: ${linux_libc:-unknown}" ;;
  esac
  version_meets_minimum "$linux_glibc_version" 2 28 || fail "this Linux package requires glibc >= 2.28; detected: $linux_glibc_version"
  for runtime_command in tar mktemp find ps awk; do
    command -v "$runtime_command" >/dev/null 2>&1 || fail "required Linux command is missing: $runtime_command"
  done
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "this Linux package requires sha256sum or shasum to verify managed files"
  fi
}

# Packaged install paths use OS defaults or explicit CLI options, never inherited
# developer/source-installer environment overrides.
unset INSTALL_ROOT DATA_ROOT CONFIG_ROOT RUNTIME_ROOT BIN_ROOT \
  BLUE_TANUKI_INSTALL_ROOT BLUE_TANUKI_DATA_ROOT BLUE_TANUKI_CONFIG_ROOT \
  BLUE_TANUKI_RUNTIME_ROOT BLUE_TANUKI_BIN_ROOT
INSTALL_ROOT="$DEFAULT_INSTALL_ROOT"
DATA_ROOT="$DEFAULT_DATA_ROOT"
CONFIG_ROOT="$DEFAULT_CONFIG_ROOT"
RUNTIME_ROOT="$DATA_ROOT/runtime"
BIN_ROOT="$HOME/.local/bin"
# Packaged product Control Center is local-only; source installers retain their
# independent URL override.
unset BLUE_TANUKI_CONTROL_CENTER_URL
CONTROL_CENTER_URL="http://127.0.0.1:8787/app"
# Developer source-installer environment switches must not alter packaged setup.
# The explicit CLI options below are the only way to change these modes.
unset FORCE RESET_CONFIG RUN_DOCTOR
FORCE=0
RESET_CONFIG=0
RUN_DOCTOR=1
LAUNCH_AFTER_INSTALL="${LAUNCH_AFTER_INSTALL:-1}"
UPDATE_MODE=0
ROLLBACK_MODE=0

usage() {
  cat <<USAGE
Usage: ./BlueTanukiSetup.sh [--update|--rollback] [--install-root DIR] [--data-root DIR] [--config-root DIR]
  [--runtime-root DIR] [--bin-root DIR] [--no-launch]

Installs, explicitly updates, or rolls back BLUE-TANUKI from this packaged ${PLATFORM_LABEL} installer archive.
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

remove_bundled_node_tool_links() {
  runtime_root=$1
  node_exe=$2
  "$node_exe" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const links = new Map([
  ["bin/npm", "../lib/node_modules/npm/bin/npm-cli.js"],
  ["bin/npx", "../lib/node_modules/npm/bin/npx-cli.js"],
  ["bin/corepack", "../lib/node_modules/corepack/dist/corepack.js"],
]);
function isWithinRoot(candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
for (const [relative, expectedTarget] of links) {
  const link = path.join(root, relative);
  let metadata;
  try {
    metadata = fs.lstatSync(link);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (!metadata.isSymbolicLink()) throw new Error(`unexpected bundled Node tool entry: ${relative}`);
  if (fs.readlinkSync(link) !== expectedTarget) throw new Error(`unexpected bundled Node tool link target: ${relative}`);
  const resolved = fs.realpathSync(link);
  if (!isWithinRoot(resolved) || !fs.statSync(link).isFile()) {
    throw new Error(`bundled Node tool link escapes the runtime or has no regular target: ${relative}`);
  }
  fs.unlinkSync(link);
}
' "$runtime_root"
}

directory_identity() {
  directory_path=$1
  [ -d "$directory_path" ] && [ ! -L "$directory_path" ] || return 1
  identity=$(LC_ALL=C ls -di "$directory_path" 2>/dev/null | awk 'NR == 1 { print $1 }')
  case "$identity" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$identity"
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
    --update)
      UPDATE_MODE=1
      ;;
    --rollback)
      ROLLBACK_MODE=1
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

[ "$((UPDATE_MODE + ROLLBACK_MODE))" -le 1 ] || fail "--update and --rollback cannot be combined"

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
grep -Fqx '  "name": "blue-tanuki",' "$PACKAGE_MANIFEST" || fail "installer manifest does not identify BLUE-TANUKI"
if [ "$PLATFORM" = "linux" ]; then
  grep -Fqx '  "schema_version": 2,' "$PACKAGE_MANIFEST" || fail "Linux installer manifest schema is not recognized"
  grep -Fqx '  "package_type": "linux-x64-tar-installer",' "$PACKAGE_MANIFEST" || fail "installer manifest must identify the Linux x64 package"
  grep -Fqx '  "linux_runtime": {' "$PACKAGE_MANIFEST" || fail "Linux runtime requirements are missing from the installer manifest"
  grep -Fqx '    "distribution": "vendor-supported GNU/Linux releases using glibc",' "$PACKAGE_MANIFEST" || fail "Linux distribution target is missing or unsupported"
  grep -Fqx '    "architecture": "x64",' "$PACKAGE_MANIFEST" || fail "Linux architecture target is missing or unsupported"
  grep -Fqx '    "minimum_kernel": "4.18",' "$PACKAGE_MANIFEST" || fail "Linux kernel requirement is missing or unsupported"
  grep -Fqx '    "libc": "glibc",' "$PACKAGE_MANIFEST" || fail "Linux libc requirement is missing or unsupported"
  grep -Fqx '    "minimum_libc": "2.28",' "$PACKAGE_MANIFEST" || fail "Linux glibc requirement is missing or unsupported"
  grep -Fqx '    "musl_supported": false,' "$PACKAGE_MANIFEST" || fail "Linux musl support must not be implied"
  grep -Fqx '    "credential_storage": "Linux Secret Service over the current-user session D-Bus is required only when persisting credentials",' "$PACKAGE_MANIFEST" || fail "Linux credential storage dependency is missing or unsupported"
  grep -Fqx '    "compatibility_source": "https://github.com/nodejs/node/blob/v22.14.0/BUILDING.md"' "$PACKAGE_MANIFEST" || fail "Linux compatibility source is missing"
else
  grep -Fqx '  "schema_version": 1,' "$PACKAGE_MANIFEST" || fail "macOS installer manifest schema is not recognized"
  grep -Eq "^  \\\"package_type\\\": \\\"macos-(x64|arm64)-tar-installer\\\",?$" "$PACKAGE_MANIFEST" || fail "installer manifest platform does not match $PLATFORM"
fi
PACKAGE_DATA_SCHEMA_VERSION=$(sed -n 's/^  "data_schema_version": \([1-9][0-9]*\),$/\1/p' "$PACKAGE_MANIFEST")
case "$PACKAGE_DATA_SCHEMA_VERSION" in
  ''|*[!0-9]*) fail "installer manifest has no supported product data-schema version" ;;
esac
[ "${#PACKAGE_DATA_SCHEMA_VERSION}" -le 10 ] || fail "installer manifest product data-schema version is outside the supported range"
PACKAGE_MANIFEST_SHA256=$(sha256_file "$PACKAGE_MANIFEST")
case "$PACKAGE_MANIFEST_SHA256" in
  *[!0-9a-fA-F]*|'') fail "installer manifest SHA-256 could not be verified" ;;
esac
[ "${#PACKAGE_MANIFEST_SHA256}" -eq 64 ] || fail "installer manifest SHA-256 has an invalid length"
assert_linux_runtime_compatibility

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
  managed_label=$2
  managed_renderer=$3
  shift 3
  if [ -e "$managed_file" ] || [ -L "$managed_file" ]; then
    [ -f "$managed_file" ] && [ ! -L "$managed_file" ] || fail "$managed_label is not a regular file: $managed_file"
    if ! "$managed_renderer" "$@" | cmp -s "$managed_file" -; then
      if [ "$managed_label" != Linux_desktop_entry ] ||
          ! render_legacy_managed_linux_desktop_entry "$@" | cmp -s "$managed_file" -; then
        fail "$managed_label is not an exact managed file; existing data was preserved: $managed_file"
      fi
    fi
  fi
}

INSTALL_PARENT=$(dirname -- "$INSTALL_ROOT")
RUNTIME_PARENT=$(dirname -- "$RUNTIME_ROOT")
INSTALL_NAME=$(basename -- "$INSTALL_ROOT")
RUNTIME_NAME=$(basename -- "$RUNTIME_ROOT")
ROLLBACK_POINTER="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-rollback-current"
PREVIOUS_SUFFIX=
PREVIOUS_APP_ROOT=
PREVIOUS_RUNTIME_ROOT=

valid_transaction_suffix() {
  suffix_value=$1
  case "$suffix_value" in *.*) ;; *) return 1 ;; esac
  suffix_left=${suffix_value%%.*}
  suffix_right=${suffix_value#*.}
  case "$suffix_right" in *.*) return 1 ;; esac
  case "$suffix_left:$suffix_right" in ''|:*|*:|*[!0-9:]*) return 1 ;; esac
  return 0
}

read_previous_pointer() {
  PREVIOUS_SUFFIX=
  PREVIOUS_APP_ROOT=
  PREVIOUS_RUNTIME_ROOT=
  if [ ! -e "$ROLLBACK_POINTER" ] && [ ! -L "$ROLLBACK_POINTER" ]; then return 0; fi
  [ -f "$ROLLBACK_POINTER" ] && [ ! -L "$ROLLBACK_POINTER" ] || fail "rollback reference is not a regular file; no install paths were changed: $ROLLBACK_POINTER"
  [ "$(wc -c < "$ROLLBACK_POINTER" | tr -d '[:space:]')" -le 128 ] || fail "rollback reference exceeds its size limit; no install paths were changed"
  [ "$(wc -l < "$ROLLBACK_POINTER" | tr -d '[:space:]')" = 1 ] || fail "rollback reference has an unexpected shape; no install paths were changed"
  PREVIOUS_SUFFIX=$(cat "$ROLLBACK_POINTER")
  valid_transaction_suffix "$PREVIOUS_SUFFIX" || fail "rollback reference suffix is invalid; no install paths were changed"
  PREVIOUS_APP_ROOT="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-rollback-$PREVIOUS_SUFFIX"
  PREVIOUS_RUNTIME_ROOT="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-rollback-$PREVIOUS_SUFFIX"
  [ -d "$PREVIOUS_APP_ROOT" ] && [ ! -L "$PREVIOUS_APP_ROOT" ] || fail "retained rollback application is missing or unsafe; no install paths were changed: $PREVIOUS_APP_ROOT"
  [ -d "$PREVIOUS_RUNTIME_ROOT" ] && [ ! -L "$PREVIOUS_RUNTIME_ROOT" ] || fail "retained rollback runtime is missing or unsafe; no install paths were changed: $PREVIOUS_RUNTIME_ROOT"
  assert_managed_product_install "$PREVIOUS_APP_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$PREVIOUS_RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT"
}

manifest_value() {
  manifest_file=$1
  manifest_key=$2
  manifest_value_result=$(sed -n "s/^  \"$manifest_key\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$manifest_file")
  [ "$(printf '%s\n' "$manifest_value_result" | wc -l | tr -d '[:space:]')" = 1 ] || fail "product manifest field is missing or ambiguous: $manifest_key"
  printf '%s\n' "$manifest_value_result"
}

manifest_schema_version() {
  manifest_file=$1
  manifest_schema=$(sed -n 's/^  "data_schema_version": \([1-9][0-9]*\),$/\1/p' "$manifest_file")
  [ "$(printf '%s\n' "$manifest_schema" | wc -l | tr -d '[:space:]')" = 1 ] || fail "product data-schema version is missing or ambiguous: $manifest_file"
  printf '%s\n' "$manifest_schema"
}

write_previous_pointer() {
  pointer_suffix=$1
  valid_transaction_suffix "$pointer_suffix" || fail "cannot write an invalid rollback reference"
  pointer_temporary="$ROLLBACK_POINTER.tmp.$$"
  [ ! -e "$pointer_temporary" ] && [ ! -L "$pointer_temporary" ] || fail "rollback reference staging path already exists: $pointer_temporary"
  if [ -e "$ROLLBACK_POINTER" ] || [ -L "$ROLLBACK_POINTER" ]; then
    [ -f "$ROLLBACK_POINTER" ] && [ ! -L "$ROLLBACK_POINTER" ] ||
      fail "rollback reference destination changed to an unsafe object; existing application paths were preserved"
  fi
  printf '%s\n' "$pointer_suffix" > "$pointer_temporary"
  chmod 600 "$pointer_temporary" || fail "rollback reference permissions could not be restricted"
  mv -f -- "$pointer_temporary" "$ROLLBACK_POINTER" || fail "rollback reference could not be committed; existing application paths were preserved"
  [ -f "$ROLLBACK_POINTER" ] && [ ! -L "$ROLLBACK_POINTER" ] && [ "$(cat "$ROLLBACK_POINTER")" = "$pointer_suffix" ] ||
    fail "rollback reference could not be read back after commit"
}

retire_previous_pair() {
  retire_suffix=$1
  valid_transaction_suffix "$retire_suffix" || fail "cannot retire a rollback path with an invalid suffix"
  retire_app="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-rollback-$retire_suffix"
  retire_runtime="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-rollback-$retire_suffix"
  [ -d "$retire_app" ] && [ ! -L "$retire_app" ] || fail "rollback application changed before retirement; preserved: $retire_app"
  [ -d "$retire_runtime" ] && [ ! -L "$retire_runtime" ] || fail "rollback runtime changed before retirement; preserved: $retire_runtime"
  assert_managed_product_install "$retire_app" "$DATA_ROOT" "$CONFIG_ROOT" "$retire_runtime" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT"
  assert_no_symlinks_in_tree "$retire_app" PreviousProductInstall
  assert_no_symlinks_in_tree "$retire_runtime" PreviousProductRuntime
  rm -rf -- "$retire_app" || fail "previous product application could not be retired; no user data was changed: $retire_app"
  [ ! -e "$retire_app" ] && [ ! -L "$retire_app" ] || fail "previous product application remained after retirement: $retire_app"
  rm -rf -- "$retire_runtime" || fail "previous product runtime could not be retired; no user data was changed: $retire_runtime"
  [ ! -e "$retire_runtime" ] && [ ! -L "$retire_runtime" ] || fail "previous product runtime remained after retirement: $retire_runtime"
}

compare_manifest_versions() {
  current_manifest=$1
  candidate_manifest=$2
  "$NODE_EXE" - "$current_manifest" "$candidate_manifest" <<'NODE'
const fs = require("node:fs");
const [currentPath, candidatePath] = process.argv.slice(2);
const pattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
function parse(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const version = manifest.version;
  const match = typeof version === "string" ? pattern.exec(version) : null;
  if (!match) throw new Error(`package version is not valid SemVer: ${file}`);
  const prerelease = match[4] === undefined ? null : match[4].split(".");
  if (prerelease?.some((part) => /^[0-9]+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`numeric prerelease identifier has a leading zero: ${version}`);
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}
function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === null ? 1 : -1;
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const numericA = /^[0-9]+$/u.test(a);
    const numericB = /^[0-9]+$/u.test(b);
    if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length > right.prerelease.length ? 1 : -1;
}
process.stdout.write(String(compare(parse(candidatePath), parse(currentPath))));
NODE
}

recover_interrupted_product_update() {
  read_previous_pointer
  completed_suffix=$PREVIOUS_SUFFIX
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
    if [ -n "$completed_suffix" ] && [ "$recovery_entry_suffix" = "$completed_suffix" ]; then continue; fi
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
    if [ -n "$completed_suffix" ] && [ "$recovery_entry_suffix" = "$completed_suffix" ]; then continue; fi
    [ "$recovery_entry_suffix" = "$recovery_suffix" ] || fail "an unmatched interrupted-update runtime candidate exists; no files were changed: $recovery_entry"
    recovery_runtime_count=$((recovery_runtime_count + 1))
    recovery_runtime_candidate=$recovery_entry
  done
  [ "$recovery_runtime_count" -le 1 ] || fail "multiple interrupted-update runtime candidates exist; no files were changed"
  if [ -n "$completed_suffix" ] &&
      { [ "$recovery_app_count" != "0" ] || [ "$recovery_runtime_count" != "0" ]; }; then
    fail "unreferenced update paths exist beside a committed rollback version; all paths were preserved for inspection"
  fi
  if [ "$recovery_app_count" = "0" ]; then
    [ "$recovery_runtime_count" = "0" ] || fail "an interrupted-update runtime candidate has no matching app candidate; all recovery paths were preserved"
    return 0
  fi

  if [ "$recovery_app_count" = "1" ] && [ "$recovery_runtime_count" = "1" ] &&
      [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] &&
      [ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ]; then
    if (assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE") >/dev/null 2>&1 &&
        (assert_managed_product_install "$recovery_app_candidate" "$DATA_ROOT" "$CONFIG_ROOT" "$recovery_runtime_candidate" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT") >/dev/null 2>&1; then
      active_schema=$(manifest_schema_version "$INSTALL_ROOT/blue-tanuki-package-manifest.json")
      recovery_schema=$(manifest_schema_version "$recovery_app_candidate/blue-tanuki-package-manifest.json")
      [ "$active_schema" = "$recovery_schema" ] ||
        fail "active and interrupted-update versions have different product data schemas; all paths were preserved"
      write_previous_pointer "$recovery_suffix"
      echo "warning: recovered the verified previous-version reference after an interrupted update commit."
      return 0
    fi
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

recover_interrupted_product_update
if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] || fail "Install target exists but is not a regular directory: $INSTALL_ROOT"
  if [ -e "$INSTALL_ROOT/.blue-tanuki-owner" ] || [ -L "$INSTALL_ROOT/.blue-tanuki-owner" ]; then
    assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  else
    assert_legacy_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM"
  fi
  if [ "$UPDATE_MODE" = "1" ] || [ "$ROLLBACK_MODE" = "1" ]; then
    [ "$RESET_CONFIG" != "1" ] && [ "$RUN_DOCTOR" != "0" ] && [ "$FORCE" != "1" ] ||
      fail "manual update/rollback cannot reset configuration, skip the packaged doctor, or use --force. Existing application and data were preserved"
    [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "manual update/rollback requires the existing regular product configuration; no files were changed"
    ACTIVE_MANIFEST="$INSTALL_ROOT/blue-tanuki-package-manifest.json"
    ACTIVE_MANIFEST_SHA256=$(sha256_file "$ACTIVE_MANIFEST")
    ACTIVE_DATA_SCHEMA_VERSION=$(manifest_schema_version "$ACTIVE_MANIFEST")
    [ "$ACTIVE_DATA_SCHEMA_VERSION" = "$PACKAGE_DATA_SCHEMA_VERSION" ] ||
      fail "installed and packaged product data-schema versions differ; migration is unsupported and no files were changed"
    UPDATE_ENV_SHA256=$(sha256_file "$ENV_FILE")
    if [ "$ROLLBACK_MODE" = "1" ]; then
      [ "$UPDATE_MODE" = "0" ] || fail "--update and --rollback cannot be combined"
      read_previous_pointer
      [ -n "$PREVIOUS_SUFFIX" ] || fail "no verified previous BLUE-TANUKI version is retained; no files were changed"
      ROLLBACK_SOURCE_SUFFIX=$PREVIOUS_SUFFIX
      ROLLBACK_SOURCE_APP=$PREVIOUS_APP_ROOT
      ROLLBACK_SOURCE_RUNTIME=$PREVIOUS_RUNTIME_ROOT
      ROLLBACK_SOURCE_SCHEMA=$(manifest_schema_version "$ROLLBACK_SOURCE_APP/blue-tanuki-package-manifest.json")
      [ "$ROLLBACK_SOURCE_SCHEMA" = "$ACTIVE_DATA_SCHEMA_VERSION" ] ||
        fail "retained rollback version has an incompatible product data schema; no files were changed"
    fi
  else
    fail "in-place product replacement is unsupported without the explicit --update or --rollback option; a matching product data-schema declaration does not authorize replacement. The existing application and data were preserved"
  fi
else
  [ "$UPDATE_MODE" = "0" ] && [ "$ROLLBACK_MODE" = "0" ] || fail "manual update/rollback requires an existing verified BLUE-TANUKI installation"
  [ -z "$PREVIOUS_SUFFIX" ] || fail "a retained rollback version exists without its active product installation; no paths were changed"
  if [ -e "$RUNTIME_ROOT" ] || [ -L "$RUNTIME_ROOT" ]; then
    fail "Runtime target exists without a verified product install and will not be replaced: $RUNTIME_ROOT"
  fi
  if [ -e "$DATA_ROOT/.blue-tanuki-owner" ] || [ -L "$DATA_ROOT/.blue-tanuki-owner" ] || [ -e "$CONFIG_ROOT/.blue-tanuki-owner" ] || [ -L "$CONFIG_ROOT/.blue-tanuki-owner" ]; then
    assert_product_data_root_markers "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  elif [ -e "$DATA_ROOT/blue-tanuki-product-data.json" ] || [ -L "$DATA_ROOT/blue-tanuki-product-data.json" ]; then
    [ -f "$DATA_ROOT/blue-tanuki-product-data.json" ] && [ ! -L "$DATA_ROOT/blue-tanuki-product-data.json" ] || fail "product data compatibility marker is not a regular file"
  else
    assert_fresh_directory "$DATA_ROOT" DATA_ROOT
    if [ "$CONFIG_ROOT" != "$DATA_ROOT" ]; then
      assert_fresh_directory "$CONFIG_ROOT" CONFIG_ROOT
    fi
  fi
fi

desktop_dir=$(dirname -- "$SURFACE_FILE")
if [ "$PLATFORM" = "macos" ]; then
  assert_managed_external_file "$BIN_LAUNCHER" BIN_LAUNCHER render_managed_unix_launcher_wrapper "$LAUNCHER"
  assert_managed_external_file "$SURFACE_FILE" macOS_application_command render_managed_macos_application_command "$BIN_LAUNCHER"
else
  render_managed_linux_desktop_entry "$BIN_LAUNCHER" >/dev/null
  assert_managed_external_file "$BIN_LAUNCHER" BIN_LAUNCHER render_managed_unix_launcher_wrapper "$LAUNCHER"
  assert_managed_external_file "$SURFACE_FILE" Linux_desktop_entry render_managed_linux_desktop_entry "$BIN_LAUNCHER"
fi

STAGE_SUFFIX="$(date +%s).$$"
INSTALL_STAGE="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-stage-$STAGE_SUFFIX"
RUNTIME_STAGE="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-stage-$STAGE_SUFFIX"
ENV_FILE_STAGE="$CONFIG_ROOT/.blue-tanuki.env-stage-$STAGE_SUFFIX"
ENV_FILE_BACKUP="$CONFIG_ROOT/.blue-tanuki.env-rollback-$STAGE_SUFFIX"
INSTALL_ENV_STAGE="$INSTALL_STAGE/blue-tanuki-install.env"
INSTALL_JSON_STAGE="$INSTALL_STAGE/blue-tanuki-install.json"
STAGE_LAUNCHER="$INSTALL_STAGE/BlueTanukiLauncher.sh"
STAGE_UNINSTALLER="$INSTALL_STAGE/BlueTanukiUninstall.sh"
STAGE_BIN_WRAPPER="$INSTALL_STAGE/BlueTanuki.sh"
NEW_APP_MOVED=0
NEW_RUNTIME_MOVED=0
INSTALL_STAGE_CREATED=0
RUNTIME_STAGE_CREATED=0
INSTALL_STAGE_ID=
RUNTIME_STAGE_ID=
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
    if [ "$ENV_FILE_BACKED_UP" = "1" ]; then
      if [ "$ENV_FILE_INSTALLED" = "1" ] && [ -f "$ENV_FILE" ]; then rm -f -- "$ENV_FILE"; fi
      if [ -f "$ENV_FILE_BACKUP" ] && [ ! -e "$ENV_FILE" ]; then
        mv -- "$ENV_FILE_BACKUP" "$ENV_FILE" && ENV_FILE_BACKED_UP=0
      fi
    elif [ "$ENV_FILE_INSTALLED" = "1" ] && [ -f "$ENV_FILE" ]; then
      rm -f -- "$ENV_FILE"
    fi
    if [ "$RUNTIME_STAGE_CREATED" = "1" ]; then
      current_runtime_stage_id=$(directory_identity "$RUNTIME_STAGE")
      if [ -n "$RUNTIME_STAGE_ID" ] && [ "$current_runtime_stage_id" = "$RUNTIME_STAGE_ID" ]; then
        rm -rf -- "$RUNTIME_STAGE"
      else
        echo "error: runtime staging path identity changed or is unknown; retained: $RUNTIME_STAGE" >&2
      fi
    fi
    if [ "$INSTALL_STAGE_CREATED" = "1" ]; then
      current_install_stage_id=$(directory_identity "$INSTALL_STAGE")
      if [ -n "$INSTALL_STAGE_ID" ] && [ "$current_install_stage_id" = "$INSTALL_STAGE_ID" ]; then
        rm -rf -- "$INSTALL_STAGE"
      else
        echo "error: install staging path identity changed or is unknown; retained: $INSTALL_STAGE" >&2
      fi
    fi
    [ ! -f "$ENV_FILE_STAGE" ] || rm -f -- "$ENV_FILE_STAGE"
  else
    [ ! -f "$ENV_FILE_BACKUP" ] || rm -f -- "$ENV_FILE_BACKUP"
  fi
  exit "$setup_status"
}
trap 'cleanup_setup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for candidate in "$INSTALL_STAGE" "$RUNTIME_STAGE" "$ENV_FILE_STAGE" "$ENV_FILE_BACKUP"; do
  [ ! -e "$candidate" ] && [ ! -L "$candidate" ] || fail "installer staging path already exists: $candidate"
done
mkdir -p "$INSTALL_PARENT" "$RUNTIME_PARENT" "$DATA_ROOT" "$CONFIG_ROOT" "$BIN_ROOT" "$desktop_dir"
mkdir "$INSTALL_STAGE"
INSTALL_STAGE_CREATED=1
INSTALL_STAGE_ID=$(directory_identity "$INSTALL_STAGE") || fail "install staging directory identity could not be recorded safely"
mkdir "$RUNTIME_STAGE"
RUNTIME_STAGE_CREATED=1
RUNTIME_STAGE_ID=$(directory_identity "$RUNTIME_STAGE") || fail "runtime staging directory identity could not be recorded safely"

if [ "$ROLLBACK_MODE" = "1" ]; then
  cp -R "$ROLLBACK_SOURCE_APP/." "$INSTALL_STAGE/"
  cp -R "$ROLLBACK_SOURCE_RUNTIME/." "$RUNTIME_STAGE/"
else
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
fi

NODE_EXE=$(find "$RUNTIME_STAGE" -type f -path "*/bin/node" | sort | sed -n '1p')
[ -n "$NODE_EXE" ] || fail "bundled node executable not found under $RUNTIME_STAGE"
if [ "$ROLLBACK_MODE" != "1" ]; then chmod +x "$NODE_EXE" || true; fi
NODE_TOP_DIRECTORY=$(basename -- "$(dirname -- "$(dirname -- "$NODE_EXE")")")
if [ "$ROLLBACK_MODE" != "1" ]; then
  remove_bundled_node_tool_links "$RUNTIME_STAGE/$NODE_TOP_DIRECTORY" "$NODE_EXE" ||
    fail "bundled Node tool links could not be normalized safely"
fi
assert_no_symlinks_in_tree "$INSTALL_STAGE" staged_install
assert_no_symlinks_in_tree "$RUNTIME_STAGE" staged_runtime
NODE_EXE_FINAL="$RUNTIME_ROOT/$NODE_TOP_DIRECTORY/bin/node"

if [ "$ROLLBACK_MODE" != "1" ]; then
{
  printf 'INSTALL_ROOT=%s\n' "$(quote_sh "$INSTALL_ROOT")"
  printf 'DATA_ROOT=%s\n' "$(quote_sh "$DATA_ROOT")"
  printf 'STATE_ROOT=%s\n' "$(quote_sh "$DATA_ROOT/data")"
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
DATA_SCHEMA_VERSION_VALUE="$PACKAGE_DATA_SCHEMA_VERSION" \
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
  "DATA_SCHEMA_VERSION_VALUE",
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
  data_schema_version: Number(process.env.DATA_SCHEMA_VERSION_VALUE),
  control_center_url: process.env.CONTROL_CENTER_URL_VALUE,
  platform: process.env.PLATFORM_VALUE,
  user_requires_node_pnpm_git: false,
  autostart_enabled_by_default: false,
};
for (const key of keys) if (!process.env[key]) throw new Error(`${key} missing`);
if (!Number.isSafeInteger(data.data_schema_version) || data.data_schema_version < 1 || data.data_schema_version > 2147483647) {
  throw new Error("product data-schema version is invalid");
}
fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
' "$INSTALL_JSON_STAGE"

cat > "$STAGE_BIN_WRAPPER" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$LAUNCHER")" "\$@"
EOF
chmod +x "$STAGE_BIN_WRAPPER"
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
else
  assert_managed_product_install "$INSTALL_STAGE" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_STAGE" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT"
  ACTIVE_MANIFEST="$ROLLBACK_SOURCE_APP/blue-tanuki-package-manifest.json"
  CANDIDATE_MANIFEST="$INSTALL_STAGE/blue-tanuki-package-manifest.json"
  rollback_version_relation=$(compare_manifest_versions "$ACTIVE_MANIFEST" "$CANDIDATE_MANIFEST") ||
    fail "retained rollback version could not be compared safely"
  [ "$rollback_version_relation" = "-1" ] || fail "retained rollback package is not older than the active package; no files were changed"
  ROLLBACK_TARGET_VERSION=$(manifest_value "$CANDIDATE_MANIFEST" version)
fi

assert_product_data_compatibility "$NODE_EXE" "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" \
  "$PACKAGE_DATA_SCHEMA_VERSION"
if [ "$ROLLBACK_MODE" != "1" ]; then
  write_product_data_compatibility_marker "$NODE_EXE" "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" \
    "$PACKAGE_DATA_SCHEMA_VERSION" "$INSTALL_MANAGED_FILES_SHA256" "$RUNTIME_MANAGED_FILES_SHA256"
fi

if { [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; } && { [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; }; then
  fail "Existing config path is not a regular file: $ENV_FILE"
fi
if [ "$UPDATE_MODE" = "1" ]; then
  CANDIDATE_VERSION=$(manifest_value "$PACKAGE_MANIFEST" version)
  update_version_relation=$(compare_manifest_versions "$ACTIVE_MANIFEST" "$PACKAGE_MANIFEST") ||
    fail "packaged update version could not be compared safely"
  [ "$update_version_relation" = "1" ] ||
    fail "manual update requires a strictly newer semantic version; no files were changed"
elif [ "$ROLLBACK_MODE" = "1" ]; then
  CANDIDATE_VERSION=$ROLLBACK_TARGET_VERSION
else
  CANDIDATE_VERSION=$(manifest_value "$PACKAGE_MANIFEST" version)
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

if [ -f "$ENV_FILE_STAGE" ]; then chmod 600 "$ENV_FILE_STAGE"; fi

UPDATE_ROLLBACK_APP="$INSTALL_PARENT/.$INSTALL_NAME.blue-tanuki-rollback-$STAGE_SUFFIX"
UPDATE_ROLLBACK_RUNTIME="$RUNTIME_PARENT/.$RUNTIME_NAME.blue-tanuki-rollback-$STAGE_SUFFIX"
if [ "$UPDATE_MODE" = "1" ] || [ "$ROLLBACK_MODE" = "1" ]; then
  [ ! -e "$UPDATE_ROLLBACK_APP" ] && [ ! -L "$UPDATE_ROLLBACK_APP" ] || fail "update rollback application path already exists; no files were changed"
  [ ! -e "$UPDATE_ROLLBACK_RUNTIME" ] && [ ! -L "$UPDATE_ROLLBACK_RUNTIME" ] || fail "update rollback runtime path already exists; no files were changed"
  if ! BLUE_TANUKI_RECOVERY=1 sh "$LAUNCHER" resident-stop >/dev/null 2>&1; then
    fail "resident shutdown could not be confirmed before update/rollback; all installed files and user data were preserved"
  fi
  assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"
  [ "$(sha256_file "$ACTIVE_MANIFEST")" = "$ACTIVE_MANIFEST_SHA256" ] ||
    fail "the installed package changed during update/rollback preparation; no candidate files were applied"
  [ "$(sha256_file "$ENV_FILE")" = "$UPDATE_ENV_SHA256" ] ||
    fail "the product configuration changed during update/rollback preparation; no candidate files were applied"
  if [ "$ROLLBACK_MODE" = "1" ]; then
    assert_managed_product_install "$ROLLBACK_SOURCE_APP" "$DATA_ROOT" "$CONFIG_ROOT" "$ROLLBACK_SOURCE_RUNTIME" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE" "$INSTALL_ROOT" "$RUNTIME_ROOT"
  else
    read_previous_pointer
    if [ -n "$PREVIOUS_SUFFIX" ]; then
      prior_suffix=$PREVIOUS_SUFFIX
      [ "$prior_suffix" != "$STAGE_SUFFIX" ] || fail "rollback generation collided with the existing retained version"
      rm -f -- "$ROLLBACK_POINTER" || fail "the old rollback reference could not be retired; no application files were changed"
      [ ! -e "$ROLLBACK_POINTER" ] && [ ! -L "$ROLLBACK_POINTER" ] || fail "the old rollback reference remained; no application files were changed"
      retire_previous_pair "$prior_suffix"
    fi
  fi
  mv -- "$INSTALL_ROOT" "$UPDATE_ROLLBACK_APP" || fail "the verified active application could not be staged for rollback; no user data was changed"
  mv -- "$RUNTIME_ROOT" "$UPDATE_ROLLBACK_RUNTIME" || fail "the verified active runtime could not be staged for rollback; preserve both paths for recovery"
fi

mv -- "$INSTALL_STAGE" "$INSTALL_ROOT"
NEW_APP_MOVED=1
INSTALL_STAGE_CREATED=0
INSTALL_STAGE_ID=
mv -- "$RUNTIME_STAGE" "$RUNTIME_ROOT"
NEW_RUNTIME_MOVED=1
RUNTIME_STAGE_CREATED=0
RUNTIME_STAGE_ID=
assert_managed_product_install "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$RUNTIME_ROOT" "$BIN_ROOT" "$PLATFORM" "$SURFACE_FILE"

if [ -f "$ENV_FILE_STAGE" ]; then
  if [ -f "$ENV_FILE" ]; then
    mv -- "$ENV_FILE" "$ENV_FILE_BACKUP"
    ENV_FILE_BACKED_UP=1
  fi
  mv -- "$ENV_FILE_STAGE" "$ENV_FILE"
  ENV_FILE_INSTALLED=1
fi

write_managed_external_file "$BIN_LAUNCHER" BIN_LAUNCHER 700 render_managed_unix_launcher_wrapper "$LAUNCHER"
if [ "$PLATFORM" = "macos" ]; then
  write_managed_external_file "$SURFACE_FILE" macOS_application_command 700 render_managed_macos_application_command "$BIN_LAUNCHER"
else
  write_managed_linux_desktop_entry "$SURFACE_FILE" 644 "$BIN_LAUNCHER"
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

if [ "$UPDATE_MODE" = "1" ] || [ "$ROLLBACK_MODE" = "1" ]; then
  write_previous_pointer "$STAGE_SUFFIX"
  NEW_APP_MOVED=0
  NEW_RUNTIME_MOVED=0
  if [ "$ROLLBACK_MODE" = "1" ] && [ "$ROLLBACK_SOURCE_SUFFIX" != "$STAGE_SUFFIX" ]; then
    if (retire_previous_pair "$ROLLBACK_SOURCE_SUFFIX"); then
      :
    else
      echo "warning: rollback completed; the consumed previous package could not be retired and is preserved for inspection: $ROLLBACK_SOURCE_APP" >&2
    fi
  fi
fi

echo ""
if [ "$UPDATE_MODE" = "1" ]; then
  echo "BLUE-TANUKI ${PLATFORM_LABEL} updated to $CANDIDATE_VERSION."
  echo "Previous version retained at: $UPDATE_ROLLBACK_APP"
elif [ "$ROLLBACK_MODE" = "1" ]; then
  echo "BLUE-TANUKI ${PLATFORM_LABEL} rolled back to $CANDIDATE_VERSION."
  echo "The previous active version is retained for a future rollback."
else
  echo "BLUE-TANUKI ${PLATFORM_LABEL} installed."
fi
echo "Launcher: $BIN_LAUNCHER"
echo "Env file:  $ENV_FILE"
echo "Control:   $CONTROL_CENTER_URL"
echo "Autostart: not enabled by installer"
echo "user_requires_node_pnpm_git=false"
echo "install_result=pass"

if [ "$LAUNCH_AFTER_INSTALL" != "0" ]; then
  "$BIN_LAUNCHER" launch || echo "warning: product installed but launch failed; run $BIN_LAUNCHER launch to retry." >&2
fi
