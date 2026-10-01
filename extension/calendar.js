// MyDock - month calendar shown above the dock's calendar tile on hover.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function cell(text, styleClass) {
    return new St.Bin({
        style_class: styleClass,
        child: new St.Label({text, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
    });
}

// Header "YYYY/M/D Weekday", a Sun..Sat row and the month grid with today circled.
// refresh() rebuilds only when the date changed.
export function makeMonthCalendar() {
    const w = new St.BoxLayout({style_class: 'mydock-month', vertical: true, visible: false});
    const header = new St.Label({style_class: 'mydock-month-header'});
    const layout = new Clutter.GridLayout({row_spacing: 6, column_spacing: 6});
    const grid = new St.Widget({style_class: 'mydock-month-grid', layout_manager: layout});
    w.add_child(header);
    w.add_child(grid);
    WEEKDAYS.forEach((d, i) => layout.attach(cell(d, 'mydock-month-cell mydock-month-weekday'), i, 0, 1, 1));

    let days = [];
    let key = null;
    w.refresh = () => {
        const now = GLib.DateTime.new_now_local();
        const k = now.format('%F');
        if (k === key)
            return;
        key = k;
        header.text = now.format('%Y/%-m/%-d %A');
        days.forEach(d => d.destroy());
        days = [];
        const first = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0);
        const count = first.add_months(1).add_days(-1).get_day_of_month();
        const lead = first.get_day_of_week() % 7; // 7 = Sunday -> column 0
        const today = now.get_day_of_month();
        for (let d = 1; d <= count; d++) {
            const c = cell(`${d}`, d === today ? 'mydock-month-cell mydock-month-today' : 'mydock-month-cell');
            const n = lead + d - 1;
            layout.attach(c, n % 7, 1 + Math.floor(n / 7), 1, 1);
            days.push(c);
        }
    };
    return w;
}
