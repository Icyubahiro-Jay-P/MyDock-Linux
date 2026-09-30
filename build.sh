#!/usr/bin/env bash
# Builds dist/dock-install.sh = install-stub.sh + base64 tarball of extension/,
# and dist/dock_VERSION_all.deb (system-wide extension + dock).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
glib-compile-schemas --strict --dry-run extension/schemas
EXCL=(--exclude=gschemas.compiled --exclude='*.test.mjs')
{ cat install-stub.sh; tar czf - -C extension "${EXCL[@]}" . | base64; } > dist/dock-install.sh
chmod +x dist/dock-install.sh

VERSION=$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["version-name"])')
DEB="dist/dock_${VERSION}_all.deb"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
ext="$root/usr/share/gnome-shell/extensions/mydock@jay-p"
mkdir -p "$ext" "$root/usr/bin" "$root/usr/share/doc/dock" "$root/DEBIAN"
tar cf - -C extension "${EXCL[@]}" . | tar xf - -C "$ext"
glib-compile-schemas "$ext/schemas"
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
Depends: gnome-shell (>= 46), gnome-shell (<< 49), python3, libglib2.0-bin
Maintainer: Icyubahiro-Jay-P <icyubahiro-jay-p@users.noreply.github.com>
Homepage: https://github.com/Icyubahiro-Jay-P/MyDock-Linux
Description: macOS-style dock for GNOME Shell
 MY DOCK FINDER FOR LINUX adds a macOS-style dock, Finder bar, Launchpad, Stage Manager and
 genie minimize to GNOME Shell. Run dock once per user to enable it.
CTL
find "$root" -type d -exec chmod 0755 {} +
find "$root" -type f -exec chmod 0644 {} +
chmod 0755 "$root/usr/bin/dock"
dpkg-deb --build --root-owner-group "$root" "$DEB" >/dev/null

echo "Built dist/dock-install.sh ($(du -h dist/dock-install.sh | cut -f1))"
echo "Built $DEB ($(du -h "$DEB" | cut -f1))"
