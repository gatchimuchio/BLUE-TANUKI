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
ENV_FILE="$CONFIG_ROOT/blue-tanuki.env"
INSTALL_ENV="$INSTALL_ROOT/blue-tanuki-install.env"
INSTALL_JSON="$INSTALL_ROOT/blue-tanuki-install.json"
LAUNCHER="$INSTALL_ROOT/BlueTanukiLauncher.sh"
UNINSTALLER="$INSTALL_ROOT/BlueTanukiUninstall.sh"
BIN_LAUNCHER="$BIN_ROOT/blue-tanuki"

[ -d "$PACKAGE_ROOT/app" ] || fail_source_tree
[ -d "$PACKAGE_ROOT/runtime" ] || fail_source_tree
[ -d "$PACKAGE_ROOT/launcher" ] || fail_source_tree
[ -f "$PACKAGE_ROOT/unix-installer-manifest.json" ] || fail_source_tree
[ -f "$PACKAGE_ROOT/launcher/BlueTanukiLauncher.sh" ] || fail_source_tree
[ -f "$PACKAGE_ROOT/launcher/BlueTanukiUninstall.sh" ] || fail_source_tree

runtime_archive=$(find "$PACKAGE_ROOT/runtime" -type f -name "$RUNTIME_GLOB" | sort | sed -n '1p')
[ -n "$runtime_archive" ] || fail "bundled Node runtime archive not found for $PLATFORM"

if [ -d "$INSTALL_ROOT" ] && [ "$FORCE" != "1" ]; then
  echo "Existing install will be repaired in place: $INSTALL_ROOT"
fi

mkdir -p "$DATA_ROOT" "$CONFIG_ROOT" "$BIN_ROOT" "$RUNTIME_ROOT"
rm -rf -- "$INSTALL_ROOT" "$RUNTIME_ROOT"
mkdir -p "$INSTALL_ROOT" "$RUNTIME_ROOT"

cp -R "$PACKAGE_ROOT/app/." "$INSTALL_ROOT/"
cp "$PACKAGE_ROOT/launcher/BlueTanukiLauncher.sh" "$LAUNCHER"
cp "$PACKAGE_ROOT/launcher/BlueTanukiUninstall.sh" "$UNINSTALLER"
chmod +x "$LAUNCHER" "$UNINSTALLER"

case "$runtime_archive" in
  *.tar.xz)
    tar -xJf "$runtime_archive" -C "$RUNTIME_ROOT"
    ;;
  *.tar.gz|*.tgz)
    tar -xzf "$runtime_archive" -C "$RUNTIME_ROOT"
    ;;
  *)
    fail "unsupported runtime archive: $runtime_archive"
    ;;
esac

NODE_EXE=$(find "$RUNTIME_ROOT" -type f -path "*/bin/node" | sort | sed -n '1p')
[ -n "$NODE_EXE" ] || fail "bundled node executable not found under $RUNTIME_ROOT"
chmod +x "$NODE_EXE" || true

quote_sh() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

{
  printf 'INSTALL_ROOT=%s\n' "$(quote_sh "$INSTALL_ROOT")"
  printf 'DATA_ROOT=%s\n' "$(quote_sh "$DATA_ROOT")"
  printf 'CONFIG_ROOT=%s\n' "$(quote_sh "$CONFIG_ROOT")"
  printf 'RUNTIME_ROOT=%s\n' "$(quote_sh "$RUNTIME_ROOT")"
  printf 'BIN_ROOT=%s\n' "$(quote_sh "$BIN_ROOT")"
  printf 'ENV_FILE=%s\n' "$(quote_sh "$ENV_FILE")"
  printf 'NODE_EXE=%s\n' "$(quote_sh "$NODE_EXE")"
  printf 'CONTROL_CENTER_URL=%s\n' "$(quote_sh "$CONTROL_CENTER_URL")"
  printf 'PLATFORM=%s\n' "$(quote_sh "$PLATFORM")"
} > "$INSTALL_ENV"
chmod 600 "$INSTALL_ENV" || true

INSTALL_ROOT_VALUE="$INSTALL_ROOT" \
DATA_ROOT_VALUE="$DATA_ROOT" \
CONFIG_ROOT_VALUE="$CONFIG_ROOT" \
RUNTIME_ROOT_VALUE="$RUNTIME_ROOT" \
BIN_ROOT_VALUE="$BIN_ROOT" \
ENV_FILE_VALUE="$ENV_FILE" \
NODE_EXE_VALUE="$NODE_EXE" \
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
  "CONTROL_CENTER_URL_VALUE",
  "PLATFORM_VALUE",
];
const data = {
  schema_version: 1,
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
' "$INSTALL_JSON"

if [ -f "$ENV_FILE" ] && [ "$RESET_CONFIG" != "1" ]; then
  echo "Existing env file retained: $ENV_FILE"
else
  if [ -f "$ENV_FILE" ] && [ "$RESET_CONFIG" = "1" ]; then
    echo "warning: RESET_CONFIG=1 is enabled. Existing env file will be regenerated: $ENV_FILE" >&2
    "$NODE_EXE" "$INSTALL_ROOT/apps/gateway/dist/main.js" --setup --yes --output "$ENV_FILE" --base-dir "$DATA_ROOT/data" --force --no-doctor
  else
    "$NODE_EXE" "$INSTALL_ROOT/apps/gateway/dist/main.js" --setup --yes --output "$ENV_FILE" --base-dir "$DATA_ROOT/data" --no-doctor
  fi
fi

if [ "$RUN_DOCTOR" != "0" ]; then
  doctor_code=0
  "$NODE_EXE" "$INSTALL_ROOT/apps/gateway/dist/main.js" --doctor --env-file "$ENV_FILE" --json || doctor_code=$?
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

cat > "$BIN_LAUNCHER" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$LAUNCHER")" "\$@"
EOF
chmod +x "$BIN_LAUNCHER"

cat > "$INSTALL_ROOT/BlueTanuki.sh" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$LAUNCHER")" "\$@"
EOF
chmod +x "$INSTALL_ROOT/BlueTanuki.sh"

if [ "$PLATFORM" = "macos" ]; then
  mkdir -p "$HOME/Applications"
  cat > "$HOME/Applications/BlueTanuki.command" <<EOF
#!/usr/bin/env sh
exec "$(printf '%s' "$BIN_LAUNCHER")" launch
EOF
  chmod +x "$HOME/Applications/BlueTanuki.command"
else
  desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$desktop_dir"
  cat > "$desktop_dir/blue-tanuki.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=BLUE-TANUKI
Comment=Launch BLUE-TANUKI Control Center
Exec=$(printf '%s' "$BIN_LAUNCHER") launch
Terminal=false
Categories=Utility;
EOF
fi

echo ""
echo "BLUE-TANUKI ${PLATFORM_LABEL} installed."
echo "Launcher: $BIN_LAUNCHER"
echo "Env file:  $ENV_FILE"
echo "Control:   $CONTROL_CENTER_URL"
echo "Autostart: not enabled by installer"
echo "user_requires_node_pnpm_git=false"
echo "install_result=pass"

if [ "$LAUNCH_AFTER_INSTALL" != "0" ]; then
  "$BIN_LAUNCHER" launch
fi
