/**
 * Readout chips and LEDs (SPEC 4.7), styled like the CAN widget's `.stat`
 * chips, plus one polite live region that announces events (stall detected,
 * steps lost, homing done) and shows them briefly as a pill.
 *
 * Item: { label, value, unit, warn, ok, led: 'on'|'off'|'trip', title, digits }
 *   value: number (formatted to ~3 significant digits, or `digits` decimals) or string.
 *   warn / ok: tint the chip (warn wins). led: prepend an LED dot.
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
    // Real spaces for screen readers; flex layout ignores whitespace-only text.
    chip.append(led, lbl, ' ', val, ' ', unit);
    this.list.append(chip);
    return { el: chip, led, lbl, val, unit, cls: 'chip', ledState: '', hidden: false, title: '' };
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
      setText(c.val, formatValue(it.value, it.digits));
      setText(c.unit, it.unit || '');
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
    }
  }

  /**
   * Announce a short event message to screen readers and show it briefly.
   * @param {string} text
   */
  announce(text) {
    if (!text) return;
    clearTimeout(this.fadeTimer);
    clearTimeout(this.clearTimer);
    // Clear first so a repeated identical message is announced again.
    this.live.textContent = '';
    this.live.classList.remove('idle');
    setTimeout(() => { this.live.textContent = text; }, 40);
    this.fadeTimer = setTimeout(() => this.live.classList.add('idle'), SHOW_MS);
    this.clearTimer = setTimeout(() => { this.live.textContent = ''; }, SHOW_MS + 600);
  }

  /** Hide all chips and the message (chapter change). */
  clear() {
    this.update([]);
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
