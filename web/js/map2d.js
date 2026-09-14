// SVG fallback map (no WebGL). Same markers, same order, same encodings as the globe.

import { loadScript } from './util.js';
import { shortMetro, escapeHtml } from './format.js';

const W = 975;
const H = 610;
const SVG_NS = 'http://www.w3.org/2000/svg';

export async function createMap2D(container, { onMetroClick, tooltipHtml }) {
  await Promise.all([loadScript('vendor/d3.min.js'), loadScript('vendor/topojson-client.min.js')]);
  const topo = await fetch('vendor/states-10m.json').then((r) => {
    if (!r.ok) throw new Error(`states-10m.json: HTTP ${r.status}`);
    return r.json();
  });
  const { d3, topojson } = window;
  const states = topojson.feature(topo, topo.objects.states);
  const projection = d3.geoAlbersUsa().fitExtent([[8, 8], [W - 8, H - 8]], states);
  const path = d3.geoPath(projection);

  const wrap = document.createElement('div');
  wrap.className = 'map2d-wrap';
  wrap.innerHTML = `<svg class="map2d" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of US metro areas; the ranked table lists the same values">
    <path class="land" d="${path(states)}"></path>
    <path class="borders" d="${path(topojson.mesh(topo, topo.objects.states, (a, b) => a !== b))}"></path>
    <g class="nodata-layer"></g><g class="marker-layer"></g><g class="label-layer"></g>
  </svg><p class="offmap" hidden></p>`;
  container.append(wrap);
  const svg = wrap.querySelector('svg');
  const [gNo, gPts, gLbl] = ['.nodata-layer', '.marker-layer', '.label-layer'].map((s) => svg.querySelector(s));
  const offmap = wrap.querySelector('.offmap');
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  container.append(tip);

  let byId = new Map();

  const circle = (x, y, r, attrs) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', x.toFixed(1));
    c.setAttribute('cy', y.toFixed(1));
    c.setAttribute('r', r.toFixed(1));
    for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
    return c;
  };

  function update({ markers, noData, scale, selectedMetro }) {
    gNo.replaceChildren();
    gPts.replaceChildren();
    gLbl.replaceChildren();
    byId = new Map();
    let outside = 0;

    for (const m of noData) {
      const p = projection([m.lng, m.lat]);
      if (!p) continue;
      byId.set(m.regionId, m);
      gNo.append(circle(p[0], p[1], 3.2, { class: 'dot-nodata', 'data-id': m.regionId }));
    }
    // Draw largest first so smaller markers stay clickable on top.
    for (const m of [...markers].reverse().sort((a, b) => b.value - a.value)) {
      const p = projection([m.lng, m.lat]);
      if (!p) { outside += 1; continue; }
      byId.set(m.regionId, m);
      gPts.append(circle(p[0], p[1], 2.5 + 13 * scale.t(m.value), {
        class: `dot${m.regionId === selectedMetro ? ' is-selected' : ''}`,
        fill: scale.color(m.value),
        'data-id': m.regionId,
      }));
    }
    markers.slice(0, 10).forEach((m) => {
      const p = projection([m.lng, m.lat]);
      if (!p) return;
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', (p[0] + 6 + 13 * scale.t(m.value)).toFixed(1));
      t.setAttribute('y', (p[1] + 4).toFixed(1));
      t.textContent = shortMetro(m.regionLabel);
      gLbl.append(t);
    });
    offmap.hidden = !outside;
    offmap.textContent = outside ? `${outside} ranked metro${outside > 1 ? 's' : ''} outside the map projection (e.g. Puerto Rico) appear in the table.` : '';
  }

  svg.addEventListener('pointermove', (e) => {
    const id = e.target.getAttribute?.('data-id');
    const m = id && byId.get(id);
    if (!m) { tip.hidden = true; return; }
    const r = container.getBoundingClientRect();
    tip.innerHTML = tooltipHtml(m);
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, e.clientY - r.top - tip.offsetHeight - 10)}px`;
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  svg.addEventListener('click', (e) => {
    const id = e.target.getAttribute?.('data-id');
    if (id) onMetroClick(id);
  });

  return {
    kind: 'map',
    update,
    focus() {},
    resetView() {},
    destroy() { container.replaceChildren(); },
    describe: () => escapeHtml('2D map'),
  };
}
