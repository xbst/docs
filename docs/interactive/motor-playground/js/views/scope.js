/**
 * Multi-trace oscilloscope (SPEC 4.6).
 *
 * Reads the chapter's trace descriptors and `world.traces` (a Map keyed
 * "name#motorIndex" → RingBuffer; ring layout in STATUS.md "Interface
 * changes"). Digital lanes sit at the top, analog traces below on a grid.
 * Each analog trace shares one vertical scale with the other traces of its
 * unit, so a target and its measured value are always comparable. Solid
 * traces get a value tag in their color at the right edge; the HTML legend
 * under the plot shows each scale and hides/shows a trace on click. A time
 * cursor supports mouse hover, touch dragging and keyboard inspection; its box stays inside
 * the canvas (a tighter pitch, or more columns, when the rows do not fit) and
 * beside the cursor where there is room (split around it if need be); the
 * cursor line is drawn over the box, so it always shows.
 *
 * Trace descriptor:
 *   { name, motor = 0, label, short, unit, group: 'analog' | 'digital',
 *     color: token name ('phase-a', 'target', …) or CSS color,
 *     dashed, range: 'auto' | 'fit' | [min, max], scale, minSpan, pulses }
 *   `color`   drawn darker in the light theme where it is under 3:1 on the
 *             plot (view-util strokeOn: amber and green); the tokens stay.
 *   `short`   lane label for digital traces (default: label).
 *   `scale`   traces with the same scale key share a range (default: unit).
 *   `minSpan` smallest auto span, so a quiet trace does not blow its noise up
 *             to full height. The largest one among a scale group's members
 *             replaces the unit default (MIN_SPAN), also when it is smaller;
 *             groups without one keep the default.
 *   Auto range: symmetric around 0 when the data goes negative, else the data
 *   extent; padded 10 %, rounded to 1-2-2.5-5 steps, with hysteresis.
 *   'fit' (chunk 04): always the data extent, also for negative data, so a
 *   small ripple on a large value fills the plot (one trace sets it for its
 *   whole scale group); it holds a range only while the data asks for at
 *   least 80 % of it (auto: 40 %).
 *   `pulses`  (chunk 04) digital lane whose samples count pulses since the
 *             previous sample (the `stepN` trace): a baseline with one thin
 *             spike per pulse, spread over the sample's interval; columns
 *             denser than one pulse per px fill as a band.
 *
 * Drawing: one path per trace per frame, decimated to the min and max of each
 * css-px column. The render path does not allocate while running; value tags
 * are reformatted at most every 100 ms, and the hover box only builds strings
 * while the pointer is over the plot. When paused the scope only redraws when
 * something changes (hover, resize, theme, legend).
 */
import { tokenColor } from '../theme.js';
import { formatCompact, formatDuration, formatTrim, formatValue } from '../format.js';
import { luminance, strokeOn } from './view-util.js';

const MAX_TRACES = 24;
const LANE_H = 14, LANE_GAP = 5;
const PAD_T = 7, PAD_B = 20, GUT_L = 52, GUT_R = 60;
const DIVS_X = 10, DIVS_Y = 4;
const TAG_H = 16, TAG_GAP = 2;
const FMT_MS = 100;
const NONE = -1e9;
const DASH = [5, 4], HOVER_DASH = [3, 3], SOLID = [];
const NICE = [1, 2, 2.5, 5, 10];
const KEEP_AUTO = 0.4, KEEP_FIT = 0.8;   // share of a held range the data must still ask for
const MIN_SPAN = {
  mm: 2, 'mm/s': 10, A: 0.2, V: 2, 'N·m': 0.02, '°': 10, deg: 10, Hz: 10, kHz: 1,
  '%': 5, 'rad/s': 1, counts: 10,
};
let scopeId = 0;

function niceCeil(x) {
  if (!(x > 0)) return 1;
  const k = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / k;
  for (let i = 0; i < NICE.length; i++) if (m <= NICE[i] * (1 + 1e-9)) return NICE[i] * k;
  return 10 * k;
}

/** '#111111' or '#ffffff', whichever contrasts more with a CSS color. */
function textOn(color) {
  return luminance(color) > 0.179 ? '#111111' : '#ffffff';
}

function rangeText(lo, hi, unit) {
  const u = unit ? ' ' + unit : '';
  if (lo === -hi) return '±' + formatTrim(hi) + u;
  return formatTrim(lo) + ' to ' + formatTrim(hi) + u;
}

export class Scope {
  /** @param {HTMLElement} host the scope card; the scope builds its canvas and legend inside */
  constructor(host) {
    this.host = host;
    this.plot = document.createElement('div');
    this.plot.className = 'scope-plot';
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'slider');
    this.canvas.setAttribute('aria-orientation', 'horizontal');
    this.canvas.setAttribute('aria-valuemin', '0');
    this.canvas.setAttribute('aria-valuemax', '100');
    this.canvas.setAttribute('aria-valuenow', '100');
    this.canvas.setAttribute('aria-valuetext', 'Newest sample. Focus the scope to inspect its values.');
    this.plot.append(this.canvas);
    this.help = document.createElement('div');
    this.help.className = 'scope-help';
    this.instructions = document.createElement('p');
    this.instructions.id = 'scope-help-' + (++scopeId);
    this.instructions.textContent = 'Pause to inspect a fixed history. Hover or tap and drag horizontally for values. '
      + 'Keyboard: Left/Right move the cursor, Home/End jump to the edges, Escape clears it.';
    this.canvas.setAttribute('aria-describedby', this.instructions.id);
    this.clearButton = document.createElement('button');
    this.clearButton.type = 'button';
    this.clearButton.className = 'btn scope-clear';
    this.clearButton.textContent = 'Clear cursor';
    this.clearButton.setAttribute('aria-disabled', 'true');
    this.clearButton.addEventListener('click', () => { if (this.cursorMode) this.clearInspection(); });
    this.help.append(this.instructions, this.clearButton);
    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    this.legend.setAttribute('role', 'group');
    this.legend.setAttribute('aria-label', 'Scope traces, select to hide or show');
    host.append(this.plot, this.legend, this.help);
    this.g = this.canvas.getContext('2d');

    this.traces = [];
    this.groups = [];
    this.window = 2;
    this.timeScale = 1;
    this.theme = null;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.hoverX = -1;
    this.cursorMode = null;
    this.cursorFraction = 1;
    this.touchPointer = null;
    this.plotLeft = 8; this.plotRight = 8;
    this.inspectionDirty = false;
    this.presenceKnown = false;      // a render has looked up the traces since setTraces
    this.dirty = true;
    this.paused = false;
    this.lastFmt = -Infinity;
    this.divStr = ''; this.winStr = ''; this.winShort = ''; this.pausedStr = 'paused';
    this.divW = 0; this.winW = 0; this.winShortW = 0; this.capDirty = true;   // caption widths, measured on change
    this.fontLabel = ''; this.fontMono = '';
    // scratch state, reused every frame
    this.tagIdx = new Int16Array(MAX_TRACES);
    this.tagY = new Float32Array(MAX_TRACES);
    this.mn = 0; this.mx = 0;
    this.pen = false; this.yPrev = 0;

    this.setWindow(2);
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.isPrimary === false) return;
      this.touchPointer = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      this.inspectAt(e.offsetX, 'touch');
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (this.touchPointer === e.pointerId) this.inspectAt(e.offsetX, 'touch');
      } else this.inspectAt(e.offsetX, 'mouse');
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.touchPointer !== e.pointerId) return;
      this.inspectAt(e.offsetX, 'touch');
      this.touchPointer = null;
      this.canvas.releasePointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointercancel', (e) => {
      if (this.touchPointer !== e.pointerId) return;
      this.touchPointer = null;
      this.clearInspection();
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (this.cursorMode === 'mouse') this.clearInspection();
    });
    this.canvas.addEventListener('focus', () => {
      if (!this.cursorMode) this.inspectAt(this.plotRight, 'keyboard');
    });
    this.canvas.addEventListener('blur', () => {
      if (this.cursorMode === 'keyboard') this.clearInspection();
    });
    this.canvas.addEventListener('keydown', (e) => this.inspectKey(e));
    this.resizeObs = new ResizeObserver(() => this.measure());
    this.resizeObs.observe(this.plot);
  }

  /** @private select a time in the visible plot; touch/keyboard selections survive resize. */
  inspectAt(x, mode) {
    const span = this.plotRight - this.plotLeft;
    if (!(span > 0)) return;
    if (mode === 'mouse' && (x < this.plotLeft || x > this.plotRight)) {
      this.clearInspection();
      return;
    }
    this.cursorMode = mode;
    this.clearButton.setAttribute('aria-disabled', 'false');
    this.cursorFraction = Math.max(0, Math.min(1, (x - this.plotLeft) / span));
    this.hoverX = this.plotLeft + this.cursorFraction * span;
    this.inspectionDirty = true;
    this.dirty = true;
  }

  /** @private */
  clearInspection() {
    this.cursorMode = null;
    this.clearButton.setAttribute('aria-disabled', 'true');
    this.hoverX = -1;
    this.inspectionDirty = false;
    this.canvas.setAttribute('aria-valuetext', 'Inspection cleared. Use Left or Right to inspect values.');
    this.dirty = true;
  }

  /** @private keyboard timeline control; unrelated keys retain their normal behavior. */
  inspectKey(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { this.clearInspection(); return; }
    let fraction = this.cursorMode ? this.cursorFraction : 1;
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === 'Home') fraction = 0;
    else if (e.key === 'End') fraction = 1;
    else fraction += e.key === 'ArrowLeft' ? -step : step;
    this.inspectAt(this.plotLeft + fraction * (this.plotRight - this.plotLeft), 'keyboard');
  }

  /** Re-read the plot size (called by a ResizeObserver; safe to call any time). */
  measure() {
    const w = this.plot.clientWidth, h = this.plot.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.dirty = true;
  }

  /** @param {Object} theme token object from theme.readTokens() */
  setTheme(theme) {
    this.theme = theme;
    const s = theme.fontScale || 1;
    this.fontLabel = `500 ${Math.round(12 * s)}px ${theme.fontUi}`;
    this.fontMono = `${Math.round(12 * s)}px ${theme.fontMono}`;
    for (let k = 0; k < this.traces.length; k++) this.colorTrace(this.traces[k]);
    this.capDirty = true;
    this.dirty = true;
  }

  /** @private the trace's color, darkened in the light theme where it would be under 3:1 on the plot */
  colorTrace(tr) {
    if (!this.theme) return;
    const th = this.theme;
    tr.color = strokeOn(th, tokenColor(th, tr.d.color, th.scopeTrace), th.scopeBg);
    tr.tagText = textOn(tr.color);
    tr.swatch.style.borderColor = tr.color;
  }

  /**
   * Replace the trace set (chapter change, or a chapter calling app.refreshTraces()).
   * Traces hidden from the legend stay hidden when the new set has one with the same
   * key and label, unless keepHidden is false (a chapter change starts all visible).
   * @param {Array<Object>} descs trace descriptors
   * @param {{keepHidden?: boolean}} [opts]
   */
  setTraces(descs, { keepHidden = true } = {}) {
    this.clearInspection();
    const prevHidden = keepHidden ? new Set(this.traces.filter((t) => !t.visible).map((t) => t.key + '|' + t.label)) : null;
    this.traces = [];
    this.groups = [];
    const byKey = new Map();
    for (const d of (descs || []).slice(0, MAX_TRACES)) {
      if (!d || !d.name) continue;
      const digital = d.group === 'digital';
      const tr = {
        d, key: d.name + '#' + (d.motor || 0), digital, pulses: digital && !!d.pulses,
        label: d.label || d.name, short: d.short || d.label || d.name, unit: d.unit || '',
        dashed: !!d.dashed, fixed: Array.isArray(d.range) ? d.range : null,
        color: '#888888', tagText: '#111111', tagStr: '',
        visible: true, present: false, ring: null, group: null,
        legendEl: null, swatch: null, scaleEl: null,
      };
      if (!digital) {
        const gk = d.scale || d.unit || d.name;
        let grp = byKey.get(gk);
        if (!grp) {
          grp = { key: gk, unit: d.unit || '', fixed: null, fit: false, lo: -1, hi: 1, init: false, active: false,
            minSpan: 0, members: [], scaleStr: d.unit || '', scaleDirty: true };
          byKey.set(gk, grp);
          this.groups.push(grp);
        }
        if (d.range === 'fit') grp.fit = true;
        if (tr.fixed && !grp.fixed) {
          grp.fixed = tr.fixed;
          grp.lo = tr.fixed[0]; grp.hi = tr.fixed[1]; grp.init = true;
          grp.scaleStr = rangeText(grp.lo, grp.hi, grp.unit);
        }
        if (d.minSpan > grp.minSpan) grp.minSpan = d.minSpan;
        grp.members.push(tr);
        tr.group = grp;
      }
      if (prevHidden && prevHidden.has(tr.key + '|' + tr.label)) tr.visible = false;
      this.traces.push(tr);
    }
    // The largest minSpan a member gives replaces the unit default, even a smaller one.
    for (const grp of this.groups) if (!(grp.minSpan > 0)) grp.minSpan = MIN_SPAN[grp.unit] || 0;
    this.buildLegend();
    for (let k = 0; k < this.traces.length; k++) this.colorTrace(this.traces[k]);
    this.presenceKnown = false;
    this.updateLabel();
    this.dirty = true;
  }

  /** @private */
  buildLegend() {
    this.legend.replaceChildren();
    for (const tr of this.traces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lg';
      b.setAttribute('aria-pressed', String(tr.visible));
      b.setAttribute('aria-label', tr.label + (tr.unit ? ` (${tr.unit})` : ''));
      b.title = 'Show or hide this trace';
      const sw = document.createElement('i');
      sw.className = tr.digital ? 'dig' : tr.dashed ? 'dash' : '';
      const name = document.createElement('span');
      name.textContent = tr.label;
      const scale = document.createElement('span');
      scale.className = 'u';
      scale.textContent = tr.digital ? '' : tr.group.scaleStr;
      b.append(sw, name, scale);
      b.hidden = true;               // shown once the world provides the trace
      b.addEventListener('click', () => {
        tr.visible = !tr.visible;
        b.setAttribute('aria-pressed', String(tr.visible));
        this.inspectionDirty = !!this.cursorMode;
        this.dirty = true;
      });
      tr.legendEl = b; tr.swatch = sw; tr.scaleEl = scale;
      this.legend.append(b);
    }
  }

  /**
   * Visible time window in sim seconds (SPEC 4.6: from the chapter, or live
   * through app.setTraceWindow).
   * @param {number} seconds
   */
  setWindow(seconds) {
    if (!(seconds > 0)) return;
    this.window = seconds;
    this.updateStrings();
  }

  /** @param {number} x sim seconds per real second, shown next to the window length */
  setTimeScale(x) {
    if (!(x > 0)) return;
    this.timeScale = x;
    this.updateStrings();
  }

  /** @param {boolean} paused when paused the scope only redraws on changes */
  setPaused(paused) {
    this.paused = !!paused;
    this.dirty = true;
  }

  /** Force a redraw on the next render call. */
  invalidate() { this.dirty = true; }

  /** @private */
  updateStrings() {
    this.divStr = formatDuration(this.window / DIVS_X) + '/div';
    const onScreen = this.window / this.timeScale;
    this.winShort = formatDuration(this.window) + ' of motor time';
    this.winStr = this.winShort
      + (Math.abs(this.timeScale - 1) > 1e-9 ? ' (' + formatDuration(onScreen) + ' on screen)' : '');
    this.capDirty = true;
    this.updateLabel();
    this.dirty = true;
  }

  /** @private names the traces the legend shows, the ones the world provides (all until a render has looked) */
  updateLabel() {
    let names = '';
    for (const t of this.traces) {
      if (this.presenceKnown && !t.present) continue;
      names += (names ? ', ' : '') + t.label + (t.unit ? ` (${t.unit})` : '');
    }
    this.canvas.setAttribute('aria-label',
      `Oscilloscope time cursor, ${formatDuration(this.window)} of motor time` + (names ? `: ${names}.` : '.'));
  }

  /**
   * Draw the traces from world.traces. Call once per frame.
   * @param {{traces: Map<string, Object>, snapshot: Object}} world
   */
  render(world) {
    const th = this.theme;
    if (!th || this.w < 40 || this.h < 30) return;
    if (this.paused && !this.dirty) return;
    this.dirty = false;
    const g = this.g, W = this.w, H = this.h, s = th.fontScale || 1;
    const map = world ? world.traces : null;
    const snap = world ? world.snapshot : null;
    const traces = this.traces;

    let nDig = 0, tNew = -Infinity, flipped = !this.presenceKnown;
    for (let k = 0; k < traces.length; k++) {
      const tr = traces[k];
      const ring = map ? map.get(tr.key) : undefined;
      tr.ring = ring || null;
      const present = !!ring;
      if (present !== tr.present) { tr.present = present; tr.legendEl.hidden = !present; flipped = true; }
      if (!present) continue;
      if (ring.len > 0) {
        let p = ring.head - 1;
        if (p < 0) p += ring.cap;
        if (ring.t[p] > tNew) tNew = ring.t[p];
      }
      if (tr.visible && tr.digital) nDig++;
    }
    if (flipped) { this.presenceKnown = true; this.updateLabel(); }   // only after a trace or world change
    const tR = snap && Number.isFinite(snap.t) ? snap.t : (tNew > -Infinity ? tNew : 0);
    const win = this.window, tL = tR - win;

    const laneH = Math.round(LANE_H * s);
    const tagH = Math.round(TAG_H * s);
    const x0 = nDig ? Math.round(GUT_L * s) : 8, gr = Math.round(GUT_R * s), x1 = W - gr, pw = x1 - x0;
    this.plotLeft = x0; this.plotRight = x1;
    if (this.cursorMode && this.cursorMode !== 'mouse') this.hoverX = x0 + this.cursorFraction * pw;
    const top = PAD_T, aBot = H - Math.round(PAD_B * s);
    const aTop = top + nDig * (laneH + LANE_GAP);
    const ah = aBot - aTop;
    if (pw < 20) return;
    const pps = pw / win;

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.setLineDash(SOLID);
    g.fillStyle = th.scopeBg;
    g.fillRect(0, 0, W, H);

    // grid: fixed divisions, the signal scrolls through them
    g.lineWidth = 1;
    g.strokeStyle = th.scopeGrid;
    g.beginPath();
    for (let i = 0; i <= DIVS_X; i++) {
      const x = Math.round(x0 + pw * i / DIVS_X) + 0.5;
      g.moveTo(x, top); g.lineTo(x, aBot);
    }
    if (ah > 16) {
      for (let i = 0; i <= DIVS_Y; i++) {
        const y = Math.round(aTop + ah * i / DIVS_Y) + 0.5;
        g.moveTo(x0, y); g.lineTo(x1, y);
      }
    }
    g.stroke();

    // digital lanes
    let lane = 0;
    g.font = this.fontLabel;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.lineWidth = 1.5;
    g.lineJoin = 'miter';
    for (let k = 0; k < traces.length; k++) {
      const tr = traces[k];
      if (!tr.digital || !tr.present || !tr.visible) continue;
      const yT = top + lane * (laneH + LANE_GAP) + 1, yB = yT + laneH - 2;
      lane++;
      g.fillStyle = th.descColor;
      g.fillText(tr.short, x0 - 6, (yT + yB) / 2, x0 - 8);
      const lo = tr.fixed ? tr.fixed[0] : 0, hi = tr.fixed ? tr.fixed[1] : 1;
      g.strokeStyle = tr.color;
      if (tr.pulses) this.strokePulses(tr.ring, tL, x0, pps, yT, yB, x1);
      else this.strokeDigital(tr.ring, tL, x0, pps, yB, lo, (yB - yT) / ((hi - lo) || 1), x1);
    }

    // analog scales
    let symmetric = false;
    for (let k = 0; k < this.groups.length; k++) {
      const grp = this.groups[k];
      let mn = Infinity, mx = -Infinity, shown = 0;
      const mem = grp.members;
      for (let j = 0; j < mem.length; j++) {
        const tr = mem[j];
        if (!tr.present || !tr.visible) continue;
        shown++;
        if (!tr.ring.len) continue;
        this.extent(tr.ring, tL);
        if (this.mn < mn) mn = this.mn;
        if (this.mx > mx) mx = this.mx;
      }
      grp.active = shown > 0 && (mn <= mx || grp.fixed !== null);
      if (!grp.active) continue;
      if (mn <= mx) this.updateRange(grp, mn, mx);
      if (grp.lo === -grp.hi) symmetric = true;
      if (grp.scaleDirty) {
        grp.scaleDirty = false;
        for (let j = 0; j < mem.length; j++) mem[j].scaleEl.textContent = grp.scaleStr;
      }
    }
    if (symmetric && ah > 16) {
      const y = Math.round((aTop + aBot) / 2) + 0.5;
      g.strokeStyle = th.tipBorder;
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    }

    // analog traces, clipped to the plot area
    g.save();
    g.beginPath();
    g.rect(x0, aTop, pw + 1, ah + 1);
    g.clip();
    g.lineJoin = 'round';
    g.lineWidth = 1.6;
    for (let k = 0; k < traces.length; k++) {
      const tr = traces[k];
      if (tr.digital || !tr.present || !tr.visible || !tr.group.active) continue;
      const grp = tr.group;
      g.strokeStyle = tr.color;
      g.setLineDash(tr.dashed ? DASH : SOLID);
      this.strokeAnalog(tr.ring, tL, x0, pps, aBot, grp.lo, ah / ((grp.hi - grp.lo) || 1));
    }
    g.restore();
    g.setLineDash(SOLID);

    // value tags at the right edge (solid traces only; targets are dashed)
    const now = performance.now();
    const refmt = now - this.lastFmt >= FMT_MS;
    if (refmt) this.lastFmt = now;
    const tagIdx = this.tagIdx, tagY = this.tagY;
    let nTags = 0;
    for (let k = 0; k < traces.length; k++) {
      const tr = traces[k];
      if (tr.digital || tr.dashed || !tr.present || !tr.visible || !tr.group.active) continue;
      const v = this.lastValue(tr.ring);
      if (v !== v) continue;
      const grp = tr.group;
      if (refmt || !tr.tagStr) tr.tagStr = formatCompact(v, Math.max(-grp.lo, grp.hi));
      let y = aBot - (v - grp.lo) * ah / ((grp.hi - grp.lo) || 1);
      if (y < aTop + tagH / 2) y = aTop + tagH / 2;
      if (y > aBot - tagH / 2) y = aBot - tagH / 2;
      tagIdx[nTags] = k; tagY[nTags] = y; nTags++;
    }
    for (let i = 1; i < nTags; i++) {            // insertion sort by y
      const yi = tagY[i], ki = tagIdx[i];
      let j = i - 1;
      while (j >= 0 && tagY[j] > yi) { tagY[j + 1] = tagY[j]; tagIdx[j + 1] = tagIdx[j]; j--; }
      tagY[j + 1] = yi; tagIdx[j + 1] = ki;
    }
    const pitch = tagH + TAG_GAP;
    for (let i = 1; i < nTags; i++) if (tagY[i] - tagY[i - 1] < pitch) tagY[i] = tagY[i - 1] + pitch;
    let limit = aBot - tagH / 2;
    for (let i = nTags - 1; i >= 0; i--) { if (tagY[i] > limit) tagY[i] = limit; limit = tagY[i] - pitch; }
    g.font = this.fontMono;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const tx = x1 + 4, tw = gr - 6;
    for (let i = 0; i < nTags; i++) {
      const tr = traces[tagIdx[i]], y = tagY[i];
      g.fillStyle = tr.color;
      g.beginPath();
      if (g.roundRect) g.roundRect(tx, y - tagH / 2, tw, tagH, 3);
      else g.rect(tx, y - tagH / 2, tw, tagH);
      g.fill();
      g.fillStyle = tr.tagText;
      g.fillText(tr.tagStr, tx + 4, y + 0.5, tw - 7);
    }

    // time axis captions: the window length always, the time per division only where both fit
    g.font = this.fontMono;
    if (this.capDirty) {
      this.capDirty = false;
      this.divW = g.measureText(this.divStr).width;
      this.winW = g.measureText(this.winStr).width;
      this.winShortW = g.measureText(this.winShort).width;
    }
    g.fillStyle = th.muted;
    g.textBaseline = 'alphabetic';
    const ty = H - 6, capGap = Math.round(12 * s);
    let winCap = this.winStr, winW = this.winW;
    if (pw < 440 * s || this.divW + capGap + winW > pw) { winCap = this.winShort; winW = this.winShortW; }
    const showDiv = this.divW + capGap + winW <= pw;
    if (showDiv) {
      g.textAlign = 'left';
      g.fillText(this.divStr, x0, ty);
    }
    g.textAlign = 'right';
    g.fillText(winCap, x1, ty, showDiv ? pw - this.divW - capGap : x1 - 6);
    if (this.paused) {
      g.textAlign = 'right';
      g.fillText(this.pausedStr, W - 6, ty);
    }

    if (this.hoverX >= x0 && this.hoverX <= x1) this.drawHover(th, tL, tR, x0, pps, top, aBot);
  }

  /** @private first logical index with t >= tL (binary search) */
  firstIndex(ring, tL, base) {
    const cap = ring.cap, T = ring.t;
    let lo = 0, hi = ring.len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let p = base + mid;
      if (p >= cap) p -= cap;
      if (T[p] < tL) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** @private min and max of the samples in the window, into this.mn / this.mx */
  extent(ring, tL) {
    const cap = ring.cap, len = ring.len, V = ring.v;
    let base = ring.head - len;
    if (base < 0) base += cap;
    let mn = Infinity, mx = -Infinity;
    for (let i = this.firstIndex(ring, tL, base); i < len; i++) {
      let p = base + i;
      if (p >= cap) p -= cap;
      const v = V[p];
      if (v !== v) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.mn = mn; this.mx = mx;
  }

  /** @private newest non-NaN value (looks back a few samples), NaN if none */
  lastValue(ring) {
    const cap = ring.cap;
    const n = Math.min(ring.len, 8);
    let p = ring.head - 1;
    for (let i = 0; i < n; i++) {
      if (p < 0) p += cap;
      const v = ring.v[p];
      if (v === v) return v;
      p--;
    }
    return NaN;
  }

  /** @private value nearest to time t, NaN if none */
  valueAt(ring, t) {
    const cap = ring.cap, len = ring.len;
    if (!len) return NaN;
    let base = ring.head - len;
    if (base < 0) base += cap;
    let i = this.firstIndex(ring, t, base);
    if (i >= len) i = len - 1;
    let p = base + i;
    if (p >= cap) p -= cap;
    if (i > 0) {
      let q = p - 1;
      if (q < 0) q += cap;
      if (Math.abs(ring.t[q] - t) < Math.abs(ring.t[p] - t)) p = q;
    }
    return ring.v[p];
  }

  /** @private auto range with 10 % padding, nice steps and hysteresis ('fit' groups: never symmetric, tighter hysteresis) */
  updateRange(grp, mn, mx) {
    if (grp.fixed) return;
    let lo, hi;
    if (mn < 0 && !grp.fit) {
      const m = niceCeil(Math.max(-mn, mx, grp.minSpan / 2, 1e-12) * 1.1);
      lo = -m; hi = m;
    } else {
      let a = mn, b = mx;
      const minSpan = Math.max(grp.minSpan, Math.abs(b) * 1e-3, 1e-12);
      if (b - a < minSpan) { const c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; }
      const pad = (b - a) * 0.1;
      a -= pad; b += pad;
      const step = niceCeil((b - a) / DIVS_Y);
      lo = Math.floor(a / step) * step;
      hi = Math.ceil(b / step) * step;
      if (mn >= 0 && lo < 0) lo = 0;
    }
    // Keep the current range while the data fits and still uses a fair part of it ('fit' groups:
    // most of it, so the range follows a shrinking extent, e.g. after a switch-on transient).
    if (grp.init && mn >= grp.lo && mx <= grp.hi && (hi - lo) >= (grp.fit ? KEEP_FIT : KEEP_AUTO) * (grp.hi - grp.lo)) return;
    // The first range always gets its legend text, even when it equals the ±1 placeholder.
    const first = !grp.init;
    grp.init = true;
    if (first || lo !== grp.lo || hi !== grp.hi) {
      grp.lo = lo; grp.hi = hi;
      grp.scaleStr = rangeText(lo, hi, grp.unit);
      grp.scaleDirty = true;
    }
  }

  /** @private one path per trace: min and max of each css-px column, NaN = gap */
  strokeAnalog(ring, tL, x0, pps, yb, lo, ys) {
    const g = this.g, cap = ring.cap, len = ring.len, T = ring.t, V = ring.v;
    let base = ring.head - len;
    if (base < 0) base += cap;
    let i = this.firstIndex(ring, tL, base);
    if (i > 0) i--;                  // start just left of the window so the line reaches the edge
    let col = NONE, cMin = 0, cMax = 0, kMin = 0, kMax = 0;
    this.pen = false;
    g.beginPath();
    for (; i < len; i++) {
      let p = base + i;
      if (p >= cap) p -= cap;
      const v = V[p];
      if (v !== v) {
        if (col !== NONE) this.emit(x0 + col, cMin, cMax, kMin <= kMax, yb, lo, ys);
        col = NONE;
        this.pen = false;
        continue;
      }
      const c = Math.floor((T[p] - tL) * pps);
      if (c !== col) {
        if (col !== NONE) this.emit(x0 + col, cMin, cMax, kMin <= kMax, yb, lo, ys);
        col = c; cMin = cMax = v; kMin = kMax = i;
      } else {
        if (v < cMin) { cMin = v; kMin = i; }
        if (v > cMax) { cMax = v; kMax = i; }
      }
    }
    if (col !== NONE) this.emit(x0 + col, cMin, cMax, kMin <= kMax, yb, lo, ys);
    g.stroke();
  }

  /** @private */
  emit(x, a, b, minFirst, yb, lo, ys) {
    const g = this.g;
    x += 0.5;
    const y1 = yb - ((minFirst ? a : b) - lo) * ys;
    if (this.pen) g.lineTo(x, y1); else { g.moveTo(x, y1); this.pen = true; }
    if (a !== b) g.lineTo(x, yb - ((minFirst ? b : a) - lo) * ys);
  }

  /** @private held levels with vertical edges; a column with both levels draws a band */
  strokeDigital(ring, tL, x0, pps, yb, lo, ys, xEnd) {
    const g = this.g, cap = ring.cap, len = ring.len, T = ring.t, V = ring.v;
    let base = ring.head - len;
    if (base < 0) base += cap;
    let i = this.firstIndex(ring, tL, base);
    if (i > 0) i--;
    let col = NONE, cFirst = 0, cMin = 0, cMax = 0, cLast = 0;
    this.pen = false;
    g.beginPath();
    for (; i < len; i++) {
      let p = base + i;
      if (p >= cap) p -= cap;
      const v = V[p];
      if (v !== v) {
        if (col !== NONE) this.emitDigital(x0 + col, cFirst, cMin, cMax, cLast, yb, lo, ys);
        col = NONE;
        this.pen = false;
        continue;
      }
      const c = Math.floor((T[p] - tL) * pps);
      if (c !== col) {
        if (col !== NONE) this.emitDigital(x0 + col, cFirst, cMin, cMax, cLast, yb, lo, ys);
        col = c; cFirst = cMin = cMax = cLast = v;
      } else {
        if (v < cMin) cMin = v;
        if (v > cMax) cMax = v;
        cLast = v;
      }
    }
    if (col !== NONE) {
      this.emitDigital(x0 + col, cFirst, cMin, cMax, cLast, yb, lo, ys);
      g.lineTo(xEnd, this.yPrev);
    }
    g.stroke();
  }

  /**
   * @private pulse-count lane: the low baseline plus one thin spike per pulse, spread evenly over
   * the interval since the previous sample; at most one spike per px column, and a column run is
   * filled when its sample holds more pulses than px (a band).
   */
  strokePulses(ring, tL, x0, pps, yT, yB, xEnd) {
    const g = this.g, cap = ring.cap, len = ring.len, T = ring.t, V = ring.v;
    let base = ring.head - len;
    if (base < 0) base += cap;
    let i = this.firstIndex(ring, tL, base);
    let tPrev = NaN;
    if (i > 0) {
      let q = base + i - 1;
      if (q >= cap) q -= cap;
      tPrev = T[q];
    }
    g.beginPath();
    if (i < len) {
      // baseline from where the data starts (like the other lanes) to the right edge
      let p0 = base + i;
      if (p0 >= cap) p0 -= cap;
      g.moveTo(tPrev === tPrev ? x0 : x0 + (T[p0] - tL) * pps, yB);
      g.lineTo(xEnd, yB);
    }
    let lastCol = NONE;
    for (; i < len; i++) {
      let p = base + i;
      if (p >= cap) p -= cap;
      const n = V[p], t = T[p];
      if (n >= 0.5) {
        const ta = tPrev === tPrev ? (tPrev > tL ? tPrev : tL) : t;
        const xa = x0 + (ta - tL) * pps;
        const xb = x0 + (t - tL) * pps;
        const k = Math.round(n), span = xb - xa;
        if (k > 1 && span < k) {
          for (let c = Math.floor(xa), c1 = Math.floor(xb); c <= c1; c++) {
            if (c === lastCol) continue;
            g.moveTo(c + 0.5, yB); g.lineTo(c + 0.5, yT);
            lastCol = c;
          }
        } else {
          for (let j = 0; j < k; j++) {
            const c = Math.floor(xa + span * (j + 0.5) / k);
            if (c === lastCol) continue;
            g.moveTo(c + 0.5, yB); g.lineTo(c + 0.5, yT);
            lastCol = c;
          }
        }
      }
      tPrev = t;
    }
    g.stroke();
  }

  /** @private */
  emitDigital(x, first, mn, mx, last, yb, lo, ys) {
    const g = this.g;
    x += 0.5;
    if (this.pen) g.lineTo(x, this.yPrev);
    else { g.moveTo(x, yb - (first - lo) * ys); this.pen = true; }
    if (mn !== mx) { g.lineTo(x, yb - (mn - lo) * ys); g.lineTo(x, yb - (mx - lo) * ys); }
    this.yPrev = yb - (last - lo) * ys;
    g.lineTo(x, this.yPrev);
  }

  /**
   * @private hover cursor and value box, kept inside the canvas and beside the cursor where it fits
   * (builds strings only while hovering)
   */
  drawHover(th, tL, tR, x0, pps, top, aBot) {
    const g = this.g, s = th.fontScale || 1;
    const t = tL + (this.hoverX - x0) / pps;
    const rows = [];
    g.font = this.fontMono;
    let wl = 0, wv = 0;
    for (const tr of this.traces) {
      if (!tr.present || !tr.visible || !tr.ring) continue;
      const v = this.valueAt(tr.ring, t);
      if (v !== v) continue;
      // analog values one decimal finer than the value tags (a tenth of the scale bound as the
      // reference, at most 4 decimals), so a sample reads closer; float residue still reads 0
      const val = tr.digital ? formatValue(v, 0)
        : formatCompact(v, Math.max(-tr.group.lo, tr.group.hi) / 10) + (tr.unit ? ' ' + tr.unit : '');
      const lab = tr.digital ? tr.short : tr.label;
      wl = Math.max(wl, g.measureText(lab).width);
      wv = Math.max(wv, g.measureText(val).width);
      rows.push(tr.color, lab, val);
    }
    const head = 't = ' + formatDuration(t - tR);
    // Update the accessible value on deliberate inspection, not on every animation frame:
    // continuously announcing a running simulation would drown out screen-reader controls.
    if (this.inspectionDirty) {
      this.inspectionDirty = false;
      const values = [];
      for (let i = 0; i < rows.length; i += 3) values.push(rows[i + 1] + ': ' + rows[i + 2]);
      this.canvas.setAttribute('aria-valuenow', String(Math.round(this.cursorFraction * 100)));
      this.canvas.setAttribute('aria-valuetext', (t === tR ? 'Newest sample' : formatDuration(tR - t) + ' before newest sample')
        + '. ' + (values.length ? values.join('; ') : 'No samples available.'));
    }
    // Fit the box to the canvas: one column at the normal pitch, else one column at a tighter pitch
    // (13·s at the least), else more columns; where those would not fit the width, one 13·s column
    // whose last line counts the rows left out.
    const pad = 7, dot = 12, gap = 16, n = rows.length / 3;
    const by = top + 2, room = this.h - 2 - by - pad * 2;
    const colW = dot + wl + 12 + wv, headW = g.measureText(head).width;
    const lh15 = Math.round(15 * s), lh13 = Math.round(13 * s);
    let lh = lh15, cols = 1;
    if ((n + 1) * lh15 > room) {
      if ((n + 1) * lh13 <= room) lh = Math.floor(room / (n + 1));
      else {
        cols = Math.ceil(n / Math.max(1, Math.floor(room / lh15) - 1));
        if (cols > 1 && cols * (colW + gap) - gap + pad * 2 > this.w - 4) { cols = 1; lh = lh13; }
      }
    }
    let per = Math.ceil(n / cols), shown = n;
    const fit = Math.floor(room / lh) - 1;
    if (per > fit) { per = Math.max(1, fit); shown = per * cols - 1; }
    const inner = Math.max(cols * (colW + gap) - gap, headW);
    const cw = cols > 1 ? colW : inner;
    const bw = inner + pad * 2;
    const bh = pad * 2 + lh * (1 + per);
    // Right of the cursor, else left of it, else (several columns) column 0 with the header left of it
    // and the other columns right of it; a box that fits none of these is clamped to the left edge.
    let bx = this.hoverX + 12, bxR = 0, wL = bw, wR = 0;
    if (bx + bw > this.w - 2) bx = this.hoverX - 12 - bw;
    if (bx < 2) {
      bx = 2;
      const l = Math.max(colW, headW) + pad * 2, r = (cols - 1) * (colW + gap) - gap + pad * 2;
      if (cols > 1 && this.hoverX - 8 - l >= 2 && this.hoverX + 8 + r <= this.w - 2) {
        wL = l; wR = r; bx = this.hoverX - 8 - l; bxR = this.hoverX + 8;
      }
    }
    g.fillStyle = th.tipBg;
    g.strokeStyle = th.tipBorder;
    g.lineWidth = 1;
    g.beginPath();
    if (g.roundRect) {
      g.roundRect(bx, by, wL, bh, 6);
      if (bxR) g.roundRect(bxR, by, wR, bh, 6);
    } else {
      g.rect(bx, by, wL, bh);
      if (bxR) g.rect(bxR, by, wR, bh);
    }
    g.fill();
    g.stroke();
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = th.muted;
    const y0 = by + pad + lh / 2;
    g.fillText(head, bx + pad, y0);
    for (let i = 0; i < shown; i++) {                 // column by column
      const c = Math.floor(i / per), y = y0 + lh * (1 + i - c * per);
      const x = bxR && c > 0 ? bxR + pad + (c - 1) * (colW + gap) : bx + pad + c * (colW + gap);
      g.fillStyle = rows[3 * i];
      g.beginPath(); g.arc(x + 4, y, 3.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = th.text;
      g.textAlign = 'left';
      g.fillText(rows[3 * i + 1], x + dot, y);
      g.textAlign = 'right';
      g.fillText(rows[3 * i + 2], x + cw, y);
    }
    if (shown < n) {
      g.fillStyle = th.muted;
      g.textAlign = 'left';
      g.fillText('+' + (n - shown) + ' more', bx + pad + dot, y0 + lh * per);
    }

    // the cursor line last, so a box that could not sit beside it does not hide it
    const hx = Math.round(this.hoverX) + 0.5;
    g.strokeStyle = th.lineColor;
    g.setLineDash(HOVER_DASH);
    g.beginPath(); g.moveTo(hx, top); g.lineTo(hx, aBot); g.stroke();
    g.setLineDash(SOLID);
  }

  destroy() {
    this.resizeObs.disconnect();
    this.host.replaceChildren();
  }
}
