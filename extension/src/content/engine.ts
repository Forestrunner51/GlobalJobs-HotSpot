// Finds an application form's fields on the page, fills the empty ones, and reports back.
// It types into fields, picks dropdown options and attaches the resume. It never clicks Submit,
// Next or any other button except a dropdown it is filling, and never changes a field that
// already has a value.

import {
  type FillReport, isPlaceholder, isSensitive, normalize, pickOption, resolveValue,
} from '../core/fields';
import type { Profile, StoredResume } from '../core/profile';

type Kind = 'text' | 'textarea' | 'select' | 'combobox' | 'listbox' | 'radio' | 'file';

export interface Field {
  kind: Kind;
  el: HTMLElement;
  label: string;
  required: boolean;
  radios?: HTMLInputElement[];
}

export function siteOf(hostname: string): string | null {
  if (/(^|\.)greenhouse\.io$/.test(hostname)) return 'Greenhouse';
  if (/(^|\.)(myworkdayjobs|myworkdaysite|myworkday)\.com$/.test(hostname)) return 'Workday';
  if (/^jobs\.(eu\.)?lever\.co$/.test(hostname)) return 'Lever';
  return null;
}

// ---------------------------------------------------------------- finding fields

const textOf = (el: Element | null | undefined): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const visible = (el: Element): boolean => el.getClientRects().length > 0;
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', '']);

function rawLabel(el: HTMLElement): string {
  const doc = el.ownerDocument;
  const byIds = (ids: string | null) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => textOf(doc.getElementById(id))).join(' ');
  return (el.id && textOf(doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)))
    || byIds(el.getAttribute('aria-labelledby'))
    // Lever wraps each question in li.application-question with an .application-label.
    || textOf(el.closest('.application-question')?.querySelector('.application-label'))
    || textOf(el.closest('label'))
    // Workday wraps each question in a formField-* container with its own label or legend.
    || textOf(el.closest('[data-automation-id^="formField"]')?.querySelector('label, legend'))
    || el.getAttribute('aria-label')
    || textOf(el.closest('fieldset')?.querySelector('legend'))
    || el.getAttribute('placeholder') || el.getAttribute('name') || el.id;
}

function groupLabel(radio: HTMLInputElement): string {
  const group = radio.closest('fieldset, [role="radiogroup"]');
  return textOf(group?.querySelector('legend'))
    || (group && rawLabel(group as HTMLElement))
    || textOf(radio.closest('.application-question')?.querySelector('.application-label'))
    || textOf(radio.closest('[data-automation-id^="formField"]')?.querySelector('label, legend'))
    || radio.name;
}

// An option's own label ("Yes"), not the question around it.
const radioText = (r: HTMLInputElement): string =>
  (r.id && textOf(r.ownerDocument.querySelector(`label[for="${CSS.escape(r.id)}"]`))) || textOf(r.closest('label')) || r.getAttribute('aria-label') || r.value;

function isRequired(el: HTMLElement, raw: string): boolean {
  return (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true'
    || /[*✱]/.test(raw) || /\brequired\b/i.test(el.getAttribute('aria-label') ?? '');
}

const clean = (raw: string) => raw.replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();

export function collectFields(doc: Document): Field[] {
  const fields: Field[] = [];
  const groups = new Set<string>();
  for (const el of doc.querySelectorAll<HTMLElement>('input, textarea, select, button[aria-haspopup="listbox"]')) {
    if ((el as HTMLInputElement).disabled || el.getAttribute('aria-hidden') === 'true') continue;
    let kind: Kind;
    let radios: HTMLInputElement[] | undefined;
    if (el instanceof HTMLButtonElement) kind = 'listbox';
    else if (el instanceof HTMLSelectElement) kind = 'select';
    else if (el instanceof HTMLTextAreaElement) kind = 'textarea';
    else if (el instanceof HTMLInputElement) {
      if (el.readOnly) continue;
      if (el.type === 'file') kind = 'file';
      else if (el.type === 'radio') {
        if (!el.name || groups.has(el.name)) continue;
        groups.add(el.name);
        radios = [...(el.form ?? doc).querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
        kind = 'radio';
      } else if (el.getAttribute('role') === 'combobox') kind = 'combobox';
      // Workday's search-as-you-type lists and date segments need more than typing; leave them.
      else if (TEXT_TYPES.has(el.type) && el.dataset.automationId !== 'searchBox' && el.getAttribute('role') !== 'spinbutton') kind = 'text';
      else continue;
    } else continue;
    if (kind !== 'file' && !visible(el)) continue; // file inputs are usually hidden behind an upload button
    const raw = kind === 'radio' ? groupLabel(el as HTMLInputElement) : rawLabel(el);
    fields.push({ kind, el, label: clean(raw), required: isRequired(el, raw), radios });
  }
  return fields;
}

export function hasValue(f: Field): boolean {
  switch (f.kind) {
    case 'text': case 'textarea': return !!(f.el as HTMLInputElement).value.trim();
    case 'select': {
      const s = f.el as HTMLSelectElement;
      return !!s.value && !isPlaceholder(s.options[s.selectedIndex]?.text);
    }
    // react-select shows the chosen option in a sibling element, not in the input's value.
    case 'combobox': return !!f.el.closest('[class*="control"]')?.querySelector('[class*="single-value"], [class*="multi-value"]');
    case 'listbox': return !isPlaceholder(textOf(f.el));
    case 'radio': return !!f.radios?.some((r) => r.checked);
    case 'file': return !!(f.el as HTMLInputElement).files?.length;
  }
}

// ---------------------------------------------------------------- filling

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

const fire = (el: Element, ...types: string[]) => { for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true })); };
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }));

/** A real-looking click: frameworks differ on whether they listen for mousedown or click. */
function press(el: HTMLElement): void {
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
  }
  el.click();
}

/** Set a value so React and other frameworks notice it (they watch the input event, not the property). */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string, commit = true): void {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  fire(el, 'input');
  if (commit) {
    fire(el, 'change');
    el.blur();
  }
}

function listOptions(owner: HTMLElement): HTMLElement[] {
  const doc = owner.ownerDocument;
  const listId = owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns');
  const scope = (listId && doc.getElementById(listId)) || doc;
  const found = scope.querySelectorAll<HTMLElement>('[role="option"], [id^="react-select-"][id*="-option-"]');
  return [...new Set(found)].filter(visible);
}

/** Greenhouse's react-select dropdowns, including ones that search as you type (location, school). */
async function fillCombobox(input: HTMLInputElement, value: string): Promise<boolean> {
  input.focus();
  key(input, 'ArrowDown');
  let opts = await waitFor(() => { const o = listOptions(input); return o.length ? o : null; }, 800);
  let i = opts ? pickOption(opts.map(textOf), value) : -1;
  if (i < 0) {
    // Long or search-backed lists: type to filter, then take the best (or for a place, the first) result.
    type(input, value, false);
    await sleep(300);
    opts = await waitFor(() => { const o = listOptions(input); return o.length ? o : null; }, 3000);
    i = opts ? pickOption(opts.map(textOf), value) : -1;
    const city = normalize(value.split(',')[0]);
    if (i < 0 && opts && value.includes(',')) i = opts.findIndex((o) => normalize(textOf(o)).startsWith(city));
  }
  if (!opts || i < 0) {
    type(input, '', false);
    key(input, 'Escape');
    input.blur();
    return false;
  }
  press(opts[i]);
  input.blur();
  return true;
}

/** Workday's button dropdowns: click to open a listbox, click the option. */
async function fillListbox(button: HTMLElement, value: string): Promise<boolean> {
  press(button);
  const opts = await waitFor(() => { const o = listOptions(button); return o.length ? o : null; }, 2000);
  const i = opts ? pickOption(opts.map(textOf), value) : -1;
  if (!opts || i < 0) {
    key(button.ownerDocument.activeElement ?? button, 'Escape');
    return false;
  }
  press(opts[i]);
  await sleep(150);
  return true;
}

async function fillField(f: Field, value: string): Promise<boolean> {
  switch (f.kind) {
    case 'text': case 'textarea':
      type(f.el as HTMLInputElement, value);
      return true;
    case 'select': {
      const s = f.el as HTMLSelectElement;
      const i = pickOption([...s.options].map((o) => o.text), value);
      if (i < 0) return false;
      s.selectedIndex = i;
      fire(s, 'input', 'change');
      return true;
    }
    case 'combobox': return fillCombobox(f.el as HTMLInputElement, value);
    case 'listbox': return fillListbox(f.el, value);
    case 'radio': {
      const radios = f.radios ?? [];
      const i = pickOption(radios.map(radioText), value);
      if (i < 0) return false;
      radios[i].click();
      return true;
    }
    case 'file': return false;
  }
}

function resumeInput(fields: Field[]): Field | undefined {
  const files = fields.filter((f) => f.kind === 'file');
  const about = (f: Field) => normalize(`${f.label} ${f.el.id} ${(f.el as HTMLInputElement).name}`);
  return files.find((f) => /\b(resume|cv|curriculum)\b/.test(about(f)) && !/\bcover\b/.test(about(f)))
    ?? (files.length === 1 && !/\bcover\b/.test(about(files[0])) ? files[0] : undefined);
}

function attach(input: HTMLInputElement, r: StoredResume): boolean {
  const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], r.name, { type: r.type }));
  input.files = transfer.files;
  fire(input, 'input', 'change');
  return input.files?.length === 1;
}

/** Outline what was filled so it's easy to review (green; orange for drafts). Outlines don't move anything on the page. */
function mark(f: Field, color = '#2f9e5b'): void {
  const target = f.kind === 'combobox' ? f.el.closest<HTMLElement>('[class*="control"]') ?? f.el : f.el;
  target.style.outline = `2px solid ${color}`;
  target.style.outlineOffset = '1px';
}

/**
 * Empty open-ended questions no profile field or saved answer covers ("Why this company?"):
 * text boxes, and one-line fields whose label is a question. Self-identification is left out.
 */
export function openQuestions(doc: Document, profile: Profile): Field[] {
  return collectFields(doc).filter((f) => !hasValue(f) && !isSensitive(f.label) && f.label
    && (f.kind === 'textarea' || (f.kind === 'text' && /\?$/.test(f.label) && f.label.split(' ').length > 5))
    && !resolveValue(f.label, profile, f.kind === 'textarea' ? 'long' : 'short'));
}

/** Put a drafted answer in a field, outlined orange so it reads as a draft to check. */
export function fillDraft(f: Field, answer: string): void {
  type(f.el as HTMLInputElement, answer);
  mark(f, '#d97706');
}

export interface FillOptions {
  /** Fields already attempted, so filling again as new fields appear (Workday's next step) leaves them alone. */
  tried?: WeakSet<Element>;
  /** False once the resume is attached in this tab, so a redrawn upload box doesn't get it twice. */
  attachResume?: boolean;
}

export async function fillPage(doc: Document, profile: Profile, resume: StoredResume | null, { tried, attachResume = true }: FillOptions = {}): Promise<FillReport | null> {
  const site = siteOf(doc.location?.hostname ?? '');
  if (!site) return null;
  const all = collectFields(doc);
  const fields = tried ? all.filter((f) => !tried.has(f.el)) : all;
  for (const f of fields) tried?.add(f.el);
  const report: FillReport = { site, fields: fields.length, filled: [], left: [], resume: 'no-field', sensitive: 0 };
  if (!fields.length) return report;

  const upload = resumeInput(fields);
  if (upload) {
    const input = upload.el as HTMLInputElement;
    // After an upload, sites show the file's name and often leave the file input itself empty.
    if (hasValue(upload) || !attachResume || (resume && doc.body.textContent?.includes(resume.name))) report.resume = 'present';
    else if (!resume) report.resume = 'no-resume';
    else report.resume = attach(input, resume) ? 'attached' : 'failed';
  }

  for (const f of fields) {
    if (f.kind === 'file' || hasValue(f)) continue;
    if (isSensitive(f.label)) {
      report.sensitive++;
      continue;
    }
    const value = resolveValue(f.label, profile, f.kind === 'textarea' ? 'long' : f.kind === 'text' ? 'short' : 'choice');
    if (!value) continue;
    try {
      if (await fillField(f, value)) {
        report.filled.push(f.label);
        mark(f);
      }
    } catch {
      // One stubborn widget shouldn't stop the rest of the form.
    }
  }
  report.left = all.filter((f) => f.required && !hasValue(f)).map((f) => f.label.slice(0, 80));
  return report;
}
