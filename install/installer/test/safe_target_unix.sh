set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
# shellcheck disable=SC1091
. "$REPO_ROOT/install/unix/safe-target.sh"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/blue-tanuki-safe-target.XXXXXX")
LIFECYCLE_GATEWAY_PID=
LIFECYCLE_WATCHDOG_PID=
LIFECYCLE_UNRELATED_PID=
cleanup_tmp_root() {
  for process_id in "$LIFECYCLE_GATEWAY_PID" "$LIFECYCLE_WATCHDOG_PID" "$LIFECYCLE_UNRELATED_PID"; do
    case "$process_id" in ''|*[!0-9]*) continue ;; esac
    kill -TERM "$process_id" 2>/dev/null || true
  done
  rm -rf -- "$TMP_ROOT"
}
trap cleanup_tmp_root EXIT HUP INT TERM
mkdir -p "$TMP_ROOT/physical" "$TMP_ROOT/home/.local" "$TMP_ROOT/home2/.local/bin" "$TMP_ROOT/bin-physical"
ln -s "$TMP_ROOT/physical" "$TMP_ROOT/physical-alias"
ln -s "$TMP_ROOT/home" "$TMP_ROOT/home-alias"
ln -s "$TMP_ROOT/bin-physical" "$TMP_ROOT/home/.local/bin"
HOME="$TMP_ROOT/home"
export HOME

resolved=$(canonical_target_path "$TMP_ROOT/physical-alias/not-created/app" fixture)
[ "$resolved" = "$TMP_ROOT/physical/not-created/app" ] || {
  echo "unexpected canonical target: $resolved" >&2
  exit 10
}

expect_rejection() {
  label=$1
  shift
  if ("$@" >/dev/null 2>&1); then
    echo "$label was accepted" >&2
    exit 11
  fi
}

MANAGED_EXTERNAL_ROOT="$TMP_ROOT/managed-external-files"
mkdir -p "$MANAGED_EXTERNAL_ROOT"
MANAGED_EXTERNAL_FILE="$MANAGED_EXTERNAL_ROOT/launcher"
write_managed_external_file "$MANAGED_EXTERNAL_FILE" fixture_launcher 700 \
  render_managed_unix_launcher_wrapper "$TMP_ROOT/managed-launcher"
is_managed_unix_launcher_wrapper "$MANAGED_EXTERNAL_FILE" "$TMP_ROOT/managed-launcher" || exit 116
printf '\nuser-owned line\n' >> "$MANAGED_EXTERNAL_FILE"
cp "$MANAGED_EXTERNAL_FILE" "$TMP_ROOT/managed-external-backup"
if (write_managed_external_file "$MANAGED_EXTERNAL_FILE" fixture_launcher 700 \
  render_managed_unix_launcher_wrapper "$TMP_ROOT/managed-launcher") > "$TMP_ROOT/managed-external-reject.out" 2>&1; then
  echo "managed external writer replaced a modified target" >&2
  exit 117
fi
cmp -s "$MANAGED_EXTERNAL_FILE" "$TMP_ROOT/managed-external-backup" || exit 118

XML_SPECIAL_ROOT="$TMP_ROOT/Blue & Tanuki <owner> \"quotes\" 'apostrophe'"
render_managed_macos_autostart_entry \
  "$XML_SPECIAL_ROOT" "$XML_SPECIAL_ROOT/out&log" "$XML_SPECIAL_ROOT/err<log" > "$TMP_ROOT/macos-plist-escaped.xml"
grep -Fq 'Blue &amp; Tanuki &lt;owner&gt; &quot;quotes&quot; &apos;apostrophe&apos;' "$TMP_ROOT/macos-plist-escaped.xml" || exit 119
grep -Fq 'out&amp;log' "$TMP_ROOT/macos-plist-escaped.xml" || exit 120
grep -Fq 'err&lt;log' "$TMP_ROOT/macos-plist-escaped.xml" || exit 121

# root 直下の既存・未生成対象も一つの slash で表し、HOME の祖先を拒否する。
PHYSICAL_TMP_ROOT=$(CDPATH= cd -P -- "$TMP_ROOT" && pwd -P)
TOP_COMPONENT=${PHYSICAL_TMP_ROOT#/}
TOP_LEVEL_TARGET=/${TOP_COMPONENT%%/*}
[ "$TOP_LEVEL_TARGET" != "/" ] || exit 18
resolved=$(canonical_target_path "$TOP_LEVEL_TARGET" root-child)
[ "$resolved" = "$TOP_LEVEL_TARGET" ] || {
  echo "root child changed identity: $resolved" >&2
  exit 19
}
MISSING_TOP_LEVEL="/$(basename -- "$TMP_ROOT")-not-created"
[ ! -e "$MISSING_TOP_LEVEL" ] && [ ! -L "$MISSING_TOP_LEVEL" ] || exit 20
resolved=$(canonical_target_path "$MISSING_TOP_LEVEL" missing-root-child)
[ "$resolved" = "$MISSING_TOP_LEVEL" ] || exit 21
[ ! -e "$MISSING_TOP_LEVEL" ] && [ ! -L "$MISSING_TOP_LEVEL" ] || exit 22
expect_rejection "root-level home ancestor" safe_destructive_target "$TOP_LEVEL_TARGET" home-parent
expect_rejection "root-level data container" safe_container_target "$TOP_LEVEL_TARGET" data-parent
expect_rejection "root-level user bin" safe_user_bin_target "$TOP_LEVEL_TARGET" bin-parent

expect_rejection "home alias" safe_destructive_target "$TMP_ROOT/home-alias/.local" alias
expect_rejection "physical user-bin alias" safe_destructive_target "$TMP_ROOT/bin-physical" user-bin-alias
expect_rejection "data root aliases user bin" safe_container_target "$TMP_ROOT/bin-physical" data-root-bin-alias
expect_rejection "double slash" safe_destructive_target "$TMP_ROOT//double-slash" double-slash
expect_rejection "relative traversal" safe_destructive_target "$TMP_ROOT/../outside" traversal
expect_rejection "filesystem root" safe_destructive_target "/" root

expect_entrypoint_rejection() {
  label=$1
  script=$2
  shift 2
  if (
    HOME="$TMP_ROOT/home" \
    INSTALL_ROOT="$TMP_ROOT/home" \
    DATA_ROOT="$TMP_ROOT/data" \
    CONFIG_ROOT="$TMP_ROOT/config" \
    RUNTIME_ROOT="$TMP_ROOT/runtime" \
    BIN_ROOT="$TMP_ROOT/bin" \
    sh "$script" "$@" >/dev/null 2>&1
  ); then
    echo "$label accepted a broad install root" >&2
    exit 12
  fi
}

expect_entrypoint_rejection "Linux source installer" "$REPO_ROOT/install/linux/install.sh"
expect_entrypoint_rejection "macOS source installer" "$REPO_ROOT/install/macos/install.sh"
expect_entrypoint_rejection "Linux uninstaller" "$REPO_ROOT/install/linux/uninstall.sh"
expect_entrypoint_rejection "macOS uninstaller" "$REPO_ROOT/install/macos/uninstall.sh"
expect_entrypoint_rejection "product installer" "$REPO_ROOT/install/unix/product/BlueTanukiSetup.sh" --no-launch
expect_entrypoint_rejection "product uninstaller" "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" --dry-run

expect_bin_overlap_rejection() {
  label=$1
  script=$2
  shift 2
  if (
    HOME="$TMP_ROOT/home2" \
    INSTALL_ROOT="$TMP_ROOT/home2/.local/share/blue-tanuki/app" \
    DATA_ROOT="$TMP_ROOT/home2/.local/bin/app-data" \
    CONFIG_ROOT="$TMP_ROOT/home2/.config/blue-tanuki" \
    RUNTIME_ROOT="$TMP_ROOT/home2/.local/bin/app-data/runtime" \
    BIN_ROOT="$TMP_ROOT/home2/.local/bin" \
    sh "$script" "$@" >/dev/null 2>&1
  ); then
    echo "$label accepted data/bin overlap" >&2
    exit 13
  fi
}

expect_bin_overlap_rejection "Linux source installer" "$REPO_ROOT/install/linux/install.sh"
expect_bin_overlap_rejection "macOS source installer" "$REPO_ROOT/install/macos/install.sh"
expect_bin_overlap_rejection "Linux uninstaller" "$REPO_ROOT/install/linux/uninstall.sh"
expect_bin_overlap_rejection "macOS uninstaller" "$REPO_ROOT/install/macos/uninstall.sh"
expect_bin_overlap_rejection "product installer" "$REPO_ROOT/install/unix/product/BlueTanukiSetup.sh" --no-launch
expect_bin_overlap_rejection "product uninstaller" "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" --dry-run

SAFE_HOME="$TMP_ROOT/safe-home"
mkdir -p "$SAFE_HOME/data/app" "$SAFE_HOME/data/runtime" "$SAFE_HOME/config" "$SAFE_HOME/bin"
printf 'fixture\n' > "$SAFE_HOME/data/app/keep.txt"
printf 'fixture\n' > "$SAFE_HOME/data/runtime/keep.txt"
printf 'fixture\n' > "$SAFE_HOME/bin/blue-tanuki"
printf '#!/usr/bin/env sh\nexit 0\n' > "$SAFE_HOME/data/app/BlueTanukiLauncher.sh"

run_dry_uninstall() {
  label=$1
  script=$2
  platform=$3
  output="$TMP_ROOT/$label.out"
  if ! (
    HOME="$SAFE_HOME" \
    INSTALL_ROOT="$SAFE_HOME/data/app" \
    DATA_ROOT="$SAFE_HOME/data" \
    CONFIG_ROOT="$SAFE_HOME/config" \
    RUNTIME_ROOT="$SAFE_HOME/data/runtime" \
    BIN_ROOT="$SAFE_HOME/bin" \
    PURGE=1 \
    DRY_RUN=1 \
    PLATFORM="$platform" \
    sh "$script" --dry-run --purge
  ) > "$output" 2>&1; then
    cat "$output" >&2
    echo "$label safe dry-run failed" >&2
    exit 14
  fi
  [ -d "$SAFE_HOME/data/app" ] && [ -f "$SAFE_HOME/data/app/keep.txt" ] || exit 15
  [ -d "$SAFE_HOME/data/runtime" ] && [ -f "$SAFE_HOME/data/runtime/keep.txt" ] || exit 16
  [ -d "$SAFE_HOME/config" ] && [ -f "$SAFE_HOME/bin/blue-tanuki" ] || exit 17
}

run_dry_uninstall "linux-uninstall" "$REPO_ROOT/install/linux/uninstall.sh" linux
run_dry_uninstall "macos-uninstall" "$REPO_ROOT/install/macos/uninstall.sh" macos

PRODUCT_HOME="$TMP_ROOT/product-home"
PRODUCT_INSTALL="$PRODUCT_HOME/.local/share/blue-tanuki/app"
PRODUCT_DATA="$PRODUCT_HOME/.local/share/blue-tanuki"
PRODUCT_CONFIG="$PRODUCT_HOME/.config/blue-tanuki"
PRODUCT_RUNTIME="$PRODUCT_DATA/runtime"
PRODUCT_BIN="$PRODUCT_HOME/.local/bin"
PRODUCT_SURFACE="$PRODUCT_HOME/.local/share/applications/blue-tanuki.desktop"
mkdir -p "$PRODUCT_INSTALL/apps/gateway/dist" "$PRODUCT_INSTALL/install/unix" \
  "$PRODUCT_RUNTIME/node-v-test/bin" "$PRODUCT_CONFIG" "$PRODUCT_BIN" \
  "$(dirname -- "$PRODUCT_SURFACE")"
for product_file in \
  "$PRODUCT_INSTALL/apps/gateway/dist/main.js" \
  "$PRODUCT_INSTALL/blue-tanuki-install.json" \
  "$PRODUCT_INSTALL/blue-tanuki-install.env" \
  "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" \
  "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" \
  "$PRODUCT_INSTALL/BlueTanuki.sh"
do
  printf 'fixture\n' > "$product_file"
done
cp "$REPO_ROOT/install/unix/safe-target.sh" "$PRODUCT_INSTALL/install/unix/safe-target.sh"
cp "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" "$PRODUCT_INSTALL/BlueTanukiUninstall.sh"
cp "$REPO_ROOT/install/unix/product/BlueTanukiLauncher.sh" "$PRODUCT_INSTALL/BlueTanukiLauncher.sh"
printf '#!/usr/bin/env sh\nexit 0\n' > "$PRODUCT_RUNTIME/node-v-test/bin/node"
chmod +x "$PRODUCT_RUNTIME/node-v-test/bin/node"
cat > "$PRODUCT_INSTALL/blue-tanuki-install.env" <<ENV
INSTALL_ROOT='$PRODUCT_INSTALL'
DATA_ROOT='$PRODUCT_DATA'
ENV_FILE='$PRODUCT_CONFIG/blue-tanuki.env'
NODE_EXE='$PRODUCT_RUNTIME/node-v-test/bin/node'
CONTROL_CENTER_URL='http://127.0.0.1:8787/app'
PLATFORM='linux'
ENV
cat > "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json" <<'MANIFEST'
{
  "schema_version": 2,
  "name": "blue-tanuki",
  "version": "1.0.0-rc.1",
  "package_type": "linux-x64-tar-installer",
  "created_at": "2026-11-10T00:00:00.000Z"
}
MANIFEST
PRODUCT_MANIFEST_SHA256=$(sha256_file "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json")
cat > "$PRODUCT_INSTALL/blue-tanuki-install.json" <<METADATA
{
  "schema_version": 3,
  "product_id": "blue-tanuki-product-install",
  "package_manifest_sha256": "$PRODUCT_MANIFEST_SHA256",
  "install_root": "$PRODUCT_INSTALL",
  "data_root": "$PRODUCT_DATA",
  "config_root": "$PRODUCT_CONFIG",
  "runtime_root": "$PRODUCT_RUNTIME",
  "bin_root": "$PRODUCT_BIN",
  "env_file": "$PRODUCT_CONFIG/blue-tanuki.env",
  "node_exe": "$PRODUCT_RUNTIME/node-v-test/bin/node",
  "control_center_url": "http://127.0.0.1:8787/app",
  "platform": "linux"
}
METADATA
printf '#!/usr/bin/env sh\nexec "%s/BlueTanukiLauncher.sh" "$@"\n' "$PRODUCT_INSTALL" > "$PRODUCT_BIN/blue-tanuki"
printf '[Desktop Entry]\nType=Application\nName=BLUE-TANUKI\nExec=%s/blue-tanuki launch\n' "$PRODUCT_BIN" > "$PRODUCT_SURFACE"
write_product_owner_marker "$PRODUCT_INSTALL/.blue-tanuki-owner" install "$PRODUCT_INSTALL" "$PRODUCT_DATA" "$PRODUCT_CONFIG" "$PRODUCT_RUNTIME" "$PRODUCT_BIN" linux "$PRODUCT_SURFACE"
write_product_owner_marker "$PRODUCT_DATA/.blue-tanuki-owner" data "$PRODUCT_INSTALL" "$PRODUCT_DATA" "$PRODUCT_CONFIG" "$PRODUCT_RUNTIME" "$PRODUCT_BIN" linux "$PRODUCT_SURFACE"
write_product_owner_marker "$PRODUCT_CONFIG/.blue-tanuki-owner" config "$PRODUCT_INSTALL" "$PRODUCT_DATA" "$PRODUCT_CONFIG" "$PRODUCT_RUNTIME" "$PRODUCT_BIN" linux "$PRODUCT_SURFACE"
PRODUCT_INSTALL_INVENTORY=$(write_managed_tree_inventory "$PRODUCT_INSTALL" blue-tanuki-install.json blue-tanuki-managed-files.txt blue-tanuki-product-install)
PRODUCT_RUNTIME_INVENTORY=$(write_managed_tree_inventory "$PRODUCT_RUNTIME" __no_metadata__ blue-tanuki-runtime-files.txt blue-tanuki-product-runtime)
cat > "$PRODUCT_INSTALL/blue-tanuki-install.json" <<METADATA
{
  "schema_version": 3,
  "product_id": "blue-tanuki-product-install",
  "package_manifest_sha256": "$PRODUCT_MANIFEST_SHA256",
  "managed_install_files_sha256": "$PRODUCT_INSTALL_INVENTORY",
  "managed_runtime_files_sha256": "$PRODUCT_RUNTIME_INVENTORY",
  "install_root": "$PRODUCT_INSTALL",
  "data_root": "$PRODUCT_DATA",
  "config_root": "$PRODUCT_CONFIG",
  "runtime_root": "$PRODUCT_RUNTIME",
  "bin_root": "$PRODUCT_BIN",
  "env_file": "$PRODUCT_CONFIG/blue-tanuki.env",
  "node_exe": "$PRODUCT_RUNTIME/node-v-test/bin/node",
  "control_center_url": "http://127.0.0.1:8787/app",
  "platform": "linux"
}
METADATA

if ! (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  DRY_RUN=1 \
  PURGE=1 \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run --purge
) > "$TMP_ROOT/product-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/product-uninstall.out" >&2
  echo "product uninstall safe dry-run failed" >&2
  exit 23
fi
grep -Fq "Would remove app: $PRODUCT_INSTALL" "$TMP_ROOT/product-uninstall.out" || exit 24
[ -f "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" ] && [ -f "$PRODUCT_RUNTIME/node-v-test/bin/node" ] || exit 25
[ -f "$PRODUCT_DATA/.blue-tanuki-owner" ] && [ -f "$PRODUCT_CONFIG/.blue-tanuki-owner" ] || exit 26

PRODUCT_AUTOSTART_DIR="$PRODUCT_HOME/.config/autostart"
PRODUCT_AUTOSTART="$PRODUCT_AUTOSTART_DIR/blue-tanuki.desktop"
mkdir -p "$PRODUCT_AUTOSTART_DIR"
cat > "$PRODUCT_AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=User-owned entry
Exec=$PRODUCT_INSTALL/BlueTanukiLauncher.sh resident-start
EOF
cp "$PRODUCT_AUTOSTART" "$TMP_ROOT/autostart-unowned.backup"
if (
  HOME="$PRODUCT_HOME" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-enable
) > "$TMP_ROOT/autostart-unowned-enable.out" 2>&1; then
  echo "autostart enable overwrote an unrelated entry with a matching Exec line" >&2
  exit 90
fi
cmp -s "$PRODUCT_AUTOSTART" "$TMP_ROOT/autostart-unowned.backup" || exit 91
grep -Fq "it was preserved" "$TMP_ROOT/autostart-unowned-enable.out" || exit 92
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-disable > "$TMP_ROOT/autostart-unowned-disable.out"
cmp -s "$PRODUCT_AUTOSTART" "$TMP_ROOT/autostart-unowned.backup" || exit 93
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/autostart-unowned-disable.out" || exit 94
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-status > "$TMP_ROOT/autostart-unowned-status.out"
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/autostart-unowned-status.out" || exit 95
if ! (
  HOME="$PRODUCT_HOME" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/autostart-unowned-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/autostart-unowned-uninstall.out" >&2
  exit 96
fi
grep -Fq "Preserved unrelated autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/autostart-unowned-uninstall.out" || exit 97

rm -f -- "$PRODUCT_AUTOSTART"
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-enable > "$TMP_ROOT/autostart-owned-enable.out"
. "$REPO_ROOT/install/unix/safe-target.sh"
is_managed_linux_autostart_entry "$PRODUCT_AUTOSTART" "$PRODUCT_INSTALL" || exit 98
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-status > "$TMP_ROOT/autostart-owned-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/autostart-owned-status.out" || exit 99
if ! (
  HOME="$PRODUCT_HOME" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/autostart-owned-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/autostart-owned-uninstall.out" >&2
  exit 100
fi
grep -Fq "Would remove managed autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/autostart-owned-uninstall.out" || exit 101
printf '\n# locally modified\n' >> "$PRODUCT_AUTOSTART"
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-disable > "$TMP_ROOT/autostart-modified-disable.out"
[ -f "$PRODUCT_AUTOSTART" ] || exit 102
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/autostart-modified-disable.out" || exit 103
if ! (
  HOME="$PRODUCT_HOME" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/autostart-modified-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/autostart-modified-uninstall.out" >&2
  exit 104
fi
grep -Fq "Preserved unrelated autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/autostart-modified-uninstall.out" || exit 105
rm -f -- "$PRODUCT_AUTOSTART"
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-enable > "$TMP_ROOT/autostart-disable-enable.out"
HOME="$PRODUCT_HOME" XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-disable > "$TMP_ROOT/autostart-owned-disable.out"
[ ! -e "$PRODUCT_AUTOSTART" ] && [ ! -L "$PRODUCT_AUTOSTART" ] || exit 106
grep -Fq 'autostart_status=disabled' "$TMP_ROOT/autostart-owned-disable.out" || exit 107
if [ "${BLUE_TANUKI_TEST_AUTOSTART_ONLY:-0}" = 1 ]; then
  echo "product_autostart_ownership=pass"
  exit 0
fi

PRODUCT_OWNER_MARKER="$PRODUCT_INSTALL/.blue-tanuki-owner"
cp "$PRODUCT_OWNER_MARKER" "$TMP_ROOT/product-owner-marker.backup"
sed "s|^install_root=.*|install_root=$PRODUCT_HOME/mismatched-app|" "$TMP_ROOT/product-owner-marker.backup" > "$PRODUCT_OWNER_MARKER"
if (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --purge
) > "$TMP_ROOT/product-uninstall-scope-mismatch.out" 2>&1; then
  echo "product uninstall accepted a mismatched install ownership scope" >&2
  exit 69
fi
grep -Eiq "ownership marker|does not match|install root" "$TMP_ROOT/product-uninstall-scope-mismatch.out" || exit 70
mv -- "$TMP_ROOT/product-owner-marker.backup" "$PRODUCT_OWNER_MARKER"
[ -f "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" ] && [ -f "$PRODUCT_RUNTIME/node-v-test/bin/node" ] || exit 71
[ -f "$PRODUCT_DATA/.blue-tanuki-owner" ] && [ -f "$PRODUCT_CONFIG/.blue-tanuki-owner" ] || exit 72

printf 'unrelated user file\n' > "$PRODUCT_INSTALL/user-added.txt"
if (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run >/dev/null 2>&1
); then
  echo "product uninstall accepted an unlisted user file" >&2
  exit 52
fi
[ -f "$PRODUCT_INSTALL/user-added.txt" ] || exit 53
rm -f -- "$PRODUCT_INSTALL/user-added.txt"
printf 'runtime user file\n' > "$PRODUCT_RUNTIME/user-added.txt"
if (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run >/dev/null 2>&1
); then
  echo "product uninstall accepted an unlisted runtime file" >&2
  exit 54
fi
[ -f "$PRODUCT_RUNTIME/user-added.txt" ] || exit 55
rm -f -- "$PRODUCT_RUNTIME/user-added.txt"
cp "$PRODUCT_INSTALL/apps/gateway/dist/main.js" "$TMP_ROOT/main-js.backup"
printf 'tampered\n' >> "$PRODUCT_INSTALL/apps/gateway/dist/main.js"
if (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run >/dev/null 2>&1
); then
  echo "product uninstall accepted a changed managed app file" >&2
  exit 56
fi
mv -- "$TMP_ROOT/main-js.backup" "$PRODUCT_INSTALL/apps/gateway/dist/main.js"
printf 'tampered\n' >> "$PRODUCT_RUNTIME/node-v-test/bin/node"
if (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run >/dev/null 2>&1
); then
  echo "product uninstall accepted a changed bundled runtime file" >&2
  exit 57
fi
sed '$d' "$PRODUCT_RUNTIME/node-v-test/bin/node" > "$TMP_ROOT/node.backup"
cat "$TMP_ROOT/node.backup" > "$PRODUCT_RUNTIME/node-v-test/bin/node"
chmod +x "$PRODUCT_RUNTIME/node-v-test/bin/node"
cp "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json" "$TMP_ROOT/package-manifest.backup"
printf 'tampered\n' >> "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json"
if (
  HOME="$PRODUCT_HOME" \
  XDG_DATA_HOME="$PRODUCT_HOME/.local/share" \
  XDG_CONFIG_HOME="$PRODUCT_HOME/.config" \
  sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run >/dev/null 2>&1
); then
  echo "product uninstall accepted a package manifest digest mismatch" >&2
  exit 48
fi
mv -- "$TMP_ROOT/package-manifest.backup" "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json"
[ -f "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" ] || exit 49

FOREIGN_ROOT="$PRODUCT_HOME/foreign-app"
mkdir -p "$FOREIGN_ROOT/install/unix"
cp "$REPO_ROOT/install/unix/safe-target.sh" "$FOREIGN_ROOT/install/unix/safe-target.sh"
cp "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" "$FOREIGN_ROOT/BlueTanukiUninstall.sh"
printf 'owner data must stay\n' > "$FOREIGN_ROOT/keep.txt"
if (
  HOME="$PRODUCT_HOME" \
  sh "$FOREIGN_ROOT/BlueTanukiUninstall.sh" --purge >/dev/null 2>&1
); then
  echo "product uninstall accepted an unowned target" >&2
  exit 27
fi
[ -f "$FOREIGN_ROOT/keep.txt" ] || exit 28

SETUP_PACKAGE="$TMP_ROOT/product-setup-package"
SETUP_HOME="$TMP_ROOT/product-setup-home"
SETUP_INSTALL="$SETUP_HOME/.local/share/blue-tanuki/app"
SETUP_DATA="$SETUP_HOME/.local/share/blue-tanuki"
SETUP_CONFIG="$SETUP_HOME/.config/blue-tanuki"
SETUP_RUNTIME="$SETUP_DATA/runtime"
SETUP_BIN="$SETUP_HOME/.local/bin"
SETUP_SURFACE="$SETUP_HOME/.local/share/applications/blue-tanuki.desktop"
FAKE_RUNTIME_SOURCE="$TMP_ROOT/fake-runtime/node-v-test-linux-x64"
mkdir -p "$SETUP_PACKAGE/app/apps/gateway/dist" "$SETUP_PACKAGE/app/install/unix" \
  "$SETUP_PACKAGE/runtime" "$SETUP_PACKAGE/launcher" "$FAKE_RUNTIME_SOURCE/bin" \
  "$SETUP_HOME/.local/bin" "$SETUP_HOME/.config/other-app"
printf 'unrelated executable\n' > "$SETUP_HOME/.local/bin/keep-cli"
cp "$REPO_ROOT/install/unix/safe-target.sh" "$SETUP_PACKAGE/safe-target.sh"
cp "$REPO_ROOT/install/unix/safe-target.sh" "$SETUP_PACKAGE/app/install/unix/safe-target.sh"
cp "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" "$SETUP_PACKAGE/launcher/BlueTanukiUninstall.sh"
cat > "$SETUP_PACKAGE/launcher/BlueTanukiLauncher.sh" <<'LAUNCHER'
#!/usr/bin/env sh
if [ "${1:-}" = "resident-stop" ] && [ "${BLUE_TANUKI_RECOVERY:-0}" = "1" ] && [ -n "${RECOVERY_STOP_FAILURE_FILE:-}" ] && [ -f "$RECOVERY_STOP_FAILURE_FILE" ]; then
  echo "fixture recovery stop failure" >&2
  exit 8
fi
if [ "${1:-}" = "resident-stop" ] && [ -n "${STOP_FAILURE_FILE:-}" ] && [ -f "$STOP_FAILURE_FILE" ]; then
  [ "${BLUE_TANUKI_RECOVERY:-0}" = "1" ] && exit 0
  echo "fixture stop failure" >&2
  exit 9
fi
exit 0
LAUNCHER
printf 'fixture package\n' > "$SETUP_PACKAGE/unix-installer-manifest.json"
printf '{"name":"blue-tanuki"}\n' > "$SETUP_PACKAGE/app/package.json"
printf 'main fixture\n' > "$SETUP_PACKAGE/app/apps/gateway/dist/main.js"
printf 'v1\n' > "$SETUP_PACKAGE/app/apps/gateway/dist/version.txt"
cat > "$FAKE_RUNTIME_SOURCE/bin/node" <<'NODE'
#!/usr/bin/env sh
set -eu
if [ "${1:-}" = "-e" ]; then
  shift
  javascript=$1
  shift
  if [ -n "${PACKAGE_MANIFEST_SHA256_VALUE:-}" ]; then
    printf '{\n  "schema_version": 2,\n  "product_id": "blue-tanuki-product-install",\n  "package_manifest_sha256": "%s",\n  "install_root": "%s",\n  "data_root": "%s",\n  "config_root": "%s",\n  "runtime_root": "%s",\n  "bin_root": "%s",\n  "env_file": "%s",\n  "node_exe": "%s",\n  "control_center_url": "%s",\n  "platform": "%s",\n  "autostart_enabled_by_default": false\n}\n' \
      "$PACKAGE_MANIFEST_SHA256_VALUE" "$INSTALL_ROOT_VALUE" "$DATA_ROOT_VALUE" "$CONFIG_ROOT_VALUE" \
      "$RUNTIME_ROOT_VALUE" "$BIN_ROOT_VALUE" "$ENV_FILE_VALUE" "$NODE_EXE_VALUE" \
      "$CONTROL_CENTER_URL_VALUE" "$PLATFORM_VALUE" > "$1"
  elif [ -n "${INSTALL_MANAGED_FILES_SHA256_VALUE:-}" ] && [ -n "${RUNTIME_MANAGED_FILES_SHA256_VALUE:-}" ]; then
    metadata_file=$1
    metadata_tmp="$metadata_file.test-tmp.$$"
    sed 's/"schema_version": 2/"schema_version": 3/' "$metadata_file" | sed '$d' > "$metadata_tmp"
    printf '  "managed_install_files_sha256": "%s",\n  "managed_runtime_files_sha256": "%s"\n}\n' \
      "$INSTALL_MANAGED_FILES_SHA256_VALUE" "$RUNTIME_MANAGED_FILES_SHA256_VALUE" >> "$metadata_tmp"
    mv -- "$metadata_tmp" "$metadata_file"
  else
    case "$javascript" in
      *'const links = new Map(['*)
        [ -d "$1" ] || exit 42
        exit 0
        ;;
      *)
        echo "unrecognized fixture Node -e invocation" >&2
        exit 43
        ;;
    esac
  fi
  exit 0
fi
script=$1
shift
case "$*" in
  *--doctor*) exit 0 ;;
  *--setup*)
    output=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--output" ]; then shift; output=$1; fi
      shift
    done
    [ -n "$output" ] || exit 41
    printf 'fixture_env=true\n' > "$output"
    exit 0
    ;;
esac
exit 0
NODE
chmod +x "$FAKE_RUNTIME_SOURCE/bin/node"
tar -cJf "$SETUP_PACKAGE/runtime/node-v-test-linux-x64.tar.xz" -C "$TMP_ROOT/fake-runtime" node-v-test-linux-x64
SETUP_RUNTIME_SHA256=$(sha256_file "$SETUP_PACKAGE/runtime/node-v-test-linux-x64.tar.xz")
cat > "$SETUP_PACKAGE/unix-installer-manifest.json" <<MANIFEST
{
  "schema_version": 2,
  "name": "blue-tanuki",
  "version": "1.0.0-rc.1",
  "package_type": "linux-x64-tar-installer",
  "linux_runtime": {
    "distribution": "vendor-supported GNU/Linux releases using glibc",
    "architecture": "x64",
    "minimum_kernel": "4.18",
    "libc": "glibc",
    "minimum_libc": "2.28",
    "musl_supported": false,
    "installer_dependencies": ["POSIX sh and utilities", "getconf", "tar", "mktemp", "find", "ps", "awk", "sha256sum or shasum"],
    "credential_storage": "Linux Secret Service over the current-user session D-Bus is required only when persisting credentials",
    "compatibility_source": "https://github.com/nodejs/node/blob/v22.14.0/BUILDING.md"
  },
  "node_runtime": {
    "bundled": true,
    "version": "test",
    "archive": "node-v-test-linux-x64.tar.xz",
    "source": "fixture",
    "sha256": "$SETUP_RUNTIME_SHA256",
    "shasums_source": "fixture"
  }
}
MANIFEST

run_fixture_setup() {
  env HOME="$SETUP_HOME" \
    XDG_DATA_HOME="$SETUP_HOME/.local/share" \
    XDG_CONFIG_HOME="$SETUP_HOME/.config" \
    LAUNCH_AFTER_INSTALL=0 \
    sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" \
      --install-root "$SETUP_INSTALL" \
      --data-root "$SETUP_DATA" \
      --config-root "$SETUP_CONFIG" \
      --runtime-root "$SETUP_RUNTIME" \
      --bin-root "$SETUP_BIN" \
      "$@"
}
cp "$REPO_ROOT/install/unix/product/BlueTanukiSetup.sh" "$SETUP_PACKAGE/BlueTanukiSetup.sh"
printf '#!/usr/bin/env sh\nexec "%s/BlueTanukiLauncher.sh" "$@"\nuser-owned line\n' "$SETUP_INSTALL" > "$SETUP_BIN/blue-tanuki"
cp "$SETUP_BIN/blue-tanuki" "$TMP_ROOT/setup-owned-wrapper-backup"
if run_fixture_setup --no-launch --skip-doctor > "$TMP_ROOT/setup-modified-wrapper.out" 2>&1; then
  echo "product setup replaced a user wrapper containing the expected launcher line" >&2
  exit 110
fi
cmp -s "$SETUP_BIN/blue-tanuki" "$TMP_ROOT/setup-owned-wrapper-backup" || exit 111
grep -Fq 'existing data was preserved' "$TMP_ROOT/setup-modified-wrapper.out" || exit 112
rm -f -- "$SETUP_BIN/blue-tanuki"

mkdir -p "$(dirname -- "$SETUP_SURFACE")"
cat > "$SETUP_SURFACE" <<EOF
[Desktop Entry]
Type=Application
Name=BLUE-TANUKI
Comment=Launch BLUE-TANUKI Control Center
Exec=$SETUP_BIN/blue-tanuki launch
Terminal=false
Categories=Utility;
X-User-Owned=true
EOF
cp "$SETUP_SURFACE" "$TMP_ROOT/setup-owned-surface-backup"
if run_fixture_setup --no-launch --skip-doctor > "$TMP_ROOT/setup-modified-surface.out" 2>&1; then
  echo "product setup replaced a user desktop entry containing the expected Exec line" >&2
  exit 113
fi
cmp -s "$SETUP_SURFACE" "$TMP_ROOT/setup-owned-surface-backup" || exit 114
grep -Fq 'existing data was preserved' "$TMP_ROOT/setup-modified-surface.out" || exit 115
rm -f -- "$SETUP_SURFACE"

if ! run_fixture_setup --no-launch --skip-doctor > "$TMP_ROOT/setup-initial.out" 2>&1; then
  cat "$TMP_ROOT/setup-initial.out" >&2
  echo "isolated product setup failed" >&2
  exit 29
fi
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 30
[ -f "$SETUP_DATA/.blue-tanuki-owner" ] && [ -f "$SETUP_CONFIG/.blue-tanuki-owner" ] || exit 31
mkdir -p "$SETUP_DATA/data"
printf 'retain across interrupted updates\n' > "$SETUP_DATA/data/user.txt"
SETUP_USER_DATA_SHA256=$(sha256_file "$SETUP_DATA/data/user.txt")
SETUP_ENV_SHA256=$(sha256_file "$SETUP_CONFIG/blue-tanuki.env")

LEGACY_HOME="$TMP_ROOT/markerless-legacy-home"
LEGACY_INSTALL="$LEGACY_HOME/legacy-app"
LEGACY_DATA="$LEGACY_HOME/data"
LEGACY_CONFIG="$LEGACY_HOME/config"
LEGACY_RUNTIME="$LEGACY_HOME/runtime"
LEGACY_BIN="$LEGACY_HOME/bin"
mkdir -p "$LEGACY_INSTALL/apps/gateway/dist" "$LEGACY_DATA" "$LEGACY_CONFIG" "$LEGACY_RUNTIME" "$LEGACY_BIN"
printf 'legacy application\n' > "$LEGACY_INSTALL/apps/gateway/dist/main.js"
printf 'legacy user data\n' > "$LEGACY_DATA/user.txt"
mkdir -p "$LEGACY_INSTALL/install/unix"
cp "$REPO_ROOT/install/unix/safe-target.sh" "$LEGACY_INSTALL/install/unix/safe-target.sh"
cp "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" "$LEGACY_INSTALL/BlueTanukiUninstall.sh"
LEGACY_INSTALL_SHA256=$(sha256_file "$LEGACY_INSTALL/apps/gateway/dist/main.js")
LEGACY_DATA_SHA256=$(sha256_file "$LEGACY_DATA/user.txt")
if (
  HOME="$LEGACY_HOME" \
  XDG_DATA_HOME="$LEGACY_HOME/xdg-data" \
  XDG_CONFIG_HOME="$LEGACY_HOME/xdg-config" \
  sh "$LEGACY_INSTALL/BlueTanukiUninstall.sh" --purge
) > "$TMP_ROOT/uninstall-markerless.out" 2>&1; then
  echo "product uninstall accepted a markerless legacy install" >&2
  exit 57
fi
grep -Fq "Automatic migration or removal is unavailable" "$TMP_ROOT/uninstall-markerless.out" || exit 58
grep -Fq "no files were changed" "$TMP_ROOT/uninstall-markerless.out" || exit 59
if (
  env HOME="$LEGACY_HOME" \
    XDG_DATA_HOME="$LEGACY_HOME/xdg-data" \
    XDG_CONFIG_HOME="$LEGACY_HOME/xdg-config" \
    LAUNCH_AFTER_INSTALL=0 \
    sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" \
      --install-root "$LEGACY_INSTALL" \
      --data-root "$LEGACY_DATA" \
      --config-root "$LEGACY_CONFIG" \
      --runtime-root "$LEGACY_RUNTIME" \
      --bin-root "$LEGACY_BIN" \
      --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-markerless-force.out" 2>&1; then
  echo "packaged product setup migrated a markerless legacy install with --force" >&2
  exit 60
fi
grep -Fq "legacy install has no installed-file inventory" "$TMP_ROOT/setup-markerless-force.out" || exit 61
[ "$(sha256_file "$LEGACY_INSTALL/apps/gateway/dist/main.js")" = "$LEGACY_INSTALL_SHA256" ] || exit 62
[ "$(sha256_file "$LEGACY_DATA/user.txt")" = "$LEGACY_DATA_SHA256" ] || exit 63
[ ! -e "$LEGACY_INSTALL/.blue-tanuki-owner" ] || exit 64

LEGACY_SYMLINK_HOME="$TMP_ROOT/markerless-symlink-home"
LEGACY_SYMLINK_TARGET="$LEGACY_SYMLINK_HOME/legacy-target"
LEGACY_SYMLINK_INSTALL="$LEGACY_SYMLINK_HOME/legacy-link"
mkdir -p "$LEGACY_SYMLINK_TARGET/apps/gateway/dist"
printf 'symlink target must remain\n' > "$LEGACY_SYMLINK_TARGET/apps/gateway/dist/main.js"
ln -s "$LEGACY_SYMLINK_TARGET" "$LEGACY_SYMLINK_INSTALL"
if (
  env HOME="$LEGACY_SYMLINK_HOME" \
    XDG_DATA_HOME="$LEGACY_SYMLINK_HOME/xdg-data" \
    XDG_CONFIG_HOME="$LEGACY_SYMLINK_HOME/xdg-config" \
    LAUNCH_AFTER_INSTALL=0 \
    sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" \
      --install-root "$LEGACY_SYMLINK_INSTALL" \
      --data-root "$LEGACY_SYMLINK_HOME/data" \
      --config-root "$LEGACY_SYMLINK_HOME/config" \
      --runtime-root "$LEGACY_SYMLINK_HOME/runtime" \
      --bin-root "$LEGACY_SYMLINK_HOME/bin" \
      --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-markerless-symlink.out" 2>&1; then
  echo "packaged product setup accepted a markerless symlink install target" >&2
  exit 65
fi
grep -Fq "symlink" "$TMP_ROOT/setup-markerless-symlink.out" || exit 66
[ "$(cat "$LEGACY_SYMLINK_TARGET/apps/gateway/dist/main.js")" = "symlink target must remain" ] || exit 67
[ ! -e "$LEGACY_SYMLINK_HOME/data" ] && [ ! -e "$LEGACY_SYMLINK_HOME/config" ] || exit 68

cp "$SETUP_PACKAGE/unix-installer-manifest.json" "$TMP_ROOT/setup-manifest.backup"
sed "s/$SETUP_RUNTIME_SHA256/0000000000000000000000000000000000000000000000000000000000000000/" "$TMP_ROOT/setup-manifest.backup" > "$SETUP_PACKAGE/unix-installer-manifest.json"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-manifest-mismatch.out" 2>&1; then
  echo "product setup accepted a runtime manifest digest mismatch" >&2
  exit 50
fi
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 51
mv -- "$TMP_ROOT/setup-manifest.backup" "$SETUP_PACKAGE/unix-installer-manifest.json"

UNOWNED_HOME="$TMP_ROOT/unowned-setup-home"
UNOWNED_INSTALL="$UNOWNED_HOME/.local/share/blue-tanuki/app"
mkdir -p "$UNOWNED_INSTALL"
printf 'foreign installation data\n' > "$UNOWNED_INSTALL/keep.txt"
if (
  HOME="$UNOWNED_HOME" \
  XDG_DATA_HOME="$UNOWNED_HOME/.local/share" \
  XDG_CONFIG_HOME="$UNOWNED_HOME/.config" \
  LAUNCH_AFTER_INSTALL=0 \
  sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" --install-root "$UNOWNED_INSTALL" \
    --data-root "$UNOWNED_HOME/.local/share/blue-tanuki" --config-root "$UNOWNED_HOME/.config/blue-tanuki" \
    --runtime-root "$UNOWNED_HOME/.local/share/blue-tanuki/runtime" --bin-root "$UNOWNED_HOME/.local/bin" --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-unowned.out" 2>&1; then
  echo "product setup accepted an unowned existing install" >&2
  exit 47
fi
[ "$(cat "$UNOWNED_INSTALL/keep.txt")" = "foreign installation data" ] || exit 48
if run_fixture_setup --no-launch --skip-doctor > "$TMP_ROOT/setup-force-required.out" 2>&1; then
  echo "product setup replaced an existing install without --force" >&2
  exit 49
fi
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 50

printf 'v2\n' > "$SETUP_PACKAGE/app/apps/gateway/dist/version.txt"
STOP_FAILURE_FILE="$TMP_ROOT/stop-process-failure"
export STOP_FAILURE_FILE
: > "$STOP_FAILURE_FILE"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-stop-failure.out" 2>&1; then
  echo "product setup continued after resident shutdown failed" >&2
  exit 69
fi
grep -Fq "existing resident process could not be safely stopped" "$TMP_ROOT/setup-stop-failure.out" || {
  cat "$TMP_ROOT/setup-stop-failure.out" >&2
  echo "product setup did not report the resident shutdown blocker" >&2
  exit 70
}
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 71
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 72
rm -f -- "$STOP_FAILURE_FILE"

CRASH_APP_MOVE_BIN="$TMP_ROOT/crash-app-move-bin"
mkdir -p "$CRASH_APP_MOVE_BIN"
cat > "$CRASH_APP_MOVE_BIN/mv" <<'CRASH_APP_MOVE'
#!/usr/bin/env sh
case "$*" in
  *".app.blue-tanuki-rollback-"*)
    /usr/bin/mv "$@"
    kill -KILL "$PPID"
    ;;
  *) exec /usr/bin/mv "$@" ;;
esac
CRASH_APP_MOVE
chmod +x "$CRASH_APP_MOVE_BIN/mv"
if (
  PATH="$CRASH_APP_MOVE_BIN:$PATH" \
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  LAUNCH_AFTER_INSTALL=0 \
  sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" --install-root "$SETUP_INSTALL" --data-root "$SETUP_DATA" \
    --config-root "$SETUP_CONFIG" --runtime-root "$SETUP_RUNTIME" --bin-root "$SETUP_BIN" --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-crash-after-app-backup.out" 2>&1; then
  echo "product setup survived injected termination after app backup" >&2
  exit 77
fi
CRASHED_APP_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-rollback-*' -print | awk 'END { print NR + 0 }')
[ "$CRASHED_APP_COUNT" = "1" ] || exit 78
CRASHED_APP=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-rollback-*' -print | sed -n '1p')
[ "$(cat "$CRASHED_APP/apps/gateway/dist/version.txt")" = "v1" ] || exit 79
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 80
RECOVERY_STOP_FAILURE_FILE="$TMP_ROOT/recovery-stop-failure"
export RECOVERY_STOP_FAILURE_FILE
: > "$RECOVERY_STOP_FAILURE_FILE"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-recovery-stop-failure.out" 2>&1; then
  echo "setup recovered interrupted update without a confirmed resident shutdown" >&2
  exit 107
fi
grep -Fq "resident shutdown could not be confirmed before interrupted-update recovery" "$TMP_ROOT/setup-recovery-stop-failure.out" || exit 108
[ ! -e "$SETUP_INSTALL" ] && [ -d "$CRASHED_APP" ] && [ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 109
rm -f -- "$RECOVERY_STOP_FAILURE_FILE"
: > "$STOP_FAILURE_FILE"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-recover-after-app-backup.out" 2>&1; then
  echo "setup continued after injected post-recovery resident-stop failure" >&2
  exit 81
fi
grep -Fq "restored the verified previous product after an interrupted update" "$TMP_ROOT/setup-recover-after-app-backup.out" || {
  cat "$TMP_ROOT/setup-recover-after-app-backup.out" >&2
  echo "setup did not recover the app-only rollback state" >&2
  exit 82
}
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 83
[ ! -e "$CRASHED_APP" ] && [ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 84
[ "$(sha256_file "$SETUP_DATA/data/user.txt")" = "$SETUP_USER_DATA_SHA256" ] || exit 85
[ "$(sha256_file "$SETUP_CONFIG/blue-tanuki.env")" = "$SETUP_ENV_SHA256" ] || exit 86
rm -f -- "$STOP_FAILURE_FILE"

FAIL_MOVE_BIN="$TMP_ROOT/fail-move-bin"
mkdir -p "$FAIL_MOVE_BIN"
cat > "$FAIL_MOVE_BIN/mv" <<'MOVE'
#!/usr/bin/env sh
case "$*" in
  *".runtime.blue-tanuki-stage-"*) exit 96 ;;
esac
exec /usr/bin/mv "$@"
MOVE
chmod +x "$FAIL_MOVE_BIN/mv"
if (
  PATH="$FAIL_MOVE_BIN:$PATH" \
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  LAUNCH_AFTER_INSTALL=0 \
  sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" --install-root "$SETUP_INSTALL" --data-root "$SETUP_DATA" \
    --config-root "$SETUP_CONFIG" --runtime-root "$SETUP_RUNTIME" --bin-root "$SETUP_BIN" --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-rollback.out" 2>&1; then
  echo "product setup unexpectedly passed the injected runtime swap failure" >&2
  exit 32
fi
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || {
  cat "$TMP_ROOT/setup-rollback.out" >&2
  echo "failed product update did not restore the previous app" >&2
  exit 33
}
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 34

CRASH_APP_STAGE_BIN="$TMP_ROOT/crash-app-stage-bin"
mkdir -p "$CRASH_APP_STAGE_BIN"
cat > "$CRASH_APP_STAGE_BIN/mv" <<'CRASH_APP_STAGE'
#!/usr/bin/env sh
case "$*" in
  *".app.blue-tanuki-stage-"*"$CRASH_INSTALL_TARGET")
    /usr/bin/mv "$@"
    kill -KILL "$PPID"
    ;;
  *) exec /usr/bin/mv "$@" ;;
esac
CRASH_APP_STAGE
chmod +x "$CRASH_APP_STAGE_BIN/mv"
if (
  CRASH_INSTALL_TARGET="$SETUP_INSTALL" \
  PATH="$CRASH_APP_STAGE_BIN:$PATH" \
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  LAUNCH_AFTER_INSTALL=0 \
  sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" --install-root "$SETUP_INSTALL" --data-root "$SETUP_DATA" \
    --config-root "$SETUP_CONFIG" --runtime-root "$SETUP_RUNTIME" --bin-root "$SETUP_BIN" --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-crash-after-app-install.out" 2>&1; then
  echo "product setup survived injected termination after new app install" >&2
  exit 110
fi
CRASHED_APP_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-rollback-*' -print | awk 'END { print NR + 0 }')
CRASHED_RUNTIME_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.runtime.blue-tanuki-rollback-*' -print | awk 'END { print NR + 0 }')
[ "$CRASHED_APP_COUNT" = "1" ] && [ "$CRASHED_RUNTIME_COUNT" = "1" ] || exit 111
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v2" ] || exit 112
[ ! -e "$SETUP_RUNTIME" ] || exit 113
: > "$STOP_FAILURE_FILE"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-recover-after-app-install.out" 2>&1; then
  echo "setup continued after injected post-recovery resident-stop failure" >&2
  exit 114
fi
grep -Fq "restored the verified previous product after an interrupted update" "$TMP_ROOT/setup-recover-after-app-install.out" || {
  cat "$TMP_ROOT/setup-recover-after-app-install.out" >&2
  echo "setup did not recover an installed new app without its runtime" >&2
  exit 115
}
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 116
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 117
RECOVERED_APP=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-interrupted-*' -print | sed -n '1p')
[ "$(cat "$RECOVERED_APP/apps/gateway/dist/version.txt")" = "v2" ] || exit 118
[ "$(sha256_file "$SETUP_DATA/data/user.txt")" = "$SETUP_USER_DATA_SHA256" ] || exit 119
[ "$(sha256_file "$SETUP_CONFIG/blue-tanuki.env")" = "$SETUP_ENV_SHA256" ] || exit 120
rm -f -- "$STOP_FAILURE_FILE"

CRASH_RUNTIME_MOVE_BIN="$TMP_ROOT/crash-runtime-move-bin"
mkdir -p "$CRASH_RUNTIME_MOVE_BIN"
cat > "$CRASH_RUNTIME_MOVE_BIN/mv" <<'CRASH_RUNTIME_MOVE'
#!/usr/bin/env sh
case "$*" in
  *".runtime.blue-tanuki-stage-"*)
    /usr/bin/mv "$@"
    kill -KILL "$PPID"
    ;;
  *) exec /usr/bin/mv "$@" ;;
esac
CRASH_RUNTIME_MOVE
chmod +x "$CRASH_RUNTIME_MOVE_BIN/mv"
if (
  PATH="$CRASH_RUNTIME_MOVE_BIN:$PATH" \
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  LAUNCH_AFTER_INSTALL=0 \
  sh "$SETUP_PACKAGE/BlueTanukiSetup.sh" --install-root "$SETUP_INSTALL" --data-root "$SETUP_DATA" \
    --config-root "$SETUP_CONFIG" --runtime-root "$SETUP_RUNTIME" --bin-root "$SETUP_BIN" --force --no-launch --skip-doctor
) > "$TMP_ROOT/setup-crash-after-runtime-install.out" 2>&1; then
  echo "product setup survived injected termination after runtime install" >&2
  exit 87
fi
CRASHED_APP_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-rollback-*' -print | awk 'END { print NR + 0 }')
CRASHED_RUNTIME_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.runtime.blue-tanuki-rollback-*' -print | awk 'END { print NR + 0 }')
[ "$CRASHED_APP_COUNT" = "1" ] && [ "$CRASHED_RUNTIME_COUNT" = "1" ] || exit 88
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v2" ] || exit 89
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 90
[ "$(sha256_file "$SETUP_DATA/data/user.txt")" = "$SETUP_USER_DATA_SHA256" ] || exit 91
[ "$(sha256_file "$SETUP_CONFIG/blue-tanuki.env")" = "$SETUP_ENV_SHA256" ] || exit 92
: > "$STOP_FAILURE_FILE"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-recover-after-runtime-install.out" 2>&1; then
  echo "setup continued after injected post-recovery resident-stop failure" >&2
  exit 93
fi
grep -Fq "restored the verified previous product after an interrupted update" "$TMP_ROOT/setup-recover-after-runtime-install.out" || {
  cat "$TMP_ROOT/setup-recover-after-runtime-install.out" >&2
  echo "setup did not recover the app and runtime rollback state" >&2
  exit 94
}
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 95
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 96
RECOVERED_APP_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-interrupted-*' -print | awk 'END { print NR + 0 }')
RECOVERED_RUNTIME_COUNT=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.runtime.blue-tanuki-interrupted-*' -print | awk 'END { print NR + 0 }')
[ "$RECOVERED_APP_COUNT" = "2" ] && [ "$RECOVERED_RUNTIME_COUNT" = "1" ] || exit 97
RECOVERED_APP=$(find "$SETUP_DATA" -mindepth 1 -maxdepth 1 -type d -name '.app.blue-tanuki-interrupted-*' -print | sed -n '1p')
[ "$(cat "$RECOVERED_APP/apps/gateway/dist/version.txt")" = "v2" ] || exit 98
[ "$(sha256_file "$SETUP_DATA/data/user.txt")" = "$SETUP_USER_DATA_SHA256" ] || exit 99
[ "$(sha256_file "$SETUP_CONFIG/blue-tanuki.env")" = "$SETUP_ENV_SHA256" ] || exit 100
rm -f -- "$STOP_FAILURE_FILE"

AMBIGUOUS_APP_A="$SETUP_DATA/.app.blue-tanuki-rollback-100.200"
AMBIGUOUS_APP_B="$SETUP_DATA/.app.blue-tanuki-rollback-101.201"
mkdir "$AMBIGUOUS_APP_A" "$AMBIGUOUS_APP_B"
if run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-ambiguous-recovery.out" 2>&1; then
  echo "product setup accepted multiple interrupted-update candidates" >&2
  exit 101
fi
grep -Fq "multiple interrupted-update app candidates exist" "$TMP_ROOT/setup-ambiguous-recovery.out" || exit 102
[ -d "$AMBIGUOUS_APP_A" ] && [ -d "$AMBIGUOUS_APP_B" ] || exit 103
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 104
[ -x "$SETUP_RUNTIME/node-v-test-linux-x64/bin/node" ] || exit 105
[ "$(sha256_file "$SETUP_DATA/data/user.txt")" = "$SETUP_USER_DATA_SHA256" ] || exit 106
rmdir "$AMBIGUOUS_APP_A" "$AMBIGUOUS_APP_B"

if ! run_fixture_setup --force --no-launch --skip-doctor > "$TMP_ROOT/setup-update.out" 2>&1; then
  cat "$TMP_ROOT/setup-update.out" >&2
  echo "isolated product update failed" >&2
  exit 35
fi
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v2" ] || exit 36
mkdir -p "$SETUP_DATA/data"
printf 'preserve until explicit purge\n' > "$SETUP_DATA/data/user.txt"
printf 'unrelated config\n' > "$SETUP_HOME/.config/other-app/keep.txt"
mkdir -p "$SETUP_HOME/.config/autostart"
printf '[Desktop Entry]\nName=Unrelated app\nComment=mentions %s\nExec=other-app\n' "$SETUP_INSTALL" > "$SETUP_HOME/.config/autostart/blue-tanuki.desktop"
: > "$STOP_FAILURE_FILE"
if (
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  sh "$SETUP_INSTALL/BlueTanukiUninstall.sh"
) > "$TMP_ROOT/uninstall-stop-failure.out" 2>&1; then
  echo "product uninstall continued after resident shutdown failed" >&2
  exit 73
fi
grep -Fq "resident shutdown was not confirmed" "$TMP_ROOT/uninstall-stop-failure.out" || {
  cat "$TMP_ROOT/uninstall-stop-failure.out" >&2
  echo "product uninstall did not report the resident shutdown blocker" >&2
  exit 74
}
[ -d "$SETUP_INSTALL" ] && [ -d "$SETUP_RUNTIME" ] || exit 75
[ -f "$SETUP_DATA/data/user.txt" ] && [ -f "$SETUP_CONFIG/blue-tanuki.env" ] || exit 76
rm -f -- "$STOP_FAILURE_FILE"
if ! (
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  sh "$SETUP_INSTALL/BlueTanukiUninstall.sh"
) > "$TMP_ROOT/setup-uninstall-retain.out" 2>&1; then
  cat "$TMP_ROOT/setup-uninstall-retain.out" >&2
  echo "isolated normal product uninstall failed" >&2
  exit 37
fi
[ ! -e "$SETUP_INSTALL" ] && [ ! -e "$SETUP_RUNTIME" ] || exit 38
[ -f "$SETUP_DATA/data/user.txt" ] && [ -f "$SETUP_CONFIG/blue-tanuki.env" ] || exit 39
[ -f "$SETUP_HOME/.config/other-app/keep.txt" ] || exit 40
[ -f "$SETUP_HOME/.config/autostart/blue-tanuki.desktop" ] || exit 47

if ! run_fixture_setup --no-launch --skip-doctor > "$TMP_ROOT/setup-reinstall.out" 2>&1; then
  cat "$TMP_ROOT/setup-reinstall.out" >&2
  echo "product reinstall did not preserve existing data roots" >&2
  exit 41
fi
[ -f "$SETUP_DATA/data/user.txt" ] || exit 42
if ! (
  HOME="$SETUP_HOME" \
  XDG_DATA_HOME="$SETUP_HOME/.local/share" \
  XDG_CONFIG_HOME="$SETUP_HOME/.config" \
  sh "$SETUP_INSTALL/BlueTanukiUninstall.sh" --purge
) > "$TMP_ROOT/setup-uninstall-purge.out" 2>&1; then
  cat "$TMP_ROOT/setup-uninstall-purge.out" >&2
  echo "isolated product purge failed" >&2
  exit 43
fi
[ ! -e "$SETUP_DATA" ] && [ ! -e "$SETUP_CONFIG" ] || exit 44
[ -f "$SETUP_HOME/.config/other-app/keep.txt" ] || exit 45
[ -f "$SETUP_HOME/.local/bin/keep-cli" ] || exit 46

safe_container_target "$TMP_ROOT/data" DATA_ROOT >/dev/null
assert_not_ancestor_target "$TMP_ROOT/data/app" "$TMP_ROOT/data" INSTALL_ROOT DATA_ROOT
expect_rejection "data ancestor of install" assert_not_ancestor_target "$TMP_ROOT/data" "$TMP_ROOT/data/app" DATA_ROOT INSTALL_ROOT

LIFECYCLE_ROOT="$TMP_ROOT/lifecycle  home"
LIFECYCLE_INSTALL="$LIFECYCLE_ROOT/install"
LIFECYCLE_DATA="$LIFECYCLE_ROOT/data"
LIFECYCLE_RUNTIME="$LIFECYCLE_ROOT/runtime"
LIFECYCLE_NODE="$LIFECYCLE_RUNTIME/bin/node"
LIFECYCLE_TEST_BIN="$TMP_ROOT/lifecycle-test-bin"
LIFECYCLE_TEST_REAL_PS=$(command -v ps)
LIFECYCLE_TEST_REAL_GREP=$(command -v grep)
LIFECYCLE_TEST_GREP_COUNT="$TMP_ROOT/lifecycle-grep-count"
mkdir -p "$LIFECYCLE_INSTALL" "$LIFECYCLE_DATA" "$LIFECYCLE_RUNTIME/bin"
cp "$REPO_ROOT/install/unix/product/BlueTanukiLauncher.sh" "$LIFECYCLE_INSTALL/BlueTanukiLauncher.sh"
cat > "$LIFECYCLE_NODE" <<'NODE'
#!/usr/bin/env sh
if [ "${1:-}" = "-e" ]; then exit 0; fi
node_cleanup() {
  if [ -n "${node_sleep_pid:-}" ]; then
    kill -TERM "$node_sleep_pid" 2>/dev/null || true
    wait "$node_sleep_pid" 2>/dev/null || true
  fi
  exit 0
}
trap node_cleanup TERM INT
while :; do
  sleep 30 &
  node_sleep_pid=$!
  wait "$node_sleep_pid" || true
done
NODE
chmod +x "$LIFECYCLE_NODE"
cat > "$LIFECYCLE_INSTALL/blue-tanuki-install.env" <<ENV
INSTALL_ROOT='$LIFECYCLE_INSTALL'
DATA_ROOT='$LIFECYCLE_DATA'
ENV_FILE='$LIFECYCLE_DATA/blue-tanuki.env'
NODE_EXE='$LIFECYCLE_NODE'
CONTROL_CENTER_URL='http://127.0.0.1:8787/app'
PLATFORM='linux'
ENV
if ! HOME="$LIFECYCLE_ROOT" sh "$LIFECYCLE_INSTALL/BlueTanukiLauncher.sh" resident-start > "$TMP_ROOT/lifecycle-start.out" 2>&1; then
  cat "$TMP_ROOT/lifecycle-start.out" >&2
  echo "isolated resident process did not start" >&2
  exit 77
fi
attempt=0
while [ ! -s "$LIFECYCLE_DATA/blue-tanuki.pid" ] && [ "$attempt" -lt 10 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
[ -s "$LIFECYCLE_DATA/blue-tanuki.pid" ] && [ -s "$LIFECYCLE_DATA/blue-tanuki-watchdog.pid" ] || {
  echo "resident process identity records were not created" >&2
  exit 78
}
LIFECYCLE_GATEWAY_PID=$(cat "$LIFECYCLE_DATA/blue-tanuki.pid")
LIFECYCLE_WATCHDOG_PID=$(cat "$LIFECYCLE_DATA/blue-tanuki-watchdog.pid")
case "$LIFECYCLE_GATEWAY_PID:$LIFECYCLE_WATCHDOG_PID" in *[!0-9:]*|:*) exit 79 ;; esac
sleep 60 &
LIFECYCLE_UNRELATED_PID=$!
printf '%s\n' "$LIFECYCLE_UNRELATED_PID" > "$LIFECYCLE_DATA/blue-tanuki.pid"
if HOME="$LIFECYCLE_ROOT" sh "$LIFECYCLE_INSTALL/BlueTanukiLauncher.sh" resident-stop > "$TMP_ROOT/lifecycle-unowned-pid.out" 2>&1; then
  echo "resident stop accepted a PID reused by an unrelated process" >&2
  exit 80
fi
kill -0 "$LIFECYCLE_UNRELATED_PID" 2>/dev/null || exit 81
kill -0 "$LIFECYCLE_GATEWAY_PID" 2>/dev/null || exit 82
[ ! -e "$LIFECYCLE_DATA/blue-tanuki.stop" ] || exit 83
[ -f "$LIFECYCLE_DATA/blue-tanuki-watchdog.pid" ] || exit 84
rm -f -- "$LIFECYCLE_DATA/blue-tanuki.pid"
mkdir -p "$LIFECYCLE_TEST_BIN"
cat > "$LIFECYCLE_TEST_BIN/ps" <<'PS'
#!/usr/bin/env sh
case " $* " in
  *" -axo "*)
    "$BLUE_TANUKI_TEST_REAL_PS" "$@" || exit
    noise_pid=90000000
    while [ "$noise_pid" -lt 90000400 ]; do
      printf '%s S /usr/bin/unrelated-process --fixture-noise %s\n' "$noise_pid" "$noise_pid"
      noise_pid=$((noise_pid + 1))
    done
    ;;
  *) exec "$BLUE_TANUKI_TEST_REAL_PS" "$@" ;;
esac
PS
cat > "$LIFECYCLE_TEST_BIN/grep" <<'GREP'
#!/usr/bin/env sh
printf x >> "$BLUE_TANUKI_TEST_GREP_COUNT"
exec "$BLUE_TANUKI_TEST_REAL_GREP" "$@"
GREP
chmod +x "$LIFECYCLE_TEST_BIN/ps" "$LIFECYCLE_TEST_BIN/grep"
if ! HOME="$LIFECYCLE_ROOT" \
  PATH="$LIFECYCLE_TEST_BIN:$PATH" \
  BLUE_TANUKI_TEST_REAL_PS="$LIFECYCLE_TEST_REAL_PS" \
  BLUE_TANUKI_TEST_REAL_GREP="$LIFECYCLE_TEST_REAL_GREP" \
  BLUE_TANUKI_TEST_GREP_COUNT="$LIFECYCLE_TEST_GREP_COUNT" \
  sh "$LIFECYCLE_INSTALL/BlueTanukiLauncher.sh" resident-stop > "$TMP_ROOT/lifecycle-recovered-stop.out" 2>&1; then
  cat "$TMP_ROOT/lifecycle-recovered-stop.out" >&2
  echo "resident stop did not recover the missing PID record by process identity" >&2
  exit 85
fi
[ ! -e "$LIFECYCLE_DATA/blue-tanuki.pid" ] && [ ! -e "$LIFECYCLE_DATA/blue-tanuki-watchdog.pid" ] || exit 86
[ "$(wc -c < "$LIFECYCLE_TEST_GREP_COUNT" | tr -d '[:space:]')" -lt 250 ] || {
  echo "resident stop spawned too many identity checks for unrelated process rows" >&2
  exit 92
}
kill -0 "$LIFECYCLE_UNRELATED_PID" 2>/dev/null || exit 87
kill -TERM "$LIFECYCLE_UNRELATED_PID" 2>/dev/null || true
wait "$LIFECYCLE_UNRELATED_PID" 2>/dev/null || true
LIFECYCLE_UNRELATED_PID=
LIFECYCLE_GATEWAY_PID=
LIFECYCLE_WATCHDOG_PID=
printf 'invalid-pid\n' > "$LIFECYCLE_DATA/blue-tanuki.pid"
if HOME="$LIFECYCLE_ROOT" sh "$LIFECYCLE_INSTALL/BlueTanukiLauncher.sh" resident-start > "$TMP_ROOT/lifecycle-invalid-record.out" 2>&1; then
  echo "resident start replaced an invalid PID record" >&2
  exit 88
fi
grep -Fq "PID record is invalid" "$TMP_ROOT/lifecycle-invalid-record.out" || {
  cat "$TMP_ROOT/lifecycle-invalid-record.out" >&2
  echo "resident start did not report the invalid PID record" >&2
  exit 89
}
[ "$(cat "$LIFECYCLE_DATA/blue-tanuki.pid")" = "invalid-pid" ] || exit 90
[ ! -e "$LIFECYCLE_DATA/blue-tanuki-watchdog.pid" ] || exit 91
rm -f -- "$LIFECYCLE_DATA/blue-tanuki.pid"

sed "s/^PLATFORM='linux'$/PLATFORM='macos'/" "$PRODUCT_INSTALL/blue-tanuki-install.env" > "$TMP_ROOT/product-install-macos.env"
mv -- "$TMP_ROOT/product-install-macos.env" "$PRODUCT_INSTALL/blue-tanuki-install.env"
cat > "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json" <<'MANIFEST'
{
  "schema_version": 1,
  "name": "blue-tanuki",
  "version": "1.0.0-rc.1",
  "package_type": "macos-arm64-tar-installer",
  "created_at": "2026-11-11T00:00:00.000Z"
}
MANIFEST
MACOS_PRODUCT_MANIFEST_SHA256=$(sha256_file "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json")
rm -f -- "$PRODUCT_INSTALL/blue-tanuki-managed-files.txt"
PRODUCT_SURFACE="$PRODUCT_HOME/Applications/BlueTanuki.command"
mkdir -p "$(dirname -- "$PRODUCT_SURFACE")"
render_managed_macos_application_command "$PRODUCT_BIN/blue-tanuki" > "$PRODUCT_SURFACE"
write_product_owner_marker "$PRODUCT_INSTALL/.blue-tanuki-owner" install "$PRODUCT_INSTALL" "$PRODUCT_DATA" "$PRODUCT_CONFIG" "$PRODUCT_RUNTIME" "$PRODUCT_BIN" macos "$PRODUCT_SURFACE"
write_product_owner_marker "$PRODUCT_DATA/.blue-tanuki-owner" data "$PRODUCT_INSTALL" "$PRODUCT_DATA" "$PRODUCT_CONFIG" "$PRODUCT_RUNTIME" "$PRODUCT_BIN" macos "$PRODUCT_SURFACE"
write_product_owner_marker "$PRODUCT_CONFIG/.blue-tanuki-owner" config "$PRODUCT_INSTALL" "$PRODUCT_DATA" "$PRODUCT_CONFIG" "$PRODUCT_RUNTIME" "$PRODUCT_BIN" macos "$PRODUCT_SURFACE"
PRODUCT_INSTALL_INVENTORY=$(write_managed_tree_inventory "$PRODUCT_INSTALL" blue-tanuki-install.json blue-tanuki-managed-files.txt blue-tanuki-product-install)
cat > "$PRODUCT_INSTALL/blue-tanuki-install.json" <<METADATA
{
  "schema_version": 3,
  "product_id": "blue-tanuki-product-install",
  "package_manifest_sha256": "$MACOS_PRODUCT_MANIFEST_SHA256",
  "managed_install_files_sha256": "$PRODUCT_INSTALL_INVENTORY",
  "managed_runtime_files_sha256": "$PRODUCT_RUNTIME_INVENTORY",
  "install_root": "$PRODUCT_INSTALL",
  "data_root": "$PRODUCT_DATA",
  "config_root": "$PRODUCT_CONFIG",
  "runtime_root": "$PRODUCT_RUNTIME",
  "bin_root": "$PRODUCT_BIN",
  "env_file": "$PRODUCT_CONFIG/blue-tanuki.env",
  "node_exe": "$PRODUCT_RUNTIME/node-v-test/bin/node",
  "control_center_url": "http://127.0.0.1:8787/app",
  "platform": "macos"
}
METADATA
rm -f -- "$PRODUCT_HOME/.local/share/applications/blue-tanuki.desktop"
PRODUCT_AUTOSTART_DIR="$PRODUCT_HOME/Library/LaunchAgents"
PRODUCT_AUTOSTART="$PRODUCT_AUTOSTART_DIR/com.blue-tanuki.gateway.plist"
mkdir -p "$PRODUCT_AUTOSTART_DIR"
mkdir -p "$PRODUCT_HOME/test-bin"
cat > "$PRODUCT_HOME/test-bin/uname" <<'UNAME'
#!/usr/bin/env sh
if [ "${1:-}" = "-s" ]; then printf 'Darwin\n'; else exec /usr/bin/uname "$@"; fi
UNAME
chmod +x "$PRODUCT_HOME/test-bin/uname"

cat > "$PRODUCT_AUTOSTART" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist><dict><key>ProgramArguments</key><array><string>$PRODUCT_INSTALL/BlueTanukiLauncher.sh</string></array></dict></plist>
EOF
cp "$PRODUCT_AUTOSTART" "$TMP_ROOT/macos-unowned-plist.backup"
if (HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-enable) > "$TMP_ROOT/macos-unowned-enable.out" 2>&1; then
  echo "macOS autostart enable replaced a user plist containing the launcher path" >&2
  exit 122
fi
cmp -s "$PRODUCT_AUTOSTART" "$TMP_ROOT/macos-unowned-plist.backup" || exit 123
HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-status > "$TMP_ROOT/macos-unowned-status.out"
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-unowned-status.out" || exit 124
HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-disable > "$TMP_ROOT/macos-unowned-disable.out"
cmp -s "$PRODUCT_AUTOSTART" "$TMP_ROOT/macos-unowned-plist.backup" || exit 125
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-unowned-disable.out" || exit 126
if ! (
  HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" \
    sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/macos-unowned-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/macos-unowned-uninstall.out" >&2
  exit 127
fi
grep -Fq "Preserved unrelated or modified autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/macos-unowned-uninstall.out" || exit 128

rm -f -- "$PRODUCT_AUTOSTART"
HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-enable > "$TMP_ROOT/macos-owned-enable.out"
is_managed_macos_autostart_entry "$PRODUCT_AUTOSTART" "$PRODUCT_INSTALL" "$PRODUCT_DATA/logs/blue-tanuki.out.log" "$PRODUCT_DATA/logs/blue-tanuki.err.log" || exit 129

cp "$PRODUCT_INSTALL/blue-tanuki-install.env" "$TMP_ROOT/product-install-env.backup"
MACOS_FOREIGN_INSTALL="$PRODUCT_HOME/foreign-app"
sed "s|^INSTALL_ROOT=.*|INSTALL_ROOT='$MACOS_FOREIGN_INSTALL'|" "$TMP_ROOT/product-install-env.backup" > "$PRODUCT_INSTALL/blue-tanuki-install.env"
render_managed_macos_autostart_entry "$MACOS_FOREIGN_INSTALL" \
  "$PRODUCT_DATA/logs/blue-tanuki.out.log" "$PRODUCT_DATA/logs/blue-tanuki.err.log" > "$PRODUCT_AUTOSTART"
HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-status > "$TMP_ROOT/macos-mismatched-root-status.out"
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-mismatched-root-status.out" || exit 143
HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-disable > "$TMP_ROOT/macos-mismatched-root-disable.out"
[ -f "$PRODUCT_AUTOSTART" ] || exit 144
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-mismatched-root-disable.out" || exit 145
mv -- "$TMP_ROOT/product-install-env.backup" "$PRODUCT_INSTALL/blue-tanuki-install.env"
render_managed_macos_autostart_entry "$PRODUCT_INSTALL" \
  "$PRODUCT_DATA/logs/blue-tanuki.out.log" "$PRODUCT_DATA/logs/blue-tanuki.err.log" > "$PRODUCT_AUTOSTART"

HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-status > "$TMP_ROOT/macos-owned-status.out"
grep -Fq 'autostart_status=enabled' "$TMP_ROOT/macos-owned-status.out" || exit 130
if ! (
  HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" \
    sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/macos-owned-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/macos-owned-uninstall.out" >&2
  exit 131
fi
grep -Fq "Would remove managed autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/macos-owned-uninstall.out" || exit 132
printf '\n<!-- user change -->\n' >> "$PRODUCT_AUTOSTART"
HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" sh "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" autostart-disable > "$TMP_ROOT/macos-modified-disable.out"
[ -f "$PRODUCT_AUTOSTART" ] || exit 133
grep -Fq 'autostart_status=preserved' "$TMP_ROOT/macos-modified-disable.out" || exit 134

render_managed_unix_launcher_wrapper "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" > "$PRODUCT_BIN/blue-tanuki"
printf '\nuser-owned line\n' >> "$PRODUCT_BIN/blue-tanuki"
render_managed_macos_application_command "$PRODUCT_BIN/blue-tanuki" > "$PRODUCT_SURFACE"
printf '\nuser-owned line\n' >> "$PRODUCT_SURFACE"
if ! (
  HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" \
    sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/macos-modified-external-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/macos-modified-external-uninstall.out" >&2
  exit 135
fi
grep -Fq "Preserved unrelated or modified launcher: $PRODUCT_BIN/blue-tanuki" "$TMP_ROOT/macos-modified-external-uninstall.out" || exit 136
grep -Fq "Preserved unrelated or modified application_command: $PRODUCT_SURFACE" "$TMP_ROOT/macos-modified-external-uninstall.out" || exit 137
grep -Fq "Preserved unrelated or modified autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/macos-modified-external-uninstall.out" || exit 138

render_managed_unix_launcher_wrapper "$PRODUCT_INSTALL/BlueTanukiLauncher.sh" > "$PRODUCT_BIN/blue-tanuki"
render_managed_macos_application_command "$PRODUCT_BIN/blue-tanuki" > "$PRODUCT_SURFACE"
render_managed_macos_autostart_entry "$PRODUCT_INSTALL" \
  "$PRODUCT_DATA/logs/blue-tanuki.out.log" "$PRODUCT_DATA/logs/blue-tanuki.err.log" > "$PRODUCT_AUTOSTART"
if ! (
  HOME="$PRODUCT_HOME" PATH="$PRODUCT_HOME/test-bin:$PATH" \
    sh "$PRODUCT_INSTALL/BlueTanukiUninstall.sh" --dry-run
) > "$TMP_ROOT/macos-exact-external-uninstall.out" 2>&1; then
  cat "$TMP_ROOT/macos-exact-external-uninstall.out" >&2
  exit 139
fi
grep -Fq "Would remove managed launcher: $PRODUCT_BIN/blue-tanuki" "$TMP_ROOT/macos-exact-external-uninstall.out" || exit 140
grep -Fq "Would remove managed application_command: $PRODUCT_SURFACE" "$TMP_ROOT/macos-exact-external-uninstall.out" || exit 141
grep -Fq "Would remove managed autostart_entry: $PRODUCT_AUTOSTART" "$TMP_ROOT/macos-exact-external-uninstall.out" || exit 142

echo "unix_target_guard=pass"
