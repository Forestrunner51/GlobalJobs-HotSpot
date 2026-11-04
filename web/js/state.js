import { DEFAULT_FLOOR } from './aggregate.js';

const SOC = /^\d{2}-\d{4}$/;
const CBSA = /^\d{5}$/;
const LEVEL_KEYS = ['intern', 'entry', 'mid', 'senior', 'staff', 'manager'];
const US_STATE = /^[A-Z]{2}$/;
const LANG = /^[A-Za-z0-9+#./ ]{1,20}$/;

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
    where: p.get('where') === 'us' ? 'us' : 'all',
    // where=remote predates the work-style filter; keep old links working.
    work: ['remote', 'hybrid', 'onsite'].includes(p.get('work')) ? p.get('work') : p.get('where') === 'remote' ? 'remote' : 'any',
    fresh: p.get('new') === '1',
    focus: p.get('focus') === '1',
    levels: [...new Set((p.get('lvl') || '').split(',').filter((l) => LEVEL_KEYS.includes(l)))],
    maxYears: /^\d{1,2}$/.test(p.get('yrs') || '') ? Number(p.get('yrs')) : null,
    yearsKnown: p.get('yknown') === '1',
    usState: US_STATE.test(p.get('st') || '') ? p.get('st') : null,
    langs: [...new Set((p.get('lang') || '').split(',').filter((l) => LANG.test(l)))],
    mine: ['saved', 'applied', 'hidden'].includes(p.get('mine')) ? p.get('mine') : null,
  };
}

export function stateToSearch({
  occ, metric, floor, metro, mode = 'occ', q = '', where = 'all', focus = false, work = 'any', fresh = false,
  levels = [], maxYears = null, yearsKnown = false, usState = null, langs = [], mine = null,
}) {
  const p = new URLSearchParams();
  if (occ.length) p.set('occ', occ.join(','));
  if (metric !== 'lq') p.set('metric', metric);
  if (floor !== DEFAULT_FLOOR) p.set('floor', String(floor));
  if (metro) p.set('metro', metro);
  if (mode === 'jobs') p.set('mode', 'jobs');
  if (q) p.set('q', q);
  if (where !== 'all') p.set('where', where);
  if (work !== 'any') p.set('work', work);
  if (fresh) p.set('new', '1');
  if (focus) p.set('focus', '1');
  if (levels.length) p.set('lvl', levels.join(','));
  if (maxYears != null) p.set('yrs', String(maxYears));
  if (yearsKnown) p.set('yknown', '1');
  if (usState) p.set('st', usState);
  if (langs.length) p.set('lang', langs.join(','));
  if (mine) p.set('mine', mine);
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
