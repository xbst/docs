/**
 * Motor Control Playground: bootstrap, router, chapter lifecycle, frame loop,
 * stage layout, fullscreen and embed height posting (SPEC 4.2, 4.3, 4.8, 4.10;
 * the generic fullscreen, postMessage and devicePixelRatio helpers live in embed.js).
 *
 * URL parameters: chapter=<id|number> (default 1), nav=0 (solo mode: no tabs,
 * an "Open the full playground" link), product=<key> (products.js; unknown =
 * generic), motor=stepper|bldc (initial motor type where allowed),
 * theme=dark|light (handled in index.html), paused=1, sim=fake (FakeWorld),
 * debug=1 (frame timing overlay).
 *
 * Chapter ctx (one object, kept for the session): { world, product, motorType,
 * app, highlight }. A chapter may set ctx.highlight (e.g. the loop whose slider
 * was touched); views receive it in their render ctx. The `app` object below
 * lists every method a chapter may call.
 *
 * Lifecycle: entering a chapter runs onLeave on the old one, scenario(type) →
 * world.configure (traceWindow merged in), builds the stage, onEnter, then
 * traces, panel text and controls. A motor-type change re-enters the same
 * chapter (onLeave, configure, onEnter) and re-renders the controls with their
 * values preserved; values the reader changed are sent through onChange again
 * so the reconfigured world matches the controls.
 */
import { CHAPTERS } from './chapters/index.js';
import { getView } from './views/index.js';
import { Scope } from './views/scope.js';
import { Readouts } from './views/readouts.js';
import { Controls } from './controls.js';
import { getProduct } from './products.js';
import { readTokens, onThemeChange } from './theme.js';
import { formatValue, timeScaleLabel } from './format.js';
import { EMBEDDED, canFullscreen, createHeightPoster, onFullscreenChange, toggleFullscreen, watchDevicePixelRatio } from './embed.js';

const params = new URLSearchParams(location.search);
const SOLO = params.get('nav') === '0';
const DEBUG = params.get('debug') === '1';
const MOBILE = matchMedia('(max-width: 720px)');
const STAGE_MIN = 280, STAGE_MAX = 540;
const TIME_NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 7];
const MOTOR_NAMES = { stepper: 'stepper', bldc: 'BLDC' };
const DEFAULT_HINT = 'Move the controls and watch the views and the scope. '
  + 'Hover, tap or use the scope\'s arrow keys to read values; select a legend entry to hide its trace.';
const EMPTY = [];

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), tb: $('tb'), tabs: $('tabs'), tabsel: $('tabsel'), prev: $('prev'), next: $('next'),
  motor: $('motor'), play: $('play'), time: $('time'), timeH: $('time-h'), slowed: $('slowed'),
  sound: $('sound'), openfull: $('openfull'), fs: $('fs'), fsOn: $('fs-on'), fsOff: $('fs-off'),
  stage: $('stage'), views: $('views'), viewsel: $('viewsel'), vhP: $('vh-primary'), vhS: $('vh-secondary'), vhStrip: $('vh-strip'),
  panel: $('panel'), pHead: $('p-head'), pLearn: $('p-learn'), pNum: $('p-num'), pTitle: $('p-title'), pTake: $('p-take'), pHint: $('p-hint'),
  pText: $('p-text'), pTry: $('p-try'), pTryList: $('p-try-list'), pCtl: $('p-ctl'), pDeep: $('p-deep'), pDeepBody: $('p-deep-body'),
  scope: $('scope'), ro: $('ro'),
};

/* ---------------- state ---------------- */
const product = getProduct(params.get('product'));
let world = null;
let ch = null, chIndex = -1;
let preferredMotor = params.get('motor') === 'bldc' ? 'bldc' : 'stepper';
let paused = params.get('paused') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
let timeScale = 1, tsRange = { min: 1, max: 1 }, tsSteps = [1];
let traceWindow = 2;
let hintOverride = null;
let hintHold = null;       // { w, h }: the hint's tallest height at width w in this chapter visit
let stageSpec = null;
const views = [];          // { slot, name, host, view, aspect, w, h, dpr }

const ctx = { world: null, product, motorType: preferredMotor, app: null, highlight: null };
// View render ctx (SPEC 4.5, plus `traces` = world.traces for views that read sub-frame
// history, such as the gantry's path trails, and `product` for config-key captions).
const renderCtx = { theme: readTokens(), motorType: preferredMotor, chapterId: '', highlight: null, t: 0, metrics: null,
  traces: null, product };

const scope = new Scope(el.scope);
const readouts = new Readouts(el.ro);
const controls = new Controls(el.pCtl, ctx);

/* ---------------- app API for chapters ---------------- */
const app = {
  /** Ordered chapter list. */
  chapters: CHAPTERS,
  /** Per-frame step caps (SPEC 4.2); lower them from the console to test the "slowed" badge. */
  maxSteps: { averaged: 2000, switching: 20000 },
  get chapter() { return ch; },
  get paused() { return paused; },
  get timeScale() { return timeScale; },
  get traceWindow() { return traceWindow; },
  get world() { return world; },
  /** Re-render the chapter's controls from controls(ctx); values preserved by id. */
  refreshControls() { renderControls(false); schedulePost(); },
  /**
   * Re-run scenario(ctx.motorType) → world.configure (traceWindow merged in),
   * e.g. when a chapter control switches the driver or the motor preset.
   * This resets the world; issue any commands (runPath, jog) afterwards.
   */
  reconfigure() { configureWorld(); scope.invalidate(); requestFrame(); },
  /** Re-render text(ctx), tryThis and deeper(ctx). */
  refreshText() { renderText(); schedulePost(); },
  /** Re-read the chapter's traces (an array, or a function of ctx); legend-hidden ones stay hidden. */
  refreshTraces() { scope.setTraces(resolveTraces()); },
  /** Scope window in sim seconds; the world re-derives its trace decimation. */
  setTraceWindow(seconds) {
    if (!(seconds > 0)) return;
    traceWindow = seconds;
    try { world.set('traceWindow', seconds); } catch (err) { console.error('[playground] world.set(traceWindow) failed', err); }
    scope.setWindow(seconds);
  },
  /**
   * Sim seconds per real second. `range` ({min, max}) replaces the toolbar
   * slider range; a value outside the range widens it.
   */
  setTimeScale(x, range) {
    if (!(x > 0)) return;
    if (range) tsRange = { min: range.min || x, max: range.max || x };
    tsRange = { min: Math.min(tsRange.min, x), max: Math.max(tsRange.max, x) };
    setTimeScaleValue(x);
    syncTimeSlider();
  },
  pause() { setPaused(true); },
  play() { setPaused(false); },
  /** Go to a chapter by id ('pi-loops'), number (8) or chapter object. */
  goto(target) {
    const i = typeof target === 'object' && target ? CHAPTERS.indexOf(target) : resolveChapter(String(target), -1);
    if (i >= 0) gotoIndex(i);
    else console.warn('[playground] goto: unknown chapter', target);
  },
  /** Announce a short message (aria-live, shown briefly in the readouts strip). */
  announce(text) { announce(text); },
  /** Set a control's value without firing its onChange. */
  setControlValue(id, value) { controls.setValue(id, value); },
  /** Current value of a control. */
  getControlValue(id) { return controls.getValue(id); },
  /** Pass options to every mounted view with this stage name (calls view.setOptions). */
  setViewOptions(name, opts) {
    for (const v of views) {
      if (v.name !== name) continue;
      try { v.view.setOptions(opts); } catch (err) { console.error(`[playground] ${name}.setOptions failed`, err); }
    }
  },
  /** Mounted views: [{ slot, name, view }]. */
  get views() { return views.map((v) => ({ slot: v.slot, name: v.name, view: v.view })); },
  /** Same as setting ctx.highlight (e.g. 'velocity' lights that loop in the block diagram). */
  setHighlight(h) { ctx.highlight = h == null ? null : h; },
  /** Replace the hint under the takeaway for this chapter visit (null restores the chapter's hint). */
  setHint(text) { hintOverride = text == null ? null : String(text); renderHint(); },
  /** Switch the motor type if the chapter allows it (same as the toolbar). */
  setMotorType(type) { preferredMotor = type; setMotorType(type); },
  /**
   * Show the toolbar sound button and wire it (chunk 08).
   * @param {(ev: MouseEvent) => void} onClick
   * @returns {HTMLButtonElement}
   */
  registerSoundButton(onClick) {
    el.sound.hidden = false;
    if (typeof onClick === 'function') el.sound.addEventListener('click', onClick);
    fitTabs();
    schedulePost();
    return el.sound;
  },
};
ctx.app = app;

/* ---------------- helpers ---------------- */
const reported = new Set();
function reportOnce(key, err) {
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[playground] ${key} failed:`, err);
}

function hook(name, ...args) {
  const fn = ch && ch[name];
  if (typeof fn !== 'function') return undefined;
  try { return fn.apply(ch, args); } catch (err) { console.error(`[playground] ${ch.id}.${name} failed:`, err); }
  return undefined;
}

function allowedTypes(c) {
  const t = c && Array.isArray(c.motorTypes) && c.motorTypes.length ? c.motorTypes : ['stepper'];
  return t.filter((x) => x === 'stepper' || x === 'bldc');
}

/** Chapter index for an id or number; `fallback` when there is no match. */
function resolveChapter(key, fallback = 0) {
  if (key == null || key === '') return fallback;
  const n = Number(key);
  if (Number.isInteger(n)) {
    const i = CHAPTERS.findIndex((c) => c.number === n);
    if (i >= 0) return i;
  }
  const i = CHAPTERS.findIndex((c) => c.id === key);
  return i >= 0 ? i : fallback;
}

function resolveTraces() {
  const t = typeof ch.traces === 'function' ? hook('traces', ctx) : ch.traces;
  return Array.isArray(t) ? t : EMPTY;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/* ---------------- world ---------------- */
async function createWorld(kind) {
  if (kind !== 'fake') {
    // Covers sim/world.js and its world-only modules. presets.js and drivers/foc.js (with units,
    // transforms, biquad) are static imports of chapters and views: a failure there stops main.js.
    try {
      const mod = await import('./sim/world.js');
      return new mod.World();
    } catch (err) {
      console.error('[playground] the simulation failed to load; using the synthetic FakeWorld instead.', err);
    }
  }
  const mod = await import('./sim/fake.js');
  return new mod.FakeWorld();
}

function configureWorld() {
  let sc = {};
  const out = hook('scenario', ctx.motorType);
  if (out && typeof out === 'object') sc = Object.assign({}, out);
  if (sc.motorType == null) sc.motorType = ctx.motorType;
  if (sc.traceWindow == null) sc.traceWindow = traceWindow;
  try { world.configure(sc); } catch (err) { console.error('[playground] world.configure failed:', err); }
  stepDebt = 0;
}

/* ---------------- toolbar ---------------- */
function buildToolbar() {
  CHAPTERS.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = `${c.number}. ${c.title}`;
    const sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = 'Chapter ';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(c.number);
    b.append(sr, n, document.createTextNode(' ' + (c.short || c.title)));
    b.addEventListener('click', () => gotoIndex(i));
    el.tabs.append(b);
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.number}. ${c.title}`;
    el.tabsel.append(o);
  });
  el.tabsel.addEventListener('change', () => gotoIndex(+el.tabsel.value));
  el.prev.addEventListener('click', () => gotoIndex(chIndex - 1));
  el.next.addEventListener('click', () => gotoIndex(chIndex + 1));
  el.motor.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-motor]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    preferredMotor = b.dataset.motor;
    setMotorType(b.dataset.motor);
  });
  el.play.addEventListener('click', () => setPaused(!paused));
  el.time.addEventListener('input', () => {
    const v = tsSteps[+el.time.value];
    if (v) setTimeScaleValue(v);
  });
  el.fs.addEventListener('click', () => toggleFullscreen(standaloneUrl));
  el.viewsel.addEventListener('change', () => {
    el.stage.setAttribute('data-mobile-view', el.viewsel.value);
    requestFrame();
    schedulePost();
  });
  // the new-tab fallback is iframe-only: a standalone page without fullscreen (iPhone Safari) would open a copy of itself
  el.fs.hidden = !EMBEDDED && !canFullscreen();
  if (SOLO) {
    el.app.classList.add('solo');
    el.openfull.hidden = false;
  }
}

function updateToolbar() {
  const tabs = el.tabs.children;
  for (let i = 0; i < tabs.length; i++) {
    if (i === chIndex) tabs[i].setAttribute('aria-current', 'step');
    else tabs[i].removeAttribute('aria-current');
  }
  el.tabsel.value = String(chIndex);
  const prev = CHAPTERS[chIndex - 1], next = CHAPTERS[chIndex + 1];
  // aria-disabled, not disabled, like the motor buttons: the arrow just pressed to reach
  // either end keeps keyboard focus (gotoIndex ignores a press past the end).
  el.prev.setAttribute('aria-disabled', String(!prev));
  el.next.setAttribute('aria-disabled', String(!next));
  el.prev.setAttribute('aria-label', prev ? `Previous chapter: ${prev.title}` : 'Previous chapter');
  el.next.setAttribute('aria-label', next ? `Next chapter: ${next.title}` : 'Next chapter');
  el.prev.title = prev ? `${prev.number}. ${prev.title}` : '';
  el.next.title = next ? `${next.number}. ${next.title}` : '';
  const allowed = allowedTypes(ch);
  const only = allowed.map((t) => MOTOR_NAMES[t]).join(' and ');
  for (const b of el.motor.querySelectorAll('button[data-motor]')) {
    const t = b.dataset.motor, ok = allowed.includes(t);
    b.setAttribute('aria-pressed', String(t === ctx.motorType));
    b.setAttribute('aria-disabled', String(!ok));
    b.title = ok ? '' : `This chapter uses ${only} motors only`;
  }
  updatePlayButton();
  updateOpenFull();
  fitTabs();
}

function updatePlayButton() {
  el.play.innerHTML = paused ? '&#9654; Play' : '&#10074;&#10074; Pause';
  el.play.setAttribute('aria-label', paused ? 'Play the simulation' : 'Pause the simulation');
}

/** Tabs when they fit on their row, the chapter select otherwise (always the select at <= 720 px). */
function fitTabs() {
  if (SOLO) return;
  el.app.classList.remove('tabs-collapsed');
  if (MOBILE.matches) return;
  const over = el.tabs.scrollWidth > el.tabs.clientWidth + 1;
  if (over) el.app.classList.add('tabs-collapsed');
}

/* ---------------- time scale ---------------- */
function buildTimeSteps(min, max, current) {
  const out = [min, max, current];
  const k0 = Math.floor(Math.log10(min)), k1 = Math.ceil(Math.log10(max));
  for (let k = k0; k <= k1; k++) {
    for (const m of TIME_NICE) {
      const v = +(m * Math.pow(10, k)).toPrecision(4);
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push(v);
    }
  }
  out.sort((a, b) => a - b);
  return out.filter((v, i) => i === 0 || v > out[i - 1] * (1 + 1e-6));
}

function syncTimeSlider() {
  tsSteps = buildTimeSteps(tsRange.min, tsRange.max, timeScale);
  let best = 0;
  for (let i = 1; i < tsSteps.length; i++) {
    if (Math.abs(Math.log(tsSteps[i] / timeScale)) < Math.abs(Math.log(tsSteps[best] / timeScale))) best = i;
  }
  el.time.max = String(tsSteps.length - 1);
  el.time.value = String(best);
  el.time.disabled = tsSteps.length < 2;
  // Room for the longest step's label (monospace), so moving the slider or a chapter's own switch
  // (chapter 1's Pulse zoom) cannot rewrap the toolbar and change an embed's height (B-006).
  let longest = 0;
  for (const v of tsSteps) longest = Math.max(longest, timeScaleLabel(v).length);
  el.timeH.style.minWidth = `max(11.5em, ${longest}ch)`;
  showTimeLabel();
}

function setTimeScaleValue(x) {
  timeScale = x;
  scope.setTimeScale(x);
  showTimeLabel();
}

function showTimeLabel() {
  const label = timeScaleLabel(timeScale);
  el.timeH.textContent = label;
  el.time.setAttribute('aria-valuetext', label);
  el.time.setAttribute('aria-label', 'Time scale');
}

function setPaused(p) {
  p = !!p;
  if (p === paused) return;
  paused = p;
  stepDebt = 0;
  scope.setPaused(paused);
  updatePlayButton();
  requestFrame();
}

/* ---------------- chapter lifecycle ---------------- */
function gotoIndex(i) {
  if (i < 0 || i >= CHAPTERS.length || i === chIndex) return;
  enterChapter(i);
}

function enterChapter(index) {
  if (ch) hook('onLeave', ctx);
  chIndex = index;
  ch = CHAPTERS[index];
  const allowed = allowedTypes(ch);
  ctx.motorType = allowed.includes(preferredMotor) ? preferredMotor : allowed[0];
  ctx.highlight = null;
  hintOverride = null;
  hintHold = null;
  const ts = ch.timeScale || {};
  const def = ts.default > 0 ? ts.default : 1;
  tsRange = { min: Math.min(ts.min > 0 ? ts.min : def, def), max: Math.max(ts.max > 0 ? ts.max : def, def) };
  timeScale = def;
  traceWindow = ch.traceWindow > 0 ? ch.traceWindow : 2;
  scope.setWindow(traceWindow);
  scope.setTimeScale(timeScale);
  configureWorld();
  buildStage();
  readouts.clear();
  controls.reset();
  el.pDeep.open = false;     // "More info" starts closed; the explanation keeps the reader's choice (open in index.html)
  el.panel.scrollTop = 0;   // phones scroll the page: in fullscreen, where Next is sticky, open at the title
  if (MOBILE.matches && document.documentElement.classList.contains('is-fs')) window.scrollTo(0, 0);
  hook('onEnter', ctx);
  scope.setTraces(resolveTraces(), { keepHidden: false });
  renderPanel();
  renderControls(false);
  syncTimeSlider();
  updateToolbar();
  updateReadouts();
  updateUrl();
  updateFitStage();
  schedulePost();
  requestFrame();
}

function setMotorType(type) {
  if (!ch || type === ctx.motorType || !allowedTypes(ch).includes(type)) return;
  hook('onLeave', ctx);
  ctx.motorType = type;
  ctx.highlight = null;
  configureWorld();
  hook('onEnter', ctx);
  scope.setTraces(resolveTraces());
  renderText();
  renderControls(true);
  updateToolbar();
  updateReadouts();
  updateUrl();
  scope.invalidate();
  schedulePost();
  requestFrame();
}

/* ---------------- stage ---------------- */
const resizeObs = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const v = views.find((x) => x.host === entry.target);
    if (v) sizeView(v);
  }
});

function buildStage() {
  for (const v of views) {
    resizeObs.unobserve(v.host);
    try { v.view.destroy(); } catch (err) { console.error(`[playground] ${v.name}.destroy failed:`, err); }
    v.host.replaceChildren();
  }
  views.length = 0;
  stageSpec = Object.assign({ primary: 'placeholder', secondary: null, split: 0.55, strip: null, aspect: null }, ch.stage);
  const split = Math.min(0.85, Math.max(0.15, +stageSpec.split || 0.55));
  stageSpec.split = split;
  el.stage.classList.toggle('has-sec', !!stageSpec.secondary);
  el.stage.style.setProperty('--split-basis', `calc(${(split * 100).toFixed(2)}% - 4px)`);
  mountView('primary', el.vhP, stageSpec.primary);
  if (stageSpec.secondary) mountView('secondary', el.vhS, stageSpec.secondary);
  else el.vhS.hidden = true;
  if (stageSpec.strip) mountView('strip', el.vhStrip, stageSpec.strip);
  else el.vhStrip.hidden = true;
  const labels = { gantry: 'Carriage', motor: 'Motor', vector: 'Current vectors',
    blocks: 'Control loops', chart: 'Torque and speed', schematic: 'Driver circuit' };
  el.viewsel.replaceChildren(...views.map((v) => {
    const option = document.createElement('option');
    option.value = v.slot;
    option.textContent = labels[v.name] || cap(v.name);
    return option;
  }));
  el.viewsel.value = 'primary';
  el.stage.setAttribute('data-mobile-view', 'primary');
  el.stage.classList.toggle('multi-view', views.length > 1);
  renderCtx.chapterId = ch.id;
}

function mountView(slot, host, name) {
  host.hidden = false;
  host.setAttribute('aria-label', `${cap(name)} view`);
  const View = getView(name);
  const opts = Object.assign({ name, slot, chapterId: ch.id }, ch.viewOptions && ch.viewOptions[name]);
  let view;
  try { view = new View(host, opts); } catch (err) {
    console.error(`[playground] view "${name}" failed to start:`, err);
    return;
  }
  // viewOptions.<name>.aspect (height/width) overrides the view's own preferred aspect, e.g. a
  // taller gantry host for a square CoreXY frame (desktop stage height and mobile host height).
  const aspect = opts.aspect > 0 ? +opts.aspect : View.aspect > 0 ? View.aspect : 0.75;
  host.style.setProperty('--ar', String(aspect));
  const v = { slot, name, host, view, aspect, w: 0, h: 0, dpr: 0 };
  views.push(v);
  resizeObs.observe(host);
  sizeView(v);
}

function sizeView(v) {
  const w = v.host.clientWidth, h = v.host.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w === v.w && h === v.h && dpr === v.dpr) return;
  v.w = w; v.h = h; v.dpr = dpr;
  if (w > 0 && h > 0) {
    try { v.view.resize(w, h, dpr); } catch (err) { reportOnce(`${v.name}.resize`, err); }
  }
}

/** Desktop stage height for the chapter's layout: views at their preferred aspect, clamped. */
function desiredStageHeight() {
  const W = el.views.clientWidth;
  const gap = parseFloat(getComputedStyle(el.views).columnGap) || 8;
  let h = STAGE_MIN;
  if (W > 0 && stageSpec) {
    if (stageSpec.aspect > 0) h = W * stageSpec.aspect;
    else {
      h = 0;
      for (const v of views) {
        if (v.slot === 'strip') continue;
        const w = v.slot === 'primary'
          ? (stageSpec.secondary ? (W - gap) * stageSpec.split : W)
          : (W - gap) * (1 - stageSpec.split);
        h = Math.max(h, w * v.aspect);
      }
    }
    h = Math.min(STAGE_MAX, Math.max(STAGE_MIN, h));
  }
  if (stageSpec && stageSpec.strip && !el.vhStrip.hidden) {
    const rowGap = parseFloat(getComputedStyle(el.stage).rowGap) || 8;
    h += el.vhStrip.getBoundingClientRect().height + rowGap;
  }
  return h;
}

/* ---------------- panel ---------------- */
function renderPanel() {
  el.pNum.textContent = `Chapter ${ch.number} of ${CHAPTERS.length}`;
  el.pTitle.textContent = ch.title;
  el.pTake.textContent = ch.takeaway || '';
  el.pTake.hidden = !ch.takeaway;
  renderText();
}

function renderText() {
  const text = typeof ch.text === 'function' ? hook('text', ctx) : ch.text;
  el.pText.innerHTML = text || '';
  const tries = typeof ch.tryThis === 'function' ? hook('tryThis', ctx) : ch.tryThis;
  const list = Array.isArray(tries) ? tries : EMPTY;
  el.pTryList.replaceChildren(...list.map((t) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.innerHTML = t;
    li.append(span);
    return li;
  }));
  el.pTry.hidden = !list.length;
  const deep = typeof ch.deeper === 'function' ? hook('deeper', ctx) : ch.deeper;
  el.pDeep.hidden = !deep;
  el.pDeepBody.innerHTML = deep || '';
  renderHint();
}

function renderHint() {
  let hint = hintOverride;
  if (hint == null) hint = typeof ch.hint === 'function' ? hook('hint', ctx) : ch.hint;
  el.pHint.textContent = hint == null ? DEFAULT_HINT : hint;
  holdHint();
}

/**
 * The hint keeps the tallest height its texts have had in this chapter visit, so a longer one
 * coming and going (chapter 4's slow-homing hint, chapter 6's loop modes) does not move every
 * row below it or change an embed's height. A new width or font measures it again.
 */
function holdHint() {
  const w = el.pHint.clientWidth;
  if (!hintHold || hintHold.w !== w) {
    hintHold = { w, h: 0 };
    el.pHint.style.minHeight = '';
  }
  const h = el.pHint.getBoundingClientRect().height;
  if (h > hintHold.h) {
    hintHold.h = h;
    el.pHint.style.minHeight = `${h}px`;
  }
}

function renderControls(reapply) {
  let specs = EMPTY;
  if (typeof ch.controls === 'function') {
    try { specs = ch.controls(ctx) || EMPTY; } catch (err) { console.error(`[playground] ${ch.id}.controls failed:`, err); }
  }
  controls.render(specs, { reapply });
}

function updateReadouts() {
  let items = EMPTY;
  if (typeof ch.readouts === 'function') {
    try { items = ch.readouts(world.snapshot, world.metrics, ctx) || EMPTY; } catch (err) { reportOnce(`${ch.id}.readouts`, err); }
  }
  readouts.update(items);
}

/* ---------------- events ---------------- */
const EVENT_TEXT = {
  stepLost: (d) => 'Steps lost' + (d && d.mm ? `: ${formatValue(d.mm)} mm` : ''),
  stallDetected: () => 'Stall detected',
  contact: () => 'The carriage reached the stop',
  homingDone: () => 'Homing done',
  homingNoEdge: () => 'Homing failed: the status output was already high',
  sweepDone: () => 'Sweep done',
};
let lastAnnounce = '', lastAnnounceT = -Infinity;

function announce(text) {
  if (!text) return;
  const now = performance.now();
  if (text === lastAnnounce && now - lastAnnounceT < 1500) return;
  lastAnnounce = text;
  lastAnnounceT = now;
  readouts.announce(String(text));
}

function drainEvents(snap) {
  const a = snap && snap.events;
  if (a && a.length) drain(a);
  const b = world.events;
  if (b && b !== a && b.length) drain(b);
}

function drain(list) {
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    let text;
    if (typeof ch.onEvent === 'function') {
      try {
        const r = ch.onEvent(ev, ctx);
        if (r === false) continue;
        if (typeof r === 'string') text = r;
      } catch (err) { reportOnce(`${ch.id}.onEvent`, err); }
    }
    if (text === undefined) text = EVENT_TEXT[ev.type] ? EVENT_TEXT[ev.type](ev.data) : '';
    if (text) announce(text);
  }
  list.length = 0;
}

/* ---------------- frame loop ---------------- */
let rafId = 0, lastNow = 0, stepDebt = 0, slowedUntil = 0, slowedShown = false, lastReadout = 0, capRate = 0;
let pageVisible = !document.hidden, inView = true, hasSize = true;

function isIdle() { return !world || !ch || !pageVisible || !inView || !hasSize; }

function requestFrame() {
  if (!rafId && !isIdle()) rafId = requestAnimationFrame(frame);
}

function frame(now) {
  rafId = 0;
  if (isIdle()) { lastNow = 0; return; }
  rafId = requestAnimationFrame(frame);
  const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.1) : 0;
  lastNow = now;
  const t0 = DEBUG ? performance.now() : 0;
  const n = !paused && dt > 0 ? advance(dt, now) : 0;
  const t1 = DEBUG ? performance.now() : 0;
  draw(now);
  if (DEBUG) debugStats(now, n, t1 - t0, performance.now() - t1);
}

/** Step the world by frameDt × timeScale sim seconds, capped per SPEC 4.2. */
function advance(dt, now) {
  const wdt = world.dt;
  if (!(wdt > 0)) return 0;
  stepDebt += dt * timeScale / wdt;
  let n = Math.floor(stepDebt);
  const capSteps = wdt < 5e-6 ? app.maxSteps.switching : app.maxSteps.averaged;
  const capped = n > capSteps;
  if (capped) {
    n = capSteps;
    stepDebt = 0;
  } else {
    stepDebt -= n;
  }
  // Badge only for sustained capping (about 3 frames in a row), not one long frame.
  capRate = capRate * 0.9 + (capped ? 0.1 : 0);
  if (capRate > 0.25) slowedUntil = now + 1000;
  for (let i = 0; i < n; i++) world.step();
  return n;
}

function draw(now) {
  const snap = world.snapshot;
  renderCtx.t = snap ? snap.t : 0;
  renderCtx.metrics = world.metrics;
  renderCtx.traces = world.traces;
  renderCtx.highlight = ctx.highlight;
  renderCtx.motorType = ctx.motorType;
  for (let i = 0; i < views.length; i++) {
    const v = views[i];
    if (!v.w || !v.h) continue;
    try { v.view.render(snap, renderCtx); } catch (err) { reportOnce(`${v.name}.render`, err); }
  }
  try { scope.render(world); } catch (err) { reportOnce('scope.render', err); }
  if (now - lastReadout >= 100) { lastReadout = now; updateReadouts(); }
  if (typeof ch.onFrame === 'function') {
    try { ch.onFrame(ctx, snap); } catch (err) { reportOnce(`${ch.id}.onFrame`, err); }
  }
  drainEvents(snap);
  const slowed = now < slowedUntil;
  // a class on the time group, not `hidden`: the toolbar keeps the badge's cell reserved at every width
  if (slowed !== slowedShown) { slowedShown = slowed; el.slowed.parentNode.classList.toggle('is-slowed', slowed); }
}

/* idle: hidden page, scrolled out of view, or zero width (inside a closed <details>) */
document.addEventListener('visibilitychange', () => {
  pageVisible = !document.hidden;
  // A hidden page runs no frames, so the one queued before hiding runs only on return:
  // restart the frame clock so it steps nothing instead of a stale 0.1 s.
  lastNow = 0;
  stepDebt = 0;
  requestFrame();
});
new IntersectionObserver((entries) => {
  inView = entries[entries.length - 1].isIntersecting;
  requestFrame();
}).observe(el.app);
new ResizeObserver(() => {
  hasSize = document.documentElement.clientWidth > 0;
  requestFrame();
  fitTabs();
  holdHint();   // the root is the shallowest element: changes below it cause no observer loop
  updateFitStage();
  schedulePost();
}).observe(document.documentElement);
// Desktop .app fills the iframe and the stage absorbs row changes: watch the rows idealHeight() sums.
const heightObs = new ResizeObserver(() => { scheduleFit(); schedulePost(); });
for (const row of [el.app, el.tb, el.pHead, el.scope, el.ro, el.pLearn]) heightObs.observe(row);

/* ---------------- debug overlay (?debug=1) ---------------- */
let dbg = null, dbgAcc = { frames: 0, steps: 0, sim: 0, draw: 0, since: 0 };
function debugStats(now, n, simMs, drawMs) {
  if (!dbg) {
    dbg = document.createElement('div');
    dbg.className = 'dbg';
    document.body.append(dbg);
    dbgAcc.since = now;
  }
  dbgAcc.frames++; dbgAcc.steps += n; dbgAcc.sim += simMs; dbgAcc.draw += drawMs;
  if (now - dbgAcc.since >= 500) {
    const f = dbgAcc.frames;
    dbg.textContent = `${Math.round(f * 1000 / (now - dbgAcc.since))} fps  steps/frame ${Math.round(dbgAcc.steps / f)}\n`
      + `sim ${(dbgAcc.sim / f).toFixed(2)} ms  draw ${(dbgAcc.draw / f).toFixed(2)} ms`;
    dbgAcc = { frames: 0, steps: 0, sim: 0, draw: 0, since: now };
  }
}

/* ---------------- URLs ---------------- */
function buildUrl(solo) {
  const p = new URLSearchParams();
  p.set('chapter', ch.id);
  if (product.key !== 'generic') p.set('product', product.key);
  if (ctx.motorType !== allowedTypes(ch)[0]) p.set('motor', ctx.motorType);
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) p.set('theme', theme);
  if (params.get('sim')) p.set('sim', params.get('sim'));
  if (solo) p.set('nav', '0');
  return location.pathname + '?' + p.toString();
}

function updateUrl() {
  const p = new URLSearchParams(location.search);
  p.set('chapter', ch.id);
  if (ctx.motorType !== allowedTypes(ch)[0]) p.set('motor', ctx.motorType);
  else p.delete('motor');
  try { history.replaceState(history.state, '', location.pathname + '?' + p.toString() + location.hash); } catch (err) { /* sandboxed */ }
}

/** Solo mode's "Open the full playground" link, with the current chapter, motor and theme. */
function updateOpenFull() { if (SOLO && ch) el.openfull.href = buildUrl(false); }

/* ---------------- fullscreen and auto-height (SPEC 4.10; helpers in embed.js) ---------------- */
const standaloneUrl = () => new URL(buildUrl(false), location.href).href;
const poster = createHeightPoster(() => (ch ? idealHeight() : 0));
function schedulePost() { poster.schedule(); }

onFullscreenChange((fs) => {
  document.documentElement.classList.toggle('is-fs', fs);
  el.fsOn.hidden = fs;
  el.fsOff.hidden = !fs;
  el.fs.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Enter fullscreen');
  el.fs.title = fs ? 'Exit fullscreen' : 'Fullscreen';
  applyTheme();
  fitTabs();
  updateFitStage();
  if (!fs) { poster.reset(); schedulePost(); }
});

/**
 * Desktop: padding + toolbar + chapter head (title, takeaway, hint) + the
 * stage height this chapter wants + scope + readouts + explanation + gaps
 * (the stage is the only flexible row). Mobile: the natural height of the
 * one-column layout. (documentElement.scrollHeight never shrinks below the
 * current iframe height, so the .app box is measured.)
 */
function idealHeight() {
  if (MOBILE.matches) return Math.ceil(el.app.getBoundingClientRect().height);
  const cs = getComputedStyle(el.app);
  const gap = parseFloat(cs.rowGap) || 0;
  let h = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  let rows = 1;
  h += desiredStageHeight();
  for (const part of [el.tb, el.pHead, el.scope, el.ro, el.pLearn]) {
    if (getComputedStyle(part).display === 'none') continue;
    h += part.getBoundingClientRect().height;
    rows++;
  }
  return Math.ceil(h + gap * (rows - 1));
}

/*
 * Standalone and fullscreen desktop pages: the stage height the layout gives with the
 * explanation closed (the viewport less the padding, the other rows and the gaps). The
 * explanation is open by default, and playground.css keeps the stage at this height while it
 * is open, so its text extends the page below the fold instead of squeezing the views.
 */
let fitTimer = 0;
function updateFitStage() {
  if (MOBILE.matches || (EMBEDDED && !document.documentElement.classList.contains('is-fs'))) return;
  const cs = getComputedStyle(el.app);
  const gap = parseFloat(cs.rowGap) || 0;
  let h = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  let rows = 1;
  for (const part of [el.tb, el.pHead, el.scope, el.ro, el.pLearn]) {
    if (getComputedStyle(part).display === 'none') continue;
    h += part === el.pLearn ? closedLearnHeight() : part.getBoundingClientRect().height;
    rows++;
  }
  const fit = Math.max(0, document.documentElement.clientHeight - h - gap * (rows - 1));
  el.app.style.setProperty('--fit-stage', `${fit}px`);
}

/** For the row observers: set inside their callback, --fit-stage could resize .app, a shallower element (an observer loop). */
function scheduleFit() {
  if (!fitTimer) fitTimer = setTimeout(() => { fitTimer = 0; updateFitStage(); }, 0);
}

/** The explanation's height when closed: its summary line plus the card's padding and border. */
function closedLearnHeight() {
  const cs = getComputedStyle(el.pLearn), summary = el.pLearn.querySelector('summary');
  return (summary ? summary.getBoundingClientRect().height : 0)
    + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
}

/* ---------------- theme ---------------- */
function applyTheme(tokens) {
  const t = tokens || readTokens();
  renderCtx.theme = t;
  scope.setTheme(t);
  readouts.resetWidths();   // fonts loaded or fullscreen: the chips measure their widths again
  hintHold = null;          // and the hint its height
  holdHint();
  updateOpenFull();   // the link carries theme=, which the docs page may have just switched
  requestFrame();
}
onThemeChange((t) => applyTheme(t));

/* ---------------- start ---------------- */
async function init() {
  document.documentElement.classList.toggle('is-standalone', !EMBEDDED);   // SPEC 4.9's solid page background
  buildToolbar();
  scope.setPaused(paused);
  applyTheme();
  world = await createWorld(params.get('sim'));
  ctx.world = world;
  window.MotorPlayground = { app, world };
  enterChapter(resolveChapter(params.get('chapter')));
  watchDevicePixelRatio(() => { for (const v of views) sizeView(v); scope.measure(); requestFrame(); });
  window.addEventListener('resize', () => { fitTabs(); schedulePost(); });
  MOBILE.addEventListener('change', () => { fitTabs(); schedulePost(); });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { applyTheme(); fitTabs(); schedulePost(); });
  }
  window.addEventListener('load', () => { applyTheme(); schedulePost(); });
}

init();
