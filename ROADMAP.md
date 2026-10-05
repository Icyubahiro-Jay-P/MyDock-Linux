# Roadmap

This is an audit of MY DOCK FINDER FOR LINUX against the real macOS Dock, menu bar and Finder
behaviour, with a plan for building each missing piece. Items are grouped by module and then put in
the order they should be built.

Legend: **Done** is shipped, **Planned** is not built yet, **Not possible** cannot be done from a GNOME Shell extension.

Every item follows the pattern in [CONTRIBUTING.md](CONTRIBUTING.md): a key in
`extension/schemas/org.gnome.shell.extensions.mydock.gschema.xml`, a row in the `PAGES` table in
`extension/prefs.js`, styles in `extension/themes/default/stylesheet.css`, everything undone in
`destroy()`, and a row in the README configuration table.

## Windows (`extension/windowbuttons.js`)

| Status | Feature | How |
| --- | --- | --- |
| Done | Close, minimize, maximize on the **left** in macOS order | Sets `org.gnome.desktop.wm.preferences button-layout` to `close,minimize,maximize:`, saves the old value in `saved-button-layout` and restores it on disable and on uninstall |
| Done | Red, yellow and green traffic light buttons (opt in) | Marked block in `~/.config/gtk-3.0/gtk.css` and `gtk-4.0/gtk.css`, removed on disable |
| Planned | Double-click title bar: Zoom or Minimize | Expose `action-double-click-titlebar` from the same WM schema in prefs |
| Planned | Mission Control (Ctrl+Up) and App Expose (Ctrl+Down) | Keybindings that open the overview, App Expose filters the window picker to the focused app |
| Planned | Hot Corners editor | Per corner action: Mission Control, Launchpad, Desktop, Lock Screen |
| Planned | Icon only app switcher like Cmd+Tab | Restyle `switch-applications` popup, hide window previews |

## Dock (`extension/dock.js`)

Already done: magnification, running dots, bounce on launch, name labels, trash, live calendar and
clock, drag to reorder, autohide, a dock on every monitor, right-click app menu.

| Status | Feature | How |
| --- | --- | --- |
| Planned | Automatic separator between pinned apps and other running apps (user separators you add from the menu are done, `dock-separators`) | Thin `St.Widget` between the two groups in `setApps()` |
| Planned | "Show suggested and recent apps in Dock" | Keep the last 3 closed unpinned apps in a key, show them after the separator |
| Done | Bounce when an app needs attention | `window-demands-attention` / `window-marked-urgent`, up to 10 hops or until the window is focused (`bounce-on-attention`) |
| Done | Progress bars and notification badges | `com.canonical.Unity.LauncherEntry` `progress` and `count` (Chrome, Telegram, Thunderbird, Nautilus), badges behind `show-badges` |
| Done | Click on the focused app to minimize, scroll to cycle windows | Click already minimized; scroll switches windows in a fixed order (`scroll-cycles-windows`) |
| Planned | Ctrl click hides other apps (middle click for a new window is done) | Extend `_activateApp()` |
| Done | Drag an icon out of the Dock to remove it (no puff animation yet) | `onDragCancelled()` unpins a pinned icon or removes a separator released outside the dock |
| Not possible | Drop files on an app to open them, on Trash to delete | GNOME Shell does not receive the file list when files are dragged from an app over the shell, so an extension cannot do this |
| Done | Hollow dot for apps whose windows are all minimized | `.mydock-dot-minimized` in the theme |
| Planned | Stacks: Downloads, Documents, Applications | Folder tiles with Fan, Grid and List popups, `Gio.File.enumerate_children_async` |
| Planned | Mounted drives and an Eject action | `Gio.VolumeMonitor`, eject from the tile menu |
| Planned | Minimize windows into the app icon or into their own tile | `minimize-into-app` key; own tiles go in the right section next to Trash |
| Planned | Autohide delay and speed, Super+Alt+D to toggle hiding | `autohide-delay`, `autohide-speed`, keybinding |
| Planned | Dock position: left, right or bottom | `dock-position` enum. Largest change: `_frame()`, `_placeStrip()`, `dockRect()`, `_dropPos()` and `getIconRect()` all assume bottom |
| Planned | Finder tile fixed at the start of the Dock | Pinned Nautilus tile that cannot be removed |

## Menu bar (`extension/finderbar.js`)

Already done: logo menu, focused app name with its app menu, custom clock, blur, notifications at
the top right, bold macOS-style dark menus, About This PC window, CPU temperature popup.

| Status | Feature | How |
| --- | --- | --- |
| Planned | Bold app name and real app menus (File, Edit, View, Window, Help) | Read the app's exported `org.gtk.Menus` or `com.canonical.dbusmenu` menu, fall back to the current AppMenu |
| Done | Logo menu: Recently opened files submenu, Task Manager | Parse `~/.local/share/recently-used.xbel` |
| Done | Logo menu: Force Quit... | `forcequit.js`: dialog of running apps, kills the selected app's windows (`Meta.Window.kill()`) |
| Done | File, View and Window menus: New/Close Window, Quit, Full Screen, Minimize, Zoom, Tile left or right, Bring All to Front | New `PanelMenu.Button` after the app name |
| Done | Spotlight icon on the right | Opens the overview with the search field focused (`show-spotlight`) |
| Done | Control Center: one icon for quick settings, plus separate Wi-Fi, Bluetooth, Sound, Display, Battery, Account and tray menus (`statusmenus.js`) | Restyle the quick settings button, keep GNOME's menu |
| Done | Automatically hide and show the menu bar | `menubarhide.js`: slides the panel away and drops its strut; the top edge, panel menus and the overview bring it back (`finderbar-autohide`) |
| Done | Clock presets | Preset popup in Settings, Custom shows the raw strftime field (`clockpresets.js`) |

## Launchpad (`extension/launchpad.js`)

| Status | Feature | How |
| --- | --- | --- |
| Done | Typing starts a search | Keep the search entry hidden but forward key presses to it |
| Done | Page dots and no scroll bar | Style the paged app grid |
| Done | Click on empty space closes Launchpad | Button press handler on the background |
| Planned | F4 or pinch gesture | Optional extra keybinding and a touchpad gesture |

## Polish

| Status | Feature | How |
| --- | --- | --- |
| Done | Reset to defaults button in settings | `settings.reset()` on every key |
| Planned | Translations | gettext `po/` folder, `_()` on every label |
| Done | Screen reader names on dock items | `accessible_name` on `DockItem` |
| Done | GNOME 49 and 50 support | Ported the maximize, grab, GLSL and restart APIs that changed; raised `shell-version`, `MAX_SHELL` and the .deb Depends |
| Planned | README screenshot | `docs/screenshot.png`, dock and menu bar in dark mode |

Out of scope: desktop icons (use Desktop Icons NG) and Quick Look (use GNOME Sushi with Nautilus).

## Build order

1. **Done**: repository links, window buttons and traffic lights, attention bounce, click and scroll
   actions, hollow dots, badges and progress bars, drag out to remove, the menu bar (Recent Items,
   Force Quit, Window menu, auto hide, Spotlight icon, Control Center), reset to defaults, GNOME 49
   and 50.
2. Dock: automatic separator and recent apps, Ctrl click, drives in the Dock.
3. Stacks with Fan and Grid views.
4. Autohide delay and speed, then dock position left and right.
5. Global app menus, Mission Control and App Expose.
6. Translations and the README screenshot.
