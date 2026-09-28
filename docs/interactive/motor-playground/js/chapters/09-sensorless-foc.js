/**
 * Chapter 9: Sensorless homing with FOC (SPEC 6.9, chunk 07).
 *
 * One belt axis under FOC in position mode with a hard stop at 0 mm, and the
 * compact block diagram's "limit" chain (velocity loop → current limit →
 * limit flag → status output → controller). "Home" first moves the carriage
 * out to the start position when it is closer than that (which also lets a
 * latched status output clear), then runs the world's homing sequence:
 * approach at the homing speed with the current limit at the homing current,
 * stop on the rising edge of the latched status output, retract. "Home again"
 * homes from wherever the carriage is: after a pass with retract 0 it is
 * still pressed against the stop, the status output is still high and the
 * pass ends with no edge, the failure the retract distance prevents. Pressed
 * during Home's move-out, it brakes and homes once from where the carriage
 * comes to rest (not a second pass queued behind the pending one).
 *
 * Default homing currents: 0.5 A on the stepper (free-motion demand peak
 * 0.39 A at 40 mm/s with 0.05 N·m of drag), 1.75 A on the BLDC (Kt is
 * 0.06 N·m/A, so friction alone needs about 1.2 A and the peak is 1.47 A).
 * Measured by chunk 07, see STATUS.md row 07.
 */
import { formatValue, formatPeak } from '../format.js';

/** Where "Home" starts the approach from (mm). */
const START_X = 40;
/** Homing current defaults per motor type (A). */
const DEFAULT_CURRENT = { stepper: 0.5, bldc: 1.75 };
/** Drag slider maximum per motor type (N·m). */
const DRAG_MAX = { stepper: 0.3, bldc: 0.2 };
/** Sim time at which the chapter homes once by itself after entering (s). */
const AUTO_HOME_AT_S = 0.4;
/** Press-in the readout flags as hard (mm). */
const PRESS_WARN_MM = 0.5;
/** Carriage speed below which a pending homing may start (mm/s; at 2 the BLDC at 1.55 A still false-triggered). */
const REST_MM_S = 1;

const S = {};
function resetState(type) {
  S.current = DEFAULT_CURRENT[type] || 0.5;
  S.speed = 40;
  S.retract = 5;
  S.drag = 0.05;
  S.homeWhenIdle = false;
  S.autoHomeAt = AUTO_HOME_AT_S;
}
resetState('stepper');

/** "Home": out to the start position first when the carriage is closer, then the homing sequence. */
function homeFromStart(c) {
  const w = c.world;
  const s = w.snapshot;
  if (Math.abs(s.gantry.x - START_X) < 0.5 && s.planner.mode === 'idle' && !s.homing.active) {
    w.command('home');
    return;
  }
  w.command('moveTo', { xMm: START_X });
  S.homeWhenIdle = true;
}

/**
 * "Home again": one pass from where the carriage is. During Home's move-out it brakes instead and
 * leaves the pending homing to onFrame, which starts it once the carriage has come to rest, so each
 * click homes once (a pass started while the carriage still moves away can trip the limit as it
 * reverses: a false trigger).
 */
function homeAgain(c) {
  const w = c.world;
  const s = w.snapshot;
  if (S.homeWhenIdle && !s.homing.active) {
    // S.homeWhenIdle stays set: onFrame homes once the carriage is at rest, also when the planner
    // has just finished the move-out and the carriage is still settling.
    if (s.planner.mode !== 'idle') w.command('stop');
    return;
  }
  S.homeWhenIdle = false;
  w.command('home');
}

const RESULT_TEXT = { ok: 'detected at the stop', 'false-trigger': 'false trigger', 'no-edge': 'no edge' };

export default {
  id: 'sensorless-foc', number: 9, title: 'Sensorless homing with FOC', short: 'Sensorless',
  takeaway: 'With FOC, stall detection is a current-limit comparison, not a guess.',
  motorTypes: ['stepper', 'bldc'],
  timeScale: { default: 0.5, min: 0.02, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: 'blocks', split: 0.6 },
  viewOptions: { gantry: { detailMm: 2, led: true }, blocks: { compact: true, chain: 'limit' } },
  hint: 'Press Home. At contact the Iq target hits the limit, the flag fires and the status output goes high.',

  scenario(motorType) {
    return {
      motorType, motorPreset: motorType === 'bldc' ? 'bldc' : 'stepper', driver: 'foc', driverMode: 'position',
      mechanics: 'axis', hardStops: true, start: { x: START_X, y: 50 }, loads: { drag: 0.05, torque: 0 },
      planner: { maxVelocity: 150, accel: 5000, scv: 5 },
      foc: { homingCurrent: DEFAULT_CURRENT[motorType] || 0.5, homingSpeedMmS: 40, retractMm: 5 },
    };
  },

  onEnter(ctx) { resetState(ctx.motorType); },
  onLeave(ctx) { resetState(ctx.motorType); },

  controls(ctx) {
    const keys = ctx.product.keys || {};
    const notes = ctx.product.notes || {};
    const runCurrent = (ctx.world.scenario || ctx.world.sc || {}).runCurrent;   // FakeWorld (?sim=fake): `sc`
    return [
      { type: 'slider', id: 'homingCurrent', label: 'Homing current limit', group: 'Homing', min: 0.2, max: 3.5, step: 0.05,
        value: S.current, format: (v) => formatPeak(v, false), caption: keys.homingCurrent,
        onChange: (v, c) => { S.current = v; c.world.set('foc.homingCurrent', v); c.app.setHighlight('limit'); } },
      { type: 'slider', id: 'homingSpeed', label: 'Homing speed', group: 'Homing', min: 10, max: 100, step: 5, value: S.speed,
        unit: 'mm/s', onChange: (v, c) => { S.speed = v; c.world.set('foc.homingSpeedMmS', v); } },
      { type: 'slider', id: 'retract', label: 'Retract distance', group: 'Homing', min: 0, max: 5, step: 0.5, value: S.retract,
        unit: 'mm', caption: keys.retract, onChange: (v, c) => { S.retract = v; c.world.set('foc.retractMm', v); } },
      { type: 'slider', id: 'drag', label: 'Drag', group: 'Homing', min: 0, max: DRAG_MAX[ctx.motorType] || 0.3, step: 0.01,
        value: S.drag, unit: 'N·m', onChange: (v, c) => { S.drag = v; c.world.command('setLoad', { drag: v }); } },
      { type: 'button', id: 'home', label: 'Home', kind: 'primary', group: 'Run', onClick: (c) => homeFromStart(c),
        title: 'Move out to 40 mm if needed, then approach the stop, detect it and retract' },
      { type: 'button', id: 'homeAgain', label: 'Home again', group: 'Run', onClick: (c) => homeAgain(c),
        title: 'A second pass from where the carriage is now, or from where it stops if Home is still moving it out' },
      { type: 'note', group: 'Run', html: `Run current for normal moves: <code>${formatPeak(runCurrent, false)}</code>`
        + (keys.runCurrent ? ` (<code>${keys.runCurrent}</code>)` : '') + '. Homing swaps in the limit above.' },
      { type: 'note', group: 'Run', html: 'The controller reads the status output as an endstop'
        + (keys.diagPin ? ` (<code>${keys.diagPin}</code>)` : '') + '.' + (notes.homing ? ' ' + notes.homing : '') },
    ];
  },

  traces: (ctx) => {
    const keys = ctx.product.keys || {};
    return [
      { name: 'flagIqTarget', group: 'digital', label: 'Limit flag' + (keys.flag ? ` (${keys.flag})` : ''), short: 'FLAG', color: 'warn' },
      { name: 'status', group: 'digital', label: 'Status output', short: keys.statusPin || 'STATUS', color: 'err' },
      { name: 'iqStar', label: 'Iq target', unit: 'A', color: 'axis-q', dashed: true },
      { name: 'iq', label: 'Torque current Iq', unit: 'A', color: 'axis-q' },
      { name: 'iLimit', label: 'Current limit', unit: 'A', color: 'target', dashed: true },
      { name: 'velCmd', label: 'Commanded speed', unit: 'mm/s', color: 'target', dashed: true },
      { name: 'velAct', label: 'Actual speed', unit: 'mm/s', color: 'phase-c' },
      { name: 'posAct', label: 'Carriage position', unit: 'mm', color: 'phase-a' },
    ];
  },

  onEvent(ev) {
    if (ev.type === 'homingDone') {
      const d = ev.data || {};
      if (d.result === 'ok') return `Homing done: the status output rose ${formatValue(d.pressInMm, 2)} mm into the stop`;
      if (d.result === 'false-trigger') return `False trigger ${formatValue(d.xMm, 1)} mm before the stop: the demand exceeded the limit in free motion`;
      return undefined;
    }
    if (ev.type === 'pathDone' || ev.type === 'bump') return false;
    return undefined;
  },

  onFrame(ctx, snap) {
    if (S.autoHomeAt >= 0 && snap.t >= S.autoHomeAt) {
      S.autoHomeAt = -1;
      homeFromStart(ctx);
    }
    // A pending homing waits for the carriage itself to rest, not only the planner: the planner
    // idles while the carriage, lagging its command, still moves outward, and a pass started
    // then can false-trigger.
    if (S.homeWhenIdle && snap.planner.mode === 'idle' && !snap.homing.active
        && Math.abs(snap.motors[0].omegaM) * (snap.rd || 40) / (2 * Math.PI) < REST_MM_S) {
      S.homeWhenIdle = false;
      ctx.world.command('home');
    }
  },

  readouts(snap, metrics, ctx) {
    const m = snap.motors[0];
    const h = snap.homing;
    const keys = ctx.product.keys || {};
    const flag = !!(m.flags && m.flags.iqTargetLimit);
    const status = !!m.status;
    const result = h.active ? (h.pass > 1 ? `running, pass ${h.pass}` : 'running') : (RESULT_TEXT[h.result] || 'not run yet');
    // Motor torque as force on the belt: T / (rd / 2π), rd in mm per turn.
    const forceN = Math.abs(m.torque) * 2 * Math.PI / ((snap.rd || 40) / 1000);
    return [
      { label: 'Carriage', value: snap.gantry.x, unit: 'mm', digits: 2 },
      { label: 'Iq target', value: Math.abs(m.iqStar), unit: 'A', digits: 2, warn: flag,
        title: `The velocity loop's request, capped at the ${formatValue(m.iLimit, 2)} A limit` },
      { label: 'Free-motion peak', value: h.freeIqPeak, unit: 'A', digits: 2,
        title: 'Largest Iq target while the carriage moved freely in this pass; set the limit just above it. '
          + 'After a false trigger it reads the limit itself, since the target is capped there' },
      { label: 'Press-in at detection', value: h.pressInMm, unit: 'mm', digits: 2, warn: h.pressInMm > PRESS_WARN_MM,
        title: 'How far the carriage had pushed into the (compliant) stop when the status output rose; '
          + 'the loop keeps pushing after that, so the carriage sinks in further' },
      { label: 'Press force', value: forceN, unit: 'N', digits: 0, title: 'Motor torque as belt force, Kt·Iq·2π/rd' },
      { label: 'Homing', value: result, warn: !h.active && (h.result === 'false-trigger' || h.result === 'no-edge'),
        ok: !h.active && h.result === 'ok' },
      { label: keys.flag || 'Limit flag', value: flag ? 'on' : 'off', led: flag ? 'trip' : 'off',
        title: 'Set while the velocity loop asks for more current than the limit allows' },
      { label: keys.statusPin || 'Status output', value: status ? 'high' : 'low', led: status ? 'trip' : 'off',
        title: 'Latched from the limit flags; clears once the carriage is off the stop' },
    ];
  },

  text: () => '<p>During homing the driver caps the torque current at a low <strong>current limit</strong> instead of the '
    + 'run current. Moving freely, the velocity loop asks only for what friction and acceleration need, below that limit.</p>'
    + '<p>At the hard stop the carriage cannot follow the commanded speed. The speed error grows at once and the loop demands '
    + 'more current. The moment the demand exceeds the limit, a <strong>limit flag</strong> is set and the driver\'s '
    + '<strong>status output</strong> goes high. The controller reads that pin as an endstop.</p>'
    + '<p>Set the limit just above the free-motion peak. Too low, and a bit of drag or a fast ramp trips it before the stop '
    + '(a false trigger). Too high, and the motor pushes hard into the stop before the flag fires.</p>'
    + '<p>The status output stays latched while the carriage is pressed against the stop, so the axis must retract before '
    + 'the next homing: with no retract, the second pass sees no rising edge.</p>'
    + '<p>Unlike chapter 4, nothing here is guessed from back-EMF: it is a comparison of two currents, and it works at any speed.</p>',
  tryThis: (ctx) => {
    const i = DEFAULT_CURRENT[ctx.motorType] || 0.5;
    return [
      `Home at ${formatValue(i, 2)} A and watch the Iq target jump to the limit at contact.`,
      'Lower the limit until homing trips before the stop, then put it back and raise the drag until it trips again.',
      'Raise the limit to 3 A and watch the press-in and the press force grow. Then set the retract to 0, press Home, '
        + 'and press Home again.',
    ];
  },
  // Press-in at detection (chunk 10, node), stepper at 40 mm/s: 0.06 / 0.09 / 0.73 / 1.44 mm at 0.5 / 1 / 2 / 3 A;
  // at 10 mm/s 0.03 / 0.37 / 1.05 / 1.76 mm, so a slower approach presses deeper above ~0.6 A. Above the
  // contact kick (velocity P × approach speed) the slope is Kt/k: 0.70 mm/A stepper, 0.19 mm/A BLDC.
  deeper: (ctx) => '<p>The stop is a stiff spring (belt compliance). At contact the speed error alone makes the loop ask for '
    + 'current in proportion to the approach speed: a limit below that trips right there, a higher one only once the belt has '
    + `compressed, about ${ctx.motorType === 'bldc' ? '0.2' : '0.7'} mm per extra amp (Kt over the belt stiffness).</p>`
    + '<p>Detection itself takes a few control cycles of 40 µs once the demand crosses the limit; what takes time is the speed '
    + 'error building up while the belt compresses. A lower limit keeps the press-in small.</p>'
    + '<p>The status output is the OR of the driver\'s limit flags: the torque-current limit used here plus the voltage '
    + 'limits, so the same pin also reports a saturated supply.</p>',
};
