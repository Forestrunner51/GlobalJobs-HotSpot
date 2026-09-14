import { classify } from './aggregate.js';
import { escapeHtml, fmtInt, fmtLQ, fmtWage, WAGE_NOTE } from './format.js';

const chips = (items, cls) => items.map((s) => `<li class="${cls}">${escapeHtml(s)}</li>`).join('');

function occCard(code, rec, occ, metric, floor) {
  const label = escapeHtml(occ?.label ?? rec?.occLabel ?? code);
  const head = `<button type="button" class="linklike occ-link" data-occ="${code}" title="Show this occupation nationally">${label}</button>`;
  if (!rec) {
    return `<li class="occ-card"><div class="occ-head">${head}</div><p class="muted">No estimate published for this metro.</p></li>`;
  }
  const status = classify(rec, metric, floor);
  const badge = status === 'nodata'
    ? '<span class="badge badge-nodata">No data: suppressed by BLS</span>'
    : status === 'below' ? `<span class="badge">Below ${fmtInt(floor)}-job floor</span>` : '';
  const derived = rec.concentrationSource === 'derived' ? ' <span class="muted" title="Derived from employment counts">(derived)</span>' : '';
  const skills = occ?.skills?.length ? occ.skills.slice(0, 5) : rec.skills;
  return `<li class="occ-card">
    <div class="occ-head">${head}${badge}</div>
    <dl class="stats">
      <div><dt>Location quotient</dt><dd>${fmtLQ(rec.concentration)}${derived}</dd></div>
      <div><dt>Jobs</dt><dd>${fmtInt(rec.employment)}</dd></div>
      <div><dt>Median wage</dt><dd${rec.medianWage == null ? ` title="${WAGE_NOTE}"` : ''}>${fmtWage(rec.medianWage)}</dd></div>
    </dl>
    ${skills?.length ? `<p class="mini-head">Top skills</p><ul class="tags">${chips(skills, 'tag')}</ul>` : ''}
    ${occ?.tech?.length ? `<p class="mini-head">Common tools</p><ul class="tags">${chips(occ.tech.slice(0, 6), 'tag tag-tool')}</ul>` : ''}
  </li>`;
}

export function renderDetail(el, { metroInfo, records, selected, occByCode, metric, floor, onPickOcc, onClose }) {
  if (!metroInfo) {
    el.hidden = true;
    return;
  }
  const byOcc = new Map(records.map((r) => [r.occCode, r]));
  const top = metroInfo.top.map(([code, lq, emp]) => `
    <li><button type="button" class="linklike" data-occ="${code}">${escapeHtml(occByCode.get(code)?.label ?? code)}</button>
      <span class="num">${fmtLQ(lq)}</span><span class="num muted">${fmtInt(emp)}</span></li>`).join('');

  el.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(metroInfo.regionLabel)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Close metro details">×</button>
    </div>
    ${selected.length ? `<h3>Selected occupations here</h3><ul class="occ-list">${selected.map((c) => occCard(c, byOcc.get(c), occByCode.get(c), metric, floor)).join('')}</ul>` : ''}
    <h3>Most concentrated occupations here</h3>
    <p class="muted small">Location quotient and jobs. Only occupations with at least 50 jobs. Select one to map it nationally.</p>
    <ol class="top-list">${top || '<li class="muted">No published estimates.</li>'}</ol>
    <p class="caveat">A high LQ means the job is unusually common here. It does not mean anyone is hiring.</p>`;
  el.hidden = false;
  el.onclick = (e) => {
    if (e.target.closest('[data-close]')) return onClose();
    const occ = e.target.closest('[data-occ]');
    if (occ) onPickOcc(occ.dataset.occ);
  };
}
