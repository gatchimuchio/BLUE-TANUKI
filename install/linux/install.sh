#!/usr/bin/env sh
set -eu

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/blue-tanuki/app}"
DATA_ROOT="${DATA_ROOT:-$HOME/.local/share/blue-tanuki}"
CONFIG_ROOT="${CONFIG_ROOT:-$HOME/.config/blue-tanuki}"
FORCE="${FORCE:-0}"
RESET_CONFIG="${RESET_CONFIG:-0}"
RUN_DOCTOR="${RUN_DOCTOR:-1}"
if [ "${NO_LAUNCH:-0}" = "1" ]; then
  LAUNCH_AFTER_INSTALL=0
fi
LAUNCH_AFTER_INSTALL="${LAUNCH_AFTER_INSTALL:-1}"
PNPM_VERSION="9.12.0"

fail() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. $2"
}

need node "Install Node.js 22.14.0 or newer."
node -e "const v=process.versions.node.split('.').map(Number); const ok=v[0]>22 || (v[0]===22 && (v[1]>14 || (v[1]===14 && v[2]>=0))); process.exit(ok?0:1)" \
  || fail "Node.js 22.14.0 or newer is required."

if command -v corepack >/dev/null 2>&1; then
  corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || true
fi

pnpm_run() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
    return
  fi
  fail "pnpm or corepack is required."
}

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE="$CONFIG_ROOT/blue-tanuki.env"
BIN_ROOT="$HOME/.local/bin"
LAUNCHER="$BIN_ROOT/blue-tanuki"
CONTROL_CENTER_URL="${BLUE_TANUKI_CONTROL_CENTER_URL:-http://127.0.0.1:8787/app}"

if [ -d "$INSTALL_ROOT" ] && [ "$FORCE" != "1" ]; then
  fail "$INSTALL_ROOT already exists. Re-run with FORCE=1 to replace the app. Add RESET_CONFIG=1 only if you also want to regenerate the env file."
fi

if [ -d "$INSTALL_ROOT" ]; then
  rm -rf "$INSTALL_ROOT"
fi
mkdir -p "$INSTALL_ROOT" "$DATA_ROOT" "$CONFIG_ROOT" "$BIN_ROOT"

(cd "$SOURCE_ROOT" && tar \
  --exclude="./node_modules" \
  --exclude="./.git" \
  --exclude="./.codex-tmp" \
  --exclude="./.blue-tanuki" \
  --exclude="./release" \
  -cf - .) | (cd "$INSTALL_ROOT" && tar -xf -)

cd "$INSTALL_ROOT"
pnpm_run install --frozen-lockfile
pnpm_run build

if [ -f "$ENV_FILE" ] && [ "$RESET_CONFIG" != "1" ]; then
  echo "Existing env file retained: $ENV_FILE"
else
  if [ -f "$ENV_FILE" ] && [ "$RESET_CONFIG" = "1" ]; then
    echo "warning: RESET_CONFIG=1 is enabled. Existing env file will be regenerated: $ENV_FILE" >&2
    node apps/gateway/dist/main.js --setup --yes --output "$ENV_FILE" --base-dir "$DATA_ROOT/data" --force --no-doctor
  else
    node apps/gateway/dist/main.js --setup --yes --output "$ENV_FILE" --base-dir "$DATA_ROOT/data" --no-doctor
  fi
fi

if [ "$RUN_DOCTOR" != "0" ]; then
  doctor_code=0
  node apps/gateway/dist/main.js --doctor --env-file "$ENV_FILE" --json || doctor_code=$?
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

cat > "$LAUNCHER" <<EOF
#!/usr/bin/env sh
set -eu
COMMAND="\${1:-start}"
if [ "\$#" -gt 0 ]; then
  shift
fi
export BLUE_TANUKI_ENV_FILE="$ENV_FILE"
RESIDENT_SCRIPT="$INSTALL_ROOT/install/resident/blue-tanuki-resident.sh"
resident_cmd() {
  INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" DATA_ROOT="$DATA_ROOT" LAUNCHER="$LAUNCHER" sh "\$RESIDENT_SCRIPT" "\$@"
}
cd "$INSTALL_ROOT"
case "\$COMMAND" in
  start|serve)
    exec node apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "\$@"
    ;;
  doctor)
    exec node apps/gateway/dist/main.js --doctor --env-file "$ENV_FILE" "\$@"
    ;;
  setup)
    exec node apps/gateway/dist/main.js --setup --output "$ENV_FILE" --base-dir "$DATA_ROOT/data" --force "\$@"
    ;;
  settings)
    echo "Settings: http://127.0.0.1:8787/settings"
    exec node apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "\$@"
    ;;
  env)
    printf '%s\n' "$ENV_FILE"
    ;;
  resident-start|resident-stop|resident-status|resident-open|resident-logs|resident-autostart-enable|resident-autostart-disable|resident-autostart-status)
    resident_cmd "\$COMMAND" "\$@"
    ;;
  help|-h|--help)
    cat <<'HELP'
Usage: blue-tanuki [start|doctor|setup|settings|env|resident-start|resident-status|resident-stop|resident-open|resident-logs|resident-autostart-enable|resident-autostart-disable|resident-autostart-status|help]
  start/settings  Start gateway serve mode. Open /settings after boot.
  doctor          Check local configuration.
  setup           Re-run setup against the installed env file.
  env             Print the env-file path.
  resident-*      Manage background resident gateway lifecycle and explicit autostart.
HELP
    ;;
  *)
    echo "error: unknown command: \$COMMAND" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$LAUNCHER"

echo ""
echo "BLUE-TANUKI installed."
echo "Launcher: $LAUNCHER"
echo "Env file:  $ENV_FILE"
echo "Control:   $CONTROL_CENTER_URL"
echo "Settings:  http://127.0.0.1:8787/settings"
echo "Run:       $LAUNCHER start"
echo "Doctor:    $LAUNCHER doctor"
echo "Settings:  $LAUNCHER settings"
echo "Reset cfg: FORCE=1 RESET_CONFIG=1 sh ./install/linux/install.sh"
echo "No launch: LAUNCH_AFTER_INSTALL=0 sh ./install/linux/install.sh"

if [ "$LAUNCH_AFTER_INSTALL" != "0" ]; then
  echo ""
  echo "Starting BLUE-TANUKI resident app..."
  BLUE_TANUKI_CONTROL_CENTER_URL="$CONTROL_CENTER_URL" "$LAUNCHER" resident-start
  BLUE_TANUKI_CONTROL_CENTER_URL="$CONTROL_CENTER_URL" "$LAUNCHER" resident-open
fi
