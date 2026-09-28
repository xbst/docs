/**
 * Readout chips and LEDs (SPEC 4.7), styled like the CAN widget's `.stat`
 * chips, plus one polite live region that announces events (stall detected,
 * steps lost, homing done) and shows them briefly as a pill.
 *
 * Item: { label, value, unit, warn, ok, led: 'on'|'off'|'trip', title, digits, bar }
 *   value: number (formatted to ~3 significant digits, or `digits` decimals) or string.
 *   unit: text after the value; a leading "%" or "°" attaches to the number ("85% of target").
 *   warn / ok: tint the chip (warn wins). led: prepend an LED dot.
 *   bar: { value, max, mark, low, off } appends a small level bar (chunk 05, the StallGuard
 *     reading): filled to value/max, a tick at mark/max (e.g. the DIAG threshold), red while
 *     `low`, empty and gray while `off` (no reading). Decorative (aria-hidden); the value text
 *     carries the number.
 * Up to 8 chips; they wrap on desktop and scroll sideways on mobile. DOM nodes
 * are reused and only touched when their text or state changes.
 */
import { formatValue } from '../format.js';

const MAX_CHIPS = 8;
const SHOW_MS = 4000;

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export class Readouts {
  /** @param {HTMLElement} host the readouts strip element */
  constructor(host) {
    this.host = host;
    this.list = document.createElement('div');
    this.list.className = 'chips';
    this.live = document.createElement('div');
    this.live.className = 'live idle';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    host.append(this.list, this.live);
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
    return { el: chip, led, lbl, val, unit, bar, fill, mark, barKey: '', cls: 'chip', ledState: '', hidden: false, title: '' };
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
      if (c.hidden) { c.el.hidden = false; c.hidden = false; }
      setText(c.lbl, it.label || '');
      // "%" and "°" attach to the number (US style: 85%, 66°; dropped when there is no number);
      // the rest of the unit follows.
      const unit = it.unit || '';
      const sym = unit[0] === '%' || unit[0] === '°' ? unit[0] : '';
      const numeric = typeof it.value === 'number' && Number.isFinite(it.value);
      setText(c.val, formatValue(it.value, it.digits) + (numeric ? sym : ''));
      const rest = sym ? unit.slice(1).trim() : unit;
      setText(c.unit, rest);
      if (c.unit.hidden !== !rest) c.unit.hidden = !rest;
      const cls = 'chip' + (it.warn ? ' warn' : it.ok ? ' ok' : '');
      if (c.cls !== cls) { c.el.className = cls; c.cls = cls; }
      const led = it.led || '';
      if (c.ledState !== led) {
        c.led.hidden = !led;
        c.led.className = 'led' + (led && led !== 'off' ? ' ' + led : '');
        c.ledState = led;
      }
      const title = it.title || '';
      if (c.title !== title) { c.el.title = title; c.title = title; }
      this.setBar(c, it.bar);
    }
  }

  /**
   * Announce a short event message to screen readers and show it briefly.
   * @param {string} text
   */
  announce(text) {
    if (!text) return;
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

  /** Hide all chips and the message (chapter change), including one still due to appear. */
  clear() {
    this.update([]);
    clearTimeout(this.showTimer);
    clearTimeout(this.fadeTimer);
    clearTimeout(this.clearTimer);
    this.live.textContent = '';
    this.live.classList.add('idle');
  }

  destroy() {
    this.clear();
    this.host.replaceChildren();
  }
}
