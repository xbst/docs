/**
 * Chapter 5: Why 48 V (SPEC 6.5).
 *
 * A free-spinning stepper (no hard stops) under a current-mode driver
 * (SpreadCycle-style, fixed in this chapter) jogs at the reader's speed. The
 * torque-speed chart is the primary view; the chart highlights the selected
 * bus voltage by itself (snapshot.supplyV) and follows the motor preset.
 *
 * "Sweep" runs the world's sweep machine at the selected voltage only: it
 * ramps from rest at 3000 mm/s² to 1.35 × the analytic 70 % speed (capped at
 * 1500 mm/s) and records the sag speed, where the current amplitude first
 * falls below 70 % of its target (chunk 02: that speed scales with the
 * voltage; the slip speed does not). The ramp keeps a sweep to 1500 mm/s
 * at 0.55 s of motor time, so the 0.5 s scope window shows nearly all of it
 * (at 2000 mm/s² it took 0.8 s; the sag speeds agree within 2 %, except 79
 * against 84 mm/s for the 8 mH motor at 12 V). The chapter keeps its own
 * table of results per motor preset and voltage, so sweeping one voltage
 * after another builds the table and an inductance change (a world rebuild)
 * keeps it; the chart gets the current preset's results through its
 * `results` option.
 *
 * A stalled stepper only catches the field again well below its stall speed
 * (about 100 mm/s at 24 V), so any speed, voltage, current or motor change
 * made while it is stalled restarts it from rest, the way you would on a
 * printer: in a fresh world, because a stalled rotor can keep spinning at
 * hundreds of mm/s, and stopping the field under it before the new jog left
 * the motor stalled after 37 of 267 stalls (12 to 36 V, drag 0 to 0.3 N·m,
 * 600 to 1500 mm/s), each time with the rotor still turning at 200 to 1300
 * mm/s when the change came.
 *
 * Run current is set in A rms, like Klipper's run_current for TMC drivers;
 * the world gets the peak phase current (× √2) and the chart labels rms.
 *
 * Calibration (2026-10-01, the datasheet motor, 3.54 A peak, unloaded, with
 * the back-EMF feed-forward in drivers/openloop.js, BEMF_FF_TAU 30 ms): sag
 * speeds 259, 534, 809, 1075, 1349 mm/s at 12, 24, 36, 48, 60 V (analytic 2
 * to 3 % higher); the 8 mH motor 166 and 338 at 24 and 48 V (analytic within
 * 1 %); the 0.8 mH motor 726 and 1468 at 24 and 48 V (analytic 4 to 5 %
 * higher), while at 60 V it holds 70 % past the 1500 mm/s cap (1820 in a
 * sweep to 2600). At 600 mm/s the current reaches about 60 % of its target at
 * 24 V and 102 % at 48 V; at 48 and 60 V the feed-forward lets it run up to
 * 3 % over the target (13 % on the 0.8 mH motor at 60 V and 1200 mm/s).
 *
 * Stalls (2.5 A rms, from the default jog, 3 s at speed): the chart's curve
 * is the worst case, the coil's voltage drop adding straight to the
 * back-EMF, which is what a motor with no load sees, so the sweep matches
 * it. Under load the rotor lags the field and the two no longer peak
 * together (past 90° of lag the current even works against the magnet,
 * field weakening; the More info's last two sentences say the first part), so
 * a loaded motor can make more torque at speed than the curve says, while
 * the open-loop stepper's mid-band resonance stalls a lightly loaded one
 * long before the curve runs out. The 1.6 mH motor at 24 V holds up to 700
 * mm/s with no load and stalls from 725, where the curve still gives it 40 %
 * of its current; with drag its first stall comes at 650 mm/s with 0.1 N·m
 * (the curve crosses the load at 891), 600 with 0.2 (720) and 600 with 0.3
 * (603). At 48 V it holds to 1350 with no load (2319) and to 1300 with
 * 0.3 N·m (1210); 60 V holds 1500 with up to 0.3 N·m. The 0.8 mH motor holds
 * 1400 mm/s at 24 V with 0.3 N·m (815), and the 8 mH motor stalls in bands
 * from 300 mm/s at 24 V with no load (923). So the chart has no load line:
 * the curve predicts the stall only for heavy drag on the 1.6 mH motor
 * (0.3 N·m: the first stall within 1 to 18 % of the crossing at 12 to 48 V).
 */
import { formatValue, formatRms } from '../format.js';
import { MOTOR_PRESETS, torqueSpeedCurve } from '../sim/presets.js';

const SQRT2 = Math.SQRT2;
const TAU = 2 * Math.PI;
/** Rotation distance (mm per motor turn). */
const RD = 40;
const VOLTAGES = [12, 24, 36, 48, 60];
const PRESETS = [
  { value: 'stepperLowL', label: '0.8 mH', title: 'Low inductance: 0.8 mH, 0.6 Ω' },
  { value: 'stepper', label: '1.6 mH', title: 'Typical NEMA 17: 1.6 mH, 1.2 Ω' },
  { value: 'stepperHighL', label: '8 mH', title: 'High inductance: 8 mH, 2.4 Ω' },
];
const PRESET_NAME = { stepperLowL: '0.8 mH', stepper: '1.6 mH', stepperHighL: '8 mH' };
/** Sweep: ramp acceleration (mm/s²), sag level, scope window (s), end speed margin over the analytic sag speed. */
const SWEEP = { accel: 3000, sagFrac: 0.7, window: 0.5, margin: 1.35 };
/** Scope windows (s) for steady running: the shortest that holds four electrical cycles. */
const WINDOWS = [0.005, 0.01, 0.02, 0.03, 0.05, 0.1];
/** Stall test: the rotor lost at least STALL_MM (two electrical cycles) within STALL_S of sim time. */
const STALL_S = 0.05, STALL_MM = 1.6;

const DEFAULTS = Object.freeze({ V: 24, speed: 150, rms: 2.5, preset: 'stepper', drag: 0 });

/** Chapter state; reset in onLeave (scenario() runs before onEnter). */
let st = freshState();

function freshState() {
  return Object.assign({}, DEFAULTS, {
    sweeping: false, sweepV: 0, sweepMax: 0,
    table: {},             // preset key → { [volts]: { sag: mm/s | null, slip: mm/s, max: mm/s } }
    stalled: false,
    lostRef: 0, lostRefT: -Infinity, lastT: 0,   // stall test baseline (see onFrame)
    stallSaid: -Infinity,  // performance.now() of the last stall announcement
  });
}

/** Start the stall test over (after a restart, a sweep or a rebuild moved the lost distance). */
function rebaseStall() {
  st.stalled = false;
  st.lostRefT = -Infinity;
}

const fmt = (v, d) => formatValue(v, d);

/** Analytic speed (mm/s) where the attainable current falls to 70 % of `peak`. */
function sagSpeed(presetKey, V, peak) {
  const c = torqueSpeedCurve(MOTOR_PRESETS[presetKey] || MOTOR_PRESETS.stepper, V, peak);
  const target = SWEEP.sagFrac * peak;
  let lo = 0, hi = c.omegaBemfM;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (c.iAvailAt(mid) >= target) lo = mid; else hi = mid;
  }
  return lo * RD / TAU;
}

/** Scope window for a steady speed: at least four electrical cycles (p = 50), within 5 to 100 ms. */
function windowFor(speedMmS) {
  const fe = Math.abs(speedMmS) / RD * 50;
  if (!(fe > 0)) return WINDOWS[WINDOWS.length - 1];
  const want = 4 / fe;
  for (const w of WINDOWS) if (w >= want) return w;
  return WINDOWS[WINDOWS.length - 1];
}

/** Sweep results of a preset for the chart: { [volts]: sag speed }. */
function chartResults(presetKey) {
  const out = {};
  const t = st.table[presetKey];
  if (t) for (const V of Object.keys(t)) if (t[V].sag != null) out[V] = t[V].sag;
  return out;
}

function tableHtml() {
  const cols = PRESETS.map((p) => p.value).filter((k) => st.table[k] && Object.keys(st.table[k]).length);
  if (!cols.length) {
    return 'Press Sweep to find the speed where the current falls below 70% of its target. '
      + 'Sweep another voltage or motor to add it to the table.';
  }
  const rows = VOLTAGES.filter((V) => cols.some((k) => st.table[k][V]));
  const base = {};
  for (const k of cols) {
    const V0 = rows.find((V) => st.table[k][V] && st.table[k][V].sag != null);
    base[k] = V0 != null ? st.table[k][V0].sag : null;
  }
  const cell = (k, V) => {
    const r = st.table[k][V];
    if (!r) return '<td>–</td>';
    if (r.sag == null) {
      return r.slip != null && r.slip < r.max ? `<td>stalled ${fmt(r.slip, 0)}</td>` : `<td>&gt; ${fmt(r.max, 0)}</td>`;
    }
    const ratio = base[k] && r.sag !== base[k] ? ` <span class="x">×${(r.sag / base[k]).toFixed(1)}</span>` : '';
    return `<td>${fmt(r.sag, 0)}${ratio}</td>`;
  };
  let h = 'Speed in mm/s where the current falls below 70% of its target.<table><tr><th>Bus</th>';
  for (const k of cols) h += `<th>${PRESET_NAME[k]}</th>`;
  h += '</tr>';
  for (const V of rows) {
    h += `<tr><td>${V} V</td>`;
    for (const k of cols) h += cell(k, V);
    h += '</tr>';
  }
  return h + '</table>';
}

/** Current and drag are shared by every comparison; changed conditions invalidate all presets. */
function clearSweepResults(ctx) {
  st.table = {};
  ctx.app.setViewOptions('chart', { results: {} });
  // Update only the note: rebuilding the controls here would interrupt an active slider drag.
  ctx.app.setControlValue('sweepResults', tableHtml());
}

/* ---------------- motion ---------------- */

/**
 * Jog at the reader's speed. A stalled motor starts over in a fresh world, at rest: its rotor can
 * still spin at hundreds of mm/s, and it would not catch a field that starts again under it.
 */
function drive(ctx) {
  if (st.stalled) {
    ctx.app.reconfigure();               // scenario() reads st: same bus, current, motor and drag
    rebaseStall();
  }
  ctx.world.command('jog', { speedMmS: st.speed });
}

/**
 * Cut a running sweep short (the world restores the supply voltage and puts the motor at rest).
 * No control re-render here: a slider being dragged would lose its grip.
 * @returns {boolean} true when a sweep was running
 */
function abortSweep(ctx) {
  if (!st.sweeping) return false;
  st.sweeping = false;
  ctx.world.command('stop', { immediate: true });
  ctx.app.setTraceWindow(windowFor(st.speed));
  rebaseStall();
  return true;
}

function startSweep(ctx) {
  const peak = st.rms * SQRT2;
  const max = Math.min(1500, Math.max(200, Math.ceil(sagSpeed(st.preset, st.V, peak) * SWEEP.margin / 50) * 50));
  st.sweeping = true;
  st.sweepV = st.V;
  st.sweepMax = max;
  rebaseStall();
  ctx.app.setTraceWindow(SWEEP.window);
  ctx.world.command('sweep', { voltages: [st.V], maxMmS: max, accelMmS2: SWEEP.accel, sagFrac: SWEEP.sagFrac });
}

/** After a sweep: back to the reader's speed, the steady scope window, the new table. */
function afterSweep(ctx) {
  st.sweeping = false;
  rebaseStall();
  ctx.app.setTraceWindow(windowFor(st.speed));
  ctx.world.command('jog', { speedMmS: st.speed });
  ctx.app.setViewOptions('chart', { results: chartResults(st.preset) });
  ctx.app.refreshControls();
}

/* ---------------- chapter ---------------- */

export default {
  id: 'voltage', number: 5, title: 'Why 48 V', short: '48 V',
  takeaway: 'Current makes torque, but voltage decides how fast current can change, so a higher voltage keeps torque alive at speed.',
  motorTypes: ['stepper'],
  timeScale: { default: 0.05, min: 0.005, max: 0.5 },
  traceWindow: windowFor(DEFAULTS.speed),
  stage: { primary: 'chart', secondary: 'motor', split: 0.6 },
  viewOptions: { chart: { rms: true, results: {} } },

  scenario(motorType) {
    return {
      motorType, motorPreset: st.preset, driver: 'openloop', driverMode: 'current', mechanics: 'free',
      supplyV: st.V, runCurrent: st.rms * SQRT2, loads: { drag: st.drag, torque: 0 },
      planner: { maxVelocity: 1500, accel: SWEEP.accel, scv: 5, microsteps: 16, fullStepsPerRev: 200 },
    };
  },

  onEnter(ctx) {
    ctx.world.command('jog', { speedMmS: st.speed });
    ctx.app.setViewOptions('chart', { results: chartResults(st.preset) });
  },

  onLeave() { st = freshState(); },

  controls() {
    return [
      { type: 'note', html: 'The driver regulates the current every PWM cycle, like SpreadCycle, throughout this '
        + 'chapter, so what runs out at speed is the voltage, not the regulation.' },
      { type: 'segmented', id: 'bus', label: 'Bus voltage', value: DEFAULTS.V, group: 'Supply and motor',
        options: VOLTAGES.map((v) => ({ value: v, label: v + ' V' })),
        onChange: (v, c) => {
          const cut = abortSweep(c);
          st.V = v;
          c.world.set('supplyV', v);
          if (cut || st.stalled) drive(c);
          c.app.refreshControls();       // the Sweep button names the voltage
        } },
      { type: 'slider', id: 'current', label: 'Run current', min: 0.5, max: 2.5, step: 0.05, value: DEFAULTS.rms,
        caption: 'run_current', group: 'Supply and motor', format: formatRms,
        onChange: (v, c) => {
          const cut = abortSweep(c);
          if (v !== st.rms) clearSweepResults(c);
          st.rms = v;
          c.world.set('runCurrent', v * SQRT2);
          if (cut || st.stalled) drive(c);
        } },
      { type: 'segmented', id: 'motor', label: 'Motor inductance', value: DEFAULTS.preset, group: 'Supply and motor',
        options: PRESETS,
        onChange: (v, c) => {
          abortSweep(c);
          st.preset = v;
          rebaseStall();
          c.world.set('motorPreset', v);  // rebuilds the motor; the sweep table stays with the chapter
          c.world.command('jog', { speedMmS: st.speed });
          c.app.setViewOptions('chart', { results: chartResults(v) });
        } },
      { type: 'slider', id: 'speed', label: 'Speed', min: 0, max: 1500, step: 10, value: DEFAULTS.speed, unit: 'mm/s',
        group: 'Motion',
        onChange: (v, c) => { abortSweep(c); st.speed = v; drive(c); } },
      { type: 'slider', id: 'load', label: 'Drag', min: 0, max: 0.3, step: 0.01, value: DEFAULTS.drag, unit: 'N·m',
        group: 'Motion',
        onChange: (v, c) => {
          const cut = abortSweep(c);
          if (v !== st.drag) clearSweepResults(c);
          st.drag = v;
          c.world.command('setLoad', { drag: v });
          if (cut || st.stalled) drive(c);
        } },
      { type: 'button', id: 'sweep', label: `Sweep at ${st.V} V`, kind: 'primary', group: 'Sweep',
        ariaLabel: `Sweep the speed at ${st.V} volts`, onClick: (c) => startSweep(c) },
      { type: 'note', id: 'sweepResults', html: tableHtml(), group: 'Sweep' },
    ];
  },

  traces: [
    // Legend room for the widest ranges the chapter reaches ("0 to 4 A" after "±5 A"; up to
    // "−50 to 100 V" for the 37 V back-EMF at 1500 mm/s against a 60 V bus), so a sweep, a stall
    // or a speed change moves nothing (B-006).
    { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'target', dashed: true, scaleChars: 8 },
    { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a' },
    { name: 'bemfA', label: 'Back-EMF, phase A', unit: 'V', color: 'axis-q', scaleChars: 12 },
    { name: 'uMag', label: 'Voltage used', unit: 'V', color: 'phase-c' },
    // 'fit' for the volts group: the data extent (−back-EMF up to the bus), not ±2× the bus.
    { name: 'uLimit', label: 'Bus voltage', unit: 'V', color: 'target', dashed: true, range: 'fit' },
    // Fixed range: the motor makes at most Kt × 3.54 A = 0.55 N·m; auto-zoom would blow the
    // no-load ripple up to full height.
    { name: 'torque', label: 'Torque', unit: 'N·m', color: 'phase-b', range: [-0.6, 0.6] },
  ],

  readouts(snap, metrics, ctx) {
    const m = snap.motors[0];
    const w = ctx.world;
    const pr = MOTOR_PRESETS[snap.motorPreset] || MOTOR_PRESETS.stepper;
    const peak = st.rms * SQRT2;
    const iF = w.iAmpLpfOut ? w.iAmpLpfOut[0] : m.iAmp;
    const pct = peak > 0 ? (100 * iF) / peak : 0;
    const V = snap.supplyV;
    // Values keep room for what a sweep reaches (thousands of hertz, 100%), and the sweep result
    // has its chip from the start, so a sweep cannot add a chip row as it runs or ends (B-006).
    const t = st.table[snap.motorPreset];
    const r = t && t[V];
    const items = [
      { label: 'Back-EMF', value: Math.hypot(m.bemf[0], m.bemf[1]), digits: 1, unit: 'V peak', minChars: 4,
        title: 'The voltage the spinning motor generates against the supply' },
      { label: 'Electrical', value: (Math.abs(m.omegaM) * pr.p) / TAU, digits: 0, unit: 'Hz', minChars: 4,
        title: 'How often the current has to reverse (50 electrical cycles per turn)' },
      { label: 'Current', value: pct, digits: 0, unit: '% of target', warn: pct < 90, minChars: 4,
        title: 'Current amplitude the driver reaches, as a share of the run current' },
      { label: 'Torque available', value: pr.Kt * iF, digits: 2, unit: 'N·m',
        title: 'Most torque the motor can make with the current it gets (the ring on the chart)' },
      { label: 'Voltage used', value: m.vAmp, digits: 1, unit: `of ${fmt(V, 0)} V`, warn: m.vAmp > 0.97 * V, minChars: 4,
        title: 'Phase voltage the driver applies; at the bus voltage it has nothing left' },
      { label: `Sweep, ${fmt(V, 0)} V`, value: r && r.sag != null ? r.sag : '–', digits: 0, unit: 'mm/s', minChars: 4,
        title: 'Highest speed at which the current held 70% of its target in the last sweep at this bus voltage; a dash until you sweep' },
    ];
    if (st.stalled) {
      items.push({ label: 'Motor', value: 'stalled', warn: true,
        title: 'The rotor lost the field. Lower the speed, raise the voltage or lower the drag.' });
    }
    return items;
  },

  onFrame(ctx, snap) {
    // A sweep that ended without its event (a rebuild dropped it): back to the jog.
    if (st.sweeping && !snap.sweep.running && !snap.events.some((e) => e.type === 'sweepDone')) afterSweep(ctx);
    // Stall test every STALL_S of sim time: the rotor kept losing the field (not while sweeping,
    // which resets the motor per run).
    const lost = snap.gantry.lostMm[0];
    if (snap.t < st.lastT || st.lostRefT === -Infinity || st.sweeping) {
      st.lostRef = lost;                                   // new baseline (also after a rebuild: t went back)
      st.lostRefT = snap.t;
      if (st.sweeping) st.stalled = false;
    } else if (snap.t - st.lostRefT >= STALL_S) {
      st.stalled = Math.abs(lost - st.lostRef) >= STALL_MM;
      st.lostRef = lost;
      st.lostRefT = snap.t;
    }
    st.lastT = snap.t;
    // Scope window follows the speed once it has settled.
    if (!st.sweeping && Math.abs(Math.abs(snap.planner.vx) - st.speed) < 1) {
      const want = windowFor(st.speed);
      if (Math.abs(want - ctx.app.traceWindow) > 1e-9) ctx.app.setTraceWindow(want);
    }
  },

  // The longest announcement, so the readouts row keeps room for it (B-008).
  announceSample: 'Sweep at 88 V: the current held 70% up to 8888 mm/s',

  onEvent(ev, ctx) {
    switch (ev.type) {
      case 'sweepDone': {
        if (!st.sweeping) return false;  // a cancelled run may still have a queued completion event
        const V = st.sweepV;
        const det = (ctx.world.snapshot.sweep.detail || {})[V] || {};
        const res = ev.data && ev.data.results ? ev.data.results[V] : undefined;
        const sag = typeof det.sagMmS === 'number' ? det.sagMmS : null;
        const slip = typeof det.slipMmS === 'number' ? det.slipMmS : res;
        if (!st.table[st.preset]) st.table[st.preset] = {};
        st.table[st.preset][V] = { sag, slip: slip != null ? slip : null, max: st.sweepMax };
        afterSweep(ctx);
        if (sag != null) return `Sweep at ${V} V: the current held 70% up to ${fmt(sag, 0)} mm/s`;
        return slip != null && slip < st.sweepMax ? `Sweep at ${V} V: the motor stalled at ${fmt(slip, 0)} mm/s`
          : `Sweep at ${V} V: the current held up to ${fmt(st.sweepMax, 0)} mm/s`;
      }
      case 'stepLost': {
        if (st.sweeping) return false;
        const now = performance.now();
        if (now - st.stallSaid < 3000) return false;
        st.stallSaid = now;
        // Not "not enough torque": with little load the open-loop stepper's mid-band resonance stalls it
        // while the chart still gives it about 40 % of its current (see the header).
        return 'The motor stalled: the rotor lost the field';
      }
      case 'stallDetected':
        return false;                    // StallGuard is chapter 4's topic; at speed it only adds noise here
      default:
        return undefined;
    }
  },

  text: () => '<p>Torque comes from current, and the driver can only push current with the voltage it has. '
    + 'Two things eat that voltage as the motor speeds up.</p>'
    + '<p><strong>Inductance.</strong> The coil resists changes in current: di/dt = (V − e − R·i)/L, the ramp '
    + 'from chapter 3. At speed each microstep is shorter, and the current no longer reaches its target in time.</p>'
    + '<p><strong>Back-EMF.</strong> A spinning motor is also a generator. Its voltage e grows with speed and '
    + 'pushes against the supply. When it nears the bus voltage, nothing is left to push current, and torque '
    + 'collapses.</p>'
    + '<p>Doubling the bus voltage roughly doubles the speed where torque holds. It does not add torque at low '
    + 'speed: that is the current\'s job. FOC drivers use the voltage as well as it can be used, but the same '
    + 'ceiling applies (chapter 7 shows it as the voltage circle).</p>',

  tryThis: [
    'Sweep at 24 V, then at 48 V, and compare the speeds in the table.',
    'At 24 V, raise the speed to 600 mm/s: the current falls short of the dashed target. Switch to 48 V.',
    'Switch to the 8 mH motor and sweep again.',
  ],

  deeper: () => '<p>The chart plots T = Kt × min(I, I<sub>avail</sub>), with I<sub>avail</sub>(ω) = '
    + '(V − λω<sub>e</sub>)/√(R² + (ω<sub>e</sub>L)²): the current the phase voltage V can push against the '
    + 'back-EMF λω<sub>e</sub> through the coil. ω<sub>e</sub> is the electrical speed, 50 times the shaft speed '
    + 'on a 1.8° stepper. At speed a chopper holds each bridge on for most of the cycle, so V is the fundamental '
    + 'of a square wave, 4/π times the bus voltage. The sweep records where the current falls below 70% of its '
    + 'target. The curve is the no-load worst case, where the coil\'s own voltage and the back-EMF peak together. '
    + 'Under load the rotor lags the field, the two peak apart, and the torque can exceed the curve.</p>',
};
