import { describe, expect, it } from 'vitest';
import { fieldKey, findAnswer, isSensitive, pickOption, resolveValue } from '../src/core/fields';
import { emptyProfile, type Profile } from '../src/core/profile';

const profile = (): Profile => ({
  ...emptyProfile(),
  firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com', phone: '555-0100',
  city: 'Austin', state: 'TX', linkedin: 'https://linkedin.com/in/sam',
  workAuthorized: 'yes', needsSponsorship: 'no',
  work: [{ company: 'Acme', title: 'Engineer', location: '', start: '2022-01', end: '', current: true, description: '' }],
  answers: [
    { question: 'What are your salary expectations?', answer: '$150k' },
    { question: 'How did you hear about this job?', answer: 'Hacker News' },
    { question: 'Why do you want to work here?', answer: '' },
  ],
});

describe('fieldKey', () => {
  it.each([
    ['First Name*', 'firstName'], ['Preferred First Name', 'preferredName'], ['Last Name', 'lastName'],
    ['Email Address', 'email'], ['Phone', 'phone'], ['Phone Device Type', 'phoneType'],
    ['LinkedIn Profile', 'linkedin'],
    ['Would you like to include your LinkedIn profile, personal website or blog?', 'linkedin'],
    ['Are you legally authorized to work in the United States?', 'workAuthorized'],
    ['Do you now or will you in the future require immigration sponsorship to work at Cloudflare?', 'needsSponsorship'],
    ['Will you be able to work in the US without visa sponsorship?', 'noSponsorship'],
    ['Location (City)', 'location'], ['Address Line 1', 'address1'], ['Postal Code', 'postalCode'],
    ['City', 'city'], ['State', 'state'], ['Country', 'country'], ['Current Company', 'currentCompany'],
  ])('%s -> %s', (label, key) => {
    expect(fieldKey(label)).toBe(key);
  });

  it('leaves alone what it shouldn\'t guess', () => {
    expect(fieldKey('Legal Name (if different than above)')).toBeNull();
    expect(fieldKey('Address Line 2')).toBeNull();
    expect(fieldKey('Are you willing to relocate to our office in a different city within six months?')).toBeNull();
  });
});

describe('isSensitive', () => {
  it('flags self-identification questions only', () => {
    for (const l of ['Gender', 'Are you Hispanic/Latino?', 'Veteran Status', 'Disability Status', 'Race']) expect(isSensitive(l)).toBe(true);
    for (const l of ['First Name', 'How did you hear about this job?', 'Manager name']) expect(isSensitive(l)).toBe(false);
  });
});

describe('findAnswer', () => {
  const { answers } = profile();
  it('matches the same question phrased differently', () => {
    expect(findAnswer('How did you hear about us?', answers)).toBe('Hacker News');
    expect(findAnswer('Desired compensation', answers)).toBe('$150k');
    expect(findAnswer('What are your salary expectations?', answers)).toBe('$150k');
  });
  it('skips empty answers and unrelated questions', () => {
    expect(findAnswer('Why do you want to work at Acme?', answers)).toBe('');
    expect(findAnswer('Describe a hard bug you fixed', answers)).toBe('');
  });
});

describe('resolveValue', () => {
  it('uses profile fields, inverts "without sponsorship", and keeps text boxes to saved answers', () => {
    const p = profile();
    expect(resolveValue('First Name', p, 'short')).toBe('Sam');
    expect(resolveValue('Location (City)', p, 'choice')).toBe('Austin, TX');
    expect(resolveValue('Can you work here without sponsorship?', p, 'choice')).toBe('Yes');
    expect(resolveValue('Do you require visa sponsorship?', p, 'choice')).toBe('No');
    expect(resolveValue('First Name', p, 'long')).toBe('');
  });
});

describe('pickOption', () => {
  it('matches yes/no answers by their first word', () => {
    expect(pickOption(['Select...', 'No, I do not', 'Yes, I do'], 'Yes')).toBe(2);
    expect(pickOption(['Yes', 'No'], 'No')).toBe(1);
  });
  it('knows state abbreviations and ways to write the US', () => {
    expect(pickOption(['Select One', 'Tennessee', 'Texas'], 'TX')).toBe(2);
    expect(pickOption(['Canada', 'United States of America'], 'United States')).toBe(1);
    expect(pickOption(['Canada', 'United States'], 'USA')).toBe(1);
  });
  it('never picks a placeholder and returns -1 when nothing fits', () => {
    expect(pickOption(['Select One', 'Mobile', 'Landline'], 'Mobile')).toBe(1);
    expect(pickOption(['Select One', 'Red', 'Blue'], 'Green')).toBe(-1);
    expect(pickOption(['Select One'], '')).toBe(-1);
  });
});
