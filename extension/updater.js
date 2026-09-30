// Updater - checks GitHub for a new release once a day and offers a one-click update.
// Per-user installs rerun the release's dock-install.sh; .deb installs go through pkexec apt-get.
// Downloads are verified against the release SHA256SUMS before anything runs.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Soup from 'gi://Soup?version=3.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {compareVersions} from './version.js';

// MYDOCK_UPDATE_* overrides are for testing against a local fake release.
const API = GLib.getenv('MYDOCK_UPDATE_API') ?? 'https://api.github.com/repos/Icyubahiro-Jay-P/MyDock-Linux/releases/latest';
const BASE = GLib.getenv('MYDOCK_UPDATE_BASE') ?? 'https://github.com/Icyubahiro-Jay-P/MyDock-Linux/releases/download';
const FIRST_DELAY = Number(GLib.getenv('MYDOCK_UPDATE_DELAY') ?? 60); // s after login, keeps startup fast
const RECHECK = 6 * 3600; // s between "is a check due?" wake-ups
const DAY = 24 * 3600;

// Runs outside the shell as: bash -c SCRIPT mydock-update <base-url> <user|deb> <version>.
// Inputs are positional args, never pasted into the script text.
const SCRIPT = `set -euo pipefail
base=$1 mode=$2 ver=$3
if [ "$mode" = deb ]; then
    f="dock_$ver"_all.deb
    command -v pkexec >/dev/null || { echo "pkexec not found. Run: curl -fLO $base/$f && sudo apt install ./$f"; exit 1; }
else
    f=dock-install.sh
fi
dl() { if command -v curl >/dev/null; then curl -fsSL --max-time 300 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi; }
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"
dl "$base/$f" "$f" || { echo "Download failed: $base/$f"; exit 1; }
dl "$base/SHA256SUMS" SHA256SUMS || { echo "Download failed: $base/SHA256SUMS"; exit 1; }
sha256sum -c --ignore-missing SHA256SUMS || { echo "Checksum check failed, nothing was installed."; exit 1; }
if [ "$mode" = deb ]; then pkexec apt-get install -y "$d/$f"; else bash "$f"; fi`;

export class Updater {
    constructor(ext) {
        this._ext = ext;
        this._cancel = new Gio.Cancellable();
        this._schedule(FIRST_DELAY);
    }

    _schedule(secs) {
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secs, () => {
            this._timer = 0;
            this._check();
            this._schedule(RECHECK);
            return GLib.SOURCE_REMOVE;
        });
    }

    _check() {
        const s = this._ext.settings;
        const now = Math.floor(Date.now() / 1000);
        if (now - s.get_int64('last-update-check') < DAY)
            return;
        this._session ??= new Soup.Session({user_agent: `MyDock/${this._ext.metadata['version-name']}`, timeout: 15});
        const msg = Soup.Message.new('GET', API);
        msg.request_headers.append('Accept', 'application/vnd.github+json');
        this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancel, (sess, res) => {
            try {
                const body = sess.send_and_read_finish(res);
                s.set_int64('last-update-check', now); // only once GitHub answered, so offline retries next wake-up
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${msg.get_status()}`);
                const ver = String(JSON.parse(new TextDecoder().decode(body.get_data())).tag_name).replace(/^v/, '');
                // the tag ends up in file names and URLs: digits and dots only
                if (!/^\d+(\.\d+)*$/.test(ver))
                    throw new Error(`odd tag ${ver}`);
                if (compareVersions(ver, this._ext.metadata['version-name']) > 0 && ver !== s.get_string('skipped-version'))
                    this._offer(ver);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.debug(`MY DOCK FINDER FOR LINUX: update check failed: ${e.message}`);
            }
        });
    }

    _offer(ver) {
        this._notify(`MY DOCK FINDER FOR LINUX ${ver} is available`, 'Update in one click. Your settings are kept.', [
            ['Update now', () => this._update(ver)],
            ['Skip this version', () => this._ext.settings?.set_string('skipped-version', ver)],
        ]);
    }

    _update(ver) {
        if (this._busy)
            return;
        this._busy = true;
        const mode = this._ext.path.startsWith('/usr/') ? 'deb' : 'user';
        this._notify('Updating MY DOCK FINDER FOR LINUX...', mode === 'deb' ? 'You will be asked for your password.' : '', [], true);
        const proc = Gio.Subprocess.new(['bash', '-c', SCRIPT, 'mydock-update', `${BASE}/v${ver}`, mode, ver],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        // Cancelling on destroy only stops waiting; a running install is left to finish.
        proc.communicate_utf8_async(null, this._cancel, (p, res) => {
            let out;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {
                return; // cancelled: the extension went away
            }
            this._busy = false;
            if (!p.get_successful()) {
                const last = out.trim().split('\n').pop() || `exit ${p.get_exit_status()}`;
                console.log(`MY DOCK FINDER FOR LINUX: update failed:\n${out}`);
                this._notify('MY DOCK FINDER FOR LINUX update failed', last);
            } else if (Meta.is_wayland_compositor()) {
                this._notify(`MY DOCK FINDER FOR LINUX updated to ${ver}`,
                    'Log out and back in to finish (Wayland cannot restart the shell). Open apps can save first; nothing closes until you confirm.',
                    [['Log out now', () => this._logout()]]);
            } else {
                this._notify(`MY DOCK FINDER FOR LINUX updated to ${ver}`, 'Restart GNOME Shell to finish. Your windows stay open.',
                    [['Restart now', () => Meta.restart('Restarting...', global.context)]]);
            }
        });
    }

    // Mode 0 = normal: GNOME shows its usual logout confirmation.
    _logout() {
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            'Logout', new GLib.Variant('(u)', [0]), null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    logError(e, 'MY DOCK FINDER FOR LINUX: logout failed');
                }
            });
    }

    _notify(title, body, actions = [], isTransient = false) {
        if (!this._source) {
            // a Source destroys itself when its last notification goes, so make one on demand
            this._source = new MessageTray.Source({title: 'MY DOCK FINDER FOR LINUX', iconName: 'software-update-available-symbolic'});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({source: this._source, title, body, isTransient});
        for (const [label, cb] of actions)
            n.addAction(label, cb);
        this._source.addNotification(n);
        console.log(`MY DOCK FINDER FOR LINUX: notification "${title}"`);
    }

    destroy() {
        this._cancel.cancel();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._source?.destroy();
        this._session?.abort();
        this._session = this._source = this._cancel = this._ext = null;
    }
}
