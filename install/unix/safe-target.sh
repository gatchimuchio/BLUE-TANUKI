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
