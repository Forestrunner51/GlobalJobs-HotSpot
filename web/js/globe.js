// 3D globe view (globe.gl / three.js / WebGL), built to idle when nothing moves.

import { loadScript } from './util.js';
import { NO_DATA_COLOR } from './scale.js';
import { escapeHtml, shortMetro } from './format.js';

const HOME = { lat: 38.5, lng: -97, altitude: 1.9 };
const IDLE_MS = 1500;

function angularDistance(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / toRad;
}

export async function createGlobe(container, { narrow, onMetroClick, tooltipHtml, onContextLost }) {
  await loadScript('vendor/globe.gl.min.js');
  const host = document.createElement('div');
  host.className = 'globe-host';
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', '3D globe of US metro areas; the ranked table lists the same values');
  container.append(host);

  const home = { ...HOME, altitude: narrow ? 2.7 : HOME.altitude };
  const globe = new window.Globe(host, {
    rendererConfig: { antialias: !narrow, alpha: true, powerPreference: 'default' },
    animateIn: false,
  });

  globe
    .width(container.clientWidth)
    .height(container.clientHeight)
    .backgroundColor('rgba(0,0,0,0)')
    // Smaller texture for phones: less download and less VRAM.
    .globeImageUrl(narrow ? 'img/earth-dark-1k.jpg' : 'img/earth-dark-2k.jpg')
    .showAtmosphere(true)
    .atmosphereColor('#4d6d91')
    .atmosphereAltitude(0.12)
    .showGraticules(false)
    // One merged geometry = one draw call. Picking is done from globe coordinates instead.
    .pointsMerge(true)
    .pointsTransitionDuration(0)
    .pointResolution(narrow ? 6 : 10)
    .pointLat('lat')
    .pointLng('lng')
    .pointAltitude('alt')
    .pointRadius('radius')
    .pointColor('color')
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude('alt')
    .htmlElement('el')
    .htmlTransitionDuration(0)
    .pointOfView(home, 0);

  if (typeof globe.htmlElementVisibilityModifier === 'function') {
    globe.htmlElementVisibilityModifier((el, visible) => { el.style.opacity = visible ? '' : '0'; });
  }

  const renderer = globe.renderer();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // Dim the landmass: the rest of the world has no data and should read as inert.
  const material = globe.globeMaterial();
  material.color?.set?.('#9aa4b5');

  const controls = globe.controls();
  controls.autoRotate = false; // an auto-rotating globe never lets the render loop idle
  controls.enableDamping = true;
  controls.minDistance = 130;
  controls.maxDistance = 700;

  // ---- render loop idling ---------------------------------------------------
  let idleTimer = null;
  let paused = false;
  let destroyed = false;
  const stats = { wakes: {}, pauses: 0 }; // for verifying that the loop really idles
  const pause = () => {
    if (!paused && !destroyed) { globe.pauseAnimation(); paused = true; stats.pauses += 1; }
  };
  const wake = (ms = IDLE_MS, why = 'other') => {
    stats.wakes[why] = (stats.wakes[why] || 0) + 1;
    if (destroyed || document.hidden) return;
    if (paused) { globe.resumeAnimation(); paused = false; }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(pause, ms);
  };
  const onVisibility = () => (document.hidden ? pause() : wake(IDLE_MS, 'visible'));
  document.addEventListener('visibilitychange', onVisibility);
  controls.addEventListener('change', () => { wake(IDLE_MS, 'controls'); scheduleLabels(); });
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
    host.addEventListener(type, () => wake(IDLE_MS, 'input'), { passive: true });
  }

  // ---- WebGL context loss ------------------------------------------------------
  const canvas = renderer.domElement;
  const onLost = (e) => {
    e.preventDefault();
    clearTimeout(idleTimer);
    onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  // ---- data, labels, picking -------------------------------------------------
  let points = [];
  let labelTargets = [];
  let selectedId = null;
  const labelCache = new Map();
  let labelCount = -1;

  const labelEl = (m, value) => {
    let el = labelCache.get(m.regionId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'globe-label';
      labelCache.set(m.regionId, el);
    }
    el.innerHTML = `${escapeHtml(shortMetro(m.regionLabel))} <b>${escapeHtml(value)}</b>`;
    return el;
  };

  function desiredLabelCount() {
    const alt = globe.pointOfView().altitude;
    const base = narrow ? 8 : 12;
    return alt < 0.8 ? base * 3 : alt < 1.3 ? base * 2 : base;
  }

  function applyLabels(force = false) {
    const n = desiredLabelCount();
    if (!force && n === labelCount) return;
    labelCount = n;
    const els = labelTargets.slice(0, n);
    if (selectedId && !els.some((d) => d.metro.regionId === selectedId)) {
      const sel = points.find((p) => p.metro.regionId === selectedId);
      if (sel) els.push(sel.label);
    }
    for (const d of els) d.el.classList.toggle('is-selected', d.metro.regionId === selectedId);
    globe.htmlElementsData(els);
  }

  let labelFrame = 0;
  function scheduleLabels() {
    if (labelFrame) return;
    labelFrame = requestAnimationFrame(() => { labelFrame = 0; applyLabels(); });
  }

  function update({ markers, noData, scale, selectedMetro }) {
    selectedId = selectedMetro;
    const radius = narrow ? 0.8 : 0.6;
    const valuePts = markers.map((m) => {
      const t = scale.t(m.value);
      const p = { lat: m.lat, lng: m.lng, alt: 0.01 + 0.3 * t, radius, color: scale.color(m.value), metro: m };
      p.label = { lat: m.lat, lng: m.lng, alt: p.alt + 0.005, metro: m, el: labelEl(m, scale.format(m.value)) };
      return p;
    });
    // No data: flat, small and grey, so it differs from a low value in height, size and color.
    const noDataPts = noData.slice(0, narrow ? 60 : 150).map((m) => {
      const p = { lat: m.lat, lng: m.lng, alt: 0.002, radius: radius * 0.6, color: NO_DATA_COLOR, metro: m, noData: true };
      p.label = { lat: m.lat, lng: m.lng, alt: 0.01, metro: m, el: labelEl(m, 'no data') };
      return p;
    });
    points = [...valuePts, ...noDataPts];
    labelTargets = valuePts.map((p) => p.label);
    globe.pointsData(points);
    applyLabels(true);
    wake(IDLE_MS + 500, 'data');
  }

  // Pick in screen space against each bar's projected base-to-top segment. Mapping the
  // click to a surface lat/lng misses tall bars, whose tops project far from their base.
  function distToSegment(x, y, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
  }

  function pick(e) {
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pov = globe.pointOfView();
    // Points beyond the horizon seen from the camera are hidden behind the globe.
    const horizon = (Math.acos(1 / (1 + pov.altitude)) * 180) / Math.PI;
    const tolerance = e.pointerType === 'touch' ? 22 : 12;
    let best = null;
    let bestD = Infinity;
    for (const p of points) {
      if (angularDistance(pov.lat, pov.lng, p.lat, p.lng) > horizon) continue;
      const d = distToSegment(x, y, globe.getScreenCoords(p.lat, p.lng, 0), globe.getScreenCoords(p.lat, p.lng, p.alt));
      // Prefer value markers over flat no-data dots when both are within reach.
      const score = p.noData ? d + 4 : d;
      if (score < bestD) { bestD = score; best = p; }
    }
    return bestD <= tolerance ? best : null;
  }

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  container.append(tip);

  let down = null;
  host.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; tip.hidden = true; });
  host.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    const hit = pick(e);
    if (hit) onMetroClick(hit.metro.regionId);
  });

  let hoverFrame = 0;
  host.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || e.buttons || hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const hit = pick(e);
      host.style.cursor = hit ? 'pointer' : '';
      if (!hit) { tip.hidden = true; return; }
      const r = container.getBoundingClientRect();
      tip.innerHTML = tooltipHtml(hit.metro);
      tip.hidden = false;
      tip.style.left = `${Math.max(8, Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, e.clientY - r.top - tip.offsetHeight - 10)}px`;
    });
  });
  host.addEventListener('pointerleave', () => { tip.hidden = true; });

  const resize = new ResizeObserver(() => {
    globe.width(container.clientWidth).height(container.clientHeight);
    wake(IDLE_MS, 'resize');
  });
  resize.observe(container);

  wake(2500, 'init');

  return {
    kind: 'globe',
    update,
    focus(lat, lng) {
      globe.pointOfView({ lat, lng, altitude: Math.min(globe.pointOfView().altitude, 1.3) }, 800);
      wake(1800);
    },
    resetView() {
      globe.pointOfView(home, 800);
      wake(1800);
    },
    destroy() {
      destroyed = true;
      clearTimeout(idleTimer);
      cancelAnimationFrame(labelFrame);
      cancelAnimationFrame(hoverFrame);
      resize.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      try { globe.pauseAnimation(); } catch { /* already gone */ }
      try { globe._destructor?.(); } catch { /* best effort */ }
      try { renderer.dispose(); } catch { /* best effort */ }
      container.replaceChildren();
    },
    // Exposed for verification: markers in render order.
    markerIds: () => points.filter((p) => !p.noData).map((p) => p.metro.regionId),
    isPaused: () => paused,
    stats,
    globe,
    renderer,
  };
}
