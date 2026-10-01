/**
 * d/q phasor view (SPEC 4.5; chapter 7).
 *
 * The rotor frame seen from the rotor: the d axis (flux current, horizontal)
 * and the q axis (torque current, up). The actual current vector (id, iq) is a
 * solid amber arrow with its d and q parts drawn along the axes; the target
 * (id*, iq*) is dashed. The circle is the current limit (motor 0's `iLimit`).
 * An inset shows the voltage vector (ud, uq) against the voltage circle
 * (`uMag` of `uLimit`); it turns amber when the drive is at its voltage limit.
 * Its value moves left into free room where it needs to and shortens (the
 * limit without its decimal, then only the voltage) rather than squeeze; in a
 * narrow view the current rows at the top leave out their targets.
 * With two motors in a comparison world (chapter 7's open-loop stepper next to
 * the FOC motor), the second motor's current vector is drawn in the target
 * color with a label.
 * Per frame, vector lengths use Math.sqrt: Math.hypot allocates on every call,
 * even in optimized code.
 *
 * Options:
 *   motor     index of the main motor (default 0)
 *   compare   'auto' (motor 1 when the world has a second, open-loop motor), true, false
 *   voltage   show the voltage inset (default true)
 *   range     'limit' (the circle is the current limit) or a fixed radius in A
 */
import { CanvasView, TAU, arrow, haloText, clamp, num, presetOf, mechanicsOf, textColor, rimColor, fitForm } from './view-util.js';
import { formatValue } from '../format.js';

const SOLID = [];
const DASH = [6, 4];
const DASH_FINE = [3, 3];
const U_FORMS = ['00.0 of 00.0 V', '00.0 of 00 V', '00.0 V'];   // the inset's value at its widest, in each form
const ROW_FORMS = ['iq −0.00 A  (target −0.00)', 'iq −0.00 A'];  // a current row at its widest, with and without the target

export class VectorView extends CanvasView {
  /** Preferred height / width. */
  static aspect = 0.9;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    super(host, opts, { motor: 0, compare: 'auto', voltage: true, range: 'limit' });
    this.lay = {
      cx: 0, cy: 0, R: 0, vx: 0, vy: 0, vr: 0, voltage: false, top: 0, small: false, rowTarget: true, uForm: 0, uX: 0, uRoom: 0,
    };
    this.str = { iq: '', id: '', lim: '', u: '', cmp: '', cmpq: '' };
    this.scaleA = 0;        // A at the circle; 0 = nothing drawn yet: the first frame snaps, later changes ease
  }

  /** @private */
  layout() {
    const L = this.lay, w = this.w, h = this.h;
    // Size, options and font scale set layoutDirty (CanvasView).
    if (!this.layoutDirty) return;
    this.layoutDirty = false;
    this.fresh = true;     // the value forms may change: rebuild the 10 Hz strings this frame
    L.small = w < 230 || h < 200;
    this.g.font = this.font.mono;
    L.rowTarget = fitForm(this.g, ROW_FORMS, w - 28) === 0;    // the rows' targets where they fit (valueRow)
    const line = this.fpx(12) + 5;
    L.top = 6 + line * (L.small ? 1 : 2);
    L.voltage = this.opts.voltage !== false && w >= 180 && h >= 170;
    const vr = L.voltage ? clamp(Math.min(w, h) * 0.12, 20, 48) : 0;
    L.vr = vr;
    // main diagram: room above for the values and the q label, right for the d label
    const top = L.top + line, bottom = 6, left = 8, right = L.small ? 18 : this.fpx(12) * 4.6;
    let R = Math.max(20, Math.min((w - left - right) / 2, (h - top - bottom) / 2) * 0.96);
    let cx = left + (w - left - right) / 2, cy = top + (h - top - bottom) / 2;
    if (L.voltage) {
      // voltage inset in the bottom-right corner; move the circle up and left into any
      // slack first, then shrink it
      L.vx = w - vr - 8;
      L.vy = h - vr - line - 4;
      const need = R + vr + 8;
      let dist = Math.hypot(L.vx - cx, L.vy - cy);
      if (dist < need) {
        const slackX = cx - left - R, slackY = cy - top - R;
        const ux = (cx - L.vx) / (dist || 1), uy = (cy - L.vy) / (dist || 1);
        const move = need - dist;
        cx += clamp(ux * move, -slackX, slackX);
        cy += clamp(uy * move, -slackY, slackY);
        dist = Math.hypot(L.vx - cx, L.vy - cy);
        if (dist < need) R = Math.max(20, dist - vr - 8);
      }
      // The value under the inset: centered on it, else moved left as far as the main circle (and
      // its axes, 1.04 R) leaves room on that row, in the longest form that fits (F-73).
      const g = this.g, ty0 = L.vy + vr + 4, ty1 = ty0 + this.fpx(12);
      const dy = ty0 > cy ? ty0 - cy : ty1 < cy ? cy - ty1 : 0;
      const x0 = dy >= R * 1.04 ? 4 : cx + (dy < R ? Math.sqrt(R * R - dy * dy) : 0) + 4;
      L.uRoom = w - 4 - x0;
      g.font = this.font.mono;
      const k = fitForm(g, U_FORMS, L.uRoom);
      L.uForm = k < 0 ? U_FORMS.length - 1 : k;
      const tw = Math.min(g.measureText(U_FORMS[L.uForm]).width, L.uRoom);
      L.uX = clamp(L.vx, x0 + tw / 2, w - 4 - tw / 2);
    }
    L.cx = cx;
    L.cy = cy;
    L.R = R;
  }

  draw(snap, ctx) {
    const idx = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[idx];
    if (!m) return;
    this.layout();
    const g = this.g, th = ctx.theme, L = this.lay;
    const pr = presetOf(snap, idx);
    const lim = num(m.iLimit, 0) > 0 ? m.iLimit : pr.Irated;
    // the comparison motor: a second motor with an open-loop driver in a 'free' world
    let cm = null;
    const cOpt = this.opts.compare;
    if (cOpt !== false && snap.motors.length > 1) {
      const other = snap.motors[idx === 0 ? 1 : 0];
      if (cOpt === true || (mechanicsOf(snap) !== 'corexy' && other.driver !== m.driver)) cm = other;
    }
    // scale: the circle is the current limit unless the comparison motor needs more room
    let scaleA = typeof this.opts.range === 'number' && this.opts.range > 0 ? this.opts.range : lim;
    if (cm) {
      const cid = num(cm.id, 0), ciq = num(cm.iq, 0);
      const cmAmp = Math.sqrt(cid * cid + ciq * ciq);
      const cmLim = num(cm.iLimit, 0);
      scaleA = Math.max(scaleA, cmLim, cmAmp);
    }
    // ease scale changes so the picture does not jump
    this.scaleA += (scaleA - this.scaleA) * (this.scaleA > 0 ? 0.2 : 1);
    if (!(this.scaleA > 0)) this.scaleA = scaleA;
    const k = L.R / this.scaleA;               // px per A
    const cx = L.cx, cy = L.cy;
    if (this.fresh) this.formatStrings(m, cm, lim);

    // axes
    const R = L.R;
    g.lineWidth = 1.5;
    g.strokeStyle = th.axisD;
    g.beginPath(); g.moveTo(cx - R * 1.04, cy); g.lineTo(cx + R * 1.04, cy); g.stroke();
    g.strokeStyle = th.axisQ;
    g.beginPath(); g.moveTo(cx, cy + R * 1.04); g.lineTo(cx, cy - R * 1.04); g.stroke();
    g.font = this.font.uiBold;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = textColor(th, th.axisD);
    haloText(g, L.small ? 'd' : 'd flux', cx + R * 1.04 + 4, cy, th.tipBg);
    g.textAlign = 'center';
    g.fillStyle = textColor(th, th.axisQ);
    haloText(g, L.small ? 'q' : 'q torque', cx, cy - R * 1.04 - this.fpx(12) * 0.65, th.tipBg);

    // current-limit circle
    const rl = lim * k;
    g.strokeStyle = th.muted;
    g.lineWidth = 1;
    g.setLineDash(DASH_FINE);
    g.beginPath(); g.arc(cx, cy, rl, 0, TAU); g.stroke();
    g.setLineDash(SOLID);
    if (!L.small) {
      // lower left of the circle, clear of the q axis and the voltage inset
      g.font = this.font.mono;
      g.fillStyle = th.muted;
      g.textAlign = 'right';
      g.textBaseline = 'top';
      const a = Math.PI * 0.78;
      haloText(g, this.str.lim, Math.max(cx + rl * Math.cos(a) - 2, g.measureText(this.str.lim).width + 6),
        cy + rl * Math.sin(a) + 2, th.tipBg);
    }

    // comparison motor (open loop): its whole current vector, drawn in the target color
    if (cm) {
      const x1 = cx + num(cm.id, 0) * k, y1 = cy - num(cm.iq, 0) * k;
      g.strokeStyle = th.target;
      g.fillStyle = th.target;
      g.lineWidth = 2.5;
      g.lineCap = 'round';
      arrow(g, cx, cy, x1, y1, 10);
      g.lineCap = 'butt';
      g.font = this.font.ui;
      g.fillStyle = th.text;
      // Above the tip (clear of the d-axis label, which sits on the axis), kept inside the view.
      const tw = g.measureText(this.str.cmp).width;
      let lx = x1 + (x1 >= cx ? 4 : -4), align = x1 >= cx ? 'left' : 'right';
      if (align === 'left' && lx + tw > this.w - 4) { lx = this.w - 4; align = 'right'; }
      if (align === 'right' && lx - tw < 4) { lx = 4; align = 'left'; }
      g.textAlign = align;
      g.textBaseline = 'bottom';
      haloText(g, this.str.cmp, lx, y1 - 5, th.tipBg);
    }

    // target (dashed)
    const ids = num(m.idStar, 0), iqs = num(m.iqStar, 0);
    if (Math.sqrt(ids * ids + iqs * iqs) * k > 3) {
      g.strokeStyle = th.target;
      g.fillStyle = th.target;
      g.lineWidth = 2;
      g.setLineDash(DASH);
      arrow(g, cx, cy, cx + ids * k, cy - iqs * k, 9);
      g.setLineDash(SOLID);
    }

    // actual current: d and q parts along the axes, then the vector
    const id = num(m.id, 0), iq = num(m.iq, 0);
    const xd = cx + id * k, yq = cy - iq * k;
    g.lineCap = 'round';
    g.lineWidth = 5;
    g.strokeStyle = th.axisD;
    g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(xd, cy); g.stroke();
    g.strokeStyle = th.axisQ;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, yq); g.stroke();
    g.globalAlpha = 1;
    g.setLineDash(DASH_FINE);
    g.lineWidth = 1;
    g.strokeStyle = th.muted;
    g.beginPath();
    g.moveTo(xd, yq); g.lineTo(xd, cy);
    g.moveTo(xd, yq); g.lineTo(cx, yq);
    g.stroke();
    g.setLineDash(SOLID);
    if (Math.sqrt(id * id + iq * iq) * k > 2) {
      g.strokeStyle = rimColor(th);
      g.fillStyle = rimColor(th);
      g.lineWidth = th.dark ? 6 : 5;
      arrow(g, cx, cy, xd, yq, 13);
      g.strokeStyle = th.field;
      g.fillStyle = th.field;
      g.lineWidth = 3;
      arrow(g, cx, cy, xd, yq, 11);
    }
    g.lineCap = 'butt';
    g.fillStyle = th.text;
    g.beginPath(); g.arc(cx, cy, 2.5, 0, TAU); g.fill();

    // values at the top left
    g.font = this.font.mono;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const line = this.fpx(12) + 5;
    let y = 6 + line / 2;
    this.valueRow(th, 8, y, th.axisQ, this.str.iq);
    if (!L.small) { y += line; this.valueRow(th, 8, y, th.axisD, this.str.id); }

    if (L.voltage) this.drawVoltage(th, m);
  }

  /** @private colored dot and a value line */
  valueRow(th, x, y, color, text) {
    const g = this.g;
    g.fillStyle = color;
    g.beginPath(); g.arc(x + 4, y, 3.5, 0, TAU); g.fill();
    g.fillStyle = th.text;
    g.fillText(text, x + 13, y, this.w - x - 20);
  }

  /** @private voltage vector against the voltage circle */
  drawVoltage(th, m) {
    const g = this.g, L = this.lay;
    const x = L.vx, y = L.vy, r = L.vr;
    const uLim = num(m.uLimit, 0);
    const uMag = num(m.uMag, 0);
    const frac = uLim > 0 ? uMag / uLim : 0;
    const full = frac >= 0.97;
    g.beginPath(); g.arc(x, y, r, 0, TAU);
    g.fillStyle = th.tipBg;
    g.fill();
    g.strokeStyle = full ? th.warn : th.muted;
    g.lineWidth = full ? 2.5 : 1.2;
    g.stroke();
    g.strokeStyle = th.divider;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y); g.moveTo(x, y + r); g.lineTo(x, y - r); g.stroke();
    // direction from (ud, uq), length from uMag / uLimit (open loop reports the larger phase voltage)
    const ud = num(m.ud, 0), uq = num(m.uq, 0);
    const n = Math.sqrt(ud * ud + uq * uq);
    if (n > 1e-6 && frac > 0.01) {
      const len = Math.min(1.05, frac) * r;
      g.strokeStyle = th.text;
      g.fillStyle = th.text;
      g.lineWidth = 2;
      arrow(g, x, y, x + (ud / n) * len, y - (uq / n) * len, 8);
    }
    g.font = this.font.ui;
    g.fillStyle = th.muted;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('voltage', x, y - r - 3);
    g.font = this.font.mono;
    g.fillStyle = full ? th.text : th.descColor;
    g.textBaseline = 'top';
    g.fillText(this.str.u, L.uX, y + r + 4, L.uRoom);
  }

  /** @private 10 Hz strings */
  formatStrings(m, cm, lim) {
    const s = this.str;
    const tg = this.lay.rowTarget;
    s.iq = `iq ${formatValue(num(m.iq, 0), 2)} A` + (tg ? `  (target ${formatValue(num(m.iqStar, 0), 2)})` : '');
    s.id = `id ${formatValue(num(m.id, 0), 2)} A` + (tg ? `  (target ${formatValue(num(m.idStar, 0), 2)})` : '');
    s.lim = `limit ${formatValue(lim, 2)} A`;
    const f = this.lay.uForm, u = formatValue(num(m.uMag, 0), 1);
    s.u = f === 2 ? `${u} V` : `${u} of ${formatValue(num(m.uLimit, 0), f === 0 ? 1 : 0)} V`;
    if (cm) {
      const a = Math.hypot(num(cm.id, 0), num(cm.iq, 0));
      s.cmp = `open loop ${formatValue(a, 2)} A`;
    }
  }

  /** @returns {string} */
  describe(snap) {
    const idx = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[idx];
    if (!m) return '';
    let s = `Rotor-frame currents: torque current ${formatValue(num(m.iq, 0), 2)} A (target ${formatValue(num(m.iqStar, 0), 2)} A), `
      + `flux current ${formatValue(num(m.id, 0), 2)} A, current limit ${formatValue(num(m.iLimit, 0), 2)} A; `
      + `voltage ${formatValue(num(m.uMag, 0), 1)} of ${formatValue(num(m.uLimit, 0), 1)} V`;
    const other = snap.motors[idx === 0 ? 1 : 0];
    if (other && mechanicsOf(snap) !== 'corexy' && other.driver !== m.driver) {
      s += `. Open-loop motor: ${formatValue(Math.hypot(num(other.id, 0), num(other.iq, 0)), 2)} A, `
        + `of which ${formatValue(num(other.iq, 0), 2)} A makes torque`;
    }
    return s + '.';
  }
}
