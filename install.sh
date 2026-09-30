#!/usr/bin/env bash
# MY DOCK FINDER FOR LINUX bootstrap: downloads the latest release installer and runs it.
#   curl -fsSL https://raw.githubusercontent.com/jay-p/MyDock-Linux/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jay-p/MyDock-Linux/main/install.sh | bash -s -- --uninstall
set -euo pipefail

main() {
    local url="${MYDOCK_URL:-https://github.com/jay-p/MyDock-Linux/releases/latest/download/dock-install.sh}"
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    if command -v curl >/dev/null; then curl -fsSL "$url" -o "$tmp"
    elif command -v wget >/dev/null; then wget -q --https-only -O "$tmp" "$url"
    else echo "MY DOCK FINDER FOR LINUX: need curl or wget to download the installer (sudo apt install curl)." >&2; exit 1; fi
    bash "$tmp" "$@"
}

main "$@"
