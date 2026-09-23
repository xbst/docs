// StallGuard-like load estimator (a behavior model, not the chip's circuit).
//
//   sg   = 1023·clamp(1 − |sin δ|·(1 + 0.3·|ωm|/ωref), 0, 1)   when |omegaCmd| ≥ minSpeed, else null
//   diag = sg !== null && sg < 2·sgthrs
//
// δ is the load angle (current vector vs rotor d axis, rad), ωm the mechanical speed (rad/s),
// ωref the mechanical speed of 100 mm/s. The result is continuous (not rounded to an integer).

import { mmSToRadS } from '../units.js';

/**
 * StallGuard-like estimator for one motor.
 *
 * Fields: `sg` (0..1023, or null below the minimum speed), `diag` (bool), `threshold`
 * (= 2·sgthrs, the value sg is compared against), `sgthrs`, `minSpeedRadS`, `omegaRefRadS`.
 */
export class StallGuard {
  constructor() {
    /** StallGuard threshold setting (0..255). */
    this.sgthrs = 60;
    /** Comparison level, 2·sgthrs. */
    this.threshold = 120;
    /** Minimum commanded speed for a valid result (rad/s). */
    this.minSpeedRadS = mmSToRadS(10, 40);
    /** Reference speed, the mechanical speed of 100 mm/s (rad/s). */
    this.omegaRefRadS = mmSToRadS(100, 40);
    /** Load estimate (0..1023) or null below the minimum speed. */
    this.sg = null;
    /** DIAG output. */
    this.diag = false;
  }

  /**
   * Set the parameters. Keeps the last result.
   * @param {{sgthrs?: number, minSpeedRadS?: number, omegaRefRadS?: number}} cfg
   *   speeds in mechanical rad/s (defaults assume rotation distance 40 mm)
   */
  configure({ sgthrs = 60, minSpeedRadS = mmSToRadS(10, 40), omegaRefRadS = mmSToRadS(100, 40) } = {}) {
    this.sgthrs = sgthrs;
    this.threshold = 2 * sgthrs;
    this.minSpeedRadS = minSpeedRadS;
    this.omegaRefRadS = omegaRefRadS > 0 ? omegaRefRadS : 1;
  }

  /** Clear the result (sg = null, diag = false). */
  reset() {
    this.sg = null;
    this.diag = false;
  }

  /**
   * Update the estimate. Call once per sim step.
   * @param {number} loadAngleRad load angle δ: current vector vs rotor d axis (rad)
   * @param {number} omegaCmdRadS commanded speed (rad/s), from the step rate
   * @param {number} omegaM actual mechanical speed (rad/s)
   */
  update(loadAngleRad, omegaCmdRadS, omegaM) {
    const wc = omegaCmdRadS < 0 ? -omegaCmdRadS : omegaCmdRadS;
    if (wc < this.minSpeedRadS) {
      this.sg = null;
      this.diag = false;
      return;
    }
    let sn = Math.sin(loadAngleRad);
    if (sn < 0) sn = -sn;
    const wm = omegaM < 0 ? -omegaM : omegaM;
    let x = 1 - sn * (1 + 0.3 * wm / this.omegaRefRadS);
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    const sg = 1023 * x;
    this.sg = sg;
    this.diag = sg < this.threshold;
  }
}
