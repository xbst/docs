/**
 * Readout chips and LEDs (SPEC 4.7), styled like the CAN widget's `.stat`
 * chips, plus one polite live region that announces events (stall detected,
 * steps lost, homing done) and shows them briefly as a pill in a slot after
 * the chips. The slot keeps the size of the chapter's longest message
 * (setSample), so a message coming and going covers nothing and moves nothing.
 *
 * Item: { label, value, unit, warn, ok, led: 'on'|'off'|'trip', title, digits, minChars, unitChars, bar }
 *   value: number (formatted to ~3 significant digits, or `digits` decimals) or string.
 *   unit: text after the value; a leading "%" or "°" attaches to the number ("85% of target").
 *   warn / ok: tint the chip (warn wins). led: prepend an LED dot.
 *   minChars: reserve this many monospace characters for a value before it arrives.
 *   unitChars: reserve room for a unit that carries a number of its own ("microsteps (3.30 µm)").
 *   bar: { value, max, mark, low, off } appends a small level bar (chunk 05, the StallGuard
 *     reading): filled to value/max, a tick at mark/max (e.g. the DIAG threshold), red while
 *     `low`, empty and gray while `off` (no reading). Decorative (aria-hidden); the value text
 *     carries the number.
 * Up to 8 chips; they wrap on desktop and scroll sideways on mobile. DOM nodes
 * are reused and only touched when their text or state changes. A chip keeps
 * the widest width it has had for its label (a min-width), so the rows do not
 * rewrap as a value changes width (a dash, a longer result); clear() and
 * resetWidths() forget those widths.
 */
import { formatValue } from '../format.js';

const MAX_CHIPS = 8;
const SHOW_MS = 4000;

/** Set a node's text; true when it changed. */
function setText(node, text) {
  if (node.textContent === text) return false;
  node.textContent = text;
  return true;
}

export class Readouts {
  /** @param {HTMLElement} host the readouts strip element */
  constructor(host) {
    this.host = host;
    this.list = document.createElement('div');
    this.list.className = 'chips';
    // The message slot (B-008): on the chips' last line when it has room, else on a line of its own
    // (playground.css .msg). An invisible copy of the chapter's longest message shares its grid
    // cell, so the slot is that message's size at any width and font size. Out of the flow
    // (.none) until a chapter has a message.
    this.msg = document.createElement('div');
    this.msg.className = 'msg none';
    this.sample = document.createElement('span');
    this.sample.className = 'msg-sample';
    this.sample.setAttribute('aria-hidden', 'true');
    this.live = document.createElement('div');
    this.live.className = 'live idle';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    this.msg.append(this.sample, this.live);
    host.append(this.list, this.msg);
    this.chips = [];
    this.showTimer = 0;
    this.fadeTimer = 0;
    this.clearTimer = 0;
  }

  /** @private */
  makeChip() {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const led = document.createElement('i');
    led.className = 'led';
    led.hidden = true;
    const lbl = document.createElement('span');
    const val = document.createElement('b');
    const unit = document.createElement('span');
    unit.className = 'u';
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.hidden = true;
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'f';
    const mark = document.createElement('span');
    mark.className = 'm';
    bar.append(fill, mark);
    // Real spaces for screen readers; flex layout ignores whitespace-only text.
    chip.append(led, lbl, ' ', val, ' ', unit, bar);
    this.list.append(chip);
    return {
      el: chip, led, lbl, val, unit, bar, fill, mark, barKey: '', cls: 'chip', ledState: '', hidden: false, title: '',
      minChars: 0, unitChars: 0,
      minW: 0, w: 0, measure: false,    // widest width for this label (css px), last measured width, due for a measure
    };
  }

  /** @private forget a chip's widest width */
  forget(c) {
    if (c.minW) { c.minW = 0; c.el.style.minWidth = ''; }
  }

  /** @private level bar of a chip (item.bar), touched only when its state changes */
  setBar(c, b) {
    if (!b || !(b.max > 0)) {
      if (c.barKey !== '') { c.bar.hidden = true; c.barKey = ''; }
      return;
    }
    const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
    const f = b.off ? 0 : clamp01(+b.value / b.max);
    const m = typeof b.mark === 'number' ? clamp01(b.mark / b.max) : -1;
    const state = b.off ? 'off' : b.low ? 'low' : '';
    const key = `${(f * 100).toFixed(1)}|${(m * 100).toFixed(1)}|${state}`;
    if (key === c.barKey) return;
    c.barKey = key;
    c.bar.hidden = false;
    c.bar.className = 'bar' + (state ? ' ' + state : '');
    c.fill.style.width = (f * 100).toFixed(1) + '%';
    c.mark.hidden = m < 0;
    if (m >= 0) c.mark.style.left = (m * 100).toFixed(1) + '%';
  }

  /**
   * Show the chapter's readouts. Call at a modest rate (main.js: 10 Hz).
   * @param {Array<Object>} items
   */
  update(items) {
    const n = Math.min(items ? items.length : 0, MAX_CHIPS);
    while (this.chips.length < n) this.chips.push(this.makeChip());
    for (let i = 0; i < this.chips.length; i++) {
      const c = this.chips[i];
      const it = i < n ? items[i] : null;
      if (!it) {
        if (!c.hidden) { c.el.hidden = true; c.hidden = true; }
        continue;
      }
      if (c.hidden) { c.el.hidden = false; c.hidden = false; c.measure = true; }
      // a new quantity in this slot starts over with its width
      if (setText(c.lbl, it.label || '')) { this.forget(c); c.measure = true; }
      const minChars = Math.max(0, +it.minChars || 0);
      if (c.minChars !== minChars) {
        c.minChars = minChars;
        c.val.style.minWidth = minChars ? minChars + 'ch' : '';
        this.forget(c);
        c.measure = true;
      }
      const unitChars = Math.max(0, +it.unitChars || 0);
      if (c.unitChars !== unitChars) {
        c.unitChars = unitChars;
        c.unit.style.minWidth = unitChars ? unitChars + 'ch' : '';
        this.forget(c);
        c.measure = true;
      }
      // "%" and "°" attach to the number (US style: 85%, 66°; dropped when there is no number);
      // the rest of the unit follows.
      const unit = it.unit || '';
      const sym = unit[0] === '%' || unit[0] === '°' ? unit[0] : '';
      const numeric = typeof it.value === 'number' && Number.isFinite(it.value);
      if (setText(c.val, formatValue(it.value, it.digits) + (numeric ? sym : ''))) c.measure = true;
      const rest = sym ? unit.slice(1).trim() : unit;
      if (setText(c.unit, rest)) c.measure = true;
      if (c.unit.hidden !== !rest) { c.unit.hidden = !rest; c.measure = true; }
      const cls = 'chip' + (it.warn ? ' warn' : it.ok ? ' ok' : '');
      if (c.cls !== cls) { c.el.className = cls; c.cls = cls; }
      const led = it.led || '';
      if (c.ledState !== led) {
        c.led.hidden = !led;
        c.led.className = 'led' + (led && led !== 'off' ? ' ' + led : '');
        c.ledState = led;
        c.measure = true;
      }
      const title = it.title || '';
      if (c.title !== title) { c.el.title = title; c.title = title; }
      const barHidden = c.bar.hidden;
      this.setBar(c, it.bar);
      if (c.bar.hidden !== barHidden || !c.minW) c.measure = true;
    }
    this.holdWidths();
  }

  /**
   * @private Each chip whose content changed keeps the widest width it has had, so the chip rows
   * do not rewrap on every change of a value's width (chapter 9's Home: F-60). All widths are
   * read before any is written, so the browser lays the strip out once.
   */
  holdWidths() {
    const cs = this.chips;
    for (let i = 0; i < cs.length; i++) if (cs[i].measure) cs[i].w = cs[i].hidden ? 0 : cs[i].el.getBoundingClientRect().width;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (!c.measure) continue;
      c.measure = false;
      if (c.w > c.minW) { c.minW = c.w; c.el.style.minWidth = c.w + 'px'; }
    }
  }

  /** Forget the chips' widest widths (their font changed: fonts loaded, fullscreen, a new theme). */
  resetWidths() {
    for (let i = 0; i < this.chips.length; i++) this.forget(this.chips[i]);
  }

  /**
   * Reserve the message slot for the chapter's longest message (main.js: the chapter's
   * announceSample). Empty: no slot until the first message.
   * @param {string} text
   */
  setSample(text) {
    const s = text ? String(text) : '';
    if (this.sample.textContent !== s) this.sample.textContent = s;
    this.msg.classList.toggle('none', !s);
  }

  /**
   * Announce a short event message to screen readers and show it briefly.
   * @param {string} text
   */
  announce(text) {
    if (!text) return;
    // A message longer than the reserved one takes over the reservation, so the slot grows once
    // and keeps that size for the visit instead of shrinking back as each such message fades.
    if (text.length > this.sample.textContent.length) this.setSample(text);
    clearTimeout(this.showTimer);
    clearTimeout(this.fadeTimer);
    clearTimeout(this.clearTimer);
    // Clear first so a repeated identical message is announced again.
    this.live.textContent = '';
    this.live.classList.remove('idle');
    this.showTimer = setTimeout(() => { this.live.textContent = text; }, 40);
    this.fadeTimer = setTimeout(() => this.live.classList.add('idle'), SHOW_MS);
    this.clearTimer = setTimeout(() => { this.live.textContent = ''; }, SHOW_MS + 600);
  }

  /**
   * Hide all chips and the message (chapter change), including one still due to appear; forget
   * their widths and the message slot's reservation.
   */
  clear() {
    this.update([]);
    this.resetWidths();
    clearTimeout(this.showTimer);
    clearTimeout(this.fadeTimer);
    clearTimeout(this.clearTimer);
    this.live.textContent = '';
    this.live.classList.add('idle');
    this.setSample('');
  }

  destroy() {
    this.clear();
    this.host.replaceChildren();
  }
}
