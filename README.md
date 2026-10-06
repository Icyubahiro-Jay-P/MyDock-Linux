# MY DOCK FINDER FOR LINUX

A macOS-style dock, Finder bar, Launchpad, Stage Manager and genie minimize for GNOME Shell.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Icyubahiro-Jay-P/MyDock-Linux)](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/releases/latest)
[![Build](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/actions/workflows/build.yml/badge.svg)](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/actions/workflows/build.yml)

<!-- Maintainer: add a screenshot at docs/screenshot.png (dock + Finder bar, ideally in dark mode), then uncomment:
![MY DOCK FINDER FOR LINUX](docs/screenshot.png)
-->

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/Icyubahiro-Jay-P/MyDock-Linux/main/install.sh | bash
```

Then **log out and back in**. Nothing needs sudo. Want to read the script first? It is [install.sh](install.sh); it downloads the latest release asset `dock-install.sh` and runs it.

## Features

- **Dock**: magnification on hover, running-app dots (hollow when every window is minimized), bounce on launch and when an app needs attention, notification badges and progress bars, scroll on an icon to switch its windows, app name labels, trash, live calendar and clock icons, blur and opacity, autohide, a dock on every monitor.
- **Finder bar**: restyles the GNOME top panel into a translucent macOS-style menu bar, with clock format presets, an optional custom logo, a Spotlight search icon, Force Quit in the logo menu, and an option to hide the bar until you push the pointer against the top edge.
- **Launchpad**: full-screen app grid, opened from the dock or with **Ctrl+Super+A**.
- **Stage Manager**: a strip of recent window groups on the side of the screen. Off by default.
- **Minimize effects**: genie, suck, scale or none, with adjustable duration.
- **Window buttons on the left**: close, minimize and maximize move to the left of the title bar in macOS order, with optional red, yellow and green traffic light colors for GTK apps. Your old layout comes back when you turn it off.
- **Themes and dark mode**: follow the system color scheme or force light or dark; load your own theme folder.

## Requirements

- GNOME Shell **46, 47, 48, 49 or 50** (Ubuntu 24.04, 25.04, 25.10 and 26.04 LTS, Fedora 40+)
- X11 or Wayland
- `gsettings`, `python3` and `glib-compile-schemas` (present on standard GNOME desktops)

GNOME 49 and 50 support is new. See [Compatibility](#compatibility).

## Other install methods

### .deb package (Ubuntu, Debian)

Download `dock_<version>_all.deb` (for example `dock_1.2.3_all.deb`) from the [Releases page](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/releases), then:

```bash
sudo apt install ./dock_<version>_all.deb
dock            # run as your normal user, not with sudo
```

`dock` enables MY DOCK FINDER FOR LINUX for your user and turns off other docks. Log out and back in.

### Single-file installer

Download `dock-install.sh` from the [Releases page](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/releases), then:

```bash
bash dock-install.sh
```

To check the download, get `SHA256SUMS` from the same release and run `sha256sum -c --ignore-missing SHA256SUMS`.

### From source

```bash
git clone https://github.com/Icyubahiro-Jay-P/MyDock-Linux.git
cd MyDock-Linux
./build.sh
bash dist/dock-install.sh
```

See [Building](#building) for what `build.sh` needs.

## What the installer does

- Installs to `~/.local/share/gnome-shell/extensions/mydock@icyubahiro-jay-p` and enables it for your user. Older installs under the previous ID `mydock@jay-p` are removed automatically and your settings are kept.
- Turns off **Ubuntu Dock**, **Dash to Dock** and **Dash2Dock Lite** if they are installed, and remembers which ones it turned off.
- Warns if a minimize-effect extension is enabled (see [Compatibility](#compatibility)).
- You then log out and back in, because Wayland cannot reload the shell in place.

## Uninstall

Uninstalling removes MY DOCK FINDER FOR LINUX and turns your previous dock back on.

| Installed with | Uninstall with |
| --- | --- |
| One-liner | `curl -fsSL https://raw.githubusercontent.com/Icyubahiro-Jay-P/MyDock-Linux/main/install.sh \| bash -s -- --uninstall` |
| .deb | `dock --uninstall` then `sudo apt remove dock` |
| Single file | `bash dock-install.sh --uninstall` |
| Source | `bash dist/dock-install.sh --uninstall` |

Log out and back in afterwards. Add `--purge` after `--uninstall` to also reset all MY DOCK FINDER FOR LINUX settings.

With the .deb, run `dock --uninstall` as every user who ran `dock` before `sudo apt remove dock`: apt cannot reach per-user settings, so removing the package alone leaves your window button layout, the traffic light block in `gtk.css` and your old dock's on/off state as they were. If the package is already gone, the one-liner uninstall above does the same.

## Updates

MY DOCK FINDER FOR LINUX checks GitHub for a new release once a day (a minute after login, never blocking the desktop). When one is out you get a notification:

- **Update now** downloads the new release, checks it against the release `SHA256SUMS` and installs it in the background. If you installed the .deb, you are asked for your password.
- **Skip this version** stays quiet until the next release.

When the update is done, click **Restart now** (X11, your windows stay open) or **Log out now** (Wayland cannot restart the shell in place; apps can save first and nothing closes until you confirm).

To update by hand, rerun the [one-line install](#install-one-line). To turn the daily check off, switch off `check-updates` in the settings.

## Configuration

Open the settings window:

```bash
gnome-extensions prefs mydock@icyubahiro-jay-p
```

Every setting applies live. Key settings (schema `org.gnome.shell.extensions.mydock`):

| Area | Key | Default | What it does |
| --- | --- | --- | --- |
| Dock | `dock-enabled` | `true` | Show the dock |
| Dock | `icon-size` / `max-size` | `60` / `75` | Icon size and magnified size |
| Dock | `magnify` | `true` | Magnify on hover |
| Dock | `autohide` | `false` | Auto-hide the dock |
| Dock | `multi-monitor` | `true` | Dock on every monitor |
| Dock | `blur` / `opacity` | `15` / `45` | Background blur radius and opacity (%) |
| Dock | `blur-windows` | `false` | Blur windows behind the Dock live (off: blurred wallpaper with clean corners, fastest) |
| Dock | `show-trash`, `show-calendar`, `show-clock`, `show-launchpad` | on, on, off, on | Extra dock icons |
| Dock | `bounce-on-attention` | `true` | Bounce an app's icon when one of its windows needs attention |
| Dock | `show-badges` | `true` | Red notification count on app icons (apps that use the Unity launcher API) |
| Dock | `scroll-cycles-windows` | `true` | Scroll on an app icon to switch between its windows |
| Finder bar | `finderbar-enabled` | `true` | macOS-style top bar |
| Finder bar | `finderbar-status-menus` | `true` | Wi-Fi, Bluetooth, sound, display, battery, account menus and a Control Center in the Finder bar |
| Finder bar | `finderbar-stats` | `true` | CPU, temperature, memory, disk and network in the top bar (turning it off saves most idle CPU) |
| Finder bar | `time-format` | `'%a %-d %b  %-I:%M %p'` | Clock format (GLib strftime); Settings offers presets |
| Finder bar | `finderbar-autohide` | `false` | Hide the menu bar until the pointer touches the top edge (works even with the Finder bar off) |
| Finder bar | `show-spotlight` | `true` | Search icon that opens the overview with the search field focused |
| Finder bar | `logo-path` | `''` | Custom top-left logo image (empty = distributor logo) |
| Launchpad | `launchpad-hotkey` | `['<Control><Super>a']` | Launchpad shortcut |
| Stage Manager | `stage-manager` | `false` | Turn Stage Manager on |
| Windows | `window-buttons-left` | `true` | Close, minimize, maximize on the left (macOS order) |
| Windows | `traffic-lights` | `false` | Red, yellow and green buttons in GTK apps |
| Effects | `minimize-effect` | `'genie'` | `none`, `scale`, `genie` or `suck` |
| Effects | `minimize-duration` | `450` | Animation length in ms |
| Themes | `theme-path` | `''` | Theme folder (empty = built-in default) |
| Themes | `dark-mode` | `0` | `0` follow system, `1` light, `2` dark |
| Updates | `check-updates` | `true` | Check GitHub once a day for a new release |

You can also use `gsettings`, for example:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/mydock@icyubahiro-jay-p/schemas \
  set org.gnome.shell.extensions.mydock minimize-effect 'scale'
```

### Custom themes

A theme is a folder with a `stylesheet.css` and an optional `icons/` folder. Icons named `<app-id>.png` (for example `org.gnome.Nautilus.png`) replace that app's dock icon. Start by copying `extension/themes/default/` and point `theme-path` at your copy.

## Compatibility

- **Other docks**: Ubuntu Dock, Dash to Dock and Dash2Dock Lite are turned off on install and restored on uninstall. Other dock extensions may conflict; disable them yourself.
- **Minimize effects**: Magic Lamp, Burn My Windows and Compiz windows effect also animate minimize. Turn them off, or set MY DOCK FINDER FOR LINUX's minimize effect to `none`.
- **Window buttons**: `window-buttons-left` changes the GNOME setting `org.gnome.desktop.wm.preferences button-layout` and restores your previous value when turned off or uninstalled. `traffic-lights` adds a marked block to `~/.config/gtk-3.0/gtk.css` and `~/.config/gtk-4.0/gtk.css` and removes only that block when turned off. GTK and libadwaita apps pick up the colors when they next start; Firefox, Chrome, Electron and Qt apps draw their own title bars and may not follow.
- **GNOME 49 / 50** (Ubuntu 25.10 / 26.04 LTS): supported since 1.2.0. These versions have no X11 session, so after an update you log out instead of restarting the shell. Please report anything that looks wrong.

## Troubleshooting

Watch the shell log (run it, then reproduce the problem):

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Turn MY DOCK FINDER FOR LINUX off without uninstalling:

```bash
gnome-extensions disable mydock@icyubahiro-jay-p
```

Common issues:

- **Nothing changed after install**: log out and back in. On Wayland the shell cannot be restarted in place.
- **Two docks**: another dock extension is still enabled. Check `gnome-extensions list --enabled`.
- **Double minimize animation**: see [Compatibility](#compatibility).
- **Extension shows as "out of date"**: your GNOME Shell version is outside 46 to 50.

If none of that helps, [open a bug report](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/issues/new?template=bug_report.md) with the log output.

## Building

`build.sh` needs `glib-compile-schemas` (package `libglib2.0-bin` on Ubuntu) and `dpkg-deb`. It writes:

- `dist/dock-install.sh`: the single-file installer
- `dist/dock_<version>_all.deb`: the Debian package

The version comes from `"version-name"` in `extension/metadata.json`.

Run the tests:

```bash
for t in extension/*.test.mjs; do node "$t"; done
```

CI (`.github/workflows/build.yml`) runs on pushes to `main`, on `v*` tags and on pull requests: it starts a headless GNOME Shell 46, 47, 48, 49 and 50 with the extension and fails on any error it logs (`ci/smoke.sh`). Only when those pass does it run the tests, shellcheck and the build. Releases are published from the Actions tab with **Run workflow** (see [CONTRIBUTING.md](CONTRIBUTING.md#releasing-maintainers)), or by pushing a tag like `v1.2.0`.

## Performance

When idle, MyDock costs about the same as Ubuntu Dock. Under active use it adds about 9% of one CPU core, mostly from icon magnification. See [PERFORMANCE.md](PERFORMANCE.md) for the measurements and which settings to turn off on low-power machines.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the macOS features that are planned next and how each one will be built.

## Contributing

Bug reports, fixes and themes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, testing in a nested shell and the release process. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not report security problems in public issues. See [SECURITY.md](SECURITY.md).

## Support this project

MY DOCK FINDER FOR LINUX is free and always will be. If it makes your desktop better and you want to say thanks, you can send any amount with **MTN Mobile Money (MoMo)**:

| | |
|---|---|
| Number | **0789124135** |
| Account name | **Nirere Gaudelive** |

Can't send money? A star on GitHub, a bug report or telling a friend helps just as much.

## License

[MIT](LICENSE) (c) 2026 Irakoze Icyubahiro Jean Pierre ([@Icyubahiro-Jay-P](https://github.com/Icyubahiro-Jay-P))
