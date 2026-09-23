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
 * optional loupe magnifies the paths around the toolhead.
 *
 * Both modes: hard stops at the frame edges (lit on contact), a bump icon on
 * the `bump` event, a drag indicator, and a lost-step marker in open loop.
 *
 * Options:
 *   mode       'auto' (from snapshot.mechanics), 'axis' or 'corexy'
 *   trail      draw the CoreXY paths (default true)
 *   clearTrail true clears the paths once (e.g. on "Reprint"); also clearTrail()
 *   loupe      magnifier around the toolhead, CoreXY (default false)
 *   loupeMm    half-width of the magnified window in mm (default 2.5)
 *   loupeAt    corner of the frame for the loupe: 'br' (default), 'bl', 'tr', 'tl'
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
const BUMP_FADE_MS = 700;
const LOST_MIN_MM = 0.05;

export class GantryView extends CanvasView {
  /** Preferred height / width (a compromise between the long axis and the square CoreXY frame). */
  static aspect = 0.62;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    super(host, opts, {
      mode: 'auto', trail: true, loupe: false, loupeMm: 2.5, loupeAt: 'br', led: 'auto', targetMm: null, motor: 0,
      detail: 'auto', detailMm: 5,
    });
    this.trail = new PathTrail();
    this.mode = '';
    this.lenMm = 350;
    this.ax = { x0: 0, k: 1, M: 40, rp: 8, cw: 30, ch: 20, stopW: 8, yt: 0, yb: 0, ybt: 0, yr: 0, yRuler: 0,
      yTop: 0, idlerX: 0, motorX: 0, labelEvery: 50, tickEvery: 10 };
    this.xy = { fx: 0, fy: 0, S: 100, k: 1, M: 20, hs: 6, labelEvery: 100, loupeR: 60, lx: 0, ly: 0 };
    this.bumpAt = -Infinity;
    this.bumpSign = 1;
    this.str = { lost: '', press: '', pos: '', loupe: '', scale: '', zoom: '' };
    this.tip = { x: 0, y: 0, xCmd: 0, yCmd: 0 };
  }

  /** Clear the CoreXY paths (for a chapter's "Reprint"). */
  clearTrail() {
    this.trail.clear();
  }

  onOptions(o) {
    if (o.clearTrail) { this.trail.clear(); this.opts.clearTrail = false; }
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
          this.bumpAt = now + 1e9;
          this.bumpSign = ev[i].data && ev[i].data.torque < 0 ? -1 : 1;
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
    C.loupeR = clamp(S * 0.2, 44, 110);
    const at = String(this.opts.loupeAt || 'br');
    C.lx = at[1] === 'l' ? C.fx + C.loupeR + 6 : C.fx + S - C.loupeR - 6;
    C.ly = at[0] === 't' ? C.fy + C.loupeR + 6 : C.fy + S - C.loupeR - 6;
    this.layoutDirty = false;
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
    for (let v = C.labelEvery; v <= Lmm + 1e-6; v += C.labelEvery) g.fillText(String(v), fx0 - 3, Y(v));

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
    g.setLineDash([3, 3]);
    g.beginPath(); g.arc(sxc, syc, hs + 3, 0, TAU); g.stroke();
    g.setLineDash(SOLID);
    g.fillStyle = th.tipBg;
    roundRect(g, sx - hs, sy - hs, hs * 2, hs * 2, 3);
    g.fill();
    g.fillStyle = th.field;
    g.globalAlpha = 0.35;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = th.field;
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = th.field;
    g.beginPath(); g.arc(sx, sy, 1.8, 0, TAU); g.fill();

    const drag = snap.loads ? num(snap.loads.drag, 0) : 0;
    if (drag > 0.004) this.drawDrag(th, sx, sy + hs + 3, hs, drag);
    this.drawBump(th, now, sx + this.bumpSign * (hs + 12), sy, Math.max(8, hs * 1.3));

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

    if (this.opts.loupe && this.opts.trail !== false) this.drawLoupe(th, xc, yc, x, y, k);
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
    const mm = this.opts.loupeMm > 0 ? this.opts.loupeMm : 2.5;
    const bar = niceStep(mm * 0.5);
    s.scale = formatValue(bar) + ' mm';
    this.loupeBarMm = bar;
    s.loupe = '×' + Math.round((this.xy.loupeR / mm) / this.xy.k);
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

  /** @private magnifier around the commanded toolhead position */
  drawLoupe(th, xc, yc, x, y, k) {
    const g = this.g, C = this.xy;
    const R = C.loupeR, cx = C.lx, cy = C.ly;
    const mm = this.opts.loupeMm > 0 ? this.opts.loupeMm : 2.5;
    const kl = R / mm;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.clip();
    // grid every bar mm
    const bar = this.loupeBarMm || 1;
    g.strokeStyle = th.scopeGrid;
    g.lineWidth = 1;
    g.beginPath();
    const x0 = Math.ceil((xc - mm) / bar) * bar, y0 = Math.ceil((yc - mm) / bar) * bar;
    for (let v = x0; v <= xc + mm; v += bar) { const s = cx + (v - xc) * kl; g.moveTo(s, cy - R); g.lineTo(s, cy + R); }
    for (let v = y0; v <= yc + mm; v += bar) { const s = cy - (v - yc) * kl; g.moveTo(cx - R, s); g.lineTo(cx + R, s); }
    g.stroke();
    this.trail.drawLoupe(g, th, cx, cy, xc, yc, kl, R, this.tip);
    // commanded point (crosshair) and actual toolhead (dot)
    g.strokeStyle = th.target;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(cx - 6, cy); g.lineTo(cx + 6, cy);
    g.moveTo(cx, cy - 6); g.lineTo(cx, cy + 6);
    g.stroke();
    g.fillStyle = th.field;
    g.beginPath();
    g.arc(cx + (x - xc) * kl, cy - (y - yc) * kl, 3.5, 0, TAU);
    g.fill();
    g.restore();
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    // scale bar and zoom factor
    g.font = this.font.mono;
    g.fillStyle = th.muted;
    g.textBaseline = 'bottom';
    g.textAlign = 'center';
    const bw = bar * kl;
    g.strokeStyle = th.text;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - bw / 2, cy + R - 10); g.lineTo(cx + bw / 2, cy + R - 10); g.stroke();
    g.fillText(this.str.scale, cx, cy + R - 13);
    g.textBaseline = 'top';
    g.fillText(this.str.loupe, cx, cy - R + 6);
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
