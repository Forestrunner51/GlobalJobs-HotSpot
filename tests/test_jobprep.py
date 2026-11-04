"""Offline tests for apply/jobprep.py; the Claude call is stubbed. Run with the venv:
    .venv/bin/python -m unittest tests/test_jobprep.py
"""

import builtins
import csv
import shutil
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apply"))
import jobprep as jp  # noqa: E402

POSTING = """Source: https://boards.example/acme/1
Apply: https://boards.example/acme/1/apply
Job ID: gh-acme-1

Rust Engineer
Acme · Seattle, WA

Build storage systems in Rust."""


def fake_app(company="Acme"):
    return jp.Application(
        memo=jp.Memo(candidate_name="Sam Lee", contact_line="sam@example.com", company=company, role="Rust Engineer",
                     summary="Backend developer.", experience=[jp.Job(employer="Beta", title="Developer", dates="2023-2025",
                                                                        bullets=["Built an API"])],
                     highlight_title="Faster site", highlight="Cut load time.", skills=["Rust"], closing="Thanks."),
        form_answers=jp.FormAnswers(why_company="Acme builds storage.", why_role="I build backends.", cover_note="Hello."),
        email_subject="Rust Engineer", email_body="Hi", recipient_name="", gaps=["Kubernetes"], verify=[])


class JobPrep(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.saved = (jp.PROFILE, jp.OUT_DIR, jp.TRACKER, jp.generate)
        jp.PROFILE, jp.OUT_DIR, jp.TRACKER = self.tmp / "profile.md", self.tmp / "out", self.tmp / "tracker.csv"
        jp.PROFILE.write_text("# Sam Lee")
        self.calls = []
        jp.generate = lambda profile, posting, note: self.calls.append(posting) or fake_app()

    def tearDown(self):
        jp.PROFILE, jp.OUT_DIR, jp.TRACKER, jp.generate = self.saved

    def test_posting_meta(self):
        self.assertEqual(jp.posting_meta(POSTING), ("gh-acme-1", "https://boards.example/acme/1/apply"))
        self.assertEqual(jp.posting_meta("just text"), ("", ""))

    def test_prep_writes_answers_and_links_tracker(self):
        app_id, folder, _ = jp.prep_one(jp.PROFILE.read_text(), POSTING)
        answers = (folder / "answers.txt").read_text()
        self.assertIn("WHY THIS COMPANY\nAcme builds storage.", answers)
        self.assertIn("APPLY AT\nhttps://boards.example/acme/1/apply", answers)
        self.assertTrue((folder / "sam-lee-acme.pdf").exists())
        row = list(csv.DictReader(io.StringIO(jp.TRACKER.read_text())))[0]
        self.assertEqual((row["id"], row["job_id"], row["status"]), (app_id, "gh-acme-1", "drafted"))

    def run_batch(self, file, answer="y", **flags):
        args = type("A", (), {"file": str(file), "yes": False, "redo": False, "note": "", **flags})()
        real_input = builtins.input
        builtins.input = lambda prompt="": answer
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                jp.cmd_batch(args)
        finally:
            builtins.input = real_input
        return out.getvalue()

    def test_batch_asks_first_and_skips_done(self):
        batch = self.tmp / "batch.json"
        batch.write_text(json.dumps({"format": "jobglobal-prep-batch", "version": 1, "postings": [
            {"id": "gh-acme-1", "title": "Rust Engineer", "company": "Acme", "text": POSTING},
            {"id": "ab-beta-2", "title": "Go Dev", "company": "Beta", "text": POSTING.replace("gh-acme-1", "ab-beta-2")},
        ]}))
        out = self.run_batch(batch, answer="n")
        self.assertIn("Cancelled", out)
        self.assertEqual(self.calls, [])  # nothing generated without a yes
        out = self.run_batch(batch, answer="y")
        self.assertIn("Prepped 2 of 2", out)
        out = self.run_batch(batch, answer="y")
        self.assertIn("Skipping 2 already prepped", out)
        self.assertEqual(len(self.calls), 2)

    def test_batch_rejects_other_files(self):
        bad = self.tmp / "x.json"
        bad.write_text("{}")
        with self.assertRaises(SystemExit):
            self.run_batch(bad)


if __name__ == "__main__":
    unittest.main()
