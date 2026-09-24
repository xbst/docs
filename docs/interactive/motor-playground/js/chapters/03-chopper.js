/**
 * Chapter 3: Inside a stepper driver (SPEC 6.3).
 *
 * One phase of a current-mode (SpreadCycle-like) driver in switching fidelity (0.5 µs steps):
 * the schematic shows the H-bridge switches from pwmState, the scope the bridge state lane and
 * phase A's current against its target. Mechanics are 'free' (no hard stops), so the optional
 * slow rotation can run forever; the carriage starts at 40 mm, where phase A's target is +I.
 *
 * Two scope windows: 500 µs (1 s on screen = 0.5 ms) with the current on a fitted range, so the
 * chopper sawtooth fills the plot; and 20 ms (1 s on screen = 20 ms) on the usual symmetric
 * range, where a slow rotation draws the sine (40 mm/s = one electrical cycle per window). The
 * inductance preset is structural, so it re-runs scenario() through app.reconfigure(); every
 * other control sets the running world. "Switch on" resets the world, so the current climbs
 * from zero again. Leaving the chapter needs no cleanup: the next chapter's scenario configures
 * averaged fidelity again.
 *
 * Readouts: the rise time from 0 to the target, (L/R)·ln(V/(V − R·I)); the current ramp with
 * the bridge on, (V − R·I)/L; the chopper ripple (phase A chopper's ppLast, the source of
 * metrics.ripplePp); the chopper frequency; the mean current against the mean target over the
 * last 1 ms.
 */
import { MOTOR_PRESETS } from '../sim/presets.js';
import { formatValue, formatRms } from '../format.js';

const ZOOMS = {
  us: { window: 0.0005, timeScale: 0.0005 },
  ms: { window: 0.02, timeScale: 0.02 },
};
const ROTATE_MS_VIEW = 40;               // mm/s picked when the 20 ms view opens at standstill
const INDUCTANCE = [['stepperLowL', 'Low'], ['stepper', 'Typical'], ['stepperHighL', 'High']];
const DEFAULTS = { bus: 24, preset: 'stepper', rms: 2.5, chopKHz: 40, zoom: 'us', speed: 0 };

/** Chapter state. scenario() reads it (app.reconfigure re-runs scenario), so onLeave resets it. */
const st = Object.assign({}, DEFAULTS);
const acc = { mean: 0, n: 0 };

/** Mean of a trace ring over its last `span` seconds, into `acc`. */
function ringMean(ring, span) {
  acc.mean = 0; acc.n = 0;
  if (!ring || !ring.len) return acc;
  const cap = ring.cap, T = ring.t, V = ring.v;
  let p = ring.head - 1;
  if (p < 0) p += cap;
  const tEnd = T[p];
  let sum = 0, n = 0;
  for (let i = 0; i < ring.len; i++) {
    if (tEnd - T[p] > span) break;
    const v = V[p];
    if (v === v) { sum += v; n++; }
    p = p === 0 ? cap - 1 : p - 1;
  }
  acc.mean = n ? sum / n : 0; acc.n = n;
  return acc;
}

const peakOf = (rms) => rms * Math.SQRT2;
const mH = (key) => formatValue(MOTOR_PRESETS[key].L * 1000, 1);
/** Scenario of the World (`scenario`) or of FakeWorld (`sc`, `?sim=fake`). */
const scOf = (w) => w.scenario || w.sc || {};
/** Preset of motor 0 (FakeWorld has no `presets`). */
const presetOf = (w) => (w.presets && w.presets[0]) || MOTOR_PRESETS[scOf(w).motorPreset] || MOTOR_PRESETS.stepper;
/** Peak run current (A). */
const runPeak = (w) => (scOf(w).runCurrent > 0 ? scOf(w).runCurrent : presetOf(w).Irated);

/** Restart the optional rotation after the world was reset. */
function rotate(ctx) {
  if (st.speed > 0) ctx.world.command('jog', { speedMmS: st.speed });
  else ctx.world.command('stop');
}

function setZoom(ctx, zoom) {
  st.zoom = zoom === 'ms' ? 'ms' : 'us';
  const z = ZOOMS[st.zoom];
  ctx.app.setTraceWindow(z.window);
  ctx.app.setTimeScale(z.timeScale);
  if (st.zoom === 'ms' && st.speed === 0) {
    st.speed = ROTATE_MS_VIEW;
    ctx.app.setControlValue('speed', st.speed);
    rotate(ctx);
  }
  ctx.app.refreshTraces();
}

export default {
  id: 'chopper', number: 3, title: 'Inside a stepper driver', short: 'Chopper',
  takeaway: 'A driver is a current regulator: it switches the supply on and off tens of thousands of times a second and measures what happens.',
  motorTypes: ['stepper'],
  timeScale: { default: ZOOMS.us.timeScale, min: 0.0001, max: 0.05 },
  traceWindow: ZOOMS.us.window,
  stage: { primary: 'schematic', secondary: null },
  hint: 'Change the bus voltage, the inductance or the chopper frequency and watch the slopes of the sawtooth.',

  scenario(motorType) {
    return {
      motorType, motorPreset: st.preset, driver: 'openloop', driverMode: 'current', fidelity: 'switching',
      mechanics: 'free', start: { x: 40, y: 50 }, supplyV: st.bus, runCurrent: peakOf(st.rms),
      chopper: { freqHz: st.chopKHz * 1000 }, microsteps: 16, interpolate: true,
    };
  },

  onEnter(ctx) { rotate(ctx); },

  onLeave() { Object.assign(st, DEFAULTS); },

  // StallGuard is chapter 4's topic; a lagging current at 12 V could otherwise announce a stall.
  onEvent(ev) { return ev.type === 'stallDetected' ? false : undefined; },

  controls() {
    return [
      { type: 'segmented', id: 'bus', label: 'Bus voltage', value: st.bus, group: 'Supply and motor',
        options: [12, 24, 48].map((v) => ({ value: v, label: `${v} V` })),
        onChange: (v, c) => { st.bus = v; c.world.set('supplyV', v); c.app.refreshText(); } },
      { type: 'segmented', id: 'ind', label: 'Motor inductance', value: st.preset, group: 'Supply and motor',
        options: INDUCTANCE.map(([key, name]) => ({ value: key, label: `${name} ${mH(key)} mH` })),
        onChange: (v, c) => { st.preset = v; c.app.reconfigure(); rotate(c); c.app.refreshText(); } },
      { type: 'slider', id: 'current', label: 'Run current', min: 0.35, max: 2.5, step: 0.05, value: st.rms,
        caption: 'run_current', group: 'Supply and motor', format: formatRms,
        onChange: (v, c) => { st.rms = v; c.world.set('runCurrent', peakOf(v)); c.app.refreshText(); } },
      { type: 'slider', id: 'chop', label: 'Chopper frequency', min: 20, max: 60, step: 1, value: st.chopKHz,
        unit: 'kHz', group: 'Chopper', onChange: (v, c) => { st.chopKHz = v; c.world.set('chopper.freqHz', v * 1000); } },
      { type: 'button', id: 'on', label: 'Switch on', kind: 'primary', group: 'Chopper',
        ariaLabel: 'Switch the driver off and on again, so the current starts from zero',
        onClick: (c) => { c.world.command('reset'); rotate(c); } },
      { type: 'segmented', id: 'zoom', label: 'Scope window', value: st.zoom, group: 'Scope',
        options: [{ value: 'us', label: '500 µs' }, { value: 'ms', label: '20 ms' }],
        onChange: (v, c) => setZoom(c, v) },
      { type: 'slider', id: 'speed', label: 'Rotation speed', min: 0, max: 60, step: 1, value: st.speed,
        unit: 'mm/s', group: 'Scope', onChange: (v, c) => { st.speed = v; rotate(c); } },
    ];
  },

  traces() {
    const range = st.zoom === 'us' ? 'fit' : 'auto';
    return [
      { name: 'pwmA', group: 'digital', label: 'Bridge A: +V, 0 or −V', short: 'Bridge A', color: 'phase-a', range: [-1, 1] },
      { name: 'iAStar', label: 'Phase A target', unit: 'A', color: 'target', dashed: true, range, minSpan: 0.1 },
      { name: 'iA', label: 'Phase A current', unit: 'A', color: 'phase-a', range },
    ];
  },

  readouts(snap, metrics, ctx) {
    const w = ctx.world, pr = presetOf(w), sc = scOf(w);
    const V = snap.supplyV, I = runPeak(w), R = pr.R, L = pr.L;
    const head = V - R * I;
    const rise = head > 0 ? (L / R) * Math.log(V / head) * 1000 : Infinity;
    const avg = ringMean(w.traces.get('iA#0'), 0.001).mean;
    const tgt = ringMean(w.traces.get('iAStar#0'), 0.001).mean;
    // The chopper's own per-cycle ripple estimate (the source of metrics.ripplePp, which only
    // publishes every 100 ms of sim time: minutes of real time at this time scale).
    const chop = w.openloop && w.openloop[0] ? w.openloop[0].chopA : null;
    const pp = chop ? chop.ppLast : metrics.ripplePp;
    return [
      { label: 'Rise time', value: rise, unit: 'ms', title: 'From 0 A to the target: (L/R)·ln(V / (V − R·I))' },
      { label: 'Current ramp', value: head / L / 1000, unit: 'A/ms', title: 'How fast the current climbs with the bridge on: (V − R·I)/L' },
      { label: 'Ripple', value: pp * 1000, unit: 'mA p-p', title: 'Peak-to-peak sawtooth per chopper cycle' },
      { label: 'Switching', value: (sc.chopper ? sc.chopper.freqHz : st.chopKHz * 1000) / 1000, unit: 'kHz',
        title: 'Chopper cycles per second' },
      { label: 'Average', value: avg, digits: 3, unit: `A (target ${formatValue(tgt, 3)} A)`,
        ok: Math.abs(avg - tgt) < 0.02 * I, title: 'Mean coil current and mean target over the last 1 ms' },
    ];
  },

  text() {
    return '<p>A stepper driver has no analog output. Each coil sits in an <strong>H-bridge</strong>: four switches '
      + 'that connect it to the supply one way, the other way, or short it.</p>'
      + '<p>With the bridge on, the current ramps up at about V/L, the bus voltage over the coil\'s inductance. '
      + 'A <strong>sense resistor</strong> measures it, and a comparator tells the chopper when it passes the '
      + 'target; the bridge then lets the current decay until the next cycle starts. That happens tens of '
      + 'thousands of times a second.</p>'
      + '<p>The target comes from the sine table (chapter 2), so the run current sets the size of that sine. '
      + 'Klipper\'s <code>run_current</code> is the RMS value; the peak is 1.41 times higher.</p>'
      + '<p>A higher bus voltage ramps the current faster, so the driver keeps up at speed (chapter 5). The '
      + 'sawtooth riding on the target is chopper ripple, part of the hiss you hear from a driver.</p>';
  },

  tryThis: [
    'Raise the inductance: the ramps get flatter, the ripple smaller and the rise time longer.',
    'Raise the bus voltage, then press Switch on: steeper ramps and a shorter rise time.',
    'Lower the chopper frequency: longer cycles and a bigger sawtooth.',
  ],

  deeper(ctx) {
    const w = ctx.world, pr = presetOf(w);
    const V = scOf(w).supplyV || st.bus, I = runPeak(w);
    const ramp = (V - pr.R * I) / pr.L / 1000;
    return '<p>The coil obeys di/dt = (V − e − R·i)/L, with e the back-EMF of the turning rotor (0 at standstill). '
      + `With the bridge on, ${formatValue(V, 0)} V into ${formatValue(pr.L * 1000, 1)} mH at `
      + `${formatValue(I, 2)} A peak gives about ${formatValue(ramp)} A per millisecond.</p>`
      + '<p>Each cycle the current climbs during the drive phase and falls during the decay phases, so the '
      + 'sawtooth grows with V/(L·f): more voltage, less inductance or a lower chopper frequency make it bigger. '
      + 'The torque comes from the average current; the ripple only adds a little heat and noise.</p>';
  },
};
