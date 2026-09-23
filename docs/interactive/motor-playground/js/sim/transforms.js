// Amplitude-invariant Clarke and Park transforms.
// Two-phase (stepper): alpha = A, beta = B (phases at 0 and π/2).
// Three-phase (BLDC): phases at 0, 2π/3, 4π/3;
//   alpha = (2/3)(A − B/2 − C/2), beta = (B − C)/√3.
// Park: d along the rotor magnet, q 90° electrical ahead.
// Every function writes into a caller-owned `out` and returns it; nothing allocates.

import { INV_SQRT3, SQRT3 } from './units.js';

const HALF_SQRT3 = 0.5 * SQRT3;
const TWO_THIRDS = 2 / 3;

/**
 * Two-phase Clarke: out.alpha = iA, out.beta = iB.
 * @param {number} iA
 * @param {number} iB
 * @param {{alpha:number, beta:number}} out
 * @returns {{alpha:number, beta:number}} out
 */
export function clarke2(iA, iB, out) {
  out.alpha = iA;
  out.beta = iB;
  return out;
}

/**
 * Three-phase amplitude-invariant Clarke.
 * @param {number} iA
 * @param {number} iB
 * @param {number} iC
 * @param {{alpha:number, beta:number}} out
 * @returns {{alpha:number, beta:number}} out
 */
export function clarke3(iA, iB, iC, out) {
  out.alpha = TWO_THIRDS * (iA - 0.5 * iB - 0.5 * iC);
  out.beta = (iB - iC) * INV_SQRT3;
  return out;
}

/**
 * Two-phase inverse Clarke: out[0] = alpha, out[1] = beta.
 * @param {number} alpha
 * @param {number} beta
 * @param {ArrayLike<number>} out writable array-like of length ≥ 2
 * @returns {ArrayLike<number>} out
 */
export function invClarke2(alpha, beta, out) {
  out[0] = alpha;
  out[1] = beta;
  return out;
}

/**
 * Three-phase inverse Clarke.
 * @param {number} alpha
 * @param {number} beta
 * @param {ArrayLike<number>} out writable array-like of length ≥ 3
 * @returns {ArrayLike<number>} out
 */
export function invClarke3(alpha, beta, out) {
  out[0] = alpha;
  out[1] = -0.5 * alpha + HALF_SQRT3 * beta;
  out[2] = -0.5 * alpha - HALF_SQRT3 * beta;
  return out;
}

/**
 * Park transform with precomputed cos/sin of the electrical angle:
 * d = α cos + β sin ; q = −α sin + β cos.
 * @param {number} alpha
 * @param {number} beta
 * @param {number} cosT
 * @param {number} sinT
 * @param {{d:number, q:number}} out
 * @returns {{d:number, q:number}} out
 */
export function park(alpha, beta, cosT, sinT, out) {
  out.d = alpha * cosT + beta * sinT;
  out.q = -alpha * sinT + beta * cosT;
  return out;
}

/**
 * Inverse Park with precomputed cos/sin: α = d cos − q sin ; β = d sin + q cos.
 * @param {number} d
 * @param {number} q
 * @param {number} cosT
 * @param {number} sinT
 * @param {{alpha:number, beta:number}} out
 * @returns {{alpha:number, beta:number}} out
 */
export function invPark(d, q, cosT, sinT, out) {
  out.alpha = d * cosT - q * sinT;
  out.beta = d * sinT + q * cosT;
  return out;
}

/**
 * Clarke dispatch on the phase count (2 or 3).
 * Contract signature is `clarke(phases, nPhases, arr, out)` with `arr` the
 * array-like of phase values. For convenience the three-argument form
 * `clarke(arr, nPhases, out)` is also accepted (when `out` is omitted, the
 * first argument is the phase array and the third is `out`). In the
 * four-argument form, if `arr` is null the values are read from `phases`.
 * @param {ArrayLike<number>|*} phases phase values (three-argument form) or ignored
 * @param {number} nPhases 2 or 3
 * @param {ArrayLike<number>|{alpha:number, beta:number}} arr phase values, or `out` in the three-argument form
 * @param {{alpha:number, beta:number}} [out]
 * @returns {{alpha:number, beta:number}} out
 */
export function clarke(phases, nPhases, arr, out) {
  let v = arr;
  let o = out;
  if (o === undefined) {
    o = arr;
    v = phases;
  } else if (v === null) {
    v = phases;
  }
  if (nPhases === 3) return clarke3(v[0], v[1], v[2], o);
  return clarke2(v[0], v[1], o);
}

/**
 * Inverse Clarke dispatch on the phase count (2 or 3).
 * @param {number} alpha
 * @param {number} beta
 * @param {number} nPhases 2 or 3
 * @param {ArrayLike<number>} out writable array-like of length ≥ nPhases
 * @returns {ArrayLike<number>} out
 */
export function invClarke(alpha, beta, nPhases, out) {
  if (nPhases === 3) return invClarke3(alpha, beta, out);
  return invClarke2(alpha, beta, out);
}
