// What job an application page is for (title, company, location, description), and whether the
// page is the "thank you, we got your application" confirmation.

import { type JobInfo, MAX_DESCRIPTION } from '../core/applications';
import { siteOf } from './engine';

const textOf = (el: Element | null | undefined): string =>
  ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const meta = (doc: Document, prop: string) => doc.querySelector<HTMLMetaElement>(`meta[property="${prop}"], meta[name="${prop}"]`)?.content?.trim() ?? '';

function greenhouse(doc: Document): JobInfo {
  const url = new URL(doc.location.href);
  // An embedded form (…/embed/job_app?for=acme&token=123) stands for the job's own board page.
  const board = url.searchParams.get('for');
  const token = url.searchParams.get('token');
  const canonical = board && token ? `https://job-boards.greenhouse.io/${board}/jobs/${token}` : url.href.replace(/\/confirmation(?=$|[?#])/, '');
  // <title>Job Application for Account Executive at Cloudflare</title>
  const fromTitle = doc.title.match(/^Job Application for (.+) at (.+)$/);
  return {
    url: canonical,
    title: textOf(doc.querySelector('.job__title h1, .app-title')) || meta(doc, 'og:title') || fromTitle?.[1],
    company: fromTitle?.[2]?.trim()
      || textOf(doc.querySelector('.company-name')).replace(/^at\s+/i, '')
      || doc.querySelector<HTMLImageElement>('img[alt$=" Logo"]')?.alt.replace(/ Logo$/, '')
      || board || '',
    location: textOf(doc.querySelector('.job__location, .location')),
    description: textOf(doc.querySelector('.job__description, #content')).slice(0, MAX_DESCRIPTION),
    site: 'Greenhouse',
  };
}

/**
 * Workday's application steps don't show the posting, so its details come from Workday's own
 * JSON for the job (same site, so no extra permission): /wday/cxs/{tenant}/{site}/job/….
 */
async function workday(doc: Document): Promise<JobInfo> {
  const url = new URL(doc.location.href);
  const path = url.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '');
  const [, site, ...rest] = path.split('/');
  const jobPath = rest.join('/').replace(/\/(apply|login|autofillWithResume|applyManually|useMyLastApplication)(\/.*)?$/i, '');
  const canonical = `${url.origin}/${site}/${jobPath}`;
  const onPage: JobInfo = {
    url: canonical,
    title: textOf(doc.querySelector('[data-automation-id="jobPostingHeader"]')),
    description: textOf(doc.querySelector('[data-automation-id="jobPostingDescription"]')).slice(0, MAX_DESCRIPTION),
    location: textOf(doc.querySelector('[data-automation-id="locations"] dd, [data-automation-id="locations"]')),
    site: 'Workday',
  };
  if (!site || !jobPath.startsWith('job/')) return onPage;
  try {
    const tenant = url.hostname.split('.')[0];
    const res = await fetch(`${url.origin}/wday/cxs/${tenant}/${site}/${jobPath}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return onPage;
    const data = await res.json() as { jobPostingInfo?: Record<string, string>; hiringOrganization?: { name?: string } };
    const info = data.jobPostingInfo ?? {};
    const html = new DOMParser().parseFromString(info.jobDescription ?? '', 'text/html');
    return {
      ...onPage,
      title: info.title || onPage.title,
      company: data.hiringOrganization?.name || tenant,
      location: info.location || onPage.location,
      description: (html.body.textContent ?? '').trim().slice(0, MAX_DESCRIPTION) || onPage.description,
    };
  } catch {
    return onPage;
  }
}

/** Lever's application page (…/apply) has no description, so it's read from the posting page (same site). */
async function lever(doc: Document): Promise<JobInfo> {
  const url = new URL(doc.location.href);
  const [, company = '', id = ''] = url.pathname.split('/');
  const canonical = `${url.origin}/${company}/${id}`;
  // <title>Palantir Technologies - Administrative Business Partner</title>
  const [, org = '', title = ''] = doc.title.match(/^(.+?) - (.+)$/) ?? [];
  const info: JobInfo = { url: canonical, title, company: org || company, site: 'Lever' };
  const read = (d: Document) => ({
    location: textOf(d.querySelector('.posting-categories .location, .posting-categories .sort-by-location')),
    description: [...d.querySelectorAll('[data-qa="job-description"], [data-qa="posting-requirements"], [data-qa="closing-description"]')]
      .map(textOf).filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION),
  });
  const here = read(doc);
  if (here.description || !id) return { ...info, ...here };
  try {
    const res = await fetch(canonical);
    return res.ok ? { ...info, ...read(new DOMParser().parseFromString(await res.text(), 'text/html')) } : info;
  } catch {
    return info;
  }
}

export async function jobInfo(doc: Document): Promise<JobInfo | null> {
  const site = siteOf(doc.location.hostname);
  if (site === 'Greenhouse') return greenhouse(doc);
  if (site === 'Workday') return workday(doc);
  if (site === 'Lever') return lever(doc);
  return null;
}

// Not "thank you for your interest": job descriptions say that too.
const THANKS = /thank you for (applying|your application)|application (has been |was )?(received|submitted)|we('ve| have) received your application|successfully (applied|submitted)/i;

export const isSubmitButton = (el: Element): boolean =>
  /^\s*submit( (my |your )?application)?\s*$/i.test(textOf(el)) || /submit/i.test(el.getAttribute('data-automation-id') ?? '');

const SUBMIT_CANDIDATES = 'button, input[type="submit"], [role="button"]';

/**
 * Whether this page confirms a submitted application. Greenhouse sends you to …/confirmation.
 * Otherwise it takes a "thank you" message shortly after a Submit click on this job, with the
 * Submit button gone: a form sent back with errors still has it, and a Workday dashboard that
 * lists past applications as "submitted" never had a recent click.
 */
export function isConfirmation(doc: Document, submittedRecently: boolean): boolean {
  const site = siteOf(doc.location.hostname);
  if (site === 'Greenhouse' && /\/confirmation\/?$/.test(doc.location.pathname)) return true;
  if (site === 'Lever' && /\/thanks\/?$/.test(doc.location.pathname)) return true;
  if (!submittedRecently || !THANKS.test(doc.body?.innerText ?? doc.body?.textContent ?? '')) return false;
  return ![...doc.querySelectorAll(SUBMIT_CANDIDATES)].some((el) => isSubmitButton(el) && el.getClientRects().length > 0);
}
