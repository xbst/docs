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
 * per frame. Nothing here allocates after construction.
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
    this.lastT = -Infinity;
    this.map = null;
    this.rings = [null, null, null, null];
    // last coarse point
    this.pxc = 0; this.pyc = 0; this.pxa = 0; this.pya = 0;
  }

  /** Forget every point. */
  clear() {
    this.fHead = 0; this.fLen = 0;
    this.cHead = 0; this.cLen = 0;
    this.lastT = -Infinity;
  }

  /**
   * Take in the samples since the last call.
   * @param {Object} snap world.snapshot (t, gantry)
   * @param {Map<string, Object>|null} traces world.traces (render ctx)
   */
  update(snap, traces) {
    if (snap.t < this.lastT) this.clear();
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
        for (let i = lo; i < n; i++) {
          const p0 = ringIndex(r[0], i), p1 = ringIndex(r[1], i), p2 = ringIndex(r[2], i), p3 = ringIndex(r[3], i);
          this.push(r[0].v[p0], r[1].v[p1], r[2].v[p2], r[3].v[p3]);
        }
        this.lastT = T[ringIndex(r[0], n - 1)];
        return;
      }
      if (this.lastT > -Infinity) return;       // no new samples (paused)
    }
    // Fallback: one snapshot point per frame.
    if (snap.t === this.lastT) return;
    this.lastT = snap.t;
    const gt = snap.gantry;
    this.push(gt.xCmd, gt.yCmd, gt.x, gt.y);
  }

  /** @private append one point to the fine ring and, when it moved enough, to the coarse ring */
  push(xc, yc, xa, ya) {
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
    this.pxc = xc; this.pyc = yc; this.pxa = xa; this.pya = ya;
  }

  /**
   * Draw the coarse trail: error shading, dashed commanded path, solid actual path.
   * Screen x = ox + x·k, screen y = oy − y·k (mm → css px).
   * @param {CanvasRenderingContext2D} g
   * @param {Object} th theme
   * @param {number} ox @param {number} oy @param {number} k px per mm
   * @param {{x: number, y: number, xCmd: number, yCmd: number}} [tip] the current point, appended to the paths
   */
  draw(g, th, ox, oy, k, tip) {
    drawPaths(g, th, this.coarse, this.cHead, this.cLen, COARSE_N, ox, oy, k, 1.5, tip, -Infinity, 0, 0);
  }

  /**
   * Draw the fine trail inside a circle of radius `rPx` around (cxMm, cyMm) at `k` px/mm,
   * centered on screen at (sx, sy). The caller clips.
   */
  drawLoupe(g, th, sx, sy, cxMm, cyMm, k, rPx, tip) {
    const ox = sx - cxMm * k, oy = sy + cyMm * k;
    const lim = (rPx / k) * 1.4;
    drawPaths(g, th, this.fine, this.fHead, this.fLen, FINE_N, ox, oy, k, 2, tip, lim, cxMm, cyMm);
  }
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
 * (in both paths) are skipped, and with `lim` > 0 points whose commanded and actual positions
 * are both farther than lim mm from (cx, cy) are dropped, leaving a break (−1).
 * @returns {number} entries in IDX
 */
function pickPoints(buf, head, len, cap, k, lim, cx, cy) {
  const cull = lim > 0 && lim < Infinity;
  const start = head - len;
  const tol = MIN_PX / k;
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
 * Shading between the paths, then the commanded (dashed) and actual (solid) polylines.
 * `lim` > 0 draws only the points within lim mm of (cx, cy) (loupe culling).
 */
function drawPaths(g, th, buf, head, len, cap, ox, oy, k, width, tip, lim, cx, cy) {
  if (len < 1) return;
  const n = pickPoints(buf, head, len, cap, k, lim, cx, cy);
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
    if (run >= 0 && j - 1 > run) bandPath(g, buf, run, j - 1, ox, oy, k);
    run = -1;
  }
  g.fill();
  g.globalAlpha = 1;
  // commanded path, dashed
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  g.strokeStyle = th.target;
  g.lineWidth = width * 0.85;
  g.setLineDash(DASH);
  strokeTrail(g, buf, n, 0, ox, oy, k, tip ? tip.xCmd : NaN, tip ? tip.yCmd : NaN);
  g.setLineDash(SOLID);
  // actual path, solid amber
  g.strokeStyle = th.field;
  g.lineWidth = width;
  strokeTrail(g, buf, n, 2, ox, oy, k, tip ? tip.x : NaN, tip ? tip.y : NaN);
}

/** Closed band between IDX[j0..j1]: along the commanded points, back along the actual ones. */
function bandPath(g, buf, j0, j1, ox, oy, k) {
  let p = IDX[j0];
  g.moveTo(ox + buf[p] * k, oy - buf[p + 1] * k);
  for (let j = j0 + 1; j <= j1; j++) { p = IDX[j]; g.lineTo(ox + buf[p] * k, oy - buf[p + 1] * k); }
  for (let j = j1; j >= j0; j--) { p = IDX[j]; g.lineTo(ox + buf[p + 2] * k, oy - buf[p + 3] * k); }
  g.closePath();
}

/** One polyline through column pair `o` (0 = commanded, 2 = actual) of the picked points, plus the live tip. */
function strokeTrail(g, buf, n, o, ox, oy, k, tx, ty) {
  g.beginPath();
  let pen = false;
  for (let j = 0; j < n; j++) {
    const p = IDX[j];
    if (p < 0) { pen = false; continue; }
    const sx = ox + buf[p + o] * k, sy = oy - buf[p + o + 1] * k;
    if (pen) g.lineTo(sx, sy); else { g.moveTo(sx, sy); pen = true; }
  }
  if (pen && tx === tx && ty === ty) g.lineTo(ox + tx * k, oy - ty * k);
  g.stroke();
}
