// Your shortlist, application tracker and apply kit. Stored only in this browser (localStorage);
// the page's Content Security Policy means none of it can be sent anywhere. Export makes a backup.

import { postingForPrep } from './jobs.js';

const TRACKER_KEY = 'jobglobal.tracker.v1';
const KIT_KEY = 'jobglobal.applykit.v1';
const PREFS_KEY = 'jobglobal.prefs.v1';
export const FOLLOW_UP_DAYS = 6; // same as FOLLOW_UP_DAYS in apply/jobprep.py
export const VIEWS = ['saved', 'applied', 'hidden'];

// Answers most application forms ask for. Filled once, copied into each form by hand.
export const KIT_FIELDS = [
  ['name', 'Full name', ''],
  ['email', 'Email', ''],
  ['phone', 'Phone', ''],
  ['location', 'Location', 'City, State'],
  ['linkedin', 'LinkedIn URL', 'https://www.linkedin.com/in/…'],
  ['github', 'GitHub URL', 'https://github.com/…'],
  ['portfolio', 'Portfolio or website', ''],
  ['workAuth', 'Work authorization', 'Authorized to work in the US'],
  ['sponsorship', 'Needs visa sponsorship?', 'No'],
  ['salary', 'Salary expectation', ''],
  ['start', 'Start date or notice period', 'Two weeks'],
  ['heard', 'How did you hear about us?', 'Company careers page'],
];

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback; // private window, blocked storage or corrupt data
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadEntries = () => load(TRACKER_KEY, {});
export const saveEntries = (entries) => save(TRACKER_KEY, entries);
export const loadKit = () => load(KIT_KEY, { fields: {}, extra: '' });
export const saveKit = (kit) => save(KIT_KEY, kit);
export const loadPrefs = () => ({ hideDone: true, ...load(PREFS_KEY, {}) });
export const savePrefs = (prefs) => save(PREFS_KEY, prefs);

/** The apply kit as [label, value] pairs to copy: filled fields, then each "other answer" block. */
export function kitItems(kit) {
  const fields = KIT_FIELDS.map(([key, label]) => [label, (kit.fields?.[key] ?? '').trim()]).filter(([, v]) => v);
  const extra = (kit.extra ?? '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
    .map((b, i) => [`Saved answer ${i + 1}`, b]);
  return [...fields, ...extra];
}

export function isoToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoToday(d);
}

/** What's kept about a posting, so a saved one still shows after it closes and leaves the data. */
const snapshot = (job) => ({
  title: job.title, company: job.company, location: job.location ?? '', url: job.url, applyUrl: job.applyUrl,
});

/** A new entries object with `job` set to `status` (saved | applied | hidden), or removed if status is null. */
export function setStatus(entries, job, status, today = isoToday()) {
  const { [job.id]: prev, ...rest } = entries;
  if (!status) return rest;
  const entry = { ...prev, status, job: prev?.job ?? snapshot(job), updated: today };
  if (status === 'saved') entry.saved = prev?.saved ?? today;
  if (status === 'applied') {
    entry.applied = prev?.applied ?? today;
    entry.followUp = prev?.followUp ?? addDays(entry.applied, FOLLOW_UP_DAYS);
  }
  return { ...rest, [job.id]: entry };
}

/** Push the follow-up date back after you've followed up. */
export function followedUp(entries, id, today = isoToday()) {
  const e = entries[id];
  return e ? { ...entries, [id]: { ...e, followUp: addDays(today, FOLLOW_UP_DAYS), followedUp: today } } : entries;
}

export const followUpDue = (entry, today = isoToday()) => entry?.status === 'applied' && !!entry.followUp && entry.followUp <= today;

export function counts(entries, today = isoToday()) {
  const c = { saved: 0, applied: 0, hidden: 0, due: 0 };
  for (const e of Object.values(entries)) {
    if (e.status in c) c[e.status] += 1;
    if (followUpDue(e, today)) c.due += 1;
  }
  return c;
}

/** Entries with `status`, newest activity first, as [id, entry]. */
export function entriesWith(entries, status) {
  return Object.entries(entries).filter(([, e]) => e.status === status)
    .sort((a, b) => (b[1].applied ?? b[1].updated ?? '').localeCompare(a[1].applied ?? a[1].updated ?? ''));
}

const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

export function toCSV(entries) {
  const head = ['status', 'company', 'title', 'location', 'saved', 'applied', 'follow_up', 'url', 'id'];
  const rows = Object.entries(entries).map(([id, e]) => [e.status, e.job.company, e.job.title, e.job.location,
    e.saved, e.applied, e.followUp, e.job.applyUrl ?? e.job.url, id]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Saved postings in the format `apply/jobprep.py batch` reads. */
export function prepBatch(jobs, textById, today = isoToday()) {
  return {
    format: 'jobglobal-prep-batch',
    version: 1,
    created: today,
    postings: jobs.map((j) => ({
      id: j.id, company: j.company, title: j.title, url: j.url, applyUrl: j.applyUrl ?? j.url,
      text: postingForPrep(j, textById[j.id] ?? ''),
    })),
  };
}

/** Restore from a backup made by exportBackup(); returns null if the file isn't one. */
export function parseBackup(text) {
  try {
    const data = JSON.parse(text);
    if (data?.format !== 'jobglobal-tracker-backup' || typeof data.entries !== 'object') return null;
    return { entries: data.entries, kit: data.kit ?? null };
  } catch {
    return null;
  }
}

export const exportBackup = (entries, kit, today = isoToday()) => ({
  format: 'jobglobal-tracker-backup', version: 1, created: today, entries, kit,
});

// ---------------------------------------------------------------------------
// The Job Application Autofill extension (extension/ in this repo) keeps its own history of
// applications, with descriptions. These keep the two in step.

/**
 * The extension's key for a job (appKey in extension/src/core/applications.ts; keep them the
 * same): a Greenhouse job id wherever the form is shown, a Lever posting id, a Workday job path without its
 * application steps, otherwise host and path.
 */
export function applicationKey(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return String(raw ?? '').trim();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const gh = /(^|\.)greenhouse\.io$/.test(host);
  const ghPath = gh && u.pathname.match(/^\/[\w-]+\/jobs\/(\d+)/);
  if (ghPath) return `greenhouse:${ghPath[1]}`;
  const ghParam = u.searchParams.get('gh_jid') ?? (gh ? u.searchParams.get('token') : null);
  if (ghParam && /^\d+$/.test(ghParam)) return `greenhouse:${ghParam}`;
  const lever = /^jobs\.(eu\.)?lever\.co$/.test(host) && u.pathname.match(/^\/[^/]+\/([0-9a-f-]{36})/i);
  if (lever) return `lever:${lever[1].toLowerCase()}`;
  if (/(^|\.)(myworkdayjobs|myworkdaysite|myworkday)\.com$/.test(host)) {
    const path = u.pathname
      .replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '')
      .replace(/\/(apply|login|autofillWithResume|applyManually|useMyLastApplication)(\/.*)?$/i, '')
      .replace(/\/+$/, '');
    return `workday:${host}${path}`;
  }
  return `${host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Mark postings applied that the extension recorded as applied (or further along). Matches by the
 * posting id the site sent, else by job key. Never changes a posting already marked applied.
 * Returns the new entries and how many changed.
 */
export function mergeApplied(entries, records, jobs) {
  const byKey = new Map();
  for (const j of jobs) {
    for (const u of [j.applyUrl, j.url]) if (u) byKey.set(applicationKey(u), j);
  }
  let next = entries;
  let added = 0;
  for (const r of records ?? []) {
    if (!r || typeof r !== 'object') continue;
    const job = jobs.find((j) => j.id === r.siteJobId) ?? byKey.get(r.key) ?? byKey.get(applicationKey(r.url));
    const id = job?.id ?? r.siteJobId;
    if (!id || next[id]?.status === 'applied') continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.applied) ? r.applied : isoToday();
    next = setStatus(next, job ?? { id, title: String(r.title ?? ''), company: String(r.company ?? ''), location: String(r.location ?? ''), url: r.url, applyUrl: r.url }, 'applied', date);
    added += 1;
  }
  return { entries: next, added };
}
