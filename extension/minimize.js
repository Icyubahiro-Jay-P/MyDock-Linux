// MyDock - macOS style minimize/unminimize animations (scale, genie, suck).
//
// GNOME binds WindowManager._minimizeWindow/_unminimizeWindow to the 'minimize'/'unminimize'
// signals with .bind() at startup, so overriding those methods has no effect. Instead we block
// GNOME's two handlers and connect our own; anything we do not animate is handed to the
// original methods. Unblocking them in destroy() restores GNOME exactly.
// Completion goes through GNOME's own bookkeeping (Main.wm._minimizing + _minimizeWindowDone),
// so completed_minimize/unminimize runs exactly once and 'kill-window-effects' keeps working.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {genieVertex, suckVertex, targetSide} from './deform-math.js';

const EFFECT_NAME = 'mydock-minimize';
const TILES = 20;       // mesh resolution for big windows
const TILE_PX = 48;     // smaller windows get ~one tile per 48px (min 8): same curve, fewer vertex calls
const VERTEX = {genie: genieVertex, suck: suckVertex};
const STAGE_MS = 380;       // Stage Manager fly-out (fixed: it is not the user's minimize effect)
const STAGE_MAX_AGE = 2e6;  // us a recorded thumbnail rect stays valid for

const DeformEffect = GObject.registerClass(
class MyDockDeformEffect extends Clutter.DeformEffect {
    _init(vertexFn, width, height, target) {
        super._init();
        this._fn = vertexFn;
        this._w = width;
        this._h = height;
        this._t = target;
        this._side = targetSide(width, height, target);
        this._progress = 0;
        this._out = {x: 0, y: 0}; // reused by every vertex, no per-vertex allocation
        const tiles = n => Math.max(8, Math.min(TILES, Math.ceil(n / TILE_PX)));
        this.set_n_tiles(tiles(width), tiles(height));
    }

    setProgress(p) {
        this._progress = p;
        this.invalidate();
    }

    vfunc_deform_vertex(width, height, vertex) {
        const r = this._fn(this._progress, vertex.tx, vertex.ty, this._w, this._h, this._t, this._side, this._out);
        vertex.x = r.x * width / this._w;
        vertex.y = r.y * height / this._h;
    }

    // the mesh leaves the actor bounds, so report an unknown volume (full repaint)
    vfunc_modify_paint_volume(_volume) {
        return false;
    }
});

export class MinimizeEffects {
    constructor(ext) {
        this._ext = ext;
        this._active = new Map(); // actor -> finish()
        const shellwm = global.window_manager;

        // GNOME's handlers were connected first (WindowManager constructor), so find() hits them
        this._blocked = [];
        for (const signalId of ['minimize', 'unminimize']) {
            const id = GObject.signal_handler_find(shellwm, {signalId});
            if (id) {
                GObject.signal_handler_block(shellwm, id);
                this._blocked.push(id);
            }
        }
        this._sigs = [
            shellwm.connect('minimize', (wm, actor) => this._onEvent(wm, actor, true)),
            shellwm.connect('unminimize', (wm, actor) => this._onEvent(wm, actor, false)),
            shellwm.connect('kill-window-effects', (wm, actor) => this._active.get(actor)?.()),
        ];
    }

    destroy() {
        const shellwm = global.window_manager;
        for (const id of this._sigs)
            shellwm.disconnect(id);
        for (const finish of [...this._active.values()])
            finish();
        for (const id of this._blocked)
            GObject.signal_handler_unblock(shellwm, id);
        this._sigs = this._blocked = this._active = null;
        this._ext = null;
    }

    _onEvent(shellwm, actor, minimizing) {
        // a new request on the same window ends the running one first
        this._active.get(actor)?.();

        let effect = this._ext.settings.get_string('minimize-effect');
        // window opened from a Stage Manager thumbnail: its own fly-out, not the dock effect
        const stage = minimizing ? null : this._stageRect(actor.meta_window);
        if (stage)
            effect = 'stage';
        if (effect === 'none' || !St.Settings.get().enable_animations ||
            Main.wm._getAnimationWindowType(actor) !== Meta.WindowType.NORMAL) {
            if (minimizing)
                Main.wm._minimizeWindow(shellwm, actor);
            else
                Main.wm._unminimizeWindow(shellwm, actor);
            return;
        }

        if (!minimizing)
            actor.show();
        // same checks GNOME does (overview open, no texture, skipped actor)
        if (!Main.wm._shouldAnimateActor(actor, [Meta.WindowType.NORMAL])) {
            if (minimizing)
                shellwm.completed_minimize(actor);
            else
                shellwm.completed_unminimize(actor);
            return;
        }

        try {
            this._animate(shellwm, actor, minimizing, effect, stage);
        } catch (e) {
            logError(e, 'MyDock: minimize effect failed');
            this._active.get(actor)?.();
        }
    }

    _animate(shellwm, actor, minimizing, effect, stageRect = null) {
        // register first so any later failure still ends in exactly one completed_*
        (minimizing ? Main.wm._minimizing : Main.wm._unminimizing).add(actor);
        let timeline = null;
        let destroyId = 0;
        const finish = () => {
            if (!this._active.delete(actor))
                return;
            if (timeline) {
                timeline.stop();
                timeline = null;
            }
            if (destroyId)
                actor.disconnect(destroyId);
            actor.remove_effect_by_name(EFFECT_NAME);
            actor.set_translation(0, 0, 0);
            actor.rotation_angle_y = 0;
            // resets transitions, scale, opacity, pivot and calls completed_* once
            if (minimizing)
                Main.wm._minimizeWindowDone(shellwm, actor);
            else
                Main.wm._unminimizeWindowDone(shellwm, actor);
        };
        this._active.set(actor, finish);
        destroyId = actor.connect('destroy', finish);

        // window actor origin = buffer rect origin (stage coords); also undoes any position
        // left behind by an earlier GNOME animation before unminimizing
        const buf = actor.meta_window.get_buffer_rect();
        if (!minimizing)
            actor.set_position(buf.x, buf.y);
        const [w, h] = actor.get_size();
        const r = stageRect ?? this._targetRect(actor);
        const target = {x: r.x - buf.x, y: r.y - buf.y, width: r.width, height: r.height};
        const duration = this._ext.settings.get_int('minimize-duration');

        actor.set_pivot_point(0, 0);
        if (effect === 'stage') {
            // start as the tilted thumbnail and spring out to the window with a slight overshoot
            actor.set({
                scale_x: w ? target.width / w : 0,
                scale_y: h ? target.height / h : 0,
                translation_x: target.x,
                translation_y: target.y,
                rotation_angle_y: 14,
                opacity: 160,
            });
            actor.ease({
                scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, rotation_angle_y: 0, opacity: 255,
                duration: STAGE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
                onStopped: finish,
            });
            return;
        }
        if (effect === 'scale') {
            const shrunk = {
                scale_x: w ? target.width / w : 0,
                scale_y: h ? target.height / h : 0,
                translation_x: target.x,
                translation_y: target.y,
                opacity: 0,
            };
            const normal = {scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, opacity: 255};
            const [from, to] = minimizing ? [normal, shrunk] : [shrunk, normal];
            actor.set({...from});
            actor.ease({
                ...to,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onStopped: finish,
            });
            return;
        }

        const deform = new DeformEffect(VERTEX[effect] ?? genieVertex, w, h, target);
        actor.add_effect_with_name(EFFECT_NAME, deform);
        // Timeline ignores the slow-down factor that ease() applies, so apply it here
        timeline = new Clutter.Timeline({actor, duration: Math.round(duration * St.Settings.get().slow_down_factor)});
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_SINE);
        const step = () => {
            const t = timeline.get_progress();
            const p = minimizing ? t : 1 - t;
            deform.setProgress(p);
            // fade only at the very end so the window does not pop out of the icon
            actor.opacity = Math.round(255 * (1 - clamp01((p - 0.85) / 0.15)));
        };
        step();
        timeline.connect('new-frame', step);
        timeline.connect('completed', finish);
        timeline.start();
    }

    // Thumbnail rect Stage Manager recorded for this window (consumed), else null.
    _stageRect(win) {
        const map = this._ext.stageOpening;
        const r = map?.get(win);
        if (!r)
            return null;
        map.delete(win);
        if (GLib.get_monotonic_time() - r.time > STAGE_MAX_AGE)
            return null;
        return r;
    }

    // Stage-space rect the window flies into: dock icon, else Meta icon geometry,
    // else bottom-center of the window's monitor.
    _targetRect(actor) {
        const win = actor.meta_window;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const dockRect = app ? this._ext.dock?.getIconRect(app) : null;
        if (dockRect)
            return dockRect;
        const [ok, geom] = win.get_icon_geometry();
        if (ok)
            return {x: geom.x, y: geom.y, width: geom.width, height: geom.height};
        const m = Main.layoutManager.monitors[win.get_monitor()] ?? Main.layoutManager.primaryMonitor;
        return {x: m.x + m.width / 2, y: m.y + m.height, width: 0, height: 0};
    }
}

function clamp01(t) {
    return Math.min(1, Math.max(0, t));
}
