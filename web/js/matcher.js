// v1 resume -> occupation matching: normalized n-gram overlap against titles,
// alternate titles, O*NET technology examples and skill names, IDF-weighted.
// Runs entirely in the browser.

const STOPWORDS = new Set((
  'a an and are as at be been by for from has have had in into is it its of on or that the to was were '
  + 'will with within our your you we i my me he she they their this those these using use used via per etc '
  + 'all other not no can may also such than then over under about across who which'
).split(' '));

const WEIGHTS = { title: 10, altTitle: 6, tool: 2, skill: 1, word: 0.8 };
const MAX_PHRASE = 6;

export function stem(t) {
  if (/[.+#]/.test(t)) return t; // node.js, c++, c#: technology names, not plurals
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+#.\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t) && !/^[\d.]+$/.test(t) && (t.length > 1 || t === 'c' || t === 'r'))
    .map(stem);
}

export function buildMatcher(occupations) {
  const entries = occupations.map((o) => {
    const phrases = new Map();
    const add = (text, kind, weight) => {
      const toks = tokenize(text);
      if (!toks.length || toks.length > MAX_PHRASE) return;
      const key = toks.join(' ');
      const prev = phrases.get(key);
      if (!prev || prev.weight < weight) phrases.set(key, { key, text, kind, weight, len: toks.length });
    };
    add(o.label, 'title', WEIGHTS.title);
    o.titles.forEach((t) => add(t, 'title', WEIGHTS.altTitle));
    o.tech.forEach((t) => add(t, 'tool', WEIGHTS.tool));
    o.skills.forEach((s) => add(s, 'skill', WEIGHTS.skill));
    const titleToks = new Set([o.label, ...o.titles.slice(0, 10)].flatMap(tokenize));
    return { o, phrases: [...phrases.values()], titleToks };
  });

  const N = entries.length;
  const phraseIndex = new Map();
  const tokenIndex = new Map();
  entries.forEach((e, i) => {
    for (const p of e.phrases) {
      if (!phraseIndex.has(p.key)) phraseIndex.set(p.key, []);
      phraseIndex.get(p.key).push([i, p]);
    }
    for (const t of e.titleToks) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(i);
    }
  });
  const idf = (df) => Math.log(1 + N / df);

  function match(text, limit = 10) {
    const toks = tokenize(text);
    const grams = new Set();
    for (let i = 0; i < toks.length; i += 1) {
      let key = '';
      for (let n = 0; n < MAX_PHRASE && i + n < toks.length; n += 1) {
        key = n ? `${key} ${toks[i + n]}` : toks[i];
        grams.add(key);
      }
    }

    const scores = new Map();
    const bump = (i, points, term) => {
      let s = scores.get(i);
      if (!s) scores.set(i, (s = { score: 0, terms: new Map() }));
      s.score += points;
      const prev = s.terms.get(term.text.toLowerCase());
      if (!prev || prev.points < points) s.terms.set(term.text.toLowerCase(), { ...term, points });
    };

    for (const g of grams) {
      const hits = phraseIndex.get(g);
      if (!hits) continue;
      const w = idf(hits.length);
      for (const [i, p] of hits) {
        bump(i, p.weight * w * (1 + 0.5 * (p.len - 1)), { text: p.text, kind: p.kind });
      }
    }
    // Loose title-word overlap for resumes that describe the role without naming it.
    for (const t of new Set(toks)) {
      const hits = tokenIndex.get(t);
      if (!hits || t.length < 3) continue;
      const w = idf(hits.length);
      if (w < 1.5) continue;
      for (const i of hits) bump(i, WEIGHTS.word * w, { text: t, kind: 'word' });
    }

    const ranked = [...scores.entries()]
      .map(([i, s]) => ({
        code: entries[i].o.code,
        label: entries[i].o.label,
        raw: s.score,
        terms: s.terms,
        strong: [...s.terms.values()].some((t) => t.kind === 'title' || t.kind === 'tool'),
      }))
      .sort((a, b) => b.raw - a.raw)
      .slice(0, limit);
    const top = ranked[0]?.raw || 1;
    return ranked.map((r) => ({
      code: r.code,
      label: r.label,
      score: Math.round((100 * r.raw) / top),
      rawScore: Number(r.raw.toFixed(2)),
      strong: r.strong,
      terms: [...r.terms.values()].sort((a, b) => b.points - a.points).slice(0, 6)
        .map(({ text, kind }) => ({ text, kind })),
    }));
  }

  return { match, size: N };
}
