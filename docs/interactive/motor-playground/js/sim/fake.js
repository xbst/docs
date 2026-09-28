/**
 * FakeWorld: a synthetic stand-in for the simulation with the full SPEC 5.7
 * surface (configure, set, command, step, dt, snapshot, traces, metrics,
 * events). The signals are plausible shapes, not physics: sines for the
 * currents, pulses for STEP/DIR, a slow back-and-forth for positions, random
 * walks for the metrics. main.js uses it with `?sim=fake`, and chunk 01 used
 * it before the real World existed.
 *
 * Conventions shared with the real World (see STATUS.md, "Interface changes"):
 * ring layout, digital sampling (STEP alternates 1/0 when dense), trace keys
 * "name#motor" (CoreXY: posCmd#0/#1 = toolhead x/y, beltPos#i per motor),
 * traces absent where they make no sense (no sg/diag for FOC, no status/flags/
 * iLimit for open loop, no phase C on a stepper, pwmA/B/C only when switching),
 * `snapshot.events === world.events`, metrics mutated in place, loadAngle = atan2(iq, id)
 * in rad.
 */

const TWO_PI = Math.PI * 2;
const RING_CAP = 4096;
const DT_AVERAGED = 40e-6, DT_SWITCHING = 0.5e-6;
const SQRT3_2 = Math.sqrt(3) / 2;

/**
 * Canonical trace names (SPEC 5.7) followed by the per-phase PWM and belt traces, and
 * `stepN` (pulses since the previous sample, chunk 04).
 */
export const TRACE_NAMES = [
  'step', 'dir', 'posCmd', 'posAct', 'posErr', 'velCmd', 'velAct', 'iA', 'iB', 'iC',
  'iAStar', 'iBStar', 'iCStar', 'vA', 'vB', 'vC', 'bemfA', 'iAmp', 'vAmp', 'id', 'iq',
  'idStar', 'iqStar', 'ud', 'uq', 'uMag', 'uLimit', 'torque', 'loadTorque', 'loadAngle',
  'sg', 'sgThreshold', 'diag', 'status', 'flagIqTarget', 'flagUq', 'encA', 'encB',
  'encCount', 'noise', 'heat', 'iLimit', 'pwmA', 'pwmB', 'pwmC', 'beltPos', 'stepN',
];
const K = Object.fromEntries(TRACE_NAMES.map((n, i) => [n, i]));
const FOC_ONLY = new Set(['idStar', 'iqStar', 'status', 'flagIqTarget', 'flagUq', 'iLimit']);
const OPEN_ONLY = new Set(['sg', 'sgThreshold', 'diag']);
const PHASE_C = new Set(['iC', 'iCStar', 'vC', 'pwmC']);
const SWITCHING_ONLY = new Set(['pwmA', 'pwmB', 'pwmC']);

const PRESETS = {
  stepper:      { phases: 2, p: 50, R: 1.14, L: 3.0e-3, Kt: 0.22, J: 8.2e-6, Irated: 3.54 },
  stepperHighL: { phases: 2, p: 50, R: 2.4,  L: 8.0e-3, Kt: 0.22, J: 8.2e-6, Irated: 3.54 },
  stepperLowL:  { phases: 2, p: 50, R: 0.6,  L: 1.5e-3, Kt: 0.22, J: 8.2e-6, Irated: 3.54 },
  bldc:         { phases: 3, p: 7,  R: 0.5,  L: 0.4e-3, Kt: 0.06, J: 1.0e-5, Irated: 5.6 },
};

/**
 * Fixed-size ring of (t, v) samples. `head` is the next write index, `len`
 * the number of valid samples; logical sample i (0 = oldest) is at
 * (head − len + i + cap) % cap.
 */
export class RingBuffer {
  constructor(cap = RING_CAP) {
    this.cap = cap;
    this.t = new Float32Array(cap);
    this.v = new Float32Array(cap);
    this.head = 0;
    this.len = 0;
  }
  push(t, v) {
    const h = this.head;
    this.t[h] = t;
    this.v[h] = v;
    this.head = h + 1 === this.cap ? 0 : h + 1;
    if (this.len < this.cap) this.len++;
  }
  /** Value of logical sample i (0 = oldest). */
  at(i) { return this.v[(this.head - this.len + i + this.cap) % this.cap]; }
  /** Time of logical sample i (0 = oldest). */
  timeAt(i) { return this.t[(this.head - this.len + i + this.cap) % this.cap]; }
  clear() { this.head = 0; this.len = 0; }
}

function defaults() {
  return {
    motorType: 'stepper', motorPreset: null, supplyV: 24, driver: 'openloop', driverMode: 'current',
    fidelity: 'averaged', microsteps: 16, interpolate: true, runCurrent: null,
    chopper: { freqHz: 40000, hystA: 0.04, fastFrac: 0.12 }, hybridThresholdMmS: 60,
    mechanics: 'axis', axisLength: 350, hardStops: true, Jload: 5e-5,
    loads: { drag: 0, torque: 0 },
    planner: { maxVelocity: 150, accel: 5000, scv: 5, microsteps: 16, fullStepsPerRev: 200 },
    path: null, stallguard: { sgthrs: 60, minSpeedMmS: 10 },
    foc: { gains: 'optimal', filters: { torque: 1, flux: 1, velocity: 1 }, homingCurrent: 0.5,
      homingSpeedMmS: 40, retractMm: 5, mask: ['iqTargetLimit', 'uqOutputLimit', 'udOutputLimit'],
      virtualSteps: { fullStepsPerRev: 4096, microsteps: 2 } },
    encoder: { cpr: 4000 }, traceWindow: 2.0, seed: 1,
  };
}

function merge(dst, src) {
  if (!src) return dst;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const STRUCTURAL = new Set(['motorType', 'motorPreset', 'driver', 'fidelity', 'mechanics', 'compareMotor', 'encoder.cpr']);

export class FakeWorld {
  constructor() {
    this.traces = new Map();
    this.events = [];
    this.metrics = {
      overshootPct: 1.2, settleMs: 18, cornerErrMm: 0.08, oscFreqHz: 0, oscAmp: 0.01, noiseIdx: 0.02,
      rippleRms: 0.03, iAmpPct: 98, phaseLagDeg: 4, stepRate: 0, lostStepsMm: 0, pressInMm: 0,
      freeMotionIqPeak: 0.25, rise: 0.4, sweep: null, overshootMm: 0.02, posErrMm: 0, heat: 0.2,
    };
    this.configure({});
  }

  /** Sim time step in seconds (40 µs averaged, 0.5 µs switching). */
  get dt() { return this._dt; }

  /** Snapshot object (SPEC 5.7), refreshed lazily when read after steps. */
  get snapshot() {
    if (this.dirty) this.refresh();
    return this.snap;
  }

  /**
   * Apply a full scenario (SPEC 5.7); resets time, state and traces.
   * @param {Object} scenario
   */
  configure(scenario) {
    this.sc = merge(defaults(), scenario || {});
    const sc = this.sc;
    if (!sc.motorPreset) sc.motorPreset = sc.motorType === 'bldc' ? 'bldc' : 'stepper';
    this.m = PRESETS[sc.motorPreset] || PRESETS.stepper;
    this.foc = sc.driver === 'foc';
    this.switching = sc.fidelity === 'switching';
    this._dt = this.switching ? DT_SWITCHING : DT_AVERAGED;
    this.nMotors = sc.mechanics === 'corexy' ? 2 : 1;
    this.rs = (sc.seed | 0) || 1;
    this.t = 0;
    this.mode = 'path';           // always moving, so every view and trace has something to show
    this.speed = Math.min(100, sc.planner.maxVelocity || 100);
    this.bumpNow = 0;
    this.phase = 0;
    this.x = this.nMotors === 2 ? 175 : 100;
    this.y = this.nMotors === 2 ? 175 : 0;
    this.xa = this.x; this.ya = this.y; this.vx = 0; this.vy = 0; this.vxa = 0; this.vya = 0;
    this.target = this.x; this.jogDir = 1;
    this.bumpT = -1; this.lostMm = 0; this.homing = null; this.sweepT = -1;
    this.stepsPerMm = 200 * (sc.microsteps || 16) / 40;
    this.count = new Int32Array(this.nMotors);
    this.edges = new Int32Array(this.nMotors);
    this.lastStep = new Uint8Array(this.nMotors);
    this.dirLevel = new Uint8Array(this.nMotors);
    this.heat = new Float64Array(this.nMotors);
    this.noiseV = new Float64Array(this.nMotors);
    this.vals = new Float64Array(TRACE_NAMES.length);
    this.sampleCounter = 0;
    this.nextMetrics = 0.1;
    this.events.length = 0;
    this.buildTraces();
    this.buildSnapshot();
    this.dirty = true;
  }

  /**
   * Change one scenario value by dotted path ('supplyV', 'loads.drag', …).
   * Structural keys reconfigure; `traceWindow` clears the traces.
   * @param {string} path
   * @param {*} value
   * @param {{reset?: boolean}} [opts]
   */
  set(path, value, opts) {
    const keys = String(path).split('.');
    let o = this.sc;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
    if ((opts && opts.reset) || STRUCTURAL.has(path)) { this.configure(this.sc); return; }
    if (path === 'traceWindow') this.buildTraces();
    if (path === 'microsteps') this.stepsPerMm = 200 * (value || 16) / 40;
    this.dirty = true;
  }

  /**
   * Run a command: jog, moveTo, runPath, bump, home, sweep, reset,
   * singleStep, stop, setLoad, setTarget.
   * @param {string} name
   * @param {Object} [args]
   */
  command(name, args) {
    const a = args || {};
    switch (name) {
      case 'jog':
        this.mode = 'jog';
        if (a.speedMmS != null) { this.speed = Math.abs(a.speedMmS); this.jogDir = a.speedMmS < 0 ? -1 : 1; }
        break;
      case 'moveTo':
        this.mode = 'move';
        this.target = a.x != null ? +a.x : this.x;
        if (a.speedMmS) this.speed = Math.abs(a.speedMmS);
        break;
      case 'runPath':
        this.mode = 'path';
        break;
      case 'bump':
        this.bumpT = this.t;
        if (!this.foc) { this.lostMm += 0.8; this.pushEvent('stepLost', { motor: 0, mm: 0.8 }); }
        else this.pushEvent('flagSet', { motor: 0, flag: 'iqTargetLimit' });
        break;
      case 'home':
        this.mode = 'home';
        this.homing = { pass: this.homing && this.homing.result ? this.homing.pass + 1 : 1, contactT: -1, retractTo: null };
        if (this.homing.pass > 1 && this.x <= 0.01) {
          this.pushEvent('homingNoEdge', { motor: 0 });
          this.homing.result = 'no-edge';
          this.mode = 'idle';
        }
        break;
      case 'sweep':
        this.mode = 'sweep'; this.sweepT = this.t; this.speed = 20;
        break;
      case 'singleStep':
        this.mode = 'idle';
        this.x += 1 / this.stepsPerMm;
        break;
      case 'stop':
        this.mode = 'idle';
        break;
      case 'reset':
        this.configure(this.sc);
        break;
      case 'setLoad':
        if (a.drag != null) this.sc.loads.drag = +a.drag;
        if (a.torque != null) this.sc.loads.torque = +a.torque;
        break;
      case 'setTarget':
        if (a.omegaMmS != null) { this.mode = 'jog'; this.speed = Math.abs(a.omegaMmS); this.jogDir = a.omegaMmS < 0 ? -1 : 1; }
        break;
      default:
        console.warn('[FakeWorld] unknown command:', name);
    }
    this.dirty = true;
  }

  /** Advance one dt. */
  step() {
    const dt = this._dt;
    this.t += dt;
    this.motion(dt);
    this.stepgen();
    if (++this.sampleCounter >= this.decimation) { this.sampleCounter = 0; this.sample(); }
    if (this.t >= this.nextMetrics) { this.nextMetrics += 0.1; this.walkMetrics(); }
    this.dirty = true;
  }

  /** @private seeded PRNG (mulberry32), never Math.random in the loop */
  rand() {
    let a = (this.rs = (this.rs + 0x6D2B79F5) | 0);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }

  /** @private */
  pushEvent(type, data) { this.events.push({ t: this.t, type, data }); }

  /** @private one ring per trace and motor, absent where the trace makes no sense */
  buildTraces() {
    const map = new Map();
    this.rings = [];
    for (let m = 0; m < this.nMotors; m++) {
      const row = new Array(TRACE_NAMES.length).fill(null);
      for (let k = 0; k < TRACE_NAMES.length; k++) {
        const n = TRACE_NAMES[k];
        if (this.foc && OPEN_ONLY.has(n)) continue;
        if (!this.foc && FOC_ONLY.has(n)) continue;
        if (this.m.phases === 2 && PHASE_C.has(n)) continue;
        if (!this.switching && SWITCHING_ONLY.has(n)) continue;
        if (n === 'beltPos' && this.nMotors < 2) continue;
        const ring = new RingBuffer(RING_CAP);
        row[k] = ring;
        map.set(n + '#' + m, ring);
      }
      this.rings.push(row);
    }
    this.traces = map;
    this.decimation = Math.max(1, Math.ceil((this.sc.traceWindow || 2) / (RING_CAP * this._dt)));
    this.sampleCounter = 0;
  }

  /**
   * @private preallocated snapshot, field names per SPEC 5.7 plus the real World's additive
   * per-motor `mode` (the driver mode in effect, filled by refresh())
   */
  buildSnapshot() {
    const ph = this.m.phases;
    const motor = () => ({
      thetaM: 0, omegaM: 0, thetaE: 0, iPhase: new Array(ph).fill(0), vPhase: new Array(ph).fill(0),
      iStar: new Array(ph).fill(0), bemf: new Array(ph).fill(0), iAlpha: 0, iBeta: 0, id: 0, iq: 0,
      idStar: 0, iqStar: 0, ud: 0, uq: 0, uMag: 0, uLimit: 0, torque: 0, loadTorque: 0, loadAngle: 0,
      thetaCmd: 0, vAmp: 0, pwmState: new Array(ph).fill(0), sg: null, diag: false,
      flags: { iqTargetLimit: false, xOutputLimit: false, uqOutputLimit: false, udOutputLimit: false, vErrSumLimit: false },
      status: false, heat: 0, iAmp: 0, iLimit: 0, driver: this.sc.driver, mode: 'current', lostCycles: 0,
      stepgen: { level: 0, dir: 1, rate: 0, count: 0 },
      encoder: { count: 0, a: 0, b: 0, thetaMeas: 0, omegaEst: 0 },
    });
    this.snap = {
      t: 0, dt: this._dt, motorType: this.sc.motorType, supplyV: this.sc.supplyV, fidelity: this.sc.fidelity,
      driver: this.sc.driver, driverMode: this.sc.driverMode, nMotors: this.nMotors,
      motors: Array.from({ length: this.nMotors }, motor),
      step: { level: 0, dir: 1, rate: 0, count: 0 },
      planner: { mode: 'path', x: 0, y: 0, vx: 0, vy: 0, phase: 'cruise', segmentIndex: 0, done: false },
      gantry: { x: 0, y: 0, xCmd: 0, yCmd: 0, atStopX: false, atStopY: false, lostMm: new Array(this.nMotors).fill(0) },
      homing: { active: false, pass: 0, contact: false, pressInMm: 0, freeIqPeak: 0, result: null, triggeredAtMm: null },
      sweep: { running: false, results: {}, currentV: this.sc.supplyV },
      events: this.events,
    };
  }

  /** @private commanded motion (x, y in mm) and a lagging actual position */
  motion(dt) {
    const L = this.sc.axisLength || 350;
    let nx = this.x, ny = this.y;
    switch (this.mode) {
      case 'path': {
        this.phase += dt * this.speed / 80;
        if (this.nMotors === 2) {
          nx = 175 + 80 * clamp(1.6 * Math.cos(this.phase), -1, 1);
          ny = 175 + 80 * clamp(1.6 * Math.sin(this.phase), -1, 1);
        } else {
          nx = 175 - 75 * Math.cos(this.phase * 80 / 75);
        }
        break;
      }
      case 'jog':
        nx = this.x + this.jogDir * this.speed * dt;
        if (this.sc.mechanics !== 'free') {
          if (nx > L - 10) { nx = L - 10; this.jogDir = -1; }
          if (nx < 10) { nx = 10; this.jogDir = 1; }
        }
        break;
      case 'move': {
        const d = this.target - this.x, s = this.speed * dt;
        nx = this.x + clamp(d, -s, s);
        break;
      }
      case 'home': this.homeStep(dt); nx = this.x; break;
      case 'sweep':
        this.speed += 250 * dt;
        nx = this.x + this.speed * dt;
        if (this.t - this.sweepT > 3) {
          this.mode = 'idle';
          const res = this.snap.sweep.results;
          res[this.sc.supplyV] = Math.round(this.speed);
          this.pushEvent('sweepDone', { supplyV: this.sc.supplyV, maxMmS: Math.round(this.speed) });
        }
        break;
      default: break;
    }
    this.vx = (nx - this.x) / dt;
    this.vy = (ny - this.y) / dt;
    this.x = nx; this.y = ny;
    // actual position: 4 ms lag, plus the bump transient (and a lost cycle open loop)
    const k = Math.min(1, dt / 0.004);
    let bump = 0;
    if (this.bumpT >= 0) {
      const tb = this.t - this.bumpT;
      if (tb < 0.25) bump = (this.foc ? 0.4 : 0.6) * Math.exp(-tb / 0.03) * Math.sin(TWO_PI * 35 * tb);
    }
    const xa = this.xa + (this.x - this.lostMm - this.xa) * k;
    const ya = this.ya + (this.y - this.ya) * k;
    this.vxa = (xa - this.xa) / dt; this.vya = (ya - this.ya) / dt;
    this.xa = xa; this.ya = ya;
    this.bumpNow = bump;
  }

  /** @private fake homing: approach 0, contact, press, retract */
  homeStep(dt) {
    const h = this.homing, sp = this.sc.foc.homingSpeedMmS || 40;
    if (h.contactT < 0) {
      this.x = Math.max(0, this.x - sp * dt);
      if (this.x <= 0) {
        h.contactT = this.t;
        this.pushEvent('contact', { motor: 0, x: 0 });
      }
    } else if (h.retractTo === null && this.t - h.contactT > 0.06) {
      const press = 0.05 + 0.08 * (this.sc.foc.homingCurrent || 0.5);
      this.metrics.pressInMm = press;
      this.pushEvent('homingDone', { motor: 0, x: 0, pressInMm: press });
      h.result = 'ok';
      h.retractTo = this.sc.foc.retractMm || 0;
      if (!h.retractTo) this.mode = 'idle';
    } else if (h.retractTo !== null) {
      this.x = Math.min(h.retractTo, this.x + sp * dt);
      if (this.x >= h.retractTo) this.mode = 'idle';
    }
  }

  /** @private STEP/DIR edges from the commanded motor positions */
  stepgen() {
    for (let m = 0; m < this.nMotors; m++) {
      const pos = this.nMotors === 2 ? (m === 0 ? this.x + this.y : this.x - this.y) : this.x;
      const target = Math.round(pos * this.stepsPerMm);
      const d = target - this.count[m];
      if (d !== 0) {
        this.edges[m] += d > 0 ? d : -d;
        this.dirLevel[m] = d > 0 ? 1 : 0;
        this.count[m] = target;
      }
    }
  }

  /** @private electrical state of motor m, into this.e (shared scratch) */
  electrical(m) {
    const M = this.m, sc = this.sc;
    const I = sc.runCurrent != null ? sc.runCurrent : M.Irated;
    const posCmd = this.nMotors === 2 ? (m === 0 ? this.x + this.y : this.x - this.y) : this.x;
    const posAct = this.nMotors === 2 ? (m === 0 ? this.xa + this.ya : this.xa - this.ya) : this.xa;
    const velAct = this.nMotors === 2 ? (m === 0 ? this.vxa + this.vya : this.vxa - this.vya) : this.vxa;
    const thetaM = TWO_PI * (posAct + (m === 0 ? this.bumpNow : 0)) / 40;
    const omegaM = TWO_PI * velAct / 40;
    const thetaE = M.p * thetaM, omegaE = M.p * omegaM;
    const lambda = M.Kt / ((M.phases === 3 ? 1.5 : 1) * M.p);
    const e = this.e || (this.e = {});
    e.posCmd = posCmd; e.posAct = posAct; e.thetaM = thetaM; e.omegaM = omegaM; e.thetaE = thetaE;
    e.omegaE = omegaE; e.lambda = lambda;
    let id, iq, idS, iqS, thetaCur;
    if (this.foc) {
      const load = this.sc.loads.torque + this.sc.loads.drag + 0.02;
      iqS = clamp(load / M.Kt + 0.002 * Math.abs(this.vx) + (this.bumpNow ? 2.5 * this.bumpNow : 0), -I, I);
      idS = 0;
      iq = iqS + (this.rand() - 0.5) * 0.03 * M.Irated;
      id = (this.rand() - 0.5) * 0.03 * M.Irated;
      thetaCur = thetaE;
      e.thetaCmd = thetaE;
    } else {
      const thetaCmd = M.p * TWO_PI * posCmd / 40;
      const lag = Math.atan(Math.abs(omegaE) * M.L / (M.R * (sc.driverMode === 'voltage' ? 1 : 8)));
      const amp = I / Math.sqrt(1 + Math.pow(Math.abs(omegaE) * M.L / (sc.supplyV / I), 2));
      thetaCur = thetaCmd - Math.sign(omegaE) * lag;
      const delta = thetaCur - thetaE;
      id = amp * Math.cos(delta); iq = amp * Math.sin(delta);
      idS = I * Math.cos(thetaCmd - thetaE); iqS = I * Math.sin(thetaCmd - thetaE);
      e.thetaCmd = thetaCmd;
    }
    const c = Math.cos(thetaE), s = Math.sin(thetaE);
    e.iAlpha = id * c - iq * s; e.iBeta = id * s + iq * c;
    e.iAlphaS = idS * c - iqS * s; e.iBetaS = idS * s + iqS * c;
    e.id = id; e.iq = iq; e.idS = idS; e.iqS = iqS;
    e.ud = M.R * id - omegaE * M.L * iq;
    e.uq = M.R * iq + lambda * omegaE + omegaE * M.L * id;
    e.uLimit = M.phases === 3 ? sc.supplyV / Math.sqrt(3) : sc.supplyV;
    e.uMag = Math.min(e.uLimit, Math.hypot(e.ud, e.uq));
    e.iAmp = Math.hypot(e.iAlpha, e.iBeta);
    e.I = I;
    e.torque = M.Kt * iq;
    e.loadTorque = sc.loads.torque + sc.loads.drag * Math.sign(omegaM);
    e.loadAngle = Math.atan2(iq, id);   // rad in ±π, like the real World (not degrees)
    e.bemfA = -lambda * omegaE * s;
    e.vAmp = Math.min(sc.supplyV, M.R * I + lambda * Math.abs(omegaE));
    return e;
  }

  /** @private push one sample of every trace */
  sample() {
    const t = this.t, vals = this.vals, sc = this.sc, M = this.m;
    for (let m = 0; m < this.nMotors; m++) {
      const e = this.electrical(m);
      const row = this.rings[m];
      const edges = this.edges[m];
      const stepV = edges > 0 && this.lastStep[m] === 0 ? 1 : 0;
      this.lastStep[m] = stepV;
      this.edges[m] = 0;
      vals[K.step] = stepV;
      vals[K.stepN] = edges;
      vals[K.dir] = this.dirLevel[m];
      const corexy = this.nMotors === 2;
      vals[K.posCmd] = corexy ? (m === 0 ? this.x : this.y) : this.x;
      vals[K.posAct] = corexy ? (m === 0 ? this.xa : this.ya) : this.xa;
      vals[K.posErr] = vals[K.posCmd] - vals[K.posAct];
      vals[K.velCmd] = corexy ? (m === 0 ? this.vx : this.vy) : this.vx;
      vals[K.velAct] = corexy ? (m === 0 ? this.vxa : this.vya) : this.vxa;
      vals[K.beltPos] = e.posAct;
      // phase quantities from alpha/beta
      let ripple = 0, pwm = 0;
      if (this.switching) {
        const f = sc.chopper.freqHz || 40000, ph = (t * f) % 1;
        const on = 0.5 + 0.3 * Math.abs(Math.cos(e.thetaE)), fast = sc.chopper.fastFrac || 0.12;
        pwm = ph < on ? 1 : ph < on + fast ? -1 : 0;
        ripple = (sc.chopper.hystA || 0.04) * (ph < on ? ph / on - 0.5 : 0.5 - (ph - on) / (1 - on));
      }
      const noise = (this.rand() - 0.5) * 0.02 * e.I + ripple;
      this.noiseV[m] = noise;
      if (M.phases === 2) {
        vals[K.iA] = e.iAlpha + noise; vals[K.iB] = e.iBeta - noise;
        vals[K.iAStar] = e.iAlphaS; vals[K.iBStar] = e.iBetaS;
      } else {
        vals[K.iA] = e.iAlpha + noise;
        vals[K.iB] = -0.5 * e.iAlpha + SQRT3_2 * e.iBeta;
        vals[K.iC] = -0.5 * e.iAlpha - SQRT3_2 * e.iBeta - noise;
        vals[K.iAStar] = e.iAlphaS;
        vals[K.iBStar] = -0.5 * e.iAlphaS + SQRT3_2 * e.iBetaS;
        vals[K.iCStar] = -0.5 * e.iAlphaS - SQRT3_2 * e.iBetaS;
      }
      const lead = Math.atan2(e.uq, e.ud);
      const vmag = e.uMag;
      vals[K.vA] = this.switching ? pwm * sc.supplyV : vmag * Math.cos(e.thetaE + lead);
      vals[K.vB] = this.switching ? -pwm * sc.supplyV : vmag * Math.cos(e.thetaE + lead - (M.phases === 3 ? TWO_PI / 3 : Math.PI / 2));
      vals[K.vC] = vmag * Math.cos(e.thetaE + lead + TWO_PI / 3);
      vals[K.pwmA] = pwm; vals[K.pwmB] = -pwm; vals[K.pwmC] = pwm;
      vals[K.bemfA] = e.bemfA;
      vals[K.iAmp] = e.iAmp; vals[K.vAmp] = e.vAmp;
      vals[K.id] = e.id; vals[K.iq] = e.iq; vals[K.idStar] = e.idS; vals[K.iqStar] = e.iqS;
      vals[K.ud] = e.ud; vals[K.uq] = e.uq; vals[K.uMag] = e.uMag; vals[K.uLimit] = e.uLimit;
      vals[K.torque] = e.torque; vals[K.loadTorque] = e.loadTorque; vals[K.loadAngle] = e.loadAngle;
      // StallGuard-like value: NaN below the minimum speed
      const vAbs = Math.abs(vals[K.velAct]);
      const sg = vAbs < (sc.stallguard.minSpeedMmS || 10) ? NaN
        : 1023 * clamp(0.93 - 2.5 * sc.loads.drag - 0.15 * vAbs / 300 + (this.rand() - 0.5) * 0.04, 0, 1);
      vals[K.sg] = sg;
      vals[K.sgThreshold] = 2 * (sc.stallguard.sgthrs || 0);
      vals[K.diag] = sg === sg && sg < 2 * sc.stallguard.sgthrs ? 1 : 0;
      const flag = (this.bumpT >= 0 && t - this.bumpT < 0.05)
        || (this.homing && this.homing.contactT >= 0 && this.mode === 'home') ? 1 : 0;
      vals[K.status] = flag; vals[K.flagIqTarget] = flag; vals[K.flagUq] = 0;
      const cpr = (sc.encoder && sc.encoder.cpr) || 4000;
      const count = Math.floor(e.thetaM * cpr / TWO_PI);
      const q = ((count % 4) + 4) % 4;
      vals[K.encA] = q === 1 || q === 2 ? 1 : 0;
      vals[K.encB] = q >= 2 ? 1 : 0;
      vals[K.encCount] = count;
      vals[K.noise] = noise;
      const heat = this.heat[m] += ((e.iAmp * e.iAmp) / (M.Irated * M.Irated) - this.heat[m]) * 0.002;
      vals[K.heat] = heat;
      vals[K.iLimit] = this.mode === 'home' ? sc.foc.homingCurrent : e.I;
      for (let k = 0; k < row.length; k++) {
        const ring = row[k];
        if (ring) ring.push(t, vals[k]);
      }
    }
  }

  /** @private random-walk metrics, published every 100 ms of sim time */
  walkMetrics() {
    const mt = this.metrics;
    const walk = (key, step, lo, hi) => { mt[key] = clamp(mt[key] + (this.rand() - 0.5) * step, lo, hi); };
    walk('overshootPct', 0.4, 0, 8); walk('settleMs', 3, 5, 60); walk('cornerErrMm', 0.02, 0, 0.5);
    walk('oscAmp', 0.01, 0, 0.2); walk('noiseIdx', 0.005, 0, 0.1); walk('rippleRms', 0.005, 0, 0.1);
    walk('iAmpPct', 2, 60, 100); walk('phaseLagDeg', 1, 0, 40); walk('rise', 0.05, 0.1, 2);
    walk('freeMotionIqPeak', 0.02, 0.1, 0.5); walk('overshootMm', 0.01, 0, 0.2);
    mt.oscFreqHz = mt.oscAmp > 0.1 ? 900 : 0;
    mt.stepRate = Math.abs(this.vx) * this.stepsPerMm;
    mt.lostStepsMm = this.lostMm;
    mt.posErrMm = Math.abs(this.x - this.xa);
    mt.heat = this.heat[0];
    mt.sweep = this.snap.sweep.results;
  }

  /**
   * @private driver mode in effect for motor m, as the real World's `motors[i].mode`: FOC
   * velocity or torque, else position; open loop voltage or current (any other mode is
   * current), hybrid current at a commanded motor speed ≥ hybridThresholdMmS (no hysteresis
   * in the fake)
   * @param {number} m motor index
   * @returns {string}
   */
  modeOf(m) {
    const dm = this.sc.driverMode;
    if (this.foc) return dm === 'velocity' || dm === 'torque' ? dm : 'position';
    if (dm === 'voltage') return 'voltage';
    if (dm !== 'hybrid') return 'current';
    const v = this.nMotors === 2 ? (m === 0 ? this.vx + this.vy : this.vx - this.vy) : this.vx;
    const thr = this.sc.hybridThresholdMmS;
    return Math.abs(v) >= (typeof thr === 'number' ? thr : 60) ? 'current' : 'voltage';
  }

  /** @private fill the snapshot from the current state */
  refresh() {
    this.dirty = false;
    const S = this.snap, sc = this.sc, M = this.m;
    S.t = this.t; S.dt = this._dt; S.supplyV = sc.supplyV; S.driverMode = sc.driverMode;
    for (let m = 0; m < this.nMotors; m++) {
      const e = this.electrical(m), o = S.motors[m];
      o.thetaM = e.thetaM; o.omegaM = e.omegaM; o.thetaE = e.thetaE; o.thetaCmd = e.thetaCmd;
      o.iAlpha = e.iAlpha; o.iBeta = e.iBeta; o.id = e.id; o.iq = e.iq; o.idStar = e.idS; o.iqStar = e.iqS;
      o.ud = e.ud; o.uq = e.uq; o.uMag = e.uMag; o.uLimit = e.uLimit; o.torque = e.torque;
      o.loadTorque = e.loadTorque; o.loadAngle = e.loadAngle; o.vAmp = e.vAmp; o.iAmp = e.iAmp; o.iLimit = e.I;
      o.mode = this.modeOf(m);
      if (M.phases === 2) {
        o.iPhase[0] = e.iAlpha; o.iPhase[1] = e.iBeta; o.iStar[0] = e.iAlphaS; o.iStar[1] = e.iBetaS;
      } else {
        o.iPhase[0] = e.iAlpha; o.iPhase[1] = -0.5 * e.iAlpha + SQRT3_2 * e.iBeta; o.iPhase[2] = -o.iPhase[0] - o.iPhase[1];
        o.iStar[0] = e.iAlphaS; o.iStar[1] = -0.5 * e.iAlphaS + SQRT3_2 * e.iBetaS; o.iStar[2] = -o.iStar[0] - o.iStar[1];
      }
      o.bemf[0] = e.bemfA;
      o.heat = this.heat[m];
      o.sg = this.foc ? null : 900;
      o.diag = false;
      o.status = !!(this.bumpT >= 0 && this.t - this.bumpT < 0.05);
      o.flags.iqTargetLimit = o.status;
      const cpr = (sc.encoder && sc.encoder.cpr) || 4000;
      o.encoder.count = Math.floor(e.thetaM * cpr / TWO_PI);
      o.encoder.thetaMeas = o.encoder.count * TWO_PI / cpr;
      o.encoder.omegaEst = e.omegaM;
      o.stepgen.count = this.count[m]; o.stepgen.dir = this.dirLevel[m];
      o.stepgen.rate = Math.abs(m === 0 ? this.vx : this.vy) * this.stepsPerMm;
    }
    S.step.count = this.count[0]; S.step.dir = this.dirLevel[0]; S.step.rate = S.motors[0].stepgen.rate;
    S.step.level = this.lastStep[0];
    const P = S.planner;
    P.mode = this.mode; P.x = this.x; P.y = this.y; P.vx = this.vx; P.vy = this.vy;
    const G = S.gantry;
    G.x = this.xa; G.y = this.ya; G.xCmd = this.x; G.yCmd = this.y;
    G.atStopX = this.x <= 0.001; G.atStopY = false; G.lostMm[0] = this.lostMm;
    const H = S.homing, h = this.homing;
    H.active = this.mode === 'home'; H.pass = h ? h.pass : 0; H.contact = !!(h && h.contactT >= 0);
    H.pressInMm = this.metrics.pressInMm; H.result = h ? h.result || null : null;
    S.sweep.running = this.mode === 'sweep'; S.sweep.currentV = sc.supplyV;
  }
}
