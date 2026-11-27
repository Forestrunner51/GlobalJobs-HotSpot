"""Collect live job postings that mention the languages in jobs/sources.json (Rust, C++, Go, ...),
tagged with the frameworks and cloud tools they mention (React, Spring Boot, AWS, ...).

Writes web/data/jobs.json (the list the site shows) and web/data/jobs-text/*.json (full posting
text in 32 pieces, loaded only when you open a posting or copy it for apply/jobprep.py).

Sources, all used through their public APIs:
  Greenhouse, Lever, Ashby,  company job boards listed in sources.json (no key needed). Workday,
  Workday, SmartRecruiters,  SmartRecruiters and Workable list postings without their text, so
  Workable                   only tech-looking titles are opened, paced, and reused across runs
  Hacker News                recent monthly "Ask HN: Who is hiring?" threads (no key needed)
  Himalayas                  job search API (no key needed). The Muse closed its public API in
                             November 2026, so it's no longer a source
  Remotive, Remote OK, Jobicy  remote-job feeds; their terms ask that listings name them and link
                             back to their page, which the site does ("via Remote OK")
  Adzuna                     off by default (paid API). To use it, set "enabled": true under "adzuna" in
                             sources.json and set ADZUNA_APP_ID and ADZUNA_APP_KEY (developer.adzuna.com)
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
import random
import re
import sys
import threading
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


def get_json(url: str, headers: dict | None = None, timeout: int = 60, body: dict | None = None):
    """GET (or, with `body`, POST as JSON) and parse JSON, retrying server errors and network
    failures. Client errors (404, 429) are raised at once: retrying won't fix them, and 429 means
    slow down."""
    extra = {"Content-Type": "application/json", "Accept": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={"User-Agent": USER_AGENT, **extra, **(headers or {})})
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

DEFAULT_GROUPS = [{"id": "language", "label": "Languages"}]


def keyword_groups(cfg: dict) -> list[dict]:
    """The rows of filters on the site, in order. A group with "tagOnly" (frameworks, cloud tools)
    labels postings that match another group but never brings in a posting by itself, so a sales
    role that mentions AWS stays out. A group with "titleOnly" (roles: Platform, SRE, ...) is
    matched against job titles only, since nearly every posting says "infrastructure" somewhere;
    its "titleRequires" / "titleExcludes" patterns keep "Cloud Account Executive" out. A group with
    "minMentions" (XR) needs its keyword in the title or that many times in the text, so a company's
    boilerplate ("build for PC, console and VR") doesn't tag every posting it has."""
    return cfg.get("keywordGroups") or DEFAULT_GROUPS


class TitleRules:
    """Which keywords are matched on the title alone, what else the title must (not) say, and how
    often a keyword must appear in the text when the title doesn't name it."""

    def __init__(self, specs: list[dict], groups: list[dict]):
        by_id = {g["id"]: g for g in groups}
        self.names = frozenset(k["name"] for k in specs if by_id.get(k["group"], {}).get("titleOnly"))
        self.requires, self.excludes = {}, {}
        self.min_mentions = {k["name"]: by_id[k["group"]]["minMentions"] for k in specs
                             if by_id.get(k["group"], {}).get("minMentions")}
        for k in specs:
            g = by_id.get(k["group"], {})
            if k["name"] in self.names:
                self.requires[k["name"]] = re.compile(g["titleRequires"], re.I) if g.get("titleRequires") else None
                self.excludes[k["name"]] = re.compile(g["titleExcludes"], re.I) if g.get("titleExcludes") else None

    def allows(self, word: str, title: str) -> bool:
        need, bar = self.requires.get(word), self.excludes.get(word)
        return (not need or bool(need.search(title))) and not (bar and bar.search(title))


NO_TITLE_RULES = TitleRules([], [])


def keyword_spec(entry: str | dict) -> dict:
    """A keyword from sources.json: a plain name, or {"name", "pattern"?, "caseSensitive"?, "group"?}.

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
            "aliases": entry.get("aliases", []),  # former names, so old links on the site still work
            "group": entry.get("group", "language")}


def compile_keyword(spec: dict) -> re.Pattern:
    return re.compile(spec["pattern"], re.I if "i" in spec["flags"] else 0)


def _snippet(text: str, m: re.Match) -> str:
    a, b = max(0, m.start() - SNIPPET_CHARS), min(len(text), m.end() + SNIPPET_CHARS)
    return ("…" if a else "") + text[a:b].replace("\n", " ").strip() + ("…" if b < len(text) else "")


def match_keywords(title: str, text: str, keywords: dict[str, re.Pattern],
                   tag_only: frozenset[str] = frozenset(), roles: TitleRules = NO_TITLE_RULES) -> dict | None:
    """Which keywords a posting mentions, which are in the title, how often each appears in the
    text, and a snippet around each keyword's first mention. None unless at least one keyword
    outside tag_only matches."""
    found, in_title, mentions, snippets = [], [], {}, {}
    for word, rx in keywords.items():
        t_hit = bool(rx.search(title))
        if word in roles.names:  # a role: the title has to say it
            if not (t_hit and roles.allows(word, title)):
                continue
            hits = []
        else:
            hits = list(rx.finditer(text))
            if not t_hit and len(hits) < roles.min_mentions.get(word, 1):
                continue
        if not (t_hit or hits):
            continue
        found.append(word)
        if t_hit:
            in_title.append(word)
        mentions[word] = len(hits)
        if hits:
            snippets[word] = _snippet(text, hits[0])
    if all(w in tag_only for w in found):
        return None
    # A posting listing ten languages doesn't need ten snippets: keep the most central ones,
    # languages before tags.
    central = sorted(snippets, key=lambda w: (w in tag_only, w not in in_title, -mentions[w]))[:SNIPPETS_PER_JOB]
    snippets = {w: snippets[w] for w in central}
    if not snippets and text:  # matched on the title alone: show how the posting opens
        opening = text[:2 * SNIPPET_CHARS].replace("\n", " ").strip()
        snippets[found[0]] = opening + ("…" if len(text) > 2 * SNIPPET_CHARS else "")
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


# ---------------------------------------------------------------- employment type

# A board's own employment-type field, letters only ("Full-Time", "full_time" -> "fulltime"). Lever's
# field is free text ("Contract - 6 months"), so these are searched for, not matched exactly.
# Anything else (full-time, internship, "Permanent") counts as full-time.
_TYPE_WORDS = [(re.compile(r"contract|freelance|temp|fixedterm"), "contract"), (re.compile(r"parttime"), "parttime")]
# Titles like "Unity Developer (Contract)" or "Backend Engineer - Contractor". "Contract" has to be
# set off from the rest of the title, so "Smart Contract Engineer" and "Contracts Manager" don't count.
CONTRACT_TITLE = re.compile(r"(?:^|[(\[,|/–—-]\s*)(?:\d+[- ]months?\s+)?(?:contract(?:or)?|freelance|temporary|temp|"
                            r"fixed[- ]term|contract[- ]to[- ]hire|1099|c2c)(?:\s*(?:role|position|basis|only))?\s*(?:[)\],|/–—-]|$)"
                            r"|\bfreelancer?\b|\bcontractor\b", re.I)
PARTTIME_TITLE = re.compile(r"\bpart[- ]time\b", re.I)
# Body text: only a direct statement about this role, not "contractors and employees alike".
CONTRACT_TEXT = re.compile(r"\b(?:this|the|it)\s+is\s+an?\s+(?:\d+[- ](?:month|week)\s+|short[- ]term\s+|long[- ]term\s+|remote\s+)*"
                           r"(?:contract|contractor|freelance|temporary|fixed[- ]term|contract[- ]to[- ]hire)\b"
                           r"|\b\d+[- ]months?\s+contract(?:[- ]to[- ]hire)?\b|\bcontract[- ]to[- ]hire\b"
                           r"|\b(?:employment|job|position|engagement)\s+type:?\s+(?:contract|contractor|freelance|temporary)\b", re.I)
PARTTIME_TEXT = re.compile(r"\b(?:this|the|it)\s+is\s+an?\s+(?:remote\s+)?part[- ]time\b"
                           r"|\b(?:employment|job|position)\s+type:?\s+part[- ]time\b", re.I)


def employment_type(board_value, title: str, text: str = "") -> str | None:
    """"contract", "parttime", or None for full-time / not stated, from the board's own field
    (Lever, Ashby, Himalayas, Remotive, Jobicy, Adzuna), the title, or, when the board doesn't say,
    a plain statement in the text ("This is a 6-month contract role")."""
    values = board_value if isinstance(board_value, list) else [board_value]
    keys = [re.sub(r"[^a-z]", "", str(v or "").lower()) for v in values]
    for rx, kind in _TYPE_WORDS:
        if any(rx.search(k) for k in keys):
            return kind
    # Boards often leave the field at its "Full-time" default, so a title saying otherwise wins.
    if CONTRACT_TITLE.search(title):
        return "contract"
    if PARTTIME_TITLE.search(title):
        return "parttime"
    if any(keys):
        return None  # the board says it's full-time (or an internship)
    head = text[:4000]
    if CONTRACT_TEXT.search(head):
        return "contract"
    if PARTTIME_TEXT.search(head):
        return "parttime"
    return None


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


# ---------------------------------------------------------------- pay

_AMOUNT = r"(\d{2,3},\d{3}|\d{2,3}(?:\.\d)?\s?[kK])(?:\.\d{2})?"
# "$150,000 - $200,000", "$150K–$200K", "USD 150,000 to 200,000", "$120,000.00 — $180,000.00 USD".
# Pay-transparency laws put a range like this in most US postings even when the board's API has no
# salary field. Hourly rates and one-off figures ("$50,000 sign-on bonus") aren't ranges, so they don't match.
PAY_RANGE = re.compile(rf"(?:\$|USD\s?)\s?{_AMOUNT}\s*(?:USD\s*)?(?:-|–|—|to|and)\s*(?:\$|USD\s?)?\s?{_AMOUNT}", re.I)
PAY_MIN, PAY_MAX = 30_000, 900_000  # outside this it's a bonus, a budget or a revenue figure


def _amount(s: str) -> int:
    s = s.strip().lower().replace(",", "")
    return int(float(s.rstrip("k ").strip()) * 1000) if s.endswith("k") else int(float(s))


def salary_from_text(text: str) -> str | None:
    """The first annual pay range stated in the posting, as "$150k–$200k"."""
    for m in PAY_RANGE.finditer(text):
        lo, hi = _amount(m.group(1)), _amount(m.group(2))
        if PAY_MIN <= lo <= hi <= PAY_MAX and hi <= lo * 4:
            lo, hi = round(lo / 1000), round(hi / 1000)
            return f"${lo}k" if lo == hi else f"${lo}k–${hi}k"
    return None


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
            "employment": cats.get("commitment"),
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
            "employment": j.get("employmentType"),
            "url": j.get("jobUrl"),
            "applyUrl": j.get("applyUrl") or j.get("jobUrl"),
            "posted": iso_date(j.get("publishedAt")),
            "text": (j.get("descriptionPlain") or html_to_text(j.get("descriptionHtml"))).strip(),
        })
    return out


# ---------------------------------------------------------------- Workday, SmartRecruiters, Workable
#
# These list postings without their text, so each posting's text is one more request. To keep
# that down, only titles that look like tech roles are opened, a posting already read last run
# reuses last run's text, and each API's requests go through one shared, paced queue (Workday and
# Workable refuse a burst of requests from one address for several minutes).

TECH_TITLE = re.compile(r"engineer|developer|programmer|software|scientist|architect|\bSRE\b|devops|devsecops|"
                        r"reliability|platform|infrastructure|cloud|security|data|machine learning|\bML\b|\bAI\b|"
                        r"technical|technologist|graphics|rendering|XR|\bVR\b|\bAR\b|reality|unity|unreal|"
                        r"game(?:play)?|firmware|embedded|systems|computer vision|robotics|\bQA\b|\btest|\bSDET\b|"
                        r"\bintern(?:ship)?\b|\bco-?op\b", re.I)


class Throttle:
    """At most one request per `seconds` across every thread that shares it."""

    def __init__(self, seconds: float):
        self.seconds, self.next, self.lock = seconds, 0.0, threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            delay = self.next - now
            self.next = max(now, self.next) + self.seconds
        if delay > 0:
            time.sleep(delay)


THROTTLES = {"workday": Throttle(1.0), "smartrecruiters": Throttle(0.25), "workable": Throttle(2.0)}

# Last run's postings and their text, so a posting already read isn't downloaded again. main()
# fills this in; tests and single fetches leave it empty.
REUSE: dict = {"jobs": {}, "out": None}
_SHARD_CACHE: dict[str, dict] = {}
_SHARD_LOCK = threading.Lock()


def reuse(job_id: str) -> dict | None:
    """Last run's posting as a raw record (text included), or None if it has to be fetched."""
    prev = REUSE["jobs"].get(job_id)
    if not prev or REUSE["out"] is None:
        return None
    shard = text_shard(job_id)
    with _SHARD_LOCK:
        if shard not in _SHARD_CACHE:
            try:
                _SHARD_CACHE[shard] = json.loads((REUSE["out"] / "jobs-text" / f"{shard}.json").read_text())
            except (OSError, ValueError):
                _SHARD_CACHE[shard] = {}
        text = _SHARD_CACHE[shard].get(job_id)
    if not text:
        return None
    return {"id": job_id, "company": prev["company"], "title": prev["title"], "location": prev.get("location", ""),
            "remote": bool(prev.get("remote")), "hybrid": bool(prev.get("hybrid")), "salary": prev.get("salary"),
            "employment": {"contract": "Contract", "parttime": "Part-time"}.get(prev.get("type"), "Full-time"),
            "url": prev.get("url"), "applyUrl": prev.get("applyUrl") or prev.get("url"),
            "posted": prev.get("posted"), "text": text}


def throttled_json(api: str, url: str, body: dict | None = None):
    """get_json through the API's shared throttle. One 429 waits RATE_LIMIT_WAIT and retries; a
    second is raised, so main() keeps that company's postings from last run."""
    for attempt in (1, 2):
        THROTTLES[api].wait()
        try:
            return get_json(url, body=body, timeout=30)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 2:
                raise
            log(f"  {SOURCE_LABELS[api]}: rate limited; waiting {RATE_LIMIT_WAIT}s")
            time.sleep(RATE_LIMIT_WAIT)


def from_workday(company: dict) -> list[dict]:
    """A company's Workday careers site, e.g. "url": "https://unitytech.wd1.myworkdayjobs.com/Unity"
    or "https://wd1.myworkdaysite.com/recruiting/snapchat/snap".
    Optional: "search" (Workday's own keyword box, to narrow very large sites), "maxPages" (pages
    of 20 to list, default 25) and "maxPostings" (new postings to open per run, default 120; ones
    read on an earlier run don't count, so a large site fills in over a few runs)."""
    parts = urllib.parse.urlsplit(company["url"])
    path = [p for p in parts.path.split("/") if p and not re.fullmatch(r"[a-z]{2}-[A-Z]{2}", p)]
    if parts.netloc.endswith("myworkdaysite.com"):  # wd1.myworkdaysite.com/recruiting/<tenant>/<site>
        tenant, site = path[1], path[2]
        public = f"https://{parts.netloc}/recruiting/{tenant}/{site}"
    else:  # <tenant>.wd5.myworkdayjobs.com/<site>
        tenant, site = parts.netloc.split(".")[0], path[0]
        public = f"https://{parts.netloc}/{site}"
    api = f"https://{parts.netloc}/wday/cxs/{tenant}/{site}"
    listed, offset, total = [], 0, None
    while offset < company.get("maxPages", 25) * 20 and (total is None or offset < total):
        data = throttled_json("workday", f"{api}/jobs", {"appliedFacets": {}, "limit": 20, "offset": offset,
                                                         "searchText": company.get("search", "")})
        if total is None:
            total = data.get("total") or 0  # only the first page reports it
        page = data.get("jobPostings") or []
        if not page:
            break
        listed += page
        offset += 20
    out, opened = [], 0
    for p in listed:
        job_path = p.get("externalPath") or ""
        if not job_path or not TECH_TITLE.search(p.get("title", "")):
            continue
        req = next((b for b in p.get("bulletFields") or [] if re.fullmatch(r"[A-Za-z0-9_-]{3,40}", b)), None)
        job_id = f"wd-{tenant}-{req}" if req else _stable_id(f"wd-{tenant}", job_path)
        old = reuse(job_id)
        if old:
            out.append(old)
            continue
        if opened >= company.get("maxPostings", 120):
            continue
        opened += 1
        info = (throttled_json("workday", f"{api}{job_path}") or {}).get("jobPostingInfo") or {}
        url = info.get("externalUrl") or f"{public}{job_path}"
        places = [info.get("location") or p.get("locationsText") or "", *(info.get("additionalLocations") or [])]
        remote_type = (info.get("remoteType") or "").lower()
        out.append({
            "id": job_id,
            "company": company["name"],
            "title": (info.get("title") or p.get("title", "")).strip(),
            "location": " | ".join(dict.fromkeys(x for x in places if x)),
            "remote": "remote" in remote_type,
            "hybrid": "hybrid" in remote_type,
            "employment": info.get("timeType"),
            "url": url,
            "applyUrl": url,
            "posted": iso_date(info.get("startDate")),
            "text": html_to_text(info.get("jobDescription")),
        })
    return out


def _sr_location(loc: dict) -> str:
    """"Austin, TEXAS" or "Frankfurt, Germany". The full country name, not SmartRecruiters' two-letter
    code, which for Canada ("CA") would read as California."""
    loc = loc or {}
    full = [x.strip() for x in (loc.get("fullLocation") or "").split(",") if x.strip()]
    if (loc.get("country") or "").lower() == "us":
        place = ", ".join(x for x in [loc.get("city"), loc.get("region")] if x) or "United States"
    else:
        place = ", ".join(dict.fromkeys(x for x in [loc.get("city"), full[-1] if full else (loc.get("country") or "").upper()] if x))
    return f"{place} (Remote)" if loc.get("remote") else place


def from_smartrecruiters(company: dict) -> list[dict]:
    """A company's SmartRecruiters board ("board" is the id in jobs.smartrecruiters.com/<board>)."""
    base = f"https://api.smartrecruiters.com/v1/companies/{company['board']}/postings"
    listed, offset, total = [], 0, None
    while total is None or offset < min(total, company.get("maxList", 2000)):
        data = throttled_json("smartrecruiters", f"{base}?limit=100&offset={offset}")
        total = data.get("totalFound") or 0
        page = data.get("content") or []
        if not page:
            break
        listed += page
        offset += 100
    out, opened = [], 0
    for p in listed:
        if not TECH_TITLE.search(p.get("name", "")):
            continue
        job_id = f"sr-{company['board']}-{p['id']}"
        old = reuse(job_id)
        if old:
            out.append(old)
            continue
        if opened >= company.get("maxPostings", 300):
            continue
        opened += 1
        d = throttled_json("smartrecruiters", f"{base}/{p['id']}")
        sections = ((d.get("jobAd") or {}).get("sections")) or {}
        text = "\n\n".join(html_to_text((sections.get(k) or {}).get("text"))
                            for k in ("jobDescription", "qualifications", "additionalInformation", "companyDescription"))
        loc = p.get("location") or {}
        out.append({
            "id": job_id,
            "company": company["name"],
            "title": p.get("name", "").strip(),
            "location": _sr_location(loc),
            "remote": bool(loc.get("remote")),
            "hybrid": bool(loc.get("hybrid")),
            "employment": (p.get("typeOfEmployment") or {}).get("label"),
            "url": d.get("postingUrl"),
            "applyUrl": d.get("applyUrl") or d.get("postingUrl"),
            "posted": iso_date(p.get("releasedDate")),
            "text": text.strip(),
        })
    return out


def from_workable(company: dict) -> list[dict]:
    """A company's Workable board ("board" is the account in apply.workable.com/<board>). One request
    returns every posting with its text."""
    data = throttled_json("workable", f"https://apply.workable.com/api/v1/widget/accounts/{company['board']}?details=true")
    out = []
    for j in data.get("jobs", []):
        locs = j.get("locations") or [{"city": j.get("city"), "region": j.get("state"), "country": j.get("country")}]
        places = [", ".join(x for x in [l.get("city"), l.get("region") or l.get("country")] if x) for l in locs]
        out.append({
            "id": f"wk-{company['board']}-{j.get('shortcode') or _stable_id('', j.get('url', ''))}",
            "company": company["name"],
            "title": (j.get("title") or "").strip(),
            "location": " | ".join(dict.fromkeys(p for p in places if p)),
            "remote": bool(j.get("telecommuting")),
            "employment": j.get("employment_type"),
            "url": j.get("url") or j.get("shortlink"),
            "applyUrl": j.get("application_url") or j.get("url"),
            "posted": iso_date(j.get("published_on") or j.get("created_at")),
            "text": html_to_text(j.get("description")),
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
                    "employment": [j.get("contract_type"), j.get("contract_time")],
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


# Searches Himalayas didn't get to last run (it rate limits part-way through most runs), as
# "query|employment type" keys. main() saves them in jobs.json and puts them first next run.
HIMALAYAS_PENDING: list[str] = []


def himalayas_searches(queries: list[tuple[str, str]], cfg: dict, pending: list[str] | None = None) -> list[tuple]:
    """(word, query, employment type, pages) for every search, last run's unfinished ones first.
    With "contractPages", each query is also searched among contract jobs only."""
    searches = [(w, q, "", cfg.get("pagesPerKeyword", {}).get(w, cfg.get("pages", 10))) for w, q in queries]
    if cfg.get("contractPages"):
        searches += [(w, q, "Contractor", cfg["contractPages"]) for w, q in queries]
    if cfg.get("shuffle"):
        # In a fixed order the same last searches would never run; shuffled, each run covers a
        # different part and main() keeps the rest from earlier runs.
        searches = random.sample(searches, len(searches))
    first = {k: i for i, k in enumerate(pending or [])}
    return sorted(searches, key=lambda s: first.get(f"{s[1]}|{s[2]}", len(first)))  # stable: keeps the shuffle


def from_himalayas(queries: list[tuple[str, str]], cfg: dict, pending: list[str] | None = None) -> list[dict]:
    """Keyword search over Himalayas' remote jobs, limited to roles open to US residents.
    `pages` (20 jobs each) caps every search; `pagesPerKeyword` raises it for languages that
    Himalayas has many more of than the company boards do (C#/.NET). On a 429 it waits
    RATE_LIMIT_WAIT seconds, up to `rateLimitWaits` times, then stops and records the searches it
    didn't finish in HIMALAYAS_PENDING."""
    wait = paced(cfg.get("secondsBetweenCalls", 1.0))
    searches = himalayas_searches(queries, cfg, pending)
    HIMALAYAS_PENDING.clear()
    out = []
    waits_left = cfg.get("rateLimitWaits", 1)

    def stop(i, query, msg):
        log(f"  Himalayas: {msg} at {query!r}; stopping with {len(out)} postings")
        CUT_SHORT.add("himalayas")
        HIMALAYAS_PENDING.extend(f"{q}|{t}" for _, q, t, _ in searches[i:])
        return out

    for i, (word, query, etype, pages) in enumerate(searches):
        for page in range(1, pages + 1):
            params = {"q": query, "country": cfg.get("country", "US"), "page": page}
            if etype:
                params["employment_type"] = etype
            url = f"https://himalayas.app/jobs/api/search?{urllib.parse.urlencode(params)}"
            wait()
            try:
                while True:
                    try:
                        data = get_json(url)
                        break
                    except urllib.error.HTTPError as e:
                        # Too many requests: every later search would fail too. Wait and retry a
                        # few times; then stop and let main() keep last run's postings.
                        if e.code != 429 or waits_left <= 0:
                            raise
                        waits_left -= 1
                        log(f"  Himalayas: rate limited at {query!r}; waiting {RATE_LIMIT_WAIT}s")
                        time.sleep(RATE_LIMIT_WAIT)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    return stop(i, query, "still rate limited")
                log(f"  Himalayas: {query!r} page {page} failed ({e}); moving on")
                break
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
                    "employment": j.get("employmentType") or etype or None,
                    "url": j.get("guid") or j.get("applicationLink"),
                    "applyUrl": j.get("applicationLink") or j.get("guid"),
                    "posted": _epoch_date(j.get("pubDate")),
                    "text": html_to_text(j.get("description")),
                })
            # Pages sometimes hold 19 of 20, so a short page doesn't mean the end.
            if not data.get("jobs") or page * 20 >= (data.get("totalCount") or 0):
                break
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
        "employment": j.get("job_type"),
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
        "employment": j.get("jobType"),
        "url": j.get("url"),
        "applyUrl": j.get("url"),  # Jobicy's terms: apply buttons go to the feed's job URL
        "posted": iso_date(j.get("pubDate")),
        "text": html_to_text(j.get("jobDescription")),
    } for j in data.get("jobs", [])]


class SkipSource(Exception):
    pass


# Sources that stopped early this run (rate limited). Their list is incomplete, so postings they
# returned last run are kept rather than counted as closed.
CUT_SHORT: set[str] = set()
RATE_LIMIT_WAIT = 30  # seconds to wait once after an HTTP 429 before giving up on the source


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


def finalize(raw: list[dict], source: str, keywords: dict[str, re.Pattern], index: MetroIndex,
             tag_only: frozenset[str] = frozenset(), roles: TitleRules = NO_TITLE_RULES):
    jobs, texts = [], {}
    for j in raw:
        text = j.pop("text", "") or ""
        query = j.pop("query", None)
        hit = match_keywords(j["title"], text, keywords, tag_only, roles)
        if not hit and query:
            # Search APIs matched the keyword on text they don't return in full; trust them.
            hit = {"keywords": [query], "inTitle": [], "mentions": {query: 1}, "snippets": {query: text[:2 * SNIPPET_CHARS]}}
        if not hit:
            continue
        loc = describe_location(index, j.get("location", ""), j.pop("remote", False), j.pop("hybrid", False))
        loc["hybrid"] = loc["hybrid"] or bool(HYBRID_TEXT.search(text))
        lat, lng = j.pop("lat", None), j.pop("lng", None)
        kind = employment_type(j.pop("employment", None), j["title"], text)
        if not loc["regionIds"] and lat is not None:
            rid = nearest_metro(index, lat, lng)
            if rid:
                loc["regionIds"], loc["us"] = [rid], True
                loc["states"] = loc["states"] or [index.home_state[rid]]
        if j.get("applyUrl") == j.get("url"):
            j.pop("applyUrl")  # the site falls back to url
        if not j.get("salary"):
            j["salary"] = salary_from_text(text)
        job = {"id": j["id"], "source": source, "location": "",
               **{k: v for k, v in j.items() if k != "id" and v not in (None, "")},
               **loc, **hit, "level": classify_level(j["title"]), "years": required_years(text), "type": kind}
        # Omit false and unknown values; with ~10k postings they add up, and the site treats missing as false.
        for key in ("us", "remote", "hybrid", "years", "type"):
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
    """Drop repeats: the same id (a search API returns a posting once per keyword it matches, and a
    carried-over posting may also be fetched fresh), or the same company, title and location."""
    seen, ids, out = set(), set(), []
    for j in jobs:
        key = (j["company"].strip().lower(), j["title"].strip().lower(), j.get("location", "").strip().lower())
        if key in seen or j["id"] in ids:
            continue
        seen.add(key)
        ids.add(j["id"])
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


SOURCE_LABELS = {"greenhouse": "Greenhouse", "lever": "Lever", "ashby": "Ashby", "workday": "Workday",
                 "smartrecruiters": "SmartRecruiters", "workable": "Workable",
                 "himalayas": "Himalayas", "remotive": "Remotive",
                 "remoteok": "Remote OK", "jobicy": "Jobicy",
                 "hn": "Hacker News", "adzuna": "Adzuna", "usajobs": "USAJobs"}
BOARD_FETCHERS = {"greenhouse": from_greenhouse, "lever": from_lever, "ashby": from_ashby, "workday": from_workday,
                  "smartrecruiters": from_smartrecruiters, "workable": from_workable}


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
    groups = keyword_groups(cfg)
    tag_only = frozenset(k["name"] for k in specs
                         if any(g["id"] == k["group"] and g.get("tagOnly") for g in groups))
    roles = TitleRules(specs, groups)
    index = MetroIndex(json.loads(METROS.read_text()))
    prev_jobs, prev_meta = load_previous(args.out)
    REUSE["jobs"], REUSE["out"] = prev_jobs, args.out
    for api in THROTTLES:  # e.g. "workday": {"secondsBetweenCalls": 2.5}
        if isinstance(cfg.get(api), dict) and "secondsBetweenCalls" in cfg[api]:
            THROTTLES[api] = Throttle(cfg[api]["secondsBetweenCalls"])

    # Every fetch is an independent (source, label, thunk); failures are reported, never fatal.
    # Search APIs are asked only for keywords that bring in postings; tags are matched on the text.
    queries = [(k["name"], q) for k in specs if k["name"] not in tag_only for q in k["queries"]]
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
        pending = (prev_meta.get("resume") or {}).get("himalayas")
        tasks.append(("himalayas", "Himalayas", lambda: from_himalayas(queries, cfg["himalayas"], pending)))
    for key, source, fn in (("remotive", "remotive", from_remotive), ("remoteOk", "remoteok", from_remote_ok),
                            ("jobicy", "jobicy", from_jobicy)):
        if cfg.get(key):
            tasks.append((source, SOURCE_LABELS[source], fn))
    if cfg.get("adzuna") is not None and cfg["adzuna"].get("enabled", True):  # off by default: paid API
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
    # Workday, SmartRecruiters and Workable fetches spend most of their time waiting on their shared
    # throttle; give them their own threads so they don't hold up the other boards.
    with ThreadPoolExecutor(12 + sum(t[0] in THROTTLES for t in tasks)) as ex:
        results = list(ex.map(run, tasks))

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
        jobs, texts = finalize(raw, source, keywords, index, tag_only, roles)
        if source in CUT_SHORT:
            fresh = {j["id"] for j in jobs}
            kept = [j for j in prev_jobs.values() if j["source"] == source and j["id"] not in fresh]
            carried += kept
            s["problems"].append(f"{label}: rate limited part-way; kept {len(kept)} postings from the last run")
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
        "keywordGroups": groups,
        "textShards": TEXT_SHARDS,
        "sources": list(sources.values()),
        # Searches a rate limit cut off, to run first next time. If Himalayas failed outright, last
        # run's list still stands.
        "resume": ({"himalayas": HIMALAYAS_PENDING} if HIMALAYAS_PENDING
                   else {} if sources.get("himalayas", {}).get("boards") else prev_meta.get("resume") or {}),
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
