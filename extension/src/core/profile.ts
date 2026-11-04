// The profile the extension fills forms from, plus JSON export/import.
// Everything here is pure (no chrome.* or DOM), so it can be unit tested in Node.

export type YesNo = 'yes' | 'no' | '';

export interface WorkEntry {
  company: string;
  title: string;
  location: string;
  start: string; // "YYYY-MM"
  end: string; // "YYYY-MM", empty when current
  current: boolean;
  description: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  start: string; // "YYYY-MM"
  end: string;
}

export interface SavedAnswer {
  question: string;
  answer: string;
}

export interface Profile {
  version: 1;
  firstName: string;
  lastName: string;
  preferredName: string;
  email: string;
  phone: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  workAuthorized: YesNo; // legally authorized to work in `country`
  needsSponsorship: YesNo;
  work: WorkEntry[];
  education: EducationEntry[];
  skills: string[];
  answers: SavedAnswer[];
}

/** Resume PDF, stored separately from the profile because it's large. */
export interface StoredResume {
  name: string;
  type: string;
  size: number;
  data: string; // base64
  savedAt: string;
}

export const MAX_RESUME_BYTES = 5 * 1024 * 1024; // chrome.storage.local holds 10 MB without extra permissions

// Questions nearly every application asks; seeded so new users see what's useful to fill in.
export const COMMON_QUESTIONS = [
  'Why do you want to work here?',
  'What are your salary expectations?',
  'How did you hear about this job?',
  'When can you start?',
];

export function emptyProfile(): Profile {
  return {
    version: 1,
    firstName: '', lastName: '', preferredName: '', email: '', phone: '',
    address1: '', city: '', state: '', postalCode: '', country: 'United States',
    linkedin: '', github: '', portfolio: '',
    workAuthorized: '', needsSponsorship: '',
    work: [], education: [], skills: [],
    answers: COMMON_QUESTIONS.map((question) => ({ question, answer: '' })),
  };
}

export const emptyWork = (): WorkEntry => ({ company: '', title: '', location: '', start: '', end: '', current: false, description: '' });
export const emptyEducation = (): EducationEntry => ({ school: '', degree: '', field: '', start: '', end: '' });

// ---------------------------------------------------------------- normalizing untrusted input
// Imported files and old stored data may be missing fields or have wrong types. Normalizing
// instead of rejecting means a slightly different file still imports what it can.

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const yesNo = (v: unknown): YesNo => {
  const s = str(v).toLowerCase();
  if (s === 'yes' || s === 'true') return 'yes';
  if (s === 'no' || s === 'false') return 'no';
  return v === true ? 'yes' : v === false ? 'no' : '';
};
const month = (v: unknown): string => {
  const m = str(v).match(/^(\d{4})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : '';
};
const list = <T>(v: unknown, item: (x: Record<string, unknown>) => T): T[] =>
  Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').map((x) => item(x as Record<string, unknown>)) : [];

export function normalizeProfile(raw: unknown): Profile {
  const base = emptyProfile();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const text = (key: keyof Profile) => (key in r ? str(r[key]) : (base[key] as string));
  return {
    version: 1,
    firstName: text('firstName'), lastName: text('lastName'), preferredName: text('preferredName'),
    email: text('email'), phone: text('phone'),
    address1: text('address1'), city: text('city'), state: text('state'), postalCode: text('postalCode'),
    country: text('country'),
    linkedin: text('linkedin'), github: text('github'), portfolio: text('portfolio'),
    workAuthorized: yesNo(r.workAuthorized), needsSponsorship: yesNo(r.needsSponsorship),
    work: list(r.work, (w) => ({
      company: str(w.company), title: str(w.title), location: str(w.location),
      start: month(w.start), end: w.current === true ? '' : month(w.end), current: w.current === true,
      description: str(w.description),
    })),
    education: list(r.education, (e) => ({
      school: str(e.school), degree: str(e.degree), field: str(e.field), start: month(e.start), end: month(e.end),
    })),
    skills: Array.isArray(r.skills)
      ? [...new Set(r.skills.map(str).filter(Boolean))]
      : str(r.skills).split(',').map((s) => s.trim()).filter(Boolean),
    answers: 'answers' in r
      ? list(r.answers, (a) => ({ question: str(a.question), answer: str(a.answer) })).filter((a) => a.question)
      : base.answers,
  };
}

// ---------------------------------------------------------------- completeness

/** Fields most forms require; the popup shows which are missing. */
export const KEY_FIELDS: Array<[keyof Profile, string]> = [
  ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
  ['city', 'City'], ['state', 'State'], ['linkedin', 'LinkedIn'],
  ['workAuthorized', 'Work authorization'], ['needsSponsorship', 'Sponsorship'],
];

export function missingFields(p: Profile, hasResume: boolean): string[] {
  const missing = KEY_FIELDS.filter(([key]) => !p[key]).map(([, label]) => label);
  if (!p.work.length) missing.push('Work history');
  if (!hasResume) missing.push('Resume PDF');
  return missing;
}

// ---------------------------------------------------------------- export / import

export const EXPORT_FORMAT = 'job-autofill-profile';

export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  profile: Profile;
  resume?: StoredResume;
}

export function exportBundle(profile: Profile, resume: StoredResume | null, now = new Date()): ExportBundle {
  return { format: EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), profile, ...(resume ? { resume } : {}) };
}

/** Parse an exported file. Throws an Error with a user-facing message if it isn't one. */
export function parseBundle(text: string): { profile: Profile; resume: StoredResume | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const d = data as Partial<ExportBundle> | null;
  if ((data as { format?: string } | null)?.format === SITE_BACKUP_FORMAT) {
    return { profile: fromSiteKit((data as { kit?: SiteKit }).kit), resume: null };
  }
  if (!d || d.format !== EXPORT_FORMAT) throw new Error("That file isn't a profile exported from this extension.");
  if (d.version !== 1) throw new Error(`This profile was exported by a newer version (format ${String(d.version)}).`);
  return { profile: normalizeProfile(d.profile), resume: parseResume(d.resume) };
}

function parseResume(raw: unknown): StoredResume | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const data = str(r.data);
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  const size = Math.floor((data.length * 3) / 4);
  if (size > MAX_RESUME_BYTES) return null;
  return { name: str(r.name) || 'resume.pdf', type: str(r.type) || 'application/pdf', size, data, savedAt: str(r.savedAt) };
}

// ---------------------------------------------------------------- import from the job site's apply kit

// "Back up" on the Career Hotspot Globe site writes this format; its apply kit has the basics.
export const SITE_BACKUP_FORMAT = 'jobglobal-tracker-backup';

interface SiteKit {
  fields?: Record<string, string>;
  extra?: string;
}

const kitYes = (v: string): YesNo => (/^(no|not)\b/i.test(v) ? 'no' : /^(yes|authorized|us citizen|citizen|green card)/i.test(v) ? 'yes' : '');

export function fromSiteKit(kit: SiteKit | undefined): Profile {
  const f = kit?.fields ?? {};
  const [first, ...rest] = str(f.name).split(/\s+/);
  const [city, state] = str(f.location).split(',').map((s) => s.trim());
  const answers = emptyProfile().answers.map((a) => {
    if (/salary/i.test(a.question)) return { ...a, answer: str(f.salary) };
    if (/hear about/i.test(a.question)) return { ...a, answer: str(f.heard) };
    if (/start/i.test(a.question)) return { ...a, answer: str(f.start) };
    return a;
  });
  const extra = str(kit?.extra).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
    .map((answer, i) => ({ question: `Saved answer ${i + 1} (rename to the question it answers)`, answer }));
  return normalizeProfile({
    firstName: first ?? '', lastName: rest.join(' '), email: f.email, phone: f.phone, city, state,
    linkedin: f.linkedin, github: f.github, portfolio: f.portfolio,
    workAuthorized: kitYes(str(f.workAuth)), needsSponsorship: kitYes(str(f.sponsorship)),
    answers: [...answers, ...extra],
  });
}
