// Motion planner: trapezoidal motion along polylines (mm) with Klipper-style
// junction speeds, plus constant-speed jogging and ramped or immediate stops.
//
// Planning (on a command, may allocate only when the segment buffers grow):
// the polyline is split into straight segments; the speed at each junction is
// limited per Klipper's "approximated centripetal velocity":
//   cosθ = −(u1·u2)  (−1 straight continuation, +1 full reversal)
//   sinHalf = √(½(1 − cosθ)), cosHalf = √(½(1 + cosθ))
//   Rjd = sinHalf/(1 − sinHalf), jd = scv²(√2 − 1)/accel, vJd² = Rjd·jd·accel
//   vCent² = ½·L·accel·tan(θ/2) for both adjoining segment lengths L
//   vJunction² = min(vJd², vCentIn², vCentOut², vmax²)
// A backward pass then makes every segment's end speed reachable from the next
// segment's start, and a forward pass makes it reachable from its own start.
//
// Execution (every `step(dt)`, no allocation): with s the distance along the
// current segment of length L and end speed vEnd,
//   vAllowed = min(max(vmax, v − a·dt), √(vEnd² + 2a(L − s))),  v = min(v + a·dt, vAllowed),  s += v·dt
// and the residual distance carries into the next segment. (The start ramp
// √(vStart² + 2as) of the textbook form is implied by v + a·dt, and the end
// limit is evaluated at the end of the step, v² + 2a·dt·v ≤ vEnd² + 2a(L − s),
// so the discrete deceleration never exceeds `accel` and arrives at vEnd. The
// max(vmax, v − a·dt) term ramps down to a vmax lowered mid-move by `configure`
// at `accel` too, in phase 'decel'.)
//
// Kinematics (commanded motor angles): axis/free θ = 2πx/rd for every motor;
// CoreXY θA = 2π(x + y)/rd, θB = 2π(x − y)/rd. The planner never clamps to the
// axis length: commanding into a hard stop is intended.

import { TWO_PI, SQRT2 } from './units.js';

/**
 * Built-in paths in mm. `start` is where the path begins (a travel segment is
 * added when the planner is elsewhere); `points` are visited in order `laps` times.
 */
export const PATHS = {
  square100: { start: [50, 50], points: [[150, 50], [150, 150], [50, 150], [50, 50]], laps: 2 },
  line150: { start: [50, 50], points: [[200, 50], [50, 50]], laps: 2 },
  zigzag: { start: [50, 50], points: [[70, 70], [90, 50], [110, 70], [130, 50], [150, 70], [170, 50], [190, 70], [210, 50]], laps: 1 },
};

/** Distance (mm) from a real corner within which `atCorner` is true. */
const CORNER_RADIUS_MM = 10;
/** A vertex is a real corner when the direction turns by more than about 1°. */
const CORNER_COS = Math.cos(Math.PI / 180);
/** Current motion counts as collinear with a new segment above this cosine. */
const COLLINEAR_COS = 0.9999;
/** Points closer than this (mm) are merged. */
const EPS_MM = 1e-9;

const KIN_AXIS = 0;
const KIN_COREXY = 1;
const KIN_FREE = 2;

/**
 * Squared Klipper junction speed between two consecutive segments.
 * @param {number} u1x incoming unit direction, x
 * @param {number} u1y incoming unit direction, y
 * @param {number} u2x outgoing unit direction, x
 * @param {number} u2y outgoing unit direction, y
 * @param {number} len1 incoming segment length, mm
 * @param {number} len2 outgoing segment length, mm
 * @param {number} scv square corner velocity, mm/s
 * @param {number} accel acceleration, mm/s²
 * @param {number} vmax maximum velocity, mm/s
 * @returns {number} junction speed squared, (mm/s)²
 */
export function junctionSpeed2(u1x, u1y, u2x, u2y, len1, len2, scv, accel, vmax) {
  const vmax2 = vmax * vmax;
  let cosT = -(u1x * u2x + u1y * u2y);
  if (cosT > 0.999999) return 0;                  // full reversal
  if (cosT <= -0.999999) return vmax2;            // straight continuation: unlimited
  cosT = Math.max(cosT, -0.999999);
  const sinHalf = Math.sqrt(Math.max(0, 0.5 * (1 - cosT)));
  const cosHalf = Math.sqrt(Math.max(0, 0.5 * (1 + cosT)));
  const rJd = sinHalf / (1 - sinHalf);
  const jd = scv * scv * (SQRT2 - 1) / accel;
  let v2 = rJd * jd * accel;
  const tanHalf = sinHalf / cosHalf;
  const cIn = 0.5 * len1 * accel * tanHalf;
  const cOut = 0.5 * len2 * accel * tanHalf;
  if (cIn < v2) v2 = cIn;
  if (cOut < v2) v2 = cOut;
  if (vmax2 < v2) v2 = vmax2;
  return v2;
}

/**
 * Klipper junction speed between two consecutive segments (see `junctionSpeed2`).
 * @param {number} u1x @param {number} u1y @param {number} u2x @param {number} u2y
 * @param {number} len1 @param {number} len2 @param {number} scv @param {number} accel @param {number} vmax
 * @returns {number} junction speed, mm/s
 */
export function junctionSpeed(u1x, u1y, u2x, u2y, len1, len2, scv, accel, vmax) {
  return Math.sqrt(junctionSpeed2(u1x, u1y, u2x, u2y, len1, len2, scv, accel, vmax));
}

/**
 * Trapezoidal motion planner for one toolhead (mm, mm/s).
 *
 * Fields: `x, y` (mm), `vx, vy` (mm/s), `speed` (|v|), `mode` ('idle'|'jog'|'move'|'path'),
 * `phase` ('idle'|'accel'|'cruise'|'decel'), `segmentIndex`, `segmentCount`, `done`,
 * `justFinished` (true for exactly one step when a move or path completes), `pathName`
 * (string|null; 'custom' for a path object), `atCorner` (commanded point within 10 mm of
 * a real corner of the current plan), `segStartX, segStartY, segEndX, segEndY` (current
 * segment), `segS` (mm along it), `stopping` (a ramped stop is in progress).
 * Config fields: `maxVelocity`, `accel`, `scv`, `rd`, `kinematics`, `axisLength`.
 */
export class Planner {
  /** Creates an idle planner at (0, 0) with default limits. */
  constructor() {
    this.maxVelocity = 150;
    this.accel = 5000;
    this.scv = 5;
    this.rd = 40;
    this.kinematics = 'axis';
    this.axisLength = 350;
    this.kin = KIN_AXIS;

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.mode = 'idle';
    this.phase = 'idle';
    this.segmentIndex = 0;
    this.segmentCount = 0;
    this.done = false;
    this.justFinished = false;
    this.pathName = null;
    this.atCorner = false;
    this.segStartX = 0;
    this.segStartY = 0;
    this.segEndX = 0;
    this.segEndY = 0;
    this.segS = 0;
    this.stopping = false;
    this.jogVx = 0;
    this.jogVy = 0;
    this.brake = false;   // segment 0 of the current plan is a braking segment

    // Raw targets of the last command, then the merged point list and segments.
    this.cap = 0;
    this.nTargets = 0;
    this.nPoints = 0;
    this.tx = null; this.ty = null;
    this.px = null; this.py = null;
    this.sx = null; this.sy = null; this.ux = null; this.uy = null; this.len = null;
    this.vj2 = null;      // squared junction speed at the end of each segment
    this.vsMax2 = null;   // backward pass: max squared start speed
    this.vs2 = null;      // planned squared start speed
    this.ve2 = null;      // planned squared end speed
    this.corner = null;   // 1 if the vertex at the end of the segment is a real corner
    this._grow(64);
  }

  /**
   * Sets limits and kinematics without touching the motion state. A move or path
   * running faster than a lowered `maxVelocity` slows down to it at `accel`.
   * @param {{ maxVelocity?: number, accel?: number, scv?: number, rd?: number,
   *           kinematics?: 'axis'|'corexy'|'free', axisLength?: number }} [opts]
   */
  configure({ maxVelocity = 150, accel = 5000, scv = 5, rd = 40, kinematics = 'axis', axisLength = 350 } = {}) {
    this.maxVelocity = maxVelocity;
    this.accel = accel > 1e-6 ? accel : 1e-6;
    this.scv = scv;
    this.rd = rd;
    this.kinematics = kinematics;
    this.kin = kinematics === 'corexy' ? KIN_COREXY : (kinematics === 'free' ? KIN_FREE : KIN_AXIS);
    this.axisLength = axisLength;
  }

  /**
   * Idles at (x, y) and forgets the current plan.
   * @param {number} xMm @param {number} yMm
   */
  reset(xMm, yMm) {
    this.x = xMm;
    this.y = yMm;
    this._halt();
    this.done = false;
    this.justFinished = false;
    this.pathName = null;
    this.segmentIndex = 0;
    this.segmentCount = 0;
    this.segS = 0;
    this.brake = false;
    this.segStartX = this.segEndX = xMm;
    this.segStartY = this.segEndY = yMm;
  }

  /**
   * Rebases the commanded position without motion (homing, single steps).
   * Any motion stops immediately and the mode becomes 'idle'.
   * @param {number} xMm @param {number} yMm
   */
  setPosition(xMm, yMm) {
    this.x = xMm;
    this.y = yMm;
    this._halt();
    this.segmentCount = 0;
    this.segmentIndex = 0;
    this.segS = 0;
    this.segStartX = this.segEndX = xMm;
    this.segStartY = this.segEndY = yMm;
  }

  /**
   * Ramps the velocity vector toward (vx, vy) at `accel` and holds it until
   * `stop()`. The target is not limited by `maxVelocity` (speed sweeps jog past it).
   * @param {number} vxMmS @param {number} [vyMmS=0]
   */
  jog(vxMmS, vyMmS = 0) {
    this.mode = 'jog';
    this.stopping = false;
    this.jogVx = vxMmS;
    this.jogVy = vyMmS;
    this.done = false;
    this.justFinished = false;
    this.pathName = null;
    this.atCorner = false;
    this.segmentIndex = 0;
    this.segmentCount = 0;
    this.segS = 0;
    this.brake = false;
    this.segStartX = this.segEndX = this.x;
    this.segStartY = this.segEndY = this.y;
  }

  /**
   * Single-segment trapezoidal move that stops at (x, y). When called while
   * moving in another direction (or too fast to stop in time), a braking
   * segment along the current velocity is planned first.
   * @param {number} xMm @param {number} [yMm=this.y]
   */
  moveTo(xMm, yMm = this.y) {
    this.nTargets = 0;
    this._target(xMm, yMm);
    this._commit('move', null);
  }

  /**
   * Runs a path: a key of `PATHS` or `{ start?, points, laps? }` (mm). If the
   * planner is not at `start`, a first travel segment goes there.
   * @param {string|{start?: number[], points: number[][], laps?: number}} nameOrPath
   */
  runPath(nameOrPath) {
    let path = nameOrPath;
    let name = 'custom';
    if (typeof nameOrPath === 'string') {
      path = PATHS[nameOrPath];
      if (!path) throw new Error(`Unknown path: ${nameOrPath}`);
      name = nameOrPath;
    }
    const pts = path.points;
    const laps = path.laps > 0 ? Math.round(path.laps) : 1;
    this.nTargets = 0;
    if (path.start) this._target(path.start[0], path.start[1]);
    for (let l = 0; l < laps; l++) {
      for (let k = 0; k < pts.length; k++) this._target(pts[k][0], pts[k][1]);
    }
    this._commit('path', name);
  }

  /**
   * Stops. `immediate`: speed 0 now and mode 'idle'. Otherwise the velocity
   * ramps down at `accel` along its current direction, then the mode becomes 'idle'.
   * A stop never sets `done` or `justFinished`.
   * @param {boolean} [immediate=false]
   */
  stop(immediate = false) {
    if (immediate || this.speed === 0) {
      this._halt();
      return;
    }
    this.stopping = true;
    this.jogVx = 0;
    this.jogVy = 0;
    this.atCorner = false;
  }

  /**
   * Advances the commanded motion by dt seconds. No allocation.
   * @param {number} dt seconds
   */
  step(dt) {
    this.justFinished = false;
    if (this.mode === 'idle') return;
    if (this.stopping || this.mode === 'jog') {
      this._stepJog(dt);
      if (this.stopping && this.speed === 0) this._halt();
      return;
    }
    const n = this.segmentCount;
    if (n === 0) { this._finish(); return; }

    const a = this.accel;
    let i = this.segmentIndex;
    let L = this.len[i];
    const adt = a * dt;
    let cap = (this.brake && i === 0) ? Infinity : this.maxVelocity;
    // A limit lowered mid-move (a live speed slider) is reached at `accel`, not in one step.
    const vDown = this.speed - adt;
    const over = vDown > cap;
    if (over) cap = vDown;
    const rem = L - this.segS;
    // Deceleration limit evaluated at the end of this step (discrete-consistent
    // form of √(vEnd² + 2a(L − s))): v² + 2a·dt·v ≤ vEnd² + 2a·rem.
    const vD = Math.sqrt(adt * adt + this.ve2[i] + 2 * a * (rem > 0 ? rem : 0)) - adt;
    const vUp = this.speed + adt;
    let v = vUp;
    if (vUp <= cap && vUp <= vD) {
      this.phase = 'accel';
    } else if (cap <= vD) {
      v = cap;
      this.phase = over ? 'decel' : 'cruise';
    } else {
      v = vD;
      this.phase = 'decel';
    }
    let s = this.segS + v * dt;
    while (s >= L - 1e-9) {
      if (i === n - 1) {
        this.segS = L;
        this._finish();
        return;
      }
      s -= L;
      if (s < 0) s = 0;
      i++;
      L = this.len[i];
    }
    if (i !== this.segmentIndex) {
      this.segmentIndex = i;
      this._loadSegment(i);
    }
    this.segS = s;
    const ux = this.ux[i];
    const uy = this.uy[i];
    this.x = this.sx[i] + ux * s;
    this.y = this.sy[i] + uy * s;
    this.speed = v;
    this.vx = ux * v;
    this.vy = uy * v;
    this.atCorner = (this.corner[i] === 1 && L - s <= CORNER_RADIUS_MM)
      || (i > 0 && this.corner[i - 1] === 1 && s <= CORNER_RADIUS_MM);
  }

  /**
   * Commanded angle of motor i, rad (axis/free: every motor follows x).
   * @param {number} i motor index
   * @returns {number}
   */
  motorAngle(i) {
    const k = TWO_PI / this.rd;
    if (this.kin === KIN_COREXY) return i === 0 ? k * (this.x + this.y) : k * (this.x - this.y);
    return k * this.x;
  }

  /**
   * Commanded speed of motor i, rad/s.
   * @param {number} i motor index
   * @returns {number}
   */
  motorOmega(i) {
    const k = TWO_PI / this.rd;
    if (this.kin === KIN_COREXY) return i === 0 ? k * (this.vx + this.vy) : k * (this.vx - this.vy);
    return k * this.vx;
  }

  // ---- internals ----

  /** Vector velocity ramp toward (jogVx, jogVy) at accel; integrates position. */
  _stepJog(dt) {
    const dvx = this.jogVx - this.vx;
    const dvy = this.jogVy - this.vy;
    const dv = Math.sqrt(dvx * dvx + dvy * dvy);
    const dvMax = this.accel * dt;
    const old = this.speed;
    if (dv <= dvMax) {
      this.vx = this.jogVx;
      this.vy = this.jogVy;
    } else {
      const k = dvMax / dv;
      this.vx += dvx * k;
      this.vy += dvy * k;
    }
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    this.speed = sp;
    if (sp === 0) this.phase = 'idle';
    else if (dv <= dvMax) this.phase = 'cruise';
    else this.phase = sp > old ? 'accel' : 'decel';
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /** Zero velocity, mode and phase idle. */
  _halt() {
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.jogVx = 0;
    this.jogVy = 0;
    this.stopping = false;
    this.mode = 'idle';
    this.phase = 'idle';
    this.atCorner = false;
  }

  /** Natural completion of a move or path: snap to the end point. */
  _finish() {
    const n = this.segmentCount;
    if (n > 0) {
      const i = n - 1;
      this.segmentIndex = i;
      this.x = this.px[n];
      this.y = this.py[n];
      this.segS = this.len[i];
    }
    this._halt();
    this.done = true;
    this.justFinished = true;
  }

  /** Grows every buffer to hold `cap` points (called outside the hot path only). */
  _grow(cap) {
    const f = (old) => {
      const a = new Float64Array(cap);
      if (old) a.set(old.subarray(0, Math.min(old.length, cap)));
      return a;
    };
    this.tx = f(this.tx); this.ty = f(this.ty);
    this.px = f(this.px); this.py = f(this.py);
    this.sx = f(this.sx); this.sy = f(this.sy);
    this.ux = f(this.ux); this.uy = f(this.uy); this.len = f(this.len);
    this.vj2 = f(this.vj2); this.vsMax2 = f(this.vsMax2);
    this.vs2 = f(this.vs2); this.ve2 = f(this.ve2);
    const c = new Uint8Array(cap);
    if (this.corner) c.set(this.corner.subarray(0, Math.min(this.corner.length, cap)));
    this.corner = c;
    this.cap = cap;
  }

  /** Appends a raw target point (mm). */
  _target(x, y) {
    if (this.nTargets + 3 > this.cap) this._grow(this.cap * 2);
    this.tx[this.nTargets] = x;
    this.ty[this.nTargets] = y;
    this.nTargets++;
  }

  /** Appends a point to the merged list unless it coincides with the last one. */
  _point(x, y) {
    const k = this.nPoints;
    if (k > 0) {
      const dx = x - this.px[k - 1];
      const dy = y - this.py[k - 1];
      if (dx * dx + dy * dy <= EPS_MM * EPS_MM) return;
    }
    this.px[k] = x;
    this.py[k] = y;
    this.nPoints = k + 1;
  }

  /**
   * Builds segments from the current position (plus an optional braking
   * point) through the targets, with junction speeds and the backward pass.
   * @returns {number} segment count
   */
  _build(brakeDist) {
    this.nPoints = 0;
    this._point(this.x, this.y);
    this.brake = false;
    if (brakeDist > 0 && this.speed > 0) {
      const ux = this.vx / this.speed;
      const uy = this.vy / this.speed;
      const before = this.nPoints;
      this._point(this.x + ux * brakeDist, this.y + uy * brakeDist);
      this.brake = this.nPoints > before;
    }
    for (let k = 0; k < this.nTargets; k++) this._point(this.tx[k], this.ty[k]);
    const n = this.nPoints - 1;
    for (let j = 0; j < n; j++) {
      const dx = this.px[j + 1] - this.px[j];
      const dy = this.py[j + 1] - this.py[j];
      const L = Math.sqrt(dx * dx + dy * dy);
      this.sx[j] = this.px[j];
      this.sy[j] = this.py[j];
      this.ux[j] = dx / L;
      this.uy[j] = dy / L;
      this.len[j] = L;
    }
    const a = this.accel;
    const vmax = this.maxVelocity;
    for (let j = 0; j < n; j++) {
      if (j === n - 1) {
        this.vj2[j] = 0;
        this.corner[j] = 0;
      } else if (this.brake && j === 0) {
        this.vj2[j] = 0;
        this.corner[j] = (this.ux[0] * this.ux[1] + this.uy[0] * this.uy[1]) < CORNER_COS ? 1 : 0;
      } else {
        this.vj2[j] = junctionSpeed2(this.ux[j], this.uy[j], this.ux[j + 1], this.uy[j + 1],
          this.len[j], this.len[j + 1], this.scv, a, vmax);
        this.corner[j] = (this.ux[j] * this.ux[j + 1] + this.uy[j] * this.uy[j + 1]) < CORNER_COS ? 1 : 0;
      }
    }
    // Backward pass: the end speed of j must not exceed the reachable start of j + 1.
    const vmax2 = vmax * vmax;
    for (let j = n - 1; j >= 0; j--) {
      let ve2 = this.vj2[j];
      if (j < n - 1 && this.vsMax2[j + 1] < ve2) ve2 = this.vsMax2[j + 1];
      this.ve2[j] = ve2;
      let vs2 = ve2 + 2 * a * this.len[j];
      const capJ = (this.brake && j === 0) ? Infinity : vmax2;
      if (capJ < vs2) vs2 = capJ;
      if (j > 0 && this.vj2[j - 1] < vs2) vs2 = this.vj2[j - 1];
      this.vsMax2[j] = vs2;
    }
    return n;
  }

  /** Plans the raw targets from the current state and starts executing them. */
  _commit(mode, name) {
    const v0 = this.speed;
    let n = this._build(0);
    if (v0 > 1e-9) {
      let ok = n > 0;
      if (ok) {
        const c = (this.vx * this.ux[0] + this.vy * this.uy[0]) / v0;
        ok = c >= COLLINEAR_COS && v0 * v0 <= this.vsMax2[0] * (1 + 1e-9) + 1e-12;
      }
      if (!ok) n = this._build(v0 * v0 / (2 * this.accel));
    }
    // Forward pass from the current speed.
    const a = this.accel;
    let vs2 = n > 0 ? v0 * v0 : 0;
    for (let j = 0; j < n; j++) {
      this.vs2[j] = vs2;
      const reach = vs2 + 2 * a * this.len[j];
      if (reach < this.ve2[j]) this.ve2[j] = reach;
      vs2 = this.ve2[j];
    }
    this.segmentCount = n;
    this.segmentIndex = 0;
    this.segS = 0;
    this.mode = mode;
    this.pathName = name;
    this.done = false;
    this.justFinished = false;
    this.stopping = false;
    this.atCorner = false;
    if (n > 0) {
      this._loadSegment(0);
      this.speed = v0;
      this.vx = this.ux[0] * v0;
      this.vy = this.uy[0] * v0;
    } else {
      this.speed = 0;
      this.vx = 0;
      this.vy = 0;
      this.segStartX = this.segEndX = this.x;
      this.segStartY = this.segEndY = this.y;
    }
  }

  /** Publishes segment i's end points. */
  _loadSegment(i) {
    this.segStartX = this.sx[i];
    this.segStartY = this.sy[i];
    this.segEndX = this.px[i + 1];
    this.segEndY = this.py[i + 1];
  }
}
