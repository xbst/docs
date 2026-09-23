// Trace ring buffers and the per-scenario trace wiring for World (chunk-02 design section 15).
//
// world.traces is a Map<string, RingBuffer> keyed `name#motorIndex` (index 0 for global traces).
// Which traces exist depends on the scenario: open-loop motors add sg/sgThreshold/diag and the
// pwmA/pwmB lanes, FOC motors add status/flagIqTarget/flagUq/iLimit, three-phase motors
// add the C phase, CoreXY maps posCmd/posAct/posErr/velCmd/velAct #0/#1 to the toolhead x/y and
// adds beltPos#i. Each trace is a (code, motor) pair resolved at configure time; pushTraces
// evaluates them with one switch, so pushing neither calls closures nor allocates.
// `noise#i` is world.noise[i] in amps: FOC (uq − LPF500(uq))/Kpq(optimal), open loop
// iA − LPF500(iA) (the signal metrics.noiseIdx measures).

/** Samples per trace ring. */
export const TRACE_CAP = 4096;

/**
 * Fixed-capacity ring of (time, value) samples in Float32Arrays.
 * `head` is the index of the next write, `len` the number of valid samples (≤ cap). Logical
 * sample i (0 = oldest) lives at `(head − len + i + cap) % cap`; the newest at
 * `(head − 1 + cap) % cap`. NaN values mark gaps (e.g. `sg = null`).
 */
export class RingBuffer {
  /**
   * @param {number} [cap=4096] capacity in samples
   */
  constructor(cap = TRACE_CAP) {
    /** @type {number} */ this.cap = cap;
    /** @type {Float32Array} sample times (s of sim time, non-decreasing) */ this.t = new Float32Array(cap);
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
const T_ILIMIT = 52, T_STEP = 53, T_DIR = 54;

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
  return { map, bufs, codes: Int32Array.from(codes), motors: Int32Array.from(motors) };
}

/**
 * Pushes one sample of every trace at the world's time (called every `decimation` steps).
 * `step` is 1 for the first sample after one or more pulses and alternates 1/0 while pulses
 * come faster than the sample rate (dense band on the scope); `sg = null` is written as NaN.
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
    let v = 0;
    switch (codes[j]) {
      case T_IA: v = m.iPhase[0]; break;
      case T_IB: v = m.iPhase[1]; break;
      case T_IC: v = m.iPhase[2]; break;
      case T_IASTAR: v = m.iStar[0]; break;
      case T_IBSTAR: v = m.iStar[1]; break;
      case T_ICSTAR: v = m.iStar[2]; break;
      case T_VA: v = m.vPhase[0]; break;
      case T_VB: v = m.vPhase[1]; break;
      case T_VC: v = m.vPhase[2]; break;
      case T_BEMFA: v = m.bemf[0]; break;
      case T_IAMP: v = m.iAmp; break;
      case T_VAMP: v = m.vAmp; break;
      case T_ID: v = m.id; break;
      case T_IQ: v = m.iq; break;
      case T_IDSTAR: v = m.idStar; break;
      case T_IQSTAR: v = m.iqStar; break;
      case T_UD: v = m.ud; break;
      case T_UQ: v = m.uq; break;
      case T_UMAG: v = m.uMag; break;
      case T_ULIMIT: v = m.uLimit; break;
      case T_TORQUE: v = m.torque; break;
      case T_LOADTORQUE: v = m.loadTorque; break;
      case T_LOADANGLE: v = m.loadAngle; break;
      case T_ENCA: v = m.encoder.a; break;
      case T_ENCB: v = m.encoder.b; break;
      case T_ENCCOUNT: v = m.encoder.count; break;
      case T_NOISE: v = w.noise[i]; break;
      case T_HEAT: v = m.heat; break;
      case T_XCMD: v = g.xCmd; break;
      case T_XACT: v = g.x; break;
      case T_XERR: v = g.xCmd - g.x; break;
      case T_VXCMD: v = w.vxCmd; break;
      case T_VXACT: v = mech.vx; break;
      case T_YCMD: v = g.yCmd; break;
      case T_YACT: v = g.y; break;
      case T_YERR: v = g.yCmd - g.y; break;
      case T_VYCMD: v = w.vyCmd; break;
      case T_VYACT: v = mech.vy; break;
      case T_BELTPOS: v = m.thetaM * k; break;
      case T_POSCMD: v = w.cmdTheta[i] * k; break;
      case T_POSACT: v = m.thetaM * k; break;
      case T_POSERR: v = (w.cmdTheta[i] - m.thetaM) * k; break;
      case T_VELCMD: v = w.cmdOmega[i] * k; break;
      case T_VELACT: v = m.omegaM * k; break;
      case T_SG: v = m.sg === null ? NaN : m.sg; break;
      case T_SGTHR: {
        const sgd = w.stallguards[i];
        v = sgd !== null ? sgd.threshold : NaN;
        break;
      }
      case T_DIAG: v = m.diag ? 1 : 0; break;
      case T_PWMA: v = m.pwmState[0]; break;
      case T_PWMB: v = m.pwmState[1]; break;
      case T_STATUS: v = m.status ? 1 : 0; break;
      case T_FLAGIQ: v = m.flags.iqTargetLimit ? 1 : 0; break;
      case T_FLAGUQ: v = m.flags.uqOutputLimit ? 1 : 0; break;
      case T_ILIMIT: v = m.iLimit; break;
      case T_STEP:
        v = 0;
        if (w.stepEdges > 0) v = w.stepLast === 1 ? 0 : 1;
        w.stepLast = v;
        w.stepEdges = 0;
        break;
      case T_DIR: v = snap.step.dir > 0 ? 1 : 0; break;
      default: v = NaN;
    }
    // Inline RingBuffer.push: a call would box the two doubles when it is not inlined.
    const rb = bufs[j];
    const h = rb.head;
    rb.t[h] = t;
    rb.v[h] = v;
    rb.head = h + 1 === rb.cap ? 0 : h + 1;
    if (rb.len < rb.cap) rb.len++;
  }
}
