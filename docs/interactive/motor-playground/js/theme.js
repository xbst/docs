/**
 * Theme tokens for the canvas and SVG views (SPEC 4.9).
 *
 * The theme-sync IIFE copied from ../can-topology.html runs inline in
 * index.html's <head>: module scripts are deferred, and running it there lets
 * the right palette paint first. It mirrors the docs site's light/dark toggle
 * (or ?theme=, or a {pinconnectTheme} message) onto :root[data-theme]. This
 * module turns the resulting CSS custom properties into a plain object, so
 * views never query the DOM for colors.
 */

/** Tokens always read, even if stylesheet discovery fails (cross-origin, old browser). */
const BASE_TOKENS = [
  'bg', 'text', 'tip-bg', 'tip-border', 'tip-shadow', 'hs-hover', 'hs-stroke', 'hs-active',
  'hint-bg', 'hint-text', 'divider', 'line-color', 'label-color', 'desc-color', 'type-color',
  'ok', 'err', 'warn', 'pulse', 'scope-bg', 'scope-grid', 'scope-trace',
  'phase-a', 'phase-b', 'phase-c', 'axis-q', 'axis-d', 'target', 'rotor-n', 'rotor-s',
  'field', 'led-on', 'led-off', 'led-trip', 'muted', 'font-scale',
];

let tokenNames = null;

/** Every custom property declared on :root in same-origin stylesheets, plus BASE_TOKENS. */
function discoverTokens() {
  const names = new Set(BASE_TOKENS);
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && !rule.style) { walk(rule.cssRules); continue; }
      if (!rule.style || !rule.selectorText || !rule.selectorText.startsWith(':root')) continue;
      for (let i = 0; i < rule.style.length; i++) {
        const p = rule.style[i];
        if (p.startsWith('--')) names.add(p.slice(2));
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch (err) { /* cross-origin sheet (Google Fonts) */ }
  }
  return [...names];
}

const camel = (name) => name.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());

/** True when the widget currently shows its dark palette. */
export function isDark() {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Read all palette tokens into an object with camelCase keys
 * (`--phase-a` → `phaseA`, `--scope-bg` → `scopeBg`), plus:
 * `dark` (boolean), `fontScale` (number, 1.15 in fullscreen),
 * `fontUi` and `fontMono` (canvas font-family strings).
 * @returns {Object<string, *>}
 */
export function readTokens() {
  if (!tokenNames) tokenNames = discoverTokens();
  const cs = getComputedStyle(document.documentElement);
  const t = {};
  for (const name of tokenNames) t[camel(name)] = cs.getPropertyValue('--' + name).trim();
  t.fontScale = parseFloat(t.fontScale) || 1;
  t.dark = isDark();
  t.fontUi = 'Roboto, system-ui, sans-serif';
  t.fontMono = '"Roboto Mono", ui-monospace, monospace';
  return t;
}

/**
 * Resolve a color name from a trace or view spec against a token object.
 * Accepts 'phase-a', 'phaseA', '--phase-a' or a literal CSS color.
 * @param {Object} theme token object from readTokens()
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function tokenColor(theme, name, fallback) {
  if (!name) return fallback || theme.scopeTrace || theme.text;
  if (name[0] === '#' || name.startsWith('rgb') || name.startsWith('hsl')) return name;
  const key = camel(name.replace(/^--/, ''));
  return theme[key] || fallback || theme.scopeTrace || theme.text;
}

/**
 * Call `cb(tokens)` whenever the palette changes: the site toggle or ?theme=
 * (via :root[data-theme]) or the OS color scheme. Fires at most once per frame.
 * @param {(tokens: Object) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(cb) {
  let queued = 0;
  const fire = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => { queued = 0; cb(readTokens()); });
  };
  const mo = new MutationObserver(fire);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', fire);
  return () => {
    mo.disconnect();
    mq.removeEventListener('change', fire);
    if (queued) cancelAnimationFrame(queued);
  };
}
