// Shared constants, angle helpers, unit conversions and the seeded PRNG for the
// motor playground sim. SI units internally; millimeters only at the API edges,
// converted with the rotation distance `rd` (mm of belt travel per motor turn).
// Nothing in this file allocates after construction.

/** 2π. */
export const TWO_PI = 2 * Math.PI;
/** π. */
export const PI = Math.PI;
/** π/2. */
export const HALF_PI = 0.5 * Math.PI;
/** √2. */
export const SQRT2 = Math.SQRT2;
/** √3. */
export const SQRT3 = Math.sqrt(3);
/** 1/√3. */
export const INV_SQRT3 = 1 / Math.sqrt(3);

/**
 * Wrap an angle into (−π, π].
 * @param {number} x angle in rad
 * @returns {number} equivalent angle in (−π, π]
 */
export function wrapPi(x) {
  if (x > -PI && x <= PI) return x;
  let y = x - TWO_PI * Math.floor((x + PI) / TWO_PI); // [−π, π)
  if (y <= -PI) y += TWO_PI;
  else if (y > PI) y -= TWO_PI;
  return y;
}

/**
 * Wrap an angle into [0, 2π).
 * @param {number} x angle in rad
 * @returns {number} equivalent angle in [0, 2π)
 */
export function wrapTwoPi(x) {
  if (x >= 0 && x < TWO_PI) return x;
  let y = x - TWO_PI * Math.floor(x / TWO_PI);
  if (y >= TWO_PI) y -= TWO_PI; // rounding guard
  if (y < 0) y = 0;
  return y;
}

/**
 * Clamp x to [lo, hi].
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * Sign of x as −1, 0 or +1 (NaN gives 0).
 * @param {number} x
 * @returns {number}
 */
export function sign(x) {
  return x > 0 ? 1 : (x < 0 ? -1 : 0);
}

/**
 * Belt travel (mm) to motor angle (rad): 2π·mm/rd.
 * @param {number} mm distance in mm
 * @param {number} rd rotation distance, mm per motor turn
 * @returns {number} rad
 */
export function mmToRad(mm, rd) {
  return TWO_PI * mm / rd;
}

/**
 * Motor angle (rad) to belt travel (mm): rad·rd/(2π).
 * @param {number} rad angle in rad
 * @param {number} rd rotation distance, mm per motor turn
 * @returns {number} mm
 */
export function radToMm(rad, rd) {
  return rad * rd / TWO_PI;
}

/**
 * Belt speed (mm/s) to motor speed (rad/s).
 * @param {number} mmS speed in mm/s
 * @param {number} rd rotation distance, mm per motor turn
 * @returns {number} rad/s
 */
export function mmSToRadS(mmS, rd) {
  return TWO_PI * mmS / rd;
}

/**
 * Motor speed (rad/s) to belt speed (mm/s).
 * @param {number} radS speed in rad/s
 * @param {number} rd rotation distance, mm per motor turn
 * @returns {number} mm/s
 */
export function radSToMmS(radS, rd) {
  return radS * rd / TWO_PI;
}

/**
 * Seeded pseudo-random generator (mulberry32) with a Box–Muller gaussian.
 * Deterministic for a given seed; next() and gaussian() never allocate.
 */
export class Rng {
  /**
   * @param {number} [seed=1] any number; only its low 32 bits are used
   */
  constructor(seed = 1) {
    /** Internal 32-bit state. */
    this.state = 0;
    /** True when `spare` holds an unused gaussian sample. */
    this.hasSpare = false;
    /** Cached second Box–Muller sample. */
    this.spare = 0;
    this.reset(seed);
  }

  /**
   * Restart the sequence from `seed`.
   * @param {number} [seed=1]
   */
  reset(seed = 1) {
    this.state = (seed >>> 0);
    this.hasSpare = false;
    this.spare = 0;
  }

  /**
   * Uniform sample in [0, 1).
   * @returns {number}
   */
  next() {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Standard normal sample N(0, 1), Box–Muller with a cached spare.
   * @returns {number}
   */
  gaussian() {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    const u1 = 1 - this.next(); // (0, 1], keeps log finite
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const a = TWO_PI * u2;
    this.spare = r * Math.sin(a);
    this.hasSpare = true;
    return r * Math.cos(a);
  }
}
