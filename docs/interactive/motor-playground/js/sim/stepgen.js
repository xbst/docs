// Step generator: quantizes a commanded motor angle into STEP/DIR pulses.
//
// Every sim step the commanded angle (rad) is rounded to the nearest step
// position; the difference to the steps already sent is emitted as signed
// pulses. When the caller passes the sign of the commanded velocity, DIR
// follows it and flips at the reversal point (v = 0), ahead of the first
// reversed pulse, as a real controller sets DIR before it steps. Without it,
// DIR is the direction of the last pulse, updated in the same call before the
// pulses of that call count. A pulse always carries its own direction on DIR.
// The pulse rate is an exponential moving average (5 ms time constant) of the
// per-step pulse count divided by dt. No allocation in `update`.

import { TWO_PI } from './units.js';

/** Time constant of the pulse-rate moving average, seconds. */
const RATE_TAU = 5e-3;

/**
 * Converts a commanded angle into STEP/DIR pulses (one instance per motor).
 *
 * Fields (read after `update`):
 * - `level`: 1 if at least one pulse was emitted this step, else 0 (the STEP line).
 * - `dir`: +1 or -1, the DIR line. With a velocity sign passed to `update`, the
 *   sign of the commanded velocity (flips at v = 0, before the first reversed
 *   pulse); otherwise the direction of the last pulse, changed in the same step
 *   that emits the first pulse of the new direction, before it counts.
 * - `count`: net signed pulses since `reset`.
 * - `rate`: pulse rate magnitude in pulses/s (EMA, 5 ms time constant, always >= 0).
 * - `pulsesThisStep`: signed pulses emitted by the last `update`.
 * - `stepAngle`: rad per pulse (2π/stepsPerRev).
 * - `sent`: absolute step position already sent (integer, round(θ/stepAngle)).
 */
export class StepGen {
  /** Creates an unconfigured generator (3200 steps/rev, dt = 40 µs). */
  constructor() {
    this.stepsPerRev = 3200;
    this.dt = 40e-6;
    this.stepAngle = TWO_PI / 3200;
    this.invStepAngle = 3200 / TWO_PI;
    this.rateK = 1 - Math.exp(-40e-6 / RATE_TAU);
    this.level = 0;
    this.dir = 1;
    this.count = 0;
    this.rate = 0;
    this.pulsesThisStep = 0;
    this.sent = 0;
  }

  /**
   * Sets the resolution and the sim step. Does not reset state; when the
   * resolution changes, `sent` is rescaled to the nearest position in the new
   * units so the next `update` does not emit a burst (call `rebase` for an
   * exact realignment).
   * @param {{ stepsPerRev: number, dt: number }} opts
   */
  configure({ stepsPerRev, dt }) {
    const oldAngle = this.stepAngle;
    this.stepsPerRev = stepsPerRev;
    this.dt = dt;
    this.stepAngle = TWO_PI / stepsPerRev;
    this.invStepAngle = stepsPerRev / TWO_PI;
    this.rateK = 1 - Math.exp(-dt / RATE_TAU);
    if (oldAngle !== this.stepAngle) this.sent = Math.round(this.sent * oldAngle * this.invStepAngle);
  }

  /**
   * Aligns the sent position to `thetaRad` and clears all history (count, rate, level, dir).
   * @param {number} thetaRad commanded motor angle, rad
   */
  reset(thetaRad) {
    this.sent = Math.round(thetaRad * this.invStepAngle);
    this.count = 0;
    this.rate = 0;
    this.level = 0;
    this.dir = 1;
    this.pulsesThisStep = 0;
  }

  /**
   * Aligns the sent position to `thetaRad` without emitting pulses; keeps
   * `count`, `rate`, `dir` and `level` history (used after homing / setPosition).
   * @param {number} thetaRad commanded motor angle, rad
   */
  rebase(thetaRad) {
    this.sent = Math.round(thetaRad * this.invStepAngle);
    this.pulsesThisStep = 0;
  }

  /**
   * Advances one sim step toward the commanded angle.
   * @param {number} thetaTargetRad commanded motor angle, rad
   * @param {number} [velSign=0] sign of the commanded velocity (+1, -1, or 0 when
   *   unknown or zero). Nonzero sets DIR before this step's pulses are emitted; 0
   *   keeps DIR at the last pulse direction.
   * @returns {number} signed pulses emitted this step (may exceed 1 in magnitude)
   */
  update(thetaTargetRad, velSign = 0) {
    if (velSign > 0) this.dir = 1;
    else if (velSign < 0) this.dir = -1;
    const target = Math.round(thetaTargetRad * this.invStepAngle);
    const n = target - this.sent;
    this.sent = target;
    this.pulsesThisStep = n;
    if (n !== 0) {
      this.dir = n > 0 ? 1 : -1;
      this.level = 1;
      this.count += n;
    } else {
      this.level = 0;
    }
    const inst = (n < 0 ? -n : n) / this.dt;
    this.rate += this.rateK * (inst - this.rate);
    return n;
  }
}
