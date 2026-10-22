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
run_dry_uninstall "product-uninstall" "$REPO_ROOT/install/unix/product/BlueTanukiUninstall.sh" linux

safe_container_target "$TMP_ROOT/data" DATA_ROOT >/dev/null
assert_not_ancestor_target "$TMP_ROOT/data/app" "$TMP_ROOT/data" INSTALL_ROOT DATA_ROOT
expect_rejection "data ancestor of install" assert_not_ancestor_target "$TMP_ROOT/data" "$TMP_ROOT/data/app" DATA_ROOT INSTALL_ROOT

echo "unix_target_guard=pass"
