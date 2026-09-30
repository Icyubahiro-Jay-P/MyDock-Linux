# Contributing to MY DOCK FINDER FOR LINUX

Thanks for helping. Small, focused pull requests are the easiest to review.

## Dev setup

You need GNOME Shell 46, 47 or 48, plus:

- `glib-compile-schemas` (Ubuntu: `libglib2.0-bin`)
- `dpkg-deb` (for the .deb build)
- `node` (for the unit tests)
- `shellcheck` (optional, CI runs it)

Build and install your working copy:

```bash
git clone https://github.com/jay-p/MyDock-Linux.git
cd MyDock-Linux
./build.sh
bash dist/dock-install.sh
```

Re-run the last two commands after each change, then test in a nested shell (below) or log out and back in.

## Running tests

```bash
node extension/deform-math.test.mjs
```

`deform-math.js` is pure math (the genie and suck vertex functions) with no GNOME imports, so it runs under plain Node. Add a case there when you change it.

Lint the shell scripts the same way CI does:

```bash
shellcheck build.sh install.sh install-stub.sh
```

## Testing in a nested shell

On GNOME 46 to 48 you can run a second GNOME Shell in a window, so a crash does not take down your session:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Watch the logs in another terminal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

The nested shell loads the installed copy in `~/.local/share/gnome-shell/extensions/mydock@jay-p`, so rebuild and reinstall before starting it. Open the settings window with `gnome-extensions prefs mydock@jay-p`.

## Code layout

```
extension/
  extension.js              entry point, creates and destroys features
  dock.js                   the dock
  finderbar.js              top panel restyle
  launchpad.js              app grid and hotkey
  stagemanager.js           Stage Manager strip
  minimize.js               minimize animations
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

- [ ] `node extension/deform-math.test.mjs` passes
- [ ] `./build.sh` succeeds
- [ ] `shellcheck` is clean for any shell script you touched
- [ ] Tested on GNOME Shell 46, 47 or 48 (say which, and X11 or Wayland)
- [ ] Disable then enable the extension: no leftovers, no errors in the log
- [ ] New settings are in the schema and in `prefs.js`
- [ ] README updated if behavior or settings changed

## Releasing (maintainers)

1. Bump `"version-name"` (for example `"1.1.0"`) and `"version"` (integer, +1) in `extension/metadata.json`. When adding support for a new GNOME version, also add it to `"shell-version"` and raise the upper bound in `install-stub.sh` (`MAX_SHELL`) and the `.deb` Depends in `build.sh`.
2. Commit, then tag and push the tag:

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

3. CI builds and publishes a GitHub Release with `dock-install.sh` and `dock_<version>_all.deb` and `SHA256SUMS` attached. The one-liner picks up the new release automatically.
