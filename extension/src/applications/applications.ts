import {
  type Application, type Applications, type AppStatus, exportApps, followedUp, followUpDate, followUpDue, mergeApps,
  parseApps, removeApp, setAppStatus, sortedApps, STATUS_LABEL, toCSV, updateApp,
} from '../core/applications';
import { loadSettings, saveSettings } from '../core/settings';
import { changeApps, isAppsChange, loadApps } from '../core/storage';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

let apps: Applications = {};

function card(a: Application): string {
  const url = safeUrl(a.url);
  const options = (Object.keys(STATUS_LABEL) as AppStatus[])
    .map((s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
  const dates = [a.applied ? `Applied ${day(a.applied)}` : `Started ${day(a.started)}`, a.site].filter(Boolean).join(' · ');
  const follow = followUpDate(a);
  const due = followUpDue(a);
  const followLine = follow
    ? `<div class="app-follow${due ? ' due' : ''}">${due ? 'Follow-up due' : 'Follow up'} ${esc(day(`${follow}T12:00:00`))}${a.followedUp ? ` · last followed up ${esc(day(`${a.followedUp}T12:00:00`))}` : ''}
        ${due ? '<button type="button" class="linklike" data-followed>I followed up</button>' : ''}</div>`
    : '';
  return `<article class="app status-${a.status}" data-key="${esc(a.key)}">
    <div class="app-head">
      <div>
        <h2 class="app-title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(a.title || 'Untitled job')}</a>` : esc(a.title || 'Untitled job')}</h2>
        <div class="app-meta">${esc([a.company, a.location].filter(Boolean).join(' · ') || 'Company not recorded')}</div>
        <div class="app-dates">${esc(dates)}</div>
        ${followLine}
      </div>
      <div class="app-side">
        ${a.status === 'started' ? '<button type="button" class="btn primary" data-applied>Mark applied</button>' : ''}
        <label class="small">Status <select data-status>${options}</select></label>
      </div>
    </div>
    <details${a.description ? '' : ' hidden'}><summary>Job description</summary><div class="desc">${esc(a.description)}</div></details>
    <label class="small">Notes<textarea data-notes rows="2" placeholder="Recruiter, interview dates, referral…">${esc(a.notes)}</textarea></label>
    <div class="app-actions"><button type="button" class="linklike" data-remove>Remove</button></div>
  </article>`;
}

function render(): void {
  const q = $<HTMLInputElement>('#q').value.trim().toLowerCase();
  const status = $<HTMLSelectElement>('#status').value;
  const all = sortedApps(apps);
  const shown = all.filter((a) => (!status || (status === 'due' ? followUpDue(a) : a.status === status))
    && (!q || `${a.company} ${a.title} ${a.location} ${a.description} ${a.notes}`.toLowerCase().includes(q)));
  const count = (s: AppStatus) => all.filter((a) => a.status === s).length;
  $('#summary').textContent = all.length
    ? `${all.length} job${all.length === 1 ? '' : 's'}: ${(Object.keys(STATUS_LABEL) as AppStatus[]).filter(count).map((s) => `${count(s)} ${STATUS_LABEL[s].toLowerCase()}`).join(', ')}`
    : '';
  $('#list').innerHTML = shown.length ? shown.map(card).join('')
    : `<p class="empty">${all.length ? 'Nothing matches.' : 'No applications yet. Fill a Greenhouse or Workday application, or mark a job applied on the job site, and it shows up here.'}</p>`;
}

async function change(fn: (a: Applications) => Applications): Promise<void> {
  apps = await changeApps(fn);
  render();
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function wire(): void {
  $('#status').insertAdjacentHTML('beforeend', '<option value="due">Follow-up due</option>' + (Object.keys(STATUS_LABEL) as AppStatus[])
    .map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join(''));
  if (location.hash === '#due') $<HTMLSelectElement>('#status').value = 'due';
  $('#q').addEventListener('input', render);
  $('#status').addEventListener('change', render);

  const list = $('#list');
  const keyOf = (el: Element) => el.closest<HTMLElement>('.app')!.dataset.key!;
  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-applied]')) void change((a) => setAppStatus(a, keyOf(t), 'applied'));
    if (t.closest('[data-followed]')) void change((a) => followedUp(a, keyOf(t)));
    if (t.closest('[data-remove]') && confirm('Remove this job from your application history?')) void change((a) => removeApp(a, keyOf(t)));
  });
  list.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('[data-status]')) void change((a) => setAppStatus(a, keyOf(t), (t as HTMLSelectElement).value as AppStatus));
    // Notes save when you leave the box; re-rendering while typing would lose the cursor.
    if (t.matches('[data-notes]')) void changeApps((a) => updateApp(a, keyOf(t), { notes: (t as HTMLTextAreaElement).value })).then((next) => { apps = next; });
  });

  const stamp = () => new Date().toISOString().slice(0, 10);
  $('#export-csv').addEventListener('click', () => download(`applications-${stamp()}.csv`, toCSV(apps), 'text/csv'));
  $('#export-json').addEventListener('click', () => {
    download(`applications-backup-${stamp()}.json`, JSON.stringify(exportApps(apps), null, 1), 'application/json');
    void saveSettings((s) => ({ ...s, lastBackup: new Date().toISOString() })).then(showBackup);
  });
  $<HTMLInputElement>('#import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const msg = $('#msg');
    try {
      const incoming = parseApps(await file.text());
      await change((a) => mergeApps(a, incoming));
      msg.className = 'small ok';
      msg.textContent = `Restored ${Object.keys(incoming).length} jobs from ${file.name} (merged with what was here).`;
    } catch (err) {
      msg.className = 'small error';
      msg.textContent = (err as Error).message;
    }
  });

  // Keep up with applications recorded in other tabs, unless you're typing a note.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !isAppsChange(changes)) return;
    void loadApps().then((next) => {
      apps = next;
      if (!(document.activeElement as HTMLElement | null)?.matches('[data-notes], #q')) render();
    });
  });
}

/** When you last backed up, and a nudge when it's been a while and automatic backup is off. */
async function showBackup(): Promise<void> {
  const s = await loadSettings();
  const days = s.lastBackup ? Math.floor((Date.now() - Date.parse(s.lastBackup)) / 86_400_000) : null;
  const el = $('#backup-note');
  const stale = Object.keys(apps).length > 0 && !s.autoBackup && (days === null || days >= 14);
  el.className = `small ${stale ? 'warn' : 'muted'}`;
  el.textContent = (days === null ? 'Never backed up.' : `Last backup ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`)
    + (s.autoBackup ? ' Automatic weekly backup is on.' : stale ? ' This list lives only in this browser: click Back up, or turn on automatic backup on the profile page.' : '');
}

async function init(): Promise<void> {
  apps = await loadApps();
  wire();
  render();
  void showBackup();
}

void init();
