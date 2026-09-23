// Scenario defaults, deep merge and normalization for World (chunk-02 design section 15).
// Configure-time code only: everything here may allocate.
//
// `runCurrent` defaults to null, which normalization resolves to the motor preset's Irated
// (3.54 A for the stepper presets, 5.6 A for the BLDC), so the scenario always holds a number
// after configure/set. `stopStiffness` (N·m/rad, default 2) is the hard-stop contact stiffness
// passed to the mechanics as kStop. `compareMotor.runCurrent` (only when `compareMotor` is an
// object) is the compare motor's own current: null (the default) follows that motor's own preset
// Irated, which World resolves (an open-loop compare motor on a BLDC scenario is the stepper,
// 3.54 A, not the scenario's 5.6 A).

import { MOTOR_PRESETS } from './presets.js';

/**
 * Recursively freezes a plain object/array tree.
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/**
 * Scenario defaults (contract section 15). `configure(partial)` deep-merges a partial scenario
 * over a copy of this object. Frozen; never mutate.
 * @type {Readonly<object>}
 */
export const SCENARIO_DEFAULTS = deepFreeze({
  motorType: 'stepper', motorPreset: 'stepper', supplyV: 24, driver: 'openloop', driverMode: 'current',
  fidelity: 'averaged', microsteps: 16, interpolate: true, runCurrent: null,
  chopper: { freqHz: 40000, hystA: 0.04, fastFrac: 0.12 }, hybridThresholdMmS: 60,
  mechanics: 'axis', axisLength: 350, hardStops: true, stopStiffness: 2, Jload: 5e-5, start: { x: 50, y: 50 },
  loads: { drag: 0, torque: 0 }, bump: { torque: 0.6, durationS: 0.04 },
  planner: { maxVelocity: 150, accel: 5000, scv: 5, microsteps: 16, fullStepsPerRev: 200 },
  path: null,
  stallguard: { sgthrs: 60, minSpeedMmS: 10 },
  encoder: { cpr: 4000, windowS: 0.5e-3 },
  foc: {
    gains: 'optimal', filters: { torque: 1, flux: 1, velocity: 1 }, homingCurrent: 0.5, homingSpeedMmS: 40, retractMm: 5,
    mask: ['iqTargetLimit', 'uqOutputLimit', 'udOutputLimit'], virtualSteps: { fullStepsPerRev: 4096, microsteps: 2 },
    omegaLimitFactor: 1.2,
  },
  compareMotor: null,   // or { driver, driverMode, runCurrent: null (= its own preset's Irated) }
  traceWindow: 2.0, seed: 1,
});

/** Gain multiplier keys of `foc.gains` (contract section 13). */
export const GAIN_KEYS = Object.freeze(['positionP', 'positionI', 'velocityP', 'velocityI', 'torqueP', 'torqueI', 'fluxP', 'fluxI']);

/** Open-loop driver modes. */
export const OPENLOOP_MODES = Object.freeze(['voltage', 'current', 'hybrid']);
/** FOC driver modes. */
export const FOC_MODES = Object.freeze(['position', 'velocity', 'torque']);

/** Top-level scenario keys whose change rebuilds the world (plus every `encoder.*` key). */
const STRUCTURAL_ROOTS = new Set(['motorType', 'motorPreset', 'driver', 'fidelity', 'mechanics', 'compareMotor']);

/**
 * True for plain objects (not arrays, not null, not typed arrays).
 * @param {*} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

/**
 * Deep copy of a JSON-like value (plain objects, arrays, primitives). Typed arrays are copied.
 * @param {*} v
 * @returns {*}
 */
export function cloneDeep(v) {
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (ArrayBuffer.isView(v)) return v.slice();
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cloneDeep(v[k]);
    return o;
  }
  return v;
}

/**
 * Deep-merges `src` into `target` (mutates and returns `target`). Plain objects merge key by
 * key; arrays, strings, numbers and `null` replace. `undefined` values in `src` are skipped.
 * A plain object replacing a non-object (e.g. `foc.gains: 'optimal'` → multipliers) is copied.
 * @param {object} target
 * @param {object} src
 * @returns {object} target
 */
export function deepMerge(target, src) {
  if (!isPlainObject(src)) return target;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv === undefined) continue;
    const tv = target[k];
    if (isPlainObject(sv) && isPlainObject(tv)) deepMerge(tv, sv);
    else target[k] = cloneDeep(sv);
  }
  return target;
}

/**
 * Sets a dotted path (`'foc.gains.velocityP'`) inside `obj`, creating intermediate objects.
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 */
export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isPlainObject(o[k])) o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
}

/**
 * Reads a dotted path; returns `undefined` when a segment is missing.
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
export function getPath(obj, path) {
  const parts = String(path).split('.');
  let o = obj;
  for (let i = 0; i < parts.length; i++) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[parts[i]];
  }
  return o;
}

/**
 * True when setting `path` must rebuild the world (contract section 15: `motorType, motorPreset,
 * driver, fidelity, mechanics, compareMotor`, plus every `encoder.*` key: the encoder is only
 * configured on a rebuild, so `encoder.cpr` and `encoder.windowS` both rebuild). `traceWindow` is
 * handled separately (it only clears the traces).
 * @param {string} path
 * @returns {boolean}
 */
export function isStructural(path) {
  const root = String(path).split('.')[0];
  return STRUCTURAL_ROOTS.has(root) || root === 'encoder';
}

/**
 * The all-×1 multiplier object (`positionI` 0, i.e. Kix = 0 like 'optimal').
 * @returns {Record<string, number>}
 */
export function unitGains() {
  return { positionP: 1, positionI: 0, velocityP: 1, velocityI: 1, torqueP: 1, torqueI: 1, fluxP: 1, fluxI: 1 };
}

/**
 * `'optimal'` stays a string; an object becomes a complete multiplier object (missing keys 1,
 * `positionI` missing 0).
 * @param {string|object|null} g
 * @returns {'optimal'|Record<string, number>}
 */
export function normalizeGains(g) {
  if (!isPlainObject(g)) return 'optimal';
  const o = unitGains();
  for (const k of GAIN_KEYS) if (typeof g[k] === 'number' && Number.isFinite(g[k])) o[k] = g[k];
  return o;
}

/**
 * Complete filter multiplier object (missing keys 1).
 * @param {object|null} f
 * @returns {{torque: number, flux: number, velocity: number}}
 */
export function normalizeFilters(f) {
  const o = { torque: 1, flux: 1, velocity: 1 };
  if (isPlainObject(f)) {
    for (const k of ['torque', 'flux', 'velocity']) if (typeof f[k] === 'number' && Number.isFinite(f[k])) o[k] = f[k];
  }
  return o;
}

/**
 * Valid driver mode for a driver kind: open loop keeps voltage/current/hybrid (default
 * 'current'), FOC keeps position/velocity/torque (default 'position').
 * @param {'openloop'|'foc'} driver
 * @param {string} mode
 * @returns {string}
 */
export function normalizeDriverMode(driver, mode) {
  if (driver === 'foc') return FOC_MODES.includes(mode) ? mode : 'position';
  return OPENLOOP_MODES.includes(mode) ? mode : 'current';
}

/**
 * Makes a merged scenario consistent, in place:
 * - `motorType` and `motorPreset` agree (`hint` names the key the caller just set; it wins,
 *   otherwise the preset wins); unknown values fall back to the stepper.
 * - `driver` ∈ {openloop, foc}; `driverMode` valid for it; `fidelity`, `mechanics` valid.
 * - `microsteps` is a positive integer and `planner.microsteps` mirrors it.
 * - `runCurrent` null/undefined (or not a finite number ≥ 0) resolves to the preset's Irated.
 * - `stopStiffness` is a finite number > 0 (default 2 N·m/rad).
 * - `compareMotor`, when an object, gets `runCurrent`: a finite number ≥ 0 stays, anything else
 *   becomes null (= the compare motor's own preset Irated, resolved by World).
 * @param {object} sc merged scenario
 * @param {'motorType'|'motorPreset'|null} [hint]
 * @returns {object} sc
 */
export function normalizeScenario(sc, hint = null) {
  if (sc.motorType !== 'bldc' && sc.motorType !== 'stepper') sc.motorType = 'stepper';
  if (!Object.prototype.hasOwnProperty.call(MOTOR_PRESETS, sc.motorPreset)) {
    sc.motorPreset = sc.motorType === 'bldc' ? 'bldc' : 'stepper';
  }
  const ptype = MOTOR_PRESETS[sc.motorPreset].type;
  if (ptype !== sc.motorType) {
    if (hint === 'motorType') sc.motorPreset = sc.motorType === 'bldc' ? 'bldc' : 'stepper';
    else sc.motorType = ptype;
  }
  if (sc.driver !== 'foc') sc.driver = 'openloop';
  sc.driverMode = normalizeDriverMode(sc.driver, sc.driverMode);
  if (sc.fidelity !== 'switching') sc.fidelity = 'averaged';
  if (sc.mechanics !== 'free' && sc.mechanics !== 'corexy') sc.mechanics = 'axis';
  const ms = Math.round(Number(sc.microsteps));
  sc.microsteps = ms >= 1 ? ms : 16;
  if (!isPlainObject(sc.planner)) sc.planner = cloneDeep(SCENARIO_DEFAULTS.planner);
  sc.planner.microsteps = sc.microsteps;
  if (!isPlainObject(sc.start)) sc.start = { x: 50, y: 50 };
  if (!isPlainObject(sc.loads)) sc.loads = { drag: 0, torque: 0 };
  if (!(sc.traceWindow > 0)) sc.traceWindow = 2.0;
  const rc = sc.runCurrent;
  if (!(typeof rc === 'number' && Number.isFinite(rc) && rc >= 0)) sc.runCurrent = MOTOR_PRESETS[sc.motorPreset].Irated;
  const ks = sc.stopStiffness;
  if (!(typeof ks === 'number' && Number.isFinite(ks) && ks > 0)) sc.stopStiffness = 2;
  if (isPlainObject(sc.compareMotor)) {
    const crc = sc.compareMotor.runCurrent;
    if (!(typeof crc === 'number' && Number.isFinite(crc) && crc >= 0)) sc.compareMotor.runCurrent = null;
  }
  return sc;
}
