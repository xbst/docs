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
 * Debounced height poster. After the first measurement, ease height changes
 * over 240 ms by posting intermediate heights (the shared pinout listener can
 * keep applying them directly). Reduced-motion users receive the final height
 * immediately. Posts only when embedded, never in fullscreen or at zero width
 * (inside a closed <details>), and only when the height changed by more than
 * 1 px. It measures at the iframe's full width: while the iframe
 * is still too short, a classic scrollbar narrows the page, and the phone
 * layout is shorter when narrower, so a height measured beside the scrollbar
 * would never make it go away.
 * @param {() => number} measure ideal content height in css px
 * @returns {{schedule: () => void, reset: () => void}} reset() forces the next post
 */
export function createHeightPoster(measure) {
  let last = 0, target = 0, timer = 0, frame = 0, from = 0, started = null;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const canPost = () => !isFullscreen() && document.documentElement.clientWidth > 0;
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    started = null;
  }
  function send(h, final = false) {
    if (!final && Math.abs(h - last) <= 1) return;
    last = h;
    try { window.parent.postMessage({ pinconnectHeight: h }, '*'); } catch (err) { /* parent gone */ }
  }
  function animate(now) {
    frame = 0;
    if (!canPost()) { target = 0; started = null; return; }
    if (motion.matches) { send(target, true); started = null; return; }
    if (started === null) started = now;
    const p = Math.min(1, (now - started) / 240);
    const eased = p * p * (3 - 2 * p);
    send(from + (target - from) * eased, p === 1);
    if (p < 1) frame = requestAnimationFrame(animate);
    else started = null;
  }
  function post() {
    const de = document.documentElement;
    if (!canPost()) { stop(); target = 0; return; }
    // body's overflow is the viewport's (html keeps overflow visible): hidden for one
    // synchronous layout, the scrollbar goes and the measure sees the full width
    const bar = window.innerWidth > de.clientWidth, st = document.body.style, ov = st.overflow;
    if (bar) st.overflow = 'hidden';
    let h;
    try { h = measure(); } finally { if (bar) st.overflow = ov; }
    if (!(h > 0)) return;
    // ResizeObservers fire again for each intermediate iframe height. Comparing
    // against the destination prevents those notifications restarting the ease.
    if (Math.abs(h - target) <= 1 && (frame || Math.abs(h - last) <= 1)) return;
    stop();
    target = h;
    if (!last || motion.matches) { send(h, true); return; }
    if (Math.abs(h - last) <= 1) return;
    from = last;
    frame = requestAnimationFrame(animate);
  }
  return {
    schedule() {
      if (!EMBEDDED || timer) return;
      timer = setTimeout(() => { timer = 0; post(); }, 30);
    },
    reset() { stop(); last = 0; target = 0; },
  };
}
