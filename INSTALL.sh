#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OS_NAME=$(uname -s 2>/dev/null || printf unknown)

case "$OS_NAME" in
  Darwin)
    exec sh "$SCRIPT_DIR/INSTALL_MACOS.sh" "$@"
    ;;
  Linux)
    exec sh "$SCRIPT_DIR/INSTALL_LINUX.sh" "$@"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "BLUE-TANUKI Windows install uses INSTALL_WINDOWS.cmd from this folder." >&2
    exit 2
    ;;
  *)
    echo "Unsupported OS for INSTALL.sh: $OS_NAME" >&2
    echo "Use INSTALL_WINDOWS.cmd on Windows, INSTALL_MACOS.command on macOS, or INSTALL_LINUX.sh on Linux." >&2
    exit 2
    ;;
esac
