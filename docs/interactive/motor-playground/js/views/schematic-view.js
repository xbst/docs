/**
 * H-bridge schematic (SPEC 4.5; chapter 3): what one phase of a stepper
 * driver does.
 *
 * Four switches (S1 high left, S2 low left, S3 high right, S4 low right)
 * around the coil (R + L), a sense resistor to ground, and the control side:
 * the target from the sine table, a comparator against the measured current,
 * and the chopper logic that sets the switches. The switch states come from
 * `pwmState[0]` (+1: S1 and S4 on, the supply drives the coil; −1: S2 and S3
 * on, reversed; 0: S2 and S4 on, the coil current circulates through the low
 * side). Chevrons flow along the active current path with a speed that grows
 * with |iA|; they stand still while the simulation is paused.
 *
 * The state is named from the target's sign: driving toward the target is
 * "drive", 0 V is "slow decay", the opposite polarity is "fast decay".
 *
 * Options:
 *   phase   phase index to show (default 0, phase A)
 */
import { CanvasView, TAU, arrow, haloText, roundRect, led, clamp, num, presetOf } from './view-util.js';
import { formatValue } from '../format.js';

// Design coordinates; the drawing is scaled uniformly to fit the view.
const DW = 540, DH = 330;
const TOP = 46, MID = 150, BOT = 252, GND = 300;
const XL = 96, XR = 300, XS = 198;           // left leg, right leg, sense resistor
const XSUP = 40;                             // supply terminal
const SOLID = [];
const DASH = [4, 4];
const CHEV_SPACING = 24;
const FLOW = 80;                             // chevron speed at rated current, design px per real second

// Current paths (design coordinates), each in the direction of the listed coil current sign.
const PATH_DRIVE_POS = [XSUP, TOP, XL, TOP, XL, MID, XR, MID, XR, BOT, XS, BOT, XS, GND];  // S1+S4, i > 0
const PATH_DRIVE_NEG = [XSUP, TOP, XR, TOP, XR, MID, XL, MID, XL, BOT, XS, BOT, XS, GND];  // S3+S2, i < 0
const PATH_SLOW = [XL, MID, XR, MID, XR, BOT, XL, BOT, XL, MID];                              // S2+S4 loop, i > 0

export class SchematicView extends CanvasView {
  /** Preferred height / width. */
  static aspect = 0.64;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    super(host, opts, { phase: 0 });
    this.s = 1;
    this.ox = 0;
    this.oy = 0;
    this.flow = 0;          // chevron offset along the path, design px
    this.lastNow = 0;
    this.str = {
      vbus: '', i: '', tgt: '', state: '', rl: '', bemf: '',
      driveP: '', driveN: '', fastP: '', fastN: '', slow: '',
    };
  }

  /** @private */
  layout() {
    const s = Math.min((this.w - 8) / DW, (this.h - 8) / DH);
    this.s = Math.max(0.3, s);
    this.ox = (this.w - DW * this.s) / 2;
    this.oy = (this.h - DH * this.s) / 2;
    this.layoutDirty = false;
  }

  /** @private design → screen */
  X(x) { return this.ox + x * this.s; }
  Y(y) { return this.oy + y * this.s; }

  draw(snap, ctx, now) {
    if (this.layoutDirty) this.layout();
    const ph = this.opts.phase | 0;
    const m = snap.motors[0];
    if (!m) return;
    const g = this.g, th = ctx.theme;
    const pr = presetOf(snap, 0);
    const i = num(m.iPhase && m.iPhase[ph], 0);
    const iStar = num(m.iStar && m.iStar[ph], 0);
    const pwm = num(m.pwmState && m.pwmState[ph], 0);
    const Irated = pr.Irated || 1;
    const sign = Math.abs(iStar) > 0.02 * Irated ? Math.sign(iStar) : (i !== 0 ? Math.sign(i) : 1);
    const state = pwm === 0 ? 'slow' : pwm === sign ? 'drive' : 'fast';
    if (this.fresh) this.formatStrings(snap, m, pr, ph, i, iStar);

    // animation: the chevrons advance with real time while the simulation runs
    const dtReal = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    let path, dir;
    if (pwm > 0) { path = PATH_DRIVE_POS; dir = Math.sign(i); }
    else if (pwm < 0) { path = PATH_DRIVE_NEG; dir = -Math.sign(i); }
    else { path = PATH_SLOW; dir = Math.sign(i); }
    if (this.advanced) this.flow += dir * FLOW * clamp(Math.abs(i) / Irated, 0, 1.5) * dtReal;

    const sc = this.s;
    const lw = Math.max(1.2, 1.6 * sc);
    // active path glow
    if (Math.abs(i) > 0.01 * Irated) {
      g.strokeStyle = th.field;
      g.globalAlpha = 0.22;
      g.lineWidth = Math.max(5, 9 * sc);
      g.lineJoin = 'round';
      this.poly(path);
      g.globalAlpha = 1;
    }
    // wires
    g.strokeStyle = th.lineColor;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(this.X(XSUP), this.Y(TOP)); g.lineTo(this.X(XR), this.Y(TOP));
    g.moveTo(this.X(XL), this.Y(BOT)); g.lineTo(this.X(XR), this.Y(BOT));
    g.moveTo(this.X(XR), this.Y(BOT)); g.lineTo(this.X(360), this.Y(BOT));   // sense line to the comparator
    g.moveTo(this.X(XS), this.Y(BOT)); g.lineTo(this.X(XS), this.Y(BOT + 10));
    g.moveTo(this.X(XS), this.Y(GND - 12)); g.lineTo(this.X(XS), this.Y(GND));
    // coil leads
    g.moveTo(this.X(XL), this.Y(MID)); g.lineTo(this.X(138), this.Y(MID));
    g.moveTo(this.X(184), this.Y(MID)); g.lineTo(this.X(196), this.Y(MID));
    g.moveTo(this.X(262), this.Y(MID)); g.lineTo(this.X(XR), this.Y(MID));
    g.stroke();
    // switches
    const on1 = pwm > 0, on2 = pwm <= 0, on3 = pwm < 0, on4 = pwm >= 0;
    this.drawSwitch(th, XL, TOP, MID, on1, 'S1', -1);
    this.drawSwitch(th, XL, MID, BOT, on2, 'S2', -1);
    this.drawSwitch(th, XR, TOP, MID, on3, 'S3', 1);
    this.drawSwitch(th, XR, MID, BOT, on4, 'S4', 1);
    // coil: resistor zigzag and inductor loops
    this.drawCoil(th, lw);
    // sense resistor and ground
    this.drawSense(th, lw);
    // supply terminal
    g.fillStyle = th.text;
    g.beginPath(); g.arc(this.X(XSUP), this.Y(TOP), 3.5, 0, TAU); g.fill();

    // chevrons along the active path
    if (Math.abs(i) > 0.01 * Irated) this.drawChevrons(th, path, dir);

    // control side: target, comparator, chopper logic
    this.drawControl(th, m, i, iStar, pwm, state, lw);

    // labels
    g.textBaseline = 'middle';
    g.font = this.font.monoBold;
    g.textAlign = 'left';
    g.fillStyle = th.text;
    g.fillText(this.str.vbus, this.X(XSUP) - 4, this.Y(TOP) - this.fpx(12));
    g.font = this.font.ui;
    g.fillStyle = th.muted;
    g.textAlign = 'center';
    g.fillText('0 V', this.X(XS), this.Y(GND) + 22 * sc + 4);
    g.fillText('sense', this.X(XS) - 30 * sc, this.Y((BOT + GND) / 2 + 2));
    // coil current with its direction
    const cy = this.Y(MID) - 24 * sc;
    g.font = this.font.monoBold;
    g.fillStyle = th.text;
    haloText(g, this.str.i, this.X((XL + XR) / 2), cy - this.fpx(12) * 0.8, th.tipBg);
    if (Math.abs(i) > 0.02 * Irated) {
      g.strokeStyle = th.field;
      g.fillStyle = th.field;
      g.lineWidth = 2;
      const x0 = this.X(150), x1 = this.X(250);
      if (i > 0) arrow(g, x0, cy + 4, x1, cy + 4, 8); else arrow(g, x1, cy + 4, x0, cy + 4, 8);
    }
    g.font = this.font.ui;
    g.fillStyle = th.muted;
    g.fillText(this.str.rl, this.X((XL + XR) / 2), this.Y(MID) + 24 * sc);
    if (this.str.bemf) {
      g.font = this.font.mono;
      g.fillStyle = th.descColor;
      g.fillText(this.str.bemf, this.X((XL + XR) / 2), this.Y(MID) + 24 * sc + this.fpx(12) + 4);
    }
    // state caption centered over the bridge, picked every frame so it matches the switches
    g.textAlign = 'center';
    g.font = this.font.title;
    g.fillStyle = th.text;
    const cap = pwm === 0 ? this.str.slow : state === 'drive' ? (pwm > 0 ? this.str.driveP : this.str.driveN)
      : (pwm > 0 ? this.str.fastP : this.str.fastN);
    this.str.state = cap;
    g.fillText(cap, this.X((XL + XR) / 2 + 20), this.Y(TOP) - this.fpx(12) - 2);
  }

  /** @private polyline through design points */
  poly(pts) {
    const g = this.g;
    g.beginPath();
    g.moveTo(this.X(pts[0]), this.Y(pts[1]));
    for (let k = 2; k < pts.length; k += 2) g.lineTo(this.X(pts[k]), this.Y(pts[k + 1]));
    g.stroke();
  }

  /** @private switch on a vertical leg between y1 and y2 (design); side −1 = label left */
  drawSwitch(th, x, y1, y2, on, name, side) {
    const g = this.g, sc = this.s;
    const ya = y1 + 24, yb = y2 - 24;
    const X = this.X(x);
    g.strokeStyle = th.lineColor;
    g.lineWidth = Math.max(1.2, 1.6 * sc);
    g.beginPath();
    g.moveTo(X, this.Y(y1)); g.lineTo(X, this.Y(ya));
    g.moveTo(X, this.Y(yb)); g.lineTo(X, this.Y(y2));
    g.stroke();
    // lever
    g.strokeStyle = on ? th.field : th.muted;
    g.lineWidth = Math.max(2, 3 * sc);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(X, this.Y(yb));
    if (on) g.lineTo(X, this.Y(ya));
    else g.lineTo(X + side * -1 * 16 * sc, this.Y(ya + 6));
    g.stroke();
    g.lineCap = 'butt';
    g.fillStyle = th.tipBg;
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1.2;
    g.beginPath(); g.arc(X, this.Y(ya), 3, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.arc(X, this.Y(yb), 3, 0, TAU); g.fill(); g.stroke();
    g.font = this.font.uiBold;
    g.fillStyle = on ? th.text : th.muted;
    g.textAlign = side < 0 ? 'right' : 'left';
    g.textBaseline = 'middle';
    const lx = X + side * 12 * sc + side * 4;
    g.fillText(name, lx, this.Y((ya + yb) / 2) - this.fpx(12) * 0.55);
    g.font = this.font.ui;
    g.fillText(on ? 'on' : 'off', lx, this.Y((ya + yb) / 2) + this.fpx(12) * 0.6);
  }

  /** @private resistor zigzag (138–184) and inductor loops (196–262) on the MID line */
  drawCoil(th, lw) {
    const g = this.g, sc = this.s, y = this.Y(MID);
    g.strokeStyle = th.text;
    g.lineWidth = lw;
    g.lineJoin = 'miter';
    g.beginPath();
    g.moveTo(this.X(138), y);
    const n = 6, x0 = 138, x1 = 184, amp = 7 * sc;
    for (let k = 0; k < n; k++) {
      const xa = x0 + (x1 - x0) * (k + 0.5) / n;
      g.lineTo(this.X(xa), y + (k % 2 ? amp : -amp));
    }
    g.lineTo(this.X(x1), y);
    g.stroke();
    // inductor: four half loops
    const lx0 = 196, lx1 = 262, loops = 4, r = (lx1 - lx0) / loops / 2;
    g.beginPath();
    for (let k = 0; k < loops; k++) {
      const cx = this.X(lx0 + r + k * 2 * r);
      g.moveTo(cx - r * sc, y);
      g.arc(cx, y, r * sc, Math.PI, 0);
    }
    g.stroke();
    g.font = this.font.ui;
    g.fillStyle = th.muted;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('R', this.X((x0 + x1) / 2), y - 16 * sc - 4);
    g.fillText('L', this.X((lx0 + lx1) / 2), y - 16 * sc - 4);
  }

  /** @private sense resistor (vertical) and the ground symbol */
  drawSense(th, lw) {
    const g = this.g, sc = this.s, x = this.X(XS);
    const y0 = this.Y(BOT + 10), y1 = this.Y(GND - 12);
    g.strokeStyle = th.text;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(x, y0);
    const n = 6, amp = 6 * sc;
    for (let k = 0; k < n; k++) g.lineTo(x + (k % 2 ? amp : -amp), y0 + (y1 - y0) * (k + 0.5) / n);
    g.lineTo(x, y1);
    g.stroke();
    const yg = this.Y(GND);
    g.beginPath();
    g.moveTo(x - 14 * sc, yg); g.lineTo(x + 14 * sc, yg);
    g.moveTo(x - 9 * sc, yg + 5 * sc); g.lineTo(x + 9 * sc, yg + 5 * sc);
    g.moveTo(x - 4 * sc, yg + 10 * sc); g.lineTo(x + 4 * sc, yg + 10 * sc);
    g.stroke();
  }

  /** @private chevrons spaced along the path, moving with this.flow */
  drawChevrons(th, pts, dir) {
    const g = this.g, sc = this.s;
    let total = 0;
    for (let k = 2; k < pts.length; k += 2) total += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
    const off = ((this.flow % CHEV_SPACING) + CHEV_SPACING) % CHEV_SPACING;
    const size = Math.max(3.5, 5 * sc);
    g.strokeStyle = th.field;
    g.lineWidth = Math.max(1.8, 2.4 * sc);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    let seg = 2, segStart = 0;
    let segLen = Math.hypot(pts[2] - pts[0], pts[3] - pts[1]);
    for (let s = off; s < total; s += CHEV_SPACING) {
      while (s > segStart + segLen && seg < pts.length - 2) {
        segStart += segLen;
        seg += 2;
        segLen = Math.hypot(pts[seg] - pts[seg - 2], pts[seg + 1] - pts[seg - 1]);
      }
      const t = segLen > 0 ? (s - segStart) / segLen : 0;
      const ux = (pts[seg] - pts[seg - 2]) / (segLen || 1), uy = (pts[seg + 1] - pts[seg - 1]) / (segLen || 1);
      const x = this.X(pts[seg - 2] + (pts[seg] - pts[seg - 2]) * t);
      const y = this.Y(pts[seg - 1] + (pts[seg + 1] - pts[seg - 1]) * t);
      const dx = ux * dir, dy = uy * dir;
      g.moveTo(x - dx * size - dy * size, y - dy * size + dx * size);
      g.lineTo(x, y);
      g.lineTo(x - dx * size + dy * size, y - dy * size - dx * size);
    }
    g.stroke();
    g.lineCap = 'butt';
  }

  /** @private target, comparator and chopper logic on the right */
  drawControl(th, m, i, iStar, pwm, state, lw) {
    const g = this.g, sc = this.s;
    // target box (sine table) with a small cosine and a dot at the commanded angle
    const bx = 372, by = 34, bw = 150, bh = 64;
    g.fillStyle = th.tipBg;
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1.2;
    roundRect(g, this.X(bx), this.Y(by), bw * sc, bh * sc, 6);
    g.fill();
    g.stroke();
    g.font = this.font.uiBold;
    g.fillStyle = th.text;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('target', this.X(bx + 8), this.Y(by + 14), bw * sc - 16);
    g.font = this.font.mono;
    g.fillText(this.str.tgt, this.X(bx + 8), this.Y(by + 14) + this.fpx(12) + 3, bw * sc - 16);
    const wx0 = bx + 92, wx1 = bx + bw - 8, wy = by + bh / 2 + 6, wa = 14;
    g.strokeStyle = th.phaseA;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = 0; k <= 24; k++) {
      const a = k / 24 * TAU;
      const px = this.X(wx0 + (wx1 - wx0) * k / 24), py = this.Y(wy - wa * Math.cos(a));
      if (k) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.stroke();
    const th0 = ((num(m.thetaCmd, 0) % TAU) + TAU) % TAU;
    g.fillStyle = th.phaseA;
    g.beginPath();
    g.arc(this.X(wx0 + (wx1 - wx0) * th0 / TAU), this.Y(wy - wa * Math.cos(th0)), 3.5, 0, TAU);
    g.fill();
    // comparator
    const cx0 = 392, cx1 = 446, cyT = 150, cyB = 214, cyM = (cyT + cyB) / 2;
    g.fillStyle = th.tipBg;
    g.strokeStyle = th.text;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(this.X(cx0), this.Y(cyT)); g.lineTo(this.X(cx1), this.Y(cyM)); g.lineTo(this.X(cx0), this.Y(cyB));
    g.closePath();
    g.fill();
    g.stroke();
    g.strokeStyle = th.lineColor;
    g.beginPath();
    // target → − input
    g.moveTo(this.X(bx + 30), this.Y(by + bh)); g.lineTo(this.X(bx + 30), this.Y(cyT + 14)); g.lineTo(this.X(cx0), this.Y(cyT + 14));
    // measured (sense) → + input
    g.moveTo(this.X(360), this.Y(BOT)); g.lineTo(this.X(360), this.Y(cyB - 14)); g.lineTo(this.X(cx0), this.Y(cyB - 14));
    // output → logic
    g.moveTo(this.X(cx1), this.Y(cyM)); g.lineTo(this.X(470), this.Y(cyM)); g.lineTo(this.X(470), this.Y(236));
    g.stroke();
    g.font = this.font.monoBold;
    g.fillStyle = th.text;
    g.textAlign = 'left';
    g.fillText('−', this.X(cx0 + 5), this.Y(cyT + 14));
    g.fillText('+', this.X(cx0 + 5), this.Y(cyB - 14));
    g.font = this.font.ui;
    g.fillStyle = th.muted;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText('measured', this.X(XR + 12), this.Y(BOT) + 5);
    g.textBaseline = 'middle';
    // "over target" output LED
    const over = Math.abs(i) >= Math.abs(iStar) && Math.abs(iStar) > 0.01;
    led(this.g, th, this.X(cx1 + 10), this.Y(cyM) - 12, 4, over, th.warn);
    g.textAlign = 'left';
    g.fillStyle = th.muted;
    g.fillText('over target', this.X(cx1 + 18), this.Y(cyM) - 12);
    // chopper logic box: which switches it closes
    const lx = 392, ly = 236, lw2 = 150, lh = 52;
    g.fillStyle = th.tipBg;
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1.2;
    roundRect(g, this.X(lx), this.Y(ly), lw2 * sc, lh * sc, 6);
    g.fill();
    g.stroke();
    g.font = this.font.uiBold;
    g.fillStyle = th.text;
    g.textAlign = 'left';
    g.fillText('chopper logic', this.X(lx + 8), this.Y(ly + 14), lw2 * sc - 16);
    g.font = this.font.mono;
    g.fillStyle = th.descColor;
    g.fillText(pwm > 0 ? 'S1 + S4 on' : pwm < 0 ? 'S2 + S3 on' : 'S2 + S4 on',
      this.X(lx + 8), this.Y(ly + 14) + this.fpx(12) + 3, lw2 * sc - 16);
  }

  /** @private 10 Hz strings (the state captions for every switch state are built here, picked per frame) */
  formatStrings(snap, m, pr, ph, i, iStar) {
    const s = this.str;
    const V = num(snap.supplyV, 24);
    const name = ['A', 'B', 'C'][ph] || 'A';
    s.vbus = '+' + formatValue(V, 0) + ' V';
    s.i = `i${name} ${signed(i)} A`;
    s.tgt = `i${name}* ${signed(iStar)} A`;
    s.rl = `coil: R ${formatValue(pr.R, 2)} Ω, L ${formatValue(pr.L * 1000, 1)} mH`;
    const e = num(m.bemf && m.bemf[ph], 0);
    s.bemf = Math.abs(e) >= 0.3 ? `back-EMF ${signed(e, 1)} V` : '';
    const vv = formatValue(V, 0);
    s.driveP = `Drive: +${vv} V`;
    s.driveN = `Drive: −${vv} V`;
    s.fastP = `Fast decay: +${vv} V`;
    s.fastN = `Fast decay: −${vv} V`;
    s.slow = 'Slow decay: 0 V';
  }

  /** @returns {string} */
  describe(snap) {
    const m = snap.motors[0];
    if (!m) return '';
    const ph = this.opts.phase | 0;
    const i = num(m.iPhase && m.iPhase[ph], 0), t = num(m.iStar && m.iStar[ph], 0);
    return `H-bridge of one coil: ${this.str.state || 'idle'}. Coil current ${formatValue(i, 2)} A, `
      + `target ${formatValue(t, 2)} A, supply ${formatValue(num(snap.supplyV, 24), 0)} V.`;
  }
}

/** Signed value with a real minus sign ("+1.23", "−0.61"). */
function signed(v, digits = 2) {
  const s = formatValue(v, digits);
  return v > 0 && Number(s.replace('−', '-')) !== 0 ? '+' + s : s;
}
