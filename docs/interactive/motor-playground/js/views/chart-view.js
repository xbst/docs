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
 * Labels (B-003). Each voltage label tries points along its own curve (where
 * it falls to 50%, 62%, 38%, … of its standstill torque, above right or below
 * left of the point, or at the curve's right end) and takes the one with the
 * fewest clashes: the plot's edges, the legend, the knee's line and note, the
 * labels placed before it (the selected voltage first) and, weighted less,
 * other curves running through it or as near to it as its own. That runs
 * when the curves, the layout or the selected voltage change. The knee note
 * stays inside the plot (right of
 * the line, else left). Each frame the sweep values and the live dot's speed
 * pick a free side the same way; the dot keeps its side while that stays free.
 * (The labels sat where each curve fell to half its torque: close knees, as on
 * the 8 mH motor or a narrow chart, put them on top of each other.)
 *
 * Options:
 *   voltages          curve voltages (default [12, 24, 36, 48, 60])
 *   maxMmS            speed axis end (default 1500)
 *   preset            'auto' (snapshot.motorPreset) or a presets.js key
 *   referencePreset   dashed comparison family when different (default 'stepper'; null = none)
 *   runCurrent        null (motor 0's iLimit, the run current) or amps
 *   Added by chunk 05 (chapter 5):
 *   results           null (snapshot.sweep.results) or { [volts]: mm/s }: the sweep diamonds, so a
 *                     chapter can keep results across sweeps and world rebuilds
 *   rms               false (the run current in A peak); true labels it in A RMS (peak / √2),
 *                     as Klipper's run_current for TMC drivers
 */
import { CanvasView, TAU, haloText, clamp, num, niceStep, stepDecimals, presetOf, mmPerRad } from './view-util.js';
import { MOTOR_PRESETS, torqueSpeedPoints, torqueSpeedCurve } from '../sim/presets.js';
import { formatValue } from '../format.js';

const N = 121;
const SOLID = [];
const DASH = [5, 4];
const DOT = [2, 3];
/** Torque levels (share of the standstill torque) a curve label tries, in order. */
const FRACS = [0.5, 0.62, 0.38, 0.75, 0.28, 0.85, 0.2];
/** Label boxes (x0, y0, x1, y1) the placement keeps, at most. */
const MAX_BOXES = 48;

/** Overlap area of the boxes (ax0, ay0, ax1, ay1) and (bx0, by0, bx1, by1). */
function overlapArea(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  const w = (ax1 < bx1 ? ax1 : bx1) - (ax0 > bx0 ? ax0 : bx0);
  const h = (ay1 < by1 ? ay1 : by1) - (ay0 > by0 ? ay0 : by0);
  return w > 0 && h > 0 ? w * h : 0;
}

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
      results: null, rms: false,
    });
    this.curves = [];
    this.refCurves = [];
    this.inputs = null;
    this.speeds = new Float64Array(N);
    this.tMax = 1;
    this.iEma = NaN;
    this.lay = { key: '', x0: 0, x1: 0, y0: 0, y1: 0, xStep: 250, yStep: 0.2, yDec: 1 };
    this.str = { legend: '', ref: '', dot: '', knee: '', cur: '' };
    this.preset = null;
    this.refPreset = null;
    this.I = 0;
    // label placement: boxes (x0, y0, x1, y1), the static ones first (legend, knee, curve
    // labels), then each frame's sweep and dot labels; the selected voltage they were placed for
    this.boxes = new Float64Array(4 * MAX_BOXES);
    this.nBoxes = 0;
    this.nStatic = 0;
    this.placedSel = NaN;
    this.kneeLX = 0;              // knee note's left edge
    this.charW = 7;               // mono font character width (px)
    this.dotPick = -1;            // the dot label's last side (candidate index)
    this.bx0 = 0; this.by0 = 0;   // the last picked floating label's left and bottom
    // the sweep diamonds (x, y, label left, label bottom, value; placed with the static labels)
    // and this frame's dot label
    this.dia = new Float64Array(5 * 16);
    this.nDia = 0;
    this.dotLX = 0; this.dotLY = 0;
    this.placedRes = 0;           // signature of the sweep results the labels were placed with
  }

  /** @private (re)compute the curves when the preset, current, voltages or range changed */
  curvesFor(snap) {
    const o = this.opts;
    const pr = o.preset && o.preset !== 'auto' && MOTOR_PRESETS[o.preset] ? MOTOR_PRESETS[o.preset] : presetOf(snap, 0);
    const refKey = o.referencePreset && MOTOR_PRESETS[o.referencePreset] ? o.referencePreset : null;
    const ref = refKey && MOTOR_PRESETS[refKey] !== pr && MOTOR_PRESETS[refKey].phases === pr.phases ? MOTOR_PRESETS[refKey] : null;
    const m = snap.motors[0];
    const I = num(o.runCurrent, 0) > 0 ? o.runCurrent : (num(m && m.iLimit, 0) > 0 ? m.iLimit : pr.Irated);
    const sel = num(snap.supplyV, 24);
    const maxMmS = num(o.maxMmS, 1500) > 10 ? o.maxMmS : 1500;
    const rd = num(snap.rd, 40);
    // unchanged inputs: nothing to do (checked without allocating, once per frame)
    const c = this.inputs;
    if (c && c.pr === pr && c.ref === ref && Math.abs(c.I - I) < 5e-4 && c.sel === sel && c.volts === o.voltages
      && c.maxMmS === maxMmS && c.rd === rd) return;
    this.inputs = { pr, ref, I, sel, volts: o.voltages, maxMmS, rd };
    const vs = Array.isArray(o.voltages) && o.voltages.length ? o.voltages.slice() : [24, 48];
    if (!vs.includes(sel)) vs.push(sel);
    vs.sort((a, b) => a - b);
    this.preset = pr;
    this.refPreset = ref;
    this.I = I;
    this.maxMmS = maxMmS;
    const make = (p) => vs.map((V) => {
      const ts = new Float64Array(N);
      torqueSpeedPoints(p, V, I, maxMmS, rd, N, this.speeds, ts);
      const c = torqueSpeedCurve(p, V, I);
      const kneeMmS = c.omegaKneeM * rd / TAU;
      // label: text and its left and bottom edge (placeLabels)
      return { V, ts, kneeMmS, label: formatValue(V, 0) + ' V', lx: 0, ly: 0, lw: 0 };
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
    const top = this.tMax * 1.3;                 // headroom for the legend rows above the curves
    L.yStep = niceStep(top / Math.max(2, Math.floor((L.y1 - L.y0) / 40)));
    L.yTop = Math.ceil(top / L.yStep) * L.yStep;
    L.yDec = Math.max(1, stepDecimals(L.yStep));  // 0.25 steps read 0.25, 0.75, not 0.3, 0.8
    this.layoutDirty = false;
    this.placedSel = NaN;
  }

  /**
   * @private Place the knee note and the voltage labels for the selected voltage `selV` (see
   * "Labels" in the header). Runs when the curves, the layout or the selected voltage change.
   */
  placeLabels(selV, res, resSig) {
    const g = this.g, L = this.lay, sp = this.speeds;
    const x0 = L.x0, x1 = L.x1, y1 = L.y1;
    const kx = (x1 - x0) / this.maxMmS, ky = (y1 - L.y0) / L.yTop;
    const fh = this.fpx(12);
    this.placedSel = selV;
    this.placedRes = resSig;
    this.nBoxes = 0;
    g.font = this.font.mono;
    this.charW = g.measureText('0000000000').width / 10;
    // the legend rows in the top right (drawn at the end of draw)
    g.font = this.font.ui;
    const lh = fh + 5, pr = this.preset;
    let ry = L.y0 + lh / 2 + 2;
    if (pr) {
      const lw = g.measureText(`this motor, L ${formatValue(pr.L * 1000, 1)} mH`).width;
      this.addBox(x1 - lw - 30, ry - lh / 2, x1, ry + lh / 2);
      if (this.refPreset) {
        ry += lh;
        const rw = g.measureText(`typical motor, L ${formatValue(this.refPreset.L * 1000, 1)} mH`).width;
        this.addBox(x1 - rw - 30, ry - lh / 2, x1, ry + lh / 2);
      }
    }
    // the knee's dotted line and its note, inside the plot: right of the line, else left of it
    let sel = null;
    for (const c of this.curves) if (c.V === selV) sel = c;
    if (sel && sel.kneeMmS > 0 && sel.kneeMmS < this.maxMmS) {
      const kxp = x0 + sel.kneeMmS * kx;
      this.addBox(kxp - 3, y1 - sel.ts[0] * ky, kxp + 3, y1);
      const kw = g.measureText(`falls from ${formatValue(sel.kneeMmS, 0)} mm/s`).width;
      let lx = kxp + 4;
      if (lx + kw > x1 - 2) lx = kxp - 4 - kw >= x0 + 2 ? kxp - 4 - kw : Math.max(x0 + 2, x1 - 2 - kw);
      this.kneeLX = lx;
      this.addBox(lx - 2, y1 - 4 - fh, lx + kw + 2, y1 - 2);
    }
    // the sweep results: diamonds on their curves, each value on a free side
    g.font = this.font.mono;
    const dia = this.dia;
    this.nDia = 0;
    if (res) {
      for (const k of Object.keys(res)) {
        const V = Number(k), v = num(res[k], NaN);
        if (!(v >= 0) || this.nDia >= 16) continue;
        const c = this.curves.find((cc) => cc.V === V);
        if (!c) continue;
        const px = x0 + Math.min(v, this.maxMmS) * kx, py = y1 - this.valueAt(c.ts, v) * ky;
        this.addBox(px - 7, py - 7, px + 7, py + 7);
        this.pickFloating(px, py - 8, py + 8, g.measureText(formatValue(v, 0)).width + 2, fh, true, false, -1);
        const j = 5 * this.nDia++;
        dia[j] = px; dia[j + 1] = py; dia[j + 2] = this.bx0; dia[j + 3] = this.by0; dia[j + 4] = v;
      }
    }
    // the voltage labels, the selected one first
    g.font = this.font.monoBold;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.curves) {
        if ((c.V === selV) !== (pass === 0)) continue;
        const w = g.measureText(c.label).width + 2, t0 = c.ts[0];
        let best = Infinity, bx = 0, by = 0, rank = 0, end = false;
        for (let k = 0; k < FRACS.length; k++) {
          const f = FRACS[k] * t0;
          let i = 1;
          while (i < N && c.ts[i] >= f) i++;
          if (i >= N) { end = true; continue; }
          const a = c.ts[i - 1], b = c.ts[i];
          const xa = x0 + (sp[i - 1] + (sp[i] - sp[i - 1]) * (a - f) / ((a - b) || 1)) * kx, ya = y1 - f * ky;
          // above right of the point (between this curve and the next one up), then below left
          let s = this.labelScore(xa + 4, ya - 3 - fh, xa + 4 + w, ya - 3, rank++, c);
          if (s < best) { best = s; bx = xa + 4; by = ya - 3; }
          s = this.labelScore(xa - 4 - w, ya + 3, xa - 4, ya + 3 + fh, rank++ + 2, c);
          if (s < best) { best = s; bx = xa - 4 - w; by = ya + 3 + fh; }
        }
        if (end) {
          // the curve stays above some levels to the plot's end: at its end, above or below it,
          // up to two rows out (curves that end together, flat, on the 0.8 mH motor)
          const ya = y1 - c.ts[N - 1] * ky;
          for (let r = 0; r < 3; r++) {
            const off = r * (fh + 2);
            let s = this.labelScore(x1 - 2 - w, ya - 3 - fh - off, x1 - 2, ya - 3 - off, rank++ + 4 * r, c);
            if (s < best) { best = s; bx = x1 - 2 - w; by = ya - 3 - off; }
            s = this.labelScore(x1 - 2 - w, ya + 3 + off, x1 - 2, ya + 3 + fh + off, rank++ + 2 + 4 * r, c);
            if (s < best) { best = s; bx = x1 - 2 - w; by = ya + 3 + fh + off; }
          }
        }
        // last resorts: centered above or below the curve at points across the plot where it has
        // left the flat top all the curves share
        for (let j = 0; j < 8; j++) {
          const xc = x0 + (0.25 + 0.1 * j) * (x1 - x0), tc = this.valueAt(c.ts, (xc - x0) / kx);
          if (tc > 0.95 * t0) continue;
          const ya = y1 - tc * ky;
          let s = this.labelScore(xc - w / 2, ya - 3 - fh, xc + w / 2, ya - 3, 20 + j, c);
          if (s < best) { best = s; bx = xc - w / 2; by = ya - 3; }
          s = this.labelScore(xc - w / 2, ya + 3, xc + w / 2, ya + 3 + fh, 22 + j, c);
          if (s < best) { best = s; bx = xc - w / 2; by = ya + 3 + fh; }
        }
        c.lx = bx + 1;
        c.ly = by;
        c.lw = w;
        this.addBox(bx, by - fh, bx + w, by);
      }
    }
    this.nStatic = this.nBoxes;
  }

  /** @private true when a box overlaps this frame's dot label */
  covered(x0, y0, x1, y1) {
    const b = this.boxes;
    for (let k = 4 * this.nStatic; k < 4 * this.nBoxes; k += 4) {
      if (overlapArea(x0, y0, x1, y1, b[k], b[k + 1], b[k + 2], b[k + 3]) > 0.5) return true;
    }
    return false;
  }

  /** @private keep a label box (x0, y0, x1, y1) */
  addBox(x0, y0, x1, y1) {
    if (this.nBoxes >= MAX_BOXES) return;
    const b = this.boxes, k = 4 * this.nBoxes++;
    b[k] = x0; b[k + 1] = y0; b[k + 2] = x1; b[k + 3] = y1;
  }

  /**
   * @private How badly a label box (x0, y0, x1, y1) sits: outside the plot, over the boxes kept so
   * far, then for a curve label (`own`, its curve; `rank` its candidate order) over other curves,
   * as near to another curve as to its own, and far from its own; lower is better.
   */
  labelScore(x0, y0, x1, y1, rank, own) {
    const L = this.lay;
    const out = (x1 - x0) * (y1 - y0) - overlapArea(x0, y0, x1, y1, L.x0 + 1, L.y0 - 2, L.x1, L.y1 - 1);
    let hit = 0;
    const b = this.boxes;
    for (let k = 0; k < 4 * this.nBoxes; k += 4) hit += overlapArea(x0, y0, x1, y1, b[k], b[k + 1], b[k + 2], b[k + 3]);
    let s = 1e6 * out + 1000 * hit;
    if (own) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dOwn = this.curveDist(own.ts, cx, cy);
      for (const c of this.curves) {
        s += 40 * this.crosses(c.ts, x0, y0, x1, y1);
        if (c !== own && this.curveDist(c.ts, cx, cy) < dOwn + 1) s += 50;   // as near counts too
      }
      for (const c of this.refCurves) s += 15 * this.crosses(c.ts, x0, y0, x1, y1);
      s += rank + dOwn;
    }
    return s;
  }

  /** @private screen distance from (px, py) to a curve's polyline */
  curveDist(ts, px, py) {
    const L = this.lay, sp = this.speeds, kx = (L.x1 - L.x0) / this.maxMmS, ky = (L.y1 - L.y0) / L.yTop;
    let best = Infinity, ax = L.x0 + sp[0] * kx, ay = L.y1 - ts[0] * ky;
    for (let i = 1; i < N; i++) {
      const bx = L.x0 + sp[i] * kx, by = L.y1 - ts[i] * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      u = u < 0 ? 0 : (u > 1 ? 1 : u);
      const ex = ax + u * dx - px, ey = ay + u * dy - py, d = ex * ex + ey * ey;
      if (d < best) best = d;
      ax = bx; ay = by;
    }
    return Math.sqrt(best);
  }

  /** @private 1 when the curve runs through the box (sampled at its left, middle and right edge) */
  crosses(ts, x0, y0, x1, y1) {
    const L = this.lay, kx = (L.x1 - L.x0) / this.maxMmS, ky = (L.y1 - L.y0) / L.yTop;
    let above = false, below = false;
    for (let j = 0; j < 3; j++) {
      const x = j === 0 ? x0 : (j === 1 ? (x0 + x1) / 2 : x1);
      const y = L.y1 - this.valueAt(ts, (x - L.x0) / kx) * ky;
      if (y >= y0 - 1 && y <= y1 + 1) return 1;
      if (y < y0) above = true; else below = true;
    }
    return above && below ? 1 : 0;
  }

  /**
   * @private Pick a box for a label `w` wide beside a marker at x = `ax` whose top and bottom are
   * `ayTop` and `ayBot`, against the boxes kept so far, and keep it. Candidates: `diamond` false
   * (the live dot) 0 above right, 1 above left, 2 below right, 3 below left, tried in that order or,
   * with `flip`, left before right; `diamond` true 0 centered above, 1 centered below, 2 right,
   * 3 left; 4 to 7 the same one text row farther out. `keep` (a candidate, or −1) is taken while
   * it is free. Leaves the label's left and bottom edges in bx0 / by0 and returns the candidate.
   */
  pickFloating(ax, ayTop, ayBot, w, fh, diamond, flip, keep) {
    let best = Infinity, pick = -1;
    if (keep >= 0) {
      const s = this.floatingScore(keep, ax, ayTop, ayBot, w, fh, diamond);
      if (s === 0) pick = keep; else best = Infinity;
    }
    if (pick < 0) {
      for (let n = 0; n < 8; n++) {
        const q = flip ? n ^ 1 : n;
        const s = this.floatingScore(q, ax, ayTop, ayBot, w, fh, diamond);
        if (s < best) { best = s; pick = q; }
      }
    }
    this.floatingBox(pick, ax, ayTop, ayBot, w, fh, diamond);
    this.addBox(this.bx0, this.by0 - fh, this.bx0 + w, this.by0);
    return pick;
  }

  /** @private candidate q's left and bottom edges into bx0 / by0 (see pickFloating) */
  floatingBox(q, ax, ayTop, ayBot, w, fh, diamond) {
    const b = q & 3, row = q > 3 ? fh + 2 : 0;
    if (diamond) {
      this.bx0 = b < 2 ? ax - w / 2 : (b === 2 ? ax + 9 : ax - 9 - w);
      this.by0 = b === 0 ? ayTop - row : (b === 1 ? ayBot + fh + row : (ayTop + ayBot + fh) / 2 + row);
    } else {
      this.bx0 = b % 2 === 0 ? ax + 9 : ax - 9 - w;
      this.by0 = b < 2 ? ayTop - row : ayBot + fh + row;
    }
  }

  /** @private labelScore of candidate q (see pickFloating) */
  floatingScore(q, ax, ayTop, ayBot, w, fh, diamond) {
    this.floatingBox(q, ax, ayTop, ayBot, w, fh, diamond);
    return this.labelScore(this.bx0, this.by0 - fh, this.bx0 + w, this.by0, -1, null);
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
    // the sweep results (the chapter's own table when it passes one), placed with the static labels
    const res = this.opts.results || (sw && sw.results);
    let resSig = 0;
    if (res) for (const k in res) resSig = resSig * 31 + Number(k) * 7919 + num(res[k], -1);
    if (selV !== this.placedSel || resSig !== this.placedRes) this.placeLabels(selV, res, resSig);
    this.nBoxes = this.nStatic;     // this frame's dot label comes after the static ones

    // grid and axes
    g.strokeStyle = th.scopeGrid;
    g.lineWidth = 1;
    g.beginPath();
    for (let v = L.xStep; v < this.maxMmS + 1e-6; v += L.xStep) { const x = Math.round(X(v)) + 0.5; g.moveTo(x, y0); g.lineTo(x, y1); }
    // y ticks by index (no accumulated rounding), so gridlines and labels share their values
    for (let i = 1; i * L.yStep < L.yTop + 1e-9; i++) { const y = Math.round(Y(i * L.yStep)) + 0.5; g.moveTo(x0, y); g.lineTo(x1, y); }
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
    for (let i = 0; i * L.yStep <= L.yTop + 1e-9; i++) g.fillText(formatValue(i * L.yStep, L.yDec), x0 - 5, Y(i * L.yStep));
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
      if (!th.dark) {
        // gray rim under the amber curve: amber alone is faint on the light card
        g.strokeStyle = th.lineColor;
        g.lineWidth = 4.6;
        g.globalAlpha = 0.55;
        this.curve(selCurve.ts, X, Y);
        g.globalAlpha = 1;
      }
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

    // the dot's speed picks a free side first; a voltage label it still covers (no side was free)
    // yields for the frame
    const fh = this.fpx(12);
    const dia = this.dia;
    const tMeas = (this.preset.Kt || 0) * (this.iEma === this.iEma ? this.iEma : 0);
    const sp = Math.min(speed, this.maxMmS);
    const dpx = X(sp), dpy = selCurve ? Y(this.valueAt(selCurve.ts, sp)) : 0, yr = Y(tMeas);
    if (selCurve) {
      // the speed above the dot and ring (toward the plot's middle) or below them, wherever it
      // is free, staying on its side while that remains free
      this.dotPick = this.pickFloating(dpx, Math.min(dpy, yr) - 6, Math.max(dpy, yr) + 6,
        this.str.dot.length * this.charW + 2, fh, false, dpx > (x0 + x1) / 2, this.dotPick);
      this.dotLX = this.bx0;
      this.dotLY = this.by0;
    }

    // curve labels and the knee note, where placeLabels put them
    g.font = this.font.monoBold;
    g.textBaseline = 'bottom';
    g.textAlign = 'left';
    for (const c of this.curves) {
      if (this.covered(c.lx - 1, c.ly - fh, c.lx - 1 + c.lw, c.ly)) continue;
      g.fillStyle = c.V === selV ? th.text : th.muted;
      haloText(g, c.label, c.lx, c.ly, th.tipBg);
    }
    if (selCurve && selCurve.kneeMmS > 0 && selCurve.kneeMmS < this.maxMmS) {
      g.font = this.font.ui;
      g.fillStyle = th.descColor;
      haloText(g, this.str.knee, this.kneeLX, y1 - 4, th.tipBg);
    }

    // sweep results, where placeLabels put them
    for (let j = 0; j < 5 * this.nDia; j += 5) {
      const px = dia[j], py = dia[j + 1];
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
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      haloText(g, formatValue(dia[j + 4], 0), dia[j + 2] + 1, dia[j + 3], th.tipBg);
    }

    // live dot on the selected curve and the measured ring
    if (selCurve) {
      g.strokeStyle = th.text;
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(dpx, yr, 6.5, 0, TAU); g.stroke();
      g.fillStyle = th.field;
      g.strokeStyle = th.tipBg;
      g.lineWidth = 2;
      g.beginPath(); g.arc(dpx, dpy, 5, 0, TAU); g.fill(); g.stroke();
      g.font = this.font.mono;
      g.fillStyle = th.text;
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      haloText(g, this.str.dot, this.dotLX + 1, this.dotLY, th.tipBg);
    }

    // run current on the title line; the motor families in the empty top right of the plot
    // (above every curve: the curves are flat at the run-current torque, then fall)
    g.font = this.font.ui;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    const ly = 8 + this.fpx(12) / 2;
    g.fillStyle = th.descColor;
    g.fillText(this.str.cur, x1, ly, Math.max(40, x1 - x0 - 40));
    const lh = this.fpx(12) + 5;
    let ry = y0 + lh / 2 + 2;
    g.fillStyle = th.text;
    g.fillText(this.str.legend, x1 - 4, ry, x1 - x0 - 34);
    let lw = g.measureText(this.str.legend).width;
    g.strokeStyle = th.target;
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(x1 - lw - 26, ry); g.lineTo(x1 - lw - 9, ry); g.stroke();
    if (this.refCurves.length) {
      ry += lh;
      g.fillStyle = th.descColor;
      g.fillText(this.str.ref, x1 - 4, ry, x1 - x0 - 34);
      lw = g.measureText(this.str.ref).width;
      g.strokeStyle = th.muted;
      g.lineWidth = 1;
      g.setLineDash(DASH);
      g.beginPath(); g.moveTo(x1 - lw - 26, ry); g.lineTo(x1 - lw - 9, ry); g.stroke();
      g.setLineDash(SOLID);
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

  /** @private curve value at a speed (linear between the sample points; held past either end) */
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
    s.legend = `this motor, L ${formatValue(pr.L * 1000, 1)} mH`;
    s.ref = this.refPreset ? `typical motor, L ${formatValue(this.refPreset.L * 1000, 1)} mH` : '';
    s.cur = this.opts.rms ? `run current ${formatValue(this.I / Math.SQRT2, 2)} A RMS`
      : `run current ${formatValue(this.I, 2)} A peak`;
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
