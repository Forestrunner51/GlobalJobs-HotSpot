// Occupation picker search: label first, then O*NET alternate titles.

export function buildSearchIndex(occupations) {
  return occupations.map((o) => ({
    o,
    label: o.label.toLowerCase(),
    titles: o.titles.map((t) => [t, t.toLowerCase()]),
  }));
}

export function searchOccupations(index, query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  const results = [];
  for (const e of index) {
    let score = 0;
    let via = null;
    if (e.o.code === q) score = 120;
    else if (e.label.startsWith(q)) score = 100;
    else if (e.label.includes(q)) score = 80;
    else if (words.every((w) => e.label.includes(w))) score = 60;
    if (!score) {
      const hit = e.titles.find(([, lower]) => lower.includes(q))
        || (words.length > 1 && e.titles.find(([, lower]) => words.every((w) => lower.includes(w))));
      if (hit) {
        score = hit[1].startsWith(q) ? 50 : 40;
        via = hit[0];
      }
    }
    if (score) results.push({ occ: e.o, score, via });
  }
  results.sort((a, b) => b.score - a.score
    || (b.occ.nationalEmployment ?? 0) - (a.occ.nationalEmployment ?? 0));
  return results.slice(0, limit);
}
