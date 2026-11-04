import { describe, expect, it } from 'vitest';
import {
  appKey, exportApps, markApplied, mergeApps, parseApps, recordJob, setAppStatus, toCSV, updateApp,
} from '../src/core/applications';

const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';

describe('appKey', () => {
  it('gives a Greenhouse job one key on its board, an embedded form and the confirmation page', () => {
    for (const url of [
      'https://job-boards.greenhouse.io/cloudflare/jobs/7695702',
      'https://boards.greenhouse.io/cloudflare/jobs/7695702?gh_jid=7695702',
      'https://job-boards.greenhouse.io/cloudflare/jobs/7695702/confirmation',
      'https://job-boards.greenhouse.io/embed/job_app?for=cloudflare&token=7695702',
      'https://www.cloudflare.com/careers/jobs/?gh_jid=7695702',
    ]) expect(appKey(url)).toBe('greenhouse:7695702');
  });

  it('gives a Workday job one key on the posting and every application step', () => {
    const key = appKey('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Engineer_R123');
    expect(key).toBe('workday:acme.wd5.myworkdayjobs.com/External/job/Austin-TX/Engineer_R123');
    expect(appKey('https://acme.wd5.myworkdayjobs.com/External/job/Austin-TX/Engineer_R123/apply/applyManually')).toBe(key);
  });

  it('falls back to host and path elsewhere', () => {
    expect(appKey('https://www.example.com/jobs/42/?ref=x')).toBe('example.com/jobs/42');
  });
});

describe('recording', () => {
  const job = { url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'Engineer', company: 'Acme', description: 'Short' };

  it('records a job once and fills in details it learns later', () => {
    let apps = recordJob({}, job, T1);
    expect(apps['greenhouse:1']).toMatchObject({ title: 'Engineer', company: 'Acme', status: 'started', started: T1, applied: '' });
    apps = recordJob(apps, { url: job.url, title: 'Other', location: 'Austin, TX', description: 'A much longer description' }, T2);
    expect(apps['greenhouse:1']).toMatchObject({ title: 'Engineer', location: 'Austin, TX', description: 'A much longer description' });
    expect(recordJob(apps, job, T2)).toBe(apps); // nothing new: same object, so storage isn't rewritten
  });

  it('marks applied once and never moves a later status back', () => {
    let apps = markApplied({}, job, T1);
    expect(apps['greenhouse:1']).toMatchObject({ status: 'applied', applied: T1 });
    apps = setAppStatus(apps, 'greenhouse:1', 'interviewing', T2);
    apps = markApplied(apps, job, T2);
    expect(apps['greenhouse:1']).toMatchObject({ status: 'interviewing', applied: T1 });
  });

  it('exports CSV with quoting and round-trips a backup, merging by the later status', () => {
    let apps = markApplied({}, { ...job, description: 'Line one, "quoted"\nLine two' }, T1);
    apps = updateApp(apps, 'greenhouse:1', { notes: 'Recruiter: Sam' }, T1);
    expect(toCSV(apps).split('\n')[1]).toBe('Applied,Acme,Engineer,,2026-11-01,2026-11-01,https://job-boards.greenhouse.io/acme/jobs/1,Recruiter: Sam,"Line one, ""quoted""');

    const backup = parseApps(JSON.stringify(exportApps(setAppStatus(apps, 'greenhouse:1', 'offer', T2))));
    const merged = mergeApps(recordJob({}, job, T1), backup);
    expect(merged['greenhouse:1']).toMatchObject({ status: 'offer', notes: 'Recruiter: Sam', applied: T1 });
    expect(() => parseApps('{"format":"other"}')).toThrow(/isn't an applications export/);
  });
});
