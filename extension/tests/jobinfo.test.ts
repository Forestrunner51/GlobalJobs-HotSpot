// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { isConfirmation, isSubmitButton, jobInfo } from '../src/content/jobinfo';

const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);

describe('Greenhouse job details', () => {
  it('reads title, company, location and description from the job page', async () => {
    setUrl('https://job-boards.greenhouse.io/acme/jobs/123');
    document.title = 'Job Application for Platform Engineer at Acme Robotics';
    document.body.innerHTML = `<div class="job__header"><div class="job__title"><h1>Platform Engineer</h1>
      <div class="job__location">Austin, TX</div></div></div>
      <div class="job__description body"><p>Build the platform.</p><p>Kubernetes, Go.</p></div>`;
    expect(await jobInfo(document)).toMatchObject({
      url: 'https://job-boards.greenhouse.io/acme/jobs/123', title: 'Platform Engineer', company: 'Acme Robotics',
      location: 'Austin, TX', site: 'Greenhouse',
    });
    expect((await jobInfo(document))?.description).toContain('Build the platform.');
  });

  it('points an embedded form at the job\'s own board page', async () => {
    setUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123');
    document.title = '';
    document.body.innerHTML = '';
    expect((await jobInfo(document))?.url).toBe('https://job-boards.greenhouse.io/acme/jobs/123');
  });

  it('knows the confirmation page by its address', () => {
    setUrl('https://job-boards.greenhouse.io/acme/jobs/123/confirmation');
    document.body.innerHTML = '<h1>Thank you for applying.</h1>';
    expect(isConfirmation(document, false)).toBe(true);
  });
});

describe('Workday confirmation', () => {
  it('needs a recent Submit click as well as a thank-you message', () => {
    setUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Engineer_R1/apply');
    document.body.innerHTML = '<div>Application Submitted</div>';
    expect(isConfirmation(document, true)).toBe(true);
    expect(isConfirmation(document, false)).toBe(false);
  });

  it('doesn\'t count a form sent back with errors, or "thank you for your interest" in a description', () => {
    setUrl('https://job-boards.greenhouse.io/acme/jobs/123');
    document.body.innerHTML = '<p>Thank you for your interest in Acme.</p><button>Submit application</button>';
    expect(isConfirmation(document, true)).toBe(false);
    document.body.innerHTML = '<p>Thank you for applying!</p><button>Submit application</button>';
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    expect(isConfirmation(document, true)).toBe(false);
    vi.restoreAllMocks();
  });

  it('recognizes submit buttons by their text', () => {
    const b = document.createElement('button');
    for (const [text, ok] of [['Submit', true], ['Submit Application', true], ['Save and Continue', false], ['Submit feedback form', false]] as const) {
      b.textContent = text;
      expect(isSubmitButton(b)).toBe(ok);
    }
  });
});
