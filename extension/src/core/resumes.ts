// Several resumes, and which one an application gets: one you've tied to words in the job title
// (say "devsecops, security"), otherwise your newest general resume. Pure, so it's unit tested.

import type { StoredResume } from './profile';

export interface ResumeEntry extends StoredResume {
  id: string;
  label: string; // your name for it, e.g. "DevSecOps"
  useFor: string; // comma-separated words; a job whose title has any of them gets this resume
}

export const useForWords = (r: ResumeEntry): string[] =>
  r.useFor.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (title: string, word: string) =>
  new RegExp(`(^|[^a-z0-9])${escape(word)}($|[^a-z0-9])`, 'i').test(title);

const newestFirst = (list: ResumeEntry[]) => [...list].sort((a, b) => b.savedAt.localeCompare(a.savedAt));

/**
 * The resume for a job: the newest one whose words appear in the title, else the newest
 * general one (no words set), else the newest of all.
 */
export function pickResume(list: ResumeEntry[], jobTitle = ''): ResumeEntry | null {
  const sorted = newestFirst(list);
  return sorted.find((r) => useForWords(r).some((w) => mentions(jobTitle, w)))
    ?? sorted.find((r) => !useForWords(r).length)
    ?? sorted[0]
    ?? null;
}

export function newEntry(resume: StoredResume, label = ''): ResumeEntry {
  return { ...resume, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label: label || resume.name.replace(/\.pdf$/i, ''), useFor: '' };
}

/** Add a resume, unless the same file (name and size) is already there. Newest first. */
export function addResume(list: ResumeEntry[], resume: StoredResume): ResumeEntry[] {
  if (list.some((r) => r.name === resume.name && r.size === resume.size && r.data === resume.data)) return list;
  return newestFirst([newEntry(resume), ...list]);
}

export function normalizeResumes(raw: unknown): ResumeEntry[] {
  if (!Array.isArray(raw)) return [];
  return newestFirst(raw.filter((r): r is ResumeEntry => !!r && typeof r === 'object' && typeof r.data === 'string' && typeof r.name === 'string')
    .map((r) => ({ ...r, id: String(r.id || newEntry(r).id), label: String(r.label ?? ''), useFor: String(r.useFor ?? ''), savedAt: String(r.savedAt ?? '') })));
}
