import { describe, expect, it } from 'vitest';
import { detectAts } from '../src/core/ats';

describe('detectAts', () => {
  it.each([
    ['https://job-boards.greenhouse.io/cloudflare/jobs/7215829', 'greenhouse'],
    ['https://boards.greenhouse.io/discord/jobs/123', 'greenhouse'],
    ['https://www.example.com/careers/role?gh_jid=4567', 'greenhouse'],
    ['https://jobs.lever.co/palantir/abc-123/apply', 'lever'],
    ['https://jobs.eu.lever.co/acme/abc', 'lever'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Engineer_R123/apply', 'workday'],
    ['https://wd3.myworkday.com/acme/d/inst/1$9925/9925$1.htmld', 'workday'],
    ['https://jobs.ashbyhq.com/zed/6871e6ed', 'ashby'],
    ['https://careers-acme.icims.com/jobs/123/job', 'icims'],
  ])('%s -> %s', (url, id) => {
    expect(detectAts(url)?.id).toBe(id);
  });

  it('ignores everything else', () => {
    expect(detectAts('https://www.google.com/search?q=greenhouse.io')).toBeNull();
    expect(detectAts('https://evil.example/boards.greenhouse.io/x')).toBeNull();
    expect(detectAts(undefined)).toBeNull();
  });
});
