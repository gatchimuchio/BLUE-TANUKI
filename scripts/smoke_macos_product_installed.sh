#!/bin/bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'usage: %s <verified-payload.tar.gz> <one-file-installer.command> <x64|arm64>\n' "$0" >&2
  exit 2
fi

artifact=$1
installer=$2
expected_arch=$3
system_path=/usr/bin:/bin:/usr/sbin:/sbin
export PATH=$system_path

if [[ "$(uname -s)" != Darwin ]]; then
  printf 'host_os=fail expected=Darwin actual=%s\n' "$(uname -s)" >&2
  exit 1
fi
case "$expected_arch:$(uname -m)" in
  x64:x86_64|arm64:arm64) ;;
  *)
    printf 'host_arch=fail expected=%s actual=%s\n' "$expected_arch" "$(uname -m)" >&2
    exit 1
    ;;
esac

for developer_command in node pnpm; do
  if command -v "$developer_command" >/dev/null 2>&1; then
    printf 'developer_command_available=fail command=%s path=%s\n' "$developer_command" "$(command -v "$developer_command")" >&2
    exit 1
  fi
done
printf 'system_node=absent\nsystem_pnpm=absent\n'

[[ -f "$artifact" ]] || { printf 'payload_missing=%s\n' "$artifact" >&2; exit 1; }
[[ -x "$installer" ]] || { printf 'product_installer_missing_or_not_executable=%s\n' "$installer" >&2; exit 1; }
shasum -a 256 "$artifact" "$installer"

tmp_parent=${TMPDIR:-/tmp}
/bin/mkdir -p "$tmp_parent"
tmp_parent=$(cd "$tmp_parent" && pwd -P)
work_root=$(/usr/bin/mktemp -d "$tmp_parent/blue-tanuki-g0401-macos.XXXXXXXX")
work_root=$(cd "$work_root" && pwd -P)
home_root="$work_root/home"
install_root="$work_root/install"
data_root="$work_root/data"
config_root="$work_root/config"
runtime_root="$work_root/runtime"
bin_root="$work_root/bin"
launcher="$install_root/BlueTanukiLauncher.sh"

cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [[ -x "$launcher" ]]; then
    "$launcher" resident-stop >/dev/null 2>&1
  fi
  case "$work_root" in
    "$tmp_parent"/blue-tanuki-g0401-macos.*) /bin/rm -rf -- "$work_root" ;;
    *) printf 'refusing cleanup outside the isolated G04.01 temp root: %s\n' "$work_root" >&2; status=1 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$home_root" "$work_root/tmp" "$bin_root"
chmod 700 "$work_root" "$home_root" "$work_root/tmp"
export HOME="$home_root"
export TMPDIR="$work_root/tmp"
export XDG_CONFIG_HOME="$work_root/xdg-config"
export XDG_DATA_HOME="$work_root/xdg-data"
export NO_LAUNCH=1

printf 'runner_os=%s\nrunner_arch=%s\n' "$(uname -s)" "$(uname -m)"
printf 'payload_sha256='
shasum -a 256 "$artifact" | awk '{print $1}'
printf 'product_installer_sha256='
shasum -a 256 "$installer" | awk '{print $1}'

/bin/sh "$installer" \
  --install-root "$install_root" \
  --data-root "$data_root" \
  --config-root "$config_root" \
  --runtime-root "$runtime_root" \
  --bin-root "$bin_root" \
  --no-launch \
  --skip-doctor
printf 'one_file_product_install_result=pass\n'

env_file="$config_root/blue-tanuki.env"
[[ -f "$env_file" ]] || { printf 'installed_env_missing=fail\n' >&2; exit 1; }
[[ "$(/usr/bin/stat -f '%Lp' "$env_file")" == 600 ]] || { printf 'installed_env_mode=fail\n' >&2; exit 1; }
node_exe=$(find "$runtime_root" -type f -path '*/bin/node' | sort | sed -n '1p')
[[ -x "$node_exe" ]] || { printf 'bundled_node_missing=fail\n' >&2; exit 1; }
node_identity=$("$node_exe" -p '`${process.platform}:${process.arch}`')
expected_node_arch=$expected_arch
[[ "$node_identity" == "darwin:$expected_node_arch" ]] || {
  printf 'bundled_node_identity=fail expected=darwin:%s actual=%s\n' "$expected_node_arch" "$node_identity" >&2
  exit 1
}
printf 'bundled_node=%s version=%s\n' "$node_identity" "$("$node_exe" --version)"

port=$("$node_exe" -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
"$node_exe" - "$env_file" "$port" <<'NODE'
const fs = require("node:fs");
const [envFile, port] = process.argv.slice(2);
const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/u);
const indexes = lines.flatMap((line, index) => line.startsWith("WEBCHAT_PORT=") ? [index] : []);
if (indexes.length !== 1) throw new Error("isolated env file must contain exactly one WEBCHAT_PORT");
lines[indexes[0]] = `WEBCHAT_PORT=${port}`;
fs.writeFileSync(envFile, `${lines.filter((line, index) => index < lines.length - 1 || line !== "").join("\n")}\n`, { mode: 0o600 });
fs.chmodSync(envFile, 0o600);
NODE

"$bin_root/blue-tanuki" resident-start
"$node_exe" - "$port" <<'NODE'
const port = Number(process.argv[2]);
const deadline = Date.now() + 60_000;
async function probe(path) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3_000) });
    return response.status;
  } catch {
    return 0;
  }
}
(async () => {
  while (Date.now() < deadline) {
    if (await probe("/healthz") === 200) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (await probe("/healthz") !== 200) throw new Error("installed healthz did not become ready");
  if (await probe("/app") !== 200) throw new Error("installed app did not return HTTP 200");
  console.log("healthz_http=200\napp_http=200");
})().catch(error => { console.error(error); process.exit(1); });
NODE

"$bin_root/blue-tanuki" resident-stop
"$node_exe" - "$port" <<'NODE'
const port = Number(process.argv[2]);
const deadline = Date.now() + 10_000;
(async () => {
  while (Date.now() < deadline) {
    try {
      await fetch("http://127.0.0.1:" + port + "/healthz", { signal: AbortSignal.timeout(1_000) });
    } catch {
      console.log("resident_stop=pass");
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("installed gateway remained reachable after resident-stop");
})().catch(error => { console.error(error); process.exit(1); });
NODE
