// Quadrature encoder model (SPEC 5.4, chunk-02 design section 7).
//
//   count = floor(θm·cpr/2π)              (unbounded integer; cpr = 4 × lines)
//   thetaMeas = (count + 0.5)·2π/cpr      (center of the count cell: within half a count
//                                          of θm, no systematic lag)
//   A/B from count mod 4 with the gray sequence A = [0,1,1,0], B = [0,0,1,1]
//
// Speed is estimated from edge times, the way drives do with hardware edge capture (the
// M/T method): each step that changes the count records the time of the last edge it
// crossed (count·2π/cpr moving up, (count + 1)·2π/cpr moving down, also when one step
// crosses several counts), interpolated inside the step from the shaft angle, in a ring
// of the last 32 edges. On every edge, omegaEst = (count change)·(2π/cpr)/(time between edges), measured
// from the newest edge back to the first older edge at least windowS earlier (or the
// oldest one stored). Between edges the estimate is held; once the time since the newest
// edge exceeds max(windowS, 1.5 × the last edge interval), |omegaEst| is bounded by one
// count per elapsed time, so a stopped rotor decays toward zero instead of holding a stale
// speed. The result is unfiltered; the FOC velocity filter smooths it.

const TWO_PI = 2 * Math.PI;
const EDGE_RING = 32;

/**
 * Incremental encoder with A/B levels and an edge-timed (M/T) speed estimate.
 *
 * Fields: `cpr` (counts per revolution), `count` (int, unbounded), `a`, `b` (0 | 1),
 * `thetaMeas` (rad, cell center), `omegaEst` (rad/s), `dt` (s), `windowS` (s),
 * `windowSteps` (int, windowS/dt rounded; informational), `t` (s since reset),
 * `edgeT`/`edgeC` (ring of the last 32 edge times and counts), `head` (newest slot),
 * `len` (edges stored), `lastInterval` (s between the two newest edges, 0 if unknown).
 * The per-step path passes no double arguments (a call V8 does not inline boxes them): the
 * world writes the shaft angle into `inThetaM` and calls updateInputs(), which hands the angle
 * to _setCount and the edge time to _pushEdge in fields too (`inThetaM`, `tEdge`).
 */
export class Encoder {
  constructor() {
    /** @type {number} counts per revolution */ this.cpr = 4000;
    /** @type {number} [s] */ this.dt = 40e-6;
    /** @type {number} speed window [s] */ this.windowS = 1e-3;
    /** @type {number} window length in steps (derived, informational) */ this.windowSteps = 25;
    /** @type {number} */ this.count = 0;
    /** @type {number} 0 | 1 */ this.a = 0;
    /** @type {number} 0 | 1 */ this.b = 0;
    /** @type {number} [rad] */ this.thetaMeas = 0;
    /** @type {number} [rad/s] */ this.omegaEst = 0;
    /** @type {number} rad per count */ this.radPerCount = TWO_PI / 4000;
    /** @type {number} time since reset [s] */ this.t = 0;
    /** @type {number} shaft angle at the previous update [rad] */ this.thetaPrev = 0;
    /** @type {number} count at the previous update */ this.countPrev = 0;
    /** @type {Float64Array} edge times [s] */ this.edgeT = new Float64Array(EDGE_RING);
    /** @type {Float64Array} count after each edge */ this.edgeC = new Float64Array(EDGE_RING);
    /** @type {number} slot of the newest edge */ this.head = 0;
    /** @type {number} edges stored (0..32) */ this.len = 0;
    /** @type {number} time between the two newest edges [s]; 0 if unknown */ this.lastInterval = 0;
    /** @type {number} shaft angle for updateInputs()/_setCount() [rad] */ this.inThetaM = 0;
    /** @type {number} time of the edge _pushEdge stores [s] */ this.tEdge = 0;
    this._derive();
  }

  /**
   * Sets the resolution, the sim step and the speed window. Call reset() after.
   * @param {object} opts
   * @param {number} [opts.cpr=4000] counts per revolution (4 × lines)
   * @param {number} [opts.dt=40e-6] sim step [s]
   * @param {number} [opts.windowS=1e-3] minimum time span of the speed estimate [s]
   */
  configure({ cpr = 4000, dt = 40e-6, windowS = 1e-3 } = {}) {
    this.cpr = Math.max(1, Math.round(cpr));
    this.dt = dt > 0 ? +dt : 40e-6;
    this.windowS = windowS > 0 ? +windowS : 1e-3;
    this._derive();
    this.reset(this.thetaPrev);
  }

  /** Recomputes the derived fields. */
  _derive() {
    this.radPerCount = TWO_PI / this.cpr;
    this.windowSteps = Math.max(1, Math.round(this.windowS / this.dt));
  }

  /**
   * Sets the count from an angle, clears the edge ring and zeroes the estimate.
   * @param {number} [thetaM=0] mechanical angle [rad]
   */
  reset(thetaM = 0) {
    this.inThetaM = thetaM;
    this._setCount();
    this.t = 0;
    this.thetaPrev = thetaM;
    this.countPrev = this.count;
    this.edgeT.fill(0);
    this.edgeC.fill(0);
    this.head = 0;
    this.len = 0;
    this.lastInterval = 0;
    this.omegaEst = 0;
  }

  /**
   * Samples the shaft once per sim step (advances the clock by dt). Does not allocate.
   * @param {number} thetaM mechanical angle [rad]
   */
  update(thetaM) {
    this.inThetaM = thetaM;
    this.updateInputs();
  }

  /** update() on the angle already in `inThetaM`: the world's per-step path. Does not allocate. */
  updateInputs() {
    const thetaM = this.inThetaM;
    const tPrev = this.t;
    const t = tPrev + this.dt;
    this.t = t;
    this._setCount();
    const c0 = this.countPrev, c1 = this.count;
    const rpc = this.radPerCount;
    if (c1 !== c0) {
      // Time of the last edge crossed in this step, interpolated on the angle. Moving up,
      // the last edge is the lower bound of cell c1; moving down, it is the upper bound
      // of cell c1, (c1 + 1)·rpc (equal to c0·rpc only for a single-count step).
      const thEdge = (c1 > c0 ? c1 : c1 + 1) * rpc;
      const dTh = thetaM - this.thetaPrev;
      let tEdge = dTh !== 0 ? tPrev + this.dt * (thEdge - this.thetaPrev) / dTh : t;
      if (!(tEdge >= tPrev)) tEdge = tPrev;
      else if (tEdge > t) tEdge = t;
      this.tEdge = tEdge;
      this._pushEdge(c1);
    } else if (this.len > 0 && this.omegaEst !== 0) {
      // Standstill bound: no edge for longer than expected → at most one count per elapsed time.
      const elapsed = t - this.edgeT[this.head];
      const limit = this.windowS > 1.5 * this.lastInterval ? this.windowS : 1.5 * this.lastInterval;
      if (elapsed > limit) {
        const bound = rpc / elapsed;
        if (this.omegaEst > bound) this.omegaEst = bound;
        else if (this.omegaEst < -bound) this.omegaEst = -bound;
      }
    }
    this.thetaPrev = thetaM;
    this.countPrev = c1;
  }

  /**
   * Stores an edge at time `this.tEdge` and recomputes omegaEst from the ring (bounded walk,
   * no allocation).
   * @param {number} c count after the edge
   */
  _pushEdge(c) {
    const tEdge = this.tEdge;
    const T = this.edgeT, C = this.edgeC;
    const h = this.len === 0 ? this.head : (this.head + 1) % EDGE_RING;
    T[h] = tEdge;
    C[h] = c;
    this.head = h;
    if (this.len < EDGE_RING) this.len++;
    const len = this.len;
    if (len < 2) {
      this.omegaEst = 0;
      this.lastInterval = 0;
      return;
    }
    this.lastInterval = tEdge - T[(h + EDGE_RING - 1) % EDGE_RING];
    let r = h;
    for (let k = 1; k < len; k++) {
      r = (h + EDGE_RING - k) % EDGE_RING;
      if (tEdge - T[r] >= this.windowS) break;
    }
    const span = tEdge - T[r];
    this.omegaEst = span > 0 ? (c - C[r]) * this.radPerCount / span : 0;
  }

  /** count, A/B and thetaMeas (cell center) from the angle in `inThetaM`. */
  _setCount() {
    const count = Math.floor(this.inThetaM * this.cpr / TWO_PI);
    this.count = count;
    const q = ((count % 4) + 4) % 4;
    this.a = (q === 1 || q === 2) ? 1 : 0;
    this.b = q >= 2 ? 1 : 0;
    this.thetaMeas = (count + 0.5) * this.radPerCount;
  }
}
