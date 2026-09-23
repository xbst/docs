// Homing and speed-sweep state machines for World (chunk-02 design section 15).
//
// Both run inside World.step() after the snapshot is filled. update() does not allocate on the
// steady path; state transitions (start of a pass, trigger, next sweep voltage) may allocate a
// little (event objects, planner/driver reconfiguration), which only happens a few times per run.
//
// Homing does not rebase on a trigger (decided behavior; it replaces the rebase step of contract
// section 15): the commanded position stays where the trigger happened and the driver keeps
// pressing at the homing current. freeIqPeak is the peak free-motion load of motor 0 before
// contact: FOC max |iq*| (the velocity loop's demand, what the iqTargetLimit flag compares),
// open loop max |i|.

/** Carriage within this distance of the x stop (or penetrating) counts as contact (mm). */
const CONTACT_NEAR_MM = 0.5;
/** No-edge rule (status already high at the start): press-in beyond this ends the pass (mm). */
const NO_EDGE_PRESS_MM = 1;
/** No-edge rule: this long in contact ends the pass (s). */
const NO_EDGE_CONTACT_S = 0.25;
/** Without any trigger, a pass ends as 'no-edge' after this long in contact (s). */
const STALL_CONTACT_S = 0.5;
/** Default homing acceleration with FOC (mm/s²): keeps the acceleration current small. */
const HOMING_ACCEL_FOC = 250;
/** Sweep: rest time before each ramp so the current settles at its target (s). */
const SWEEP_SETTLE_S = 0.05;
/** Sweep: lost distance that counts as a slip (mm). */
const SWEEP_SLIP_MM = 0.8;

/**
 * @param {*} v
 * @param {number} dflt
 * @returns {number} v when it is a finite number, else dflt
 */
function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Deletes every own key of an object (keeps the object identity).
 * @param {object} o
 */
function clearKeys(o) {
  for (const k of Object.keys(o)) delete o[k];
}

/**
 * Sensorless homing toward the x = 0 stop (FOC: rising edge of `status`; open loop: rising edge
 * of StallGuard `diag`), with retract and repeated passes. `snap` is `world.snapshot.homing`.
 *
 * Sequence per pass: current limit = homing current (FOC), note the trigger level at the start,
 * jog at −speed in x with the homing acceleration (FOC default 250 mm/s², so the acceleration
 * current stays well below the homing limit; open loop default: the planner acceleration). On a
 * rising edge: stop the planner at once without rebasing (decided behavior, replacing the
 * `setPosition(mechanics.x)` / `thetaStar = thetaMeas` rebase of contract section 15): the
 * commanded position and the FOC target stay where the trigger happened, so there is no target
 * jump, and like a real driver the loop keeps pressing with the homing current (`status` stays
 * high while the carriage is against the stop). `freeIqPeak` = max over the free motion of
 * this pass (not near the stop) of |iq*| (FOC velocity-loop demand) or |i| (open loop).
 * Result 'ok' when the carriage is within 0.5 mm of the stop or penetrating, else
 * 'false-trigger', event `homingDone`. Then retract by `retractMm` at the homing speed (from
 * the commanded position, which is still where the trigger happened) and start the next pass
 * if any.
 * No edge: if the trigger was already high at the start and the carriage is in contact with
 * press-in > 1 mm or 0.25 s in contact, or if it has been in contact for 0.5 s without an
 * edge, stop, result 'no-edge', event `homingNoEdge`, end. End: FOC current limit back to the
 * run current, planner limits restored, `active = false`.
 */
export class HomingMachine {
  /**
   * @param {object} world the owning World
   */
  constructor(world) {
    /** @type {object} */ this.world = world;
    /** Snapshot view (`snapshot.homing`). */
    this.snap = { active: false, pass: 0, contact: false, pressInMm: 0, freeIqPeak: 0, result: null, triggeredAtMm: null };
    /** 0 idle, 1 seeking the stop, 2 retracting. */
    this.phase = 0;
    this.passes = 1;
    this.speedMmS = 40;
    this.retractMm = 5;
    this.current = 0.5;
    this.accel = 500;
    this.statusAtStart = false;
    this.prevTrig = false;
    this.contactTime = 0;
  }

  /**
   * Starts homing. Defaults come from the scenario's `foc.*` keys; `accelMmS2` defaults to
   * 250 mm/s² (FOC) or the planner acceleration (open loop).
   * @param {{ speedMmS?: number, retractMm?: number, passes?: number, current?: number, accelMmS2?: number }} args
   */
  start(args) {
    const w = this.world;
    const f = w._sc.foc;
    const a = args || {};
    this.speedMmS = Math.abs(num(a.speedMmS, f.homingSpeedMmS)) || 40;
    this.retractMm = Math.max(0, num(a.retractMm, f.retractMm));
    this.passes = Math.max(1, Math.round(num(a.passes, 1)));
    this.current = Math.max(0, num(a.current, f.homingCurrent));
    const dflt = w.foc[0] !== null ? HOMING_ACCEL_FOC : num(w._sc.planner.accel, 5000);
    this.accel = Math.abs(num(a.accelMmS2, dflt)) || dflt;
    this.snap.active = true;
    this.snap.pass = 0;
    w._setHoming(true, this.current);
    this._beginPass();
  }

  /** Starts one pass: reset the per-pass readouts and jog toward the stop. */
  _beginPass() {
    const w = this.world;
    const s = this.snap;
    s.pass++;
    s.contact = false;
    s.pressInMm = 0;
    s.freeIqPeak = 0;
    s.result = null;
    s.triggeredAtMm = null;
    const trig = w._homingTrigger();
    this.statusAtStart = trig;
    this.prevTrig = trig;
    this.contactTime = 0;
    w._setMaxVelocityOverride(0);
    w._setAccelOverride(this.accel);
    w.planner.jog(-this.speedMmS, 0);
    this.phase = 1;
  }

  /**
   * Advances the machine by one sim step (after the snapshot fill).
   * @param {number} dt sim step (s)
   */
  update(dt) {
    const w = this.world;
    const s = this.snap;
    if (this.phase === 1) {
      const mech = w.mechanics;
      s.contact = mech.atStopX;
      const near = mech.atStopX || mech.x <= CONTACT_NEAR_MM;
      if (mech.penX > s.pressInMm) s.pressInMm = mech.penX;
      if (near) this.contactTime += dt;
      else {
        const load = w._homingLoad();
        if (load > s.freeIqPeak) s.freeIqPeak = load;
      }
      const trig = w._homingTrigger();
      const rising = trig && !this.prevTrig;
      this.prevTrig = trig;
      if (rising) {
        w.planner.stop(true);
        s.result = near ? 'ok' : 'false-trigger';
        s.triggeredAtMm = mech.x;
        w._emit('homingDone', { pass: s.pass, result: s.result, xMm: mech.x, pressInMm: s.pressInMm, freeIqPeak: s.freeIqPeak });
        this._afterPass();
        return;
      }
      if (near && ((this.statusAtStart && (s.pressInMm > NO_EDGE_PRESS_MM || this.contactTime >= NO_EDGE_CONTACT_S))
          || this.contactTime >= STALL_CONTACT_S)) {
        w.planner.stop(true);
        s.result = 'no-edge';
        w._emit('homingNoEdge', { pass: s.pass, xMm: mech.x, pressInMm: s.pressInMm, statusAtStart: this.statusAtStart });
        this._finish();
      }
    } else if (this.phase === 2) {
      if (w.planner.mode === 'idle') {
        w._setMaxVelocityOverride(0);
        if (s.pass < this.passes) this._beginPass();
        else this._finish();
      }
    }
  }

  /** After a triggered pass: retract (if any), then the next pass or the end. */
  _afterPass() {
    const w = this.world;
    if (this.retractMm > 0) {
      w._setMaxVelocityOverride(this.speedMmS);
      w.planner.moveTo(w.planner.x + this.retractMm, w.planner.y);
      this.phase = 2;
    } else if (this.snap.pass < this.passes) {
      this._beginPass();
    } else {
      this._finish();
    }
  }

  /** Ends homing: restores the planner speed limit and the run current. */
  _finish() {
    const w = this.world;
    w._setMaxVelocityOverride(0);
    w._setAccelOverride(0);
    w._setHoming(false, 0);
    this.snap.active = false;
    this.phase = 0;
  }

  /** Cancels homing (keeps the last readouts). */
  abort() {
    if (this.phase === 0 && !this.snap.active) return;
    this._finish();
  }
}

/**
 * Speed sweep for the voltage chapter: for each voltage, set `supplyV`, reset the motor and
 * mechanics (rotor at the start, stops disabled), rest 50 ms, then jog to +maxMmS with
 * `accelMmS2`. `sagMmS` = commanded speed at the first step where LPF200(|i|) < sagFrac·I
 * (after it had reached sagFrac·I at rest); `slipMmS` = commanded speed when
 * |gantry.lostMm[0]| ≥ 0.8 mm, or maxMmS if the ramp reaches it without slipping.
 * Finally restores `supplyV`, the planner limits and the stops, resets, emits `sweepDone`.
 * `snap` is `world.snapshot.sweep` (`results` and `detail` keep their identity).
 */
export class SweepMachine {
  /**
   * @param {object} world the owning World
   */
  constructor(world) {
    /** @type {object} */ this.world = world;
    /** Snapshot view (`snapshot.sweep`). */
    this.snap = { running: false, results: {}, detail: {}, currentV: 0 };
    /** 0 idle, 1 settling at rest, 2 ramping. */
    this.phase = 0;
    /** @type {number[]} */ this.voltages = [];
    this.index = 0;
    this.maxMmS = 1500;
    this.accel = 2000;
    this.sagFrac = 0.7;
    this.origV = 24;
    this.settleT = 0;
    this.armed = false;
    /** @type {{slipMmS: number|null, sagMmS: number|null}|null} detail entry of the current voltage */
    this.det = null;
  }

  /**
   * Starts a sweep.
   * @param {{ voltages?: number[], maxMmS?: number, accelMmS2?: number, sagFrac?: number }} args
   */
  start(args) {
    const w = this.world;
    const a = args || {};
    const vs = Array.isArray(a.voltages) && a.voltages.length ? a.voltages : [24, 48];
    this.voltages = vs.filter((v) => typeof v === 'number' && v > 0);
    if (!this.voltages.length) this.voltages = [24, 48];
    this.maxMmS = Math.abs(num(a.maxMmS, 1500)) || 1500;
    this.accel = Math.abs(num(a.accelMmS2, 2000)) || 2000;
    this.sagFrac = num(a.sagFrac, 0.7);
    if (!this.snap.running) this.origV = w._sc.supplyV;
    clearKeys(this.snap.results);
    clearKeys(this.snap.detail);
    this.snap.running = true;
    this.index = 0;
    w._sweepNoStops = true;
    this._beginVoltage();
  }

  /** Prepares the run at voltages[index]. */
  _beginVoltage() {
    const w = this.world;
    const V = this.voltages[this.index];
    this.snap.currentV = V;
    this.det = { slipMmS: null, sagMmS: null };
    this.snap.detail[V] = this.det;
    w.set('supplyV', V);
    w._resetState(false);
    w._setMaxVelocityOverride(this.maxMmS);
    w._setAccelOverride(this.accel);
    this.settleT = 0;
    this.armed = false;
    this.phase = 1;
  }

  /**
   * Advances the sweep by one sim step (after the snapshot fill).
   * @param {number} dt sim step (s)
   */
  update(dt) {
    const w = this.world;
    const I = w._targetCurrent(0);
    const iAmpF = w.iAmpLpfOut[0];
    const lim = this.sagFrac * I;
    if (!this.armed && iAmpF >= lim) this.armed = true;
    if (this.phase === 1) {
      this.settleT += dt;
      if (this.settleT >= SWEEP_SETTLE_S) {
        w.planner.jog(this.maxMmS, 0);
        this.phase = 2;
      }
      return;
    }
    if (this.phase !== 2) return;
    const speed = w.planner.speed;
    const det = this.det;
    if (this.armed && det.sagMmS === null && iAmpF < lim) det.sagMmS = speed;
    const lost = w.snapshot.gantry.lostMm[0];
    if (lost >= SWEEP_SLIP_MM || lost <= -SWEEP_SLIP_MM) this._endVoltage(speed);
    else if (speed >= this.maxMmS) this._endVoltage(this.maxMmS);
  }

  /**
   * Records the result of the current voltage and moves on.
   * @param {number} slipMmS
   */
  _endVoltage(slipMmS) {
    const w = this.world;
    this.det.slipMmS = slipMmS;
    this.snap.results[this.voltages[this.index]] = slipMmS;
    w.planner.stop(true);
    this.index++;
    if (this.index < this.voltages.length) this._beginVoltage();
    else this._finish(true);
  }

  /**
   * Restores the scenario state and ends the sweep.
   * @param {boolean} emit emit `sweepDone`
   */
  _finish(emit) {
    const w = this.world;
    this.phase = 0;
    this.snap.running = false;
    this.snap.currentV = 0;
    this.det = null;
    w._sweepNoStops = false;
    w._setMaxVelocityOverride(0);
    w._setAccelOverride(0);
    w.set('supplyV', this.origV);
    w._resetState(false);
    w._fillSnapshot();
    if (emit) {
      const results = {};
      for (const k of Object.keys(this.snap.results)) results[k] = this.snap.results[k];
      w._emit('sweepDone', { results });
    }
  }

  /** Cancels a running sweep and restores the scenario state (no event). */
  abort() {
    if (!this.snap.running) return;
    this._finish(false);
  }
}
