"""Offline tests for jobs/fetch_jobs.py parsing. Run: python -m unittest tests/test_fetch_jobs.py"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "jobs"))
import fetch_jobs as fj  # noqa: E402

METROS = [
    {"regionId": "35620", "regionLabel": "New York-Newark-Jersey City, NY-NJ", "lat": 40.7, "lng": -74.0},
    {"regionId": "41860", "regionLabel": "San Francisco-Oakland-Fremont, CA", "lat": 37.7, "lng": -122.3},
    {"regionId": "31080", "regionLabel": "Los Angeles-Long Beach-Anaheim, CA", "lat": 34.1, "lng": -118.2},
    {"regionId": "42660", "regionLabel": "Seattle-Tacoma-Bellevue, WA", "lat": 47.6, "lng": -122.0},
    {"regionId": "38900", "regionLabel": "Portland-Vancouver-Hillsboro, OR-WA", "lat": 45.5, "lng": -122.7},
    {"regionId": "38860", "regionLabel": "Portland-South Portland, ME", "lat": 43.7, "lng": -70.3},
    {"regionId": "40140", "regionLabel": "Riverside-San Bernardino-Ontario, CA", "lat": 34.0, "lng": -117.0},
]
INDEX = fj.MetroIndex(METROS)


def where(loc):
    return fj.describe_location(INDEX, loc)


import json  # noqa: E402

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "jobs" / "sources.json").read_text())
SPECS = {k["name"]: k for k in map(fj.keyword_spec, CONFIG["keywords"])}
RX = {name: fj.compile_keyword(spec) for name, spec in SPECS.items()}


def mentions(name, text):
    return bool(RX[name].search(text))


class Keywords(unittest.TestCase):
    rx = {"Rust": RX["Rust"], "C++": RX["C++"]}

    def test_word_boundaries(self):
        self.assertIsNone(fj.match_keywords("Trust & Safety Lead", "We value trust and robustness.", self.rx))
        hit = fj.match_keywords("Backend Engineer", "Strong Rust skills. We also use rust daily.", self.rx)
        self.assertEqual(hit["keywords"], ["Rust"])
        self.assertEqual(hit["mentions"], {"Rust": 2})
        self.assertEqual(hit["inTitle"], [])
        self.assertIn("Strong Rust", hit["snippets"]["Rust"])

    def test_symbols_and_title(self):
        hit = fj.match_keywords("C++/Rust Engineer", "Modern C++17 and Rust.", self.rx)
        self.assertEqual(hit["keywords"], ["Rust", "C++"])
        self.assertEqual(hit["inTitle"], ["Rust", "C++"])
        self.assertEqual(hit["mentions"], {"Rust": 1, "C++": 1})

    def test_go_only_as_a_language(self):
        for text in ("Experience with Go, Rust or C++", "services written in Go.", "Golang experience",
                     "Go/Python", "Go and Kotlin", "strong Go engineers"):
            self.assertTrue(mentions("Go", text), text)
        for text in ("Our go-to-market team", "Go live with customers", "Go-to-market strategy",
                     "We go fast", "Let's Go build the future", "ready to go", "Head of Sales / Go To Market"):
            self.assertFalse(mentions("Go", text), text)

    def test_other_languages(self):
        self.assertTrue(mentions("Java", "Java, Kotlin"))
        self.assertFalse(mentions("Java", "JavaScript and TypeScript"))
        for text in ("C#/.NET", "c# developers", "ASP.NET Core", "experience with .NET 8", "dotnet CLI", "C Sharp"):
            self.assertTrue(mentions("C# / .NET", text), text)
        for text in ("see https://www.cerebras.net/privacy", "visit example.NET", "C++ and Go"):
            self.assertFalse(mentions("C# / .NET", text), text)
        self.assertFalse(mentions("Swift", "swift onboarding"))
        self.assertFalse(mentions("Swift", "SWIFT payments"))
        self.assertTrue(mentions("Ruby", "Ruby on Rails"))

    def test_devsecops(self):
        for text in ("Senior DevSecOps Engineer", "Dev-Sec-Ops pipelines", "AppSec team", "Cloud Security Engineer",
                     "software supply-chain security", "SAST and DAST tooling", "security automation in CI/CD"):
            self.assertTrue(mentions("DevSecOps", text), text)
        for text in ("Security Operations Center analyst", "job security", "DevOps Engineer", "Nasdaq listed"):
            self.assertFalse(mentions("DevSecOps", text), text)

    def test_text_shard_is_stable(self):
        # Must match textShard() in web/js/jobs.js (FNV-1a mod 32).
        self.assertEqual(fj.text_shard("gh-cloudflare-123"), fj.text_shard("gh-cloudflare-123"))
        self.assertEqual(fj.text_shard(""), f"{0x811C9DC5 % 32:02d}")


class Experience(unittest.TestCase):
    def test_level_from_title(self):
        cases = {
            "Senior Engineering Manager, Platform": "manager", "Staff Software Engineer": "staff",
            "Sr. Rust Engineer": "senior", "Software Engineer III": "senior", "Software Engineer I": "entry",
            "2026 Early Career Software Engineer": "entry", "Software Engineering Intern - Summer '27": "intern",
            "Rust Backend Engineer": "mid", "Member of Technical Staff - Systems": "mid", "AI Research Engineer": "mid",
        }
        for title, level in cases.items():
            self.assertEqual(fj.classify_level(title), level, title)

    def test_years_required(self):
        cases = {
            "5+ years of experience building backend systems": 5, "3-5 years' experience in Rust": 3,
            "At least two years of professional software experience": 2, "Experience: 4+ years": 4,
            "Bachelor's degree and 2 years of relevant experience": 2, "experience with Rust (3+ years)": 3,
            "We were founded 15 years ago. Experience with Rust.": None, "Proficiency in Rust": None,
            "Nice to have: 8+ years in C++. Required: 5+ years of software experience": 5,
        }
        for text, years in cases.items():
            self.assertEqual(fj.required_years(text), years, text)


class Locations(unittest.TestCase):
    def test_city_state_and_suburbs(self):
        self.assertEqual(where("San Francisco, CA")["regionIds"], ["41860"])
        self.assertEqual(where("Irvine, California, United States | Irvine, CA (OC-62)")["regionIds"], ["31080"])
        self.assertEqual(where("ONSITE in Seattle, WA")["regionIds"], ["42660"])
        self.assertEqual(where("Torrance, CA OR Seattle, WA")["regionIds"], ["31080", "42660"])

    def test_city_lists_and_aliases(self):
        self.assertEqual(where("New York, San Francisco")["regionIds"], ["35620", "41860"])
        self.assertEqual(where("Remote (US), NYC")["regionIds"], ["35620"])
        self.assertEqual(where("Portland")["regionIds"], ["38900"])
        self.assertEqual(where("Portland, ME")["regionIds"], ["38860"])

    def test_states(self):
        self.assertEqual(where("Irvine, California, United States | Irvine, CA (OC-62)")["states"], ["CA"])
        self.assertEqual(where("Torrance, CA OR Seattle, WA")["states"], ["CA", "WA"])
        self.assertEqual(where("New York, San Francisco")["states"], ["NY", "CA"])  # principal state of each metro
        d = where("ONSITE in Moses Lake, WA")  # a state with no metro in the data
        self.assertEqual((d["regionIds"], d["states"], d["us"]), ([], ["WA"], True))
        self.assertEqual(where("Remote - Texas")["states"], ["TX"])
        self.assertEqual(where("London, UK")["states"], [])

    def test_outside_us_is_not_placed(self):
        for loc in ("London, UK", "Toronto, Ontario", "Paris, France", "Berlin; Munich"):
            d = where(loc)
            self.assertEqual(d["regionIds"], [], loc)
            self.assertFalse(d["us"], loc)

    def test_remote_flags(self):
        self.assertTrue(where("Home based - Worldwide")["remote"])
        d = where("REMOTE, HYBRID, and ONSITE (UNITED STATES ONLY)")
        self.assertTrue(d["remote"])
        self.assertTrue(d["us"])
        self.assertFalse(where("Remote (EU)")["us"])


class Feeds(unittest.TestCase):
    """The feed parsers, run against canned responses shaped like each API's."""

    def setUp(self):
        self._get = fj.get_json

    def tearDown(self):
        fj.get_json = self._get

    def test_remote_ok_skips_legal_notice_and_fixes_encoding(self):
        fj.get_json = lambda url, headers=None, timeout=60: [
            {"legal": "API Terms of Service..."},
            {"id": "1", "position": "Senior Rust Engineer", "company": "Sotheby\u00e2\u0080\u0099s",
             "location": "", "description": "<p>Rust</p>", "url": "https://remoteok.com/x", "apply_url": "https://remoteok.com/x/apply",
             "date": "2026-10-18T19:00:02+00:00", "salary_min": 150000, "salary_max": 190000},
        ]
        jobs = fj.from_remote_ok()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["location"], "Remote (Anywhere)")
        self.assertEqual(jobs[0]["salary"], "$150k–$190k")
        self.assertEqual(jobs[0]["company"], "Sotheby\u2019s")

    def test_himalayas_pages_until_total(self):
        calls = []

        def fake(url, headers=None, timeout=60):
            calls.append(url)
            page = int(url.rsplit("page=", 1)[1])
            n = 19 if page == 1 else 20  # a short page that isn't the last
            return {"totalCount": 39, "jobs": [{"title": f"Go dev {page}-{i}", "guid": f"https://h/{page}/{i}",
                                                "companyName": "Acme", "locationRestrictions": ["United States"],
                                                "description": "Golang", "pubDate": 1792000000} for i in range(n)]}
        fj.get_json = fake
        jobs = fj.from_himalayas([("Go", "golang")], {"pages": 10, "secondsBetweenCalls": 0})
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(jobs), 39)
        self.assertEqual(jobs[0]["location"], "Remote (United States)")
        self.assertTrue(jobs[0]["remote"])


class WorkStyleAndExpiry(unittest.TestCase):
    def test_hybrid(self):
        self.assertTrue(where("Hybrid - New York, NY")["hybrid"])
        self.assertFalse(where("New York, NY")["hybrid"])
        for text in ("This is a hybrid role based in NYC.", "You'll be in-office 3 days a week.",
                     "Expect two days per week at our HQ"):
            self.assertTrue(fj.HYBRID_TEXT.search(text), text)
        for text in ("Experience with hybrid cloud infrastructure", "hybrid search with vector databases"):
            self.assertFalse(fj.HYBRID_TEXT.search(text), text)

    def test_feed_postings_expire_board_postings_dont(self):
        import datetime as dt
        today = dt.date(2026, 10, 19)
        limits = {"hn": 60}
        self.assertTrue(fj.too_old({"source": "hn", "posted": "2026-08-01"}, limits, today))
        self.assertFalse(fj.too_old({"source": "hn", "posted": "2026-09-01"}, limits, today))
        self.assertFalse(fj.too_old({"source": "greenhouse", "posted": "2024-01-01"}, limits, today))
        self.assertFalse(fj.too_old({"source": "hn"}, limits, today))  # no date: keep


class Resilience(unittest.TestCase):
    def test_get_json_retries_server_errors(self):
        import io
        import urllib.error
        calls = []

        def flaky(req, timeout=60):
            calls.append(1)
            if len(calls) == 1:
                raise urllib.error.HTTPError(req.full_url, 500, "boom", {}, None)
            return io.BytesIO(b'{"ok": true}')
        real, delays = fj.urllib.request.urlopen, fj.RETRY_DELAYS
        fj.urllib.request.urlopen, fj.RETRY_DELAYS = flaky, (0, 0)
        try:
            self.assertEqual(fj.get_json("https://example.test/x"), {"ok": True})
            self.assertEqual(len(calls), 2)
        finally:
            fj.urllib.request.urlopen, fj.RETRY_DELAYS = real, delays

    def test_failed_source_keeps_last_runs_postings(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out, cfg = Path(tmp) / "out", Path(tmp) / "sources.json"
            out.mkdir()
            prev = {"generated": "2026-10-18T12:00:00+00:00", "trackedSince": "2026-10-01", "jobs": [
                {"id": "hm-old", "source": "himalayas", "company": "Acme", "title": "Rust Engineer", "location": "Remote (US)",
                 "regionIds": [], "states": [], "keywords": ["Rust"], "inTitle": ["Rust"], "mentions": {"Rust": 1},
                 "snippets": {}, "firstSeen": "2026-10-02"}]}
            (out / "jobs.json").write_text(json.dumps(prev))
            cfg.write_text(json.dumps({"keywords": ["Rust"], "hackerNews": False, "usajobs": False, "remotive": True,
                                       "himalayas": {"pages": 1, "secondsBetweenCalls": 0}}))
            real_h, real_r, argv = fj.from_himalayas, fj.from_remotive, sys.argv

            def down(*a, **k):
                raise OSError("unreachable")
            fj.from_himalayas = down
            fj.from_remotive = lambda: [{"id": "rv-1", "company": "Beta", "title": "Rust Dev", "location": "Remote",
                                         "remote": True, "url": "https://r/1", "text": "Rust"}]
            sys.argv = ["fetch_jobs.py", "--config", str(cfg), "--out", str(out)]
            try:
                self.assertEqual(fj.main(), 0)
            finally:
                fj.from_himalayas, fj.from_remotive, sys.argv = real_h, real_r, argv
            data = json.loads((out / "jobs.json").read_text())
            jobs = {j["id"]: j for j in data["jobs"]}
            self.assertIn("hm-old", jobs)  # carried over, not counted as closed
            self.assertEqual(jobs["hm-old"]["firstSeen"], "2026-10-02")
            self.assertEqual(data["changes"]["closed"], 0)
            self.assertEqual(data["changes"]["new"], 1)
            self.assertEqual(data["trackedSince"], "2026-10-01")


class HackerNews(unittest.TestCase):
    def test_header_fields(self):
        p = fj.parse_hn_comment(
            'Footprint (<a href="https:&#x2F;&#x2F;onefootprint.com">https://onefootprint.com</a>) | '
            'Rust Engineers (Backend) | New York, San Francisco | Full-time | $180k-$250k<p>We are hiring...')
        self.assertEqual(p["company"], "Footprint")
        self.assertEqual(p["title"], "Rust Engineers (Backend)")
        self.assertEqual(p["location"], "New York, San Francisco")
        self.assertEqual(p["link"], "https://onefootprint.com")

    def test_remote_field_with_extra_words(self):
        p = fj.parse_hn_comment("NeuralFrame | Senior Backend Engineer (Python + Rust) | "
                                "REMOTE (US only, US time zones; no visa sponsorship) | Full-time | $170k-$210k<p>...")
        self.assertEqual(p["location"], "REMOTE (US only, US time zones; no visa sponsorship)")
        d = where(p["location"])
        self.assertTrue(d["remote"] and d["us"])

    def test_html_to_text_double_escaped(self):
        # Greenhouse escapes its HTML, so entities inside it arrive escaped twice.
        self.assertEqual(fj.html_to_text("&lt;p&gt;Rust &amp;amp; Go&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Linux&lt;/li&gt;&lt;/ul&gt;"),
                         "Rust & Go\n- Linux")


if __name__ == "__main__":
    unittest.main()
