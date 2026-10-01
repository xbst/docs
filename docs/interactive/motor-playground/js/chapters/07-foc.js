/**
 * Chapter 7: Field-oriented control (SPEC 6.7).
 *
 * One FOC motor on a free shaft (no gantry), stepper or BLDC, in velocity mode: the speed
 * slider is the velocity loop's setpoint (a planner jog, ramped). "Hold position" switches
 * the driver to position mode where the rotor is (the world rebases the target, so nothing
 * jumps); moving the speed slider switches back. "Compare with open-loop stepping" rebuilds
 * the world with a second motor, an open-loop stepper in current mode at its rated current,
 * on the same command and the same loads (an open-loop motor on a BLDC scenario is the
 * stepper). Stage: motor cross-section, d/q vector view, and the compact block chain in the
 * stage strip.
 *
 * Measured at the default 40 mm/s and 0.2 N·m (and from 10 to 300 mm/s; the same on both buses
 * below the voltage limit; FOC retuned 2026-10-01): Id averages within 0.003 A of zero (sense
 * noise peaks of 0.04 to 0.09 A; the chip reads −0.02 to 0.01 A), Iq = (load + 0.02 N·m friction
 * + 1e-5 N·m per rad/s of speed)/Kt within 0.1%, the load angle is 90° (89.5 to 90.5°). The heat
 * readouts are (I / I_rated)² of the smoothed current amplitude (the world's heat is a 1 s
 * average, about a minute of real time at this time scale); at 0.2 N·m 16% of rated (stepper
 * FOC, 1.41 A), 42 to 44% (BLDC FOC, 3.67 A) and 100% (open-loop stepper at 3.54 A, whose current
 * vector lies mostly on d: Id 3.25 A, Iq 1.41 A). The Iq target carries the encoder's graininess
 * (the speed is whole counts per control period): 0.06 A peak to peak at 40 mm/s on the stepper
 * and 0.14 A on the BLDC (torque ±3 to 4%), 0.16 and 0.43 A at 10 mm/s and elsewhere up to
 * 1000 mm/s (±7 to 9%); at the multiples of 250 mm/s (one count per period is 250 mm/s) the
 * counts beat with the control rate, 0.65 to 0.67 A and 1.8 A, and the torque flickers by ±27 to
 * 28%. More info says the target looks grainy, most at those speeds; the text claims nothing
 * smoother.
 * Limits: the stepper makes 0.55 N·m at its 3.54 A, the BLDC Kt·5.6 A = 0.34 N·m. The BLDC's
 * load slider stops at 0.25 N·m (4.5 A): there the grainy target peaks at 5.43 A at the
 * multiples of 250 mm/s and the velocity loop's request is never clipped at any setpoint on
 * either bus. At 0.28 N·m it is clipped 7% of the time at those speeds (the speed sags
 * 3.5 mm/s), and at 0.3 N·m the BLDC cannot hold 10 to 40 mm/s (it sags to 4 to 5 mm/s) and set
 * to 300 or 800 mm/s it sticks just above 250 or 750 mm/s. The stepper's maximum keeps 0.8 A of
 * room. The comparison stepper holds 0.55 N·m at 3.54 A at low speed, less at speed (back-EMF),
 * so load + bump + friction stay at 0.47 N·m on both motor types: stepper load up to 0.35 N·m
 * with a 0.1 N·m bump, BLDC up to 0.25 N·m with 0.15 N·m. There the comparison holds the bump up
 * to 550 mm/s on 24 V with the stepper's settings and 500 mm/s with the BLDC's (both slip it at
 * 600 mm/s), and on 48 V up to 900 mm/s with the stepper's (the bump slips it at 1000 mm/s) and
 * at every speed with the BLDC's (re-measured with the open-loop back-EMF feed-forward of
 * 2026-10-01, 30 ms; the FOC retune changed nothing here, since the open-loop motor follows the
 * same command on its own rotor). Past the range, Compare turned on under 0.4 N·m slips it while
 * its current builds up, and a load stepped to 0.45 N·m at 40 mm/s slips it (ramped, it holds
 * 0.5 N·m: a sudden load swings the rotor past its holding angle).
 *
 * Speed (B-009, 2026-10-01): the setpoint reaches 1000 mm/s, past what printers run, so the
 * limits show. On 24 V the stepper's FOC runs out of voltage at about 760 mm/s at the default
 * load (570 mm/s at 0.35 N·m, 940 mm/s with none): the voltage inset fills and the speed stays
 * under the setpoint. On 48 V it reaches 1000 mm/s at every load (81% of its voltage on average
 * at 0.35 N·m), and the BLDC does on both buses. The comparison stepper at the default load slips
 * from about 660 mm/s on 24 V (640 holds), at the stepper's maximum load from 600 mm/s (550
 * holds); on 48 V it holds 1000 mm/s at every load in range and slips only when the stepper's
 * maximum load and its bump come together at 1000 mm/s. A slipped stepper under a constant load
 * is driven backward without end, so a stepLost on the comparison motor starts
 * both motors again at rest; they run again when the speed setpoint, the bus voltage, Hold or
 * Compare changes (running them at once would only slip again at the same speed). Turning the
 * comparison off instead removed its chips and its legend entry, a row change the reader had not
 * asked for (B-006).
 * Bus voltage: 24 or 48 V (48 V by default), kept in the chapter state across Compare and the
 * restart; `world.set('supplyV')` applies it without a rebuild.
 */
import { MOTOR_PRESETS } from '../sim/presets.js';

const DEFAULTS = { speed: 40, load: 0.2, hold: false, compare: false, transforms: false, bus: 48 };
const MAX_LOAD = { stepper: 0.35, bldc: 0.25 };
const MAX_SPEED = 1000;
const BUMP = { stepper: { torque: 0.1, durationS: 0.04 }, bldc: { torque: 0.15, durationS: 0.04 } };
/** Time scale and scope window per motor type: about one electrical turn per second on screen at 40 mm/s. */
const PACE = { stepper: { time: 0.02, window: 0.1 }, bldc: { time: 0.1, window: 0.5 } };
const DEG = 180 / Math.PI;

let st = { ...DEFAULTS };
// Readout smoothing (per frame): FOC motor and the comparison motor.
const sm = { id: 0, iq: 0, amp: 0, la: 90, tq: 0, amp1: 0, n: 0 };

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const typeOf = (ctx) => (ctx.motorType === 'bldc' ? 'bldc' : 'stepper');

/** Velocity mode runs at the speed setpoint; Hold keeps the shaft where it is. */
function startMotion(c) {
  if (!st.hold) c.world.command('jog', { speedMmS: st.speed });
}

function resetSmoothing() {
  sm.n = 0;
}

export default {
  id: 'foc', number: 7, title: 'Field-oriented control', short: 'FOC',
  takeaway: 'FOC measures where the rotor is and puts the current exactly where it makes torque.',
  motorTypes: ['stepper', 'bldc'],
  timeScale: { default: 0.02, min: 0.002, max: 1 },
  traceWindow: 0.1,
  stage: { primary: 'motor', secondary: 'vector', split: 0.55, strip: 'blocks' },
  viewOptions: { blocks: { compact: true }, motor: { showTransforms: false } },

  scenario(motorType) {
    const type = motorType === 'bldc' ? 'bldc' : 'stepper';
    return {
      motorType: type, motorPreset: type, driver: 'foc', driverMode: st.hold ? 'position' : 'velocity',
      mechanics: 'free', supplyV: st.bus, loads: { drag: 0, torque: Math.min(st.load, MAX_LOAD[type]) }, bump: BUMP[type],
      compareMotor: st.compare ? { driver: 'openloop', driverMode: 'current' } : null,
      planner: { maxVelocity: 300, accel: 5000, scv: 5, microsteps: 16, fullStepsPerRev: 200 },
    };
  },

  onEnter(ctx) {
    const pace = PACE[typeOf(ctx)];
    ctx.app.setTimeScale(pace.time);
    ctx.app.setTraceWindow(pace.window);
    resetSmoothing();
    startMotion(ctx);
  },

  // scenario() runs before onEnter, so the chapter state is reset on leave.
  onLeave() {
    st = { ...DEFAULTS };
    resetSmoothing();
  },

  controls(ctx) {
    const type = typeOf(ctx);
    return [
      { type: 'slider', id: 'load', label: 'Load torque', min: 0, max: MAX_LOAD[type], step: 0.01, value: st.load,
        unit: 'N·m', title: 'A constant torque against the motor, like a weight on a pulley',
        onChange: (v, c) => {
          const max = MAX_LOAD[typeOf(c)];
          st.load = Math.min(v, max);
          if (v > max) c.app.setControlValue('load', max);
          c.world.set('loads.torque', st.load);
        } },
      { type: 'slider', id: 'speed', label: 'Speed setpoint', min: 0, max: MAX_SPEED, step: 10, value: st.speed, unit: 'mm/s',
        title: 'The velocity loop\'s target. Moving it leaves Hold position',
        onChange: (v, c) => {
          st.speed = v;
          if (st.hold) {
            st.hold = false;
            c.app.setControlValue('hold', false);
            c.world.set('driverMode', 'velocity');
          }
          startMotion(c);
        } },
      // A new bus also runs the motors again after the comparison's slip stopped them.
      { type: 'segmented', id: 'bus', label: 'Bus voltage', value: st.bus,
        options: [{ value: 24, label: '24 V' }, { value: 48, label: '48 V' }],
        title: 'The driver\'s supply: a faster motor needs more voltage (chapter 5)',
        onChange: (v, c) => { st.bus = v; c.world.set('supplyV', v); startMotion(c); } },
      { type: 'button', id: 'bump', label: 'Bump', kind: 'primary', ariaLabel: 'Bump the shaft',
        title: 'A short torque pulse against the motor', onClick: (c) => c.world.command('bump') },
      { type: 'toggle', id: 'hold', label: 'Hold position', value: st.hold,
        title: 'Stop and switch to position mode: the driver holds the shaft against the load',
        onChange: (v, c) => {
          st.hold = v;
          c.world.set('driverMode', v ? 'position' : 'velocity');
          startMotion(c);
        } },
      { type: 'toggle', id: 'compare', label: 'Compare with open-loop stepping', value: st.compare,
        title: 'A second motor, a stepper driven open loop at its rated current, on the same command and load',
        onChange: (v, c) => {
          st.compare = v;
          c.app.reconfigure();
          resetSmoothing();
          startMotion(c);
          c.app.refreshTraces();
        } },
      { type: 'toggle', id: 'transforms', label: 'Show transforms', value: st.transforms,
        title: 'Phase currents → α, β (Clarke) → d, q (Park), drawn on the motor',
        onChange: (v, c) => { st.transforms = v; c.app.setViewOptions('motor', { showTransforms: v }); } },
      { type: 'note', html: 'The speed setpoint drives the velocity loop directly. In a printer the driver runs '
        + 'in position mode, as with <b>Hold position</b>.' },
    ];
  },

  traces(ctx) {
    const type = typeOf(ctx);
    // Torque axis a little past what each motor can make (stepper 0.55 N·m at 3.54 A, BLDC 0.34).
    const tMax = type === 'bldc' ? 0.4 : 0.6;
    const t = [
      { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
      { name: 'iB', label: 'Phase B current', unit: 'A', color: 'phase-b' },
      { name: 'iC', label: 'Phase C current', unit: 'A', color: 'phase-c' },
      { name: 'iqStar', label: 'Iq target', unit: 'A', color: 'axis-q', dashed: true },
      { name: 'iq', label: 'Torque current Iq', unit: 'A', color: 'axis-q' },
      { name: 'id', label: 'Flux current Id', unit: 'A', color: 'axis-d' },
      { name: 'torque', label: 'Torque', unit: 'N·m', color: 'text', range: [-tMax, tMax] },
      { name: 'loadTorque', label: 'Load', unit: 'N·m', color: 'text', dashed: true, range: [-tMax, tMax] },
      { name: 'uMag', label: 'Voltage used', unit: 'V', color: 'muted' },
      { name: 'uLimit', label: 'Voltage limit', unit: 'V', color: 'muted', dashed: true },
    ];
    if (st.compare) t.push({ name: 'iAmp', motor: 1, label: 'Open-loop stepper current', unit: 'A', color: 'target' });
    return t;
  },

  onFrame(ctx, snap) {
    const m = snap.motors[0];
    if (!m) return;
    const a = sm.n === 0 ? 1 : 0.2;
    sm.n++;
    const amp = Math.hypot(num(m.id, 0), num(m.iq, 0));
    sm.id += a * (num(m.id, 0) - sm.id);
    sm.iq += a * (num(m.iq, 0) - sm.iq);
    sm.amp += a * (amp - sm.amp);
    sm.tq += a * (num(m.torque, 0) - sm.tq);
    if (amp > 0.05) sm.la += a * (num(m.loadAngle, 0) * DEG - sm.la);
    const m1 = snap.motors[1];
    if (m1) sm.amp1 += a * (num(m1.iAmp, 0) - sm.amp1);
  },

  readouts(snap, metrics, ctx) {
    const m1 = st.compare ? snap.motors[1] : null;
    // Heat from the present current, (I / I_rated)²: the world's 1 s average would take about a
    // minute of real time to settle at this chapter's time scale.
    const heat = (amp, preset) => 100 * (amp / preset.Irated) ** 2;
    // Values keep room for a sign and a bump's peak (−0.24 N·m, 100%), so the chip rows stay put
    // after Bump or a setpoint change (B-006).
    const items = [
      { label: 'Id', value: sm.id, unit: 'A', digits: 2, minChars: 5, title: 'Flux current: no torque, only heat. FOC holds it at zero' },
      { label: 'Iq', value: sm.iq, unit: 'A', digits: 2, minChars: 5, title: 'Torque current: torque = Kt × Iq' },
      { label: 'Load angle', value: sm.amp > 0.05 ? sm.la : '–', unit: '°', digits: 0, minChars: 4,
        title: 'Angle between the current vector and the rotor magnet' },
      { label: 'Current', value: sm.amp, unit: 'A peak', digits: 2, minChars: 4, title: 'Phase current amplitude' },
      { label: 'Torque', value: sm.tq, unit: 'N·m', digits: 2, minChars: 5 },
      { label: 'Heat', value: heat(sm.amp, MOTOR_PRESETS[typeOf(ctx)]), unit: '% of rated', digits: 0, minChars: 4,
        title: 'Copper loss at this current, compared with running at the rated current' },
    ];
    if (m1) {
      // Room for 3.54 A and 100% from the start: the values grow from 0 as the smoothing settles,
      // which wrapped a chip row 0.6 s after Compare at some widths (B-006, found in B-009's check).
      const h1 = heat(sm.amp1, MOTOR_PRESETS.stepper);
      items.push({ label: 'Open-loop current', value: sm.amp1, unit: 'A peak', digits: 2, minChars: 4,
        title: 'The open-loop stepper\'s phase current amplitude: its run current, whatever the load' });
      items.push({ label: 'Open-loop heat', value: h1, unit: '% of rated', digits: 0, warn: h1 > 80, minChars: 4,
        title: 'The open-loop stepper\'s copper loss at this current, compared with running at its rated current' });
    }
    return items;
  },

  // The only announcement, at its longest, so the readouts row keeps room for it (B-008).
  announceSample: 'The open-loop stepper slipped at 1000 mm/s, so both motors stopped',

  onEvent(ev, ctx) {
    if (ev.type === 'stallDetected') return false;     // the open-loop comparison motor's StallGuard
    if (ev.type === 'stepLost' && ev.data && ev.data.motor === 1) {
      // A slipped stepper under a constant load would be driven backward without end. Both motors
      // start again at rest and stay there until the speed setpoint, the bus voltage, Hold or
      // Compare changes: at the default load the stepper slips again on its own from about
      // 660 mm/s on 24 V, so running them again would only repeat the slip. The comparison stays
      // on, so the chips and the legend keep their rows.
      const pl = ctx.world.snapshot && ctx.world.snapshot.planner;
      const speed = pl ? Math.round(Math.hypot(num(pl.vx, 0), num(pl.vy, 0))) : st.speed;
      ctx.app.reconfigure();
      resetSmoothing();
      return `The open-loop stepper slipped at ${speed} mm/s, so both motors stopped`;
    }
    return undefined;
  },

  text: () => '<p>Tens of thousands of times a second, the driver reads the rotor angle from the encoder and the '
    + 'phase currents, then rotates the currents into the rotor\'s frame (the Park transform). '
    + 'The part along the magnet is the flux current Id: it makes no torque, only heat. The part 90° ahead is the '
    + 'torque current Iq. Two PI loops hold Iq at what the motion asks for and Id at zero (chapter 8 tunes them), '
    + 'and the driver rotates their output back (inverse Park) and switches the phases with PWM.</p>'
    + '<p>So every amp makes torque: the current follows the load at any speed, not a fixed setting, and there '
    + 'are no steps to lose. A three-phase BLDC works the same way: switch the motor type.</p>'
    + '<p>In a printer, Klipper still sends STEP and DIR. The driver counts the pulses into a position target, so '
    + 'the steps and microsteps in your config are virtual: they set how finely Klipper can command a position, '
    + 'not how the motor moves.</p>',

  tryThis: [
    'Raise the <b>Load torque</b> and watch Iq rise while Id stays at zero.',
    'Turn on <b>Compare with open-loop stepping</b>: the stepper beside it draws its full run current at any '
      + 'load, and most of it lands on the d axis. Compare the heat.',
    'Switch the motor type to <b>BLDC</b>, then turn on <b>Show transforms</b>.',
  ],

  deeper: () => '<p>Park: Id = Iα·cos θ + Iβ·sin θ and Iq = −Iα·sin θ + Iβ·cos θ, with θ the rotor\'s electrical '
    + 'angle. A stepper\'s two coils already are α and β; a three-phase motor first folds its three currents into '
    + 'α and β (Clarke). Torque = Kt·Iq, so Iq follows the load. The Iq target looks grainy, most at multiples of '
    + '250&nbsp;mm/s: the driver gets its speed from whole encoder counts, which the filters smooth only partly.</p>'
    + '<p>Each current loop is a PI with Kp = L·ωc; its integral part supplies the voltage for the coil\'s resistance '
    + 'and back-EMF. The '
    + 'voltage inset shows how much of the supply the loops use: at speed the back-EMF takes more of it '
    + '(chapter 5), and once the voltage circle is full the current can no longer follow.</p>',
};
