/**
 * Number and duration formatting shared by the toolbar, controls, scope and
 * readouts. Output uses a real minus sign (U+2212) so digits line up.
 */

const MINUS = '−';
/** Magnitude below which a value is float residue and reads "0": a millionth of any display unit. */
const FLOOR = 1e-6;

/**
 * Format a number to about three significant digits: 1234 → "1234",
 * 123.4 → "123", 12.34 → "12.3", 1.234 → "1.23", 0.01234 → "0.0123".
 * Magnitudes under 1e-6 (float residue) read "0", so the output never
 * switches to exponent notation.
 * @param {number} v
 * @param {number} [digits] fixed decimals instead of significant digits
 * @returns {string}
 */
export function formatValue(v, digits) {
  if (typeof v !== 'number') return v == null ? '–' : String(v);
  if (!Number.isFinite(v)) return v !== v ? '–' : (v > 0 ? '∞' : MINUS + '∞');
  let s;
  if (digits != null) s = v.toFixed(digits);
  else {
    const a = Math.abs(v);
    if (a < FLOOR) s = '0';
    else if (a >= 100) s = v.toFixed(0);
    else if (a >= 10) s = v.toFixed(1);
    else if (a >= 1) s = v.toFixed(2);
    else s = String(+v.toPrecision(3));
  }
  if (s[0] === '-') s = /^-0(\.0*)?$/.test(s) ? s.slice(1) : MINUS + s.slice(1);
  return s;
}

/**
 * Up to four significant digits without trailing zeros: 5 → "5",
 * 2.5 → "2.5", 0.25 → "0.25", 1023 → "1023". Used for scale bounds.
 * @param {number} v
 * @returns {string}
 */
export function formatTrim(v) {
  if (!Number.isFinite(v)) return formatValue(v);
  const s = String(+v.toPrecision(4));
  return s[0] === '-' ? MINUS + s.slice(1) : s;
}

/**
 * Like formatValue, but at most about six characters wide: large values get
 * k/M suffixes (12345 → "12.3k"); the rest keep three significant digits but
 * no more decimals than the scale shows, 2 − floor(log10 ref) clamped to 0…4
 * (1.234 on ±2 → "1.23", 0.0123 on ±0.2 → "0.012", −0.000178 on ±2 → "0.00").
 * No SI prefix on small values: the tag carries no unit, and the unit (mm,
 * N·m) may not take one. Used for scope value tags.
 * @param {number} v
 * @param {number} [ref] the scale's largest absolute bound, max(|lo|, |hi|);
 *   without it, at most 3 decimals
 * @returns {string}
 */
export function formatCompact(v, ref) {
  const a = Math.abs(v);
  if (a >= 1e6) return formatValue(v / 1e6) + 'M';
  if (a >= 1e4) return formatValue(v / 1e3) + 'k';
  const dr = ref > 0 ? Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(ref)))) : 3;
  const dv = a > 0 ? Math.max(0, 2 - Math.floor(Math.log10(a))) : dr;
  return formatValue(v, Math.min(dv, dr));
}

/**
 * Human duration: 2 → "2 s", 0.01 → "10 ms", 0.0005 → "0.5 ms",
 * 2e-5 → "20 µs", −0.35 → "−350 ms". Up to three significant digits.
 * @param {number} s seconds
 * @returns {string}
 */
export function formatDuration(s) {
  const a = Math.abs(s);
  const sign = s < 0 && a >= 5e-10 ? MINUS : '';
  const num = (x) => sign + String(+x.toPrecision(3));
  if (a >= 1 || a < 5e-10) return num(a) + ' s';
  if (a >= 1e-4) return num(a * 1e3) + ' ms';
  return num(a * 1e6) + ' µs';
}

/**
 * A current set in A RMS, the unit of Klipper's `run_current` for TMC-style
 * drivers, with its sine peak: 1.5 → "1.50 A RMS (2.12 A peak)". The sim's
 * runCurrent is the peak (RMS × √2).
 * @param {number} rms amps RMS
 * @returns {string}
 */
export function formatRms(rms) {
  return `${formatValue(rms, 2)} A RMS (${formatValue(rms * Math.SQRT2, 2)} A peak)`;
}

/**
 * A current set as a peak, the unit FOC drivers use for their current
 * limits, with its RMS equivalent: 2.5 → "2.50 A peak (1.77 A RMS)".
 * @param {number} peak amps peak
 * @param {boolean} [withRms=true] add the RMS value in parentheses
 * @returns {string}
 */
export function formatPeak(peak, withRms = true) {
  const s = `${formatValue(peak, 2)} A peak`;
  return withRms ? `${s} (${formatValue(peak / Math.SQRT2, 2)} A RMS)` : s;
}

/**
 * Label for the toolbar time slider: 1 → "Real time",
 * 0.01 → "1 s on screen = 10 ms".
 * @param {number} timeScale sim seconds per real second
 * @returns {string}
 */
export function timeScaleLabel(timeScale) {
  if (Math.abs(timeScale - 1) < 1e-9) return 'Real time';
  return '1 s on screen = ' + formatDuration(timeScale);
}
