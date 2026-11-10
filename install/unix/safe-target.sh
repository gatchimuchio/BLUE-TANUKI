safe_target_fail() {
  echo "error: $*" >&2
  exit 1
}

trim_trailing_slashes() {
  value=$1
  while [ "$value" != "/" ] && [ "${value%/}" != "$value" ]; do
    value=${value%/}
  done
  printf '%s\n' "$value"
}

canonical_target_path() {
  raw=$1
  label=$2
  [ -n "$raw" ] || safe_target_fail "$label is empty"
  case "$raw" in
    /*) ;;
    *) safe_target_fail "$label must be absolute: $raw" ;;
  esac
  case "$raw" in
    *//* ) safe_target_fail "$label contains an ambiguous double slash: $raw" ;;
  esac
  case "/$raw/" in
    *"/../"*|*"/./"*) safe_target_fail "$label contains relative traversal: $raw" ;;
  esac

  normalized=$(trim_trailing_slashes "$raw")
  if [ "$normalized" = "/" ]; then
    printf '/\n'
    return
  fi
  if [ -L "$normalized" ]; then
    safe_target_fail "$label points to a symlink: $normalized"
  fi

  suffix=$(basename -- "$normalized")
  cursor=$(dirname -- "$normalized")
  while [ ! -d "$cursor" ]; do
    if [ -e "$cursor" ] || [ -L "$cursor" ]; then
      safe_target_fail "$label parent is not a directory: $cursor"
    fi
    component=$(basename -- "$cursor")
    [ "$component" != "/" ] || safe_target_fail "$label parent cannot be resolved: $cursor"
    suffix="$component/$suffix"
    cursor=$(dirname -- "$cursor")
  done

  parent=$(CDPATH= cd -P -- "$cursor" && pwd -P) || safe_target_fail "$label parent cannot be resolved: $cursor"
  # 親が / でも二重 slash を生成せず、広域対象の実体同一性を保つ。
  trim_trailing_slashes "${parent%/}/$suffix"
}

path_is_same_or_descendant() {
  child=$(trim_trailing_slashes "$1")
  parent=$(trim_trailing_slashes "$2")
  [ "$child" = "$parent" ] && return 0
  if [ "$parent" = "/" ]; then
    case "$child" in /*) return 0 ;; esac
  fi
  case "$child" in
    "$parent"/*) return 0 ;;
  esac
  return 1
}

is_denied_broad_target() {
  target=$(trim_trailing_slashes "$1")
  case "$target" in ""|"/") return 0 ;; esac
  home=$(CDPATH= cd -P -- "$HOME" 2>/dev/null && pwd -P) || safe_target_fail "HOME cannot be resolved: $HOME"

  # Refuse the home directory and every parent that could remove it (for example /home).
  path_is_same_or_descendant "$home" "$target" && return 0
  for denied in \
    "$home/.local" \
    "$home/.local/share" \
    "$home/.config" \
    "$home/Library" \
    "$home/Library/Application Support"
  do
    denied=$(trim_trailing_slashes "$denied")
    [ "$target" = "$denied" ] && return 0
  done
  return 1
}

safe_destructive_target() {
  target=$(canonical_target_path "$1" "$2")
  user_bin=$(home_bin_target_path)
  if is_denied_broad_target "$target" || [ "$target" = "$user_bin" ]; then
    safe_target_fail "$2 points to an unsafe broad path: $target"
  fi
  printf '%s\n' "$target"
}

safe_container_target() {
  target=$(canonical_target_path "$1" "$2")
  user_bin=$(home_bin_target_path)
  if is_denied_broad_target "$target" || [ "$target" = "$user_bin" ]; then
    safe_target_fail "$2 points to an unsafe broad path: $target"
  fi
  printf '%s\n' "$target"
}

home_bin_target_path() {
  if [ -d "$HOME/.local/bin" ]; then
    bin_path=$(CDPATH= cd -P -- "$HOME/.local/bin" && pwd -P) || safe_target_fail "HOME bin cannot be resolved: $HOME/.local/bin"
    trim_trailing_slashes "$bin_path"
  else
    canonical_target_path "$HOME/.local/bin" "HOME bin"
  fi
}

safe_user_bin_target() {
  target=$(canonical_target_path "$1" "$2")
  user_bin=$(home_bin_target_path)
  if is_denied_broad_target "$target" && [ "$target" != "$user_bin" ]; then
    safe_target_fail "$2 points to an unsafe broad path: $target"
  fi
  printf '%s\n' "$target"
}

safe_file_target() {
  target=$(canonical_target_path "$1" "$2")
  [ "$target" != "/" ] || safe_target_fail "$2 points to the filesystem root"
  printf '%s\n' "$target"
}

sha256_file() {
  bt_sha_path=$1
  [ -f "$bt_sha_path" ] && [ ! -L "$bt_sha_path" ] || safe_target_fail "SHA-256 input is not a regular file: $bt_sha_path"
  sha256_stdin < "$bt_sha_path"
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -c1-64
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -c1-64
  else
    safe_target_fail "SHA-256 utility is unavailable; refusing to trust package metadata"
  fi
}

managed_tree_inventory() {
  bt_inventory_root=$1
  bt_metadata_name=$2
  bt_inventory_name=$3
  bt_tree_list_temp=$(mktemp "${TMPDIR:-/tmp}/blue-tanuki-inventory.XXXXXX") ||
    safe_target_fail "managed file inventory could not allocate a temporary file"
  if ! (
    cd "$bt_inventory_root" || exit 1
    find . -mindepth 1 -exec sh -c '
      metadata_name=$1
      inventory_name=$2
      shift 2
      for entry do
        relative=${entry#./}
        [ "$relative" = "$metadata_name" ] && continue
        [ "$relative" = "$inventory_name" ] && continue
        if [ -L "$entry" ]; then
          echo "error: managed tree contains a symlink: $relative" >&2
          exit 1
        elif [ -d "$entry" ]; then
          kind=directory
          size=0
          digest=-
        elif [ -f "$entry" ]; then
          kind=file
          size=$(wc -c < "$entry" | tr -d "[:space:]") || exit 1
          if command -v sha256sum >/dev/null 2>&1; then
            digest=$(sha256sum < "$entry" 2>/dev/null | cut -c1-64)
          else
            digest=$(shasum -a 256 < "$entry" 2>/dev/null | cut -c1-64) || exit 1
          fi
          [ "${#digest}" -eq 64 ] || exit 1
        else
          echo "error: managed tree contains an unsupported filesystem entry: $relative" >&2
          exit 1
        fi
        path_hex=$(printf "%s" "$relative" | od -An -v -tx1 | tr -d "[:space:]") || exit 1
        printf "%s|%s|%s|%s\\n" "$kind" "$size" "$digest" "$path_hex"
      done
    ' blue-tanuki-inventory "$bt_metadata_name" "$bt_inventory_name" {} +
  ) > "$bt_tree_list_temp"; then
    rm -f -- "$bt_tree_list_temp"
    safe_target_fail "managed tree could not be fully inspected: $bt_inventory_root"
  fi
  LC_ALL=C sort "$bt_tree_list_temp"
  bt_inventory_status=$?
  rm -f -- "$bt_tree_list_temp"
  [ "$bt_inventory_status" -eq 0 ] || safe_target_fail "managed tree inventory could not be sorted"
}

write_managed_tree_inventory() {
  bt_inventory_root=$1
  bt_metadata_name=$2
  bt_inventory_name=$3
  bt_product_id=$4
  bt_inventory_file="$bt_inventory_root/$bt_inventory_name"
  [ ! -e "$bt_inventory_file" ] && [ ! -L "$bt_inventory_file" ] ||
    safe_target_fail "managed tree inventory target already exists: $bt_inventory_file"
  managed_tree_inventory "$bt_inventory_root" "$bt_metadata_name" "$bt_inventory_name" > "$bt_inventory_file"
  chmod 600 "$bt_inventory_file"
  sha256_file "$bt_inventory_file"
}

assert_managed_tree_inventory() {
  bt_inventory_root=$1
  bt_metadata_name=$2
  bt_inventory_name=$3
  bt_expected_hash=$4
  [ -d "$bt_inventory_root" ] && [ ! -L "$bt_inventory_root" ] || safe_target_fail "managed tree inventory root is not a regular directory: $bt_inventory_root"
  case "$bt_expected_hash" in
    *[!0-9a-fA-F]*|'') safe_target_fail "managed tree inventory digest is missing or invalid" ;;
  esac
  [ "${#bt_expected_hash}" -eq 64 ] || safe_target_fail "managed tree inventory digest has an invalid length"
  bt_inventory_file="$bt_inventory_root/$bt_inventory_name"
  [ -f "$bt_inventory_file" ] && [ ! -L "$bt_inventory_file" ] ||
    safe_target_fail "managed tree inventory is missing or not a regular file: $bt_inventory_file"
  [ "$(wc -c < "$bt_inventory_file" | tr -d '[:space:]')" -le 67108864 ] ||
    safe_target_fail "managed tree inventory exceeds the size limit"
  bt_actual_hash=$(sha256_file "$bt_inventory_file")
  [ "$(printf '%s' "$bt_expected_hash" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$bt_actual_hash" | tr '[:upper:]' '[:lower:]')" ] ||
    safe_target_fail "managed tree inventory digest does not match install metadata"
  bt_assert_inventory_temp=$(mktemp "${TMPDIR:-/tmp}/blue-tanuki-inventory.XXXXXX") ||
    safe_target_fail "managed tree inventory could not allocate a temporary file"
  if ! managed_tree_inventory "$bt_inventory_root" "$bt_metadata_name" "$bt_inventory_name" > "$bt_assert_inventory_temp"; then
    rm -f -- "$bt_assert_inventory_temp"
    safe_target_fail "managed tree could not be fully inspected: $bt_inventory_root"
  fi
  if ! cmp -s -- "$bt_assert_inventory_temp" "$bt_inventory_file"; then
    rm -f -- "$bt_assert_inventory_temp"
    safe_target_fail "managed tree contents differ from the installed-file inventory: $bt_inventory_root"
  fi
  rm -f -- "$bt_assert_inventory_temp"
}

assert_managed_product_app_inventory() {
  bt_app_root=$1
  bt_metadata="$bt_app_root/blue-tanuki-install.json"
  [ -f "$bt_metadata" ] && [ ! -L "$bt_metadata" ] || safe_target_fail "managed install metadata is missing or not a regular file: $bt_metadata"
  [ "$(wc -c < "$bt_metadata" | tr -d '[:space:]')" -le 65536 ] || safe_target_fail "managed install metadata exceeds the size limit"
  bt_hash=$(sed -n 's/^  "managed_install_files_sha256": "\([0-9A-Fa-f]\{64\}\)",$/\1/p' "$bt_metadata")
  [ "$(printf '%s\n' "$bt_hash" | wc -l | tr -d '[:space:]')" = 1 ] || safe_target_fail "managed app inventory digest is missing or ambiguous"
  assert_managed_tree_inventory "$bt_app_root" blue-tanuki-install.json blue-tanuki-managed-files.txt "$bt_hash"
}

assert_managed_product_runtime_inventory() {
  bt_app_root=$1
  bt_runtime_root=$2
  bt_metadata="$bt_app_root/blue-tanuki-install.json"
  [ -f "$bt_metadata" ] && [ ! -L "$bt_metadata" ] || safe_target_fail "managed install metadata is missing or not a regular file: $bt_metadata"
  [ "$(wc -c < "$bt_metadata" | tr -d '[:space:]')" -le 65536 ] || safe_target_fail "managed install metadata exceeds the size limit"
  bt_hash=$(sed -n 's/^  "managed_runtime_files_sha256": "\([0-9A-Fa-f]\{64\}\)",\{0,1\}$/\1/p' "$bt_metadata")
  [ "$(printf '%s\n' "$bt_hash" | wc -l | tr -d '[:space:]')" = 1 ] || safe_target_fail "managed runtime inventory digest is missing or ambiguous"
  assert_managed_tree_inventory "$bt_runtime_root" __no_metadata__ blue-tanuki-runtime-files.txt "$bt_hash"
}

assert_managed_product_install_inventories() {
  assert_managed_product_app_inventory "$1"
  assert_managed_product_runtime_inventory "$1" "$2"
}

assert_not_same_target() {
  left=$(trim_trailing_slashes "$1")
  right=$(trim_trailing_slashes "$2")
  [ "$left" != "$right" ] || safe_target_fail "$3 must not equal $4: $left"
}

assert_not_ancestor_target() {
  parent=$(trim_trailing_slashes "$1")
  child=$(trim_trailing_slashes "$2")
  if path_is_same_or_descendant "$child" "$parent"; then
    safe_target_fail "$3 must not contain $4: $parent contains $child"
  fi
}

assert_no_overlap_target() {
  left=$(trim_trailing_slashes "$1")
  right=$(trim_trailing_slashes "$2")
  if path_is_same_or_descendant "$left" "$right" || path_is_same_or_descendant "$right" "$left"; then
    safe_target_fail "$3 and $4 must not overlap: $left ; $right"
  fi
}

assert_same_or_disjoint_target() {
  left=$(trim_trailing_slashes "$1")
  right=$(trim_trailing_slashes "$2")
  [ "$left" = "$right" ] || assert_no_overlap_target "$left" "$right" "$3" "$4"
}

assert_no_symlinks_in_tree() {
  bt_root=$1
  bt_label=$2
  [ -d "$bt_root" ] || safe_target_fail "$bt_label is not a directory: $bt_root"
  [ ! -L "$bt_root" ] || safe_target_fail "$bt_label is a symlink: $bt_root"
  bt_links=$(find "$bt_root" -type l -print -quit 2>/dev/null) || safe_target_fail "$bt_label could not be inspected safely: $bt_root"
  [ -z "$bt_links" ] || safe_target_fail "$bt_label contains a symlink: $bt_links"
}

assert_metadata_path_value() {
  bt_value=$1
  bt_label=$2
  bt_backtick=$(printf '\140')
  case "$bt_value" in
    *'='*|*'"'*|*'$'*|*"$bt_backtick"*|*"$(printf '\r')"*) safe_target_fail "$bt_label cannot be represented safely in the ownership marker or launcher" ;;
  esac
  [ "$(printf '%s' "$bt_value" | wc -l | tr -d '[:space:]')" = 0 ] || safe_target_fail "$bt_label contains a line break"
}

assert_product_owner_marker() {
  bt_marker=$1
  bt_expected_kind=$2
  bt_expected_install=$3
  bt_expected_data=$4
  bt_expected_config=$5
  bt_expected_runtime=$6
  bt_expected_bin=$7
  bt_expected_platform=$8
  bt_expected_surface=$9
  [ -f "$bt_marker" ] && [ ! -L "$bt_marker" ] || safe_target_fail "product ownership marker is missing or not a regular file: $bt_marker"
  [ "$(wc -l < "$bt_marker" | tr -d '[:space:]')" = 10 ] || safe_target_fail "product ownership marker has an unexpected shape: $bt_marker"
  grep -Fqx 'schema_version=1' "$bt_marker" || safe_target_fail "unsupported product ownership marker schema: $bt_marker"
  grep -Fqx 'product_id=blue-tanuki-product' "$bt_marker" || safe_target_fail "unrecognized product ownership marker: $bt_marker"
  grep -Fqx "root_kind=$bt_expected_kind" "$bt_marker" || safe_target_fail "product ownership marker root kind does not match: $bt_marker"
  grep -Fqx "install_root=$bt_expected_install" "$bt_marker" || safe_target_fail "product ownership marker install path does not match: $bt_marker"
  grep -Fqx "data_root=$bt_expected_data" "$bt_marker" || safe_target_fail "product ownership marker data path does not match: $bt_marker"
  grep -Fqx "config_root=$bt_expected_config" "$bt_marker" || safe_target_fail "product ownership marker config path does not match: $bt_marker"
  grep -Fqx "runtime_root=$bt_expected_runtime" "$bt_marker" || safe_target_fail "product ownership marker runtime path does not match: $bt_marker"
  grep -Fqx "bin_root=$bt_expected_bin" "$bt_marker" || safe_target_fail "product ownership marker bin path does not match: $bt_marker"
  grep -Fqx "platform=$bt_expected_platform" "$bt_marker" || safe_target_fail "product ownership marker platform does not match: $bt_marker"
  grep -Fqx "surface_file=$bt_expected_surface" "$bt_marker" || safe_target_fail "product ownership marker surface path does not match: $bt_marker"
}

write_product_owner_marker() {
  bt_marker=$1
  bt_root_kind=$2
  bt_install_root=$3
  bt_data_root=$4
  bt_config_root=$5
  bt_runtime_root=$6
  bt_bin_root=$7
  bt_platform=$8
  bt_surface=$9
  for bt_pair in "install_root:$bt_install_root" "data_root:$bt_data_root" "config_root:$bt_config_root" "runtime_root:$bt_runtime_root" "bin_root:$bt_bin_root" "platform:$bt_platform" "surface_file:$bt_surface"; do
    bt_key=${bt_pair%%:*}
    bt_value=${bt_pair#*:}
    assert_metadata_path_value "$bt_value" "$bt_key"
  done
  bt_temporary="$bt_marker.tmp.$$"
  [ ! -e "$bt_temporary" ] && [ ! -L "$bt_temporary" ] || safe_target_fail "ownership marker staging path already exists: $bt_temporary"
  {
    printf 'schema_version=1\n'
    printf 'product_id=blue-tanuki-product\n'
    printf 'root_kind=%s\n' "$bt_root_kind"
    printf 'install_root=%s\n' "$bt_install_root"
    printf 'data_root=%s\n' "$bt_data_root"
    printf 'config_root=%s\n' "$bt_config_root"
    printf 'runtime_root=%s\n' "$bt_runtime_root"
    printf 'bin_root=%s\n' "$bt_bin_root"
    printf 'platform=%s\n' "$bt_platform"
    printf 'surface_file=%s\n' "$bt_surface"
  } > "$bt_temporary"
  chmod 600 "$bt_temporary"
  mv -- "$bt_temporary" "$bt_marker"
}

assert_managed_product_app_identity() {
  bt_app_root=$1
  bt_expected_install_root=$2
  bt_data_root=$3
  bt_config_root=$4
  bt_expected_runtime_root=$5
  bt_bin_root=$6
  bt_platform=$7
  bt_surface=$8
  assert_no_symlinks_in_tree "$bt_app_root" INSTALL_ROOT
  assert_product_owner_marker "$bt_app_root/.blue-tanuki-owner" install "$bt_expected_install_root" "$bt_data_root" "$bt_config_root" "$bt_expected_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
  for bt_relative in \
    apps/gateway/dist/main.js \
    blue-tanuki-install.json \
    blue-tanuki-managed-files.txt \
    blue-tanuki-install.env \
    BlueTanukiLauncher.sh \
    BlueTanukiUninstall.sh \
    BlueTanuki.sh \
    install/unix/safe-target.sh
  do
    bt_file="$bt_app_root/$bt_relative"
    [ -f "$bt_file" ] && [ ! -L "$bt_file" ] || safe_target_fail "managed product install is missing a regular file: $bt_relative"
  done
  bt_metadata="$bt_app_root/blue-tanuki-install.json"
  bt_manifest="$bt_app_root/blue-tanuki-package-manifest.json"
  [ -f "$bt_metadata" ] && [ ! -L "$bt_metadata" ] || safe_target_fail "managed install metadata is not a regular file"
  [ "$(wc -c < "$bt_metadata" | tr -d '[:space:]')" -le 65536 ] || safe_target_fail "managed install metadata exceeds the size limit"
  [ -f "$bt_manifest" ] && [ ! -L "$bt_manifest" ] || safe_target_fail "installed package manifest is missing or not a regular file"
  [ "$(wc -c < "$bt_manifest" | tr -d '[:space:]')" -le 1048576 ] || safe_target_fail "installed package manifest exceeds the size limit"
  grep -Fqx '  "schema_version": 3,' "$bt_metadata" || safe_target_fail "managed install metadata schema is not recognized"
  grep -Fqx '  "product_id": "blue-tanuki-product-install",' "$bt_metadata" || safe_target_fail "managed install metadata does not identify BLUE-TANUKI"
  for bt_pair in \
    "install_root:$bt_expected_install_root" \
    "data_root:$bt_data_root" \
    "config_root:$bt_config_root" \
    "runtime_root:$bt_expected_runtime_root" \
    "bin_root:$bt_bin_root" \
    "platform:$bt_platform"; do
    bt_key=${bt_pair%%:*}
    bt_value=${bt_pair#*:}
    grep -Fqx "  \"$bt_key\": \"$bt_value\"," "$bt_metadata" ||
      grep -Fqx "  \"$bt_key\": \"$bt_value\"" "$bt_metadata" || safe_target_fail "managed install metadata does not match $bt_key"
  done
  bt_metadata_hash=$(sed -n 's/^  "package_manifest_sha256": "\([0-9A-Fa-f]\{64\}\)",$/\1/p' "$bt_metadata")
  [ "$(printf '%s\n' "$bt_metadata_hash" | wc -l | tr -d '[:space:]')" = 1 ] || safe_target_fail "managed install metadata package digest is missing or ambiguous"
  bt_actual_hash=$(sha256_file "$bt_manifest")
  [ "$(printf '%s' "$bt_metadata_hash" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$bt_actual_hash" | tr '[:upper:]' '[:lower:]')" ] || safe_target_fail "installed package manifest digest does not match install metadata"
  case "$bt_platform" in
    linux)
      grep -Fqx '  "schema_version": 2,' "$bt_manifest" || safe_target_fail "installed Linux package manifest schema is not recognized"
      grep -Fqx '  "package_type": "linux-x64-tar-installer",' "$bt_manifest" ||
        safe_target_fail "installed Linux package type is not recognized"
      ;;
    macos)
      grep -Fqx '  "schema_version": 1,' "$bt_manifest" || safe_target_fail "installed macOS package manifest schema is not recognized"
      grep -Eq '^  "package_type": "macos-(x64|arm64)-tar-installer",?$' "$bt_manifest" ||
        safe_target_fail "installed macOS package type is not recognized"
      ;;
    *)
      safe_target_fail "installed package platform is not recognized"
      ;;
  esac
  grep -Fqx '  "name": "blue-tanuki",' "$bt_manifest" || safe_target_fail "installed package manifest does not identify BLUE-TANUKI"
  assert_managed_product_app_inventory "$bt_app_root"
}

assert_managed_product_install() {
  bt_install_root=$1
  bt_data_root=$2
  bt_config_root=$3
  bt_runtime_root=$4
  bt_bin_root=$5
  bt_platform=$6
  bt_surface=$7
  bt_metadata_install_root=${8:-$bt_install_root}
  bt_metadata_runtime_root=${9:-$bt_runtime_root}
  assert_managed_product_app_identity "$bt_install_root" "$bt_metadata_install_root" "$bt_data_root" "$bt_config_root" "$bt_metadata_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
  assert_no_symlinks_in_tree "$bt_runtime_root" RUNTIME_ROOT
  bt_node_path=$(find "$bt_runtime_root" -type f -path '*/bin/node' -print -quit 2>/dev/null) || safe_target_fail "bundled runtime could not be inspected: $bt_runtime_root"
  [ -n "$bt_node_path" ] && [ -x "$bt_node_path" ] && [ ! -L "$bt_node_path" ] || safe_target_fail "managed product runtime has no regular executable node: $bt_runtime_root"
  case "$bt_node_path" in
    "$bt_runtime_root"/*) bt_node_relative=${bt_node_path#"$bt_runtime_root"/} ;;
    *) safe_target_fail "bundled Node path is outside the runtime root: $bt_node_path" ;;
  esac
  bt_metadata_node_path="$bt_metadata_runtime_root/$bt_node_relative"
  grep -Fqx "  \"node_exe\": \"$bt_metadata_node_path\"," "$bt_install_root/blue-tanuki-install.json" || safe_target_fail "managed install metadata does not identify its bundled Node runtime"
  assert_managed_product_runtime_inventory "$bt_install_root" "$bt_runtime_root"
  if [ "$bt_config_root" = "$bt_data_root" ]; then
    assert_product_owner_marker "$bt_data_root/.blue-tanuki-owner" shared-root "$bt_metadata_install_root" "$bt_data_root" "$bt_config_root" "$bt_metadata_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
  else
    assert_product_owner_marker "$bt_data_root/.blue-tanuki-owner" data "$bt_metadata_install_root" "$bt_data_root" "$bt_config_root" "$bt_metadata_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
    assert_product_owner_marker "$bt_config_root/.blue-tanuki-owner" config "$bt_metadata_install_root" "$bt_data_root" "$bt_config_root" "$bt_metadata_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
  fi
}

assert_product_data_root_markers() {
  bt_install_root=$1
  bt_data_root=$2
  bt_config_root=$3
  bt_runtime_root=$4
  bt_bin_root=$5
  bt_platform=$6
  bt_surface=$7
  [ -d "$bt_data_root" ] && [ ! -L "$bt_data_root" ] || safe_target_fail "managed product data root is missing or not a directory: $bt_data_root"
  [ -d "$bt_config_root" ] && [ ! -L "$bt_config_root" ] || safe_target_fail "managed product config root is missing or not a directory: $bt_config_root"
  if [ "$bt_config_root" = "$bt_data_root" ]; then
    assert_product_owner_marker "$bt_data_root/.blue-tanuki-owner" shared-root "$bt_install_root" "$bt_data_root" "$bt_config_root" "$bt_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
  else
    assert_product_owner_marker "$bt_data_root/.blue-tanuki-owner" data "$bt_install_root" "$bt_data_root" "$bt_config_root" "$bt_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
    assert_product_owner_marker "$bt_config_root/.blue-tanuki-owner" config "$bt_install_root" "$bt_data_root" "$bt_config_root" "$bt_runtime_root" "$bt_bin_root" "$bt_platform" "$bt_surface"
  fi
}

assert_legacy_product_install() {
  bt_install_root=$1
  bt_data_root=$2
  bt_config_root=$3
  bt_runtime_root=$4
  bt_bin_root=$5
  bt_platform=$6
  safe_target_fail "legacy install has no installed-file inventory, so recursive replacement is unsafe. No files were changed; preserve or relocate it before migration."
  assert_no_symlinks_in_tree "$bt_install_root" legacy_INSTALL_ROOT
  assert_no_symlinks_in_tree "$bt_runtime_root" legacy_RUNTIME_ROOT
  [ -d "$bt_data_root" ] && [ ! -L "$bt_data_root" ] || safe_target_fail "legacy product data root is missing or not a directory: $bt_data_root"
  [ -d "$bt_config_root" ] && [ ! -L "$bt_config_root" ] || safe_target_fail "legacy product config root is missing or not a directory: $bt_config_root"
  for bt_relative in \
    apps/gateway/dist/main.js \
    blue-tanuki-install.json \
    blue-tanuki-install.env \
    BlueTanukiLauncher.sh \
    BlueTanukiUninstall.sh \
    BlueTanuki.sh \
    install/unix/safe-target.sh
  do
    bt_file="$bt_install_root/$bt_relative"
    [ -f "$bt_file" ] && [ ! -L "$bt_file" ] || safe_target_fail "legacy product install is missing a regular file: $bt_relative"
  done
  bt_metadata="$bt_install_root/blue-tanuki-install.json"
  [ "$(wc -c < "$bt_metadata" | tr -d '[:space:]')" -le 65536 ] || safe_target_fail "legacy product install metadata exceeds the size limit"
  grep -Fqx '  "schema_version": 1,' "$bt_metadata" || safe_target_fail "legacy product install metadata schema is not recognized"
  grep -Fqx "  \"install_root\": \"$bt_install_root\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not match INSTALL_ROOT"
  grep -Fqx "  \"data_root\": \"$bt_data_root\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not match DATA_ROOT"
  grep -Fqx "  \"config_root\": \"$bt_config_root\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not match CONFIG_ROOT"
  grep -Fqx "  \"runtime_root\": \"$bt_runtime_root\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not match RUNTIME_ROOT"
  grep -Fqx "  \"bin_root\": \"$bt_bin_root\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not match BIN_ROOT"
  grep -Fqx "  \"platform\": \"$bt_platform\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not match platform"
  bt_node_path=$(find "$bt_runtime_root" -type f -path '*/bin/node' -print -quit 2>/dev/null) || safe_target_fail "legacy product runtime could not be inspected"
  [ -n "$bt_node_path" ] && [ -x "$bt_node_path" ] && [ ! -L "$bt_node_path" ] || safe_target_fail "legacy product runtime has no regular executable node"
  grep -Fqx "  \"node_exe\": \"$bt_node_path\"," "$bt_metadata" || safe_target_fail "legacy product install metadata does not identify its bundled Node runtime"
}
