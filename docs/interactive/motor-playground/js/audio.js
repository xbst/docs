/**
 * Motor sound (chunk 08): an optional Web Audio synth that plays what the simulated motors would
 * sound like, and the toolbar button that turns it on.
 *
 * Off by default. The AudioContext is created by the button's click (browsers start audio only
 * from a user gesture); nothing runs before. The analysis (audio-analysis.js) reads every sim step
 * while the sound is on (main.js calls `analyzer.sample(world)` after each `world.step()`) and the
 * synth follows it once per frame (`frame`): up to six sine partials and six noise bands rebuild
 * the motors' torque ripple, plus a full-step hum per motor, a current-mode chopper's hiss and
 * knocks for hard stops, lost steps and bumps (`event`). Levels arrive as torques (N·m); one
 * loudness curve, Y = Y_REF·(L/L_REF)^GAMMA for the total L, scales every voice alike, so the
 * mix keeps its balance while the range between a whisper and a stall shrinks to a listenable one.
 *
 * It falls silent, and the AudioContext suspends, while the simulation is paused, when the frame
 * loop idles (the widget scrolled out of view, a closed admonition) or the page is hidden. The
 * on/off state lasts for the session (every chapter); the volume is remembered in localStorage.
 *
 * UI: the button toggles the sound (aria-pressed). Turning it on opens a small popover under it
 * with the volume slider and a line on what you hear; Escape, a click elsewhere or turning the
 * sound off closes it.
 */
import { SoundAnalyzer, SOUND } from './audio-analysis.js';

/** Loudness and voice tuning (frozen). */
export const MIX = Object.freeze({
  /**
   * Output RMS Y_REF at an analyzed torque RMS of L_REF (N·m); GAMMA < 1 narrows the range (a
   * tenfold torque is 16 dB, not 20). Measured totals: a well-tuned FOC axis 2.6 mN·m at rest and
   * 6 in motion, 16 plain microsteps 17, full steps 365, a hunting loop or a stall 300 to 700.
   */
  L_REF: 0.3, Y_REF: 0.4, GAMMA: 0.8,
  /** Volume slider default (%) and the gain at 100% (the slider is squared). */
  VOLUME: 80, VOLUME_MAX: 1,
  /** Smoothing (s): voice gains, partial glides, the pause/idle fade. */
  TAU_GAIN: 0.05, TAU_FREQ: 0.03, TAU_FADE: 0.015,
  /** Seconds of silence before the AudioContext suspends; frames missing this long mean idle (ms). */
  SUSPEND_S: 0.4, IDLE_MS: 300,
  /** A partial follows a peak within this many octaves; a free partial waits this long before reuse (s). */
  TRACK_OCT: 0.08, REUSE_S: 0.15,
  /** Knocks: torque equivalents (N·m) and the shortest gap between two of a kind (ms). */
  THUMP_PER_MMS: 0.002, THUMP_MAX: 0.45, CLACK: 0.15, CLACK_PER_CYCLE: 0.08, CLACK_MAX: 0.45, KNOCK_SHARE: 0.6,
  CLICK_GAP_MS: 45,
});

const STORE_KEY = 'motorPlayground.soundVolume';
const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10L5 10H2z"/>'
  + '<path class="snd-on" d="M11.2 5.6a3.4 3.4 0 0 1 0 4.8M13.2 3.6a6.2 6.2 0 0 1 0 8.8"/>'
  + '<path class="snd-off" d="M11 6.2l3.6 3.6M14.6 6.2L11 9.8"/></svg>';
const NOTE = 'Synthesized from the simulation: the vibration the motor currents cause (steps, ringing, loop '
  + 'oscillations, noise), the hiss of a current-mode chopper, and knocks at the hard stops. It plays while '
  + 'the simulation runs, at real pitch even in slow motion.';

/** Small deterministic noise for the knock samples. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296 * 2 - 1;
  };
}

/** A mono buffer of `seconds` from fn(t, noise), normalized to a peak of 1. */
function makeBuffer(ac, seconds, fn, seed = 7) {
  const rate = ac.sampleRate;
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = ac.createBuffer(1, n, rate);
  const x = buf.getChannelData(0);
  const noise = rng(seed);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    x[i] = fn(i / rate, noise);
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) for (let i = 0; i < n; i++) x[i] /= peak;
  return buf;
}

/** Two-pole resonator (biquad band-pass, constant peak gain) over a sample stream, for the knocks. */
function resonator(rate, f, q) {
  const w = 2 * Math.PI * f / rate, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const b0 = alpha / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Output RMS for a torque RMS (N·m) on the shared loudness curve. */
function loudness(L) {
  return L > 0 ? MIX.Y_REF * Math.pow(L / MIX.L_REF, MIX.GAMMA) : 0;
}

function readVolume() {
  try {
    const v = Number(localStorage.getItem(STORE_KEY));
    if (localStorage.getItem(STORE_KEY) !== null && v >= 0 && v <= 100) return v;
  } catch (err) { /* storage blocked */ }
  return MIX.VOLUME;
}

function writeVolume(v) {
  try { localStorage.setItem(STORE_KEY, String(v)); } catch (err) { /* storage blocked */ }
}

/** The toolbar sound: UI, synth and its analyzer. One per page; inert until the button turns it on. */
export class MotorSound {
  /** True where Web Audio exists. */
  static get supported() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }

  constructor() {
    /** The analyzer main.js feeds every sim step while `listening` is true. */
    this.analyzer = new SoundAnalyzer();
    /** True while the sound is on (main.js taps the steps). */
    this.listening = false;
    /** The reader's on/off choice. */
    this.on = false;
    /** True while sound plays (on, running, visible). */
    this.active = false;
    this.volume = readVolume();
    this.ac = null;
    this.lastFrame = 0;
    this.lastAnalysis = 0;
    this.lastClick = { thump: 0, clack: 0, knock: 0 };
    this.watchdog = 0;
    this.suspendTimer = 0;
    this.gestureArmed = false;
    this.button = null;
    this.pop = null;
  }

  /* ---------------- UI ---------------- */

  /**
   * Wires the toolbar button (index.html's #sound, shown by app.registerSoundButton()) and builds
   * its popover beside it.
   * @param {HTMLButtonElement} button
   */
  mount(button) {
    if (!button || this.button) return;
    this.button = button;
    button.innerHTML = ICON;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Motor sound');
    button.title = 'Motor sound';
    const wrap = document.createElement('span');
    wrap.className = 'snd';
    button.before(wrap);
    wrap.append(button);
    const pop = document.createElement('div');
    pop.className = 'snd-pop';
    pop.id = 'snd-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'group');
    pop.setAttribute('aria-label', 'Sound');
    pop.innerHTML = '<div class="snd-h"><label for="snd-vol">Volume</label><output id="snd-out" for="snd-vol"></output></div>'
      + '<input type="range" id="snd-vol" min="0" max="100" step="5">'
      + `<p class="snd-note">${NOTE}</p>`;
    wrap.append(pop);
    this.pop = pop;
    this.wrap = wrap;
    this.slider = pop.querySelector('#snd-vol');
    this.out = pop.querySelector('#snd-out');
    button.setAttribute('aria-controls', pop.id);
    button.setAttribute('aria-expanded', 'false');
    this._showVolume();
    button.addEventListener('click', () => this.toggle());
    this.slider.addEventListener('input', () => {
      this.volume = +this.slider.value;
      this._showVolume();
      this._applyVolume();
      writeVolume(this.volume);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.pop.hidden) return;
      e.stopPropagation();
      this._closePop();
      this.button.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.pop.hidden && !this.wrap.contains(e.target)) this._closePop();
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._setActive(false);
    });
  }

  _showVolume() {
    this.slider.value = String(this.volume);
    this.out.textContent = `${this.volume}%`;
    this.slider.setAttribute('aria-valuetext', `${this.volume}%`);
  }

  _openPop() {
    this.pop.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    // Anchored at the button's right edge; a button near the left edge (a wrapped phone toolbar) anchors left.
    const r = this.button.getBoundingClientRect();
    this.pop.classList.toggle('left', r.right < this.pop.offsetWidth + 8);
  }

  _closePop() {
    this.pop.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }

  /** The button: sound on (with the volume popover) or off. Runs in the click's user gesture. */
  toggle() {
    if (this.on) this._turnOff();
    else this._turnOn();
  }

  _turnOn() {
    if (!this.ac && !this._build()) {
      this.button.disabled = true;
      this.button.title = 'Sound is not available in this browser';
      return;
    }
    this.on = true;
    this.listening = true;
    this.analyzer.reset();
    this.button.setAttribute('aria-pressed', 'true');
    this._openPop();
    // Resume inside the gesture (browsers allow audio from here on); the next frame fades in if
    // the simulation runs, else the context suspends again after SUSPEND_S.
    this.active = false;
    this._resume();
    this._applyActive();
    this.lastFrame = performance.now();
    if (!this.watchdog) this.watchdog = setInterval(() => this._watch(), 250);
  }

  _turnOff() {
    this.on = false;
    this.listening = false;
    this.button.setAttribute('aria-pressed', 'false');
    this._closePop();
    this._setActive(false);
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = 0; }
    this.analyzer.reset();
  }

  /* ---------------- per frame (main.js) ---------------- */

  /**
   * Once per drawn frame while the frame loop runs.
   * @param {object} world
   * @param {number} timeScale sim seconds per real second; 0 while paused
   * @param {number} now frame time (ms, performance.now() clock)
   */
  frame(world, timeScale, now) {
    if (!this.on) return;
    this.lastFrame = now;
    const run = timeScale > 0 && !document.hidden;
    this._setActive(run);
    if (!run || !this.ac || now - this.lastAnalysis < 30) return;
    this.lastAnalysis = now;
    let v;
    try { v = this.analyzer.analyze(world, timeScale); } catch (err) { return; }
    this._apply(v);
    if (v.impactMmS > 0) this._knock('thump', Math.min(MIX.THUMP_MAX, MIX.THUMP_PER_MMS * v.impactMmS));
  }

  /** The frame loop went idle (hidden page, out of view, zero width): fall silent now. */
  idle() {
    if (this.on) this._setActive(false);
  }

  /**
   * A world event (main.js drains them once per frame): knocks for lost steps and bumps.
   * @param {{type: string, data?: object}} ev
   */
  event(ev) {
    if (!this.active || !ev) return;
    const d = ev.data || {};
    if (ev.type === 'stepLost') {
      const cycles = Math.abs(+d.mm || 0) / 0.8;
      this._knock('clack', Math.min(MIX.CLACK_MAX, MIX.CLACK + MIX.CLACK_PER_CYCLE * Math.min(4, cycles)));
    } else if (ev.type === 'bump') {
      this._knock('knock', MIX.KNOCK_SHARE * Math.abs(+d.torque || 0.3));
    }
  }

  /* ---------------- synth ---------------- */

  /** Creates the AudioContext and the voices (in the click's gesture). @returns {boolean} */
  _build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    let ac;
    try { ac = new AC({ latencyHint: 'interactive' }); } catch (err) {
      try { ac = new AC(); } catch (err2) { return false; }
    }
    try {
      this._graph(ac);
    } catch (err) {
      // A browser missing a node type: no sound rather than an error on every click.
      try { ac.close(); } catch (err2) { /* already closed */ }
      return false;
    }
    this.ac = ac;
    ac.addEventListener('statechange', () => {
      if (this.active && ac.state !== 'running') this._resume();
    });
    return true;
  }

  /** The voices and their mix (see the file header). */
  _graph(ac) {
    const rate = ac.sampleRate;
    // The voices' mix → fade (pause, idle, off) → volume → limiter → output.
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    limiter.connect(ac.destination);
    this.vol = ac.createGain();
    this.vol.connect(limiter);
    this.fade = ac.createGain();
    this.fade.gain.value = 0;
    this.fade.connect(this.vol);
    this._applyVolume();
    const mix = this.fade;
    // Sine partials.
    this.partials = [];
    for (let j = 0; j < SOUND.PARTIALS; j++) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      const g = ac.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(mix);
      osc.start();
      this.partials.push({ osc, g, f: 0, on: false, offAt: -1 });
    }
    // White noise, unit RMS (two seconds, looped).
    const noise = makeBuffer(ac, 2, (t, r) => r() + r() + r(), 11);
    const nd = noise.getChannelData(0);
    let ms = 0;
    for (let i = 0; i < nd.length; i++) ms += nd[i] * nd[i];
    const k = 1 / Math.sqrt(ms / nd.length);
    for (let i = 0; i < nd.length; i++) nd[i] *= k;
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.start();
    // Noise bands: band-pass at the geometric center; norm scales unit white noise to unit RMS in the band.
    this.bands = [];
    for (const [f1, f2] of SOUND.BANDS) {
      const f0 = Math.sqrt(f1 * f2), q = f0 / (f2 - f1);
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f0;
      bp.Q.value = q;
      const g = ac.createGain();
      g.gain.value = 0;
      src.connect(bp);
      bp.connect(g);
      g.connect(mix);
      this.bands.push({ g, norm: Math.sqrt(q * rate / (Math.PI * f0)) });
    }
    // Hiss: noise between 2 and 9 kHz.
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    this.hiss = ac.createGain();
    this.hiss.gain.value = 0;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(this.hiss);
    this.hiss.connect(mix);
    this.hissNorm = Math.sqrt((rate / 2) / 7000);
    // Full-step hum per motor: the fundamental (amplitude 1) with three weaker harmonics.
    const real = new Float32Array([0, 0, 0, 0, 0]), imag = new Float32Array([0, 1, 0.5, 0.3, 0.15]);
    let wave = null;
    try { wave = ac.createPeriodicWave(real, imag, { disableNormalization: true }); } catch (err) { wave = null; }
    this.hums = [];
    for (let i = 0; i < 2; i++) {
      const osc = ac.createOscillator();
      if (wave) osc.setPeriodicWave(wave);
      osc.frequency.value = 100;
      const g = ac.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(mix);
      osc.start();
      this.hums.push({ osc, g });
    }
    // Knocks: a carriage meeting a stop, a rotor slipping a cycle, a hand bumping the axis.
    const thumpBody = resonator(rate, 2200, 2);
    this.clicks = {
      thump: makeBuffer(ac, 0.14, (t, r) => Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t / 0.024)
        + 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.01) + 0.6 * thumpBody(r()) * Math.exp(-t / 0.002), 3),
      clack: (() => {
        const ring = resonator(rate, 2600, 6);
        return makeBuffer(ac, 0.06, (t, r) => ring(r()) * Math.exp(-t / 0.006)
          + 0.4 * Math.sin(2 * Math.PI * 700 * t) * Math.exp(-t / 0.008), 5);
      })(),
      knock: (() => {
        const soft = resonator(rate, 900, 1.5);
        return makeBuffer(ac, 0.16, (t, r) => Math.sin(2 * Math.PI * 160 * t) * Math.exp(-t / 0.03)
          + 0.35 * soft(r()) * Math.exp(-t / 0.004), 9);
      })(),
    };
    this.clickBus = ac.createGain();
    this.clickBus.connect(mix);
  }

  _applyVolume() {
    if (!this.vol) return;
    const v = this.volume / 100;
    this.vol.gain.setTargetAtTime(v * v * MIX.VOLUME_MAX, this.vol.context.currentTime, 0.02);
  }

  /** Resumes the AudioContext; if the browser wants a gesture for it, the next one anywhere does it. */
  _resume() {
    const ac = this.ac;
    if (!ac || ac.state === 'running' || ac.state === 'closed') return;
    let p;
    try { p = ac.resume(); } catch (err) { this._armGesture(); return; }
    if (p && p.then) p.then(() => { if (ac.state !== 'running' && this.active) this._armGesture(); }, () => this._armGesture());
  }

  _armGesture() {
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    const go = () => {
      this.gestureArmed = false;
      document.removeEventListener('pointerdown', go, true);
      document.removeEventListener('keydown', go, true);
      if (this.active && this.ac && this.ac.state !== 'running') this.ac.resume().catch(() => {});
    };
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  }

  /** Plays (true) or falls silent (false); a change fades and resumes or suspends the context. */
  _setActive(on) {
    on = !!on && this.on && !!this.ac;
    if (on === this.active) return;
    this.active = on;
    this._applyActive();
  }

  /** Fades in (resuming the context) or out (suspending it after SUSPEND_S of silence). */
  _applyActive() {
    const ac = this.ac;
    if (!ac) return;
    if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = 0; }
    if (this.active) {
      this._resume();
      this.fade.gain.setTargetAtTime(1, ac.currentTime, MIX.TAU_FADE);
    } else {
      this.fade.gain.setTargetAtTime(0, ac.currentTime, MIX.TAU_FADE);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = 0;
        if (!this.active && ac.state === 'running') ac.suspend().catch(() => {});
      }, MIX.SUSPEND_S * 1000);
    }
  }

  /** Frames stopped coming (the loop idles): silence. */
  _watch() {
    if (this.active && performance.now() - this.lastFrame > MIX.IDLE_MS) this._setActive(false);
  }

  /** Sets every voice from the analysis (torques in N·m). */
  _apply(v) {
    const ac = this.ac;
    const t = ac.currentTime;
    const L = v.total;
    const s = L > 1e-9 ? loudness(L) / L : 0;
    const tg = MIX.TAU_GAIN;
    // Partials: each stays on the peak nearest its pitch (gliding); a free one, silent for
    // REUSE_S, takes a new peak: what is left of its fade drops out in a few ms, then it jumps.
    const P = this.partials;
    for (let k = 0; k < P.length; k++) P[k].claimed = false;
    for (let j = 0; j < (v.valid ? v.n : 0); j++) {
      const f = v.freq[j];
      if (!(f > 0)) continue;
      let best = null, bestD = MIX.TRACK_OCT;
      for (let k = 0; k < P.length; k++) {
        const p = P[k];
        if (!p.on || p.claimed) continue;
        const d = Math.abs(Math.log2(f / p.f));
        if (d < bestD) { bestD = d; best = p; }
      }
      let at = t;
      if (best) {
        best.osc.frequency.setTargetAtTime(f, t, MIX.TAU_FREQ);
      } else {
        for (let k = 0; k < P.length && !best; k++) {
          const p = P[k];
          if (!p.on && !p.claimed && (p.offAt < 0 || t - p.offAt >= MIX.REUSE_S)) best = p;
        }
        if (!best) continue;
        at = t + 0.015;
        best.g.gain.setTargetAtTime(0, t, 0.003);
        best.osc.frequency.setValueAtTime(f, at);
        best.on = true;
      }
      best.f = f;
      best.claimed = true;
      best.g.gain.setTargetAtTime(s * v.amp[j], at, tg);
    }
    for (let k = 0; k < P.length; k++) {
      const p = P[k];
      if (p.on && !p.claimed) {
        p.on = false;
        p.offAt = t;
        p.g.gain.setTargetAtTime(0, t, tg);
      }
    }
    for (let b = 0; b < this.bands.length; b++) {
      const x = v.valid ? v.bands[b] : 0;
      this.bands[b].g.gain.setTargetAtTime(s * x * this.bands[b].norm, t, tg);
    }
    for (let i = 0; i < 2; i++) {
      const h = this.hums[i];
      const f = v.humFreq[i];
      const a = f > 0 && f < 12000 ? v.humAmp[i] : 0;
      if (a > 0) h.osc.frequency.setTargetAtTime(f, t, MIX.TAU_FREQ);
      h.g.gain.setTargetAtTime(s * a, t, tg);
    }
    this.hiss.gain.setTargetAtTime(s * v.hiss * this.hissNorm, t, tg);
  }

  /** Plays a knock at a torque-equivalent level (N·m), at most one of a kind per CLICK_GAP_MS. */
  _knock(kind, torque) {
    if (!this.active || !this.ac || !(torque > 0)) return;
    const now = performance.now();
    if (now - this.lastClick[kind] < MIX.CLICK_GAP_MS) return;
    this.lastClick[kind] = now;
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.clicks[kind];
    const g = ac.createGain();
    g.gain.value = Math.min(1, loudness(torque / Math.SQRT2) * Math.SQRT2);
    src.connect(g);
    g.connect(this.clickBus);
    src.onended = () => { g.disconnect(); };
    src.start();
  }
}
