// Occupation picker search: label first, then programming languages, then O*NET alternate titles.

// Generic trailing words dropped before a language lookup, so "rust jobs" finds Rust.
const LANG_SUFFIX = /\s+(jobs?|developers?|programmers?|engineers?|dev)$/;

export function buildSearchIndex(occupations) {
  return occupations.map((o) => ({
    o,
    label: o.label.toLowerCase(),
    languages: (o.languages ?? []).map((l) => [l, l.toLowerCase()]),
    titles: o.titles.map((t) => [t, t.toLowerCase()]),
  }));
}

// Languages in the data with how many occupations use each, most-used first.
export function languageCounts(occupations) {
  const counts = new Map();
  for (const o of occupations) for (const l of o.languages ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function occupationsByLanguage(occupations, language) {
  return occupations
    .filter((o) => (o.languages ?? []).includes(language))
    .sort((a, b) => (b.nationalEmployment ?? 0) - (a.nationalEmployment ?? 0));
}

export function searchOccupations(index, query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  const lang = q.replace(LANG_SUFFIX, '');
  // Title hits must start at a word, so "rust" doesn't match "Trust Officer".
  const atWord = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const qRe = atWord(q);
  const wordRes = words.map(atWord);
  const results = [];
  for (const e of index) {
    let score = 0;
    let via = null;
    if (e.o.code === q) score = 120;
    else if (e.label.startsWith(q)) score = 100;
    else if (e.label.includes(q)) score = 80;
    else if (words.every((w) => e.label.includes(w))) score = 60;
    if (!score) {
      const used = e.languages.find(([, lower]) => lower === lang);
      if (used) {
        score = 55;
        via = `uses ${used[0]}`;
      }
    }
    if (!score) {
      const hit = e.titles.find(([, lower]) => qRe.test(lower))
        || (words.length > 1 && e.titles.find(([, lower]) => wordRes.every((re) => re.test(lower))));
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
