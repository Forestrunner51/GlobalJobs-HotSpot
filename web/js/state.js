import { DEFAULT_FLOOR } from './aggregate.js';

const SOC = /^\d{2}-\d{4}$/;
const CBSA = /^\d{5}$/;

/** Shareable view state lives in the query string. Resume content never does. */
export function readState(search = location.search) {
  const p = new URLSearchParams(search);
  const floor = Number.parseInt(p.get('floor') ?? '', 10);
  return {
    occ: [...new Set((p.get('occ') || '').split(',').filter((c) => SOC.test(c)))],
    metric: p.get('metric') === 'employment' ? 'employment' : 'lq',
    floor: Number.isFinite(floor) && floor >= 0 ? floor : DEFAULT_FLOOR,
    metro: CBSA.test(p.get('metro') || '') ? p.get('metro') : null,
    mode: p.get('mode') === 'jobs' ? 'jobs' : 'occ',
    q: (p.get('q') || '').slice(0, 100),
    where: ['us', 'remote'].includes(p.get('where')) ? p.get('where') : 'all',
    focus: p.get('focus') === '1',
  };
}

export function stateToSearch({ occ, metric, floor, metro, mode = 'occ', q = '', where = 'all', focus = false }) {
  const p = new URLSearchParams();
  if (occ.length) p.set('occ', occ.join(','));
  if (metric !== 'lq') p.set('metric', metric);
  if (floor !== DEFAULT_FLOOR) p.set('floor', String(floor));
  if (metro) p.set('metro', metro);
  if (mode === 'jobs') p.set('mode', 'jobs');
  if (q) p.set('q', q);
  if (where !== 'all') p.set('where', where);
  if (focus) p.set('focus', '1');
  const s = p.toString().replace(/%2C/g, ',');
  return s ? `?${s}` : '';
}

export function writeState(state, { push = false } = {}) {
  const keep = new URLSearchParams(location.search).has('nowebgl') ? 'nowebgl' : null;
  let search = stateToSearch(state);
  if (keep) search += (search ? '&' : '?') + keep;
  if (search === location.search) return;
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}${search}${location.hash}`);
}
