// Content script for the Career Hotspot Globe job site. It connects the site and the extension
// through window.postMessage, since the site's CSP keeps it from talking to anything else:
//   site → extension: "apply-queue" (open these jobs and fill them), "applied" / "unapplied"
//                     (you changed a job's status on the site), "hello" (send me your list)
//   extension → site: "applications" (jobs applied to, so the site can mark them), "queued"
// Messages from the page are untrusted input: only plain strings are read from them.

import { appKey, type Applications, type JobInfo, markApplied, removeApp, sortedApps } from '../core/applications';
import { changeApps, isAppsChange, loadApps } from '../core/storage';

const FROM_SITE = 'jobglobal';
const FROM_EXT = 'job-autofill';

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

function jobFrom(raw: unknown): (JobInfo & { applyUrl: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = str(r.url, 2000);
  const applyUrl = str(r.applyUrl, 2000) || url;
  if (!/^https:\/\//.test(applyUrl)) return null;
  return {
    url: url || applyUrl, applyUrl, title: str(r.title), company: str(r.company), location: str(r.location),
    description: str(r.description, 30_000), siteJobId: str(r.id), site: str(r.source) || 'Job site',
  };
}

const post = (data: Record<string, unknown>) => window.postMessage({ source: FROM_EXT, ...data }, location.origin);

// localhost matches any local server you run, so nothing is sent or done until the page has
// said hello and looks like the job site (it has the My applications panel).
let connected = false;

function sendApplications(apps: Applications): void {
  if (!connected) return;
  post({
    type: 'applications',
    // Opened or filled but not submitted yet, so the apply queue doesn't open them again.
    inProgress: sortedApps(apps).filter((a) => a.status === 'started').map((a) => a.key),
    applications: sortedApps(apps).filter((a) => a.status !== 'started').map((a) => ({
      key: a.key, siteJobId: a.siteJobId, url: a.url, title: a.title, company: a.company, location: a.location,
      status: a.status, applied: a.applied.slice(0, 10),
    })),
  });
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const msg = e.data as { source?: string; type?: string; jobs?: unknown; job?: unknown; date?: unknown };
  if (msg?.source !== FROM_SITE) return;
  if (msg.type === 'hello' && document.getElementById('my-apps')) connected = true;
  if (!connected) return;
  if (msg.type === 'hello') void loadApps().then(sendApplications);
  if (msg.type === 'apply-queue' && Array.isArray(msg.jobs)) {
    const jobs = msg.jobs.map(jobFrom).filter((j): j is NonNullable<ReturnType<typeof jobFrom>> => !!j);
    chrome.runtime.sendMessage({ type: 'queue', jobs })
      .then((res: unknown) => post({ type: 'queued', ...(res as object) }))
      .catch((err: Error) => post({ type: 'queued', error: err.message }));
  }
  if (msg.type === 'applied') {
    const job = jobFrom(msg.job);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(str(msg.date)) ? `${str(msg.date)}T12:00:00.000Z` : undefined;
    // Keyed by the application address, the same one a queued tab or the Fill button records.
    if (job) void changeApps((apps) => markApplied(apps, { ...job, url: job.applyUrl }, date));
  }
  if (msg.type === 'unapplied') {
    const job = jobFrom(msg.job);
    if (!job) return;
    void changeApps((apps) => {
      const app = apps[appKey(job.applyUrl)];
      // Undo only a record the site created and you haven't added notes to.
      return app && !app.notes && app.status === 'applied' ? removeApp(apps, app.key) : apps;
    });
  }
  if (msg.type === 'open-applications') void chrome.runtime.sendMessage({ type: 'open-applications' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && isAppsChange(changes)) void loadApps().then(sendApplications);
});

// Lets the site show its extension buttons. Set before the site's own scripts run.
document.documentElement.dataset.jobAutofill = chrome.runtime.getManifest().version;
