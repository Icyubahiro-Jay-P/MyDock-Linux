// Clock format presets for the Finder bar clock (prefs.js). Pure data, tested by clockpresets.test.mjs.

// [name, GLib strftime format]; the first one is the schema default
export const CLOCK_PRESETS = [
    ['Day, date and time', '%a %-d %b  %-I:%M %p'],
    ['Day, date and 24-hour time', '%a %-d %b  %H:%M'],
    ['Time only', '%-I:%M %p'],
    ['24-hour time only', '%H:%M'],
    ['Day, date and time with seconds', '%a %-d %b  %-I:%M:%S %p'],
];

// Index of `format` in CLOCK_PRESETS, or CLOCK_PRESETS.length ("Custom") for anything else.
export function presetIndex(format) {
    const i = CLOCK_PRESETS.findIndex(([, f]) => f === format);
    return i < 0 ? CLOCK_PRESETS.length : i;
}
