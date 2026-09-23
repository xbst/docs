// Open-loop stepper driver: microstep sequencer with optional 256-step interpolation, plus the
// three current regulation strategies of a TMC-style driver:
//
//   voltage mode (StealthChop-like): vk = vAmp·cos(thetaCmd − φk); vAmp follows the current
//     target slowly: dvAmp/dt = (R/τA)·(I − iAmpMeas), τA = 30 ms, clamp [0, Vbus],
//     iAmpMeas = LPF200(|i|).
//   current mode (SpreadCycle-like): averaged fidelity uses a per-phase PI with Kp = L·ωc,
//     Ki = R·ωc, ωc = 2π·currentLoopHz, output clamped to ±Vbus with back-calculation
//     anti-windup (never past zero, like drivers/foc.js); switching fidelity uses one fixed-frequency Chopper per phase.
//   hybrid: current mode at |omegaCmd| ≥ hybridThresholdRadS, voltage mode below.
//
// Electrical angles in rad (unwrapped), currents in A, voltages in V, time in s.
// Two-phase (stepper) only: phase A = α (spatial angle 0), phase B = β (spatial angle π/2).
// Hot path (consumePulses, step) never allocates.

import { HALF_PI, wrapPi } from '../units.js';
import { Lowpass1 } from '../biquad.js';
import { Chopper, BipolarPwm } from './chopper.js';

/** Voltage-mode amplitude loop time constant (s). */
const TAU_A = 0.03;
/** Cutoff of the current-amplitude low-pass used by voltage mode (Hz). */
const AMP_LPF_HZ = 200;
/** Interpolation resolution: 256 microsteps per full step. */
const QUANTUM = HALF_PI / 256;
/** A pulse after a pause longer than this many previous intervals is applied without a glide. */
const RESTART_RATIO = 4;

/**
 * Open-loop microstepping driver for a two-phase stepper.
 *
 * Usage per sim step: `consumePulses(n)` with the signed pulse count from the step generator,
 * then `step(motor, omegaCmdRadS)`; read `vAlpha`, `vBeta` and feed them to the motor.
 *
 * Fields: `thetaCmd` (commanded electrical angle, unwrapped, quantized to (π/2)/256 when
 * interpolating), `thetaStep` (stepped target), `iStar` (Float64Array(2) phase targets),
 * `iAmpTarget` (= runCurrent), `vAmp` (voltage-mode amplitude; in current mode the applied
 * |v|), `iAmpMeas` (LPF200 of |i|), `modeActive` ('voltage' | 'current'), `vAlpha`, `vBeta`,
 * `vPhase` (Float64Array(2)), `pwmState` (Int8Array(2): chopper/PWM state in switching
 * fidelity, sign of the phase voltage in averaged fidelity), `currentAngle` (atan2(iβ, iα)),
 * `stepRateEstimate` (pulses/s from the last step interval).
 */
export class OpenLoopDriver {
  constructor() {
    /** Configured mode: 'voltage' | 'current' | 'hybrid'. */
    this.mode = 'current';
    /** Mode in effect this step: 'voltage' | 'current'. */
    this.modeActive = 'current';
    /** 'averaged' | 'switching'. */
    this.fidelity = 'averaged';
    /** Microsteps per full step. */
    this.microsteps = 16;
    /** 256-microstep interpolation on/off. */
    this.interpolate = true;
    /** Run current amplitude (A, peak per phase). */
    this.runCurrent = 3.54;
    /** Bus voltage (V). */
    this.Vbus = 24;
    /** Hybrid threshold (rad/s, same units as omegaCmdRadS passed to step). */
    this.hybridThresholdRadS = 2 * Math.PI * 60 / 40;
    /** Motor preset used for R and L at reset (step reads motor.preset). */
    this.preset = null;
    /** Phase resistance from the preset (Ω). */
    this.R = 1.14;
    /** Phase inductance from the preset (H). */
    this.L = 3.0e-3;
    /** Sim step (s). */
    this.dt = 40e-6;
    /** Control period of the averaged current PI (s). */
    this.controlDt = 40e-6;
    /** Current PI runs every controlEvery sim steps. */
    this.controlEvery = 1;
    /** Step counter for the control tick. */
    this.controlCount = 0;
    /** Current loop bandwidth (Hz). */
    this.currentLoopHz = 3000;

    /** Electrical angle of one microstep (rad). */
    this.stepAngle = HALF_PI / 16;
    /** Offset of the microstep grid (π/4 in full-step mode, else 0). */
    this.stepOffset = 0;
    /** Integer microstep index; thetaStep = stepOffset + stepIndex·stepAngle. */
    this.stepIndex = 0;
    /** Stepped target angle (elec rad, unwrapped). */
    this.thetaStep = 0;
    /** Continuous glide position (elec rad) before quantization. */
    this.thetaGlide = 0;
    /** Commanded electrical angle (rad, unwrapped). */
    this.thetaCmd = 0;
    /** Glide rate (rad/s, magnitude). */
    this.glideRate = 0;
    /** Interval between the last two pulses (s); 0 = unknown. */
    this.lastInterval = 0;
    /** Time since the last pulse (s). */
    this.sinceStep = 0;
    /** True once a pulse has been seen since reset. */
    this.hadPulse = false;
    /** Step rate estimate (pulses/s). */
    this.stepRateEstimate = 0;

    /** Phase current targets (A). */
    this.iStar = new Float64Array(2);
    /** Current amplitude target (A). */
    this.iAmpTarget = 3.54;
    /** Voltage-mode amplitude (V). */
    this.vAmp = 0;
    /** LPF200 of the motor current amplitude (A). */
    this.iAmpMeas = 0;
    /** Current PI integrators per phase (V). */
    this.integ = new Float64Array(2);
    /** Output voltages. */
    this.vAlpha = 0;
    this.vBeta = 0;
    /** Phase voltages (V). */
    this.vPhase = new Float64Array(2);
    /** Per-phase switch state (+1, 0, −1). */
    this.pwmState = new Int8Array(2);
    /** Angle of the actual current vector, atan2(iβ, iα) (rad). */
    this.currentAngle = 0;

    /** Current-amplitude low-pass. */
    this.ampLpf = new Lowpass1(1 / 40e-6);
    /** Chopper per phase (switching fidelity, current mode). */
    this.chopA = new Chopper();
    this.chopB = new Chopper();
    /** Bipolar PWM per phase (switching fidelity, voltage mode). */
    this.pwmA = new BipolarPwm();
    this.pwmB = new BipolarPwm();
    this.ampLpf.setCutoff(AMP_LPF_HZ);
  }

  /**
   * Set parameters. Does not reset the electrical or sequencer state (a microstep change
   * re-bases the step index so thetaStep stays at the nearest position of the new grid);
   * call reset() after the first configure.
   * @param {object} cfg
   * @param {'voltage'|'current'|'hybrid'} [cfg.mode]
   * @param {'averaged'|'switching'} [cfg.fidelity]
   * @param {number} [cfg.microsteps]
   * @param {boolean} [cfg.interpolate]
   * @param {number} [cfg.runCurrent] A
   * @param {number} [cfg.Vbus] V
   * @param {number} [cfg.hybridThresholdRadS] rad/s (same units as step's omegaCmdRadS)
   * @param {object} [cfg.preset] motor preset (R, L)
   * @param {number} cfg.dt sim step (s)
   * @param {number} [cfg.controlDt] averaged current-PI period (s)
   * @param {{freqHz?: number, hystA?: number, fastFrac?: number}} [cfg.chopper]
   * @param {number} [cfg.currentLoopHz]
   */
  configure({ mode = 'current', fidelity = 'averaged', microsteps = 16, interpolate = true,
    runCurrent = 3.54, Vbus = 24, hybridThresholdRadS = 2 * Math.PI * 60 / 40, preset = null,
    dt = 40e-6, controlDt = 40e-6, chopper = null, currentLoopHz = 3000 } = {}) {
    const modeWas = this.modeActive;
    this.mode = mode;
    this.fidelity = fidelity;
    this.interpolate = !!interpolate;
    this.runCurrent = runCurrent;
    this.iAmpTarget = runCurrent;
    this.Vbus = Vbus;
    this.hybridThresholdRadS = hybridThresholdRadS;
    if (preset) {
      this.preset = preset;
      this.R = preset.R;
      this.L = preset.L;
    }
    this.currentLoopHz = currentLoopHz;
    this.controlDt = controlDt;
    if (dt !== this.dt) {
      this.dt = dt;
      this.ampLpf = new Lowpass1(1 / dt);
      this.ampLpf.setCutoff(AMP_LPF_HZ);
      this.ampLpf.reset(this.iAmpMeas);
    }
    this.controlEvery = Math.max(1, Math.round(controlDt / dt));

    const ms = Math.max(1, Math.round(microsteps));
    if (ms !== this.microsteps) {
      this.microsteps = ms;
      this.stepAngle = HALF_PI / ms;
      this.stepOffset = ms === 1 ? HALF_PI / 2 : 0;
      this.stepIndex = Math.round((this.thetaStep - this.stepOffset) / this.stepAngle);
      this.thetaStep = this.stepOffset + this.stepIndex * this.stepAngle;
    }

    const ch = chopper || {};
    const cfgC = { freqHz: ch.freqHz === undefined ? 40000 : ch.freqHz,
      hystA: ch.hystA === undefined ? 0.04 : ch.hystA,
      fastFrac: ch.fastFrac === undefined ? 0.12 : ch.fastFrac, Vbus, dt };
    this.chopA.configure(cfgC);
    this.chopB.configure(cfgC);
    this.pwmA.configure(cfgC);
    this.pwmB.configure(cfgC);

    if (mode !== 'hybrid') this.modeActive = mode === 'voltage' ? 'voltage' : 'current';
    if (this.modeActive !== modeWas) this._handover();
  }

  /**
   * Reset the sequencer and regulators. thetaStep = thetaCmd = the microstep position nearest
   * to thetaE; vAmp = R·I; integrators 0.
   * @param {number} [thetaE] electrical rotor angle (rad)
   */
  reset(thetaE = 0) {
    this.stepIndex = Math.round((thetaE - this.stepOffset) / this.stepAngle);
    this.thetaStep = this.stepOffset + this.stepIndex * this.stepAngle;
    this.thetaGlide = this.thetaStep;
    this.thetaCmd = this.thetaStep;
    this.glideRate = 0;
    this.lastInterval = 0;
    this.sinceStep = 0;
    this.hadPulse = false;
    this.stepRateEstimate = 0;
    this.controlCount = 0;
    const I = this.runCurrent;
    const c = Math.cos(wrapPi(this.thetaCmd));
    const s = Math.sin(wrapPi(this.thetaCmd));
    this.iStar[0] = I * c;
    this.iStar[1] = I * s;
    this.iAmpTarget = I;
    let va = this.R * I;
    if (va > this.Vbus) va = this.Vbus;
    if (va < 0) va = 0;
    this.vAmp = va;
    this.iAmpMeas = 0;
    this.ampLpf.reset(0);
    this.integ[0] = 0;
    this.integ[1] = 0;
    this.vAlpha = 0;
    this.vBeta = 0;
    this.vPhase[0] = 0;
    this.vPhase[1] = 0;
    this.pwmState[0] = 0;
    this.pwmState[1] = 0;
    this.currentAngle = 0;
    this.chopA.reset();
    this.chopB.reset();
    this.pwmA.reset();
    this.pwmB.reset();
    this.modeActive = this.mode === 'current' ? 'current' : 'voltage';
  }

  /**
   * Apply step pulses: thetaStep += n·(π/2)/microsteps. Call once per sim step before step().
   * Measures the step interval for the interpolation glide and the rate estimate.
   * @param {number} n signed pulse count (int)
   */
  consumePulses(n) {
    if (n === 0) return;
    this.stepIndex += n;
    this.thetaStep = this.stepOffset + this.stepIndex * this.stepAngle;
    const an = n < 0 ? -n : n;
    const interval = this.sinceStep / an;
    // The first pulse after reset, or one after a pause much longer than the previous interval,
    // has no usable rate: apply it at once (like a non-interpolated step). A pause interval is
    // still kept as the reference for the next pulse.
    const restart = !this.hadPulse
      || (this.lastInterval > 0 && interval > RESTART_RATIO * this.lastInterval);
    if (this.hadPulse && interval > 0) {
      this.lastInterval = interval;
      this.stepRateEstimate = 1 / interval;
    }
    this.hadPulse = true;
    this.sinceStep = 0;
    if (restart || interval <= 0) {
      this.thetaGlide = this.thetaStep;
      this.glideRate = 0;
    } else {
      // Glide so the target is reached in one interval; normally the backlog is one microstep.
      let backlog = this.thetaStep - this.thetaGlide;
      if (backlog < 0) backlog = -backlog;
      if (backlog < this.stepAngle) backlog = this.stepAngle;
      this.glideRate = backlog / interval;
    }
  }

  /**
   * Advance one sim step: interpolation, targets, regulation. Writes vAlpha, vBeta, vPhase.
   * @param {{iAlpha: number, iBeta: number, iPhase: ArrayLike<number>, iAmp: number,
   *          preset: {R: number, L: number}}} motor
   * @param {number} omegaCmdRadS commanded speed (for hybrid switching)
   */
  step(motor, omegaCmdRadS) {
    const dt = this.dt;
    const Vbus = this.Vbus;
    const I = this.runCurrent;
    const pr = motor.preset;
    const R = pr ? pr.R : this.R;
    const L = pr ? pr.L : this.L;

    // Hybrid switching.
    if (this.mode === 'hybrid') {
      const w = omegaCmdRadS < 0 ? -omegaCmdRadS : omegaCmdRadS;
      const want = w >= this.hybridThresholdRadS ? 'current' : 'voltage';
      if (want !== this.modeActive) {
        this.modeActive = want;
        this._handover();
      }
    }

    // Sequencer and interpolation.
    const target = this.thetaStep;
    if (!this.interpolate) {
      this.thetaGlide = target;
      this.thetaCmd = target;
    } else {
      let g = this.thetaGlide;
      if (g !== target) {
        const d = this.glideRate * dt;
        if (g < target) { g += d; if (g >= target || d <= 0) g = target; }
        else { g -= d; if (g <= target || d <= 0) g = target; }
        this.thetaGlide = g;
      }
      this.thetaCmd = g === target ? target : Math.round(g / QUANTUM) * QUANTUM;
    }
    this.sinceStep += dt;
    // Let the rate estimate fall off once the pulses stop.
    if (this.hadPulse && this.sinceStep > this.lastInterval && this.sinceStep > 0) {
      const r = 1 / this.sinceStep;
      if (r < this.stepRateEstimate) this.stepRateEstimate = r;
    }

    const th = wrapPi(this.thetaCmd);
    const c = Math.cos(th);
    const s = Math.sin(th);
    this.iStar[0] = I * c;
    this.iStar[1] = I * s;
    this.iAmpTarget = I;

    const ia = motor.iAlpha;
    const ib = motor.iBeta;
    this.iAmpMeas = this.ampLpf.process(motor.iAmp);
    this.currentAngle = Math.atan2(ib, ia);

    const switching = this.fidelity === 'switching';
    if (this.modeActive === 'voltage') {
      let va = this.vAmp + dt * (R / TAU_A) * (I - this.iAmpMeas);
      if (va < 0) va = 0;
      else if (va > Vbus) va = Vbus;
      this.vAmp = va;
      if (switching) {
        this.vPhase[0] = this.pwmA.step(va * c);
        this.vPhase[1] = this.pwmB.step(va * s);
        this.pwmState[0] = this.pwmA.state;
        this.pwmState[1] = this.pwmB.state;
      } else {
        this.vPhase[0] = va * c;
        this.vPhase[1] = va * s;
      }
    } else if (switching) {
      const ip = motor.iPhase;
      this.vPhase[0] = this.chopA.step(this.iStar[0], ip[0]);
      this.vPhase[1] = this.chopB.step(this.iStar[1], ip[1]);
      this.pwmState[0] = this.chopA.state;
      this.pwmState[1] = this.chopB.state;
    } else {
      this.controlCount++;
      if (this.controlCount >= this.controlEvery) {
        this.controlCount = 0;
        const dtc = dt * this.controlEvery;
        const wc = 2 * Math.PI * this.currentLoopHz;
        const Kp = L * wc;
        const Ki = R * wc;
        const ip = motor.iPhase;
        for (let k = 0; k < 2; k++) {
          const err = this.iStar[k] - ip[k];
          let integ = this.integ[k] + Ki * err * dtc;
          const pTerm = Kp * err;
          let v = pTerm + integ;
          // Back-calculation anti-windup: pull the integrator back so the output sits on the
          // limit, but never past zero. When the P term alone exceeds the limit (a large target
          // step), a literal pull-back would wind the integrator far the other way and the output
          // would leave saturation at once, so the current would slew at a few volts instead of
          // the full bus voltage.
          if (v > Vbus) {
            v = Vbus;
            const bc = Vbus - pTerm;
            const cap = bc > 0 ? bc : 0;
            if (integ > cap) integ = cap;
          } else if (v < -Vbus) {
            v = -Vbus;
            const bc = -Vbus - pTerm;
            const floor = bc < 0 ? bc : 0;
            if (integ < floor) integ = floor;
          }
          this.integ[k] = integ;
          this.vPhase[k] = v;
        }
      }
    }

    const v0 = this.vPhase[0];
    const v1 = this.vPhase[1];
    this.vAlpha = v0;
    this.vBeta = v1;
    if (!switching) {
      this.pwmState[0] = v0 > 0 ? 1 : (v0 < 0 ? -1 : 0);
      this.pwmState[1] = v1 > 0 ? 1 : (v1 < 0 ? -1 : 0);
    }
    // In current mode vAmp mirrors the applied amplitude, so a hand-over to voltage mode is smooth.
    if (this.modeActive === 'current') {
      let va = Math.sqrt(v0 * v0 + v1 * v1);
      if (va > Vbus) va = Vbus;
      this.vAmp = va;
    }
  }

  /**
   * Initialize the newly active mode's state from the last outputs (hybrid switch).
   * @private
   */
  _handover() {
    const v0 = this.vPhase[0];
    const v1 = this.vPhase[1];
    if (this.modeActive === 'current') {
      this.integ[0] = v0;
      this.integ[1] = v1;
      this.controlCount = this.controlEvery;
    } else {
      let va = Math.sqrt(v0 * v0 + v1 * v1);
      if (va > this.Vbus) va = this.Vbus;
      this.vAmp = va;
    }
  }
}
