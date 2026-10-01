/**
 * Chapter 6: Open loop vs closed loop (SPEC 6.6).
 *
 * A CoreXY gantry prints a 100 mm square in a 350 mm frame, lap after lap (the path restarts
 * on every pathDone, like the next layer). The loop control swaps the driver between open
 * loop (current mode) and FOC with the optimal gains; the swap, like "Reprint", rebuilds the
 * world and starts the square again.
 *
 * Current: open loop slides the run current in A RMS like Klipper's `run_current` (the world
 * gets the peak, × √2); closed loop slides the current limit as a peak, the unit FOC drivers
 * use. The chapter keeps one current, as a peak, and snaps it to the other slider's grid when
 * the loop changes, so both loops start from the same current.
 *
 * Bump: a 0.45 N·m, 20 ms shove, always sideways to the motion (the world's directed CoreXY
 * bump, `dir`). Sideways, so the closed loop's dip shows as a path deviation and not only as
 * lag along the path. Sized for the stepper's 0.1556 N·m per peak amp: a 20 ms half-sine slips
 * it from about 0.9 times its holding torque (0.35 N·m slips 9 of 10 bumps at the default
 * current), which is 0.385 N·m at the default 1.75 A RMS (2.47 A peak) and 0.55 N·m at the top of
 * the slider. Measured at the defaults (150 mm/s, 5000 mm/s²), ten bumps a run, the same at 24
 * and 48 V (at 150 mm/s neither loop is short of voltage; re-measured with the open-loop back-EMF
 * feed-forward of 2026-10-01, 30 ms): open loop slips every time, the rotors flung out of step
 * and re-locked cycles later, 19 to 75 mm of shift per bump in whole 0.8 mm cycles per belt;
 * 2.0 A RMS still slips every time, 2.25 and 2.5 A RMS hold every bump (dips of 0.15 and
 * 0.13 mm, back after 16 ms). FOC at the default 2.5 A peak dips 1.2 to 1.4 mm and is back on
 * the path 38 to 43 ms after the bump (2.1 A peak: 2.2 to 2.3 mm and 52 to 55 ms; 3 A: 0.7 mm).
 * 250 ms after a bump the chapter reads the trace rings, finds the largest sideways excursion,
 * holds the gantry's magnifier on it (a dip up to 6 mm) and announces how far the toolhead was
 * pushed and when it was back. A bump that lost steps in those 250 ms (a stepLost event) gets
 * neither: the slip is plain in the frame, and a slip along the path, or one that undoes an
 * earlier slip, can look like a small sideways dip that healed.
 *
 * Without a bump, open loop at the default current skips at the next corner once the
 * acceleration is 40 000 mm/s² (4 to 48 mm lost; 30 000 and 35 000 hold over two laps; 2.5 A RMS
 * holds even 100 000 mm/s²), and 0.3 N·m of drag slips it at the corners (0.28 holds); FOC
 * keeps up in both (error at most 1.1 mm; its lag at 150 mm/s is 0.80 mm). Current and Heat at
 * 150 mm/s: open loop 2.45 to 2.53 A and 46 to 49% at any drag; FOC 0.02 to 0.39 A and 0%
 * without drag, about 1.4 A and 16% at 0.2 N·m, about 2.1 A and 33% at 0.3 N·m. Lower run
 * currents skip at lower accelerations (1.0 A RMS at 20 000 mm/s², 1.5 A RMS at 30 000 mm/s²).
 *
 * Bus voltage: 24 or 48 V (48 V by default), kept in the chapter state, so a loop switch or
 * Reprint keeps it; `world.set('supplyV')` applies it without a rebuild.
 *
 * Speed and acceleration (B-009, 2026-10-01): the sliders reach 1000 mm/s and 100 000 mm/s²,
 * past what printers run, so the limits show. Measured over 5 s of the square at the default
 * current: open loop holds 1000 mm/s at 5000 and 20 000 mm/s² on both buses (a 100 mm side at
 * 5000 mm/s² never gets past about 700 mm/s) and slips at every speed at 100 000 mm/s². The
 * closed loop never loses steps; it trails by speed / (2π·fx), 0.81 mm at 150 mm/s, 3.2 mm at
 * 600 mm/s, 4.8 mm at 900 mm/s, and it cruises steadily: belt speeds within 1% of the command
 * and Id under 0.25 A at 900 and 1000 mm/s on 48 V and at 900 mm/s on 24 V (20 000 mm/s²;
 * before the FOC retune of 2026-10-01 the stepper hunted at about 100 Hz there, ±7% and Id up
 * to 1.1 A; a regression test checks it). On 24 V it runs short of voltage from about 900 mm/s
 * (at the limit 23% of the time at 940 mm/s and 20 000 mm/s², 32% at 880 mm/s and
 * 100 000 mm/s²) and trails 7.8 mm at 1000 mm/s and 20 000 mm/s², 22 mm at 1000 mm/s and
 * 100 000 mm/s². On 48 V the voltage lasts to 1000 mm/s
 * (5.3 mm, the lag, at 20 000 mm/s²; 6.8 mm at 100 000 mm/s²). At 100 000 mm/s² the default
 * 2.5 A cannot give the 0.54 N·m the commanded acceleration needs, so after each corner the
 * motors catch up, overshoot the speed into the voltage limit for 20 to 30 ms (Id swings up to
 * 2.5 A) and then cruise cleanly; Heat 16% at 1000 mm/s and 100 000 mm/s² on 48 V (2% at
 * 20 000 mm/s²). Wherever the voltage runs out while a motor brakes, the model's current can
 * pass the limit for a few milliseconds (the d axis takes the whole voltage circle first): Iq
 * up to 4 A against 2.5 A at 1000 mm/s on 24 V, up to 5.4 A at 1000 mm/s and 100 000 mm/s² on
 * 48 V (reported as a sim issue). Worst cases over the slider grid (both buses, 720 settings, no
 * frame contact anywhere): at the lowest current limit, 0.5 A peak, and 1000 mm/s the motors
 * cannot follow the corners and swing wide of the square on a repeating path that trails by up
 * to 176 mm and on 48 V passes 7.3 mm from the frame (at 30 000 mm/s²; the same over 300 s; 40
 * runs with the settings changed mid-lap came no closer than 10.9 mm); a current limit too weak
 * for the drag (Kt·I under 0.02 N·m plus the drag, as 0.5 A with 0.1 N·m or 1.5 A with
 * 0.3 N·m) leaves the toolhead creeping near the start while the command laps, trailing by up to
 * the square's diagonal, and it catches up slowly once the command stops.
 */
import { formatValue, formatRms, formatPeak } from '../format.js';
import { TUNING } from '../sim/drivers/foc.js';

const LEN = 350;
// Up and left of the middle, so the magnifier in the bottom-right corner stays clear of it.
const SQUARE = { start: [100, 150], points: [[200, 150], [200, 250], [100, 250], [100, 150]], laps: 1 };
const BUMP = { torque: 0.45, durationS: 0.02 };
/** Current sliders: open loop in A RMS, closed loop in A peak. */
const RMS = { min: 0.35, max: 2.5, step: 0.05 };
const PEAK = { min: 0.5, max: 3.5, step: 0.1 };
const DEFAULTS = { loop: 'openloop', current: 1.75 * Math.SQRT2, speed: 150, accel: 5000, drag: 0, bus: 48 };
/** Sim time after a bump before its excursion is measured (s). */
const BUMP_LOOK_S = 0.25;
/** Largest excursion (mm) still shown as a dip in the magnifier. */
const DIP_MAX_MM = 6;
/** Sideways distance (mm) that counts as back on the path. */
const BACK_MM = 0.05;

let st = { ...DEFAULTS };
let pending = null;          // { t, dirX, dirY, slipped } of the bump being measured
let lost = { seen: 0, at: 0, told: 0 };

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** v on a slider's grid (rounded to its step, clamped to its range). */
const onGrid = (v, s) => Math.min(s.max, Math.max(s.min, +(Math.round(v / s.step) * s.step).toFixed(2)));

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
  takeaway: 'An open-loop driver hopes the rotor followed; a closed-loop driver knows, and fixes it.',
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
      start: { x: SQUARE.start[0], y: SQUARE.start[1] }, path: SQUARE, supplyV: st.bus,
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
    return [
      { type: 'segmented', id: 'loop', label: 'Loop', value: st.loop,
        options: [{ value: 'openloop', label: 'Open loop' }, { value: 'foc', label: 'Closed loop (FOC)' }],
        onChange: (v, c) => {
          st.loop = v;
          // The same current on the new slider's grid (RMS in open loop, peak in closed loop).
          st.current = v === 'foc' ? onGrid(st.current, PEAK) : onGrid(st.current / Math.SQRT2, RMS) * Math.SQRT2;
          restart(c);
          c.app.refreshControls();
          c.app.refreshTraces();
          c.app.refreshText();
        } },
      { type: 'button', id: 'bump', label: 'Bump', kind: 'primary', ariaLabel: 'Bump the toolhead sideways',
        title: 'A short sideways shove on the toolhead, like the nozzle catching a blob', onClick: bump },
      { type: 'button', id: 'reprint', label: 'Reprint', ariaLabel: 'Start the square again', onClick: (c) => restart(c) },
      foc
        ? { type: 'slider', id: 'currentLimit', label: 'Current limit', group: 'Driver', ...PEAK,
          value: st.current, format: formatPeak, caption: keys.runCurrent,
          title: 'The most the driver may use; it uses only what the load needs',
          onChange: (v, c) => { st.current = v; c.world.set('runCurrent', v); } }
        : { type: 'slider', id: 'runCurrent', label: 'Run current', group: 'Driver', ...RMS,
          value: +(st.current / Math.SQRT2).toFixed(2), format: formatRms, caption: 'run_current',
          title: 'The driver pushes this current all the time, whatever the load',
          onChange: (v, c) => { st.current = v * Math.SQRT2; c.world.set('runCurrent', st.current); } },
      { type: 'segmented', id: 'bus', label: 'Bus voltage', value: st.bus, group: 'Driver',
        options: [{ value: 24, label: '24 V' }, { value: 48, label: '48 V' }],
        title: 'The driver\'s supply: a faster move needs more voltage (chapter 5)',
        onChange: (v, c) => { st.bus = v; c.world.set('supplyV', v); } },
      { type: 'slider', id: 'speed', label: 'Speed', group: 'Motion', min: 50, max: 1000, step: 1, sig: 2, log: true, value: st.speed,
        unit: 'mm/s', onChange: (v, c) => { st.speed = v; c.world.set('planner.maxVelocity', v); } },
      { type: 'slider', id: 'accel', label: 'Acceleration', group: 'Motion', min: 1000, max: 100000, step: 1, sig: 2, log: true,
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
      // Symmetric even after a slip leaves the errors one-sided: "5 to 20 mm" after "±20 mm" added a
      // legend row seconds after Bump (B-006), and an error reads best against the center line. Room
      // for "±100 mm", as long as "±250 mm" and "±500 mm": a shifted print (about 200 mm at most) or
      // the closed loop at 0.5 A and 1000 mm/s (up to 176 mm on 48 V) passes ±50 mm while it runs
      // (B-009).
      { name: 'posErr', motor: 0, label: 'Position error X', unit: 'mm', scale: 'err', color: 'err', range: 'sym', scaleChars: 7 },
      { name: 'posErr', motor: 1, label: 'Position error Y', unit: 'mm', scale: 'err', color: 'axis-d', range: 'sym', scaleChars: 7 },
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
    // Values keep room for what a bump or a slip makes of them (12.57 mm, 100%), so the chip rows
    // stay put after Bump (B-006). The error drops a decimal from 10 mm and another from 100 mm, the
    // shift its decimal from 100 mm, so both stay within that room up to the frame's size: a slipped
    // print shifts up to about 200 mm, and the closed loop at 0.5 A peak and 1000 mm/s trails by up
    // to 176 mm.
    const errDigits = err < 9.995 ? 2 : err < 99.95 ? 1 : 0;
    const items = [
      { label: 'Position error', value: err, unit: 'mm', digits: errDigits, warn: err > 3, minChars: 5,
        title: 'Distance between the toolhead and where Klipper commanded it right now' },
      { label: 'Lost', value: shift, unit: 'mm', digits: shift < 99.95 ? 1 : 0, warn: shift >= 0.05, ok: foc, minChars: 4,
        title: foc ? 'A closed loop cannot lose steps: it corrects from the encoder'
          : 'How far the print has shifted because the rotors slipped' },
      { label: 'Current', value: amp, unit: 'A peak', digits: 2,
        title: 'Phase current amplitude, the larger of the two motors' },
      { label: 'Heat', value: 100 * heat, unit: '% of rated', digits: 0, warn: heat > 0.8, minChars: 4,
        title: 'Copper loss compared with running at the rated current, averaged over the last second' },
    ];
    if (foc && m0.encoder) {
      items.push({ label: 'Encoder A', value: String(m0.encoder.count), unit: 'counts', minChars: 5,
        title: 'Motor A\'s encoder position: 4000 counts per turn' });
    }
    return items;
  },

  // The longest announcement (onFrame's bump result), so the readouts row keeps room for it (B-008).
  announceSample: 'Bump: pushed 8.8 mm off the path, back on it after 888 ms',

  onEvent(ev, ctx) {
    switch (ev.type) {
      case 'pathDone':
        // Next layer: the same square again from the commanded start.
        ctx.world.command('runPath', { path: SQUARE });
        return false;
      case 'bump': {
        const d = ev.data || {};
        pending = { t: num(ev.t, 0), dirX: num(d.dirX, -1), dirY: num(d.dirY, 0), slipped: false };
        return false;
      }
      case 'stepLost':
        lost.at = num(ev.t, 0);
        if (pending) pending.slipped = true;  // a slip, not a dip: no magnifier, no heal
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
    // A slip is over once no step was lost for 150 ms: announce the new shift once. A slip that
    // undoes an earlier one leaves no shift (the belts lose whole 0.8 mm cycles, so a nonzero
    // shift is at least 0.57 mm; 0.05 mm is the Lost readout's warn threshold): say so instead.
    if (st.loop !== 'foc') {
      const s = shiftMm(snap);
      if (Math.abs(s - lost.seen) > 0.01) { lost.seen = s; lost.at = t; }
      if (t - lost.at > 0.15 && Math.abs(lost.seen - lost.told) >= 0.4) {
        lost.told = lost.seen;
        ctx.app.announce(lost.seen < 0.05 ? 'Steps lost again: the print is back in place'
          : `Steps lost: the print is now shifted ${formatValue(lost.seen, 1)} mm`);
      }
    }
    if (!pending || t < pending.t + BUMP_LOOK_S) return;
    const p = pending;
    pending = null;
    const r = measure(ctx.world, p);
    if (!r || p.slipped || !(r.dev >= 0.1) || r.dev > DIP_MAX_MM) {
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
    + 'often many at once. The driver can\'t see it and never talks back (chapter 1), so Klipper can\'t either, '
    + 'and every later layer prints shifted. The fixes are blunt: more current, less acceleration.</p>'
    + '<p>A closed-loop driver reads an encoder on the motor shaft thousands of times a second. It compares where '
    + 'the rotor is with where Klipper asked it to be and corrects the difference, so a bump becomes a dip that '
    + 'heals. It also draws only the current the load needs, so the motors run cooler. Chapter 7 shows how it '
    + 'makes that correction.</p>',

  tryThis: [
    'In open loop, press <b>Bump</b>: the square shifts and stays shifted.',
    'Switch to <b>Closed loop</b> and press <b>Bump</b>: the magnifier shows the dip healing. Compare '
      + '<b>Current</b> and <b>Heat</b> with open loop, with and without drag.',
    'Raise the acceleration to 40,000&nbsp;mm/s²: open loop skips on its own. Switch to closed loop: it keeps up.',
  ],

  // The 24 V sentence names its bus, so it holds whichever bus is selected (measured: the closed
  // loop runs short of voltage from 880 to 940 mm/s on 24 V, and not below 1000 mm/s on 48 V).
  deeper: () => '<p>Why whole cycles? The rotor locks to the field once per electrical cycle, 50 times per turn on '
    + 'a 1.8° motor, so a slipped rotor lands a multiple of 40&nbsp;mm / 50 = 0.8&nbsp;mm of belt away.</p>'
    + '<p>Why does the closed loop trail? Its position loop asks for a speed of P × error, so at '
    + `150&nbsp;mm/s the error is 150 / P = 150 / (2π × ${TUNING.fx}&nbsp;Hz) ≈ `
    + `${formatValue(150 / (2 * Math.PI * TUNING.fx), 2)}&nbsp;mm. The lag is the same on every layer, so nothing `
    + 'shifts; many drives add feed-forward to shrink it. On a 24&nbsp;V bus the motor runs out of voltage from '
    + 'about 900&nbsp;mm/s (chapter 5) and lags far more. The encoder reads 4000 counts per turn, 0.01&nbsp;mm of '
    + 'belt each.</p>',
};
