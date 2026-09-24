/**
 * Chapter 2: Microstepping (SPEC 6.2).
 *
 * The stepper on a belt axis in open loop (current mode), jogging back and forth at a slow speed.
 * The motor view shows one electrical cycle (the field vector jumps 90° per full step and
 * 90°/n per microstep); the gantry's magnified strip shows the carriage stepping. Interpolation
 * starts off, so 1/4/16 microsteps show their own staircase currents (with it on, every setting
 * becomes a 256-step sine inside the driver).
 *
 * Run current: the slider is in A RMS like Klipper's `run_current`; the sim's runCurrent is the
 * sine's peak (× √2). Readouts: the step rate the controller must send, the field angle and the
 * incremental torque per microstep (sin(90°/n) of the holding torque), the position ripple and
 * the lag (peak-to-peak of posErr and mean load angle over the last 50 ms), and the analytic ring
 * frequency √(Kt·I·p/Jt)/2π. "Single step" uses command('singleStep') and stops the jog first.
 * The accessors below fall back for FakeWorld (`?sim=fake`: no presets, mechanics or scenario getter).
 */
import { formatValue, formatRms } from '../format.js';
import { MOTOR_PRESETS } from '../sim/presets.js';

const SPEED = 10;
const CURRENT_RMS = 2.5;
const MICRO = 16;
const TURN_HI = 300, TURN_LO = 50;       // jog turnaround points (mm)
const STATS_S = 0.05;                     // ripple and lag window (s of sim time)
const MICROSTEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

/** Chapter state; reset in onEnter (scenario() only reads the constants). */
const st = { micro: MICRO, interp: false, rms: CURRENT_RMS, speed: SPEED, drag: 0, run: true, dir: 1, trail: false };
/** Scratch for ringStats (no allocation per readout). */
const stats = { min: 0, max: 0, mean: 0, n: 0 };

/** Min, max and mean of a trace ring over its last `span` seconds, into `stats`. */
function ringStats(ring, span) {
  stats.n = 0;
  if (!ring || !ring.len) return stats;
  const cap = ring.cap, T = ring.t, V = ring.v;
  let p = ring.head - 1;
  if (p < 0) p += cap;
  const tEnd = T[p];
  let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
  for (let i = 0; i < ring.len; i++) {
    const t = T[p], v = V[p];
    if (tEnd - t > span) break;
    if (v === v) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
      n++;
    }
    p = p === 0 ? cap - 1 : p - 1;
  }
  stats.min = mn; stats.max = mx; stats.mean = n ? sum / n : 0; stats.n = n;
  return stats;
}

/** Scenario of the World (`scenario`) or of FakeWorld (`sc`). */
const scOf = (w) => w.scenario || w.sc || {};
/** Preset of motor 0. */
const presetOf = (w) => (w.presets && w.presets[0]) || MOTOR_PRESETS[scOf(w).motorPreset] || MOTOR_PRESETS.stepper;
/** Peak run current (A). */
const peakOf = (w) => (scOf(w).runCurrent > 0 ? scOf(w).runCurrent : presetOf(w).Irated);

/** Pulses per mm of the world (4·p full steps per turn × microsteps / rotation distance). */
function stepsPerMm(world) {
  return 4 * presetOf(world).p * (scOf(world).microsteps || 16) / (world.rd || 40);
}

/** Natural (ring) frequency of the rotor on its field spring at peak current I (Hz). */
function ringHz(world, I) {
  const pr = presetOf(world);
  const jt = world.mechanics && world.mechanics.Jt ? world.mechanics.Jt[0] : pr.Jrotor + (scOf(world).Jload || 5e-5);
  return Math.sqrt(pr.Kt * I * pr.p / jt) / (2 * Math.PI);
}

function jog(ctx) {
  if (st.run) ctx.world.command('jog', { speedMmS: st.dir * st.speed });
  else ctx.world.command('stop');
}

export default {
  id: 'microstepping', number: 2, title: 'Microstepping', short: 'Microstepping',
  takeaway: 'Microsteps make motion smoother and quieter by sharing the field between two coils, but they don\'t buy accuracy under load.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.05, min: 0.005, max: 1 },
  traceWindow: 0.1,
  stage: { primary: 'motor', secondary: 'gantry', split: 0.55 },
  // No DIAG LED and no stall announcements: StallGuard is chapter 4's topic.
  viewOptions: { motor: { fieldTrail: false }, gantry: { detailMm: 0.5, led: false } },
  hint: 'Change the microsteps and watch the field vector and the current waveforms. Stop, then press Single step to see one step.',

  scenario(motorType) {
    return {
      motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: 'current', mechanics: 'axis',
      microsteps: MICRO, interpolate: false, runCurrent: CURRENT_RMS * Math.SQRT2, start: { x: 100, y: 50 },
      loads: { drag: 0, torque: 0 },
    };
  },

  onEnter(ctx) {
    Object.assign(st, { micro: MICRO, interp: false, rms: CURRENT_RMS, speed: SPEED, drag: 0, run: true, dir: 1, trail: false });
    jog(ctx);
  },

  onEvent(ev) {
    return ev.type === 'stallDetected' ? false : undefined;
  },

  onFrame(ctx, snap) {
    if (!st.run) return;
    const x = snap.gantry.xCmd;
    if (st.dir > 0 && x > TURN_HI) { st.dir = -1; jog(ctx); }
    else if (st.dir < 0 && x < TURN_LO) { st.dir = 1; jog(ctx); }
  },

  controls() {
    return [
      { type: 'segmented', id: 'micro', label: 'Microsteps', value: st.micro, caption: 'microsteps', group: 'Driver',
        options: MICROSTEPS,
        onChange: (v, c) => { st.micro = v; c.world.set('microsteps', v); } },
      { type: 'toggle', id: 'interp', label: 'Interpolate to 256 microsteps', value: st.interp, caption: 'interpolate',
        group: 'Driver', onChange: (v, c) => { st.interp = v; c.world.set('interpolate', v); } },
      { type: 'slider', id: 'current', label: 'Run current', min: 0.35, max: 2.5, step: 0.05, value: st.rms,
        caption: 'run_current', group: 'Driver', format: formatRms,
        onChange: (v, c) => { st.rms = v; c.world.set('runCurrent', v * Math.SQRT2); } },
      { type: 'segmented', id: 'motion', label: 'Motion', value: st.run ? 'move' : 'stop', group: 'Motion',
        options: [{ value: 'move', label: 'Move' }, { value: 'stop', label: 'Stop' }],
        onChange: (v, c) => { st.run = v === 'move'; jog(c); } },
      { type: 'button', id: 'single', label: 'Single step', kind: 'primary', group: 'Motion',
        ariaLabel: 'Stop and send a single step pulse',
        onClick: (c) => {
          st.run = false;
          c.app.setControlValue('motion', 'stop');
          c.world.command('singleStep', { dir: 1 });
        } },
      { type: 'slider', id: 'speed', label: 'Speed', min: 0.1, max: 100, log: true, value: st.speed, group: 'Motion',
        format: (v) => `${formatValue(v)} mm/s`,
        onChange: (v, c) => { st.speed = v; if (st.run) jog(c); } },
      { type: 'slider', id: 'drag', label: 'Drag', min: 0, max: 0.3, step: 0.01, value: st.drag, unit: 'N·m',
        group: 'Motion', onChange: (v, c) => { st.drag = v; c.world.command('setLoad', { drag: v }); } },
      { type: 'toggle', id: 'trail', label: 'Field trail', value: st.trail, group: 'View',
        onChange: (v, c) => { st.trail = v; c.app.setViewOptions('motor', { fieldTrail: v }); } },
    ];
  },

  traces: [
    { name: 'stepN', group: 'digital', pulses: true, label: 'STEP', color: 'phase-a' },
    { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'phase-a', dashed: true },
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
    { name: 'iBStar', label: 'Phase B target', unit: 'A', color: 'phase-b', dashed: true },
    { name: 'iB', label: 'Phase B current', unit: 'A', color: 'phase-b' },
    { name: 'loadAngle', label: 'Load angle', unit: 'rad', color: 'axis-q', minSpan: 0.2 },
    { name: 'posCmd', label: 'Commanded position', unit: 'mm', color: 'target', dashed: true, minSpan: 0.4 },
    { name: 'posAct', label: 'Carriage position', unit: 'mm', color: 'phase-c', minSpan: 0.4 },
  ],

  readouts(snap, metrics, ctx) {
    const w = ctx.world;
    const n = scOf(w).microsteps || 16;
    const spm = stepsPerMm(w);
    const rate = st.speed * spm;
    const s = ringStats(w.traces.get('posErr#0'), STATS_S);
    const ripple = s.n ? (s.max - s.min) * 1000 : 0;
    // Lag from the load angle (field vs rotor, electrical rad), not from posErr: after a switch
    // out of full-step mode the planner's step grid sits half a full step from the driver's.
    const la = ringStats(w.traces.get('loadAngle#0'), STATS_S);   // reuses the scratch object
    const p = presetOf(w).p;
    const lag = la.n ? Math.abs(la.mean) / p * (w.rd || 40) / (2 * Math.PI) : 0;
    return [
      { label: 'Step rate needed', value: rate >= 1000 ? rate / 1000 : rate, unit: rate >= 1000 ? 'kHz' : 'Hz',
        title: 'Pulses per second the controller must send at this speed' },
      { label: 'Field per microstep', value: 90 / n, unit: '° electrical' },
      { label: 'Torque per microstep', value: 100 * Math.sin(Math.PI / 2 / n), unit: '% of holding',
        title: 'The pull toward a microstep one step away: holding torque × sin(90°/n)' },
      { label: 'Position ripple', value: ripple, unit: 'µm', title: 'Peak-to-peak wobble of the carriage around the commanded motion (last 50 ms)' },
      { label: 'Lag', value: lag * spm, unit: `microsteps (${formatValue(lag * 1000)} µm)`,
        title: 'How far the carriage trails the command (mean over the last 50 ms)' },
      { label: 'Ring frequency', value: ringHz(w, peakOf(w)), unit: 'Hz',
        title: '√(Kt·I·p/J)/2π: the rotor on the spring of the field, with this run current and carriage' },
    ];
  },

  text() {
    return '<p>Inside the motor, two coils (A and B) pull on the rotor. A <strong>full step</strong> switches the '
      + 'currents so the field jumps 90°, a quarter of the electrical cycle. The rotor snaps after it, overshoots '
      + 'and rings at the stepper\'s resonance, typically 100–300 Hz: the classic stepper buzz.</p>'
      + '<p><strong>Microstepping</strong> sets the two currents to the cosine and sine of the field angle, so the '
      + 'field turns in small angles instead of jumps. Smaller jumps, less vibration, quieter motion.</p>'
      + '<p>But the pull toward the next microstep is small, and it grows only with the distance from it. Friction '
      + 'or a load holds the rotor a few microsteps behind, and a slow rotor moves in bursts. More microsteps do '
      + 'not make it more accurate under load.</p>'
      + '<p>Drivers can <strong>interpolate</strong>: they take 16 microsteps from the controller and smooth them '
      + 'to 256 inside. Every microstep from the controller is a pulse to send, which is why 16 with interpolation '
      + 'is the usual setting.</p>';
  },

  tryThis: [
    'Pick 1 microstep and Stop, then press Single step: the field jumps 90° and the rotor rings.',
    'Move at 16 microsteps with interpolation off, then on: the current staircase becomes a smooth sine.',
    'At 256 microsteps, press Single step a few times: the rotor waits, then jumps. Add drag while moving and read the lag.',
  ],

  deeper(ctx) {
    const w = ctx.world;
    const pr = presetOf(w);
    const f = ringHz(w, pr.Irated);
    return '<p>The field advances 90°/n per microstep (n = microsteps). Four full steps make one electrical cycle, '
      + `and a 1.8° motor has ${pr.p} electrical cycles per turn.</p>`
      + '<p>The pull toward a microstep one step ahead is T<sub>hold</sub> × sin(90°/n): 9.8% of the holding torque '
      + 'at n = 16, but 0.6% at n = 256, less than the motor\'s own friction.</p>'
      + `<p>The rotor rings at f = √(Kt·I·p/J) / 2π: about ${Math.round(f)} Hz for this motor and carriage at `
      + `${formatValue(pr.Irated / Math.SQRT2)} A RMS. Less current or more mass lowers it.</p>`;
  },
};
