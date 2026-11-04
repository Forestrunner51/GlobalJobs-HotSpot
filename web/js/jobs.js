// Pure logic for the job postings view: filtering, metro markers and the text handed
// to apply/jobprep.py. Rendering lives in main.js.

export const WHERE = ['all', 'us'];

// Work arrangement. On-site means the posting names a place and doesn't mention remote or hybrid
// work; many postings don't say, so it's the least certain of the three.
export const WORK = [['any', 'Any'], ['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']];
export function workMatches(job, work) {
  if (work === 'remote') return !!job.remote;
  if (work === 'hybrid') return !!job.hybrid;
  if (work === 'onsite') return !job.remote && !job.hybrid && !!job.location;
  return true;
}

const DAY = 86_400_000;
/** First seen within `days` of the data's last update, and after tracking began (so not just "first run"). */
export function isNew(job, { generated, trackedSince } = {}, days = 7) {
  if (!job.firstSeen || !generated || !trackedSince || job.firstSeen <= trackedSince) return false;
  return new Date(generated) - new Date(`${job.firstSeen}T00:00:00Z`) <= days * DAY;
}

// Levels assigned by jobs/fetch_jobs.py from the job title.
export const LEVELS = [
  ['intern', 'Intern'],
  ['entry', 'Entry'],
  ['mid', 'Mid / not stated'],
  ['senior', 'Senior'],
  ['staff', 'Staff+'],
  ['manager', 'Manager'],
];
export const LEVEL_LABEL = Object.fromEntries(LEVELS);
export const YEARS_OPTIONS = [1, 2, 3, 5, 8];

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

/** The job's languages that matter for the current selection: the picked ones, or all of them. */
export const relevantLangs = (job, langs = []) => (langs.length ? langs.filter((k) => job.keywords.includes(k)) : job.keywords);

/** A language in the title, or mentioned at least twice: the posting is about it, not listing it in passing. */
const focusedOn = (job, k) => job.inTitle.includes(k) || (job.mentions[k] ?? 0) >= 2;
export const isFocused = (job, langs = []) => relevantLangs(job, langs).some((k) => focusedOn(job, k));

/**
 * levels: empty means any level. maxYears: postings asking for more are dropped; postings that
 * don't state years stay unless yearsKnown is set.
 */
export function filterJobs(jobs, {
  q = '', where = 'all', focus = false, metro = null, levels = [], maxYears = null, yearsKnown = false,
  usState = null, langs = [], work = 'any', fresh = false, meta = {},
} = {}) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return jobs.filter((j) => {
    if (langs.length && !langs.some((k) => j.keywords.includes(k))) return false;
    if (levels.length && !levels.includes(j.level)) return false;
    if (yearsKnown && j.years == null) return false;
    if (maxYears != null && j.years != null && j.years > maxYears) return false;
    if (where === 'us' && !(j.us || j.regionIds.length)) return false;
    if (!workMatches(j, work)) return false;
    if (fresh && !isNew(j, meta)) return false;
    if (focus && !isFocused(j, langs)) return false;
    if (usState && !(j.states ?? []).includes(usState)) return false;
    if (metro && !j.regionIds.includes(metro)) return false;
    if (!words.length) return true;
    const hay = `${j.title} ${j.company} ${j.location} ${j.keywords.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** States in a metro title: "Boston-Cambridge-Newton, MA-NH" -> ['MA', 'NH'] */
export const metroStates = (label) => label.split(', ').pop().split('-');

/**
 * One marker per metro with the number of postings there, most first (the views' marker shape).
 * With usState, only metros in that state count, so a posting listing Seattle and Austin
 * doesn't put Austin on a Washington map.
 */
export function jobMarkers(jobs, metroById, { usState = null } = {}) {
  const byMetro = new Map();
  for (const j of jobs) {
    for (const id of j.regionIds) {
      const info = metroById.get(id);
      if (!info || (usState && !metroStates(info.regionLabel).includes(usState))) continue;
      let m = byMetro.get(id);
      if (!m) {
        m = { regionId: id, regionLabel: info.regionLabel, lat: Number(info.lat), lng: Number(info.lng), value: 0, jobs: [] };
        byMetro.set(id, m);
      }
      m.value += 1;
      m.jobs.push(j);
    }
  }
  return [...byMetro.values()].sort((a, b) => b.value - a.value || a.regionLabel.localeCompare(b.regionLabel));
}

/** [code, name, count] for each state with postings, alphabetical by name. */
export function stateCounts(jobs) {
  const counts = new Map();
  for (const j of jobs) for (const st of j.states ?? []) counts.set(st, (counts.get(st) ?? 0) + 1);
  return [...counts].map(([st, n]) => [st, US_STATES[st] ?? st, n]).sort((a, b) => a[1].localeCompare(b[1]));
}

/** [key, label, count] per work arrangement under `filters`. */
export function workCounts(jobs, filters = {}) {
  return WORK.map(([key, label]) => [key, label, filterJobs(jobs, { ...filters, work: key }).length]);
}

export function levelCounts(jobs) {
  const counts = Object.fromEntries(LEVELS.map(([k]) => [k, 0]));
  for (const j of jobs) if (j.level in counts) counts[j.level] += 1;
  return counts;
}

/** Languages ordered by how central they are to the posting: in the title, then most mentioned. */
function byCentrality(job, langs) {
  return relevantLangs(job, langs).slice().sort((a, b) => job.inTitle.includes(b) - job.inTitle.includes(a)
    || (job.mentions[b] ?? 0) - (job.mentions[a] ?? 0));
}

/** One tag per relevant language, at most `max`: [{text, focus}], plus how many were left out. */
export function strengthTags(job, langs = [], max = 3) {
  const ks = byCentrality(job, langs);
  const tags = ks.slice(0, max).map((k) => {
    const n = job.mentions[k] ?? 0;
    const text = job.inTitle.includes(k) ? `${k} in title` : n >= 2 ? `${k} ×${n}` : `${k} once`;
    return { text, focus: focusedOn(job, k) };
  });
  return { tags, more: Math.max(0, ks.length - max) };
}

/** The snippet around the most central picked language that has one. */
export function jobSnippet(job, langs = []) {
  const k = byCentrality(job, langs).find((w) => job.snippets?.[w]);
  return k ? { lang: k, text: job.snippets[k] } : null;
}

/** Postings about the picked languages first, then the newest. */
export function sortJobs(jobs, langs = []) {
  const score = (j) => {
    const ks = relevantLangs(j, langs);
    return 10 * ks.filter((k) => j.inTitle.includes(k)).length + Math.min(3, ks.reduce((n, k) => n + (j.mentions[k] ?? 0), 0));
  };
  return jobs.map((j) => [score(j), j.posted ?? '', j])
    .sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([, , j]) => j);
}

/** [name, count] for each language: how many postings that language alone would show under `filters`. */
export function langCounts(jobs, names, filters = {}) {
  return names.map((n) => [n, filterJobs(jobs, { ...filters, langs: [n] }).length]);
}

/** Which jobs-text/NN.json holds a posting: FNV-1a of the id, as text_shard() in fetch_jobs.py. */
export function textShard(id, shards = 32) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return String(h % shards).padStart(2, '0');
}

export function postedLabel(iso, today = new Date()) {
  if (!iso) return '';
  const days = Math.floor((today - new Date(`${iso}T12:00:00Z`)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

/** The posting as plain text in the shape apply/jobprep.py reads from stdin. */
export function postingForPrep(job, text) {
  return [
    `Source: ${job.url}`,
    job.applyUrl && job.applyUrl !== job.url ? `Apply: ${job.applyUrl}` : null,
    job.id ? `Job ID: ${job.id}` : null, // lets jobprep.py link its records to this posting
    '',
    `${job.title}`,
    `${job.company}${job.location ? ` · ${job.location}` : ''}${job.remote ? ' · Remote' : ''}`,
    job.salary ? `Compensation: ${job.salary}` : null,
    '',
    text || Object.values(job.snippets ?? {})[0] || '',
  ].filter((line) => line !== null).join('\n');
}
