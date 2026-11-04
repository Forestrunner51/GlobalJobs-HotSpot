"""Prep tailored job applications: a one-page memo PDF, an email draft, and answers for the
questions application forms ask ("Why this company?", a short cover note), per posting.

Nothing is sent or submitted. Each run writes a folder under apply/out/ for you to review, and
records the application in apply/tracker.csv so follow-ups don't slip.

    python apply/jobprep.py prep --url https://company.com/jobs/123 --to jane@company.com
    python apply/jobprep.py prep --file posting.txt
    pbpaste | python apply/jobprep.py prep
    python apply/jobprep.py batch ~/Downloads/prep-batch-2026-10-19.json   # saved postings from the site
    python apply/jobprep.py render apply/out/2026-10-07_acme_web-developer
    python apply/jobprep.py list
    python apply/jobprep.py mark 2026-10-07_acme_web-developer sent
"""

import argparse
import csv
import datetime as dt
import json
import re
import sys
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

import anthropic
from fpdf import FPDF
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
PROFILE = HERE / "profile.md"
OUT_DIR = HERE / "out"
TRACKER = HERE / "tracker.csv"
TRACKER_FIELDS = ["id", "created", "company", "role", "to", "status", "sent", "follow_up", "job_id", "url"]
FOLLOW_UP_DAYS = 6
MODEL = "claude-opus-5-5"


# ---------------------------------------------------------------- output schema

class Job(BaseModel):
    employer: str
    title: str
    dates: str
    bullets: list[str] = Field(description="2-3 bullets, most relevant to this posting first")


class Memo(BaseModel):
    candidate_name: str
    contact_line: str = Field(description="Email · phone · city · portfolio/GitHub, from the profile only")
    company: str
    role: str
    summary: str = Field(description="3-4 sentences: who I am and why I fit this specific role")
    experience: list[Job] = Field(description="1-3 most relevant jobs or projects")
    highlight_title: str = Field(description="Short title for the one accomplishment to feature")
    highlight: str = Field(description="3-5 sentences: the situation, what I did, the result")
    skills: list[str] = Field(description="Skills from the profile that the posting asks for, most important first")
    closing: str = Field(description="One or two sentences ending the memo")


class FormAnswers(BaseModel):
    why_company: str = Field(description="2-3 sentences answering 'Why do you want to work here?', tied to specifics in the posting")
    why_role: str = Field(description="2-3 sentences answering 'Why are you a good fit for this role?', citing profile facts")
    cover_note: str = Field(description="Under 150 words for a cover letter text box: who I am, the fit, one concrete result")


class Application(BaseModel):
    memo: Memo
    form_answers: FormAnswers
    email_subject: str
    email_body: str = Field(description="Under 150 words, mentions the attached memo, signed with name and contact")
    recipient_name: str = Field(description="Hiring manager or recruiter name if the posting gives one, else empty")
    gaps: list[str] = Field(description="Requirements in the posting the profile does not cover")
    verify: list[str] = Field(description="Anything in the memo or email the applicant should double-check")


SYSTEM = """You write job application materials for one applicant, using only the facts in their profile.

Rules:
- Never invent employers, titles, dates, skills, numbers or results. If the profile has no metric, describe the result in words.
- Pick the experience and the single accomplishment that best match what this posting asks for.
- Write plainly and specifically. No buzzwords ("passionate", "synergy", "rockstar"), no flattery of the company.
- If the posting asks for something the profile doesn't show, list it under gaps. Don't claim it.
- The email is short: who they are, the role, one concrete reason they fit, that a one-page memo is attached, a polite ask for a conversation.
- Form answers are for pasting into the employer's application form. Same rules: only facts from the profile and the posting, specific to this company and role, first person, no clichés."""


# ---------------------------------------------------------------- posting input

class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head"}

    def __init__(self):
        super().__init__()
        self.parts, self._skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.parts.append(data.strip())


def fetch_posting(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode(resp.headers.get_content_charset() or "utf-8", "replace")
    parser = _TextExtractor()
    parser.feed(html)
    text = "\n".join(parser.parts)
    if len(text) < 500:
        sys.exit(
            f"Only got {len(text)} characters from {url}. The site probably loads the posting with "
            "JavaScript or blocks scripts (LinkedIn does). Copy the posting text and run:\n"
            "  pbpaste | python apply/jobprep.py prep"
        )
    return f"Source: {url}\n\n{text}"


def read_posting(args) -> str:
    if args.url:
        return fetch_posting(args.url)
    if args.file:
        return Path(args.file).read_text()
    if sys.stdin.isatty():
        print("Paste the job posting, then press Ctrl-D:", file=sys.stderr)
    return sys.stdin.read()


# ---------------------------------------------------------------- generation

def generate(profile: str, posting: str, note: str) -> Application:
    user = f"<profile>\n{profile}\n</profile>\n\n<posting>\n{posting}\n</posting>"
    if note:
        user += f"\n\n<applicant_note>\n{note}\n</applicant_note>"
    response = anthropic.Anthropic().beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        output_config={"effort": "high"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": user}],
        output_format=Application,
    )
    if response.stop_reason == "refusal":
        sys.exit("The model declined this request. Try again or check the posting text.")
    if response.stop_reason == "max_tokens":
        sys.exit("Response was cut off (max_tokens). Try a shorter posting or profile.")
    return response.parsed_output


# ---------------------------------------------------------------- PDF

# fpdf's built-in fonts are Latin-1 only; map the usual typographic characters.
_LATIN1 = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                         "–": "-", "—": "-", "…": "...", "•": "-", " ": " "})


def _t(s: str) -> str:
    return s.translate(_LATIN1).encode("latin-1", "replace").decode("latin-1")


def render_pdf(memo: Memo, path: Path) -> None:
    pdf = FPDF(format="Letter")
    pdf.set_margins(18, 16, 18)
    pdf.set_auto_page_break(True, margin=16)
    pdf.add_page()
    w = pdf.epw

    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(w, 9, _t(memo.candidate_name), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(90, 90, 90)
    pdf.cell(w, 5, _t(memo.contact_line.replace("·", "|")), new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(180, 180, 180)
    pdf.line(pdf.l_margin, pdf.get_y() + 2, pdf.l_margin + w, pdf.get_y() + 2)
    pdf.ln(5)

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(w, 6, _t(f"Re: {memo.role} at {memo.company}"), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(w, 5, _t(memo.summary), new_x="LMARGIN", new_y="NEXT")

    def heading(text):
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 10.5)
        pdf.set_text_color(30, 70, 140)
        pdf.cell(w, 6, _t(text.upper()), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)

    heading("Experience")
    for job in memo.experience:
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(w * 0.7, 5.5, _t(f"{job.title}, {job.employer}"))
        pdf.set_font("Helvetica", "", 9.5)
        pdf.cell(w * 0.3, 5.5, _t(job.dates), align="R", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 10)
        for b in job.bullets:
            pdf.set_x(pdf.l_margin + 3)
            pdf.multi_cell(w - 3, 5, _t(f"-  {b}"), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(1)

    heading(f"Highlight: {memo.highlight_title}")
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(w, 5, _t(memo.highlight), new_x="LMARGIN", new_y="NEXT")

    heading("Relevant skills")
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(w, 5, _t(", ".join(memo.skills)), new_x="LMARGIN", new_y="NEXT")

    pdf.ln(4)
    pdf.multi_cell(w, 5, _t(memo.closing), new_x="LMARGIN", new_y="NEXT")
    pdf.output(str(path))


# ---------------------------------------------------------------- tracker

def load_tracker() -> list[dict]:
    if not TRACKER.exists():
        return []
    with TRACKER.open(newline="") as f:
        return list(csv.DictReader(f))


def save_tracker(rows: list[dict]) -> None:
    with TRACKER.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=TRACKER_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "x"


# ---------------------------------------------------------------- commands

def posting_meta(posting: str) -> tuple[str, str]:
    """The site's Job ID and the best link, from the header "Copy for prep" adds to a posting."""
    job_id = re.search(r"^Job ID: (\S+)", posting, re.M)
    url = re.search(r"^Apply: (\S+)", posting, re.M) or re.search(r"^Source: (\S+)", posting, re.M)
    return (job_id.group(1) if job_id else ""), (url.group(1) if url else "")


def require_profile() -> str:
    if not PROFILE.exists():
        sys.exit(f"Missing {PROFILE}. Copy profile.example.md to profile.md and fill it in.")
    return PROFILE.read_text()


def cmd_prep(args):
    profile = require_profile()
    posting = read_posting(args).strip()
    if not posting:
        sys.exit("No posting text given.")
    print("Writing memo, email and form answers...", file=sys.stderr)
    app_id, folder, notes = prep_one(profile, posting, args.to, args.note)
    print(f"\n{folder}\n")
    print("\n".join(notes))
    print(f"\nWhen you've sent it: python apply/jobprep.py mark {app_id} sent")


def prep_one(profile: str, posting: str, to: str | None = None, note: str = "") -> tuple[str, Path, list[str]]:
    """Generate and write one application folder; returns (id, folder, review notes)."""
    app = generate(profile, posting, note)
    memo = app.memo
    job_id, url = posting_meta(posting)

    today = dt.date.today().isoformat()
    app_id = f"{today}_{slug(memo.company)}_{slug(memo.role)}"
    folder = OUT_DIR / app_id
    n = 2
    while folder.exists():
        folder = OUT_DIR / f"{app_id}-{n}"
        n += 1
    app_id = folder.name
    folder.mkdir(parents=True)

    (folder / "posting.txt").write_text(posting)
    (folder / "memo.json").write_text(memo.model_dump_json(indent=2))
    pdf_name = f"{slug(memo.candidate_name)}-{slug(memo.company)}.pdf"
    render_pdf(memo, folder / pdf_name)
    greeting_to = f"{app.recipient_name} <{to}>" if app.recipient_name and to else to or ""
    (folder / "email.txt").write_text(
        f"To: {greeting_to}\nSubject: {app.email_subject}\nAttach: {pdf_name}\n\n{app.email_body}\n"
    )
    gaps = [f"- {g}" for g in app.gaps] or ["- none"]
    checks = [f"- {v}" for v in app.verify] or ["- nothing flagged"]
    notes = ["GAPS (posting asks for, profile doesn't show):", *gaps, "", "DOUBLE-CHECK:", *checks]
    (folder / "review.txt").write_text("\n".join(notes) + "\n")
    fa = app.form_answers
    (folder / "answers.txt").write_text(
        "Paste these into the application form. Check every sentence first.\n\n"
        f"WHY THIS COMPANY\n{fa.why_company}\n\nWHY THIS ROLE / WHY YOU\n{fa.why_role}\n\n"
        f"COVER NOTE\n{fa.cover_note}\n" + (f"\nAPPLY AT\n{url}\n" if url else ""))

    rows = load_tracker()
    rows.append({"id": app_id, "created": today, "company": memo.company, "role": memo.role,
                 "to": to or "", "status": "drafted", "sent": "", "follow_up": "", "job_id": job_id, "url": url})
    save_tracker(rows)
    return app_id, folder, [f"{memo.role} at {memo.company}", *notes]


def cmd_batch(args):
    """Prep every posting in a batch file downloaded from the site ("Download saved for prep")."""
    profile = require_profile()
    try:
        data = json.loads(Path(args.file).expanduser().read_text())
    except (OSError, ValueError) as e:
        sys.exit(f"Could not read {args.file}: {e}")
    if data.get("format") != "jobglobal-prep-batch":
        sys.exit(f"{args.file} isn't a prep batch from the site (use its \"Download saved for prep\" button).")
    done = {r.get("job_id") for r in load_tracker() if r.get("job_id")}
    postings = [p for p in data.get("postings", []) if args.redo or p.get("id") not in done]
    skipped = len(data.get("postings", [])) - len(postings)
    if skipped:
        print(f"Skipping {skipped} already prepped (use --redo to prep them again).")
    if not postings:
        print("Nothing to prep.")
        return
    for i, p in enumerate(postings, 1):
        print(f"  {i:>2}. {p.get('title', '?')} at {p.get('company', '?')}")
    if not args.yes:
        answer = input(f"\nPrep these {len(postings)}? Each is one Claude API call (usually a few cents). [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Cancelled.")
            return
    made, failed = [], []
    for i, p in enumerate(postings, 1):
        print(f"\n[{i}/{len(postings)}] {p.get('title')} at {p.get('company')}...", file=sys.stderr)
        try:
            app_id, folder, notes = prep_one(profile, p["text"], note=args.note)
        except (Exception, SystemExit) as e:  # one bad posting shouldn't stop the rest
            failed.append(f"{p.get('title')} at {p.get('company')}: {e}")
            print(f"  failed: {e}", file=sys.stderr)
            continue
        made.append((app_id, folder))
        print(f"  {folder}  (gaps and things to check: review.txt)")
    print(f"\nPrepped {len(made)} of {len(postings)}." + (f" {len(failed)} failed:" if failed else ""))
    for f in failed:
        print(f"  {f}")
    if made:
        print("\nFor each: read review.txt, send the email or open the posting and paste from answers.txt,")
        print("then: python apply/jobprep.py mark <id> sent   (ids are the folder names above)")


def cmd_render(args):
    folder = Path(args.folder)
    memo = Memo.model_validate_json((folder / "memo.json").read_text())
    pdfs = list(folder.glob("*.pdf"))
    path = pdfs[0] if pdfs else folder / f"{slug(memo.candidate_name)}-{slug(memo.company)}.pdf"
    render_pdf(memo, path)
    print(f"Rendered {path}")


def cmd_list(args):
    rows = load_tracker()
    if not rows:
        print("No applications yet.")
        return
    today = dt.date.today().isoformat()
    for r in rows:
        due = r["status"] == "sent" and r["follow_up"] and r["follow_up"] <= today
        flag = "  <- FOLLOW UP" if due else ""
        print(f"{r['created']}  {r['status']:<9} {r['company'][:24]:<24} {r['role'][:30]:<30} {r['id']}{flag}")


def cmd_mark(args):
    rows = load_tracker()
    matches = [r for r in rows if r["id"] == args.id]
    if not matches:
        sys.exit(f"No application with id {args.id}. Run `list` to see ids.")
    row = matches[0]
    row["status"] = args.status
    if args.status in ("sent", "followed-up"):
        today = dt.date.today()
        row["sent"] = row["sent"] or today.isoformat()
        row["follow_up"] = (today + dt.timedelta(days=FOLLOW_UP_DAYS)).isoformat()
        if args.status == "followed-up":
            row["status"] = "sent"
    save_tracker(rows)
    print(f"{row['id']}: {row['status']}" + (f", follow up on {row['follow_up']}" if row["follow_up"] else ""))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    prep = sub.add_parser("prep", help="Generate memo PDF + email for one posting")
    src = prep.add_mutually_exclusive_group()
    src.add_argument("--url", help="Job posting URL")
    src.add_argument("--file", help="Text file with the posting")
    prep.add_argument("--to", help="Recipient email, if you have one")
    prep.add_argument("--note", default="", help="Extra context, e.g. 'met them at a meetup'")
    prep.set_defaults(func=cmd_prep)

    batch = sub.add_parser("batch", help="Prep every posting in a batch file saved from the site")
    batch.add_argument("file", help="prep-batch-*.json from the site's \"Download saved for prep\"")
    batch.add_argument("--yes", action="store_true", help="Don't ask before making API calls")
    batch.add_argument("--redo", action="store_true", help="Also prep postings already in the tracker")
    batch.add_argument("--note", default="", help="Extra context added to every posting")
    batch.set_defaults(func=cmd_batch)

    render = sub.add_parser("render", help="Rebuild the PDF after editing memo.json")
    render.add_argument("folder")
    render.set_defaults(func=cmd_render)

    sub.add_parser("list", help="Show applications and due follow-ups").set_defaults(func=cmd_list)

    mark = sub.add_parser("mark", help="Update status: sent, followed-up, replied, interview, rejected")
    mark.add_argument("id")
    mark.add_argument("status", choices=["sent", "followed-up", "replied", "interview", "rejected", "offer"])
    mark.set_defaults(func=cmd_mark)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
