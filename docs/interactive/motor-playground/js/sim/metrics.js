// Readout metrics for the motor playground (chunk-02 design section 14).
//
// `Metrics.update(world)` runs once per sim step. It reads only documented fields:
//   world.snapshot  (motors[0..1], step, gantry, homing, sweep, supplyV)
//   world.planner   (mode, phase, justFinished, atCorner, segStartX/Y, segEndX/Y, speed, x, y, vx, vy)
//   world.scenario  (driver, mechanics, fidelity, runCurrent, planner.accel, planner.maxVelocity)
//   world.openloop[0].chopA.ppLast (switching fidelity only: the phase-A chopper's per-cycle
//                    ripple, EMA of cycle peak - valley, A; absent or null for FOC motor 0)
//   world.vxCmd, world.vyCmd (commanded toolhead velocity, mm/s: the planner's, or the setTarget
//                    ramp while the planner idles; used for "at rest" and velErrMmS)
//   world.noise     (Float64Array, per motor, A: the world's noise signal; FOC motors
//                    (uq - LPF500(uq)) / Kpq_optimal, the high-frequency content of the torque-axis
//                    voltage command as an equivalent current; open-loop motors iA - LPF500(iA),
//                    chopper ripple / current noise. Treated as 0 when the world has no noise array.)
// It accumulates per-period statistics and publishes them into `this.values` every
// `periodS` of sim time (and on demand through `publish()`). `values` is one object that
// is mutated in place; `update` never allocates.
//
// Definitions (motor 0 unless stated):
//   noiseIdx          RMS of world.noise[0] over the period / Irated (the world does the high-pass)
//   rippleRms/Pp      chopper current ripple of phase A. Switching fidelity: ripplePp = the phase-A
//                     chopper's ppLast at publish time, rippleRms = ppLast / (2 * sqrt(3)) (triangle
//                     approximation). A high-pass of iA is not used: once the motor turns it is
//                     dominated by the current's fundamental. Averaged fidelity (no chopper), FOC and
//                     voltage mode (no hysteresis chopper): both 0; chapters show the analytic ripple
//                     there instead.
//   oscFreqHz/oscAmp  high-passed signal (iq - LPF50(iq)) for FOC, (omegaM - LPF50(omegaM)) for open
//                     loop (a current-regulated stepper hides its ringing in the current but shows it
//                     in the rotor speed), so oscAmp is in A for FOC and in rad/s for open loop;
//                     only for periods spent entirely at rest (planner speed and commanded velocity 0):
//                     f = crossings / (2 * period), amp = (max - min) / 2. Crossings are counted
//                     with a Schmitt trigger whose hysteresis is 25% of the previous period's
//                     amplitude, so measurement noise riding on a real oscillation is not counted.
//   iAmpPct           100 * LPF200(iAmp) / runCurrent (open loop) or / iLimit (FOC)
//   phaseLagDeg       open loop: LPF50(wrapPi(thetaCmd - currentAngle)) in degrees, sign flipped
//                     when the last step direction is negative so positive always means "current lags"
//   overshootMm/Pct   peak excursion past the final commanded position along the last segment's
//                     direction, over the 300 ms after planner.justFinished; Pct relative to
//                     vDecel^2 / (2 * accel), vDecel = speed when the last deceleration began
//   settleMs          time from the stop until |position error| stays below 0.02 mm (window length if never)
//   cornerErrMm       max distance of the toolhead from the current/previous commanded segment,
//                     sampled while planner.atCorner, since the current path started
//   rise              L * I / (Vbus - R * I) * 1000 (ms), Infinity when Vbus <= R * I
//   lostStepsMm       axis/free: gantry.lostMm[0]; corexy: toolhead shift magnitude
//                     sqrt(((lA + lB) / 2)^2 + ((lA - lB) / 2)^2) from lostMm[0], lostMm[1]
//   posErrMm/velErrMmS instantaneous |error| (x for axis/free, Euclidean for corexy) at publish time
// Axis and free mechanics have no physical y; the commanded y stands in for the actual y there,
// so every distance reduces to the x error.

import { TWO_PI, wrapPi } from './units.js';
import { Lowpass1 } from './biquad.js';

/** Length of the overshoot / settle window after a stop (s). */
const SETTLE_WINDOW_S = 0.3;
/** Settle band (mm). */
const SETTLE_BAND_MM = 0.02;
/** Schmitt-trigger hysteresis for the oscillation crossing count, as a fraction of the last amplitude. */
const OSC_HYST_FRAC = 0.25;
/** Speeds below this (mm/s) count as "at rest". */
const REST_EPS_MMS = 1e-9;
/** Filter cutoffs (Hz). */
const F_OSC = 50;
/** Former ripple high-pass cutoff; lpRipple is kept configured but no longer feeds a metric. */
const F_RIPPLE = 2000;
const F_IAMP = 200;
const F_LAG = 50;
const RAD_TO_DEG = 180 / Math.PI;
/** RMS / peak-to-peak of a symmetric triangle wave. */
const TRI_RMS_PER_PP = 1 / (2 * Math.sqrt(3));

/**
 * Distance from point (px, py) to the segment (ax, ay)-(bx, by). Allocation free.
 * @param {number} px @param {number} py @param {number} ax @param {number} ay
 * @param {number} bx @param {number} by
 * @returns {number}
 */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-18) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Accumulates readout metrics from the world once per sim step and publishes them into
 * `values` every `periodS` of sim time. See the file header for the definitions.
 */
export class Metrics {
  /** Creates an unconfigured instance (dt = 40 µs, generic preset values). */
  constructor() {
    this.dt = 40e-6;
    this.fs = 25000;
    this.rd = 40;
    this.nMotors = 1;
    this.periodS = 0.1;
    this.periodSteps = 2500;
    /** Motor preset (from getMotorPreset) or null before configure. */
    this.preset = null;
    this.L = 3.0e-3;
    this.R = 1.14;
    this.Irated = 3.54;
    /** Last world passed to update (used by on-demand publish), or null. */
    this.world = null;

    /**
     * Published metrics, mutated in place (same object for the lifetime of this instance).
     * `sweep` is a reference to snapshot.sweep.results (null before the first publish).
     */
    this.values = {
      overshootPct: 0, overshootMm: 0, settleMs: 0, cornerErrMm: 0, oscFreqHz: 0, oscAmp: 0,
      noiseIdx: 0, rippleRms: 0, ripplePp: 0, iAmpPct: 0, phaseLagDeg: 0, stepRate: 0,
      lostStepsMm: 0, pressInMm: 0, freeMotionIqPeak: 0, rise: 0, sweep: null,
      posErrMm: 0, velErrMmS: 0, heat: 0,
    };

    // Filters (rebuilt for the sample rate in configure).
    this.lpOsc = new Lowpass1(this.fs);
    this.lpRipple = new Lowpass1(this.fs);
    this.lpIAmp = new Lowpass1(this.fs);
    this.lpLag = new Lowpass1(this.fs);
    this.primed = false;
    this.iAmpF = 0;
    this.lagF = 0;

    // Per-period accumulators.
    this.n = 0;
    this.noiseSq = 0;
    this.rippleSq = 0;
    this.rippleMin = 0;
    this.rippleMax = 0;
    this.oscMin = 0;
    this.oscMax = 0;
    this.oscCross = 0;
    this.oscAllRest = true;
    // Schmitt state persists across periods: -1, 0 (unknown) or +1.
    this.oscState = 0;
    this.oscHyst = 0;

    // Motion tracking for overshoot / settle.
    this.prevMode = 'idle';
    this.prevPhase = 'idle';
    this.prevSpeed = 0;
    this.decelFrom = 0;
    this.peakSpeed = 0;
    this.lastDirX = 1;
    this.lastDirY = 0;
    this.winActive = false;
    this.winT = 0;
    this.tgtX = 0;
    this.tgtY = 0;
    this.dirX = 1;
    this.dirY = 0;
    this.decelDist = 0;
    this.osPeak = 0;
    this.settleCand = 0;
    this.osMm = 0;
    this.osPct = 0;
    this.settleMs = 0;

    // Corner error tracking.
    this.hasCur = false;
    this.curSX = 0; this.curSY = 0; this.curEX = 0; this.curEY = 0;
    this.hasPrev = false;
    this.prvSX = 0; this.prvSY = 0; this.prvEX = 0; this.prvEY = 0;
    this.cornerErr = 0;
  }

  /**
   * Sets the sample rate and motor parameters, rebuilds the filters and resets all state.
   * @param {{ dt: number, preset: object, rd?: number, nMotors?: number, periodS?: number }} opts
   *   dt sim step (s); preset from getMotorPreset (R, L, Irated read); rd rotation distance (mm/turn);
   *   nMotors motors in the world; periodS publish period (s of sim time).
   */
  configure({ dt, preset, rd = 40, nMotors = 1, periodS = 0.1 }) {
    this.dt = dt;
    this.fs = 1 / dt;
    this.rd = rd;
    this.nMotors = nMotors;
    this.periodS = periodS;
    this.periodSteps = Math.max(1, Math.round(periodS / dt));
    this.preset = preset || null;
    if (preset) {
      this.L = preset.L;
      this.R = preset.R;
      this.Irated = preset.Irated;
    }
    this.lpOsc = new Lowpass1(this.fs);
    this.lpOsc.setCutoff(F_OSC);
    this.lpRipple = new Lowpass1(this.fs);
    this.lpRipple.setCutoff(F_RIPPLE);
    this.lpIAmp = new Lowpass1(this.fs);
    this.lpIAmp.setCutoff(F_IAMP);
    this.lpLag = new Lowpass1(this.fs);
    this.lpLag.setCutoff(F_LAG);
    this.world = null;
    this.reset();
  }

  /** Clears all accumulators, filters, tracking state and published values (the object is kept). */
  reset() {
    const v = this.values;
    v.overshootPct = 0; v.overshootMm = 0; v.settleMs = 0; v.cornerErrMm = 0;
    v.oscFreqHz = 0; v.oscAmp = 0; v.noiseIdx = 0; v.rippleRms = 0; v.ripplePp = 0;
    v.iAmpPct = 0; v.phaseLagDeg = 0; v.stepRate = 0; v.lostStepsMm = 0; v.pressInMm = 0;
    v.freeMotionIqPeak = 0; v.rise = 0; v.sweep = null; v.posErrMm = 0; v.velErrMmS = 0; v.heat = 0;

    this.primed = false;
    this.iAmpF = 0;
    this.lagF = 0;
    this._resetPeriod();
    this.oscState = 0;
    this.oscHyst = 0;

    this.prevMode = 'idle';
    this.prevPhase = 'idle';
    this.prevSpeed = 0;
    this.decelFrom = 0;
    this.peakSpeed = 0;
    this.lastDirX = 1;
    this.lastDirY = 0;
    this.winActive = false;
    this.winT = 0;
    this.tgtX = 0; this.tgtY = 0;
    this.dirX = 1; this.dirY = 0;
    this.decelDist = 0;
    this.osPeak = 0;
    this.settleCand = 0;
    this.osMm = 0; this.osPct = 0; this.settleMs = 0;

    this.hasCur = false;
    this.hasPrev = false;
    this.cornerErr = 0;
  }

  /** Clears the per-period accumulators (the Schmitt state and hysteresis persist). */
  _resetPeriod() {
    this.n = 0;
    this.noiseSq = 0;
    this.rippleSq = 0;
    this.rippleMin = Infinity;
    this.rippleMax = -Infinity;
    this.oscMin = Infinity;
    this.oscMax = -Infinity;
    this.oscCross = 0;
    this.oscAllRest = true;
  }

  /**
   * Accumulates one sim step. Call once per step after the snapshot is filled. Allocation free.
   * @param {object} world the World (reads world.snapshot, world.planner, world.scenario,
   *   world.vxCmd/vyCmd and world.noise)
   */
  update(world) {
    this.world = world;
    const s = world.snapshot;
    const pl = world.planner;
    const sc = world.scenario;
    const m0 = s.motors[0];
    const foc = sc.driver === 'foc';
    const iA = m0.iPhase[0];
    // Oscillation signal: torque current (A) for FOC, rotor speed (rad/s) for open loop.
    const oscIn = foc ? m0.iq : m0.omegaM;

    if (!this.primed) {
      // Start the filters at the current values so a DC level does not show up as a transient.
      this.lpOsc.reset(oscIn);
      this.lpRipple.reset(iA);
      this.lpIAmp.reset(m0.iAmp);
      this.iAmpF = m0.iAmp;
      this.lpLag.reset(0);
      this.lagF = 0;
      this.primed = true;
    }

    // Noise index: the world's per-motor noise signal is already high-passed (A).
    const nz = world.noise;
    const nzA = nz ? nz[0] : 0;
    this.noiseSq += nzA * nzA;

    // Chopper ripple is read from the phase-A chopper at publish time (see the header); the
    // ripple filter and accumulators (lpRipple, rippleSq/Min/Max) are no longer fed.

    // Oscillation at rest.
    const hpO = oscIn - this.lpOsc.process(oscIn);
    // Commanded toolhead speed: the world's command (covers setTarget, where the planner idles).
    const cvx = world.vxCmd;
    const cvy = world.vyCmd;
    if (pl.speed > REST_EPS_MMS || cvx > REST_EPS_MMS || cvx < -REST_EPS_MMS || cvy > REST_EPS_MMS
        || cvy < -REST_EPS_MMS) this.oscAllRest = false;
    if (hpO < this.oscMin) this.oscMin = hpO;
    if (hpO > this.oscMax) this.oscMax = hpO;
    const h = this.oscHyst;
    if (this.oscState >= 0 && hpO < -h) {
      if (this.oscState > 0) this.oscCross++;
      this.oscState = -1;
    } else if (this.oscState <= 0 && hpO > h) {
      if (this.oscState < 0) this.oscCross++;
      this.oscState = 1;
    }

    // Current amplitude and phase lag.
    this.iAmpF = this.lpIAmp.process(m0.iAmp);
    if (!foc) {
      let lag = wrapPi(m0.thetaCmd - m0.currentAngle);
      if (s.step.dir < 0) lag = -lag;
      this.lagF = this.lpLag.process(lag);
    }

    // Actual toolhead point in the planner's plane (axis/free: commanded y stands in for y).
    const corexy = sc.mechanics === 'corexy';
    const ax = s.gantry.x;
    const ay = corexy ? s.gantry.y : pl.y;

    this._trackMotion(pl, sc, ax, ay);
    this._trackCorner(pl, ax, ay);

    this.n++;
    if (this.n >= this.periodSteps) {
      this.publish();
      this._resetPeriod();
    }
  }

  /** Overshoot / settle tracking. Allocation free. */
  _trackMotion(pl, sc, ax, ay) {
    const mode = pl.mode;
    const phase = pl.phase;
    const speed = pl.speed;

    if (mode !== 'idle' && mode !== this.prevMode) {
      // A new move, path or jog started: the last-stop metrics no longer apply.
      this.winActive = false;
      this.osMm = 0; this.osPct = 0; this.settleMs = 0;
      this.decelFrom = 0;
      this.peakSpeed = 0;
      if (mode === 'path') {
        this.cornerErr = 0;
        this.hasCur = false;
        this.hasPrev = false;
      }
    }
    if (phase === 'decel' && this.prevPhase !== 'decel') {
      this.decelFrom = this.prevSpeed > speed ? this.prevSpeed : speed;
    }
    if (speed > this.peakSpeed) this.peakSpeed = speed;
    if (speed > REST_EPS_MMS) {
      const vx = pl.vx;
      const vy = pl.vy;
      const vl = Math.sqrt(vx * vx + vy * vy);
      if (vl > REST_EPS_MMS) { this.lastDirX = vx / vl; this.lastDirY = vy / vl; }
    }

    if (pl.justFinished) {
      this.tgtX = pl.x;
      this.tgtY = pl.y;
      const dx = pl.segEndX - pl.segStartX;
      const dy = pl.segEndY - pl.segStartY;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-9) { this.dirX = dx / len; this.dirY = dy / len; } else { this.dirX = this.lastDirX; this.dirY = this.lastDirY; }
      const vDec = this.decelFrom > 0 ? this.decelFrom : this.peakSpeed;
      const accel = sc.planner.accel;
      this.decelDist = accel > 0 ? (vDec * vDec) / (2 * accel) : 0;
      this.winActive = true;
      this.winT = 0;
      this.osPeak = 0;
      this.settleCand = 0;
      this.osMm = 0; this.osPct = 0; this.settleMs = 0;
      this.decelFrom = 0;
      this.peakSpeed = 0;
    }

    if (this.winActive) {
      const ex = ax - this.tgtX;
      const ey = ay - this.tgtY;
      const along = ex * this.dirX + ey * this.dirY;
      if (along > this.osPeak) this.osPeak = along;
      const err = Math.sqrt(ex * ex + ey * ey);
      if (err >= SETTLE_BAND_MM) this.settleCand = this.winT + this.dt;
      this.winT += this.dt;
      this.osMm = this.osPeak;
      this.osPct = this.decelDist > 0 ? (100 * this.osPeak) / this.decelDist : 0;
      this.settleMs = 1000 * this.settleCand;
      if (this.winT >= SETTLE_WINDOW_S - 0.5 * this.dt) this.winActive = false;
    }

    this.prevMode = mode;
    this.prevPhase = phase;
    this.prevSpeed = speed;
  }

  /** Corner (path deviation) tracking. Allocation free. */
  _trackCorner(pl, ax, ay) {
    const sx = pl.segStartX, sy = pl.segStartY, ex = pl.segEndX, ey = pl.segEndY;
    if (!this.hasCur || sx !== this.curSX || sy !== this.curSY || ex !== this.curEX || ey !== this.curEY) {
      if (this.hasCur) {
        this.prvSX = this.curSX; this.prvSY = this.curSY; this.prvEX = this.curEX; this.prvEY = this.curEY;
        this.hasPrev = true;
      }
      this.curSX = sx; this.curSY = sy; this.curEX = ex; this.curEY = ey;
      this.hasCur = true;
    }
    if (pl.atCorner) {
      let d = segDist(ax, ay, sx, sy, ex, ey);
      if (this.hasPrev) {
        const d2 = segDist(ax, ay, this.prvSX, this.prvSY, this.prvEX, this.prvEY);
        if (d2 < d) d = d2;
      }
      if (d > this.cornerErr) this.cornerErr = d;
    }
  }

  /**
   * Publishes the current metrics into `this.values`. Runs automatically every `periodS` of sim
   * time; may be called on demand (period statistics then cover the partial period so far and
   * are left unchanged when no step has run since the last period boundary). Allocation free.
   */
  publish() {
    const v = this.values;
    const w = this.world;
    const n = this.n;

    if (n > 0) {
      v.noiseIdx = this.Irated > 0 ? Math.sqrt(this.noiseSq / n) / this.Irated : 0;
      const amp = 0.5 * (this.oscMax - this.oscMin);
      this.oscHyst = OSC_HYST_FRAC * amp;
      if (this.oscAllRest) {
        v.oscFreqHz = this.oscCross / (2 * n * this.dt);
        v.oscAmp = amp;
      } else {
        v.oscFreqHz = 0;
        v.oscAmp = 0;
      }
    }

    v.overshootMm = this.osMm;
    v.overshootPct = this.osPct;
    v.settleMs = this.settleMs;
    v.cornerErrMm = this.cornerErr;

    if (w === null) return;
    const s = w.snapshot;
    const sc = w.scenario;
    const m0 = s.motors[0];
    const foc = sc.driver === 'foc';

    const iTarget = foc ? m0.iLimit : sc.runCurrent;
    v.iAmpPct = iTarget > 0 ? (100 * this.iAmpF) / iTarget : 0;
    v.phaseLagDeg = foc ? 0 : this.lagF * RAD_TO_DEG;
    v.stepRate = s.step.rate;
    // Chopper ripple: phase-A chopper's per-cycle p-p in switching fidelity, else 0.
    let pp = 0;
    if (sc.fidelity === 'switching') {
      const ol = w.openloop;
      const d0 = ol ? ol[0] : null;
      const ch = d0 ? d0.chopA : null;
      if (ch && ch.ppLast > 0) pp = ch.ppLast;
    }
    v.ripplePp = pp;
    v.rippleRms = pp * TRI_RMS_PER_PP;
    const lm = s.gantry.lostMm;
    const lA = lm[0] === undefined ? 0 : lm[0];
    if (sc.mechanics === 'corexy') {
      const lB = lm[1] === undefined ? 0 : lm[1];
      const lx = 0.5 * (lA + lB);
      const ly = 0.5 * (lA - lB);
      v.lostStepsMm = Math.sqrt(lx * lx + ly * ly);
    } else {
      v.lostStepsMm = lA;
    }
    v.pressInMm = s.homing.pressInMm;
    v.freeMotionIqPeak = s.homing.freeIqPeak;
    const I = sc.runCurrent;
    const headroom = s.supplyV - this.R * I;
    v.rise = headroom > 0 ? (1000 * this.L * I) / headroom : Infinity;
    v.sweep = s.sweep.results;
    v.heat = m0.heat;

    // Instantaneous toolhead errors.
    const g = s.gantry;
    const k = this.rd / TWO_PI;
    if (sc.mechanics === 'corexy' && s.motors.length > 1) {
      const ex = g.x - g.xCmd;
      const ey = g.y - g.yCmd;
      v.posErrMm = Math.sqrt(ex * ex + ey * ey);
      const w0 = m0.omegaM;
      const w1 = s.motors[1].omegaM;
      const evx = 0.5 * k * (w0 + w1) - w.vxCmd;
      const evy = 0.5 * k * (w0 - w1) - w.vyCmd;
      v.velErrMmS = Math.sqrt(evx * evx + evy * evy);
    } else {
      v.posErrMm = Math.abs(g.x - g.xCmd);
      v.velErrMmS = Math.abs(k * m0.omegaM - w.vxCmd);
    }
  }
}
