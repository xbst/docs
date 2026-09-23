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
 * Measured (24 V, velocity mode, 20–300 mm/s): Id stays within 0.01 A of zero, Iq =
 * (load + 0.02 N·m friction)/Kt within 1%, the load angle is 90°. Heat at 0.2 N·m: 7% of
 * rated (stepper FOC), 37% (BLDC FOC), 87% (open-loop stepper at 3.54 A). Limits: the BLDC
 * makes at most Kt·5.6 A = 0.34 N·m, so its load slider stops at 0.3 N·m and its bump is
 * 0.15 N·m. The comparison stepper holds 0.78 N·m at 3.54 A up to about 250 mm/s (less
 * beyond, back-EMF), so on the stepper the load stops at 0.4 N·m, the bump is 0.25 N·m and
 * the speed stops at 250 mm/s: load, bump and acceleration stay below its holding torque
 * (0.4 + 0.3 slipped it at 300 mm/s). A slipped stepper under a constant load is driven
 * backward without end (about 19 m/s here), so a stepLost on the comparison motor restarts
 * both motors.
 */
import { formatValue } from '../format.js';

const DEFAULTS = { speed: 40, load: 0.2, hold: false, compare: false, transforms: false };
const MAX_LOAD = { stepper: 0.4, bldc: 0.3 };
const MAX_SPEED = 250;
const BUMP = { stepper: { torque: 0.25, durationS: 0.04 }, bldc: { torque: 0.15, durationS: 0.04 } };
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
      mechanics: 'free', loads: { drag: 0, torque: Math.min(st.load, MAX_LOAD[type]) }, bump: BUMP[type],
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
      { type: 'slider', id: 'speed', label: 'Speed setpoint', min: 0, max: MAX_SPEED, step: 5, value: st.speed, unit: 'mm/s',
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
    const tMax = type === 'bldc' ? 0.4 : 0.8;
    const t = [
      { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
      { name: 'iB', label: 'Phase B current', unit: 'A', color: 'phase-b' },
      { name: 'iC', label: 'Phase C current', unit: 'A', color: 'phase-c' },
      { name: 'iqStar', label: 'Iq target', unit: 'A', color: 'axis-q', dashed: true },
      { name: 'iq', label: 'Torque current Iq', unit: 'A', color: 'axis-q' },
      { name: 'id', label: 'Flux current Id', unit: 'A', color: 'axis-d' },
      { name: 'torque', label: 'Torque', unit: 'N·m', color: 'text', range: [-tMax, tMax] },
      { name: 'loadTorque', label: 'Load', unit: 'N·m', color: 'text', dashed: true, range: [-tMax, tMax] },
      { name: 'uMag', label: 'Voltage', unit: 'V', color: 'muted' },
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

  readouts(snap) {
    const m = snap.motors[0];
    const m1 = st.compare ? snap.motors[1] : null;
    const items = [
      { label: 'Id', value: sm.id, unit: 'A', digits: 2, title: 'Flux current: no torque, only heat. FOC holds it at zero' },
      { label: 'Iq', value: sm.iq, unit: 'A', digits: 2, title: 'Torque current: torque = Kt × Iq' },
      { label: 'Load angle', value: sm.amp > 0.05 ? sm.la : '–', unit: '°', digits: 0,
        title: 'Angle between the current vector and the rotor magnet' },
      { label: 'Amplitude', value: sm.amp, unit: 'A', digits: 2, title: 'Phase current amplitude' },
      { label: 'Torque', value: sm.tq, unit: 'N·m', digits: 3 },
      { label: 'Heat', value: 100 * num(m.heat, 0), unit: '% of rated', digits: 0,
        title: 'Copper loss compared with running at the rated current, averaged over the last second' },
    ];
    if (m1) {
      items.push({ label: 'Open loop', value: sm.amp1, unit: 'A', digits: 2,
        title: 'The open-loop stepper\'s phase current amplitude: its run current, whatever the load' });
      items.push({ label: 'Open-loop heat', value: 100 * num(m1.heat, 0), unit: '% of rated', digits: 0, warn: m1.heat > 0.8,
        title: 'The open-loop stepper\'s copper loss compared with running at its rated current' });
    }
    return items;
  },

  onEvent(ev, ctx) {
    if (ev.type === 'stallDetected') return false;     // the open-loop comparison motor's StallGuard
    if (ev.type === 'stepLost' && ev.data && ev.data.motor === 1) {
      // Safety net (the ranges keep load + bump below its holding torque): a slipped stepper
      // under a constant load would be driven backward without end, so start both motors again.
      ctx.app.reconfigure();
      resetSmoothing();
      startMotion(ctx);
      return 'The open-loop stepper slipped under the load, so both motors start again';
    }
    return undefined;
  },

  text: () => '<p>Tens of thousands of times a second, the driver reads the rotor angle from the encoder and the '
    + 'phase currents from its sensors, then rotates the currents into the rotor\'s frame (the Park transform). '
    + 'The part along the magnet is the flux current Id: it makes no torque, only heat. The part 90° ahead is the '
    + 'torque current Iq. Two PI loops hold Iq at what the motion asks for and Id at zero, and the driver rotates '
    + 'their output back (inverse Park) and switches the phases with PWM.</p>'
    + '<p>So every amp makes torque: the current follows the load instead of a fixed setting, the torque stays '
    + 'smooth at any speed, and there are no steps to lose. A three-phase BLDC works the same way: switch the '
    + 'motor type.</p>'
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
    + 'α and β (Clarke). Torque = Kt·Iq, so Iq follows the load.</p>'
    + '<p>Each current loop is a PI with Kp = L·ωc and Ki = R·ωc, which cancels the coil\'s own time constant. The '
    + 'voltage inset shows how much of the supply the loops use: at speed the back-EMF takes more of it '
    + '(chapter 5), and once the voltage circle is full the current can no longer follow.</p>',
};
