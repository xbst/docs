// Electrical model of a non-salient permanent-magnet machine in the stationary α/β frame
// (SPEC 5.2, chunk-02 design section 5). Covers both the two-phase hybrid stepper and the
// three-phase BLDC: a stepper is a PM synchronous machine with p = 50 pole pairs.
//
//   eα = −λ·ωe·sin θe            eβ = λ·ωe·cos θe                  back-EMF [V]
//   diα/dt = (vα − R·iα − eα)/L  diβ/dt = (vβ − R·iβ − eβ)/L       explicit Euler (dt ≪ L/R)
//   id = iα·cos θe + iβ·sin θe   iq = −iα·sin θe + iβ·cos θe       Park
//   Te = Kt·iq                                                     [N·m]
//
// The torque of a step is computed from the currents before the update (what the previous
// voltage produced), so a driver acting on this step's voltage sees an honest one-sample delay.
// Phase quantities for display come from the amplitude-invariant inverse Clarke transform:
// two-phase A = α, B = β; three-phase A = α, B = −α/2 + (√3/2)β, C = −α/2 − (√3/2)β.

import { getMotorPreset } from './presets.js';

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;
const HALF_SQRT3 = Math.sqrt(3) / 2;

/** Wraps an angle into [−π, π) for trig on large unwrapped angles. */
function wrapAngle(x) {
  if (x >= -PI && x < PI) return x;
  return x - TWO_PI * Math.floor((x + PI) / TWO_PI);
}

/** Amplitude-invariant inverse Clarke into `out` (length 2 or 3). */
function invClarkeInto(alpha, beta, out) {
  out[0] = alpha;
  if (out.length === 3) {
    out[1] = -0.5 * alpha + HALF_SQRT3 * beta;
    out[2] = -0.5 * alpha - HALF_SQRT3 * beta;
  } else {
    out[1] = beta;
  }
}

/**
 * Non-salient PM motor, electrical states in α/β, explicit Euler.
 *
 * After each {@link Motor#step} the fields hold: `iAlpha, iBeta` (A, after the update),
 * `eAlpha, eBeta` (V), `id, iq` (A, from the currents before the update), `torque` (N·m,
 * `Kt·iq`), `cosE, sinE` (of the rotor electrical angle), `iPhase, vPhase, bemf`
 * (`Float64Array(phases)`, from the inverse Clarke transform), `iAmp` (`sqrt(iα² + iβ²)`,
 * after the update), `vAlpha, vBeta` (the voltage last applied).
 */
export class Motor {
  /**
   * @param {object|string} preset a preset from getMotorPreset (a reference is kept), or a preset key
   */
  constructor(preset) {
    /** @type {object} preset in use (R, L, Kt, p, lambda, kf, phases, Irated, ...) */
    this.preset = typeof preset === 'string' ? getMotorPreset(preset) : preset;
    /** @type {number} [A] */ this.iAlpha = 0;
    /** @type {number} [A] */ this.iBeta = 0;
    /** @type {number} [V] */ this.eAlpha = 0;
    /** @type {number} [V] */ this.eBeta = 0;
    /** @type {number} [A] */ this.id = 0;
    /** @type {number} [A] */ this.iq = 0;
    /** @type {number} [N·m] */ this.torque = 0;
    /** @type {number} */ this.cosE = 1;
    /** @type {number} */ this.sinE = 0;
    /** @type {number} [A] */ this.iAmp = 0;
    /** @type {number} [V] */ this.vAlpha = 0;
    /** @type {number} [V] */ this.vBeta = 0;
    /** @type {number} step inputs for stepInputs(): rotor electrical angle [rad] and speed [rad/s], step [s] */
    this.inThetaE = 0; this.inOmegaE = 0; this.stepDt = 4e-5;
    const n = this.preset.phases === 3 ? 3 : 2;
    /** @type {Float64Array} phase currents [A] */ this.iPhase = new Float64Array(n);
    /** @type {Float64Array} phase voltages [V] */ this.vPhase = new Float64Array(n);
    /** @type {Float64Array} phase back-EMFs [V] */ this.bemf = new Float64Array(n);
  }

  /**
   * Switches the motor parameters and keeps the electrical state (α/β currents). The phase
   * arrays are reallocated only when the number of phases changes.
   * @param {object|string} preset a preset from getMotorPreset, or a preset key
   */
  setPreset(preset) {
    this.preset = typeof preset === 'string' ? getMotorPreset(preset) : preset;
    const n = this.preset.phases === 3 ? 3 : 2;
    if (this.iPhase.length !== n) {
      this.iPhase = new Float64Array(n);
      this.vPhase = new Float64Array(n);
      this.bemf = new Float64Array(n);
      invClarkeInto(this.iAlpha, this.iBeta, this.iPhase);
      invClarkeInto(this.vAlpha, this.vBeta, this.vPhase);
      invClarkeInto(this.eAlpha, this.eBeta, this.bemf);
    }
  }

  /** Zeroes the currents and every output (cosE = 1, sinE = 0 for a rotor at θe = 0). */
  reset() {
    this.iAlpha = 0; this.iBeta = 0; this.eAlpha = 0; this.eBeta = 0;
    this.id = 0; this.iq = 0; this.torque = 0; this.cosE = 1; this.sinE = 0;
    this.iAmp = 0; this.vAlpha = 0; this.vBeta = 0;
    this.iPhase.fill(0); this.vPhase.fill(0); this.bemf.fill(0);
  }

  /**
   * Advances the electrical state by one step. Does not allocate.
   * @param {number} vAlpha applied α voltage [V]
   * @param {number} vBeta applied β voltage [V]
   * @param {number} thetaE rotor electrical angle [rad], unwrapped
   * @param {number} omegaE rotor electrical speed [rad/s]
   * @param {number} dt step [s]
   */
  step(vAlpha, vBeta, thetaE, omegaE, dt) {
    this.vAlpha = vAlpha; this.vBeta = vBeta;
    this.inThetaE = thetaE; this.inOmegaE = omegaE; this.stepDt = dt;
    this.stepInputs();
  }

  /**
   * step() on inputs already in `vAlpha`, `vBeta`, `inThetaE`, `inOmegaE` and `stepDt`: the
   * world's per-step path, without double arguments (boxed when a call is not inlined).
   */
  stepInputs() {
    const vAlpha = this.vAlpha, vBeta = this.vBeta, omegaE = this.inOmegaE, dt = this.stepDt;
    const pr = this.preset;
    const R = pr.R, L = pr.L, lam = pr.lambda;
    const th = wrapAngle(this.inThetaE);
    const c = Math.cos(th), s = Math.sin(th);
    this.cosE = c; this.sinE = s;

    const ea = -lam * omegaE * s;
    const eb = lam * omegaE * c;
    this.eAlpha = ea; this.eBeta = eb;

    let ia = this.iAlpha, ib = this.iBeta;
    const iq = -ia * s + ib * c;
    this.id = ia * c + ib * s;
    this.iq = iq;
    this.torque = pr.Kt * iq;

    ia += dt * (vAlpha - R * ia - ea) / L;
    ib += dt * (vBeta - R * ib - eb) / L;
    this.iAlpha = ia; this.iBeta = ib;
    this.iAmp = Math.sqrt(ia * ia + ib * ib);

    // Inverse Clarke (invClarkeInto) written out for the three outputs: no double arguments.
    const ip = this.iPhase, vp = this.vPhase, be = this.bemf;
    ip[0] = ia; vp[0] = vAlpha; be[0] = ea;
    if (ip.length === 3) {
      ip[1] = -0.5 * ia + HALF_SQRT3 * ib;
      ip[2] = -0.5 * ia - HALF_SQRT3 * ib;
      vp[1] = -0.5 * vAlpha + HALF_SQRT3 * vBeta;
      vp[2] = -0.5 * vAlpha - HALF_SQRT3 * vBeta;
      be[1] = -0.5 * ea + HALF_SQRT3 * eb;
      be[2] = -0.5 * ea - HALF_SQRT3 * eb;
    } else {
      ip[1] = ib; vp[1] = vBeta; be[1] = eb;
    }
  }
}
