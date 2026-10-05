# Contributing to MY DOCK FINDER FOR LINUX

Thanks for helping. Small, focused pull requests are the easiest to review.

## Dev setup

You need GNOME Shell 46 to 50, plus:

- `glib-compile-schemas` (Ubuntu: `libglib2.0-bin`)
- `dpkg-deb` (for the .deb build)
- `node` (for the unit tests)
- `shellcheck` (optional, CI runs it)

Build and install your working copy:

```bash
git clone https://github.com/Icyubahiro-Jay-P/MyDock-Linux.git
cd MyDock-Linux
./build.sh
bash dist/dock-install.sh
```

Re-run the last two commands after each change, then test in a nested shell (below) or log out and back in.

## Running tests

```bash
for t in extension/*.test.mjs; do node "$t"; done
```

Each `*.test.mjs` covers a module with no GNOME imports (`deform-math.js`, `version.js`, `panel-order.js`, `clockpresets.js` and the `sysinfo.js` parsers), so it runs under plain Node. Add a case when you change one. `shell-range.test.mjs` checks that the supported GNOME versions agree everywhere they are written (`metadata.json`, `install-stub.sh`, `build.sh`).

The smoke test starts a headless GNOME Shell with your working copy, flips every on/off setting, disables and re-enables the extension, and fails on any error the shell logs. It uses its own D-Bus session and home folder, so it does not touch your desktop. CI runs it on GNOME 46, 48, 49 and 50:

```bash
bash ci/smoke.sh
```

Lint the shell scripts the same way CI does:

```bash
shellcheck build.sh install.sh install-stub.sh ci/smoke.sh
```

## Testing in a nested shell

You can run a second GNOME Shell in a window, so a crash does not take down your session.

On GNOME 46 to 48:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

On GNOME 49 and 50 `--nested` is gone; use `--devkit` instead (it needs the Mutter devkit viewer, which your distribution ships with its Mutter development tools):

```bash
dbus-run-session -- gnome-shell --devkit --wayland
```

Watch the logs in another terminal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

The nested shell loads the installed copy in `~/.local/share/gnome-shell/extensions/mydock@icyubahiro-jay-p`, so rebuild and reinstall before starting it. Open the settings window with `gnome-extensions prefs mydock@icyubahiro-jay-p`.

## Code layout

```
extension/
  extension.js              entry point, creates and destroys features
  dock.js                   the dock
  finderbar.js              top panel restyle
  launchpad.js              app grid and hotkey
  stagemanager.js           Stage Manager strip
  minimize.js               minimize animations
  windowbuttons.js          window buttons on the left, traffic light colors
  menubarhide.js            hide and show the menu bar automatically
  forcequit.js              Force Quit Applications dialog
  clockpresets.js           clock format presets for the settings window
  deform-math.js            pure math for genie/suck (tested by deform-math.test.mjs)
  prefs.js                  settings window, rows generated from tables
  schemas/                  GSettings schema
  themes/default/stylesheet.css   default theme
build.sh                    builds dist/dock-install.sh and the .deb
install-stub.sh             installer script that the payload is appended to
install.sh                  one-liner that fetches the latest release installer
```

### Feature classes

Every feature follows the same shape:

```js
export class Feature {
    constructor(ext) { /* build UI, read ext.settings, connect signals */ }
    destroy()        { /* undo everything the constructor did */ }
}
```

`extension.js` lists features in its `FEATURES` table. A feature with an on/off setting is created with `new Feature(ext)` when the setting turns on and torn down with `destroy()` when it turns off, live. A new feature gets a row in that table, not special code in `enable()`.

New settings go in `extension/schemas/org.gnome.shell.extensions.mydock.gschema.xml` and in the `PAGES` table in `prefs.js`.

## Style

- Match the surrounding code: indentation, naming, comment style.
- Use ESM imports (`import St from 'gi://St'`, `resource:///org/gnome/shell/...`), as required by GNOME 45+.
- Clean up everything in `destroy()`: disconnect every signal, remove every actor you added, remove timeouts and sources, and restore anything you patched. Disabling and re-enabling the extension must leave the shell exactly as it was.
- Never let one feature take the shell down. `extension.js` already catches constructor errors; do not swallow errors silently elsewhere.
- Keep it small. Prefer existing GNOME Shell APIs over new abstractions.

## Pull request checklist

- [ ] Every `extension/*.test.mjs` passes
- [ ] `./build.sh` succeeds
- [ ] `shellcheck` is clean for any shell script you touched
- [ ] Tested on GNOME Shell 46 to 50 (say which, and X11 or Wayland)
- [ ] Disable then enable the extension: no leftovers, no errors in the log
- [ ] New settings are in the schema and in `prefs.js`
- [ ] README updated if behavior or settings changed

## Releasing (maintainers)

**One step, from any browser or the GitHub app:** Actions > build > **Run workflow** on `main`, type the new version (for example `1.2.1`) and run it. CI checks the GNOME smoke tests, sets `"version-name"` and bumps `"version"` in `extension/metadata.json` (`ci/bump.py`), commits that to `main`, then builds and publishes the `v1.2.1` release. Leave the version empty to publish the version already in `metadata.json`.

**By hand:** set the version with `python3 ci/bump.py 1.2.1`, commit and merge to `main`, then tag and push the tag:

```bash
git tag v1.2.1
git push origin v1.2.1
```

When adding support for a new GNOME version, add it to `"shell-version"` and raise `MAX_SHELL` in `install-stub.sh` and the `.deb` Depends in `build.sh` (`shell-range.test.mjs` fails until they agree), and add the matching image to the `smoke` matrix in the workflow.

Either way, CI builds and publishes a GitHub Release with `dock-install.sh` and `dock_<version>_all.deb` and `SHA256SUMS` attached. The one-liner picks up the new release automatically.
