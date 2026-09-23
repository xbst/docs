// Motor presets and the analytic torque-speed helper (SPEC 5.2, chunk-02 design section 4).
//
// Values are illustrative but realistic. All quantities are SI and phase values are peak
// (amplitude-invariant transforms):
//   R [ohm] phase resistance, L [H] phase inductance, Kt [N·m/A] torque per peak phase amp,
//   p pole pairs (a 1.8° stepper has 50), Jrotor [kg·m²], Irated [A peak].
// Derived by getMotorPreset():
//   kf = 1 (two-phase) or 1.5 (three-phase, amplitude-invariant Clarke), lambda = Kt/(kf·p)
//   [V·s/rad electrical], tauE = L/R [s], phaseAngles = spatial phase angles [rad].
//
// Check for the stepper: 1000 rpm -> omegaE = 50·104.7 = 5236 rad/s -> lambda·omegaE = 23 V peak
// back-EMF, which is why a 24 V supply runs out of voltage near 1000 rpm.

const TWO_PI = 2 * Math.PI;
const SQRT3 = Math.sqrt(3);

const STEPPER = Object.freeze({
  key: 'stepper', type: 'stepper', phases: 2, p: 50, R: 1.14, L: 3.0e-3, Kt: 0.22,
  Jrotor: 8.2e-6, Irated: 3.54, name: 'NEMA 17 1.8°',
});

/**
 * Base motor presets, keyed by preset key. Frozen; use {@link getMotorPreset} to get a
 * working copy with the derived fields.
 * @type {Readonly<Record<string, Readonly<{key: string, type: 'stepper'|'bldc', phases: number, p: number,
 *   R: number, L: number, Kt: number, Jrotor: number, Irated: number, name: string}>>>}
 */
export const MOTOR_PRESETS = Object.freeze({
  stepper: STEPPER,
  stepperHighL: Object.freeze({ ...STEPPER, key: 'stepperHighL', L: 8.0e-3, R: 2.4, name: 'NEMA 17, high inductance' }),
  stepperLowL: Object.freeze({ ...STEPPER, key: 'stepperLowL', L: 1.5e-3, R: 0.6, name: 'NEMA 17, low inductance' }),
  bldc: Object.freeze({
    key: 'bldc', type: 'bldc', phases: 3, p: 7, R: 0.5, L: 0.4e-3, Kt: 0.06,
    Jrotor: 1.0e-5, Irated: 5.6, name: 'NEMA 17-size BLDC servo',
  }),
});

/**
 * Returns a fresh, mutable copy of a preset with the derived fields added:
 * `kf` (1 for two phases, 1.5 for three), `lambda = Kt/(kf·p)`, `tauE = L/R` and
 * `phaseAngles` ([0, π/2] or [0, 2π/3, 4π/3]). Allocates; call from configure code only.
 * @param {string|object} key preset key of {@link MOTOR_PRESETS}, or a preset-like object to derive from
 * @returns {{key: string, type: string, phases: number, p: number, R: number, L: number, Kt: number,
 *   Jrotor: number, Irated: number, name: string, kf: number, lambda: number, tauE: number, phaseAngles: number[]}}
 * @throws {Error} when the key is unknown
 */
export function getMotorPreset(key) {
  const base = (key !== null && typeof key === 'object') ? key : MOTOR_PRESETS[key];
  if (!base) throw new Error(`Unknown motor preset: ${key}`);
  const phases = base.phases === 3 ? 3 : 2;
  const kf = phases === 3 ? 1.5 : 1;
  return {
    key: String(base.key), type: String(base.type), phases, p: base.p, R: base.R, L: base.L, Kt: base.Kt,
    Jrotor: base.Jrotor, Irated: base.Irated, name: String(base.name),
    kf,
    lambda: base.Kt / (kf * base.p),
    tauE: base.L / base.R,
    phaseAngles: phases === 3 ? [0, TWO_PI / 3, 2 * TWO_PI / 3] : [0, Math.PI / 2],
  };
}

/** lambda of a preset, derived when the object has no `lambda` field (raw MOTOR_PRESETS entry). */
function lambdaOf(preset) {
  if (typeof preset.lambda === 'number') return preset.lambda;
  return preset.Kt / ((preset.phases === 3 ? 1.5 : 1) * preset.p);
}

/**
 * Peak phase voltage a driver can impose: `Vbus` for a two-phase H-bridge driver,
 * `Vbus/√3` for a three-phase bridge (space-vector limit).
 * @param {{phases: number}} preset
 * @param {number} Vbus supply voltage [V]
 * @returns {number} [V]
 */
export function vLimit(preset, Vbus) {
  return preset.phases === 3 ? Vbus / SQRT3 : Vbus;
}

/** Attainable current amplitude (unclamped) at mechanical speed omegaM. */
function iAvailRaw(R, L, lam, p, Vl, omegaM) {
  const we = p * Math.abs(omegaM);
  const num = Vl - lam * we;
  if (num <= 0) return 0;
  return num / Math.sqrt(R * R + we * L * we * L);
}

/**
 * Analytic torque-speed curve for a current-regulated drive (chapter 5 chart).
 * `ωe = p·ωm`; `Iavail = max(0, (Vlimit − λ·ωe)/sqrt(R² + (ωe·L)²))`; `T = Kt·min(I, Iavail)`.
 *
 * `iAvailAt(ωm)` returns the current amplitude the drive reaches for the target `I`, i.e.
 * `min(I, Iavail)`: it equals `I` below the knee and falls to 0 at `omegaBemfM`.
 * `omegaKneeM` is the mechanical speed where `Iavail == I` (bisection; 0 if `Iavail(0) < I`),
 * `omegaBemfM = Vlimit/(λ·p)` the speed where the back-EMF alone equals the voltage limit.
 * Overmodulation (chunk 02): a two-phase stepper driver has one full H-bridge per phase, and
 * at speed its current regulator holds each bridge fully on for most of every half cycle. The
 * fundamental of that near-square phase voltage is up to 4/π·Vbus, which is what the sim's
 * clipped current PI (and a real chopper driver) delivers, so `Vlimit` carries a 4/π factor for
 * two-phase presets by default (`opts.overmodulation` overrides it; three-phase presets keep
 * the linear SVPWM limit Vbus/√3, factor 1). With it the sweep's 70% sag speed lands within a
 * few percent of this curve instead of 24% beyond the plain-Vbus curve.
 * Allocates (returns closures); not for the hot path.
 * @param {object} preset from {@link getMotorPreset} (or a raw {@link MOTOR_PRESETS} entry)
 * @param {number} Vbus supply voltage [V]
 * @param {number} I target current amplitude [A peak]
 * @param {{overmodulation?: number}} [opts] voltage-limit factor (default 4/π two-phase, 1 three-phase)
 * @returns {{iAvailAt: (omegaM: number) => number, torqueAt: (omegaM: number) => number,
 *   vLimit: number, omegaKneeM: number, omegaBemfM: number, overmodulation: number}}
 */
export function torqueSpeedCurve(preset, Vbus, I, opts = {}) {
  const R = preset.R, L = preset.L, p = preset.p, Kt = preset.Kt;
  const lam = lambdaOf(preset);
  const overmod = (typeof opts.overmodulation === 'number' && opts.overmodulation > 0) ? opts.overmodulation
    : (preset.phases === 3 ? 1 : 4 / Math.PI);
  const Vl = vLimit(preset, Vbus) * overmod;
  const omegaBemfM = Vl / (lam * p);
  let omegaKneeM = 0;
  if (iAvailRaw(R, L, lam, p, Vl, 0) >= I && I > 0) {
    // Iavail decreases monotonically from Vl/R at 0 to 0 at omegaBemfM.
    let lo = 0, hi = omegaBemfM;
    for (let k = 0; k < 80; k++) {
      const mid = 0.5 * (lo + hi);
      if (iAvailRaw(R, L, lam, p, Vl, mid) >= I) lo = mid; else hi = mid;
    }
    omegaKneeM = 0.5 * (lo + hi);
  }
  const iAvailAt = (omegaM) => Math.min(I, iAvailRaw(R, L, lam, p, Vl, omegaM));
  const torqueAt = (omegaM) => Kt * iAvailAt(omegaM);
  return { iAvailAt, torqueAt, vLimit: Vl, omegaKneeM, omegaBemfM, overmodulation: overmod };
}

/**
 * Fills chart arrays with `n` points of the torque-speed curve from 0 to `maxMmS`
 * (linear in speed). Does not allocate.
 * @param {object} preset from {@link getMotorPreset}
 * @param {number} Vbus supply voltage [V]
 * @param {number} I target current amplitude [A peak]
 * @param {number} maxMmS last speed [mm/s]
 * @param {number} rd rotation distance [mm per motor turn]
 * @param {number} n number of points
 * @param {Float64Array} outMmS receives the speeds [mm/s]
 * @param {Float64Array} outNm receives the torques [N·m]
 */
export function torqueSpeedPoints(preset, Vbus, I, maxMmS, rd, n, outMmS, outNm) {
  const R = preset.R, L = preset.L, p = preset.p, Kt = preset.Kt;
  const lam = lambdaOf(preset);
  const Vl = vLimit(preset, Vbus);
  for (let i = 0; i < n; i++) {
    const mmS = n > 1 ? maxMmS * i / (n - 1) : 0;
    const omegaM = TWO_PI * mmS / rd;
    outMmS[i] = mmS;
    outNm[i] = Kt * Math.min(I, iAvailRaw(R, L, lam, p, Vl, omegaM));
  }
}
