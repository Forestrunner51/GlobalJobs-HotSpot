import { readState, writeState } from './state.js';
import { loadCore, loadRecords, loadJobs, loadJobText } from './data.js';
import { aggregate, markerSubset, DEFAULT_FLOOR } from './aggregate.js';
import { makeScale, RAMP } from './scale.js';
import { renderTable } from './table.js';
import { renderDetail } from './detail.js';
import { buildSearchIndex, searchOccupations, languageCounts, occupationsByLanguage } from './search.js';
import { hasWebGL } from './util.js';
import { escapeHtml, fmtInt, fmtLQ } from './format.js';
import { filterJobs, jobMarkers, isFocused, strengthLabel, postedLabel, safeUrl, postingForPrep } from './jobs.js';

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
let jobsListed = [];
const JOBS_PAGE = 50;
let jobsShown = JOBS_PAGE;

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
  const scale = makeScale(viewMetric(), lastAgg.ranked.map((m) => m.value));
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
  }
  const anywhere = filterJobs(jobsData.jobs, { q: state.q, where: state.where, focus: state.focus });
  lastAgg = { ranked: jobMarkers(anywhere, core.metroById), noData: [], belowFloor: [] };
  if (state.metro && !lastAgg.ranked.some((m) => m.regionId === state.metro)) state.metro = null;
  jobsListed = state.metro ? anywhere.filter((j) => j.regionIds.includes(state.metro)) : anywhere;
  pushToView();
  renderJobs(anywhere);
  renderDetailView();
}

function syncJobControls() {
  const q = $('#job-q');
  if (document.activeElement !== q) q.value = state.q;
  for (const r of document.querySelectorAll('input[name="where"]')) r.checked = r.value === state.where;
  $('#job-focus').checked = state.focus;
  if (jobsData) $('#job-focus-label').textContent = `${jobsData.keywords.join(', ')}-focused postings only`;
}

function renderJobSources() {
  const total = jobsData.jobs.length;
  $('#jobs-sources').innerHTML = jobsData.sources.map((s) => {
    const skipped = !s.boards && s.problems.length;
    const what = s.source === 'hn' ? 'latest thread' : s.boards === 1 ? '1 feed' : `${s.boards} boards`;
    const detail = skipped
      ? `<span class="muted">${escapeHtml(s.problems[0].replace(/^[^:]+: (skipped: )?/, ''))}</span>`
      : `${fmtInt(s.matched)} of ${fmtInt(s.scanned)} postings <span class="muted">(${what})</span>`
        + (s.problems.length ? ` <span class="warn" title="${escapeHtml(s.problems.join('\n'))}">${s.problems.length} failed</span>` : '');
    return `<li><strong>${escapeHtml(s.label)}</strong> ${detail}</li>`;
  }).join('') + `<li class="muted">${fmtInt(total)} postings in all</li>`;
}

function highlight(text, keywords) {
  const alts = keywords.map((k) => escapeHtml(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return escapeHtml(text).replace(new RegExp(`(?<![A-Za-z0-9])(${alts})(?![A-Za-z0-9])`, 'gi'), '<mark>$1</mark>');
}

function jobCard(j) {
  const url = safeUrl(j.url);
  const apply = safeUrl(j.applyUrl) ?? url;
  const remoteTag = j.remote && !/remote/i.test(j.location) ? '<span class="tag">Remote</span>' : '';
  const meta = [
    `<span class="job-company">${escapeHtml(j.company)}</span>`,
    j.location ? escapeHtml(j.location) : '<span class="muted">Location not listed</span>',
    j.posted ? `<span class="muted">${escapeHtml(postedLabel(j.posted))}</span>` : '',
    `<span class="muted">via ${escapeHtml(jobsData.sources.find((s) => s.source === j.source)?.label ?? j.source)}</span>`,
  ].filter(Boolean).join(' · ');
  return `<article class="job" data-id="${escapeHtml(j.id)}">
    <h3 class="job-title">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(j.title)}</a>` : escapeHtml(j.title)}</h3>
    <div class="job-meta">${meta}</div>
    <div class="job-tags"><span class="tag${isFocused(j) ? ' is-focus' : ''}">${escapeHtml(strengthLabel(j))}</span>${remoteTag}${j.salary ? `<span class="tag">${escapeHtml(j.salary)}</span>` : ''}</div>
    ${j.snippet ? `<p class="job-snippet">${highlight(j.snippet, j.keywords)}</p>` : ''}
    <div class="job-actions">
      ${apply ? `<a class="btn-primary" href="${escapeHtml(apply)}" target="_blank" rel="noopener noreferrer">Apply</a>` : ''}
      <button type="button" class="ghost" data-prep>Copy for prep</button>
      <button type="button" class="linklike" data-read aria-expanded="false">Read posting</button>
    </div>
    <p class="prep-msg status" role="status"></p>
    <div class="job-text" hidden></div>
  </article>`;
}

function renderJobs(anywhere) {
  const kw = jobsData.keywords.join(', ');
  const metroLabel = state.metro && core.metroById.get(state.metro)?.regionLabel;
  const n = jobsListed.length;
  $('#jobs-title').textContent = metroLabel
    ? `${fmtInt(n)} posting${n === 1 ? '' : 's'} in ${metroLabel}`
    : `${fmtInt(n)} posting${n === 1 ? '' : 's'} mentioning ${kw}`;
  $('#jobs-clear-metro').hidden = !state.metro;
  const onMap = anywhere.filter((j) => j.regionIds.length).length;
  $('#jobs-count').textContent = `${fmtInt(anywhere.length)} of ${fmtInt(jobsData.jobs.length)} postings match. ${fmtInt(onMap)} have a US city and are on the map.`;
  const shown = jobsListed.slice(0, jobsShown);
  $('#jobs-list').innerHTML = shown.length
    ? shown.map(jobCard).join('') + (n > shown.length
      ? `<button type="button" class="ghost more-jobs" data-more>Show ${fmtInt(Math.min(JOBS_PAGE, n - shown.length))} more of ${fmtInt(n - shown.length)}</button>` : '')
    : '<p class="muted">No postings match these filters.</p>';
}

async function jobText(id) {
  try {
    return (await loadJobText())[id] ?? '';
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
  $('#job-focus').addEventListener('change', (e) => { state.focus = e.target.checked; jobsShown = JOBS_PAGE; refresh(); });
  $('#jobs-clear-metro').addEventListener('click', () => selectMetro(null));

  $('#jobs-list').addEventListener('click', async (e) => {
    if (e.target.closest('[data-more]')) {
      jobsShown += JOBS_PAGE;
      renderJobs(filterJobs(jobsData.jobs, { q: state.q, where: state.where, focus: state.focus }));
      return;
    }
    const card = e.target.closest('.job');
    const job = card && jobsById.get(card.dataset.id);
    if (!job) return;
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
