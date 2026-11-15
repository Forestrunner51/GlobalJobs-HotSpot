import { fmtCompact } from './format.js';

// Plum to pale gold, one hue sweep that only ever gets lighter: ordered for every kind of color
// vision, and every step stays visible against the dark globe. Height/radius carry the same value.
export const RAMP = ['#8f2d63', '#b23557', '#cf4a44', '#e56a3a', '#f08c3d', '#f6ad4f', '#fbd277', '#fff1b8'];
export const NO_DATA_COLOR = '#9a917e';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const RAMP_RGB = RAMP.map(rgb);

export function colorAt(t) {
  const x = clamp01(t) * (RAMP_RGB.length - 1);
  const i = Math.min(Math.floor(x), RAMP_RGB.length - 2);
  const f = x - i;
  const [a, b] = [RAMP_RGB[i], RAMP_RGB[i + 1]];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * LQ uses a fixed log domain (0.5x-8x) so colors mean the same thing across
 * selections. Employment uses a log domain fitted to the current values.
 */
export function makeScale(metric, values) {
  let lo;
  let hi;
  if (metric === 'lq') {
    lo = 0.5;
    hi = 8;
  } else {
    const vals = values.filter((v) => v > 0);
    lo = vals.length ? Math.max(1, Math.min(...vals)) : 1;
    hi = vals.length ? Math.max(lo * 10, Math.max(...vals)) : 10;
  }
  const t = (v) => (v > 0 ? clamp01((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) : 0);
  const format = metric === 'lq' ? (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}×` : fmtCompact;
  return { metric, lo, hi, t, color: (v) => colorAt(t(v)), format };
}
