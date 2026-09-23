/**
 * Torque-speed chart (SPEC 4.5; chapter 5).
 *
 * The torque a current-regulated drive can make at each speed, from the
 * analytic `torqueSpeedPoints` (sim/presets.js, the same voltage limit the
 * simulation reaches): one curve per bus voltage, the selected voltage
 * (`snapshot.supplyV`, or the voltage a running sweep is on) thick and amber,
 * the others thin. Its knee (where the current starts to fall short) is
 * marked. A dot rides the selected curve at the rotor's current speed; a ring
 * shows the torque the measured current amplitude gives (Kt · |i|), so the
 * simulation can be read against the curve. Sweep results are diamonds on
 * their curves. When the motor preset is not the reference (typical)
 * stepper, the reference family is drawn dashed for comparison.
 *
 * Options:
 *   voltages          curve voltages (default [12, 24, 36, 48, 60])
 *   maxMmS            speed axis end (default 1500)
 *   preset            'auto' (snapshot.motorPreset) or a presets.js key
 *   referencePreset   dashed comparison family when different (default 'stepper'; null = none)
 *   runCurrent        null (motor 0's iLimit, the run current) or amps
 */
import { CanvasView, TAU, haloText, clamp, num, niceStep, presetOf, mmPerRad } from './view-util.js';
import { MOTOR_PRESETS, torqueSpeedPoints, torqueSpeedCurve } from '../sim/presets.js';
import { formatValue } from '../format.js';

const N = 121;
const SOLID = [];
const DASH = [5, 4];
const DOT = [2, 3];

export class ChartView extends CanvasView {
  /** Preferred height / width. */
  static aspect = 0.62;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    super(host, opts, {
      voltages: [12, 24, 36, 48, 60], maxMmS: 1500, preset: 'auto', referencePreset: 'stepper', runCurrent: null,
    });
    this.curves = [];
    this.refCurves = [];
    this.curveKey = '';
    this.speeds = new Float64Array(N);
    this.tMax = 1;
    this.iEma = NaN;
    this.lay = { key: '', x0: 0, x1: 0, y0: 0, y1: 0, xStep: 250, yStep: 0.2 };
    this.str = { legend: '', ref: '', dot: '', knee: '', cur: '' };
    this.preset = null;
    this.refPreset = null;
    this.I = 0;
  }

  /** @private (re)compute the curves when the preset, current, voltages or range changed */
  curvesFor(snap) {
    const o = this.opts;
    const pr = o.preset && o.preset !== 'auto' && MOTOR_PRESETS[o.preset] ? MOTOR_PRESETS[o.preset] : presetOf(snap, 0);
    const refKey = o.referencePreset && MOTOR_PRESETS[o.referencePreset] ? o.referencePreset : null;
    const ref = refKey && MOTOR_PRESETS[refKey] !== pr && MOTOR_PRESETS[refKey].phases === pr.phases ? MOTOR_PRESETS[refKey] : null;
    const m = snap.motors[0];
    const I = num(o.runCurrent, 0) > 0 ? o.runCurrent : (num(m && m.iLimit, 0) > 0 ? m.iLimit : pr.Irated);
    const vs = Array.isArray(o.voltages) && o.voltages.length ? o.voltages.slice() : [24, 48];
    const sel = num(snap.supplyV, 24);
    if (!vs.includes(sel)) vs.push(sel);
    vs.sort((a, b) => a - b);
    const maxMmS = num(o.maxMmS, 1500) > 10 ? o.maxMmS : 1500;
    const rd = num(snap.rd, 40);
    const key = `${pr.key}|${ref ? ref.key : ''}|${I.toFixed(3)}|${vs.join(',')}|${maxMmS}|${rd}`;
    if (key === this.curveKey) return;
    this.curveKey = key;
    this.preset = pr;
    this.refPreset = ref;
    this.I = I;
    this.maxMmS = maxMmS;
    const make = (p) => vs.map((V) => {
      const ts = new Float64Array(N);
      torqueSpeedPoints(p, V, I, maxMmS, rd, N, this.speeds, ts);
      const c = torqueSpeedCurve(p, V, I);
      const kneeMmS = c.omegaKneeM * rd / TAU;
      // label position: where the curve falls to half its standstill torque, else the right end
      let li = N - 1;
      for (let i = 1; i < N; i++) if (ts[i] < 0.5 * ts[0]) { li = i; break; }
      return { V, ts, kneeMmS, li };
    });
    this.curves = make(pr);
    this.refCurves = ref ? make(ref) : [];
    this.tMax = (pr.Kt || 0.2) * I;
    this.layoutDirty = true;
    this.fmtAt = -Infinity;
  }

  /** @private plot rectangle and ticks */
  layout() {
    const L = this.lay, w = this.w, h = this.h;
    const f = this.fpx(12);
    L.y0 = 8 + (f + 8) + 8;                   // legend line and the y-axis title above
    L.y1 = h - (f * 2 + 16);                  // tick labels and the axis title below
    L.x0 = Math.round(f * 3.3) + 10;
    L.x1 = w - Math.max(14, f * 1.7);         // room for half of the last tick label
    L.xStep = niceStep(this.maxMmS / Math.max(2, Math.floor((L.x1 - L.x0) / 70)));
    const top = this.tMax * 1.15;
    L.yStep = niceStep(top / Math.max(2, Math.floor((L.y1 - L.y0) / 40)));
    L.yTop = Math.ceil(top / L.yStep) * L.yStep;
    this.layoutDirty = false;
  }

  draw(snap, ctx) {
    this.curvesFor(snap);
    if (this.layoutDirty) this.layout();
    const g = this.g, th = ctx.theme, L = this.lay;
    const x0 = L.x0, x1 = L.x1, y0 = L.y0, y1 = L.y1;
    if (x1 - x0 < 40 || y1 - y0 < 30) return;
    const kx = (x1 - x0) / this.maxMmS, ky = (y1 - y0) / L.yTop;
    const X = (v) => x0 + v * kx, Y = (t) => y1 - t * ky;
    const sw = snap.sweep;
    const selV = sw && sw.running && sw.currentV ? sw.currentV : num(snap.supplyV, 24);
    const m = snap.motors[0];
    const speed = Math.abs(num(m && m.omegaM, 0)) * mmPerRad(snap);
    if (this.advanced || this.iEma !== this.iEma) {
      const ia = num(m && m.iAmp, Math.hypot(num(m && m.iAlpha, 0), num(m && m.iBeta, 0)));
      this.iEma = this.iEma === this.iEma ? this.iEma + (ia - this.iEma) * 0.15 : ia;
    }
    if (this.fresh) this.formatStrings(snap, selV, speed);

    // grid and axes
    g.strokeStyle = th.scopeGrid;
    g.lineWidth = 1;
    g.beginPath();
    for (let v = L.xStep; v < this.maxMmS + 1e-6; v += L.xStep) { const x = Math.round(X(v)) + 0.5; g.moveTo(x, y0); g.lineTo(x, y1); }
    for (let t = L.yStep; t < L.yTop + 1e-9; t += L.yStep) { const y = Math.round(Y(t)) + 0.5; g.moveTo(x0, y); g.lineTo(x1, y); }
    g.stroke();
    g.strokeStyle = th.lineColor;
    g.beginPath();
    g.moveTo(x0 + 0.5, y0); g.lineTo(x0 + 0.5, y1 + 0.5); g.lineTo(x1, y1 + 0.5);
    g.stroke();
    g.font = this.font.mono;
    g.fillStyle = th.muted;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let v = 0; v <= this.maxMmS + 1e-6; v += L.xStep) g.fillText(String(Math.round(v)), X(v), y1 + 4);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let t = 0; t <= L.yTop + 1e-9; t += L.yStep) g.fillText(formatValue(t, L.yStep < 0.1 ? 2 : 1), x0 - 5, Y(t));
    g.font = this.font.ui;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('speed (mm/s)', (x0 + x1) / 2, this.h - 3);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('torque (N·m)', 6, 8 + this.fpx(12) / 2);

    // reference family (dashed), then the other voltages, then the selected one
    g.save();
    g.beginPath();
    g.rect(x0, y0 - 2, x1 - x0 + 1, y1 - y0 + 3);
    g.clip();
    g.lineJoin = 'round';
    if (this.refCurves.length) {
      g.strokeStyle = th.muted;
      g.lineWidth = 1;
      g.setLineDash(DASH);
      for (const c of this.refCurves) this.curve(c.ts, X, Y);
      g.setLineDash(SOLID);
    }
    let selCurve = null;
    g.strokeStyle = th.target;
    g.lineWidth = 1.4;
    for (const c of this.curves) {
      if (c.V === selV) { selCurve = c; continue; }
      this.curve(c.ts, X, Y);
    }
    if (selCurve) {
      // area under the selected curve, then the curve
      g.fillStyle = th.field;
      g.globalAlpha = 0.1;
      g.beginPath();
      g.moveTo(X(0), Y(0));
      for (let i = 0; i < N; i++) g.lineTo(X(this.speeds[i]), Y(selCurve.ts[i]));
      g.lineTo(X(this.speeds[N - 1]), Y(0));
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = th.field;
      g.lineWidth = 3;
      this.curve(selCurve.ts, X, Y);
      // knee
      if (selCurve.kneeMmS > 0 && selCurve.kneeMmS < this.maxMmS) {
        const kxp = X(selCurve.kneeMmS);
        g.strokeStyle = th.descColor;
        g.lineWidth = 1;
        g.setLineDash(DOT);
        g.beginPath(); g.moveTo(kxp, Y(selCurve.ts[0])); g.lineTo(kxp, y1); g.stroke();
        g.setLineDash(SOLID);
      }
    }
    g.restore();

    // curve labels
    g.font = this.font.monoBold;
    g.textBaseline = 'bottom';
    g.textAlign = 'left';
    for (const c of this.curves) {
      const i = c.li;
      const x = Math.min(X(this.speeds[i]) + 4, x1 - 30), y = Y(c.ts[i]) - 3;
      g.fillStyle = c.V === selV ? th.text : th.muted;
      haloText(g, formatValue(c.V, 0) + ' V', x, Math.max(y, y0 + this.fpx(12)), th.tipBg);
    }
    if (selCurve && selCurve.kneeMmS > 0 && selCurve.kneeMmS < this.maxMmS) {
      g.font = this.font.ui;
      g.fillStyle = th.descColor;
      g.textAlign = selCurve.kneeMmS > this.maxMmS * 0.6 ? 'right' : 'left';
      g.textBaseline = 'bottom';
      const kxp = X(selCurve.kneeMmS);
      haloText(g, this.str.knee, kxp + (g.textAlign === 'left' ? 4 : -4), y1 - 4, th.tipBg);
    }

    // sweep results
    const res = sw && sw.results;
    if (res) {
      for (const k of Object.keys(res)) {
        const V = Number(k), v = num(res[k], NaN);
        if (!(v >= 0)) continue;
        const c = this.curves.find((cc) => cc.V === V);
        if (!c) continue;
        const px = X(Math.min(v, this.maxMmS)), py = Y(this.valueAt(c.ts, v));
        g.fillStyle = th.tipBg;
        g.strokeStyle = th.text;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(px, py - 6); g.lineTo(px + 6, py); g.lineTo(px, py + 6); g.lineTo(px - 6, py);
        g.closePath();
        g.fill();
        g.stroke();
        g.font = this.font.mono;
        g.fillStyle = th.text;
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        haloText(g, formatValue(v, 0), px, py - 8, th.tipBg);
      }
    }

    // live dot on the selected curve and the measured ring
    if (selCurve) {
      const sp = Math.min(speed, this.maxMmS);
      const px = X(sp), py = Y(this.valueAt(selCurve.ts, sp));
      const tMeas = (this.preset.Kt || 0) * (this.iEma === this.iEma ? this.iEma : 0);
      g.strokeStyle = th.text;
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, Y(tMeas), 6.5, 0, TAU); g.stroke();
      g.fillStyle = th.field;
      g.strokeStyle = th.tipBg;
      g.lineWidth = 2;
      g.beginPath(); g.arc(px, py, 5, 0, TAU); g.fill(); g.stroke();
      g.font = this.font.mono;
      g.fillStyle = th.text;
      g.textAlign = px > (x0 + x1) / 2 ? 'right' : 'left';
      g.textBaseline = 'bottom';
      haloText(g, this.str.dot, px + (g.textAlign === 'left' ? 9 : -9), Math.min(py, Y(tMeas)) - 6, th.tipBg);
    }

    // legend
    g.font = this.font.ui;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    const ly = 8 + this.fpx(12) / 2;
    let lx = x1;
    g.fillStyle = th.descColor;
    g.fillText(this.str.cur, lx, ly);
    lx -= g.measureText(this.str.cur).width + 14;
    if (this.refCurves.length && lx > x0 + 120) {
      g.fillText(this.str.ref, lx, ly);
      const rw = g.measureText(this.str.ref).width;
      g.strokeStyle = th.muted;
      g.lineWidth = 1;
      g.setLineDash(DASH);
      g.beginPath(); g.moveTo(lx - rw - 22, ly); g.lineTo(lx - rw - 5, ly); g.stroke();
      g.setLineDash(SOLID);
      lx -= rw + 36;
    }
    if (lx > x0 + 60) {
      g.fillStyle = th.text;
      g.fillText(this.str.legend, lx, ly, lx - x0 - 40);
    }
  }

  /** @private one curve's polyline */
  curve(ts, X, Y) {
    const g = this.g, sp = this.speeds;
    g.beginPath();
    g.moveTo(X(sp[0]), Y(ts[0]));
    for (let i = 1; i < N; i++) g.lineTo(X(sp[i]), Y(ts[i]));
    g.stroke();
  }

  /** @private curve value at a speed (linear between the sample points) */
  valueAt(ts, v) {
    const f = clamp(v / this.maxMmS, 0, 1) * (N - 1);
    const i = Math.min(N - 2, Math.floor(f));
    const t = f - i;
    return ts[i] + (ts[i + 1] - ts[i]) * t;
  }

  /** @private 10 Hz strings */
  formatStrings(snap, selV, speed) {
    const s = this.str, pr = this.preset;
    if (!pr) return;
    s.legend = `${pr.name}, L ${formatValue(pr.L * 1000, 1)} mH`;
    s.ref = this.refPreset ? `${this.refPreset.name}, L ${formatValue(this.refPreset.L * 1000, 1)} mH` : '';
    s.cur = `run current ${formatValue(this.I, 2)} A`;
    s.dot = `${formatValue(speed, 0)} mm/s`;
    const c = this.curves.find((cc) => cc.V === selV);
    s.knee = c && c.kneeMmS > 0 ? `falls from ${formatValue(c.kneeMmS, 0)} mm/s` : '';
  }

  /** @returns {string} */
  describe(snap) {
    const selV = num(snap.supplyV, 24);
    const c = this.curves.find((cc) => cc.V === selV);
    if (!c || !this.preset) return '';
    const m = snap.motors[0];
    const speed = Math.abs(num(m && m.omegaM, 0)) * mmPerRad(snap);
    return `Torque available vs speed at ${formatValue(selV, 0)} V: ${formatValue(c.ts[0], 2)} N·m up to about `
      + `${formatValue(c.kneeMmS, 0)} mm/s, then falling. The motor runs at ${formatValue(speed, 0)} mm/s.`;
  }
}
