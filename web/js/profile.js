// What the postings tab learns from your resume: which of the tracked skills it mentions, and the
// contact details application forms ask for. Pure functions; the resume text itself is never stored.
// Only the skill names and contact details are kept, in this browser (localStorage).

import { US_STATES } from './jobs.js';

const PROFILE_KEY = 'jobglobal.resume.v1';

export function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    return p && Array.isArray(p.skills) ? p : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  try {
    if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Names of the keywords (as [name, RegExp] pairs or a Map) that the resume text mentions. */
export function resumeSkills(text, regexes) {
  const found = [];
  for (const [name, re] of regexes) {
    re.lastIndex = 0; // the site's patterns are global, so reset before each test
    if (re.test(text)) found.push(name);
  }
  return found;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%-]+/i;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+/i;
const ANY_URL = /(?:https?:\/\/|www\.)[^\s<>()|,;]+/gi;
const CITY_STATE = /([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z]{2})(?![A-Za-z])/g;
const NOT_A_NAME = /resume|curriculum|vitae|engineer|developer|profile|summary|experience|education|objective|contact/i;

const withScheme = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/[.,;:]+$/, '');

function guessName(text) {
  for (const raw of text.split('\n').slice(0, 8)) {
    // A header line often holds more than the name: "Ada Lovelace | ada@example.com | 555..."
    const line = raw.split(/\s{3,}|[|•·]/)[0].trim();
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4 || NOT_A_NAME.test(line)) continue;
    if (!words.every((w) => /^\p{Lu}[\p{L}.'-]*$/u.test(w))) continue;
    // All-caps headers ("ADA LOVELACE") become "Ada Lovelace".
    return words.map((w) => (w.length > 2 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
  }
  return '';
}

/**
 * Contact details found in resume text, keyed like KIT_FIELDS in tracker.js. Best effort: the
 * apply kit shows them for review before anything is saved. Missing ones are left out.
 */
export function resumeContact(text) {
  const head = text.slice(0, 1500); // contact details sit at the top; later matches are employers
  const out = {};
  const name = guessName(text);
  if (name) out.name = name;
  const email = text.match(EMAIL)?.[0];
  if (email) out.email = email;
  const phone = head.match(PHONE)?.[0] ?? text.match(PHONE)?.[0];
  if (phone) out.phone = phone.trim();
  const linkedin = text.match(LINKEDIN)?.[0];
  if (linkedin) out.linkedin = withScheme(linkedin);
  const github = text.match(GITHUB)?.[0];
  if (github) out.github = withScheme(github);
  const site = (head.match(ANY_URL) ?? []).find((u) => !/linkedin\.com|github\.com/i.test(u));
  if (site) out.portfolio = withScheme(site);
  for (const m of head.matchAll(CITY_STATE)) {
    if (US_STATES[m[2]]) { out.location = `${m[1]}, ${m[2]}`; break; }
  }
  return out;
}

/** Kit fields with the resume's details filled into the empty ones; what you typed is never replaced. */
export function fillKitFields(fields = {}, contact = {}) {
  const next = { ...fields };
  const filled = [];
  for (const [key, value] of Object.entries(contact)) {
    if (value && !(next[key] ?? '').trim()) { next[key] = value; filled.push(key); }
  }
  return { fields: next, filled };
}

/**
 * How well a posting's skills line up with the resume's. A skill in the title weighs 3, one
 * mentioned repeatedly 2, one listed once 1. Returns the percent covered, the weight of what you
 * have (so of two full matches, the one asking for more of your skills ranks first) and what's
 * missing, most important first; null when the posting lists no tracked skills.
 */
export function matchJob(job, skills, ignore = null) {
  const mine = skills instanceof Set ? skills : new Set(skills);
  const weight = (k) => (job.inTitle?.includes(k) ? 3 : (job.mentions?.[k] ?? 0) >= 2 ? 2 : 1);
  let total = 0;
  let got = 0;
  const have = [];
  const missing = [];
  for (const k of job.keywords ?? []) {
    if (ignore?.has(k)) continue; // role names (Platform, SRE) describe the job, they aren't skills
    const w = weight(k);
    total += w;
    if (mine.has(k)) { got += w; have.push(k); } else missing.push(k);
  }
  if (!total) return null;
  missing.sort((a, b) => weight(b) - weight(a));
  return { percent: Math.round((100 * got) / total), weight: got, have, missing };
}
