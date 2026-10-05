// MyDock - pure month-grid math for calendar.js (no gi imports, so node can test it).

// The 7 weekday numbers (0 = Sunday) in column order for a week starting on weekStart.
export function weekdayOrder(weekStart = 0) {
    return [0, 1, 2, 3, 4, 5, 6].map(i => (i + weekStart) % 7);
}

// One {day, col, row} per day of the month (month is 1..12), row 0 being the first week.
export function monthGrid(year, month, weekStart = 0) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lead = (firstDow - weekStart + 7) % 7;
    const cells = [];
    for (let d = 1; d <= count; d++) {
        const n = lead + d - 1;
        cells.push({day: d, col: n % 7, row: Math.floor(n / 7)});
    }
    return cells;
}
