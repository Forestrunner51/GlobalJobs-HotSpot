// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fillPage, openQuestions } from '../src/content/engine';
import { emptyProfile, type Profile, type StoredResume } from '../src/core/profile';

const profile: Profile = {
  ...emptyProfile(),
  firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com', phone: '555-0100', city: 'Austin', state: 'TX',
  linkedin: 'https://linkedin.com/in/sam', workAuthorized: 'yes', needsSponsorship: 'no',
  answers: [{ question: 'How did you hear about this job?', answer: 'Hacker News' }],
};
const resume: StoredResume = { name: 'sam.pdf', type: 'application/pdf', size: 3, data: btoa('pdf'), savedAt: '' };

const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** A stand-in for react-select: ArrowDown opens a menu of options; clicking one shows it as the value. */
function fakeReactSelect(id: string, options: string[]): void {
  const input = $<HTMLInputElement>(`#${id}`);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'ArrowDown') return;
    const menu = document.createElement('div');
    menu.id = `react-select-${id}-listbox`;
    input.setAttribute('aria-controls', menu.id);
    options.forEach((text, i) => {
      const o = document.createElement('div');
      o.setAttribute('role', 'option');
      o.id = `react-select-${id}-option-${i}`;
      o.textContent = text;
      o.addEventListener('click', () => {
        const v = document.createElement('div');
        v.className = 'select__single-value';
        v.textContent = text;
        input.closest('.select__control')!.prepend(v);
        menu.remove();
      });
      menu.append(o);
    });
    input.closest('.select-shell')!.append(menu);
  });
}

/** A stand-in for Workday's dropdown button: clicking opens a listbox; picking an option sets the button text. */
function fakeWorkdayDropdown(id: string, options: string[]): void {
  const button = $<HTMLButtonElement>(`#${id}`);
  button.addEventListener('click', () => {
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    for (const text of options) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = text;
      li.addEventListener('click', () => { button.textContent = text; list.remove(); });
      list.append(li);
    }
    document.body.append(list);
  });
}

beforeEach(() => {
  // happy-dom doesn't lay out, so treat every element as visible.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});

describe('Greenhouse', () => {
  beforeEach(() => {
    setUrl('https://job-boards.greenhouse.io/acme/jobs/1');
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name<span>*</span></label><input id="first_name" aria-required="true">
        <label for="last_name">Last Name*</label><input id="last_name" value="Already-typed">
        <label for="email">Email*</label><input id="email" type="email" aria-required="true">
        <label for="phone">Phone</label><input id="phone" type="tel">
        <label class="visually-hidden" for="resume">Resume/CV</label><input id="resume" type="file">
        <label for="cover_letter">Cover Letter</label><input id="cover_letter" type="file">
        <label for="q1">How did you hear about us?</label><input id="q1">
        <label for="q2">Why Acme?*</label><textarea id="q2" required></textarea>
        <div class="select-shell"><label id="q3-label" for="q3">Will you now or in the future require sponsorship?*</label>
          <div class="select__control"><input id="q3" role="combobox" aria-labelledby="q3-label" aria-required="true"></div></div>
        <label for="gender">Gender</label><select id="gender"><option value="">Select...</option><option>Female</option></select>
        <input type="checkbox" id="privacy" required><label for="privacy">I acknowledge the privacy policy</label>
      </form>`;
    fakeReactSelect('q3', ['Yes', 'No']);
  });

  it('fills empty fields, attaches the resume, and reports what still needs the applicant', async () => {
    const report = await fillPage(document, profile, resume);
    expect($<HTMLInputElement>('#first_name').value).toBe('Sam');
    expect($<HTMLInputElement>('#last_name').value).toBe('Already-typed');
    expect($<HTMLInputElement>('#email').value).toBe('sam@example.com');
    expect($<HTMLInputElement>('#q1').value).toBe('Hacker News');
    expect($<HTMLInputElement>('#resume').files?.[0]?.name).toBe('sam.pdf');
    expect($<HTMLInputElement>('#cover_letter').files?.length ?? 0).toBe(0);
    expect(document.querySelector('.select__single-value')?.textContent).toBe('No');
    expect($<HTMLSelectElement>('#gender').value).toBe('');
    expect($<HTMLInputElement>('#privacy').checked).toBe(false);
    expect(report).toMatchObject({
      site: 'Greenhouse', resume: 'attached', sensitive: 1, left: ['Why Acme?'],
      filled: ['First Name', 'Email', 'Phone', 'How did you hear about us?', 'Will you now or in the future require sponsorship?'],
    });
  });

  it('does nothing on pages that aren\'t a supported application site', async () => {
    setUrl('https://careers.example.com/jobs?gh_jid=1');
    expect(await fillPage(document, profile, resume)).toBeNull();
    expect($<HTMLInputElement>('#first_name').value).toBe('');
  });
});

describe('Workday', () => {
  beforeEach(() => {
    setUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Engineer_R1/apply');
    document.body.innerHTML = `
      <div data-automation-id="formField-legalName--firstName"><label for="name--legalName--firstName">First Name*</label>
        <input id="name--legalName--firstName" type="text" aria-required="true"></div>
      <div data-automation-id="formField-address--city"><label for="address--city">City</label><input id="address--city" type="text"></div>
      <div data-automation-id="formField-address--countryRegion"><label for="address--countryRegion">State*</label>
        <button id="address--countryRegion" aria-haspopup="listbox" aria-label="State Select One Required">Select One</button></div>
      <div data-automation-id="formField-source"><label>How Did You Hear About Us?*</label>
        <input data-automation-id="searchBox" type="text" aria-required="true"></div>
      <fieldset><legend>Are you legally authorized to work in the United States?*</legend>
        <input type="radio" name="auth" id="auth-y" value="true"><label for="auth-y">Yes</label>
        <input type="radio" name="auth" id="auth-n" value="false"><label for="auth-n">No</label></fieldset>
      <input type="file" data-automation-id="file-upload-input-ref">`;
    fakeWorkdayDropdown('address--countryRegion', ['Tennessee', 'Texas', 'Utah']);
  });

  it('fills text, dropdown buttons and yes/no radios, and leaves search lists alone', async () => {
    const report = await fillPage(document, profile, resume);
    expect($<HTMLInputElement>('#name--legalName--firstName').value).toBe('Sam');
    expect($<HTMLInputElement>('#address--city').value).toBe('Austin');
    expect($('#address--countryRegion').textContent).toBe('Texas');
    expect($<HTMLInputElement>('#auth-y').checked).toBe(true);
    expect($<HTMLInputElement>('[data-automation-id="file-upload-input-ref"]').files?.length).toBe(1);
    expect(report?.site).toBe('Workday');
    expect(report?.filled).toEqual(['First Name', 'City', 'State', 'Are you legally authorized to work in the United States?']);
  });
});

describe('Lever', () => {
  beforeEach(() => {
    setUrl('https://jobs.lever.co/acme/6ed76ce8-4156-4b60-b120-403538bd66cd/apply');
    document.body.innerHTML = `
      <ul>
        <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div>
          <div class="application-field"><input type="text" name="name" required></div></label></li>
        <li class="application-question"><label><div class="application-label">Current company</div>
          <div class="application-field"><input type="text" name="org"></div></label></li>
        <li class="application-question custom-question"><div><div class="application-label full-width"><div class="text">Are you legally authorized to work in the country for which you are applying?<span class="required">✱</span></div></div>
          <div class="application-field"><ul><li><label><input type="radio" name="cards[a][field0]" value="Yes" required><span>Yes</span></label></li>
          <li><label><input type="radio" name="cards[a][field0]" value="No" required><span>No</span></label></li></ul></div></div></li>
        <li class="application-question custom-question"><div><div class="application-label"><div class="text">Why do you want to work at Acme?</div></div>
          <div class="application-field"><textarea name="cards[b][field0]"></textarea></div></div></li>
      </ul>`;
  });

  it('fills name, company and yes/no questions, and lists open questions for drafting', async () => {
    const withJob = { ...profile, work: [{ company: 'JPMC', title: 'SWE', location: '', start: '', end: '', current: true, description: '' }] };
    const report = await fillPage(document, withJob, null);
    expect($<HTMLInputElement>('[name="name"]').value).toBe('Sam Rivera');
    expect($<HTMLInputElement>('[name="org"]').value).toBe('JPMC');
    expect($<HTMLInputElement>('[value="Yes"]').checked).toBe(true);
    expect(report?.site).toBe('Lever');
    expect(openQuestions(document, withJob).map((f) => f.label)).toEqual(['Why do you want to work at Acme?']);
  });
});
