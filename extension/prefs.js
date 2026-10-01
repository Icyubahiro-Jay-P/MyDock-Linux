// MY DOCK FINDER FOR LINUX settings window, laid out like macOS System Settings: a searchable sidebar of
// categories with colored badges and a content pane of rounded cards. Rows are generated
// from the tables below; every key applies live.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {compareVersions} from './version.js';

// [page title, icon, badge color, [[group title, [key, ...], footnote?], ...], header?]
// A plain string starts a new titled section in the sidebar.
const PAGES = [
    ['General', 'preferences-system-symbolic', 'graphite', [
        ['Theme', ['theme-path'],
            'A theme folder holds a stylesheet.css and an icons/ folder. Leave it empty for the built-in look.'],
    ], 'appearance'],
    ['Stage Manager', 'view-dual-symbolic', 'cyan', [
        ['', ['stage-manager'],
            'Stage Manager keeps the current window in the center and arranges your other windows in a strip on the left.'],
        ['Strip', ['stage-count', 'stage-size', 'stage-show-title']],
    ]],
    ['Effects', 'applications-graphics-symbolic', 'maroon', [
        ['Minimize', ['minimize-effect', 'minimize-duration']],
        ['Launchpad', ['launchpad-hotkey'], 'Click the shortcut to record a new one.'],
    ]],
    'MyDock',
    ['Dock', 'view-app-grid-symbolic', 'blue', [
        ['', ['dock-enabled', 'autohide', 'multi-monitor', 'edge-distance']],
        ['Icons', ['icon-size', 'magnify', 'max-size', 'icon-space', 'bounce-on-launch', 'show-labels', 'show-running-dots']],
        ['Background', ['blur', 'blur-windows', 'opacity'],
            'Blurring windows behind the Dock costs more and leaves the corner tips slightly blurred.'],
        ['Extra icons', ['show-launchpad', 'show-trash', 'show-calendar', 'show-clock']],
    ], 'preview'],
    'MyFinder',
    ['Finder Bar', 'preferences-desktop-display-symbolic', 'purple', [
        ['', ['finderbar-enabled', 'finderbar-blur', 'finderbar-status-menus']],
        ['System stats', ['finderbar-stats', 'stats-cpu', 'stats-temp', 'stats-mem', 'stats-disk', 'stats-net'],
            'Pick which meters appear in the top bar.'],
        ['Menu and clock', ['logo-path', 'time-format'],
            'The clock uses GLib strftime codes, for example %a %-d %b  %-I:%M %p.'],
    ]],
    ['Windows', 'focus-windows-symbolic', 'red', [
        ['Title bar buttons', ['window-buttons-left', 'traffic-lights'],
            'Puts close, minimize and maximize on the left like macOS. Traffic light colors apply to GTK apps you open next; restart open apps to see them.'],
    ]],
    'More',
    // groups are built by _aboutSections (hero, Software Update, Support, GitHub)
    ['About', 'help-about-symbolic', 'grey', [], 'about'],
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
    'blur-windows': 'Blur windows behind the Dock',
    'opacity': 'Opacity',
    'show-launchpad': 'Launchpad',
    'show-trash': 'Trash',
    'show-calendar': 'Live calendar',
    'show-clock': 'Live clock',
    'finderbar-enabled': 'Show the Finder bar',
    'finderbar-blur': 'Translucent background',
    'finderbar-status-menus': 'Status menus and Control Center',
    'finderbar-stats': 'Show system stats',
    'stats-cpu': 'CPU usage',
    'stats-temp': 'CPU temperature',
    'stats-mem': 'Memory usage',
    'stats-disk': 'Disk usage',
    'stats-net': 'Network upload and download',
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
    'theme-path': 'Theme folder',
    'check-updates': 'Check for updates automatically',
};

const ENUM_ROWS = {
    'minimize-effect': ['none', 'scale', 'genie', 'suck'],
};
// dark-mode values shown as thumbnail cards on the General page
const APPEARANCES = [['Light', 1, 'light'], ['Dark', 2, 'dark'], ['Follow OS', 0, 'auto']];
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
    'finderbar-status-menus': 'finderbar-enabled',
    'finderbar-stats': 'finderbar-enabled',
    'stats-cpu': 'finderbar-stats',
    'stats-temp': 'finderbar-stats',
    'stats-mem': 'finderbar-stats',
    'stats-disk': 'finderbar-stats',
    'stats-net': 'finderbar-stats',
    'traffic-lights': 'window-buttons-left',
    'stage-count': 'stage-manager',
    'stage-size': 'stage-manager',
    'stage-show-title': 'stage-manager',
};

const PREVIEW_ICONS = 8;
// Scale ticks like the reference sliders (marks drawn under the trough).
const SLIDER_TICKS = 8;

const AUTHOR = 'Irakoze Icyubahiro Jean Pierre (@Icyubahiro-Jay-P)';
const RELEASES_URL = 'https://api.github.com/repos/Icyubahiro-Jay-P/MyDock-Linux/releases/latest';
const MOMO_NUMBER = '0789124135';
const MOMO_NAME = 'Nirere Gaudelive';

export default class MyDockPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window
        const schema = settings.settings_schema;

        const css = new Gtk.CssProvider();
        css.load_from_path(`${this.path}/prefs.css`);
        const display = Gdk.Display.get_default();
        // above USER: a full theme in ~/.config/gtk-4.0/gtk.css would otherwise restyle our buttons
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);
        // Charcoal palette only under the dark style; light mode keeps the libadwaita colors.
        window.add_css_class('mydock-window');
        const styles = Adw.StyleManager.get_default();
        const syncDark = () => (styles.dark ? window.add_css_class('mydock-dark') : window.remove_css_class('mydock-dark'));
        const darkId = styles.connect('notify::dark', syncDark);
        syncDark();
        window.connect('close-request', () => {
            styles.disconnect(darkId);
            Gtk.StyleContext.remove_provider_for_display(display, css);
            return false;
        });

        // Sidebar
        const search = new Gtk.SearchEntry({placeholder_text: 'Search', margin_start: 10, margin_end: 10, margin_bottom: 8, css_classes: ['mydock-search']});
        const list = new Gtk.ListBox({css_classes: ['navigation-sidebar', 'mydock-sidebar']});
        const sidebarBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        sidebarBox.append(search);
        sidebarBox.append(new Gtk.ScrolledWindow({
            child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        // our own traffic lights replace the theme's title buttons
        const sidebarHeader = new Adw.HeaderBar({show_title: false, show_start_title_buttons: false, show_end_title_buttons: false});
        sidebarHeader.pack_start(windowDots(window));
        const sidebarView = new Adw.ToolbarView({content: sidebarBox, css_classes: ['mydock-sidebar-pane']});
        sidebarView.add_top_bar(sidebarHeader);

        // Content
        const stack = new Gtk.Stack();
        const titleLabel = new Gtk.Label({css_classes: ['mydock-page-title']});
        const header = new Adw.HeaderBar({title_widget: new Gtk.Box(), show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(titleLabel);
        const contentView = new Adw.ToolbarView({content: stack, css_classes: ['mydock-content-pane']});
        contentView.add_top_bar(header);
        const contentPage = new Adw.NavigationPage({child: contentView, title: 'General'});

        const split = new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({child: sidebarView, title: 'MY DOCK FINDER FOR LINUX'}),
            content: contentPage,
            min_sidebar_width: 210,
            max_sidebar_width: 240,
            css_classes: ['mydock-prefs'],
        });

        // Build every page and remember rows for search.
        const pages = [];
        const headers = []; // {row, pages}
        for (const def of PAGES) {
            if (typeof def === 'string') {
                const row = new Gtk.ListBoxRow({selectable: false, activatable: false, css_classes: ['mydock-sidebar-header-row'],
                    child: new Gtk.Label({label: def, xalign: 0, css_classes: ['mydock-sidebar-header']})});
                list.append(row);
                headers.push({row, pages: []});
                continue;
            }
            const [title, icon, color, groups, extra] = def;
            const page = new Adw.PreferencesPage();
            const entry = {title, sections: [], row: sidebarRow(title, icon, color)};
            entry.row._page = entry;
            headers.at(-1)?.pages.push(entry);
            if (extra === 'appearance') {
                const group = appearanceGroup(settings);
                entry.sections.push(this._section(page, group, [{row: group._picker, text: 'appearance light dark follow os mode'}]));
            }
            if (extra === 'preview')
                entry.sections.push(this._section(page, previewGroup(settings), []));
            if (extra === 'about')
                entry.sections.push(...this._aboutSections(page, window, settings, schema));
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
            pages.push(entry);
        }

        list.connect('row-selected', (_l, row) => {
            if (!row?._page)
                return;
            const {title} = row._page;
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
            for (const h of headers)
                h.row.visible = h.pages.some(p => p.row.visible);
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
        // collapsed: the content page is shown alone, so give it a close button
        bp.add_setter(header, 'show_end_title_buttons', true);
        window.add_breakpoint(bp);
    }

    _section(page, group, rows) {
        page.add(group);
        return {group, rows};
    }

    // About page, top to bottom: hero, Software Update, Support, GitHub link.
    _aboutSections(page, window, settings, schema) {
        const md = this.metadata;
        const name = md.name ?? 'MY DOCK FINDER FOR LINUX';
        const version = String(md['version-name'] ?? md.version ?? '');
        const center = Gtk.Align.CENTER;

        // Hero
        const hero = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, css_classes: ['card', 'mydock-hero']});
        hero.append(new Gtk.Image({icon_name: 'view-app-grid-symbolic', pixel_size: 44, halign: center,
            css_classes: ['mydock-badge', 'mydock-hero-icon', 'mydock-blue']}));
        hero.append(new Gtk.Label({label: name, wrap: true, justify: Gtk.Justification.CENTER, css_classes: ['mydock-hero-name']}));
        hero.append(new Gtk.Label({label: `Version ${version}`, css_classes: ['dim-label', 'numeric']}));
        // "Name (@handle)" -> "by Name @handle" with the handle linking to GitHub
        const author = String(md.author ?? AUTHOR).trim();
        const m = /^(.*?)\s*\(@([\w-]+)\)$/.exec(author);
        const by = `by ${GLib.markup_escape_text(m ? m[1] : author, -1)}`;
        hero.append(new Gtk.Label({use_markup: true, wrap: true, justify: Gtk.Justification.CENTER, margin_top: 4, css_classes: ['mydock-hero-author'],
            label: m ? `${by} <a href="https://github.com/${m[2]}">@${m[2]}</a>` : by}));
        if (md.description) {
            hero.append(new Gtk.Label({label: md.description, wrap: true, justify: Gtk.Justification.CENTER,
                max_width_chars: 50, margin_top: 6, css_classes: ['dim-label', 'mydock-hero-text']}));
        }
        const heroGroup = new Adw.PreferencesGroup({css_classes: ['mydock-plain']});
        heroGroup.add(hero);

        // Software Update: manual check against the latest GitHub release.
        const update = new Adw.PreferencesGroup({title: 'Software Update'});
        const status = new Adw.ActionRow({title: `${name} ${version}`, use_markup: false, css_classes: ['mydock-update-row']});
        const spinner = new Gtk.Spinner({visible: false, valign: center});
        const updateNow = new Gtk.Button({label: 'Update Now', visible: false, valign: center, css_classes: ['suggested-action', 'mydock-button']});
        const check = new Gtk.Button({label: 'Check for Updates', valign: center, css_classes: ['mydock-button']});
        status.add_suffix(spinner);
        status.add_suffix(updateNow);
        status.add_suffix(check);
        let manual = 0; // this window's own check; never written to last-update-check (the shell updater watches it)
        const syncTime = () => {
            const t = Math.max(Number(settings.get_int64('last-update-check')), manual);
            status.subtitle = `Last checked: ${t ? GLib.DateTime.new_from_unix_local(t).format('%c') : 'Never'}`;
        };
        settings.connect('changed::last-update-check', syncTime);
        syncTime();

        let cancellable = null;
        const busy = on => {
            check.sensitive = !on;
            spinner.visible = spinner.spinning = on;
        };
        const done = text => {
            status.title = text;
            busy(false);
        };
        check.connect('clicked', () => {
            busy(true);
            updateNow.visible = false;
            status.remove_css_class('mydock-error');
            status.title = 'Checking for updates...';
            cancellable = new Gio.Cancellable();
            const msg = Soup.Message.new('GET', RELEASES_URL);
            msg.request_headers.append('Accept', 'application/vnd.github+json');
            const session = new Soup.Session({user_agent: `MyDock/${version}`, timeout: 20});
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    if (msg.get_status() !== Soup.Status.OK)
                        throw new Error(`GitHub answered with HTTP ${msg.get_status()}`);
                    const tag = String(JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())).tag_name ?? '').replace(/^v/, '');
                    if (!/^\d+(\.\d+)*$/.test(tag))
                        throw new Error('the latest release has an unexpected version tag');
                    manual = Math.floor(Date.now() / 1000);
                    syncTime();
                    const newer = compareVersions(tag, version) > 0;
                    updateNow.visible = newer;
                    done(newer ? `Version ${tag} is available` : `${name} is up to date`);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return; // window closed, widgets are gone
                    status.add_css_class('mydock-error');
                    done(`Could not check for updates: ${e.message}`);
                }
            });
        });
        // The shell updater treats last-update-check = 0 as "check now" and posts a one-click notification.
        updateNow.connect('clicked', () => {
            settings.set_string('skipped-version', '');
            settings.set_int64('last-update-check', 0);
            updateNow.visible = false;
            status.title = 'Look for the update notification at the top of the screen.';
        });
        const auto = this._row(settings, schema.get_key('check-updates'), 'check-updates');
        update.add(status);
        update.add(auto);
        update.add(new Gtk.Label({label: `${name} checks GitHub once a day and offers a one-click update.`,
            xalign: 0, wrap: true, css_classes: ['dim-label', 'caption', 'mydock-footnote']}));

        // Support
        const support = new Adw.PreferencesGroup({title: 'Support this app', css_classes: ['mydock-support'],
            description: `If ${name} helps you, you can support its development with MTN Mobile Money (MoMo).`});
        const momo = new Adw.ActionRow({title: MOMO_NUMBER, subtitle: `Account name: ${MOMO_NAME}`, use_markup: false,
            css_classes: ['mydock-momo']});
        momo.add_prefix(new Gtk.Image({icon_name: 'phone-symbolic', pixel_size: 12, valign: center,
            css_classes: ['mydock-badge', 'mydock-orange']}));
        const copy = new Gtk.Button({label: 'Copy Number', valign: center, css_classes: ['mydock-button']});
        let copyTimer = 0;
        copy.connect('clicked', () => {
            copy.get_clipboard().set(MOMO_NUMBER);
            copy.label = 'Copied';
            if (copyTimer)
                GLib.source_remove(copyTimer);
            copyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                copy.label = 'Copy Number';
                copyTimer = 0;
                return GLib.SOURCE_REMOVE;
            });
        });
        momo.add_suffix(copy);
        support.add(momo);

        window.connect('close-request', () => {
            cancellable?.cancel();
            if (copyTimer)
                GLib.source_remove(copyTimer);
            copyTimer = 0;
            return false;
        });

        const sections = [
            this._section(page, heroGroup, [{row: hero, text: `about version author ${name} ${author}`.toLowerCase()}]),
            this._section(page, update, [
                {row: status, text: 'software update check for updates version'},
                {row: auto, text: `${auto.title} check-updates`.toLowerCase()},
            ]),
            this._section(page, support, [{row: momo, text: 'support donate mtn mobile money momo copy number'}]),
        ];
        if (md.url) {
            const btn = new Gtk.Button({label: 'View on GitHub', halign: center, css_classes: ['pill', 'suggested-action', 'mydock-github']});
            btn.connect('clicked', () => new Gtk.UriLauncher({uri: md.url}).launch(btn.get_root(), null, null));
            const linkGroup = new Adw.PreferencesGroup({css_classes: ['mydock-plain']});
            linkGroup.add(btn);
            sections.push(this._section(page, linkGroup, [{row: btn, text: 'github source code website'}]));
        }
        return sections;
    }

    _row(settings, skey, key) {
        const title = TITLES[key] ?? skey.get_summary() ?? key;

        if (ENUM_ROWS[key]) {
            const labels = ENUM_ROWS[key];
            const shown = labels.map(l => l[0].toUpperCase() + l.slice(1));
            // compact macOS popup button instead of a full-width combo row
            const drop = new Gtk.DropDown({model: Gtk.StringList.new(shown), valign: Gtk.Align.CENTER, css_classes: ['mydock-popup']});
            drop.selected = Math.max(0, labels.indexOf(settings.get_string(key)));
            drop.connect('notify::selected', () => settings.set_string(key, labels[drop.selected]));
            settings.connect(`changed::${key}`, () => (drop.selected = Math.max(0, labels.indexOf(settings.get_string(key)))));
            const row = new Adw.ActionRow({title, activatable_widget: drop});
            row.add_suffix(drop);
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
    const box = new Gtk.Box({spacing: 9});
    box.append(new Gtk.Image({icon_name: icon, pixel_size: 12, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER, css_classes: ['mydock-badge', `mydock-${color}`]}));
    box.append(new Gtk.Label({label: title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ['mydock-sidebar-label']}));
    return new Gtk.ListBoxRow({child: box});
}

function sliderRow(settings, key, title, lo, hi, unit) {
    const row = new Adw.ActionRow({title});
    const adj = new Gtk.Adjustment({lower: lo, upper: hi, step_increment: 1, page_increment: Math.max(1, Math.round((hi - lo) / 10))});
    const scale = new Gtk.Scale({adjustment: adj, draw_value: false, round_digits: 0, width_request: 220, valign: Gtk.Align.CENTER, css_classes: ['mydock-scale']});
    for (let i = 0; i <= SLIDER_TICKS; i++)
        scale.add_mark(lo + (hi - lo) * i / SLIDER_TICKS, Gtk.PositionType.BOTTOM, null);
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
    const group = new Adw.PreferencesGroup({css_classes: ['mydock-plain']});
    group.add(strip);
    return group;
}

// macOS window controls: grey dots that light up on hover.
function windowDots(window) {
    const box = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER, margin_start: 6, css_classes: ['mydock-dots']});
    for (const [name, tip, fn] of [
        ['close', 'Close', () => window.close()],
        ['minimize', 'Minimize', () => window.minimize()],
        ['maximize', 'Zoom', () => (window.is_maximized() ? window.unmaximize() : window.maximize())],
    ]) {
        const btn = new Gtk.Button({tooltip_text: tip, valign: Gtk.Align.CENTER, css_classes: ['mydock-dot', `mydock-dot-${name}`]});
        btn.connect('clicked', fn);
        box.append(btn);
    }
    return box;
}

// Light / Dark / Follow OS as mini desktop thumbnails bound to dark-mode.
function appearanceGroup(settings) {
    const picker = new Gtk.Box({spacing: 18, halign: Gtk.Align.START, valign: Gtk.Align.START, margin_top: 4, margin_bottom: 4});
    const buttons = APPEARANCES.map(([label, value, kind]) => {
        const thumb = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, width_request: 96, height_request: 64, vexpand: false,
            overflow: Gtk.Overflow.HIDDEN, css_classes: ['mydock-thumb', `mydock-thumb-${kind}`]});
        thumb.append(new Gtk.Box({halign: Gtk.Align.START, margin_start: 8, margin_top: 8,
            width_request: 46, height_request: 24, css_classes: ['mydock-thumb-window']}));
        thumb.append(new Gtk.Box({halign: Gtk.Align.CENTER, valign: Gtk.Align.END, vexpand: true, margin_bottom: 6,
            width_request: 60, height_request: 10, css_classes: ['mydock-thumb-dock']}));
        const col = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, valign: Gtk.Align.START});
        col.append(thumb);
        col.append(new Gtk.Label({label}));
        const btn = new Gtk.ToggleButton({child: col, tooltip_text: label, css_classes: ['flat', 'mydock-appearance']});
        btn.connect('toggled', () => {
            if (btn.active && settings.get_int('dark-mode') !== value)
                settings.set_int('dark-mode', value);
        });
        picker.append(btn);
        return [btn, value];
    });
    buttons.slice(1).forEach(([b]) => b.set_group(buttons[0][0]));
    const sync = () => buttons.forEach(([b, v]) => (b.active = settings.get_int('dark-mode') === v));
    settings.connect('changed::dark-mode', sync);
    sync();

    const group = new Adw.PreferencesGroup({title: 'Appearance'});
    group.add(picker);
    group._picker = picker;
    return group;
}
