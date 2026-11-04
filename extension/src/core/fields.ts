// Which profile value a form field wants, from its label, and which dropdown option matches it.
// Pure (no chrome.* or DOM), so it's unit tested in Node. The page side is src/content/engine.ts.

import type { Profile, SavedAnswer } from './profile';

export type FieldKey =
  | 'firstName' | 'lastName' | 'preferredName' | 'fullName' | 'email' | 'phone' | 'phoneType'
  | 'address1' | 'city' | 'state' | 'postalCode' | 'country' | 'location'
  | 'linkedin' | 'github' | 'portfolio'
  | 'workAuthorized' | 'needsSponsorship' | 'noSponsorship'
  | 'currentCompany' | 'currentTitle' | 'school' | 'degree' | 'discipline';

/** What `fill` sends back to the popup from each frame with an application form. */
export interface FillReport {
  site: string;
  fields: number; // form fields found, filled or not
  filled: string[]; // labels of the fields it filled
  left: string[]; // required fields still empty afterwards
  resume: 'attached' | 'present' | 'no-resume' | 'no-field' | 'failed';
  resumeName?: string; // which of your resumes was attached
  sensitive: number; // voluntary self-identification questions left alone
}

export const normalize = (s: string): string =>
  s.toLowerCase().replace(/[*_\-–—]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[?:.]+$/, '').trim();

// Checked in order; the first match wins ("preferred first name" is the preferred name,
// "email address" is the email). `any` rules also apply to long questions; the rest only to
// short labels, so "Are you willing to relocate to our city?" isn't treated as a City field.
const RULES: Array<[FieldKey, RegExp, 'any'?]> = [
  ['preferredName', /\bpreferred( first)? name\b|\bnick ?name\b/],
  ['firstName', /\b(first|given) name\b/],
  ['lastName', /\b(last|family) name\b|\bsurname\b/],
  ['fullName', /^(full |your )?name$/],
  ['email', /\be ?mail\b/],
  ['phoneType', /\b(phone )?device type\b|\bphone type\b/],
  ['phone', /\b(phone|mobile|cell)( number)?\b/],
  ['linkedin', /\blinked ?in\b/, 'any'],
  ['github', /\bgit ?hub\b/, 'any'],
  ['portfolio', /\bportfolio\b|\bpersonal (web ?site|site)\b|^(web ?site|blog)( url)?$/, 'any'],
  ['noSponsorship', /\bwithout (\w+ ){0,3}sponsorship\b/, 'any'],
  ['needsSponsorship', /\bsponsor/, 'any'],
  ['workAuthorized', /\b(authori[sz]ed|eligible|permitted) to work\b|\bright to work\b|\bwork (authori[sz]ation|permit)\b/, 'any'],
  ['location', /^(current )?location\b|\bwhere are you (currently )?(located|based)\b/, 'any'],
  ['address1', /^(street )?address( line)? ?1?$|\bstreet address\b/],
  ['postalCode', /\b(zip|postal)( code)?\b/],
  ['city', /\bcity\b/],
  ['state', /\b(state|province)\b/],
  ['country', /\bcountry\b/],
  ['currentCompany', /\bcurrent (company|employer)\b|^(company|employer)( name)?$/],
  ['currentTitle', /\bcurrent (job )?(title|role|position)\b|^job title$/],
  ['school', /\b(school|university|college|institution)\b/],
  ['degree', /\bdegree\b/],
  ['discipline', /\b(discipline|field of study|major)\b/],
];

const SHORT_LABEL_WORDS = 8;

export function fieldKey(label: string): FieldKey | null {
  const l = normalize(label);
  const short = l.split(' ').length <= SHORT_LABEL_WORDS;
  for (const [key, re, scope] of RULES) if ((short || scope === 'any') && re.test(l)) return key;
  return null;
}

// Voluntary self-identification (EEO) and other questions that are the applicant's to answer
// each time. These are never filled, even when a saved answer happens to match.
const SENSITIVE = /\b(gender|sex|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(y|ies)|sexual orientation|transgender|pronouns?|date of birth|birth ?date|age|social security|ssn)\b/;
export const isSensitive = (label: string): boolean => SENSITIVE.test(normalize(label));

const yesNo = (v: string): string => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '');

export function valueFor(key: FieldKey, p: Profile): string {
  const job = p.work.find((w) => w.current) ?? p.work[0];
  const school = p.education[0];
  switch (key) {
    case 'fullName': return [p.firstName, p.lastName].filter(Boolean).join(' ');
    case 'location': return [p.city, p.state].filter(Boolean).join(', ');
    case 'phoneType': return p.phone ? 'Mobile' : '';
    case 'workAuthorized': return yesNo(p.workAuthorized);
    case 'needsSponsorship': return yesNo(p.needsSponsorship);
    case 'noSponsorship': return yesNo(p.needsSponsorship === 'yes' ? 'no' : p.needsSponsorship === 'no' ? 'yes' : '');
    case 'currentCompany': return job?.company ?? '';
    case 'currentTitle': return job?.title ?? '';
    case 'school': return school?.school ?? '';
    case 'degree': return school?.degree ?? '';
    case 'discipline': return school?.field ?? '';
    default: return p[key];
  }
}

// ---------------------------------------------------------------- saved answers

// Questions phrased many ways that should still find the same saved answer.
const TOPICS = [
  /\bsalary|\bcompensation\b|\bpay (range|expectation)/,
  /\bhear about\b|\breferr(ed|al)\b|\bhow did you (find|learn)\b/,
  /\bstart date\b|\b(when can you|available to) start\b|\bnotice period\b/,
  /\bwhy .*\b(work|join|interested)\b|\binterest(ed)? in (this|the|our)\b/,
];
const STOP = new Set('the and for you your are with this that what how why when did our from have will would can about any please'.split(' '));
const words = (s: string) => new Set(normalize(s).split(/\W+/).filter((w) => w.length > 2 && !STOP.has(w)));

export function findAnswer(question: string, answers: SavedAnswer[]): string {
  const q = normalize(question);
  const usable = answers.filter((a) => a.answer.trim());
  const exact = usable.find((a) => normalize(a.question) === q);
  if (exact) return exact.answer;
  const topic = TOPICS.find((t) => t.test(q));
  const sameTopic = topic && usable.find((a) => topic.test(normalize(a.question)));
  if (sameTopic) return sameTopic.answer;
  // Otherwise most of the shorter question's words must appear in the longer one.
  const qw = words(q);
  for (const a of usable) {
    const aw = words(a.question);
    const shared = [...qw].filter((w) => aw.has(w)).length;
    if (shared >= 2 && shared / Math.min(qw.size, aw.size) >= 0.8) return a.answer;
  }
  return '';
}

/** The value to put in a field, or '' to leave it alone. Long text boxes only get saved answers. */
export function resolveValue(label: string, p: Profile, kind: 'short' | 'long' | 'choice'): string {
  const key = kind === 'long' ? null : fieldKey(label);
  return (key && valueFor(key, p)) || findAnswer(label, p.answers);
}

// ---------------------------------------------------------------- dropdown options

const PLACEHOLDER = /^(select( one| an option)?|please select.*|choose.*|none selected|\W*)$/;
export const isPlaceholder = (text: string | undefined): boolean => PLACEHOLDER.test(normalize(text ?? ''));

const STATES = 'al alabama|ak alaska|az arizona|ar arkansas|ca california|co colorado|ct connecticut|de delaware|dc district of columbia|fl florida|ga georgia|hi hawaii|id idaho|il illinois|in indiana|ia iowa|ks kansas|ky kentucky|la louisiana|me maine|md maryland|ma massachusetts|mi michigan|mn minnesota|ms mississippi|mo missouri|mt montana|ne nebraska|nv nevada|nh new hampshire|nj new jersey|nm new mexico|ny new york|nc north carolina|nd north dakota|oh ohio|ok oklahoma|or oregon|pa pennsylvania|ri rhode island|sc south carolina|sd south dakota|tn tennessee|tx texas|ut utah|vt vermont|va virginia|wa washington|wv west virginia|wi wisconsin|wy wyoming'
  .split('|').map((s) => [s.slice(0, 2), s.slice(3)] as const);
const US = ['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a'];

/** Other ways an option list may spell the same value: "CA" ↔ "California", "USA" ↔ "United States". */
function spellings(v: string): string[] {
  if (US.includes(v.replace(/\./g, ' ').replace(/\s+/g, ' ').trim())) return US;
  const st = STATES.find(([abbr, name]) => v === abbr || v === name);
  return st ? [st[1], st[0]] : [v];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of the option that best matches `value`, or -1. Never picks a "Select…" placeholder. */
export function pickOption(options: string[], value: string): number {
  const v = normalize(value);
  if (!v) return -1;
  const opts = options.map((o) => (isPlaceholder(o) ? '' : normalize(o)));
  const find = (ok: (o: string) => boolean) => opts.findIndex((o) => o !== '' && ok(o));
  if (v === 'yes' || v === 'no') return find((o) => new RegExp(`^${v}\\b`).test(o));
  const names = spellings(v);
  for (const test of [
    (o: string, n: string) => o === n,
    (o: string, n: string) => new RegExp(`^${escape(n)}\\b`).test(o),
    (o: string, n: string) => new RegExp(`\\b${escape(n)}\\b`).test(o),
    (o: string, n: string) => o.length >= 4 && new RegExp(`\\b${escape(o)}\\b`).test(n),
  ]) {
    for (const n of names) {
      const i = find((o) => test(o, n));
      if (i >= 0) return i;
    }
  }
  return -1;
}
