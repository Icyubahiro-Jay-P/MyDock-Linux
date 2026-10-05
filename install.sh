#!/usr/bin/env bash
# MY DOCK FINDER FOR LINUX bootstrap: downloads the latest release installer and runs it.
#   curl -fsSL https://raw.githubusercontent.com/Icyubahiro-Jay-P/MyDock-Linux/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Icyubahiro-Jay-P/MyDock-Linux/main/install.sh | bash -s -- --uninstall
set -euo pipefail

main() {
    local url="${MYDOCK_URL:-https://github.com/Icyubahiro-Jay-P/MyDock-Linux/releases/latest/download/dock-install.sh}"
    tmp=$(mktemp) sums=$(mktemp)
    trap 'rm -f "$tmp" "$sums"' EXIT
    if command -v curl >/dev/null; then dl() { curl --proto '=https' --proto-redir '=https' -fsSL "$1" -o "$2"; }
    elif command -v wget >/dev/null; then dl() { wget -q --https-only -O "$2" "$1"; }
    else echo "MY DOCK FINDER FOR LINUX: need curl or wget to download the installer (sudo apt install curl)." >&2; exit 1; fi
    dl "$url" "$tmp"
    dl "${url%/*}/SHA256SUMS" "$sums"
    want=$(awk '$2=="dock-install.sh"||$2=="*dock-install.sh"{print $1}' "$sums")
    [[ -n $want && $(sha256sum "$tmp" | cut -d' ' -f1) == "$want" ]] || { echo "MY DOCK FINDER FOR LINUX: checksum check failed, nothing was installed." >&2; exit 1; }
    bash "$tmp" "$@"
}

main "$@"
