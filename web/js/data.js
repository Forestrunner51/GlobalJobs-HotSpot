// Loads the static JSON emitted by build_data.py. Hotspot records may be a
// single file or sharded by SOC major group; callers don't need to know which.

const BASE = 'data/';

async function getJSON(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) {
    const err = new Error(`${BASE}${path}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function indexByOcc(records) {
  const byOcc = new Map();
  for (const r of records) {
    if (!byOcc.has(r.occCode)) byOcc.set(r.occCode, []);
    byOcc.get(r.occCode).push(r);
  }
  return byOcc;
}

export async function loadCore() {
  const [meta, occupations, metros] = await Promise.all([
    getJSON('meta.json'), getJSON('occupations.json'), getJSON('metros.json'),
  ]);
  return {
    meta,
    occupations,
    metros,
    occByCode: new Map(occupations.map((o) => [o.code, o])),
    metroById: new Map(metros.map((m) => [m.regionId, m])),
    chunks: new Map(), // shard key -> Promise<Map<occCode, records[]>>
  };
}

function chunk(core, key, path) {
  if (!core.chunks.has(key)) {
    const p = getJSON(path).then(indexByOcc);
    p.catch(() => core.chunks.delete(key)); // allow retry after a failed fetch
    core.chunks.set(key, p);
  }
  return core.chunks.get(key);
}

export async function loadRecords(core, codes) {
  const shards = core.meta.shards;
  const keys = shards
    ? [...new Set(codes.map((c) => c.slice(0, 2)))].filter((m) => shards.includes(m))
    : ['all'];
  const maps = await Promise.all(keys.map((k) => (
    shards ? chunk(core, k, `hotspots/${k}.json`) : chunk(core, k, 'hotspots.json'))));
  return codes.flatMap((code) => maps.flatMap((m) => m.get(code) || []));
}
