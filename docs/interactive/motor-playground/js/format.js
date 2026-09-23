/**
 * Number and duration formatting shared by the toolbar, controls, scope and
 * readouts. Output uses a real minus sign (U+2212) so digits line up.
 */

const MINUS = '−';

/**
 * Format a number to about three significant digits: 1234 → "1234",
 * 123.4 → "123", 12.34 → "12.3", 1.234 → "1.23", 0.01234 → "0.0123".
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
    if (a === 0) s = '0';
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
 * k/M suffixes (12345 → "12.3k"). Used for scope value tags.
 * @param {number} v
 * @returns {string}
 */
export function formatCompact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return formatValue(v / 1e6) + 'M';
  if (a >= 1e4) return formatValue(v / 1e3) + 'k';
  if (a !== 0 && a < 1e-3) return formatValue(v * 1e6) + 'µ';
  return formatValue(v);
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
 * Label for the toolbar time slider: 1 → "Real time",
 * 0.01 → "1 s on screen = 10 ms".
 * @param {number} timeScale sim seconds per real second
 * @returns {string}
 */
export function timeScaleLabel(timeScale) {
  if (Math.abs(timeScale - 1) < 1e-9) return 'Real time';
  return '1 s on screen = ' + formatDuration(timeScale);
}
