# Job Application Autofill (browser extension)

Fills in the job application on the page you're looking at, from a profile saved in your browser,
when you click **Fill**. It never submits a form, never clicks buttons for you, and never acts on
pages you didn't open. You review every field and submit the application yourself.

Works in Chrome, Brave and Edge (Manifest V3). Firefox compatibility is kept in mind but not tested.

## Status

| Phase | What | State |
| --- | --- | --- |
| 1 | Skeleton: manifest, build, popup, profile editor, storage, import/export | **Done** |
| 2 | Greenhouse: fill fields, attach resume, match saved answers | **Done** |
| 3 | Lever | **Done** |
| 4 | Tracking: application history, detect a submitted application, sync with the job site, apply queue | **Done** |
| 5 | Workday: one step at a time, you click Next | **Done** (basic, see Limits) |

| 6 | Several resumes, follow-up reminders, queue limits, weekly backup, Claude drafts | **Done** |

The popup also recognizes Ashby and iCIMS pages and says filling for them isn't built yet.

## Using it

**Resumes.** On the profile page, **Add a resume PDF** reads the resume (with PDF.js, inside the
extension) and fills in your name, contact details, links, jobs, schools and skills. What changed
is highlighted; nothing is kept until you click **Save**. Keep as many resumes as you like:

- The newest one is used for applications, so adding an updated resume is all it takes. The
  profile refreshes from it and keeps what a resume doesn't cover (work eligibility, saved
  answers, street address).
- To send a different resume for certain jobs, give it words to look for in the job title
  (*Use for job titles with*: `devsecops, security`). A title with any of them, as a whole word,
  gets that resume; other jobs get the newest resume with no words set.
- The popup says which resume it attached. Scanned (image-only) PDFs have no text to read.

**Filling an application.** Open the application form, click the extension icon, then **Fill this application**. It fills
the empty fields it has an answer for, outlines them in green, attaches your resume, and lists
the required fields still empty. Fields you already typed in are never changed.

- **Greenhouse**: works on `job-boards.greenhouse.io` and on company careers pages that embed
  the form (`?gh_jid=` in the URL).
- **Lever**: works on `jobs.lever.co` application pages (…/apply). Its location box suggests
  places as you type; pick one from its list if it asks.
- **Workday**: sign in and start the application, then click **Fill** on each step. You click
  **Next** yourself.

**Drafting open questions (optional).** With your own Anthropic API key on the profile page,
**Draft open questions with Claude** in the popup writes first drafts for the empty questions no
profile field or saved answer covers ("Why do you want to work here?"), outlined in orange for you
to edit. It uses Claude Opus 5.5 with Anthropic's server-side fallback if the model declines.
Sent to Anthropic: the job's title, company and description, the questions, and your work history,
education, skills and saved answers. Never sent: your name, email, phone, address or links. Each
draft uses a few cents of API credit. Questions Claude has no facts for are left blank.

Which value goes where comes from the field's label (`src/core/fields.ts`): name, email, phone,
address, LinkedIn/GitHub/portfolio, work authorization and sponsorship (including "without
sponsorship" questions, answered the other way round), current company and title, and school.
Other questions get one of your saved answers when the question matches closely enough.
Voluntary self-identification questions (gender, race, veteran, disability) and checkboxes such
as privacy acknowledgements are always left for you.

**Application history.** **My applications** (in the popup, or **Application history** on the
job site) lists every job you filled, submitted or marked applied, with company, title,
location, link, dates and the full job description as it was when you applied. Change a job's
status (Applied, Interviewing, Offer, Rejected, Withdrawn), add notes, search, export CSV, and
back up or restore the list.

- Clicking **Fill** records the job as *In progress*.
- Submitting marks it *Applied*: on Greenhouse when the confirmation page loads; elsewhere when a
  "thank you for applying" message appears within 15 minutes of clicking a Submit button for
  that job. If it misses one, click **I applied to this job** in the popup, or **Mark applied** in
  the list.
- On Workday the description comes from Workday's own job data, and on Lever from the posting
  page, since their application pages don't show it.
- **Follow-ups**: an application is due for a follow-up 6 days after you applied (as on the job
  site). The toolbar icon shows how many are due; **I followed up** sets the next one 6 days out.
  Moving it to Interviewing, Offer, Rejected or Withdrawn stops the reminders.
- **Backups**: the list lives only in this browser. **Back up** saves a file; the profile page can
  turn on a weekly backup to `Downloads/job-autofill-backups/` (off by default; asks for the
  downloads permission when you turn it on). The page reminds you when it's been 2 weeks.

**Apply queue (with the job site).** On the job site, save the postings you want, then **Apply to
saved with Autofill** under My applications. Up to 10 open in new tabs and fill themselves in,
within your limits on the profile page (default: 15 new applications a day, 3 per company in 30
days; skipped jobs are listed with the reason). They
(on Workday, again after each Next). Check each one and submit it yourself. Marking a posting
applied on the site adds it to the history with its description; jobs the extension sees you
submit show as applied on the site. The site is the GitHub Pages copy or a local server on
`localhost`/`127.0.0.1`.

## Setup

```sh
cd extension
npm install
npm run build        # typecheck + build the pages and the content script into extension/dist/
npm test             # unit tests (Vitest)
npm run watch        # rebuild on save while developing
```

### Load it in Brave (Chrome and Edge are the same)

1. Open `brave://extensions` (Chrome: `chrome://extensions`, Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/dist` folder.
4. Pin it: puzzle-piece icon in the toolbar → pin **Job Application Autofill**.
5. Click the icon → **Edit profile**, fill it in, attach your resume PDF, **Save**.

After `npm run build` again, click the reload arrow on the extension's card in `brave://extensions`.

To skip retyping the basics: on the job site, **My applications → Export, back up, restore → Back
up**, then on the profile page **Import…** that file. It fills name, email, phone, city/state,
links, work authorization, sponsorship, salary, "how did you hear" and your saved answers.

## Architecture

```
extension/
  public/manifest.json      MV3 manifest, copied into dist/ as is
  src/
    core/
      resume.ts             Resume text → name, contact, jobs, schools, skills; merging into a profile (pure, tested)
      applications.ts       Application history: job keys, statuses, follow-ups, queue limits, CSV/backup (pure, tested)
      resumes.ts            Several resumes and which one a job gets (pure, tested)
      settings.ts           Queue limits, weekly backup, Anthropic API key
      fields.ts             Label → profile value, saved-answer matching, dropdown option matching (pure, tested)
      profile.ts            Profile model, normalizing untrusted input, export/import (pure, tested)
      ats.ts                Which applicant tracking system a URL belongs to (pure, tested)
      storage.ts            chrome.storage.local wrappers, resume file → base64
    content/
      engine.ts             Finds the form's fields and fills them: text, selects, react-select (Greenhouse),
                            dropdown buttons (Workday), yes/no radios, resume upload (tested with happy-dom)
      jobinfo.ts            Job title/company/description from the page (or Workday's job data), confirmation pages
      fill.ts               Content script on Greenhouse/Workday: Fill, history, submission watch, queued autofill
      site.ts               Content script on the job site: apply queue and status sync via postMessage
    background.ts           Service worker: apply queue (with limits), follow-up badge, weekly backup, drafting
    draft.ts                Drafts open questions with the Claude API (@anthropic-ai/sdk)
    applications/           My applications page
    popup/                  Toolbar popup: this page's status, Fill button and its report, profile summary
    options/                Full-page profile editor (opened from the popup); pdf-text.ts reads PDF text with PDF.js
    ui.css                  Shared styles; follows system light/dark
  tests/                    Vitest unit tests
```

The content script is injected only into the active tab, and only when you click **Fill**. It
sets values with the native setter and fires `input`/`change`/`blur` events so React-controlled
fields register them, and opens dropdowns the way a click or the arrow key would.

## Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Keep your profile, resumes and application history (with job descriptions) on this device. |
| `alarms` | Hourly: update the follow-ups count on the icon, and run the weekly backup if you turned it on. |
| `downloads` (optional) | Asked for only when you turn on the weekly backup. |
| `activeTab` | Read the current tab's URL and fill it, only after you click the extension. |
| `scripting` | Inject the filling script into a company page that embeds a Greenhouse form, when you click **Fill**. |
| Greenhouse, Lever and Workday sites | Notice when you submit an application, and fill queued tabs by themselves. Nothing is filled there unless you click **Fill** or opened the tab from the apply queue. |

It also runs on the job site (`forestrunner51.github.io/GlobalJobs-HotSpot`, `localhost`,
`127.0.0.1`) to connect the two. Showing a page there isn't a permission prompt in Chrome.

## Privacy

- Your profile, resume and application history are stored only in this browser's extension storage.
- The extension sends nothing anywhere on its own: no analytics, no uploads. It reads job details
  from the site you're applying on (Workday's job data, Lever's posting page).
- Drafting sends the details listed above to Anthropic, only when you click **Draft** and only
  if you added your own API key. The key is kept in this browser's extension storage.
- Export writes a JSON file you control. It includes your resume only if the box is ticked.
- Remove everything by removing the extension, or clear the fields and **Save**.

## Limits

- Resume PDFs up to 5 MB (extension storage holds 10 MB without extra permissions).
- Workday: work experience and education entries (behind **Add** buttons), search-as-you-type
  lists such as "How did you hear about us?", and date fields are left for you. Workday usually
  fills experience from your resume anyway.
- Matching goes by label wording, so an unusually worded question may be skipped or, rarely,
  get the wrong saved answer. That's why everything filled is outlined for review.
- Minimum Chrome 116 (Brave and Edge track Chromium versions).
