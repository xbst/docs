/**
 * Gantry view (SPEC 4.5; chapters 1, 2, 4, 6, 8 and 9).
 *
 * Mode 'axis' (one motor): front view of a belt axis. The carriage rides a
 * rail over a ruler from 0 to the axis length (350 mm); a belt loop runs from
 * an idler behind the hard stop at 0 mm to the motor pulley at the far end,
 * whose marker turns with the rotor. A dashed pointer marks the commanded
 * position. At the stop: an LED for the driver's stall output (DIAG in open
 * loop, STATUS with FOC), a home arrow while homing, the trigger point and
 * the press-in distance.
 *
 * Mode 'corexy' (two motors): top view of the frame with the X rail moving in
 * Y, the toolhead, motors A (rear right) and B (rear left) with angle markers
 * (and encoder discs under FOC), the two belts, the commanded path (dashed),
 * the actual path (solid amber) and the error between them (shaded). The
 * optional loupe magnifies the paths around the toolhead, and the optional
 * inspect lens the paths anywhere on the frame.
 *
 * Both modes: hard stops at the frame edges (lit on contact), a bump icon on
 * the `bump` event, a drag indicator, and a lost-step marker in open loop.
 *
 * Options:
 *   mode       'auto' (from snapshot.mechanics), 'axis' or 'corexy'
 *   trail      draw the CoreXY paths (default true)
 *   clearTrail true clears the paths once (e.g. on "Reprint"); also clearTrail()
 *   loupe      magnifier around the toolhead, CoreXY (default false)
 *   loupeMm    half-width of the magnified window in mm at the reference size (loupeSize;
 *              default 2.5); a larger loupe (loupeClear) shows more at the same magnification
 *   loupeAt    corner of the frame for the loupe: 'br' (default), 'bl', 'tr', 'tl'
 *   loupeClear with loupeAt 'tr': [x0, y0, x1, y1] mm, the area the moves use. The loupe is then
 *              the largest circle at the view's top right, up to 45% of its short side, that
 *              keeps clear of that area and of motor A, beside the frame where the view is wide
 *   loupeFit   center the loupe between the commanded point and the toolhead, and widen it
 *              while the error between them is large, so both stay in it (default false)
 *   loupeCenter null (follow the commanded point) or {x, y} in mm: hold the loupe on that
 *              point and draw the long (coarse) trail there, e.g. where a bump hit
 *   loupeLabel text shown before the zoom factor at the top of the loupe (default '')
 *   loupeSize  reference loupe radius as a fraction of the frame's side (default 0.2; 44–110 px)
 *   inspect    CoreXY: a lens (×7 to ×15, LENS_SPAN_PX) on the path point nearest the pointer or
 *              a tap (a tap on the lens puts it away); none over the empty frame. With keyboard
 *              focus on the view it starts at the toolhead, and Left and Right walk it along the
 *              path (Shift: farther; Home: back to the toolhead; Escape puts it away)
 *   led        'auto' (while homing or when the output is high), true, false
 *   targetMm   axis mode: a dashed target marker on the ruler (null = none)
 *   motor      axis mode: which motor's angle the pulley shows (default 0)
 *   detail     axis mode: magnified strip under the axis, 'auto' (when the view is tall
 *              enough), true or false
 *   detailMm   axis mode: half-width of the magnified strip in mm (default 5; homing
 *              reads well at 2 to 3)
 */
import { CanvasView, TAU, haloText, roundRect, clamp, num, mechanicsOf, niceStep } from './view-util.js';
import { PathTrail } from './gantry-trail.js';
import { AxisMode } from './gantry-axis.js';
import { formatValue } from '../format.js';

const SOLID = [];
const DASH_FINE = [3, 3];
const BUMP_FADE_MS = 700;
const LOST_MIN_MM = 0.05;
/** loupeFit: the commanded point and the toolhead stay within this share of the loupe's radius. */
const FIT_SHARE = 0.7;
/** loupeFit: time constants (s) of the loupe widening as the error grows and narrowing back. */
const FIT_GROW_S = 0.15, FIT_SHRINK_S = 1;
/** A touch that moves less than this (css px) and lifts within TAP_MS is a tap. */
const TAP_PX = 10, TAP_MS = 600;
/**
 * Inspect lens: the frame css px it shows on each side of its point. A screen pixel of the frame
 * is 0.7 to 2 mm, about what the loupe shows at its ×50, so the lens magnifies less: a pixel of
 * pointer movement shifts its view by a sixth of its radius (×7 to ×15).
 */
const LENS_SPAN_PX = 6;
/**
 * Inspect lens: how near (css px) the pointer or a tap must come to a path for the lens to take
 * it; it then snaps to the nearest path point, and it stays away from the empty frame.
 */
const SNAP_PX = 16, SNAP_TOUCH_PX = 28;
/** Inspect lens: steps (mm of path) of the Left and Right keys; with Shift, the larger one. */
const KEY_MM = 5, KEY_MM_FAR = 25;

export class GantryView extends CanvasView {
  /** Preferred height / width (a compromise between the long axis and the square CoreXY frame). */
  static aspect = 0.62;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    super(host, opts, {
      mode: 'auto', trail: true, loupe: false, loupeMm: 2.5, loupeAt: 'br', loupeClear: null, loupeFit: false,
      loupeCenter: null, loupeLabel: '', loupeSize: 0.2, inspect: false,
      led: 'auto', targetMm: null, motor: 0, detail: 'auto', detailMm: 5,
    });
    this.trail = new PathTrail();
    this.mode = '';
    this.lenMm = 350;
    this.ax = { x0: 0, k: 1, M: 40, rp: 8, cw: 30, ch: 20, stopW: 8, yt: 0, yb: 0, ybt: 0, yr: 0, yRuler: 0,
      yTop: 0, idlerX: 0, motorX: 0, labelEvery: 50, tickEvery: 10 };
    this.xy = { fx: 0, fy: 0, S: 100, k: 1, M: 20, hs: 6, labelEvery: 100, loupeR: 60, loupeRef: 60, lx: 0, ly: 0, lensR: 50 };
    this.bumpAt = -Infinity;
    this.bumpSign = 1;
    // Screen direction the last bump came from (CoreXY icon; a plain bump comes along x).
    this.bumpFromX = 1;
    this.bumpFromY = 0;
    this.str = { lost: '', press: '', pos: '', loupe: '', scale: '', zoom: '', lens: '', lensScale: '' };
    this.tip = { x: 0, y: 0, xCmd: 0, yCmd: 0 };
    this.loupeBarMm = 1;
    this.lensBarMm = 1;
    // the loupe's half-width (mm, loupeHalf) and when it was last eased (performance.now ms)
    this.half = 0;
    this.halfAt = 0;
    // inspect lens: shown, how ('mouse', 'touch' or 'keyboard'), the path point it magnifies (mm)
    // and that point's coarse trail id (−1: none), where the arrow keys walk on from
    this.lens = { on: false, mode: '', x: 0, y: 0, id: -1 };
    this.tap = null;
    this.listeners = null;
    this.listen(!!this.opts.inspect);
  }

  /** Clear the CoreXY paths (for a chapter's "Reprint"). */
  clearTrail() {
    this.trail.clear();
  }

  onOptions(o) {
    if (o.clearTrail) { this.trail.clear(); this.opts.clearTrail = false; }
    if ('loupeMm' in o || 'loupeFit' in o) this.half = 0;      // the new size at once, not eased
    if ('inspect' in o) this.listen(!!o.inspect);
  }

  destroy() {
    this.listen(false);
    super.destroy();
  }

  /**
   * @private The inspect lens's handlers: pointer hover and taps on the canvas, and the host as
   * a keyboard stop (focus shows the lens at the toolhead, Left and Right walk it). Off: none,
   * and the host leaves the tab order again (main.js reuses it for the next chapter's view).
   */
  listen(on) {
    if (this.listeners) { this.listeners.abort(); this.listeners = null; }
    this.lensOff();
    const host = this.host, cv = this.canvas;
    if (!on) {
      if (typeof host.removeAttribute === 'function') host.removeAttribute('tabindex');
      return;
    }
    const ac = this.listeners = new AbortController();
    const o = { signal: ac.signal };
    cv.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') this.lensAt(e.offsetX, e.offsetY, 'mouse'); }, o);
    cv.addEventListener('pointerleave', () => { if (this.lens.mode === 'mouse') this.lensOff(); }, o);
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.isPrimary !== false) this.tap = { id: e.pointerId, x: e.offsetX, y: e.offsetY, t: e.timeStamp };
    }, o);
    cv.addEventListener('pointerup', (e) => {
      const t = this.tap;
      this.tap = null;
      if (!t || t.id !== e.pointerId || Math.hypot(e.offsetX - t.x, e.offsetY - t.y) > TAP_PX || e.timeStamp - t.t > TAP_MS) return;
      // A tap on the lens puts it away; a tap anywhere else on the frame moves it there. (A
      // drag scrolls the page as usual: the browser cancels the pointer.)
      if (this.onLens(e.offsetX, e.offsetY)) this.lensOff();
      else this.lensAt(e.offsetX, e.offsetY, 'touch');
    }, o);
    cv.addEventListener('pointercancel', () => { this.tap = null; }, o);
    host.tabIndex = 0;
    host.addEventListener('focus', () => {
      // Keyboard focus only: a click focuses the host too, and the pointer already shows the lens.
      let keyboard = true;
      try { keyboard = host.matches(':focus-visible'); } catch (err) { /* no :focus-visible */ }
      if (keyboard && !this.lens.on && this.mode === 'corexy') this.lensHome();
    }, o);
    host.addEventListener('blur', () => { if (this.lens.mode === 'keyboard') this.lensOff(); }, o);
    host.addEventListener('keydown', (e) => this.lensKey(e), o);
  }

  /**
   * @private The inspect lens on the path point nearest to (px, py) css px (the commanded path of
   * the laps the coarse trail holds), within SNAP_PX (a tap: SNAP_TOUCH_PX). Off away from the
   * paths and over the loupe (a mouse only puts away a lens it showed).
   */
  lensAt(px, py, mode) {
    const C = this.xy, k = C.k, tr = this.trail;
    const onLoupe = this.opts.loupe && Math.hypot(px - C.lx, py - C.ly) <= C.loupeR;
    const i = this.mode === 'corexy' && !onLoupe
      ? tr.nearest((px - C.fx) / k, (C.fy + C.S - py) / k, (mode === 'touch' ? SNAP_TOUCH_PX : SNAP_PX) / k) : -1;
    if (i < 0) {
      if (mode !== 'mouse' || this.lens.mode === 'mouse') this.lensOff();
      return;
    }
    this.lensTo(tr.cmdAt(i, 0), tr.cmdAt(i, 1), mode, tr.coarseId(i));
  }

  /** @private the inspect lens on (x, y) mm (coarse trail id `id`, or −1), kept on the frame */
  lensTo(x, y, mode, id) {
    const L = this.lens;
    L.on = true;
    L.mode = mode;
    L.x = clamp(num(x, 0), 0, this.lenMm);
    L.y = clamp(num(y, 0), 0, this.lenMm);
    L.id = id;
    this.canvas.style.cursor = mode === 'mouse' ? 'crosshair' : '';
  }

  /** @private keyboard: the lens on the toolhead, the newest path point (or the commanded point before any) */
  lensHome() {
    const tr = this.trail;
    if (tr.cLen > 0) this.lensTo(tr.cmdAt(tr.cLen - 1, 0), tr.cmdAt(tr.cLen - 1, 1), 'keyboard', tr.coarseId(tr.cLen - 1));
    else this.lensTo(this.tip.xCmd, this.tip.yCmd, 'keyboard', -1);
  }

  /** @private */
  lensOff() {
    const L = this.lens;
    if (!L) return;
    L.on = false;
    L.mode = '';
    this.canvas.style.cursor = '';
  }

  /** @private is (px, py) css px on the inspect lens? */
  onLens(px, py) {
    const L = this.lens, C = this.xy;
    return L.on && Math.hypot(px - (C.fx + L.x * C.k), py - (C.fy + C.S - L.y * C.k)) <= C.lensR;
  }

  /**
   * @private Keyboard: Left and Right walk the lens back and forth along the path (KEY_MM of it;
   * Shift: KEY_MM_FAR), from its point or, put away, from the toolhead; Home brings it to the
   * toolhead and Escape puts it away. Other keys keep their usual job.
   */
  lensKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || this.mode !== 'corexy') return;
    const L = this.lens, tr = this.trail;
    if (e.key === 'Escape') {
      if (L.on) { this.lensOff(); e.preventDefault(); }
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      this.lensHome();
      return;
    }
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    let i = L.on && L.id >= 0 ? tr.coarseIndex(L.id) : -1;
    if (i < 0) i = L.on ? tr.nearest(L.x, L.y, Infinity) : tr.cLen - 1;
    if (i < 0) { this.lensHome(); return; }
    const j = tr.walk(i, dir, e.shiftKey ? KEY_MM_FAR : KEY_MM);
    this.lensTo(tr.cmdAt(j, 0), tr.cmdAt(j, 1), 'keyboard', tr.coarseId(j));
  }

  /** @private */
  modeOf(snap) {
    const o = this.opts.mode;
    if (o === 'axis' || o === 'corexy') return o;
    return mechanicsOf(snap) === 'corexy' ? 'corexy' : 'axis';
  }

  draw(snap, ctx, now) {
    const th = ctx.theme;
    const mode = this.modeOf(snap);
    const len = num(snap.axisLength, 350) > 1 ? num(snap.axisLength, 350) : 350;
    if (mode !== this.mode || len !== this.lenMm) { this.mode = mode; this.lenMm = len; this.layoutDirty = true; }
    // bump: the event marks the start; the icon stays while the pulse lasts, then fades
    const ev = snap.events;
    if (ev) {
      for (let i = 0; i < ev.length; i++) {
        if (ev[i].type === 'bump') {
          const d = ev[i].data;
          this.bumpAt = now + 1e9;
          this.bumpSign = d && d.torque < 0 ? -1 : 1;
          // The hit comes from the side opposite the shove (dirX, dirY: mm frame, y up).
          const dx = d ? num(d.dirX, -this.bumpSign) : -this.bumpSign, dy = d ? num(d.dirY, 0) : 0;
          const len = Math.hypot(dx, dy) || 1;
          this.bumpFromX = -dx / len;
          this.bumpFromY = dy / len;
        }
      }
    }
    const bumpNow = snap.loads ? num(snap.loads.bump, 0) : 0;
    if (bumpNow !== 0) this.bumpAt = now + 1e9;
    else if (this.bumpAt > now + 1e8) this.bumpAt = now;
    if (mode === 'corexy') this.drawXY(snap, ctx, th, now);
    else this.drawAxis(snap, ctx, th, now);
  }

  /** @private NEMA-style motor face */
  drawMotorFace(th, x, y, M, m) {
    const g = this.g;
    g.fillStyle = th.divider;
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    roundRect(g, x - M / 2, y - M / 2, M, M, M * 0.12);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(x, y, M * 0.36, 0, TAU);
    g.stroke();
    const hr = Math.max(1.5, M * 0.04), ho = M * 0.36;
    g.fillStyle = th.lineColor;
    g.beginPath();
    g.arc(x - ho, y - ho, hr, 0, TAU); g.moveTo(x + ho + hr, y - ho);
    g.arc(x + ho, y - ho, hr, 0, TAU); g.moveTo(x - ho + hr, y + ho);
    g.arc(x - ho, y + ho, hr, 0, TAU); g.moveTo(x + ho + hr, y + ho);
    g.arc(x + ho, y + ho, hr, 0, TAU);
    g.fill();
  }

  /** @private pulley with a marker at the rotor's mechanical angle */
  drawPulley(th, x, y, r, thetaM) {
    const g = this.g;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.strokeStyle = th.descColor;
    g.lineWidth = 1.5;
    g.stroke();
    g.strokeStyle = th.text;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + r * 0.85 * Math.cos(thetaM), y - r * 0.85 * Math.sin(thetaM));
    g.stroke();
    g.lineCap = 'butt';
    g.fillStyle = th.text;
    g.beginPath(); g.arc(x, y, 1.8, 0, TAU); g.fill();
  }

  /** @private friction hatch under a carriage or around a toolhead */
  drawDrag(th, x, y, half, drag) {
    const g = this.g;
    const n = drag > 0.2 ? 5 : drag > 0.08 ? 4 : 3;
    g.strokeStyle = th.muted;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const hx = x - half + 4 + i * ((2 * half - 8) / Math.max(1, n - 1));
      g.moveTo(hx - 3, y + 5); g.lineTo(hx + 3, y - 1);
    }
    g.stroke();
  }

  /** @private starburst next to the carriage while a bump acts, then fading */
  drawBump(th, now, x, y, r) {
    const age = now - this.bumpAt;
    if (age > BUMP_FADE_MS) return;
    const g = this.g;
    const a = age <= 0 ? 1 : 1 - age / BUMP_FADE_MS;
    g.globalAlpha = a;
    g.strokeStyle = th.warn;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const t = i * TAU / 8 + 0.2;
      g.moveTo(x + r * 0.35 * Math.cos(t), y + r * 0.35 * Math.sin(t));
      g.lineTo(x + r * Math.cos(t), y + r * Math.sin(t));
    }
    g.stroke();
    g.lineCap = 'butt';
    g.font = this.font.uiBold;
    g.fillStyle = th.text;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    haloText(g, 'bump', x, y - r - 2, th.tipBg);
    g.globalAlpha = 1;
  }

  /* ================================================================ CoreXY mode */

  /** @private */
  layoutXY() {
    const C = this.xy, w = this.w, h = this.h, Lmm = this.lenMm;
    const pad = 6;
    const lab = this.fpx(12) + 8;
    C.M = clamp(Math.min(w, h) * 0.09, 16, 42);
    const availW = w - 2 * pad - lab - C.M * 0.7;
    const availH = h - 2 * pad - lab - C.M * 0.75;
    const S = Math.max(40, Math.min(availW, availH));
    C.S = S;
    C.k = S / Lmm;
    C.hs = clamp(S * 0.028, 5, 12);
    C.fx = pad + lab + C.M * 0.35 + (availW - S) / 2;
    C.fy = pad + C.M * 0.75 + (availH - S) / 2;
    C.labelEvery = niceStep(Lmm / Math.max(2, Math.floor(S / 60)));
    C.loupeRef = clamp(S * (this.opts.loupeSize > 0 ? this.opts.loupeSize : 0.2), 44, 110);
    C.loupeR = C.loupeRef;
    const at = String(this.opts.loupeAt || 'br');
    C.lx = at[1] === 'l' ? C.fx + C.loupeR + 6 : C.fx + S - C.loupeR - 6;
    C.ly = at[0] === 't' ? C.fy + C.loupeR + 6 : C.fy + S - C.loupeR - 6;
    if (at === 'tr' && Array.isArray(this.opts.loupeClear)) this.placeLoupe(this.opts.loupeClear);
    C.lensR = clamp(S * 0.24, 44, 90);
    this.half = 0;                       // the loupe's half-width follows the new size at once
    this.layoutDirty = false;
  }

  /**
   * @private The largest loupe at the view's top right, from 45% of the view's short side (at
   * most 160 px) down to the reference size, that keeps clear of motor A's face and of the moves'
   * area `clear` ([x0, y0, x1, y1] mm, widened by the toolhead's half size) and ends above the
   * frame's bottom edge, so the axis labels stay readable. It sits against the view's right edge,
   * as high as motor A lets it. None fits: the plain top-right corner placement stays.
   */
  placeLoupe(clear) {
    const C = this.xy, k = C.k, hs = C.hs, pad = 6;
    const ox = C.fx, oy = C.fy + C.S;                     // screen of (0, 0) mm
    const keep = [ox + num(clear[0], 0) * k - hs, oy - num(clear[3], 0) * k - hs,
      ox + num(clear[2], 0) * k + hs, oy - num(clear[1], 0) * k + hs];
    const ax = ox + this.lenMm * k + hs, ay = oy - this.lenMm * k - hs, am = C.M / 2 + 4;   // motor A's face
    const motor = [ax - am, ay - am, ax + am, ay + am];
    const bottom = oy + hs;
    const hits = (x, y, R, r) => {
      const dx = x - clamp(x, r[0], r[2]), dy = y - clamp(y, r[1], r[3]);
      return dx * dx + dy * dy < R * R;
    };
    for (let R = Math.floor(Math.min(160, 0.45 * Math.min(this.w, this.h))); R > C.loupeRef; R -= 2) {
      const x = this.w - pad - R;
      let y = pad + R;
      while (y + R <= bottom && hits(x, y, R, motor)) y += 2;
      if (y + R > bottom || hits(x, y, R, keep)) continue;
      C.loupeR = R;
      C.lx = x;
      C.ly = y;
      return;
    }
  }

  /** @private */
  drawXY(snap, ctx, th, now) {
    if (this.layoutDirty) this.layoutXY();
    const g = this.g, C = this.xy, Lmm = this.lenMm;
    const gt = snap.gantry;
    const k = C.k, ox = C.fx, oy = C.fy + C.S;          // screen of (0, 0) mm
    const X = (mm) => ox + mm * k, Y = (mm) => oy - mm * k;
    const x = num(gt.x, 0), y = num(gt.y, 0), xc = num(gt.xCmd, x), yc = num(gt.yCmd, y);
    const tip = this.tip;
    tip.x = x; tip.y = y; tip.xCmd = xc; tip.yCmd = yc;
    const hs = C.hs;
    if (this.opts.trail !== false) this.trail.update(snap, ctx.traces);
    if (this.fresh) this.formatXY(snap, x, y);

    // frame: the travel box expanded by the toolhead's half size
    const fx0 = X(0) - hs, fx1 = X(Lmm) + hs, fy0 = Y(Lmm) - hs, fy1 = Y(0) + hs;
    g.fillStyle = th.scopeBg;
    g.fillRect(fx0, fy0, fx1 - fx0, fy1 - fy0);
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1.5;
    g.strokeRect(fx0, fy0, fx1 - fx0, fy1 - fy0);
    // grid every labelEvery mm, labels on the bottom and left edges
    g.strokeStyle = th.scopeGrid;
    g.lineWidth = 1;
    g.beginPath();
    for (let v = C.labelEvery; v < Lmm - 1e-6; v += C.labelEvery) {
      const sx = Math.round(X(v)) + 0.5, sy = Math.round(Y(v)) + 0.5;
      g.moveTo(sx, fy0 + 1); g.lineTo(sx, fy1 - 1);
      g.moveTo(fx0 + 1, sy); g.lineTo(fx1 - 1, sy);
    }
    g.stroke();
    g.font = this.font.mono;
    g.fillStyle = th.muted;
    g.textBaseline = 'top';
    g.textAlign = 'center';
    for (let v = 0; v <= Lmm + 1e-6; v += C.labelEvery) g.fillText(String(v), X(v), fy1 + 3);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    // None under rear motor B, whose face covers the frame's top-left corner (the top label at 50
    // and 25 mm steps); the bottom axis still reads to the end.
    const yMin = fy0 + C.M / 2 + this.fpx(12) * 0.5 + 2;
    for (let v = C.labelEvery; v <= Lmm + 1e-6; v += C.labelEvery) {
      const ly = Y(v);
      if (ly >= yMin) g.fillText(String(v), fx0 - 3, ly);
    }

    // lit stop edges
    g.strokeStyle = th.warn;
    g.lineWidth = 3;
    g.beginPath();
    if (gt.atStopX) { const ex = x < Lmm / 2 ? fx0 : fx1; g.moveTo(ex, fy0); g.lineTo(ex, fy1); }
    if (gt.atStopY) { const ey = y < Lmm / 2 ? fy1 : fy0; g.moveTo(fx0, ey); g.lineTo(fx1, ey); }
    g.stroke();

    // X rail (moves in y) and belts from the rear motors (A at the rear right, B at the rear
    // left), under the paths so a move along x does not hide them
    const sy = Y(y), sx = X(x);
    g.fillStyle = th.divider;
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.globalAlpha = 0.7;
    roundRect(g, fx0 + 1, sy - 4, fx1 - fx0 - 2, 8, 3);
    g.fill();
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = th.descColor;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(fx1 - 5, fy0); g.lineTo(fx1 - 5, sy - 2); g.lineTo(sx + hs, sy - 2);
    g.moveTo(fx0 + 5, fy0); g.lineTo(fx0 + 5, sy + 2); g.lineTo(sx - hs, sy + 2);
    g.stroke();

    // paths
    if (this.opts.trail !== false) {
      g.save();
      g.beginPath();
      g.rect(fx0, fy0, fx1 - fx0, fy1 - fy0);
      g.clip();
      this.trail.draw(g, th, ox, oy, k, tip);
      g.restore();
    }

    // commanded position (dashed ring) and the toolhead
    const sxc = X(xc), syc = Y(yc);
    g.strokeStyle = th.target;
    g.lineWidth = 1.5;
    g.setLineDash(DASH_FINE);
    g.beginPath(); g.arc(sxc, syc, hs + 3, 0, TAU); g.stroke();
    g.setLineDash(SOLID);
    g.fillStyle = th.tipBg;
    roundRect(g, sx - hs, sy - hs, hs * 2, hs * 2, 3);
    g.fill();
    g.fillStyle = th.field;
    g.globalAlpha = th.dark ? 0.35 : 0.5;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = th.dark ? th.field : th.lineColor;       // amber alone is faint on the light card
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = th.field;
    g.beginPath(); g.arc(sx, sy, 1.8, 0, TAU); g.fill();

    const drag = snap.loads ? num(snap.loads.drag, 0) : 0;
    if (drag > 0.004) this.drawDrag(th, sx, sy + hs + 3, hs, drag);
    const bo = hs + 12;
    this.drawBump(th, now, sx + this.bumpFromX * bo, sy + this.bumpFromY * bo, Math.max(8, hs * 1.3));

    // motors A (rear right) and B (rear left)
    if (snap.motors[0]) this.drawXYMotor(th, fx1, fy0, C.M, snap.motors[0], 'A', 1);
    if (snap.motors[1]) this.drawXYMotor(th, fx0, fy0, C.M, snap.motors[1], 'B', -1);

    // lost steps (open loop): the toolhead shift from both belts
    if (this.shift >= LOST_MIN_MM && snap.motors[0] && snap.motors[0].driver !== 'foc') {
      g.font = this.font.uiBold;
      g.fillStyle = th.err;
      g.textBaseline = 'bottom';
      g.textAlign = sx > (fx0 + fx1) / 2 ? 'right' : 'left';
      haloText(g, this.str.lost, sx + (sx > (fx0 + fx1) / 2 ? -hs - 4 : hs + 4), sy - hs - 4, th.tipBg);
    }

    if (this.opts.loupe && this.opts.trail !== false) {
      const lc = this.opts.loupeCenter;
      const held = !!lc && Number.isFinite(lc.x) && Number.isFinite(lc.y);
      const fit = !held && !!this.opts.loupeFit;
      const mm = this.loupeHalf(fit ? Math.hypot(xc - x, yc - y) : 0, now);
      const mx = held ? lc.x : fit ? (xc + x) / 2 : xc, my = held ? lc.y : fit ? (yc + y) / 2 : yc;
      this.drawLoupe(th, C.lx, C.ly, C.loupeR, mx, my, C.loupeR / mm, held ? 'held' : 'fine', x, y, xc, yc,
        this.loupeBarMm, this.str.scale, this.str.loupe);
    }
    const L = this.lens;
    if (L.on && this.opts.inspect) {
      // the lens sits on the spot it magnifies
      this.drawLoupe(th, X(L.x), Y(L.y), C.lensR, L.x, L.y, C.lensR * k / LENS_SPAN_PX, 'lens', x, y, xc, yc,
        this.lensBarMm, this.str.lensScale, this.str.lens);
    }
  }

  /** @private loupeMm, or its default */
  baseMm() {
    return this.opts.loupeMm > 0 ? this.opts.loupeMm : 2.5;
  }

  /**
   * @private The loupe's half-width (mm): loupeMm scaled from the reference size to the loupe's
   * own, so a larger loupe shows more at the same magnification. With loupeFit it widens while
   * `err` (the commanded point to the toolhead, mm) needs it, so both stay within FIT_SHARE of the
   * radius around their midpoint: quickly as the error grows, slowly back as it shrinks.
   */
  loupeHalf(err, now) {
    const C = this.xy;
    const base = this.baseMm() * C.loupeR / C.loupeRef;
    const want = Math.max(base, err / 2 / FIT_SHARE);
    const dt = Math.min(0.25, Math.max(0, (now - this.halfAt) / 1000));
    this.halfAt = now;
    if (!(this.half > 0) || !this.opts.loupeFit) this.half = want;
    else this.half += (want - this.half) * (1 - Math.exp(-dt / (want > this.half ? FIT_GROW_S : FIT_SHRINK_S)));
    return this.half;
  }

  /** @private 10 Hz CoreXY strings */
  formatXY(snap, x, y) {
    const s = this.str, gt = snap.gantry;
    const la = num(gt.lostMm && gt.lostMm[0], 0), lb = num(gt.lostMm && gt.lostMm[1], 0);
    // belt A = x + y, belt B = x − y
    const dx = (la + lb) / 2, dy = (la - lb) / 2;
    this.shift = Math.hypot(dx, dy);
    s.lost = 'shifted ' + formatValue(this.shift, 1) + ' mm';
    s.pos = `${formatValue(x, 1)}, ${formatValue(y, 1)} mm`;
    const C = this.xy;
    const mm = this.half > 0 ? this.half : this.baseMm() * C.loupeR / C.loupeRef;
    const bar = niceStep(mm * 0.5);
    s.scale = formatValue(bar) + ' mm';
    this.loupeBarMm = bar;
    const zoom = '×' + Math.round((C.loupeR / mm) / C.k);
    s.loupe = this.opts.loupeLabel ? this.opts.loupeLabel + ' ' + zoom : zoom;
    // the inspect lens: LENS_SPAN_PX of the frame on each side
    this.lensBarMm = niceStep((LENS_SPAN_PX / C.k) * 0.5);
    s.lensScale = formatValue(this.lensBarMm) + ' mm';
    s.lens = '×' + Math.round(C.lensR / LENS_SPAN_PX);
  }

  /** @private rear motor with a pulley marker; encoder disc under FOC */
  drawXYMotor(th, x, y, M, m, name, side) {
    const g = this.g;
    this.drawMotorFace(th, x, y, M, m);
    const foc = m.driver === 'foc';
    const a = num(m.thetaM, 0);
    if (foc) {
      const r = M * 0.36;
      g.strokeStyle = th.muted;
      g.lineWidth = 1;
      g.beginPath();
      for (let k = 0; k < 24; k++) {
        const t = a + k * TAU / 24, c = Math.cos(t), s = Math.sin(t);
        g.moveTo(x + r * c, y - r * s);
        g.lineTo(x + (r - Math.max(2.5, M * 0.08)) * c, y - (r - Math.max(2.5, M * 0.08)) * s);
      }
      g.stroke();
    }
    this.drawPulley(th, x, y, M * 0.2, a);
    // name inside the frame, beside the motor
    g.font = this.font.uiBold;
    g.fillStyle = th.text;
    g.textBaseline = 'top';
    g.textAlign = side > 0 ? 'right' : 'left';
    g.fillText(name, x - side * (M / 2 + 4), y + 4);
  }

  /**
   * @private A magnifier of radius R css px at (cx, cy), showing (mx, my) mm at kl px per mm:
   * the loupe (`kind` 'fine': the last seconds of the paths around the toolhead; 'held': the
   * coarse trail of the last laps around a held point, loupeCenter) or the inspect lens ('lens':
   * both trails, anywhere on the frame). (xc, yc) is the commanded point and (x, y) the actual
   * toolhead; `bar` the grid and scale-bar step in mm, labeled `scale`; `label` its top line.
   */
  drawLoupe(th, cx, cy, R, mx, my, kl, kind, x, y, xc, yc, bar, scale, label) {
    const g = this.g;
    const mm = R / kl;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.clip();
    // grid every bar mm
    if (!(bar > 0)) bar = 1;
    g.strokeStyle = th.scopeGrid;
    g.lineWidth = 1;
    g.beginPath();
    const x0 = Math.ceil((mx - mm) / bar) * bar, y0 = Math.ceil((my - mm) / bar) * bar;
    for (let v = x0; v <= mx + mm; v += bar) { const s = cx + (v - mx) * kl; g.moveTo(s, cy - R); g.lineTo(s, cy + R); }
    for (let v = y0; v <= my + mm; v += bar) { const s = cy - (v - my) * kl; g.moveTo(cx - R, s); g.lineTo(cx + R, s); }
    g.stroke();
    if (kind === 'lens') this.trail.drawLens(g, th, cx, cy, mx, my, kl, R, this.tip);
    else this.trail.drawLoupe(g, th, cx, cy, mx, my, kl, R, this.tip, kind === 'held');
    // commanded point (crosshair) and actual toolhead (dot), where they fall in the window
    const px = cx + (xc - mx) * kl, py = cy - (yc - my) * kl;
    g.strokeStyle = th.target;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(px - 6, py); g.lineTo(px + 6, py);
    g.moveTo(px, py - 6); g.lineTo(px, py + 6);
    g.stroke();
    g.fillStyle = th.field;
    g.beginPath();
    g.arc(cx + (x - mx) * kl, cy - (y - my) * kl, 3.5, 0, TAU);
    g.fill();
    g.restore();
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    // scale bar and zoom factor; the bar (at most R wide: bar ≤ the half-width) sits high enough
    // that the circle is wider there than the bar
    g.font = this.font.mono;
    g.fillStyle = th.muted;
    g.textBaseline = 'bottom';
    g.textAlign = 'center';
    const bw = bar * kl, by = cy + R - Math.max(10, R * 0.18);
    g.strokeStyle = th.text;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - bw / 2, by); g.lineTo(cx + bw / 2, by); g.stroke();
    // haloed: the paths run under the labels in a large loupe or a lens on a corner
    haloText(g, scale, cx, by - 3, th.tipBg);
    g.textBaseline = 'top';
    haloText(g, label, cx, cy - R + 6, th.tipBg);
  }

  /** @returns {string} */
  describe(snap) {
    const gt = snap.gantry;
    if (!gt) return '';
    const mode = this.modeOf(snap);
    const err = Math.hypot(num(gt.xCmd, 0) - num(gt.x, 0), num(gt.yCmd, 0) - num(gt.y, 0));
    if (mode === 'corexy') {
      let s = `CoreXY gantry: toolhead at ${formatValue(num(gt.x, 0), 1)}, ${formatValue(num(gt.y, 0), 1)} mm, `
        + `commanded ${formatValue(num(gt.xCmd, 0), 1)}, ${formatValue(num(gt.yCmd, 0), 1)} mm, error ${formatValue(err, 2)} mm`;
      if (this.shift >= LOST_MIN_MM) s += `, shifted ${formatValue(this.shift, 1)} mm by lost steps`;
      return s + '.';
    }
    const m = snap.motors[0];
    let s = `Belt axis: carriage at ${formatValue(num(gt.x, 0), 1)} mm, commanded ${formatValue(num(gt.xCmd, 0), 1)} mm`;
    if (gt.atStopX) s += ', touching the hard stop';
    if (snap.homing && snap.homing.active) s += ', homing';
    if (m && m.driver === 'foc' && m.status) s += ', status output high';
    if (m && m.driver !== 'foc' && m.diag) s += ', DIAG high';
    return s + '.';
  }
}

// Axis mode (layoutAxis, drawAxis, drawAxisDetail, formatAxis) lives in gantry-axis.js.
for (const key of Object.getOwnPropertyNames(AxisMode.prototype)) {
  if (key !== 'constructor') GantryView.prototype[key] = AxisMode.prototype[key];
}
