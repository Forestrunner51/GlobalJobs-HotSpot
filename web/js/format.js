const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const DASH = '—';

export const fmtInt = (n) => (n == null ? DASH : intFmt.format(n));
export const fmtCompact = (n) => (n == null ? DASH : compactFmt.format(n));
export const fmtLQ = (n) => (n == null ? DASH : n.toFixed(2));
export const fmtWage = (n) => (n == null ? DASH : `$${intFmt.format(n)}`);

/** "Houston-Pasadena-The Woodlands, TX" -> "Houston" */
export function shortMetro(label) {
  return label.split(',')[0].split('-')[0].trim();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export const WAGE_NOTE = 'Not published: suppressed, or at/above the BLS wage top-code';
