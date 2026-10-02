/**
 * Commanded and actual toolhead paths for the CoreXY gantry view.
 *
 * The trail reads the scope's trace rings (`posCmd#0/#1`, `posAct#0/#1` =
 * toolhead x and y in CoreXY) through the render ctx, so it sees every trace
 * sample between two frames, not only the snapshot at frame time. It keeps two
 * rings of (x cmd, y cmd, x act, y act) points in mm:
 *   - fine:   every trace sample (4096 points, about the last two seconds),
 *             drawn in the magnifier (loupe) around the toolhead;
 *   - coarse: a point whenever the commanded or the actual position moved
 *             0.25 mm (8192 points, about two meters of travel), drawn over
 *             the whole frame.
 * Without trace rings (an older main.js) it falls back to one snapshot point
 * per frame. Nothing here allocates after construction: the drawing methods
 * take their screen transform from setView() or a magnifier object and hand it
 * to the path functions in a shared scratch object, not in double arguments
 * (V8 boxes those whenever it does not inline the call).
 */

const FINE_N = 4096;
const COARSE_N = 8192;
const COARSE_MM2 = 0.25 * 0.25;
const KEYS = ['posCmd#0', 'posCmd#1', 'posAct#0', 'posAct#1'];
const DASH = [5, 4];
const SOLID = [];

export class PathTrail {
  constructor() {
    this.fine = new Float32Array(FINE_N * 4);
    this.fHead = 0;
    this.fLen = 0;
    this.coarse = new Float32Array(COARSE_N * 4);
    this.cHead = 0;
    this.cLen = 0;
    this.cTotal = 0;          // coarse points ever pushed (coarseId)
    this.lastT = -Infinity;
    // Snapshot time of the last update: a smaller one means a new world. (Ring times can be
    // Float32, rounded above the snapshot time, so lastT cannot tell.)
    this.snapT = -Infinity;
    this.map = null;
    this.rings = [null, null, null, null];
    // last coarse point
    this.pxc = 0; this.pyc = 0; this.pxa = 0; this.pya = 0;
    // the point pushPt() appends (x cmd, y cmd, x act, y act; mm), handed over here rather than
    // in double arguments
    this.pt = new Float64Array(4);
    // the frame's screen transform for draw() (setView)
    this.ox = 0; this.oy = 0; this.k = 1;
  }

  /**
   * Sets the frame's screen transform for draw(): screen x = ox + x·k, screen y = oy − y·k
   * (mm → css px). The gantry view sets it from its layout.
   * @param {number} ox @param {number} oy @param {number} k px per mm
   */
  setView(ox, oy, k) {
    this.ox = ox;
    this.oy = oy;
    this.k = k;
  }

  /**
   * Forget every point, and skip the samples the trace rings already hold: only samples
   * newer than the newest one at the time of the call are taken in afterwards.
   */
  clear() {
    this.reset();
    const r = this.rings[0];
    if (r && r.len > 0) this.lastT = r.t[ringIndex(r, r.len - 1)];
  }

  /** @private forget every point and read the next rings from their start (a new world) */
  reset() {
    this.fHead = 0; this.fLen = 0;
    this.cHead = 0; this.cLen = 0;
    this.lastT = -Infinity;
  }

  /**
   * Take in the samples since the last call (or since clear()). A snapshot time before the
   * last call's means a new world: its rings are read from the start.
   * @param {Object} snap world.snapshot (t, gantry)
   * @param {Map<string, Object>|null} traces world.traces (render ctx)
   */
  update(snap, traces) {
    if (snap.t < this.snapT) this.reset();
    this.snapT = snap.t;
    if (traces && traces !== this.map) {
      this.map = traces;
      for (let k = 0; k < 4; k++) this.rings[k] = traces.get(KEYS[k]) || null;
    }
    const r = this.rings;
    if (traces && r[0] && r[1] && r[2] && r[3] && r[0].len > 0) {
      const n = Math.min(r[0].len, r[1].len, r[2].len, r[3].len);
      const cap = r[0].cap;
      let base = r[0].head - r[0].len;
      if (base < 0) base += cap;
      // first logical index with t > lastT (binary search on ring 0's times)
      const T = r[0].t;
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        let p = base + mid;
        if (p >= cap) p -= cap;
        if (T[p] <= this.lastT) lo = mid + 1; else hi = mid;
      }
      if (lo < n) {
        const pt = this.pt;
        for (let i = lo; i < n; i++) {
          pt[0] = r[0].v[ringIndex(r[0], i)];
          pt[1] = r[1].v[ringIndex(r[1], i)];
          pt[2] = r[2].v[ringIndex(r[2], i)];
          pt[3] = r[3].v[ringIndex(r[3], i)];
          this.pushPt();
        }
        this.lastT = T[ringIndex(r[0], n - 1)];
        return;
      }
      if (this.lastT > -Infinity) return;       // no new samples (paused)
    }
    // Fallback: one snapshot point per frame.
    if (snap.t === this.lastT) return;
    this.lastT = snap.t;
    const gt = snap.gantry, pt = this.pt;
    pt[0] = gt.xCmd; pt[1] = gt.yCmd; pt[2] = gt.x; pt[3] = gt.y;
    this.pushPt();
  }

  /** @private append one point (mm) to the fine ring and, when it moved enough, to the coarse ring */
  push(xc, yc, xa, ya) {
    const pt = this.pt;
    pt[0] = xc; pt[1] = yc; pt[2] = xa; pt[3] = ya;
    this.pushPt();
  }

  /** @private push() of the point in `pt` (update's per-sample path: no double arguments to box) */
  pushPt() {
    const pt = this.pt, xc = pt[0], yc = pt[1], xa = pt[2], ya = pt[3];
    if (xc !== xc || yc !== yc || xa !== xa || ya !== ya) return;
    let p = this.fHead * 4;
    const f = this.fine;
    f[p] = xc; f[p + 1] = yc; f[p + 2] = xa; f[p + 3] = ya;
    this.fHead = (this.fHead + 1) % FINE_N;
    if (this.fLen < FINE_N) this.fLen++;
    if (this.cLen > 0) {
      const dc = (xc - this.pxc) * (xc - this.pxc) + (yc - this.pyc) * (yc - this.pyc);
      const da = (xa - this.pxa) * (xa - this.pxa) + (ya - this.pya) * (ya - this.pya);
      if (dc < COARSE_MM2 && da < COARSE_MM2) return;
    }
    const c = this.coarse;
    p = this.cHead * 4;
    c[p] = xc; c[p + 1] = yc; c[p + 2] = xa; c[p + 3] = ya;
    this.cHead = (this.cHead + 1) % COARSE_N;
    if (this.cLen < COARSE_N) this.cLen++;
    this.cTotal++;
    this.pxc = xc; this.pyc = yc; this.pxa = xa; this.pya = ya;
  }

  /**
   * Draw the coarse trail over the frame, in setView's transform: error shading, dashed
   * commanded path, solid actual path.
   * @param {CanvasRenderingContext2D} g
   * @param {Object} th theme
   * @param {{x: number, y: number, xCmd: number, yCmd: number}} [tip] the current point, appended to the paths
   */
  draw(g, th, tip) {
    P.ox = this.ox; P.oy = this.oy; P.k = this.k;
    P.width = 1.5; P.lim = -Infinity; P.cx = 0; P.cy = 0;
    drawPaths(g, th, this.coarse, this.cHead, this.cLen, COARSE_N, tip, ALL);
  }

  /**
   * Draw the trail inside a magnifier `M`: a circle of radius M.R css px centered on screen at
   * (M.cx, M.cy), showing (M.mx, M.my) mm at M.kl px per mm. The caller clips. `coarse` draws the
   * long coarse ring (a loupe held on a fixed point: several laps back) instead of the fine one.
   * @param {{cx: number, cy: number, R: number, mx: number, my: number, kl: number}} M
   */
  drawLoupe(g, th, M, tip, coarse) {
    magnify(M);
    if (coarse) drawPaths(g, th, this.coarse, this.cHead, this.cLen, COARSE_N, tip, ALL);
    else drawPaths(g, th, this.fine, this.fHead, this.fLen, FINE_N, tip, ALL);
  }

  /**
   * Logical index (0 = oldest) of the coarse point whose commanded position is nearest to
   * (x, y) mm, no farther than maxMm; −1 when none is. Laps that coincide give the newest.
   */
  nearest(x, y, maxMm) {
    const c = this.coarse, start = this.cHead - this.cLen;
    let best = -1, bd = maxMm * maxMm;
    for (let i = this.cLen - 1; i >= 0; i--) {
      let p = start + i;
      if (p < 0) p += COARSE_N;
      p *= 4;
      const dx = c[p] - x, dy = c[p + 1] - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Id of logical coarse index i: it stays with its point as the ring moves on. */
  coarseId(i) {
    return this.cTotal - this.cLen + i;
  }

  /** Logical coarse index of an id; −1 once its point has left the ring (or after clear()). */
  coarseIndex(id) {
    const i = id - (this.cTotal - this.cLen);
    return i >= 0 && i < this.cLen ? i : -1;
  }

  /**
   * Coarse index `mm` of commanded path away from logical index i, toward the newest points
   * (dir 1) or the oldest (−1), stopping at either end of the ring.
   */
  walk(i, dir, mm) {
    const c = this.coarse, start = this.cHead - this.cLen;
    const off = (j) => { let p = start + j; if (p < 0) p += COARSE_N; return p * 4; };
    let d = 0, j = i;
    while (d < mm) {
      const n = j + dir;
      if (n < 0 || n >= this.cLen) break;
      const a = off(j), b = off(n);
      d += Math.hypot(c[b] - c[a], c[b + 1] - c[a + 1]);
      j = n;
    }
    return j;
  }

  /** Commanded x (k 0) or y (k 1) of logical coarse index i, mm. */
  cmdAt(i, k) {
    let p = this.cHead - this.cLen + i;
    if (p < 0) p += COARSE_N;
    return this.coarse[p * 4 + k];
  }

  /**
   * As drawLoupe, for a magnifier that can sit anywhere on the frame (the gantry view's inspect
   * lens): the coarse trail (the laps back), then the fine actual path over it where the last
   * two seconds reach, so an overshoot a 0.25 mm step would skip still shows. The commanded path
   * comes from the coarse trail alone: drawn twice, its dashes would fill each other's gaps.
   */
  drawLens(g, th, M, tip) {
    magnify(M);
    drawPaths(g, th, this.coarse, this.cHead, this.cLen, COARSE_N, tip, ALL);
    drawPaths(g, th, this.fine, this.fHead, this.fLen, FINE_N, tip, ACTUAL);
  }
}

/** drawPaths parts: the error shading, the commanded path, the actual path. */
const SHADE = 1, COMMANDED = 2, ACTUAL = 4, ALL = SHADE | COMMANDED | ACTUAL;

/**
 * The path functions' parameters, set by the drawing methods before each drawPaths: the screen
 * transform (x = ox + mm·k, y = oy − mm·k), the actual path's line width, and the culling window
 * (lim > 0: only points within lim mm of (cx, cy)). Shared by every trail, like IDX.
 */
const P = { ox: 0, oy: 0, k: 1, width: 1.5, lim: -Infinity, cx: 0, cy: 0 };

/** P for magnifier M: its transform, 2 px paths, and the points within 1.4 radii of its center. */
function magnify(M) {
  const k = M.kl;
  P.ox = M.cx - M.mx * k;
  P.oy = M.cy + M.my * k;
  P.k = k;
  P.width = 2;
  P.lim = (M.R / k) * 1.4;
  P.cx = M.mx;
  P.cy = M.my;
}

/** Physical index of logical sample i (0 = oldest) of a ring buffer. */
function ringIndex(ring, i) {
  let p = ring.head - ring.len + i;
  if (p < 0) p += ring.cap;
  return p >= ring.cap ? p - ring.cap : p;
}

/** Scratch list of buffer offsets to draw (−1 = a break), shared by every trail. */
const IDX = new Int32Array(Math.max(FINE_N, COARSE_N) * 2 + 2);
const MIN_PX = 0.8;

/**
 * Picks the points to draw into IDX: points closer than MIN_PX on screen to the last kept one
 * (in both paths) are skipped, and with P.lim > 0 points whose commanded and actual positions
 * are both farther than P.lim mm from (P.cx, P.cy) are dropped, leaving a break (−1).
 * @returns {number} entries in IDX
 */
function pickPoints(buf, head, len, cap) {
  const lim = P.lim, cx = P.cx, cy = P.cy;
  const cull = lim > 0 && lim < Infinity;
  const start = head - len;
  const tol = MIN_PX / P.k;
  let n = 0, have = false, lxc = 0, lyc = 0, lxa = 0, lya = 0;
  for (let i = 0; i < len; i++) {
    let p = start + i;
    if (p < 0) p += cap;
    p *= 4;
    const xc = buf[p], yc = buf[p + 1], xa = buf[p + 2], ya = buf[p + 3];
    if (cull && (Math.abs(xc - cx) > lim || Math.abs(yc - cy) > lim) && (Math.abs(xa - cx) > lim || Math.abs(ya - cy) > lim)) {
      if (have) { IDX[n++] = -1; have = false; }
      continue;
    }
    if (have && i < len - 1 && Math.abs(xc - lxc) < tol && Math.abs(yc - lyc) < tol
      && Math.abs(xa - lxa) < tol && Math.abs(ya - lya) < tol) continue;
    IDX[n++] = p;
    have = true;
    lxc = xc; lyc = yc; lxa = xa; lya = ya;
  }
  return n;
}

/**
 * Shading between the paths, then the commanded (dashed) and actual (solid) polylines; `parts`
 * picks which (SHADE, COMMANDED, ACTUAL). Transform, line width and culling come from P.
 */
function drawPaths(g, th, buf, head, len, cap, tip, parts) {
  if (len < 1) return;
  const n = pickPoints(buf, head, len, cap);
  const k = P.k, width = P.width;
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  if (parts & SHADE) {
    // Error shading: one polygon per run of points whose error shows (> 0.6 px), out along the
    // commanded path and back along the actual one. Far fewer edges to raster than a quad per
    // sample, and the nonzero fill keeps a band whose sides cross as one area.
    const minErr2 = (0.6 / k) * (0.6 / k);
    g.fillStyle = th.field;
    g.globalAlpha = 0.2;
    g.beginPath();
    let run = -1;
    for (let j = 0; j <= n; j++) {
      let ok = false;
      const p = j < n ? IDX[j] : -1;
      if (p >= 0) {
        const dx = buf[p] - buf[p + 2], dy = buf[p + 1] - buf[p + 3];
        ok = dx * dx + dy * dy > minErr2;
      }
      if (ok) { if (run < 0) run = j; continue; }
      if (run >= 0 && j - 1 > run) bandPath(g, buf, run, j - 1);
      run = -1;
    }
    g.fill();
    g.globalAlpha = 1;
  }
  if (parts & COMMANDED) {
    // commanded path, dashed
    g.strokeStyle = th.target;
    g.lineWidth = width * 0.85;
    g.setLineDash(DASH);
    tracePath(g, buf, n, 0, tip);
    g.stroke();
    g.setLineDash(SOLID);
  }
  if (!(parts & ACTUAL)) return;
  // actual path, solid amber (over a gray rim on the light card, where amber alone is faint)
  tracePath(g, buf, n, 2, tip);
  if (!th.dark) {
    g.strokeStyle = th.lineColor;
    g.lineWidth = width + 1.6;
    g.globalAlpha = 0.55;
    g.stroke();
    g.globalAlpha = 1;
  }
  g.strokeStyle = th.field;
  g.lineWidth = width;
  g.stroke();
}

/** Closed band between IDX[j0..j1]: along the commanded points, back along the actual ones. */
function bandPath(g, buf, j0, j1) {
  const ox = P.ox, oy = P.oy, k = P.k;
  let p = IDX[j0];
  g.moveTo(ox + buf[p] * k, oy - buf[p + 1] * k);
  for (let j = j0 + 1; j <= j1; j++) { p = IDX[j]; g.lineTo(ox + buf[p] * k, oy - buf[p + 1] * k); }
  for (let j = j1; j >= j0; j--) { p = IDX[j]; g.lineTo(ox + buf[p + 2] * k, oy - buf[p + 3] * k); }
  g.closePath();
}

/**
 * Builds (does not stroke) one polyline through column pair `o` (0 = commanded, 2 = actual)
 * of the picked points, plus the live tip (its commanded or actual point).
 */
function tracePath(g, buf, n, o, tip) {
  const ox = P.ox, oy = P.oy, k = P.k;
  g.beginPath();
  let pen = false;
  for (let j = 0; j < n; j++) {
    const p = IDX[j];
    if (p < 0) { pen = false; continue; }
    const sx = ox + buf[p + o] * k, sy = oy - buf[p + o + 1] * k;
    if (pen) g.lineTo(sx, sy); else { g.moveTo(sx, sy); pen = true; }
  }
  if (!pen || !tip) return;
  const tx = o === 0 ? tip.xCmd : tip.x, ty = o === 0 ? tip.yCmd : tip.y;
  if (tx === tx && ty === ty) g.lineTo(ox + tx * k, oy - ty * k);
}
