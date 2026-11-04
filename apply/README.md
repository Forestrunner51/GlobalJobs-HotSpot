# Application prep

Generates the prep work for a job application: a one-page memo PDF (who you worked for, what
you know, what you did, one accomplishment) tailored to the posting, a short email, and answers for
the questions application forms ask. Nothing is sent or submitted. You review the files and apply
yourself.

## Setup

```sh
.venv/bin/pip install -r apply/requirements.txt
cp apply/profile.example.md apply/profile.md   # then fill it in
export ANTHROPIC_API_KEY=sk-ant-...            # from console.anthropic.com
```

`profile.md`, `out/` and `tracker.csv` are git-ignored, so your personal details stay out of the repo.

## Use

```sh
# from a URL (sites that load postings with JavaScript, like LinkedIn, need the paste option)
.venv/bin/python apply/jobprep.py prep --url https://company.com/careers/123 --to hiring@company.com

# from copied text
pbpaste | .venv/bin/python apply/jobprep.py prep --to hiring@company.com

# from the site's Job postings tab: press "Copy for prep" on a posting, then
pbpaste | .venv/bin/python apply/jobprep.py prep

# several at once: save postings on the site, press "Download saved for prep", then
.venv/bin/python apply/jobprep.py batch ~/Downloads/prep-batch-2026-10-19.json
# lists them and asks before making any API calls; skips postings already prepped (--redo to override)

# add context the posting doesn't have
... prep --file posting.txt --note "Referred by Sam on their platform team"
```

Each run creates `apply/out/<date>_<company>_<role>/` containing:

| File | What it is |
| --- | --- |
| `<name>-<company>.pdf` | The memo to attach |
| `email.txt` | To, subject and body, ready to paste |
| `answers.txt` | "Why this company?", "Why this role?" and a short cover note, to paste into the application form |
| `review.txt` | Requirements you don't cover yet, and claims to double-check |
| `memo.json` | Memo content. Edit it, then run `render <folder>` to rebuild the PDF |
| `posting.txt` | The posting, kept for later reference |

## Tracking

```sh
.venv/bin/python apply/jobprep.py list                 # all applications; flags due follow-ups
.venv/bin/python apply/jobprep.py mark <id> sent       # sets a follow-up date 6 days out
.venv/bin/python apply/jobprep.py mark <id> followed-up
.venv/bin/python apply/jobprep.py mark <id> replied    # or interview / rejected / offer
```

Each posting costs about one Claude Opus 5.5 call, usually a few cents. Postings copied or downloaded
from the site carry a `Job ID`, which is recorded in `tracker.csv` so `batch` can skip ones already done.

On the site, **My applications** tracks what you've saved, applied to and hidden, with follow-up
reminders; the **apply kit** holds your standard form answers (name, links, work authorization, …)
with a Copy button each. Both live only in your browser. Tests: `.venv/bin/python -m unittest tests/test_jobprep.py`
(Claude is stubbed, so they're free).
