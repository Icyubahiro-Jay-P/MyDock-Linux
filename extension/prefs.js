// MY DOCK FINDER FOR LINUX settings window, laid out like macOS System Settings: a searchable sidebar of
// categories with colored badges and a content pane of rounded cards. Rows are generated
// from the tables below; every key applies live.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// [page title, icon, badge color, [[group title, [key, ...], footnote?], ...], header?]
const PAGES = [
    ['Dock', 'view-app-grid-symbolic', 'blue', [
        ['', ['dock-enabled', 'autohide', 'multi-monitor', 'edge-distance']],
        ['Icons', ['icon-size', 'magnify', 'max-size', 'icon-space', 'bounce-on-launch', 'show-labels', 'show-running-dots']],
        ['Background', ['blur', 'opacity']],
        ['Extra icons', ['show-launchpad', 'show-trash', 'show-calendar', 'show-clock']],
    ], 'preview'],
    ['Finder Bar', 'preferences-desktop-display-symbolic', 'grey', [
        ['', ['finderbar-enabled', 'finderbar-blur']],
        ['Menu and clock', ['logo-path', 'time-format'],
            'The clock uses GLib strftime codes, for example %a %-d %b  %-I:%M %p.'],
    ]],
    ['Windows', 'focus-windows-symbolic', 'red', [
        ['Title bar buttons', ['window-buttons-left', 'traffic-lights'],
            'Puts close, minimize and maximize on the left like macOS. Traffic light colors apply to GTK apps you open next; restart open apps to see them.'],
    ]],
    ['Stage Manager', 'view-dual-symbolic', 'purple', [
        ['', ['stage-manager'],
            'Stage Manager keeps the current window in the center and arranges your other windows in a strip on the left.'],
        ['Strip', ['stage-count', 'stage-size', 'stage-show-title']],
    ]],
    ['Effects', 'applications-graphics-symbolic', 'orange', [
        ['Minimize', ['minimize-effect', 'minimize-duration']],
        ['Launchpad', ['launchpad-hotkey'], 'Click the shortcut to record a new one.'],
    ]],
    ['Themes', 'preferences-color-symbolic', 'pink', [
        ['', ['dark-mode', 'theme-path'],
            'A theme folder holds a stylesheet.css and an icons/ folder. Leave it empty for the built-in look.'],
    ]],
    ['About', 'software-update-available-symbolic', 'green', [
        ['Software Update', ['check-updates'], 'MY DOCK FINDER FOR LINUX checks GitHub once a day and offers a one-click update.'],
    ], 'about'],
];

// Friendlier titles than the schema summaries (the summary is the fallback).
const TITLES = {
    'dock-enabled': 'Show the Dock',
    'autohide': 'Automatically hide and show the Dock',
    'multi-monitor': 'Show on all displays',
    'edge-distance': 'Distance from screen edge',
    'icon-size': 'Size',
    'magnify': 'Magnification',
    'max-size': 'Magnified size',
    'icon-space': 'Spacing',
    'bounce-on-launch': 'Animate opening applications',
    'show-labels': 'Show app names on hover',
    'show-running-dots': 'Show indicators for open applications',
    'blur': 'Blur',
    'opacity': 'Opacity',
    'show-launchpad': 'Launchpad',
    'show-trash': 'Trash',
    'show-calendar': 'Live calendar',
    'show-clock': 'Live clock',
    'finderbar-enabled': 'Show the Finder bar',
    'finderbar-blur': 'Translucent background',
    'logo-path': 'Menu logo',
    'time-format': 'Clock format',
    'window-buttons-left': 'Buttons on the left (macOS order)',
    'traffic-lights': 'Red, yellow and green buttons',
    'stage-manager': 'Stage Manager',
    'stage-count': 'Groups in the strip',
    'stage-size': 'Thumbnail width',
    'stage-show-title': 'Show window titles',
    'minimize-effect': 'Minimize windows using',
    'minimize-duration': 'Animation length',
    'launchpad-hotkey': 'Open Launchpad',
    'dark-mode': 'Appearance',
    'theme-path': 'Theme folder',
    'check-updates': 'Check for updates automatically',
};

const ENUM_ROWS = {
    'minimize-effect': ['none', 'scale', 'genie', 'suck'],
};
const INT_CHOICE_ROWS = {
    'dark-mode': ['Follow system', 'Light', 'Dark'],
};
// Int keys shown as a slider with this unit (other int keys get a spin button).
const SLIDER_UNITS = {
    'icon-size': 'px', 'max-size': 'px', 'icon-space': 'px', 'edge-distance': 'px',
    'blur': 'px', 'opacity': '%', 'stage-size': 'px', 'minimize-duration': 'ms',
};
// String keys picked with a file dialog.
const PATH_ROWS = {'logo-path': 'file', 'theme-path': 'folder'};
// Row is greyed out while the boolean key it depends on is off.
const DEPENDS = {
    'max-size': 'magnify',
    'finderbar-blur': 'finderbar-enabled',
    'traffic-lights': 'window-buttons-left',
    'stage-count': 'stage-manager',
    'stage-size': 'stage-manager',
    'stage-show-title': 'stage-manager',
};

const PREVIEW_ICONS = 8;

export default class MyDockPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window
        const schema = settings.settings_schema;

        const css = new Gtk.CssProvider();
        css.load_from_path(`${this.path}/prefs.css`);
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        window.connect('close-request', () => {
            Gtk.StyleContext.remove_provider_for_display(display, css);
            return false;
        });

        // Sidebar
        const search = new Gtk.SearchEntry({placeholder_text: 'Search', margin_start: 10, margin_end: 10, margin_bottom: 6});
        const list = new Gtk.ListBox({css_classes: ['navigation-sidebar', 'mydock-sidebar']});
        const sidebarBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        sidebarBox.append(search);
        sidebarBox.append(new Gtk.ScrolledWindow({
            child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        const sidebarView = new Adw.ToolbarView({content: sidebarBox});
        sidebarView.add_top_bar(new Adw.HeaderBar({show_title: false}));

        // Content
        const stack = new Gtk.Stack();
        const titleLabel = new Gtk.Label({css_classes: ['mydock-page-title']});
        const header = new Adw.HeaderBar({title_widget: new Gtk.Box()});
        header.pack_start(titleLabel);
        const contentView = new Adw.ToolbarView({content: stack});
        contentView.add_top_bar(header);
        const contentPage = new Adw.NavigationPage({child: contentView, title: PAGES[0][0]});

        const split = new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({child: sidebarView, title: 'MY DOCK FINDER FOR LINUX'}),
            content: contentPage,
            min_sidebar_width: 210,
            max_sidebar_width: 240,
            css_classes: ['mydock-prefs'],
        });

        // Build every page and remember rows for search.
        const pages = PAGES.map(([title, icon, color, groups, extra]) => {
            const page = new Adw.PreferencesPage();
            const entry = {title, sections: [], row: sidebarRow(title, icon, color)};
            if (extra === 'preview')
                entry.sections.push(this._section(page, previewGroup(settings), []));
            if (extra === 'about')
                entry.sections.push(this._section(page, this._aboutGroup(), []));
            for (const [gTitle, keys, note] of groups) {
                const group = new Adw.PreferencesGroup({title: gTitle});
                const rows = keys.map(key => {
                    const row = this._row(settings, schema.get_key(key), key);
                    if (DEPENDS[key])
                        settings.bind(DEPENDS[key], row, 'sensitive', Gio.SettingsBindFlags.GET);
                    group.add(row);
                    return {row, text: `${row.title} ${key}`.toLowerCase()};
                });
                if (note)
                    group.add(new Gtk.Label({label: note, xalign: 0, wrap: true, css_classes: ['dim-label', 'caption', 'mydock-footnote']}));
                entry.sections.push(this._section(page, group, rows));
            }
            stack.add_named(page, title);
            list.append(entry.row);
            return entry;
        });

        list.connect('row-selected', (_l, row) => {
            if (!row)
                return;
            const {title} = pages[row.get_index()];
            stack.visible_child_name = title;
            titleLabel.label = title;
            contentPage.title = title;
        });
        list.connect('row-activated', () => (split.show_content = true));
        list.select_row(pages[0].row);

        search.connect('search-changed', () => {
            const q = search.text.trim().toLowerCase();
            for (const p of pages) {
                const pageHit = !q || p.title.toLowerCase().includes(q);
                let any = pageHit;
                for (const s of p.sections) {
                    let shown = pageHit;
                    for (const r of s.rows) {
                        r.row.visible = pageHit || r.text.includes(q);
                        shown ||= r.row.visible;
                    }
                    s.group.visible = shown;
                    any ||= shown;
                }
                p.row.visible = any;
            }
            const selected = list.get_selected_row();
            if (!selected?.visible) {
                const first = pages.find(p => p.row.visible);
                if (first)
                    list.select_row(first.row);
            }
        });
        search.connect('activate', () => (split.show_content = true));

        // The shell's dialog requires a visible page, so add an empty one and keep the
        // original content referenced while our split view takes over the window.
        window.add(new Adw.PreferencesPage());
        window._origContent = window.get_content();
        window.set_content(split);
        window.title = 'MY DOCK FINDER FOR LINUX';
        window.set_default_size(860, 620);
        window.set_size_request(360, 360); // breakpoints need a minimum size

        const bp = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 560sp')});
        bp.add_setter(split, 'collapsed', true);
        window.add_breakpoint(bp);
    }

    _section(page, group, rows) {
        page.add(group);
        return {group, rows};
    }

    _aboutGroup() {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ['card', 'mydock-hero']});
        box.append(new Gtk.Image({icon_name: 'view-app-grid-symbolic', pixel_size: 44, halign: Gtk.Align.CENTER,
            css_classes: ['mydock-badge', 'mydock-hero-icon', 'mydock-blue']}));
        box.append(new Gtk.Label({label: this.metadata.name ?? 'MY DOCK FINDER FOR LINUX', css_classes: ['title-1']}));
        box.append(new Gtk.Label({label: `Version ${this.metadata['version-name'] ?? this.metadata.version ?? ''}`, css_classes: ['dim-label']}));
        box.append(new Gtk.Label({label: this.metadata.description ?? '', wrap: true, justify: Gtk.Justification.CENTER,
            max_width_chars: 50, css_classes: ['mydock-hero-text']}));
        const url = this.metadata.url;
        if (url) {
            const btn = new Gtk.Button({label: 'View on GitHub', halign: Gtk.Align.CENTER, css_classes: ['pill', 'suggested-action'], margin_top: 8});
            btn.connect('clicked', () => new Gtk.UriLauncher({uri: url}).launch(btn.get_root(), null, null));
            box.append(btn);
        }
        const group = new Adw.PreferencesGroup();
        group.add(box);
        return group;
    }

    _row(settings, skey, key) {
        const title = TITLES[key] ?? skey.get_summary() ?? key;

        if (ENUM_ROWS[key] || INT_CHOICE_ROWS[key]) {
            const isEnum = !!ENUM_ROWS[key];
            const labels = ENUM_ROWS[key] ?? INT_CHOICE_ROWS[key];
            const shown = labels.map(l => l[0].toUpperCase() + l.slice(1));
            const row = new Adw.ComboRow({title, model: Gtk.StringList.new(shown)});
            const read = () => isEnum ? labels.indexOf(settings.get_string(key)) : settings.get_int(key);
            row.selected = Math.max(0, read());
            row.connect('notify::selected', () => isEnum
                ? settings.set_string(key, labels[row.selected])
                : settings.set_int(key, row.selected));
            return row;
        }

        const type = skey.get_value_type().dup_string();
        if (type === 'b') {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        }
        if (type === 'i') {
            const [, range] = skey.get_range().deepUnpack();
            const [lo, hi] = range.deepUnpack();
            if (key in SLIDER_UNITS)
                return sliderRow(settings, key, title, lo, hi, SLIDER_UNITS[key]);
            const row = Adw.SpinRow.new_with_range(lo, hi, 1);
            row.title = title;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        }
        if (type === 'as')
            return shortcutRow(settings, key, title);
        if (PATH_ROWS[key])
            return pathRow(settings, key, title, PATH_ROWS[key] === 'folder');
        const row = new Adw.EntryRow({title});
        settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}

function sidebarRow(title, icon, color) {
    const box = new Gtk.Box({spacing: 10});
    box.append(new Gtk.Image({icon_name: icon, pixel_size: 14, css_classes: ['mydock-badge', `mydock-${color}`]}));
    box.append(new Gtk.Label({label: title, xalign: 0}));
    return new Gtk.ListBoxRow({child: box});
}

function sliderRow(settings, key, title, lo, hi, unit) {
    const row = new Adw.ActionRow({title});
    const adj = new Gtk.Adjustment({lower: lo, upper: hi, step_increment: 1, page_increment: Math.max(1, Math.round((hi - lo) / 10))});
    const scale = new Gtk.Scale({adjustment: adj, draw_value: false, round_digits: 0, width_request: 200, valign: Gtk.Align.CENTER});
    const value = new Gtk.Label({width_chars: 7, xalign: 1, css_classes: ['dim-label', 'numeric']});
    // Explicit sync: GSettings has no double -> int32 mapping for binding an adjustment.
    adj.value = settings.get_int(key);
    value.label = `${adj.value} ${unit}`;
    adj.connect('value-changed', () => {
        const v = Math.round(adj.value);
        value.label = `${v} ${unit}`;
        if (settings.get_int(key) !== v)
            settings.set_int(key, v);
    });
    settings.connect(`changed::${key}`, () => (adj.value = settings.get_int(key)));
    row.add_suffix(scale);
    row.add_suffix(value);
    return row;
}

function pathRow(settings, key, title, folder) {
    const row = new Adw.ActionRow({title, subtitle_lines: 1});
    const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', tooltip_text: 'Use the default', valign: Gtk.Align.CENTER, css_classes: ['flat']});
    const choose = new Gtk.Button({label: 'Choose...', valign: Gtk.Align.CENTER});
    const sync = () => {
        const path = settings.get_string(key);
        row.subtitle = path || 'Default';
        clear.visible = !!path;
    };
    settings.connect(`changed::${key}`, sync);
    sync();
    clear.connect('clicked', () => settings.reset(key));
    choose.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title});
        if (!folder) {
            const filter = new Gtk.FileFilter({name: 'Images'});
            filter.add_mime_type('image/*');
            dialog.default_filter = filter;
        }
        const finish = (d, res) => {
            try {
                const file = folder ? d.select_folder_finish(res) : d.open_finish(res);
                if (file?.get_path())
                    settings.set_string(key, file.get_path());
            } catch {
                // dialog cancelled
            }
        };
        if (folder)
            dialog.select_folder(row.get_root(), null, finish);
        else
            dialog.open(row.get_root(), null, finish);
    });
    row.add_suffix(clear);
    row.add_suffix(choose);
    return row;
}

function shortcutRow(settings, key, title) {
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Gtk.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
    const sync = () => (label.accelerator = settings.get_strv(key)[0] ?? '');
    settings.connect(`changed::${key}`, sync);
    sync();
    row.add_suffix(label);
    row.connect('activated', () => captureShortcut(row, settings, key, title));
    return row;
}

function captureShortcut(row, settings, key, title) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, valign: Gtk.Align.CENTER, margin_bottom: 24});
    box.append(new Gtk.Label({label: 'Press the new shortcut', css_classes: ['title-3']}));
    box.append(new Gtk.Label({label: 'Esc to cancel, Backspace to restore the default', css_classes: ['dim-label']}));
    const view = new Adw.ToolbarView({content: box});
    view.add_top_bar(new Adw.HeaderBar({show_title: false}));
    const win = new Adw.Window({title, modal: true, transient_for: row.get_root(), default_width: 380, default_height: 200, content: view});
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval, keycode, state) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();
        if (!mask && keyval === Gdk.KEY_Escape) {
            win.close();
        } else if (!mask && keyval === Gdk.KEY_BackSpace) {
            settings.reset(key);
            win.close();
        } else if (mask && Gtk.accelerator_valid(keyval, mask)) {
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, Gdk.keyval_to_lower(keyval), keycode, mask)]);
            win.close();
        }
        return Gdk.EVENT_STOP;
    });
    win.add_controller(keys);
    win.present();
}

// Wallpaper-like strip with a dock of the user's favorite apps, following icon size and spacing.
function previewGroup(settings) {
    const dock = new Gtk.Box({halign: Gtk.Align.CENTER, valign: Gtk.Align.END, margin_bottom: 12, css_classes: ['mydock-preview-dock']});
    const shell = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.shell', true);
    const ids = shell ? new Gio.Settings({settings_schema: shell}).get_strv('favorite-apps') : [];
    const gicons = ids.map(id => Gio.DesktopAppInfo.new(id)?.get_icon()).filter(Boolean).slice(0, PREVIEW_ICONS);
    while (gicons.length < 5)
        gicons.push(Gio.ThemedIcon.new('application-x-executable'));
    const images = gicons.map(gicon => new Gtk.Image({gicon}));
    images.forEach(img => dock.append(img));

    const update = () => {
        const size = settings.get_int('icon-size');
        const space = settings.get_int('icon-space');
        const fit = Math.max(3, Math.floor(520 / (size + space)));
        dock.spacing = space;
        images.forEach((img, i) => {
            img.pixel_size = size;
            img.visible = i < fit;
        });
    };
    for (const k of ['icon-size', 'icon-space'])
        settings.connect(`changed::${k}`, update);
    update();

    const strip = new Gtk.Box({css_classes: ['mydock-preview'], height_request: 170, overflow: Gtk.Overflow.HIDDEN});
    dock.hexpand = true;
    strip.append(dock);
    const group = new Adw.PreferencesGroup();
    group.add(strip);
    return group;
}
