import { describe, expect, it } from 'vitest';
import { mergeResume, readResume } from '../src/core/resume';
import { emptyProfile } from '../src/core/profile';

// Text as pdf-text.ts produces it: one line per baseline, right-aligned dates on the same line.
const CLASSIC = `Jordan Lee
Austin, TX • (512) 555-0147 • jordan.lee@example.com • linkedin.com/in/jordanlee • github.com/jlee
SUMMARY
Backend engineer who likes boring, reliable systems.
TECHNICAL SKILLS
Languages: Go, Python, SQL
Cloud & DevOps: AWS (Lambda, SQS), Docker, Kubernetes, CI/CD, cloud
migration
PROFESSIONAL EXPERIENCE
Senior Software Engineer Mar 2021 – Present
Acme Corp — Austin, TX
• Built the billing pipeline that processes
2M events a day.
• Cut deploy time by 40%.
Software Engineer Intern Summers 2019 & 2020
Initech — Dallas, TX
• Wrote internal tools.
EDUCATION & CERTIFICATIONS
B.S. in Computer Science, Minor in Math Aug 2016 – May 2020
University of Texas at Austin — Austin, TX
AWS Certified Developer • Stanford University — Certificate in AI`;

// Company first, pipes, school before degree, numeric dates.
const COMPANY_FIRST = `Priya Nair
priya@example.org | 415-555-0199 | San Francisco, CA | priya.dev
Experience
Globex Inc | San Francisco, CA 06/2022 - 09/2024
Staff Engineer
- Led the search team.
Work History
Education
Stanford University 2014 - 2018
Master of Science in Electrical Engineering
Skills
Rust; C++; Distributed systems`;

describe('readResume', () => {
  it('reads the header, jobs, schools and skills of a typical resume', () => {
    const r = readResume(CLASSIC);
    expect(r).toMatchObject({
      firstName: 'Jordan', lastName: 'Lee', email: 'jordan.lee@example.com', phone: '(512) 555-0147',
      city: 'Austin', state: 'TX', linkedin: 'https://linkedin.com/in/jordanlee', github: 'https://github.com/jlee',
    });
    expect(r.work).toEqual([
      { title: 'Senior Software Engineer', company: 'Acme Corp', location: 'Austin, TX', start: '2021-03', end: '', current: true,
        description: 'Built the billing pipeline that processes 2M events a day.\nCut deploy time by 40%.' },
      { title: 'Software Engineer Intern', company: 'Initech', location: 'Dallas, TX', start: '', end: '', current: false,
        description: 'Wrote internal tools.' },
    ]);
    expect(r.education).toEqual([{ school: 'University of Texas at Austin', degree: 'Bachelor of Science', field: 'Computer Science', start: '2016-08', end: '2020-05' }]);
    expect(r.skills).toEqual(['Go', 'Python', 'SQL', 'AWS', 'Lambda', 'SQS', 'Docker', 'Kubernetes', 'CI/CD', 'cloud migration']);
  });

  it('handles company-first entries, pipes, numeric dates and school-first education', () => {
    const r = readResume(COMPANY_FIRST);
    expect(r).toMatchObject({ firstName: 'Priya', email: 'priya@example.org', city: 'San Francisco', state: 'CA', portfolio: 'https://priya.dev' });
    expect(r.work).toEqual([{ title: 'Staff Engineer', company: 'Globex Inc', location: 'San Francisco, CA', start: '2022-06', end: '2024-09', current: false, description: 'Led the search team.' }]);
    expect(r.education).toEqual([{ school: 'Stanford University', degree: 'Master of Science', field: 'Electrical Engineering', start: '', end: '' }]);
    expect(r.skills).toEqual(['Rust', 'C++', 'Distributed systems']);
  });
});

describe('mergeResume', () => {
  it('takes what the resume has and keeps everything it doesn\'t cover', () => {
    const before = { ...emptyProfile(), firstName: 'Jordan', linkedin: 'https://linkedin.com/in/old', workAuthorized: 'yes' as const, needsSponsorship: 'no' as const, address1: '1 Main St' };
    before.answers[1].answer = '$150k';
    const { profile, changed } = mergeResume(before, readResume(CLASSIC));
    expect(profile).toMatchObject({ firstName: 'Jordan', lastName: 'Lee', linkedin: 'https://linkedin.com/in/jordanlee', workAuthorized: 'yes', needsSponsorship: 'no', address1: '1 Main St' });
    expect(profile.answers[1].answer).toBe('$150k');
    expect(changed).toEqual(['last name', 'email', 'phone', 'city', 'state', 'LinkedIn', 'GitHub', 'work history (2 jobs)', 'education', 'skills (10)']);
  });

  it('reports nothing changed when the resume matches the profile', () => {
    const first = mergeResume(emptyProfile(), readResume(CLASSIC)).profile;
    expect(mergeResume(first, readResume(CLASSIC)).changed).toEqual([]);
  });
});
