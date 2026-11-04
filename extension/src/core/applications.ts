// Your application history: every job you started or submitted through the extension or marked
// applied on the job site, with its description. Pure (no chrome.* or DOM), so it's unit tested.

export type AppStatus = 'started' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn';

export const STATUS_LABEL: Record<AppStatus, string> = {
  started: 'In progress', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer',
  rejected: 'Rejected', withdrawn: 'Withdrawn',
};

// Filling a form again never moves an application back to "In progress".
const RANK: Record<AppStatus, number> = { started: 0, applied: 1, interviewing: 2, offer: 3, rejected: 3, withdrawn: 3 };

export interface Application {
  key: string; // which job this is, from appKey()
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  site: string; // Greenhouse, Workday, or where the job site found it
  status: AppStatus;
  started: string; // ISO timestamps
  applied: string;
  updated: string;
  submittedAt: string; // when a Submit button was clicked, to confirm the "thank you" page that follows
  notes: string;
  siteJobId: string; // the posting's id on the job site, when it came from there
  followUp: string; // YYYY-MM-DD; empty means FOLLOW_UP_DAYS after applying
  followedUp: string; // YYYY-MM-DD you last followed up
}

export type Applications = Record<string, Application>;

/** What's known about a job from its page or the job site. */
export interface JobInfo {
  url: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  site?: string;
  siteJobId?: string;
}

export const MAX_DESCRIPTION = 30_000;

/**
 * One key per job however you reached it: Greenhouse's job id is the same on its own board,
 * in a company's embedded form (?gh_jid=, &token=) and on the confirmation page; Lever's posting
 * id is the same on the posting, …/apply and …/thanks; Workday's job
 * path is the same on the posting, every application step and the "submitted" page.
 */
export function appKey(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const ghPath = /(^|\.)greenhouse\.io$/.test(host) && u.pathname.match(/^\/[\w-]+\/jobs\/(\d+)/);
  if (ghPath) return `greenhouse:${ghPath[1]}`;
  const ghParam = u.searchParams.get('gh_jid') ?? (/(^|\.)greenhouse\.io$/.test(host) ? u.searchParams.get('token') : null);
  if (ghParam && /^\d+$/.test(ghParam)) return `greenhouse:${ghParam}`;
  const lever = /^jobs\.(eu\.)?lever\.co$/.test(host) && u.pathname.match(/^\/[^/]+\/([0-9a-f-]{36})/i);
  if (lever) return `lever:${lever[1].toLowerCase()}`;
  if (/(^|\.)(myworkdayjobs|myworkdaysite|myworkday)\.com$/.test(host)) {
    const path = u.pathname
      .replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '') // locale prefix
      .replace(/\/(apply|login|autofillWithResume|applyManually|useMyLastApplication)(\/.*)?$/i, '')
      .replace(/\/+$/, '');
    return `workday:${host}${path}`;
  }
  return `${host}${u.pathname.replace(/\/+$/, '')}`;
}

const text = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function blank(key: string, now: string): Application {
  return {
    key, company: '', title: '', location: '', url: '', description: '', site: '', status: 'started',
    started: now, applied: '', updated: now, submittedAt: '', notes: '', siteJobId: '', followUp: '', followedUp: '',
  };
}

/** Add what's newly known about a job, keeping what's already recorded unless it was empty. */
export function recordJob(apps: Applications, info: JobInfo, now = new Date().toISOString()): Applications {
  const key = appKey(info.url);
  const prev = apps[key] ?? blank(key, now);
  const next: Application = { ...prev };
  next.url ||= text(info.url, 2000);
  next.title ||= text(info.title);
  next.company ||= text(info.company);
  next.location ||= text(info.location);
  next.site ||= text(info.site);
  next.siteJobId ||= text(info.siteJobId);
  const desc = text(info.description, MAX_DESCRIPTION);
  if (desc.length > next.description.length) next.description = desc;
  if (JSON.stringify(next) === JSON.stringify(apps[key])) return apps;
  next.updated = now;
  return { ...apps, [key]: next };
}

export function setAppStatus(apps: Applications, key: string, status: AppStatus, now = new Date().toISOString()): Applications {
  const prev = apps[key];
  if (!prev || prev.status === status) return apps;
  const next = { ...prev, status, updated: now };
  if (status !== 'started' && !next.applied) next.applied = now;
  if (status === 'started') next.applied = '';
  return { ...apps, [key]: next };
}

/** Mark a job applied, recording it first if needed. Never moves a later status (interviewing…) back. */
export function markApplied(apps: Applications, info: JobInfo, at = new Date().toISOString()): Applications {
  const recorded = recordJob(apps, info, at);
  const key = appKey(info.url);
  return RANK[recorded[key].status] >= RANK.applied ? recorded : setAppStatus(recorded, key, 'applied', at);
}

export function updateApp(apps: Applications, key: string, patch: Partial<Pick<Application, 'notes' | 'applied' | 'submittedAt'>>, now = new Date().toISOString()): Applications {
  const prev = apps[key];
  return prev ? { ...apps, [key]: { ...prev, ...patch, updated: now } } : apps;
}

export function removeApp(apps: Applications, key: string): Applications {
  const { [key]: _gone, ...rest } = apps;
  return rest;
}

/** Newest activity first. */
export const sortedApps = (apps: Applications): Application[] =>
  Object.values(apps).sort((a, b) => (b.applied || b.started).localeCompare(a.applied || a.started));

// ---------------------------------------------------------------- export / import

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCSV(apps: Applications): string {
  const head = ['status', 'company', 'title', 'location', 'applied', 'started', 'url', 'notes', 'description'];
  const rows = sortedApps(apps).map((a) => [STATUS_LABEL[a.status], a.company, a.title, a.location,
    a.applied.slice(0, 10), a.started.slice(0, 10), a.url, a.notes, a.description]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export const APPS_FORMAT = 'job-autofill-applications';

export const exportApps = (apps: Applications, now = new Date()) =>
  ({ format: APPS_FORMAT, version: 1, exportedAt: now.toISOString(), applications: sortedApps(apps) });

/** Read an exported file, keeping only well-formed entries. Throws with a user-facing message. */
export function parseApps(raw: string): Applications {
  let data: { format?: string; applications?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (data?.format !== APPS_FORMAT || !Array.isArray(data.applications)) {
    throw new Error("That file isn't an applications export from this extension.");
  }
  const out: Applications = {};
  for (const item of data.applications) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const url = text(r.url, 2000);
    if (!url) continue;
    const key = appKey(url);
    const status = (Object.keys(RANK) as AppStatus[]).includes(r.status as AppStatus) ? (r.status as AppStatus) : 'applied';
    out[key] = {
      ...blank(key, text(r.started, 40) || new Date().toISOString()),
      company: text(r.company), title: text(r.title), location: text(r.location), url,
      description: text(r.description, MAX_DESCRIPTION), site: text(r.site), status,
      applied: text(r.applied, 40), updated: text(r.updated, 40), notes: text(r.notes, 5000), siteJobId: text(r.siteJobId),
      followUp: text(r.followUp, 10), followedUp: text(r.followedUp, 10),
    };
  }
  return out;
}

/** Merge an import into what's here: imported entries fill gaps, and the later status wins. */
export function mergeApps(here: Applications, incoming: Applications): Applications {
  const out = { ...here };
  for (const [key, inc] of Object.entries(incoming)) {
    const cur = out[key];
    if (!cur) { out[key] = inc; continue; }
    const merged = recordJob({ [key]: cur }, inc, cur.updated)[key];
    out[key] = RANK[inc.status] > RANK[cur.status]
      ? { ...merged, status: inc.status, applied: cur.applied || inc.applied }
      : merged;
    if (!out[key].notes && inc.notes) out[key] = { ...out[key], notes: inc.notes };
  }
  return out;
}

// ---------------------------------------------------------------- follow-ups

export const FOLLOW_UP_DAYS = 6; // same as FOLLOW_UP_DAYS on the job site and in apply/jobprep.py

/** Today (or `d`) as YYYY-MM-DD in local time. */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/** When to follow up on an application still waiting for a reply, or '' once it has moved on. */
export function followUpDate(a: Application): string {
  if (a.status !== 'applied' || !a.applied) return '';
  return a.followUp || addDays(localDay(new Date(a.applied)), FOLLOW_UP_DAYS);
}

export const followUpDue = (a: Application, today = localDay()): boolean => {
  const due = followUpDate(a);
  return !!due && due <= today;
};

export const dueCount = (apps: Applications, today = localDay()): number =>
  Object.values(apps).filter((a) => followUpDue(a, today)).length;

/** You followed up today: the next reminder comes FOLLOW_UP_DAYS later. */
export function followedUp(apps: Applications, key: string, today = localDay()): Applications {
  const prev = apps[key];
  return prev ? { ...apps, [key]: { ...prev, followedUp: today, followUp: addDays(today, FOLLOW_UP_DAYS), updated: new Date().toISOString() } } : apps;
}

// ---------------------------------------------------------------- apply queue limits

export interface QueueLimits {
  perDay: number; // new applications opened per day, 0 for no limit
  perCompany: number; // per company within `companyDays`, 0 for no limit
  companyDays: number;
}

export const DEFAULT_LIMITS: QueueLimits = { perDay: 15, perCompany: 3, companyDays: 30 };

const sameCompany = (a: string, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which queued jobs to open. Jobs already in the history don't count again. Over the daily
 * limit, or the per-company limit (counting applications started in the last `companyDays`),
 * a job is skipped with the reason.
 */
export function applyLimits<T extends JobInfo>(apps: Applications, jobs: T[], limits: QueueLimits, now = new Date()):
  { allowed: T[]; skipped: Array<{ job: T; reason: string }> } {
  const today = localDay(now);
  const since = addDays(today, -limits.companyDays);
  const all = Object.values(apps);
  let todayCount = all.filter((a) => localDay(new Date(a.started)) === today).length;
  const allowed: T[] = [];
  const skipped: Array<{ job: T; reason: string }> = [];
  for (const job of jobs) {
    if (apps[appKey(job.url)]) { allowed.push(job); continue; }
    const company = job.company ?? '';
    const atCompany = all.filter((a) => sameCompany(a.company, company) && localDay(new Date(a.started)) >= since).length
      + allowed.filter((j) => !apps[appKey(j.url)] && sameCompany(j.company ?? '', company)).length;
    if (limits.perDay && todayCount >= limits.perDay) {
      skipped.push({ job, reason: `daily limit of ${limits.perDay} reached` });
    } else if (limits.perCompany && company && atCompany >= limits.perCompany) {
      skipped.push({ job, reason: `${limits.perCompany} applications to ${company} in ${limits.companyDays} days` });
    } else {
      allowed.push(job);
      todayCount++;
    }
  }
  return { allowed, skipped };
}
