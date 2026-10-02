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

// [page title, icon, badge color, groups, style?]
// A group is [title, [key, ...], footnote?] or the name of a custom builder in CUSTOM_GROUPS.
// style 'cards' draws each group as a rounded card; other pages are a plain list like the
// MyDock and MyFinder pages of the reference. A plain string starts a new sidebar section.
const PAGES = [
    ['General', 'preferences-system-symbolic', 'graphite', [
        ['', ['finderbar-enabled', 'dock-enabled']],
        'appearance',
        ['', ['theme-path'],
            'A theme folder holds a stylesheet.css and an icons/ folder. Leave it empty for the built-in look.'],
    ], 'cards'],
    ['Stage Manager', 'view-dual-symbolic', 'blue', [
        ['', ['stage-manager'],
            'Stage Manager keeps the current window in the center and arranges your other windows in a strip on the left.'],
        ['', ['stage-show-title', 'stage-count', 'stage-size']],
    ], 'cards'],
    'MyDock',
    ['Look & Behaviour', 'video-single-display-symbolic', 'dark', [
        'preview',
        ['', ['icon-size', 'magnify', 'max-size', 'icon-space', 'edge-distance', 'blur', 'blur-windows', 'opacity'],
            'Blurring windows behind the Dock costs more and leaves the corner tips slightly blurred.'],
    ]],
    ['Launchpad', 'view-app-grid-symbolic', 'dark', [
        ['', ['show-launchpad', 'launchpad-hotkey'], 'Click the shortcut to record a new one.'],
    ]],
    ['Advanced', 'emblem-system-symbolic', 'grey', [
        ['', ['autohide', 'multi-monitor', 'show-labels', 'show-running-dots', 'bounce-on-launch',
            'show-trash', 'show-calendar', 'show-clock']],
    ]],
    ['Minimize Effects', 'focus-windows-symbolic', 'blue', [
        ['', ['minimize-effect', 'minimize-duration']],
    ]],
    'MyFinder',
    ['Look & Behaviour', 'focus-top-bar-symbolic', 'dark', [
        ['', ['logo-path', 'finderbar-blur', 'finderbar-status-menus', 'window-buttons-left', 'traffic-lights'],
            'Traffic light colors apply to GTK apps you open next; restart open apps to see them.'],
    ]],
    ['Time & Date', 'x-office-calendar-symbolic', 'blue', [
        ['', ['time-format'], 'The clock uses GLib strftime codes, for example %a %-d %b  %-I:%M %p.'],
    ]],
    ['Hardware Status', 'mydock-cpu-symbolic', 'red', [
        ['', ['finderbar-stats']],
        ['', ['stats-cpu']], ['', ['stats-temp']], ['', ['stats-mem']], ['', ['stats-disk']], ['', ['stats-net']],
    ], 'cards'],
    'More',
    // groups are built by _aboutSections (hero, Software Update, Support, GitHub)
    ['About', 'help-about-symbolic', 'grey', [], 'about'],
];

// Friendlier titles than the schema summaries (the summary is the fallback).
const TITLES = {
    'dock-enabled': 'Enable myDock',
    'autohide': 'Automatically hide and show the Dock',
    'multi-monitor': 'Show the Dock on all displays',
    'edge-distance': 'Dock distance from screen edge',
    'icon-size': 'Icon size',
    'magnify': 'Magnify icons on hover',
    'max-size': 'Icon magnification',
    'icon-space': 'Distance between icons',
    'bounce-on-launch': 'Animate opening applications',
    'show-labels': 'Show app names on hover',
    'show-running-dots': 'Show indicators for open applications',
    'blur': 'Background blur intensity',
    'blur-windows': 'Blur windows behind the Dock',
    'opacity': 'Background opacity',
    'show-launchpad': 'Show Launchpad in the Dock',
    'show-trash': 'Show Trash in the Dock',
    'show-calendar': 'Show a live calendar in the Dock',
    'show-clock': 'Show a live clock in the Dock',
    'finderbar-enabled': 'Enable myFinder',
    'finderbar-blur': 'Translucent Finder background',
    'finderbar-status-menus': 'Show status menus and Control Center in Finder',
    'finderbar-stats': 'Show hardware status in Finder',
    'stats-cpu': 'Processor',
    'stats-temp': 'Temperatures',
    'stats-mem': 'Memory',
    'stats-disk': 'Storage',
    'stats-net': 'Network',
    'logo-path': 'MyFinder menu icon',
    'time-format': 'Time format',
    'window-buttons-left': 'Window buttons on the left (macOS order)',
    'traffic-lights': 'Red, yellow and green window buttons',
    'stage-manager': 'Enable Stage Manager',
    'stage-count': 'Groups in the strip',
    'stage-size': 'Window list icon size',
    'stage-show-title': 'Show window titles',
    'minimize-effect': 'Minimize animation',
    'minimize-duration': 'Minimize animation length',
    'launchpad-hotkey': 'Show Launchpad shortcut',
    'theme-path': 'Theme folder',
    'check-updates': 'Check for updates automatically',
};

// Booleans drawn as a switch on the right; every other boolean is a checkbox.
const SWITCHES = new Set(['dock-enabled', 'finderbar-enabled', 'stage-manager', 'finderbar-stats',
    'stats-cpu', 'stats-temp', 'stats-mem', 'stats-disk', 'stats-net', 'check-updates']);
// Large glyph in front of a switch row (Hardware Status cards).
const ROW_ICONS = {
    'stats-cpu': 'mydock-cpu-symbolic', 'stats-temp': 'mydock-temp-symbolic', 'stats-mem': 'mydock-memory-symbolic',
    'stats-disk': 'mydock-disk-symbolic', 'stats-net': 'mydock-network-symbolic',
};
const CUSTOM_GROUPS = {appearance: appearanceGroup, preview: previewGroup};

const ENUM_ROWS = {
    'minimize-effect': ['none', 'scale', 'genie', 'suck'],
};
// dark-mode values shown as thumbnail cards on the General page
const APPEARANCES = [['Light', 1, 'light'], ['Dark', 2, 'dark'], ['Follow OS', 0, 'auto']];
// Int keys are sliders; the unit shows in the tooltip since the reference sliders have no value label.
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
// Tick count for long slider ranges (prefs.css lifts the marks onto the track).
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
        // the Finder bar's meter glyphs, reused on Hardware Status
        Gtk.IconTheme.get_for_display(display).add_search_path(`${this.path}/icons`);
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
            const [title, icon, color, groups, style] = def;
            // list pages drop the card chrome; cards stay on the top pages and About
            const page = new Adw.PreferencesPage({css_classes: style ? [] : ['mydock-list']});
            const entry = {title, page, sections: [], row: sidebarRow(title, icon, color)};
            entry.row._page = entry;
            headers.at(-1)?.pages.push(entry);
            if (style === 'about')
                entry.sections.push(...this._aboutSections(page, window, settings, schema));
            for (const def of groups) {
                if (typeof def === 'string') {
                    const group = CUSTOM_GROUPS[def](settings);
                    entry.sections.push(this._section(page, group, group._search ? [group._search] : []));
                    continue;
                }
                const [gTitle, keys, note] = def;
                const group = new Adw.PreferencesGroup({title: gTitle});
                const rows = keys.map(key => {
                    const rowTitle = TITLES[key] ?? schema.get_key(key).get_summary() ?? key;
                    const row = this._row(settings, schema.get_key(key), key, rowTitle);
                    if (DEPENDS[key])
                        settings.bind(DEPENDS[key], row, 'sensitive', Gio.SettingsBindFlags.GET);
                    group.add(row);
                    return {row, text: `${rowTitle} ${key}`.toLowerCase()};
                });
                if (note)
                    group.add(new Gtk.Label({label: note, xalign: 0, wrap: true, css_classes: ['dim-label', 'caption', 'mydock-footnote']}));
                entry.sections.push(this._section(page, group, rows));
            }
            // titles repeat across sections (Look & Behaviour), so pages are keyed by object
            stack.add_child(page);
            list.append(entry.row);
            pages.push(entry);
        }

        list.connect('row-selected', (_l, row) => {
            if (!row?._page)
                return;
            const {title, page} = row._page;
            stack.visible_child = page;
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
        const update = new Adw.PreferencesGroup({title: 'Software Update', css_classes: ['mydock-update']});
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
            status.subtitle = `Last checked: ${t ? GLib.DateTime.new_from_unix_local(t).format('%x %X') : 'Never'}`;
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
        const auto = this._row(settings, schema.get_key('check-updates'), 'check-updates', TITLES['check-updates']);
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
                {row: auto, text: `${TITLES['check-updates']} check-updates`.toLowerCase()},
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

    // Booleans are a checkbox, or a switch on the right for SWITCHES. Everything else is
    // stacked like the reference: a bold title with its control underneath.
    _row(settings, skey, key, title) {
        const type = skey.get_value_type().dup_string();
        if (type === 'b' && !SWITCHES.has(key)) {
            const check = new Gtk.CheckButton({label: title, css_classes: ['mydock-check']});
            settings.bind(key, check, 'active', Gio.SettingsBindFlags.DEFAULT);
            return listRow(check, 'mydock-check-row');
        }
        if (type === 'b') {
            const box = new Gtk.Box({spacing: 14});
            if (ROW_ICONS[key])
                box.append(new Gtk.Image({icon_name: ROW_ICONS[key], pixel_size: 30, css_classes: ['mydock-row-icon']}));
            box.append(new Gtk.Label({label: title, xalign: 0, hexpand: true, wrap: true, css_classes: ['mydock-row-title']}));
            const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
            settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            box.append(toggle);
            return listRow(box, 'mydock-switch-row');
        }

        let control;
        if (ENUM_ROWS[key]) {
            control = enumPopup(settings, key);
        } else if (type === 'i') {
            const [, range] = skey.get_range().deepUnpack();
            const [lo, hi] = range.deepUnpack();
            control = slider(settings, key, lo, hi, SLIDER_UNITS[key] ?? '');
        } else if (type === 'as') {
            control = shortcutButton(settings, key, title);
        } else if (PATH_ROWS[key]) {
            control = pathPicker(settings, key, title, PATH_ROWS[key] === 'folder');
        } else {
            control = textEntry(settings, key);
        }
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        box.append(new Gtk.Label({label: title, xalign: 0, wrap: true, css_classes: ['mydock-row-title']}));
        box.append(control);
        return listRow(box, 'mydock-stack-row');
    }
}

function listRow(child, cls) {
    return new Gtk.ListBoxRow({child, activatable: false, selectable: false, css_classes: [cls]});
}

function sidebarRow(title, icon, color) {
    const box = new Gtk.Box({spacing: 9});
    box.append(new Gtk.Image({icon_name: icon, pixel_size: 12, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER, css_classes: ['mydock-badge', `mydock-${color}`]}));
    box.append(new Gtk.Label({label: title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ['mydock-sidebar-label']}));
    return new Gtk.ListBoxRow({child: box});
}

// compact grey popup button with the blue chevron cap
function enumPopup(settings, key) {
    const labels = ENUM_ROWS[key];
    const shown = labels.map(l => l[0].toUpperCase() + l.slice(1));
    const drop = new Gtk.DropDown({model: Gtk.StringList.new(shown), halign: Gtk.Align.START, css_classes: ['mydock-popup']});
    drop.selected = Math.max(0, labels.indexOf(settings.get_string(key)));
    drop.connect('notify::selected', () => settings.set_string(key, labels[drop.selected]));
    settings.connect(`changed::${key}`, () => (drop.selected = Math.max(0, labels.indexOf(settings.get_string(key)))));
    return drop;
}

// Ticks on the track: one per step for short ranges, SLIDER_TICKS otherwise.
function slider(settings, key, lo, hi, unit) {
    const adj = new Gtk.Adjustment({lower: lo, upper: hi, step_increment: 1, page_increment: Math.max(1, Math.round((hi - lo) / 10))});
    const scale = new Gtk.Scale({adjustment: adj, draw_value: false, round_digits: 0, hexpand: true, css_classes: ['mydock-scale']});
    const steps = hi - lo <= 12 ? hi - lo : SLIDER_TICKS;
    for (let i = 0; i <= steps; i++)
        scale.add_mark(lo + (hi - lo) * i / steps, Gtk.PositionType.BOTTOM, null);
    const tip = v => (scale.tooltip_text = unit ? `${v} ${unit}` : `${v}`);
    // Explicit sync: GSettings has no double -> int32 mapping for binding an adjustment.
    adj.value = settings.get_int(key);
    tip(adj.value);
    adj.connect('value-changed', () => {
        const v = Math.round(adj.value);
        tip(v);
        if (settings.get_int(key) !== v)
            settings.set_int(key, v);
    });
    settings.connect(`changed::${key}`, () => (adj.value = settings.get_int(key)));
    return scale;
}

// Plain text field; the clock format also shows what it renders right now.
function textEntry(settings, key) {
    const entry = new Gtk.Entry({width_chars: 26, halign: Gtk.Align.START, css_classes: ['mydock-entry']});
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    if (key !== 'time-format')
        return entry;
    const sample = new Gtk.Label({xalign: 0, css_classes: ['dim-label', 'mydock-sample']});
    const sync = () => (sample.label = GLib.DateTime.new_now_local().format(settings.get_string(key)) || 'Invalid format');
    settings.connect(`changed::${key}`, sync);
    sync();
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
    box.append(entry);
    box.append(sample);
    return box;
}

function pathPicker(settings, key, title, folder) {
    const box = new Gtk.Box({spacing: 8});
    const choose = new Gtk.Button({label: 'Choose...', css_classes: ['mydock-pill']});
    const label = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.MIDDLE, css_classes: ['dim-label']});
    const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', tooltip_text: 'Use the default', css_classes: ['flat', 'mydock-clear']});
    const sync = () => {
        const path = settings.get_string(key);
        label.label = path || 'Default';
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
            dialog.select_folder(box.get_root(), null, finish);
        else
            dialog.open(box.get_root(), null, finish);
    });
    box.append(choose);
    box.append(label);
    box.append(clear);
    return box;
}

function shortcutButton(settings, key, title) {
    const label = new Gtk.ShortcutLabel({disabled_text: 'Disabled'});
    const button = new Gtk.Button({child: label, halign: Gtk.Align.START, tooltip_text: 'Click to record a new shortcut', css_classes: ['mydock-pill']});
    const sync = () => (label.accelerator = settings.get_strv(key)[0] ?? '');
    settings.connect(`changed::${key}`, sync);
    sync();
    button.connect('clicked', () => captureShortcut(button, settings, key, title));
    return button;
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
    group._search = {row: picker, text: 'appearance light dark follow os mode'};
    return group;
}
