// Reads profile details out of a resume's text: contact details and links from the header, jobs,
// schools and skills from their sections. Pure, so it's unit tested in Node; the PDF text comes
// from src/options/pdf-text.ts. Resumes vary a lot, so this is a best effort the user reviews.

import type { EducationEntry, Profile, WorkEntry } from './profile';

export interface ResumeFacts {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  linkedin: string;
  github: string;
  portfolio: string;
  work: WorkEntry[];
  education: EducationEntry[];
  skills: string[];
}

type Section = 'header' | 'experience' | 'education' | 'skills' | 'other';

const HEADINGS: Array<[Section, RegExp]> = [
  ['experience', /^((professional|work|relevant) )?(experience|employment( history)?|work history)$/],
  ['education', /^education( and (certifications?|training))?$/],
  ['skills', /^((technical|core|key) )?(skills|competencies|technologies)( and (tools|technologies))?$/],
  ['other', /^(summary|profile|objective|about( me)?|projects|personal projects|certifications?|awards|honors|publications|volunteering|volunteer experience|interests|leadership|activities)$/],
];

function sectionOf(line: string): Section | null {
  const l = line.toLowerCase().replace(/&/g, 'and').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if (!l || l.split(' ').length > 5) return null;
  return HEADINGS.find(([, re]) => re.test(l))?.[0] ?? null;
}

// ---------------------------------------------------------------- dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = String.raw`(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}|\d{1,2}/\d{4}|(?:spring|summer|fall|autumn|winter)s?\s+\d{4}(?:\s*(?:&|and|,)\s*\d{4})*|\d{4})`;
const END = String.raw`(?:${DATE}|present|current|now|today)`;
// A date or date range at the end of a line, e.g. "Aug 2024 – Present" or "Summers 2022 & 2023".
const TRAILING_DATES = new RegExp(String.raw`(?:^|\s|\|)(${DATE}(?:\s*(?:[-–—]|to)\s*${END})?|${END})\s*$`, 'i');

function toMonth(text: string): string {
  const m = text.match(/^([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i);
  if (m && MONTHS.includes(m[1].toLowerCase())) return `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
  const n = text.match(/^(\d{1,2})\/(\d{4})$/);
  return n ? `${n[2]}-${n[1].padStart(2, '0')}` : ''; // a bare year or season has no month to give
}

function splitDates(line: string): { text: string; start: string; end: string; current: boolean; hasDates: boolean } {
  const m = line.match(TRAILING_DATES);
  if (!m) return { text: line, start: '', end: '', current: false, hasDates: false };
  const [from, to = ''] = m[1].split(/\s*(?:[-–—]|\bto\b)\s*/i);
  const current = /present|current|now|today/i.test(to || from);
  return {
    text: line.slice(0, m.index).replace(/[\s|,–—-]+$/, '').trim(),
    start: toMonth(from.trim()), end: current ? '' : toMonth(to.trim()), current, hasDates: true,
  };
}

// ---------------------------------------------------------------- header

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const URL_RE = /(https?:\/\/)?(www\.)?[\w-]+(\.[\w-]+)+(\/[\w\-./%~]*)?/gi;
const CITY_STATE = /^([A-Z][A-Za-z.' -]+),\s*([A-Z]{2})\b/;

const BULLET = /^[•▪◦●○■□➢►\-*–]\s*/;
const isBullet = (line: string) => BULLET.test(line);

const withScheme = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

function readHeader(lines: string[], facts: ResumeFacts): void {
  const nameLine = lines.find((l) => !EMAIL.test(l) && !/\d/.test(l) && /^[\p{L}.'-]+( [\p{L}.'-]+){1,3}$/u.test(l.trim()));
  if (nameLine) {
    const words = nameLine.trim().split(/\s+/);
    facts.firstName = words[0];
    facts.lastName = words.slice(1).join(' ');
  }
  const text = lines.join(' | ');
  facts.email = text.match(EMAIL)?.[0] ?? '';
  facts.phone = text.replace(EMAIL, ' ').match(PHONE)?.[0].trim() ?? '';
  for (const url of text.replace(EMAIL, ' ').match(URL_RE) ?? []) {
    if (/linkedin\.com\//i.test(url)) facts.linkedin ||= withScheme(url);
    else if (/github\.com\//i.test(url)) facts.github ||= withScheme(url);
    else if (/[a-z]\.[a-z]{2,}(\/|$)/i.test(url) && !/^\d/.test(url)) facts.portfolio ||= withScheme(url);
  }
  for (const part of text.split(/\s*[|•·●]\s*|\s{3,}/)) {
    const m = part.trim().match(CITY_STATE);
    if (m) {
      [facts.city, facts.state] = [m[1].trim(), m[2]];
      break;
    }
  }
}

// ---------------------------------------------------------------- experience

const SEPARATOR = /\s+[—–|@]\s+|\s+-\s+|,\s+(?=[A-Z][a-z]+,?\s*[A-Z]{2}\b)/;
const COMPANYISH = /\b(inc|llc|ltd|corp|corporation|co|company|group|bank|labs?|technologies|university|& co)\b\.?/i;

/** Joins wrapped lines back onto the bullet or line they continue. */
function bulletText(lines: string[]): string {
  const items: string[] = [];
  for (const line of lines) {
    if (isBullet(line) || !items.length) items.push(line.replace(BULLET, '').trim());
    else items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.filter(Boolean).join('\n');
}

function readExperience(lines: string[]): WorkEntry[] {
  const jobs: WorkEntry[] = [];
  let body: string[] = [];
  const flush = () => {
    const job = jobs[jobs.length - 1];
    if (job) job.description = bulletText(body);
    body = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dates = isBullet(line) || /[.;]$/.test(line) ? null : splitDates(line);
    if (!dates?.hasDates) {
      body.push(line);
      continue;
    }
    flush();
    // "Title   Dates" then "Company — Location" (or the other way round).
    const parts = (s: string) => s.split(SEPARATOR).map((p) => p.trim());
    let [title, company = '', location = ''] = parts(dates.text);
    const next = lines[i + 1];
    if (next && !isBullet(next) && !splitDates(next).hasDates) {
      const [first, firstPlace = ''] = [title, company];
      const [second, secondPlace = ''] = parts(next);
      [title, company, location] = COMPANYISH.test(first) && !COMPANYISH.test(second)
        ? [second, first, firstPlace || secondPlace]
        : [first, second, secondPlace || firstPlace];
      i++;
    }
    jobs.push({ company, title, location, start: dates.start, end: dates.end, current: dates.current, description: '' });
  }
  flush();
  return jobs;
}

// ---------------------------------------------------------------- education

const DEGREES: Array<[RegExp, string]> = [
  [/^(b\.?\s?s\.?|bsc|b\.?sc\.?)$/i, 'Bachelor of Science'], [/^(b\.?\s?a\.?)$/i, 'Bachelor of Arts'],
  [/^(m\.?\s?s\.?|msc|m\.?sc\.?)$/i, 'Master of Science'], [/^(m\.?\s?a\.?)$/i, 'Master of Arts'],
  [/^m\.?b\.?a\.?$/i, 'Master of Business Administration'], [/^ph\.?\s?d\.?$/i, 'Doctor of Philosophy'],
  [/^(a\.?\s?s\.?)$/i, 'Associate of Science'], [/^(a\.?\s?a\.?)$/i, 'Associate of Arts'],
];
const DEGREE_LINE = /\b(bachelor|master|associate|doctor|ph\.?\s?d|m\.?b\.?a|diploma)\b|^(b|m|a)\.?\s?(s|a|sc|eng)\.?\b/i;
const SCHOOL_LINE = /\b(university|college|institute|school|academy|polytechnic)\b/i;

function readDegree(text: string): { degree: string; field: string } {
  // "in" separates the field: "Master of Science in Physics", "B.S. in Computer Science".
  const [, degree = text, field = ''] = text.match(/^(.+?)\s+in\s+(.+)$/i) ?? [];
  const head = degree.split(/[,;(]/)[0].trim();
  const full = DEGREES.find(([re]) => re.test(head))?.[1] ?? head;
  return { degree: full, field: field.split(/[,;(]/)[0].trim() };
}

function readEducation(lines: string[]): EducationEntry[] {
  const schools: EducationEntry[] = [];
  let cur: EducationEntry | null = null;
  for (const line of lines) {
    if (isBullet(line)) continue;
    const dates = splitDates(line);
    const text = dates.text;
    const isDegree = DEGREE_LINE.test(text) && !/^[^,;]*\b(university|college|institute)\b/i.test(text);
    const isSchool = !isDegree && SCHOOL_LINE.test(text);
    // "AWS Certified Developer • Cornell University — Certificate in ML" is a certification, not a school.
    if ((!isSchool && !isDegree) || (isSchool && /\bcertifi(ed|cate|cation)\b/i.test(text))) continue;
    if (!cur || (isSchool && cur.school) || (isDegree && cur.degree)) {
      cur = { school: '', degree: '', field: '', start: '', end: '' };
      schools.push(cur);
    }
    if (isSchool) cur.school = text.split(SEPARATOR).find((s) => SCHOOL_LINE.test(s))?.trim() ?? text;
    else Object.assign(cur, readDegree(text));
    if (dates.hasDates) [cur.start, cur.end] = [dates.start, dates.end];
  }
  return schools;
}

// ---------------------------------------------------------------- skills

function readSkills(lines: string[]): string[] {
  // A line with "Label:" starts a group; lines without one continue the previous line.
  const rows: string[] = [];
  for (const line of lines) {
    if (/^[^,]{1,40}:/.test(line) || isBullet(line) || !rows.length) rows.push(line.replace(BULLET, ''));
    else rows[rows.length - 1] += ` ${line}`;
  }
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const row of rows) {
    const items = row.replace(/^[^,]{1,40}:\s*/, '').replace(/\(/g, ', ').replace(/\)/g, '')
      .split(/\s*(?:,|;|•|\||\s\/\s)\s*/);
    for (const raw of items) {
      const s = raw.trim().replace(/\.$/, '');
      if (s && s.length <= 40 && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        skills.push(s);
      }
    }
  }
  return skills.slice(0, 80);
}

// ---------------------------------------------------------------- putting it together

export function readResume(text: string): ResumeFacts {
  const facts: ResumeFacts = {
    firstName: '', lastName: '', email: '', phone: '', city: '', state: '',
    linkedin: '', github: '', portfolio: '', work: [], education: [], skills: [],
  };
  const sections: Record<Section, string[]> = { header: [], experience: [], education: [], skills: [], other: [] };
  let current: Section = 'header';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const heading = sectionOf(line);
    if (heading) current = heading;
    else sections[current].push(line);
  }
  readHeader(sections.header, facts);
  facts.work = readExperience(sections.experience);
  facts.education = readEducation(sections.education);
  facts.skills = readSkills(sections.skills);
  return facts;
}

const SCALARS: Array<[keyof ResumeFacts & keyof Profile, string]> = [
  ['firstName', 'first name'], ['lastName', 'last name'], ['email', 'email'], ['phone', 'phone'],
  ['city', 'city'], ['state', 'state'], ['linkedin', 'LinkedIn'], ['github', 'GitHub'], ['portfolio', 'website'],
];

/**
 * The profile updated from a resume, and what changed. The resume wins for what it contains;
 * everything it doesn't cover (work eligibility, saved answers, street address) is kept.
 */
export function mergeResume(profile: Profile, facts: ResumeFacts): { profile: Profile; changed: string[] } {
  const next: Profile = { ...profile };
  const changed: string[] = [];
  for (const [key, label] of SCALARS) {
    const value = facts[key] as string;
    if (value && value !== profile[key]) {
      (next[key] as string) = value;
      changed.push(label);
    }
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (facts.work.length && !same(facts.work, profile.work)) {
    next.work = facts.work;
    changed.push(`work history (${facts.work.length} job${facts.work.length > 1 ? 's' : ''})`);
  }
  if (facts.education.length && !same(facts.education, profile.education)) {
    next.education = facts.education;
    changed.push('education');
  }
  if (facts.skills.length && !same(facts.skills, profile.skills)) {
    next.skills = facts.skills;
    changed.push(`skills (${facts.skills.length})`);
  }
  if (facts.state && !profile.country) next.country = 'United States';
  return { profile: next, changed };
}

/** Which form fields to highlight after a merge, by the profile key they edit. */
export const changedKeys = (before: Profile, after: Profile): Array<keyof Profile> =>
  (Object.keys(after) as Array<keyof Profile>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
