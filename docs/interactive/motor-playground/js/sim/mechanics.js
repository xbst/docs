// Rotor and gantry mechanics (SPEC 5.3, chunk-02 design section 6).
//
// Per motor i, semi-implicit Euler (update ω, then θ):
//   Jt·dω/dt = Te − B·ω − (Tc + Tdrag)·tanh(ω/ω_eps) − Tload − Tbump(t) − Tcontact
//   Jt = Jrotor + Jload (free, axis)      Jt = Jrotor + Jload/2 (corexy, each belt carries half)
// The viscous and Coulomb-like friction terms are linearized around the current ω and solved
// implicitly (one Newton step of backward Euler): with a light rotor and heavy drag the tanh
// slope (Tc + Tdrag)/ω_eps would otherwise make explicit Euler chatter around ω = 0.
// Stick rule (chunk 02 addition to SPEC 5.3): when the speed would cross or sit at zero within
// a step and |net torque without friction| ≤ Tc + Tdrag, the rotor sticks at exactly ω = 0 and
// the friction balances the torque. This gives true static friction (breakaway at Tc + Tdrag)
// instead of a slow creep inside |ω| < ω_eps, and it removes the linearization chatter.
//
// Tbump(t) = A·sin(π·t/T)·s_i for 0 ≤ t < T on the motors in the mask. The per-motor scale s_i
// defaults to 1 (same sign on all: in CoreXY that is a shove along −x for A > 0); chunk 06 added
// the optional scales so a CoreXY shove can point in any direction (World.command('bump', {dir})).
//
// Kinematics (rd = rotation distance, mm per motor turn):
//   axis, free: x = θ0·rd/(2π), y = 0
//   corexy:     x = rd·(θA + θB)/(4π), y = rd·(θA − θB)/(4π)   (inverse: θA = 2π(x+y)/rd, θB = 2π(x−y)/rd)
// Hard stops (axis, corexy) at 0 and axisLength on each bounded axis: penalty contact with
// θ-space penetration θp = 2π·pen/rd and penetration rate ωp, restoring torque
// Tstop = kStop·θp + c·ωp, c = 2·sqrt(kStop·Jt) (critical damping), clamped at ≥ 0 (a stop
// pushes, never pulls). Axis: applied to motor 0. CoreXY: an x-stop applies the same Tstop to
// both motors, a y-stop +Tstop to A and −Tstop to B.
//
// Default kStop = 2 N·m/rad models a belt-driven carriage pushed into an endstop: the belt
// compresses (40 N/mm of belt stiffness at rd 40 mm is about 1.6 N·m/rad), so 0.66 N·m
// (3 A) sinks about 2 mm and 0.11 N·m (0.5 A) about 0.35 mm, visible in chapter 9. A rigid,
// direct-coupled stop is configure({ kStop: 500 }). Explicit contact is stable for
// dt·sqrt(kStop/Jt) < 0.2; at the default that is about 0.007 at dt 40 µs and Jt 5.8e-5
// (about 0.12 at kStop 500).

const TWO_PI = 2 * Math.PI;
const KIN_FREE = 0;
const KIN_AXIS = 1;
const KIN_COREXY = 2;

/**
 * Rotor dynamics for up to `maxMotors` motors plus the axis/CoreXY gantry kinematics and
 * hard stops.
 *
 * Fields after {@link Mechanics#step}: `nMotors`, `theta`, `omega` (rad, rad/s, per motor),
 * `Jt` (kg·m²), `tLoad` (N·m, everything except Te and B·ω, with the sign of the equation:
 * positive opposes +θ), `tContact` (N·m, same sign convention), `x, y` (mm, toolhead from the
 * rotor angles), `vx, vy` (mm/s), `atStopX, atStopY` (penetrating a stop), `penX, penY`
 * (mm, ≥ 0), `bumpActive`, `bumpT` (s into the pulse).
 */
export class Mechanics {
  /**
   * @param {number} [maxMotors=2] capacity of the per-motor arrays
   */
  constructor(maxMotors = 2) {
    const n = Math.max(1, maxMotors | 0);
    /** @type {number} */ this.maxMotors = n;
    /** @type {string} 'free' | 'axis' | 'corexy' */ this.mode = 'axis';
    /** @type {number} internal kinematics id */ this.kin = KIN_AXIS;
    /** @type {number} */ this.nMotors = 1;
    /** @type {Float64Array} [rad] */ this.theta = new Float64Array(n);
    /** @type {Float64Array} [rad/s] */ this.omega = new Float64Array(n);
    /** @type {Float64Array} [kg·m²] */ this.Jt = new Float64Array(n);
    /** @type {Float64Array} [kg·m²] */ this.Jrotor = new Float64Array(n);
    /** @type {Float64Array} [N·m] */ this.tLoad = new Float64Array(n);
    /** @type {Float64Array} [N·m] */ this.tContact = new Float64Array(n);
    /** @type {number} [kg·m²] */ this.Jload = 5e-5;
    /** @type {number} viscous friction [N·m·s/rad] */ this.B = 1e-5;
    /** @type {number} Coulomb friction [N·m] */ this.Tc = 0.02;
    /** @type {number} tanh smoothing speed [rad/s] */ this.omegaEps = 0.5;
    /** @type {number} rotation distance [mm/turn] */ this.rd = 40;
    /** @type {number} [mm] */ this.axisLength = 350;
    /** @type {boolean} */ this.hardStops = true;
    /** @type {number} contact stiffness [N·m/rad] */ this.kStop = 2;
    /** @type {number} default bump amplitude [N·m] */ this.bumpTorque = 0.6;
    /** @type {number} default bump duration [s] */ this.bumpDuration = 0.04;
    /** @type {number} friction-like drag [N·m] */ this.tDrag = 0;
    /** @type {number} constant load torque, opposes +θ [N·m] */ this.tLoadConst = 0;
    /** @type {boolean} */ this.bumpActive = false;
    /** @type {number} [s] */ this.bumpT = 0;
    /** @type {number} current pulse amplitude [N·m] */ this.bumpA = 0;
    /** @type {number} current pulse duration [s] */ this.bumpDur = 0.04;
    /** @type {number} bit i = motor i */ this.bumpMask = 0;
    /** @type {Float64Array} per-motor factor on the pulse (1 = the plain same-sign bump) */
    this.bumpScale = new Float64Array(n).fill(1);
    /** @type {number} step length for stepAtDt [s] (step(torques, dt) sets it too) */ this.stepDt = 4e-5;
    /** @type {number} [mm] */ this.x = 0;
    /** @type {number} [mm] */ this.y = 0;
    /** @type {number} [mm/s] */ this.vx = 0;
    /** @type {number} [mm/s] */ this.vy = 0;
    /** @type {boolean} */ this.atStopX = false;
    /** @type {boolean} */ this.atStopY = false;
    /** @type {number} [mm] */ this.penX = 0;
    /** @type {number} [mm] */ this.penY = 0;
    /** @type {number} angleToXY output [mm] */ this.tmpX = 0;
    /** @type {number} angleToXY output [mm] */ this.tmpY = 0;
  }

  /**
   * Sets the mechanical parameters. Keeps rotor angles and speeds (the arrays are
   * reallocated, zeroed, only when `nMotors` exceeds the capacity). CoreXY always uses two
   * motors; axis and free default to one.
   * @param {object} opts
   * @param {'free'|'axis'|'corexy'} [opts.mode='axis']
   * @param {number} [opts.nMotors] 1 or 2 (corexy forces 2)
   * @param {number[]|number} [opts.Jrotor=8.2e-6] rotor inertia per motor [kg·m²] (a number applies to all)
   * @param {number} [opts.Jload=5e-5] reflected load inertia [kg·m²] (split in half per motor in corexy)
   * @param {number} [opts.B=1e-5] viscous friction [N·m·s/rad]
   * @param {number} [opts.Tc=0.02] Coulomb friction [N·m]
   * @param {number} [opts.omegaEps=0.5] tanh smoothing speed [rad/s]
   * @param {number} [opts.rd=40] rotation distance [mm/turn]
   * @param {number} [opts.axisLength=350] travel of each bounded axis [mm]
   * @param {boolean} [opts.hardStops=true]
   * @param {number} [opts.kStop=2] contact stiffness [N·m/rad] (belt-compliant; 500 ≈ rigid)
   * @param {number} [opts.bumpTorque=0.6] default bump amplitude [N·m]
   * @param {number} [opts.bumpDuration=0.04] default bump duration [s]
   */
  configure({
    mode = 'axis', nMotors, Jrotor = 8.2e-6, Jload = 5e-5, B = 1e-5, Tc = 0.02, omegaEps = 0.5,
    rd = 40, axisLength = 350, hardStops = true, kStop = 2, bumpTorque = 0.6, bumpDuration = 0.04,
  } = {}) {
    this.mode = mode === 'corexy' ? 'corexy' : mode === 'free' ? 'free' : 'axis';
    this.kin = this.mode === 'corexy' ? KIN_COREXY : this.mode === 'free' ? KIN_FREE : KIN_AXIS;
    let n = this.kin === KIN_COREXY ? 2 : (nMotors === undefined ? 1 : Math.max(1, nMotors | 0));
    if (n > this.maxMotors) {
      this.maxMotors = n;
      this.theta = new Float64Array(n); this.omega = new Float64Array(n);
      this.Jt = new Float64Array(n); this.Jrotor = new Float64Array(n);
      this.tLoad = new Float64Array(n); this.tContact = new Float64Array(n);
      this.bumpScale = new Float64Array(n).fill(1);
    }
    this.nMotors = n;
    for (let i = 0; i < this.maxMotors; i++) {
      let jr;
      if (Array.isArray(Jrotor) || ArrayBuffer.isView(Jrotor)) {
        jr = Jrotor.length ? Jrotor[Math.min(i, Jrotor.length - 1)] : 8.2e-6;
      } else {
        jr = Jrotor;
      }
      this.Jrotor[i] = +jr;
    }
    this.Jload = +Jload;
    this.B = +B; this.Tc = +Tc; this.omegaEps = omegaEps > 0 ? +omegaEps : 0.5;
    this.rd = +rd; this.axisLength = +axisLength; this.hardStops = !!hardStops; this.kStop = +kStop;
    this.bumpTorque = +bumpTorque; this.bumpDuration = +bumpDuration;
    const jl = this.kin === KIN_COREXY ? 0.5 * this.Jload : this.Jload;
    for (let i = 0; i < this.maxMotors; i++) this.Jt[i] = this.Jrotor[i] + jl;
    this._kinematics();
  }

  /**
   * Places the rotors so the toolhead sits at (x, y) and zeroes speeds, loads applied this
   * step and any bump in progress. In axis and free mode every motor gets θ0 = 2πx/rd (a
   * compare motor starts on the same command).
   * @param {number} [xMm=0]
   * @param {number} [yMm=0]
   */
  reset(xMm = 0, yMm = 0) {
    const th = this.theta, om = this.omega;
    if (this.kin === KIN_COREXY) {
      th[0] = TWO_PI * (xMm + yMm) / this.rd;
      th[1] = TWO_PI * (xMm - yMm) / this.rd;
    } else {
      const t0 = TWO_PI * xMm / this.rd;
      for (let i = 0; i < th.length; i++) th[i] = t0;
    }
    om.fill(0); this.tLoad.fill(0); this.tContact.fill(0);
    this.bumpActive = false; this.bumpT = 0; this.bumpA = 0; this.bumpMask = 0; this.bumpScale.fill(1);
    this._kinematics();
  }

  /**
   * Sets the external loads: a friction-like drag that opposes motion (added to Tc inside the
   * tanh) and a constant torque that opposes +θ. Applied to every motor.
   * @param {number} dragNm [N·m], ≥ 0
   * @param {number} torqueNm [N·m]
   */
  setLoads(dragNm, torqueNm) {
    this.tDrag = Math.abs(+dragNm || 0);
    this.tLoadConst = +torqueNm || 0;
  }

  /**
   * Starts a half-sine torque pulse `A·sin(π·t/T)` subtracted from the motors in the mask
   * (positive A pushes toward −θ; in CoreXY with both motors it is an x-directed shove).
   * Restarts a pulse already in progress.
   * @param {number} [torqueNm=this.bumpTorque] amplitude A [N·m]
   * @param {number} [durationS=this.bumpDuration] duration T [s]
   * @param {number} [motorMask] bit i = motor i; default all motors
   * @param {ArrayLike<number>} [scales] per-motor factor on the pulse (default 1 each); CoreXY
   *   scales (−(ux + uy), −(ux − uy)) shove the toolhead along the unit vector u
   */
  bump(torqueNm = this.bumpTorque, durationS = this.bumpDuration, motorMask, scales) {
    const all = (1 << this.nMotors) - 1;
    this.bumpA = +torqueNm;
    this.bumpDur = durationS > 0 ? +durationS : this.bumpDuration;
    this.bumpMask = typeof motorMask === 'number' ? (motorMask & all) : all;
    const sc = this.bumpScale;
    for (let i = 0; i < sc.length; i++) {
      const s = scales && i < scales.length ? +scales[i] : 1;
      sc[i] = Number.isFinite(s) ? s : 1;
    }
    this.bumpT = 0;
    this.bumpActive = this.bumpDur > 0 && this.bumpMask !== 0;
  }

  /**
   * Advances every motor by one step. Does not allocate.
   * @param {Float64Array|number[]} torqueIn electromagnetic torque per motor [N·m]
   * @param {number} dt step [s]
   */
  step(torqueIn, dt) {
    this.stepDt = dt;
    this.stepAtDt(torqueIn);
  }

  /**
   * step() with the step length already in `stepDt` (the world writes it before each call): the
   * world's per-step path, without a double argument, which is boxed when a call is not inlined.
   * @param {Float64Array|number[]} torqueIn electromagnetic torque per motor [N·m]
   */
  stepAtDt(torqueIn) {
    const dt = this.stepDt;
    const n = this.nMotors;
    const th = this.theta, om = this.omega, Jt = this.Jt, tLoad = this.tLoad, tC = this.tContact;
    for (let i = 0; i < n; i++) tC[i] = 0;

    // Contact torques from the state at the start of the step (kinematics are current).
    if (this.hardStops && this.kin !== KIN_FREE) {
      const k = this.kStop, s = TWO_PI / this.rd, len = this.axisLength;
      if (this.kin === KIN_AXIS) {
        const c = 2 * Math.sqrt(k * Jt[0]);
        tC[0] = -stopForce(this.x, this.vx, len, k, c, s);
      } else {
        const c = 2 * Math.sqrt(k * 0.5 * (Jt[0] + Jt[1]));
        const sx = stopForce(this.x, this.vx, len, k, c, s);
        const sy = stopForce(this.y, this.vy, len, k, c, s);
        tC[0] = -sx - sy;
        tC[1] = -sx + sy;
      }
    }

    // Bump pulse, sampled at the start of the step.
    let tb = 0;
    const mask = this.bumpMask;
    if (this.bumpActive) {
      tb = this.bumpA * Math.sin(Math.PI * this.bumpT / this.bumpDur);
      this.bumpT += dt;
      if (this.bumpT >= this.bumpDur) this.bumpActive = false;
    }

    const B = this.B, fc = this.Tc + this.tDrag, tcStick = this.Tc, eps = this.omegaEps, tl = this.tLoadConst;
    const bs = this.bumpScale;
    for (let i = 0; i < n; i++) {
      const w = om[i];
      const tn = Math.tanh(w / eps);
      const f = fc * tn;
      const fp = fc * (1 - tn * tn) / eps;
      const tbi = (mask >> i) & 1 ? tb * bs[i] : 0;
      const a0 = torqueIn[i] - B * w - tl - tbi - tC[i];   // everything but the Coulomb friction
      const a = a0 - f;
      const dw = dt * a / (Jt[i] + dt * (B + fp));
      let wn = w + dw;
      let fApplied = f + fp * dw;
      // Stick rule: if the speed would cross (or sit at) zero within this step and the net
      // torque cannot overcome the rotor's own Coulomb level Tc, the rotor sticks at exactly
      // zero and the friction balances the torque. Without it the one-step linearization of
      // the tanh chatters around zero for stiff knees, and a resting rotor creeps under
      // torques below Tc (the friction is viscous-like inside |w| < eps), which let the
      // closed-loop velocity estimate kick it across encoder edges at ~130 Hz. Only Tc sticks:
      // the drag slider stands for carriage friction that reaches the rotor through a
      // compliant belt, so it stays the smooth tanh term (a hard stick at Tc + Tdrag made slow
      // closed-loop moves jerk in stick-slip cycles).
      if ((w >= 0 && wn <= 0) || (w <= 0 && wn >= 0)) {
        if (Math.abs(a0) <= tcStick) { wn = 0; fApplied = a0; }
      }
      tLoad[i] = fApplied + tl + tbi + tC[i];
      om[i] = wn;
      th[i] += wn * dt;
    }
    this._kinematics();
  }

  /**
   * Toolhead position for two rotor angles per the kinematics; fills `tmpX`, `tmpY` (mm).
   * Axis and free use `thetaA` only (y = 0). Does not allocate.
   * @param {number} thetaA motor 0 angle [rad]
   * @param {number} [thetaB=0] motor 1 angle [rad] (corexy)
   */
  angleToXY(thetaA, thetaB = 0) {
    const k = this.rd / TWO_PI;
    if (this.kin === KIN_COREXY) {
      this.tmpX = 0.5 * k * (thetaA + thetaB);
      this.tmpY = 0.5 * k * (thetaA - thetaB);
    } else {
      this.tmpX = k * thetaA;
      this.tmpY = 0;
    }
  }

  /**
   * Rotor angles for a toolhead position: corexy θA = 2π(x+y)/rd, θB = 2π(x−y)/rd; axis and
   * free θ0 = θ1 = 2πx/rd. Does not allocate.
   * @param {number} xMm
   * @param {number} yMm
   * @param {Float64Array|number[]} out receives out[0], out[1] [rad]
   * @returns {Float64Array|number[]} out
   */
  xyToAngles(xMm, yMm, out) {
    const k = TWO_PI / this.rd;
    if (this.kin === KIN_COREXY) {
      out[0] = k * (xMm + yMm);
      out[1] = k * (xMm - yMm);
    } else {
      out[0] = k * xMm;
      out[1] = out[0];
    }
    return out;
  }

  /** Refreshes x, y, vx, vy, penetrations and stop flags from the rotor state. */
  _kinematics() {
    const k = this.rd / TWO_PI;
    const th = this.theta, om = this.omega;
    if (this.kin === KIN_COREXY) {
      this.x = 0.5 * k * (th[0] + th[1]);
      this.y = 0.5 * k * (th[0] - th[1]);
      this.vx = 0.5 * k * (om[0] + om[1]);
      this.vy = 0.5 * k * (om[0] - om[1]);
    } else {
      this.x = k * th[0];
      this.y = 0;
      this.vx = k * om[0];
      this.vy = 0;
    }
    if (this.hardStops && this.kin !== KIN_FREE) {
      const len = this.axisLength;
      this.penX = this.x < 0 ? -this.x : this.x > len ? this.x - len : 0;
      this.penY = this.kin === KIN_COREXY ? (this.y < 0 ? -this.y : this.y > len ? this.y - len : 0) : 0;
    } else {
      this.penX = 0;
      this.penY = 0;
    }
    this.atStopX = this.penX > 0;
    this.atStopY = this.penY > 0;
  }
}

/**
 * Signed restoring torque of the stops on one axis, positive toward +position.
 * @param {number} pos [mm]
 * @param {number} vel [mm/s]
 * @param {number} len axis length [mm]
 * @param {number} k stiffness [N·m/rad]
 * @param {number} c damping [N·m·s/rad]
 * @param {number} s 2π/rd [rad/mm]
 */
function stopForce(pos, vel, len, k, c, s) {
  if (pos < 0) {
    const r = k * (-pos * s) + c * (-vel * s);
    return r > 0 ? r : 0;
  }
  if (pos > len) {
    const r = k * ((pos - len) * s) + c * (vel * s);
    return r > 0 ? -r : 0;
  }
  return 0;
}
