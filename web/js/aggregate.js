// Pure ranking logic shared by the table, the 2D map and the globe, so every
// view shows the same metros in the same order.

export const DEFAULT_FLOOR = 50;

/**
 * ok      - usable value for the active metric
 * nodata  - BLS suppressed the estimate (never treated as zero)
 * below   - employment reported but under the floor (a genuine small count)
 */
export function classify(rec, metric, floor) {
  if (metric === 'employment') return rec.employment == null ? 'nodata' : 'ok';
  if (rec.concentration == null || rec.employment == null) return 'nodata';
  return rec.employment < floor ? 'below' : 'ok';
}

/**
 * One entry per metro for the selected occupations.
 * LQ metric: value = max LQ across the selected set (lead = that occupation).
 * Employment metric: value = total employment across the selected set.
 */
export function aggregate(records, { metric = 'lq', floor = DEFAULT_FLOOR } = {}) {
  const metros = new Map();
  for (const rec of records) {
    let m = metros.get(rec.regionId);
    if (!m) {
      m = { regionId: rec.regionId, regionLabel: rec.regionLabel, lat: rec.lat, lng: rec.lng,
        parts: [], value: null, lead: null };
      metros.set(rec.regionId, m);
    }
    m.parts.push({ rec, status: classify(rec, metric, floor) });
  }

  const ranked = [];
  const noData = [];
  const belowFloor = [];
  const key = metric === 'lq' ? 'concentration' : 'employment';
  const statusOrder = { ok: 0, below: 1, nodata: 2 };

  for (const m of metros.values()) {
    m.parts.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]
      || (b.rec[key] ?? -1) - (a.rec[key] ?? -1));
    const ok = m.parts.filter((p) => p.status === 'ok');
    if (ok.length) {
      m.lead = ok[0].rec;
      m.value = metric === 'lq'
        ? m.lead.concentration
        : ok.reduce((sum, p) => sum + p.rec.employment, 0);
      m.maxLQ = Math.max(...m.parts.map((p) => p.rec.concentration ?? -Infinity));
      if (!Number.isFinite(m.maxLQ)) m.maxLQ = null;
      ranked.push(m);
    } else if (m.parts.some((p) => p.status === 'nodata')) {
      noData.push(m);
    } else {
      belowFloor.push(m);
    }
  }

  ranked.sort((a, b) => b.value - a.value || a.regionLabel.localeCompare(b.regionLabel));
  noData.sort((a, b) => a.regionLabel.localeCompare(b.regionLabel));
  return { ranked, noData, belowFloor };
}

/** Markers handed to a renderer: a prefix of `ranked`, so order always matches the table. */
export function markerSubset(ranked, { metric, maxMarkers, minLQ }) {
  const out = [];
  for (const m of ranked) {
    if (out.length >= maxMarkers) break;
    if (metric === 'lq' && m.value < minLQ) break; // ranked is sorted, nothing later qualifies
    out.push(m);
  }
  return out;
}
