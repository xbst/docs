/**
 * Chapter 1: STEP and DIR (SPEC 6.1).
 *
 * One belt axis in open loop. The reader commands moves (the "Move to" slider and the ±10/±100
 * buttons) and watches the pulses on the scope. Every number comes from the world: steps per mm
 * from the preset (4·p full steps per turn), the microsteps and the rotation distance; the step
 * count is the step generator's position (`world.stepgens[0].sent`, what the controller has
 * sent, counted from 0 mm); "pulses for this move" is that count since the last move command.
 *
 * Speed and acceleration are the planner limits and apply from the next move (a new limit
 * mid-move would change the cruise speed in one step). "Pulse zoom" narrows the scope to 10 ms
 * and slows time (1 s on screen = 10 ms) so single pulses, the DIR edge and the ramp show; the
 * STEP lane draws the `stepN` trace (pulses per sample) as thin pulses, so it stays true above
 * 12.5 kHz. The accessors below fall back for FakeWorld (`?sim=fake`), which has no presets,
 * step generators or scenario getter.
 */
import { MOTOR_PRESETS } from '../sim/presets.js';

const AXIS_MM = 350;
const START_MM = 50;
const FIRST_MOVE_MM = 90;
const SPEED = 100;
const ACCEL = 2000;
const ZOOM = { window: 0.01, timeScale: 0.01 };
const NORMAL = { window: 2, timeScale: 1 };

/** Chapter state; reset in onEnter (scenario() runs before it and only reads the constants). */
const st = { target: FIRST_MOVE_MM, speed: SPEED, accel: ACCEL, zoom: false, sent0: 0, goal: 0, moving: false };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Scenario of the World (`scenario`) or of FakeWorld (`sc`). */
const scOf = (w) => w.scenario || w.sc || {};
/** Preset of motor 0. */
const presetOf = (w) => (w.presets && w.presets[0]) || MOTOR_PRESETS[scOf(w).motorPreset] || MOTOR_PRESETS.stepper;
/** The controller's step position (FakeWorld: its absolute step count). */
const sentOf = (w) => (w.stepgens && w.stepgens[0] ? w.stepgens[0].sent : w.snapshot.step.count);

/** Step geometry of the world: full steps per turn, microsteps, rotation distance, pulses per turn and per mm. */
function geometry(world) {
  const full = 4 * presetOf(world).p;
  const micro = scOf(world).microsteps || 16;
  const rd = world.rd || 40;
  const perRev = full * micro;
  return { full, micro, rd, perRev, spm: perRev / rd };
}

/**
 * Command a move to x mm (clamped to the axis) with the current speed and acceleration. A
 * command that extends the running motion in the same direction continues the same move for
 * the pulse counter (four quick +10 presses count as one 40 mm move).
 */
function moveTo(ctx, x) {
  const w = ctx.world, pl = w.snapshot.planner;
  const target = clamp(Math.round(x), 0, AXIS_MM);
  const heading = Math.sign(pl.vx);
  const continuing = st.moving && pl.mode !== 'idle' && heading !== 0 && heading === Math.sign(target - pl.x);
  st.target = target;
  w.set('planner.maxVelocity', st.speed);
  w.set('planner.accel', st.accel);
  if (!continuing) st.sent0 = sentOf(w);
  st.goal = Math.round(target * geometry(w).spm);
  st.moving = true;
  w.command('moveTo', { xMm: target });
  ctx.app.setControlValue('target', target);
  ctx.app.setViewOptions('gantry', { targetMm: target });
}

function setZoom(ctx, on) {
  st.zoom = !!on;
  const z = st.zoom ? ZOOM : NORMAL;
  ctx.app.setTraceWindow(z.window);
  ctx.app.setTimeScale(z.timeScale);
}

const nudge = (d) => ({
  type: 'button', id: `by${d < 0 ? 'm' : 'p'}${Math.abs(d)}`, label: (d < 0 ? '−' : '+') + Math.abs(d), group: 'Move',
  ariaLabel: `Move ${Math.abs(d)} mm ${d < 0 ? 'toward 0' : 'away from 0'}`,
  onClick: (c) => moveTo(c, st.target + d),
});

export default {
  id: 'step-dir', number: 1, title: 'STEP and DIR', short: 'STEP/DIR',
  takeaway: 'Klipper talks to every stepper driver over two wires, STEP and DIR, and the driver never talks back.',
  motorTypes: ['stepper'],
  timeScale: { default: 1, min: 0.002, max: 1 },
  traceWindow: NORMAL.window,
  stage: { primary: 'gantry', secondary: null },
  viewOptions: { gantry: { led: false } },       // DIAG belongs to chapter 4
  hint: 'Move the carriage with the slider or the buttons. Pulse zoom slows time and shows single pulses.',

  scenario(motorType) {
    return {
      motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'current', mechanics: 'axis',
      microsteps: 16, interpolate: true, start: { x: START_MM, y: 50 },
      planner: { maxVelocity: SPEED, accel: ACCEL },
    };
  },

  onEnter(ctx) {
    st.speed = SPEED;
    st.accel = ACCEL;
    st.zoom = false;
    moveTo(ctx, FIRST_MOVE_MM);
  },

  onLeave() {
    st.zoom = false;
    st.moving = false;
  },

  onEvent(ev, ctx) {
    if (ev.type === 'stallDetected') return false;
    if (ev.type !== 'pathDone' || !st.moving) return undefined;
    st.moving = false;
    const pulses = Math.abs(st.goal - st.sent0);
    const mm = pulses / geometry(ctx.world).spm;
    return `Move done: ${pulses} pulses for ${+mm.toFixed(3)} mm`;
  },

  controls(ctx) {
    const g = geometry(ctx.world);
    return [
      { type: 'slider', id: 'target', label: 'Move to', min: 0, max: AXIS_MM, step: 1, value: st.target, unit: 'mm',
        live: false, group: 'Move', onChange: (v, c) => moveTo(c, v) },
      nudge(-100), nudge(-10), nudge(10), nudge(100),
      { type: 'slider', id: 'speed', label: 'Speed', min: 10, max: 300, step: 5, value: st.speed, unit: 'mm/s',
        group: 'Motion', onChange: (v) => { st.speed = v; } },
      { type: 'slider', id: 'accel', label: 'Acceleration', min: 500, max: 10000, step: 100, value: st.accel,
        unit: 'mm/s²', group: 'Motion', onChange: (v) => { st.accel = v; } },
      { type: 'note', group: 'Motion', html: 'New speed and acceleration values apply from the next move.' },
      { type: 'toggle', id: 'zoom', label: 'Pulse zoom', value: st.zoom, group: 'Scope',
        onChange: (v, c) => setZoom(c, v) },
      { type: 'note', group: 'Scope',
        html: `<code>microsteps: ${g.micro}</code> and <code>rotation_distance: ${g.rd}</code>: `
          + `${g.full} full steps × ${g.micro} = ${g.perRev} pulses per turn, ${g.perRev} / ${g.rd} = `
          + `<strong>${g.spm} pulses per mm</strong>.` },
    ];
  },

  traces: [
    { name: 'stepN', group: 'digital', pulses: true, label: 'STEP', color: 'phase-a' },
    { name: 'dir', group: 'digital', label: 'DIR', color: 'phase-b' },
    { name: 'posCmd', label: 'Commanded position', unit: 'mm', color: 'target', dashed: true },
    { name: 'velCmd', label: 'Commanded speed', unit: 'mm/s', color: 'phase-c', dashed: true },
  ],

  readouts(snap, metrics, ctx) {
    const w = ctx.world;
    const sent = sentOf(w);
    const done = Math.abs(sent - st.sent0), total = Math.abs(st.goal - st.sent0);
    return [
      { label: 'Step rate', value: snap.step.rate / 1000, unit: 'kHz', digits: 2 },
      { label: 'Step count', value: sent, digits: 0, title: 'Steps sent so far, counted from 0 mm' },
      { label: 'Pulses for this move', value: done, digits: 0, unit: `of ${total}`, ok: total > 0 && done === total },
      { label: 'Carriage', value: snap.gantry.x, unit: 'mm', digits: 2 },
      { label: 'Steps per mm', value: geometry(w).spm, digits: 0 },
    ];
  },

  text(ctx) {
    const g = geometry(ctx.world);
    return '<p>Your printer\'s controller (Klipper) moves a stepper with two wires. Every pulse on '
      + '<strong>STEP</strong> advances the motor by one microstep, and the level on <strong>DIR</strong> '
      + 'sets the direction. DIR changes before the first pulse of a move.</p>'
      + '<p>Speed is the pulse rate, and acceleration is that rate ramping up and down. Klipper plans every '
      + 'move ahead and computes each pulse time in advance, so the two wires carry the whole motion as timing.</p>'
      + `<p>With <code>microsteps: ${g.micro}</code> and <code>rotation_distance: ${g.rd}</code>, one turn takes `
      + `${g.full} × ${g.micro} = ${g.perRev} pulses and moves the belt ${g.rd} mm: `
      + `<strong>${g.spm} pulses per millimeter</strong>.</p>`
      + '<p>The driver only counts pulses. It never reports whether the motor actually moved, so a rotor that '
      + 'slips goes unnoticed (chapter 6).</p>';
  },

  tryThis(ctx) {
    const g = geometry(ctx.world);
    return [
      `Move 40 mm with the slider and check that the pulse counter reaches ${40 * g.spm}.`,
      'Turn on Pulse zoom, double the speed and move again: the pulses crowd together.',
      'With Pulse zoom on, move back toward 0 and watch DIR drop before the first pulse.',
    ];
  },

  deeper(ctx) {
    const g = geometry(ctx.world);
    return `<p>Steps per mm = full steps per turn × microsteps / rotation_distance = ${g.full} × ${g.micro} / ${g.rd} `
      + `= ${g.spm}.</p>`
      + `<p>Step rate = speed × steps per mm: 100 mm/s needs ${100 * g.spm} pulses per second. While the speed `
      + `ramps up at an acceleration <i>a</i>, pulse <i>k</i> leaves at t = √(2<i>k</i> / (<i>a</i> × ${g.spm})), `
      + 'so the gaps between pulses shrink; while it ramps down they grow again.</p>'
      + `<p>A 1.8° motor makes ${g.full} full steps per turn. Chapter 2 shows what one step does inside the motor.</p>`;
  },
};
