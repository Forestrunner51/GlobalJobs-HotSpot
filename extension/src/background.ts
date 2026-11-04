// Service worker. It:
//  - opens the job site's apply queue in tabs (within your limits) and remembers which tabs to
//    fill by themselves (content scripts can't open tabs or see their own tab id),
//  - drafts answers with Claude when you ask (draft.ts),
//  - shows how many follow-ups are due on the toolbar icon,
//  - backs up your application history to Downloads every week, if you turned that on.

import {
  appKey, applyLimits, dueCount, exportApps, type JobInfo, recordJob,
} from './core/applications';
import { loadSettings, saveSettings } from './core/settings';
import { changeApps, isAppsChange, loadApps, loadProfile } from './core/storage';
import { type DraftQuestion, draftAnswers, draftError } from './draft';

const QUEUE_KEY = 'queuedTabs'; // in storage.session, so it survives the worker restarting
export const MAX_QUEUE = 10;

type Queued = Record<string, string>; // tab id → the job key it was opened for

async function queuedTabs(): Promise<Queued> {
  return ((await chrome.storage.session.get(QUEUE_KEY))[QUEUE_KEY] as Queued | undefined) ?? {};
}

// Serialized, so tabs opening in quick succession don't overwrite each other's entries.
let pending: Promise<unknown> = Promise.resolve();
function setQueued(change: (q: Queued) => Queued): Promise<void> {
  const next = pending.then(async () => chrome.storage.session.set({ [QUEUE_KEY]: change(await queuedTabs()) }));
  pending = next.catch(() => {});
  return next;
}

const without = (q: Queued, tabId: number): Queued => {
  const { [String(tabId)]: _gone, ...rest } = q;
  return rest;
};

const isHttps = (url: unknown): url is string => {
  try {
    return typeof url === 'string' && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

async function openQueue(jobs: Array<JobInfo & { applyUrl?: string }>) {
  // Keyed by the address the tab opens, so the form page finds the record.
  const usable = jobs.filter((j) => isHttps(j.applyUrl ?? j.url)).map((j) => ({ ...j, url: j.applyUrl ?? j.url }));
  const [apps, settings] = await Promise.all([loadApps(), loadSettings()]);
  const { allowed, skipped } = applyLimits(apps, usable, settings.limits);
  const opening = allowed.slice(0, MAX_QUEUE);
  await changeApps((current) => opening.reduce((acc, j) => recordJob(acc, j), current));
  for (const [i, job] of opening.entries()) {
    const tab = await chrome.tabs.create({ url: job.url, active: i === 0 });
    if (tab.id !== undefined) await setQueued((q) => ({ ...q, [String(tab.id)]: appKey(job.url) }));
  }
  return {
    opened: opening.length,
    skipped: skipped.map(({ job, reason }) => `${job.title ?? 'A job'} at ${job.company ?? '?'}: ${reason}`),
  };
}

async function draft(job: JobInfo, questions: DraftQuestion[]) {
  const [settings, profile] = await Promise.all([loadSettings(), loadProfile()]);
  if (!settings.claudeKey) return { error: 'Add your Anthropic API key on the profile page to draft answers.' };
  if (!questions.length) return { answers: {} };
  try {
    return { answers: await draftAnswers(settings.claudeKey, profile, job, questions.slice(0, 20)) };
  } catch (e) {
    return { error: draftError(e) };
  }
}

// ---------------------------------------------------------------- follow-up badge

async function updateBadge(): Promise<void> {
  const n = dueCount(await loadApps());
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#9a6700' });
  await chrome.action.setTitle({ title: n ? `Job Application Autofill: ${n} follow-up${n === 1 ? '' : 's'} due` : 'Job Application Autofill' });
}

// ---------------------------------------------------------------- weekly backup (opt-in)

async function backupIfDue(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.autoBackup || !(await chrome.permissions.contains({ permissions: ['downloads'] }))) return;
  const last = settings.lastBackup ? Date.parse(settings.lastBackup) : 0;
  if (Date.now() - last < settings.backupEveryDays * 86_400_000) return;
  const apps = await loadApps();
  if (!Object.keys(apps).length) return;
  // No blob URLs in a service worker; a data URL holds the JSON instead.
  const bytes = new TextEncoder().encode(JSON.stringify(exportApps(apps), null, 1));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const day = new Date().toISOString().slice(0, 10);
  await chrome.downloads.download({
    url: `data:application/json;base64,${btoa(binary)}`,
    filename: `job-autofill-backups/applications-${day}.json`,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  await saveSettings((s) => ({ ...s, lastBackup: new Date().toISOString() }));
}

// ---------------------------------------------------------------- wiring

chrome.runtime.onMessage.addListener((msg: { type?: string; jobs?: unknown; key?: unknown; job?: unknown; questions?: unknown }, sender, reply) => {
  const tabId = sender.tab?.id;
  if (msg?.type === 'queue' && Array.isArray(msg.jobs)) {
    openQueue(msg.jobs as JobInfo[]).then(reply, (e: Error) => reply({ error: e.message }));
    return true;
  }
  if (msg?.type === 'autofill?') {
    queuedTabs().then((q) => reply(tabId !== undefined && q[String(tabId)] === msg.key));
    return true;
  }
  if (msg?.type === 'draft' && msg.job && Array.isArray(msg.questions)) {
    draft(msg.job as JobInfo, msg.questions as DraftQuestion[]).then(reply);
    return true;
  }
  if (msg?.type === 'applied-tab' && tabId !== undefined) void setQueued((q) => without(q, tabId));
  if (msg?.type === 'open-applications') void chrome.tabs.create({ url: chrome.runtime.getURL('applications/applications.html') });
  if (msg?.type === 'backup-now') void backupIfDue();
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => void setQueued((q) => without(q, tabId)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && isAppsChange(changes)) void updateBadge();
});
// Hourly: follow-ups come due as days pass, and the backup checks whether a week has gone by.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'hourly') return;
  void updateBadge();
  void backupIfDue();
});
const start = () => {
  void chrome.alarms.create('hourly', { periodInMinutes: 60 });
  void updateBadge();
};
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
