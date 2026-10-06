// Force Quit Applications dialog, opened from the Finder bar logo menu (finderbar.js).
// Lists the running apps; "Force Quit" kills the selected app's windows right away, like macOS.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

let _dialog = null;

// Kill every window of the app (SIGKILL on X11, the client connection on Wayland), then SIGKILL
// its processes no other app shares: on Wayland a hung client survives losing its connection. An app with no windows
// only gets a polite quit request.
export function forceQuit(app) {
    const wins = app.get_windows();
    if (!wins.length) {
        app.request_quit();
        return;
    }
    const self = new Gio.Credentials().get_unix_pid();
    const pids = new Set(wins.map(w => w.get_pid()).filter(pid => pid > 1 && pid !== self));
    // a process can host several apps (Chromium web apps, LibreOffice Writer/Calc): leave it at
    // the window kills above unless every window it owns is this app's
    const tracker = Shell.WindowTracker.get_default();
    for (const actor of global.get_window_actors()) {
        const w = actor.meta_window;
        if (pids.has(w.get_pid()) && tracker.get_window_app(w) !== app)
            pids.delete(w.get_pid());
    }
    for (const w of wins)
        w.kill();
    for (const pid of pids) {
        try {
            // async, and GSubprocess reaps it on its own
            Gio.Subprocess.new(['kill', '-KILL', `${pid}`], Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, `MyDock: cannot kill ${pid}`);
        }
    }
}

export function showForceQuit() {
    if (_dialog)
        return;
    const dialog = new ModalDialog.ModalDialog({styleClass: 'mydock-forcequit', destroyOnClose: true});
    _dialog = dialog;
    dialog.connect('destroy', () => {
        if (_dialog === dialog)
            _dialog = null;
    });

    const box = dialog.contentLayout;
    box.add_child(new St.Label({text: 'Force Quit Applications', style_class: 'mydock-forcequit-title'}));
    box.add_child(new St.Label({
        text: 'If an app doesn’t respond for a while, select its name and click Force Quit.',
        style_class: 'mydock-forcequit-hint',
    }));

    const list = new St.BoxLayout({vertical: true, style_class: 'mydock-forcequit-list'});
    box.add_child(list);

    let selected = null;
    const rows = new Map(); // app -> row button
    const select = app => {
        selected = app;
        for (const [a, row] of rows) {
            if (a === app)
                row.add_style_class_name('selected');
            else
                row.remove_style_class_name('selected');
        }
        quitButton.reactive = quitButton.can_focus = !!app;
    };

    const apps = Shell.AppSystem.get_default().get_running()
        .sort((a, b) => a.get_name().localeCompare(b.get_name()));
    for (const app of apps) {
        const row = new St.Button({style_class: 'mydock-forcequit-row', can_focus: true, x_expand: true});
        const content = new St.BoxLayout({style_class: 'mydock-forcequit-row-box'});
        content.add_child(app.create_icon_texture(24));
        content.add_child(new St.Label({text: app.get_name(), y_align: Clutter.ActorAlign.CENTER}));
        row.set_child(content);
        row.connect('clicked', () => select(app));
        row.connect('key-focus-in', () => select(app));
        rows.set(app, row);
        list.add_child(row);
    }
    if (!apps.length)
        list.add_child(new St.Label({text: 'No apps are running.', style_class: 'mydock-forcequit-hint'}));

    const quit = () => {
        if (!selected)
            return;
        forceQuit(selected);
        dialog.close();
    };
    dialog.setButtons([
        {label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape},
        {label: 'Force Quit', action: quit, default: true},
    ]);
    const quitButton = dialog.buttonLayout.get_last_child();

    // preselect the app in front, like macOS
    const front = Shell.WindowTracker.get_default().focus_app;
    select(rows.has(front) ? front : apps[0] ?? null);
    if (selected)
        dialog.setInitialKeyFocus(rows.get(selected));

    if (!dialog.open())
        dialog.destroy(); // no modal grab: drop it, or _dialog would block every later open
}

export function closeForceQuit() {
    _dialog?.close();
}
