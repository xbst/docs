// Switching-fidelity power stage models for one phase of an H-bridge driver.
//
// Chopper:    fixed-frequency current chopper, SpreadCycle-like (on, fast decay, slow decay),
//             with the trip level raised by the measured peak-to-mean ripple (hystA/2 until the
//             first tripped cycle measures it) so the mean current lands on the target at any
//             ripple (hysteresis decrement) instead of sitting below or above it. A current
//             that climbs back over the trip level during slow decay (back-EMF against a falling
//             target) starts another fast decay within the same cycle.
// BipolarPwm: center-aligned bipolar voltage PWM, StealthChop-like.
//
// Both are stepped once per simulation sub-step (dt = 0.5 us in switching fidelity) and
// return the phase voltage for that sub-step. Units: V, A, s, Hz. No allocation in step().

/** Chopper sub-cycle phases (internal). */
const PH_ON = 0;
const PH_FAST = 1;
const PH_SLOW = 2;

/**
 * Fixed-frequency hysteresis current chopper for one phase (SpreadCycle-like).
 *
 * Every cycle starts "on" (`v = sgn·Vbus`, `sgn = sign(iStar)` with 0 treated as +1) until
 * `sgn·iMeas ≥ sgn·iStar + offLast` (`+ hystA/2` while offLast is not measured yet); then fast
 * decay (`v = −sgn·Vbus`) for `fastFrac/freqHz`; then slow decay (`v = 0`) until the cycle
 * ends. If the trip never happens the on-state lasts the whole cycle. A fast decay that would
 * outlast the cycle is cut short by the next cycle. While in slow decay, if `sgn·iMeas` rises
 * back to the trip level (the back-EMF pushes the current up at 0 V while the target falls),
 * another fast decay of `fastFrac/freqHz` starts, as often as needed until the cycle ends. At
 * standstill the current only falls during slow decay, so the sequence stays on, fast, slow.
 *
 * Trip timing: a sub-step takes one level, so the switch lands on a sub-step boundary. The trip
 * test adds half of the last sub-step's rise (`sgn·iMeas` minus the previous sample's, when
 * positive) to the sample, so the fast decay starts at the boundary nearest to the crossing, not
 * the one after it. Testing the bare sample switched half a sub-step late on average and put the
 * mean half a sub-step of ramp, ½·dt·(V − R·I)/L, above the target: 15 mA on the 0.8 mH motor at
 * 48 V, 3% of a 0.35 A RMS run current (B-016). Now it is under 0.5 mA in those cases.
 *
 * Mean centering: over each cycle the max, min and mean of `sgn·iMeas` are tracked; at the end
 * of a cycle in which the trip happened, `ppLast` (EMA over about 4 cycles of `max − min`) and
 * `offLast` (same EMA of `max − mean`) are updated. Putting the trip `offLast` above the target
 * puts the cycle mean on the target while the ripple stays what the physics gives (fast plus
 * slow decay), also when that ripple is smaller than `hystA` (low current, high L, high
 * frequency). `offLast` rather than `ppLast/2` is used because the waveform is not symmetric:
 * the steep fast decay sits right after the peak, so the mean lies below the p-p midpoint
 * (by 1.6% at 48 V / 1.5 mH / 20 kHz / 3.54 A). Cycles without a trip (current still ramping)
 * do not update the estimates; both are cleared on reset() and when the target changes sign.
 *
 * Fields: `state` is the applied voltage polarity for this sub-step (`v/Vbus`: +1, 0 or −1;
 * with a positive target that is +1 on, −1 fast decay, 0 slow decay), `tCycle` the time into
 * the current cycle (s), `v` the last output voltage (V), `ppLast` the p-p ripple estimate (A),
 * `offLast` the trip offset above the target (A).
 */
export class Chopper {
  constructor() {
    /** Chopper frequency (Hz). */
    this.freqHz = 40000;
    /** Initial trip band (A): the on-phase ends at target + hystA/2 until offLast is measured. */
    this.hystA = 0.04;
    /** Fast-decay duration as a fraction of the cycle. */
    this.fastFrac = 0.12;
    /** Bus voltage (V). */
    this.Vbus = 24;
    /** Sub-step (s). */
    this.dt = 0.5e-6;
    /** Cycle period (s), 1/freqHz. */
    this.period = 1 / 40000;
    /** Fast-decay duration (s), fastFrac/freqHz. */
    this.tFast = 0.12 / 40000;
    /** Applied polarity this sub-step: +1, 0 or −1 (= v/Vbus). */
    this.state = 0;
    /** Time into the current cycle (s). */
    this.tCycle = 0;
    /** Output voltage of the last sub-step (V). */
    this.v = 0;
    /** Internal sub-cycle phase (PH_ON, PH_FAST, PH_SLOW). */
    this.phase = PH_ON;
    /** Polarity of the target latched at cycle start (+1 or −1). */
    this.sgn = 1;
    /** Remaining fast-decay time (s). */
    this.fastLeft = 0;
    /** True until the first sub-step after reset (forces a cycle start). */
    this.fresh = true;
    /** Ripple estimate (A): EMA of the per-cycle max − min of sgn·iMeas; 0 = none yet. */
    this.ppLast = 0;
    /** Max of sgn·iMeas in the current cycle (A). */
    this.iMax = 0;
    /** Min of sgn·iMeas in the current cycle (A). */
    this.iMin = 0;
    /**
     * Peak-to-mean ripple estimate (A): EMA of the per-cycle max − mean of sgn·iMeas, the trip
     * offset above the target; 0 = none yet (the trip then uses hystA/2).
     */
    this.offLast = 0;
    /** Sum of sgn·iMeas samples in the current cycle (A). */
    this.iSum = 0;
    /** Number of samples in iSum. */
    this.nSum = 0;
    /** True once the on-phase tripped in the current cycle. */
    this.tripped = false;
    /** sgn·iMeas of the previous sub-step (A): its change is the ramp per sub-step. */
    this.yPrev = 0;
    /** Inputs of stepInputs(): phase current target and measured current (A). */
    this.inStar = 0;
    this.inMeas = 0;
  }

  /**
   * Set the chopper parameters. Keeps the switching state.
   * @param {{freqHz?: number, hystA?: number, fastFrac?: number, Vbus?: number, dt: number}} cfg
   */
  configure({ freqHz = 40000, hystA = 0.04, fastFrac = 0.12, Vbus = 24, dt = 0.5e-6 } = {}) {
    this.freqHz = freqHz > 0 ? freqHz : 40000;
    this.hystA = hystA;
    this.fastFrac = fastFrac < 0 ? 0 : (fastFrac > 1 ? 1 : fastFrac);
    this.Vbus = Vbus;
    this.dt = dt;
    this.period = 1 / this.freqHz;
    this.tFast = this.fastFrac * this.period;
  }

  /** Restart at the beginning of a cycle with zero output. */
  reset() {
    this.state = 0;
    this.tCycle = 0;
    this.v = 0;
    this.phase = PH_ON;
    this.sgn = 1;
    this.fastLeft = 0;
    this.fresh = true;
    this.ppLast = 0;
    this.iMax = 0;
    this.iMin = 0;
    this.offLast = 0;
    this.iSum = 0;
    this.nSum = 0;
    this.tripped = false;
    this.yPrev = 0;
  }

  /**
   * Advance one sub-step.
   * @param {number} iStar phase current target (A)
   * @param {number} iMeas measured phase current (A), i.e. the current at the start of this sub-step
   * @returns {number} phase voltage for this sub-step: +Vbus, 0 or −Vbus
   */
  step(iStar, iMeas) {
    this.inStar = iStar;
    this.inMeas = iMeas;
    this.stepInputs();
    return this.v;
  }

  /**
   * step() on inputs already in `inStar` and `inMeas`; the voltage is left in `v`. The driver's
   * per-sub-step path: double arguments are boxed when a call is not inlined.
   */
  stepInputs() {
    const iStar = this.inStar, iMeas = this.inMeas;
    const dt = this.dt;
    // Cycle boundary (half a sub-step tolerance so float drift never skips a boundary).
    if (this.fresh || this.tCycle + 0.5 * dt >= this.period) {
      const newSgn = iStar < 0 ? -1 : 1;
      if (this.fresh) {
        this.tCycle = 0;
        this.fresh = false;
      } else {
        this.tCycle -= this.period;
        // Close the finished cycle: its last current sample is this sub-step's iMeas.
        const y = this.sgn * iMeas;
        if (y > this.iMax) this.iMax = y;
        if (y < this.iMin) this.iMin = y;
        if (newSgn !== this.sgn) { this.ppLast = 0; this.offLast = 0; }
        else if (this.tripped && this.nSum > 0) {
          const pp = this.iMax - this.iMin;
          const off = this.iMax - this.iSum / this.nSum;
          const first = this.ppLast <= 0;
          this.ppLast = first ? pp : this.ppLast + 0.25 * (pp - this.ppLast);
          this.offLast = first ? off : this.offLast + 0.25 * (off - this.offLast);
        }
      }
      if (this.tCycle < 0) this.tCycle = 0;
      this.phase = PH_ON;
      this.sgn = newSgn;
      this.iMax = newSgn * iMeas;
      this.iMin = this.iMax;
      this.yPrev = this.iMax;     // no ramp across a cycle start (the polarity may have changed)
      this.iSum = 0;
      this.nSum = 0;
      this.tripped = false;
    }
    const sgn = this.sgn;
    const y = sgn * iMeas;
    if (y > this.iMax) this.iMax = y;
    if (y < this.iMin) this.iMin = y;
    this.iSum += y;
    this.nSum++;
    // Trip offset: the measured peak-to-mean ripple, also when it is below hystA/2 (a floor there
    // would lift the whole sawtooth above the target); hystA/2 until it has been measured.
    const off = this.offLast > 0 ? this.offLast : 0.5 * this.hystA;
    // Trip from the on-state, or re-enter fast decay from slow decay when the current climbs
    // back over the trip level, at the sub-step boundary nearest to the crossing: a rising
    // current that will cross within the first half of this sub-step trips now (B-016).
    const rise = y - this.yPrev;
    this.yPrev = y;
    if ((this.phase === PH_ON || this.phase === PH_SLOW) && y + (rise > 0 ? 0.5 * rise : 0) >= sgn * iStar + off) {
      this.phase = PH_FAST;
      this.fastLeft = this.tFast;
      this.tripped = true;
    }
    if (this.phase === PH_FAST && this.fastLeft < 0.5 * dt) this.phase = PH_SLOW;

    let s;
    if (this.phase === PH_ON) s = sgn;
    else if (this.phase === PH_FAST) { s = -sgn; this.fastLeft -= dt; }
    else s = 0;
    this.state = s;
    this.v = s * this.Vbus;
    this.tCycle += dt;
  }
}

/**
 * Length of the overlap of the intervals [a0, a1] and [b0, b1] (0 when disjoint).
 * @param {number} a0 @param {number} a1 @param {number} b0 @param {number} b1
 * @returns {number}
 */
function overlap(a0, a1, b0, b1) {
  const lo = a0 > b0 ? a0 : b0;
  const hi = a1 < b1 ? a1 : b1;
  return hi > lo ? hi - lo : 0;
}

/**
 * Center-aligned bipolar PWM for one phase (voltage-mode switching, StealthChop-like).
 *
 * The output is +Vbus during a window of length `duty·period` centered in each cycle and
 * −Vbus otherwise, with `duty = (1 + vCmd/Vbus)/2` clamped to [0, 1]. Because a sub-step can
 * only take one level, the exact on-time inside each sub-step is computed and the rounding
 * residue is carried to the next sub-step (error diffusion), so edges land within one sub-step
 * of the ideal ones and the mean voltage over whole cycles equals vCmd.
 *
 * Fields: `state` (+1 or −1), `tCycle` (s into the cycle), `v` (V), `duty`.
 */
export class BipolarPwm {
  constructor() {
    /** PWM frequency (Hz). */
    this.freqHz = 40000;
    /** Bus voltage (V). */
    this.Vbus = 24;
    /** Sub-step (s). */
    this.dt = 0.5e-6;
    /** Cycle period (s). */
    this.period = 1 / 40000;
    /** Output polarity this sub-step (+1 or −1). */
    this.state = -1;
    /** Time into the current cycle (s). */
    this.tCycle = 0;
    /** Output voltage of the last sub-step (V). */
    this.v = 0;
    /** Duty of the last sub-step (fraction of the cycle at +Vbus). */
    this.duty = 0.5;
    /** Carried rounding residue (fraction of a sub-step). */
    this.acc = 0;
  }

  /**
   * Set the PWM parameters. Keeps the switching state.
   * @param {{freqHz?: number, Vbus?: number, dt: number}} cfg
   */
  configure({ freqHz = 40000, Vbus = 24, dt = 0.5e-6 } = {}) {
    this.freqHz = freqHz > 0 ? freqHz : 40000;
    this.Vbus = Vbus;
    this.dt = dt;
    this.period = 1 / this.freqHz;
  }

  /** Restart at the beginning of a cycle. */
  reset() {
    this.state = -1;
    this.tCycle = 0;
    this.v = 0;
    this.duty = 0.5;
    this.acc = 0;
  }

  /**
   * Advance one sub-step.
   * @param {number} vCmd commanded mean phase voltage (V)
   * @returns {number} +Vbus or −Vbus
   */
  step(vCmd) {
    const dt = this.dt;
    const P = this.period;
    let d = this.Vbus > 0 ? 0.5 * (1 + vCmd / this.Vbus) : 0.5;
    d = d < 0 ? 0 : (d > 1 ? 1 : d);
    this.duty = d;
    const t0 = this.tCycle;
    const t1 = t0 + dt;
    const w0 = 0.5 * P * (1 - d);
    const w1 = 0.5 * P * (1 + d);
    // On-time inside this sub-step: this cycle's window plus the next cycle's (when the sub-step
    // straddles the cycle boundary).
    const on = overlap(t0, t1, w0, w1) + overlap(t0, t1, w0 + P, w1 + P);
    const want = on / dt + this.acc;
    const s = want >= 0.5 - 1e-9 ? 1 : -1; // tolerance: float residue must not split a tie
    this.acc = want - (s > 0 ? 1 : 0);
    this.state = s;
    this.v = s * this.Vbus;
    let t = t1;
    if (t >= P) t -= P;
    this.tCycle = t;
    return this.v;
  }
}
