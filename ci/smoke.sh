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
# run from a desktop terminal, these would point the headless shell at the real session
unset DISPLAY GNOME_SHELL_SESSION_MODE GNOME_SETUP_DISPLAY WAYLAND_DISPLAY
export LANG=C.UTF-8 LC_ALL=C.UTF-8

work=$(mktemp -d)
# short path: unix socket paths are capped at 108 bytes and the shell puts its sockets here
run=$(mktemp -d /tmp/smk.XXXXXX)
trap 'rm -rf "$work" "$run"' EXIT
export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" XDG_DATA_HOME="$work/home/.local/share"
export XDG_RUNTIME_DIR="$run" XDG_CACHE_HOME="$work/home/.cache"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p "$HOME/Desktop"  # Ubuntu's desktop-icons extension logs a JS error without it
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
    trap 'kill "$(cat "$work/system_bus.pid")" 2>/dev/null; rm -rf "$work" "$run"' EXIT
    export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$work/system_bus_socket"
fi

echo "GNOME Shell: $(gnome-shell --version)"
# shellcheck disable=SC2016 # expanded by the inner shell
dbus-run-session -- bash -c '
    set -u
    uuid=$1 schema=$2 dest=$3 log=$4 wait=$5
    export LANG=C.UTF-8 LC_ALL=C.UTF-8
    gs() { gsettings --schemadir "$dest/schemas" "$@"; }
    gsettings set org.gnome.shell enabled-extensions "[\"$uuid\"]"
    # no update checks against GitHub during the test
    gs set "$schema" check-updates false
    # prevent locale1 null deref in GNOME 47: set input source via gsettings (GVariant format)
    gsettings set org.gnome.desktop.input-sources sources "@as [('xkb', 'us')]"
    # under gdb when installed (CI installs it where the shell crashes natively): a segfault then
    # prints a backtrace into the log
    dbg=()
    command -v gdb >/dev/null && dbg=(env DEBUGINFOD_URLS= gdb -q -batch
        -ex "handle SIGPIPE SIGUSR1 SIGUSR2 SIGCHLD nostop noprint pass"
        -ex run -ex "thread apply all bt 30" --args)
    "${dbg[@]}" gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11 >"$log" 2>&1 &
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
    active || { echo "Extension did not become active: $(ext GetExtensionInfo)"; kill "$shell"; echo "--- gnome-shell log (first 200 lines) ---"; head -n 200 "$log"; exit 1; }
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

    # every enum setting through each of its values, then back
    for key in $(gs list-keys "$schema"); do
        set -- $(gs range "$schema" "$key")
        [ "$1" = enum ] || continue
        shift
        old=$(gs get "$schema" "$key")
        for v in "$@"; do gs set "$schema" "$key" "$v"; sleep 0.5; done
        gs set "$schema" "$key" "$old"; sleep 0.5
    done

    # dark-mode is an int key: light, dark, then back to follow system
    for v in 1 2 0; do gs set "$schema" dark-mode "$v"; sleep 0.5; done

    # full disable and enable: every destroy() runs, then every constructor again
    ext DisableExtension >/dev/null; sleep 2
    ext EnableExtension >/dev/null; sleep 3
    ok=0; active && ok=1
    # only the log up to here is checked: killing the shell finalizes the actors of every extension,
    # and distro extensions (Ubuntu dock, DING) log GC criticals then that are not ours
    wc -l <"$log" >"$log.lines"
    kill "$shell"; wait "$shell" 2>/dev/null
    [ "$ok" = 1 ] || { echo "Extension is not active after disable and enable"; exit 1; }
    echo "Extension is active after disable and enable"
' smoke "$UUID" "$SCHEMA" "$dest" "$log" "$WAIT" || {
    echo "--- gnome-shell log ---"
    cat "$log"
    if command -v rpm >/dev/null; then
        echo "--- Fedora packages ---"
        rpm -q gnome-shell mutter gnome-desktop4 glib2 ibus gnome-settings-daemon colord 2>/dev/null || true
    fi
    exit 1
}

# prefs.js runs in the Extensions app, not the shell: import it under gjs so a syntax or import
# error fails here too. It needs the app's resource bundle and gnome-shell's private typelibs.
shew=$(find /usr/lib /usr/lib64 -name Shew-0.typelib -path '*gnome-shell*' -print -quit 2>/dev/null || true)
cat > "$work/prefs.mjs" <<'JS'
import Gio from 'gi://Gio';
Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
const prefs = await import(`file://${ARGV[0]}/prefs.js`);
if (typeof prefs.default !== 'function')
    throw new Error('prefs.js has no default export');
JS
GI_TYPELIB_PATH="${shew%/*}" gjs -m "$work/prefs.mjs" "$dest" || { echo "prefs.js failed to import"; exit 1; }
echo "prefs.js imports"

# Anything the extension (or a shell API it misuses) logs as an error fails the run.
# Distinguish infra (pre-extension) from extension errors by only scanning up to log.lines
errors=$(head -n "$(cat "$log.lines")" "$log" | grep -E 'JS ERROR|JS WARNING|Gjs-CRITICAL|had error|MyDock|MY DOCK FINDER' || true)
if [ -n "$errors" ]; then
    echo "--- errors in the gnome-shell log (extension) ---"
    echo "$errors"
    echo "--- full log ---"
    cat "$log"
    exit 1
fi
echo "Smoke test passed: no errors logged"
