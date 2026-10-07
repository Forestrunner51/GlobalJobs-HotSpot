# Application prep

Generates the prep work for one job application: a one-page memo PDF (who you worked for, what
you know, what you did, one accomplishment) tailored to the posting, plus a short email. Nothing
is sent. You review the files and send the email yourself.

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

# add context the posting doesn't have
... prep --file posting.txt --note "Referred by Sam on their platform team"
```

Each run creates `apply/out/<date>_<company>_<role>/` containing:

| File | What it is |
| --- | --- |
| `<name>-<company>.pdf` | The memo to attach |
| `email.txt` | To, subject and body, ready to paste |
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

Each `prep` costs about one Claude Opus 5.5 call, usually a few cents.
