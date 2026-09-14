import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, markerSubset, classify } from '../../web/js/aggregate.js';
import { buildMatcher, tokenize } from '../../web/js/matcher.js';
import { buildSearchIndex, searchOccupations } from '../../web/js/search.js';
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

test('URL state round-trips and rejects junk', () => {
  const s = { occ: ['15-1252', '17-2171'], metric: 'employment', floor: 100, metro: '26420' };
  assert.deepEqual(readState(stateToSearch(s)), s);
  assert.deepEqual(readState('?occ=bad,15-1252&metric=x&floor=-3&metro=abc'),
    { occ: ['15-1252'], metric: 'lq', floor: 50, metro: null });
});

test('LQ color scale uses a fixed log domain', () => {
  const s = makeScale('lq', []);
  assert.equal(s.t(0.5), 0);
  assert.equal(s.t(8), 1);
  assert.ok(Math.abs(s.t(2) - 0.5) < 1e-9); // 2x is the log midpoint of 0.5x..8x
});
