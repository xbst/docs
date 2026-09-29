/**
 * Embedding helpers (SPEC 4.10): fullscreen with a new-tab fallback inside an
 * iframe, and auto-height posting to the pinout_embed listener on the docs
 * page, which resizes the iframe when the widget posts {pinconnectHeight: N}.
 * What N is depends on the layout, so main.js passes in the measuring function.
 * Also a devicePixelRatio watcher for resizing the canvases (SPEC 4.5).
 */

/** True when the widget runs inside an iframe. */
export const EMBEDDED = window.parent !== window;

/** True while the document (or an element in it) is fullscreen. */
export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/** Whether this document may go fullscreen (false on iPhone Safari and in iframes without permission). */
export function fullscreenAvailable() {
  return 'fullscreenEnabled' in document ? !!document.fullscreenEnabled : !!document.webkitFullscreenEnabled;
}

/**
 * Whether toggleFullscreen can request fullscreen here: it is available and
 * documentElement has a request method (standard or webkit-prefixed).
 * @returns {boolean}
 */
export function canFullscreen() {
  const root = document.documentElement;
  return fullscreenAvailable() && !!(root.requestFullscreen || root.webkitRequestFullscreen);
}

/**
 * Toggle fullscreen on documentElement. Inside an iframe, where fullscreen is
 * not possible (canFullscreen) or the request is refused, open `fallbackUrl()`
 * in a new tab instead. A standalone page has nowhere better to go, so it does
 * nothing (main.js hides the button there when canFullscreen() is false).
 * @param {() => string} fallbackUrl absolute URL of the standalone widget
 */
export function toggleFullscreen(fallbackUrl) {
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const open = () => { if (EMBEDDED) window.open(fallbackUrl(), '_blank', 'noopener'); };
  if (!canFullscreen()) { open(); return; }
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  try {
    const p = request.call(root);
    if (p && typeof p.catch === 'function') p.catch(open);
  } catch (err) {
    open();
  }
}

/**
 * Run `cb(isFullscreen())` whenever fullscreen starts or ends (Esc included).
 * @param {(fullscreen: boolean) => void} cb
 */
export function onFullscreenChange(cb) {
  const fire = () => cb(isFullscreen());
  document.addEventListener('fullscreenchange', fire);
  document.addEventListener('webkitfullscreenchange', fire);
}

/**
 * Run `onChange()` after every devicePixelRatio change (a window moved to
 * another monitor, a zoomed fixed-width docs page). A ratio change without a
 * css size change reaches no ResizeObserver, so this watches a
 * `(resolution: <dpr>dppx)` media query and re-arms it for each new ratio
 * (before calling `onChange`, so a throwing callback does not end the watch).
 * @param {() => void} onChange
 */
export function watchDevicePixelRatio(onChange) {
  const arm = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      .addEventListener('change', () => { arm(); onChange(); }, { once: true });
  };
  arm();
}

/**
 * Debounced height poster. Posts only when embedded, never in fullscreen or
 * at zero width (inside a closed <details>), and only when the height changed
 * by more than 1 px.
 * @param {() => number} measure ideal content height in css px
 * @returns {{schedule: () => void, reset: () => void}} reset() forces the next post
 */
export function createHeightPoster(measure) {
  let last = 0, timer = 0;
  function post() {
    if (isFullscreen() || document.documentElement.clientWidth === 0) return;
    const h = measure();
    if (!(h > 0) || Math.abs(h - last) <= 1) return;
    last = h;
    try { window.parent.postMessage({ pinconnectHeight: h }, '*'); } catch (err) { /* parent gone */ }
  }
  return {
    schedule() {
      if (!EMBEDDED || timer) return;
      timer = setTimeout(() => { timer = 0; post(); }, 30);
    },
    reset() { last = 0; },
  };
}
