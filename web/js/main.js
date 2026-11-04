import { readState, writeState } from './state.js';
import { loadCore, loadRecords, loadJobs, loadJobText } from './data.js';
import { aggregate, markerSubset, DEFAULT_FLOOR } from './aggregate.js';
import { makeScale, RAMP } from './scale.js';
import { renderTable } from './table.js';
import { renderDetail } from './detail.js';
import { buildSearchIndex, searchOccupations, languageCounts, occupationsByLanguage } from './search.js';
import { hasWebGL } from './util.js';
import { escapeHtml, fmtInt, fmtLQ, shortMetro } from './format.js';
import {
  filterJobs, jobMarkers, strengthTags, jobSnippet, sortJobs, langCounts, textShard, postedLabel, safeUrl,
  postingForPrep, LEVELS, LEVEL_LABEL, YEARS_OPTIONS, levelCounts, stateCounts, US_STATES, workCounts, isNew,
} from './jobs.js';
import {
  loadEntries, saveEntries, loadKit, saveKit, loadPrefs, savePrefs, setStatus, followedUp, followUpDue, counts,
  entriesWith, toCSV, prepBatch, exportBackup, parseBackup, kitItems, isoToday, KIT_FIELDS, mergeApplied, applicationKey,
} from './tracker.js';

const $ = (sel) => document.querySelector(sel);
const narrowMQ = window.matchMedia('(max-width: 760px)');
const params = new URLSearchParams(location.search);

const state = { ...readState(), evidence: new Map() };
const EMPTY_AGG = { ranked: [], noData: [], belowFloor: [] };
let core;
let searchIndex;
let matcher = null;
let view = null;
let viewKind = null;
let webglOK = false;
let lastAgg = EMPTY_AGG;
let lastRecords = [];
let refreshToken = 0;
let jobsData = null;
let jobsById = new Map();
let jobPool = []; // jobsData.jobs minus postings you applied to or hid (when hiding is on)
let jobsListed = [];
const JOBS_PAGE = 50;
let jobsShown = JOBS_PAGE;
// Applying: your saved/applied/hidden postings and apply kit, kept in this browser only.
let entries = loadEntries();
let kit = loadKit();
const prefs = loadPrefs();
let kitJob = null;
let focusIndex = -1;
// The Job Application Autofill extension (extension/), when installed, marks this page and
// relays messages (extension/src/content/site.ts). Without it, none of this does anything.
const hasExtension = () => !!document.documentElement.dataset.jobAutofill;
const toExtension = (type, data = {}) => window.postMessage({ source: 'jobglobal', type, ...data }, location.origin);
const QUEUE_MAX = 10; // MAX_QUEUE in extension/src/background.ts
let fromExtension = null; // applications the extension reported, waiting for postings to load
let inProgress = new Set(); // job keys the extension has opened or filled but you haven't submitted

// Performance budget: cap markers, stricter on narrow viewports.
const budget = () => (narrowMQ.matches
  ? { maxMarkers: 150, minLQ: 1.25 }
  : { maxMarkers: 300, minLQ: 1.0 });

// ---------------------------------------------------------------------------
// Banner / status
// ---------------------------------------------------------------------------

function banner(text, action) {
  $('#banner-text').textContent = text;
  const btn = $('#banner-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { $('#banner').hidden = true; action.run(); };
  }
  $('#banner').hidden = false;
}

function showFatal(html) {
  $('#fatal').innerHTML = html;
  $('#fatal').hidden = false;
  document.querySelector('.layout').hidden = true;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function jobsTooltipHtml(m) {
  const items = m.jobs.slice(0, 5).map((j) => `<li><span>${escapeHtml(j.title)}</span><span class="muted">${escapeHtml(j.company)}</span></li>`).join('');
  const more = m.jobs.length > 5 ? `<li class="muted">+${m.jobs.length - 5} more</li>` : '';
  return `<strong>${escapeHtml(m.regionLabel)}</strong>
    <div class="tip-value">${fmtInt(m.value)} posting${m.value === 1 ? '' : 's'}</div>
    <ul class="tip-parts">${items}${more}</ul>
    <div class="tip-foot">Click to list them.</div>`;
}

function tooltipHtml(m) {
  if (state.mode === 'jobs') return jobsTooltipHtml(m);
  const lqMetric = state.metric === 'lq';
  const parts = m.parts.slice(0, 8).map(({ rec, status }) => {
    const label = escapeHtml(core.occByCode.get(rec.occCode)?.label ?? rec.occLabel);
    const val = status === 'nodata'
      ? '<span class="muted">no data (suppressed)</span>'
      : status === 'below'
        ? `<span class="muted">${fmtInt(rec.employment)} jobs, under floor</span>`
        : `LQ ${fmtLQ(rec.concentration)}${rec.concentrationSource === 'derived' ? '†' : ''} · ${fmtInt(rec.employment)} jobs`;
    return `<li><span>${label}</span><span class="num">${val}</span></li>`;
  }).join('');
  const more = m.parts.length > 8 ? `<li class="muted">+${m.parts.length - 8} more</li>` : '';
  const headline = m.value == null
    ? 'No data: BLS suppressed these estimates'
    : lqMetric ? `Max LQ ${fmtLQ(m.value)}` : `${fmtInt(m.value)} jobs`;
  return `<strong>${escapeHtml(m.regionLabel)}</strong>
    <div class="tip-value">${headline}</div>
    ${state.occ.length > 1 || m.value == null ? `<ul class="tip-parts">${parts}${more}</ul>` : ''}
    <div class="tip-foot">Concentration, not openings. Click for details.</div>`;
}

async function setView(kind) {
  if (kind === viewKind && view) return;
  view?.destroy();
  view = null;
  viewKind = kind;
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === kind));
  }
  const host = $('#viewport-inner');
  host.replaceChildren();
  const opts = { narrow: narrowMQ.matches, onMetroClick: selectMetro, tooltipHtml, onContextLost };
  try {
    if (kind === 'globe') {
      const { createGlobe } = await import('./globe.js');
      view = await createGlobe(host, opts);
    } else {
      const { createMap2D } = await import('./map2d.js');
      view = await createMap2D(host, opts);
    }
  } catch (err) {
    console.error(err);
    if (kind === 'globe') {
      banner(`The 3D globe could not start (${err.message}). Showing the 2D map instead.`);
      return setView('map');
    }
    banner('The map could not load. The ranked table below has the same data.');
    return undefined;
  }
  if (viewKind !== kind) return undefined; // superseded while loading
  window.__view = view;
  pushToView();
  return undefined;
}

function onContextLost() {
  // The GPU dropped our context (OS reclaimed memory, driver reset). Fall back
  // to a working view rather than leaving a black canvas.
  setView('map');
  banner('The 3D view lost its graphics context. Switched to the 2D map.', {
    label: 'Try 3D again',
    run: () => setView('globe'),
  });
}

// Job postings are counts, so they use the same log scale as "Number of jobs".
const viewMetric = () => (state.mode === 'jobs' ? 'employment' : state.metric);

function pushToView() {
  const values = lastAgg.ranked.map((m) => m.value);
  // Posting counts start at 1, so a lone metro reads as large rather than as the scale minimum.
  const scale = makeScale(viewMetric(), state.mode === 'jobs' ? [1, ...values] : values);
  const markers = markerSubset(lastAgg.ranked, { metric: viewMetric(), ...budget() });
  view?.update({ markers, noData: lastAgg.noData, scale, selectedMetro: state.metro });
  renderLegend(scale, markers.length);
}

function renderLegend(scale, shown) {
  const el = $('#legend');
  if (state.mode === 'jobs') {
    el.hidden = !shown;
    el.innerHTML = `
      <div class="legend-title">Postings per metro <span class="muted">(${viewKind === 'globe' ? 'height' : 'size'} and color)</span></div>
      <div class="legend-bar" style="background:linear-gradient(90deg,${RAMP.join(',')})"></div>
      <div class="legend-scale"><span>${scale.format(scale.lo)}</span><span>${scale.format(scale.hi)}+</span></div>
      <div class="legend-note">${shown} metro${shown === 1 ? '' : 's'}. Remote and non-US postings are in the list, not on the map.</div>`;
    return;
  }
  if (!state.occ.length) { el.hidden = true; return; }
  const lq = state.metric === 'lq';
  const total = lastAgg.ranked.length;
  const { minLQ } = budget();
  const shownNote = shown < total
    ? `Top ${shown} of ${total} metros${lq ? ` with LQ ≥ ${minLQ}` : ''}. The table lists all.`
    : `${shown} metro${shown === 1 ? '' : 's'}`;
  el.innerHTML = `
    <div class="legend-title">${lq ? 'Location quotient' : 'Jobs'} <span class="muted">(${viewKind === 'globe' ? 'height' : 'size'} and color)</span></div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${RAMP.join(',')})"></div>
    <div class="legend-scale"><span>${scale.format(scale.lo)}</span>${lq ? '<span>1× = US average</span>' : ''}<span>${scale.format(scale.hi)}+</span></div>
    <div class="legend-row"><span class="swatch-nodata${viewKind === 'globe' ? ' is-globe' : ''}" aria-hidden="true"></span>${viewKind === 'globe' ? 'Flat grey dot' : 'Dashed ring'} = no data (suppressed), not zero</div>
    <div class="legend-note">${shownNote}</div>`;
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Refresh pipeline
// ---------------------------------------------------------------------------

async function refresh({ push = false } = {}) {
  const token = ++refreshToken;
  writeState(state, { push });
  applyMode();
  if (state.mode === 'jobs') return refreshJobs(token);
  renderChips();
  renderLanguages();
  syncControls();
  $('#empty').hidden = state.occ.length > 0;

  if (!state.occ.length) {
    lastRecords = [];
    lastAgg = EMPTY_AGG;
  } else {
    $('#loading').hidden = false;
    try {
      const records = await loadRecords(core, state.occ);
      if (token !== refreshToken) return;
      lastRecords = records;
      lastAgg = aggregate(records, { metric: state.metric, floor: state.floor });
    } catch (err) {
      if (token !== refreshToken) return;
      console.error(err);
      banner(`Could not load hotspot data (${err.message}).`, { label: 'Retry', run: () => refresh() });
      return;
    } finally {
      if (token === refreshToken) $('#loading').hidden = true;
    }
  }
  pushToView();
  renderTableView();
  renderDetailView();
  return undefined;
}

function renderTableView() {
  const title = $('#table-title');
  const tableEl = $('#table');
  if (!state.occ.length) {
    title.textContent = 'Ranked metros';
    tableEl.innerHTML = '<p class="muted">Pick at least one occupation to rank metro areas.</p>';
    return;
  }
  const names = state.occ.map((c) => core.occByCode.get(c)?.label ?? c);
  title.textContent = `Metros ranked by ${state.metric === 'lq' ? 'concentration' : 'number of jobs'}: ${names.length > 2 ? `${names.length} occupations` : names.join(' + ')}`;
  renderTable(tableEl, {
    agg: lastAgg,
    metric: state.metric,
    floor: state.floor,
    occByCode: core.occByCode,
    selectedMetro: state.metro,
    multi: state.occ.length > 1,
    onSelectMetro: selectMetro,
  });
}

function renderDetailView() {
  const el = $('#detail');
  const metro = state.mode === 'occ' ? state.metro : null; // in jobs mode a metro filters the list instead
  document.querySelector('.layout').classList.toggle('has-detail', !!metro);
  renderDetail(el, {
    metroInfo: metro ? core.metroById.get(metro) : null,
    records: lastRecords.filter((r) => r.regionId === state.metro),
    selected: state.occ,
    occByCode: core.occByCode,
    metric: state.metric,
    floor: state.floor,
    onPickOcc: (code) => {
      state.occ = [code];
      view?.resetView();
      refresh({ push: true });
    },
    onClose: () => selectMetro(null),
  });
}

function selectMetro(id) {
  state.metro = id;
  const info = id && core.metroById.get(id);
  if (state.mode === 'jobs') {
    if (info) view?.focus(info.lat, info.lng);
    jobsShown = JOBS_PAGE;
    refresh({ push: true });
    if (id) $('#jobs-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  writeState(state, { push: true });
  if (info) view?.focus(info.lat, info.lng);
  pushToView();
  renderTableView();
  renderDetailView();
  if (info && narrowMQ.matches) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Job postings
// ---------------------------------------------------------------------------

let occVintage = '';

function applyMode() {
  const jobs = state.mode === 'jobs';
  for (const tab of document.querySelectorAll('[data-mode]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === state.mode));
  }
  $('#jobs-side').hidden = !jobs;
  $('#occ-side').hidden = jobs;
  $('#jobs-wrap').hidden = !jobs;
  $('#table-wrap').hidden = jobs;
  $('#vintage').textContent = jobs
    ? (jobsData ? `Live postings, updated ${new Date(jobsData.generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Live job postings')
    : occVintage;
  $('#coverage-text').textContent = jobs
    ? 'Map shows US postings with a city'
    : 'Data covers US metro areas only';
  if (jobs) $('#empty').hidden = true;
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  state.metro = null;
  jobsShown = JOBS_PAGE;
  view?.resetView();
  refresh({ push: true });
}

async function refreshJobs(token) {
  syncJobControls();
  if (!jobsData) {
    $('#loading').hidden = false;
    try {
      jobsData = await loadJobs();
      jobsById = new Map(jobsData.jobs.map((j) => [j.id, j]));
      langRegexes = new Map(jobsData.keywords.map((k) => [k.name, new RegExp(k.pattern, `${k.flags}g`)]));
      // Links from before a language was renamed ("C#" -> "C# / .NET") still select it.
      const alias = new Map(jobsData.keywords.flatMap((k) => (k.aliases ?? []).map((a) => [a, k.name])));
      state.langs = [...new Set(state.langs.map((l) => alias.get(l) ?? l))];
    } catch (err) {
      if (token !== refreshToken) return;
      console.error(err);
      lastAgg = EMPTY_AGG;
      pushToView();
      $('#jobs-title').textContent = 'Postings';
      $('#jobs-list').innerHTML = err.status === 404
        ? '<p class="muted">No postings downloaded yet. Run <code>python3 jobs/fetch_jobs.py</code> from the project folder, then reload this page.</p>'
        : `<p class="status error">Could not load postings (${escapeHtml(err.message)}).</p>`;
      return;
    } finally {
      if (token === refreshToken) $('#loading').hidden = true;
    }
    if (token !== refreshToken) return;
    applyMode();
    syncJobControls();
    renderJobSources();
    setTimeout(syncFromExtension); // after this refresh finishes, since it may refresh again
  }
  // Postings you applied to or hid leave the list and every count, so the numbers agree.
  const done = (j) => prefs.hideDone && ['applied', 'hidden'].includes(entries[j.id]?.status);
  jobPool = jobsData.jobs.filter((j) => !done(j));
  // My applications views list your postings regardless of the search filters.
  const mine = state.mine ? entriesWith(entries, state.mine) : null;
  const anywhere = mine
    ? mine.map(([id]) => jobsById.get(id)).filter(Boolean)
    : filterJobs(jobPool, jobFilters());
  renderMine();
  renderLevelPills(filterJobs(jobPool, { ...jobFilters(), levels: [] }));
  lastAgg = { ranked: jobMarkers(anywhere, core.metroById, { usState: state.usState }), noData: [], belowFloor: [] };
  if (state.metro && !lastAgg.ranked.some((m) => m.regionId === state.metro)) state.metro = null;
  renderPlacePickers(filterJobs(jobPool, { ...jobFilters(), usState: null }));
  renderLangPills();
  renderWorkStyles();
  jobsListed = mine
    ? mine.map(([id, e]) => jobsById.get(id) ?? { id, ...e.job, gone: true })
      .filter((j) => !state.metro || j.regionIds?.includes(state.metro))
    : sortJobs(state.metro ? anywhere.filter((j) => j.regionIds.includes(state.metro)) : anywhere, state.langs);
  pushToView();
  renderJobs(anywhere);
  renderDetailView();
}

const jobFilters = () => ({
  q: state.q, where: state.where, focus: state.focus, usState: state.usState, langs: state.langs,
  work: state.work, fresh: state.fresh, meta: jobsData,
  levels: state.levels, maxYears: state.maxYears, yearsKnown: state.yearsKnown,
});

// State options count postings under every other filter; city options are the metros on the map.
function renderPlacePickers(withoutState) {
  const states = stateCounts(withoutState);
  if (state.usState && !states.some(([st]) => st === state.usState)) {
    states.push([state.usState, US_STATES[state.usState] ?? state.usState, 0]);
  }
  $('#job-state').innerHTML = '<option value="">All states</option>' + states
    .map(([st, name, n]) => `<option value="${st}">${escapeHtml(name)} (${fmtInt(n)})</option>`).join('');
  $('#job-state').value = state.usState ?? '';
  const cities = [...lastAgg.ranked].sort((a, b) => a.regionLabel.localeCompare(b.regionLabel));
  $('#job-city').innerHTML = `<option value="">${state.usState ? `All of ${escapeHtml(US_STATES[state.usState] ?? state.usState)}` : 'All cities'}</option>`
    + cities.map((m) => `<option value="${m.regionId}" title="${escapeHtml(m.regionLabel)}">${escapeHtml(shortMetro(m.regionLabel))}, ${escapeHtml(m.regionLabel.split(', ').pop())} (${fmtInt(m.value)})</option>`).join('');
  $('#job-city').value = state.metro ?? '';
}

const langNames = () => jobsData.keywords.map((k) => k.name);
const langList = (names) => (names.length > 2 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join(' or '));

function renderLangPills() {
  $('#job-langs').innerHTML = langCounts(jobPool, langNames(), jobFilters()).map(([name, n]) => `<button type="button" class="pill"
    data-lang="${escapeHtml(name)}" aria-pressed="${state.langs.includes(name)}">${escapeHtml(name)}<span class="count">${fmtInt(n)}</span></button>`).join('');
}

function renderWorkStyles() {
  $('#job-work').innerHTML = workCounts(jobPool, jobFilters()).map(([key, label, n]) => `<label>
    <input type="radio" name="work" value="${key}"${state.work === key ? ' checked' : ''}><span>${label}<span class="seg-count">${fmtInt(n)}</span></span></label>`).join('');
}

function renderLevelPills(pool) {
  const counts = levelCounts(pool);
  $('#job-levels').innerHTML = LEVELS.map(([key, label]) => `<button type="button" class="pill" data-level="${key}"
    aria-pressed="${state.levels.includes(key)}">${escapeHtml(label)}<span class="count">${fmtInt(counts[key])}</span></button>`).join('');
}

function syncJobControls() {
  const q = $('#job-q');
  if (document.activeElement !== q) q.value = state.q;
  for (const r of document.querySelectorAll('input[name="where"]')) r.checked = r.value === state.where;
  $('#job-focus').checked = state.focus;
  $('#job-fresh').checked = state.fresh;
  if (jobsData) {
    const none = !jobsData.jobs.some((j) => isNew(j, jobsData));
    $('#job-fresh-label').textContent = none && jobsData.trackedSince
      ? `New in the last 7 days (none yet: tracking began ${shortDate(jobsData.trackedSince)})`
      : 'New in the last 7 days';
  }
  $('#job-years').value = state.maxYears == null ? '' : String(state.maxYears);
  $('#job-years-known').checked = state.yearsKnown;
  $('#job-focus-label').textContent = state.langs.length ? `Focused on ${langList(state.langs)} only` : 'Focused postings only';
}

// A bare date ("2026-10-19") would parse as UTC midnight and show as the day before in US time zones.
const shortDate = (iso) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function changesLine() {
  const c = jobsData.changes;
  if (!c || c.new == null) return '';
  const aged = c.expired ? ` (${fmtInt(c.expired)} past 60 days)` : '';
  return `<li class="changes">Since ${escapeHtml(shortDate(c.since))}: ${fmtInt(c.new)} new, ${fmtInt(c.closed)} closed or expired${aged}</li>`;
}

function renderJobSources() {
  const total = jobsData.jobs.length;
  $('#jobs-sources').innerHTML = jobsData.sources.map((s) => {
    const skipped = !s.boards && s.problems.length;
    const what = s.source === 'hn' ? `${s.boards} monthly thread${s.boards === 1 ? '' : 's'}`
      : ['greenhouse', 'lever', 'ashby'].includes(s.source) ? `${s.boards} companies` : 'feed';
    const detail = skipped
      ? `<span class="muted">${escapeHtml(s.problems[0].replace(/^[^:]+: (skipped: )?/, ''))}</span>`
      : `${fmtInt(s.matched)} of ${fmtInt(s.scanned)} postings <span class="muted">(${what})</span>`
        + (s.problems.length ? ` <span class="warn" title="${escapeHtml(s.problems.join('\n'))}">${s.problems.length} failed</span>` : '');
    return `<li><strong>${escapeHtml(s.label)}</strong> ${detail}</li>`;
  }).join('') + `<li class="muted">${fmtInt(total)} postings in all</li>` + changesLine();
}

// The same patterns fetch_jobs.py matched with, so highlights agree with the counts.
let langRegexes = new Map();

function highlight(text, langs) {
  const ranges = [];
  for (const name of langs) {
    const re = langRegexes.get(name);
    if (!re) continue;
    for (const m of text.matchAll(re)) {
      // Context patterns (Go) include a lead-in such as "in "; mark only the language itself.
      // When the match doesn't contain the name (".NET" for "C# / .NET"), mark all of it.
      const at = m[0].toLowerCase().lastIndexOf(name.toLowerCase());
      if (at < 0) {
        ranges.push([m.index, m.index + m[0].length]);
        continue;
      }
      const word = m[0].slice(at).match(/^[\w+#]+/)?.[0] ?? m[0].slice(at);
      ranges.push([m.index + at, m.index + at + word.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out += `${escapeHtml(text.slice(at, a))}<mark>${escapeHtml(text.slice(a, b))}</mark>`;
    at = b;
  }
  return out + escapeHtml(text.slice(at));
}

function jobCard(j) {
  const { tags, more } = strengthTags(j, state.langs);
  const snippet = jobSnippet(j, state.langs);
  const url = safeUrl(j.url);
  const apply = safeUrl(j.applyUrl) ?? url;
  const remoteTag = (j.remote && !/remote/i.test(j.location) ? '<span class="tag">Remote</span>' : '')
    + (j.hybrid && !/hybrid/i.test(j.location) ? '<span class="tag">Hybrid</span>' : '');
  const newTag = isNew(j, jobsData) ? '<span class="tag is-new">New</span>' : '';
  const meta = [
    `<span class="job-company">${escapeHtml(j.company)}</span>`,
    j.location ? escapeHtml(j.location) : '<span class="muted">Location not listed</span>',
    j.posted ? `<span class="muted">${escapeHtml(postedLabel(j.posted))}</span>` : '',
    `<span class="muted">via ${escapeHtml(jobsData.sources.find((s) => s.source === j.source)?.label ?? j.source)}</span>`,
  ].filter(Boolean).join(' · ');
  const entry = entries[j.id];
  return `<article class="job${entry?.status === 'applied' ? ' is-applied' : ''}" data-id="${escapeHtml(j.id)}" tabindex="-1">
    <h3 class="job-title">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(j.title)}</a>` : escapeHtml(j.title)}</h3>
    <div class="job-meta">${meta}</div>
    <div class="job-tags">${newTag}${tags.map((t) => `<span class="tag${t.focus ? ' is-focus' : ''}">${escapeHtml(t.text)}</span>`).join('')}${more ? `<span class="tag" title="${escapeHtml(j.keywords.join(', '))}">+${more} more</span>` : ''}<span class="tag">${escapeHtml(LEVEL_LABEL[j.level] ?? 'Mid / not stated')}</span>${j.years != null ? `<span class="tag">${j.years}+ yrs experience</span>` : ''}${remoteTag}${j.salary ? `<span class="tag">${escapeHtml(j.salary)}</span>` : ''}</div>
    ${snippet ? `<p class="job-snippet">${highlight(snippet.text, state.langs.length ? state.langs : j.keywords)}</p>` : ''}
    ${statusLine(entry)}
    <div class="job-actions">
      ${apply ? `<a class="btn-primary" href="${escapeHtml(apply)}" target="_blank" rel="noopener noreferrer" data-apply>Apply</a>` : ''}
      <button type="button" class="ghost" data-save aria-pressed="${entry?.status === 'saved'}">${entry?.status === 'saved' ? '★ Saved' : '☆ Save'}</button>
      <button type="button" class="ghost" data-prep>Copy for prep</button>
      <span class="secondary">
        <button type="button" class="linklike" data-read aria-expanded="false">Read posting</button>
        <button type="button" class="linklike" data-applied>${entry?.status === 'applied' ? 'Not applied' : 'Mark applied'}</button>
        <button type="button" class="linklike" data-hide>${entry?.status === 'hidden' ? 'Unhide' : 'Not interested'}</button>
      </span>
    </div>
    <p class="prep-msg status" role="status"></p>
    <div class="job-text" hidden></div>
  </article>`;
}

function statusLine(entry) {
  if (!entry) return '';
  if (entry.status === 'saved') return `<div class="job-status"><span class="status-chip saved">Saved ${escapeHtml(shortDate(entry.saved))}</span></div>`;
  if (entry.status === 'hidden') return '<div class="job-status"><span class="status-chip">Hidden</span></div>';
  const due = followUpDue(entry);
  return `<div class="job-status"><span class="status-chip applied">Applied ${escapeHtml(shortDate(entry.applied))}</span>
    <span class="status-chip${due ? ' due' : ''}">${due ? 'Follow-up due' : 'Follow up'} ${escapeHtml(shortDate(entry.followUp))}</span>
    ${due ? '<button type="button" class="linklike" data-followed>I followed up</button>' : ''}</div>`;
}

/** A tracked posting that's no longer in the data: its board took it down, usually because it was filled. */
function goneCard(j) {
  const entry = entries[j.id];
  const url = safeUrl(j.applyUrl) ?? safeUrl(j.url);
  return `<article class="job is-gone" data-id="${escapeHtml(j.id)}" tabindex="-1">
    <h3 class="job-title">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(j.title)}</a>` : escapeHtml(j.title)}</h3>
    <div class="job-meta"><span class="job-company">${escapeHtml(j.company)}</span>${j.location ? ` · ${escapeHtml(j.location)}` : ''}</div>
    <p class="job-snippet">No longer listed: the role was probably filled or closed.</p>
    ${statusLine(entry)}
    <div class="job-actions"><span class="secondary"><button type="button" class="linklike" data-forget>Remove from my list</button></span></div>
  </article>`;
}

function renderJobs(anywhere) {
  const metroLabel = state.metro && core.metroById.get(state.metro)?.regionLabel;
  const n = jobsListed.length;
  const place = metroLabel || (state.usState && (US_STATES[state.usState] ?? state.usState));
  const mineLabel = { saved: 'Saved', applied: 'Applied to', hidden: 'Hidden' }[state.mine];
  $('#jobs-title').textContent = mineLabel
    ? `${mineLabel}: ${fmtInt(n)} posting${n === 1 ? '' : 's'}${metroLabel ? ` in ${metroLabel}` : ''}`
    : place
      ? `${fmtInt(n)} posting${n === 1 ? '' : 's'} in ${place}`
      : `${fmtInt(n)} posting${n === 1 ? '' : 's'}${state.langs.length ? ` mentioning ${langList(state.langs)}` : ''}`;
  $('#jobs-clear-metro').hidden = !(state.metro || state.usState);
  const onMap = anywhere.filter((j) => j.regionIds.length).length;
  $('#jobs-count').textContent = `${fmtInt(anywhere.length)} of ${fmtInt(jobsData.jobs.length)} postings match. ${fmtInt(onMap)} have a US city and are on the map.`;
  const shown = jobsListed.slice(0, jobsShown);
  $('#jobs-list').innerHTML = shown.length
    ? shown.map((j) => (j.gone ? goneCard(j) : jobCard(j))).join('') + (n > shown.length
      ? `<button type="button" class="ghost more-jobs" data-more>Show ${fmtInt(Math.min(JOBS_PAGE, n - shown.length))} more of ${fmtInt(n - shown.length)}</button>` : '')
    : `<p class="muted">${state.mine ? 'Nothing here yet.' : 'No postings match these filters.'}</p>`;
  focusCard(Math.min(focusIndex, shown.length - 1), { scroll: false });
}

async function jobText(id) {
  try {
    return (await loadJobText(textShard(id, jobsData.textShards ?? 32)))[id] ?? '';
  } catch (err) {
    console.error(err);
    return '';
  }
}

function wireJobs() {
  for (const tab of document.querySelectorAll('[data-mode]')) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  }
  let typing;
  $('#job-q').addEventListener('input', (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.q = e.target.value.trim(); jobsShown = JOBS_PAGE; refresh(); }, 150);
  });
  for (const r of document.querySelectorAll('input[name="where"]')) {
    r.addEventListener('change', () => { state.where = r.value; jobsShown = JOBS_PAGE; refresh(); });
  }
  $('#job-work').addEventListener('change', (e) => {
    if (e.target.name !== 'work') return;
    state.work = e.target.value;
    jobsShown = JOBS_PAGE;
    refresh();
  });
  $('#job-fresh').addEventListener('change', (e) => { state.fresh = e.target.checked; jobsShown = JOBS_PAGE; refresh(); });
  $('#job-focus').addEventListener('change', (e) => { state.focus = e.target.checked; jobsShown = JOBS_PAGE; refresh(); });
  $('#jobs-clear-metro').addEventListener('click', () => { state.usState = null; selectMetro(null); });
  $('#job-years').insertAdjacentHTML('beforeend', YEARS_OPTIONS
    .map((n) => `<option value="${n}">${n === 1 ? '0–1 years' : `${n} years`}</option>`).join(''));
  $('#job-langs').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-lang]');
    if (!pill) return;
    const name = pill.dataset.lang;
    state.langs = state.langs.includes(name) ? state.langs.filter((l) => l !== name) : [...state.langs, name];
    jobsShown = JOBS_PAGE;
    refresh({ push: true });
  });
  $('#job-levels').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-level]');
    if (!pill) return;
    const lvl = pill.dataset.level;
    state.levels = state.levels.includes(lvl) ? state.levels.filter((l) => l !== lvl) : [...state.levels, lvl];
    jobsShown = JOBS_PAGE;
    refresh();
  });
  $('#job-years').addEventListener('change', (e) => {
    state.maxYears = e.target.value === '' ? null : Number(e.target.value);
    jobsShown = JOBS_PAGE;
    refresh();
  });
  $('#job-years-known').addEventListener('change', (e) => { state.yearsKnown = e.target.checked; jobsShown = JOBS_PAGE; refresh(); });
  $('#job-state').addEventListener('change', (e) => {
    state.usState = e.target.value || null;
    state.metro = null;
    jobsShown = JOBS_PAGE;
    view?.resetView();
    refresh({ push: true });
  });
  $('#job-city').addEventListener('change', (e) => selectMetro(e.target.value || null));

  $('#jobs-list').addEventListener('click', async (e) => {
    if (e.target.closest('[data-more]')) {
      jobsShown += JOBS_PAGE;
      renderJobs(state.mine ? jobsListed.filter((j) => !j.gone) : filterJobs(jobPool, jobFilters()));
      return;
    }
    const card = e.target.closest('.job');
    if (!card) return;
    focusIndex = [...document.querySelectorAll('#jobs-list .job')].indexOf(card);
    if (e.target.closest('[data-forget]')) { updateStatus({ id: card.dataset.id }, null); return; }
    if (e.target.closest('[data-followed]')) { entries = followedUp(entries, card.dataset.id); persist(); return; }
    const job = jobsById.get(card.dataset.id);
    if (!job) return;
    if (e.target.closest('[data-apply]')) { openKit(job); return; } // the link itself opens the employer's page
    if (e.target.closest('[data-save]')) { updateStatus(job, entries[job.id]?.status === 'saved' ? null : 'saved'); return; }
    if (e.target.closest('[data-applied]')) { updateStatus(job, entries[job.id]?.status === 'applied' ? null : 'applied'); return; }
    if (e.target.closest('[data-hide]')) { updateStatus(job, entries[job.id]?.status === 'hidden' ? null : 'hidden'); return; }
    const textEl = card.querySelector('.job-text');
    const readBtn = card.querySelector('[data-read]');
    const showText = async () => {
      if (!textEl.dataset.loaded) {
        textEl.textContent = (await jobText(job.id)) || 'Full text is not available for this posting. Open it on the employer\'s site.';
        textEl.dataset.loaded = '1';
      }
      textEl.hidden = false;
      readBtn.setAttribute('aria-expanded', 'true');
      readBtn.textContent = 'Hide posting';
    };
    if (e.target.closest('[data-read]')) {
      if (textEl.hidden) await showText();
      else {
        textEl.hidden = true;
        readBtn.setAttribute('aria-expanded', 'false');
        readBtn.textContent = 'Read posting';
      }
    }
    if (e.target.closest('[data-prep]')) {
      const msg = card.querySelector('.prep-msg');
      const posting = postingForPrep(job, await jobText(job.id));
      try {
        await navigator.clipboard.writeText(posting);
        msg.className = 'prep-msg status ok';
        msg.innerHTML = 'Copied. In Terminal, from the project folder, run:<br><code class="cmd">pbpaste | .venv/bin/python apply/jobprep.py prep</code>';
      } catch {
        await showText();
        msg.className = 'prep-msg status warn';
        msg.textContent = 'This browser blocked clipboard access. Select the posting text below, copy it, then run: pbpaste | .venv/bin/python apply/jobprep.py prep';
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Applying: shortlist, tracker, apply kit, batch prep. Nothing here submits anything.
// ---------------------------------------------------------------------------

function persist() {
  if (!saveEntries(entries)) banner('This browser blocked local storage, so saved postings will be lost when you close the tab.');
  refresh();
}

function updateStatus(job, status) {
  const was = entries[job.id]?.status;
  entries = setStatus(entries, job, status);
  if (kitJob?.id === job.id) renderKit();
  persist();
  if (hasExtension() && status !== was && (status === 'applied' || was === 'applied')) void tellExtension(job, status === 'applied');
}

const forExtension = (j) => ({
  id: j.id, title: j.title, company: j.company, location: j.location ?? '', url: j.url, applyUrl: j.applyUrl ?? j.url,
  source: jobsData?.sources.find((s) => s.source === j.source)?.label ?? j.source ?? '',
});

/** Record a status change in the extension's history, with the posting's full description. */
async function tellExtension(job, applied) {
  const j = jobsById.get(job.id) ?? job;
  if (!j.url && !j.applyUrl) return;
  if (!applied) { toExtension('unapplied', { job: forExtension(j) }); return; }
  toExtension('applied', { job: { ...forExtension(j), description: await jobText(j.id) }, date: entries[j.id]?.applied });
}

/** Mark postings applied that you submitted through the extension. */
function syncFromExtension() {
  if (!jobsData || !fromExtension) return;
  const { entries: next, added } = mergeApplied(entries, fromExtension, jobsData.jobs);
  fromExtension = null;
  if (!added) return;
  entries = next;
  persist();
  mineMessage(`Marked ${added} posting${added === 1 ? '' : 's'} applied from the Autofill extension's history.`);
}

/** Open saved postings' applications in tabs; the extension fills each one and you submit it. */
const queueable = () => entriesWith(entries, 'saved').map(([id]) => jobsById.get(id))
  .filter((j) => j && !inProgress.has(applicationKey(j.applyUrl ?? j.url)));

async function queueSaved() {
  const saved = queueable().slice(0, QUEUE_MAX);
  if (!saved.length) return;
  mineMessage(`Opening ${saved.length} application${saved.length === 1 ? '' : 's'}…`);
  const jobs = await Promise.all(saved.map(async (j) => ({ ...forExtension(j), description: await jobText(j.id) })));
  toExtension('apply-queue', { jobs });
}

function renderMine() {
  const c = counts(entries);
  const views = [['', 'All', null], ['saved', 'Saved', c.saved], ['applied', 'Applied', c.applied], ['hidden', 'Hidden', c.hidden]];
  $('#mine-views').innerHTML = views.map(([key, label, n]) => `<label><input type="radio" name="mine" value="${key}"${(state.mine ?? '') === key ? ' checked' : ''}><span>${label}${n == null ? '' : `<span class="seg-count">${fmtInt(n)}</span>`}</span></label>`).join('');
  const due = $('#due-line');
  due.hidden = !c.due;
  due.textContent = `${c.due} follow-up${c.due === 1 ? '' : 's'} due`;
  $('#hide-done').checked = prefs.hideDone;
  const ready = entriesWith(entries, 'saved').filter(([id]) => jobsById.has(id)).length;
  $('#batch-download').textContent = `Download saved for prep (${ready})`;
  $('#batch-download').disabled = !ready;
  const queue = $('#autofill-queue');
  const open = queueable().length;
  queue.hidden = !hasExtension();
  queue.disabled = !open;
  queue.textContent = `Apply to saved with Autofill (${open > QUEUE_MAX ? `${QUEUE_MAX} of ${open}` : open})`;
  queue.title = 'Saved postings already opened by the extension and not submitted yet are left out.';
  $('#autofill-history').hidden = !hasExtension();
}

function renderKit() {
  const el = $('#apply-kit');
  if (!kitJob) { el.hidden = true; return; }
  const items = kitItems(kit);
  const applied = entries[kitJob.id]?.status === 'applied';
  el.innerHTML = `<div class="kit-head">
      <div><span class="muted small">Applying to</span><strong>${escapeHtml(kitJob.title)}</strong><span class="small">${escapeHtml(kitJob.company)}</span></div>
      <button type="button" class="icon-btn" data-kit-close aria-label="Close apply kit">×</button>
    </div>
    <p class="hint">The application opened in a new tab. Copy your answers from here into the form, then submit it yourself.</p>
    ${items.length ? `<ul class="kit-list">${items.map(([label, value], i) => `<li>
        <span class="kit-label">${escapeHtml(label)}</span><span class="kit-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
        <button type="button" class="ghost small" data-copy="${i}">Copy</button></li>`).join('')}</ul>`
    : '<p class="small">Your apply kit is empty. Fill it in once with the answers forms always ask for.</p>'}
    <div class="kit-actions">
      <button type="button" class="${applied ? 'ghost' : 'btn-primary'}" data-kit-applied>${applied ? 'Applied ✓ (undo)' : 'Mark as applied'}</button>
      <button type="button" class="ghost small" data-kit-prep>Copy posting for prep</button>
      <button type="button" class="linklike small" data-kit-edit>${items.length ? 'Edit kit' : 'Set up kit'}</button>
    </div>
    <p class="hint">For tailored answers ("Why this company?", a short cover note), run prep on this posting first; they're in <code>answers.txt</code> in its <code>apply/out/</code> folder.</p>
    <p class="status" role="status" data-kit-msg></p>`;
  el.hidden = false;
}

function openKit(job) {
  kitJob = job;
  renderKit();
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = label; button.classList.remove('copied'); }, 1200);
    }
    return true;
  } catch {
    return false;
  }
}

function openKitEditor() {
  $('#kit-fields').innerHTML = KIT_FIELDS.map(([key, label, placeholder]) => `<label>${escapeHtml(label)}
    <input name="${key}" value="${escapeHtml(kit.fields?.[key] ?? '')}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></label>`).join('');
  $('#kit-extra').value = kit.extra ?? '';
  $('#kit-editor').showModal();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function mineMessage(text, kind = 'ok') {
  const el = $('#mine-msg');
  el.className = `status ${kind}`;
  el.innerHTML = text;
}

async function downloadBatch() {
  const saved = entriesWith(entries, 'saved').map(([id]) => jobsById.get(id)).filter(Boolean);
  if (!saved.length) return;
  const texts = Object.fromEntries(await Promise.all(saved.map(async (j) => [j.id, await jobText(j.id)])));
  const name = `prep-batch-${isoToday()}.json`;
  download(name, JSON.stringify(prepBatch(saved, texts), null, 1), 'application/json');
  mineMessage(`Downloaded ${saved.length} posting${saved.length === 1 ? '' : 's'}. Then run:<br><code class="cmd">.venv/bin/python apply/jobprep.py batch ~/Downloads/${escapeHtml(name)}</code>`);
}

function focusCard(i, { scroll = true } = {}) {
  const cards = [...document.querySelectorAll('#jobs-list .job')];
  if (!cards.length || i < 0) { focusIndex = -1; return null; }
  focusIndex = Math.max(0, Math.min(i, cards.length - 1));
  const card = cards[focusIndex];
  if (scroll) {
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  return card;
}

// j/k to move between postings, then one key per action. Only in the postings tab, never while typing.
function onJobKeys(e) {
  if (state.mode !== 'jobs' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && kitJob) { kitJob = null; renderKit(); return; }
  if (e.target.closest('input, textarea, select, [contenteditable], dialog')) return;
  const keys = { j: 1, k: -1 };
  if (e.key in keys) {
    focusCard(focusIndex + keys[e.key]);
    e.preventDefault();
    return;
  }
  const card = document.querySelectorAll('#jobs-list .job')[focusIndex];
  if (!card) return;
  const target = { s: '[data-save]', a: '[data-apply]', p: '[data-prep]', r: '[data-read]', h: '[data-hide]' }[e.key];
  const el = target && card.querySelector(target);
  if (el) { el.click(); e.preventDefault(); }
}

function wireApplying() {
  $('#mine-views').addEventListener('change', (e) => {
    state.mine = e.target.value || null;
    state.metro = null;
    jobsShown = JOBS_PAGE;
    focusIndex = -1;
    refresh({ push: true });
  });
  $('#due-line').addEventListener('click', () => { state.mine = 'applied'; refresh({ push: true }); });
  $('#hide-done').addEventListener('change', (e) => { prefs.hideDone = e.target.checked; savePrefs(prefs); refresh(); });
  $('#kit-open').addEventListener('click', openKitEditor);
  $('#batch-download').addEventListener('click', downloadBatch);
  $('#autofill-queue').addEventListener('click', queueSaved);
  $('#autofill-history').addEventListener('click', () => toExtension('open-applications'));
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'job-autofill') return;
    if (e.data.type === 'applications' && Array.isArray(e.data.applications)) {
      fromExtension = e.data.applications;
      inProgress = new Set(Array.isArray(e.data.inProgress) ? e.data.inProgress.filter((k) => typeof k === 'string') : []);
      syncFromExtension();
      if (jobsData) renderMine();
    }
    if (e.data.type === 'queued') {
      const skipped = Array.isArray(e.data.skipped) ? e.data.skipped.filter((x) => typeof x === 'string') : [];
      mineMessage(e.data.error
        ? `The extension couldn't open them: ${escapeHtml(String(e.data.error))}`
        : `Opened ${Number(e.data.opened)} application${e.data.opened === 1 ? '' : 's'} in new tabs. Each fills itself in; check it and submit it yourself. Submitted ones are marked applied here.`
          + (skipped.length ? `<br>Skipped (your limits in the extension's profile page):<br>${skipped.map(escapeHtml).join('<br>')}` : ''),
        e.data.error ? 'error' : 'ok');
    }
  });
  if (hasExtension()) toExtension('hello');
  $('#export-csv').addEventListener('click', () => download(`applications-${isoToday()}.csv`, toCSV(entries), 'text/csv'));
  $('#backup').addEventListener('click', () => download(`job-tracker-backup-${isoToday()}.json`,
    JSON.stringify(exportBackup(entries, kit), null, 1), 'application/json'));
  $('#restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const data = parseBackup(await file.text());
    if (!data) { mineMessage('That file isn\'t a backup from this site.', 'error'); return; }
    const n = Object.keys(data.entries).length;
    if (!window.confirm(`Replace your current list with the ${n} postings in this backup?`)) return;
    entries = data.entries;
    if (data.kit) { kit = data.kit; saveKit(kit); }
    persist();
    mineMessage(`Restored ${n} postings.`);
  });

  $('#apply-kit').addEventListener('click', async (e) => {
    if (!kitJob) return;
    const msg = $('#apply-kit [data-kit-msg]');
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const [, value] = kitItems(kit)[Number(copy.dataset.copy)] ?? [];
      if (value && !(await copyText(value, copy))) msg.textContent = 'This browser blocked the clipboard. Select the text and copy it instead.';
    }
    if (e.target.closest('[data-kit-close]')) { kitJob = null; renderKit(); }
    if (e.target.closest('[data-kit-edit]')) openKitEditor();
    if (e.target.closest('[data-kit-applied]')) updateStatus(kitJob, entries[kitJob.id]?.status === 'applied' ? 'saved' : 'applied');
    if (e.target.closest('[data-kit-prep]')) {
      const ok = await copyText(postingForPrep(kitJob, await jobText(kitJob.id)), e.target.closest('[data-kit-prep]'));
      msg.innerHTML = ok ? 'Copied. Run: <code class="cmd">pbpaste | .venv/bin/python apply/jobprep.py prep</code>' : 'This browser blocked the clipboard.';
    }
  });

  const closeEditor = () => $('#kit-editor').close();
  $('#kit-cancel').addEventListener('click', closeEditor);
  $('#kit-cancel-2').addEventListener('click', closeEditor);
  $('#kit-form').addEventListener('submit', () => {
    const fields = Object.fromEntries(KIT_FIELDS.map(([key]) => [key, $(`#kit-fields [name="${key}"]`).value.trim()]));
    kit = { fields, extra: $('#kit-extra').value };
    if (!saveKit(kit)) banner('This browser blocked local storage, so the apply kit will be lost when you close the tab.');
    renderKit();
  });
  document.addEventListener('keydown', onJobKeys);
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

function addOccupation(code, { refreshNow = true } = {}) {
  if (!core.occByCode.has(code) || state.occ.includes(code)) return;
  state.occ = [...state.occ, code];
  if (refreshNow) refresh({ push: true });
}

function removeOccupation(code) {
  state.occ = state.occ.filter((c) => c !== code);
  state.evidence.delete(code);
  refresh({ push: true });
  renderSuggestionsState();
}

const KIND_LABEL = { title: 'title', tool: 'tool', skill: 'skill', word: 'word' };

// Shown first in the language row; any other language in the data is reachable through search.
const FEATURED_LANGUAGES = ['Rust', 'Python', 'JavaScript', 'TypeScript', 'Go', 'Java', 'C++', 'C#'];

function languageCodes(lang) {
  return occupationsByLanguage(core.occupations, lang).map((o) => o.code);
}

function pickLanguage(lang) {
  state.occ = languageCodes(lang);
  state.evidence.clear();
  refresh({ push: true });
  renderSuggestionsState();
}

function renderLanguages() {
  const sameSet = (codes) => codes.length === state.occ.length && codes.every((c) => state.occ.includes(c));
  const active = core.languages.find(([lang]) => sameSet(languageCodes(lang)))?.[0];
  for (const btn of document.querySelectorAll('#lang-picks [data-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === active));
  }
  const note = $('#lang-note');
  note.hidden = !active;
  if (active) {
    const n = state.occ.length;
    note.textContent = `O*NET lists ${active} for ${n} occupation${n === 1 ? '' : 's'}. Government data has no per-language job counts, so this shows where those occupations are concentrated.`;
  }
}

function renderChips() {
  const el = $('#chips');
  if (!state.occ.length) {
    el.innerHTML = '<p class="muted small">None selected yet.</p>';
    return;
  }
  el.innerHTML = `<ul class="chip-list">${state.occ.map((code) => {
    const occ = core.occByCode.get(code);
    const ev = state.evidence.get(code);
    return `<li class="chip">
      <div class="chip-main"><span>${escapeHtml(occ?.label ?? code)}</span>
        <button type="button" class="icon-btn" data-remove="${code}" aria-label="Remove ${escapeHtml(occ?.label ?? code)}">×</button></div>
      ${ev ? `<div class="chip-why">From resume: ${ev.map((t) => escapeHtml(t.text)).join(', ')}</div>` : ''}
    </li>`;
  }).join('')}</ul>
  ${state.occ.length > 1 ? '<button type="button" class="linklike small" data-clear>Clear all</button>' : ''}`;
}

function wirePicker() {
  const input = $('#occ-search');
  const list = $('#occ-results');
  let results = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const draw = () => {
    list.innerHTML = results.length ? results.map((r, i) => `
      <li role="option" id="opt-${i}" aria-selected="${i === active}" data-code="${r.occ.code}" class="${state.occ.includes(r.occ.code) ? 'is-picked' : ''}">
        <span class="opt-label">${escapeHtml(r.occ.label)}</span>
        ${r.via ? `<span class="opt-via">matches “${escapeHtml(r.via)}”</span>` : ''}
        <span class="opt-code">${r.occ.code}</span>
      </li>`).join('') : '<li class="muted empty-opt">No matching occupations</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
  };
  const choose = (code) => {
    addOccupation(code);
    input.value = '';
    close();
    input.focus();
  };

  input.addEventListener('input', () => {
    results = searchOccupations(searchIndex, input.value);
    active = results.length ? 0 : -1;
    if (input.value.trim().length < 2) close(); else draw();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && results[active]) { choose(results[active].occ.code); e.preventDefault(); }
    if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-code]');
    if (li) { e.preventDefault(); choose(li.dataset.code); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  $('#chips').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) removeOccupation(rm.dataset.remove);
    if (e.target.closest('[data-clear]')) {
      state.occ = [];
      state.evidence.clear();
      refresh({ push: true });
      renderSuggestionsState();
    }
  });
  $('#empty').addEventListener('click', (e) => {
    const b = e.target.closest('[data-code]');
    if (b) addOccupation(b.dataset.code);
  });
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

let suggestions = [];

function renderSuggestionsState() {
  const el = $('#suggestions');
  if (!suggestions.length) { el.innerHTML = ''; return; }
  el.innerHTML = suggestions.map((s) => {
    const picked = state.occ.includes(s.code);
    return `<li class="suggestion">
      <div class="sugg-head">
        <button type="button" class="toggle ${picked ? 'is-on' : ''}" data-toggle="${s.code}" aria-pressed="${picked}">
          ${picked ? 'Added' : 'Add'}</button>
        <span class="sugg-label">${escapeHtml(s.label)}${s.strong ? '' : ' <span class="weak" title="Matched only general skills or loose words, not a job title or tool">weak match</span>'}</span>
        <span class="score" title="Relative match score (top match = 100)">
          <span class="score-bar" style="width:${s.score}%"></span><span class="score-num">${s.score}</span></span>
      </div>
      <ul class="terms">${s.terms.map((t) => `<li class="term term-${t.kind}"><span class="term-kind">${KIND_LABEL[t.kind]}</span>${escapeHtml(t.text)}</li>`).join('')}</ul>
    </li>`;
  }).join('');
}

async function handleResume(file) {
  const status = $('#resume-status');
  status.className = 'status';
  status.textContent = `Reading ${file.name} in your browser…`;
  suggestions = [];
  renderSuggestionsState();
  try {
    const [{ extractText }, { buildMatcher }] = await Promise.all([import('./resume.js'), import('./matcher.js')]);
    const { text, pages, words } = await extractText(file);
    matcher ??= buildMatcher(core.occupations);
    suggestions = matcher.match(text, 10);
    if (!suggestions.length) {
      status.className = 'status warn';
      status.textContent = `Read ${fmtInt(words)} words, but no occupation titles, tools or skills matched. Pick occupations with the search above.`;
      return;
    }
    // Auto-add only matches backed by a job title or tool. Generic skills such as
    // "Critical Thinking" appear everywhere and aren't enough on their own.
    const top = suggestions[0].score;
    const strong = suggestions.slice(0, 3).filter((s) => s.strong && s.score >= top * 0.5);
    status.className = strong.length ? 'status ok' : 'status warn';
    status.textContent = `Read ${fmtInt(words)} words${pages ? ` from ${pages} page${pages > 1 ? 's' : ''}` : ''}. `
      + (strong.length
        ? `Added ${strong.length} strong match${strong.length > 1 ? 'es' : ''}. Each suggestion lists the resume terms that matched. Keyword matching makes mistakes, so check them and add or remove as needed.`
        : 'No job titles or tools matched, only general skills, so nothing was added. Review the weak matches below or search above.');
    strong.forEach((s) => {
      state.evidence.set(s.code, s.terms.slice(0, 4));
      addOccupation(s.code, { refreshNow: false });
    });
    for (const s of suggestions) if (!state.evidence.has(s.code)) state.evidence.set(s.code, s.terms.slice(0, 4));
    renderSuggestionsState();
    refresh({ push: true });
  } catch (err) {
    if (!err.kind) console.error(err);
    status.className = 'status error';
    status.textContent = err.kind ? err.message : `Could not read that file (${err.message}).`;
  } finally {
    $('#resume-file').value = '';
  }
}

function wireResume() {
  const input = $('#resume-file');
  const drop = $('#drop');
  input.addEventListener('change', () => input.files[0] && handleResume(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    if (e.dataTransfer.files[0]) handleResume(e.dataTransfer.files[0]);
  });
  $('#suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    const code = b.dataset.toggle;
    if (state.occ.includes(code)) removeOccupation(code);
    else { addOccupation(code); renderSuggestionsState(); }
  });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function syncControls() {
  for (const r of document.querySelectorAll('input[name="metric"]')) r.checked = r.value === state.metric;
  const floor = $('#floor');
  if (document.activeElement !== floor) floor.value = state.floor;
  floor.disabled = state.metric !== 'lq';
  $('#metric-hint').textContent = state.metric === 'lq'
    ? 'Where the job is unusually common relative to the US. 1.0 is average; 3.0+ is a strong cluster.'
    : 'Where the most people do this job. This mostly tracks city size.';
}

function wireControls() {
  for (const r of document.querySelectorAll('input[name="metric"]')) {
    r.addEventListener('change', () => { state.metric = r.value; refresh(); });
  }
  $('#floor').addEventListener('change', (e) => {
    const v = Number.parseInt(e.target.value, 10);
    state.floor = Number.isFinite(v) && v >= 0 ? v : DEFAULT_FLOOR;
    refresh();
  });
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.addEventListener('click', () => !tab.disabled && setView(tab.dataset.view));
  }
  $('#banner-close').addEventListener('click', () => { $('#banner').hidden = true; });
  $('#about-btn').addEventListener('click', () => $('#about').showModal());
  $('#about-close').addEventListener('click', () => $('#about').close());
  window.addEventListener('popstate', () => {
    Object.assign(state, readState());
    state.occ = state.occ.filter((c) => core.occByCode.has(c));
    refresh();
    renderSuggestionsState();
  });
}

// ---------------------------------------------------------------------------

async function init() {
  wireControls();
  try {
    core = await loadCore();
  } catch (err) {
    console.error(err);
    showFatal(err.status === 404
      ? '<h2>Data not built yet</h2><p>Run <code>python build_data.py</code> to generate <code>web/data/</code>. The README lists the source files to download first.</p>'
      : `<h2>Could not load data</h2><p>${escapeHtml(err.message)}</p>`);
    return;
  }
  const { meta } = core;
  occVintage = `${meta.vintage.label}: not live job postings`;
  $('#vintage').textContent = occVintage;
  $('#about-vintage').textContent = meta.vintage.note;
  $('#about-sources').innerHTML = meta.sources.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  if (meta.partial) banner('This is a partial build limited to a few occupations (build_data.py --occ).');

  searchIndex = buildSearchIndex(core.occupations);
  state.occ = state.occ.filter((c) => core.occByCode.has(c));
  if (state.metro && !core.metroById.has(state.metro)) state.metro = null;
  core.languages = languageCounts(core.occupations);
  const counts = new Map(core.languages);
  $('#lang-picks').innerHTML = FEATURED_LANGUAGES.filter((l) => counts.has(l))
    .map((l) => `<button type="button" class="pill" data-lang="${escapeHtml(l)}" aria-pressed="false" title="${counts.get(l)} occupation${counts.get(l) === 1 ? '' : 's'}">${escapeHtml(l)}</button>`).join('');
  $('#lang-picks').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lang]');
    if (btn) pickLanguage(btn.dataset.lang);
  });
  wirePicker();
  wireResume();
  wireJobs();
  wireApplying();

  const examples = ['15-1252', '29-1141', '17-2171', '27-2011'].filter((c) => core.occByCode.has(c));
  $('#examples').innerHTML = examples.map((c) => `<button type="button" class="pill" data-code="${c}">${escapeHtml(core.occByCode.get(c).label)}</button>`).join('');

  webglOK = hasWebGL() && !params.has('nowebgl');
  const globeTab = $('#tab-globe');
  globeTab.disabled = !webglOK;
  if (!webglOK) {
    globeTab.title = 'WebGL is unavailable in this browser';
    $('#no-webgl-note').hidden = false;
  }
  const initial = refresh();
  await setView(webglOK ? 'globe' : 'map');
  await initial;
}

init();
