#!/usr/bin/env bash
# MY DOCK FINDER FOR LINUX single-file installer for GNOME Shell 46-48 (Ubuntu 24.04+).
#   bash dock-install.sh              install / update
#   bash dock-install.sh --uninstall  remove and restore the previous dock
set -euo pipefail

UUID="mydock@jay-p"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
STATE="$HOME/.local/share/mydock-disabled-extensions"
SYS="/usr/share/gnome-shell/extensions/$UUID"
# Other docks are turned off (restored on uninstall). Minimize-effect extensions only get a warning.
DOCKS=(ubuntu-dock@ubuntu.com dash-to-dock@micxgx.gmail.com dash2dock-lite@icedman.github.com)
EFFECTS=(compiz-alike-magic-lamp-effect@hermes83.github.com burn-my-windows@schneegans.github.com compiz-windows-effect@hermes83.github.com)
# Keep in sync with "shell-version" in metadata.json: GNOME refuses to load the extension on other versions.
MIN_SHELL=46 MAX_SHELL=48

is_enabled()  { gsettings get org.gnome.shell enabled-extensions | grep -q "'$1'"; }
is_disabled() { gsettings get org.gnome.shell disabled-extensions | grep -q "'$1'"; }
# Ubuntu Dock is a session-mode extension: it is on without being in enabled-extensions,
# so treat any installed dock that is not explicitly disabled as running.
is_installed() { [[ -d "$HOME/.local/share/gnome-shell/extensions/$1" || -d "/usr/share/gnome-shell/extensions/$1" ]]; }

# Edit enabled-extensions directly: works even before the shell has seen the extension (Wayland).
set_enabled() { # uuid on|off
    python3 - "$1" "$2" <<'PY'
import ast, subprocess, sys
uuid, on = sys.argv[1], sys.argv[2] == "on"
for key, want in (("enabled-extensions", on), ("disabled-extensions", not on)):
    raw = subprocess.check_output(["gsettings", "get", "org.gnome.shell", key], text=True).strip()
    cur = [] if raw.startswith("@as") else ast.literal_eval(raw)
    cur = [u for u in cur if u != uuid] + ([uuid] if want else [])
    subprocess.check_call(["gsettings", "set", "org.gnome.shell", key, str(cur)])
PY
}

# Undo the window button changes in case the shell is not running to do it on disable.
restore_windows() {
    local dir="$DEST/schemas" saved
    [[ -f "$dir/gschemas.compiled" ]] || dir="$SYS/schemas"
    if [[ -f "$dir/gschemas.compiled" ]] &&
        saved=$(gsettings --schemadir "$dir" get org.gnome.shell.extensions.mydock saved-button-layout 2>/dev/null) &&
        [[ "$saved" != "''" ]]; then
        gsettings set org.gnome.desktop.wm.preferences button-layout "$saved"
        gsettings --schemadir "$dir" reset org.gnome.shell.extensions.mydock saved-button-layout
    fi
    local f
    for f in "${XDG_CONFIG_HOME:-$HOME/.config}"/gtk-{3,4}.0/gtk.css; do
        [[ -f "$f" ]] && sed -i '/mydock-traffic-lights start/,/mydock-traffic-lights end/d' "$f"
    done
    return 0
}

if [[ "${1:-}" == "--uninstall" ]]; then
    set_enabled "$UUID" off
    restore_windows
    rm -rf "$DEST"
    if [[ -f "$STATE" ]]; then
        while read -r u; do [[ -n "$u" ]] && set_enabled "$u" on; done < "$STATE"
        rm -f "$STATE"
    fi
    echo "MY DOCK FINDER FOR LINUX removed. Log out and back in to finish."
    [[ -d "$SYS" ]] && echo "System-wide files stay in $SYS (remove with: sudo apt remove dock)."
    exit 0
fi

command -v gnome-shell >/dev/null || { echo "GNOME Shell not found. MY DOCK FINDER FOR LINUX needs GNOME." >&2; exit 1; }
ver=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
(( ver >= MIN_SHELL )) || { echo "GNOME Shell $ver is too old, need $MIN_SHELL or newer." >&2; exit 1; }
(( ver <= MAX_SHELL )) || { echo "GNOME Shell $ver is not supported yet (MY DOCK FINDER FOR LINUX supports $MIN_SHELL-$MAX_SHELL). See https://github.com/Icyubahiro-Jay-P/MyDock-Linux/issues" >&2; exit 1; }

# No payload after the marker = shipped standalone as dock by the .deb.
if [[ -n "$(awk 'f{print;exit} /^__PAYLOAD__$/{f=1}' "$0")" ]]; then
    echo "Installing MY DOCK FINDER FOR LINUX to $DEST"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    sed '1,/^__PAYLOAD__$/d' "$0" | base64 -d | tar xz -C "$DEST"
    glib-compile-schemas "$DEST/schemas"
elif [[ -d "$SYS" ]]; then
    echo "Using system-wide MY DOCK FINDER FOR LINUX at $SYS"
    # A per-user copy wins over the package files, so drop any old one.
    [[ -d "$DEST" ]] && { echo "Removing older per-user copy at $DEST"; rm -rf "$DEST"; }
else
    echo "MY DOCK FINDER FOR LINUX files not found: no payload in $0 and no $SYS. Reinstall the dock package or use dock-install.sh." >&2; exit 1
fi

mkdir -p "${STATE%/*}"
: > "$STATE.tmp"
[[ -f "$STATE" ]] && cat "$STATE" >> "$STATE.tmp"
for u in "${DOCKS[@]}"; do
    if is_installed "$u" && ! is_disabled "$u"; then
        echo "Turning off $u (restored by --uninstall)"
        set_enabled "$u" off
        echo "$u" >> "$STATE.tmp"
    fi
done
sort -u "$STATE.tmp" > "$STATE"; rm -f "$STATE.tmp"

for u in "${EFFECTS[@]}"; do
    is_enabled "$u" && echo "Note: $u also animates minimize. Turn it off, or set MY DOCK FINDER FOR LINUX's effect to 'none' in its settings."
done

set_enabled "$UUID" on
echo
echo "Done. Log out and back in to start MY DOCK FINDER FOR LINUX (Wayland cannot reload the shell)."
echo "Settings: gnome-extensions prefs $UUID"
exit 0
# shellcheck disable=SC2317 # marker line, never executed: the base64 payload follows
__PAYLOAD__
