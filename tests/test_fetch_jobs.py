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


class Keywords(unittest.TestCase):
    rx = {"Rust": fj.keyword_re("Rust"), "C++": fj.keyword_re("C++")}

    def test_word_boundaries(self):
        self.assertIsNone(fj.match_keywords("Trust & Safety Lead", "We value trust and robustness.", self.rx))
        hit = fj.match_keywords("Backend Engineer", "Strong Rust skills. We also use rust daily.", self.rx)
        self.assertEqual(hit["keywords"], ["Rust"])
        self.assertEqual(hit["mentions"], 2)
        self.assertFalse(hit["inTitle"])
        self.assertIn("Strong Rust", hit["snippet"])

    def test_symbols_and_title(self):
        hit = fj.match_keywords("C++/Rust Engineer", "", self.rx)
        self.assertEqual(hit["keywords"], ["Rust", "C++"])
        self.assertTrue(hit["inTitle"])


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
