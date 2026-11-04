// chrome.storage.local wrappers. All data stays on this device; nothing here touches the network.

import type { Applications } from './applications';
import { normalizeProfile, type Profile, type StoredResume } from './profile';
import { addResume, normalizeResumes, type ResumeEntry } from './resumes';

const PROFILE_KEY = 'profile';
const RESUME_KEY = 'resume';
const RESUMES_KEY = 'resumes';

export async function loadProfile(): Promise<Profile> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  return normalizeProfile(stored[PROFILE_KEY]);
}

export async function saveProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

/** Your resumes, newest first. 0.3.x and earlier kept one resume under "resume"; it's moved here. */
export async function loadResumes(): Promise<ResumeEntry[]> {
  const stored = await chrome.storage.local.get([RESUMES_KEY, RESUME_KEY]);
  const list = normalizeResumes(stored[RESUMES_KEY]);
  const old = stored[RESUME_KEY] as StoredResume | undefined;
  if (!old) return list;
  const moved = addResume(list, old);
  await chrome.storage.local.set({ [RESUMES_KEY]: moved });
  await chrome.storage.local.remove(RESUME_KEY);
  return moved;
}

export async function saveResumes(list: ResumeEntry[]): Promise<void> {
  await chrome.storage.local.set({ [RESUMES_KEY]: list });
}

/** Read a picked file into a StoredResume (base64), in chunks so large PDFs don't overflow the stack. */
export async function fileToResume(file: File): Promise<StoredResume> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: file.name, type: file.type || 'application/pdf', size: file.size, data: btoa(binary), savedAt: new Date().toISOString() };
}

// Each application is stored under its own key ("app:<job key>"), so tabs recording different
// jobs at the same time (an apply queue) can't overwrite each other's changes.
const APP_PREFIX = 'app:';
const OLD_APPS_KEY = 'applications'; // 0.3.0 kept the whole history under one key

export const isAppsChange = (changes: Record<string, unknown>): boolean =>
  Object.keys(changes).some((k) => k.startsWith(APP_PREFIX));

/** Only the history's keys, so the resume (up to 5 MB) isn't read each time. getKeys is Chrome 130+. */
async function appEntries(): Promise<Record<string, unknown>> {
  const area = chrome.storage.local as typeof chrome.storage.local & { getKeys?: () => Promise<string[]> };
  if (!area.getKeys) return area.get(null);
  const keys = (await area.getKeys()).filter((k) => k.startsWith(APP_PREFIX) || k === OLD_APPS_KEY);
  return keys.length ? area.get(keys) : {};
}

export async function loadApps(): Promise<Applications> {
  const all = await appEntries();
  const apps: Applications = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(APP_PREFIX)) apps[k.slice(APP_PREFIX.length)] = v as Applications[string];
  const old = all[OLD_APPS_KEY] as Applications | undefined;
  if (old) {
    const moved = { ...old, ...apps };
    await chrome.storage.local.set(Object.fromEntries(Object.entries(moved).map(([k, v]) => [APP_PREFIX + k, v])));
    await chrome.storage.local.remove(OLD_APPS_KEY);
    return moved;
  }
  return apps;
}

/** Read, change and write the application history, writing only the jobs that changed. */
export async function changeApps(change: (apps: Applications) => Applications): Promise<Applications> {
  const before = await loadApps();
  const after = change(before);
  const set = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v).map(([k, v]) => [APP_PREFIX + k, v]));
  const removed = Object.keys(before).filter((k) => !(k in after)).map((k) => APP_PREFIX + k);
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (removed.length) await chrome.storage.local.remove(removed);
  return after;
}
