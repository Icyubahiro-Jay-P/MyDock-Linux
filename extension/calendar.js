// MyDock - month calendar shown above the dock's calendar tile on hover.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {monthGrid, weekdayOrder} from './calendar-math.js';

// localized short weekday name, dow 0 = Sunday (2023-01-01 was a Sunday)
const weekdayName = dow => GLib.DateTime.new_local(2023, 1, 1 + dow, 0, 0, 0).format('%a');

function cell(text, styleClass) {
    return new St.Bin({
        style_class: styleClass,
        child: new St.Label({text, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
    });
}

// Header "YYYY/M/D Weekday", a weekday row starting on the locale's first day and the
// month grid with today circled.
// refresh() rebuilds only when the date changed.
export function makeMonthCalendar() {
    const w = new St.BoxLayout({style_class: 'mydock-month', orientation: Clutter.Orientation.VERTICAL, visible: false});
    const header = new St.Label({style_class: 'mydock-month-header'});
    const layout = new Clutter.GridLayout({row_spacing: 6, column_spacing: 6});
    const grid = new St.Widget({style_class: 'mydock-month-grid', layout_manager: layout});
    w.add_child(header);
    w.add_child(grid);
    const weekStart = Shell.util_get_week_start();
    weekdayOrder(weekStart).forEach((dow, i) =>
        layout.attach(cell(weekdayName(dow), 'mydock-month-cell mydock-month-weekday'), i, 0, 1, 1));

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
        const today = now.get_day_of_month();
        for (const {day, col, row} of monthGrid(now.get_year(), now.get_month(), weekStart)) {
            const c = cell(`${day}`, day === today ? 'mydock-month-cell mydock-month-today' : 'mydock-month-cell');
            layout.attach(c, col, 1 + row, 1, 1);
            days.push(c);
        }
    };
    return w;
}
