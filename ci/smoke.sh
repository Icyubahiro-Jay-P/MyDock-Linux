#!/usr/bin/env bash
# Smoke test: start a headless GNOME Shell with the extension, flip every on/off setting, disable and
# re-enable it, and fail if the shell logs any JavaScript error or warning. Run from the repo root:
#   bash ci/smoke.sh
# Needs gnome-shell, dbus-run-session, gsettings (dconf) and glib-compile-schemas. Safe to run in a
# container; on a desktop it uses a private D-Bus session and leaves the real session alone.
set -euo pipefail

UUID=$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')
SCHEMA=org.gnome.shell.extensions.mydock
WAIT=${SMOKE_WAIT:-60}  # seconds to wait for the extension to come up

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" XDG_DATA_HOME="$work/home/.local/share"
export XDG_RUNTIME_DIR="$work/run" XDG_CACHE_HOME="$work/home/.cache"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
dest="$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
mkdir -p "$dest"
tar cf - -C extension --exclude='*.test.mjs' --exclude=gschemas.compiled . | tar xf - -C "$dest"
glib-compile-schemas "$dest/schemas"
log="$work/shell.log"

# Containers usually have no system bus; the shell refuses to start without one. A private bus
# stands in (logind, accounts and friends are simply missing from it, which the shell tolerates).
if [ ! -S /run/dbus/system_bus_socket ]; then
    dbus-daemon --session --fork --address="unix:path=$work/system_bus_socket" \
        --print-pid=3 3>"$work/system_bus.pid" >/dev/null 2>&1
    trap 'kill "$(cat "$work/system_bus.pid")" 2>/dev/null; rm -rf "$work"' EXIT
    export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$work/system_bus_socket"
fi

echo "GNOME Shell: $(gnome-shell --version)"
# shellcheck disable=SC2016 # expanded by the inner shell
dbus-run-session -- bash -c '
    set -u
    uuid=$1 schema=$2 dest=$3 log=$4 wait=$5
    gs() { gsettings --schemadir "$dest/schemas" "$@"; }
    gsettings set org.gnome.shell enabled-extensions "[\"$uuid\"]"
    gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11 >"$log" 2>&1 &
    shell=$!
    ext() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method "org.gnome.Shell.Extensions.$1" "$uuid" 2>/dev/null; }
    # ExtensionState: 1 is ACTIVE (GNOME 46 to 50)
    active() { ext GetExtensionInfo | grep -q "'"'"'state'"'"': <1.0>"; }
    for _ in $(seq "$wait"); do
        active && break
        kill -0 "$shell" 2>/dev/null || { echo "gnome-shell exited early"; exit 1; }
        sleep 1
    done
    active || { echo "Extension did not become active: $(ext GetExtensionInfo)"; kill "$shell"; exit 1; }
    echo "Extension is active"
    sleep 3

    # every boolean setting off and back on: runs each feature destroy() and constructor live
    for key in $(gs list-keys "$schema"); do
        [ "$(gs range "$schema" "$key")" = "type b" ] || continue
        old=$(gs get "$schema" "$key")
        new=true; [ "$old" = true ] && new=false
        gs set "$schema" "$key" "$new"; sleep 0.5
        gs set "$schema" "$key" "$old"; sleep 0.5
    done

    # full disable and enable: every destroy() runs, then every constructor again
    ext DisableExtension >/dev/null; sleep 2
    ext EnableExtension >/dev/null; sleep 3
    ok=0; active && ok=1
    kill "$shell"; wait "$shell" 2>/dev/null
    [ "$ok" = 1 ] || { echo "Extension is not active after disable and enable"; exit 1; }
    echo "Extension is active after disable and enable"
' smoke "$UUID" "$SCHEMA" "$dest" "$log" "$WAIT" || { echo "--- gnome-shell log ---"; cat "$log"; exit 1; }

# Anything the extension (or a shell API it misuses) logs as an error fails the run.
errors=$(grep -E 'JS ERROR|JS WARNING|Gjs-CRITICAL|had error|MyDock|MY DOCK FINDER' "$log" || true)
if [ -n "$errors" ]; then
    echo "--- errors in the gnome-shell log ---"
    echo "$errors"
    echo "--- full log ---"
    cat "$log"
    exit 1
fi
echo "Smoke test passed: no errors logged"
