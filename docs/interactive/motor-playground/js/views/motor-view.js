/**
 * Motor cross-section view (SPEC 4.5; chapters 2, 4, 5 and 7).
 *
 * Draws one electrical cycle of the motor: a two-pole rotor (N red, S blue)
 * at the rotor's electrical angle `thetaE`, and the stator teeth with their
 * coils (stepper: A and B at 0° and 90°; BLDC: A, B and C at 0°, 120° and
 * 240°, with the return teeth marked with a prime). Each coil glows with
 * |phase current| / rated current in its phase color. Overlays: the current
 * (field) vector in amber from iα/iβ, the rotor's d axis (solid) and q axis
 * (dashed), the load-angle arc with its value, a curved torque arrow, and a
 * dashed ghost vector: the commanded field `thetaCmd` in open loop, or the
 * target current (id*, iq*) under FOC. With an FOC driver a small dial shows
 * the shaft's mechanical angle on a turning encoder disc.
 *
 * Options (setOptions or the chapter's viewOptions.motor):
 *   motor           index of the motor to draw (default 0)
 *   showTransforms  Clarke/Park overlay and a three-stage panel (phase
 *                   currents → α, β → d, q) for chapter 7 (default false)
 *   fieldTrail      dots where the current vector's tip has been (default false)
 *   compact         only the motor and its vectors, no labels (default false;
 *                   also automatic below 220 × 180 css px)
 *   dial            'auto' (FOC only), true or false
 *   legend, note    top legend line and the "repeats N times per turn" note (default true)
 */
import {
  CanvasView, TAU, arrow, arrowHead, haloText, clamp, num, presetOf, wrapAngle,
} from './view-util.js';
import { formatValue } from '../format.js';

const TRAIL_N = 480;
const DEG = 180 / Math.PI;
const TORQUE_SPAN = 100 / DEG;       // arc span of the torque arrow at full torque
const TICKS = 48;                    // ticks drawn on the encoder disc (schematic)
const PRIME = '′';
const SOLID = [];
const DASH = [6, 4];
const DASH_FINE = [3, 3];
const PHASE_NAMES = ['A', 'B', 'C'];

export class MotorView extends CanvasView {
  /** Preferred height / width (main.js: stage height and mobile host height). */
  static aspect = 0.8;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    super(host, opts, {
      motor: 0, showTransforms: false, fieldTrail: false, compact: false, dial: 'auto', legend: true, note: true,
    });
    this.trail = new Float32Array(TRAIL_N * 2);
    this.trailHead = 0;
    this.trailLen = 0;
    this.lay = {
      key: '', compact: false, phases: 2, cx: 0, cy: 0, R: 0, Ry: 0, Rin: 0, Rr: 0,
      legend: false, legendY: 0, note: false, noteY: 0, dial: false, dx: 0, dy: 0, dr: 0,
      panel: 0, px: 0, py: 0, pw: 0, ph: 0,
    };
    this.str = {
      delta: '', torque: '', count: '', ph: ['', '', ''], alpha: '', beta: '', d: '', q: '',
    };
    this.noteText = '';
    this.ghostLabel = '';
    this.stages = null;
  }

  onTheme() {
    this.stages = null;
  }

  onOptions(o) {
    if ('fieldTrail' in o || 'motor' in o) this.trailLen = 0;
  }

  /** @private layout for the current size, options, phase count and driver */
  layout(nPh, isFoc) {
    const L = this.lay, o = this.opts, w = this.w, h = this.h;
    const key = `${w}|${h}|${this.fs}|${nPh}|${isFoc}|${o.compact}|${o.showTransforms}|${o.dial}|${o.legend}|${o.note}`;
    if (!this.layoutDirty && key === L.key) return;
    this.layoutDirty = false;
    L.key = key;
    L.phases = nPh;
    const compact = !!o.compact || w < 220 || h < 180;
    L.compact = compact;
    const line = this.fpx(12) + 8;
    let top = 4, bot = h - 4, left = 4, right = w - 4;
    L.legend = !compact && o.legend !== false;
    L.panel = 0;
    if (o.showTransforms && !compact) {
      if (w >= 1.3 * h) {
        L.panel = 1;
        L.pw = clamp(w * 0.36, 150, 250);
        L.px = right - L.pw;
        right = L.px - 8;
      } else {
        L.panel = 2;
        L.ph = this.fpx(12) * 4 + 22;
        L.pw = right - left;
        L.px = left;
      }
    }
    L.note = !compact && o.note !== false && L.panel !== 2;
    if (L.legend) { L.legendY = top + line / 2; top += line; }
    if (L.note) { L.noteY = bot - line / 2; bot -= line; }
    if (L.panel === 2) { L.py = bot - L.ph; bot = L.py - 4; }
    if (L.panel === 1) { L.py = top; L.ph = bot - top; }
    const cx = (left + right) / 2, cy = (top + bot) / 2;
    let R = Math.max(12, Math.min(right - left, bot - top) / 2 - 2);
    L.dial = !compact && (o.dial === true || (o.dial === 'auto' && isFoc));
    if (L.dial) {
      const dr = clamp(Math.min(w, h) * 0.085, 16, 36);
      L.dr = dr;
      L.dx = right - dr - 2;
      L.dy = top + dr + this.fpx(12) + 6;
      const dist = Math.hypot(L.dx - cx, L.dy - cy);
      if (dist < R + dr + 6) R = Math.max(12, dist - dr - 6);
    }
    L.cx = cx;
    L.cy = cy;
    L.R = R;
    L.Ry = R * 0.84;
    L.Rin = R * 0.6;
    L.Rr = L.Rin * 0.66;
  }

  /**
   * @param {Object} snap
   * @param {Object} ctx
   */
  draw(snap, ctx) {
    const idx = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[idx];
    if (!m) return;
    const th = ctx.theme, g = this.g;
    const pr = presetOf(snap, idx);
    const nPh = m.iPhase && m.iPhase.length === 3 ? 3 : 2;
    const isFoc = m.driver === 'foc' || (m.driver == null && snap.driver === 'foc');
    this.layout(nPh, isFoc);
    const L = this.lay;
    const Irated = pr.Irated || 1;
    const thetaE = num(m.thetaE, 0);
    const iA = num(m.iAlpha, 0), iB = num(m.iBeta, 0);
    const iMag = Math.sqrt(iA * iA + iB * iB);
    const phi = Math.atan2(iB, iA);
    const vScale = L.Rin * 0.95 / Irated;           // px per amp for the vectors
    const cx = L.cx, cy = L.cy;

    if (this.fresh) this.formatStrings(snap, m, pr, isFoc, iMag, phi, thetaE);

    this.drawStator(th, m, nPh, Irated);

    // bore outline
    g.strokeStyle = th.divider;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, L.Rin - 1.5, 0, TAU);
    g.stroke();

    if (this.opts.fieldTrail) this.drawTrail(th, snap, iA / Irated, iB / Irated);
    this.drawRotor(th, thetaE);
    if (this.opts.showTransforms && !L.compact) this.drawProjections(th, m, thetaE, vScale, iA, iB);
    this.drawAxes(th, thetaE);

    // load-angle arc (between the rotor's d axis and the current vector)
    if (iMag > 0.04 * Irated) {
      const delta = wrapAngle(phi - thetaE);
      const r = L.Rr * 0.42;
      g.strokeStyle = th.text;
      g.globalAlpha = 0.75;
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(cx, cy, r, -thetaE, -thetaE - delta, delta > 0);
      g.stroke();
      g.globalAlpha = 1;
      if (!L.compact && Math.abs(delta) > 3 / DEG) {
        const mid = thetaE + delta / 2, rl = r + this.fpx(12) * 0.9;
        g.font = this.font.monoBold;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = th.text;
        haloText(g, this.str.delta, cx + rl * Math.cos(mid), cy - rl * Math.sin(mid), th.tipBg);
      }
    }

    this.drawTorque(th, m, pr, thetaE);

    // ghost: commanded field (open loop) or target current (FOC), dashed
    let gAng, gMag;
    if (isFoc) {
      const ids = num(m.idStar, 0), iqs = num(m.iqStar, 0);
      gMag = Math.sqrt(ids * ids + iqs * iqs);
      gAng = thetaE + Math.atan2(iqs, ids);
    } else {
      const ids = num(m.idStar, 0), iqs = num(m.iqStar, 0);
      gMag = Math.sqrt(ids * ids + iqs * iqs);
      gAng = num(m.thetaCmd, thetaE);
    }
    if (gMag > 0.02 * Irated) {
      const r = Math.min(gMag * vScale, L.Rin * 1.08);
      g.strokeStyle = th.target;
      g.fillStyle = th.target;
      g.lineWidth = 2;
      g.setLineDash(DASH);
      g.lineCap = 'butt';
      arrow(g, cx, cy, cx + r * Math.cos(gAng), cy - r * Math.sin(gAng), 9);
      g.setLineDash(SOLID);
    }

    // current (field) vector, amber, with a halo
    if (iMag > 0.01 * Irated) {
      const r = Math.min(iMag * vScale, L.Rin * 1.08);
      const x1 = cx + r * Math.cos(phi), y1 = cy - r * Math.sin(phi);
      g.lineCap = 'round';
      g.strokeStyle = th.tipBg;
      g.fillStyle = th.tipBg;
      g.lineWidth = 6;
      arrow(g, cx, cy, x1, y1, 13);
      g.strokeStyle = th.field;
      g.fillStyle = th.field;
      g.lineWidth = 3;
      arrow(g, cx, cy, x1, y1, 11);
      g.lineCap = 'butt';
    }
    // shaft
    g.beginPath();
    g.arc(cx, cy, Math.max(2.5, L.Rr * 0.08), 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.stroke();

    if (L.dial) this.drawDial(th, m);
    if (L.legend) this.drawLegend(th, isFoc);
    if (L.note) {
      g.font = this.font.ui;
      g.fillStyle = th.muted;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(this.noteText, this.w / 2, L.noteY, this.w - 8);
    }
    if (L.panel) this.drawPanel(th, nPh);
  }

  /** @private 10 Hz strings */
  formatStrings(snap, m, pr, isFoc, iMag, phi, thetaE) {
    const s = this.str;
    s.delta = Math.round(wrapAngle(phi - thetaE) * DEG) + '°';
    s.torque = 'torque ' + formatValue(num(m.torque, 0), 2) + ' N·m';
    s.count = m.encoder ? String(m.encoder.count) : '';
    const ip = m.iPhase || [];
    for (let k = 0; k < 3; k++) s.ph[k] = k < ip.length ? signed(ip[k]) + ' A' : '';
    s.alpha = signed(num(m.iAlpha, 0)) + ' A';
    s.beta = signed(num(m.iBeta, 0)) + ' A';
    s.d = signed(num(m.id, 0)) + ' A';
    s.q = signed(num(m.iq, 0)) + ' A';
    this.noteText = pr.phases === 3
      ? `${pr.p} pole pairs: this picture repeats ${pr.p} times per turn`
      : `A 1.8° stepper repeats this picture ${pr.p} times per turn`;
    this.ghostLabel = isFoc ? 'target' : 'command';
  }

  /** @private yoke, teeth and glowing coils */
  drawStator(th, m, nPh, Irated) {
    const g = this.g, L = this.lay, cx = L.cx, cy = L.cy, R = L.R;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.arc(cx, cy, L.Ry, 0, TAU, true);
    g.fillStyle = th.divider;
    g.fill();
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();

    const nT = nPh * 2;
    const sa = (Math.PI / nT) * 0.62;
    const tw = R * (nT === 4 ? 0.1 : 0.075);
    const sh = R * 0.05;
    const cw = R * 0.055;
    const Rin = L.Rin, Ry = L.Ry;
    const u0 = Rin + sh + 3, u1 = Ry - 3;
    const ip = m.iPhase || [];
    const colors = [th.phaseA, th.phaseB, th.phaseC];
    const pitch = TAU / nT;
    for (let k = 0; k < nT; k++) {
      const a = k * pitch;
      const ph = toothPhase(k, nPh);
      g.save();
      g.translate(cx, cy);
      g.rotate(-a);
      // tooth with its pole shoe
      g.beginPath();
      g.arc(0, 0, Rin, -sa, sa);
      g.lineTo((Rin + sh) * Math.cos(sa), (Rin + sh) * Math.sin(sa));
      g.lineTo(Rin + sh + 2, tw);
      g.lineTo(Ry + 1, tw);
      g.lineTo(Ry + 1, -tw);
      g.lineTo(Rin + sh + 2, -tw);
      g.lineTo((Rin + sh) * Math.cos(sa), -(Rin + sh) * Math.sin(sa));
      g.closePath();
      g.fillStyle = th.divider;
      g.fill();
      g.strokeStyle = th.lineColor;
      g.stroke();
      // coil on both sides of the tooth neck
      const col = colors[ph.index];
      const lvl = Math.min(1, Math.abs(num(ip[ph.index], 0)) / Irated);
      g.fillStyle = col;
      g.globalAlpha = 0.12 + 0.78 * lvl;
      g.fillRect(u0, tw, u1 - u0, cw);
      g.fillRect(u0, -tw - cw, u1 - u0, cw);
      g.globalAlpha = 1;
      g.strokeStyle = col;
      g.lineWidth = 1.2;
      g.strokeRect(u0, tw, u1 - u0, cw);
      g.strokeRect(u0, -tw - cw, u1 - u0, cw);
      g.lineWidth = 0.8;
      g.beginPath();
      for (let u = u0 + 3; u < u1 - 1; u += 3.5) {
        g.moveTo(u, tw); g.lineTo(u, tw + cw);
        g.moveTo(u, -tw); g.lineTo(u, -tw - cw);
      }
      g.stroke();
      g.restore();
    }
    if (L.compact) return;
    // phase letters on the teeth
    g.font = this.font.uiBold;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = th.text;
    const ul = (u0 + u1) / 2;
    for (let k = 0; k < nT; k++) {
      const a = k * pitch;
      const ph = toothPhase(k, nPh);
      g.fillText(PHASE_NAMES[ph.index] + (ph.ret ? PRIME : ''), cx + ul * Math.cos(a), cy - ul * Math.sin(a));
    }
  }

  /** @private two-pole rotor at thetaE: N half toward thetaE */
  drawRotor(th, thetaE) {
    const g = this.g, L = this.lay, cx = L.cx, cy = L.cy, r = L.Rr;
    const a0 = -thetaE - Math.PI / 2, a1 = -thetaE + Math.PI / 2;
    // N half
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, a0, a1);
    g.closePath();
    g.fillStyle = th.rotorN;
    g.globalAlpha = 0.26;
    g.fill();
    g.globalAlpha = 1;
    // S half
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, a1, a0 + TAU);
    g.closePath();
    g.fillStyle = th.rotorS;
    g.globalAlpha = 0.26;
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = 2.5;
    g.strokeStyle = th.rotorN;
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    g.strokeStyle = th.rotorS;
    g.beginPath(); g.arc(cx, cy, r, a1, a0 + TAU); g.stroke();
    if (L.compact && r < 30) return;
    const rl = r * 0.7, off = 0.62;
    g.font = `700 ${this.fpx(13)}px ${this.theme.fontUi}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = th.rotorN;
    g.fillText('N', cx + rl * Math.cos(thetaE + off), cy - rl * Math.sin(thetaE + off));
    g.fillStyle = th.rotorS;
    g.fillText('S', cx + rl * Math.cos(thetaE + Math.PI + off), cy - rl * Math.sin(thetaE + Math.PI + off));
  }

  /** @private d axis (solid) and q axis (dashed) of the rotor frame */
  drawAxes(th, thetaE) {
    const g = this.g, L = this.lay, cx = L.cx, cy = L.cy;
    const r = L.Rin * 0.97;
    const cd = Math.cos(thetaE), sd = Math.sin(thetaE);
    const cq = -sd, sq = cd;
    g.lineCap = 'butt';
    // halo
    g.strokeStyle = th.tipBg;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - r * 0.35 * cd, cy + r * 0.35 * sd); g.lineTo(cx + r * cd, cy - r * sd);
    g.stroke();
    g.strokeStyle = th.axisD;
    g.lineWidth = 1.6;
    g.stroke();
    g.setLineDash(DASH_FINE);
    g.strokeStyle = th.axisQ;
    g.beginPath();
    g.moveTo(cx - r * 0.35 * cq, cy + r * 0.35 * sq); g.lineTo(cx + r * cq, cy - r * sq);
    g.stroke();
    g.setLineDash(SOLID);
    if (L.compact && L.R < 60) return;
    g.font = this.font.uiBold;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // Labels sit beside the axis ends, on the lagging side: a positive load angle puts the
    // current vector just ahead of d, so the label stays clear of it.
    const rl = r - 4, off = this.fpx(12) * 0.75;
    g.fillStyle = th.axisD;
    haloText(g, 'd', cx + rl * cd + off * sd, cy - rl * sd + off * cd, th.tipBg);
    g.fillStyle = th.axisQ;
    haloText(g, 'q', cx + rl * cq + off * sq, cy - rl * sq + off * cq, th.tipBg);
  }

  /** @private curved arrow around the rotor, span ∝ torque / (Kt · Irated) */
  drawTorque(th, m, pr, thetaE) {
    const tq = num(m.torque, 0);
    const tmax = (pr.Kt || 0.2) * (pr.Irated || 1);
    const f = clamp(tq / tmax, -1, 1);
    if (Math.abs(f) < 0.03) return;
    const g = this.g, L = this.lay, cx = L.cx, cy = L.cy;
    const r = L.Rr + (L.Rin - L.Rr) * 0.42;
    const span = f * TORQUE_SPAN;
    const a0 = thetaE, a1 = thetaE + span;
    g.strokeStyle = th.axisQ;
    g.fillStyle = th.axisQ;
    g.lineWidth = 3;
    g.lineCap = 'round';
    const head = Math.min(10, Math.abs(span) * r * 0.5);
    // stop the arc short of the head so the head's tip lands on a1
    const back = head / r * Math.sign(span);
    g.beginPath();
    g.arc(cx, cy, r, -a0, -(a1 - back), span > 0);
    g.stroke();
    g.lineCap = 'butt';
    const tx = -Math.sin(a1) * Math.sign(span), ty = -Math.cos(a1) * Math.sign(span);
    arrowHead(g, cx + r * Math.cos(a1), cy - r * Math.sin(a1), tx, ty, head);
  }

  /** @private where the current vector's tip has been, fading with age */
  drawTrail(th, snap, nx, ny) {
    const tr = this.trail;
    if (snap.t < this.lastT) this.trailLen = 0;
    if (this.advanced || this.trailLen === 0) {
      const h = this.trailHead;
      tr[h * 2] = nx;
      tr[h * 2 + 1] = ny;
      this.trailHead = (h + 1) % TRAIL_N;
      if (this.trailLen < TRAIL_N) this.trailLen++;
    }
    const g = this.g, L = this.lay, s = L.Rin * 0.95, n = this.trailLen;
    g.fillStyle = th.field;
    const r = L.compact ? 1.4 : 1.9;
    for (let b = 0; b < 4; b++) {
      g.globalAlpha = 0.15 + 0.2 * b;
      g.beginPath();
      const i0 = Math.floor(n * b / 4), i1 = Math.floor(n * (b + 1) / 4);
      for (let i = i0; i < i1; i++) {
        let p = this.trailHead - n + i;
        if (p < 0) p += TRAIL_N;
        const x = L.cx + tr[p * 2] * s, y = L.cy - tr[p * 2 + 1] * s;
        g.moveTo(x + r, y);
        g.arc(x, y, r, 0, TAU);
      }
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** @private Clarke (α, β) and Park (d, q) projections of the current vector */
  drawProjections(th, m, thetaE, vScale, iA, iB) {
    const g = this.g, L = this.lay, cx = L.cx, cy = L.cy, r = L.Rin * 1.02;
    // stator axes α and β
    g.strokeStyle = th.muted;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx - r, cy); g.lineTo(cx + r, cy);
    g.moveTo(cx, cy + r); g.lineTo(cx, cy - r);
    g.stroke();
    // labels beside the axis ends (the phase letters sit on the axes, on the A and B teeth)
    g.font = this.font.uiBold;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = th.muted;
    const off = this.fpx(12) * 0.8;
    haloText(g, 'α', cx + r - off, cy + off, th.tipBg);
    haloText(g, 'β', cx - off, cy - r + off, th.tipBg);
    const tx = cx + iA * vScale, ty = cy - iB * vScale;
    // Clarke: projections onto α and β
    g.setLineDash(DASH_FINE);
    g.beginPath();
    g.moveTo(tx, ty); g.lineTo(tx, cy);
    g.moveTo(tx, ty); g.lineTo(cx, ty);
    g.stroke();
    g.setLineDash(SOLID);
    g.fillStyle = th.muted;
    g.beginPath(); g.arc(tx, cy, 3, 0, TAU); g.arc(cx, ty, 3, 0, TAU); g.fill();
    // Park: id along d, iq along q (thick colored segments)
    const cd = Math.cos(thetaE), sd = Math.sin(thetaE);
    const id = num(m.id, 0) * vScale, iq = num(m.iq, 0) * vScale;
    const dx = cx + id * cd, dy = cy - id * sd;
    const qx = cx - iq * sd, qy = cy - iq * cd;
    g.setLineDash(DASH_FINE);
    g.strokeStyle = th.text;
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(tx, ty); g.lineTo(dx, dy);
    g.moveTo(tx, ty); g.lineTo(qx, qy);
    g.stroke();
    g.globalAlpha = 1;
    g.setLineDash(SOLID);
    g.lineCap = 'round';
    g.lineWidth = 5;
    g.strokeStyle = th.axisD;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(dx, dy); g.stroke();
    g.strokeStyle = th.axisQ;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(qx, qy); g.stroke();
    g.lineCap = 'butt';
  }

  /** @private shaft angle on a turning encoder disc (FOC) */
  drawDial(th, m) {
    const g = this.g, L = this.lay, x = L.dx, y = L.dy, r = L.dr;
    const a = num(m.thetaM, 0);
    g.font = this.font.ui;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillStyle = th.muted;
    g.fillText('shaft', x, y - r - 3);
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.stroke();
    // encoder lines turn with the shaft
    g.strokeStyle = th.muted;
    g.beginPath();
    for (let k = 0; k < TICKS; k++) {
      const t = a + k * TAU / TICKS, c = Math.cos(t), s = Math.sin(t);
      g.moveTo(x + (r - 1) * c, y - (r - 1) * s);
      g.lineTo(x + (r - 5) * c, y - (r - 5) * s);
    }
    g.stroke();
    // fixed read head at the top
    g.fillStyle = th.text;
    g.beginPath();
    g.moveTo(x, y - r + 6); g.lineTo(x - 3.5, y - r - 1); g.lineTo(x + 3.5, y - r - 1);
    g.closePath();
    g.fill();
    // pointer
    g.strokeStyle = th.text;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (r - 8) * Math.cos(a), y - (r - 8) * Math.sin(a));
    g.stroke();
    g.lineCap = 'butt';
    g.font = this.font.mono;
    g.textBaseline = 'top';
    g.fillStyle = th.muted;
    g.fillText(this.str.count, x, y + r + 3, Math.max(40, r * 2.6));
  }

  /** @private one-line legend at the top */
  drawLegend(th, isFoc) {
    const g = this.g, y = this.lay.legendY;
    g.font = this.font.ui;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    let x = this.legendItem(th, 8, y, th.field, SOLID, 3, 'current');
    x = this.legendItem(th, x, y, th.target, DASH, 2, this.ghostLabel || (isFoc ? 'target' : 'command'));
    if (x + 60 < this.w) this.legendItem(th, x, y, th.axisQ, SOLID, 3, this.str.torque);
  }

  /** @private one legend entry; returns the x after it */
  legendItem(th, x, y, color, dash, width, label) {
    const g = this.g;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + 16, y); g.stroke();
    g.setLineDash(SOLID);
    g.fillStyle = th.descColor;
    g.fillText(label, x + 21, y);
    return x + 21 + g.measureText(label).width + 12;
  }

  /** @private stage descriptors of the transforms panel (rebuilt with the strings, 10 Hz) */
  buildStages(th, nPh) {
    const s = this.str, side = this.lay.panel === 1;
    const phases = [['A', s.ph[0], th.phaseA], ['B', s.ph[1], th.phaseB]];
    if (nPh === 3) phases.push(['C', s.ph[2], th.phaseC]);
    this.stages = [
      { title: side ? '1  Phase currents' : 'Phase currents', note: side ? 'what the sensors read' : '', rows: phases },
      { title: side ? '2  Clarke → α, β' : 'Clarke → α, β', note: side ? 'stator frame: they rotate' : '',
        rows: [['α', s.alpha, th.muted], ['β', s.beta, th.muted]] },
      { title: side ? '3  Park → d, q' : 'Park → d, q', note: side ? 'rotor frame: they hold still' : '',
        rows: [['d', s.d, th.axisD], ['q', s.q, th.axisQ]] },
    ];
  }

  /** @private Clarke/Park stage panel (side or bottom) */
  drawPanel(th, nPh) {
    const g = this.g, L = this.lay;
    const lh = this.fpx(12) + 4;
    const side = L.panel === 1;
    if (this.fresh || !this.stages) this.buildStages(th, nPh);
    const stages = this.stages;
    g.textBaseline = 'middle';
    if (side) {
      const x = L.px, w = L.pw;
      const blockH = lh * 5 + 8;
      const gap = Math.max(10, (L.ph - blockH * 3) / 2);
      let y = L.py + Math.max(0, (L.ph - blockH * 3 - gap * 2) / 2);
      for (let k = 0; k < 3; k++) {
        this.drawStage(th, stages[k], x, y, w, blockH, lh);
        if (k < 2) {
          g.strokeStyle = th.muted;
          g.fillStyle = th.muted;
          g.lineWidth = 1.5;
          arrow(g, x + w / 2, y + blockH + 1, x + w / 2, y + blockH + gap - 1, 6);
        }
        y += blockH + gap;
      }
    } else {
      const gap = 14;
      const cw = (L.pw - gap * 2) / 3;
      for (let k = 0; k < 3; k++) {
        const x = L.px + k * (cw + gap);
        this.drawStage(th, stages[k], x, L.py, cw, L.ph, lh);
        if (k < 2) {
          g.strokeStyle = th.muted;
          g.fillStyle = th.muted;
          g.lineWidth = 1.5;
          arrow(g, x + cw + 2, L.py + L.ph / 2, x + cw + gap - 2, L.py + L.ph / 2, 5);
        }
      }
    }
  }

  /** @private one stage box of the transforms panel */
  drawStage(th, st, x, y, w, h, lh) {
    const g = this.g;
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1;
    g.beginPath();
    if (g.roundRect) g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6); else g.rect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.stroke();
    let yy = y + 4 + lh / 2;
    g.font = this.font.uiBold;
    g.textAlign = 'left';
    g.fillStyle = th.text;
    g.fillText(st.title, x + 6, yy, w - 12);
    yy += lh;
    if (st.note) {
      g.font = this.font.ui;
      g.fillStyle = th.muted;
      g.fillText(st.note, x + 6, yy, w - 12);
      yy += lh;
    }
    g.font = this.font.mono;
    const rows = st.rows;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      g.fillStyle = row[2];
      g.beginPath(); g.arc(x + 10, yy, 3.5, 0, TAU); g.fill();
      g.fillStyle = th.text;
      g.textAlign = 'left';
      g.fillText(row[0], x + 18, yy);
      g.textAlign = 'right';
      g.fillText(row[1], x + w - 6, yy, w - 40);
      yy += lh;
    }
  }

  /** @returns {string} one-sentence summary */
  describe(snap) {
    const idx = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[idx];
    if (!m) return '';
    const pr = presetOf(snap, idx);
    const kind = pr.phases === 3 ? 'BLDC motor' : 'Stepper motor';
    const deg = Math.round(((num(m.thetaE, 0) * DEG) % 360 + 360) % 360);
    const iMag = Math.hypot(num(m.iAlpha, 0), num(m.iBeta, 0));
    const delta = Math.round(wrapAngle(Math.atan2(num(m.iBeta, 0), num(m.iAlpha, 0)) - num(m.thetaE, 0)) * DEG);
    const foc = m.driver === 'foc';
    return `${kind} cross-section${foc ? ' under field-oriented control' : ''}: rotor at ${deg}° electrical, `
      + `current ${formatValue(iMag, 2)} A at a load angle of ${delta}°, torque ${formatValue(num(m.torque, 0), 2)} N·m`
      + (foc ? `, torque current ${formatValue(num(m.iq, 0), 2)} A, flux current ${formatValue(num(m.id, 0), 2)} A.` : '.');
  }
}

/** Signed value with a real minus sign and two decimals ("+1.23", "−0.61"). */
function signed(v) {
  const s = formatValue(v, 2);
  return v > 0 && s !== '0.00' ? '+' + s : s;
}

/**
 * Phase of stator tooth k (teeth every 180°/phases, starting at 0°): the
 * tooth at a phase's spatial angle carries that phase; the one opposite it is
 * the same phase's return (primed).
 * @returns {{index: number, ret: boolean}}
 */
const TOOTH = {
  2: [{ index: 0, ret: false }, { index: 1, ret: false }, { index: 0, ret: true }, { index: 1, ret: true }],
  3: [{ index: 0, ret: false }, { index: 2, ret: true }, { index: 1, ret: false },
    { index: 0, ret: true }, { index: 2, ret: false }, { index: 1, ret: true }],
};
function toothPhase(k, nPh) {
  return TOOTH[nPh][k];
}
