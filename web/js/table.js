// Ranked metro table: the WebGL fallback, a first-class view, and the
// reference the globe is checked against.

import { escapeHtml, fmtInt, fmtLQ, fmtWage, WAGE_NOTE } from './format.js';

const DERIVED_MARK = '<sup class="derived" title="LQ derived from employment counts; BLS did not report one">†</sup>';

export function renderTable(el, { agg, metric, floor, occByCode, selectedMetro, multi, onSelectMetro }) {
  if (!agg.ranked.length && !agg.noData.length && !agg.belowFloor.length) {
    el.innerHTML = '<p class="muted">No metro estimates for this selection.</p>';
    return;
  }
  const lqMetric = metric === 'lq';
  const rows = agg.ranked.map((m, i) => {
    const lead = m.lead;
    const lq = lqMetric ? m.value : m.maxLQ;
    const derived = lqMetric && lead.concentrationSource === 'derived' ? DERIVED_MARK : '';
    const wage = lead.medianWage == null && lead.employment != null
      ? `<span title="${WAGE_NOTE}">${fmtWage(null)}</span>` : fmtWage(lead.medianWage);
    return `<tr class="${m.regionId === selectedMetro ? 'is-selected' : ''}">
      <td class="num rank">${i + 1}</td>
      <th scope="row"><button type="button" class="linklike" data-metro="${m.regionId}">${escapeHtml(m.regionLabel)}</button></th>
      <td class="num strong">${lqMetric ? fmtLQ(m.value) + derived : fmtInt(m.value)}</td>
      <td class="num">${lqMetric ? fmtInt(lead.employment) : fmtLQ(lq)}</td>
      <td class="num">${wage}</td>
      ${multi ? `<td class="lead">${escapeHtml(occByCode.get(lead.occCode)?.label ?? lead.occLabel)}</td>` : ''}
    </tr>`;
  }).join('');

  const noData = agg.noData.length ? `
    <details class="nodata">
      <summary>${agg.noData.length} metro${agg.noData.length === 1 ? '' : 's'} with suppressed estimates: no data, not zero</summary>
      <ul>${agg.noData.map((m) => `<li><button type="button" class="linklike" data-metro="${m.regionId}">${escapeHtml(m.regionLabel)}</button></li>`).join('')}</ul>
    </details>` : '';
  const below = lqMetric && agg.belowFloor.length
    ? `<p class="muted">${agg.belowFloor.length} metro${agg.belowFloor.length === 1 ? '' : 's'} left out: employment below the ${fmtInt(floor)}-job floor.</p>` : '';

  el.innerHTML = `
    <div class="table-scroll">
      <table class="ranked">
        <caption class="sr-only">Metros ranked by ${lqMetric ? 'location quotient' : 'employment'}</caption>
        <thead><tr>
          <th scope="col" class="num">#</th>
          <th scope="col">Metro area</th>
          <th scope="col" class="num">${lqMetric ? (multi ? 'Max LQ' : 'LQ') : (multi ? 'Total jobs' : 'Jobs')}</th>
          <th scope="col" class="num">${lqMetric ? 'Jobs' : (multi ? 'Max LQ' : 'LQ')}</th>
          <th scope="col" class="num">Median wage</th>
          ${multi ? `<th scope="col">${lqMetric ? 'Most concentrated' : 'Largest'} occupation</th>` : ''}
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${multi ? 6 : 5}" class="muted">No metros meet the current floor.</td></tr>`}</tbody>
      </table>
    </div>
    ${below}${noData}`;

  el.onclick = (e) => {
    const btn = e.target.closest('[data-metro]');
    if (btn) onSelectMetro(btn.dataset.metro);
  };
}
