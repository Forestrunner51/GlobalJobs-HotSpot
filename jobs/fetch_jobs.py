"""Collect live job postings that mention the languages in jobs/sources.json (Rust, C++, Go, ...).

Writes web/data/jobs.json (the list the site shows) and web/data/jobs-text/*.json (full posting
text in 32 pieces, loaded only when you open a posting or copy it for apply/jobprep.py).

Sources, all used through their public APIs:
  Greenhouse, Lever, Ashby   company job boards listed in sources.json (no key needed)
  Hacker News                recent monthly "Ask HN: Who is hiring?" threads (no key needed)
  Himalayas, The Muse        job search APIs (no key needed)
  Remotive, Remote OK, Jobicy  remote-job feeds; their terms ask that listings name them and link
                             back to their page, which the site does ("via Remote OK")
  Adzuna                     set ADZUNA_APP_ID and ADZUNA_APP_KEY (free at developer.adzuna.com)
  USAJobs                    set USAJOBS_API_KEY and USAJOBS_EMAIL (free at developer.usajobs.gov)

    python jobs/fetch_jobs.py
    python jobs/fetch_jobs.py --keywords Rust Zig     # override the keywords in sources.json

Only the standard library is used, so it runs anywhere Python 3.10+ does, including CI.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "jobs" / "sources.json"
OUT_DIR = ROOT / "web" / "data"
METROS = OUT_DIR / "metros.json"
TEXT_LIMIT = 15_000  # characters of posting text kept per job
SNIPPET_CHARS = 75  # context on each side of a keyword's first mention
SNIPPETS_PER_JOB = 2  # snippets kept for the keywords most central to the posting (they dominate file size)
USER_AGENT = "CareerHotspotGlobe job fetcher (+https://github.com/)"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


RETRY_DELAYS = (2, 6)  # seconds before the 2nd and 3rd attempts


def get_json(url: str, headers: dict | None = None, timeout: int = 60):
    """GET and parse JSON, retrying server errors and network failures. Client errors (404, 429)
    are raised at once: retrying won't fix them, and 429 means slow down."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for delay in (*RETRY_DELAYS, None):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code < 500 or delay is None:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if delay is None:
                raise
        time.sleep(delay)


def html_to_text(s: str | None) -> str:
    """Board APIs return HTML, sometimes entity-escaped twice (Greenhouse)."""
    s = html.unescape(s or "")
    if "&lt;" in s or "&amp;" in s:
        s = html.unescape(s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>|</div>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "\n- ", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))  # entities left over from triple escaping
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\s*\n\s*", "\n", s).strip()


def iso_date(value) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):  # Lever: epoch milliseconds
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).date().isoformat()
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return str(value)[:10]


# ---------------------------------------------------------------- keywords

def keyword_spec(entry: str | dict) -> dict:
    """A keyword from sources.json: a plain name, or {"name", "pattern"?, "caseSensitive"?}.

    Patterns are shared with the site (for highlighting), so they must work in both Python and
    JavaScript: no inline flags, and only fixed-width lookbehind.
    """
    if isinstance(entry, str):
        entry = {"name": entry}
    name = entry["name"]
    # Letter/digit boundaries rather than \b, so "C++" and "C#" work and "Rust" skips "trust".
    escaped = re.sub(r"([.^$*+?{}\[\]\\|()])", r"\\\1", name)
    tail = r"(?![A-Za-z0-9])" if name[-1].isalnum() else r"(?![A-Za-z])"  # "C++17" is still C++
    pattern = entry.get("pattern") or rf"(?<![A-Za-z0-9]){escaped}{tail}"
    query = entry.get("query", name)
    return {"name": name, "pattern": pattern, "flags": "" if entry.get("caseSensitive") else "i",
            "queries": query if isinstance(query, list) else [query],  # what to send to keyword-search APIs
            "aliases": entry.get("aliases", [])}  # former names, so old links on the site still work


def compile_keyword(spec: dict) -> re.Pattern:
    return re.compile(spec["pattern"], re.I if "i" in spec["flags"] else 0)


def _snippet(text: str, m: re.Match) -> str:
    a, b = max(0, m.start() - SNIPPET_CHARS), min(len(text), m.end() + SNIPPET_CHARS)
    return ("…" if a else "") + text[a:b].replace("\n", " ").strip() + ("…" if b < len(text) else "")


def match_keywords(title: str, text: str, keywords: dict[str, re.Pattern]) -> dict | None:
    """Which keywords a posting mentions, which are in the title, how often each appears in the
    text, and a snippet around each keyword's first mention."""
    found, in_title, mentions, snippets = [], [], {}, {}
    for word, rx in keywords.items():
        t_hit = bool(rx.search(title))
        hits = list(rx.finditer(text))
        if not (t_hit or hits):
            continue
        found.append(word)
        if t_hit:
            in_title.append(word)
        mentions[word] = len(hits)
        if hits:
            snippets[word] = _snippet(text, hits[0])
    if not found:
        return None
    # A posting listing ten languages doesn't need ten snippets: keep the most central ones.
    central = sorted(snippets, key=lambda w: (w not in in_title, -mentions[w]))[:SNIPPETS_PER_JOB]
    snippets = {w: snippets[w] for w in central}
    return {"keywords": found, "inTitle": in_title, "mentions": mentions, "snippets": snippets}


# ---------------------------------------------------------------- experience

# Checked in order; the first that matches the title wins. "Senior Engineering Manager" is a manager.
LEVELS = [
    ("intern", r"intern(ship)?|co-?op|apprentice"),
    ("manager", r"manager|director|head of|vp|vice president|chief|cto"),
    ("staff", r"staff|principal|distinguished|fellow"),
    ("senior", r"senior|sr\.?|lead|iii|iv"),
    ("entry", r"junior|jr\.?|entry[- ]level|graduate|new grad|early[- ]career|associate|i"),
]
LEVEL_RES = [(name, re.compile(rf"(?<![A-Za-z])({pat})(?![A-Za-z])", re.I)) for name, pat in LEVELS]

_NUM_WORDS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten".split())}
_NUM = r"(\d{1,2}|" + "|".join(_NUM_WORDS) + r")"
# "5+ years of experience", "3-5 years' experience", "at least two years of professional experience",
# "experience: 4+ years". The phrase must be tied to experience so "founded 15 years ago" doesn't count.
YEARS_RES = [
    re.compile(rf"(?<![\d.]){_NUM}\s*\+?\s*(?:(?:-|–|to)\s*\d{{1,2}}\s*\+?\s*)?(?:years?|yrs?)['’]?"
               r"(?:\s+of)?(?:\s+[\w/&+#-]+){0,5}?\s+(?:experience|exp\b)", re.I),
    re.compile(rf"experience[^.\n]{{0,40}}?(?<![\d.]){_NUM}\s*\+?\s*(?:years?|yrs?)", re.I),
]


def classify_level(title: str) -> str:
    # "Member of Technical Staff" is a catch-all title used at every level, not a Staff role.
    title = re.sub(r"(?i)member of (the )?technical staff", "", title)
    for name, rx in LEVEL_RES:
        if rx.search(title):
            return name
    return "mid"  # no level in the title; most such postings are mid-level, but it's a guess


def required_years(text: str) -> int | None:
    """Years of experience the posting asks for: the first such phrase, which is usually the main requirement."""
    first = None
    for rx in YEARS_RES:
        m = rx.search(text)
        if m and (first is None or m.start() < first.start()):
            first = m
    if not first:
        return None
    n = first.group(1).lower()
    years = _NUM_WORDS.get(n, None) if not n.isdigit() else int(n)
    return years if years is not None and years <= 25 else None


# ---------------------------------------------------------------- locations

STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "district of columbia": "DC",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
    "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
    "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "puerto rico": "PR",
}
STATE_CODES = set(STATES.values())

# Names postings use that aren't a principal city in the OMB metro title: nicknames and the
# suburbs where tech employers cluster. Tried only after the name itself fails to match.
_SUBURBS = {
    "new york": "nyc|new york city|manhattan|brooklyn|hoboken",
    "san francisco": "sf bay area|san francisco bay area|sf bay area|menlo park|redwood city|san mateo|"
                     "south san francisco|foster city|emeryville|berkeley|burlingame|san bruno",
    "san jose": "silicon valley|palo alto|mountain view|cupertino|milpitas|los gatos|campbell|los altos",
    "los angeles": "la|irvine|santa ana|costa mesa|el segundo|torrance|hawthorne|santa monica|pasadena|"
                   "burbank|culver city|playa vista|venice|glendale|newport beach|carson|el monte",
    "washington": "washington dc|washington d.c.|dc|d.c.|reston|herndon|mclean|chantilly|tysons|"
                  "bethesda|rockville|gaithersburg|crystal city|springfield|falls church|dulles",
    "boston": "waltham|quincy|somerville|burlington|lexington|bedford|woburn|watertown|needham|"
              "andover|chelmsford|framingham|marlborough",
    "denver": "broomfield|lakewood|golden|englewood|littleton|louisville|westminster",
    "seattle": "redmond|kirkland|bothell|everett|renton|issaquah",
    "dallas": "plano|irving|richardson|frisco|addison",
    "austin": "cedar park|georgetown tx",
    "chicago": "evanston|schaumburg|naperville",
    "palm bay": "cape canaveral|melbourne fl|titusville",
    "miami": "fort lauderdale|boca raton",
    "raleigh": "research triangle|rtp|morrisville",
}
CITY_ALIASES = {alias: city for city, names in _SUBURBS.items() for alias in names.split("|")}
# Ambiguous bare city names resolved to the metro postings almost always mean.
PREFERRED_STATE = {"portland": "OR", "washington": "DC", "columbus": "OH", "kansas city": "MO",
                   "cambridge": "MA", "arlington": "VA", "springfield": "MA", "richmond": "VA"}

US_HINT = re.compile(r"(?<![A-Za-z])(US|USA|U\.S\.A?\.?|(?i:United States|North America)|AMER)(?![A-Za-z])")
REMOTE_HINT = re.compile(r"remote|anywhere|distributed|work from home|wfh|home[- ]based|worldwide", re.I)
# Hybrid shows up in location fields ("Hybrid - New York") or in the text. Text phrases must be about
# the work arrangement, so "hybrid cloud" doesn't count.
HYBRID_TEXT = re.compile(
    r"\bhybrid (?:role|position|work|working|schedule|model|environment|arrangement|setup|policy|opportunity|team)\b"
    r"|\b(?:this|the) (?:role|position|job) is hybrid\b"
    r"|\b(?:\d|two|three|four) days (?:a|per|each) week (?:in|at|from) (?:the|our|an?) (?:office|hq|headquarters)\b"
    r"|\bin[- ]office (?:\d|two|three|four) days\b", re.I)
SPLIT_LOCATIONS = re.compile(r"\s*(?:;|\||/|•|\n|\bor\b|\band\b)\s*", re.I)


class MetroIndex:
    """Maps free-text posting locations onto the site's metro areas (CBSA ids)."""

    def __init__(self, metros: list[dict]):
        self.metros = {m["regionId"]: m for m in metros}
        self.by_city_state: dict[tuple[str, str], str] = {}
        self.by_city: dict[str, set[str]] = {}
        self.home_state: dict[str, str] = {}  # the metro's first-listed (principal) state
        for m in metros:
            cities, _, states = m["regionLabel"].rpartition(", ")
            states = states.split("-")
            self.home_state[m["regionId"]] = states[0]
            for city in cities.split("-"):
                key = city.strip().lower()
                for st in states:
                    self.by_city_state.setdefault((key, st), m["regionId"])
                self.by_city.setdefault(key, set()).add(m["regionId"])

    def _lookup(self, city: str, state: str | None) -> str | None:
        if state:
            return self.by_city_state.get((city, state))
        ids = self.by_city.get(city, set())
        if len(ids) == 1:
            return next(iter(ids))
        if city in PREFERRED_STATE:
            return self.by_city_state.get((city, PREFERRED_STATE[city]))
        return None

    def _city(self, city: str, state: str | None) -> str | None:
        # The name itself first, so "Quincy, IL" stays in Illinois; then the suburb alias.
        return self._lookup(city, state) or (CITY_ALIASES.get(city) and self._lookup(CITY_ALIASES[city], state))

    def resolve_one(self, part: str) -> list[tuple[str | None, str | None]]:
        """(metro id, state) pairs for one location. Either can be None: "Moses Lake, WA" has a
        state but no metro in the data. A metro without a stated state gets its principal state."""
        part = re.sub(r"\(.*?\)", " ", part)
        part = re.sub(r"(?i)\b(hybrid|onsite|on-site|in[- ]office|office|hq|remote|full[- ]time)\b", " ", part)
        part = re.sub(r"\s+", " ", part).strip(" -,:.")
        part = re.sub(r"(?i)^(based )?in ", "", part)
        if not part:
            return []
        bits = [b for b in (US_HINT.sub("", b).strip() for b in part.split(",")) if b]
        if len(bits) >= 2:
            city = bits[0].lower()
            for b in bits[1:]:
                st = b.upper() if b.upper() in STATE_CODES else STATES.get(b.lower())
                if st:
                    return [(self._city(city, st), st)]
            # "New York, San Francisco" is a list of cities; "Toronto, Ontario" is not.
            ids = [self._city(b.lower(), None) for b in bits]
            return [(rid, self.home_state[rid]) for rid in ids] if all(ids) else []
        if not bits:
            return []
        rid = self._city(bits[0].lower(), None)
        if rid:
            return [(rid, self.home_state[rid])]
        st = STATES.get(bits[0].lower())  # a bare state name: "Remote - Texas"
        return [(None, st)] if st else []

    def resolve(self, location: str) -> tuple[list[str], list[str]]:
        ids, states = [], []
        for part in SPLIT_LOCATIONS.split(location or ""):
            for rid, st in self.resolve_one(part):
                if rid and rid not in ids:
                    ids.append(rid)
                if st and st not in states:
                    states.append(st)
        return ids, states


def describe_location(index: MetroIndex, location: str, remote_flag: bool = False, hybrid_flag: bool = False) -> dict:
    ids, states = index.resolve(location)
    us = bool(ids or states) or bool(US_HINT.search(location or ""))
    return {"regionIds": ids, "states": states, "us": us,
            "remote": remote_flag or bool(REMOTE_HINT.search(location or "")),
            "hybrid": hybrid_flag or bool(re.search(r"hybrid", location or "", re.I))}


# ---------------------------------------------------------------- sources

def from_greenhouse(company: dict) -> list[dict]:
    data = get_json(f"https://boards-api.greenhouse.io/v1/boards/{company['board']}/jobs?content=true")
    out = []
    for j in data.get("jobs", []):
        offices = [o.get("name") for o in j.get("offices") or [] if o.get("name")]
        location = (j.get("location") or {}).get("name") or ""
        extra = [o for o in offices if o.lower() not in location.lower()]
        out.append({
            "id": f"gh-{company['board']}-{j['id']}",
            "company": company["name"],
            "title": j.get("title", "").strip(),
            "location": " | ".join([location, *extra]) if extra else location,
            "url": j.get("absolute_url"),
            "applyUrl": j.get("absolute_url"),
            "posted": iso_date(j.get("first_published") or j.get("updated_at")),
            "text": html_to_text(j.get("content")),
        })
    return out


def from_lever(company: dict) -> list[dict]:
    data = get_json(f"https://api.lever.co/v0/postings/{company['board']}?mode=json")
    out = []
    for j in data:
        cats = j.get("categories") or {}
        locs = cats.get("allLocations") or [cats.get("location")]
        lists = "\n".join(f"{l.get('text', '')}\n{html_to_text(l.get('content'))}" for l in j.get("lists") or [])
        text = "\n\n".join(filter(None, [j.get("descriptionPlain"), lists, j.get("additionalPlain")]))
        out.append({
            "id": f"lv-{company['board']}-{j['id']}",
            "company": company["name"],
            "title": j.get("text", "").strip(),
            "location": " | ".join(filter(None, locs)),
            "remote": j.get("workplaceType") == "remote",
            "hybrid": j.get("workplaceType") == "hybrid",
            "url": j.get("hostedUrl"),
            "applyUrl": j.get("applyUrl") or j.get("hostedUrl"),
            "posted": iso_date(j.get("createdAt")),
            "text": text.strip(),
        })
    return out


def _ashby_place(loc) -> str:
    if isinstance(loc, str):
        return loc
    addr = ((loc or {}).get("address") or {}).get("postalAddress") or {}
    place = ", ".join(filter(None, [addr.get("addressLocality"), addr.get("addressRegion"), addr.get("addressCountry")]))
    return place or (loc or {}).get("location") or ""


def from_ashby(company: dict) -> list[dict]:
    data = get_json(f"https://api.ashbyhq.com/posting-api/job-board/{company['board']}?includeCompensation=true")
    out = []
    for j in data.get("jobs", []):
        if j.get("isListed") is False:
            continue
        places = [j.get("location") or "", _ashby_place({"address": j.get("address")})]
        places += [_ashby_place(s) for s in j.get("secondaryLocations") or []]
        comp = ((j.get("compensation") or {}).get("scrapeableCompensationSalarySummary")) or ""
        out.append({
            "id": f"ab-{company['board']}-{j['id']}",
            "company": company["name"],
            "title": j.get("title", "").strip(),
            "location": " | ".join(dict.fromkeys(p for p in places if p)),
            "remote": bool(j.get("isRemote")) or j.get("workplaceType") == "Remote",
            "hybrid": j.get("workplaceType") == "Hybrid",
            "salary": comp or None,
            "url": j.get("jobUrl"),
            "applyUrl": j.get("applyUrl") or j.get("jobUrl"),
            "posted": iso_date(j.get("publishedAt")),
            "text": (j.get("descriptionPlain") or html_to_text(j.get("descriptionHtml"))).strip(),
        })
    return out


ROLE_HINT = re.compile(r"engineer|developer|programmer|scientist|architect|researcher|designer|"
                       r"\bsre\b|devops|manager|lead|head of|staff|intern|consultant|analyst|cto|founding", re.I)
LOC_HINT = re.compile(r"remote|onsite|on-site|hybrid|\b[A-Z]{2}\b|,|\b(US|USA|UK|EU|EMEA|APAC)\b")
WORK_MODE = re.compile(r"remote|onsite|on-site|hybrid|in[- ]office", re.I)
NOT_LOC = re.compile(r"full[- ]?time|part[- ]?time|contract|visa|equity|salary|[$€£]|\d+k\b|https?://", re.I)


def parse_hn_comment(comment_html: str) -> dict:
    """Split a Who's Hiring post's first line (Company | Role | Location | ...) into fields."""
    first = re.split(r"(?i)<p>|\n", comment_html or "", maxsplit=1)[0]
    head = html_to_text(first)
    fields = [f.strip() for f in head.split("|") if f.strip()]
    company = re.sub(r"\s*\(.*?\)\s*", " ", fields[0]).strip() if fields else "Unknown"
    rest = fields[1:]
    title = next((f for f in rest if ROLE_HINT.search(f) and not NOT_LOC.search(f)), "")
    # "REMOTE (US only; no visa sponsorship)" is still a location, so remote/onsite wins over NOT_LOC.
    locations = [f for f in rest if f != title and LOC_HINT.search(f)
                 and (WORK_MODE.search(f) or not NOT_LOC.search(f))]
    urls = [html.unescape(u) for u in re.findall(r'href="([^"]+)"', comment_html or "")]
    return {"company": company[:80], "title": title[:140], "location": " | ".join(locations)[:200],
            "link": urls[0] if urls else None}


def hacker_news_threads(months: int) -> list[str]:
    """Ids of the latest monthly "Who is hiring?" threads, newest first."""
    stories = get_json("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20")
    return [h["objectID"] for h in stories["hits"] if h["title"].startswith("Ask HN: Who is hiring?")][:months]


def from_hacker_news(story_id: str) -> list[dict]:
    thread = get_json(f"https://hn.algolia.com/api/v1/items/{story_id}", timeout=120)
    out = []
    for c in thread.get("children", []):
        if not c.get("text"):
            continue
        p = parse_hn_comment(c["text"])
        url = f"https://news.ycombinator.com/item?id={c['id']}"
        out.append({
            "id": f"hn-{c['id']}",
            "company": p["company"],
            "title": p["title"] or "Multiple roles (see post)",
            "location": p["location"],
            "url": url,
            "applyUrl": p["link"] or url,
            "posted": iso_date(c.get("created_at")),
            "text": html_to_text(c["text"]),
        })
    return out


def paced(seconds: float):
    """Call before each request to keep at least `seconds` between requests to one API."""
    last = [0.0]

    def wait():
        delay = last[0] + seconds - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        last[0] = time.monotonic()
    return wait


def from_adzuna(queries: list[tuple[str, str]], cfg: dict) -> list[dict]:
    app_id, app_key = os.environ.get("ADZUNA_APP_ID"), os.environ.get("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        raise SkipSource("set ADZUNA_APP_ID and ADZUNA_APP_KEY to include Adzuna")
    # The free tier is rate limited, so requests are spaced out and a 429 ends the run early
    # with whatever was collected.
    wait = paced(cfg.get("secondsBetweenCalls", 2.5))
    out = []
    for word, query in queries:
        for page in range(1, cfg.get("pages", 5) + 1):
            q = urllib.parse.urlencode({"app_id": app_id, "app_key": app_key, "what": query,
                                        "results_per_page": 50, "content-type": "application/json"})
            wait()
            try:
                data = get_json(f"https://api.adzuna.com/v1/api/jobs/{cfg.get('country', 'us')}/search/{page}?{q}")
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    log(f"  Adzuna rate limit reached after {len(out)} postings; keeping those")
                    return out
                raise
            for j in data.get("results", []):
                out.append({
                    "id": f"az-{j['id']}",
                    "company": (j.get("company") or {}).get("display_name") or "Unknown",
                    "title": html_to_text(j.get("title")),
                    "location": (j.get("location") or {}).get("display_name") or "",
                    "lat": j.get("latitude"), "lng": j.get("longitude"),
                    "url": j.get("redirect_url"),
                    "applyUrl": j.get("redirect_url"),
                    "posted": iso_date(j.get("created")),
                    # Adzuna only returns a snippet; the full text is on the linked page.
                    "text": html_to_text(j.get("description")),
                    "query": word,
                })
            if len(data.get("results", [])) < 50:
                break
    return out


def from_usajobs(queries: list[tuple[str, str]]) -> list[dict]:
    key, email = os.environ.get("USAJOBS_API_KEY"), os.environ.get("USAJOBS_EMAIL")
    if not (key and email):
        raise SkipSource("set USAJOBS_API_KEY and USAJOBS_EMAIL to include USAJobs")
    headers = {"Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": key}
    out = []
    for word, query in queries:
        q = urllib.parse.urlencode({"Keyword": query, "ResultsPerPage": 250})
        data = get_json(f"https://data.usajobs.gov/api/search?{q}", headers=headers)
        for item in data.get("SearchResult", {}).get("SearchResultItems", []):
            j = item.get("MatchedObjectDescriptor", {})
            details = (j.get("UserArea") or {}).get("Details") or {}
            text = "\n\n".join(filter(None, [details.get("JobSummary"), j.get("QualificationSummary"),
                                             "\n".join(details.get("MajorDuties") or [])]))
            if (j.get("ApplicationCloseDate") or "9999")[:10] < dt.date.today().isoformat():
                continue  # applications closed
            out.append({
                "id": f"us-{j.get('PositionID') or item.get('MatchedObjectId')}",
                "company": j.get("OrganizationName") or "US Government",
                "title": j.get("PositionTitle", ""),
                "location": " | ".join(l.get("LocationName", "") for l in j.get("PositionLocation") or []),
                "url": j.get("PositionURI"),
                "applyUrl": (j.get("ApplyURI") or [j.get("PositionURI")])[0],
                "posted": iso_date(j.get("PublicationStartDate")),
                "text": text,
                "query": word,
            })
    return out


def _stable_id(prefix: str, value: str) -> str:
    return f"{prefix}-{hashlib.sha1(value.encode()).hexdigest()[:12]}"


def _epoch_date(value) -> str | None:
    try:
        return dt.datetime.fromtimestamp(int(value), dt.timezone.utc).date().isoformat()
    except (TypeError, ValueError):
        return iso_date(value)


def _salary(lo, hi, currency="USD") -> str | None:
    try:
        lo, hi = int(float(lo or 0)), int(float(hi or 0))
    except (TypeError, ValueError):
        return None
    sym = "$" if (currency or "USD") == "USD" else f"{currency} "
    if lo and hi:
        return f"{sym}{lo // 1000}k–{sym}{hi // 1000}k"
    return f"{sym}{(lo or hi) // 1000}k" if (lo or hi) else None


def from_himalayas(queries: list[tuple[str, str]], cfg: dict) -> list[dict]:
    """Keyword search over Himalayas' remote jobs, limited to roles open to US residents.
    `pages` (20 jobs each) caps every search; `pagesPerKeyword` raises it for languages that
    Himalayas has many more of than the company boards do (C#/.NET)."""
    wait = paced(cfg.get("secondsBetweenCalls", 0.4))
    out = []
    for word, query in queries:
        for page in range(1, cfg.get("pagesPerKeyword", {}).get(word, cfg.get("pages", 10)) + 1):
            q = urllib.parse.urlencode({"q": query, "country": cfg.get("country", "US"), "page": page})
            wait()
            try:
                data = get_json(f"https://himalayas.app/jobs/api/search?{q}")
            except Exception as e:  # noqa: BLE001 - keep the other searches' results
                log(f"  Himalayas: {query!r} page {page} failed ({e}); moving on")
                break
            now = time.time()
            for j in data.get("jobs", []):
                if j.get("expiryDate") and float(j["expiryDate"]) < now:
                    continue  # past the employer's listing end date
                where = ", ".join(j.get("locationRestrictions") or []) or "Anywhere"
                out.append({
                    "id": _stable_id("hm", j.get("guid") or j.get("applicationLink") or j["title"]),
                    "company": j.get("companyName") or "Unknown",
                    "title": j.get("title", "").strip(),
                    "location": f"Remote ({where})",
                    "remote": True,
                    "salary": _salary(j.get("minSalary"), j.get("maxSalary"), j.get("currency")),
                    "url": j.get("guid") or j.get("applicationLink"),
                    "applyUrl": j.get("applicationLink") or j.get("guid"),
                    "posted": _epoch_date(j.get("pubDate")),
                    "text": html_to_text(j.get("description")),
                })
            # Pages sometimes hold 19 of 20, so a short page doesn't mean the end.
            if not data.get("jobs") or page * 20 >= (data.get("totalCount") or 0):
                break
    return out


def from_the_muse(cfg: dict) -> list[dict]:
    """The Muse's public API. Its country filter doesn't narrow results, so it's queried by city."""
    wait = paced(cfg.get("secondsBetweenCalls", 0.5))
    params = [("category", c) for c in cfg.get("categories", ["Software Engineering"])]
    params += [("location", loc) for loc in cfg.get("locations", [])]
    out, page, pages = [], 0, 1
    while page < min(pages, cfg.get("pages", 30)):
        wait()
        data = get_json("https://www.themuse.com/api/public/jobs?" + urllib.parse.urlencode([("page", page), *params]))
        pages = data.get("page_count", 0)
        page += 1
        for j in data.get("results", []):
            out.append({
                "id": f"mu-{j['id']}",
                "company": (j.get("company") or {}).get("name") or "Unknown",
                "title": j.get("name", "").strip(),
                "location": " | ".join(l["name"] for l in j.get("locations") or []),
                "url": (j.get("refs") or {}).get("landing_page"),
                "applyUrl": (j.get("refs") or {}).get("landing_page"),
                "posted": iso_date(j.get("publication_date")),
                "text": html_to_text(j.get("contents")),
            })
    return out


def from_remotive() -> list[dict]:
    # Remotive asks for at most ~4 requests a day; the fetcher makes one.
    data = get_json("https://remotive.com/api/remote-jobs?category=software-dev")
    return [{
        "id": f"rv-{j['id']}",
        "company": j.get("company_name") or "Unknown",
        "title": j.get("title", "").strip(),
        "location": f"Remote ({j.get('candidate_required_location') or 'Anywhere'})",
        "remote": True,
        "salary": j.get("salary") or None,
        "url": j.get("url"),
        "applyUrl": j.get("url"),
        "posted": iso_date(j.get("publication_date")),
        "text": html_to_text(j.get("description")),
    } for j in data.get("jobs", [])]


def _unmangle(s: str) -> str:
    """Remote OK sometimes double-encodes UTF-8 ("Sothebyâ€™s")."""
    if "â" in (s or "") or "Ã" in (s or ""):
        try:
            return s.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return s
    return s


def from_remote_ok() -> list[dict]:
    data = get_json("https://remoteok.com/api", headers={"User-Agent": "Mozilla/5.0"})
    out = []
    for j in data[1:]:  # the first element is the API's legal notice
        if not j.get("id"):
            continue
        out.append({
            "id": f"ro-{j['id']}",
            "company": _unmangle(j.get("company") or "Unknown"),
            "title": _unmangle(j.get("position", "")).strip(),
            "location": f"Remote ({_unmangle(j.get('location') or 'Anywhere')})",
            "remote": True,
            "salary": _salary(j.get("salary_min"), j.get("salary_max")),
            "url": j.get("url"),
            "applyUrl": j.get("apply_url") or j.get("url"),
            "posted": iso_date(j.get("date")),
            "text": _unmangle(html_to_text(j.get("description"))),
        })
    return out


def from_jobicy() -> list[dict]:
    data = get_json("https://jobicy.com/api/v2/remote-jobs?count=100&industry=dev")
    return [{
        "id": f"jc-{j['id']}",
        "company": j.get("companyName") or "Unknown",
        "title": html.unescape(j.get("jobTitle", "")).strip(),
        "location": f"Remote ({j.get('jobGeo') or 'Anywhere'})",
        "remote": True,
        "salary": _salary(j.get("salaryMin"), j.get("salaryMax"), j.get("salaryCurrency")),
        "url": j.get("url"),
        "applyUrl": j.get("url"),  # Jobicy's terms: apply buttons go to the feed's job URL
        "posted": iso_date(j.get("pubDate")),
        "text": html_to_text(j.get("jobDescription")),
    } for j in data.get("jobs", [])]


class SkipSource(Exception):
    pass


# ---------------------------------------------------------------- assembly

def nearest_metro(index: MetroIndex, lat, lng, max_km: float = 60) -> str | None:
    """Fallback for sources that give coordinates (Adzuna)."""
    import math
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    best, best_d = None, max_km
    for rid, m in index.metros.items():
        dlat, dlng = math.radians(float(m["lat"]) - lat), math.radians(float(m["lng"]) - lng)
        a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat)) * math.cos(math.radians(float(m["lat"]))) * math.sin(dlng / 2) ** 2
        d = 6371 * 2 * math.asin(math.sqrt(a))
        if d < best_d:
            best, best_d = rid, d
    return best


def finalize(raw: list[dict], source: str, keywords: dict[str, re.Pattern], index: MetroIndex):
    jobs, texts = [], {}
    for j in raw:
        text = j.pop("text", "") or ""
        query = j.pop("query", None)
        hit = match_keywords(j["title"], text, keywords)
        if not hit and query:
            # Search APIs matched the keyword on text they don't return in full; trust them.
            hit = {"keywords": [query], "inTitle": [], "mentions": {query: 1}, "snippets": {query: text[:2 * SNIPPET_CHARS]}}
        if not hit:
            continue
        loc = describe_location(index, j.get("location", ""), j.pop("remote", False), j.pop("hybrid", False))
        loc["hybrid"] = loc["hybrid"] or bool(HYBRID_TEXT.search(text))
        lat, lng = j.pop("lat", None), j.pop("lng", None)
        if not loc["regionIds"] and lat is not None:
            rid = nearest_metro(index, lat, lng)
            if rid:
                loc["regionIds"], loc["us"] = [rid], True
                loc["states"] = loc["states"] or [index.home_state[rid]]
        if j.get("applyUrl") == j.get("url"):
            j.pop("applyUrl")  # the site falls back to url
        job = {"id": j["id"], "source": source, "location": "",
               **{k: v for k, v in j.items() if k != "id" and v not in (None, "")},
               **loc, **hit, "level": classify_level(j["title"]), "years": required_years(text)}
        # Omit false and unknown values; with ~10k postings they add up, and the site treats missing as false.
        for key in ("us", "remote", "hybrid", "years"):
            if not job[key] and job[key] != 0:
                del job[key]
        jobs.append(job)
        texts[j["id"]] = text[:TEXT_LIMIT]
    return jobs, texts


def too_old(job: dict, max_age: dict, today: dt.date) -> bool:
    """Feeds don't say when a role is filled, so their postings expire by age. Company boards list
    only open roles (a filled one drops out of the API), so they have no age limit by default."""
    days = max_age.get(job["source"])
    posted = job.get("posted") or ""
    if days is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", posted):
        return False
    return (today - dt.date.fromisoformat(posted)).days > days


def load_previous(out: Path) -> tuple[dict, dict]:
    """The last run's jobs by id, and its top-level fields, for tracking what's new and what closed."""
    try:
        prev = json.loads((out / "jobs.json").read_text())
    except (OSError, ValueError):
        return {}, {}
    return {j["id"]: j for j in prev.get("jobs", [])}, {k: v for k, v in prev.items() if k != "jobs"}


def previous_text(out: Path, ids: set[str]) -> dict[str, str]:
    texts = {}
    for shard in {text_shard(i) for i in ids}:
        try:
            data = json.loads((out / "jobs-text" / f"{shard}.json").read_text())
        except (OSError, ValueError):
            continue
        texts.update({i: data[i] for i in ids if i in data})
    return texts


def dedupe(jobs: list[dict]) -> list[dict]:
    seen, out = set(), []
    for j in jobs:
        key = (j["company"].lower(), j["title"].lower(), j.get("location", "").lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(j)
    return out


TEXT_SHARDS = 32


def text_shard(job_id: str) -> str:
    """FNV-1a of the id, so the site can find a posting's text file without an index (see jobs.js)."""
    h = 0x811C9DC5
    for byte in job_id.encode():
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"{h % TEXT_SHARDS:02d}"


def write_text_shards(out: Path, texts: dict[str, str]) -> None:
    """Full posting text, split so reading one posting downloads ~1/32 of it."""
    shards: dict[str, dict] = {f"{i:02d}": {} for i in range(TEXT_SHARDS)}
    for job_id, text in texts.items():
        shards[text_shard(job_id)][job_id] = text
    folder = out / "jobs-text"
    folder.mkdir(exist_ok=True)
    for name, data in shards.items():
        write_atomic(folder / f"{name}.json", data)
    (out / "jobs-text.json").unlink(missing_ok=True)  # single-file layout used before sharding


def write_atomic(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)


SOURCE_LABELS = {"greenhouse": "Greenhouse", "lever": "Lever", "ashby": "Ashby",
                 "himalayas": "Himalayas", "muse": "The Muse", "remotive": "Remotive",
                 "remoteok": "Remote OK", "jobicy": "Jobicy",
                 "hn": "Hacker News", "adzuna": "Adzuna", "usajobs": "USAJobs"}
BOARD_FETCHERS = {"greenhouse": from_greenhouse, "lever": from_lever, "ashby": from_ashby}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--keywords", nargs="+", help="Override the keywords in the config")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    cfg = json.loads(args.config.read_text())
    specs = [keyword_spec(k) for k in (args.keywords or cfg.get("keywords") or ["Rust"])]
    words = [k["name"] for k in specs]
    keywords = {k["name"]: compile_keyword(k) for k in specs}
    index = MetroIndex(json.loads(METROS.read_text()))

    # Every fetch is an independent (source, label, thunk); failures are reported, never fatal.
    queries = [(k["name"], q) for k in specs for q in k["queries"]]
    tasks = [(c["ats"], c["name"], lambda c=c: BOARD_FETCHERS[c["ats"]](c)) for c in cfg.get("companies", [])]
    hn = cfg.get("hackerNews", True)
    if hn:
        months = hn.get("months", 1) if isinstance(hn, dict) else 1
        try:
            for story in hacker_news_threads(months):
                tasks.append(("hn", f"Who is hiring {story}", lambda story=story: from_hacker_news(story)))
        except Exception as e:  # noqa: BLE001 - reported like any other failed source
            log(f"  Hacker News: could not list threads ({type(e).__name__}: {e})")
    if cfg.get("himalayas"):
        tasks.append(("himalayas", "Himalayas", lambda: from_himalayas(queries, cfg["himalayas"])))
    if cfg.get("theMuse"):
        tasks.append(("muse", "The Muse", lambda: from_the_muse(cfg["theMuse"])))
    for key, source, fn in (("remotive", "remotive", from_remotive), ("remoteOk", "remoteok", from_remote_ok),
                            ("jobicy", "jobicy", from_jobicy)):
        if cfg.get(key):
            tasks.append((source, SOURCE_LABELS[source], fn))
    if cfg.get("adzuna") is not None:
        tasks.append(("adzuna", "Adzuna", lambda: from_adzuna(queries, cfg["adzuna"])))
    if cfg.get("usajobs", True):
        tasks.append(("usajobs", "USAJobs", lambda: from_usajobs(queries)))

    def run(task):
        source, label, fn = task
        try:
            return source, label, fn(), None
        except SkipSource as e:
            return source, label, None, f"skipped: {e}"
        except Exception as e:  # network errors, renamed boards, API changes
            return source, label, None, f"{type(e).__name__}: {e}"

    log(f"Fetching {len(tasks)} sources for {', '.join(words)}...")
    with ThreadPoolExecutor(12) as ex:
        results = list(ex.map(run, tasks))

    prev_jobs, prev_meta = load_previous(args.out)
    today = dt.datetime.now(dt.timezone.utc).date()
    all_jobs, all_text, sources = [], {}, {}
    carried = []
    for source, label, raw, err in results:
        s = sources.setdefault(source, {"source": source, "label": SOURCE_LABELS[source],
                                        "boards": 0, "scanned": 0, "matched": 0, "problems": []})
        if err:
            s["problems"].append(f"{label}: {err}")
            log(f"  {SOURCE_LABELS[source]:<11} {label:<24} {err}")
            # A source that failed to load this time hasn't closed its roles; keep last run's postings
            # (still subject to the age limit below). Skipped sources (no API key) are really off.
            if source in BOARD_FETCHERS:
                carried += [j for j in prev_jobs.values() if j["source"] == source and j["company"] == label]
            elif source != "hn" and not err.startswith("skipped"):
                carried += [j for j in prev_jobs.values() if j["source"] == source]
            continue
        jobs, texts = finalize(raw, source, keywords, index)
        s["boards"] += 1
        s["scanned"] += len(raw)
        s["matched"] += len(jobs)
        all_jobs += jobs
        all_text.update(texts)

    if carried:
        all_jobs += carried
        all_text.update(previous_text(args.out, {j["id"] for j in carried}))
        log(f"  kept {len(carried)} postings from sources that failed to load this run")

    max_age = cfg.get("maxAgeDays", {})
    expired = sum(too_old(j, max_age, today) for j in all_jobs)
    all_jobs = [j for j in all_jobs if not too_old(j, max_age, today)]

    all_jobs.sort(key=lambda j: j.get("posted") or "", reverse=True)  # keep the newest of duplicates
    all_jobs = dedupe(all_jobs)

    # firstSeen lets the site flag new postings; ids missing from this run are roles that closed.
    tracked_since = prev_meta.get("trackedSince") or today.isoformat()
    for j in all_jobs:
        j["firstSeen"] = prev_jobs.get(j["id"], {}).get("firstSeen") or today.isoformat()
    ids = {j["id"] for j in all_jobs}
    changes = {"since": prev_meta.get("generated"), "new": len(ids - prev_jobs.keys()) if prev_jobs else None,
               "closed": len(prev_jobs.keys() - ids) if prev_jobs else None, "expired": expired}
    all_jobs.sort(key=lambda j: (-len(j["inTitle"]), -min(sum(j["mentions"].values()), 3),
                                 -(dt.date.fromisoformat(j["posted"]).toordinal()
                                   if re.fullmatch(r"\d{4}-\d{2}-\d{2}", j.get("posted") or "") else 0)))
    kept = {j["id"] for j in all_jobs}
    all_text = {k: v for k, v in all_text.items() if k in kept}

    fetched = sum(s["boards"] for s in sources.values())
    if not fetched:
        log("Every source failed. Keeping the existing jobs.json.")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    write_atomic(args.out / "jobs.json", {
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "trackedSince": tracked_since,
        "changes": changes,
        "keywords": specs,
        "textShards": TEXT_SHARDS,
        "sources": list(sources.values()),
        "jobs": all_jobs,
    })
    write_text_shards(args.out, all_text)

    log("")
    for s in sources.values():
        log(f"  {s['label']:<11} {s['boards']:>3} fetched  {s['scanned']:>6} postings scanned  {s['matched']:>4} matched"
            + (f"  ({len(s['problems'])} problem{'s' * (len(s['problems']) != 1)})" if s["problems"] else ""))
    on_map = sum(1 for j in all_jobs if j["regionIds"])
    by_word = {w: sum(w in j["keywords"] for j in all_jobs) for w in words}
    log(f"\n{len(all_jobs)} postings mention at least one keyword; {on_map} placed on the map, "
        f"{sum(bool(j.get('remote')) for j in all_jobs)} remote, {sum(bool(j.get('hybrid')) for j in all_jobs)} hybrid.")
    if prev_jobs:
        log(f"Since the last run: {changes['new']} new, {changes['closed']} closed or expired"
            f" ({expired} dropped for age).")
    log("  " + ", ".join(f"{w} {n}" for w, n in by_word.items()))
    log(f"Wrote {args.out / 'jobs.json'} and {TEXT_SHARDS} text files in {args.out / 'jobs-text'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
