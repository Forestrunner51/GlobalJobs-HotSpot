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

    def test_xr_keywords(self):
        for text in ["Senior XR Engineer", "AR/VR platform", "We build AR glasses", "virtual reality training",
                     "Mixed Reality apps for Quest 3", "spatial computing on Apple Vision Pro"]:
            self.assertTrue(mentions("XR / AR / VR", text), text)
        for text in ["Little Rock, AR 72201", "Grow ARR", "XRP trading desk", "Mr. Smith", "MRR growth"]:
            self.assertFalse(mentions("XR / AR / VR", text), text)
        groups = [{"id": "language"}, {"id": "xr", "minMentions": 2}]
        specs = [SPECS["Rust"], SPECS["XR / AR / VR"]]
        rules, rx = fj.TitleRules(specs, groups), {"Rust": RX["Rust"], "XR / AR / VR": RX["XR / AR / VR"]}
        boilerplate = "Our engine powers PC, console and VR games."
        self.assertIsNone(fj.match_keywords("Counsel", boilerplate, rx, roles=rules))
        self.assertEqual(fj.match_keywords("Engineer", boilerplate + " Rust.", rx, roles=rules)["keywords"], ["Rust"])
        self.assertIn("XR / AR / VR", fj.match_keywords("VR Engineer", "", rx, roles=rules)["keywords"])
        self.assertIn("XR / AR / VR", fj.match_keywords("Engineer", "AR glasses. Virtual reality.", rx, roles=rules)["keywords"])
        self.assertTrue(mentions("Unity", "Experience with Unity and C#"))
        self.assertFalse(mentions("Unity", "Unity of purpose and community"))
        self.assertFalse(mentions("Unity", "Delta Lake and Unity Catalog"))
        self.assertTrue(mentions("Unreal Engine", "Gameplay programming in UE5"))
        self.assertTrue(mentions("OpenXR / WebXR", "Ship on OpenXR and ARKit"))

    def test_frameworks_tag_but_never_qualify_alone(self):
        rx = {"Java": RX["Java"], "Spring Boot": RX["Spring Boot"], "AWS": RX["AWS"]}
        tags = frozenset({"Spring Boot", "AWS"})
        self.assertIsNone(fj.match_keywords("AWS Partner Sales Manager", "Sell AWS and Spring Boot support.", rx, tags))
        hit = fj.match_keywords("Backend Engineer", "Java and Spring Boot services on AWS. More AWS.", rx, tags)
        self.assertEqual(hit["keywords"], ["Java", "Spring Boot", "AWS"])
        self.assertEqual(list(hit["snippets"])[0], "Java")  # languages keep their snippet ahead of tags
        self.assertIsNotNone(fj.match_keywords("AWS Engineer", "AWS", {"AWS": RX["AWS"]}))  # untagged: qualifies

    def test_framework_patterns(self):
        for name, yes, no in [
            ("React", ["React", "React.js", "ReactJS", "React Native"], ["react quickly", "Reactive streams"]),
            ("Node.js", ["Node.js", "NodeJS"], ["a Kubernetes node", "Node"]),
            ("Spring Boot", ["Spring Boot", "SpringBoot", "Spring Framework"], ["Spring 2027 internship"]),
            ("AWS", ["AWS Lambda", "Amazon Web Services"], ["laws and draws"]),
            ("Kubernetes", ["Kubernetes", "k8s"], ["k8"]),
            ("Spark", ["Apache Spark", "PySpark", "Spark SQL", "Python, Spark"], ["spark joy", "Spark Driver app"]),
        ]:
            for text in yes:
                self.assertTrue(mentions(name, text), (name, text))
            for text in no:
                self.assertFalse(mentions(name, text), (name, text))

    def test_every_keyword_group_exists(self):
        groups = {g["id"] for g in fj.keyword_groups(CONFIG)}
        self.assertEqual({s["group"] for s in SPECS.values()} - groups, set())

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

    def test_employment_type(self):
        titles = {"Unity Developer (Contract)": "contract", "Backend Engineer - Contractor": "contract",
                  "Senior Engineer, Contract": "contract", "XR Engineer | 6-month contract": "contract",
                  "Freelance 3D Artist": "contract", "Part-Time Tutor": "parttime",
                  "Smart Contract Engineer": None, "Contracts Manager": None, "Contract Specialist": None,
                  "Senior Software Engineer": None}
        for title, kind in titles.items():
            self.assertEqual(fj.employment_type(None, title), kind, title)
        self.assertEqual(fj.employment_type(None, "Engineer", "This is a 6-month contract role in NYC."), "contract")
        self.assertIsNone(fj.employment_type(None, "Engineer", "We work with contractors and employees alike."))
        # Board fields in each source's spelling; a title saying "Contract" beats a default "Full-time".
        self.assertEqual(fj.employment_type("Contract - 6 months", "Engineer"), "contract")  # Lever
        self.assertEqual(fj.employment_type("PartTime", "Engineer"), "parttime")  # Ashby
        self.assertEqual(fj.employment_type(["permanent", "part_time"], "Engineer"), "parttime")  # Adzuna
        self.assertEqual(fj.employment_type("Contractor", "Engineer"), "contract")  # Himalayas
        self.assertEqual(fj.employment_type(["Full-Time"], "Engineer (Contract)"), "contract")
        self.assertIsNone(fj.employment_type("Full-Time", "Engineer", "This is a contract role."))

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


class Roles(unittest.TestCase):
    """Cloud and infrastructure roles are matched on the job title only."""
    groups = fj.keyword_groups(CONFIG)
    roles = fj.TitleRules(list(SPECS.values()), groups)

    def found(self, title, text="We run infrastructure on a cloud platform with DevOps practices."):
        hit = fj.match_keywords(title, text, RX, frozenset(), self.roles)
        return [k for k in (hit or {}).get("keywords", []) if SPECS[k]["group"] == "role"]

    def test_titles(self):
        for title, want in [
            ("Senior Platform Engineer", ["Platform"]),
            ("Software Engineer, Platform", ["Platform"]),
            ("Staff Engineer - Developer Platform", ["Platform"]),
            ("Cloud Infrastructure Engineer", ["Cloud / AWS", "Infrastructure"]),
            ("AWS Cloud Architect", ["Cloud / AWS"]),
            ("Infra Engineer", ["Infrastructure"]),
            ("Site Reliability Engineer II", ["SRE"]),
            ("SRE Manager", ["SRE"]),
            ("DevOps Engineer", ["DevOps"]),
            ("Dev Ops Lead", ["DevOps"]),
        ]:
            self.assertEqual(self.found(title), want, title)

    def test_not_roles(self):
        # The text mentions all of them; only the title counts.
        for title in ("Backend Engineer", "Cloud Account Executive", "Sales Engineer, Cloud", "Product Manager, Platform",
                      "Platform Marketing Lead", "Infrastructure Recruiter", "Head of Cloud Partnerships",
                      "Global Head of Cloud Alliances", "Director of Product Design - Developer Platform"):
            self.assertEqual(self.found(title), [], title)

    def test_title_only_posting_gets_an_opening_snippet(self):
        hit = fj.match_keywords("Platform Engineer", "Join the team that runs our clusters. " * 10,
                                {"Platform": RX["Platform"]}, frozenset(), self.roles)
        self.assertEqual(hit["inTitle"], ["Platform"])
        self.assertEqual(hit["mentions"], {"Platform": 0})
        self.assertTrue(hit["snippets"]["Platform"].startswith("Join the team"))
        self.assertTrue(hit["snippets"]["Platform"].endswith("…"))

    def test_role_patterns_work_in_javascript_too(self):
        # The site compiles the same patterns for highlighting: no lookbehind of variable width, no inline flags.
        for name, spec in SPECS.items():
            if spec["group"] == "role":
                self.assertNotRegex(spec["pattern"], r"\(\?[aiLmsux]|\(\?<[=!][^)]*[*+]", name)


class RateLimit(unittest.TestCase):
    def test_himalayas_waits_once_then_stops_and_reports(self):
        import urllib.error
        real_get, real_wait = fj.get_json, fj.RATE_LIMIT_WAIT
        calls = []

        def fake(url, headers=None, timeout=60):
            calls.append(url)
            if "q=rust" in url:
                return {"totalCount": 1, "jobs": [{"title": "Rust dev", "guid": "https://h/1", "companyName": "Acme",
                                                   "description": "Rust", "pubDate": 1792000000}]}
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
        fj.get_json, fj.RATE_LIMIT_WAIT = fake, 0
        fj.CUT_SHORT.clear()
        try:
            jobs = fj.from_himalayas([("Rust", "rust"), ("Go", "golang"), ("Python", "python")],
                                     {"pages": 3, "secondsBetweenCalls": 0})
        finally:
            fj.get_json, fj.RATE_LIMIT_WAIT = real_get, real_wait
        self.assertEqual(len(jobs), 1)  # what it had before the limit
        self.assertEqual(len(calls), 3)  # rust, golang, golang again after waiting; python never asked
        self.assertIn("himalayas", fj.CUT_SHORT)
        fj.CUT_SHORT.clear()

    def test_himalayas_shuffle_asks_every_search_in_some_order(self):
        asked = []

        def fake(url, headers=None, timeout=60):
            asked.append(url.split("q=")[1].split("&")[0])
            return {"totalCount": 0, "jobs": []}
        real_get, fj.get_json = fj.get_json, fake
        words = [(str(i), f"w{i}") for i in range(30)]
        try:
            fj.from_himalayas(words, {"pages": 1, "secondsBetweenCalls": 0, "shuffle": True})
        finally:
            fj.get_json = real_get
        self.assertEqual(sorted(asked), sorted(q for _, q in words))
        self.assertNotEqual(asked, [q for _, q in words])  # 30! orders; the listed one won't come up

    def test_himalayas_runs_last_runs_unfinished_searches_first(self):
        import urllib.error
        asked = []

        def fake(url, headers=None, timeout=60, body=None):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            asked.append(f"{q['q'][0]}|{q.get('employment_type', [''])[0]}")
            if len(asked) > 2:
                raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
            return {"totalCount": 0, "jobs": []}
        real_get, real_wait, fj.get_json, fj.RATE_LIMIT_WAIT = fj.get_json, fj.RATE_LIMIT_WAIT, fake, 0
        fj.CUT_SHORT.clear()
        try:
            fj.from_himalayas([("Rust", "rust"), ("Go", "golang")],
                              {"pages": 1, "contractPages": 1, "secondsBetweenCalls": 0, "shuffle": True, "rateLimitWaits": 0},
                              pending=["golang|Contractor", "rust|"])
        finally:
            fj.get_json, fj.RATE_LIMIT_WAIT = real_get, real_wait
        self.assertEqual(asked[:2], ["golang|Contractor", "rust|"])  # last run's leftovers go first
        self.assertEqual(len(fj.HIMALAYAS_PENDING), 2)  # the 429'd search and the one never asked
        self.assertIn(asked[2], fj.HIMALAYAS_PENDING)
        fj.CUT_SHORT.clear()

    def test_cut_short_source_keeps_last_runs_postings(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out, cfg = Path(tmp) / "out", Path(tmp) / "sources.json"
            out.mkdir()
            old = {"source": "himalayas", "company": "Acme", "location": "Remote (US)", "regionIds": [], "states": [],
                   "keywords": ["Rust"], "inTitle": ["Rust"], "mentions": {"Rust": 1}, "snippets": {}, "firstSeen": "2026-10-02"}
            (out / "jobs.json").write_text(json.dumps({"generated": "2026-10-18T12:00:00+00:00", "jobs": [
                {**old, "id": "hm-seen-again", "title": "Rust Engineer"}, {**old, "id": "hm-not-reached", "title": "Rust SRE"}]}))
            cfg.write_text(json.dumps({"keywords": ["Rust"], "hackerNews": False, "usajobs": False,
                                       "himalayas": {"pages": 1, "secondsBetweenCalls": 0}}))
            real_h, argv = fj.from_himalayas, sys.argv

            def partial(*a, **k):
                fj.CUT_SHORT.add("himalayas")
                return [{"id": "hm-seen-again", "company": "Acme", "title": "Rust Engineer", "location": "Remote (US)",
                         "remote": True, "url": "https://h/1", "text": "Rust"}]
            fj.from_himalayas = partial
            sys.argv = ["fetch_jobs.py", "--config", str(cfg), "--out", str(out)]
            try:
                self.assertEqual(fj.main(), 0)
            finally:
                fj.from_himalayas, sys.argv = real_h, argv
                fj.CUT_SHORT.clear()
            data = json.loads((out / "jobs.json").read_text())
            self.assertEqual(sorted(j["id"] for j in data["jobs"]), ["hm-not-reached", "hm-seen-again"])
            self.assertEqual(data["changes"]["closed"], 0)
            self.assertIn("rate limited", data["sources"][0]["problems"][0])


class SlowBoards(unittest.TestCase):
    """Workday, SmartRecruiters and Workable, with the network faked."""

    def setUp(self):
        self.real_get, self.calls = fj.get_json, []
        self.real_throttles = dict(fj.THROTTLES)
        for k in fj.THROTTLES:
            fj.THROTTLES[k] = fj.Throttle(0)

    def tearDown(self):
        fj.get_json = self.real_get
        fj.THROTTLES.update(self.real_throttles)
        fj.REUSE.update({"jobs": {}, "out": None})
        fj._SHARD_CACHE.clear()

    def test_workday_lists_then_opens_tech_titles_only(self):
        def fake(url, headers=None, timeout=60, body=None):
            self.calls.append(url)
            if url.endswith("/jobs"):
                return {"total": 2, "jobPostings": [] if body["offset"] else [
                    {"title": "Senior XR Engineer", "externalPath": "/job/Seattle-WA/XR_R0001", "bulletFields": ["R0001"]},
                    {"title": "Payroll Specialist", "externalPath": "/job/Austin-TX/Pay_R0002", "bulletFields": ["R0002"]}]}
            return {"jobPostingInfo": {"title": "Senior XR Engineer", "jobDescription": "<p>Build VR in C++.</p>",
                                       "location": "Seattle, WA", "startDate": "2026-11-20", "timeType": "Full time",
                                       "remoteType": "Hybrid"}}
        fj.get_json = fake
        jobs = fj.from_workday({"name": "Acme", "url": "https://acme.wd5.myworkdayjobs.com/en-US/Careers"})
        self.assertEqual(self.calls, ["https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs",
                                      "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Seattle-WA/XR_R0001"])
        self.assertEqual(len(jobs), 1)
        j = jobs[0]
        self.assertEqual((j["id"], j["location"], j["posted"], j["hybrid"]), ("wd-acme-R0001", "Seattle, WA", "2026-11-20", True))
        self.assertEqual(j["url"], "https://acme.wd5.myworkdayjobs.com/Careers/job/Seattle-WA/XR_R0001")
        self.assertIn("Build VR", j["text"])

    def test_workday_site_urls_and_reuse_of_last_runs_text(self):
        import tempfile
        def fake(url, headers=None, timeout=60, body=None):
            self.calls.append(url)
            return {"total": 1, "jobPostings": [] if body and body["offset"] else [
                {"title": "AR Engineer", "externalPath": "/job/LA/AR_R0009", "bulletFields": ["R0009"]}]}
        fj.get_json = fake
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "jobs-text").mkdir()
            (out / "jobs-text" / f"{fj.text_shard('wd-snapchat-R0009')}.json").write_text(json.dumps({"wd-snapchat-R0009": "Spectacles AR"}))
            fj.REUSE.update({"out": out, "jobs": {"wd-snapchat-R0009": {"company": "Snap", "title": "AR Engineer",
                             "location": "Los Angeles, CA", "url": "https://x/9", "posted": "2026-11-01", "type": "contract"}}})
            jobs = fj.from_workday({"name": "Snap", "url": "https://wd1.myworkdaysite.com/recruiting/snapchat/snap"})
        self.assertEqual(self.calls, ["https://wd1.myworkdaysite.com/wday/cxs/snapchat/snap/jobs"])  # no detail request
        self.assertEqual((jobs[0]["text"], jobs[0]["employment"], jobs[0]["posted"]), ("Spectacles AR", "Contract", "2026-11-01"))

    def test_smartrecruiters(self):
        def fake(url, headers=None, timeout=60, body=None):
            self.calls.append(url)
            if "offset=" in url:
                return {"totalFound": 2, "content": [
                    {"id": "11", "name": "Backend Engineer (Go)", "releasedDate": "2026-11-25T10:00:00Z",
                     "location": {"city": "Austin", "region": "TEXAS", "country": "us", "hybrid": True},
                     "typeOfEmployment": {"label": "Contract"}},
                    {"id": "12", "name": "Store Associate", "location": {"city": "Austin", "country": "us"}}]}
            return {"postingUrl": "https://jobs.smartrecruiters.com/Acme/11", "applyUrl": "https://jobs.smartrecruiters.com/Acme/11?oga=true",
                    "jobAd": {"sections": {"jobDescription": {"text": "<p>Go services.</p>"}}}}
        fj.get_json = fake
        jobs = fj.from_smartrecruiters({"name": "Acme", "board": "Acme"})
        self.assertEqual(len(self.calls), 2)  # the list, then the one tech title
        j = jobs[0]
        self.assertEqual((j["id"], j["location"], j["employment"], j["posted"]), ("sr-Acme-11", "Austin, TEXAS", "Contract", "2026-11-25"))
        self.assertEqual(fj._sr_location({"city": "Montreal", "country": "ca", "fullLocation": "Montreal, , Canada"}), "Montreal, Canada")
        for title in ["Talent Acquisition & Internal Mobility Manager", "Contest Coordinator"]:
            self.assertIsNone(fj.TECH_TITLE.search(title), title)
        self.assertEqual(fj.employment_type(j["employment"], j["title"]), "contract")
        self.assertIn("Go services", j["text"])

    def test_workable(self):
        fj.get_json = lambda url, headers=None, timeout=60, body=None: {"jobs": [
            {"title": "Unity Developer", "shortcode": "AB12", "employment_type": "Contract", "telecommuting": True,
             "description": "<p>Unity and C#.</p>", "url": "https://apply.workable.com/acme/j/AB12/",
             "published_on": "2026-11-24", "locations": [{"city": "Berlin", "country": "Germany"}]}]}
        j = fj.from_workable({"name": "Acme", "board": "acme"})[0]
        self.assertEqual((j["id"], j["location"], j["remote"], j["employment"]), ("wk-acme-AB12", "Berlin, Germany", True, "Contract"))


class Pay(unittest.TestCase):
    def test_ranges(self):
        pay = fj.salary_from_text
        self.assertEqual(pay("The base salary range is $150,000 - $200,000 per year."), "$150k–$200k")
        self.assertEqual(pay("Pay: $120K–$165K plus equity"), "$120k–$165k")
        self.assertEqual(pay("USD 135,000 to 180,500 annually"), "$135k–$180k")
        self.assertEqual(pay("$142,500.00 — $190,000.00 USD"), "$142k–$190k")
        self.assertEqual(pay("between $95,000 and $130,000"), "$95k–$130k")
        self.assertEqual(pay("$150,000 - $150,000"), "$150k")

    def test_not_pay(self):
        pay = fj.salary_from_text
        self.assertIsNone(pay("We raised $50,000,000 - $60,000,000 in funding"))
        self.assertIsNone(pay("a $10,000 - $20,000 sign-on bonus"))
        self.assertIsNone(pay("$45 - $60 per hour"))
        self.assertIsNone(pay("Serving 150,000 to 200,000 customers"))
        self.assertIsNone(pay("No numbers here"))
        # A bonus range before the real one is skipped, not returned.
        self.assertEqual(pay("Bonus of $5,000 - $9,000. Salary $110,000 - $140,000."), "$110k–$140k")

    def test_dedupe_by_id_and_by_posting(self):
        jobs = [{"id": "a", "company": "Acme", "title": "Engineer", "location": "NYC"},
                {"id": "a", "company": "Acme", "title": "Engineer (updated)", "location": "NYC"},
                {"id": "b", "company": "acme ", "title": "engineer", "location": "nyc"},
                {"id": "c", "company": "Acme", "title": "Engineer", "location": "Austin"}]
        self.assertEqual([j["id"] for j in fj.dedupe(jobs)], ["a", "c"])


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
