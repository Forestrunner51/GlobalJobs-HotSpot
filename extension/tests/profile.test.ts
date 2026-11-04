import { describe, expect, it } from 'vitest';
import {
  emptyProfile, exportBundle, fromSiteKit, missingFields, normalizeProfile, parseBundle, SITE_BACKUP_FORMAT,
} from '../src/core/profile';

describe('normalizeProfile', () => {
  it('fills in defaults for missing or junk input', () => {
    expect(normalizeProfile(null)).toEqual(emptyProfile());
    expect(normalizeProfile('nope')).toEqual(emptyProfile());
  });

  it('coerces types instead of rejecting a slightly different file', () => {
    const p = normalizeProfile({
      firstName: '  Sam ', phone: 5551234, workAuthorized: true, needsSponsorship: 'No',
      skills: 'Rust, Go,  , Rust',
      work: [{ company: 'Acme', title: 'Dev', start: '2023-3', end: '2025-01', current: false }, 'junk', null],
      education: [{ school: 'State U', start: '2017-09-01', end: 'someday' }],
    });
    expect(p.firstName).toBe('Sam');
    expect(p.phone).toBe('5551234');
    expect(p.workAuthorized).toBe('yes');
    expect(p.needsSponsorship).toBe('no');
    expect(p.skills).toEqual(['Rust', 'Go', 'Rust']);
    expect(p.work).toHaveLength(1);
    expect(p.work[0]).toMatchObject({ company: 'Acme', start: '2023-03', end: '2025-01' });
    expect(p.education[0]).toMatchObject({ start: '2017-09', end: '' });
  });

  it('dedupes skill arrays and clears the end date of a current job', () => {
    const p = normalizeProfile({ skills: ['Rust', 'Rust', ' Go '], work: [{ company: 'A', end: '2025-01', current: true }] });
    expect(p.skills).toEqual(['Rust', 'Go']);
    expect(p.work[0].end).toBe('');
  });

  it('keeps an explicitly empty answers list but seeds common questions otherwise', () => {
    expect(normalizeProfile({ answers: [] }).answers).toEqual([]);
    expect(normalizeProfile({}).answers.map((a) => a.question)).toContain('Why do you want to work here?');
  });
});

describe('missingFields', () => {
  it('lists what most forms need', () => {
    const p = { ...emptyProfile(), firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com' };
    const missing = missingFields(p, false);
    expect(missing).toContain('Phone');
    expect(missing).toContain('Resume PDF');
    expect(missing).not.toContain('Email');
  });
});

describe('export and import', () => {
  const resume = { name: 'cv.pdf', type: 'application/pdf', size: 3, data: 'JVBE', savedAt: '2026-10-19T00:00:00Z' };

  it('round-trips a profile and resume', () => {
    const profile = normalizeProfile({ firstName: 'Sam', work: [{ company: 'Acme' }] });
    const back = parseBundle(JSON.stringify(exportBundle(profile, resume)));
    expect(back.profile).toEqual(profile);
    expect(back.resume?.name).toBe('cv.pdf');
  });

  it('rejects other files with a readable message', () => {
    expect(() => parseBundle('not json')).toThrow("isn't valid JSON");
    expect(() => parseBundle('{"format":"something-else"}')).toThrow("isn't a profile");
    expect(() => parseBundle('{"format":"job-autofill-profile","version":2}')).toThrow('newer version');
  });

  it('drops a resume that is not base64', () => {
    const bundle = { ...exportBundle(emptyProfile(), null), resume: { ...resume, data: '<script>' } };
    expect(parseBundle(JSON.stringify(bundle)).resume).toBeNull();
  });

  it("imports the job site's apply kit backup", () => {
    const backup = {
      format: SITE_BACKUP_FORMAT,
      entries: {},
      kit: {
        fields: { name: 'Sam Q. Lee', email: 'sam@example.com', location: 'Austin, TX', workAuth: 'Authorized to work in the US',
          sponsorship: 'No', salary: '$150k', heard: 'Careers page', linkedin: 'https://linkedin.com/in/sam' },
        extra: 'A short bio.\n\nA project summary.',
      },
    };
    const { profile } = parseBundle(JSON.stringify(backup));
    expect(profile).toMatchObject({ firstName: 'Sam', lastName: 'Q. Lee', city: 'Austin', state: 'TX',
      workAuthorized: 'yes', needsSponsorship: 'no', linkedin: 'https://linkedin.com/in/sam' });
    expect(profile.answers.find((a) => /salary/i.test(a.question))?.answer).toBe('$150k');
    expect(profile.answers.filter((a) => a.question.startsWith('Saved answer'))).toHaveLength(2);
    expect(fromSiteKit(undefined).firstName).toBe('');
  });
});
