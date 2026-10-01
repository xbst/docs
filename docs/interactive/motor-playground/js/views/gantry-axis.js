/**
 * Axis mode of the gantry view (gantry-view.js): a front view of one belt axis
 * with the carriage, rail, ruler, belt loop, idler, motor pulley and hard
 * stops, the stall-output LED and homing marks, and a magnified strip that
 * follows the carriage. The methods are mixed into GantryView.prototype, so
 * `this` is the GantryView (its layout object `ax`, strings `str`, options and
 * the shared helpers drawMotorFace, drawPulley, drawDrag and drawBump).
 * Screen positions come from module functions of the layout object (axisX,
 * detailX), not per-frame closures, and the motor face and pulley take the
 * layout's `ax.face`: a closure, or a double argument to a call V8 does not
 * inline, would allocate every frame.
 */
import { TAU, arrow, haloText, led, roundRect, clamp, num } from './view-util.js';
import { formatValue } from '../format.js';

const SOLID = [];
const DASH = [5, 4];
const LOST_MIN_MM = 0.05;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10];
const LABEL_STEPS = [0.5, 1, 2, 5, 10, 20, 50];
/** Left and right margin of the magnified strip (css px). */
const DETAIL_PAD = 10;
/** The strip's ruler labels by mm and decimals (they repeat as the strip pans), see detailLabel. */
const DETAIL_LABELS = new Map();

/** Screen x (css px) of axis position `mm` in the overview; `A` is the layout (`this.ax`). */
function axisX(A, mm) {
  return A.x0 + mm * A.k;
}

/** Screen x (css px) of `mm` in the magnified strip: window start `A.dA` (mm), `A.dK` px per mm. */
function detailX(A, mm) {
  return DETAIL_PAD + (mm - A.dA) * A.dK;
}

/**
 * The strip's ruler label for `v` mm (a multiple of a LABEL_STEPS step, so of 0.5 mm) with
 * `digits` decimals, built once per value.
 */
function detailLabel(v, digits) {
  const key = Math.round(v * 10) * 2 + digits;
  let s = DETAIL_LABELS.get(key);
  if (s === undefined) {
    if (DETAIL_LABELS.size >= 2000) DETAIL_LABELS.clear();
    s = formatValue(v === 0 ? 0 : v, digits);
    DETAIL_LABELS.set(key, s);
  }
  return s;
}

/** Axis-mode methods of GantryView (mixed in, never instantiated). */
export class AxisMode {
  /** @private */
  layoutAxis() {
    const A = this.ax, w = this.w, h = this.h, Lmm = this.lenMm;
    const pad = 8;
    A.M = clamp(Math.min(h * 0.28, w * 0.13), 26, 92);
    A.rp = A.M * 0.2;
    A.cw = clamp(w * 0.075, 24, 58);
    A.ch = clamp(A.M * 0.52, 16, 40);
    A.stopW = clamp(w * 0.014, 6, 12);
    A.idlerX = pad + A.rp + 1;
    const left = A.idlerX + A.rp + 4 + A.stopW + A.cw / 2;
    A.motorX = w - pad - A.M / 2;
    const right = A.motorX - A.M / 2 - 6 - A.cw / 2;
    A.x0 = left;
    A.k = Math.max(0.05, (right - left) / Lmm);
    const line = this.fpx(12) + 6;
    const block = line * 2 + A.ch + 2 * A.rp + 16 + line;
    // magnified strip under the axis when there is room (or when asked for)
    const o = this.opts.detail;
    A.detail = o === true || (o !== false && h - block >= 104);
    let top;
    if (A.detail) {
      A.dH = clamp(h - block - 14, 84, 170);
      const used = block + 10 + A.dH;
      top = Math.max(pad, (h - used) / 2);
      A.dTop = top + block + 10;
    } else {
      top = Math.max(pad, (h - block) / 2);
    }
    A.yTop = top;
    A.yt = top + line * 2 + A.ch;
    A.yb = A.yt + A.rp;
    A.ybt = A.yb + A.rp;
    A.yr = A.yt - A.ch * 0.55;
    // the motor face and its pulley (drawMotorFace, drawPulley: radius 0.2 M = A.rp)
    A.face.x = A.motorX;
    A.face.y = A.yb;
    A.face.M = A.M;
    A.yRuler = Math.min(h - line - 2, A.ybt + 12);
    const pxPer50 = 50 * A.k;
    A.labelEvery = pxPer50 >= 34 ? 50 : 100;
    A.tickEvery = 10 * A.k >= 5 ? 10 : 50;
    this.layoutDirty = false;
  }

  /** @private */
  drawAxis(snap, ctx, th, now) {
    if (this.layoutDirty) this.layoutAxis();
    const g = this.g, A = this.ax, Lmm = this.lenMm;
    const gt = snap.gantry;
    const mi = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[mi];
    const x = num(gt.x, 0), xc = num(gt.xCmd, x);
    const half = A.cw / 2;
    if (this.fresh) this.formatAxis(snap, mi, x);

    // ruler
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(axisX(A, 0), A.yRuler); g.lineTo(axisX(A, Lmm), A.yRuler);
    for (let v = 0; v <= Lmm + 1e-6; v += A.tickEvery) {
      const sx = Math.round(axisX(A, v)) + 0.5;
      const big = Math.abs(v / A.labelEvery - Math.round(v / A.labelEvery)) < 1e-6;
      g.moveTo(sx, A.yRuler); g.lineTo(sx, A.yRuler + (big ? 6 : 3));
    }
    g.stroke();
    g.font = this.font.mono;
    g.fillStyle = th.muted;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let v = 0; v <= Lmm + 1e-6; v += A.labelEvery) g.fillText(String(v), axisX(A, v), A.yRuler + 8);
    g.textAlign = 'right';
    if (A.x0 > 30) g.fillText('mm', axisX(A, 0) - half - A.stopW - 4, A.yRuler + 8);

    // trigger point of the last homing pass
    const hm = snap.homing;
    if (hm && hm.triggeredAtMm != null && hm.result) {
      const col = hm.result === 'ok' ? th.ok : th.err;
      const sx = axisX(A, hm.triggeredAtMm);
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(sx, A.yRuler - 1); g.lineTo(sx - 5, A.yRuler - 9); g.lineTo(sx + 5, A.yRuler - 9);
      g.closePath();
      g.fill();
    }

    // hard stops: the carriage face touches them when its center is at 0 or at the axis length
    const contactL = gt.atStopX && x < Lmm / 2, contactR = gt.atStopX && x >= Lmm / 2;
    const sTop = A.yr - A.ch * 0.75, sBot = A.ybt + 4;
    g.fillStyle = contactL ? th.warn : th.lineColor;
    g.fillRect(axisX(A, 0) - half - A.stopW, sTop, A.stopW, sBot - sTop);
    g.fillStyle = contactR ? th.warn : th.lineColor;
    g.fillRect(axisX(A, Lmm) + half, A.yr - A.ch * 0.4, Math.max(4, A.stopW * 0.6), A.ch * 0.8);

    // belt loop between the idler and the motor pulley; tick marks travel with the belt
    const xi = A.idlerX, xm = A.motorX;
    this.drawMotorFace(th, A.face);
    g.strokeStyle = th.descColor;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(xi, A.yt); g.lineTo(xm, A.yt);
    g.moveTo(xi, A.ybt); g.lineTo(xm, A.ybt);
    g.arc(xi, A.yb, A.rp, Math.PI / 2, Math.PI * 1.5);
    g.moveTo(xm, A.ybt);
    g.stroke();
    g.beginPath();
    g.arc(xi, A.yb, A.rp * 0.6, 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.stroke();
    const pitch = 10 * A.k >= 6 ? 10 : 20;
    const off = ((x % pitch) + pitch) % pitch;
    g.strokeStyle = th.descColor;
    g.lineWidth = 1;
    g.beginPath();
    for (let v = -pitch + off; axisX(A, v) < xm - A.rp * 0.3; v += pitch) {
      const sx = axisX(A, v);
      if (sx < xi + 2) continue;
      g.moveTo(sx, A.yt - 2.5); g.lineTo(sx, A.yt + 2.5);
    }
    const offB = ((-x % pitch) + pitch) % pitch;
    for (let v = -pitch + offB; axisX(A, v) < xm - A.rp * 0.3; v += pitch) {
      const sx = axisX(A, v);
      if (sx < xi + 2) continue;
      g.moveTo(sx, A.ybt - 2.5); g.lineTo(sx, A.ybt + 2.5);
    }
    g.stroke();
    this.drawPulley(th, A.face, m);

    // rail
    g.fillStyle = th.divider;
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    roundRect(g, axisX(A, 0) - half - 2, A.yr - 3, axisX(A, Lmm) - axisX(A, 0) + A.cw + 4, 6, 3);
    g.fill();
    g.stroke();

    // commanded position: dashed pointer from the rail to the ruler
    const sxc = axisX(A, xc);
    g.strokeStyle = th.target;
    g.lineWidth = 1.5;
    g.setLineDash(DASH);
    g.beginPath(); g.moveTo(sxc, A.yr); g.lineTo(sxc, A.yRuler); g.stroke();
    g.setLineDash(SOLID);

    // target marker from the chapter
    const tgt = this.opts.targetMm;
    if (typeof tgt === 'number' && Number.isFinite(tgt)) {
      const sx = axisX(A, clamp(tgt, 0, Lmm));
      g.strokeStyle = th.target;
      g.fillStyle = th.target;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(sx, A.yRuler - 1); g.lineTo(sx - 5, A.yRuler + 7); g.lineTo(sx + 5, A.yRuler + 7);
      g.closePath();
      g.stroke();
    }

    // carriage (actual position), clamped to the belt's top run
    const sx = axisX(A, x);
    const cy0 = A.yr - A.ch * 0.55, cy1 = A.yt + 3;
    g.fillStyle = th.tipBg;
    roundRect(g, sx - half, cy0, A.cw, cy1 - cy0, 4);
    g.fill();
    g.fillStyle = th.field;
    g.globalAlpha = th.dark ? 0.28 : 0.45;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = th.dark ? th.field : th.lineColor;       // amber alone is faint on the light card
    g.lineWidth = 1.5;
    g.stroke();
    g.strokeStyle = th.field;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(sx, cy1); g.lineTo(sx, A.yRuler); g.stroke();
    g.fillStyle = th.field;
    g.beginPath(); g.moveTo(sx, A.yRuler); g.lineTo(sx - 4, A.yRuler - 7); g.lineTo(sx + 4, A.yRuler - 7); g.closePath(); g.fill();

    // drag: hatch marks under the carriage
    const drag = snap.loads ? num(snap.loads.drag, 0) : 0;
    if (drag > 0.004) this.drawDrag(th, sx, A.yr + 5, half, drag);

    // labels above: stall-output LED, homing, position, press-in, lost steps, bump
    const yl = A.yTop + (this.fpx(12) + 6) * 0.5;
    const yl2 = yl + this.fpx(12) + 6;
    let ledEnd = 0;
    const showLed = this.opts.led === true
      || (this.opts.led === 'auto' && m && ((hm && (hm.active || hm.pass > 0)) || m.diag || m.status));
    if (showLed && m) {
      const foc = m.driver === 'foc';
      const lit = foc ? !!m.status : !!m.diag;
      const lx = Math.max(8, axisX(A, 0) - half - A.stopW / 2);
      led(g, th, lx, yl, 4.5, lit);
      g.font = this.font.uiBold;
      g.fillStyle = th.descColor;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      const label = foc ? 'STATUS' : 'DIAG';
      g.fillText(label, lx + 9, yl);
      ledEnd = lx + 9 + g.measureText(label).width;
    }
    g.font = this.font.mono;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillStyle = th.text;
    haloText(g, this.str.pos, clamp(sx, 40, this.w - 40), yl2, th.tipBg);
    if (hm && hm.active) {
      g.strokeStyle = th.text;
      g.fillStyle = th.text;
      g.lineWidth = 2;
      const ax = clamp(sx, ledEnd + 56, this.w - 90);
      arrow(g, ax - 8, yl, ax - 42, yl, 8);
      g.font = this.font.ui;
      g.textAlign = 'left';
      g.fillText(hm.pass > 1 ? `homing, pass ${hm.pass}` : 'homing', ax - 2, yl);
    }
    const lost = num(gt.lostMm && gt.lostMm[mi], 0);
    if (m && m.driver !== 'foc' && Math.abs(lost) >= LOST_MIN_MM) {
      g.font = this.font.uiBold;
      g.fillStyle = th.err;
      g.textAlign = 'center';
      haloText(g, this.str.lost, clamp((sx + sxc) / 2, 50, this.w - 50), A.yRuler + this.fpx(12) + 14, th.tipBg);
    }
    if (contactL && x < 0 && !A.detail) {
      g.font = this.font.mono;
      g.fillStyle = th.text;
      g.textAlign = 'left';
      haloText(g, this.str.press, axisX(A, 0) + half + 6, A.yb, th.tipBg);
    }
    if (this.bumpShown(now)) this.drawBump(th, now, sx + this.bumpSign * (half + 10), A.yr - A.ch * 0.2, A.ch * 0.45);
    if (A.detail) this.drawAxisDetail(th, gt);
  }

  /**
   * @private magnified strip that follows the carriage: its left face at x (the model's
   * contact point, so the stop face is 0 mm), the commanded face dashed, belt teeth at the
   * 2 mm GT2 pitch, and the press-in shaded where the face goes past the stop. Sets the strip's
   * window (`ax.dA`, `ax.dK`) for detailX.
   */
  drawAxisDetail(th, gt) {
    const g = this.g, A = this.ax, Lmm = this.lenMm;
    const x = num(gt.x, 0), xc = num(gt.xCmd, x);
    const d = this.opts.detailMm > 0 ? this.opts.detailMm : 5;
    const left = DETAIL_PAD, right = this.w - DETAIL_PAD, y0 = A.dTop, hh = A.dH;
    const kd = (right - left) / (2 * d);
    // Window start: the face 0.7 d from the left edge; within d of the stop the window holds
    // the stop face too (and a face pressed past it), and between d and 2 d it pans smoothly.
    const aFar = x - d * 0.7, aNear = -d * 0.15;
    let a;
    if (x <= d) a = Math.min(aFar, aNear);
    else if (x >= 2 * d) a = aFar;
    else {
      let t = (x - d) / d;
      t = t * t * (3 - 2 * t);
      a = aNear + (aFar - aNear) * t;
    }
    if (a > Lmm - d * 1.6) a = Lmm - d * 1.6;
    A.dA = a;
    A.dK = kd;
    const f = this.fpx(12);
    // where the strip is on the overview ruler
    g.strokeStyle = th.field;
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(axisX(A, Math.max(0, a)), A.yRuler - 1); g.lineTo(axisX(A, Math.min(Lmm, a + 2 * d)), A.yRuler - 1); g.stroke();
    // card
    g.fillStyle = th.scopeBg;
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1;
    g.beginPath();
    if (g.roundRect) g.roundRect(left - 4, y0, right - left + 8, hh, 8); else g.rect(left - 4, y0, right - left + 8, hh);
    g.fill();
    g.stroke();
    g.save();
    g.beginPath();
    g.rect(left - 3, y0 + 1, right - left + 6, hh - 2);
    g.clip();
    const yRul = y0 + hh - f - 12;
    const yTopC = y0 + f + 12, yBelt = yRul - 12;
    // ruler
    let step = TICK_STEPS[0];
    for (let i = 0; i < TICK_STEPS.length; i++) { step = TICK_STEPS[i]; if (step * kd >= 7) break; }
    let lab = LABEL_STEPS[0];
    for (let i = 0; i < LABEL_STEPS.length; i++) { lab = LABEL_STEPS[i]; if (lab >= step && lab * kd >= 44) break; }
    g.strokeStyle = th.lineColor;
    g.beginPath();
    g.moveTo(left - 3, yRul + 0.5); g.lineTo(right + 3, yRul + 0.5);
    const v0 = Math.ceil(a / step) * step;
    for (let v = v0; v <= a + 2 * d + 1e-9; v += step) {
      const sx = Math.round(detailX(A, v)) + 0.5;
      const big = Math.abs(v / lab - Math.round(v / lab)) < 1e-6;
      g.moveTo(sx, yRul); g.lineTo(sx, yRul + (big ? 6 : 3));
    }
    g.stroke();
    g.font = this.font.mono;
    g.fillStyle = th.muted;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const l0 = Math.ceil(a / lab) * lab;
    for (let v = l0; v <= a + 2 * d + 1e-9; v += lab) g.fillText(detailLabel(v, lab < 1 ? 1 : 0), detailX(A, v), yRul + 7);
    const contact = gt.atStopX;
    // belt with teeth at the GT2 pitch, moving with the carriage
    g.strokeStyle = th.descColor;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(left - 3, yBelt); g.lineTo(right + 3, yBelt); g.stroke();
    g.lineWidth = 1;
    g.beginPath();
    const t0 = x + Math.ceil((a - x) / 2) * 2;
    for (let v = t0; v <= a + 2 * d; v += 2) {
      const sx = detailX(A, v);
      g.moveTo(sx - 0.25 * kd, yBelt); g.lineTo(sx, yBelt + 4); g.lineTo(sx + 0.25 * kd, yBelt);
    }
    g.stroke();
    // commanded face (dashed)
    const sxc = detailX(A, xc);
    g.strokeStyle = th.target;
    g.lineWidth = 1.5;
    g.setLineDash(DASH);
    g.beginPath(); g.moveTo(sxc, yTopC - 6); g.lineTo(sxc, yRul); g.stroke();
    g.setLineDash(SOLID);
    // carriage: its face at x, the body to the right
    const sx = detailX(A, x);
    g.fillStyle = th.tipBg;
    g.fillRect(sx, yTopC, right + 3 - sx, yBelt - yTopC);
    g.fillStyle = th.field;
    g.globalAlpha = 0.28;
    g.fillRect(sx, yTopC, right + 3 - sx, yBelt - yTopC);
    g.globalAlpha = 1;
    g.strokeStyle = th.field;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(sx, yTopC); g.lineTo(sx, yBelt); g.stroke();
    // stops over the carriage (faces at 0 and at the axis length); a face pressed past one is
    // shaded where it overlaps
    g.fillStyle = th.lineColor;
    g.globalAlpha = 0.9;
    if (a < 0) g.fillRect(left - 3, yTopC - 4, detailX(A, 0) - left + 3, yBelt - yTopC + 8);
    if (a + 2 * d > Lmm) g.fillRect(detailX(A, Lmm), yTopC - 4, right + 3 - detailX(A, Lmm), yBelt - yTopC + 8);
    g.globalAlpha = 1;
    if (x < 0) {
      g.fillStyle = th.warn;
      g.globalAlpha = 0.55;
      g.fillRect(sx, yTopC, detailX(A, 0) - sx, yBelt - yTopC);
      g.globalAlpha = 1;
      g.strokeStyle = th.field;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(sx, yTopC); g.lineTo(sx, yBelt); g.stroke();
    }
    if (contact) {
      g.fillStyle = th.warn;
      const fx = x < Lmm / 2 ? detailX(A, 0) : detailX(A, Lmm);
      g.fillRect(fx - 1.5, yTopC - 4, 3, yBelt - yTopC + 8);
    }
    g.restore();
    // caption
    g.font = this.font.ui;
    g.fillStyle = th.descColor;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(this.str.zoom, left + 2, y0 + f / 2 + 5);
    if (x < 0 && contact) {
      g.textAlign = 'right';
      g.fillStyle = th.text;
      g.font = this.font.monoBold;
      g.fillText(this.str.press, right - 2, y0 + f / 2 + 5);
    }
  }

  /** @private 10 Hz axis strings */
  formatAxis(snap, mi, x) {
    const s = this.str, gt = snap.gantry, A = this.ax;
    s.pos = formatValue(x, 1) + ' mm';
    const lost = num(gt.lostMm && gt.lostMm[mi], 0);
    s.lost = 'lost ' + formatValue(Math.abs(lost), 2) + ' mm';
    s.press = 'pressing ' + formatValue(Math.max(0, -x), 2) + ' mm';
    const d = this.opts.detailMm > 0 ? this.opts.detailMm : 5;
    s.zoom = `×${Math.round(((this.w - 20) / (2 * d)) / A.k)} at the carriage`;
  }
}
