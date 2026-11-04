// Extension settings, edited on the profile page. Stored in chrome.storage.local like the rest.

import { DEFAULT_LIMITS, type QueueLimits } from './applications';

export interface Settings {
  limits: QueueLimits;
  autoBackup: boolean; // weekly backup of the application history to Downloads (needs the downloads permission)
  backupEveryDays: number;
  lastBackup: string; // ISO time of the last backup, automatic or by hand
  claudeKey: string; // Anthropic API key for drafting answers; empty turns drafting off
}

export const DEFAULT_SETTINGS: Settings = {
  limits: DEFAULT_LIMITS, autoBackup: false, backupEveryDays: 7, lastBackup: '', claudeKey: '',
};

const SETTINGS_KEY = 'settings';

const count = (v: unknown, fallback: number, max = 1000) =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : fallback);

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & { limits?: Partial<QueueLimits> };
  const l: Partial<QueueLimits> = r.limits ?? {};
  return {
    limits: {
      perDay: count(l.perDay, DEFAULT_LIMITS.perDay),
      perCompany: count(l.perCompany, DEFAULT_LIMITS.perCompany),
      companyDays: count(l.companyDays, DEFAULT_LIMITS.companyDays, 365) || DEFAULT_LIMITS.companyDays,
    },
    autoBackup: r.autoBackup === true,
    backupEveryDays: count(r.backupEveryDays, DEFAULT_SETTINGS.backupEveryDays, 90) || DEFAULT_SETTINGS.backupEveryDays,
    lastBackup: typeof r.lastBackup === 'string' ? r.lastBackup : '',
    claudeKey: typeof r.claudeKey === 'string' ? r.claudeKey.trim() : '',
  };
}

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

export async function saveSettings(change: (s: Settings) => Settings): Promise<Settings> {
  const next = change(await loadSettings());
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
