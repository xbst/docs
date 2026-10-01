// StallGuard-like load estimator (a behavior model, not the chip's circuit).
//
//   sg   = 1023·(1 − min(1 − SG_STALL_FLOOR, |sin δ|·(1 + 0.3·|ωm|/ωref)))
//          when |omegaCmd| ≥ minSpeed, else NaN (no reading)
//   diag = sg < 2·sgthrs (false while there is no reading)
//
// δ is the load angle (current vector vs rotor d axis, rad), ωm the mechanical speed (rad/s),
// ωref the mechanical speed of 100 mm/s. The result is continuous (not rounded to an integer).
// SG_STALL_FLOOR = 0.08 floors the reading at about 82 whatever the load angle and speed, so a
// stalled rotor, including one that slips and rebounds against a compliant stop, never reads
// 0 and a too-dull threshold (2·sgthrs < 82, sgthrs below ~41) never detects the stall.
// Unloaded readings are unchanged (the floor only clips the low end).
// "No reading" is NaN, not null: a field that only ever holds doubles keeps V8's double
// representation and is updated in place, while a null-or-number field boxes every reading into
// a new HeapNumber (16 B per motor per step). Readers test `sg !== sg`.

import { mmSToRadS } from '../units.js';

/** Fraction of full scale a stalled rotor (ωm = 0, δ = 90°) still reads: sg ≈ 1023·0.08 ≈ 82. */
export const SG_STALL_FLOOR = 0.08;

/**
 * StallGuard-like estimator for one motor.
 *
 * Fields: `sg` (0..1023, or NaN below the minimum speed), `diag` (bool), `threshold`
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
    /** Load estimate (0..1023) or NaN below the minimum speed. */
    this.sg = NaN;
    /** DIAG output. */
    this.diag = false;
    /** Inputs for updateInputs(): load angle δ (rad), commanded and actual mechanical speed (rad/s). */
    this.inLoadAngle = 0; this.inOmegaCmd = 0; this.inOmegaM = 0;
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

  /** Clear the result (sg = NaN, diag = false). */
  reset() {
    this.sg = NaN;
    this.diag = false;
  }

  /**
   * Update the estimate. Call once per sim step.
   * @param {number} loadAngleRad load angle δ: current vector vs rotor d axis (rad)
   * @param {number} omegaCmdRadS commanded speed (rad/s), from the step rate
   * @param {number} omegaM actual mechanical speed (rad/s)
   */
  update(loadAngleRad, omegaCmdRadS, omegaM) {
    this.inLoadAngle = loadAngleRad; this.inOmegaCmd = omegaCmdRadS; this.inOmegaM = omegaM;
    this.updateInputs();
  }

  /**
   * update() on inputs already in `inLoadAngle`, `inOmegaCmd` and `inOmegaM`: the world's
   * per-step path, without double arguments (boxed when a call is not inlined).
   */
  updateInputs() {
    const omegaCmdRadS = this.inOmegaCmd, omegaM = this.inOmegaM;
    const wc = omegaCmdRadS < 0 ? -omegaCmdRadS : omegaCmdRadS;
    if (wc < this.minSpeedRadS) {
      this.sg = NaN;
      this.diag = false;
      return;
    }
    let sn = Math.sin(this.inLoadAngle);
    if (sn < 0) sn = -sn;
    const wm = omegaM < 0 ? -omegaM : omegaM;
    let load = sn * (1 + 0.3 * wm / this.omegaRefRadS);
    if (load > 1 - SG_STALL_FLOOR) load = 1 - SG_STALL_FLOOR;   // floor: a stall reads ~82, never 0
    const sg = 1023 * (1 - load);
    this.sg = sg;
    this.diag = sg < this.threshold;
  }
}
