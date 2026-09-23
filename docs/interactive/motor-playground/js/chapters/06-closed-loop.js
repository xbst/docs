/**
 * Chapter 6: Open loop vs closed loop (SPEC 6.6).
 *
 * A CoreXY gantry prints a 100 mm square in a 350 mm frame, lap after lap (the path restarts
 * on every pathDone, like the next layer). The loop control swaps the driver between open
 * loop (current mode) and FOC with the optimal gains; the swap, like "Reprint", rebuilds the
 * world and starts the square again.
 *
 * Bump: a 0.6 N·m, 20 ms shove, always sideways to the motion (the world's directed CoreXY
 * bump, `dir`). Sideways, so the closed loop's dip shows as a path deviation and not only as
 * lag along the path. Measured at the defaults (2.5 A, 150 mm/s, 5000 mm/s²): open loop loses
 * 15–25 mm every time (the rotor is flung out of step and re-locks cycles later), FOC dips
 * about 1.5 mm and is back on the path within about 40 ms. From 3 A up the stepper holds the
 * bump; at 0.8 A and 20 000 mm/s² open loop skips with no bump at all while FOC keeps up.
 * 250 ms after a bump the chapter reads the trace rings, finds the largest sideways excursion,
 * holds the gantry's magnifier on it (a dip up to 6 mm; a slip is plain in the frame) and
 * announces how far the toolhead was pushed and when it was back.
 */
import { formatValue } from '../format.js';

const LEN = 350;
// Up and left of the middle, so the magnifier in the bottom-right corner stays clear of it.
const SQUARE = { start: [100, 150], points: [[200, 150], [200, 250], [100, 250], [100, 150]], laps: 1 };
const BUMP = { torque: 0.6, durationS: 0.02 };
const DEFAULTS = { loop: 'openloop', current: 2.5, speed: 150, accel: 5000, drag: 0 };
/** Sim time after a bump before its excursion is measured (s). */
const BUMP_LOOK_S = 0.25;
/** Largest excursion (mm) still shown as a dip in the magnifier. */
const DIP_MAX_MM = 6;
/** Sideways distance (mm) that counts as back on the path. */
const BACK_MM = 0.05;

let st = { ...DEFAULTS };
let pending = null;          // { t, dirX, dirY } of the bump being measured
let lost = { seen: 0, at: 0, told: 0 };

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Toolhead shift (mm) from the two belts' lost distances (belt A = x + y, B = x − y). */
function shiftMm(snap) {
  const lm = snap.gantry && snap.gantry.lostMm;
  if (!lm) return 0;
  const a = num(lm[0], 0), b = num(lm[1], 0);
  return Math.hypot((a + b) / 2, (a - b) / 2);
}

/** Smoothed current amplitude of motor i (A). */
function ampOf(world, snap, i) {
  const f = world.iAmpLpfOut;
  if (f && i < f.length) return f[i];
  const m = snap.motors[i];
  return m ? num(m.iAmp, 0) : 0;
}

/** Rebuild the world (new loop mode, or Reprint): the square starts again, the trail clears. */
function restart(c) {
  pending = null;
  lost = { seen: 0, at: 0, told: 0 };
  c.app.setViewOptions('gantry', { loupe: false, loupeCenter: null, clearTrail: true });
  c.app.reconfigure();
}

/** A shove sideways to the motion (to the left of it: toward the middle of the square). */
function bump(c) {
  const pl = c.world.snapshot && c.world.snapshot.planner;
  const vx = pl ? num(pl.vx, 0) : 0, vy = pl ? num(pl.vy, 0) : 0;
  const sp = Math.hypot(vx, vy);
  c.world.command('bump', { dir: sp > 1 ? [-vy / sp, vx / sp] : [-1, 0] });
}

/**
 * Largest sideways excursion after the pending bump, from the trace rings (CoreXY: #0 = x,
 * #1 = y; the rings are pushed together, so one index fits all four), up to where the
 * commanded path turns (after a corner the lag along the new direction would count as
 * sideways): { dev (mm), x, y (actual toolhead there), backMs (when it was last more than
 * BACK_MM off the path, ms after the bump), healed (back for at least 10 ms before the scan
 * ended) } or null when the rings are missing.
 */
function measure(world, p) {
  const map = world.traces;
  if (!map || !map.get) return null;
  const cx = map.get('posCmd#0'), cy = map.get('posCmd#1'), ax = map.get('posAct#0'), ay = map.get('posAct#1');
  if (!cx || !cy || !ax || !ay) return null;
  const n = Math.min(cx.len, cy.len, ax.len, ay.len);
  const t1 = p.t + BUMP_LOOK_S;
  let dev = 0, px = NaN, py = NaN, last = 0, end = 0, c0 = NaN;
  for (let i = 0; i < n; i++) {
    const k = (cx.head - n + i + cx.cap) % cx.cap;
    const t = cx.t[k];
    if (t < p.t || t > t1) continue;
    const side = cx.v[k] * p.dirX + cy.v[k] * p.dirY;
    if (c0 !== c0) c0 = side;
    else if (Math.abs(side - c0) > 0.01) break;         // the commanded path turned
    const d = (ax.v[k] - cx.v[k]) * p.dirX + (ay.v[k] - cy.v[k]) * p.dirY;
    if (d > dev) { dev = d; px = ax.v[k]; py = ay.v[k]; }
    if (Math.abs(d) > BACK_MM) last = t - p.t;
    end = t - p.t;
  }
  return Number.isFinite(px) ? { dev, x: px, y: py, backMs: last * 1000, healed: end - last >= 0.01 } : null;
}

export default {
  id: 'closed-loop', number: 6, title: 'Open loop vs closed loop', short: 'Closed loop',
  takeaway: 'An open-loop driver hopes the rotor followed. A closed-loop driver knows, and fixes it.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.5, min: 0.05, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: null },
  // A taller host than the gantry's default (the CoreXY frame is square) and a smaller loupe,
  // which clears the square on phones too.
  viewOptions: { gantry: { aspect: 0.8, loupe: false, loupeMm: 4, loupeAt: 'br', loupeSize: 0.15 } },

  scenario() {
    const foc = st.loop === 'foc';
    return {
      motorType: 'stepper', motorPreset: 'stepper', driver: foc ? 'foc' : 'openloop',
      driverMode: foc ? 'position' : 'current', mechanics: 'corexy', axisLength: LEN,
      start: { x: SQUARE.start[0], y: SQUARE.start[1] }, path: SQUARE,
      runCurrent: st.current, loads: { drag: st.drag, torque: 0 }, bump: BUMP,
      planner: { maxVelocity: st.speed, accel: st.accel, scv: 5, microsteps: 16, fullStepsPerRev: 200 },
    };
  },

  // scenario() runs before onEnter, so the chapter state is reset on leave.
  onLeave() {
    st = { ...DEFAULTS };
    pending = null;
    lost = { seen: 0, at: 0, told: 0 };
  },

  controls(ctx) {
    const foc = st.loop === 'foc';
    const keys = (ctx.product && ctx.product.keys) || {};
    const amps = (v) => `${formatValue(v, 1)} A (${formatValue(v / Math.SQRT2, 2)} rms)`;
    return [
      { type: 'segmented', id: 'loop', label: 'Loop', value: st.loop,
        options: [{ value: 'openloop', label: 'Open loop' }, { value: 'foc', label: 'Closed loop (FOC)' }],
        onChange: (v, c) => {
          st.loop = v;
          restart(c);
          c.app.refreshControls();
          c.app.refreshTraces();
          c.app.refreshText();
        } },
      { type: 'button', id: 'bump', label: 'Bump', kind: 'primary', ariaLabel: 'Bump the toolhead sideways',
        title: 'A short sideways shove on the toolhead, like the nozzle catching a blob', onClick: bump },
      { type: 'button', id: 'reprint', label: 'Reprint', ariaLabel: 'Start the square again', onClick: (c) => restart(c) },
      { type: 'slider', id: 'current', label: foc ? 'Current limit' : 'Run current', group: 'Driver',
        min: 0.5, max: 3.5, step: 0.1, value: st.current, format: amps,
        caption: foc ? keys.runCurrent : 'run_current',
        title: foc ? 'The most the driver may use; it uses only what the load needs'
          : 'Peak phase current, always on. Klipper\'s run_current is the rms value',
        onChange: (v, c) => { st.current = v; c.world.set('runCurrent', v); } },
      { type: 'slider', id: 'speed', label: 'Speed', group: 'Motion', min: 50, max: 300, step: 10, value: st.speed,
        unit: 'mm/s', onChange: (v, c) => { st.speed = v; c.world.set('planner.maxVelocity', v); } },
      { type: 'slider', id: 'accel', label: 'Acceleration', group: 'Motion', min: 1000, max: 20000, step: 500,
        value: st.accel, unit: 'mm/s²', onChange: (v, c) => { st.accel = v; c.world.set('planner.accel', v); } },
      { type: 'slider', id: 'drag', label: 'Drag', group: 'Motion', min: 0, max: 0.3, step: 0.01, value: st.drag,
        unit: 'N·m', title: 'Friction on both motors, like a stiff carriage',
        onChange: (v, c) => { st.drag = v; c.world.set('loads.drag', v); } },
    ];
  },

  traces() {
    const t = [
      { name: 'posCmd', motor: 0, label: 'Commanded X', unit: 'mm', color: 'target', dashed: true },
      { name: 'posAct', motor: 0, label: 'Actual X', unit: 'mm', color: 'phase-a' },
      { name: 'posErr', motor: 0, label: 'Error X', unit: 'mm', scale: 'err', color: 'axis-q' },
      { name: 'posErr', motor: 1, label: 'Error Y', unit: 'mm', scale: 'err', color: 'axis-d' },
      { name: 'iAmp', motor: 0, label: 'Current, motor A', unit: 'A', color: 'phase-b' },
      { name: 'torque', motor: 0, label: 'Torque, motor A', unit: 'N·m', color: 'phase-c' },
    ];
    if (st.loop === 'foc') {
      t.unshift(
        { name: 'encA', motor: 0, group: 'digital', label: 'Encoder A, motor A', short: 'ENC A', color: 'phase-a' },
        { name: 'encB', motor: 0, group: 'digital', label: 'Encoder B, motor A', short: 'ENC B', color: 'phase-b' },
      );
    }
    return t;
  },

  readouts(snap, metrics, ctx) {
    const foc = st.loop === 'foc';
    const g = snap.gantry;
    const err = Math.hypot(num(g.x, 0) - num(g.xCmd, 0), num(g.y, 0) - num(g.yCmd, 0));
    const shift = foc ? 0 : shiftMm(snap);
    const m0 = snap.motors[0], m1 = snap.motors[1];
    const amp = Math.max(ampOf(ctx.world, snap, 0), m1 ? ampOf(ctx.world, snap, 1) : 0);
    const heat = Math.max(num(m0.heat, 0), m1 ? num(m1.heat, 0) : 0);
    const items = [
      { label: 'Error', value: err, unit: 'mm', digits: 2, warn: err > 3,
        title: 'Distance between the toolhead and where Klipper commanded it right now' },
      { label: 'Lost', value: shift, unit: 'mm', digits: 1, warn: shift >= 0.05, ok: foc,
        title: foc ? 'A closed loop cannot lose steps: it corrects from the encoder'
          : 'How far the print has shifted because the rotors slipped' },
      { label: 'Current', value: amp, unit: 'A', digits: 2,
        title: 'Phase current amplitude, the larger of the two motors' },
      { label: 'Heat', value: 100 * heat, unit: '% of rated', digits: 0, warn: heat > 0.8,
        title: 'Copper loss compared with running at the rated current, averaged over the last second' },
    ];
    if (foc && m0.encoder) {
      items.push({ label: 'Encoder A', value: String(m0.encoder.count), unit: 'counts',
        title: 'Motor A\'s encoder position: 4000 counts per turn' });
    }
    return items;
  },

  onEvent(ev, ctx) {
    switch (ev.type) {
      case 'pathDone':
        // Next layer: the same square again from the commanded start.
        ctx.world.command('runPath', { path: SQUARE });
        return false;
      case 'bump': {
        const d = ev.data || {};
        pending = { t: num(ev.t, 0), dirX: num(d.dirX, -1), dirY: num(d.dirY, 0) };
        return false;
      }
      case 'stepLost':
        lost.at = num(ev.t, 0);
        return false;                    // announced once the slip is over (onFrame)
      case 'stallDetected':
        return false;                    // StallGuard is chapter 4's topic
      case 'contact':
        return 'The toolhead ran into the frame';
      default:
        return undefined;
    }
  },

  onFrame(ctx, snap) {
    const t = num(snap.t, 0);
    // A slip is over once no step was lost for 150 ms: announce the new shift once.
    if (st.loop !== 'foc') {
      const s = shiftMm(snap);
      if (Math.abs(s - lost.seen) > 0.01) { lost.seen = s; lost.at = t; }
      if (t - lost.at > 0.15 && Math.abs(lost.seen - lost.told) >= 0.4) {
        lost.told = lost.seen;
        ctx.app.announce(`Steps lost: the print is now shifted ${formatValue(lost.seen, 1)} mm`);
      }
    }
    if (!pending || t < pending.t + BUMP_LOOK_S) return;
    const p = pending;
    pending = null;
    const r = measure(ctx.world, p);
    if (!r || !(r.dev >= 0.1) || r.dev > DIP_MAX_MM) {
      ctx.app.setViewOptions('gantry', { loupe: false, loupeCenter: null });
      return;
    }
    // Magnifier on the dip: centered halfway between the path and the farthest point.
    const mm = Math.min(8, Math.max(2.5, r.dev * 1.25 + 1.2));
    ctx.app.setViewOptions('gantry', {
      loupe: true, loupeMm: mm, loupeLabel: 'bump',
      loupeCenter: { x: r.x - p.dirX * r.dev / 2, y: r.y - p.dirY * r.dev / 2 },
    });
    if (r.healed) {
      ctx.app.announce(`Bump: pushed ${formatValue(r.dev, 1)} mm off the path, back on it after ${Math.round(r.backMs)} ms`);
    }
  },

  hint: () => (st.loop === 'foc'
    ? 'Closed loop: press Bump, then look at the magnifier in the corner. Reprint starts the square again.'
    : 'Open loop: press Bump and watch the square shift. Reprint starts the square again.'),

  text: () => '<p>An open-loop driver moves the field and hopes the rotor follows. It does, as long as the move '
    + 'needs less torque than the run current can make. A bump, a blob or too much acceleration for the current '
    + 'pulls the rotor out of step: it slips by whole electrical cycles (four full steps, 0.8&nbsp;mm of belt each), '
    + 'often many at once. The driver can\'t see it, Klipper can\'t either, and every later layer prints shifted. '
    + 'The fixes are blunt: more current, less acceleration.</p>'
    + '<p>A closed-loop driver reads an encoder on the motor shaft thousands of times a second. It compares where '
    + 'the rotor is with where Klipper asked it to be and corrects the difference, so a bump becomes a dip that '
    + 'heals. It also draws only the current the load needs, so the motors run cooler. Chapter 7 shows how it '
    + 'makes that correction.</p>',

  tryThis: [
    'In open loop, press <b>Bump</b>: the square shifts and stays shifted.',
    'Switch to <b>Closed loop</b> and press <b>Bump</b>: the magnifier shows the dip and how it heals. '
      + 'Compare the <b>Current</b> and <b>Heat</b> readouts with open loop.',
    'Set the current to 0.8&nbsp;A and the acceleration to 20&nbsp;000&nbsp;mm/s² in both modes: open loop skips '
      + 'on its own, closed loop keeps up. Then add drag.',
  ],

  deeper: () => '<p>Why whole cycles? The rotor locks to the field in one position per electrical cycle, 50 per '
    + 'turn on a 1.8° motor. A slipped rotor falls into another one, a multiple of 0.8&nbsp;mm away, and at speed '
    + 'it can slide many before it catches up.</p>'
    + '<p>Why does the closed loop trail the command while moving? Its position loop turns the error into a speed '
    + 'demand, so it needs a small error to ask for speed: about 0.9&nbsp;mm at 150&nbsp;mm/s here. The lag is '
    + 'the same on every layer, so nothing shifts; many drives add feed-forward to shrink it. The encoder here '
    + 'reads 4000 counts per turn, 0.01&nbsp;mm of belt each.</p>',
};
