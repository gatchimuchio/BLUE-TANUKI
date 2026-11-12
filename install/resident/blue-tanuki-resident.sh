#!/usr/bin/env sh
set -eu

COMMAND="${1:-status}"
if [ "$#" -gt 0 ]; then
  shift
fi

INSTALL_ROOT="${INSTALL_ROOT:-$(pwd)}"
ENV_FILE="${ENV_FILE:-${BLUE_TANUKI_ENV_FILE:-}}"
DATA_ROOT="${DATA_ROOT:-$HOME/.local/share/blue-tanuki}"
LAUNCHER="${LAUNCHER:-$HOME/.local/bin/blue-tanuki}"
PID_FILE="$DATA_ROOT/blue-tanuki.pid"
LOG_DIR="$DATA_ROOT/logs"
STDOUT_LOG="$LOG_DIR/blue-tanuki.out.log"
STDERR_LOG="$LOG_DIR/blue-tanuki.err.log"
CONTROL_CENTER_URL="${BLUE_TANUKI_CONTROL_CENTER_URL:-http://127.0.0.1:8787/}"
RESIDENT_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SAFE_TARGET_SCRIPT="$(dirname -- "$RESIDENT_SCRIPT_DIR")/unix/safe-target.sh"

fail() {
  echo "error: $*" >&2
  exit 2
}

load_safe_target() {
  [ -f "$SAFE_TARGET_SCRIPT" ] && [ ! -L "$SAFE_TARGET_SCRIPT" ] ||
    fail "shared Unix target guard is missing; refusing autostart management"
  # shellcheck disable=SC1090
  . "$SAFE_TARGET_SCRIPT"
}

need_env_file() {
  [ -n "$ENV_FILE" ] || fail "ENV_FILE or BLUE_TANUKI_ENV_FILE is required."
}

read_pid() {
  if [ -f "$PID_FILE" ]; then
    sed -n '1p' "$PID_FILE"
  fi
}

is_running() {
  pid="$(read_pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

resident_start() {
  need_env_file
  if is_running; then
    echo "resident_status=running pid=$(read_pid)"
    return
  fi
  mkdir -p "$DATA_ROOT" "$LOG_DIR"
  (
    cd "$INSTALL_ROOT"
    nohup node apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "$@" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
    echo "$!" > "$PID_FILE"
  )
  echo "resident_status=started pid=$(read_pid)"
  echo "control_center=$CONTROL_CENTER_URL"
  echo "logs=$LOG_DIR"
}

resident_stop() {
  pid="$(read_pid)"
  if [ -z "$pid" ]; then
    echo "resident_status=stopped"
    return
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "resident_status=stopped pid=$pid"
  else
    echo "resident_status=stale pid=$pid"
  fi
  rm -f -- "$PID_FILE"
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

resident_open() {
  if command -v open >/dev/null 2>&1; then
    open "$CONTROL_CENTER_URL" >/dev/null 2>&1 || true
    echo "opened=$CONTROL_CENTER_URL"
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$CONTROL_CENTER_URL" >/dev/null 2>&1 || true
    echo "opened=$CONTROL_CENTER_URL"
    return
  fi
  echo "open_manually=$CONTROL_CENTER_URL"
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

node_path() {
  bt_node_path=$(command -v node 2>/dev/null) || fail "node is required for resident autostart."
  case "$bt_node_path" in
    /*) printf '%s\n' "$bt_node_path" ;;
    *) fail "node path must be absolute for resident autostart." ;;
  esac
}

linux_autostart_preflight() {
  bt_linux_root=$1
  bt_linux_env=$2
  bt_linux_node=$3
  bt_linux_launcher=$4
  bt_linux_unit="$HOME/.config/systemd/user/blue-tanuki.service"
  bt_linux_desktop="$HOME/.config/autostart/blue-tanuki.desktop"
  bt_linux_found=0
  if [ -e "$bt_linux_unit" ] || [ -L "$bt_linux_unit" ]; then
    is_managed_dev_linux_systemd_user_service "$bt_linux_unit" "$bt_linux_root" "$bt_linux_env" "$bt_linux_node" ||
      fail "existing Linux systemd autostart entry is not an exact managed BLUE-TANUKI entry; it was preserved: $bt_linux_unit"
    echo "autostart_entry=$bt_linux_unit"
    bt_linux_found=1
  fi
  if [ -e "$bt_linux_desktop" ] || [ -L "$bt_linux_desktop" ]; then
    is_managed_dev_linux_xdg_autostart_entry "$bt_linux_desktop" "$bt_linux_launcher" ||
      fail "existing Linux XDG autostart entry is not an exact managed BLUE-TANUKI entry; it was preserved: $bt_linux_desktop"
    echo "autostart_entry=$bt_linux_desktop"
    bt_linux_found=1
  fi
  if [ "$bt_linux_found" = "1" ]; then
    echo "autostart_status=enabled"
    return 0
  fi
  return 1
}

autostart_enable_macos() {
  load_safe_target
  need_env_file
  plist_dir="$HOME/Library/LaunchAgents"
  plist="$plist_dir/com.blue-tanuki.gateway.plist"
  mkdir -p "$plist_dir"
  node_bin="$(node_path)"
  install_root=$(CDPATH= cd -- "$INSTALL_ROOT" && pwd -P) || fail "install root cannot be resolved for autostart."
  write_managed_external_file "$plist" macOS_development_autostart_entry 600 \
    render_managed_dev_macos_autostart_entry \
    "$install_root" "$ENV_FILE" "$node_bin" "$STDOUT_LOG" "$STDERR_LOG"
  if command -v launchctl >/dev/null 2>&1; then
    launch_domain="gui/$(id -u)"
    if launchctl print "$launch_domain/com.blue-tanuki.gateway" >/dev/null 2>&1; then
      launchctl bootout "$launch_domain" "$plist" >/dev/null 2>&1 ||
        fail "managed macOS autostart could not be unloaded; its file was preserved."
    fi
    launchctl enable "$launch_domain/com.blue-tanuki.gateway" >/dev/null 2>&1 ||
      fail "managed macOS autostart could not be enabled; its file was preserved."
    launchctl bootstrap "$launch_domain" "$plist" >/dev/null 2>&1 ||
      fail "managed macOS autostart could not be loaded; its file was preserved."
  fi
  echo "autostart_status=enabled"
  echo "autostart_entry=$plist"
}

autostart_enable_linux_systemd() {
  load_safe_target
  need_env_file
  unit_dir="$HOME/.config/systemd/user"
  unit="$unit_dir/blue-tanuki.service"
  node_bin="$(node_path)"
  install_root=$(CDPATH= cd -- "$INSTALL_ROOT" && pwd -P) || fail "install root cannot be resolved for autostart."
  launcher_dir=$(CDPATH= cd -- "$(dirname -- "$LAUNCHER")" && pwd -P) || fail "launcher directory cannot be resolved."
  launcher="$launcher_dir/$(basename -- "$LAUNCHER")"
  if linux_autostart_preflight "$install_root" "$ENV_FILE" "$node_bin" "$launcher"; then
    return
  fi
  mkdir -p "$unit_dir"
  write_managed_external_file "$unit" Linux_development_systemd_user_service 600 \
    render_managed_dev_linux_systemd_user_service "$install_root" "$ENV_FILE" "$node_bin"
  systemctl --user daemon-reload || fail "systemd user manager could not reload; the managed unit was preserved: $unit"
  systemctl --user enable blue-tanuki.service || fail "systemd user manager could not enable the managed unit; it was preserved: $unit"
  echo "autostart_status=enabled"
  echo "autostart_entry=$unit"
}

autostart_enable_linux_xdg() {
  load_safe_target
  need_env_file
  autostart_dir="$HOME/.config/autostart"
  desktop="$autostart_dir/blue-tanuki.desktop"
  node_bin="$(node_path)"
  install_root=$(CDPATH= cd -- "$INSTALL_ROOT" && pwd -P) || fail "install root cannot be resolved for autostart."
  launcher_dir=$(CDPATH= cd -- "$(dirname -- "$LAUNCHER")" && pwd -P) || fail "launcher directory cannot be resolved."
  launcher="$launcher_dir/$(basename -- "$LAUNCHER")"
  if linux_autostart_preflight "$install_root" "$ENV_FILE" "$node_bin" "$launcher"; then
    return
  fi
  mkdir -p "$autostart_dir"
  write_managed_external_file "$desktop" Linux_development_XDG_autostart_entry 600 \
    render_managed_dev_linux_xdg_autostart_entry "$launcher"
  echo "autostart_status=enabled"
  echo "autostart_entry=$desktop"
}

autostart_enable() {
  case "$(uname -s)" in
    Darwin)
      autostart_enable_macos
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1; then
        autostart_enable_linux_systemd
      else
        autostart_enable_linux_xdg
      fi
      ;;
    *)
      fail "resident autostart is supported only on macOS and Linux by this script."
      ;;
  esac
}

autostart_disable() {
  if [ "$(uname -s)" = "Darwin" ]; then
    load_safe_target
    plist="$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist"
    if [ ! -e "$plist" ] && [ ! -L "$plist" ]; then
      echo "autostart_status=disabled"
      return
    fi
    node_bin=$(command -v node 2>/dev/null || true)
    install_root=$(CDPATH= cd -- "$INSTALL_ROOT" 2>/dev/null && pwd -P || true)
    if [ -z "$node_bin" ] || [ -z "$install_root" ] ||
        ! is_managed_dev_macos_autostart_entry "$plist" "$install_root" "$ENV_FILE" "$node_bin" "$STDOUT_LOG" "$STDERR_LOG"; then
      echo "autostart_status=preserved"
      echo "autostart_entry=$plist"
      return
    fi
    command -v launchctl >/dev/null 2>&1 || fail "launchctl is unavailable; the managed macOS autostart file was preserved."
    launch_domain="gui/$(id -u)"
    if launchctl print "$launch_domain/com.blue-tanuki.gateway" >/dev/null 2>&1; then
      launchctl bootout "$launch_domain" "$plist" >/dev/null 2>&1 ||
        fail "managed macOS autostart could not be unloaded; its file was preserved."
    fi
    launchctl disable "$launch_domain/com.blue-tanuki.gateway" >/dev/null 2>&1 ||
      fail "managed macOS autostart could not be disabled; its file was preserved."
    is_managed_dev_macos_autostart_entry "$plist" "$install_root" "$ENV_FILE" "$node_bin" "$STDOUT_LOG" "$STDERR_LOG" ||
      fail "managed macOS autostart changed during disable; it was preserved: $plist"
    rm -f -- "$plist" || fail "managed macOS autostart file could not be removed: $plist"
    echo "autostart_status=disabled"
    return
  fi
  load_safe_target
  unit="$HOME/.config/systemd/user/blue-tanuki.service"
  desktop="$HOME/.config/autostart/blue-tanuki.desktop"
  install_root=$(CDPATH= cd -- "$INSTALL_ROOT" 2>/dev/null && pwd -P || true)
  node_bin=$(command -v node 2>/dev/null || true)
  if [ -e "$unit" ] || [ -L "$unit" ]; then
    if [ -n "$node_bin" ] && [ -n "$install_root" ] &&
        is_managed_dev_linux_systemd_user_service "$unit" "$install_root" "$ENV_FILE" "$node_bin"; then
      command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable; the managed Linux service was preserved."
      systemctl --user disable --now blue-tanuki.service ||
        fail "systemd user manager could not disable the managed unit; it was preserved: $unit"
      is_managed_dev_linux_systemd_user_service "$unit" "$install_root" "$ENV_FILE" "$node_bin" ||
        fail "managed Linux systemd unit changed during disable; it was preserved: $unit"
      rm -f -- "$unit" || fail "managed Linux systemd unit could not be removed: $unit"
      systemctl --user daemon-reload || fail "systemd user manager did not reload after unit removal: $unit"
      echo "autostart_entry_removed=$unit"
    else
      echo "autostart_entry_preserved=$unit"
    fi
  fi
  launcher_dir=$(CDPATH= cd -- "$(dirname -- "$LAUNCHER")" 2>/dev/null && pwd -P || true)
  if [ -e "$desktop" ] || [ -L "$desktop" ]; then
    if [ -n "$launcher_dir" ] &&
        is_managed_dev_linux_xdg_autostart_entry "$desktop" "$launcher_dir/$(basename -- "$LAUNCHER")"; then
      is_managed_dev_linux_xdg_autostart_entry "$desktop" "$launcher_dir/$(basename -- "$LAUNCHER")" ||
        fail "managed Linux XDG autostart entry changed during disable; it was preserved: $desktop"
      rm -f -- "$desktop" || fail "managed Linux XDG autostart entry could not be removed: $desktop"
      echo "autostart_entry_removed=$desktop"
    else
      echo "autostart_entry_preserved=$desktop"
    fi
  fi
  if [ ! -e "$unit" ] && [ ! -L "$unit" ] && [ ! -e "$desktop" ] && [ ! -L "$desktop" ]; then
    echo "autostart_status=disabled"
  else
    echo "autostart_status=preserved"
  fi
}

autostart_status() {
  load_safe_target
  case "$(uname -s)" in
    Darwin)
      entry="$HOME/Library/LaunchAgents/com.blue-tanuki.gateway.plist"
      node_bin=$(command -v node 2>/dev/null || true)
      install_root=$(CDPATH= cd -- "$INSTALL_ROOT" 2>/dev/null && pwd -P || true)
      if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then
        echo "autostart_status=disabled"
      elif [ -n "$node_bin" ] && [ -n "$install_root" ] &&
          is_managed_dev_macos_autostart_entry "$entry" "$install_root" "$ENV_FILE" "$node_bin" "$STDOUT_LOG" "$STDERR_LOG"; then
        echo "autostart_status=enabled"
        echo "autostart_entry=$entry"
      else
        echo "autostart_status=preserved"
        echo "autostart_entry=$entry"
      fi
      return
      ;;
    Linux)
      unit="$HOME/.config/systemd/user/blue-tanuki.service"
      desktop="$HOME/.config/autostart/blue-tanuki.desktop"
      install_root=$(CDPATH= cd -- "$INSTALL_ROOT" 2>/dev/null && pwd -P || true)
      node_bin=$(command -v node 2>/dev/null || true)
      launcher_dir=$(CDPATH= cd -- "$(dirname -- "$LAUNCHER")" 2>/dev/null && pwd -P || true)
      managed=0
      preserved=0
      if [ -e "$unit" ] || [ -L "$unit" ]; then
        if [ -n "$node_bin" ] && [ -n "$install_root" ] &&
            is_managed_dev_linux_systemd_user_service "$unit" "$install_root" "$ENV_FILE" "$node_bin"; then
          managed=1
          echo "autostart_entry=$unit"
        else
          preserved=1
          echo "autostart_entry_preserved=$unit"
        fi
      fi
      if [ -e "$desktop" ] || [ -L "$desktop" ]; then
        if [ -n "$launcher_dir" ] &&
            is_managed_dev_linux_xdg_autostart_entry "$desktop" "$launcher_dir/$(basename -- "$LAUNCHER")"; then
          managed=1
          echo "autostart_entry=$desktop"
        else
          preserved=1
          echo "autostart_entry_preserved=$desktop"
        fi
      fi
      if [ "$preserved" = "1" ]; then
        echo "autostart_status=preserved"
      elif [ "$managed" = "1" ]; then
        echo "autostart_status=enabled"
      else
        echo "autostart_status=disabled"
      fi
      return
      ;;
    *)
      entry=""
      ;;
  esac
  if [ -n "$entry" ] && [ -f "$entry" ]; then
    echo "autostart_status=enabled"
    echo "autostart_entry=$entry"
  else
    echo "autostart_status=disabled"
  fi
}

case "$COMMAND" in
  start|resident-start)
    resident_start "$@"
    ;;
  stop|resident-stop)
    resident_stop
    ;;
  status|resident-status)
    resident_status
    ;;
  open|resident-open)
    resident_open
    ;;
  logs|resident-logs)
    resident_logs
    ;;
  autostart-enable|resident-autostart-enable)
    autostart_enable
    ;;
  autostart-disable|resident-autostart-disable)
    autostart_disable
    ;;
  autostart-status|resident-autostart-status)
    autostart_status
    ;;
  *)
    fail "unknown resident command: $COMMAND"
    ;;
esac
