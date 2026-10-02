// Trace ring buffers and the per-scenario trace wiring for World (chunk-02 design section 15).
//
// world.traces is a Map<string, RingBuffer> keyed `name#motorIndex` (index 0 for global traces).
// Which traces exist depends on the scenario: open-loop motors add sg/sgThreshold/diag and the
// pwmA/pwmB lanes, FOC motors add status/flagIqTarget/flagUq/iLimit, three-phase motors
// add the C phase, CoreXY maps posCmd/posAct/posErr/velCmd/velAct #0/#1 to the toolhead x/y and
// adds beltPos#i. Each trace is a (code, motor) pair resolved at configure time; pushTraces
// evaluates them with one switch, so pushing neither calls closures nor allocates.
// `noise#i` is world.noise[i] in amps: FOC (uq − LPF500(uq))/Kpq(optimal), open loop
// e − LPF500(e) with e = iA − iA* (the signal metrics.noiseIdx measures).
// `stepN#0` (chunk 04) is the number of STEP pulses motor 0's step generator emitted since the
// previous sample (0, 1, 2, …), so a scope lane can draw every pulse even when several fall into
// one sample; `step#0` keeps its alternating 1/0 level encoding.
// Sample times are Float64 (absolute sim time keeps sub-microsecond resolution after hours; a
// Float32 time lost the 0.5 µs switching step after minutes); values stay Float32. The scope
// reads `t`/`v` directly and does not depend on the array types.
// Decimation (traceDecimation) rounds up, so the 4096-sample ring always spans at least
// traceWindow.

/** Samples per trace ring. */
export const TRACE_CAP = 4096;

/**
 * Sim steps per trace sample: max(1, ceil(traceWindow/(TRACE_CAP·dt))), so the ring covers at
 * least `traceWindow` (round() left it up to a third short).
 * @param {number} traceWindow scope window (s)
 * @param {number} dt sim step (s)
 * @returns {number} decimation (integer ≥ 1)
 */
export function traceDecimation(traceWindow, dt) {
  return Math.max(1, Math.ceil(traceWindow / (TRACE_CAP * dt)));
}

/**
 * Fixed-capacity ring of (time, value) samples: times in a Float64Array (absolute sim time,
 * full resolution), values in a Float32Array.
 * `head` is the index of the next write, `len` the number of valid samples (≤ cap). Logical
 * sample i (0 = oldest) lives at `(head − len + i + cap) % cap`; the newest at
 * `(head − 1 + cap) % cap`. NaN values mark gaps (e.g. `sg` with no reading).
 */
export class RingBuffer {
  /**
   * @param {number} [cap=4096] capacity in samples
   */
  constructor(cap = TRACE_CAP) {
    /** @type {number} */ this.cap = cap;
    /** @type {Float64Array} sample times (s of sim time, non-decreasing) */ this.t = new Float64Array(cap);
    /** @type {Float32Array} sample values */ this.v = new Float32Array(cap);
    /** @type {number} index of the next write */ this.head = 0;
    /** @type {number} valid samples */ this.len = 0;
  }

  /**
   * Appends one sample (overwrites the oldest when full). Does not allocate.
   * @param {number} t time (s)
   * @param {number} v value
   */
  push(t, v) {
    const h = this.head;
    this.t[h] = t;
    this.v[h] = v;
    this.head = h + 1 === this.cap ? 0 : h + 1;
    if (this.len < this.cap) this.len++;
  }

  /**
   * Value of the i-th oldest sample (0 ≤ i < len).
   * @param {number} i
   * @returns {number}
   */
  at(i) {
    return this.v[(this.head - this.len + i + this.cap) % this.cap];
  }

  /**
   * Time of the i-th oldest sample (0 ≤ i < len).
   * @param {number} i
   * @returns {number}
   */
  timeAt(i) {
    return this.t[(this.head - this.len + i + this.cap) % this.cap];
  }

  /** Empties the ring (keeps the storage). */
  clear() {
    this.head = 0;
    this.len = 0;
  }
}

// Trace source codes.
const T_IA = 0, T_IB = 1, T_IC = 2, T_IASTAR = 3, T_IBSTAR = 4, T_ICSTAR = 5, T_VA = 6, T_VB = 7, T_VC = 8;
const T_BEMFA = 9, T_IAMP = 10, T_VAMP = 11, T_ID = 12, T_IQ = 13, T_IDSTAR = 14, T_IQSTAR = 15, T_UD = 16;
const T_UQ = 17, T_UMAG = 18, T_ULIMIT = 19, T_TORQUE = 20, T_LOADTORQUE = 21, T_LOADANGLE = 22, T_ENCA = 23;
const T_ENCB = 24, T_ENCCOUNT = 25, T_NOISE = 26, T_HEAT = 27, T_XCMD = 28, T_XACT = 29, T_XERR = 30;
const T_VXCMD = 31, T_VXACT = 32, T_YCMD = 33, T_YACT = 34, T_YERR = 35, T_VYCMD = 36, T_VYACT = 37;
const T_BELTPOS = 38, T_POSCMD = 39, T_POSACT = 40, T_POSERR = 41, T_VELCMD = 42, T_VELACT = 43, T_SG = 44;
const T_SGTHR = 45, T_DIAG = 46, T_PWMA = 47, T_PWMB = 48, T_STATUS = 49, T_FLAGIQ = 50, T_FLAGUQ = 51;
const T_ILIMIT = 52, T_STEP = 53, T_DIR = 54, T_STEPN = 55;

/**
 * Builds the trace map for a configured world (configure-time only; allocates). Reads
 * `world.snapshot`, `world.nMotors`, `world.kinematics`, `world.openloop`, `world.foc`.
 * @param {object} world a World after its modules and snapshot were built
 * @returns {{ map: Map<string, RingBuffer>, bufs: RingBuffer[], codes: Int32Array, motors: Int32Array }}
 */
export function buildTraces(world) {
  const map = new Map();
  const bufs = [];
  const codes = [];
  const motors = [];
  const add = (name, idx, code) => {
    const rb = new RingBuffer(TRACE_CAP);
    map.set(name + '#' + idx, rb);
    bufs.push(rb);
    codes.push(code);
    motors.push(idx);
  };
  const corexy = world.kinematics === 'corexy';
  for (let i = 0; i < world.nMotors; i++) {
    const three = world.snapshot.motors[i].iPhase.length === 3;
    add('iA', i, T_IA);
    add('iB', i, T_IB);
    if (three) add('iC', i, T_IC);
    add('iAStar', i, T_IASTAR);
    add('iBStar', i, T_IBSTAR);
    if (three) add('iCStar', i, T_ICSTAR);
    add('vA', i, T_VA);
    add('vB', i, T_VB);
    if (three) add('vC', i, T_VC);
    add('bemfA', i, T_BEMFA);
    add('iAmp', i, T_IAMP);
    add('vAmp', i, T_VAMP);
    add('id', i, T_ID);
    add('iq', i, T_IQ);
    add('idStar', i, T_IDSTAR);
    add('iqStar', i, T_IQSTAR);
    add('ud', i, T_UD);
    add('uq', i, T_UQ);
    add('uMag', i, T_UMAG);
    add('uLimit', i, T_ULIMIT);
    add('torque', i, T_TORQUE);
    add('loadTorque', i, T_LOADTORQUE);
    add('loadAngle', i, T_LOADANGLE);
    add('encA', i, T_ENCA);
    add('encB', i, T_ENCB);
    add('encCount', i, T_ENCCOUNT);
    add('noise', i, T_NOISE);
    add('heat', i, T_HEAT);
    if (corexy) {
      // #0 = toolhead x, #1 = toolhead y (commanded vs actual); beltPos per motor.
      if (i === 0) {
        add('posCmd', 0, T_XCMD); add('posAct', 0, T_XACT); add('posErr', 0, T_XERR);
        add('velCmd', 0, T_VXCMD); add('velAct', 0, T_VXACT);
      } else if (i === 1) {
        add('posCmd', 1, T_YCMD); add('posAct', 1, T_YACT); add('posErr', 1, T_YERR);
        add('velCmd', 1, T_VYCMD); add('velAct', 1, T_VYACT);
      }
      add('beltPos', i, T_BELTPOS);
    } else {
      add('posCmd', i, T_POSCMD); add('posAct', i, T_POSACT); add('posErr', i, T_POSERR);
      add('velCmd', i, T_VELCMD); add('velAct', i, T_VELACT);
    }
    if (world.openloop[i] !== null) {
      add('sg', i, T_SG);
      add('sgThreshold', i, T_SGTHR);
      add('diag', i, T_DIAG);
      // Per-phase applied polarity lanes (contract 15b: pwmA, pwmB, pwmC; range −1..1).
      add('pwmA', i, T_PWMA);
      add('pwmB', i, T_PWMB);
    }
    if (world.foc[i] !== null) {
      add('status', i, T_STATUS);
      add('flagIqTarget', i, T_FLAGIQ);
      add('flagUq', i, T_FLAGUQ);
      add('iLimit', i, T_ILIMIT);
    }
  }
  add('step', 0, T_STEP);
  add('dir', 0, T_DIR);
  add('stepN', 0, T_STEPN);
  return { map, bufs, codes: Int32Array.from(codes), motors: Int32Array.from(motors) };
}

/**
 * Pushes one sample of every trace at the world's time (called every `decimation` steps).
 * `step` is 1 for the first sample after one or more pulses and alternates 1/0 while pulses
 * come faster than the sample rate (dense band on the scope); `sg` is NaN (a gap) with no reading.
 * Does not allocate.
 * @param {object} w World (reads `_traceBufs`, `_traceCodes`, `_traceMotors`, `snapshot`, ...)
 */
export function pushTraces(w) {
  const t = w._t;
  const bufs = w._traceBufs;
  const codes = w._traceCodes;
  const mot = w._traceMotors;
  const snap = w.snapshot;
  const motors = snap.motors;
  const g = snap.gantry;
  const mech = w.mechanics;
  const k = w._mmPerRad;
  const nb = bufs.length;
  for (let j = 0; j < nb; j++) {
    const i = mot[j];
    const m = motors[i];
    // Inline RingBuffer.push, and every case writes its value straight into the ring: a shared
    // `v` would merge tagged and float values into one variable and box every double (chunk 09).
    const rb = bufs[j];
    const h = rb.head;
    const out = rb.v;
    switch (codes[j]) {
      case T_IA: out[h] = m.iPhase[0]; break;
      case T_IB: out[h] = m.iPhase[1]; break;
      case T_IC: out[h] = m.iPhase[2]; break;
      case T_IASTAR: out[h] = m.iStar[0]; break;
      case T_IBSTAR: out[h] = m.iStar[1]; break;
      case T_ICSTAR: out[h] = m.iStar[2]; break;
      case T_VA: out[h] = m.vPhase[0]; break;
      case T_VB: out[h] = m.vPhase[1]; break;
      case T_VC: out[h] = m.vPhase[2]; break;
      case T_BEMFA: out[h] = m.bemf[0]; break;
      case T_IAMP: out[h] = m.iAmp; break;
      case T_VAMP: out[h] = m.vAmp; break;
      case T_ID: out[h] = m.id; break;
      case T_IQ: out[h] = m.iq; break;
      case T_IDSTAR: out[h] = m.idStar; break;
      case T_IQSTAR: out[h] = m.iqStar; break;
      case T_UD: out[h] = m.ud; break;
      case T_UQ: out[h] = m.uq; break;
      case T_UMAG: out[h] = m.uMag; break;
      case T_ULIMIT: out[h] = m.uLimit; break;
      case T_TORQUE: out[h] = m.torque; break;
      case T_LOADTORQUE: out[h] = m.loadTorque; break;
      case T_LOADANGLE: out[h] = m.loadAngle; break;
      case T_ENCA: out[h] = m.encoder.a; break;
      case T_ENCB: out[h] = m.encoder.b; break;
      case T_ENCCOUNT: out[h] = m.encoder.count; break;
      case T_NOISE: out[h] = w.noise[i]; break;
      case T_HEAT: out[h] = m.heat; break;
      case T_XCMD: out[h] = g.xCmd; break;
      case T_XACT: out[h] = g.x; break;
      case T_XERR: out[h] = g.xCmd - g.x; break;
      case T_VXCMD: out[h] = w.vxCmd; break;
      case T_VXACT: out[h] = mech.vx; break;
      case T_YCMD: out[h] = g.yCmd; break;
      case T_YACT: out[h] = g.y; break;
      case T_YERR: out[h] = g.yCmd - g.y; break;
      case T_VYCMD: out[h] = w.vyCmd; break;
      case T_VYACT: out[h] = mech.vy; break;
      case T_BELTPOS: out[h] = m.thetaM * k; break;
      case T_POSCMD: out[h] = w.cmdTheta[i] * k; break;
      case T_POSACT: out[h] = m.thetaM * k; break;
      case T_POSERR: out[h] = (w.cmdTheta[i] - m.thetaM) * k; break;
      case T_VELCMD: out[h] = w.cmdOmega[i] * k; break;
      case T_VELACT: out[h] = m.omegaM * k; break;
      case T_SG: out[h] = m.sg; break;
      case T_SGTHR: {
        const sgd = w.stallguards[i];
        out[h] = sgd !== null ? sgd.threshold : NaN;
        break;
      }
      case T_DIAG: out[h] = m.diag ? 1 : 0; break;
      case T_PWMA: out[h] = m.pwmState[0]; break;
      case T_PWMB: out[h] = m.pwmState[1]; break;
      case T_STATUS: out[h] = m.status ? 1 : 0; break;
      case T_FLAGIQ: out[h] = m.flags.iqTargetLimit ? 1 : 0; break;
      case T_FLAGUQ: out[h] = m.flags.uqOutputLimit ? 1 : 0; break;
      case T_ILIMIT: out[h] = m.iLimit; break;
      case T_STEP: {
        const s = w.stepEdges > 0 ? (w.stepLast === 1 ? 0 : 1) : 0;
        out[h] = s;
        w.stepLast = s;
        w.stepEdges = 0;
        break;
      }
      case T_DIR: out[h] = snap.step.dir > 0 ? 1 : 0; break;
      case T_STEPN: out[h] = w.stepPulses; w.stepPulses = 0; break;
      default: out[h] = NaN;
    }
    rb.t[h] = t;
    rb.head = h + 1 === rb.cap ? 0 : h + 1;
    if (rb.len < rb.cap) rb.len++;
  }
}
