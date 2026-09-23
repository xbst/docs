/**
 * Block diagram of the FOC driver (SPEC 4.5; chapters 7, 8 and 9), drawn as
 * SVG in the view host. Element positions are rebuilt on resize, theme and
 * option changes; each frame only changes text and a few attributes, and the
 * numbers update at most 10 times per second.
 *
 * Full mode (chapter 8): the cascade from top to bottom, position loop →
 * velocity loop → current loops (torque Iq and flux Id) → inverse Park and
 * PWM → motor, with the targets on the arrows between them, the encoder and
 * current-sensor feedback on the right (filters marked), LEDs on the
 * torque-current limit and the voltage limit, and the status output line.
 * Loops that the driver mode does not use are dimmed ("off").
 *
 * Compact mode: one chain of boxes, laid out as a row in a wide host (the
 * stage strip) and as a column in a tall one.
 *   chain 'foc'   (chapter 7): measure → Park → PI loops → inverse Park → PWM
 *   chain 'limit' (chapter 9): velocity loop → current limit → limit flag →
 *                 status output → controller (endstop)
 *
 * `ctx.highlight` lights one part: 'position', 'velocity', 'torque', 'flux'
 * ('current' lights both current loops), 'velocityFilter', 'torqueFilter',
 * 'fluxFilter' ('filters' lights all three), 'limit', 'status'. The 'limit'
 * chain highlights 'limit' when nothing else is set. Product captions (flag
 * and status pin names) come from `ctx.product.keys` when present.
 *
 * Options:
 *   compact   false (full) or true (chain)
 *   chain     'auto' (chapter 9 → 'limit', else 'foc'), 'foc' or 'limit'
 *   motor     which motor's loops to show (default 0; CoreXY: 0 = A)
 *   filters   { torque, flux, velocity } multipliers of the optimal cutoffs; when set,
 *             the filter tooltips show the cutoff in Hz
 */
import { TUNING } from '../sim/drivers/foc.js';
import { formatValue } from '../format.js';
import { mmPerRad, mechanicsOf, num, clamp } from './view-util.js';

const NS = 'http://www.w3.org/2000/svg';
const ARIA_MS = 1000;
const FRESH_MS = 100;
const DEG = 180 / Math.PI;

/** Create an SVG element with attributes, appended to `parent` when given. */
function mk(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.append(e);
  return e;
}

export class BlockDiagram {
  /** Preferred height / width (the full cascade is a tall column). */
  static aspect = 1.05;

  /**
   * @param {HTMLElement} host
   * @param {Object} [opts]
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = Object.assign({ compact: false, chain: 'auto', motor: 0, filters: null }, opts);
    this.svg = mk('svg', { 'aria-hidden': 'true' });
    host.append(this.svg);
    this.w = 0;
    this.h = 0;
    this.fs = 1;
    this.theme = null;
    this.built = '';
    this.hl = undefined;
    this.fmtAt = -Infinity;
    this.ariaAt = -Infinity;
    this.ariaText = '';
    this.parts = {};      // id → { rect, sub: [rects], dim }
    this.texts = {};      // id → text element (value strings)
    this.leds = {};       // id → circle
    this.chips = {};      // id → { rect, title }
    this.styled = [];     // [element, role] for theme colors
    this.chainName = 'foc';
  }

  resize(cssW, cssH) {
    this.w = cssW;
    this.h = cssH;
    this.built = '';      // build() sets the viewBox
  }

  setOptions(opts) {
    if (!opts) return;
    Object.assign(this.opts, opts);
    this.built = '';
  }

  destroy() {
    this.svg.remove();
  }

  /**
   * @param {Object} snap
   * @param {Object} ctx render ctx
   */
  render(snap, ctx) {
    if (this.w < 40 || this.h < 30 || !snap) return;
    const th = ctx.theme;
    const chain = this.opts.chain === 'foc' || this.opts.chain === 'limit' ? this.opts.chain
      : (ctx.chapterId === 'sensorless-foc' ? 'limit' : 'foc');
    const fs = th.fontScale || 1;
    const product = ctx.product || null;
    const key = `${this.w}|${this.h}|${fs}|${this.opts.compact}|${chain}|${product ? product.key : ''}`;
    if (key !== this.built) {
      this.fs = fs;
      this.chainName = chain;
      this.product = product;
      this.build();
      this.built = key;
      this.theme = null;
      this.hl = undefined;
      this.fmtAt = -Infinity;
    }
    if (th !== this.theme) {
      this.theme = th;
      this.applyTheme(th);
      this.hl = undefined;
    }
    let hl = ctx.highlight == null ? null : String(ctx.highlight);
    if (hl == null && this.opts.compact && chain === 'limit') hl = 'limit';
    if (hl !== this.hl) {
      this.hl = hl;
      this.applyHighlight(th, hl);
    }
    const now = performance.now();
    if (now - this.fmtAt >= FRESH_MS) {
      this.fmtAt = now;
      this.update(snap, th);
    }
    if (now - this.ariaAt >= ARIA_MS) {
      this.ariaAt = now;
      const text = this.describe(snap);
      if (text && text !== this.ariaText) {
        this.ariaText = text;
        this.host.setAttribute('aria-label', text);
      }
    }
  }

  /* ---------------- building ---------------- */

  /** @private font px */
  fpx(px) {
    return Math.round(px * this.fs);
  }

  /** @private */
  build() {
    this.svg.replaceChildren();
    this.parts = {};
    this.texts = {};
    this.leds = {};
    this.chips = {};
    this.styled = [];
    this.bar = null;
    this.defs = mk('defs', null, this.svg);
    this.marker = mk('marker', {
      id: 'bd-arrow-' + Math.random().toString(36).slice(2, 8), viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    }, this.defs);
    this.markerPath = mk('path', { d: 'M0,0 L10,5 L0,10 z' }, this.marker);
    this.markerUrl = `url(#${this.marker.id})`;
    // Lay out in css px (viewBox = host size). When the host is smaller than the layout's
    // minimum, lay out at the minimum and let the viewBox scale the drawing down uniformly.
    const need = this.minSize();
    const scale = Math.min(1, this.w / need.w, this.h / need.h);
    this.vw = this.w / scale;
    this.vh = this.h / scale;
    this.svg.setAttribute('viewBox', `0 0 ${this.vw.toFixed(1)} ${this.vh.toFixed(1)}`);
    if (!this.opts.compact) this.buildFull();
    else this.buildChain(this.chainName === 'limit' ? this.limitNodes() : this.focNodes());
  }

  /** @private smallest size (css px) at which the current mode's layout does not overlap */
  minSize() {
    const f = this.fpx(12);
    if (!this.opts.compact) {
      const lh = f + 4;
      return { w: 180, h: 12 + (lh * 2 + 4) * 4 + (lh * 4 + 6) + lh + 5 * 8 };
    }
    const lh = f + 3, n = 5;
    if (this.w >= this.h * 2.2) return { w: n * 64, h: lh * 2 + 18 + (this.chainName === 'foc' ? 14 : 0) };
    return { w: 150, h: n * (lh * 2 + 6) + (n - 1) * 12 + 10 };
  }

  /** @private register an element for a theme role */
  style(el, role) {
    this.styled.push([el, role]);
    return el;
  }

  /** @private text element */
  text(parent, x, y, str, role, opts) {
    const o = opts || {};
    const t = mk('text', {
      x, y, 'font-size': this.fpx(o.size || 12), 'font-weight': o.weight || 400,
      'text-anchor': o.anchor || 'start', 'dominant-baseline': 'central',
    }, parent);
    t.dataset.font = o.mono ? 'mono' : 'ui';
    t.textContent = str;
    this.style(t, role || 'text');
    return t;
  }

  /** @private arrow line (with the shared marker) */
  arrowLine(parent, x1, y1, x2, y2, role) {
    const l = mk('line', { x1, y1, x2, y2, 'stroke-width': 1.5, 'marker-end': this.markerUrl }, parent);
    this.style(l, role || 'line');
    return l;
  }

  /** @private polyline with an arrow at the end */
  arrowPath(parent, pts, role) {
    const p = mk('polyline', { points: pts.join(' '), fill: 'none', 'stroke-width': 1.5, 'marker-end': this.markerUrl }, parent);
    this.style(p, role || 'line');
    return p;
  }

  /** @private box */
  box(parent, id, x, y, w, h) {
    const r = mk('rect', { x, y, width: w, height: h, rx: 6, 'stroke-width': 1.2 }, parent);
    this.parts[id] = { rect: r, dim: false };
    return r;
  }

  /** @private LED */
  led(parent, id, x, y, r) {
    const c = mk('circle', { cx: x, cy: y, r, 'stroke-width': 1 }, parent);
    this.leds[id] = { el: c, on: null };
    return c;
  }

  /**
   * @private full cascade, top to bottom. Every block has its name on the first line and its
   * live numbers on the second ("target → actual"), so the arrows between them need no labels.
   */
  buildFull() {
    const s = this.svg, w = this.vw, h = this.vh;
    const f = this.fpx(12);
    const pad = 6;
    const lane = Math.max(10, Math.round(f * 0.85));
    const xO = w - pad - 2;            // encoder lane
    const xI = xO - lane;              // current-sensor lane
    const chipW = Math.max(38, Math.round(f * 3.3));
    const bx = pad, bR = Math.max(bx + 110, xI - chipW - 8), bw = bR - bx;
    const lh = f + 4;
    const b2 = lh * 2 + 4, bc = lh * 4 + 6, b1 = lh * 2 + 4;
    const fixed = b2 * 3 + bc + b1 + lh;                   // P, V, PWM, current block, motor, status row
    let ag = (h - pad * 2 - fixed - lh) / 5;               // with the input label
    const showInput = ag >= 10;
    if (!showInput) ag = (h - pad * 2 - fixed) / 5;
    ag = clamp(ag, 8, 26);
    const total = (showInput ? lh : 0) + fixed + ag * 5;
    let y = pad + Math.max(0, (h - pad * 2 - total) / 2);
    const ax = bx + Math.min(24, bw * 0.14);               // x of the down arrows
    const tx = bx + 8, vx = bx + 8;                        // name and value x
    const line1 = (y0) => y0 + 3 + lh / 2, line2 = (y0) => y0 + 3 + lh * 1.5;
    // input
    if (showInput) {
      this.text(s, ax + 8, y + lh / 2, w >= 280 ? 'position target (from STEP/DIR)' : 'position target', 'muted');
      y += lh;
    }
    this.arrowLine(s, ax, y - (showInput ? lh * 0.5 : 0), ax, y + ag);
    y += ag;
    // position loop
    const yP = y;
    this.box(s, 'position', bx, yP, bw, b2);
    this.text(s, tx, line1(yP), 'Position loop', 'text', { weight: 500 });
    this.texts.pos = this.text(s, vx, line2(yP), '', 'value', { mono: true });
    y = yP + b2;
    this.arrowLine(s, ax, y, ax, y + ag);
    y += ag;
    // velocity loop
    const yV = y;
    this.box(s, 'velocity', bx, yV, bw, b2);
    this.text(s, tx, line1(yV), 'Velocity loop', 'text', { weight: 500 });
    this.texts.w = this.text(s, vx, line2(yV), '', 'value', { mono: true });
    y = yV + b2;
    this.arrowLine(s, ax, y, ax, y + ag);
    y += ag;
    // current loops: torque (Iq) and flux (Id), each with a name and a value line
    const yC = y;
    this.box(s, 'current', bx, yC, bw, bc);
    const half = (bc - 6) / 2;
    const sub1 = mk('rect', { x: bx + 3, y: yC + 3, width: bw - 6, height: half, rx: 4 }, s);
    const sub2 = mk('rect', { x: bx + 3, y: yC + 3 + half, width: bw - 6, height: half, rx: 4 }, s);
    this.parts.torque = { rect: sub1, dim: false, sub: true };
    this.parts.flux = { rect: sub2, dim: false, sub: true };
    this.text(s, tx, line1(yC), 'Torque loop (Iq)', 'text', { weight: 500 });
    this.texts.iq = this.text(s, vx, line2(yC), '', 'value', { mono: true });
    this.led(s, 'iqLimit', bR - 10, line1(yC), 4.5);
    this.ledTitle(this.leds.iqLimit.el, 'Torque-current limit reached: the velocity loop asks for more than the limit');
    this.text(s, tx, line1(yC + half), 'Flux loop (Id)', 'text', { weight: 500 });
    this.texts.id = this.text(s, vx, line2(yC + half), '', 'value', { mono: true });
    y = yC + bc;
    this.arrowLine(s, ax, y, ax, y + ag);
    y += ag;
    // inverse Park + PWM
    const yW = y;
    this.box(s, 'pwm', bx, yW, bw, b2);
    this.text(s, tx, line1(yW), 'Inverse Park, PWM', 'text', { weight: 500 });
    this.texts.u = this.text(s, vx, line2(yW), '', 'value', { mono: true });
    this.led(s, 'uLimit', bR - 10, line1(yW), 4.5);
    this.ledTitle(this.leds.uLimit.el, 'Voltage limit reached: the current loops ask for more voltage than the supply gives');
    y = yW + b2;
    this.arrowLine(s, ax, y, ax, y + ag);
    y += ag;
    // motor
    const yM = y;
    const mw = Math.min(bw, Math.max(64, bw * 0.36));
    this.box(s, 'motor', bx, yM, mw, b1);
    this.text(s, tx, yM + b1 / 2, 'Motor', 'text', { weight: 500 });
    y = yM + b1;
    // status output
    const yS = y + lh / 2 + 2;
    this.led(s, 'status', bx + 9, yS, 4.5);
    this.text(s, bx + 20, yS, 'status output', 'muted');
    const cap = this.product && this.product.keys && this.product.keys.statusPin;
    if (cap && w >= 240) this.text(s, bx + 20 + f * 7.6, yS, cap, 'muted', { mono: true });

    // feedback: the encoder lane to the position and velocity loops, the current lane to the
    // current loops; filters sit on the speed and current feedback
    const mR = bx + mw;
    const yEnc = yM + b1 * 0.27, yCur = yM + b1 * 0.73;
    const chipX = bR + 4;
    const tapP = line1(yP), tapV = line1(yV) + lh * 0.5, tapC = yC + bc / 2;
    this.arrowPath(s, [mR, yEnc, xO, yEnc, xO, tapP, bR, tapP]);
    this.arrowPath(s, [xO, tapV, chipX + chipW, tapV]);
    this.arrowLine(s, chipX, tapV, bR, tapV);
    this.arrowPath(s, [mR, yCur, xI, yCur, xI, tapC, chipX + chipW, tapC]);
    this.arrowLine(s, chipX, tapC, bR, tapC);
    this.chip(s, 'velocityFilter', chipX, tapV, chipW, 'filter');
    this.chip(s, 'currentFilter', chipX, tapC, chipW, 'filters');
    // lane labels on the motor's two feedback lines
    const segW = xI - mR;
    if (segW > f * 4.4) {
      const cx = mR + segW / 2, bw2 = f * 4.2;
      this.bgBehind(s, this.text(s, cx, yEnc, 'encoder', 'muted', { anchor: 'middle' }), cx, yEnc, bw2, lh - 2);
      this.bgBehind(s, this.text(s, cx, yCur, 'currents', 'muted', { anchor: 'middle' }), cx, yCur, bw2, lh - 2);
    }
  }

  /** @private tooltip on an element */
  ledTitle(el, str) {
    const t = mk('title', null, el);
    t.textContent = str;
  }

  /** @private filter chip on a feedback path */
  chip(parent, id, x, yc, w, label) {
    const h = this.fpx(12) + 6;
    const r = mk('rect', { x, y: yc - h / 2, width: w, height: h, rx: h / 2, 'stroke-width': 1.2 }, parent);
    const t = this.text(parent, x + w / 2, yc, label, 'text', { anchor: 'middle' });
    const title = mk('title', null, r);
    this.chips[id] = { rect: r, text: t, title };
    return r;
  }

  /* ---------------- compact chains ---------------- */

  /** @private chapter 7: one control cycle */
  focNodes() {
    return [
      { id: 'measure', title: 'Measure', v1: 'angle', v2: 'currents' },
      { id: 'park', title: 'Park', v1: 'Iq', v2: 'Id' },
      { id: 'current', title: 'PI loops', v1: 'Iq →', v2: 'Id → 0' },
      { id: 'ipark', title: 'Inverse Park', v1: 'uq', v2: 'ud' },
      { id: 'pwm', title: 'PWM', v1: 'voltage', v2: '' },
    ];
  }

  /** @private chapter 9: stall detection by the current limit */
  limitNodes() {
    const keys = (this.product && this.product.keys) || {};
    return [
      { id: 'velocity', title: 'Velocity loop', v1: 'speed', v2: '' },
      { id: 'limit', title: 'Current limit', v1: 'Iq', v2: '', bar: true },
      { id: 'flag', title: 'Limit flag', v1: '', v2: keys.flag || '', led: 'flag', capMono: !!keys.flag },
      { id: 'status', title: 'Status output', v1: '', v2: keys.statusPin || '', led: 'status', capMono: !!keys.statusPin },
      { id: 'ctrl', title: 'Controller', v1: 'endstop', v2: '' },
    ];
  }

  /** @private lay out a chain as a row (wide host) or a column */
  buildChain(nodes) {
    const s = this.svg, w = this.vw, h = this.vh;
    const f = this.fpx(12);
    const lh = f + 3;
    const n = nodes.length;
    const row = w >= h * 2.2;
    const pad = 5;
    const lines = 3;
    if (row) {
      const gap = Math.max(12, f);
      const bw = (w - pad * 2 - gap * (n - 1)) / n;
      const bh = Math.min(h - pad * 2 - (this.chainName === 'foc' ? 14 : 0), lh * lines + 8);
      const y0 = pad + Math.max(0, (h - pad * 2 - bh - (this.chainName === 'foc' ? 14 : 0)) / 2);
      for (let i = 0; i < n; i++) {
        const x = pad + i * (bw + gap);
        this.chainNode(s, nodes[i], x, y0, bw, bh, lh);
        if (i < n - 1) this.arrowLine(s, x + bw + 1, y0 + bh / 2, x + bw + gap - 1, y0 + bh / 2);
      }
      if (this.chainName === 'foc') {
        // back to the start: the motor turns and the sensors measure again
        const yb = y0 + bh + 9;
        const xl = pad + bw / 2, xr = pad + (n - 1) * (bw + gap) + bw / 2;
        this.arrowPath(s, [xr, y0 + bh, xr, yb, xl, yb, xl, y0 + bh + 1], 'muted');
        const lab = this.text(s, (xl + xr) / 2, yb, 'motor turns, sensors measure again', 'muted', { anchor: 'middle' });
        this.bgBehind(s, lab, (xl + xr) / 2, yb, f * 17, lh);
      }
    } else {
      const gap = Math.max(12, f * 1.1);
      const bh = Math.min((h - pad * 2 - gap * (n - 1)) / n, lh * lines + 8);
      const total = bh * n + gap * (n - 1);
      const y0 = pad + Math.max(0, (h - pad * 2 - total) / 2);
      const bw = Math.min(w - pad * 2, 260);
      const x = (w - bw) / 2;
      for (let i = 0; i < n; i++) {
        const y = y0 + i * (bh + gap);
        this.chainNode(s, nodes[i], x, y, bw, bh, lh);
        if (i < n - 1) this.arrowLine(s, x + bw / 2, y + bh + 1, x + bw / 2, y + bh + gap - 1);
      }
    }
  }

  /** @private background patch behind a label (`label`) that sits on a line */
  bgBehind(parent, label, cx, cy, w, h) {
    const r = mk('rect', { x: cx - w / 2, y: cy - h / 2, width: w, height: h });
    this.style(r, 'bg');
    parent.insertBefore(r, label);
  }

  /** @private one chain box: title, one or two value lines, optional LED or bar */
  chainNode(s, node, x, y, bw, bh, lh) {
    this.box(s, node.id, x, y, bw, bh);
    const three = bh >= lh * 3 + 4;
    const ty = three ? y + 4 + lh / 2 : y + bh / 2 - lh / 2;
    const hasLed = !!node.led;
    this.text(s, x + 7 + (hasLed ? 13 : 0), ty, node.title, 'text', { weight: 500 });
    if (hasLed) this.led(s, node.led, x + 12, ty, 4.5);
    const v1y = three ? ty + lh : ty + lh;
    this.texts[node.id + '1'] = this.text(s, x + 7, v1y, node.v1, 'value', { mono: true });
    if (three) {
      const t2 = this.text(s, x + 7, v1y + lh, node.v2, node.capMono ? 'muted' : 'value', { mono: true });
      this.texts[node.id + '2'] = t2;
    }
    if (node.bar) {
      const by = three ? v1y + lh - 4 : y + bh - 7;
      const track = mk('rect', { x: x + 7, y: by, width: bw - 14, height: 6, rx: 3 }, s);
      this.style(track, 'track');
      const fill = mk('rect', { x: x + 7, y: by, width: 0, height: 6, rx: 3 }, s);
      this.bar = { el: fill, w: bw - 14, x: x + 7, last: -1 };
    }
  }

  /* ---------------- theme and highlight ---------------- */

  /** @private */
  applyTheme(th) {
    const mono = th.fontMono, ui = th.fontUi;
    for (const [el, role] of this.styled) {
      switch (role) {
        case 'text': el.setAttribute('fill', th.text); break;
        case 'value': el.setAttribute('fill', th.text); break;
        case 'muted': el.setAttribute('fill', el.tagName === 'text' ? th.muted : 'none');
          if (el.tagName !== 'text') el.setAttribute('stroke', th.muted);
          break;
        case 'line': el.setAttribute('stroke', th.lineColor); break;
        case 'bg': el.setAttribute('fill', th.tipBg); break;
        case 'track': el.setAttribute('fill', th.divider); break;
        default: break;
      }
      if (el.tagName === 'text') el.setAttribute('font-family', el.dataset.font === 'mono' ? mono : ui);
    }
    this.markerPath.setAttribute('fill', th.lineColor);
    for (const id of Object.keys(this.chips)) {
      const c = this.chips[id];
      c.rect.setAttribute('fill', th.tipBg);
      c.rect.setAttribute('stroke', th.lineColor);
    }
    if (this.bar) this.bar.el.setAttribute('fill', th.axisQ);
    for (const id of Object.keys(this.leds)) this.leds[id].on = null;
  }

  /** @private box colors: highlighted (amber), normal, or dimmed */
  applyHighlight(th, hl) {
    const lit = (id) => {
      if (!hl) return false;
      if (hl === id) return true;
      if (hl === 'current' && (id === 'torque' || id === 'flux' || id === 'current')) return true;
      if ((hl === 'torque' || hl === 'flux') && id === 'current' && this.opts.compact) return true;
      return false;
    };
    for (const id of Object.keys(this.parts)) {
      const p = this.parts[id];
      const on = lit(id);
      if (p.sub) {
        p.rect.setAttribute('fill', on ? th.hsActive : 'none');
        p.rect.setAttribute('stroke', on ? th.hsStroke : 'none');
      } else {
        p.rect.setAttribute('fill', on ? th.hsActive : th.tipBg);
        p.rect.setAttribute('stroke', on ? th.hsStroke : th.tipBorder);
        p.rect.setAttribute('stroke-width', on ? 2 : 1.2);
      }
    }
    const filt = (id) => hl === 'filters' || hl === id
      || (id === 'currentFilter' && (hl === 'torqueFilter' || hl === 'fluxFilter'));
    for (const id of Object.keys(this.chips)) {
      const c = this.chips[id];
      const on = filt(id);
      c.rect.setAttribute('fill', on ? th.hsActive : th.tipBg);
      c.rect.setAttribute('stroke', on ? th.hsStroke : th.lineColor);
    }
  }

  /* ---------------- live values ---------------- */

  /** @private set a text element's content when it changed */
  set(id, str) {
    const t = this.texts[id];
    if (t && t.textContent !== str) t.textContent = str;
  }

  /** @private LED on/off (red = a flag, the chip's convention) */
  setLed(id, on, th) {
    const l = this.leds[id];
    if (!l || l.on === on) return;
    l.on = on;
    l.el.setAttribute('fill', on ? th.ledTrip : th.ledOff);
    l.el.setAttribute('stroke', on ? th.ledTrip : th.lineColor);
  }

  /** @private dim a box whose loop is not running in this driver mode */
  setDim(id, dim) {
    const p = this.parts[id];
    if (!p || p.dim === dim) return;
    p.dim = dim;
    p.rect.setAttribute('opacity', dim ? 0.45 : 1);
  }

  /** @private 10 Hz update of the numbers, LEDs and dimming */
  update(snap, th) {
    const idx = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[idx];
    if (!m) return;
    const k = mmPerRad(snap);
    const foc = m.driver === 'foc';
    const mode = m.mode || snap.driverMode || 'position';
    const fl = m.flags || {};
    const iqLim = !!fl.iqTargetLimit;
    const uLim = !!(fl.uqOutputLimit || fl.udOutputLimit);
    const status = !!m.status;
    if (!this.opts.compact) {
      const posOn = foc && mode === 'position', velOn = foc && mode !== 'torque';
      this.setDim('position', !posOn);
      this.setDim('velocity', !velOn);
      this.set('pos', posOn ? 'error ' + formatValue((num(m.thetaStar, 0) - num(m.thetaM, 0)) * k, 2) + ' mm' : 'off');
      this.set('w', velOn ? formatValue(num(m.omegaStar, 0) * k, 0) + ' → '
        + formatValue(num(m.omegaFilt, num(m.omegaM, 0)) * k, 0) + ' mm/s' : 'off');
      this.set('iq', formatValue(num(m.iqStar, 0), 2) + ' → ' + formatValue(num(m.iq, 0), 2) + ' A');
      this.set('id', formatValue(num(m.idStar, 0), 0) + ' → ' + formatValue(num(m.id, 0), 2) + ' A');
      this.set('u', formatValue(num(m.uMag, 0), 1) + ' of ' + formatValue(num(m.uLimit, 0), 0) + ' V');
      this.setLed('iqLimit', iqLim, th);
      this.setLed('uLimit', uLim, th);
      this.setLed('status', status, th);
      this.updateChips();
      return;
    }
    if (this.chainName === 'limit') {
      const lim = num(m.iLimit, 0);
      const iqs = Math.abs(num(m.iqStar, 0));
      this.set('velocity1', formatValue(num(m.omegaStar, 0) * k, 0) + ' → ' + formatValue(num(m.omegaFilt, 0) * k, 0) + ' mm/s');
      this.set('limit1', 'Iq ' + formatValue(iqs, 2) + ' of ' + formatValue(lim, 2) + ' A');
      this.set('flag1', iqLim ? 'on' : 'off');
      this.set('status1', status ? 'high' : 'low');
      this.set('ctrl1', status ? 'endstop: triggered' : 'endstop: open');
      this.setLed('flag', iqLim, th);
      this.setLed('status', status, th);
      if (this.bar) {
        const fw = lim > 0 ? clamp(iqs / lim, 0, 1) * this.bar.w : 0;
        if (Math.abs(fw - this.bar.last) > 0.5) {
          this.bar.last = fw;
          this.bar.el.setAttribute('width', fw.toFixed(1));
          this.bar.el.setAttribute('fill', iqLim ? th.ledTrip : th.axisQ);
        }
      }
      return;
    }
    // chain 'foc'
    const deg = Math.round(((num(m.thetaE, 0) * DEG) % 360 + 360) % 360);
    this.set('measure1', 'angle ' + deg + '°');
    this.set('measure2', mechanicsOf(snap) === 'corexy' ? 'currents (A)' : 'currents');
    this.set('park1', 'Iq ' + formatValue(num(m.iq, 0), 2) + ' A');
    this.set('park2', 'Id ' + formatValue(num(m.id, 0), 2) + ' A');
    this.set('current1', 'Iq → ' + formatValue(num(m.iqStar, 0), 2) + ' A');
    this.set('current2', 'Id → 0');
    this.set('ipark1', 'uq ' + formatValue(num(m.uq, 0), 1) + ' V');
    this.set('ipark2', 'ud ' + formatValue(num(m.ud, 0), 1) + ' V');
    this.set('pwm1', formatValue(num(m.uMag, 0), 1) + ' of ' + formatValue(num(m.uLimit, 0), 0) + ' V');
    this.set('pwm2', (m.iPhase && m.iPhase.length === 3) ? '3 phases' : '2 phases');
    this.setDim('current', !foc);
  }

  /** @private filter tooltips with the cutoff frequencies when the chapter passes them */
  updateChips() {
    const f = this.opts.filters;
    const v = this.chips.velocityFilter, c = this.chips.currentFilter;
    if (!v || !c) return;
    const hz = (x) => (x >= 1000 ? formatValue(x / 1000, 2) + ' kHz' : formatValue(x, 0) + ' Hz');
    const vs = f ? `Velocity filter: low-pass at ${hz(TUNING.fVel * num(f.velocity, 1))}` : 'Velocity filter: a low-pass on the measured speed';
    const cs = f ? `Current filters: torque ${hz(TUNING.fFilter * num(f.torque, 1))}, flux ${hz(TUNING.fFilter * num(f.flux, 1))}`
      : 'Current filters: low-passes on the measured Iq and Id';
    if (v.title.textContent !== vs) v.title.textContent = vs;
    if (c.title.textContent !== cs) c.title.textContent = cs;
  }

  /** @returns {string} */
  describe(snap) {
    const idx = snap.motors[this.opts.motor] ? this.opts.motor : 0;
    const m = snap.motors[idx];
    if (!m) return '';
    const k = mmPerRad(snap);
    const st = m.status ? 'high' : 'low';
    if (this.opts.compact && this.chainName === 'limit') {
      return `Stall detection: torque current ${formatValue(Math.abs(num(m.iqStar, 0)), 2)} A of a `
        + `${formatValue(num(m.iLimit, 0), 2)} A limit; limit flag ${m.flags && m.flags.iqTargetLimit ? 'on' : 'off'}, status output ${st}.`;
    }
    return `FOC loops: speed target ${formatValue(num(m.omegaStar, 0) * k, 1)} mm/s, actual ${formatValue(num(m.omegaFilt, 0) * k, 1)} mm/s; `
      + `torque current target ${formatValue(num(m.iqStar, 0), 2)} A, actual ${formatValue(num(m.iq, 0), 2)} A; `
      + `flux current ${formatValue(num(m.id, 0), 2)} A; voltage ${formatValue(num(m.uMag, 0), 1)} of ${formatValue(num(m.uLimit, 0), 1)} V; `
      + `status output ${st}.`;
  }
}
