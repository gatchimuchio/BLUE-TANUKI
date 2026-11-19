#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
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

STATE_ROOT="${STATE_ROOT:-$DATA_ROOT/data}"
[ "$STATE_ROOT" = "$DATA_ROOT/data" ] ||
  fail "installed runtime state root does not match its retained data root"
BLUE_TANUKI_STATE_ROOT="$STATE_ROOT"
BLUE_TANUKI_INSTALL_ROOT="$INSTALL_ROOT"
BLUE_TANUKI_DATA_ROOT="$DATA_ROOT"
export BLUE_TANUKI_STATE_ROOT
export BLUE_TANUKI_INSTALL_ROOT
export BLUE_TANUKI_DATA_ROOT

load_autostart_guard() {
  SAFE_TARGET_LIB="$SCRIPT_DIR/install/unix/safe-target.sh"
  if [ ! -f "$SAFE_TARGET_LIB" ] || [ -L "$SAFE_TARGET_LIB" ]; then
    fail "shared Unix target guard is missing; refusing autostart management"
  fi
  # shellcheck disable=SC1090
  . "$SAFE_TARGET_LIB"
}

# Use the bundled Gateway parser rather than interpreting the saved settings in sh.
installed_webchat() (
  cd "$INSTALL_ROOT"
  "$NODE_EXE" --input-type=module - "$ENV_FILE" "$@" <<'NODE'
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { connect, createServer, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { loadEnvFile } from "./apps/gateway/dist/env_file.js";

function normalizeHost(value) {
  const host = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 6) return new URL("http://[" + host + "]/").hostname.slice(1, -1);
  if (isIP(host) === 4 || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.?$/i.test(host)) return host;
  throw new Error("invalid_host");
}

const isLoopback = (host) => host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
const wildcardTarget = (host) => host === "::" ? "::1" : host === "0.0.0.0" ? "127.0.0.1" : host;
const urlHost = (host) => isIP(host) === 6 ? "[" + host + "]" : host;
const formatAddress = (host, port) => urlHost(normalizeHost(host)) + ":" + port;

function verifyResidentSocket(socket, pid, start) {
  const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync);
  if (!lsof || !/^[1-9][0-9]{0,9}$/.test(pid) || !start ||
      !socket.localAddress || !socket.remoteAddress) throw new Error("peer_unverified");
  const reverseTuple = formatAddress(socket.remoteAddress, socket.remotePort) + "->" +
    formatAddress(socket.localAddress, socket.localPort);
  const records = execFileSync(lsof, ["-nP", "-a", "-p", pid, "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], {
    encoding: "utf8", timeout: 2500, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"],
  });
  const residentStart = execFileSync("/bin/ps", ["-p", pid, "-o", "lstart="], {
    encoding: "utf8", timeout: 1000, env: { LC_ALL: "C" },
  }).trim();
  if (residentStart !== start || records.split("\n").filter((line) => line === "n" + reverseTuple).length !== 1 ||
      socket.destroyed || !socket.writable || socket.readableEnded) throw new Error("peer_unverified");
}

function listenAvailable(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => server.close(resolve));
  });
}

async function launchTicket(target, port, tls, pid, start) {
  const socket = tls ? tlsConnect({ ...tls, host: target, port }) : connect(port, target);
  socket.on("error", () => {});
  const agent = tls ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  try {
    await once(socket, tls ? "secureConnect" : "connect", { signal: AbortSignal.timeout(2500) });
    verifyResidentSocket(socket, pid, start);

    // Reuse exactly the connection verified above. Do not reconnect after inspection.
    agent.createConnection = () => socket;
    const headers = { "content-type": "application/json", "content-length": "2",
      authorization: "Bearer " + process.env.WEBCHAT_TOKEN };
    for (const [name, header] of [
      ["WEBCHAT_RESUME_TOKEN", "x-blue-tanuki-launch-resume"],
      ["BLUE_TANUKI_OWNER_TOKEN", "x-blue-tanuki-launch-owner"],
      ["BLUE_TANUKI_SETTINGS_TOKEN", "x-blue-tanuki-launch-settings"],
      ["BLUE_TANUKI_MAINTENANCE_TOKEN", "x-blue-tanuki-launch-maintenance"],
    ]) {
      if (process.env[name]) headers[header] = process.env[name];
    }
    const ticket = await new Promise((resolve, reject) => {
      const transport = tls ? https : http;
      const request = transport.request({ hostname: target, port, agent, headers,
        method: "POST", path: "/control-center/launch-handoff", signal: AbortSignal.timeout(4000) }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("error", reject);
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) response.destroy(new Error("handoff_too_large"));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body).ticket); } catch { resolve(null); }
        });
      });
      request.on("error", reject);
      request.end("{}");
    });
    if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error("handoff_invalid");
    return ticket;
  } finally {
    agent.destroy();
    socket.destroy();
  }
}

try {
  const [, , envFile, operation, first, second, expectedUrl] = process.argv;
  await loadEnvFile(envFile);
  const env = process.env;
  const bind = normalizeHost(env.WEBCHAT_HOST?.trim() || "127.0.0.1");
  const publicHost = normalizeHost(env.WEBCHAT_PUBLIC_HOST?.trim() || bind);
  const browser = wildcardTarget(publicHost);
  const port = Number.parseInt(env.WEBCHAT_PORT ?? "8787", 10);
  const cert = env.WEBCHAT_TLS_CERT_FILE?.trim();
  const key = env.WEBCHAT_TLS_KEY_FILE?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || Boolean(cert) !== Boolean(key) ||
      (!cert && !isLoopback(publicHost) && publicHost !== "localhost" && publicHost !== "localhost.")) {
    throw new Error("invalid_transport");
  }
  const url = (cert ? "https://" : "http://") + urlHost(browser) + ":" + port + "/app";
  if (operation === "url") {
    process.stdout.write(url);
  } else if (operation === "port-available") {
    await listenAvailable(bind, port).catch(() => {
      process.stderr.write("port_conflict=" + formatAddress(bind, port) + "\n");
      throw new Error("port_unavailable");
    });
  } else {
    const targetHost = wildcardTarget(bind);
    const target = normalizeHost(isIP(targetHost) ? targetHost : (await lookup(targetHost)).address);
    if (operation === "loopback-health" && !isLoopback(target)) process.exit(3);
    const localAddresses = Object.values(networkInterfaces()).flatMap((entries) =>
      (entries || []).map(({ address }) => normalizeHost(address.split("%", 1)[0])));
    if (!isLoopback(target) && !localAddresses.includes(target)) throw new Error("nonlocal_health_target");
    let tls;
    if (cert) {
      const info = lstatSync(cert);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1_048_576 || resolve(cert) === resolve(key)) {
        throw new Error("invalid_certificate");
      }
      const configuredCertificate = readFileSync(cert);
      const expectedFingerprint = new X509Certificate(configuredCertificate).fingerprint256;
      tls = { ca: configuredCertificate, allowPartialTrustChain: true,
        rejectUnauthorized: true, servername: isIP(browser) ? undefined : browser,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(browser, certificate) ??
          (certificate.fingerprint256 === expectedFingerprint ? undefined : new Error("certificate_mismatch")) };
    }
    if (operation === "ticket") {
      // A URL outside the native loopback binding must never receive a launch ticket.
      const browserAddress = browser === "localhost" || browser === "localhost."
        ? normalizeHost((await lookup(browser)).address) : browser;
      if (url !== expectedUrl || browserAddress !== target || !isLoopback(target) || !env.WEBCHAT_TOKEN) {
        throw new Error("handoff_not_local");
      }
      process.stdout.write(await launchTicket(target, port, tls, first, second));
    } else if (operation === "health" || operation === "loopback-health") {
      const timeoutSeconds = Number(first);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 15) throw new Error("invalid_timeout");
      const deadline = Date.now() + timeoutSeconds * 1000;
      const transport = tls ? https : http;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        const signal = AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())));
        ready = await new Promise((resolve) => {
          const request = transport.get({ ...tls, hostname: target, port, path: "/healthz", signal, agent: false }, (response) => {
            response.resume();
            response.once("error", () => resolve(false));
            response.once("end", () => resolve(response.statusCode === 200));
          });
          request.once("error", () => resolve(false));
        });
        if (!ready && Date.now() < deadline) await delay(250);
      }
      if (!ready) process.exitCode = 2;
    } else {
      throw new Error("invalid_operation");
    }
  }
} catch {
  process.stderr.write("installed_webchat_transport_unavailable\n");
  process.exitCode = 2;
}
NODE
)

read_pid() {
  read_pid_record "$PID_FILE" resident
}

read_watchdog_pid() {
  read_pid_record "$WATCHDOG_PID_FILE" watchdog
}

read_pid_record() {
  record_path=$1
  record_kind=$2
  if [ ! -e "$record_path" ] && [ ! -L "$record_path" ]; then
    return 0
  fi
  if [ ! -f "$record_path" ] || [ -L "$record_path" ]; then
    echo "error: $record_kind PID record is not a regular file; refusing process control" >&2
    return 1
  fi
  record_lines=$(wc -l < "$record_path" 2>/dev/null | tr -d '[:space:]') || {
    echo "error: $record_kind PID record could not be inspected" >&2
    return 1
  }
  if [ "$record_lines" != 1 ]; then
    echo "error: $record_kind PID record has an unexpected shape; refusing process control" >&2
    return 1
  fi
  record_pid=$(cat "$record_path" 2>/dev/null) || {
    echo "error: $record_kind PID record could not be read" >&2
    return 1
  }
  case "$record_pid" in
    ''|*[!0-9]*)
      echo "error: $record_kind PID record is invalid; refusing process control" >&2
      return 1
      ;;
  esac
  if [ "${#record_pid}" -gt 10 ] || [ "$record_pid" -lt 2 ] || [ "$record_pid" -gt 2147483647 ]; then
    echo "error: $record_kind PID record is outside the supported range" >&2
    return 1
  fi
  printf '%s\n' "$record_pid"
}

write_pid_record() {
  record_path=$1
  record_pid=$2
  record_kind=$3
  case "$record_pid" in ''|*[!0-9]*) echo "error: cannot write invalid $record_kind PID" >&2; return 1 ;; esac
  if [ -L "$record_path" ] || { [ -e "$record_path" ] && [ ! -f "$record_path" ]; }; then
    echo "error: $record_kind PID record is not a regular file" >&2
    return 1
  fi
  record_tmp="$record_path.tmp.$$"
  if [ -e "$record_tmp" ] || [ -L "$record_tmp" ]; then
    echo "error: temporary $record_kind PID record already exists" >&2
    return 1
  fi
  if ! (umask 077; printf '%s\n' "$record_pid" > "$record_tmp"); then
    rm -f -- "$record_tmp"
    echo "error: $record_kind PID record could not be written" >&2
    return 1
  fi
  if [ -L "$record_path" ] || { [ -e "$record_path" ] && [ ! -f "$record_path" ]; }; then
    rm -f -- "$record_tmp"
    echo "error: $record_kind PID record changed while writing" >&2
    return 1
  fi
  if ! mv -f -- "$record_tmp" "$record_path"; then
    rm -f -- "$record_tmp"
    echo "error: $record_kind PID record could not be installed" >&2
    return 1
  fi
  return 0
}

write_stop_marker() {
  if [ -L "$STOP_FILE" ] || { [ -e "$STOP_FILE" ] && [ ! -f "$STOP_FILE" ]; }; then
    echo "error: resident stop marker is not a regular file" >&2
    return 1
  fi
  stop_tmp="$STOP_FILE.tmp.$$"
  if [ -e "$stop_tmp" ] || [ -L "$stop_tmp" ]; then
    echo "error: temporary resident stop marker already exists" >&2
    return 1
  fi
  if ! (umask 077; : > "$stop_tmp"); then
    rm -f -- "$stop_tmp"
    echo "error: resident stop marker could not be written" >&2
    return 1
  fi
  if [ -L "$STOP_FILE" ] || { [ -e "$STOP_FILE" ] && [ ! -f "$STOP_FILE" ]; }; then
    rm -f -- "$stop_tmp"
    echo "error: resident stop marker changed while writing" >&2
    return 1
  fi
  if ! mv -f -- "$stop_tmp" "$STOP_FILE"; then
    rm -f -- "$stop_tmp"
    echo "error: resident stop marker could not be installed" >&2
    return 1
  fi
  return 0
}

process_has_literal() {
  process_text=$1
  expected_text=$2
  [ -n "$expected_text" ] && printf '%s\n' "$process_text" | grep -F -e "$expected_text" >/dev/null 2>&1
}

is_gateway_process_args() {
  process_text=$1
  process_has_literal "$process_text" "$NODE_EXE" &&
    process_has_literal "$process_text" "apps/gateway/dist/main.js" &&
    process_has_literal "$process_text" "--serve" &&
    process_has_literal "$process_text" "--env-file" &&
    process_has_literal "$process_text" "$ENV_FILE"
}

is_watchdog_process_args() {
  process_text=$1
  process_has_literal "$process_text" "$SCRIPT_DIR/BlueTanukiLauncher.sh" &&
    process_has_literal "$process_text" "resident-watchdog"
}

list_owned_process_pids() {
  process_kind=$1
  process_lines=$(ps -ww -axo pid= -o stat= -o command= 2>/dev/null) || return 2
  [ -n "$process_lines" ] || return 0
  printf '%s\n' "$process_lines" | while IFS= read -r process_line; do
    # Process inventories can be large on macOS. A mandatory identity fragment
    # cheaply rejects unrelated rows before spawning per-row text utilities;
    # the full ownership checks below remain authoritative.
    case "$process_kind" in
      resident)
        case "$process_line" in *"apps/gateway/dist/main.js"*) ;; *) continue ;; esac
        ;;
      watchdog)
        case "$process_line" in *"resident-watchdog"*) ;; *) continue ;; esac
        ;;
      *) return 2 ;;
    esac
    # ps emits a numeric PID followed by its command; disable glob expansion while splitting.
    set -f
    set -- $process_line
    [ "$#" -ge 3 ] || continue
    candidate_pid=$1
    candidate_state=$2
    shift 2
    case "$candidate_state" in Z*|X*) continue ;; esac
    case "$candidate_pid" in
      ''|*[!0-9]*) continue ;;
    esac
    candidate_args=$(printf '%s\n' "$process_line" | sed 's/^[0-9][0-9]*[[:space:]][[:space:]]*[^[:space:]][^[:space:]]*[[:space:]][[:space:]]*//')
    case "$process_kind" in
      resident)
        if is_gateway_process_args "$candidate_args"; then printf '%s\n' "$candidate_pid"; fi
        ;;
      watchdog)
        if is_watchdog_process_args "$candidate_args"; then printf '%s\n' "$candidate_pid"; fi
        ;;
    esac
  done
}

process_identity_state() {
  process_kind=$1
  process_pid=$2
  if process_info=$(ps -ww -p "$process_pid" -o stat= -o command= 2>/dev/null); then
    :
  elif kill -0 "$process_pid" 2>/dev/null; then
    return 2
  else
    return 1
  fi
  [ -n "$process_info" ] || return 1
  process_state=$(printf '%s\n' "$process_info" | sed 's/^[[:space:]]*//; s/[[:space:]].*$//')
  process_text=$(printf '%s\n' "$process_info" | sed 's/^[[:space:]]*[^[:space:]]*[[:space:]]*//')
  [ -n "$process_state" ] && [ -n "$process_text" ] || return 2
  case "$process_state" in Z*|X*) return 1 ;; esac
  case "$process_kind" in
    resident) is_gateway_process_args "$process_text" && return 0 ;;
    watchdog) is_watchdog_process_args "$process_text" && return 0 ;;
  esac
  return 3
}

count_process_pids() {
  if [ -z "$1" ]; then printf '0\n'; else printf '%s\n' "$1" | awk 'NF { count++ } END { print count + 0 }'; fi
}

resolve_owned_pid() {
  process_kind=$1
  record_path=$2
  recorded_pid=$(read_pid_record "$record_path" "$process_kind") || fail "cannot inspect $process_kind PID record; no files were changed"
  process_candidates=$(list_owned_process_pids "$process_kind") || fail "cannot inspect $process_kind process inventory; no files were changed"
  process_count=$(count_process_pids "$process_candidates")
  [ "$process_count" -le 1 ] || fail "multiple same-install $process_kind processes were found; no files were changed"
  candidate_pid=$(printf '%s\n' "$process_candidates" | sed -n '1p')

  if [ -n "$recorded_pid" ]; then
    if process_identity_state "$process_kind" "$recorded_pid"; then recorded_state=0; else recorded_state=$?; fi
    case "$recorded_state" in
      0)
        [ "$candidate_pid" = "$recorded_pid" ] || fail "$process_kind process inventory changed during inspection; no files were changed"
        ;;
      1) ;;
      2) fail "$process_kind process identity could not be inspected; no files were changed" ;;
      3) fail "$process_kind PID is in use by a process not owned by this install; no files were changed" ;;
    esac
  fi
  printf '%s\n' "$candidate_pid"
}

stop_owned_process() {
  process_kind=$1
  process_pid=$2
  [ -n "$process_pid" ] || return 0
  if process_identity_state "$process_kind" "$process_pid"; then process_state=0; else process_state=$?; fi
  case "$process_state" in
    0) ;;
    1) return 0 ;;
    2) fail "$process_kind process identity could not be rechecked; install files were retained" ;;
    3) fail "$process_kind process identity changed before shutdown; install files were retained" ;;
  esac
  if ! kill -TERM "$process_pid" 2>/dev/null; then
    if process_identity_state "$process_kind" "$process_pid"; then process_state=0; else process_state=$?; fi
    [ "$process_state" -eq 1 ] && return 0
    fail "$process_kind process could not be signalled; install files were retained"
  fi
  attempts=0
  while [ "$attempts" -lt 10 ]; do
    if process_identity_state "$process_kind" "$process_pid"; then process_state=0; else process_state=$?; fi
    [ "$process_state" -eq 1 ] && return 0
    sleep 1
    attempts=$((attempts + 1))
  done
  if process_identity_state "$process_kind" "$process_pid"; then process_state=0; else process_state=$?; fi
  fail "$process_kind process PID $process_pid did not stop within 10 seconds (identity_state=$process_state); install files were retained"
}

is_pid_running() {
  pid=$1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null
}

is_running() {
  pid=$(read_pid) || return 1
  [ -n "$pid" ] || return 1
  process_identity_state resident "$pid"
}

assert_port_available() {
  if is_running; then
    return
  fi
  installed_webchat port-available
}

wait_gateway_health() {
  installed_webchat health "${1:-15}"
}

open_control_center() {
  managed_pid=$(resolve_owned_pid resident "$PID_FILE") || return 2
  [ -n "$managed_pid" ] || fail "managed Gateway is not running; the Control Center was not opened"
  if ! wait_gateway_health 2; then
    echo "resident_health=not_ready; the managed process was left running. logs=$LOG_DIR" >&2
    echo "next_action=Run '$SCRIPT_DIR/BlueTanukiLauncher.sh doctor' and review the logs before retrying." >&2
    return 2
  fi
  configured_url=$(installed_webchat url) || return 2
  control_center_url=$configured_url
  resident_start_time=$(LC_ALL=C /bin/ps -p "$managed_pid" -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  launch_ticket=$(installed_webchat ticket "$managed_pid" "$resident_start_time" "$configured_url" 2>/dev/null || true)
  if [ -n "$launch_ticket" ]; then
    control_center_url="$control_center_url#bt-launch-handoff=$launch_ticket"
  else
    echo "launch_handoff=unavailable; no credential was added to the browser URL" >&2
  fi
  if command -v open >/dev/null 2>&1; then
    (open "$control_center_url" >/dev/null 2>&1 || true) &
    echo "open_requested=$configured_url"
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    (xdg-open "$control_center_url" >/dev/null 2>&1 || true) &
    echo "open_requested=$configured_url"
    return
  fi
  echo "open_manually=$configured_url"
}

resident_start() {
  existing_pid=$(resolve_owned_pid resident "$PID_FILE") || return 2
  existing_watchdog=$(resolve_owned_pid watchdog "$WATCHDOG_PID_FILE") || return 2
  if [ -n "$existing_pid" ] || [ -n "$existing_watchdog" ]; then
    if [ -n "$existing_pid" ]; then
      echo "resident_status=running pid=$existing_pid"
    else
      echo "resident_status=starting watchdog_pid=$existing_watchdog"
    fi
  else
    if [ -L "$STOP_FILE" ] || { [ -e "$STOP_FILE" ] && [ ! -f "$STOP_FILE" ]; }; then
      fail "resident stop marker is not a regular file; cannot start safely"
    fi
    rm -f -- "$STOP_FILE"
    assert_port_available
    mkdir -p "$DATA_ROOT" "$LOG_DIR"
    "$SCRIPT_DIR/BlueTanukiLauncher.sh" resident-watchdog "$@" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
    watchdog_process=$!
    if ! write_pid_record "$WATCHDOG_PID_FILE" "$watchdog_process" watchdog; then
      kill -TERM "$watchdog_process" 2>/dev/null || true
      fail "resident watchdog identity could not be recorded; gateway was not started"
    fi
    echo "resident_status=started pid=$(read_pid)"
  fi
  if ! wait_gateway_health; then
    echo "resident_health=not_ready; the managed process was left running. logs=$LOG_DIR" >&2
    echo "next_action=Run '$SCRIPT_DIR/BlueTanukiLauncher.sh doctor' and review the logs before retrying." >&2
    return 2
  fi
  ready_pid=$(resolve_owned_pid resident "$PID_FILE") || return 2
  [ -n "$ready_pid" ] || fail "Gateway health responded but the managed process could not be verified; no process was changed"
  echo "resident_health=ready pid=$ready_pid"
  echo "control_center=$(installed_webchat url 2>/dev/null || printf unavailable)"
  echo "logs=$LOG_DIR"
}

resident_watchdog() {
  mkdir -p "$DATA_ROOT" "$LOG_DIR"
  while :; do
    if [ -f "$STOP_FILE" ]; then
      exit 0
    fi
    (
      cd "$INSTALL_ROOT"
      exec "$NODE_EXE" -- apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "$@"
    ) >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
    gateway_pid=$!
    if ! write_pid_record "$PID_FILE" "$gateway_pid" resident; then
      kill -TERM "$gateway_pid" 2>/dev/null || true
      wait "$gateway_pid" 2>/dev/null || true
      exit 2
    fi
    set +e
    wait "$gateway_pid"
    code=$?
    set -e
    if current_gateway_pid=$(read_pid 2>/dev/null) && [ "$current_gateway_pid" = "$gateway_pid" ]; then rm -f -- "$PID_FILE"; fi
    if [ -f "$STOP_FILE" ]; then
      exit 0
    fi
    printf 'watchdog_restarting_after_exit=%s\n' "$code" >>"$STDERR_LOG"
    sleep 1
  done
}

resident_stop() {
  pid=$(resolve_owned_pid resident "$PID_FILE") || return 2
  watchdog_pid=$(resolve_owned_pid watchdog "$WATCHDOG_PID_FILE") || return 2
  if [ -n "$pid" ] && [ "$pid" = "$watchdog_pid" ]; then
    fail "resident and watchdog PID records identify the same process; no files were changed"
  fi
  if [ -L "$STOP_FILE" ] || { [ -e "$STOP_FILE" ] && [ ! -f "$STOP_FILE" ]; }; then
    fail "resident stop marker is not a regular file; no files were changed"
  fi
  if [ -n "$pid" ] || [ -n "$watchdog_pid" ]; then
    mkdir -p "$DATA_ROOT"
    write_stop_marker || fail "resident stop marker could not be written; install files were retained"
  fi
  stop_owned_process watchdog "$watchdog_pid"
  stop_owned_process resident "$pid"
  remaining_resident=$(list_owned_process_pids resident) || fail "resident process inventory could not be rechecked; install files were retained"
  remaining_watchdog=$(list_owned_process_pids watchdog) || fail "watchdog process inventory could not be rechecked; install files were retained"
  [ -z "$remaining_resident" ] || fail "same-install resident process remains; install files were retained"
  [ -z "$remaining_watchdog" ] || fail "same-install watchdog remains; install files were retained"
  rm -f -- "$PID_FILE" "$WATCHDOG_PID_FILE" "$STOP_FILE"
  echo "resident_status=stopped"
}

resident_status() {
  pid=$(resolve_owned_pid resident "$PID_FILE") || return 2
  watchdog_pid=$(resolve_owned_pid watchdog "$WATCHDOG_PID_FILE") || return 2
  if [ -n "$pid" ]; then
    echo "resident_status=running pid=$pid"
    if installed_webchat loopback-health 2; then
      echo "resident_health=ready"
    else
      health_code=$?
      if [ "$health_code" -eq 3 ]; then
        echo "resident_health=unobserved_non_loopback_binding"
      else
        echo "resident_health=not_ready"
        echo "resident_health_next_action=Run '$SCRIPT_DIR/BlueTanukiLauncher.sh' doctor and review the logs before retrying."
      fi
    fi
  elif [ -n "$watchdog_pid" ]; then
    echo "resident_status=starting watchdog_pid=$watchdog_pid"
  else
    echo "resident_status=stopped"
  fi
  echo "control_center=$(installed_webchat url 2>/dev/null || printf unavailable)"
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
      load_autostart_guard
      [ "$INSTALL_ROOT" = "$SCRIPT_DIR" ] || fail "launcher install root does not match its installed location"
      [ -n "$HOME" ] && [ -d "$HOME" ] && [ ! -L "$HOME" ] ||
        fail "macOS home directory is missing or not a regular directory; existing data was preserved"
      entry_dir="$HOME/Library/LaunchAgents"
      if [ -e "$HOME/Library" ] || [ -L "$HOME/Library" ]; then
        [ -d "$HOME/Library" ] && [ ! -L "$HOME/Library" ] ||
          fail "macOS Library path is not a regular directory; existing data was preserved: $HOME/Library"
      fi
      if [ -e "$entry_dir" ] || [ -L "$entry_dir" ]; then
        [ -d "$entry_dir" ] && [ ! -L "$entry_dir" ] ||
          fail "macOS LaunchAgents path is not a regular directory; existing data was preserved: $entry_dir"
      else
        mkdir -p "$entry_dir"
      fi
      [ -d "$entry_dir" ] && [ ! -L "$entry_dir" ] ||
        fail "macOS LaunchAgents path is not a regular directory: $entry_dir"
      entry="$entry_dir/com.blue-tanuki.gateway.plist"
      if [ -e "$entry" ] || [ -L "$entry" ]; then
        is_managed_macos_autostart_entry "$entry" "$INSTALL_ROOT" "$STDOUT_LOG" "$STDERR_LOG" ||
          fail "existing macOS autostart entry is not an exact managed BLUE-TANUKI entry; it was preserved: $entry"
      else
        write_managed_external_file "$entry" macOS_autostart_entry 600 \
          render_managed_macos_autostart_entry "$INSTALL_ROOT" "$STDOUT_LOG" "$STDERR_LOG"
      fi
      ;;
    linux)
      load_autostart_guard
      entry_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
      entry="$entry_dir/blue-tanuki.desktop"
      [ "$INSTALL_ROOT" = "$SCRIPT_DIR" ] || fail "launcher install root does not match its installed location"
      if [ -L "$entry_dir" ] || { [ -e "$entry_dir" ] && [ ! -d "$entry_dir" ]; }; then
        fail "autostart directory is not a regular directory; existing data was preserved: $entry_dir"
      fi
      mkdir -p "$entry_dir"
      [ -d "$entry_dir" ] && [ ! -L "$entry_dir" ] || fail "autostart directory is not a regular directory: $entry_dir"
      if [ -e "$entry" ] || [ -L "$entry" ]; then
        is_managed_linux_autostart_entry "$entry" "$INSTALL_ROOT" ||
          fail "existing autostart entry is not an exact managed BLUE-TANUKI entry; it was preserved: $entry"
      else
        if ! (umask 077; set -C; render_managed_linux_autostart_entry "$INSTALL_ROOT" > "$entry") 2>/dev/null; then
          fail "autostart entry could not be created without replacing existing data: $entry"
        fi
        is_managed_linux_autostart_entry "$entry" "$INSTALL_ROOT" ||
          fail "new autostart entry failed its ownership check: $entry"
      fi
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
  case "$PLATFORM" in
    linux)
      load_autostart_guard
      if [ -n "$entry" ] && { [ -e "$entry" ] || [ -L "$entry" ]; }; then
        if is_managed_linux_autostart_entry "$entry" "$INSTALL_ROOT"; then
          rm -f -- "$entry"
          echo "autostart_status=disabled"
        else
          echo "autostart_status=preserved"
          echo "autostart_entry=$entry"
        fi
      else
        echo "autostart_status=disabled"
      fi
      return
      ;;
    macos)
      load_autostart_guard
      if [ -n "$entry" ] && { [ -e "$entry" ] || [ -L "$entry" ]; }; then
        if [ "$INSTALL_ROOT" = "$SCRIPT_DIR" ] &&
          [ -d "$(dirname -- "$entry")" ] && [ ! -L "$(dirname -- "$entry")" ] &&
          [ ! -L "$HOME" ] && [ ! -L "$HOME/Library" ] &&
          is_managed_macos_autostart_entry "$entry" "$INSTALL_ROOT" "$STDOUT_LOG" "$STDERR_LOG"; then
          rm -f -- "$entry"
          echo "autostart_status=disabled"
        else
          echo "autostart_status=preserved"
          echo "autostart_entry=$entry"
        fi
      else
        echo "autostart_status=disabled"
      fi
      ;;
    *)
      echo "autostart_status=disabled"
      ;;
  esac
}

autostart_status() {
  entry=$(autostart_entry)
  if [ "$PLATFORM" = linux ]; then
    load_autostart_guard
    if [ -n "$entry" ] && is_managed_linux_autostart_entry "$entry" "$INSTALL_ROOT"; then
      echo "autostart_status=enabled"
      echo "autostart_entry=$entry"
    elif [ -n "$entry" ] && { [ -e "$entry" ] || [ -L "$entry" ]; }; then
      echo "autostart_status=preserved"
      echo "autostart_entry=$entry"
    else
      echo "autostart_status=disabled"
    fi
    return
  fi
  if [ "$PLATFORM" = macos ]; then
    load_autostart_guard
    if [ -n "$entry" ] && [ "$INSTALL_ROOT" = "$SCRIPT_DIR" ] &&
      [ -d "$(dirname -- "$entry")" ] && [ ! -L "$(dirname -- "$entry")" ] &&
      [ ! -L "$HOME" ] && [ ! -L "$HOME/Library" ] &&
      is_managed_macos_autostart_entry "$entry" "$INSTALL_ROOT" "$STDOUT_LOG" "$STDERR_LOG"; then
      echo "autostart_status=enabled"
      echo "autostart_entry=$entry"
    elif [ -n "$entry" ] && { [ -e "$entry" ] || [ -L "$entry" ] || [ -L "$HOME" ] || [ -L "$(dirname -- "$entry")" ] || [ -L "$HOME/Library" ]; }; then
      echo "autostart_status=preserved"
      echo "autostart_entry=$entry"
    else
      echo "autostart_status=disabled"
    fi
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
    exec "$NODE_EXE" -- apps/gateway/dist/main.js --serve --env-file "$ENV_FILE" "$@"
    ;;
  resident-start)
    resident_start "$@"
    ;;
  resident-watchdog)
    resident_watchdog "$@"
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
    resident_stop
    resident_start "$@"
    ;;
  doctor)
    cd "$INSTALL_ROOT"
    exec "$NODE_EXE" -- apps/gateway/dist/main.js --doctor --env-file "$ENV_FILE" --json "$@"
    ;;
  recovery-inspect)
    cd "$INSTALL_ROOT"
    BLUE_TANUKI_ENV_FILE="$ENV_FILE" exec "$NODE_EXE" -- apps/gateway/dist/main.js --recovery-inspect --env-file "$ENV_FILE" "$@"
    ;;
  recovery-reconcile)
    cd "$INSTALL_ROOT"
    BLUE_TANUKI_ENV_FILE="$ENV_FILE" exec "$NODE_EXE" -- apps/gateway/dist/main.js --recovery-reconcile --env-file "$ENV_FILE" "$@"
    ;;
  recovery-apply-goal-purpose)
    cd "$INSTALL_ROOT"
    BLUE_TANUKI_ENV_FILE="$ENV_FILE" exec "$NODE_EXE" -- apps/gateway/dist/main.js --recovery-apply-goal-purpose --env-file "$ENV_FILE" "$@"
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
Usage: blue-tanuki [launch|start|stop|restart|status|doctor|recovery-inspect|recovery-reconcile|recovery-apply-goal-purpose|safe-mode|logs|env|uninstall|resident-autostart-enable|resident-autostart-disable|resident-autostart-status|help]
HELP
    ;;
  *)
    fail "unknown command: $COMMAND"
    ;;
esac
