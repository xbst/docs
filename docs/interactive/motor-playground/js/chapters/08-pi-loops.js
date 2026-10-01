/**
 * Chapter 8: The four PI loops (SPEC 6.8, chunk 07).
 *
 * A CoreXY gantry under FOC in position mode with the full block diagram
 * beside it. Eight gain sliders and three filter sliders are multiples of the
 * optimal (×1) gains the sim derives for the selected motor (`optimalGains`
 * in `sim/drivers/foc.js`); position I is a multiple of its slider reference
 * `KixRef` (0 = well tuned). Every slider lights its loop, or its filter chip,
 * in the block diagram.
 *
 * Presets set the multipliers to one symptom row of the calibration tables
 * (only the rows this model reproduces; the others are listed under "More info"
 * as things you would also see on hardware), pick a fitting test move, size
 * the gantry loupe to the symptom, and name the symptom beside the preset
 * after 3.5 s of sim time or when the reader presses "Reveal". A line under
 * the preset select names the test move the preset sets, and a note in the
 * Test move section says that a preset switches it. The
 * multipliers were measured on the stepper preset (chunk 07, STATUS.md
 * "Preset multipliers"); the BLDC preset shows the same symptoms, mostly
 * stronger, and where it differs (velocity P too low, torque I too high,
 * filters too high) the symptom sentence depends on the motor type. Moving
 * a slider switches the select to "Custom" (a pending reveal still comes on
 * time, naming the preset the Custom state started from). A motor-type
 * change keeps the preset, or the Custom state and the preset it started
 * from: the framework replays the select, then every slider off its default.
 *
 * Test moves loop on their own: a path restarts one second after it ends
 * (the stop metrics need 0.3 s, the rest-oscillation metric a few 100 ms
 * periods), the hold moves bump the carriage every 1.5 s or load it with a
 * steady torque. Readout thresholds come from the optimal run: corner error
 * 0.08 mm, no overshoot, 0.03 A of "oscillation" at rest (the noise floor),
 * noise index 0.3 % of the rated current, following error v / Kpx (the
 * position loop is P-only, without feed-forward), heat counted above what the
 * load itself needs (the load hold's 0.15 N·m needs 20% of rated on the BLDC,
 * 4% on the stepper).
 *
 * Speed and acceleration (B-009, 2026-10-01): the test move's sliders reach 1000 mm/s and
 * 100 000 mm/s², past what printers run; the supply stays 24 V. From about 600 mm/s the stepper
 * runs out of voltage (its back-EMF) and trails far beyond speed / Kpx: at 1000 mm/s by 26 mm
 * at 20 000 mm/s² and 48 mm at 100 000 mm/s² with the optimal gains (113 mm with flux P too
 * high). The BLDC keeps up (6 and 10 mm). At 48 V three stepper presets (position P too high,
 * position I too high, velocity P too low) run away into the frame with 24 to 26 A at 800 mm/s:
 * the model's current loops have no feed-forward of the d/q cross-coupling (ωL·I), which the
 * voltage limit keeps in check on 24 V.
 */
import { formatValue } from '../format.js';
import { TUNING } from '../sim/drivers/foc.js';
import { MOTOR_PRESETS } from '../sim/presets.js';

const SQUARE = { start: [50, 50], points: [[150, 50], [150, 150], [50, 150], [50, 50]], laps: 1 };
const LINE = { start: [50, 50], points: [[200, 50], [50, 50]], laps: 1 };
/**
 * Where the test moves run ([x0, y0, x1, y1] mm, the square and the line with room for lag and
 * overshoot): the gantry loupe takes the largest circle at the view's top right that keeps clear
 * of it (B-010).
 */
const MOVE_AREA = [35, 35, 215, 165];
/** Rest between two runs of a path (sim s). */
const PAUSE_S = 1.0;
/** Settling time after a stop before a path starts (sim s), so its metrics start clean. */
const SETTLE_S = 0.3;
/** Bump period in the "hold, bumped" move (sim s) and the window the dip/heal readouts watch. */
const BUMP_EVERY_S = 1.5;
const BUMP_WINDOW_S = 1.2;
/** Sim seconds after a preset before its symptom is named. */
const REVEAL_S = 3.5;
/** Load torque of the "hold against a load" move (N·m). */
const HOLD_TORQUE = 0.15;
/** Bump torque per motor type (N·m): the BLDC preset makes at most 0.34 N·m and cannot hold a 0.6 N·m shove. */
const BUMP_TORQUE = { stepper: 0.6, bldc: 0.25 };
/** Bump dip of the optimal run per motor type (mm), the readout's reference. */
const DIP_REF = { stepper: 0.52, bldc: 0.2 };
/** Drag slider maximum per motor type (N·m); the BLDC has little torque to spare. */
const DRAG_MAX = { stepper: 0.3, bldc: 0.2 };
/** Speed fraction that counts as cruise for the following-error readout. */
const CRUISE = 0.9;
/** Rest-oscillation amplitude below which the readout shows no frequency (the noise floor, A). */
const OSC_FLOOR = 0.06;
/**
 * Heat readout thresholds, in points of "% of rated" above the heat the load needs (S.loadHeat): a
 * well-tuned axis stays within HEAT_OK of it, and more than HEAT_WARN above it is the tuning's
 * doing. Without drag the optimal run stays within 1.6 points of it on both motors; the presets
 * that heat the motor add 7 (stepper torque P or flux P too high) to over 90 points.
 */
const HEAT_OK = 2, HEAT_WARN = 10;
/** Time constant of the world's heat reading (s, HEAT_TAU in world.js); the load's heat follows it. */
const HEAT_TAU_S = 1;
const LOUPE_DEFAULT = 1.5;

const GAINS = [
  { id: 'positionP', label: 'Position P', loop: 'position', group: 'Position loop' },
  { id: 'positionI', label: 'Position I', loop: 'position', group: 'Position loop' },
  { id: 'velocityP', label: 'Velocity P', loop: 'velocity', group: 'Velocity loop' },
  { id: 'velocityI', label: 'Velocity I', loop: 'velocity', group: 'Velocity loop' },
  { id: 'torqueP', label: 'Torque P', loop: 'torque', group: 'Torque and flux loops' },
  { id: 'torqueI', label: 'Torque I', loop: 'torque', group: 'Torque and flux loops' },
  { id: 'fluxP', label: 'Flux P', loop: 'flux', group: 'Torque and flux loops' },
  { id: 'fluxI', label: 'Flux I', loop: 'flux', group: 'Torque and flux loops' },
];
const FILTERS = [
  { id: 'torque', ctl: 'torqueFilter', label: 'Torque filter', hl: 'torqueFilter' },
  { id: 'flux', ctl: 'fluxFilter', label: 'Flux filter', hl: 'fluxFilter' },
  { id: 'velocity', ctl: 'velocityFilter', label: 'Velocity filter', hl: 'velocityFilter' },
];

const MOVES = [
  { value: 'square', label: 'Square: corners and a stop' },
  { value: 'line', label: 'Line: two stops' },
  { value: 'holdBump', label: 'Hold, bumped every 1.5 s' },
  { value: 'holdLoad', label: 'Hold against a load torque' },
];

/**
 * Presets: one per symptom row of the calibration tables that this model
 * reproduces. `gains` and `filters` are multipliers (missing = ×1, position I
 * missing = 0), `move` the test move, `loupeMm` the gantry loupe half-width
 * at its reference size, the magnification that makes the symptom visible (the
 * larger loupe shows more around it), `symptom` the sentence named after the
 * reader had time to watch (a function of ctx where the motor type matters).
 */
const PRESETS = [
  { id: 'optimal', label: 'Optimal (×1)', move: 'square', loupeMm: LOUPE_DEFAULT,
    symptom: 'corners within 0.1 mm, no overshoot, and only sensor noise at rest.' },
  { id: 'posP-high', label: 'Position P too high', gains: { positionP: 8 }, move: 'line', highlight: 'position', loupeMm: LOUPE_DEFAULT,
    symptom: 'the axis overshoots its stops and then buzzes there at about 150 Hz with amps of current (see the overshoot and the rest oscillation). On hardware you hear a loud buzz at every stop.' },
  { id: 'posP-low', label: 'Position P too low', gains: { positionP: 0.25 }, move: 'square', highlight: 'position', loupeMm: 4,
    symptom: 'the toolhead runs about 3 mm behind the command at 150 mm/s and cuts every corner (corner error 0.6 mm), so prints come out smaller than commanded.' },
  { id: 'posI-high', label: 'Position I too high', gains: { positionI: 1 }, move: 'square', highlight: 'position', loupeMm: 0.6,
    symptom: 'integral windup. The toolhead overshoots each corner by about 0.1 mm and hooks back, and after a bump it creeps back to the line instead of snapping to it.' },
  { id: 'velP-high', label: 'Velocity P too high', gains: { velocityP: 3 }, move: 'square', highlight: 'velocity', loupeMm: LOUPE_DEFAULT,
    symptom: 'the speed loop hunts at about 150 Hz with amps of current, at rest and after every corner. On hardware you would see ringing-like artifacts on the print.' },
  { id: 'velP-low', label: 'Velocity P too low', gains: { velocityP: 0.25 }, move: 'square', highlight: 'velocity', loupeMm: 4,
    symptom: (ctx) => `the axis lags the target speed, rounds every corner by ${ctx.motorType === 'bldc' ? 'about 1' : '2 to 3'} mm `
      + 'and wobbles (30 to 45 Hz) after each stop.' },
  { id: 'velI-high', label: 'Velocity I too high', gains: { velocityI: 4 }, move: 'square', highlight: 'velocity', loupeMm: LOUPE_DEFAULT,
    symptom: 'the speed oscillates at about 100 Hz after every corner and keeps oscillating at rest.' },
  { id: 'velI-low', label: 'Velocity I too low', gains: { velocityI: 0.1 }, move: 'holdBump', highlight: 'velocity', loupeMm: LOUPE_DEFAULT,
    symptom: 'a bump dips twice as deep and takes four times longer to heal, and under drag the axis runs a few mm/s slow until the integrator catches up.' },
  { id: 'torqueP-high', label: 'Torque P too high', gains: { torqueP: 6 }, move: 'square', highlight: 'torque', loupeMm: LOUPE_DEFAULT,
    symptom: 'the current loop rings at about 1.1 kHz (a high-pitched whine) with more than an amp of current, even at rest. No outer loop can fix this.' },
  { id: 'torqueI-high', label: 'Torque I too high', gains: { torqueI: 10 }, move: 'square', highlight: 'torque', loupeMm: LOUPE_DEFAULT,
    symptom: (ctx) => (ctx.motorType === 'bldc'
      ? 'the current loop is unstable and buzzes at about 800 Hz with amps of current when stationary.'
      : 'a faint 400 Hz buzz when stationary, three times the normal noise; a little more and the current loop goes unstable.') },
  { id: 'fluxP-high', label: 'Flux P too high', gains: { fluxP: 5 }, move: 'square', highlight: 'flux', loupeMm: LOUPE_DEFAULT,
    symptom: 'the flux loop rings at about 1 kHz, so Id, which makes no torque, swings by more than an amp: audible noise and a motor running hot for nothing (see the Heat readout).' },
  { id: 'filters-low', label: 'Filters too low', filters: { torque: 0.5, flux: 0.5, velocity: 0.33 }, move: 'square', highlight: 'filters', loupeMm: 4,
    symptom: 'the loops see their measurements late. The corners round off and after each stop the axis hunts at about 65 Hz; push the filters lower and the current loops go unstable.' },
  { id: 'filters-high', label: 'Filters too high', filters: { torque: 10, flux: 10, velocity: 10 }, move: 'square', highlight: 'filters', loupeMm: LOUPE_DEFAULT,
    symptom: (ctx) => 'sensor noise passes straight into the current. ' + (ctx.motorType === 'bldc'
      ? 'The noise index rises by half while moving (a hiss); the motion stays fine.'
      : 'The noise index more than doubles (a hiss while moving); the motion stays fine.') },
];
const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

const unitGains = () => ({ positionP: 1, positionI: 0, velocityP: 1, velocityI: 1, torqueP: 1, torqueI: 1, fluxP: 1, fluxI: 1 });
const unitFilters = () => ({ torque: 1, flux: 1, velocity: 1 });
const fmtMult = (v) => (v > 0 ? '×' + formatValue(v) : 'off');

/** Chapter state for one visit (reset in onLeave and onEnter). */
const S = {};
/** S.lastPreset as onLeave found it: a Custom state keeps it across a motor-type change (restoreCustom). */
let keptPreset = PRESETS[0];
function resetState() {
  S.gains = unitGains();
  S.filters = unitFilters();
  S.preset = 'optimal';
  S.lastPreset = PRESETS[0];
  S.revealed = true;
  S.revealAt = -1;
  S.move = 'square';
  S.speed = 150;
  S.accel = 5000;
  S.drag = 0;
  S.doneAt = -1;
  S.startAt = -1;
  S.nextBump = -1;
  S.bumpT = -1;
  S.dip = 0;
  S.heal = 0;
  S.follow = 0;
  S.idPeak = 0;
  S.osc = { amp: 0, freq: 0 };
  S.held = { overshootPct: 0, overshootMm: 0, settleMs: 0 };
  S.loadHeat = 0;   // heat the load needs, low-passed like the world's heat reading (fraction of rated; onFrame)
  S.loadHeatT = 0;  // sim time of its last update (s)
}
resetState();

/** Clears the readouts that hold values across moves. */
function clearHeld() {
  S.follow = 0;
  S.idPeak = 0;
  S.dip = 0;
  S.heal = 0;
  S.bumpT = -1;
  S.osc = { amp: 0, freq: 0 };
  S.held = { overshootPct: 0, overshootMm: 0, settleMs: 0 };
}

/** Toolhead position error (mm): Euclidean in CoreXY. */
function posError(snap) {
  const g = snap.gantry;
  return Math.hypot(g.x - g.xCmd, g.y - g.yCmd);
}

/**
 * Decimals of a distance readout (mm), so it stays within four characters up to 999 mm: at
 * 1000 mm/s the stepper, out of voltage on 24 V, trails by up to 113 mm (B-009).
 */
const mmDigits = (v) => (v >= 100 ? 0 : v >= 10 ? 1 : 2);

/**
 * Starts (or restarts) the selected test move: the gantry stops where it is,
 * settles with the current gains, then a path starts from rest. (The metrics
 * restart their corner error on any runPath, but the following-error readout
 * and the loupe trail should not carry the old run into the new one.)
 */
function startMove(c) {
  const w = c.world;
  S.doneAt = -1;
  S.startAt = -1;
  S.follow = 0;
  c.app.setViewOptions('gantry', { clearTrail: true });
  w.command('setLoad', { torque: S.move === 'holdLoad' ? HOLD_TORQUE : 0 });
  w.command('stop', { immediate: true });
  if (S.move === 'square' || S.move === 'line') S.startAt = w.snapshot.t + SETTLE_S;
  S.nextBump = S.move === 'holdBump' ? w.snapshot.t + 0.8 : -1;
}

/** Runs the selected path from rest (the first run and every repeat). */
function runPath(c) {
  S.doneAt = -1;
  S.follow = 0;
  c.app.setViewOptions('gantry', { clearTrail: true });
  c.world.command('runPath', { path: S.move === 'line' ? LINE : SQUARE });
}

function setMove(c, move) {
  S.move = move;
  clearHeld();
  startMove(c);
}

/**
 * A slider moved: the preset no longer applies. A reveal still pending keeps its time, so the
 * text names the symptom as promised, as the one the Custom state "started from".
 */
function markCustom(c) {
  if (S.preset === 'custom') return;
  S.preset = 'custom';
  c.app.setControlValue('preset', 'custom');
  refreshSymptom(c);
}

/**
 * The preset select sends "Custom" (which the reader cannot pick) only when the
 * framework replays it after a motor-type change: the Custom state comes back,
 * still started from the preset it had before the switch.
 */
function restoreCustom(c) {
  S.lastPreset = keptPreset;
  markCustom(c);
}

// Both return early on an unchanged value: after a motor-type change the framework replays
// the sliders a replayed preset has already set, and those are not slider moves.
function setGain(c, g, v) {
  if (v === S.gains[g.id]) return;
  S.gains[g.id] = v;
  c.world.set('foc.gains.' + g.id, v);
  c.app.setHighlight(g.loop);
  markCustom(c);
}

function setFilter(c, f, v) {
  if (v === S.filters[f.id]) return;
  S.filters[f.id] = v;
  c.world.set('foc.filters.' + f.id, v);
  c.app.setViewOptions('blocks', { filters: Object.assign({}, S.filters) });
  c.app.setHighlight(f.hl);
  markCustom(c);
}

/** Names the current preset's symptom beside its controls and in the explanation. */
function reveal(c) {
  S.revealed = true;
  S.revealAt = -1;
  refreshSymptom(c);
}

function applyPreset(c, id) {
  const p = PRESET_BY_ID.get(id);
  if (!p) return;
  S.preset = id;
  S.lastPreset = p;
  S.gains = Object.assign(unitGains(), p.gains || {});
  S.filters = Object.assign(unitFilters(), p.filters || {});
  c.world.set('foc.gains', Object.assign({}, S.gains));
  c.world.set('foc.filters', Object.assign({}, S.filters));
  for (const g of GAINS) c.app.setControlValue(g.id, S.gains[g.id]);
  for (const f of FILTERS) c.app.setControlValue(f.ctl, S.filters[f.id]);
  c.app.setViewOptions('blocks', { filters: Object.assign({}, S.filters) });
  c.app.setViewOptions('gantry', { loupeMm: p.loupeMm || LOUPE_DEFAULT });
  c.app.setHighlight(p.highlight || null);
  S.revealed = id === 'optimal';
  S.revealAt = S.revealed ? -1 : c.world.snapshot.t + REVEAL_S;
  if (p.move && p.move !== S.move) {
    S.move = p.move;
    c.app.setControlValue('move', p.move);
  }
  clearHeld();
  startMove(c);
  refreshSymptom(c);
}

/** Keep the visible notes current without replacing a slider being adjusted. */
function refreshSymptom(c) {
  c.app.setControlValue('presetMove', presetMoveHtml());
  c.app.setControlValue('symptom', symptomHtml(c));
  c.app.refreshText();
}

/**
 * The line under the preset select: the test move the preset (or the one a Custom state started
 * from) sets. The move select sits in another section, so a preset switched the move unseen (B-011).
 */
function presetMoveHtml() {
  const m = MOVES.find((x) => x.value === S.lastPreset.move);
  return m ? `Also sets the test move to "${m.label}".` : '';
}

function symptomHtml(ctx) {
  const p = S.lastPreset;
  if (!p) return '';
  const custom = S.preset === 'custom';
  const s = typeof p.symptom === 'function' ? p.symptom(ctx) : p.symptom;
  const head = custom ? `Started from "${p.label}"` : (p.id === 'optimal' ? 'Reference' : p.label);
  const named = `<strong>${head}:</strong> ${s}`;
  if (p.id === 'optimal' && !custom) return `<p>${named}</p>`;
  // The placeholder and the symptom share one grid cell (.stack), the hidden one invisible and
  // second, so the paragraph is as tall as the longer before and after the reveal and nothing below
  // it moves (B-006).
  const waiting = `<strong>${custom ? 'Started from' : 'Preset'} "${p.label}":</strong> watch the gantry loupe, the scope and `
    + `the readouts. What changed? The symptom is named here after ${REVEAL_S} s of motor time, or press Reveal.`;
  const [shown, hidden] = S.revealed ? [named, waiting] : [waiting, named];
  return `<p class="stack"><span>${shown}</span><span aria-hidden="true">${hidden}</span></p>`;
}

const ROWS = [
  ['Whine or buzz at rest', 'torque P or I down'],
  ['Speed hunts after corners', 'velocity P or I down'],
  ['Rounded corners, lag', 'velocity P, then position P up'],
  ['Overshoot and buzz at stops', 'position P down'],
  ['Corner overshoot, hook back', 'position I to 0'],
  ['Hiss while moving', 'filters down'],
];
const TEXT = '<p>Chapter 7\'s torque and flux loops are the inner half of a cascade: the <strong>position loop</strong> '
  + 'turns position error into a speed target, the <strong>velocity loop</strong> turns speed error into a torque '
  + 'current (Iq) target, the <strong>torque loop</strong> sets the coil voltage until Iq matches, and the '
  + '<strong>flux loop</strong> holds Id at zero.</p>'
  + '<p>Each is a PI controller: <strong>P</strong> reacts to the error now (too little lags, too much oscillates), '
  + '<strong>I</strong> removes a steady offset (too much winds up). Tune from the inside out: no outer loop can calm '
  + 'a ringing torque loop.</p>'
  + '<p>The <strong>filters</strong> smooth the measured currents and speed: too high lets sensor noise through '
  + '(hiss), too low delays the loops until they oscillate.</p>'
  + '<table><tr><th>Symptom</th><th>Knob</th></tr>'
  + ROWS.map(([s, k]) => `<tr><td>${s}</td><td>${k}</td></tr>`).join('')
  + '</table>';

const DEEPER = `<p>Loop bandwidths in this model: current loops ${TUNING.fc} Hz with their sense filters at `
  + `${formatValue(TUNING.fFilter / 1000, 1)} kHz, velocity loop ${TUNING.fv} Hz with its filter at ${TUNING.fVel} Hz, `
  + `position loop ${TUNING.fx} Hz. The position loop has no feed-forward, so at cruise the toolhead trails the command by `
  + `speed / P (${formatValue(150 / (2 * Math.PI * TUNING.fx), 2)} mm at 150 mm/s) even when well tuned; the corners `
  + 'stay sharp because both axes trail alike. From about 600&nbsp;mm/s the stepper runs out of voltage on this '
  + '24&nbsp;V supply (chapter 5) and trails far more, whatever the tuning; the BLDC keeps up.</p>'
  + '<p>On hardware you would also see symptoms this model does not reproduce, so they have no preset: torque P too '
  + 'low (overshoot on fast moves), torque I too low (slow position loss under a static load), flux P too low (less '
  + 'torque at speed) and position I too low (drift during long prints).</p>';

export default {
  id: 'pi-loops', number: 8, title: 'The four PI loops', short: 'PI loops',
  takeaway: 'Position asks velocity, velocity asks torque, torque asks the coils: tune from the inside out.',
  motorTypes: ['stepper', 'bldc'],
  timeScale: { default: 0.25, min: 0.01, max: 1 },
  traceWindow: 2.0,
  stage: { primary: 'gantry', secondary: 'blocks', split: 0.55 },
  // The loupe at the top right, clear of the moves and as large as the view allows; it keeps the
  // toolhead in sight however far it lags; the inspect lens magnifies any point of the paths (B-010).
  viewOptions: {
    gantry: { loupe: true, loupeMm: LOUPE_DEFAULT, loupeAt: 'tr', loupeClear: MOVE_AREA, loupeFit: true, inspect: true },
    blocks: { filters: { torque: 1, flux: 1, velocity: 1 } },
  },
  hint: `Every slider lights its loop in the block diagram. The Presets controls name the symptom after ${REVEAL_S} s `
    + 'of motor time, or press Reveal. Point at the paths on the gantry, or tap them, to magnify them.',

  scenario(motorType) {
    return {
      motorType, motorPreset: motorType === 'bldc' ? 'bldc' : 'stepper', driver: 'foc', driverMode: 'position',
      mechanics: 'corexy', supplyV: 24, path: null, start: { x: 50, y: 50 },
      planner: { maxVelocity: 150, accel: 5000, scv: 5 }, loads: { drag: 0, torque: 0 },
      foc: { gains: 'optimal', filters: { torque: 1, flux: 1, velocity: 1 } },
    };
  },

  onEnter(ctx) {
    resetState();
    ctx.app.setViewOptions('blocks', { filters: Object.assign({}, S.filters) });
    ctx.app.setViewOptions('gantry', { loupeMm: LOUPE_DEFAULT });
    startMove(ctx);
  },

  onLeave() {
    keptPreset = S.lastPreset;
    resetState();
  },

  controls(ctx) {
    const keys = ctx.product.keys || {};
    const type = ctx.motorType;
    const gain = (g) => Object.assign({
      type: 'slider', id: g.id, label: g.label, group: g.group, value: S.gains[g.id], caption: keys[g.id],
      format: fmtMult, onChange: (v, c) => setGain(c, g, v),
    }, g.id === 'positionI'
      ? { min: 0, max: 4, step: 0.05, title: 'Multiples of a reference integral gain; 0 is the well-tuned value' }
      : { min: 0.1, max: 10, step: 0.01, log: true });
    const filt = (f) => ({
      type: 'slider', id: f.ctl, label: f.label, group: 'Filters', min: 0.25, max: 10, step: 0.01, log: true,
      value: S.filters[f.id], caption: keys[f.ctl], format: fmtMult, onChange: (v, c) => setFilter(c, f, v),
      title: 'Multiples of the well-tuned cutoff frequency',
    });
    // A product's own tuning advice (notes.pi) takes the place of the generic hardware sentence.
    const pn = ctx.product.notes && ctx.product.notes.pi;
    const note = '×1 is a well-tuned value for this simulated motor. '
      + (pn || 'On your hardware, start from the values your driver\'s autotune gives you and move in the '
        + 'direction the symptoms point.');
    return [
      { type: 'select', id: 'preset', label: 'Preset', group: 'Presets', value: S.preset,
        options: PRESETS.map((p) => ({ value: p.id, label: p.label })).concat([{ value: 'custom', label: 'Custom (sliders moved)', disabled: true }]),
        onChange: (v, c) => (v === 'custom' ? restoreCustom(c) : applyPreset(c, v)) },
      { type: 'note', id: 'presetMove', kind: 'help', group: 'Presets', html: presetMoveHtml() },
      { type: 'button', id: 'reveal', label: 'Reveal the symptom', group: 'Presets', onClick: (c) => reveal(c) },
      { type: 'note', id: 'symptom', group: 'Presets', html: symptomHtml(ctx) },
      { type: 'select', id: 'move', label: 'Test move', group: 'Test move', value: S.move, options: MOVES,
        onChange: (v, c) => setMove(c, v) },
      { type: 'note', group: 'Test move',
        html: 'A preset switches the test move to the one that shows its symptom. To try a preset on another '
          + 'move, pick the move after the preset.' },
      { type: 'slider', id: 'speed', label: 'Speed', group: 'Test move', min: 50, max: 1000, step: 1, sig: 2, log: true, value: S.speed,
        unit: 'mm/s', live: false, onChange: (v, c) => { S.speed = v; c.world.set('planner.maxVelocity', v); startMove(c); } },
      { type: 'slider', id: 'accel', label: 'Acceleration', group: 'Test move', min: 1000, max: 100000, step: 1, sig: 2, log: true,
        value: S.accel, unit: 'mm/s²', live: false,
        onChange: (v, c) => { S.accel = v; c.world.set('planner.accel', v); startMove(c); } },
      { type: 'slider', id: 'drag', label: 'Drag', group: 'Test move', min: 0, max: DRAG_MAX[type] || 0.3, step: 0.01, value: S.drag,
        unit: 'N·m', onChange: (v, c) => { S.drag = v; c.world.command('setLoad', { drag: v }); } },
      { type: 'button', id: 'bump', label: 'Bump', group: 'Test move',
        onClick: (c) => c.world.command('bump', { torque: BUMP_TORQUE[c.motorType] || 0.6 }) },
      ...GAINS.map(gain),
      ...FILTERS.map(filt),
      { type: 'button', id: 'reset', label: 'Reset to optimal', kind: 'primary', group: 'Reference',
        onClick: (c) => { applyPreset(c, 'optimal'); c.app.setControlValue('preset', 'optimal'); } },
      { type: 'note', group: 'Reference', html: note },
    ];
  },

  traces: [
    { name: 'posCmd', motor: 0, label: 'Commanded X', unit: 'mm', color: 'target', dashed: true },
    { name: 'posAct', motor: 0, label: 'Actual X', unit: 'mm', color: 'phase-a' },
    { name: 'posErr', motor: 0, label: 'Position error X', unit: 'mm', color: 'err', scale: 'error', minSpan: 0.5 },
    { name: 'velCmd', motor: 0, label: 'Commanded speed X', unit: 'mm/s', color: 'target', dashed: true },
    { name: 'velAct', motor: 0, label: 'Actual speed X', unit: 'mm/s', color: 'phase-c' },
    { name: 'iqStar', motor: 0, label: 'Iq target, motor A', unit: 'A', color: 'axis-q', dashed: true },
    { name: 'iq', motor: 0, label: 'Torque current Iq, motor A', unit: 'A', color: 'axis-q' },
    { name: 'id', motor: 0, label: 'Flux current Id, motor A', unit: 'A', color: 'axis-d' },
    // No minSpan: the amps default (±0.2 A) keeps the optimal noise a thin band, so noisier presets stand out.
    { name: 'noise', motor: 0, label: 'Current noise, motor A', unit: 'A', color: 'phase-b', scale: 'noise' },
  ],

  onEvent(ev) {
    if (ev.type === 'pathDone') { S.doneAt = ev.t; return false; }
    if (ev.type === 'bump') { S.bumpT = ev.t; S.dip = 0; S.heal = 0; return false; }
    return undefined;
  },

  onFrame(ctx, snap) {
    const w = ctx.world;
    const m = w.metrics;
    const t = snap.t;
    if (S.startAt >= 0 && t >= S.startAt) { S.startAt = -1; runPath(ctx); }
    if (S.doneAt >= 0 && t - S.doneAt >= PAUSE_S) runPath(ctx);
    if (S.move === 'holdBump' && S.nextBump >= 0 && t >= S.nextBump) {
      w.command('bump', { torque: BUMP_TORQUE[ctx.motorType] || 0.6 });
      S.nextBump = t + BUMP_EVERY_S;
    }
    if (S.revealAt >= 0 && t >= S.revealAt) reveal(ctx);
    // Readouts that hold a value: the last at-rest oscillation, the last stop's overshoot and
    // settle time, the following error at cruise, the bump dip and heal time, the recent Id peak.
    if (m.oscAmp > 0) { S.osc.amp = m.oscAmp; S.osc.freq = m.oscFreqHz; }
    const pl = snap.planner;
    if (pl.mode === 'idle') {
      S.held.overshootPct = m.overshootPct;
      S.held.overshootMm = m.overshootMm;
      S.held.settleMs = m.settleMs;
    } else if (Math.hypot(pl.vx, pl.vy) >= CRUISE * S.speed) {
      const e = posError(snap);
      if (e > S.follow) S.follow = e;
    }
    if (S.bumpT >= 0 && t - S.bumpT <= BUMP_WINDOW_S) {
      const e = posError(snap);
      if (e > S.dip) S.dip = e;
      if (e >= 0.03) S.heal = t - S.bumpT;
    }
    const id = Math.abs(snap.motors[0].id);
    S.idPeak = id > S.idPeak ? id : S.idPeak * 0.985;
    // The heat the load needs whatever the tuning (a fraction of rated, like metrics.heat): the load
    // torque's current over the rated current, squared. The load hold holds HOLD_TORQUE, the drag acts
    // while the gantry moves. The same torque costs the BLDC about 5.4 times the stepper's heat
    // (Kt·Irated 0.34 against 0.78 N·m). Low-passed like the world's heat reading, so the Heat chip's
    // thresholds follow a load switched on or off at the pace of the reading itself.
    const mp = MOTOR_PRESETS[ctx.motorType] || MOTOR_PRESETS.stepper;
    const r = ((S.move === 'holdLoad' ? HOLD_TORQUE : 0) + (pl.mode !== 'idle' ? S.drag : 0)) / (mp.Kt * mp.Irated);
    const dt = t - S.loadHeatT;
    S.loadHeatT = t;
    if (dt > 0) S.loadHeat += (1 - Math.exp(-dt / HEAT_TAU_S)) * (r * r - S.loadHeat);
  },

  readouts(snap, metrics, ctx) {
    const type = ctx.motorType;
    const osc = S.osc;
    // A period with no counted zero crossing (a swing under the counter's hysteresis, e.g. right
    // after a preset switch away from a larger ring) has no frequency to name: the amplitude
    // alone, not "at 0 Hz".
    const oscText = osc.amp > OSC_FLOOR && osc.freq > 0
      ? `${formatValue(osc.amp, 2)} A at ${formatValue(osc.freq, 0)} Hz`
      : `${formatValue(osc.amp, 2)} A`;
    // Every value keeps room for what the worst preset makes of it ("3.77 A at 165 Hz", 10.05%,
    // 1200 ms), so the chip rows stay put as a preset's symptom builds up (B-006).
    const items = [];
    if (S.move === 'holdBump') {
      const ref = DIP_REF[type] || 0.5;
      items.push({ label: 'Bump dip', value: S.dip, unit: 'mm', digits: 2, warn: S.dip > 1.5 * ref, ok: S.dip > 0 && S.dip <= 1.2 * ref,
        minChars: 4, title: 'Largest position error after the last bump' });
      items.push({ label: 'Heal time', value: S.heal * 1000, unit: 'ms', digits: 0, warn: S.heal > 0.15, ok: S.heal > 0 && S.heal <= 0.1,
        minChars: 4, title: 'Time after the bump until the error stays below 0.03 mm' });
    } else if (S.move === 'holdLoad') {
      const e = metrics.posErrMm;
      items.push({ label: 'Position error', value: e, unit: 'mm', digits: 3, warn: e > 0.05, ok: e <= 0.02, minChars: 5 });
      items.push({ label: 'Holding current', value: Math.abs(snap.motors[0].iq), unit: 'A', digits: 2, minChars: 4,
        title: 'Iq that holds the load torque' });
    } else {
      const h = S.held;
      items.push({ label: 'Overshoot', value: h.overshootPct, unit: '%', digits: 1, warn: h.overshootPct > 2, ok: h.overshootPct < 0.5,
        minChars: 5, title: `${formatValue(h.overshootMm, 3)} mm past the last stop, as a share of the deceleration distance` });
      items.push({ label: 'Settle', value: h.settleMs, unit: 'ms', digits: 0, warn: h.settleMs > 100, ok: h.settleMs <= 50,
        minChars: 4, title: 'Time after the stop until the error stays below 0.02 mm' });
      items.push({ label: 'Corner error', value: metrics.cornerErrMm, unit: 'mm', digits: mmDigits(metrics.cornerErrMm),
        warn: metrics.cornerErrMm > 0.15, ok: metrics.cornerErrMm <= 0.1, minChars: 4 });
      const expect = S.speed / (2 * Math.PI * TUNING.fx);
      items.push({ label: 'Following error', value: S.follow, unit: 'mm', digits: mmDigits(S.follow),
        warn: S.follow > 1.6 * expect, ok: S.follow > 0 && S.follow <= 1.2 * expect, minChars: 4,
        title: 'Largest distance behind the commanded point at cruise speed (a P-only position loop trails by speed / Kpx)' });
    }
    items.push({ label: 'Oscillation at rest', value: oscText, warn: osc.amp > 0.1, ok: osc.amp > 0 && osc.amp <= OSC_FLOOR,
      minChars: 16, title: 'Iq oscillation while the gantry holds still (0.03 A is the sensor-noise floor)' });
    const nz = metrics.noiseIdx * 100;
    items.push({ label: 'Noise index', value: nz, unit: '%', digits: 2, warn: nz > 0.8, ok: nz <= 0.5, minChars: 6,
      title: 'High-frequency content of the torque loop\'s output as a share of the rated current' });
    items.push({ label: 'Flux current peak', value: S.idPeak, unit: 'A', digits: 2, warn: S.idPeak > 0.5, ok: S.idPeak <= 0.2,
      minChars: 4, title: 'Recent peak of |Id|, the current that heats the motor without making torque' });
    const heat = metrics.heat * 100;
    const need = S.loadHeat * 100;   // a load warms the motor at any tuning, the BLDC far more than the stepper
    items.push({ label: 'Heat', value: heat, unit: '% of rated', digits: 0, warn: heat > need + HEAT_WARN, ok: heat <= need + HEAT_OK,
      minChars: 4,
      title: 'Copper loss compared with running at the rated current, averaged over the last second'
        + (need >= 0.5 ? `; the load alone needs about ${formatValue(need, 0)}%` : '') });
    return items;
  },

  text: (ctx) => TEXT + symptomHtml(ctx),
  tryThis: [
    'Run each preset and name the symptom before it is revealed.',
    'Set torque P to ×6, then try to calm the whine with position P or velocity P. You can\'t: fix the inner loop first.',
    'Pick a bad preset and tune it back to good with the sliders, checking the readouts against the optimal run.',
  ],
  deeper: () => DEEPER,
};
