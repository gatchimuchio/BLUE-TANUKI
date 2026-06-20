#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ENV="$SCRIPT_DIR/blue-tanuki-install.env"

if [ ! -f "$INSTALL_ENV" ]; then
  echo "error: installed launcher metadata missing: $INSTALL_ENV" >&2
  exit 2
fi

# shellcheck disable=SC1090
. "$INSTALL_ENV"

COMMAND="${1:-launch}"
if [ "$#" -gt 0 ]; then
  shift
fi

PID_FILE="$DATA_ROOT/blue-tanuki.pid"
WATCHDOG_PID_FILE="$DATA_ROOT/blue-tanuki-watchdog.pid"
STOP_FILE="$DATA_ROOT/blue-tanuki.stop"
LOG_DIR="$DATA_ROOT/logs"
STDOUT_LOG="$LOG_DIR/blue-tanuki.out.log"
STDERR_LOG="$LOG_DIR/blue-tanuki.err.log"

fail() {
  echo "error: $*" >&2
  exit 2
}

read_env_value() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi
  sed -n "s/^${key}=//p" "$ENV_FILE" | sed -n '1p' | sed 's/^"//; s/"$//'
}

webchat_port() {
  port=$(read_env_value WEBCHAT_PORT)
  if [ -n "$port" ]; then
    printf '%s\n' "$port"
  else
    printf '8787\n'
  fi
}

read_pid() {
  if [ -f "$PID_FILE" ]; then
    sed -n '1p' "$PID_FILE"
  fi
}

read_watchdog_pid() {
  if [ -f "$WATCHDOG_PID_FILE" ]; then
    sed -n '1p' "$WATCHDOG_PID_FILE"
  fi
}

is_pid_running() {
  pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

is_running() {
  pid=$(read_pid)
  is_pid_running "$pid"
}

assert_port_available() {
  port=$(webchat_port)
  if is_running; then
    return
  fi
  if "$NODE_EXE" -e '
const net = require("net");
const port = Number(process.argv[1]);
const server = net.createServer();
server.once("error", () => process.exit(2));
server.once("listening", () => server.close(() => process.exit(0)));
server.listen(port, "127.0.0.1");
' "$port"; then
    return
  fi
  echo "port_conflict=127.0.0.1:$port" >&2
  exit 2
}

open_control_center() {
  if command -v open >/dev/null 2>&1; then
    (open "$CONTROL_CENTER_URL" >/dev/null 2>&1 || true) &
    echo "open_requested=$CONTROL_CENTER_URL"
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    (xdg-open "$CONTROL_CENTER_URL" >/dev/null 2>&1 || true) &
    echo "open_requested=$CONTROL_CENTER_URL"
    return
  fi
  echo "open_manually=$CONTROL_CENTER_URL"
}

resident_start() {
  if is_running; then
    echo "resident_status=running pid=$(read_pid)"
    echo "control_center=$CONTROL_CENTER_URL"
    return
  fi
  assert_port_available
  mkdir -p "$DATA_ROOT" "$LOG_DIR"
  rm -f -- "$STOP_FILE"
  (
    while :; do
      if [ -f "$STOP_FILE" ]; then
        exit 0
      fi
      (
        cd "$INSTALL_ROOT"
        exec "$NODE_EXE" apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "$@"
      ) >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
      gateway_pid=$!
      printf '%s\n' "$gateway_pid" > "$PID_FILE"
      set +e
      wait "$gateway_pid"
      code=$?
      set -e
      if [ -f "$STOP_FILE" ]; then
        exit 0
      fi
      printf 'watchdog_restarting_after_exit=%s\n' "$code" >>"$STDERR_LOG"
      sleep 1
    done
  ) &
  printf '%s\n' "$!" > "$WATCHDOG_PID_FILE"
  echo "resident_status=started pid=$(read_pid)"
  echo "control_center=$CONTROL_CENTER_URL"
  echo "logs=$LOG_DIR"
}

resident_stop() {
  mkdir -p "$DATA_ROOT"
  : > "$STOP_FILE"
  pid=$(read_pid)
  if is_pid_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  watchdog_pid=$(read_watchdog_pid)
  if is_pid_running "$watchdog_pid"; then
    kill "$watchdog_pid" 2>/dev/null || true
  fi
  rm -f -- "$PID_FILE" "$WATCHDOG_PID_FILE" "$STOP_FILE"
  echo "resident_status=stopped"
}

resident_status() {
  if is_running; then
    echo "resident_status=running pid=$(read_pid)"
  else
    echo "resident_status=stopped"
  fi
  echo "control_center=$CONTROL_CENTER_URL"
  echo "env_file=$ENV_FILE"
  echo "logs=$LOG_DIR"
}

resident_logs() {
  echo "stdout=$STDOUT_LOG"
  echo "stderr=$STDERR_LOG"
  if [ -f "$STDOUT_LOG" ]; then
    echo "--- stdout tail ---"
    tail -n 80 "$STDOUT_LOG"
  fi
  if [ -f "$STDERR_LOG" ]; then
    echo "--- stderr tail ---"
    tail -n 80 "$STDERR_LOG"
  fi
}

autostart_enable() {
  case "$PLATFORM" in
    macos)
      entry_dir="$HOME/Library/LaunchAgents"
      entry="$entry_dir/com.blue-tanuki.gateway.plist"
      mkdir -p "$entry_dir"
      cat > "$entry" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.blue-tanuki.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_ROOT/BlueTanukiLauncher.sh</string>
    <string>resident-start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$STDOUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_LOG</string>
</dict>
</plist>
EOF
      ;;
    linux)
      entry_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
      entry="$entry_dir/blue-tanuki.desktop"
      mkdir -p "$entry_dir"
      cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=BLUE-TANUKI
Comment=Start BLUE-TANUKI resident gateway
Exec=$INSTALL_ROOT/BlueTanukiLauncher.sh resident-start
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
      ;;
    *)
      fail "autostart unsupported platform: $PLATFORM"
      ;;
  esac
  echo "autostart_status=enabled"
  echo "autostart_entry=$entry"
}

autostart_entry() {
  case "$PLATFORM" in
    macos) printf '%s\n' "$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist" ;;
    linux) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/blue-tanuki.desktop" ;;
    *) printf '\n' ;;
  esac
}

autostart_disable() {
  entry=$(autostart_entry)
  if [ -n "$entry" ]; then
    rm -f -- "$entry"
  fi
  echo "autostart_status=disabled"
}

autostart_status() {
  entry=$(autostart_entry)
  if [ -n "$entry" ] && [ -f "$entry" ]; then
    echo "autostart_status=enabled"
    echo "autostart_entry=$entry"
  else
    echo "autostart_status=disabled"
  fi
}

case "$COMMAND" in
  launch|open)
    resident_start "$@"
    open_control_center
    ;;
  start|serve)
    assert_port_available
    cd "$INSTALL_ROOT"
    exec "$NODE_EXE" apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "$@"
    ;;
  resident-start)
    resident_start "$@"
    ;;
  resident-stop|stop)
    resident_stop
    ;;
  resident-status|status)
    resident_status
    ;;
  resident-open)
    open_control_center
    ;;
  resident-logs|logs)
    resident_logs
    ;;
  resident-autostart-enable|autostart-enable)
    autostart_enable
    ;;
  resident-autostart-disable|autostart-disable)
    autostart_disable
    ;;
  resident-autostart-status|autostart-status)
    autostart_status
    ;;
  restart)
    resident_stop
    resident_start "$@"
    ;;
  safe-mode)
    BLUE_TANUKI_SAFE_MODE=1
    export BLUE_TANUKI_SAFE_MODE
    resident_start "$@"
    ;;
  doctor)
    cd "$INSTALL_ROOT"
    exec "$NODE_EXE" apps/gateway/dist/main.js --doctor --env-file "$ENV_FILE" --json "$@"
    ;;
  setup)
    cd "$INSTALL_ROOT"
    exec "$NODE_EXE" apps/gateway/dist/main.js --setup --output "$ENV_FILE" --base-dir "$DATA_ROOT/data" --force "$@"
    ;;
  env)
    printf '%s\n' "$ENV_FILE"
    ;;
  uninstall)
    exec sh "$INSTALL_ROOT/BlueTanukiUninstall.sh" "$@"
    ;;
  help|-h|--help)
    cat <<'HELP'
Usage: blue-tanuki [launch|start|stop|restart|status|doctor|safe-mode|logs|env|uninstall|resident-autostart-enable|resident-autostart-disable|resident-autostart-status|help]
HELP
    ;;
  *)
    fail "unknown command: $COMMAND"
    ;;
esac
