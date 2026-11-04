import {
  emptyEducation, emptyWork, exportBundle, MAX_RESUME_BYTES, normalizeProfile, parseBundle,
  type EducationEntry, type Profile, type SavedAnswer, type WorkEntry,
} from '../core/profile';
import { changedKeys, mergeResume, readResume } from '../core/resume';
import { addResume, pickResume, type ResumeEntry, useForWords } from '../core/resumes';
import { loadSettings, normalizeSettings, saveSettings, type Settings } from '../core/settings';
import { fileToResume, loadProfile, loadResumes, saveProfile, saveResumes } from '../core/storage';

type ListName = 'work' | 'education' | 'answers';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

let profile: Profile;
let resumes: ResumeEntry[] = [];
let settings: Settings;
let dirty = false;

// ---------------------------------------------------------------- rendering

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function field(label: string, name: string, value: string, type = 'text', cls = ''): string {
  return `<label class="${cls}">${label}<input type="${type}" data-field="${name}" value="${esc(value)}"></label>`;
}

function workEntry(w: WorkEntry, i: number): string {
  return `<div class="entry" data-index="${i}">
    <div class="entry-head"><span>Job ${i + 1}</span><button type="button" class="linklike" data-remove>Remove</button></div>
    <div class="grid">
      ${field('Company', 'company', w.company)}${field('Title', 'title', w.title)}
      ${field('Location', 'location', w.location)}
      <label class="check"><input type="checkbox" data-field="current"${w.current ? ' checked' : ''}> I work here now</label>
      ${field('Start', 'start', w.start, 'month')}${field('End', 'end', w.end, 'month')}
      <label class="span2">What you did<textarea data-field="description" rows="3">${esc(w.description)}</textarea></label>
    </div></div>`;
}

function educationEntry(e: EducationEntry, i: number): string {
  return `<div class="entry" data-index="${i}">
    <div class="entry-head"><span>School ${i + 1}</span><button type="button" class="linklike" data-remove>Remove</button></div>
    <div class="grid">
      ${field('School', 'school', e.school, 'text', 'span2')}${field('Degree', 'degree', e.degree)}${field('Field of study', 'field', e.field)}
      ${field('Start', 'start', e.start, 'month')}${field('End (or expected)', 'end', e.end, 'month')}
    </div></div>`;
}

function answerEntry(a: SavedAnswer, i: number): string {
  return `<div class="entry" data-index="${i}">
    <div class="entry-head"><span>Answer ${i + 1}</span><button type="button" class="linklike" data-remove>Remove</button></div>
    ${field('Question', 'question', a.question)}
    <label>Your answer<textarea data-field="answer" rows="3">${esc(a.answer)}</textarea></label></div>`;
}

const RENDERERS = { work: workEntry, education: educationEntry, answers: answerEntry } as const;

function renderList(name: ListName): void {
  const items = profile[name] as Array<WorkEntry & EducationEntry & SavedAnswer>;
  $(`#${name}`).innerHTML = items.map((item, i) => RENDERERS[name](item, i)).join('');
}

function render(): void {
  for (const el of $$<HTMLInputElement>('[data-key]')) {
    const key = el.dataset.key as keyof Profile;
    el.value = key === 'skills' ? profile.skills.join(', ') : String(profile[key] ?? '');
  }
  (['work', 'education', 'answers'] as const).forEach(renderList);
  syncCurrentJobs();
  renderResumes();
  renderSettings();
}

function renderResumes(): void {
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
  const fallback = pickResume(resumes, '');
  $('#resumes').innerHTML = resumes.map((r) => {
    const words = useForWords(r);
    const badge = words.length ? `For titles with: ${words.join(', ')}` : r.id === fallback?.id ? 'Used for all other jobs' : 'Older, not used';
    return `<div class="entry" data-resume="${esc(r.id)}">
      <div class="entry-head"><span>${esc(r.name)} · ${kb(r.size)} · added ${esc(r.savedAt ? new Date(r.savedAt).toLocaleDateString() : '?')}<span class="resume-badge">${esc(badge)}</span></span>
        <button type="button" class="linklike" data-resume-remove>Remove</button></div>
      <div class="grid">
        <label>Name<input type="text" data-resume-field="label" value="${esc(r.label)}"></label>
        <label>Use for job titles with<input type="text" data-resume-field="useFor" value="${esc(r.useFor)}" placeholder="devsecops, security"></label>
      </div>
      <div class="row"><button type="button" class="btn" data-resume-fill>Fill profile from this resume</button></div>
    </div>`;
  }).join('');
  if (!resumes.length) $('#resume-status').textContent = 'No resume yet. Forms that ask for one will be left for you to attach.';
}

/** Names and title words typed into the resume list. */
function readResumes(): ResumeEntry[] {
  return resumes.map((r) => {
    const entry = document.querySelector(`[data-resume="${CSS.escape(r.id)}"]`);
    const val = (f: string) => (entry?.querySelector<HTMLInputElement>(`[data-resume-field="${f}"]`)?.value ?? '').trim();
    return entry ? { ...r, label: val('label'), useFor: val('useFor') } : r;
  });
}

function renderSettings(): void {
  $<HTMLInputElement>('#limit-day').value = String(settings.limits.perDay);
  $<HTMLInputElement>('#limit-company').value = String(settings.limits.perCompany);
  $<HTMLInputElement>('#limit-days').value = String(settings.limits.companyDays);
  $<HTMLInputElement>('#claude-key').value = settings.claudeKey;
  $<HTMLInputElement>('#auto-backup').checked = settings.autoBackup;
}

function readSettings(): Settings {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  return normalizeSettings({
    ...settings,
    limits: { perDay: num('#limit-day'), perCompany: num('#limit-company'), companyDays: num('#limit-days') },
    claudeKey: $<HTMLInputElement>('#claude-key').value,
    autoBackup: $<HTMLInputElement>('#auto-backup').checked,
  });
}

/** "I work here now" disables the end date. */
function syncCurrentJobs(): void {
  for (const entry of $$('#work .entry')) {
    const current = $<HTMLInputElement>('[data-field="current"]', entry).checked;
    const end = $<HTMLInputElement>('[data-field="end"]', entry);
    end.disabled = current;
    if (current) end.value = '';
  }
}

// ---------------------------------------------------------------- reading the form back

function readList(name: ListName): Array<Record<string, unknown>> {
  return $$(`#${name} .entry`).map((entry) => Object.fromEntries($$<HTMLInputElement>('[data-field]', entry)
    .map((el) => [el.dataset.field!, el.type === 'checkbox' ? el.checked : el.value])));
}

function readForm(): Profile {
  const raw: Record<string, unknown> = { ...profile };
  for (const el of $$<HTMLInputElement>('[data-key]')) raw[el.dataset.key!] = el.value;
  raw.skills = String(raw.skills).split(',');
  for (const name of ['work', 'education', 'answers'] as const) raw[name] = readList(name);
  return normalizeProfile(raw);
}

// ---------------------------------------------------------------- actions

function setStatus(el: HTMLElement, text: string, kind: 'ok' | 'warn' | 'error' | '' = ''): void {
  el.className = `small ${kind}`;
  el.textContent = text;
}

function markDirty(): void {
  dirty = true;
  setStatus($('#save-status'), 'Unsaved changes', 'warn');
}

function showBanner(text: string, kind: '' | 'error' = ''): void {
  const banner = $('#resume-banner');
  banner.textContent = text;
  banner.className = `banner ${kind}`;
  banner.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Read a resume PDF and fill the profile form from it, highlighting what changed. Doesn't save. */
async function fillFromResume(resume: ResumeEntry | undefined): Promise<void> {
  if (!resume) return;
  resumes = readResumes();
  const before = readForm();
  try {
    const { pdfText } = await import('./pdf-text'); // PDF.js is large; load it only when needed
    const facts = readResume(await pdfText(Uint8Array.from(atob(resume.data), (c) => c.charCodeAt(0))));
    const { profile: next, changed } = mergeResume(before, facts);
    profile = next;
    render();
    for (const key of changedKeys(before, next)) {
      $$(`[data-key="${key}"], #${key} .entry`).forEach((el) => el.classList.add('from-resume'));
    }
    if (!changed.length) {
      showBanner(facts.firstName || facts.work.length
        ? 'Your profile already matches this resume. Nothing changed.'
        : "Couldn't read any details from this PDF. It may be a scanned image; fill the profile in by hand.", facts.firstName ? '' : 'error');
      return;
    }
    markDirty();
    showBanner(`Filled in from ${resume.label || resume.name}: ${changed.join(', ')}. Check the highlighted fields, fix anything it got wrong, then click Save.`);
  } catch (err) {
    showBanner(`Couldn't read this PDF: ${(err as Error).message}`, 'error');
  }
}

async function save(): Promise<void> {
  profile = readForm();
  resumes = readResumes();
  const next = readSettings();
  try {
    await Promise.all([saveProfile(profile), saveResumes(resumes), saveSettings((s) => ({ ...next, lastBackup: s.lastBackup }))]);
    settings = next;
    renderResumes();
    dirty = false;
    setStatus($('#save-status'), 'Saved', 'ok');
    $$('.from-resume').forEach((el) => el.classList.remove('from-resume'));
    $('#resume-banner').hidden = true;
  } catch (err) {
    setStatus($('#save-status'), `Could not save: ${(err as Error).message}`, 'error');
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function wire(): void {
  const form = $<HTMLFormElement>('#profile');
  form.addEventListener('input', markDirty);
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).dataset.field === 'current') syncCurrentJobs();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });

  form.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const add = target.closest<HTMLElement>('[data-add]');
    const remove = target.closest<HTMLElement>('[data-remove]');
    if (!add && !remove) return;
    profile = readForm(); // keep what's been typed before re-rendering the list
    if (add) {
      const name = add.dataset.add as ListName;
      const blank = { work: emptyWork, education: emptyEducation, answers: () => ({ question: '', answer: '' }) }[name]();
      (profile[name] as unknown[]).push(blank);
      renderList(name);
      syncCurrentJobs();
      $$<HTMLInputElement>(`#${name} .entry:last-child [data-field]`)[0]?.focus();
    } else if (remove) {
      const entry = remove.closest<HTMLElement>('.entry')!;
      const name = entry.parentElement!.id as ListName;
      (profile[name] as unknown[]).splice(Number(entry.dataset.index), 1);
      renderList(name);
      syncCurrentJobs();
    }
    markDirty();
  });

  $<HTMLInputElement>('#resume-file').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_RESUME_BYTES) {
      setStatus($('#resume-status'), `That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 5 MB.`, 'error');
      return;
    }
    resumes = addResume(readResumes(), await fileToResume(file));
    setStatus($('#resume-status'), '');
    renderResumes();
    markDirty();
    // The newest resume is the one used from now on, so the profile follows it.
    await fillFromResume(resumes.find((r) => r.name === file.name && r.size === file.size));
  });
  $('#resumes').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const id = t.closest<HTMLElement>('[data-resume]')?.dataset.resume;
    if (!id) return;
    if (t.closest('[data-resume-fill]')) void fillFromResume(readResumes().find((r) => r.id === id));
    if (t.closest('[data-resume-remove]')) {
      resumes = readResumes().filter((r) => r.id !== id);
      renderResumes();
      markDirty();
    }
  });
  $('#resumes').addEventListener('change', () => { resumes = readResumes(); renderResumes(); });
  $<HTMLInputElement>('#auto-backup').addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.checked) return;
    // Asked for only when you turn this on; the request must come straight from the click.
    void chrome.permissions.request({ permissions: ['downloads'] }).then((granted) => {
      if (!granted) box.checked = false;
      else setStatus($('#import-status'), 'Weekly backup turns on when you click Save.', 'ok');
    });
  });

  $('#export').addEventListener('click', () => {
    const withResume = $<HTMLInputElement>('#export-resume').checked;
    const bundle = exportBundle(readForm(), withResume ? pickResume(readResumes(), '') : null);
    download(`autofill-profile-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
  });
  $<HTMLInputElement>('#import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const imported = parseBundle(await file.text());
      if (!confirm('Replace the profile on this page with the imported one? Click Save afterwards to keep it.')) return;
      profile = imported.profile;
      if (imported.resume) resumes = addResume(readResumes(), imported.resume);
      render();
      markDirty();
      setStatus($('#import-status'), `Imported ${file.name}. Review it, then Save.`, 'ok');
    } catch (err) {
      setStatus($('#import-status'), (err as Error).message, 'error');
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });
}

async function init(): Promise<void> {
  [profile, resumes, settings] = await Promise.all([loadProfile(), loadResumes(), loadSettings()]);
  render();
  wire();
}

void init();
