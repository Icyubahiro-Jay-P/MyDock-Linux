# Security Policy

## Supported versions

Only the [latest release](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/releases/latest) gets security fixes. Please update before reporting.

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting:

https://github.com/Icyubahiro-Jay-P/MyDock-Linux/security/advisories/new

**Do not open a public issue** for security problems.

Include the MY DOCK FINDER FOR LINUX version, GNOME Shell version, distro, and steps to reproduce.

## What to expect

MY DOCK FINDER FOR LINUX is maintained by a volunteer, so response is best effort. You should get a first reply within 7 days. Once a fix is ready it ships in a new release and the advisory is published, with credit to you if you want it.

## Scope

- **The extension** runs inside `gnome-shell` as your user. It has the same access as your desktop session, and no more.
- **The installer** (`install.sh`, `dock-install.sh`, `dock`) runs as your user and never uses sudo. It writes to `~/.local/share` and changes your own GNOME settings.
- **The .deb** needs sudo only for `apt` to install the package files. Setup afterwards runs as your normal user.
- **The one-liner** pipes a script from GitHub into bash. If you prefer, read [install.sh](https://github.com/Icyubahiro-Jay-P/MyDock-Linux/blob/main/install.sh) first, or download `dock-install.sh` from the Releases page and inspect it before running.

- **The update check** sends one anonymous HTTPS request a day to `api.github.com` (no ID, only a `MyDock/<version>` user agent). An update is downloaded from the GitHub release and verified against its `SHA256SUMS` before anything runs; .deb updates go through `pkexec` so you see a password prompt. Turn it off with the `check-updates` setting.

Problems in GNOME Shell itself or in other extensions should go to their own projects.
