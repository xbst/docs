// Field-oriented control (FOC) cascade for the motor playground sim.
//
// Position P(I) -> velocity PI -> dq current PI -> voltage circle -> inverse Park.
// Sampled once per control period (default 25 kHz). The controller reads the
// encoder's measured mechanical angle and speed estimate plus the motor's actual
// phase currents (it adds its own gaussian measurement noise) and writes the
// stator-frame voltage command (uAlpha, uBeta) for the plant.
//
// Per sample (contract section 13):
//   thetaE = p * thetaMeasM ; omega = velocityFilter(omegaEst)
//   iPhaseMeas[k] = iPhase[k] + sigma * N(0, 1),  sigma = noiseSigmaFrac * Irated
//   (id, iq) = park(clarke(iPhaseMeas), thetaE) ; idf = fluxFilter(id) ; iqf = torqueFilter(iq)
//   position: e = thetaStar - thetaMeasM (or whole encoder cells, see below)
//             omega* = clamp(Kpx * e + integX, +-omegaLimit)
//   velocity: iq*    = clamp(Kpv * ev + integV, +-iLimit)
//   torque:   iq*    = clamp(iqStarCmd, +-iLimit)
//   current:  uq = Kpq * eq + integQ ; ud = Kpd * ed + integD ; circle |u| <= Umax (d axis first)
//   (uAlpha, uBeta) = invPark(ud, uq, thetaE)
//
// Anti-windup (back-calculation): when a loop output is clamped, the integrator
// is pulled back so that `Kp*err + integ == clamped output`. The pull-back never
// drives the integrator past zero: if the proportional term alone already
// exceeds the limit, the integrator is only reduced to 0 (not to a large value of
// the opposite sign). That keeps an integrator with Ki = 0 (the default position
// loop) at exactly 0 and avoids a steady-state offset after a saturated move.
//
// Gain changes: each integrator stores its whole I term (Ki*integral of the error),
// so a new nonzero I gain keeps it and the output does not jump. An I gain set to
// 0 clears its integrator in `configure`: nothing could discharge it any more, and
// a position I set back to 0 while it held the cruise speed (about 0.9 mm of error
// at 150 mm/s) would keep the axis off target at rest for good.
//
// Position error in whole encoder cells: when `encoderCpr > 0` and `step` gets
// the encoder count, the error is `(floor(thetaStar*cpr/2pi) - count) * 2pi/cpr`,
// i.e. zero while the rotor sits in the target's cell. A real drive only knows
// the count, so it does not hunt inside a cell at rest. `deadbandCells` (default 1)
// widens the zero zone by that many cells on each side, so a rotor resting on a
// cell edge is not kicked across it by the velocity loop's reaction to each edge
// (that chatter ran at ~130 Hz with 0.3-0.5 A of iq*). Without a count (or with
// `encoderCpr = 0`) the error is the continuous `thetaStar - thetaMeasM`.
//
// Tuning (TUNING, absolute frequencies in Hz): the current loops cross over at
// `fc` (400 Hz, pole-zero cancellation of the RL plant), the velocity loop at
// `fv` (75 Hz, PI zero at `alpha*fv`, alpha 0.25), the position loop at `fx` (28 Hz). The
// torque (iq) and flux (id) sense biquads sit inside the current loops at
// `fFilter` (1200 Hz = 3*fc): a second-order low-pass at the loop's own crossover
// would remove about 90 degrees of phase margin and make the loop ring. The
// velocity feedback biquad sits at `fVel` (225 Hz = 3*fv). fv is capped near 75 Hz by
// the 4000-count encoder: below ~20 mm/s the edge-timed speed estimate lags by about one
// edge interval, and a 100 Hz velocity loop then oscillates during slow moves and stops.
//
// Hot path (`step`) does not allocate. SI units throughout.

import { TWO_PI, wrapPi } from '../units.js';
import { clarke2, clarke3, park, invPark } from '../transforms.js';
import { Biquad } from '../biquad.js';
import { vLimit } from '../presets.js';

/**
 * Tuning constants for the optimal gains (the x1 reference of chapter 8), all
 * absolute frequencies in Hz: `fFilter` torque/flux sense filter cutoff; `fc`
 * current-loop crossover; `fv` velocity-loop crossover; `alpha` places the
 * velocity PI zero at `alpha*fv`; `fVel` velocity feedback filter cutoff; `fx`
 * position-loop crossover; `kixRefRatio` scales the position I slider reference
 * (`KixRef = Kpx*2*pi*fx*kixRefRatio`).
 * @type {{fFilter: number, fc: number, fv: number, alpha: number, fVel: number, fx: number,
 *         kixRefRatio: number}}
 */
export const TUNING = { fFilter: 1200, fc: 400, fv: 75, alpha: 0.25, fVel: 225, fx: 28, kixRefRatio: 2 };

/** Mode codes used internally by the hot path. */
const MODE_POSITION = 0;
const MODE_VELOCITY = 1;
const MODE_TORQUE = 2;

/**
 * @typedef {object} FocGains
 * @property {number} Kpq q-axis current P gain (V/A)
 * @property {number} Kiq q-axis current I gain (V/(A*s))
 * @property {number} Kpd d-axis current P gain (V/A)
 * @property {number} Kid d-axis current I gain (V/(A*s))
 * @property {number} Kpv velocity P gain (A/(rad/s))
 * @property {number} Kiv velocity I gain (A/rad)
 * @property {number} Kpx position P gain (1/s)
 * @property {number} Kix position I gain (1/s^2), 0 in the optimal set
 * @property {number} KixRef slider reference for Kix (Kpx*2*pi*fx*kixRefRatio)
 * @property {number} fFilter optimal torque/flux filter cutoff (Hz, TUNING.fFilter)
 * @property {number} fTorque torque (iq) filter cutoff (Hz, 0 = bypass)
 * @property {number} fFlux flux (id) filter cutoff (Hz, 0 = bypass)
 * @property {number} fVel velocity feedback filter cutoff (Hz, 0 = bypass)
 * @property {number} Umax voltage circle radius (V)
 * @property {number} omegaLimit position loop output limit (mech rad/s)
 * @property {number} iLimit current limit (A, run current)
 * @property {number} fc current-loop crossover (Hz)
 * @property {number} fv velocity-loop crossover (Hz)
 * @property {number} fx position-loop crossover (Hz)
 * @property {number} alpha velocity PI zero ratio
 */

/** @returns {FocGains} a gains object with every field 0 (fixed key order). */
function zeroGains() {
  return {
    Kpq: 0, Kiq: 0, Kpd: 0, Kid: 0, Kpv: 0, Kiv: 0, Kpx: 0, Kix: 0, KixRef: 0,
    fTorque: 0, fFlux: 0, fVel: 0, Umax: 0, omegaLimit: 0, iLimit: 0, fc: 0, fv: 0, fx: 0, alpha: 0,
    fFilter: 0,
  };
}

/**
 * Copy every gains field from `src` into `dst` (keeps `dst`'s shape).
 * @param {FocGains} dst
 * @param {FocGains} src
 * @returns {FocGains} dst
 */
function copyGains(dst, src) {
  dst.Kpq = src.Kpq; dst.Kiq = src.Kiq; dst.Kpd = src.Kpd; dst.Kid = src.Kid;
  dst.Kpv = src.Kpv; dst.Kiv = src.Kiv; dst.Kpx = src.Kpx; dst.Kix = src.Kix; dst.KixRef = src.KixRef;
  dst.fTorque = src.fTorque; dst.fFlux = src.fFlux; dst.fVel = src.fVel; dst.Umax = src.Umax;
  dst.omegaLimit = src.omegaLimit; dst.iLimit = src.iLimit; dst.fc = src.fc; dst.fv = src.fv; dst.fx = src.fx;
  dst.alpha = src.alpha; dst.fFilter = src.fFilter;
  return dst;
}

/**
 * Flux linkage of a preset (V*s/rad electrical), falling back to Kt/(kf*p).
 * @param {object} preset
 * @returns {number}
 */
function presetLambda(preset) {
  if (typeof preset.lambda === 'number' && preset.lambda > 0) return preset.lambda;
  const kf = typeof preset.kf === 'number' ? preset.kf : (preset.phases === 3 ? 1.5 : 1);
  return preset.Kt / (kf * preset.p);
}

/**
 * Optimal (x1 reference) cascade gains for a motor preset and total inertia.
 *
 * - `Kpq = Kpd = L*2*pi*fc`, `Kiq = Kid = R*2*pi*fc` (pole-zero cancellation of the RL plant)
 * - `Kpv = Jt*2*pi*fv/Kt`, `Kiv = Kpv*2*pi*fv*alpha`
 * - `Kpx = 2*pi*fx`, `Kix = 0`, `KixRef = Kpx*2*pi*fx*kixRefRatio`
 * - `fTorque = fFlux = fFilter`, `fVel = tuning.fVel`, `Umax = 0.96*vLimit(preset, Vbus)`
 *
 * Every tuning value comes from the `tuning` object (default TUNING); a key it
 * lacks falls back to TUNING. `omegaLimit` defaults to the back-EMF speed
 * `vLimit/(lambda*p)` when not given (the world normally passes 1.2x the
 * planner's max speed); `runCurrent` defaults to `preset.Irated` and becomes
 * `iLimit`.
 *
 * @param {object} preset motor preset from `getMotorPreset` (R, L, Kt, p, lambda, phases, Irated)
 * @param {number} Jt total inertia seen by the motor (kg*m^2)
 * @param {{tuning?: Partial<typeof TUNING>, Vbus?: number, omegaLimit?: number,
 *          runCurrent?: number}} [opts]
 * @returns {FocGains}
 */
export function optimalGains(preset, Jt, { tuning = TUNING, Vbus = 24, omegaLimit, runCurrent } = {}) {
  const t = tuning || TUNING;
  const tv = (key) => (typeof t[key] === 'number' && Number.isFinite(t[key]) ? t[key] : TUNING[key]);
  const fFilter = tv('fFilter');
  const fc = tv('fc');
  const fv = tv('fv');
  const alpha = tv('alpha');
  const fVel = tv('fVel');
  const fx = tv('fx');
  const kixRefRatio = tv('kixRefRatio');
  const wc = TWO_PI * fc;
  const wv = TWO_PI * fv;
  const wx = TWO_PI * fx;
  const vl = vLimit(preset, Vbus);
  const Kpv = Jt * wv / preset.Kt;
  const Kpx = wx;
  const wLim = (typeof omegaLimit === 'number' && omegaLimit > 0)
    ? omegaLimit
    : vl / (presetLambda(preset) * preset.p);
  const iLim = (typeof runCurrent === 'number' && runCurrent >= 0) ? runCurrent : preset.Irated;
  const g = zeroGains();
  g.Kpq = preset.L * wc; g.Kiq = preset.R * wc;
  g.Kpd = preset.L * wc; g.Kid = preset.R * wc;
  g.Kpv = Kpv; g.Kiv = Kpv * wv * alpha;
  g.Kpx = Kpx; g.Kix = 0; g.KixRef = Kpx * wx * kixRefRatio;
  g.fTorque = fFilter; g.fFlux = fFilter; g.fVel = fVel;
  g.Umax = 0.96 * vl;
  g.omegaLimit = wLim;
  g.iLimit = iLim;
  g.fc = fc; g.fv = fv; g.fx = fx; g.alpha = alpha; g.fFilter = fFilter;
  return g;
}

/**
 * Pull an integrator back after its loop output was clamped (back-calculation),
 * never past zero. `bc` is the integrator value that makes the output exactly
 * the clamped value; `hi` tells which limit was hit.
 * @param {number} integ current integrator value
 * @param {number} bc back-calculated value (clampedOut - Kp*err)
 * @param {boolean} hi true when the output hit the upper limit
 * @returns {number}
 */
function backCalc(integ, bc, hi) {
  if (hi) {
    const cap = bc > 0 ? bc : 0;
    return integ > cap ? cap : integ;
  }
  const floor = bc < 0 ? bc : 0;
  return integ < floor ? floor : integ;
}

/**
 * Multiplier lookup for the `gains` / `filters` configure options.
 * @param {object|string|null|undefined} obj
 * @param {string} key
 * @param {number} dflt
 * @returns {number}
 */
function mult(obj, key, dflt) {
  if (obj && typeof obj === 'object' && typeof obj[key] === 'number' && Number.isFinite(obj[key])) return obj[key];
  return dflt;
}

/**
 * FOC cascade controller (position / velocity / torque modes) for one motor.
 *
 * Targets are plain fields set by the world: `thetaStar` (mech rad),
 * `omegaStar` (mech rad/s), `iqStarCmd` (A). Call `configure` once (and again to
 * push new parameters; it keeps the controller state), `reset` to clear state,
 * then `step` once per control period.
 */
export class FocController {
  /** Creates an unconfigured controller with every field initialized. */
  constructor() {
    /** @type {object|null} motor preset (reference) */
    this.preset = null;
    this.nPhases = 2;
    this.p = 1;
    this.Irated = 1;
    this.Jt = 0;
    this.Vbus = 24;
    this.fs = 25000;
    this.invFs = 1 / 25000;
    /** @type {'position'|'velocity'|'torque'} */
    this.mode = 'position';
    this.modeCode = MODE_POSITION;
    this.runCurrent = 0;
    this.homingCurrent = 0.5;
    this.noiseSigmaFrac = 0.01;
    this.sigma = 0;
    /** Encoder counts per mechanical revolution for the cell-quantized position error (0 = continuous). */
    this.encoderCpr = 0;
    this._radPerCell = 0;
    /**
     * Position-loop deadband in encoder cells (only with `encoderCpr > 0`). With 1, the loop
     * ignores a rotor that sits in the target's cell or in either neighbor, so a rotor resting
     * on a cell edge is not kicked back and forth (without it the loop chatters at ~130 Hz).
     */
    this.deadbandCells = 1;

    /** Effective gains after multipliers (see optimalGains for the fields). */
    this.gains = zeroGains();
    /** Optimal (x1) gains for the current configuration. */
    this.optimal = zeroGains();
    /** Gain multipliers in effect (positionI multiplies KixRef). */
    this.multipliers = {
      positionP: 1, positionI: 0, velocityP: 1, velocityI: 1, torqueP: 1, torqueI: 1, fluxP: 1, fluxI: 1,
    };
    /** Filter cutoff multipliers in effect. */
    this.filterMultipliers = { torque: 1, flux: 1, velocity: 1 };

    /** @type {string[]} flag names ORed into `status` */
    this.mask = ['iqTargetLimit', 'uqOutputLimit', 'udOutputLimit'];
    this.maskIqTarget = true;
    this.maskXOutput = false;
    this.maskUqOutput = true;
    this.maskUdOutput = true;
    this.maskVErrSum = false;

    this.velocityFilter = new Biquad(25000);
    this.torqueFilter = new Biquad(25000);
    this.fluxFilter = new Biquad(25000);

    // Targets.
    this.thetaStar = 0;
    this.omegaStar = 0;
    this.iqStarCmd = 0;

    // Measurements and outputs.
    this.thetaMeasE = 0;
    this.cosE = 1;
    this.sinE = 0;
    this.omegaFilt = 0;
    this.id = 0;
    this.iq = 0;
    this.idf = 0;
    this.iqf = 0;
    this.idStar = 0;
    this.iqStar = 0;
    this.omegaStarOut = 0;
    this.ud = 0;
    this.uq = 0;
    this.uMag = 0;
    this.uLimit = 0;
    this.uAlpha = 0;
    this.uBeta = 0;
    this.iLimit = 0;
    this.homing = false;
    this.flags = {
      iqTargetLimit: false, xOutputLimit: false, uqOutputLimit: false, udOutputLimit: false, vErrSumLimit: false,
    };
    this.status = false;
    this.iPhaseMeas = new Float64Array(2);
    this.noiseA = 0;
    this.integX = 0;
    this.integV = 0;
    this.integQ = 0;
    this.integD = 0;

    // Scratch vectors for the transforms (reused every step).
    this._ab = { alpha: 0, beta: 0 };
    this._dq = { d: 0, q: 0 };
    this._uab = { alpha: 0, beta: 0 };
    // Sense noise of one period, and the step inputs as fields: step() and stepEncoder() hand
    // them to _run() without double arguments, which are boxed when a call is not inlined.
    this._noise = new Float64Array(3);
    this._inTheta = 0;
    this._inOmega = 0;
    this._inCount = NaN;
  }

  /**
   * Set parameters. Allocation is allowed here. Calling it again keeps the
   * controller state (integrators, filter states, targets, homing), so the world
   * can push new parameters without a reset; a new phase count or sample rate
   * rebuilds the affected buffers/filters, and an integrator whose I gain is now 0
   * is cleared (see "Gain changes" in the file header).
   *
   * @param {object} cfg
   * @param {object} cfg.preset motor preset from getMotorPreset
   * @param {number} cfg.Jt total inertia (kg*m^2)
   * @param {number} [cfg.Vbus=24] supply voltage (V)
   * @param {number} [cfg.fs=25000] control sample rate (Hz)
   * @param {'position'|'velocity'|'torque'} [cfg.mode='position']
   * @param {number} [cfg.runCurrent] current limit when not homing (A), default preset.Irated
   * @param {number} [cfg.homingCurrent=0.5] current limit while homing (A)
   * @param {'optimal'|object} [cfg.gains='optimal'] multipliers of the optimal gains
   *   ({ positionP, positionI, velocityP, velocityI, torqueP, torqueI, fluxP, fluxI });
   *   missing keys are 1, except positionI (multiplies KixRef) which defaults to 0
   * @param {{torque?: number, flux?: number, velocity?: number}} [cfg.filters] multipliers of the optimal cutoffs
   * @param {string[]} [cfg.mask] flag names ORed into `status`
   * @param {number} [cfg.omegaLimit] position loop output limit (mech rad/s)
   * @param {number} [cfg.noiseSigmaFrac=0.01] current-sense noise sigma as a fraction of Irated
   * @param {number} [cfg.encoderCpr=0] encoder counts per revolution; > 0 makes the position
   *   error whole encoder cells when `step` gets a count (0 = continuous error)
   * @param {number} [cfg.deadbandCells=1] cells of position error ignored on each side of the
   *   target cell (cell-quantized error only)
   * @param {typeof TUNING} [cfg.tuning=TUNING] tuning constants (passed to optimalGains)
   * @returns {FocController} this
   */
  configure(cfg) {
    const {
      preset, Jt, Vbus = 24, fs = 25000, mode = 'position', runCurrent, homingCurrent = 0.5,
      gains = 'optimal', filters = null, mask = null, omegaLimit, noiseSigmaFrac = 0.01, tuning = TUNING,
      encoderCpr = 0, deadbandCells = 1,
    } = cfg;
    this.deadbandCells = (typeof deadbandCells === 'number' && deadbandCells >= 0) ? Math.round(deadbandCells) : 1;
    this.preset = preset;
    this.nPhases = preset.phases === 3 ? 3 : 2;
    this.p = preset.p;
    this.Irated = preset.Irated;
    this.Jt = Jt;
    this.Vbus = Vbus;
    this.mode = mode === 'velocity' ? 'velocity' : (mode === 'torque' ? 'torque' : 'position');
    this.modeCode = this.mode === 'velocity' ? MODE_VELOCITY : (this.mode === 'torque' ? MODE_TORQUE : MODE_POSITION);
    this.runCurrent = (typeof runCurrent === 'number' && runCurrent >= 0) ? runCurrent : preset.Irated;
    this.homingCurrent = homingCurrent;
    this.noiseSigmaFrac = noiseSigmaFrac;
    this.sigma = noiseSigmaFrac * preset.Irated;
    const cpr = (typeof encoderCpr === 'number' && encoderCpr > 0) ? encoderCpr : 0;
    this.encoderCpr = cpr;
    this._radPerCell = cpr > 0 ? TWO_PI / cpr : 0;

    if (this.iPhaseMeas.length !== this.nPhases) this.iPhaseMeas = new Float64Array(this.nPhases);
    if (fs !== this.fs) {
      this.fs = fs;
      this.velocityFilter = new Biquad(fs);
      this.torqueFilter = new Biquad(fs);
      this.fluxFilter = new Biquad(fs);
    }
    this.invFs = 1 / fs;

    const opt = optimalGains(preset, Jt, { tuning: tuning || TUNING, Vbus, omegaLimit, runCurrent: this.runCurrent });
    copyGains(this.optimal, opt);

    const m = this.multipliers;
    m.positionP = mult(gains, 'positionP', 1);
    m.positionI = mult(gains, 'positionI', 0);
    m.velocityP = mult(gains, 'velocityP', 1);
    m.velocityI = mult(gains, 'velocityI', 1);
    m.torqueP = mult(gains, 'torqueP', 1);
    m.torqueI = mult(gains, 'torqueI', 1);
    m.fluxP = mult(gains, 'fluxP', 1);
    m.fluxI = mult(gains, 'fluxI', 1);
    const fm = this.filterMultipliers;
    fm.torque = mult(filters, 'torque', 1);
    fm.flux = mult(filters, 'flux', 1);
    fm.velocity = mult(filters, 'velocity', 1);

    const g = copyGains(this.gains, opt);
    g.Kpx = opt.Kpx * m.positionP;
    g.Kix = opt.KixRef * m.positionI;
    g.Kpv = opt.Kpv * m.velocityP;
    g.Kiv = opt.Kiv * m.velocityI;
    g.Kpq = opt.Kpq * m.torqueP;
    g.Kiq = opt.Kiq * m.torqueI;
    g.Kpd = opt.Kpd * m.fluxP;
    g.Kid = opt.Kid * m.fluxI;
    // An I gain of 0 can no longer move its integrator: drop the stored term (file header).
    if (g.Kix === 0) this.integX = 0;
    if (g.Kiv === 0) this.integV = 0;
    if (g.Kiq === 0) this.integQ = 0;
    if (g.Kid === 0) this.integD = 0;

    // Filter cutoffs (the Biquad clamps to 0.45*fs; report the effective value).
    this.torqueFilter.setCutoff(opt.fTorque * fm.torque);
    this.fluxFilter.setCutoff(opt.fFlux * fm.flux);
    this.velocityFilter.setCutoff(opt.fVel * fm.velocity);
    g.fTorque = this.torqueFilter.cutoff;
    g.fFlux = this.fluxFilter.cutoff;
    g.fVel = this.velocityFilter.cutoff;

    const mk = Array.isArray(mask) ? mask : ['iqTargetLimit', 'uqOutputLimit', 'udOutputLimit'];
    this.mask = mk.slice();
    this.maskIqTarget = mk.indexOf('iqTargetLimit') >= 0;
    this.maskXOutput = mk.indexOf('xOutputLimit') >= 0;
    this.maskUqOutput = mk.indexOf('uqOutputLimit') >= 0;
    this.maskUdOutput = mk.indexOf('udOutputLimit') >= 0;
    this.maskVErrSum = mk.indexOf('vErrSumLimit') >= 0;

    this.uLimit = g.Umax;
    this.iLimit = this.homing ? this.homingCurrent : this.runCurrent;
    return this;
  }

  /**
   * Clear the controller state: integrators 0, filters reset to 0, thetaStar =
   * thetaMeasM, omegaStar = 0, iqStarCmd = 0, flags and outputs cleared. The
   * homing state is kept.
   * @param {number} [thetaMeasM=0] measured mechanical angle (rad)
   */
  reset(thetaMeasM = 0) {
    this.integX = 0; this.integV = 0; this.integQ = 0; this.integD = 0;
    this.velocityFilter.reset(0);
    this.torqueFilter.reset(0);
    this.fluxFilter.reset(0);
    this.thetaStar = thetaMeasM;
    this.omegaStar = 0;
    this.iqStarCmd = 0;
    this.thetaMeasE = thetaMeasM * this.p;
    this.cosE = Math.cos(wrapPi(this.thetaMeasE));
    this.sinE = Math.sin(wrapPi(this.thetaMeasE));
    this.omegaFilt = 0;
    this.id = 0; this.iq = 0; this.idf = 0; this.iqf = 0;
    this.idStar = 0; this.iqStar = 0; this.omegaStarOut = 0;
    this.ud = 0; this.uq = 0; this.uMag = 0; this.uAlpha = 0; this.uBeta = 0;
    this.iPhaseMeas.fill(0);
    this.noiseA = 0;
    const f = this.flags;
    f.iqTargetLimit = false; f.xOutputLimit = false; f.uqOutputLimit = false; f.udOutputLimit = false;
    f.vErrSumLimit = false;
    this.status = false;
    this.iLimit = this.homing ? this.homingCurrent : this.runCurrent;
  }

  /**
   * Enter or leave homing: the current limit becomes `homingCurrent` while
   * active, `runCurrent` otherwise.
   * @param {boolean} active
   */
  setHoming(active) {
    this.homing = !!active;
    this.iLimit = this.homing ? this.homingCurrent : this.runCurrent;
  }

  /**
   * One control period. Reads the targets (`thetaStar`, `omegaStar`,
   * `iqStarCmd`), writes `uAlpha`, `uBeta` and every diagnostic field.
   * Does not allocate.
   * @param {number} thetaMeasM measured mechanical angle (rad, unwrapped)
   * @param {number} omegaEstRadS encoder speed estimate (mech rad/s, unfiltered)
   * @param {ArrayLike<number>} iPhase actual phase currents (A), length = phases
   * @param {{fillGaussian: function(Float64Array, number): void}|null} rng seeded generator for the
   *   sense noise (units.js Rng; null = no noise)
   * @param {number} [count=NaN] encoder count (cells of 2pi/encoderCpr); when finite and
   *   `encoderCpr > 0` the position error is `(floor(thetaStar*cpr/2pi) - count)*2pi/cpr`
   */
  step(thetaMeasM, omegaEstRadS, iPhase, rng, count = NaN) {
    this._inTheta = thetaMeasM;
    this._inOmega = omegaEstRadS;
    this._inCount = count;
    this._run(iPhase, rng);
  }

  /**
   * step() with the angle, speed estimate and count read from an encoder (`thetaMeas`,
   * `omegaEst`, `count`): the world's per-step path, with no double arguments to box.
   * @param {{thetaMeas: number, omegaEst: number, count: number}} enc
   * @param {ArrayLike<number>} iPhase actual phase currents (A)
   * @param {{fillGaussian: function(Float64Array, number): void}|null} rng
   */
  stepEncoder(enc, iPhase, rng) {
    this._inTheta = enc.thetaMeas;
    this._inOmega = enc.omegaEst;
    this._inCount = enc.count;
    this._run(iPhase, rng);
  }

  /**
   * The control period of step()/stepEncoder() on the inputs they stored.
   * @private
   */
  _run(iPhase, rng) {
    const thetaMeasM = this._inTheta;
    const omegaEstRadS = this._inOmega;
    const count = this._inCount;
    const g = this.gains;
    const f = this.flags;
    const invFs = this.invFs;
    const iLim = this.iLimit;

    // Angle and speed feedback.
    const thE = thetaMeasM * this.p;
    this.thetaMeasE = thE;
    const w = wrapPi(thE);
    const c = Math.cos(w);
    const s = Math.sin(w);
    this.cosE = c;
    this.sinE = s;
    const omega = this.velocityFilter.process(omegaEstRadS);
    this.omegaFilt = omega;

    // Current sensing with noise.
    const sigma = this.sigma;
    const meas = this.iPhaseMeas;
    const n = this.nPhases;
    const noisy = !!rng && sigma > 0;
    const nzs = this._noise;
    if (noisy) rng.fillGaussian(nzs, n);    // the same draws, in the same order, as n gaussian() calls
    for (let k = 0; k < n; k++) {
      const nz = noisy ? sigma * nzs[k] : 0;
      meas[k] = iPhase[k] + nz;
      if (k === 0) this.noiseA = nz;
    }
    const ab = n === 3 ? clarke3(meas[0], meas[1], meas[2], this._ab) : clarke2(meas[0], meas[1], this._ab);
    const dq = park(ab.alpha, ab.beta, c, s, this._dq);
    const id = dq.d;
    const iq = dq.q;
    this.id = id;
    this.iq = iq;
    const idf = this.fluxFilter.process(id);
    const iqf = this.torqueFilter.process(iq);
    this.idf = idf;
    this.iqf = iqf;

    f.iqTargetLimit = false; f.xOutputLimit = false; f.uqOutputLimit = false; f.udOutputLimit = false;
    f.vErrSumLimit = false;

    const mode = this.modeCode;
    let iqStar = 0;
    if (mode === MODE_TORQUE) {
      iqStar = this.iqStarCmd;
      if (iqStar > iLim) { iqStar = iLim; f.iqTargetLimit = true; } else if (iqStar < -iLim) { iqStar = -iLim; f.iqTargetLimit = true; }
      this.omegaStarOut = this.omegaStar;
    } else {
      // Position loop (position mode only).
      let wStar = this.omegaStar;
      if (mode === MODE_POSITION) {
        // Whole encoder cells when a count is given (zero inside the target's cell).
        // Same expression as encoder.js so a target and a rotor at the same angle
        // land in the same cell.
        const cpr = this.encoderCpr;
        let e;
        if (cpr > 0 && Number.isFinite(count)) {
          let cells = Math.floor(this.thetaStar * cpr / TWO_PI) - count;
          const db = this.deadbandCells;
          if (cells > db) cells -= db; else if (cells < -db) cells += db; else cells = 0;
          e = cells * this._radPerCell;
        } else {
          e = this.thetaStar - thetaMeasM;
        }
        this.integX += g.Kix * e * invFs;
        const pTerm = g.Kpx * e;
        wStar = pTerm + this.integX;
        const wLim = g.omegaLimit;
        if (wStar > wLim) {
          wStar = wLim; f.xOutputLimit = true;
          this.integX = backCalc(this.integX, wLim - pTerm, true);
        } else if (wStar < -wLim) {
          wStar = -wLim; f.xOutputLimit = true;
          this.integX = backCalc(this.integX, -wLim - pTerm, false);
        }
      }
      this.omegaStarOut = wStar;

      // Velocity loop.
      const ev = wStar - omega;
      let iv = this.integV + g.Kiv * ev * invFs;
      if (iv > iLim) { iv = iLim; f.vErrSumLimit = true; } else if (iv < -iLim) { iv = -iLim; f.vErrSumLimit = true; }
      const pv = g.Kpv * ev;
      iqStar = pv + iv;
      if (iqStar > iLim) {
        iqStar = iLim; f.iqTargetLimit = true;
        iv = backCalc(iv, iLim - pv, true);
      } else if (iqStar < -iLim) {
        iqStar = -iLim; f.iqTargetLimit = true;
        iv = backCalc(iv, -iLim - pv, false);
      }
      this.integV = iv;
    }
    this.idStar = 0;
    this.iqStar = iqStar;

    // Current loops.
    const eq = iqStar - iqf;
    const ed = -idf;
    this.integQ += g.Kiq * eq * invFs;
    this.integD += g.Kid * ed * invFs;
    const pq = g.Kpq * eq;
    const pd = g.Kpd * ed;
    let uq = pq + this.integQ;
    let ud = pd + this.integD;

    // Voltage circle, d axis has priority.
    const Umax = g.Umax;
    if (ud > Umax) {
      ud = Umax; f.udOutputLimit = true;
      this.integD = backCalc(this.integD, Umax - pd, true);
    } else if (ud < -Umax) {
      ud = -Umax; f.udOutputLimit = true;
      this.integD = backCalc(this.integD, -Umax - pd, false);
    }
    const r2 = Umax * Umax - ud * ud;
    const uqMax = r2 > 0 ? Math.sqrt(r2) : 0;
    if (uq > uqMax) {
      uq = uqMax; f.uqOutputLimit = true;
      this.integQ = backCalc(this.integQ, uqMax - pq, true);
    } else if (uq < -uqMax) {
      uq = -uqMax; f.uqOutputLimit = true;
      this.integQ = backCalc(this.integQ, -uqMax - pq, false);
    }
    this.ud = ud;
    this.uq = uq;
    this.uMag = Math.sqrt(ud * ud + uq * uq);
    this.uLimit = Umax;
    const uab = invPark(ud, uq, c, s, this._uab);
    this.uAlpha = uab.alpha;
    this.uBeta = uab.beta;

    this.status = (this.maskIqTarget && f.iqTargetLimit) || (this.maskXOutput && f.xOutputLimit)
      || (this.maskUqOutput && f.uqOutputLimit) || (this.maskUdOutput && f.udOutputLimit)
      || (this.maskVErrSum && f.vErrSumLimit);
  }
}
