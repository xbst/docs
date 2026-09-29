// Per-step pipeline and snapshot fill for World (chunk-02 design section 15, "Per-step order"
// and "Snapshot"). Split out of world.js to keep files short and hot functions small enough for
// the JIT to inline the module calls (a non-inlined call boxes its floating-point arguments).
//
// Order per step:
//   1. planner.step (control ticks only) and the commanded motor angles/speeds
//   2. step generators (open loop: 4·p·microsteps per rev; FOC: virtual steps)
//   3. drivers: open loop consumePulses + step; FOC θ*/ω*/iq* targets + step (control ticks)
//   4. motors, 5. mechanics, 6. encoders and StallGuard
//   7. snapshot, homing/sweep machines, metrics, traces (every `decimation` steps), t += dt
// FOC step gets the encoder count as its 5th argument (the position error is counted in whole
// encoder cells). The planner's commanded speed (world.cmdOmega, mechanical rad/s) drives every
// speed-dependent decision, not the step-rate EMA (world._omegaCmdOL, kept for readers): the
// StallGuard minimum-speed gate (switches exactly at minSpeedMmS without flicker), the open-loop
// hybrid threshold (OpenLoopDriver.step's speed argument) and the step generator's DIR
// (StepGen.update's velSign, so DIR flips before the first reversed pulse).
// The noise signal (world.noise, amps) is, for FOC motors, (uq − LPF500(uq))/Kpq with the ×1
// (optimal) Kpq, and for open-loop motors e − LPF500(e) with the regulation error
// e = iA − iA* (at standstill the chopper ripple; at speed the current fundamental cancels).
// Voltage headroom: FOC motors report uMag = |(ud, uq)| against uLimit = Umax. Open-loop
// two-phase motors report uMag = max(|vA|, |vB|) against uLimit = Vbus (each H-bridge can only
// impose ±Vbus per phase; the α/β vector magnitude would reach √2·Vbus), and their current-mode
// vAmp is LPF200 of that same quantity (so vAmp ≤ Vbus).
// Events: flagSet on the rising edge of the LATCHED status (once per latch); stallDetected on the
// DIAG rising edge, then held off for 20 ms; stepLost at most once per 50 ms per motor, carrying
// `mm` (the signed distance lost since the previous stepLost event) next to `lostMm` (running
// total). The holdoff times live in world._gates (EventGates, created by buildSnapshot).
// Nothing here allocates on the steady path; events allocate one small object when they fire.

import { TWO_PI, wrapPi } from './units.js';
import { pushTraces } from './world-traces.js';

/** FOC mode code (world._focMode): position mode. */
export const FOC_POS = 0;
/** FOC mode code: velocity mode. */
export const FOC_VEL = 1;
/** FOC mode code: torque mode. */
export const FOC_TRQ = 2;
/** Control period of the planner, FOC and averaged current loops (s). */
export const CONTROL_DT = 40e-6;

/** Holdoff after a stallDetected event before the next DIAG rising edge may fire one (s). */
export const STALL_HOLDOFF_S = 0.02;
/** Minimum spacing of stepLost events per motor (s); the lost distance accumulates meanwhile. */
export const STEP_LOST_HOLDOFF_S = 0.05;

const SQRT3_2 = Math.sqrt(3) / 2;

/**
 * Per-motor event rate-limit state: sim time of the last stallDetected and stepLost event
 * (−Infinity = none yet, so the first event fires at once). Times stay valid across
 * World._resetState (t keeps running); a rebuild creates a fresh instance with t = 0.
 */
export class EventGates {
  /**
   * @param {number} n motor count
   */
  constructor(n) {
    /** @type {Float64Array} time of the last stallDetected event per motor (s) */
    this.stallT = new Float64Array(n).fill(-Infinity);
    /** @type {Float64Array} time of the last stepLost event per motor (s) */
    this.lostT = new Float64Array(n).fill(-Infinity);
  }
}

/**
 * Allocates the snapshot object for a built world (configure only) and the world's event
 * rate-limit state (`w._gates`, an EventGates). Field list: contract
 * section 15 (SPEC 5.7 names plus the additive driver, driverMode, nMotors, cmdAngleErr,
 * currentAngle, iAmp, iLimit, stepgen, lostCycles, triggeredAtMm, detail, currentV) and
 * `motors[i].mode` (the driver mode in effect: voltage/current/position/velocity/torque).
 * Chunk 03 (views) added: top-level `mechanics`, `motorPreset`, `axisLength` (mm), `rd` (mm per
 * motor turn) and `loads` ({ drag, torque, bump } in N·m, bump = the bump torque right now);
 * per motor `thetaStar` (position target, mech rad), `omegaStar` (velocity-loop target, mech
 * rad/s) and `omegaFilt` (the speed the velocity loop sees, mech rad/s), see fillMotor/fillFoc.
 * @param {object} w World
 * @returns {object} snapshot
 */
export function buildSnapshot(w) {
  const sc = w._sc;
  const n = w.nMotors;
  const motors = [];
  for (let i = 0; i < n; i++) {
    const ph = w.presets[i].phases;
    const isFoc = w.foc[i] !== null;
    motors.push({
      thetaM: 0, omegaM: 0, thetaE: 0,
      iPhase: new Float64Array(ph), vPhase: new Float64Array(ph), iStar: new Float64Array(ph), bemf: new Float64Array(ph),
      iAlpha: 0, iBeta: 0, id: 0, iq: 0, idStar: 0, iqStar: 0, ud: 0, uq: 0, uMag: 0, uLimit: 0,
      torque: 0, loadTorque: 0, loadAngle: 0, thetaCmd: 0, vAmp: 0, pwmState: new Int8Array(isFoc ? ph : 2),
      sg: null, diag: false,
      flags: { iqTargetLimit: false, xOutputLimit: false, uqOutputLimit: false, udOutputLimit: false, vErrSumLimit: false },
      status: false, heat: 0,
      encoder: { count: 0, a: 0, b: 0, thetaMeas: 0, omegaEst: 0 },
      cmdAngleErr: 0, currentAngle: 0, iAmp: 0, iLimit: 0,
      stepgen: { level: 0, dir: 1, rate: 0, count: 0 },
      driver: w.driverKinds[i], mode: w.driverModes[i], lostCycles: 0,
      thetaStar: 0, omegaStar: 0, omegaFilt: 0,
    });
  }
  const lostMm = [];
  for (let i = 0; i < n; i++) lostMm.push(0);
  w._gates = new EventGates(n);
  return {
    t: 0, dt: w._dt, motorType: sc.motorType, supplyV: sc.supplyV, fidelity: sc.fidelity,
    driver: sc.driver, driverMode: sc.driverMode, nMotors: n,
    mechanics: w.kinematics, motorPreset: sc.motorPreset,
    axisLength: typeof sc.axisLength === 'number' ? sc.axisLength : 350, rd: w.rd,
    loads: { drag: 0, torque: 0, bump: 0 },
    motors,
    step: { level: 0, dir: 1, rate: 0, count: 0 },
    planner: { mode: 'idle', x: 0, y: 0, vx: 0, vy: 0, phase: 'idle', segmentIndex: 0, done: false },
    gantry: { x: 0, y: 0, xCmd: 0, yCmd: 0, atStopX: false, atStopY: false, lostMm },
    homing: w.homing.snap,
    sweep: w.sweep.snap,
    events: w._events,
  };
}

/**
 * Commanded motor angles/speeds and toolhead from the planner, or from the setTarget
 * constant-speed ramp (ramped at the planner acceleration).
 * @param {object} w World
 * @param {number} cdt control period (s); 0 recomputes without advancing
 */
export function updateCommand(w, cdt) {
  const pl = w.planner;
  const n = w.nMotors;
  const cmdTheta = w.cmdTheta;
  const cmdOmega = w.cmdOmega;
  const k = w._mmPerRad;
  if (w._velActive) {
    let v = w._velCmd;
    const tgt = w._velTarget;
    const dv = w._velAccel * cdt;
    if (v < tgt) { v += dv; if (v > tgt) v = tgt; } else if (v > tgt) { v -= dv; if (v < tgt) v = tgt; }
    w._velCmd = v;
    const th = w._velTheta + v * cdt;
    w._velTheta = th;
    for (let i = 0; i < n; i++) { cmdTheta[i] = w._velBase[i] + th; cmdOmega[i] = v; }
    w.xCmd = pl.x + th * k;
    w.yCmd = pl.y;
    w.vxCmd = v * k;
    w.vyCmd = 0;
  } else {
    const src = w._srcIdx;
    for (let i = 0; i < n; i++) {
      cmdTheta[i] = pl.motorAngle(src[i]);
      cmdOmega[i] = pl.motorOmega(src[i]);
    }
    w.xCmd = pl.x;
    w.yCmd = pl.y;
    w.vxCmd = pl.vx;
    w.vyCmd = pl.vy;
  }
}

/**
 * Step generator and driver of motor i; writes the driver output voltage into w._va/_vb.
 * DIR and the open-loop hybrid switch follow the planner's commanded speed (w.cmdOmega);
 * w._omegaCmdOL keeps the step-rate EMA speed for its readers.
 * @param {object} w World
 * @param {number} i motor index
 * @param {boolean} ctrl control tick
 */
function driveMotor(w, i, ctrl) {
  const sgen = w.stepgens[i];
  const omegaCmd = w.cmdOmega[i];
  const velSign = omegaCmd > 1e-6 ? 1 : omegaCmd < -1e-6 ? -1 : 0;
  const pulses = sgen.update(w.cmdTheta[i], velSign);
  const ol = w.openloop[i];
  if (ol !== null) {
    ol.consumePulses(pulses);
    w._omegaCmdOL[i] = sgen.rate * w._stepAngle[i] * sgen.dir;
    ol.inOmegaCmd = omegaCmd;             // ol.step(motor, omegaCmd) without a boxed double argument
    ol.stepInputs(w.motors[i]);
    w._va[i] = ol.vAlpha;
    w._vb[i] = ol.vBeta;
    return;
  }
  const foc = w.foc[i];
  const mode = w._focMode[i];
  if (mode === FOC_POS) {
    if (pulses !== 0) foc.thetaStar += pulses * w._stepAngle[i];
  } else if (mode === FOC_VEL) {
    foc.omegaStar = w.cmdOmega[i];
  } else {
    foc.iqStarCmd = w._iqTarget;
  }
  if (ctrl) foc.stepEncoder(w.encoders[i], w.motors[i].iPhase, w.rng);
  w._va[i] = foc.uAlpha;
  w._vb[i] = foc.uBeta;
}

/**
 * Electrical step of motor i with the voltage from driveMotor.
 * @param {object} w World
 * @param {number} i motor index
 */
function stepMotor(w, i) {
  const mech = w.mechanics;
  const p = w._p[i];
  const motor = w.motors[i];
  // motor.step(va, vb, θe, ωe, dt) through fields: double arguments are boxed when a call is not inlined.
  motor.vAlpha = w._va[i];
  motor.vBeta = w._vb[i];
  motor.inThetaE = p * mech.theta[i];
  motor.inOmegaE = p * mech.omega[i];
  motor.stepDt = w._dt;
  motor.stepInputs();
  w._torques[i] = motor.torque;
}

/**
 * Encoder, load angle and StallGuard of motor i (after the mechanics step).
 * @param {object} w World
 * @param {number} i motor index
 */
function sense(w, i) {
  const mech = w.mechanics;
  w.encoders[i].update(mech.theta[i]);
  const motor = w.motors[i];
  const la = Math.atan2(motor.iq, motor.id);
  w._loadAngle[i] = la;
  const sgd = w.stallguards[i];
  // Minimum-speed gate on the planner's commanded speed (same rad/s as FOC velocity mode).
  if (sgd !== null) sgd.update(la, w.cmdOmega[i], mech.omega[i]);
}

/**
 * One sim step of the whole world (World.step). Does not allocate on the steady path.
 * @param {object} w World
 */
export function stepWorld(w) {
  const n = w.nMotors;
  const ctrl = w._tick === 0;
  if (++w._tick >= w.controlEvery) w._tick = 0;

  if (ctrl) {
    const pl = w.planner;
    pl.step(CONTROL_DT);
    // The FOC position-loop limit held after a maxVelocity drop (World._derive) drops too once
    // the planner has slowed down to the new limit, or once a jog command that took over (jogs
    // ignore maxVelocity) no longer slows down: from then on the jog's limit is the maxVelocity
    // one, as for any jog. A homing seek keeps the hold until it stops: a fast seek that had the
    // limit dropped under its speed would brake against the homing current and false-trigger.
    const hold = w._omegaHoldMmS;
    if (hold >= 0 && (pl.speed <= hold || (pl.mode === 'jog' && pl.phase !== 'decel' && w.homing.phase === 0))) {
      w._releaseOmegaHold();
    }
    updateCommand(w, CONTROL_DT);
    if (pl.justFinished) w._emit('pathDone', { path: pl.pathName, xMm: pl.x, yMm: pl.y });
  }
  for (let i = 0; i < n; i++) driveMotor(w, i, ctrl);
  for (let i = 0; i < n; i++) stepMotor(w, i);
  const mech = w.mechanics;
  mech.stepDt = w._dt;          // a field write, not a double argument (boxed when not inlined)
  mech.stepAtDt(w._torques);
  for (let i = 0; i < n; i++) sense(w, i);

  w._t += w._dt;
  fillSnapshot(w);
  if (w.homing.phase !== 0) w.homing.update(w._dt);
  if (w.sweep.phase !== 0) w.sweep.update(w._dt);
  w.metricsEngine.update(w);
  const sg0 = w.stepgens[0];
  w.stepEdges += sg0.level;
  const pn = sg0.pulsesThisStep;
  w.stepPulses += pn < 0 ? -pn : pn;
  if (++w._decimCount >= w._decimation) {
    w._decimCount = 0;
    pushTraces(w);
  }
}

/**
 * Snapshot fields of an open-loop motor. (fillOpenLoop and fillFoc recompute the rotor's
 * electrical angle, p·θ, rather than take it as an argument: a double argument is boxed
 * when the call is not inlined.)
 * @param {object} w World
 * @param {number} i motor index
 * @param {object} m snapshot.motors[i]
 * @returns {number} lost electrical cycles
 */
function fillOpenLoop(w, i, m) {
  const thE = w._p[i] * w.mechanics.theta[i];
  const ol = w.openloop[i];
  const motor = w.motors[i];
  const c = motor.cosE;
  const sn = motor.sinE;
  const thetaCmd = ol.thetaCmd;
  m.thetaCmd = thetaCmd;
  const isa = ol.iStar[0];
  const isb = ol.iStar[1];
  const st = m.iStar;
  if (st.length === 3) {
    st[0] = isa;
    st[1] = -0.5 * isa + SQRT3_2 * isb;
    st[2] = -0.5 * isa - SQRT3_2 * isb;
  } else {
    st[0] = isa;
    st[1] = isb;
  }
  m.idStar = isa * c + isb * sn;
  m.iqStar = -isa * sn + isb * c;
  const va = motor.vAlpha;
  const vb = motor.vBeta;
  m.ud = va * c + vb * sn;
  m.uq = -va * sn + vb * c;
  // Two-phase: each H-bridge imposes at most ±Vbus on its own phase, so the headroom is the
  // larger phase voltage against Vbus (the α/β vector magnitude would reach √2·Vbus).
  let um;
  if (st.length === 2) {
    const aa = va < 0 ? -va : va;
    const ab = vb < 0 ? -vb : vb;
    um = aa > ab ? aa : ab;
  } else {
    um = Math.sqrt(va * va + vb * vb);
  }
  m.uMag = um;
  m.uLimit = w._uLimitOL[i];
  const vf = w._vAmpLpf[i].process(um);
  m.vAmp = ol.modeActive === 'voltage' ? ol.vAmp : vf;
  m.pwmState[0] = ol.pwmState[0];
  m.pwmState[1] = ol.pwmState[1];
  const sgd = w.stallguards[i];
  m.sg = sgd.sg;
  const diag = sgd.diag;
  m.diag = diag;
  if (diag && w._prevDiag[i] === 0) {
    const g = w._gates;
    if (w._t - g.stallT[i] >= STALL_HOLDOFF_S) {
      g.stallT[i] = w._t;
      w._emit('stallDetected', { motor: i, sg: sgd.sg, xMm: w.mechanics.x });
    }
  }
  w._prevDiag[i] = diag ? 1 : 0;
  m.status = false;
  m.iLimit = w._iTarget[i];
  m.mode = ol.modeActive;
  const err = thetaCmd - thE;
  m.cmdAngleErr = wrapPi(err);
  return Math.round(err / TWO_PI);
}

/**
 * Snapshot fields of a FOC motor. A closed loop never loses steps: lost cycles are 0 (its
 * following error is posErr).
 * @param {object} w World
 * @param {number} i motor index
 * @param {object} m snapshot.motors[i]
 * @returns {number} lost electrical cycles (0)
 */
function fillFoc(w, i, m) {
  const thE = w._p[i] * w.mechanics.theta[i];
  const foc = w.foc[i];
  const motor = w.motors[i];
  const c = motor.cosE;
  const sn = motor.sinE;
  const posMode = w._focMode[i] === FOC_POS;
  const thetaCmd = posMode ? w._p[i] * foc.thetaStar : thE;
  m.thetaCmd = thetaCmd;
  const ids = foc.idStar;
  const iqs = foc.iqStar;
  m.idStar = ids;
  m.iqStar = iqs;
  const a = ids * c - iqs * sn;
  const b = ids * sn + iqs * c;
  const st = m.iStar;
  if (st.length === 3) {
    st[0] = a;
    st[1] = -0.5 * a + SQRT3_2 * b;
    st[2] = -0.5 * a - SQRT3_2 * b;
  } else {
    st[0] = a;
    st[1] = b;
  }
  m.ud = foc.ud;
  m.uq = foc.uq;
  m.uMag = foc.uMag;
  m.uLimit = foc.uLimit;
  m.vAmp = foc.uMag;
  const ff = foc.flags;
  const fl = m.flags;
  fl.iqTargetLimit = ff.iqTargetLimit;
  fl.xOutputLimit = ff.xOutputLimit;
  fl.uqOutputLimit = ff.uqOutputLimit;
  fl.udOutputLimit = ff.udOutputLimit;
  fl.vErrSumLimit = ff.vErrSumLimit;
  // Status output: the driver's status flags are latched (like the TMC4671's STATUS_FLAGS), so
  // the output stays high after a stall until the controller clears it. The sim clears the
  // latch once the live flags are gone AND the carriage has been off every hard stop for 50 ms:
  // a carriage left pressed against the stop (retract 0) keeps the output high, so the next
  // homing pass sees no rising edge (SPEC 5.8-13, 6.9). `flags` stay live.
  const status = foc.status;
  let latched = w._statusLatch[i] === 1;
  if (status) {
    latched = true;
    w._statusClear[i] = 0;
  } else if (latched) {
    const mech = w.mechanics;
    if (mech.atStopX || mech.atStopY) {
      w._statusClear[i] = 0;
    } else if (++w._statusClear[i] >= w._statusClearN) {
      latched = false;
      w._statusClear[i] = 0;
    }
  }
  w._statusLatch[i] = latched ? 1 : 0;
  m.status = latched;
  // flagSet on the rising edge of the latched output (once per latch, not per live-flag edge;
  // a limit cycle toggles the live flags thousands of times per second). w._prevStatus holds
  // the previous latched level. The flags reported are the live ones that set the latch.
  if (latched && w._prevStatus[i] === 0) {
    w._emit('flagSet', {
      motor: i, iqTargetLimit: ff.iqTargetLimit, xOutputLimit: ff.xOutputLimit, uqOutputLimit: ff.uqOutputLimit,
      udOutputLimit: ff.udOutputLimit, vErrSumLimit: ff.vErrSumLimit,
    });
  }
  w._prevStatus[i] = latched ? 1 : 0;
  m.iLimit = foc.iLimit;
  m.sg = null;
  m.diag = false;
  m.mode = foc.mode;
  m.cmdAngleErr = posMode ? wrapPi(thetaCmd - thE) : 0;
  // Loop targets for the block diagram (fillMotor set the open-loop meaning first).
  if (posMode) m.thetaStar = foc.thetaStar;
  m.omegaStar = foc.omegaStarOut;
  m.omegaFilt = foc.omegaFilt;
  return 0;
}

/**
 * Snapshot of motor i (common part), heat, noise and amplitude filters, lost cycles.
 * @param {object} w World
 * @param {number} i motor index
 */
function fillMotor(w, i) {
  const s = w.snapshot;
  const m = s.motors[i];
  const mech = w.mechanics;
  const motor = w.motors[i];
  const p = w._p[i];
  const th = mech.theta[i];
  const thE = p * th;
  m.thetaM = th;
  m.omegaM = mech.omega[i];
  m.thetaE = thE;
  const ip = motor.iPhase;
  const vp = motor.vPhase;
  const be = motor.bemf;
  const mi = m.iPhase;
  const mv = m.vPhase;
  const mb = m.bemf;
  const ph = mi.length;
  let isq = 0;
  for (let k = 0; k < ph; k++) {
    const x = ip[k];
    mi[k] = x;
    mv[k] = vp[k];
    mb[k] = be[k];
    isq += x * x;
  }
  const ia = motor.iAlpha;
  const ib = motor.iBeta;
  m.iAlpha = ia;
  m.iBeta = ib;
  m.id = motor.id;
  m.iq = motor.iq;
  m.torque = motor.torque;
  m.loadTorque = mech.tLoad[i];
  m.loadAngle = w._loadAngle[i];
  const iAmp = motor.iAmp;
  m.iAmp = iAmp;
  m.currentAngle = Math.atan2(ib, ia);
  const h0 = w._heat[i];
  const h = h0 + w._heatK * (isq * w._heatNorm[i] - h0);
  w._heat[i] = h;
  m.heat = h;
  const focI = w.foc[i];
  if (focI !== null) {
    // FOC: high-frequency content of the q-axis voltage command as an equivalent current.
    const uq = focI.uq;
    w.noise[i] = (uq - w._noiseLpf[i].process(uq)) * w._noiseScale[i];
  } else {
    // Open loop: high-passed regulation error e = iA − iA*, so the current fundamental cancels
    // at speed and the chopper ripple remains at standstill.
    const e = ip[0] - w.openloop[i].iStar[0];
    w.noise[i] = e - w._noiseLpf[i].process(e);
  }
  w.iAmpLpfOut[i] = w._iAmpLpf[i].process(iAmp);
  // Commanded angle and speed (fillFoc replaces them with the FOC loop targets).
  m.thetaStar = w.cmdTheta[i];
  m.omegaStar = w.cmdOmega[i];
  m.omegaFilt = mech.omega[i];

  const lost = w.openloop[i] !== null ? fillOpenLoop(w, i, m) : fillFoc(w, i, m);
  const mmPerCycle = w.rd / p;
  // stepLost at most once per STEP_LOST_HOLDOFF_S per motor. w._prevLost is the lost count at
  // the last event, so a change inside the holdoff accumulates into the next event's `mm`.
  const prevLost = w._prevLost[i];
  if (lost !== prevLost) {
    const g = w._gates;
    if (w._t - g.lostT[i] >= STEP_LOST_HOLDOFF_S) {
      g.lostT[i] = w._t;
      w._prevLost[i] = lost;
      w._emit('stepLost', { motor: i, lostCycles: lost, lostMm: lost * mmPerCycle, mm: (lost - prevLost) * mmPerCycle });
    }
  }
  m.lostCycles = lost;
  s.gantry.lostMm[i] = lost * mmPerCycle;

  const enc = w.encoders[i];
  const me = m.encoder;
  me.count = enc.count;
  me.a = enc.a;
  me.b = enc.b;
  me.thetaMeas = enc.thetaMeas;
  me.omegaEst = enc.omegaEst;
  const sgen = w.stepgens[i];
  const ms = m.stepgen;
  ms.level = sgen.level;
  ms.dir = sgen.dir;
  ms.rate = sgen.rate;
  ms.count = sgen.count;
}

/**
 * Copies the module state into `w.snapshot` and raises edge events (stepLost and stallDetected
 * rate-limited, flagSet once per status latch, contact). Does not allocate except when an
 * event fires.
 * @param {object} w World
 */
export function fillSnapshot(w) {
  const s = w.snapshot;
  s.t = w._t;
  const n = w.nMotors;
  for (let i = 0; i < n; i++) fillMotor(w, i);

  const s0 = w.stepgens[0];
  const st = s.step;
  st.level = s0.level;
  st.dir = s0.dir;
  st.rate = s0.rate;
  st.count = s0.count;

  const pl = w.planner;
  const sp = s.planner;
  sp.mode = pl.mode;
  sp.x = pl.x;
  sp.y = pl.y;
  sp.vx = pl.vx;
  sp.vy = pl.vy;
  sp.phase = pl.phase;
  sp.segmentIndex = pl.segmentIndex;
  sp.done = pl.done;

  const mech = w.mechanics;
  const ld = s.loads;
  ld.drag = mech.tDrag;
  ld.torque = mech.tLoadConst;
  ld.bump = mech.bumpActive ? mech.bumpA * Math.sin(Math.PI * mech.bumpT / mech.bumpDur) : 0;
  const g = s.gantry;
  g.x = mech.x;
  g.y = mech.y;
  g.xCmd = w.xCmd;
  g.yCmd = w.yCmd;
  const ax = mech.atStopX;
  const ay = mech.atStopY;
  g.atStopX = ax;
  g.atStopY = ay;
  if (ax && !w._prevStopX) w._emit('contact', { axis: 'x', xMm: mech.x, yMm: mech.y });
  if (ay && !w._prevStopY) w._emit('contact', { axis: 'y', xMm: mech.x, yMm: mech.y });
  w._prevStopX = ax;
  w._prevStopY = ay;
}
