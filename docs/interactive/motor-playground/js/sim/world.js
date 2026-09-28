// World: the motor playground simulation (chunk-02 design section 15, SPEC 5).
//
// ---------------------------------------------------------------------------------------------
// MODEL (SI units inside: rad, rad/s, N·m, A, V, s, Ω, H, kg·m²; mm only at the API edges,
// mm = rad·rd/(2π) with the rotation distance rd = 40 mm per motor turn)
//
// Motor (motor.js), non-salient PM machine in the stationary α/β frame, explicit Euler:
//   eα = −λ·ωe·sin θe, eβ = λ·ωe·cos θe;  diα/dt = (vα − R·iα − eα)/L (same for β)
//   id = iα cos θe + iβ sin θe, iq = −iα sin θe + iβ cos θe;  Te = Kt·iq, Kt = kf·p·λ
//   θe = p·θm, kf = 1 (two-phase stepper, p = 50) or 3/2 (three-phase BLDC, p = 7,
//   amplitude-invariant Clarke). Phase values come from the inverse Clarke transform.
// Mechanics (mechanics.js), semi-implicit Euler per motor:
//   Jt·dω/dt = Te − B·ω − (Tc + Tdrag)·tanh(ω/ωε) − Tload − Tbump(t) − Tcontact
//   Jt = Jrotor + Jload (axis, free) or Jrotor + Jload/2 (CoreXY). B = 1e-5, Tc = 0.02 N·m,
//   ωε = 0.5 rad/s, plus a stick rule: a rotor whose speed would cross zero within a step sticks
//   at exactly 0 while |net torque| ≤ Tc (true static friction; the drag slider stays smooth).
//   Tbump = A·sin(πt/T) half-sine. Hard stops at 0 and axisLength:
//   Tcontact = k·θp + 2·sqrt(k·Jt)·ωp, k = scenario.stopStiffness (default 2 N·m/rad: a belt
//   that gives, so the homing current visibly presses in; 500 = rigid stop). Axis x = θ0·rd/2π;
//   CoreXY x = rd(θA + θB)/4π, y = rd(θA − θB)/4π.
// Encoder (encoder.js): count = floor(θ·cpr/2π) (cpr 4000), θmeas = (count + 0.5)·2π/cpr (cell
//   center); ωest is timer based (M/T method): on each edge, counts moved over the time between
//   edges at least encoder.windowS (0.5 ms) apart, held between edges and bounded by one count
//   per elapsed time once edges stop; A/B quadrature from count mod 4.
// Step generation (stepgen.js): commanded motor angle quantized to 2π/stepsPerRev, STEP/DIR
//   pulses = change of the quantized position. Open loop: stepsPerRev = 4·p·microsteps
//   (= 200·microsteps for the 1.8° stepper); FOC: virtual steps fullStepsPerRev·microsteps.
//   singleStep moves the command to (sent ± 1)·stepAngle of motor 0's generator: one pulse.
// Open-loop driver (drivers/openloop.js): θcmd += pulses·(π/2)/microsteps (electrical),
//   optional 256-step interpolation; targets iA* = I cos θcmd, iB* = I sin θcmd.
//   Current mode: per-phase PI, Kp = L·ωc, Ki = R·ωc, ωc = 2π·3 kHz, clamp ±Vbus (averaged)
//   or a 40 kHz mean-centered chopper (switching fidelity, dt = 0.5 µs). Voltage mode:
//   v = vAmp·cos(θcmd − φk), dvAmp/dt = (R/30 ms)·(I − LPF200|i|). Hybrid: current mode once the
//   planner's commanded speed reaches hybridThresholdMmS, back to voltage mode below 0.9× that
//   (hysteresis). I = runCurrent (scenario null → the preset's Irated); the compare motor
//   (motor 1 with compareMotor set) uses compareMotor.runCurrent, null → its own preset's Irated
//   (an open-loop compare motor on a BLDC scenario is the stepper: 3.54 A, not 5.6 A).
// StallGuard (drivers/stallguard.js): sg = 1023·clamp(1 − 0.92·|sin δ|·(1 + 0.3|ωm|/ωref), 0, 1)
//   (a stalled rotor reads about 82: SG_STALL_FLOOR 0.08),
//   δ = atan2(iq, id) (current vector vs rotor d axis), ωref = 100 mm/s; null while the
//   planner's commanded speed is below minSpeedMmS; diag = sg < 2·sgthrs.
// FOC (drivers/foc.js), sampled at 25 kHz (every 40 µs control tick):
//   position ω* = clamp(Kpx·eθ + Kix∫, ±ωLimit), θ* += pulses·2π/virtualSteps, with the error
//            in whole encoder cells: eθ = (floor(θ*·cpr/2π) − count)·2π/cpr with a one-cell
//            deadband on each side (0 while the rotor sits in or next to the target's cell, so
//            the loop does not hunt at rest)
//   velocity iq* = clamp(Kpv·(ω* − LPF(ωest)) + Kiv∫, ±iLimit)
//   current  uq = Kpq·(iq* − LPF(iq)) + Kiq∫, ud = Kpd·(0 − LPF(id)) + Kid∫, |u| ≤ Umax
//   (vα, vβ) = invPark(ud, uq, p·θmeas). Phase current noise σ = 1% Irated.
//   Optimal gains (TUNING in drivers/foc.js, absolute frequencies in Hz: fc current-loop
//   crossover, fv velocity-loop crossover, alpha places the velocity PI zero at alpha·fv, fx
//   position-loop crossover, fFilter iq/id sense filter cutoff, fVel velocity feedback filter
//   cutoff, kixRefRatio position-I slider reference; see that object for the values):
//   Kpq = Kpd = L·2πfc, Kiq = Kid = R·2πfc; Kpv = Jt·2πfv/Kt, Kiv = Kpv·2πfv·alpha;
//   Kpx = 2πfx, Kix = 0 (KixRef = Kpx·2πfx·kixRefRatio); filters at fFilter and fVel;
//   Umax = 0.96·Vlimit (Vbus, or Vbus/√3 three-phase); ωLimit = omegaLimitFactor·maxVelocity
//   (×√2 on CoreXY: a 45° move at maxVelocity drives one belt at √2·maxVelocity; a maxVelocity
//   lowered mid-move keeps the planner's speed until the planner has slowed down to it);
//   iLimit = runCurrent (homingCurrent while homing). scenario.foc.gains holds multipliers.
//   Values (2026-09-23): fFilter 1200, fc 400, fv 75, alpha 0.25, fVel 225, fx 28, kixRefRatio 2.
//   Status output: snapshot.motors[i].status is latched like the chip's STATUS_FLAGS (set on any
//   masked flag, cleared once the flags are gone and the carriage has been off every stop for
//   50 ms); motors[i].flags stay live.
// Planner (planner.js): trapezoidal moves along polylines, Klipper junction speeds (scv).
//   Leaving a setTarget speed command hands the ramp's current speed to the planner (moveTo and
//   runPath brake from it, jog ramps from it). jog, moveTo, runPath, singleStep and setTarget
//   first abort a running sweep or homing (restoring what those machines override).
// Homing (world-machines.js): FOC ramp 250 mm/s² by default; no rebase on the trigger, the
//   command stays where it triggered and the driver keeps pressing at the homing current;
//   freeIqPeak = max |iq*| (FOC) or |i|; the trigger is the latched status (rising edge).
//
// Time step: dt = 40 µs (averaged) or 0.5 µs (switching). Planner, FOC and the averaged current
// PI run every 40 µs control tick. Per step: planner (control ticks) → step generators →
// drivers → motors → mechanics → encoders/StallGuard → snapshot, homing/sweep machines,
// metrics, traces (every `decimation` steps, decimation = max(1, ceil(traceWindow/(4096·dt))),
// so the ring spans at least traceWindow; see traceDecimation in world-traces.js).
//
// Derived snapshot values: loadAngle = atan2(iq, id); cmdAngleErr = wrapPi(θcmd − θe);
// lostCycles = round((θcmd − θe)/2π) (open loop; always 0 for FOC), lostMm = lostCycles·rd/p;
// heat = exponential 1 s mean of Σ iPhase²/(kf·Irated²) (1.0 = rated current continuously).
// Noise signal world.noise[i] (A, the `noise` trace): FOC (uq − LPF500(uq))/Kpq with the ×1
// (optimal) Kpq, so a torque P multiplier of 6 shows 6× the noise; open loop e − LPF500(e) with
// the regulation error e = iA − iA* (the current fundamental cancels at speed).
//
// Metrics (metrics.js, published every 100 ms of sim time, motor 0): overshootPct/Mm (peak
// past the final position after a stop, % of the deceleration distance), settleMs (until
// |error| < 0.02 mm), cornerErrMm (max distance to the commanded polyline near corners),
// oscFreqHz/oscAmp (at rest, no bump or load-torque change in the last 0.2 s: high-passed iq
// for FOC, in A, or rotor speed omegaM for open loop, in rad/s), noiseIdx (RMS of world.noise[0]
// / Irated), rippleRms/Pp (phase-A chopper ppLast in switching fidelity, rms = pp/(2√3); 0 in
// averaged fidelity and FOC), iAmpPct (LPF200|i| vs target), phaseLagDeg (θcmd vs current
// angle), stepRate, lostStepsMm (CoreXY: magnitude of the x/y loss from both belts), pressInMm,
// freeMotionIqPeak, rise (L·I/(Vbus − R·I)), sweep, posErrMm, velErrMmS, heat.
// ---------------------------------------------------------------------------------------------
//
// Hot path (step) does not allocate except for rare event objects and state-machine
// transitions.

import { TWO_PI, Rng } from './units.js';
import { Lowpass1 } from './biquad.js';
import { getMotorPreset, vLimit } from './presets.js';
import { Motor } from './motor.js';
import { Mechanics } from './mechanics.js';
import { Encoder } from './encoder.js';
import { StepGen } from './stepgen.js';
import { Planner } from './planner.js';
import { OpenLoopDriver } from './drivers/openloop.js';
import { StallGuard } from './drivers/stallguard.js';
import { FocController, optimalGains, TUNING } from './drivers/foc.js';
import { Metrics } from './metrics.js';
import {
  SCENARIO_DEFAULTS, cloneDeep, deepMerge, setPath, isStructural, normalizeScenario, normalizeGains,
  normalizeFilters, normalizeDriverMode, unitGains,
} from './world-scenario.js';
import { RingBuffer, buildTraces, traceDecimation } from './world-traces.js';
import { buildSnapshot, fillSnapshot, stepWorld, updateCommand, CONTROL_DT, FOC_POS, FOC_VEL, FOC_TRQ } from './world-step.js';
import { HomingMachine, SweepMachine } from './world-machines.js';

export { RingBuffer, SCENARIO_DEFAULTS };

/** Sim step, averaged fidelity (s). */
const DT_AVERAGED = 40e-6;
/** Sim step, switching fidelity (s). */
const DT_SWITCHING = 0.5e-6;
/** Rotation distance (mm per motor turn). */
const RD_MM = 40;
/** Heat time constant (s). */
const HEAT_TAU = 1;
/** Maximum undrained events kept (older ones are kept, newer dropped). */
const EVENT_CAP = 256;
const EMPTY = Object.freeze({});

/**
 * @param {*} v
 * @param {number} dflt
 * @returns {number}
 */
function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Deep-freezes a clone (read-only scenario view).
 * @param {*} o
 * @returns {*}
 */
function frozenClone(o) {
  const c = cloneDeep(o);
  const f = (x) => {
    if (x && typeof x === 'object') {
      Object.freeze(x);
      for (const k of Object.keys(x)) f(x[k]);
    }
  };
  f(c);
  return c;
}

/**
 * The motor playground world: owns every sim module, advances them in a fixed order and
 * publishes one `snapshot` object mutated in place, trace ring buffers, metrics and events.
 *
 * Public module fields (read by metrics, the machines and debugging tools): `planner`,
 * `mechanics`, `motors[i]`, `encoders[i]`, `stepgens[i]`, `openloop[i]` / `foc[i]` (the
 * driver of motor i, the other one is null), `stallguards[i]` (null for FOC), `presets[i]`,
 * `nMotors`, `kinematics`, `rd`, `controlDt`, `controlEvery`.
 */
export class World {
  /** Creates a world configured with the default scenario. */
  constructor() {
    /** @type {object} internal scenario (use the `scenario` getter from outside) */
    this._sc = cloneDeep(SCENARIO_DEFAULTS);
    /** @type {object|null} cached read-only view */
    this._scView = null;
    /** True while runCurrent follows the preset's Irated (scenario runCurrent was null). */
    this._runCurrentAuto = true;
    this._dt = DT_AVERAGED;
    this._t = 0;
    /** Control period (s) and sim steps per control tick. */
    this.controlDt = CONTROL_DT;
    this.controlEvery = 1;
    this._tick = 0;
    this.rd = RD_MM;
    this._mmPerRad = RD_MM / TWO_PI;
    this.nMotors = 1;
    /** @type {'free'|'axis'|'corexy'} */
    this.kinematics = 'axis';
    this.compareActive = false;

    /** @type {object[]} */ this.presets = [];
    /** @type {Motor[]} */ this.motors = [];
    /** @type {Mechanics} */ this.mechanics = new Mechanics(2);
    /** @type {Planner} */ this.planner = new Planner();
    /** @type {Encoder[]} */ this.encoders = [];
    /** @type {StepGen[]} */ this.stepgens = [];
    /** @type {Array<OpenLoopDriver|null>} */ this.openloop = [];
    /** @type {Array<FocController|null>} */ this.foc = [];
    /** @type {Array<StallGuard|null>} */ this.stallguards = [];
    /** @type {string[]} 'openloop' | 'foc' per motor */ this.driverKinds = [];
    /** @type {string[]} driver mode per motor */ this.driverModes = [];
    /** @type {Rng} */ this.rng = new Rng(1);
    /** @type {Metrics} */ this.metricsEngine = new Metrics();
    /** @type {object|null} optimalGains() of motor 0 */ this._optimal = null;

    // Per-motor numeric state (reallocated in _build with the motor count).
    this.cmdTheta = new Float64Array(2);   // commanded motor angle (rad)
    this.cmdOmega = new Float64Array(2);   // commanded motor speed (rad/s)
    this.noise = new Float64Array(2);      // noise signal (A), see fillMotor in world-step.js
    this._noiseScale = new Float64Array(2); // FOC: 1/Kpq(optimal); open loop: 0 (unused)
    this.iAmpLpfOut = new Float64Array(2); // LPF200(|i|)
    this._torques = new Float64Array(1);
    this._p = new Float64Array(2);
    this._spr = new Float64Array(2);       // step-source steps per rev
    this._stepAngle = new Float64Array(2); // rad per pulse
    this._srcIdx = new Int32Array(2);      // planner motor index each motor follows
    this._focMode = new Int32Array(2);
    this._omegaCmdOL = new Float64Array(2);
    this._loadAngle = new Float64Array(2);
    this._heat = new Float64Array(2);
    this._heatNorm = new Float64Array(2);
    this._uLimitOL = new Float64Array(2);
    this._iTarget = new Float64Array(2);
    this._prevLost = new Float64Array(2);
    this._prevDiag = new Uint8Array(2);
    /** Previous latched status level per motor (flagSet rising edge, see fillFoc). */
    this._prevStatus = new Uint8Array(2);
    /** @type {object|null} event rate-limit state (EventGates, created by buildSnapshot) */
    this._gates = null;
    /** Latched status per motor (1 = the status output is high), see fillFoc. */
    this._statusLatch = new Uint8Array(2);
    /** Steps the clear condition has held per motor. */
    this._statusClear = new Int32Array(2);
    /** Steps the clear condition must hold before the latch drops (50 ms). */
    this._statusClearN = 1250;
    this._velBase = new Float64Array(2);
    this._saveTheta = new Float64Array(2);
    this._saveOmega = new Float64Array(2);
    this._va = new Float64Array(2);        // driver output voltage alpha (V)
    this._vb = new Float64Array(2);        // driver output voltage beta (V)
    this._bumpScales = new Float64Array(2); // per-motor bump factors of a directed CoreXY bump
    /** @type {Lowpass1[]} */ this._noiseLpf = [];
    /** @type {Lowpass1[]} */ this._iAmpLpf = [];
    /** @type {Lowpass1[]} */ this._vAmpLpf = [];
    this._heatK = 0;

    // Commanded toolhead (mm, mm/s).
    this.xCmd = 0;
    this.yCmd = 0;
    this.vxCmd = 0;
    this.vyCmd = 0;
    // Constant-speed target (setTarget { omegaMmS }).
    this._velActive = false;
    this._velTarget = 0;
    this._velCmd = 0;
    this._velTheta = 0;
    this._velAccel = 0;
    this._iqTarget = 0;
    // Overrides used by homing (retract speed) and the sweep (0 = none).
    this._maxVelOverride = 0;
    this._accelOverride = 0;
    this._homingCurrentOverride = 0;
    this._sweepNoStops = false;
    // Planner speed (mm/s) at or under which the control tick releases the FOC position-loop
    // speed limit held after a maxVelocity drop (-1 = no hold; see _derive, _releaseOmegaHold).
    this._omegaHoldMmS = -1;
    // Step trace state (see world-traces.js). stepPulses: motor 0's pulses since the last trace
    // sample (the `stepN` trace).
    this.stepEdges = 0;
    this.stepLast = 0;
    this.stepPulses = 0;
    this._prevStopX = false;
    this._prevStopY = false;
    this.eventsDropped = 0;

    /** @type {object[]} */ this._events = [];
    /** @type {object|null} */ this.snapshot = null;
    /** @type {Map<string, RingBuffer>} */ this._traces = new Map();
    /** @type {RingBuffer[]} */ this._traceBufs = [];
    /** @type {Int32Array} trace source codes */ this._traceCodes = new Int32Array(0);
    /** @type {Int32Array} trace motor indices */ this._traceMotors = new Int32Array(0);
    this._decimation = 1;
    this._decimCount = 0;

    this.homing = new HomingMachine(this);
    this.sweep = new SweepMachine(this);
    this.configure({});
  }

  // ------------------------------------------------------------------ getters

  /** Sim step (s): 40e-6 averaged, 0.5e-6 switching. @returns {number} */
  get dt() { return this._dt; }
  /** Sim time (s) of the state in the snapshot. @returns {number} */
  get t() { return this._t; }
  /** Trace ring buffers keyed `name#motorIndex` (rebuilt on configure). @returns {Map<string, RingBuffer>} */
  get traces() { return this._traces; }
  /** Metric values (`Metrics.values`, mutated in place). @returns {object} */
  get metrics() { return this.metricsEngine.values; }
  /** Event list (same array as `snapshot.events`; the UI drains it). @returns {object[]} */
  get events() { return this._events; }
  /** Read-only (frozen) copy of the current scenario. @returns {object} */
  get scenario() {
    if (this._scView === null) this._scView = frozenClone(this._sc);
    return this._scView;
  }
  /** optimalGains() for motor 0 under the current scenario (the ×1 reference). @returns {object} */
  get optimal() { return this._optimal; }
  /** The FOC tuning constants. @returns {object} */
  get tuning() { return TUNING; }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Replaces the scenario (deep-merged over the defaults), rebuilds every module, resets the
   * state: t = 0, planner and mechanics at `start`, traces cleared, events emptied. Starts
   * `scenario.path` when it is set.
   * @param {object} [scenario] partial scenario (contract section 15)
   */
  configure(scenario) {
    const partial = scenario && typeof scenario === 'object' ? scenario : EMPTY;
    const sc = cloneDeep(SCENARIO_DEFAULTS);
    deepMerge(sc, partial);
    const hint = ('motorType' in partial && !('motorPreset' in partial)) ? 'motorType' : 'motorPreset';
    this._runCurrentAuto = !(typeof sc.runCurrent === 'number' && Number.isFinite(sc.runCurrent));
    normalizeScenario(sc, hint);
    if (sc.foc.gains !== 'optimal') sc.foc.gains = normalizeGains(sc.foc.gains);
    // A running sweep's temporary supply voltage lives only in the scenario being replaced.
    this._dropSweep();
    this._sc = sc;
    this._scView = null;
    this._build();
  }

  /**
   * Sets one scenario value by dotted path, then pushes all non-structural parameters into
   * the modules without touching the state. Structural keys (motorType, motorPreset, driver,
   * fidelity, mechanics, compareMotor, every encoder.* key) rebuild the world; a rebuild ends a
   * running sweep and puts its original supply voltage back. traceWindow only clears the
   * traces. Setting `foc.gains.<key>` while gains are 'optimal' first expands them to the
   * all-×1 object.
   * @param {string} path e.g. 'supplyV', 'foc.gains.velocityP'
   * @param {*} value
   * @param {{ reset?: boolean }} [opts] reset: rebuild as configure does
   */
  set(path, value, opts) {
    const sc = this._sc;
    const p = String(path);
    const rebuild = (opts && opts.reset === true) || isStructural(p);
    // A rebuild ends a running sweep: its original supply voltage goes back first, so a
    // supplyV set with { reset: true } still wins.
    if (rebuild) this._dropSweep();
    if (p.startsWith('foc.gains.') && sc.foc.gains === 'optimal') sc.foc.gains = unitGains();
    setPath(sc, p, cloneDeep(value));
    const root = p.split('.')[0];
    const motorKey = root === 'motorType' || root === 'motorPreset';
    // runCurrent: null follows the motor preset's Irated (also across later preset changes)
    // until a number is set.
    if (p === 'runCurrent') this._runCurrentAuto = !(typeof value === 'number' && Number.isFinite(value));
    else if (motorKey && this._runCurrentAuto) sc.runCurrent = null;
    normalizeScenario(sc, motorKey ? root : null);
    if (sc.foc.gains !== 'optimal') sc.foc.gains = normalizeGains(sc.foc.gains);
    this._scView = null;
    if (rebuild) {
      this._build();
      return;
    }
    if (p === 'traceWindow') {
      this._setupDecimation();
      for (let k = 0; k < this._traceBufs.length; k++) this._traceBufs[k].clear();
      return;
    }
    this._derive();
  }

  /**
   * Runs a command (contract section 15): jog, moveTo, runPath, stop, bump, home, sweep,
   * singleStep, reset, setLoad, setTarget. jog, moveTo, runPath, singleStep and setTarget
   * first abort a running sweep or homing (each machine restores what it overrides: supply
   * voltage, planner limits, hard stops, the FOC current limit). bump takes { torque,
   * durationS, motors, dir }; `dir: [x, y]` (CoreXY only) shoves the toolhead along that
   * direction instead of along −x, with the same force; the `bump` event carries the shove's
   * unit direction as dirX, dirY.
   * @param {string} name
   * @param {object} [args]
   */
  command(name, args) {
    const a = args && typeof args === 'object' ? args : EMPTY;
    const pl = this.planner;
    const sc = this._sc;
    switch (name) {
      case 'jog':
        this._abortMachines();
        this._leaveVelocityTarget();
        pl.jog(num(a.speedMmS, 0), num(a.vyMmS, 0));
        break;
      case 'moveTo':
        this._abortMachines();
        this._leaveVelocityTarget();
        pl.moveTo(num(a.xMm, pl.x), num(a.yMm, pl.y));
        break;
      case 'runPath': {
        const nm = typeof a.name === 'string' ? a.name : null;
        if (nm === 'homeX') { this.command('home', a); break; }
        const path = a.path || nm || sc.path;
        if (!path) break;
        this._abortMachines();
        this._leaveVelocityTarget();
        pl.runPath(path);
        // Also a path started while another one runs (no mode change): corner error from zero.
        this.metricsEngine.pathStarted();
        break;
      }
      case 'stop': {
        const immediate = a.immediate === true;
        this.homing.abort();
        this.sweep.abort();
        if (this._velActive) {
          this._velTarget = 0;
          if (immediate) this._velCmd = 0;
        }
        pl.stop(immediate);
        break;
      }
      case 'bump': {
        const all = (1 << this.nMotors) - 1;
        let mask = all;
        const m = a.motors;
        if (typeof m === 'number') mask = (1 << m) & all;
        else if (Array.isArray(m)) { mask = 0; for (const i of m) mask |= (1 << i); mask &= all; }
        const torque = num(a.torque, sc.bump.torque);
        const durationS = num(a.durationS, sc.bump.durationS);
        // Shove direction in the XY plane (unit vector; the plain bump shoves along −x for a
        // positive torque). `dir: [x, y]` (CoreXY only, chunk 06) shoves along that direction
        // with the same force: per-motor scales (−(ux + uy), −(ux − uy)) on |torque|.
        let dirX = torque < 0 ? 1 : -1, dirY = 0;
        let scales = null;
        const d = a.dir;
        if (this.kinematics === 'corexy' && d && Number.isFinite(+d[0]) && Number.isFinite(+d[1])) {
          const len = Math.hypot(+d[0], +d[1]);
          if (len > 1e-9) {
            const s = torque < 0 ? -1 : 1;
            dirX = s * d[0] / len;
            dirY = s * d[1] / len;
            this._bumpScales[0] = -(dirX + dirY);
            this._bumpScales[1] = -(dirX - dirY);
            scales = this._bumpScales;
          }
        }
        this.mechanics.bump(scales ? Math.abs(torque) : torque, durationS, mask, scales);
        // For the views (a bump icon) and chapters' onEvent; main.js announces nothing for it.
        this._emit('bump', { torque, durationS, motors: mask, xMm: this.mechanics.x, yMm: this.mechanics.y, dirX, dirY });
        break;
      }
      case 'home':
        this.sweep.abort();
        this._leaveVelocityTarget();
        this.homing.start(a);
        break;
      case 'sweep':
        this.homing.abort();
        this._leaveVelocityTarget();
        this.sweep.start(a);
        break;
      case 'singleStep': {
        const dir = num(a.dir, 1) < 0 ? -1 : 1;
        this._abortMachines();
        this._leaveVelocityTarget();
        this._singleStep(dir);
        break;
      }
      case 'reset':
        this._build();
        break;
      case 'setLoad':
        if (typeof a.drag === 'number') sc.loads.drag = a.drag;
        if (typeof a.torque === 'number') sc.loads.torque = a.torque;
        this._scView = null;
        this.mechanics.setLoads(sc.loads.drag, sc.loads.torque);
        break;
      case 'setTarget':
        if (typeof a.omegaMmS === 'number' || typeof a.iq === 'number') this._abortMachines();
        if (typeof a.omegaMmS === 'number') {
          if (!this._velActive) {
            pl.stop(true);
            for (let i = 0; i < this.nMotors; i++) this._velBase[i] = pl.motorAngle(this._srcIdx[i]);
            this._velTheta = 0;
            this._velCmd = 0;
            this._velActive = true;
          }
          this._velTarget = a.omegaMmS / this._mmPerRad;
        }
        if (typeof a.iq === 'number') this._iqTarget = a.iq;
        break;
      default:
        throw new Error('Unknown command: ' + name);
    }
  }

  // ------------------------------------------------------------------ build / derive

  /** Rebuilds every module from `this._sc` and resets the state (configure, structural set). */
  _build() {
    // Homing and sweep machines are recreated below; nothing of theirs survives a rebuild. A
    // running sweep's temporary supply voltage must not either.
    this._dropSweep();
    const sc = this._sc;
    this._dt = sc.fidelity === 'switching' ? DT_SWITCHING : DT_AVERAGED;
    const dt = this._dt;
    this.controlEvery = Math.max(1, Math.round(CONTROL_DT / dt));
    this.controlDt = CONTROL_DT;
    this._tick = 0;
    this.kinematics = sc.mechanics;
    this.compareActive = sc.compareMotor !== null && typeof sc.compareMotor === 'object' && sc.mechanics === 'free';
    const n = this.kinematics === 'corexy' || this.compareActive ? 2 : 1;
    this.nMotors = n;
    this._maxVelOverride = 0;
    this._accelOverride = 0;
    this._homingCurrentOverride = 0;
    this._sweepNoStops = false;
    this._omegaHoldMmS = -1;

    // Drivers and presets per motor.
    this.driverKinds = [];
    this.driverModes = [];
    this.presets = [];
    for (let i = 0; i < n; i++) {
      let kind = sc.driver;
      let mode = sc.driverMode;
      if (i === 1 && this.compareActive) {
        kind = sc.compareMotor.driver === 'foc' ? 'foc' : 'openloop';
        mode = normalizeDriverMode(kind, sc.compareMotor.driverMode);
      }
      this.driverKinds.push(kind);
      this.driverModes.push(mode);
      // The open-loop driver is two-phase only: an open-loop motor on a BLDC scenario is a stepper.
      const key = kind === 'openloop' && sc.motorType === 'bldc' ? 'stepper' : sc.motorPreset;
      this.presets.push(getMotorPreset(key));
    }
    this.preset = this.presets[0];

    // Per-motor arrays.
    this.cmdTheta = new Float64Array(n);
    this.cmdOmega = new Float64Array(n);
    this.noise = new Float64Array(n);
    this._noiseScale = new Float64Array(n);
    this.iAmpLpfOut = new Float64Array(n);
    this._torques = new Float64Array(n);
    this._p = new Float64Array(n);
    this._spr = new Float64Array(n);
    this._stepAngle = new Float64Array(n);
    this._srcIdx = new Int32Array(n);
    this._focMode = new Int32Array(n);
    this._omegaCmdOL = new Float64Array(n);
    this._loadAngle = new Float64Array(n);
    this._heat = new Float64Array(n);
    this._heatNorm = new Float64Array(n);
    this._uLimitOL = new Float64Array(n);
    this._iTarget = new Float64Array(n);
    this._prevLost = new Float64Array(n);
    this._prevDiag = new Uint8Array(n);
    this._prevStatus = new Uint8Array(n);
    this._statusLatch = new Uint8Array(n);
    this._statusClear = new Int32Array(n);
    this._statusClearN = Math.max(1, Math.round(0.05 / this._dt));
    this._velBase = new Float64Array(n);
    this._saveTheta = new Float64Array(n);
    this._saveOmega = new Float64Array(n);
    this._va = new Float64Array(n);
    this._vb = new Float64Array(n);
    this._heatK = 1 - Math.exp(-dt / HEAT_TAU);

    // Modules.
    this.mechanics = new Mechanics(2);
    this.mechanics.configure(this._mechCfg());
    this.planner = new Planner();
    this.planner.configure(this._plannerCfg());
    this.rng = new Rng(sc.seed);
    this.motors = [];
    this.encoders = [];
    this.stepgens = [];
    this.openloop = [];
    this.foc = [];
    this.stallguards = [];
    this._noiseLpf = [];
    this._iAmpLpf = [];
    this._vAmpLpf = [];
    const fs = 1 / dt;
    for (let i = 0; i < n; i++) {
      const pr = this.presets[i];
      this._p[i] = pr.p;
      this._heatNorm[i] = 1 / (pr.kf * pr.Irated * pr.Irated);
      this._srcIdx[i] = this.kinematics === 'corexy' ? i : 0;
      this.motors.push(new Motor(pr));
      const enc = new Encoder();
      enc.configure({ cpr: num(sc.encoder && sc.encoder.cpr, 4000), dt, windowS: num(sc.encoder && sc.encoder.windowS, 0.5e-3) });
      this.encoders.push(enc);
      const sg = new StepGen();
      this.stepgens.push(sg);
      if (this.driverKinds[i] === 'foc') {
        this.openloop.push(null);
        this.stallguards.push(null);
        this.foc.push(new FocController());
      } else {
        this.openloop.push(new OpenLoopDriver());
        this.stallguards.push(new StallGuard());
        this.foc.push(null);
      }
      const lpN = new Lowpass1(fs); lpN.setCutoff(500); this._noiseLpf.push(lpN);
      const lpI = new Lowpass1(fs); lpI.setCutoff(200); this._iAmpLpf.push(lpI);
      const lpV = new Lowpass1(fs); lpV.setCutoff(200); this._vAmpLpf.push(lpV);
    }
    this._pushDriverParams(true);

    this.metricsEngine = new Metrics();
    this.metricsEngine.configure({ dt, preset: this.presets[0], rd: this.rd, nMotors: n, periodS: 0.1 });

    this._events.length = 0;
    this.eventsDropped = 0;
    this.homing = new HomingMachine(this);
    this.sweep = new SweepMachine(this);
    this.snapshot = buildSnapshot(this);
    this._resetState(true);
    this._t = 0;
    this.snapshot.t = 0;

    const tr = buildTraces(this);
    this._traces = tr.map;
    this._traceBufs = tr.bufs;
    this._traceCodes = tr.codes;
    this._traceMotors = tr.motors;
    this._setupDecimation();
    this._decimCount = 0;

    this.metricsEngine.reset();
    this._fillSnapshot();
  }

  /** decimation = traceDecimation(traceWindow, dt) = max(1, ceil(traceWindow/(cap·dt))). */
  _setupDecimation() {
    this._decimation = traceDecimation(this._sc.traceWindow, this._dt);
    this._decimCount = 0;
  }

  /** Pushes every non-structural scenario parameter into the modules (keeps the state). */
  _derive() {
    const sc = this._sc;
    const mech = this.mechanics;
    const n = this.nMotors;
    // Mechanics: keep the rotor state across the reconfiguration.
    for (let i = 0; i < n; i++) { this._saveTheta[i] = mech.theta[i]; this._saveOmega[i] = mech.omega[i]; }
    mech.configure(this._mechCfg());
    for (let i = 0; i < n; i++) { mech.theta[i] = this._saveTheta[i]; mech.omega[i] = this._saveOmega[i]; }
    mech.setLoads(sc.loads.drag, sc.loads.torque);
    this.planner.configure(this._plannerCfg());
    // A maxVelocity lowered under the speed of a move or path: the planner slows down at accel,
    // and the FOC position-loop limit (_omegaLimit) stays at its speed until the control tick
    // sees it at or under the new limit (then _releaseOmegaHold). Jogs ignore maxVelocity.
    const vMax = num(sc.planner.maxVelocity, 150);
    const pl = this.planner;
    this._omegaHoldMmS = (pl.mode === 'move' || pl.mode === 'path') && pl.speed > vMax ? vMax : -1;
    // Driver modes (the compare motor keeps its own).
    this.driverModes[0] = sc.driverMode;
    if (this.kinematics === 'corexy' && n > 1) this.driverModes[1] = sc.driverMode;
    this._pushDriverParams(false);
    this.snapshot.supplyV = sc.supplyV;
    this.snapshot.driverMode = sc.driverMode;
    this.snapshot.axisLength = num(sc.axisLength, 350);
  }

  /**
   * Configures the step generators, drivers and StallGuards from the scenario.
   * @param {boolean} fresh true right after construction (no rebase needed)
   */
  _pushDriverParams(fresh) {
    const sc = this._sc;
    const dt = this._dt;
    let modeChanged = false;
    for (let i = 0; i < this.nMotors; i++) {
      const pr = this.presets[i];
      const isFoc = this.driverKinds[i] === 'foc';
      const spr = isFoc
        ? Math.max(1, Math.round(sc.foc.virtualSteps.fullStepsPerRev * sc.foc.virtualSteps.microsteps))
        : 4 * pr.p * sc.microsteps;
      if (spr !== this._spr[i]) {
        this._spr[i] = spr;
        this._stepAngle[i] = TWO_PI / spr;
        this.stepgens[i].configure({ stepsPerRev: spr, dt });
        if (!fresh) this.stepgens[i].rebase(this.cmdTheta[i]);
      }
      const runCurrent = this._runCurrent(i);
      this._iTarget[i] = runCurrent;
      if (isFoc) {
        const code = this.driverModes[i] === 'velocity' ? FOC_VEL : this.driverModes[i] === 'torque' ? FOC_TRQ : FOC_POS;
        if (!fresh && code !== this._focMode[i]) modeChanged = true;
        this._focMode[i] = code;
        this.foc[i].configure(this._focCfg(i));
      } else {
        this._uLimitOL[i] = vLimit(pr, sc.supplyV);
        this.openloop[i].configure({
          mode: this.driverModes[i], fidelity: sc.fidelity, microsteps: sc.microsteps, interpolate: sc.interpolate !== false,
          runCurrent, Vbus: sc.supplyV, hybridThresholdRadS: num(sc.hybridThresholdMmS, 60) / this._mmPerRad,
          preset: pr, dt, controlDt: CONTROL_DT, chopper: cloneDeep(sc.chopper), currentLoopHz: 3000,
        });
        const sgc = sc.stallguard || EMPTY;
        this.stallguards[i].configure({
          sgthrs: num(sgc.sgthrs, 60), minSpeedRadS: num(sgc.minSpeedMmS, 10) / this._mmPerRad,
          omegaRefRadS: 100 / this._mmPerRad,
        });
      }
    }
    this._velAccel = this.planner.accel / this._mmPerRad;
    const opts = { tuning: TUNING, Vbus: sc.supplyV, omegaLimit: this._omegaLimit(), runCurrent: sc.runCurrent };
    this._optimal = optimalGains(this.presets[0], this._jt(0), opts);
    // Noise signal scale of FOC motors: 1/Kpq of the ×1 (optimal) gains, so the uq noise reads
    // as an equivalent current and a torque P multiplier shows up as more noise.
    for (let i = 0; i < this.nMotors; i++) {
      if (this.driverKinds[i] !== 'foc') { this._noiseScale[i] = 0; continue; }
      const kpq = i === 0 ? this._optimal.Kpq : optimalGains(this.presets[i], this._jt(i), opts).Kpq;
      this._noiseScale[i] = kpq > 0 ? 1 / kpq : 0;
    }
    if (modeChanged) {
      // A FOC mode switch starts from where the rotor is: no target jump.
      this._velActive = false;
      this._velCmd = 0;
      this._velTarget = 0;
      this.planner.stop(true);
      this._rebaseToActual();
    }
  }

  /** @returns {object} Mechanics.configure options from the scenario. */
  _mechCfg() {
    const sc = this._sc;
    const jr = [];
    for (let i = 0; i < this.nMotors; i++) jr.push(this.presets[i].Jrotor);
    return {
      mode: this.kinematics, nMotors: this.nMotors, Jrotor: jr, Jload: num(sc.Jload, 5e-5), rd: this.rd,
      axisLength: num(sc.axisLength, 350), hardStops: sc.hardStops !== false && !this._sweepNoStops,
      kStop: num(sc.stopStiffness, 2),
      bumpTorque: num(sc.bump && sc.bump.torque, 0.6), bumpDuration: num(sc.bump && sc.bump.durationS, 0.04),
    };
  }

  /** @returns {object} Planner.configure options (with the homing/sweep overrides). */
  _plannerCfg() {
    const p = this._sc.planner;
    return {
      maxVelocity: this._maxVelOverride > 0 ? this._maxVelOverride : num(p.maxVelocity, 150),
      accel: this._accelOverride > 0 ? this._accelOverride : num(p.accel, 5000),
      scv: num(p.scv, 5), rd: this.rd, kinematics: this.kinematics, axisLength: num(this._sc.axisLength, 350),
    };
  }

  /**
   * FOC position-loop speed limit (mech rad/s): omegaLimitFactor·maxVelocity as belt speed,
   * ×√2 on CoreXY (a 45° move at maxVelocity drives one belt at √2·maxVelocity). While _derive
   * holds the limit (a move or path still faster than a lowered maxVelocity, slowing down to it
   * at accel), the planner's speed stands in for maxVelocity until the control tick sees it at
   * or under maxVelocity and _releaseOmegaHold pushes the lower one. Without a hold the
   * limit is the maxVelocity one, even while a jog or a homing pass runs faster.
   * @returns {number}
   */
  _omegaLimit() {
    const sc = this._sc;
    const belt = this.kinematics === 'corexy' ? Math.SQRT2 : 1;
    const vMax = num(sc.planner.maxVelocity, 150);
    const sp = this._omegaHoldMmS >= 0 ? this.planner.speed : 0;
    return belt * num(sc.foc.omegaLimitFactor, 1.2) * (sp > vMax ? sp : vMax) / this._mmPerRad;
  }

  /**
   * Ends the hold _derive set on the FOC position-loop speed limit: pushes the limit for the
   * current maxVelocity into every FOC motor. Called from the control tick (world-step.js)
   * once the planner has slowed down to `_omegaHoldMmS`.
   */
  _releaseOmegaHold() {
    this._omegaHoldMmS = -1;
    for (let i = 0; i < this.nMotors; i++) {
      const f = this.foc[i];
      if (f !== null) f.configure(this._focCfg(i));
    }
    if (this._optimal !== null) this._optimal.omegaLimit = this._omegaLimit();
  }

  /**
   * Run current of motor i (A): the scenario runCurrent, except the compare motor (motor 1
   * with compareMotor set), which uses compareMotor.runCurrent or, when that is null, its own
   * preset's Irated (an open-loop compare motor on a BLDC scenario is the stepper).
   * @param {number} i
   * @returns {number}
   */
  _runCurrent(i) {
    const sc = this._sc;
    if (i === 1 && this.compareActive) return num(sc.compareMotor.runCurrent, this.presets[1].Irated);
    return sc.runCurrent;
  }

  /**
   * Total inertia of motor i (kg·m²), as the mechanics computes it.
   * @param {number} i
   * @returns {number}
   */
  _jt(i) {
    const j = this.mechanics.Jt[i];
    if (j > 0) return j;
    const jl = num(this._sc.Jload, 5e-5);
    return this.presets[i].Jrotor + (this.kinematics === 'corexy' ? 0.5 * jl : jl);
  }

  /**
   * FocController.configure options for motor i.
   * @param {number} i
   * @returns {object}
   */
  _focCfg(i) {
    const sc = this._sc;
    const f = sc.foc;
    return {
      preset: this.presets[i], Jt: this._jt(i), Vbus: sc.supplyV, fs: 1 / CONTROL_DT, mode: this.driverModes[i],
      runCurrent: sc.runCurrent,
      homingCurrent: this._homingCurrentOverride > 0 ? this._homingCurrentOverride : num(f.homingCurrent, 0.5),
      gains: normalizeGains(f.gains), filters: normalizeFilters(f.filters),
      mask: Array.isArray(f.mask) ? f.mask.slice() : ['iqTargetLimit', 'uqOutputLimit', 'udOutputLimit'],
      omegaLimit: this._omegaLimit(), noiseSigmaFrac: 0.01, tuning: TUNING,
      encoderCpr: num(sc.encoder && sc.encoder.cpr, 4000),
    };
  }

  /**
   * Resets the motion and electrical state (rotor and planner at `start`, drivers aligned,
   * filters and heat cleared). Keeps t, traces, events and metrics.
   * @param {boolean} startPath start `scenario.path` when set
   */
  _resetState(startPath) {
    const sc = this._sc;
    const sx = num(sc.start.x, 50);
    const sy = num(sc.start.y, 50);
    const mech = this.mechanics;
    mech.configure(this._mechCfg());
    mech.reset(sx, sy);
    mech.setLoads(num(sc.loads.drag, 0), num(sc.loads.torque, 0));
    const pl = this.planner;
    pl.configure(this._plannerCfg());
    pl.reset(sx, sy);
    this._velActive = false;
    this._velTarget = 0;
    this._velCmd = 0;
    this._velTheta = 0;
    this._iqTarget = 0;
    this._updateCommand(0);
    for (let i = 0; i < this.nMotors; i++) {
      const th = mech.theta[i];
      this.motors[i].reset();
      this.encoders[i].reset(th);
      this.stepgens[i].reset(this.cmdTheta[i]);
      if (this.openloop[i] !== null) {
        this.openloop[i].reset(this._p[i] * th);
        this.stallguards[i].reset();
      } else {
        this.foc[i].reset(this.encoders[i].thetaMeas);
      }
      this._noiseLpf[i].reset(0);
      this._iAmpLpf[i].reset(0);
      this._vAmpLpf[i].reset(0);
      this.noise[i] = 0;
      this.iAmpLpfOut[i] = 0;
      this._heat[i] = 0;
      this._loadAngle[i] = 0;
      this._omegaCmdOL[i] = 0;
      this._prevLost[i] = 0;
      this._prevDiag[i] = 0;
      this._prevStatus[i] = 0;
      this._statusLatch[i] = 0;
      this._statusClear[i] = 0;
    }
    this._tick = 0;
    this.stepEdges = 0;
    this.stepLast = 0;
    this.stepPulses = 0;
    this._prevStopX = false;
    this._prevStopY = false;
    if (startPath && sc.path) pl.runPath(sc.path);
  }

  // ------------------------------------------------------------------ helpers (machines)

  /**
   * Emits an event `{ t, type, data }` (dropped once EVENT_CAP undrained events are queued).
   * @param {string} type
   * @param {object|null} data
   */
  _emit(type, data) {
    if (this._events.length >= EVENT_CAP) { this.eventsDropped++; return; }
    this._events.push({ t: this._t, type, data });
  }

  /** @returns {boolean} homing trigger level of motor 0 (FOC status, open-loop DIAG) */
  _homingTrigger() {
    const f = this.foc[0];
    if (f !== null) return this._statusLatch[0] === 1;   // the latched status output (fillFoc)
    return this.stallguards[0].diag;
  }

  /**
   * Free-motion load measure of motor 0: FOC |iq*| (the velocity loop's current demand, the
   * quantity the iqTargetLimit flag compares with the homing current), open loop |i|.
   * @returns {number}
   */
  _homingLoad() {
    const f = this.foc[0];
    if (f !== null) return f.iqStar < 0 ? -f.iqStar : f.iqStar;
    return this.motors[0].iAmp;
  }

  /**
   * Current target of motor i (A): run current (open loop) or the FOC current limit.
   * @param {number} i
   * @returns {number}
   */
  _targetCurrent(i) {
    const f = this.foc[i];
    return f !== null ? f.iLimit : this._iTarget[i];
  }

  /**
   * Enters or leaves the FOC homing current limit on every FOC motor.
   * @param {boolean} active
   * @param {number} current homing current (A) while active
   */
  _setHoming(active, current) {
    this._homingCurrentOverride = active ? current : 0;
    for (let i = 0; i < this.nMotors; i++) {
      const f = this.foc[i];
      if (f === null) continue;
      f.configure(this._focCfg(i));
      f.setHoming(active);
    }
  }

  /**
   * Planner speed limit override (0 = scenario value).
   * @param {number} v mm/s
   */
  _setMaxVelocityOverride(v) {
    if (v === this._maxVelOverride) return;
    this._maxVelOverride = v;
    this.planner.configure(this._plannerCfg());
  }

  /**
   * Planner acceleration override (0 = scenario value).
   * @param {number} a mm/s²
   */
  _setAccelOverride(a) {
    if (a === this._accelOverride) return;
    this._accelOverride = a;
    this.planner.configure(this._plannerCfg());
    this._velAccel = this.planner.accel / this._mmPerRad;
  }

  /**
   * Rebases the planner on the actual toolhead position without motion: step generators
   * realigned (no pulses), FOC θ* = θmeas.
   */
  _rebaseToActual() {
    const mech = this.mechanics;
    const pl = this.planner;
    this._velActive = false;
    this._velCmd = 0;
    this._velTarget = 0;
    this._velTheta = 0;
    pl.setPosition(mech.x, this.kinematics === 'corexy' ? mech.y : pl.y);
    this._updateCommand(0);
    for (let i = 0; i < this.nMotors; i++) {
      this.stepgens[i].rebase(this.cmdTheta[i]);
      const f = this.foc[i];
      if (f !== null) { f.thetaStar = this.encoders[i].thetaMeas; f.omegaStar = 0; }
    }
  }

  /**
   * Moves the commanded position by exactly one step of the active step source (motor 0's
   * step generator), counted from what that generator has already sent, so the next update
   * emits exactly one pulse even when the planner stopped between two step positions.
   * Axis/free: θ = (sent + dir)·stepAngle, x = θ·rd/2π. CoreXY: an x step moves both belts, so
   * both motors land on their next step, θA = (sentA + dir)·stepAngle and θB = (sentB + dir)·
   * stepAngle, x = (θA + θB)·rd/4π, y = (θA − θB)·rd/4π (x advances one step; y only loses
   * the sub-step remainder, if any).
   * @param {number} dir +1 or −1
   */
  _singleStep(dir) {
    const pl = this.planner;
    const k = this._mmPerRad;
    const g0 = this.stepgens[0];
    const th0 = (g0.sent + dir) * g0.stepAngle;
    if (this.kinematics === 'corexy' && this.nMotors > 1) {
      const g1 = this.stepgens[1];
      const th1 = (g1.sent + dir) * g1.stepAngle;
      pl.setPosition(0.5 * (th0 + th1) * k, 0.5 * (th0 - th1) * k);
    } else {
      pl.setPosition(th0 * k, pl.y);
    }
    this._updateCommand(0);
  }

  /**
   * Aborts a running homing or sweep before a new motion command. Homing restores the run
   * current limit and the planner overrides; the sweep restores the supply voltage, planner
   * limits and hard stops (and resets the motion state, as its abort does).
   */
  _abortMachines() {
    this.homing.abort();
    this.sweep.abort();
  }

  /**
   * Forgets a running sweep ahead of a rebuild (which recreates the machine): the sweep's
   * original supply voltage goes back into the current scenario and the cached view is
   * cleared, so the temporary sweep voltage does not outlive the sweep.
   */
  _dropSweep() {
    const sw = this.sweep;
    if (!sw || !sw.snap.running) return;
    this._sc.supplyV = sw.origV;
    this._scView = null;
    sw.snap.running = false;
  }

  /**
   * Ends a setTarget constant-speed command: the planner takes over at the commanded position
   * and speed (a jog at the ramp's current speed), so a following moveTo/runPath brakes from
   * that speed and a jog ramps from it instead of the command dropping to 0 in one tick.
   */
  _leaveVelocityTarget() {
    if (!this._velActive) return;
    const pl = this.planner;
    const k = this._mmPerRad;
    const v = this._velCmd * k;
    pl.setPosition(pl.x + this._velTheta * k, pl.y);
    this._velActive = false;
    this._velCmd = 0;
    this._velTarget = 0;
    this._velTheta = 0;
    if (v !== 0) {
      pl.jog(v, 0);
      // jog() only sets the target velocity; the current velocity is the handed-over one.
      pl.vx = v;
      pl.vy = 0;
      pl.speed = v < 0 ? -v : v;
    }
    this._updateCommand(0);
  }

  /** Advances the simulation by one `dt` (see world-step.js for the order). */
  step() {
    stepWorld(this);
  }

  /** Copies the module state into `snapshot` (also used after configure). */
  _fillSnapshot() {
    fillSnapshot(this);
  }

  /**
   * Commanded motor angles/speeds and toolhead from the planner or the setTarget ramp.
   * @param {number} cdt control period (s); 0 recomputes without advancing
   */
  _updateCommand(cdt) {
    updateCommand(this, cdt);
  }
}
