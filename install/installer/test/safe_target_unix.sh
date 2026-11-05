set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
# shellcheck disable=SC1091
. "$REPO_ROOT/install/unix/safe-target.sh"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/blue-tanuki-safe-target.XXXXXX")
trap 'rm -rf -- "$TMP_ROOT"' EXIT HUP INT TERM
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
printf '#!/usr/bin/env sh\nexit 0\n' > "$PRODUCT_RUNTIME/node-v-test/bin/node"
chmod +x "$PRODUCT_RUNTIME/node-v-test/bin/node"
cat > "$PRODUCT_INSTALL/blue-tanuki-package-manifest.json" <<'MANIFEST'
{
  "schema_version": 1,
  "name": "blue-tanuki",
  "version": "1.0.0-rc.1",
  "package_type": "linux-x64-tar-installer"
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
  if [ -n "${INSTALL_MANAGED_FILES_SHA256_VALUE:-}" ]; then
    node -e "$javascript" "$@"
    exit $?
  fi
  printf '{\n  "schema_version": 3,\n  "product_id": "blue-tanuki-product-install",\n  "package_manifest_sha256": "%s",\n  "managed_install_files_sha256": "%s",\n  "managed_runtime_files_sha256": "%s",\n  "install_root": "%s",\n  "data_root": "%s",\n  "config_root": "%s",\n  "runtime_root": "%s",\n  "bin_root": "%s",\n  "env_file": "%s",\n  "node_exe": "%s",\n  "control_center_url": "%s",\n  "platform": "%s"\n}\n' \
    "$PACKAGE_MANIFEST_SHA256_VALUE" "${INSTALL_MANAGED_FILES_SHA256_VALUE:-}" "${RUNTIME_MANAGED_FILES_SHA256_VALUE:-}" \
    "$INSTALL_ROOT_VALUE" "$DATA_ROOT_VALUE" "$CONFIG_ROOT_VALUE" "$RUNTIME_ROOT_VALUE" "$BIN_ROOT_VALUE" \
    "$ENV_FILE_VALUE" "$NODE_EXE_VALUE" "$CONTROL_CENTER_URL_VALUE" "$PLATFORM_VALUE" > "$1"
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
  "schema_version": 1,
  "name": "blue-tanuki",
  "version": "1.0.0-rc.1",
  "package_type": "linux-x64-tar-installer",
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
if ! run_fixture_setup --no-launch --skip-doctor > "$TMP_ROOT/setup-initial.out" 2>&1; then
  cat "$TMP_ROOT/setup-initial.out" >&2
  echo "isolated product setup failed" >&2
  exit 29
fi
[ "$(cat "$SETUP_INSTALL/apps/gateway/dist/version.txt")" = "v1" ] || exit 30
[ -f "$SETUP_DATA/.blue-tanuki-owner" ] && [ -f "$SETUP_CONFIG/.blue-tanuki-owner" ] || exit 31
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

echo "unix_target_guard=pass"
