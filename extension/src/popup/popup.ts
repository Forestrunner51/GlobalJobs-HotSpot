import { type AtsInfo, detectAts, PLANNED_PHASE, SUPPORTED } from '../core/ats';
import type { FillReport } from '../core/fields';
import { dueCount } from '../core/applications';
import { missingFields } from '../core/profile';
import { loadSettings } from '../core/settings';
import { loadApps, loadProfile, loadResumes } from '../core/storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let tab: chrome.tabs.Tab | undefined;
let ats: AtsInfo | null = null;

async function showPage(): Promise<void> {
  const status = $('page-status');
  // activeTab grants this tab's URL because the user just clicked the extension; no host permission needed.
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ats = detectAts(tab?.url);
  if (!ats) {
    status.textContent = "Not a job application page this extension recognizes (Greenhouse, Lever, Workday, Ashby, iCIMS).";
    return;
  }
  if (SUPPORTED.has(ats.id)) {
    status.textContent = `${ats.label} application.`;
    $('fill').removeAttribute('disabled');
    $('mark-applied').hidden = false;
    $('draft').hidden = !(await loadSettings()).claudeKey;
    return;
  }
  const phase = PLANNED_PHASE[ats.id];
  status.textContent = `${ats.label} application. Filling for ${ats.label} isn't built yet${phase ? ` (planned for phase ${phase})` : ''}.`;
}

async function showProfile(): Promise<void> {
  const [profile, resumes, apps] = await Promise.all([loadProfile(), loadResumes(), loadApps()]);
  const resume = resumes.length > 0;
  const due = dueCount(apps);
  $('due').hidden = !due;
  $('due').textContent = `${due} follow-up${due === 1 ? '' : 's'} due`;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  $('profile-name').textContent = name ? `${name}${profile.email ? ` · ${profile.email}` : ''}` : 'No profile yet.';
  const missing = missingFields(profile, !!resume);
  const el = $('profile-missing');
  el.className = `small ${missing.length ? 'warn' : 'ok'}`;
  el.textContent = missing.length ? `Missing: ${missing.join(', ')}` : 'Profile complete, resume attached.';
}

function showReport(lines: Array<[string, string?]>): void {
  const box = $('fill-report');
  box.replaceChildren(...lines.map(([text, cls]) => {
    const p = document.createElement('p');
    p.textContent = text;
    if (cls) p.className = cls;
    return p;
  }));
  box.hidden = false;
}

const RESUME_NOTE: Record<FillReport['resume'], [string, string?] | null> = {
  attached: ['Resume attached.', 'ok'], // replaced with the resume's name below
  present: null,
  'no-resume': ['No resume saved in your profile, so none was attached.', 'warn'],
  'no-field': null,
  failed: ["Couldn't attach your resume here. Upload it yourself.", 'warn'],
};

function describe(reports: FillReport[]): Array<[string, string?]> {
  const forms = reports.filter((r) => r.fields > 0);
  if (!forms.length) {
    return [[ats?.id === 'workday'
      ? "No application form on this page yet. Click Apply (and sign in if asked), then click Fill on each step."
      : "No application form found on this page. Open the job's application form, then click Fill again.", 'warn']];
  }
  const filled = forms.flatMap((r) => r.filled);
  const left = [...new Set(forms.flatMap((r) => r.left))];
  const lines: Array<[string, string?]> = [[filled.length
    ? `Filled ${filled.length} field${filled.length > 1 ? 's' : ''} (outlined in green).`
    : 'Nothing to fill: the fields are already filled or your profile has no answer for them.', filled.length ? 'ok' : undefined]];
  for (const r of forms) {
    const note = r.resume === 'attached' && r.resumeName ? [`Attached your resume "${r.resumeName}".`, 'ok'] as [string, string] : RESUME_NOTE[r.resume];
    if (note) lines.push(note);
  }
  if (left.length) lines.push([`Still needs you: ${left.join('; ')}`, 'warn']);
  if (forms.some((r) => r.sensitive)) lines.push(['Voluntary self-identification questions (gender, race, veteran, disability) are left for you.', 'muted']);
  lines.push([forms.some((r) => r.site === 'Workday')
    ? 'Check every field, then click Next yourself and Fill again on the next step.'
    : 'Check every field before you submit.', 'muted']);
  return lines;
}

async function fill(): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const button = $<HTMLButtonElement>('fill');
  button.disabled = true;
  showReport([['Filling…']]);
  try {
    const target = { tabId, allFrames: true };
    // Greenhouse and Workday pages already have the script; this covers a company page that
    // embeds the form (and does nothing in frames that aren't an application).
    await chrome.scripting.executeScript({ target, files: ['content/fill.js'] });
    const results = await chrome.scripting.executeScript({
      target,
      func: () => (globalThis as { __jobAutofill?: () => Promise<unknown> }).__jobAutofill?.() ?? null,
    });
    showReport(describe(results.map((r) => r.result as FillReport | null).filter((r): r is FillReport => !!r)));
  } catch (e) {
    showReport([[`Couldn't fill this page: ${(e as Error).message}`, 'warn']]);
  } finally {
    button.disabled = false;
  }
}

async function markApplied(): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['content/fill.js'] });
    const results = await chrome.scripting.executeScript({
      target,
      func: () => (globalThis as { __jobMarkApplied?: () => Promise<unknown> }).__jobMarkApplied?.() ?? null,
    });
    const job = results.map((r) => r.result as { title?: string; company?: string } | null).find(Boolean);
    showReport(job
      ? [[`Saved to My applications as applied: ${[job.title, job.company].filter(Boolean).join(' at ') || 'this job'}.`, 'ok']]
      : [["Couldn't tell which job this page is for.", 'warn']]);
  } catch (e) {
    showReport([[`Couldn't record this job: ${(e as Error).message}`, 'warn']]);
  }
}

$('fill').addEventListener('click', () => void fill());
$('mark-applied').addEventListener('click', () => void markApplied());
async function draft(): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const button = $<HTMLButtonElement>('draft');
  button.disabled = true;
  showReport([['Drafting with Claude… (this can take a minute)']]);
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['content/fill.js'] });
    const results = await chrome.scripting.executeScript({
      target,
      func: () => (globalThis as { __jobDraft?: () => Promise<unknown> }).__jobDraft?.() ?? null,
    });
    const r = results.map((x) => x.result as { drafted: string[]; open: number; error?: string } | null).find(Boolean);
    if (!r) showReport([["Couldn't find an application form on this page.", 'warn']]);
    else if (r.error) showReport([[r.error, 'warn']]);
    else if (!r.open) showReport([['No open questions left to draft: they are filled, or your saved answers cover them.']]);
    else showReport([
      [`Drafted ${r.drafted.length} of ${r.open} open question${r.open === 1 ? '' : 's'} (outlined in orange).`, 'ok'],
      ['These are drafts. Read each one and make it yours before you submit. Questions Claude had no facts for are left blank.', 'muted'],
    ]);
  } catch (e) {
    showReport([[`Couldn't draft: ${(e as Error).message}`, 'warn']]);
  } finally {
    button.disabled = false;
  }
}

const openHistory = (hash = '') => void chrome.tabs.create({ url: chrome.runtime.getURL(`applications/applications.html${hash}`) });
$('history').addEventListener('click', () => openHistory());
$('due').addEventListener('click', () => openHistory('#due'));
$('draft').addEventListener('click', () => void draft());
$('edit').addEventListener('click', () => chrome.runtime.openOptionsPage());
void showPage();
void showProfile();
