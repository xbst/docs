/**
 * Declarative controls renderer (SPEC 4.4). A chapter's `controls(ctx)`
 * returns an array of specs; this module turns them into grouped, keyboard-
 * operable DOM controls inside the panel.
 *
 * Common fields: `id` (unique within the chapter), `label`, `group` (heading;
 * controls without one come first, ungrouped), `disabled`, `title` (tooltip),
 * `caption` (a config key shown under the control in Roboto Mono; pass
 * `ctx.product.keys.X`, which is undefined for the generic profile).
 *
 *   slider:    { type:'slider', id, label, min, max, step, value, unit, log:false,
 *                format:(v)=>string, live:true, onChange:(v, ctx)=>void }
 *              `log:true` maps the track on log10 (min > 0); `step` then only
 *              rounds the value. `live:false` fires onChange on release only.
 *   segmented: { type:'segmented', id, label, options:[{value, label, disabled, title}], value, onChange }
 *   toggle:    { type:'toggle', id, label, value, onChange }
 *   button:    { type:'button', id, label, kind:'primary'|'normal', onClick:(ctx)=>void }
 *   select:    { type:'select', id, label, options:[{value, label, disabled}] | [value, …], value, onChange }
 *   note:      { type:'note', html }
 *
 * Values are preserved by id across re-renders (refreshControls, motor-type
 * change) unless the chapter passes a different `value` than it did last time.
 * With `{reapply:true}` (used after a motor-type change reconfigures the world)
 * every preserved value that differs from the chapter's value is sent through
 * its onChange again, so the world matches what the controls show.
 */
import { formatValue } from './format.js';

const PREFIX = 'ctl-';

const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function decimalsOf(step) {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

function roundTo(v, step) {
  if (!(step > 0)) return v;
  return +(Math.round(v / step) * step).toFixed(decimalsOf(step));
}

const normOptions = (opts) => (opts || []).map((o) => (o !== null && typeof o === 'object')
  ? o : { value: o, label: String(o) });

/** Renders and tracks the controls of the current chapter. */
export class Controls {
  /**
   * @param {HTMLElement} host panel element the controls render into
   * @param {Object} ctx chapter ctx passed to onChange/onClick
   */
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    /** @type {Map<string, {spec: *, value: *}>} */
    this.memory = new Map();
    /** @type {Map<string, {set: (v: *) => void, el: HTMLElement}>} */
    this.items = new Map();
    this.gen = 0;
  }

  /** Forget preserved values (called on chapter change). */
  reset() { this.memory.clear(); }

  /** Remove all controls and forget preserved values. */
  clear() { this.reset(); this.items.clear(); this.host.replaceChildren(); }

  /**
   * Build the controls from specs, replacing the previous ones.
   * @param {Array<Object>} specs
   * @param {{reapply?: boolean}} [opts]
   */
  render(specs, opts) {
    const reapply = !!(opts && opts.reapply);
    const gen = ++this.gen;
    const active = document.activeElement;
    const focusId = active && active !== document.body && this.host.contains(active) ? active.id : null;
    this.items.clear();
    const frag = document.createDocumentFragment();
    const groups = new Map();
    const pending = [];
    for (const spec of specs || []) {
      if (!spec || !BUILD[spec.type]) {
        if (spec) console.warn('[playground] unknown control type:', spec.type);
        continue;
      }
      const key = spec.group || '';
      let g = groups.get(key);
      if (!g) {
        g = el('div', 'cg');
        if (key) {
          const h = el('h2', 'p-h', key);
          h.id = PREFIX + 'g' + groups.size;
          g.setAttribute('role', 'group');
          g.setAttribute('aria-labelledby', h.id);
          g.append(h);
        }
        groups.set(key, g);
        frag.append(g);
      }
      let value = spec.value;
      if (spec.id != null && HAS_VALUE[spec.type]) {
        const mem = this.memory.get(spec.id);
        if (mem && same(mem.spec, spec.value)) value = mem.value;
        this.memory.set(spec.id, { spec: spec.value, value });
        if (reapply && mem && !same(value, spec.value) && spec.onChange) pending.push([spec, value]);
      }
      const item = BUILD[spec.type](spec, value, this);
      if (spec.title) item.el.title = spec.title;
      g.append(item.el);
      if (spec.id != null) this.items.set(String(spec.id), item);
    }
    this.host.replaceChildren(frag);
    if (focusId) {
      const f = document.getElementById(focusId);
      if (f) f.focus({ preventScroll: true });
    }
    for (const [spec, v] of pending) {
      if (this.gen !== gen) break;     // an onChange re-rendered the controls (a preset): stop here
      this.fire(spec.onChange, v);
    }
  }

  /**
   * Set a control's value without calling its onChange.
   * @param {string} id
   * @param {*} value
   */
  setValue(id, value) {
    const item = this.items.get(String(id));
    const mem = this.memory.get(id);
    if (mem) mem.value = value;
    if (item) item.set(value);
  }

  /** Current value of a control (preserved or last set). */
  getValue(id) {
    const mem = this.memory.get(id);
    return mem ? mem.value : undefined;
  }

  /** @private record a user change */
  store(id, value) {
    if (id == null) return;
    const mem = this.memory.get(id);
    if (mem) mem.value = value;
    else this.memory.set(id, { spec: undefined, value });
  }

  /** @private call a chapter handler; errors are logged, never thrown into the DOM event */
  fire(fn, ...args) {
    if (typeof fn !== 'function') return;
    try { fn(...args, this.ctx); } catch (err) { console.error('[playground] control handler failed:', err); }
  }
}

const HAS_VALUE = { slider: true, segmented: true, toggle: true, select: true };

function wrap(spec, kind) {
  const w = el('div', 'ctl ' + kind + (spec.disabled ? ' disabled' : ''));
  return w;
}

function addCaption(w, spec, describedEl, id) {
  if (!spec.caption) return;
  const c = el('div', 'cap', spec.caption);
  c.id = id + '-c';
  w.append(c);
  if (describedEl) describedEl.setAttribute('aria-describedby', c.id);
}

const BUILD = {
  slider(spec, value, C) {
    const id = PREFIX + spec.id;
    const w = wrap(spec, 'slider');
    const head = el('div', 'ctl-h');
    const lab = el('label', null, spec.label);
    lab.htmlFor = id;
    const out = el('output');
    out.htmlFor = id;
    head.append(lab, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    const min = +spec.min, max = +spec.max;
    const log = !!spec.log && min > 0 && max > min;
    if (log) {
      const a = Math.log10(min), b = Math.log10(max);
      input.min = String(a);
      input.max = String(b);
      input.step = String(spec.logStep || (b - a) / 200);
    } else {
      input.min = String(min);
      input.max = String(max);
      input.step = spec.step > 0 ? String(spec.step) : 'any';
    }
    input.disabled = !!spec.disabled;
    const fmt = typeof spec.format === 'function' ? spec.format
      : (v) => (log && !(spec.step > 0) ? formatValue(v) : formatValue(v, decimalsOf(spec.step)))
        + (spec.unit ? ' ' + spec.unit : '');
    const toRaw = (v) => (log ? Math.log10(Math.min(max, Math.max(min, v))) : v);
    const fromRaw = (r) => {
      if (!log) return +r;
      const v = Math.pow(10, +r);
      return spec.step > 0 ? roundTo(v, spec.step) : +v.toPrecision(3);
    };
    let current = value;
    const show = (v) => {
      const s = fmt(v);
      out.textContent = s;
      input.setAttribute('aria-valuetext', s);
    };
    const set = (v) => { current = v; input.value = String(toRaw(v)); show(v); };
    set(value);
    input.addEventListener('input', () => {
      const v = fromRaw(input.value);
      if (same(v, current)) return;
      current = v;
      show(v);
      C.store(spec.id, v);
      if (spec.live !== false) C.fire(spec.onChange, v);
    });
    if (spec.live === false) input.addEventListener('change', () => C.fire(spec.onChange, current));
    w.append(head, input);
    addCaption(w, spec, input, id);
    return { el: w, set };
  },

  segmented(spec, value, C) {
    const id = PREFIX + spec.id;
    const w = wrap(spec, 'segmented');
    const head = el('div', 'ctl-h');
    const lab = el('span', 'ctl-l', spec.label);
    lab.id = id + '-l';
    head.append(lab);
    const box = el('div', 'pills');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', lab.id);
    box.id = id;
    const options = normOptions(spec.options);
    const buttons = options.map((o) => {
      const b = el('button', null, o.label != null ? o.label : String(o.value));
      b.type = 'button';
      b.disabled = !!(o.disabled || spec.disabled);
      if (o.title) b.title = o.title;
      b.addEventListener('click', () => {
        if (same(current, o.value)) return;
        set(o.value);
        C.store(spec.id, o.value);
        C.fire(spec.onChange, o.value);
      });
      box.append(b);
      return b;
    });
    let current = value;
    const set = (v) => {
      current = v;
      options.forEach((o, i) => buttons[i].setAttribute('aria-pressed', String(same(o.value, v))));
    };
    set(value);
    w.append(head, box);
    addCaption(w, spec, box, id);
    return { el: w, set };
  },

  toggle(spec, value, C) {
    const id = PREFIX + spec.id;
    const w = wrap(spec, 'toggle');
    const b = el('button', 'sw');
    b.type = 'button';
    b.id = id;
    b.setAttribute('role', 'switch');
    b.disabled = !!spec.disabled;
    const track = el('span', 'sw-t');
    track.setAttribute('aria-hidden', 'true');
    const lab = el('span', null, spec.label);
    lab.id = id + '-l';
    b.setAttribute('aria-labelledby', lab.id);
    b.append(track, lab);
    let current = !!value;
    const set = (v) => { current = !!v; b.setAttribute('aria-checked', String(current)); };
    set(value);
    b.addEventListener('click', () => {
      set(!current);
      C.store(spec.id, current);
      C.fire(spec.onChange, current);
    });
    w.append(b);
    addCaption(w, spec, b, id);
    return { el: w, set };
  },

  button(spec, value, C) {
    const w = wrap(spec, 'button');
    const b = el('button', 'btn' + (spec.kind === 'primary' ? ' primary' : ''), spec.label);
    b.type = 'button';
    if (spec.id != null) b.id = PREFIX + spec.id;
    b.disabled = !!spec.disabled;
    if (spec.ariaLabel) b.setAttribute('aria-label', spec.ariaLabel);
    b.addEventListener('click', () => C.fire(spec.onClick));
    w.append(b);
    return { el: w, set: () => {} };
  },

  select(spec, value, C) {
    const id = PREFIX + spec.id;
    const w = wrap(spec, 'select');
    const head = el('div', 'ctl-h');
    const lab = el('label', null, spec.label);
    lab.htmlFor = id;
    head.append(lab);
    const sel = document.createElement('select');
    sel.id = id;
    sel.disabled = !!spec.disabled;
    const options = normOptions(spec.options);
    options.forEach((o, i) => {
      const op = el('option', null, o.label != null ? o.label : String(o.value));
      op.value = String(i);
      op.disabled = !!o.disabled;
      sel.append(op);
    });
    const set = (v) => {
      const i = options.findIndex((o) => same(o.value, v));
      sel.value = String(i >= 0 ? i : 0);
    };
    set(value);
    sel.addEventListener('change', () => {
      const o = options[+sel.value];
      if (!o) return;
      C.store(spec.id, o.value);
      C.fire(spec.onChange, o.value);
    });
    if (spec.label) w.append(head);
    w.append(sel);
    addCaption(w, spec, sel, id);
    return { el: w, set };
  },

  note(spec) {
    const w = wrap(spec, 'note-w');
    const n = el('div', 'note');
    n.innerHTML = spec.html || '';
    w.append(n);
    return { el: w, set: () => {} };
  },
};
