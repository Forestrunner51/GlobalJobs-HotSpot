import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, markerSubset, classify } from '../../web/js/aggregate.js';
import { buildMatcher, tokenize } from '../../web/js/matcher.js';
import { buildSearchIndex, searchOccupations, languageCounts, occupationsByLanguage } from '../../web/js/search.js';
import { readState, stateToSearch } from '../../web/js/state.js';
import { makeScale } from '../../web/js/scale.js';

const rec = (regionId, occCode, employment, concentration, extra = {}) => ({
  id: `${regionId}:${occCode}`, regionId, regionLabel: `Metro ${regionId}`, lat: 30, lng: -90,
  occCode, occLabel: occCode, employment, concentration, concentrationSource: 'reported',
  medianWage: 50000, skills: [], ...extra,
});

test('classify: suppressed is no data, small counts are below floor', () => {
  assert.equal(classify(rec('1', 'a', null, null), 'lq', 50), 'nodata');
  assert.equal(classify(rec('1', 'a', 40, 3), 'lq', 50), 'below');
  assert.equal(classify(rec('1', 'a', 400, 3), 'lq', 50), 'ok');
  assert.equal(classify(rec('1', 'a', 40, null), 'employment', 50), 'ok');
});

test('aggregate: one entry per metro, max LQ across selection, sorted', () => {
  const agg = aggregate([
    rec('10000', '15-1252', 1000, 1.2),
    rec('10000', '15-1211', 500, 2.5),
    rec('20000', '15-1252', 9000, 1.9),
    rec('30000', '15-1252', null, null),
    rec('40000', '15-1252', 10, 9.0),
  ], { metric: 'lq', floor: 50 });
  assert.deepEqual(agg.ranked.map((m) => [m.regionId, m.value]), [['10000', 2.5], ['20000', 1.9]]);
  assert.equal(agg.ranked[0].lead.occCode, '15-1211');
  assert.deepEqual(agg.noData.map((m) => m.regionId), ['30000']);
  assert.deepEqual(agg.belowFloor.map((m) => m.regionId), ['40000']);
});

test('aggregate: employment metric sums across the selection', () => {
  const agg = aggregate([rec('1', 'a', 100, 1), rec('1', 'b', 50, null), rec('2', 'a', 120, 1)], { metric: 'employment' });
  assert.deepEqual(agg.ranked.map((m) => [m.regionId, m.value]), [['1', 150], ['2', 120]]);
});

test('markerSubset is a prefix of the ranked table', () => {
  const ranked = [5, 4, 3, 2, 1.1, 0.9].map((v, i) => ({ regionId: String(i), value: v }));
  const lq = markerSubset(ranked, { metric: 'lq', maxMarkers: 300, minLQ: 1.0 });
  assert.deepEqual(lq, ranked.slice(0, 5));
  assert.deepEqual(markerSubset(ranked, { metric: 'lq', maxMarkers: 2, minLQ: 1 }), ranked.slice(0, 2));
});

test('tokenize keeps tech tokens and stems plurals', () => {
  assert.deepEqual(tokenize('Senior Software Developers, C++ & Node.js; 5 years'), ['senior', 'software', 'developer', 'c++', 'node.js', 'year']);
});

const OCCS = [
  { code: '15-1252', label: 'Software Developers', titles: ['Software Engineer', 'Application Developer'], tech: ['Python', 'Git'], skills: ['Programming', 'Critical Thinking'] },
  { code: '29-1141', label: 'Registered Nurses', titles: ['Staff Nurse', 'ICU Nurse'], tech: ['Epic Systems'], skills: ['Service Orientation', 'Critical Thinking'] },
  { code: '17-2171', label: 'Petroleum Engineers', titles: ['Reservoir Engineer', 'Drilling Engineer'], tech: ['Petrel'], skills: ['Mathematics', 'Critical Thinking'] },
];

test('matcher ranks by title evidence and reports the driving terms', () => {
  const m = buildMatcher(OCCS);
  const res = m.match('Experienced software engineer. Built Python services with Git. Strong programming background.');
  assert.equal(res[0].code, '15-1252');
  assert.equal(res[0].score, 100);
  const texts = res[0].terms.map((t) => t.text.toLowerCase());
  assert.ok(texts.includes('software engineer'));
  assert.ok(texts.includes('python'));
  const nurse = m.match('ICU nurse at a regional hospital, charting in Epic Systems daily.');
  assert.equal(nurse[0].code, '29-1141');
});

test('matcher returns nothing for unrelated text', () => {
  assert.deepEqual(buildMatcher(OCCS).match('lorem ipsum dolor sit amet'), []);
});

test('search finds label and alternate titles', () => {
  const idx = buildSearchIndex(OCCS);
  assert.equal(searchOccupations(idx, 'nurse')[0].occ.code, '29-1141');
  const viaTitle = searchOccupations(idx, 'reservoir');
  assert.equal(viaTitle[0].occ.code, '17-2171');
  assert.equal(viaTitle[0].via, 'Reservoir Engineer');
});

test('search finds occupations by programming language', () => {
  const occs = [
    { code: '15-1299', label: 'Computer Occupations, All Other', titles: ['Blockchain Engineer'], languages: ['Rust', 'Python'], nationalEmployment: 400 },
    { code: '15-1252', label: 'Software Developers', titles: [], languages: ['Python'], nationalEmployment: 1600 },
    { code: '13-2052', label: 'Personal Financial Advisors', titles: ['Trust Officer'], languages: [], nationalEmployment: 300 },
  ];
  const idx = buildSearchIndex(occs);
  for (const q of ['rust', 'Rust jobs', 'rust developer']) {
    const res = searchOccupations(idx, q);
    assert.deepEqual(res.map((r) => r.occ.code), ['15-1299'], q);
    assert.equal(res[0].via, 'uses Rust');
  }
  assert.equal(searchOccupations(idx, 'trust')[0].via, 'Trust Officer');
  assert.deepEqual(occupationsByLanguage(occs, 'Python').map((o) => o.code), ['15-1252', '15-1299']);
  assert.deepEqual(languageCounts(occs), [['Python', 2], ['Rust', 1]]);
});

test('URL state round-trips and rejects junk', () => {
  const s = { occ: ['15-1252', '17-2171'], metric: 'employment', floor: 100, metro: '26420',
    mode: 'occ', q: '', where: 'all', focus: false };
  assert.deepEqual(readState(stateToSearch(s)), s);
  const jobs = { ...s, mode: 'jobs', q: 'backend', where: 'remote', focus: true };
  assert.deepEqual(readState(stateToSearch(jobs)), jobs);
  assert.deepEqual(readState('?occ=bad,15-1252&metric=x&floor=-3&metro=abc&mode=x&where=moon'),
    { occ: ['15-1252'], metric: 'lq', floor: 50, metro: null, mode: 'occ', q: '', where: 'all', focus: false });
});

test('LQ color scale uses a fixed log domain', () => {
  const s = makeScale('lq', []);
  assert.equal(s.t(0.5), 0);
  assert.equal(s.t(8), 1);
  assert.ok(Math.abs(s.t(2) - 0.5) < 1e-9); // 2x is the log midpoint of 0.5x..8x
});

import { filterJobs, jobMarkers, isFocused, strengthLabel, postingForPrep, safeUrl } from '../../web/js/jobs.js';

const JOBS = [
  { id: 'a', title: 'Rust Engineer', company: 'Acme', location: 'Seattle, WA', regionIds: ['42660'], us: true, remote: false, keywords: ['Rust'], inTitle: true, mentions: 4, url: 'https://x/a', applyUrl: 'https://x/a/apply' },
  { id: 'b', title: 'Backend Engineer', company: 'Beta', location: 'Remote (US) | Seattle, WA', regionIds: ['42660'], us: true, remote: true, keywords: ['Rust'], inTitle: false, mentions: 1, url: 'https://x/b' },
  { id: 'c', title: 'Systems Engineer', company: 'Gamma', location: 'Berlin', regionIds: [], us: false, remote: false, keywords: ['Rust'], inTitle: false, mentions: 2, url: 'https://x/c' },
  { id: 'd', title: 'SRE', company: 'Delta', location: 'New York, NY', regionIds: ['35620'], us: true, remote: false, keywords: ['Rust'], inTitle: false, mentions: 1, url: 'javascript:alert(1)' },
];
const METRO_BY_ID = new Map([
  ['42660', { regionLabel: 'Seattle-Tacoma-Bellevue, WA', lat: '47.6', lng: '-122.0' }],
  ['35620', { regionLabel: 'New York-Newark-Jersey City, NY-NJ', lat: '40.7', lng: '-74.0' }],
]);

test('filterJobs: location, focus, metro and text filters combine', () => {
  const ids = (opts) => filterJobs(JOBS, opts).map((j) => j.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ where: 'us' }), ['a', 'b', 'd']);
  assert.deepEqual(ids({ where: 'remote' }), ['b']);
  assert.deepEqual(ids({ focus: true }), ['a', 'c']);
  assert.deepEqual(ids({ metro: '42660' }), ['a', 'b']);
  assert.deepEqual(ids({ q: 'engineer seattle' }), ['a', 'b']);
  assert.deepEqual(ids({ q: 'gamma' }), ['c']);
});

test('jobMarkers counts postings per metro, most first', () => {
  const m = jobMarkers(JOBS, METRO_BY_ID);
  assert.deepEqual(m.map((x) => [x.regionId, x.value]), [['42660', 2], ['35620', 1]]);
  assert.equal(m[0].lat, 47.6);
  assert.deepEqual(m[0].jobs.map((j) => j.id), ['a', 'b']);
});

test('job strength labels and prep text', () => {
  assert.ok(isFocused(JOBS[0]) && !isFocused(JOBS[1]) && isFocused(JOBS[2]));
  assert.equal(strengthLabel(JOBS[0]), 'Rust in title');
  assert.equal(strengthLabel(JOBS[1]), 'mentions Rust once');
  assert.equal(strengthLabel(JOBS[2]), 'mentions Rust 2×');
  const text = postingForPrep(JOBS[0], 'Build things in Rust.');
  assert.match(text, /^Source: https:\/\/x\/a\nApply: https:\/\/x\/a\/apply\n\nRust Engineer\nAcme · Seattle, WA\n\nBuild things in Rust\.$/);
  assert.equal(safeUrl(JOBS[3].url), null);
});
