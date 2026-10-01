/**
 * Chapter 4: StealthChop, SpreadCycle and StallGuard (SPEC 6.4).
 *
 * The carriage shuttles between 20 and 80 mm on a belt axis with a hard stop
 * at 0 mm. The open-loop driver runs in the reader's mode: voltage
 * (StealthChop-like), current (SpreadCycle-like) or hybrid (switches at the
 * stealthchop_threshold speed). "Home toward the stop" first brings the
 * carriage to rest (Klipper finishes the moves in progress before G28), then
 * runs the world's homing machine on the StallGuard DIAG output with a gentle
 * 500 mm/s² ramp. Like Klipper on a TMC2209, whose StallGuard only works in
 * StealthChop, the homing move itself runs in voltage mode; the reader's mode
 * comes back at the trigger, before the retract. After homing the carriage
 * stays parked until the reader presses "Run back and forth" or changes a
 * driver or motion setting. A run or a homing that starts after steps were
 * lost (a StealthChop stall, a homing that slammed the stop) resets the axis
 * first: the model does not re-home the position, and a homing from a rotor
 * still shaken by a stall false-triggers at any threshold.
 *
 * Why the gentle ramp: in voltage mode the current sags while the motor
 * accelerates, and at the planner's 5000 mm/s² that dip alone pulls the
 * StallGuard reading under a mid-range threshold whenever the axis has some
 * drag, from rest or not. At 500 mm/s² the result depends on the threshold
 * and the load, not on what the carriage did before.
 *
 * The scope shows either the currents or the StallGuard signals (the
 * "Scope" control; homing switches it to StallGuard).
 *
 * Run current is set in A rms, like Klipper's run_current for TMC drivers;
 * the world gets the peak phase current (× √2).
 *
 * Deviation from SPEC 6.4 (agreed with the user, recorded in STATUS.md): no
 * noise trace and no noise-index readout. The averaged model has no chopper
 * ripple, and its noise signal (the high-passed current error) is dominated
 * by StealthChop's phase lag; in switching fidelity the StealthChop PWM
 * ripples more than the SpreadCycle chopper. Neither can show "StealthChop
 * is quiet", so the text explains the hiss instead.
 *
 * Calibration (2026-09-28, 1.5 A rms = 2.12 A peak, homing from rest at 40
 * mm/s with a 500 mm/s² ramp in voltage mode, fresh axis or after running):
 * with the default drag of 0.02 N·m driver_SGTHRS ≤ 40 never detects the stop
 * (the carriage slams and the motor skips) and 50 to 255 stop at contact (0.6
 * to 0.1 mm into the belt; 100 stops 0.48 mm in); with drag 0.2 N·m 50 to 100
 * still stop at contact while 150 to 255 false-trigger. The model's reading
 * has no noise, so a false trigger needs load. 5 mm/s never detects (below
 * the 10 mm/s minimum). StealthChop on the shuttle (accel 5000) holds up to
 * 115 mm/s once running and falls out of step from 125 mm/s (at 120 it slips
 * cycles and recovers). A start from rest (after Home, or after about 20 ms
 * at rest) holds 85 and slips at 90, but with drag 0.05 it already slips at
 * 75: hence the defaults of 80 mm/s and 0.02 N·m. A start at t = 0 of a fresh
 * world is luckier (it holds 95): the driver's reset leaves the measured
 * current at 0, so the amplitude loop winds the voltage up while the current
 * rises. Hybrid and SpreadCycle hold 200. With 0.1 N·m of drag or more,
 * StealthChop slips a few steps on the shuttle too. The chapter's 0.25 N·m
 * bump pulls the reading down to between about 80 and 510, depending on where
 * in the stroke it lands, without skipping a step.
 *
 * The speed and acceleration sliders reach past what printers run, 1000 mm/s
 * and 100 000 mm/s² (B-009, 2026-10-01): SpreadCycle holds the shuttle up to
 * 600 mm/s at 20 000 mm/s² and falls out of step at 1000 mm/s, or at 600 mm/s
 * with 100 000 mm/s²; Hybrid slips a little earlier. The bus stays at 24 V:
 * StealthChop and this StallGuard are TMC2209 features (a driver for up to
 * 29 V), and 48 V changed nothing on the shuttle.
 */
import { formatValue, formatRms } from '../format.js';

const SQRT2 = Math.SQRT2;
/** Shuttle ends (mm). */
const NEAR = 20, FAR = 80;
/** Retract after a homing trigger (mm). */
const RETRACT_MM = 10;
/** Homing ramp (mm/s²), see the header. */
const HOMING_ACCEL = 500;
/** StallGuard minimum speed (mm/s), the world's stallguard.minSpeedMmS. */
const MIN_SPEED = 10;
/** Distance from the stop (mm) beyond which a homing below MIN_SPEED gets the slow-homing hint. */
const SLOW_HINT_MM = 15;
/** Lost distance (mm) that counts as a lost position (the gantry view shows it from 0.05 mm). */
const LOST_MM = 0.05;
/** Bump for this chapter: a knock StallGuard notices without skipping a step at the default current. */
const BUMP = { torque: 0.25, durationS: 0.04 };
/**
 * How long after a homing ends its slam's last stepLost events can still arrive (s of sim time):
 * the world sends at most one per 50 ms, and the last came up to 0.057 s after the end.
 */
const SLAM_TRAIL_S = 0.1;
/** The chapter's time-scale range (the toolbar slider's range). */
const TIME_SCALE = Object.freeze({ default: 0.25, min: 0.01, max: 1 });
const MODE_NAME = { voltage: 'StealthChop', current: 'SpreadCycle' };
const MODE_KEY = { voltage: 'stealthchop_threshold: 999999', current: 'stealthchop_threshold: 0' };

const DEFAULTS = Object.freeze({
  mode: 'voltage', threshold: 60, speed: 80, accel: 5000, rms: 1.5, drag: 0.02,
  sgthrs: 100, homingSpeed: 40, scope: 'current',
});

/** Chapter state; reset in onLeave (scenario() runs before onEnter). */
let st = freshState();

function freshState() {
  return Object.assign({}, DEFAULTS, {
    homing: false,     // "Home" pressed: stopping first, then the world's homing machine (approach, retract)
    pending: false,    // waiting for the carriage to stop before the homing move starts
    forced: false,     // the driver was switched to voltage mode for the homing move
    result: null,      // last homing: { kind: 'running'|'ok'|'false-trigger'|'no-edge'|'canceled', xMm, pressInMm, slow }
    homeSpeed: DEFAULTS.homingSpeed, // speed of the homing move started last (mm/s); the slider applies from the next Home
    homingEndT: -Infinity, // sim time the last homing ended; its slam's trailing stepLost events go unannounced
    slowHint: '',      // the slow-homing hint shown: '' none, 'raise' (advises a faster time scale), 'max'
    lostAt: -Infinity, // performance.now() of the last "fell out of step" announcement
  });
}

const fmt = (v, d) => formatValue(v, d);

/* ---------------- world helpers ---------------- */

function lostMm(world) {
  const s = world.snapshot;
  return s && s.gantry ? s.gantry.lostMm[0] || 0 : 0;
}

function startShuttle(ctx) {
  const w = ctx.world;
  const y = w.snapshot.planner.y;
  w.command('runPath', { path: { points: [[FAR, y], [NEAR, y]], laps: 50 } });
}

/** Put the reader's driver mode back after the homing move. */
function restoreMode(ctx) {
  if (!st.forced) return;
  st.forced = false;
  ctx.world.set('driverMode', st.mode);
}

/**
 * Get the carriage moving back and forth. `force`: restart even when it is
 * already moving (the Run button; it also cancels a homing). Otherwise only a
 * parked carriage starts, so a slider drag does not restart the path.
 */
function run(ctx, force) {
  const w = ctx.world;
  st.homingEndT = -Infinity;       // a reconfigure below restarts sim time
  let canceled = false;
  if (st.homing) {
    if (!force) return;
    restoreMode(ctx);
    st.homing = false;
    st.pending = false;
    // A homing still on its way to the stop is canceled; one past its trigger keeps its result.
    if (st.result && st.result.kind === 'running') { st.result = { kind: 'canceled' }; canceled = true; }
    slowHint(ctx, 0);              // onFrame no longer sees this homing end: drop its hint here
  }
  const lost = lostMm(w);
  if (Math.abs(lost) >= LOST_MM) {
    // Open loop never finds its position again: start over from a fresh axis.
    ctx.app.reconfigure();
    ctx.app.announce(`${canceled ? 'Homing canceled. ' : ''}Axis reset: the motor had lost ${fmt(Math.abs(lost), 1)} mm`);
    startShuttle(ctx);
    return;
  }
  if (canceled) ctx.app.announce('Homing canceled: the carriage runs back and forth again');
  if (force || w.snapshot.planner.mode === 'idle') startShuttle(ctx);
}

/** "Home toward the stop": bring the carriage to rest first, like Klipper before G28. */
function home(ctx) {
  const w = ctx.world;
  restoreMode(ctx);                // a homing already running: its forced mode ends here
  slowHint(ctx, 0);                // and its hint; startHoming shows the new homing's own
  st.homing = true;
  st.homingEndT = -Infinity;       // a reconfigure below restarts sim time
  st.result = { kind: 'running' };
  setScope(ctx, 'stallguard');
  const lost = lostMm(w);
  if (Math.abs(lost) >= LOST_MM) {
    ctx.app.reconfigure();         // a fresh axis at rest (see the header)
    ctx.app.announce(`Axis reset: the motor had lost ${fmt(Math.abs(lost), 1)} mm`);
  }
  if (w.snapshot.planner.mode === 'idle') { startHoming(ctx); return; }
  st.pending = true;
  w.command('stop');               // ramped; onFrame starts the homing move once the carriage rests
}

function startHoming(ctx) {
  const w = ctx.world;
  st.pending = false;
  if (w.snapshot.driverMode !== 'voltage') {
    // Klipper puts a TMC2209 in StealthChop for the homing move: its StallGuard only works there.
    st.forced = true;
    w.set('driverMode', 'voltage');
  }
  st.homeSpeed = st.homingSpeed;
  w.command('home', { speedMmS: st.homeSpeed, retractMm: RETRACT_MM, passes: 1, accelMmS2: HOMING_ACCEL });
  slowHint(ctx, w.snapshot.gantry.x);
}

/**
 * Shows, updates or clears the slow-homing hint. While the homing runs below StallGuard's minimum
 * speed (st.homeSpeed, the speed it started with) and the carriage is more than SLOW_HINT_MM from
 * the stop, the hint gives the motor time the approach needs from `farMm`, plus the advice to
 * fast-forward while the time scale is below the chapter's maximum. Otherwise a hint shown is
 * cleared: pass 0 when the homing ends or is replaced.
 */
function slowHint(ctx, farMm) {
  if (st.homeSpeed < MIN_SPEED && farMm > SLOW_HINT_MM) {
    const atMax = ctx.app.timeScale >= TIME_SCALE.max;
    st.slowHint = atMax ? 'max' : 'raise';
    ctx.app.setHint(`At ${st.homeSpeed} mm/s the carriage needs ${fmt(farMm / st.homeSpeed, 0)} s of motor time `
      + (atMax ? 'to reach the stop.' : 'to reach the stop: raise the time scale to fast-forward.'));
  } else if (st.slowHint) {
    st.slowHint = '';
    ctx.app.setHint(null);
  }
}

function setScope(ctx, s) {
  if (st.scope === s) return;
  st.scope = s;
  ctx.app.setControlValue('scope', s);
  ctx.app.refreshTraces();
}

/* ---------------- traces ---------------- */

const DIAG = { name: 'diag', group: 'digital', label: 'DIAG', color: 'err' };
const CURRENT_TRACES = [
  DIAG,
  { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'target', dashed: true },
  { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
  { name: 'iAmp', label: 'Current amplitude', unit: 'A', color: 'phase-b' },
  { name: 'vAmp', label: 'Voltage amplitude', unit: 'V', color: 'phase-c' },
];
const SG_TRACES = [
  DIAG,
  { name: 'sg', label: 'StallGuard reading', scale: 'sg', color: 'phase-b', range: [0, 1023] },
  { name: 'sgThreshold', label: 'DIAG threshold (2 × SGTHRS)', scale: 'sg', color: 'err', dashed: true },
  { name: 'velCmd', label: 'Commanded speed', unit: 'mm/s', color: 'target', dashed: true },
  { name: 'velAct', label: 'Actual speed', unit: 'mm/s', color: 'phase-c' },
];

/* ---------------- readouts ---------------- */

/** The longest homing result, "stopped 0.48 mm into the stop": its room is kept from the start (B-006). */
const RESULT_CHARS = 29;

function resultChip(snap) {
  const r = st.result;
  if (!r) return { label: 'Homing', value: 'not run yet', minChars: RESULT_CHARS };
  switch (r.kind) {
    case 'running':
      return { label: 'Homing', value: st.pending ? 'stopping first…' : snap.homing.contact ? 'at the stop…' : 'moving to the stop…',
        minChars: RESULT_CHARS };
    case 'ok':
      return { label: 'Homing', value: `stopped ${fmt(Math.max(0, r.pressInMm), 2)} mm into the stop`, ok: true, minChars: RESULT_CHARS,
        title: 'DIAG went high at the stop. The carriage pressed into the belt by this much first.' };
    case 'false-trigger':
      return { label: 'Homing', value: `false trigger at ${fmt(r.xMm, 1)} mm`, warn: true, minChars: RESULT_CHARS,
        title: 'DIAG went high before the carriage reached the stop.' };
    case 'canceled':
      return { label: 'Homing', value: 'canceled', minChars: RESULT_CHARS,
        title: 'Ended before the carriage reached the stop, so there is no result.' };
    default:
      return { label: 'Homing', value: r.slow ? 'no detection: too slow' : 'no detection: hit the stop', warn: true, minChars: RESULT_CHARS,
        title: r.slow ? `Below ${MIN_SPEED} mm/s StallGuard has no reading.`
          : 'The reading never fell below the threshold, so the motor ground against the stop.' };
  }
}

function sgChip(snap, m) {
  const thr = 2 * st.sgthrs;
  if (m.sg == null) {
    // A homing move below the minimum speed; the shuttle passes through it at every reversal, and the
    // carriage while it stops before a homing (neither flagged).
    const slow = st.homing && !st.pending && st.homeSpeed < MIN_SPEED && snap.planner.mode !== 'idle';
    return { label: 'StallGuard', value: slow ? 'too slow' : '–', warn: slow, minChars: 8,
      title: `No reading below ${MIN_SPEED} mm/s (the driver needs the motor's back-EMF to measure).`,
      bar: { value: 0, max: 1023, mark: thr, off: true } };
  }
  const low = m.sg < thr;
  return { label: 'StallGuard', value: m.sg, digits: 0, warn: low, minChars: 8,
    title: `Reading 0 to 1023 (high = little load). DIAG goes high below ${thr} (2 × driver_SGTHRS).`,
    bar: { value: m.sg, max: 1023, mark: thr, low } };
}

/* ---------------- chapter ---------------- */

export default {
  id: 'driver-modes', number: 4, title: 'StealthChop, SpreadCycle and StallGuard', short: 'Driver modes',
  takeaway: 'Quiet mode regulates current slowly, fast mode regulates it every cycle, and stall detection guesses the load from how the current behaves.',
  motorTypes: ['stepper'],
  timeScale: TIME_SCALE,
  traceWindow: 1.0,
  stage: { primary: 'motor', secondary: 'gantry', split: 0.5 },
  viewOptions: { gantry: { mode: 'axis', led: true, detailMm: 3 } },
  hint: 'Slow the time scale to watch the current vector trail the dashed command in the motor view.',

  scenario(motorType) {
    return {
      motorType, motorPreset: 'stepper', driver: 'openloop', driverMode: st.mode, mechanics: 'axis',
      runCurrent: st.rms * SQRT2, hybridThresholdMmS: st.threshold,
      loads: { drag: st.drag, torque: 0 }, bump: BUMP, start: { x: 50, y: 0 },
      planner: { maxVelocity: st.speed, accel: st.accel, scv: 5, microsteps: 16, fullStepsPerRev: 200 },
      stallguard: { sgthrs: st.sgthrs, minSpeedMmS: MIN_SPEED },
    };
  },

  onEnter(ctx) { startShuttle(ctx); },

  onLeave() { st = freshState(); },

  controls(ctx) {
    const hybrid = st.mode === 'hybrid';
    return [
      { type: 'segmented', id: 'mode', label: 'Driver mode', value: DEFAULTS.mode, group: 'Driver',
        caption: MODE_KEY[st.mode] || null,
        options: [{ value: 'voltage', label: 'StealthChop' }, { value: 'current', label: 'SpreadCycle' },
          { value: 'hybrid', label: 'Hybrid' }],
        onChange: (v, c) => {
          st.mode = v;
          // During the homing approach the driver stays in StealthChop; the new mode comes at the trigger.
          if (st.homing && st.result && st.result.kind === 'running') st.forced = v !== 'voltage';
          else c.world.set('driverMode', v);
          c.app.refreshControls();       // caption and the threshold slider's state
          run(c, false);
        } },
      { type: 'slider', id: 'threshold', label: 'Hybrid: StealthChop below', min: 10, max: 200, step: 5,
        value: DEFAULTS.threshold, unit: 'mm/s', caption: 'stealthchop_threshold', group: 'Driver', disabled: !hybrid,
        title: hybrid ? '' : 'Used in Hybrid mode',
        onChange: (v, c) => { st.threshold = v; c.world.set('hybridThresholdMmS', v); run(c, false); } },
      { type: 'slider', id: 'current', label: 'Run current', min: 0.5, max: 2.5, step: 0.05, value: DEFAULTS.rms,
        caption: 'run_current', group: 'Driver', format: formatRms,
        onChange: (v, c) => { st.rms = v; c.world.set('runCurrent', v * SQRT2); } },

      { type: 'slider', id: 'speed', label: 'Speed', min: 20, max: 1000, step: 1, sig: 2, log: true, value: DEFAULTS.speed, unit: 'mm/s',
        group: 'Motion',
        onChange: (v, c) => { st.speed = v; c.world.set('planner.maxVelocity', v); run(c, false); } },
      { type: 'slider', id: 'accel', label: 'Acceleration', min: 500, max: 100000, step: 1, sig: 2, log: true, value: DEFAULTS.accel,
        unit: 'mm/s²', caption: 'max_accel', group: 'Motion',
        onChange: (v, c) => { st.accel = v; c.world.set('planner.accel', v); run(c, false); } },
      { type: 'slider', id: 'drag', label: 'Drag', min: 0, max: 0.3, step: 0.01, value: DEFAULTS.drag, unit: 'N·m',
        group: 'Motion',
        onChange: (v, c) => { st.drag = v; c.world.command('setLoad', { drag: v }); } },
      { type: 'button', id: 'run', label: 'Run back and forth', group: 'Motion', onClick: (c) => run(c, true) },
      { type: 'button', id: 'bump', label: 'Bump', group: 'Motion', ariaLabel: 'Bump the carriage',
        onClick: (c) => c.world.command('bump') },

      { type: 'slider', id: 'sgthrs', label: 'StallGuard threshold', min: 0, max: 255, step: 1, value: DEFAULTS.sgthrs,
        caption: 'driver_SGTHRS', group: 'StallGuard',
        onChange: (v, c) => { st.sgthrs = v; c.world.set('stallguard.sgthrs', v); } },
      { type: 'slider', id: 'homingSpeed', label: 'Homing speed', min: 5, max: 80, step: 1, value: DEFAULTS.homingSpeed,
        unit: 'mm/s', caption: 'homing_speed', group: 'StallGuard',
        onChange: (v) => { st.homingSpeed = v; } },
      { type: 'button', id: 'home', label: 'Home toward the stop', kind: 'primary', group: 'StallGuard',
        onClick: (c) => home(c) },

      { type: 'segmented', id: 'scope', label: 'Scope shows', value: DEFAULTS.scope, group: 'Scope',
        options: [{ value: 'current', label: 'Currents' }, { value: 'stallguard', label: 'StallGuard' }],
        onChange: (v, c) => { st.scope = v; c.app.refreshTraces(); } },
    ];
  },

  traces: () => (st.scope === 'stallguard' ? SG_TRACES : CURRENT_TRACES),

  readouts(snap, metrics, ctx) {
    const m = snap.motors[0];
    const w = ctx.world;
    const peak = st.rms * SQRT2;
    const pct = peak > 0 && w.iAmpLpfOut ? (100 * w.iAmpLpfOut[0]) / peak : metrics.iAmpPct;
    const active = MODE_NAME[m.mode] || MODE_NAME.current;
    // Values keep room for their widest form (a homing's "StealthChop for homing", 100%, a result),
    // so a value that grows after Home or Run cannot add a chip row (B-006).
    const items = [
      { label: 'Driver', value: st.forced ? `${active} for homing` : active, minChars: 22,
        title: st.mode === 'hybrid' ? `Hybrid: StealthChop below ${st.threshold} mm/s, SpreadCycle above` : '' },
      { label: 'Current', value: pct, digits: 0, unit: '% of target', warn: pct < 85 || pct > 115, minChars: 4,
        title: 'Current amplitude as a share of the run current' },
      { label: 'Lag', value: metrics.phaseLagDeg, digits: 0, unit: '°', minChars: 4,
        title: 'How far the current trails the commanded field (electrical degrees)' },
      sgChip(snap, m),
      { label: 'DIAG', value: m.diag ? 'high' : 'low', led: m.diag ? 'trip' : 'off', minChars: 4 },
      resultChip(snap),
    ];
    // Shown from the start, like chapter 6's: a chip that appeared at a stall, a moment after the
    // reader's action, could add a chip row by itself (B-006).
    const lost = Math.abs(lostMm(w));
    items.push({ label: 'Lost', value: lost, digits: 1, unit: 'mm', warn: lost >= LOST_MM, minChars: 5,
      title: 'Distance the rotor fell behind the commanded position (open loop never finds it again)' });
    return items;
  },

  onFrame(ctx, snap) {
    if (st.pending) {
      if (snap.planner.mode === 'idle') startHoming(ctx);
      return;
    }
    // The reader took the hint's advice up to the maximum: drop the advice (or the whole hint once
    // the carriage is within SLOW_HINT_MM of the stop).
    if (st.slowHint === 'raise' && ctx.app.timeScale >= TIME_SCALE.max && snap.homing.active && !snap.homing.contact) {
      slowHint(ctx, snap.gantry.x);
    }
    // Homing ended (retract done, or aborted by another command).
    if (st.homing && !snap.homing.active) {
      st.homing = false;
      st.homingEndT = snap.t;      // main.js drains events after onFrame: the slam's last stepLost may come next
      restoreMode(ctx);
      slowHint(ctx, 0);
      // Still running: the result event drained right after this replaces it, else it was aborted.
      if (st.result && st.result.kind === 'running') st.result = { kind: 'canceled' };
    }
  },

  // The longest announcement, so the readouts row keeps room for it (B-008).
  announceSample: 'No stall detected: the carriage hit the stop and the motor skipped',

  onEvent(ev, ctx) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'homingDone':
        restoreMode(ctx);
        st.result = { kind: d.result, xMm: d.xMm, pressInMm: d.pressInMm };
        return d.result === 'ok' ? 'Stall detected at the stop: homed'
          : `False trigger: DIAG went high at ${fmt(d.xMm, 1)} mm, before the stop`;
      case 'homingNoEdge': {
        restoreMode(ctx);
        const slow = st.homeSpeed < MIN_SPEED;   // the homing's own speed, not the slider moved since
        st.result = { kind: 'no-edge', slow };
        return slow ? `No stall detected: StallGuard has no reading below ${MIN_SPEED} mm/s`
          : 'No stall detected: the carriage hit the stop and the motor skipped';
      }
      case 'stallDetected':
        // Homing reports its own result. Outside homing DIAG blips at StealthChop reversals and on
        // bumps; the LED and the scope show that, and Klipper ignores DIAG then too.
        return false;
      case 'stepLost': {
        // A homing reports its own result, and its slam's last stepLost events can still arrive just
        // after it ended. A later slip, such as one the reader causes with Bump on the parked axis at a
        // low current, is announced. The Lost chip shows the distance either way.
        if (st.homing || ev.t - st.homingEndT < SLAM_TRAIL_S) return false;
        const now = performance.now();
        if (now - st.lostAt < 3000) return false;
        st.lostAt = now;
        return 'The motor fell out of step';
      }
      case 'pathDone':
        // The shuttle ran out of laps: keep going. (The homing retract is a moveTo: path null.)
        if (!st.homing && d.path === 'custom') startShuttle(ctx);
        return false;
      default:
        return undefined;
    }
  },

  text: () => '<p><strong>StealthChop</strong> is voltage mode. The driver applies a smooth sine of voltage '
    + 'and slowly adjusts its size until the current is right, so the motor runs almost silently. The '
    + 'correction takes tens of milliseconds: the current trails the command, dips when the motor speeds up, '
    + 'overshoots when it slows down, and at higher speeds the rotor can fall out of step.</p>'
    + '<p><strong>SpreadCycle</strong> measures the current every PWM cycle and corrects it at once, like the '
    + 'chopper in chapter 3. It holds the target at speed, and the constant chopping is the hiss you '
    + 'hear. Klipper switches between the two at <code>stealthchop_threshold</code>.</p>'
    + '<p><strong>StallGuard</strong> estimates the load from how the current lines up with the back-EMF; a '
    + 'stalled motor looks like a very heavy load. Below twice <code>driver_SGTHRS</code>, the DIAG pin goes '
    + 'high and Klipper uses it as the endstop. It needs a minimum speed and a threshold tuned at your homing '
    + 'speed: too sensitive triggers early, too dull slams into the stop. With FOC, chapter 9 detects the stop '
    + 'without guessing.</p>'
    + '<p><em>A behavior model of these features, not the chip\'s circuit.</em></p>',

  tryThis: [
    'In StealthChop, raise the speed to 150 mm/s until the rotor falls out of step. Switch to SpreadCycle and try again.',
    'Home toward the stop with <code>driver_SGTHRS</code> at 30, then at 100. Add 0.2 N·m of drag and home at 255.',
    'Set the homing speed to 5 mm/s and home again.',
  ],

  deeper: () => '<p>A real StealthChop also scales its voltage with speed, so its current swings less than in this '
    + 'model. Here the StallGuard reading is 1023 × (1 − |sin δ| × (1 + 0.3 v / 100 mm/s)), with δ the '
    + 'load angle between the current and the rotor: no load reads near 1023, a stall about 80. A TMC2209 '
    + 'infers its load from the back-EMF and only in StealthChop, so Klipper switches the driver to StealthChop '
    + 'for the homing move (the Driver readout shows it). DIAG also blips when StealthChop reverses, because the '
    + 'dip in current looks like load; Klipper only listens to DIAG while homing. <code>stealthchop_threshold</code> '
    + 'is a speed in mm/s: 0 keeps SpreadCycle, 999999 keeps StealthChop, anything between switches at that '
    + 'speed.</p>',
};
