import { describe, expect, it } from 'vitest';
import {
  appKey, applyLimits, DEFAULT_LIMITS, dueCount, followedUp, followUpDate, followUpDue, markApplied, recordJob, setAppStatus,
} from '../src/core/applications';
import { addResume, pickResume, type ResumeEntry } from '../src/core/resumes';
import { normalizeSettings } from '../src/core/settings';

const job = (n: number, company = 'Acme') => ({ url: `https://job-boards.greenhouse.io/x/jobs/${n}`, title: `Job ${n}`, company });

describe('follow-ups', () => {
  it('come due 6 days after applying, move on when you follow up, and stop once the status moves on', () => {
    let apps = markApplied({}, job(1), '2026-10-20T15:00:00');
    const a = apps['greenhouse:1'];
    expect(followUpDate(a)).toBe('2026-10-26');
    expect(followUpDue(a, '2026-10-25')).toBe(false);
    expect(dueCount(apps, '2026-10-26')).toBe(1);
    apps = followedUp(apps, 'greenhouse:1', '2026-10-27');
    expect(followUpDate(apps['greenhouse:1'])).toBe('2026-11-02');
    expect(dueCount(setAppStatus(apps, 'greenhouse:1', 'interviewing'), '2026-12-01')).toBe(0);
    expect(followUpDate(recordJob({}, job(2))['greenhouse:2'])).toBe(''); // not applied yet
  });
});

describe('applyLimits', () => {
  const now = new Date('2026-11-02T12:00:00');
  it('stops at the daily limit, counting what was opened today', () => {
    const apps = recordJob({}, job(1, 'Other'), '2026-11-02T09:00:00');
    const { allowed, skipped } = applyLimits(apps, [job(2, 'A'), job(3, 'B'), job(4, 'C')], { ...DEFAULT_LIMITS, perDay: 3 }, now);
    expect(allowed.map((j) => j.title)).toEqual(['Job 2', 'Job 3']);
    expect(skipped[0].reason).toBe('daily limit of 3 reached');
  });

  it('stops at the per-company limit within the window, ignoring older applications and jobs already recorded', () => {
    let apps = recordJob({}, job(1), '2026-10-25T09:00:00');
    apps = recordJob(apps, job(2), '2026-09-01T09:00:00'); // outside 30 days
    const { allowed, skipped } = applyLimits(apps, [job(1), job(3), job(4), job(5, 'Other')], { perDay: 0, perCompany: 2, companyDays: 30 }, now);
    expect(allowed.map((j) => j.title)).toEqual(['Job 1', 'Job 3', 'Job 5']);
    expect(skipped.map((s) => s.reason)).toEqual(['2 applications to Acme in 30 days']);
  });
});

describe('resumes', () => {
  const r = (name: string, savedAt: string, useFor = ''): ResumeEntry => ({ id: name, name, label: name, useFor, savedAt, size: 1, type: 'application/pdf', data: name });
  const list = [r('general-old', '2026-01-01'), r('general-new', '2026-06-01'), r('devsecops', '2026-09-01', 'DevSecOps, security')];

  it('uses a resume tied to words in the title, else the newest general one', () => {
    expect(pickResume(list, 'Senior DevSecOps Engineer')?.name).toBe('devsecops');
    expect(pickResume(list, 'Cloud Security Engineer')?.name).toBe('devsecops');
    expect(pickResume(list, 'Backend Engineer')?.name).toBe('general-new');
    expect(pickResume(list, 'Securities Analyst')?.name).toBe('general-new'); // whole words only
    expect(pickResume([r('only', '2026-01-01', 'rust')], 'Go Engineer')?.name).toBe('only');
    expect(pickResume([], 'x')).toBeNull();
  });

  it('adds a new resume first and skips an exact duplicate', () => {
    const added = addResume(list, { name: 'new.pdf', type: 'application/pdf', size: 2, data: 'x', savedAt: '2026-11-01' });
    expect(added[0].name).toBe('new.pdf');
    expect(pickResume(added, 'Backend')?.name).toBe('new.pdf');
    expect(addResume(added, added[0])).toBe(added);
  });
});

describe('settings', () => {
  it('fills defaults and clamps junk', () => {
    expect(normalizeSettings(null)).toMatchObject({ limits: DEFAULT_LIMITS, autoBackup: false, claudeKey: '' });
    expect(normalizeSettings({ limits: { perDay: -5, perCompany: 2.6, companyDays: 0 }, claudeKey: ' sk-ant-x ' }))
      .toMatchObject({ limits: { perDay: 15, perCompany: 3, companyDays: 30 }, claudeKey: 'sk-ant-x' });
  });
});

describe('Lever keys', () => {
  it('give a posting one key on the posting, its form and the thank-you page', () => {
    const id = '6ed76ce8-4156-4b60-b120-403538bd66cd';
    for (const u of [`https://jobs.lever.co/palantir/${id}`, `https://jobs.lever.co/palantir/${id}/apply`, `https://jobs.lever.co/palantir/${id}/thanks`]) {
      expect(appKey(u)).toBe(`lever:${id}`);
    }
  });
});
