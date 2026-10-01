/**
 * Shared helpers for the canvas views (SPEC 4.5).
 *
 * `CanvasView` owns the <canvas> inside a view host: it sizes the backing
 * store (css px × dpr; main.js already caps dpr at 2), rebuilds the fonts when
 * the theme's font scale changes (1.15 in fullscreen), rations text that
 * changes with the simulation to at most 10 updates per second (`this.fresh`),
 * and refreshes the host's aria-label at most once per second. A subclass
 * implements `draw(snap, ctx, now)` and `describe(snap, ctx)`, and may
 * override `onTheme(theme)` and `onOptions(changed)`.
 *
 * Colors come only from `ctx.theme` (camelCase tokens, see theme.js); alpha
 * variants use `globalAlpha`, so nothing is parsed per frame. Colors derived
 * from the tokens (`textColor`, `strokeOn`) are cached per theme object.
 */
import { MOTOR_PRESETS } from '../sim/presets.js';

export const TAU = Math.PI * 2;
const ARIA_MS = 1000;
const FRESH_MS = 100;
const SOLID = [];

export class CanvasView {
  /**
   * @param {HTMLElement} host
   * @param {Object} opts constructor options from main.js (name, slot, chapterId, viewOptions)
   * @param {Object} defaults option defaults of the subclass
   */
  constructor(host, opts, defaults) {
    this.host = host;
    this.opts = Object.assign({}, defaults, opts);
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    host.append(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.theme = null;
    this.fs = 0;
    this.font = { ui: '', uiBold: '', title: '', mono: '', monoBold: '' };
    this.layoutDirty = true;
    this.fresh = true;
    this.fmtAt = -Infinity;
    this.ariaAt = -Infinity;
    this.ariaText = '';
    this.lastT = NaN;
    this.advanced = false;
  }

  /** @param {number} cssW @param {number} cssH @param {number} dpr */
  resize(cssW, cssH, dpr) {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.layoutDirty = true;
  }

  /** @param {Object} opts merged into the current options */
  setOptions(opts) {
    if (!opts) return;
    Object.assign(this.opts, opts);
    this.layoutDirty = true;
    this.fmtAt = -Infinity;
    this.onOptions(opts);
  }

  /** Hook: options changed (the keys given to setOptions). */
  onOptions() {}

  /** Hook: the theme object changed (new palette or font scale). */
  onTheme() {}

  /**
   * Font px for a base size, scaled by the theme's font scale.
   * @param {number} px base size in css px (≥ 12 for text)
   * @returns {number}
   */
  fpx(px) {
    return Math.round(px * this.fs);
  }

  /**
   * Draw one frame (SPEC 4.5). Handles theme, fonts, the 10 Hz text ration,
   * pause detection (`this.advanced` is false while the sim time stands still)
   * and the 1 Hz aria-label; the subclass draws in `draw`.
   * @param {Object} snap world.snapshot
   * @param {Object} ctx render ctx { theme, motorType, chapterId, highlight, t, metrics, traces, product }
   */
  render(snap, ctx) {
    const w = this.w, h = this.h;
    if (w < 8 || h < 8 || !snap) return;
    const th = ctx.theme;
    if (th !== this.theme) {
      this.theme = th;
      const s = th.fontScale || 1;
      if (s !== this.fs) {
        this.fs = s;
        this.font.ui = `400 ${this.fpx(12)}px ${th.fontUi}`;
        this.font.uiBold = `500 ${this.fpx(12)}px ${th.fontUi}`;
        this.font.title = `600 ${this.fpx(13)}px ${th.fontUi}`;
        this.font.mono = `400 ${this.fpx(12)}px ${th.fontMono}`;
        this.font.monoBold = `500 ${this.fpx(12)}px ${th.fontMono}`;
        this.layoutDirty = true;
      }
      this.fmtAt = -Infinity;
      this.onTheme(th);
    }
    const now = performance.now();
    this.fresh = now - this.fmtAt >= FRESH_MS;
    if (this.fresh) this.fmtAt = now;
    this.advanced = snap.t !== this.lastT;
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setLineDash(SOLID);
    g.globalAlpha = 1;
    this.draw(snap, ctx, now);
    g.setLineDash(SOLID);
    g.globalAlpha = 1;
    this.lastT = snap.t;
    // Not while the host has focus (the gantry's inspect lens makes it a keyboard stop): a screen
    // reader would read the changed label out every second.
    if (now - this.ariaAt >= ARIA_MS && document.activeElement !== this.host) {
      this.ariaAt = now;
      let text = '';
      try { text = this.describe(snap, ctx); } catch (err) { text = ''; }
      if (text && text !== this.ariaText) {
        this.ariaText = text;
        this.host.setAttribute('aria-label', text);
      }
    }
  }

  /** Subclass: draw the frame. */
  draw() {}

  /** Subclass: one-sentence state summary for the host's aria-label. */
  describe() { return ''; }

  destroy() {
    this.canvas.remove();
  }
}

/* ---------------- drawing helpers ---------------- */

/**
 * Straight arrow with a filled head (uses the current strokeStyle/fillStyle and lineWidth).
 * @param {CanvasRenderingContext2D} g
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {number} head head length in px
 */
export function arrow(g, x0, y0, x1, y1, head) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return;
  const ux = dx / len, uy = dy / len;
  const hl = Math.min(head, len * 0.6), hw = hl * 0.5;
  const bx = x1 - ux * hl, by = y1 - uy * hl;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(bx, by);
  g.stroke();
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(bx - uy * hw, by + ux * hw);
  g.lineTo(bx + uy * hw, by - ux * hw);
  g.closePath();
  g.fill();
}

/**
 * Arrow head only, pointing along (ux, uy) with its tip at (x, y).
 * @param {CanvasRenderingContext2D} g
 */
export function arrowHead(g, x, y, ux, uy, head) {
  const hw = head * 0.5;
  const bx = x - ux * head, by = y - uy * head;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(bx - uy * hw, by + ux * hw);
  g.lineTo(bx + uy * hw, by - ux * hw);
  g.closePath();
  g.fill();
}

/**
 * Text with a halo in `halo` (drawn under it), so labels stay legible over lines.
 * Uses the current font, textAlign, textBaseline and fillStyle.
 * @param {CanvasRenderingContext2D} g
 */
export function haloText(g, text, x, y, halo, maxW) {
  const fill = g.fillStyle;
  g.lineJoin = 'round';
  g.lineWidth = 3.5;
  g.strokeStyle = halo;
  if (maxW) g.strokeText(text, x, y, maxW); else g.strokeText(text, x, y);
  g.fillStyle = fill;
  if (maxW) g.fillText(text, x, y, maxW); else g.fillText(text, x, y);
}

/**
 * Rounded rectangle path (falls back to a plain rectangle).
 * @param {CanvasRenderingContext2D} g
 */
export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/**
 * Small status LED: a filled circle in `on` color with a soft glow, or an
 * outlined dim circle when off.
 * @param {CanvasRenderingContext2D} g
 * @param {Object} th theme
 * @param {boolean} lit
 * @param {string} [color] lit color (default the trip color)
 */
export function led(g, th, x, y, r, lit, color) {
  if (lit) {
    const c = color || th.ledTrip;
    g.fillStyle = c;
    g.globalAlpha = 0.3;
    g.beginPath();
    g.arc(x, y, r * 2, 0, TAU);
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  } else {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = th.ledOff;
    g.fill();
    g.strokeStyle = th.lineColor;
    g.lineWidth = 1;
    g.stroke();
  }
}

/** [r, g, b] (0–255) of a CSS hex or rgb() color; mid gray when it cannot be read. */
function rgbOf(color) {
  const s = String(color || '').trim();
  if (s[0] === '#') {
    const hex = s.length === 4 ? s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s.slice(1, 7);
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const m = s.match(/[\d.]+/g);
  return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : [136, 136, 136];
}

/** '#rrggbb' of r, g, b (rounded, 0–255). */
function hexOf(r, g, b) {
  const h = (c) => Math.round(c).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/** WCAG relative luminance of a CSS hex or rgb() color. */
export function luminance(color) {
  const [r, gg, b] = rgbOf(color);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
}

/**
 * The opaque color `color` gives when drawn at `alpha` over `bg` (what a translucent glow looks like).
 * @param {string} color @param {number} alpha @param {string} bg opaque background
 * @returns {string} '#rrggbb'
 */
export function blend(color, alpha, bg) {
  const a = rgbOf(color), b = rgbOf(bg);
  return hexOf(a[0] * alpha + b[0] * (1 - alpha), a[1] * alpha + b[1] * (1 - alpha), a[2] * alpha + b[2] * (1 - alpha));
}

/** WCAG contrast ratio of two CSS colors (1 to 21). */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const textCache = new WeakMap();

/**
 * `color` when it reads as text on the view background (contrast ≥ 4.5), otherwise the
 * theme's text color: the light palette's pink q-axis color falls just short. Cached per
 * theme object, so it is cheap per frame.
 * @param {Object} th theme
 * @param {string} color
 * @returns {string}
 */
export function textColor(th, color) {
  let m = textCache.get(th);
  if (!m) { m = new Map(); textCache.set(th, m); }
  let c = m.get(color);
  if (c === undefined) {
    c = contrast(color, th.tipBg) >= 4.5 ? color : th.text;
    m.set(color, c);
  }
  return c;
}

const strokeCache = new WeakMap();

/**
 * `color` for lines drawn on `bg`: unchanged in the dark theme or where it reaches 3:1 (WCAG 1.4.11
 * for graphics), else scaled toward black in 1 % steps until it does. In the light palette amber
 * #E39A00 becomes #c38400 and green #27AE60 #25a55b on the scope's #fafafa; the tokens stay as they
 * are. Cached per theme object and background, so it is cheap per frame.
 * @param {Object} th theme
 * @param {string} color
 * @param {string} bg the opaque color under the stroke
 * @returns {string}
 */
export function strokeOn(th, color, bg) {
  let byBg = strokeCache.get(th);
  if (!byBg) { byBg = new Map(); strokeCache.set(th, byBg); }
  let m = byBg.get(bg);
  if (!m) { m = new Map(); byBg.set(bg, m); }
  let c = m.get(color);
  if (c === undefined) {
    c = color;
    if (!th.dark && contrast(color, bg) < 3) {
      const [r, g, b] = rgbOf(color);
      for (let k = 1; k <= 100; k++) {
        const f = 1 - k / 100;
        c = hexOf(r * f, g * f, b * f);
        if (contrast(c, bg) >= 3) break;
      }
    }
    m.set(color, c);
  }
  return c;
}

/** Least share of its natural width a label may be squeezed to by fillText's maxWidth (fitForm). */
export const MIN_SQUEEZE = 0.9;

/**
 * Index of the first of `forms` (longest first) that fits `room` css px in the current font,
 * squeezed by fillText's maxWidth to no less than MIN_SQUEEZE of its width; −1 when none fits.
 * A view calls it from its layout with templates of its widest values (it measures, so not per
 * frame) and shortens or leaves out a label rather than squeeze it unreadable.
 * @param {CanvasRenderingContext2D} g
 * @param {string[]} forms
 * @param {number} room
 * @returns {number}
 */
export function fitForm(g, forms, room) {
  for (let k = 0; k < forms.length; k++) if (g.measureText(forms[k]).width * MIN_SQUEEZE <= room) return k;
  return -1;
}

/**
 * Edge color drawn under bright strokes (amber, green): the card background in the dark
 * theme (a halo that separates them from what lies below), a gray rim in the light theme,
 * where amber and green alone are under 3:1 against the card.
 * @param {Object} th theme
 * @returns {string}
 */
export function rimColor(th) {
  return th.dark ? th.tipBg : th.lineColor;
}

/* ---------------- numbers ---------------- */

const NICE = [1, 2, 2.5, 5, 10];

/** Smallest 1-2-2.5-5 × 10^k step ≥ x. */
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const k = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / k;
  for (let i = 0; i < NICE.length; i++) if (m <= NICE[i] * (1 + 1e-9)) return NICE[i] * k;
  return 10 * k;
}

/**
 * Decimals that print every multiple of a tick step exactly (at most 6):
 * 50 → 0, 0.2 → 1, 0.25 → 2, 0.025 → 3.
 * @param {number} step a niceStep result
 * @returns {number}
 */
export function stepDecimals(step) {
  for (let d = 0; d < 6; d++) {
    const s = step * Math.pow(10, d);
    if (Math.abs(Math.round(s) - s) < 1e-6) return d;
  }
  return 6;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Clamp v to [lo, hi]. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A finite number or the fallback. */
export function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* ---------------- sim facts the views need ---------------- */

/**
 * Motor preset (presets.js) of motor i: three phases → the BLDC; two phases →
 * the scenario's stepper preset (snap.motorPreset), else the typical stepper.
 * @param {Object} snap
 * @param {number} [i=0]
 * @returns {Object} a MOTOR_PRESETS entry (R, L, Kt, p, Irated, phases, name)
 */
export function presetOf(snap, i = 0) {
  const m = snap.motors && snap.motors[i];
  if (m && m.iPhase && m.iPhase.length === 3) return MOTOR_PRESETS.bldc;
  const key = snap.motorPreset;
  const p = key && MOTOR_PRESETS[key];
  if (p && p.phases === 2) return p;
  return MOTOR_PRESETS.stepper;
}

/** mm of belt per radian of motor rotation (rotation distance / 2π). */
export function mmPerRad(snap) {
  return num(snap.rd, 40) / TAU;
}

/** The mechanics mode: 'axis', 'corexy' or 'free' (falls back on the motor count). */
export function mechanicsOf(snap) {
  const m = snap.mechanics;
  if (m === 'axis' || m === 'corexy' || m === 'free') return m;
  return snap.nMotors === 2 ? 'corexy' : 'axis';
}
