// Content script for Greenhouse and Workday pages (and frames). It:
//  - fills the form when you click Fill in the popup (the popup calls __jobAutofill),
//  - records the job in your application history when you fill it or mark it applied,
//  - marks it applied when the page confirms your submission,
//  - fills by itself in tabs opened from the job site's apply queue, step by step on Workday.
// It is declared in the manifest for those sites and also injected by the popup, so it guards
// against running twice in one frame.

import { appKey, type JobInfo, markApplied, recordJob, updateApp } from '../core/applications';
import { pickResume, type ResumeEntry } from '../core/resumes';
import { changeApps, loadApps, loadProfile, loadResumes } from '../core/storage';
import type { Profile } from '../core/profile';
import { type FillOptions, fillDraft, fillPage, openQuestions, siteOf } from './engine';
import { isConfirmation, isSubmitButton, jobInfo } from './jobinfo';

type Global = typeof globalThis & {
  __jobAutofillLoaded?: boolean;
  __jobAutofill?: () => Promise<unknown>;
  __jobMarkApplied?: () => Promise<unknown>;
  __jobDraft?: () => Promise<unknown>;
};
const g = globalThis as Global;
const SUBMIT_WINDOW_MS = 15 * 60 * 1000;

// Looked up once per address: on Workday it's a request to Workday's job JSON.
const infoByUrl = new Map<string, Promise<JobInfo | null>>();
const info = (): Promise<JobInfo | null> => {
  if (!infoByUrl.has(location.href)) infoByUrl.set(location.href, jobInfo(document));
  return infoByUrl.get(location.href)!;
};

async function fill(options: FillOptions = {}, data?: Promise<[Profile, ResumeEntry[]]>) {
  const [profile, resumes] = await (data ?? Promise.all([loadProfile(), loadResumes()]));
  // The resume tied to words in this job's title, else your newest general one.
  const resume = pickResume(resumes, (await info())?.title);
  const report = await fillPage(document, profile, resume, options);
  if (report && resume && report.resume === 'attached') report.resumeName = resume.label || resume.name;
  if (report?.fields) {
    const job = await info();
    if (job) await changeApps((apps) => recordJob(apps, job));
  }
  return report;
}

/** Ask Claude (through the service worker) to draft the open questions, and fill in the drafts. */
async function draftThisPage() {
  const job = await info();
  if (!job) return null;
  const fields = openQuestions(document, await loadProfile());
  if (!fields.length) return { drafted: [], open: 0 };
  const questions = fields.map((f, i) => ({ id: String(i), question: f.label.slice(0, 500) }));
  const res = await chrome.runtime.sendMessage({ type: 'draft', job, questions }) as { answers?: Record<string, string>; error?: string };
  if (res?.error || !res?.answers) return { error: res?.error ?? 'No reply from the extension.', drafted: [], open: fields.length };
  const drafted: string[] = [];
  fields.forEach((f, i) => {
    const answer = res.answers![String(i)];
    if (answer && !(f.el as HTMLInputElement).value.trim()) {
      fillDraft(f, answer);
      drafted.push(f.label.slice(0, 80));
    }
  });
  return { drafted, open: fields.length };
}

async function markThisApplied() {
  const job = await info();
  if (!job) return null;
  await changeApps((apps) => markApplied(apps, job));
  chrome.runtime.sendMessage({ type: 'applied-tab' }).catch(() => {});
  return { site: job.site, title: job.title, company: job.company };
}

/** Remember a Submit click, then mark the job applied once the page confirms it. */
function watchForSubmission(): void {
  let done = false;
  const check = async () => {
    if (done || !isConfirmation(document, true)) return; // cheap check before reading storage
    const key = appKey((await info())?.url ?? location.href);
    const app = (await loadApps())[key];
    const recent = !!app?.submittedAt && Date.now() - Date.parse(app.submittedAt) < SUBMIT_WINDOW_MS;
    if (!isConfirmation(document, recent) || done) return;
    done = true;
    await markThisApplied();
  };
  document.addEventListener('click', (e) => {
    const button = (e.target as Element | null)?.closest('button, input[type="submit"], [role="button"]');
    if (!button || !isSubmitButton(button)) return;
    void (async () => {
      const job = await info();
      if (!job) return;
      const now = new Date().toISOString();
      await changeApps((apps) => updateApp(recordJob(apps, job, now), appKey(job.url), { submittedAt: now }, now));
    })();
  }, true);
  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void check(), 800);
  }).observe(document.documentElement, { childList: true, subtree: true });
  void check();
}

/** In a tab opened from the apply queue, fill now and again whenever a new step's fields appear. */
async function autofillIfQueued(): Promise<void> {
  const job = await info();
  // The tab was queued for this job; if you've since gone to another job in it, leave that alone.
  const queued = job && await chrome.runtime.sendMessage({ type: 'autofill?', key: appKey(job.url) }).catch(() => false);
  if (!queued) return;
  const options: FillOptions = { tried: new WeakSet<Element>(), attachResume: true };
  const data = Promise.all([loadProfile(), loadResumes()]); // read once, not on every page change
  let running = false;
  let timer = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const report = await fill(options, data);
      if (report?.resume === 'attached') options.attachResume = false;
    } finally {
      running = false;
    }
  };
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 1000);
  }).observe(document.documentElement, { childList: true, subtree: true });
  void run();
}

if (!g.__jobAutofillLoaded && siteOf(location.hostname)) {
  g.__jobAutofillLoaded = true;
  g.__jobAutofill = () => fill();  // the popup's Fill button
  g.__jobMarkApplied = markThisApplied;
  g.__jobDraft = draftThisPage;
  watchForSubmission();
  void autofillIfQueued();
} else if (!siteOf(location.hostname)) {
  // A company page around an embedded form: nothing to do in this frame.
  g.__jobAutofill = async () => null;
  g.__jobMarkApplied = async () => null;
  g.__jobDraft = async () => null;
}
