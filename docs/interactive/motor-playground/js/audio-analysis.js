/**
 * Motor sound, analysis half (chunk 08): what the simulated motors would sound like, as voice
 * parameters for the synth in audio.js. No DOM and no Web Audio here, so node tests can drive it
 * with a World.
 *
 * Every level is a torque in N·m (an amplitude for tones, an RMS for noise), so the motors, the
 * hum and the hiss compare on one scale; audio.js maps that scale to loudness. Sources:
 *
 *  1. The motors' own torque ripple, from the model. `sample(world)` runs after every sim step
 *     while the sound is on and keeps 25 kHz samples per motor; `analyze()` takes an FFT of the
 *     latest window, turns the strongest peaks into sine partials and the rest into noise in six
 *     bands (40 Hz to 12 kHz). FOC motors give Kt·iq and Kt·id. Open-loop motors give
 *     Kt·|i|·(sin, cos)(field − rotor angle), with the driver's stepped field angle, or with the
 *     planner's continuous angle when the driver interpolates: the sim hands step pulses to the
 *     driver on its 40 µs control ticks, so an interpolating driver times each step only to 40 µs
 *     and its field wobbles at the beat of the step rate with that tick (a 1 kHz tone of 6 mN·m
 *     at 100 mm/s, half as loud as 16 plain microsteps), which a real driver, timing steps with a
 *     MHz clock, does not do. So microsteps sing at the step rate, louder the coarser they are
 *     and gone with interpolation; a full step rings at the rotor's resonance; a stalled motor
 *     grinds at the slip frequency; a badly tuned FOC loop whines, growls, buzzes or hisses at
 *     the frequencies chapter 8 names; a well-tuned one is nearly silent.
 *  2. A full-step hum (four times the electrical frequency of a stepper, six times that of the
 *     BLDC). A real motor's torque is not a perfect sine of the rotor angle (detent torque and
 *     flux harmonics); the ideal model's is, so this one source is added. Its level follows the
 *     current (HUM_SHARE of Kt·|i|), so an FOC motor carrying only what the load needs hums far
 *     less than an open-loop one at its full run current.
 *  3. A current-mode chopper's hiss (SpreadCycle-like). A voltage-mode (StealthChop-like) or FOC
 *     driver switches at a fixed rate above hearing; a hysteresis chopper's cycle wanders into
 *     the audible range. The level follows the chopper's current ripple: the chopper's own
 *     measurement in switching fidelity, else RIPPLE_K·(V/L)^0.66·I_rms^0.31/f, a fit to that
 *     measurement (within 40% from 12 to 48 V, 0.8 to 8 mH, 20 to 60 kHz, 0.7 to 2.5 A RMS). It
 *     fades out as the driver runs out of voltage (at full duty nothing chops).
 *  4. Hard-stop contacts, as the carriage's speed at impact (`impactMmS`); audio.js knocks with it,
 *     and with the world's stepLost and bump events.
 *
 * The analysis window spans about WINDOW_REAL_S of real time at the current time scale (1024 to
 * 4096 samples, 41 to 164 ms of motor time), so a slowed-down simulation changes its sound at the
 * pace you watch it, while every pitch stays the real one.
 */

const TWO_PI = 2 * Math.PI;

/** Tuning of the analysis (frozen). */
export const SOUND = Object.freeze({
  /** Analysis sample rate (Hz): the averaged sim step of 40 µs. */
  FS: 25000,
  /** Samples kept per motor and signal (a power of two, at least N_MAX). */
  RING: 8192,
  /** FFT sizes (powers of two) and the real time the window aims to span. */
  N_MIN: 1024, N_MAX: 4096, N_FLOOR: 512, WINDOW_REAL_S: 0.4,
  /** Analyzed band (Hz). */
  F_LO: 40, F_HI: 12000,
  /** Sine partials (the strongest peaks) and the noise bands for the rest (Hz). */
  PARTIALS: 6,
  BANDS: Object.freeze([[40, 120], [120, 350], [350, 1000], [1000, 2500], [2500, 6000], [6000, 12000]]),
  /** A peak counts as a tone when its bin beats the local floor by this factor... */
  PROMINENCE: 6,
  /** ...and its main lobe holds at least this share of the analyzed power. */
  MIN_SHARE: 0.01,
  /**
   * Full-step hum: torque harmonic amplitude as a share of Kt·|i| (the BLDC gets half), faded in
   * from 20 to 60 Hz. 0.025 makes 14 mN·m at the stepper's rated current, about the detent torque
   * of a 0.55 N·m NEMA 17 (15 to 25 mN·m on data sheets).
   */
  HUM_SHARE: 0.025, HUM_FADE_LO: 20, HUM_FADE_HI: 60,
  /** Chopper ripple fit (A p-p): RIPPLE_K·(V/L)^RIPPLE_VL·I_rms^RIPPLE_I/f. */
  RIPPLE_K: 4.885, RIPPLE_VL: 0.66, RIPPLE_I: 0.31,
  /**
   * Hiss: torque-equivalent RMS per N·m of Kt·ripple (7 mN·m at 24 V and 11 at 48 V for the
   * stepper at 2.5 A RMS, so a running stepper hums about as loud as it hisses); it fades over the
   * last HISS_HEADROOM of the voltage.
   */
  HISS_PER_RIPPLE: 0.5, HISS_HEADROOM: 0.15,
  /** One-pole low-pass (Hz) ahead of the 0.5 µs steps' decimation to 25 kHz (the 40 kHz chopper ripple). */
  F_DECIM: 8000,
});

/** Cached FFT tables per size: bit reversal, twiddles, Hann window and its power correction. */
const TABLES = new Map();
function tables(n) {
  let t = TABLES.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(TWO_PI * k / n); sin[k] = -Math.sin(TWO_PI * k / n); }
  const win = new Float64Array(n);
  let w2 = 0;
  for (let i = 0; i < n; i++) { win[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / n); w2 += win[i] * win[i]; }
  // Mean square of a stationary signal = Σ|Z_k|² / (n·Σw²) (Parseval with the window).
  t = { rev, cos, sin, win, scale: 1 / (n * w2) };
  TABLES.set(n, t);
  return t;
}

/**
 * In-place complex radix-2 FFT of `re`/`im` (first n entries).
 * @param {Float64Array} re @param {Float64Array} im @param {number} n power of two
 */
function fft(re, im, n) {
  const { rev, cos, sin } = tables(n);
  for (let i = 1; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const a = i + k, b = a + half;
        const wr = cos[tw], wi = sin[tw];
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Largest power of two not above x (at least 1). */
function floorPow2(x) {
  let n = 1;
  while (n * 2 <= x) n *= 2;
  return n;
}

/**
 * Per-step tap and per-frame analysis. Allocation free after construction, except when a new
 * world build is bound (configure-time).
 */
export class SoundAnalyzer {
  constructor() {
    const R = SOUND.RING;
    /** Analysis samples per motor: torque (q) and flux (d) components, N·m. */
    this.q = [new Float32Array(R), new Float32Array(R)];
    this.d = [new Float32Array(R), new Float32Array(R)];
    this.head = 0;
    /** Samples written since the last bind (capped at RING). */
    this.count = 0;
    /** Samples written since the last analyze(). */
    this.fresh = 0;
    // Bound world build.
    this.snap = null;
    this.nm = 0;
    this.isFoc = new Uint8Array(2);
    this.kt = new Float64Array(2);
    this.p = new Float64Array(2);
    this.humOrder = new Float64Array(2);
    this.humShare = new Float64Array(2);
    this.L = new Float64Array(2);
    /** @type {Array<object|null>} open-loop drivers (interpolate, chopA) */
    this.ol = [null, null];
    // Decimation to 25 kHz: sub-steps per sample, a one-pole low-pass ahead of it.
    this.subN = 1;
    this.sub = 0;
    this.lpA = 1;
    this.lp = new Float64Array(4);
    this.acc = new Float64Array(4);
    // Per-motor means since the last analyze(): |i| and |ω|.
    this.sumAmp = new Float64Array(2);
    this.sumW = new Float64Array(2);
    this.nMean = 0;
    this.meanAmp = new Float64Array(2);
    this.meanW = new Float64Array(2);
    // Hard-stop edges and the fastest impact since the last analyze().
    this.stopX = false;
    this.stopY = false;
    this.impact = 0;
    // FFT work space and the spectrum (mean square per bin, N·m²).
    this.re = new Float64Array(SOUND.N_MAX);
    this.im = new Float64Array(SOUND.N_MAX);
    this.pw = new Float64Array(SOUND.N_MAX / 2);
    this.pre = new Float64Array(SOUND.N_MAX / 2 + 1);
    this.used = new Uint8Array(SOUND.N_MAX / 2);
    const P = SOUND.PARTIALS, B = SOUND.BANDS.length;
    this.pkK = new Int32Array(P);
    this.pkPow = new Float64Array(P);
    /**
     * Voice parameters, mutated in place by analyze(): `valid` (a spectrum exists), `n` partials
     * as `freq[i]` Hz and `amp[i]` N·m (strongest first), `bands[b]` noise RMS N·m, `humFreq[m]`
     * and `humAmp[m]` per motor, `hiss` RMS N·m, `total` RMS N·m of all of them, `impactMmS`
     * (fastest hard-stop contact since the last call, mm/s, 0 if none), `window` (samples).
     */
    this.voices = {
      valid: false, n: 0, freq: new Float64Array(P), amp: new Float64Array(P),
      bands: new Float64Array(B), humFreq: new Float64Array(2), humAmp: new Float64Array(2),
      hiss: 0, total: 0, impactMmS: 0, window: 0, spec2: 0,
    };
  }

  /** Forgets every sample (the next analyze() has no spectrum until the window refills). */
  reset() {
    this.snap = null;
    this.count = 0;
    this.fresh = 0;
    this.head = 0;
    this.nMean = 0;
    this.sub = 0;
    this.lp.fill(0);
    this.acc.fill(0);
    this.sumAmp.fill(0);
    this.sumW.fill(0);
    this.impact = 0;
    this.voices.valid = false;
  }

  /** Reads a new world build (configure-time; may allocate nothing but small reads). */
  _bind(world) {
    const s = world.snapshot;
    this.reset();
    this.snap = s;
    const ms = s.motors;
    this.nm = Math.min(2, ms.length);
    const presets = world.presets;
    const ol = world.openloop;
    for (let i = 0; i < 2; i++) {
      const pr = presets && presets[i];
      const drv = ol && ol[i] ? ol[i] : null;
      this.ol[i] = drv;
      this.isFoc[i] = drv === null ? 1 : 0;
      this.kt[i] = pr && pr.Kt > 0 ? pr.Kt : 0.15;
      this.p[i] = pr && pr.p > 0 ? pr.p : 50;
      this.L[i] = pr && pr.L > 0 ? pr.L : 1.6e-3;
      const three = pr ? pr.phases === 3 : false;
      this.humOrder[i] = three ? 6 : 4;
      this.humShare[i] = SOUND.HUM_SHARE * (three ? 0.5 : 1);
    }
    const dt = world.dt > 0 ? world.dt : 1 / SOUND.FS;
    this.subN = Math.max(1, Math.round(1 / (SOUND.FS * dt)));
    this.lpA = this.subN > 1 ? 1 - Math.exp(-TWO_PI * SOUND.F_DECIM * dt) : 1;
    const g = s.gantry;
    this.stopX = !!(g && g.atStopX);
    this.stopY = !!(g && g.atStopY);
  }

  /**
   * One sim step (call after world.step() while the sound is on). Allocation free.
   * @param {object} world
   */
  sample(world) {
    const s = world.snapshot;
    if (s !== this.snap) this._bind(world);
    const ms = s.motors;
    const cmd = world.cmdTheta;
    const lp = this.lp, acc = this.acc, a = this.lpA;
    for (let i = 0; i < this.nm; i++) {
      const m = ms[i];
      const amp = m.iAmp;
      let q, d;
      if (this.isFoc[i] === 1) {
        q = m.iq;
        d = m.id;
      } else {
        const p = this.p[i];
        const drv = this.ol[i];
        const field = drv.interpolate && cmd ? p * cmd[i] : m.thetaCmd;
        const e = field - p * m.thetaM;
        q = amp * Math.sin(e);
        d = amp * Math.cos(e);
      }
      const k = this.kt[i];
      const j = 2 * i;
      lp[j] += a * (k * q - lp[j]);
      lp[j + 1] += a * (k * d - lp[j + 1]);
      acc[j] += lp[j];
      acc[j + 1] += lp[j + 1];
      this.sumAmp[i] += amp;
      const w = m.omegaM;
      this.sumW[i] += w < 0 ? -w : w;
    }
    this.nMean++;
    const g = s.gantry;
    const ax = g.atStopX, ay = g.atStopY;
    if ((ax && !this.stopX) || (ay && !this.stopY)) this._impact(world);
    this.stopX = ax;
    this.stopY = ay;
    if (++this.sub < this.subN) return;
    const inv = 1 / this.sub;
    this.sub = 0;
    const h = this.head;
    for (let i = 0; i < this.nm; i++) {
      const j = 2 * i;
      this.q[i][h] = acc[j] * inv;
      this.d[i][h] = acc[j + 1] * inv;
      acc[j] = 0;
      acc[j + 1] = 0;
    }
    this.head = (h + 1) & (SOUND.RING - 1);
    if (this.count < SOUND.RING) this.count++;
    this.fresh++;
  }

  /** Records the carriage speed at a hard-stop contact (rare; kept out of sample()). */
  _impact(world) {
    const mech = world.mechanics;
    const v = mech ? Math.hypot(mech.vx || 0, mech.vy || 0) : 0;
    if (v > this.impact) this.impact = v;
  }

  /**
   * Voice parameters from the latest samples. Allocation free.
   * @param {object} world
   * @param {number} timeScale sim seconds per real second (sets the window length)
   * @returns {object} this.voices
   */
  analyze(world, timeScale) {
    const v = this.voices;
    const s = world.snapshot;
    if (s !== this.snap) this._bind(world);
    v.impactMmS = this.impact;
    this.impact = 0;
    if (this.nMean > 0) {
      for (let i = 0; i < this.nm; i++) {
        this.meanAmp[i] = this.sumAmp[i] / this.nMean;
        this.meanW[i] = this.sumW[i] / this.nMean;
        this.sumAmp[i] = 0;
        this.sumW[i] = 0;
      }
      this.nMean = 0;
    }
    let total2 = this._spectrum(timeScale);
    total2 += this._hum(v);
    v.hiss = this._hiss(world);
    total2 += v.hiss * v.hiss;
    v.total = Math.sqrt(total2);
    this.fresh = 0;
    return v;
  }

  /** FFT of the latest window → partials and bands; returns their mean square (N·m²). */
  _spectrum(timeScale) {
    const v = this.voices;
    const S = SOUND;
    // Nothing new (a very slow time scale): the last spectrum stands.
    if (this.fresh === 0 && v.valid) return v.spec2;
    let n = floorPow2(Math.max(1, S.FS * (timeScale > 0 ? timeScale : 0) * S.WINDOW_REAL_S) * 1.5);
    n = Math.max(S.N_MIN, Math.min(S.N_MAX, n));
    while (n > this.count && n > S.N_FLOOR) n >>= 1;
    if (this.count < n || this.nm === 0) {
      v.valid = false;
      v.n = 0;
      v.bands.fill(0);
      v.window = 0;
      v.spec2 = 0;
      return 0;
    }
    v.valid = true;
    v.window = n;
    const T = tables(n);
    const re = this.re, im = this.im, pw = this.pw, win = T.win;
    const half = n >> 1;
    pw.fill(0, 0, half);
    const mask = S.RING - 1;
    const start = (this.head - n + S.RING) & mask;
    for (let i = 0; i < this.nm; i++) {
      const Q = this.q[i], D = this.d[i];
      let mq = 0, md = 0;
      for (let k = 0, r = start; k < n; k++, r = (r + 1) & mask) { mq += Q[r]; md += D[r]; }
      mq /= n;
      md /= n;
      for (let k = 0, r = start; k < n; k++, r = (r + 1) & mask) {
        re[k] = (Q[r] - mq) * win[k];
        im[k] = (D[r] - md) * win[k];
      }
      fft(re, im, n);
      // q + i·d is one complex signal: its power at +f and −f together is the mean square at f.
      for (let k = 1; k < half; k++) {
        const kn = n - k;
        pw[k] += (re[k] * re[k] + im[k] * im[k] + re[kn] * re[kn] + im[kn] * im[kn]) * T.scale;
      }
    }
    const df = S.FS / n;
    const kLo = Math.max(3, Math.ceil(S.F_LO / df)), kHi = Math.min(half - 3, Math.floor(S.F_HI / df));
    // Prefix sums for the local floor, and the analyzed total.
    const pre = this.pre;
    pre[0] = 0;
    for (let k = 0; k < half; k++) pre[k + 1] = pre[k] + pw[k];
    const totalIn = pre[kHi + 1] - pre[kLo];
    this.used.fill(0, 0, half);
    // Peaks: local maxima above the local floor (bins 4 to 20 away on both sides), strongest kept.
    const P = S.PARTIALS, pkK = this.pkK, pkPow = this.pkPow;
    let np = 0;
    for (let k = kLo; k <= kHi; k++) {
      const x = pw[k];
      if (!(x > pw[k - 1] && x >= pw[k + 1] && x > pw[k - 2] && x >= pw[k + 2])) continue;
      const a0 = Math.max(0, k - 20), a1 = Math.max(0, k - 3), b0 = Math.min(half, k + 4), b1 = Math.min(half, k + 21);
      const nf = (a1 - a0) + (b1 - b0);
      const floor = nf > 0 ? ((pre[a1] - pre[a0]) + (pre[b1] - pre[b0])) / nf : 0;
      if (!(x > S.PROMINENCE * floor)) continue;
      const lobe = pw[k - 2] + pw[k - 1] + x + pw[k + 1] + pw[k + 2];
      if (!(lobe >= S.MIN_SHARE * totalIn)) continue;
      // Keep the P strongest, sorted by power (insertion).
      let at = np < P ? np : P - 1;
      if (np === P && lobe <= pkPow[at]) continue;
      while (at > 0 && pkPow[at - 1] < lobe) { pkPow[at] = pkPow[at - 1]; pkK[at] = pkK[at - 1]; at--; }
      pkPow[at] = lobe;
      pkK[at] = k;
      if (np < P) np++;
    }
    let sum2 = 0;
    for (let j = 0; j < np; j++) {
      const k = pkK[j];
      const a = Math.log(pw[k - 1] + 1e-30), b = Math.log(pw[k] + 1e-30), c = Math.log(pw[k + 1] + 1e-30);
      const den = a - 2 * b + c;
      const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      v.freq[j] = (k + delta) * df;
      v.amp[j] = Math.sqrt(2 * pkPow[j]);
      sum2 += pkPow[j];
      for (let u = k - 2; u <= k + 2; u++) this.used[u] = 1;
    }
    v.n = np;
    // The rest, per band.
    const bands = S.BANDS;
    for (let b = 0; b < bands.length; b++) {
      const k0 = Math.max(kLo, Math.ceil(bands[b][0] / df)), k1 = Math.min(kHi, Math.floor(bands[b][1] / df) - 1);
      let p2 = 0;
      for (let k = k0; k <= k1; k++) if (this.used[k] === 0) p2 += pw[k];
      v.bands[b] = Math.sqrt(p2);
      sum2 += p2;
    }
    v.spec2 = sum2;
    return sum2;
  }

  /** Full-step hum per motor from the mean speed and current since the last call; mean square. */
  _hum(v) {
    let sum2 = 0;
    for (let i = 0; i < 2; i++) {
      if (i >= this.nm) { v.humAmp[i] = 0; continue; }
      const f = this.humOrder[i] * this.p[i] * this.meanW[i] / TWO_PI;
      const x = (f - SOUND.HUM_FADE_LO) / (SOUND.HUM_FADE_HI - SOUND.HUM_FADE_LO);
      const fade = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
      const a = this.humShare[i] * this.kt[i] * this.meanAmp[i] * fade;
      v.humFreq[i] = f;
      v.humAmp[i] = a;
      sum2 += a * a / 2;
    }
    return sum2;
  }

  /** Chopper hiss of open-loop motors in current mode (RMS N·m). */
  _hiss(world) {
    const s = world.snapshot;
    const S = SOUND;
    let sum2 = 0;
    for (let i = 0; i < this.nm; i++) {
      if (this.isFoc[i] === 1) continue;
      const m = s.motors[i];
      if (m.mode !== 'current') continue;
      const drv = this.ol[i];
      let pp = 0;
      if (s.fidelity === 'switching' && drv.chopA) pp = drv.chopA.ppLast > 0 ? drv.chopA.ppLast : 0;
      else {
        const sc = world.scenario;
        const f = sc && sc.chopper && sc.chopper.freqHz > 0 ? sc.chopper.freqHz : 40000;
        const V = s.supplyV > 0 ? s.supplyV : 24;
        const irms = this.meanAmp[i] / Math.SQRT2;
        pp = irms > 0 ? S.RIPPLE_K * Math.pow(V / this.L[i], S.RIPPLE_VL) * Math.pow(irms, S.RIPPLE_I) / f : 0;
      }
      const head = m.uLimit > 0 ? 1 - m.vAmp / m.uLimit : 1;
      const fade = Math.max(0, Math.min(1, head / S.HISS_HEADROOM));
      const h = S.HISS_PER_RIPPLE * this.kt[i] * pp * fade;
      sum2 += h * h;
    }
    return Math.sqrt(sum2);
  }
}
