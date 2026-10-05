#!/usr/bin/env bash
# Builds dist/dock-install.sh = install-stub.sh + base64 tarball of extension/,
# and dist/dock_VERSION_all.deb (system-wide extension + dock).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist
glib-compile-schemas --strict --dry-run extension/schemas
EXCL=(--exclude=gschemas.compiled --exclude='*.test.mjs')
{ cat install-stub.sh; tar czf - -C extension "${EXCL[@]}" . | base64; } > dist/dock-install.sh
chmod +x dist/dock-install.sh

VERSION=$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["version-name"])')
[[ $VERSION =~ ^[0-9]+(\.[0-9]+)*$ ]] || { echo "Bad version-name in metadata.json: $VERSION" >&2; exit 1; }
DEB="dist/dock_${VERSION}_all.deb"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
ext="$root/usr/share/gnome-shell/extensions/mydock@icyubahiro-jay-p"
shim="$root/usr/share/gnome-shell/extensions/mydock@jay-p"
mkdir -p "$ext" "$shim" "$root/usr/bin" "$root/usr/share/doc/dock" "$root/DEBIAN"
tar cf - -C extension "${EXCL[@]}" . | tar xf - -C "$ext"
glib-compile-schemas "$ext/schemas"
# Up to 1.1.0 the extension ID was mydock@jay-p. apt cannot touch per-user settings, so this
# stub swaps the old ID for the new one in enabled-extensions the first time the shell loads it.
# ponytail: drop the shim around 1.3 once 1.1.0 .deb users have upgraded.
cat > "$shim/metadata.json" <<'JSON'
{
  "uuid": "mydock@jay-p",
  "name": "MY DOCK FINDER FOR LINUX (migration)",
  "description": "Moves MY DOCK FINDER FOR LINUX to its new extension ID. Safe to ignore.",
  "shell-version": ["46", "47", "48", "49", "50"]
}
JSON
cat > "$shim/extension.js" <<'JS'
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MigrateMyDock extends Extension {
    enable() {
        const s = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const on = s.get_strv('enabled-extensions').filter(u => u !== this.uuid);
        if (!on.includes('mydock@icyubahiro-jay-p'))
            on.push('mydock@icyubahiro-jay-p');
        s.set_strv('enabled-extensions', on);
    }

    disable() {}
}
JS
cp install-stub.sh "$root/usr/bin/dock"
{ echo "MY DOCK FINDER FOR LINUX - https://github.com/Icyubahiro-Jay-P/MyDock-Linux"; echo
  if [[ -f LICENSE ]]; then cat LICENSE
  else echo "MIT License. Copyright (c) 2026 Irakoze Icyubahiro Jean Pierre"; fi; } > "$root/usr/share/doc/dock/copyright"
cat > "$root/DEBIAN/control" <<CTL
Package: dock
Version: $VERSION
Section: gnome
Priority: optional
Architecture: all
Depends: gnome-shell (>= 46), gnome-shell (<< 51), python3, libglib2.0-bin
Maintainer: Irakoze Icyubahiro Jean Pierre <icyubahiro-jay-p@users.noreply.github.com>
Homepage: https://github.com/Icyubahiro-Jay-P/MyDock-Linux
Description: macOS-style dock for GNOME Shell
 MY DOCK FINDER FOR LINUX adds a macOS-style dock, Finder bar, Launchpad, Stage Manager and
 genie minimize to GNOME Shell. Run dock once per user to enable it.
CTL
# apt cannot reach per-user settings. Removal is already underway when prerm runs, so point users at
# the one-liner, which does the same as dock --uninstall without the package.
cat > "$root/DEBIAN/prerm" <<'SH'
#!/bin/sh
set -e
if [ "$1" = remove ]; then
    echo "dock: per-user changes stay for each user who ran dock (window buttons, gtk.css, other docks turned off)."
    echo "dock: next time, run dock --uninstall as each user first. To undo them now, run as each user (not root):"
    echo "  curl -fsSL https://raw.githubusercontent.com/Icyubahiro-Jay-P/MyDock-Linux/main/install.sh | bash -s -- --uninstall"
fi
SH
find "$root" -type d -exec chmod 0755 {} +
find "$root" -type f -exec chmod 0644 {} +
chmod 0755 "$root/usr/bin/dock" "$root/DEBIAN/prerm"
dpkg-deb --build --root-owner-group "$root" "$DEB" >/dev/null

echo "Built dist/dock-install.sh ($(du -h dist/dock-install.sh | cut -f1))"
echo "Built $DEB ($(du -h "$DEB" | cut -f1))"
