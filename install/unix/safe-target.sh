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
  case "/$raw/" in
    *"/../"*|*"/./"*) safe_target_fail "$label contains relative traversal: $raw" ;;
  esac
  if [ -L "$raw" ]; then
    safe_target_fail "$label points to a symlink: $raw"
  fi
  dir=$(dirname -- "$raw")
  base=$(basename -- "$raw")
  if [ -d "$dir" ]; then
    parent=$(CDPATH= cd -P -- "$dir" && pwd) || safe_target_fail "$label parent cannot be resolved: $dir"
    trim_trailing_slashes "$parent/$base"
    return
  fi
  trim_trailing_slashes "$raw"
}

is_denied_broad_target() {
  target=$(trim_trailing_slashes "$1")
  home=$(trim_trailing_slashes "$HOME")
  case "$target" in
    ""|"/"|".") return 0 ;;
  esac
  for denied in \
    "$home" \
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
  if is_denied_broad_target "$target" || [ "$target" = "$(trim_trailing_slashes "$HOME/.local/bin")" ]; then
    safe_target_fail "$2 points to an unsafe broad path: $target"
  fi
  printf '%s\n' "$target"
}

safe_container_target() {
  target=$(canonical_target_path "$1" "$2")
  if is_denied_broad_target "$target"; then
    safe_target_fail "$2 points to an unsafe broad path: $target"
  fi
  printf '%s\n' "$target"
}

safe_user_bin_target() {
  target=$(canonical_target_path "$1" "$2")
  home=$(trim_trailing_slashes "$HOME")
  if is_denied_broad_target "$target" && [ "$target" != "$home/.local/bin" ]; then
    safe_target_fail "$2 points to an unsafe broad path: $target"
  fi
  printf '%s\n' "$target"
}

assert_not_same_target() {
  left=$(trim_trailing_slashes "$1")
  right=$(trim_trailing_slashes "$2")
  [ "$left" != "$right" ] || safe_target_fail "$3 must not equal $4: $left"
}
