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
    mode: 'occ', q: '', where: 'all', work: 'any', jobType: 'any', fresh: false, focus: false, levels: [], maxYears: null, yearsKnown: false, usState: null, langs: [], mine: null, sort: 'relevance', pay: false };
  assert.deepEqual(readState(stateToSearch(s)), s);
  const jobs = { ...s, mode: 'jobs', q: 'backend', where: 'us', work: 'hybrid', jobType: 'contract', fresh: true, focus: true, levels: ['entry', 'mid'], maxYears: 3, yearsKnown: true, usState: 'WA', langs: ['C++', 'Go', 'C#', 'XR / AR / VR'], mine: 'applied', sort: 'new', pay: true };
  assert.deepEqual(readState(stateToSearch(jobs)), jobs);
  assert.deepEqual(readState('?occ=bad,15-1252&metric=x&floor=-3&metro=abc&mode=x&where=moon'),
    { occ: ['15-1252'], metric: 'lq', floor: 50, metro: null, mode: 'occ', q: '', where: 'all', work: 'any', jobType: 'any', fresh: false, focus: false, levels: [], maxYears: null, yearsKnown: false, usState: null, langs: [], mine: null, sort: 'relevance', pay: false });
  assert.equal(readState('?where=remote').work, 'remote'); // links from before the work-style filter
  assert.deepEqual(readState('?lvl=senior,bogus&yrs=abc').levels, ['senior']);
  assert.equal(readState('?st=wa').usState, null);
  assert.deepEqual(readState('?lang=C%23+%2F+.NET,Rust').langs, ['C# / .NET', 'Rust']);
});

test('LQ color scale uses a fixed log domain', () => {
  const s = makeScale('lq', []);
  assert.equal(s.t(0.5), 0);
  assert.equal(s.t(8), 1);
  assert.ok(Math.abs(s.t(2) - 0.5) < 1e-9); // 2x is the log midpoint of 0.5x..8x
});

import {
  filterJobs, langsByGroup, jobMarkers, isFocused, strengthTags, jobSnippet, sortJobs, langCounts, textShard,
  postingForPrep, safeUrl, levelCounts, stateCounts, workCounts, jobTypeCounts, isNew, shortlist,
} from '../../web/js/jobs.js';

const JOBS = [
  { id: 'a', title: 'Rust Engineer', company: 'Acme', location: 'Seattle, WA', regionIds: ['42660'], states: ['WA'], us: true, remote: false, keywords: ['Rust'], inTitle: ['Rust'], mentions: { Rust: 4 }, snippets: { Rust: 'Write Rust.' }, posted: '2026-10-01', url: 'https://x/a', applyUrl: 'https://x/a/apply' },
  { id: 'b', title: 'Backend Engineer', company: 'Beta', location: 'Remote (US) | Seattle, WA', regionIds: ['42660'], states: ['WA'], us: true, remote: true, keywords: ['Rust', 'Go'], inTitle: [], mentions: { Rust: 1, Go: 3 }, snippets: { Rust: 'some Rust', Go: 'Go services' }, posted: '2026-10-10', url: 'https://x/b' },
  { id: 'c', title: 'Systems Engineer', company: 'Gamma', location: 'Berlin', regionIds: [], us: false, remote: false, keywords: ['Rust'], inTitle: [], mentions: { Rust: 2 }, snippets: {}, posted: '2026-09-01', url: 'https://x/c' },
  { id: 'd', title: 'SRE', company: 'Delta', location: 'New York, NY', regionIds: ['35620'], states: ['NY'], us: true, remote: false, keywords: ['Go', 'Python'], inTitle: [], mentions: { Go: 1, Python: 1 }, snippets: {}, posted: '2026-10-15', url: 'javascript:alert(1)' },
];
const METRO_BY_ID = new Map([
  ['42660', { regionLabel: 'Seattle-Tacoma-Bellevue, WA', lat: '47.6', lng: '-122.0' }],
  ['35620', { regionLabel: 'New York-Newark-Jersey City, NY-NJ', lat: '40.7', lng: '-74.0' }],
]);

test('filterJobs: location, focus, metro and text filters combine', () => {
  const ids = (opts) => filterJobs(JOBS, opts).map((j) => j.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ where: 'us' }), ['a', 'b', 'd']);
  assert.deepEqual(ids({ work: 'remote' }), ['b']);
  assert.deepEqual(ids({ work: 'onsite' }), ['a', 'c', 'd']);
  assert.deepEqual(ids({ focus: true }), ['a', 'b', 'c']); // b is focused on Go
  assert.deepEqual(ids({ langs: ['Rust'] }), ['a', 'b', 'c']);
  assert.deepEqual(ids({ langs: ['Go'] }), ['b', 'd']);
  assert.deepEqual(ids({ langs: ['Rust'], focus: true }), ['a', 'c']); // b mentions Rust once
  assert.deepEqual(ids({ langs: ['Go', 'Python'], focus: true }), ['b']);
  assert.deepEqual(ids({ metro: '42660' }), ['a', 'b']);
  assert.deepEqual(ids({ q: 'engineer seattle' }), ['a', 'b']);
  assert.deepEqual(ids({ q: 'gamma' }), ['c']);
  assert.deepEqual(ids({ usState: 'WA' }), ['a', 'b']);
  assert.deepEqual(ids({ usState: 'WA', work: 'remote' }), ['b']);
  assert.deepEqual(stateCounts(JOBS), [['NY', 'New York', 1], ['WA', 'Washington', 2]]);
});

test('shortlist: fit, freshness and autofill, one per company, skipping my list', () => {
  const base = { title: '', location: '', regionIds: [], keywords: ['Go'], inTitle: [], mentions: { Go: 1 } };
  const today = new Date('2026-11-26T12:00:00Z');
  const jobs = [
    { id: 'old', company: 'A', source: 'greenhouse', firstSeen: '2026-10-01' },
    { id: 'new-gh', company: 'B', source: 'greenhouse', firstSeen: '2026-11-26' },
    { id: 'new-feed', company: 'C', source: 'himalayas', firstSeen: '2026-11-26' },
    { id: 'b-again', company: 'b ', source: 'lever', firstSeen: '2026-11-26' },
    { id: 'saved', company: 'D', source: 'ashby', firstSeen: '2026-11-26' },
    { id: 'gone', company: 'E', source: 'ashby', firstSeen: '2026-11-26', gone: true },
  ].map((j) => ({ ...base, ...j }));
  const ids = (opts) => shortlist(jobs, { today, skip: new Set(['saved']), ...opts }).map((j) => j.id);
  assert.deepEqual(ids({}), ['new-gh', 'new-feed', 'old']); // b-again is B's second posting
  assert.deepEqual(ids({ size: 2 }), ['new-gh', 'new-feed']);
  assert.deepEqual(ids({ perCompany: 2 }).slice(0, 2).sort(), ['b-again', 'new-gh']);
  const matchOf = (j) => ({ percent: j.id === 'old' ? 100 : 10 });
  assert.equal(ids({ matchOf })[0], 'old'); // a strong fit beats freshness
});

test('work style and new postings', () => {
  const jobs = [
    { id: 'r', remote: true, location: 'Remote (US)', firstSeen: '2026-10-18' },
    { id: 'h', hybrid: true, location: 'Hybrid - NYC', firstSeen: '2026-10-01' },
    { id: 'rh', remote: true, hybrid: true, location: 'Remote or hybrid in SF', firstSeen: '2026-10-19' },
    { id: 'o', location: 'Austin, TX', firstSeen: '2026-09-30' },
    { id: 'x', location: '', firstSeen: '2026-09-30' },
  ].map((j) => ({ title: '', company: '', regionIds: [], keywords: [], inTitle: [], mentions: {}, ...j }));
  const ids = (opts) => filterJobs(jobs, opts).map((j) => j.id);
  assert.deepEqual(ids({ work: 'remote' }), ['r', 'rh']);
  assert.deepEqual(ids({ work: 'hybrid' }), ['h', 'rh']);
  assert.deepEqual(ids({ work: 'onsite' }), ['o']); // no location means unknown, not on-site
  assert.deepEqual(workCounts(jobs).map(([k, , n]) => [k, n]), [['any', 5], ['remote', 2], ['hybrid', 2], ['onsite', 1]]);
  const typed = [{ id: 'f' }, { id: 'c', type: 'contract' }, { id: 'p', type: 'parttime' }]
    .map((j) => ({ title: '', company: '', location: '', regionIds: [], keywords: [], inTitle: [], mentions: {}, ...j }));
  assert.deepEqual(filterJobs(typed, { jobType: 'contract' }).map((j) => j.id), ['c']);
  assert.deepEqual(filterJobs(typed, { jobType: 'fulltime' }).map((j) => j.id), ['f']); // not stated counts as full-time
  assert.deepEqual(jobTypeCounts(typed).map(([k, , n]) => [k, n]), [['any', 3], ['fulltime', 1], ['contract', 1], ['parttime', 1]]);
  const meta = { generated: '2026-10-19T12:00:00+00:00', trackedSince: '2026-09-30' };
  assert.deepEqual(ids({ fresh: true, meta }), ['r', 'rh']); // h is 18 days old; o and x were in the first run
  assert.equal(isNew(jobs[0], { ...meta, trackedSince: '2026-10-19' }), false);
});

test('filterJobs: any pick within a row, every row', () => {
  const groupOf = { Rust: 'language', Go: 'language', Python: 'language', React: 'framework', AWS: 'cloud' };
  const jobs = [
    { id: 'a', keywords: ['Rust', 'AWS'] },
    { id: 'b', keywords: ['Go', 'React', 'AWS'] },
    { id: 'c', keywords: ['Python', 'React'] },
  ].map((j) => ({ title: '', company: '', location: '', regionIds: [], inTitle: [], mentions: {}, ...j }));
  const ids = (langs) => filterJobs(jobs, { langs, groupOf }).map((j) => j.id);
  assert.deepEqual(ids(['Rust', 'Go']), ['a', 'b']);
  assert.deepEqual(ids(['Rust', 'Go', 'AWS']), ['a', 'b']);
  assert.deepEqual(ids(['Rust', 'Go', 'React']), ['b']);
  assert.deepEqual(ids(['React', 'AWS']), ['b']);
  assert.deepEqual(langsByGroup(['Go', 'React', 'Rust'], groupOf), [['Go', 'Rust'], ['React']]);
  // Without groups every pick is one row, as before.
  assert.deepEqual(filterJobs(jobs, { langs: ['Rust', 'React'] }).map((j) => j.id), ['a', 'b', 'c']);
  // A pill counts what it would show in its row alongside the other rows' picks.
  assert.deepEqual(langCounts(jobs, ['Rust', 'Python', 'React', 'AWS'], { langs: ['Go', 'React'], groupOf }),
    [['Rust', 0], ['Python', 1], ['React', 1], ['AWS', 1]]);
});

test('filterJobs: experience level and years', () => {
  const jobs = [
    { id: 'jr', level: 'entry', years: 1 }, { id: 'mid', level: 'mid', years: null },
    { id: 'sr', level: 'senior', years: 5 }, { id: 'st', level: 'staff', years: 10 },
  ].map((j) => ({ title: '', company: '', location: '', regionIds: [], keywords: [], ...j }));
  const ids = (opts) => filterJobs(jobs, opts).map((j) => j.id);
  assert.deepEqual(ids({ levels: ['entry', 'mid'] }), ['jr', 'mid']);
  assert.deepEqual(ids({ maxYears: 5 }), ['jr', 'mid', 'sr']); // unstated years are kept by default
  assert.deepEqual(ids({ maxYears: 5, yearsKnown: true }), ['jr', 'sr']);
  assert.deepEqual(ids({ levels: ['senior', 'staff'], maxYears: 3 }), []);
  assert.deepEqual(levelCounts(jobs), { intern: 0, entry: 1, mid: 1, senior: 1, staff: 1, manager: 0 });
});

test('jobMarkers counts postings per metro, most first', () => {
  const m = jobMarkers(JOBS, METRO_BY_ID);
  assert.deepEqual(m.map((x) => [x.regionId, x.value]), [['42660', 2], ['35620', 1]]);
  assert.equal(m[0].lat, 47.6);
  assert.deepEqual(m[0].jobs.map((j) => j.id), ['a', 'b']);
  const multi = [{ ...JOBS[0], regionIds: ['42660', '35620'] }];
  assert.deepEqual(jobMarkers(JOBS, METRO_BY_ID).map((x) => [x.regionId, x.value]), [['42660', 2], ['35620', 1]]);
  assert.deepEqual(jobMarkers(multi, METRO_BY_ID, { usState: 'WA' }).map((x) => x.regionId), ['42660']);
});

test('per-language tags, snippets, sorting and prep text', () => {
  assert.ok(isFocused(JOBS[0]) && isFocused(JOBS[1]) && !isFocused(JOBS[1], ['Rust']));
  assert.deepEqual(strengthTags(JOBS[0]).tags, [{ text: 'Rust in title', focus: true }]);
  assert.deepEqual(strengthTags(JOBS[1]).tags.map((t) => t.text), ['Go ×3', 'Rust once']);
  assert.deepEqual(strengthTags(JOBS[1], ['Rust']).tags.map((t) => t.text), ['Rust once']);
  assert.equal(strengthTags(JOBS[1], [], 1).more, 1);
  assert.equal(jobSnippet(JOBS[1]).lang, 'Go');
  assert.equal(jobSnippet(JOBS[1], ['Rust']).text, 'some Rust');
  assert.deepEqual(sortJobs(JOBS).map((j) => j.id), ['a', 'b', 'd', 'c']); // c and d tie; d is newer
  assert.deepEqual(sortJobs(JOBS, ['Go']).map((j) => j.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(langCounts(JOBS, ['Rust', 'Go', 'Zig']), [['Rust', 3], ['Go', 2], ['Zig', 0]]);
  assert.deepEqual(langCounts(JOBS, ['Rust', 'Go'], { focus: true, langs: ['Go'] }), [['Rust', 2], ['Go', 1]]);
  // Must agree with text_shard() in jobs/fetch_jobs.py.
  assert.deepEqual(['gh-cloudflare-123', 'ab-zed-6871e6ed', 'hn-49922881'].map((id) => textShard(id)), ['23', '11', '31']);
  const text = postingForPrep(JOBS[0], 'Build things in Rust.');
  assert.match(text, /^Source: https:\/\/x\/a\nApply: https:\/\/x\/a\/apply\nJob ID: a\n\nRust Engineer\nAcme · Seattle, WA\n\nBuild things in Rust\.$/);
  assert.equal(safeUrl(JOBS[3].url), null);
});

import {
  setStatus, followedUp, followUpDue, counts, entriesWith, toCSV, prepBatch, parseBackup, exportBackup,
  kitItems, normalizeKit, addDays, loadEntries, applicationKey, mergeApplied,
} from '../../web/js/tracker.js';

test('tracker: save, apply, hide and follow-ups', () => {
  const job = { id: 'a', title: 'Rust Engineer', company: 'Acme, Inc.', location: 'Seattle, WA', url: 'https://x/a' };
  let e = setStatus({}, job, 'saved', '2026-10-19');
  assert.deepEqual(e.a, { status: 'saved', job: { title: 'Rust Engineer', company: 'Acme, Inc.', location: 'Seattle, WA', url: 'https://x/a', applyUrl: undefined }, updated: '2026-10-19', saved: '2026-10-19' });
  e = setStatus(e, job, 'applied', '2026-10-20');
  assert.equal(e.a.applied, '2026-10-20');
  assert.equal(e.a.followUp, '2026-10-26'); // 6 days, as in jobprep.py
  assert.equal(e.a.saved, '2026-10-19'); // history kept
  assert.ok(!followUpDue(e.a, '2026-10-25') && followUpDue(e.a, '2026-10-26'));
  assert.deepEqual(counts(e, '2026-10-27'), { saved: 0, applied: 1, hidden: 0, due: 1 });
  e = followedUp(e, 'a', '2026-10-27');
  assert.equal(e.a.followUp, '2026-11-02');
  e = setStatus(e, { id: 'b', title: 'SRE', company: 'B' }, 'hidden', '2026-10-21');
  assert.deepEqual(entriesWith(e, 'hidden').map(([id]) => id), ['b']);
  assert.deepEqual(Object.keys(setStatus(e, { id: 'b' }, null)), ['a']);
  assert.equal(addDays('2026-12-30', 6), '2027-01-05');
  assert.deepEqual(loadEntries(), {}); // no localStorage under node: empty, not a crash
});

test('tracker: CSV, batch file, backup and apply kit', () => {
  const e = setStatus({}, { id: 'a', title: 'Engineer, "Core"', company: 'Acme, Inc.', url: 'https://x/a' }, 'saved', '2026-10-19');
  assert.equal(toCSV(e).split('\n')[1], 'saved,"Acme, Inc.","Engineer, ""Core""",,2026-10-19,,,https://x/a,a');
  const batch = prepBatch([{ id: 'a', title: 'Engineer', company: 'Acme', url: 'https://x/a', snippets: {} }], { a: 'Full text.' }, '2026-10-19');
  assert.equal(batch.format, 'jobglobal-prep-batch');
  assert.match(batch.postings[0].text, /^Source: https:\/\/x\/a\nJob ID: a\n\nEngineer\nAcme\n\nFull text\.$/);
  const kit = { fields: { name: 'Sam Lee', email: '', heard: 'Careers page' }, extra: 'Short bio.\n\nProject summary.' };
  assert.deepEqual(parseBackup(JSON.stringify(exportBackup(e, kit))), { entries: JSON.parse(JSON.stringify(e)), kit });
  assert.equal(parseBackup('{"entries": {}}'), null);
  assert.equal(parseBackup('not json'), null);
  assert.deepEqual(kitItems(kit), [['Full name', 'Sam Lee'], ['How did you hear about us?', 'Careers page'],
    ['Saved answer 1', 'Short bio.'], ['Saved answer 2', 'Project summary.']]);
  // The answer bank: titled answers copy under their question; untitled and older ones are numbered.
  const bank = normalizeKit({ fields: { name: ' Sam ' }, answers: [{ q: ' Why here? ', a: ' The mission. ' }, { q: 'Empty', a: ' ' }, { a: 'No title.' }, null], extra: 'Old one.' });
  assert.deepEqual(bank.answers, [{ q: 'Why here?', a: 'The mission.' }, { q: '', a: 'No title.' }, { q: '', a: 'Old one.' }]);
  assert.deepEqual(kitItems(bank), [['Full name', 'Sam'], ['Why here?', 'The mission.'], ['Saved answer 1', 'No title.'], ['Saved answer 2', 'Old one.']]);
  assert.deepEqual(normalizeKit(null), { fields: {}, answers: [] });
});

test('tracker: extension job keys and merging applications from the extension', () => {
  assert.equal(applicationKey('https://www.stripe.com/jobs/listing?gh_jid=555'), 'greenhouse:555');
  assert.equal(applicationKey('https://job-boards.greenhouse.io/stripe/jobs/555/confirmation'), 'greenhouse:555');
  assert.equal(applicationKey('https://acme.wd5.myworkdayjobs.com/en-US/Ext/job/X/Eng_R1/apply'), 'workday:acme.wd5.myworkdayjobs.com/Ext/job/X/Eng_R1');
  assert.equal(applicationKey('https://jobs.lever.co/palantir/6ED76CE8-4156-4b60-b120-403538bd66cd/apply'), 'lever:6ed76ce8-4156-4b60-b120-403538bd66cd');
  assert.equal(applicationKey('https://jobs.ashbyhq.com/Acme/DCEA53A5-5650-406d-a154-fad077c4b81b/application'), 'ashby:dcea53a5-5650-406d-a154-fad077c4b81b');
  assert.equal(applicationKey('https://jobs.ashbyhq.com/acme/dcea53a5-5650-406d-a154-fad077c4b81b'), 'ashby:dcea53a5-5650-406d-a154-fad077c4b81b');
  const jobs = [
    { id: 'gh-stripe-555', title: 'Engineer', company: 'Stripe', url: 'https://stripe.com/jobs/listing?gh_jid=555' },
    { id: 'wd-1', title: 'SRE', company: 'Acme', url: 'https://acme.wd5.myworkdayjobs.com/en-US/Ext/job/X/Eng_R1' },
  ];
  const before = setStatus({}, jobs[1], 'saved', '2026-10-30');
  const { entries, added } = mergeApplied(before, [
    { key: 'greenhouse:555', applied: '2026-11-01' },
    { key: 'other', url: 'https://acme.wd5.myworkdayjobs.com/Ext/job/X/Eng_R1/apply/applyManually', applied: '2026-11-02' },
    { siteJobId: 'gone-1', title: 'Old role', company: 'Closed Co', url: 'https://x.example/j', applied: '2026-10-01' },
    null,
  ], jobs);
  assert.equal(added, 3);
  assert.equal(entries['gh-stripe-555'].applied, '2026-11-01');
  assert.equal(entries['wd-1'].saved, '2026-10-30'); // history kept
  assert.equal(entries['wd-1'].applied, '2026-11-02');
  assert.equal(entries['gone-1'].job.company, 'Closed Co');
  assert.equal(mergeApplied(entries, [{ key: 'greenhouse:555', applied: '2026-11-05' }], jobs).added, 0);
});

test('sortJobs: newest, and best fit for a resume', async () => {
  const { sortJobs: sort, filterJobs: filter } = await import('../../web/js/jobs.js');
  const { matchJob } = await import('../../web/js/profile.js');
  const job = (id, keywords, posted, extra = {}) => ({
    id, keywords, posted, title: '', company: '', location: '', regionIds: [], inTitle: [],
    mentions: Object.fromEntries(keywords.map((k) => [k, 1])), ...extra,
  });
  const jobs = [
    job('old-rust', ['Rust'], '2026-01-01', { inTitle: ['Rust'] }),
    job('new-mixed', ['Rust', 'Kafka', 'Go'], '2026-03-01'),
    job('mid-go', ['Go', 'AWS'], '2026-02-01', { salary: '$150k–$200k' }),
  ];
  assert.deepEqual(sort(jobs, ['Rust']).map((j) => j.id), ['old-rust', 'new-mixed', 'mid-go']);
  assert.deepEqual(sort(jobs, ['Rust'], { by: 'new' }).map((j) => j.id), ['new-mixed', 'mid-go', 'old-rust']);
  const mine = new Set(['Go', 'AWS']);
  assert.deepEqual(sort(jobs, [], { by: 'match', matchOf: (j) => matchJob(j, mine) }).map((j) => j.id),
    ['mid-go', 'new-mixed', 'old-rust']);
  // Of two complete matches, the posting that asks for more of what you have comes first.
  const full = [job('one', ['Go'], '2026-03-01'), job('two', ['Go', 'AWS'], '2026-01-01')];
  assert.deepEqual(sort(full, [], { by: 'match', matchOf: (j) => matchJob(j, mine) }).map((j) => j.id), ['two', 'one']);
  // Without a resume, "match" falls back to relevance rather than shuffling.
  assert.deepEqual(sort(jobs, ['Rust'], { by: 'match' }).map((j) => j.id), ['old-rust', 'new-mixed', 'mid-go']);
  assert.deepEqual(filter(jobs, { pay: true }).map((j) => j.id), ['mid-go']);
  const s = readState('?mode=jobs&sort=match&pay=1');
  assert.equal(s.sort, 'match');
  assert.equal(s.pay, true);
  assert.equal(stateToSearch(s), '?mode=jobs&sort=match&pay=1');
  assert.equal(readState('?sort=junk').sort, 'relevance');
});

test('resume profile: skills, contact details, kit filling and match percent', async () => {
  const { resumeSkills, resumeContact, fillKitFields, matchJob } = await import('../../web/js/profile.js');
  const resume = `ADA LOVELACE
San Francisco, CA | ada.lovelace@example.com | (415) 555-0134
linkedin.com/in/ada-lovelace · github.com/adal · https://ada.dev

Software engineer at Analytical Engines, Austin, TX. Built services in Rust and Python on AWS.
Trusted by 40 teams.`;
  const regexes = new Map([
    ['Rust', /(?<![A-Za-z0-9])Rust(?![A-Za-z0-9])/gi], ['Python', /(?<![A-Za-z0-9])Python(?![A-Za-z0-9])/gi],
    ['Go', /[Gg]olang/g], ['AWS', /(?<![A-Za-z0-9])AWS(?![A-Za-z0-9])/gi],
  ]);
  assert.deepEqual(resumeSkills(resume, regexes), ['Rust', 'Python', 'AWS']);
  assert.deepEqual(resumeSkills(resume, regexes), ['Rust', 'Python', 'AWS'], 'global regexes are reset between calls');
  assert.deepEqual(resumeContact(resume), {
    name: 'Ada Lovelace', email: 'ada.lovelace@example.com', phone: '(415) 555-0134',
    linkedin: 'https://linkedin.com/in/ada-lovelace', github: 'https://github.com/adal',
    portfolio: 'https://ada.dev', location: 'San Francisco, CA',
  });
  assert.deepEqual(resumeContact('Resume\nSenior Software Engineer\nno contact details here'), {});

  const { fields, filled } = fillKitFields({ name: 'A. Lovelace', email: ' ' }, { name: 'Ada Lovelace', email: 'a@b.co', phone: '555' });
  assert.deepEqual(fields, { name: 'A. Lovelace', email: 'a@b.co', phone: '555' });
  assert.deepEqual(filled, ['email', 'phone']);

  const job = { keywords: ['Rust', 'Kafka', 'AWS'], inTitle: ['Rust'], mentions: { Rust: 4, Kafka: 2, AWS: 1 } };
  assert.deepEqual(matchJob(job, ['Rust', 'AWS']), { percent: 67, weight: 4, have: ['Rust', 'AWS'], missing: ['Kafka'] });
  assert.equal(matchJob(job, []).percent, 0);
  assert.equal(matchJob({ keywords: [] }, ['Rust']), null);
});

test('tracker: moving the list to another device', async () => {
  const { encodeTransfer, decodeTransfer, mergeEntries, mergeKit, kitAsText } = await import('../../web/js/tracker.js');
  const entry = (status, updated, title = 'Engineer') => ({ status, updated, job: { title, company: 'Acme', location: '', url: 'https://a.example/1' } });
  const laptop = { a: entry('saved', '2026-11-01'), b: entry('applied', '2026-11-05'), c: entry('saved', '2026-11-02', 'Ünïcode — title') };
  const kit = { fields: { name: 'Ada', email: 'ada@example.com' }, extra: 'A bio.' };

  const code = await encodeTransfer(laptop, kit);
  assert.match(code, /^[zj]\.[\w-]+$/, 'safe to put after # in a link');
  assert.deepEqual(await decodeTransfer(code), { entries: laptop, kit });
  assert.equal(await decodeTransfer(code.slice(0, -9)), null, 'a cut-off link is refused, not half-read');
  assert.equal(await decodeTransfer('nonsense'), null);

  const phone = { a: entry('applied', '2026-11-03'), b: entry('saved', '2026-11-04'), d: entry('hidden', '2026-11-01') };
  const { entries, changed } = mergeEntries(phone, { ...laptop, junk: { status: 'weird' }, e: null });
  assert.equal(entries.a.status, 'applied', 'the phone changed it more recently');
  assert.equal(entries.b.status, 'applied', 'the laptop changed it more recently');
  assert.deepEqual(Object.keys(entries).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(changed, 2);

  assert.deepEqual(mergeKit({ fields: { name: 'Ada L.' }, extra: '' }, kit),
    { fields: { name: 'Ada L.', email: 'ada@example.com' }, answers: [{ q: '', a: 'A bio.' }] });
  assert.deepEqual(mergeKit(kit, null), kit);
  const mine = { fields: {}, answers: [{ q: 'Why here?', a: 'The mission.' }, { q: '', a: 'A bio.' }] };
  const theirs = { fields: {}, answers: [{ q: 'why here?', a: 'Older wording.' }, { q: 'Remote?', a: 'Yes.' }], extra: 'A bio.' };
  assert.deepEqual(mergeKit(mine, theirs).answers, [...mine.answers, { q: 'Remote?', a: 'Yes.' }],
    'an answer to the same question, or the same text, is not added twice');
  assert.equal(kitAsText(kit), 'Full name: Ada\nEmail: ada@example.com\nSaved answer 1: A bio.');
});
