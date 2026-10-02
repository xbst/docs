// Low-pass filters for the sim: an RBJ second-order low-pass (direct form II
// transposed) and a cheap first-order low-pass. process() never allocates.

import { TWO_PI } from './units.js';

/**
 * RBJ biquad low-pass, direct form II transposed, unity DC gain.
 * A cutoff of 0 (or less) bypasses the filter.
 */
export class Biquad {
  /**
   * @param {number} fs sample rate in Hz
   */
  constructor(fs) {
    /** Sample rate (Hz). */
    this.fs = fs > 0 ? fs : 1;
    /** Current cutoff (Hz), 0 = bypass. */
    this.f = 0;
    /** Current quality factor. */
    this.q = 0.7071;
    /** True while bypassed. */
    this.bypass = true;
    /** Normalized coefficients. */
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    /** DF2T state. */
    this.z1 = 0;
    this.z2 = 0;
    /** Last output. */
    this.y = 0;
  }

  /**
   * Set the cutoff and Q. f ≤ 0 bypasses (process returns x); f is clamped to 0.45·fs.
   * Leaving bypass restarts the state at the last output so there is no jump.
   * @param {number} f cutoff in Hz
   * @param {number} [Q=0.7071]
   */
  setCutoff(f, Q = 0.7071) {
    const q = Q > 1e-6 ? Q : 1e-6;
    if (!(f > 0)) {
      this.f = 0;
      this.q = q;
      this.bypass = true;
      this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
      return;
    }
    const fMax = 0.45 * this.fs;
    const fc = f > fMax ? fMax : f;
    const wasBypass = this.bypass;
    const w0 = TWO_PI * fc / this.fs;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const inv = 1 / (1 + alpha);
    const b0 = 0.5 * (1 - cw) * inv;
    this.b0 = b0;
    this.b1 = 2 * b0;
    this.b2 = b0;
    this.a1 = -2 * cw * inv;
    this.a2 = (1 - alpha) * inv;
    this.f = fc;
    this.q = q;
    this.bypass = false;
    if (wasBypass) this.reset(this.y);
  }

  /**
   * Set the internal state so the output equals `value` (steady state for input `value`).
   * @param {number} [value=0]
   */
  reset(value = 0) {
    this.z2 = value * (this.b2 - this.a2);
    this.z1 = value * (this.b1 - this.a1) + this.z2;
    this.y = value;
  }

  /**
   * Filter one sample.
   * @param {number} x input
   * @returns {number} output
   */
  process(x) {
    if (this.bypass) {
      this.y = x;
      return x;
    }
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    this.y = y;
    return y;
  }

  /**
   * Current cutoff in Hz (0 = bypass).
   * @returns {number}
   */
  get cutoff() {
    return this.f;
  }
}

/**
 * First-order low-pass: y += k·(x − y), k = 1 − exp(−2πf/fs). f ≤ 0 bypasses.
 */
export class Lowpass1 {
  /**
   * @param {number} fs sample rate in Hz
   */
  constructor(fs) {
    /** Sample rate (Hz). */
    this.fs = fs > 0 ? fs : 1;
    /** Cutoff (Hz), 0 = bypass. */
    this.f = 0;
    /** Smoothing factor (1 = bypass). */
    this.k = 1;
    /** Output / state. */
    this.y = 0;
  }

  /**
   * Set the cutoff; f ≤ 0 bypasses.
   * @param {number} f cutoff in Hz
   */
  setCutoff(f) {
    if (!(f > 0)) {
      this.f = 0;
      this.k = 1;
      return;
    }
    this.f = f;
    this.k = 1 - Math.exp(-TWO_PI * f / this.fs);
  }

  /**
   * Set the output (state) to `value`.
   * @param {number} [value=0]
   */
  reset(value = 0) {
    this.y = value;
  }

  /**
   * Filter one sample.
   * @param {number} x input
   * @returns {number} output
   */
  process(x) {
    this.y += this.k * (x - this.y);
    return this.y;
  }

  /**
   * Current cutoff in Hz (0 = bypass).
   * @returns {number}
   */
  get cutoff() {
    return this.f;
  }
}
