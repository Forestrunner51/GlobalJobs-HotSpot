"""Collect live job postings that mention the keywords in jobs/sources.json (default: Rust).

Writes web/data/jobs.json (the list the site shows) and web/data/jobs-text.json (full posting
text, loaded only when you open a posting or copy it for apply/jobprep.py).

Sources, all used through their public APIs:
  Greenhouse, Lever, Ashby   company job boards listed in sources.json (no key needed)
  Hacker News                the latest monthly "Ask HN: Who is hiring?" thread (no key needed)
  Adzuna                     set ADZUNA_APP_ID and ADZUNA_APP_KEY (free at developer.adzuna.com)
  USAJobs                    set USAJOBS_API_KEY and USAJOBS_EMAIL (free at developer.usajobs.gov)

    python jobs/fetch_jobs.py
    python jobs/fetch_jobs.py --keywords Rust Zig     # override the keywords in sources.json

Only the standard library is used, so it runs anywhere Python 3.10+ does, including CI.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "jobs" / "sources.json"
OUT_DIR = ROOT / "web" / "data"
METROS = OUT_DIR / "metros.json"
TEXT_LIMIT = 15_000  # characters of posting text kept per job
SNIPPET_CHARS = 110  # context on each side of the first keyword mention
USER_AGENT = "CareerHotspotGlobe job fetcher (+https://github.com/)"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def get_json(url: str, headers: dict | None = None, timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def html_to_text(s: str | None) -> str:
    """Board APIs return HTML, sometimes entity-escaped twice (Greenhouse)."""
    s = html.unescape(s or "")
    if "&lt;" in s or "&amp;" in s:
        s = html.unescape(s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>|</div>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "\n- ", s)
    s = re.sub(r"<[^>]+>", " ", s)
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

def keyword_re(word: str) -> re.Pattern:
    # Letter/digit boundaries rather than \b, so "C++" and "C#" work and "Rust" skips "trust".
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(word)}(?![A-Za-z0-9])", re.I)


def match_keywords(title: str, text: str, keywords: dict[str, re.Pattern]) -> dict | None:
    """Which keywords a posting mentions, how strongly, and a snippet showing the first mention."""
    found, mentions, in_title, snippet = [], 0, False, ""
    for word, rx in keywords.items():
        t_hit = bool(rx.search(title))
        hits = list(rx.finditer(text))
        if not (t_hit or hits):
            continue
        found.append(word)
        in_title |= t_hit
        mentions += len(hits)
        if hits and not snippet:
            m = hits[0]
            a, b = max(0, m.start() - SNIPPET_CHARS), min(len(text), m.end() + SNIPPET_CHARS)
            snippet = ("…" if a else "") + text[a:b].replace("\n", " ").strip() + ("…" if b < len(text) else "")
    if not found:
        return None
    return {"keywords": found, "inTitle": in_title, "mentions": mentions, "snippet": snippet}


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
SPLIT_LOCATIONS = re.compile(r"\s*(?:;|\||/|•|\n|\bor\b|\band\b)\s*", re.I)


class MetroIndex:
    """Maps free-text posting locations onto the site's metro areas (CBSA ids)."""

    def __init__(self, metros: list[dict]):
        self.metros = {m["regionId"]: m for m in metros}
        self.by_city_state: dict[tuple[str, str], str] = {}
        self.by_city: dict[str, set[str]] = {}
        for m in metros:
            cities, _, states = m["regionLabel"].rpartition(", ")
            states = states.split("-")
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

    def resolve_one(self, part: str) -> list[str]:
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
                    rid = self._city(city, st)
                    return [rid] if rid else []
            # "New York, San Francisco" is a list of cities; "Toronto, Ontario" is not.
            ids = [self._city(b.lower(), None) for b in bits]
            return ids if all(ids) else []
        rid = self._city(bits[0].lower(), None) if bits else None
        return [rid] if rid else []

    def resolve(self, location: str) -> list[str]:
        ids = []
        for part in SPLIT_LOCATIONS.split(location or ""):
            for rid in self.resolve_one(part):
                if rid not in ids:
                    ids.append(rid)
        return ids


def describe_location(index: MetroIndex, location: str, remote_flag: bool = False) -> dict:
    ids = index.resolve(location)
    states = re.findall(r"(?<![A-Za-z])([A-Z]{2})(?![A-Za-z])", location or "")
    us = bool(ids) or bool(US_HINT.search(location or "")) or any(s in STATE_CODES - {"IN", "OR", "ME"} for s in states)
    return {"regionIds": ids, "remote": remote_flag or bool(REMOTE_HINT.search(location or "")), "us": us}


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


def from_hacker_news() -> list[dict]:
    stories = get_json("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10")
    story = next((h for h in stories["hits"] if h["title"].startswith("Ask HN: Who is hiring?")), None)
    if not story:
        return []
    thread = get_json(f"https://hn.algolia.com/api/v1/items/{story['objectID']}", timeout=120)
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


def from_adzuna(keywords: list[str], cfg: dict) -> list[dict]:
    app_id, app_key = os.environ.get("ADZUNA_APP_ID"), os.environ.get("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        raise SkipSource("set ADZUNA_APP_ID and ADZUNA_APP_KEY to include Adzuna")
    out = []
    for word in keywords:
        for page in range(1, cfg.get("pages", 3) + 1):
            q = urllib.parse.urlencode({"app_id": app_id, "app_key": app_key, "what": word,
                                        "results_per_page": 50, "content-type": "application/json"})
            data = get_json(f"https://api.adzuna.com/v1/api/jobs/{cfg.get('country', 'us')}/search/{page}?{q}")
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


def from_usajobs(keywords: list[str]) -> list[dict]:
    key, email = os.environ.get("USAJOBS_API_KEY"), os.environ.get("USAJOBS_EMAIL")
    if not (key and email):
        raise SkipSource("set USAJOBS_API_KEY and USAJOBS_EMAIL to include USAJobs")
    headers = {"Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": key}
    out = []
    for word in keywords:
        q = urllib.parse.urlencode({"Keyword": word, "ResultsPerPage": 250})
        data = get_json(f"https://data.usajobs.gov/api/search?{q}", headers=headers)
        for item in data.get("SearchResult", {}).get("SearchResultItems", []):
            j = item.get("MatchedObjectDescriptor", {})
            details = (j.get("UserArea") or {}).get("Details") or {}
            text = "\n\n".join(filter(None, [details.get("JobSummary"), j.get("QualificationSummary"),
                                             "\n".join(details.get("MajorDuties") or [])]))
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
            hit = {"keywords": [query], "inTitle": False, "mentions": 1, "snippet": text[:2 * SNIPPET_CHARS]}
        if not hit:
            continue
        loc = describe_location(index, j.get("location", ""), j.pop("remote", False))
        lat, lng = j.pop("lat", None), j.pop("lng", None)
        if not loc["regionIds"] and lat is not None:
            rid = nearest_metro(index, lat, lng)
            if rid:
                loc["regionIds"], loc["us"] = [rid], True
        job = {"id": j["id"], "source": source, "location": "",
               **{k: v for k, v in j.items() if k != "id" and v not in (None, "")},
               **loc, **hit}
        jobs.append(job)
        texts[j["id"]] = text[:TEXT_LIMIT]
    return jobs, texts


def dedupe(jobs: list[dict]) -> list[dict]:
    seen, out = set(), []
    for j in jobs:
        key = (j["company"].lower(), j["title"].lower(), j.get("location", "").lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(j)
    return out


def write_atomic(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)


SOURCE_LABELS = {"greenhouse": "Greenhouse", "lever": "Lever", "ashby": "Ashby",
                 "hn": "Hacker News", "adzuna": "Adzuna", "usajobs": "USAJobs"}
BOARD_FETCHERS = {"greenhouse": from_greenhouse, "lever": from_lever, "ashby": from_ashby}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--keywords", nargs="+", help="Override the keywords in the config")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    cfg = json.loads(args.config.read_text())
    words = args.keywords or cfg.get("keywords") or ["Rust"]
    keywords = {w: keyword_re(w) for w in words}
    index = MetroIndex(json.loads(METROS.read_text()))

    # Every fetch is an independent (source, label, thunk); failures are reported, never fatal.
    tasks = [(c["ats"], c["name"], lambda c=c: BOARD_FETCHERS[c["ats"]](c)) for c in cfg.get("companies", [])]
    if cfg.get("hackerNews", True):
        tasks.append(("hn", "Who is hiring", from_hacker_news))
    if cfg.get("adzuna") is not None:
        tasks.append(("adzuna", "Adzuna", lambda: from_adzuna(words, cfg["adzuna"])))
    if cfg.get("usajobs", True):
        tasks.append(("usajobs", "USAJobs", lambda: from_usajobs(words)))

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

    all_jobs, all_text, sources = [], {}, {}
    for source, label, raw, err in results:
        s = sources.setdefault(source, {"source": source, "label": SOURCE_LABELS[source],
                                        "boards": 0, "scanned": 0, "matched": 0, "problems": []})
        if err:
            s["problems"].append(f"{label}: {err}")
            log(f"  {SOURCE_LABELS[source]:<11} {label:<24} {err}")
            continue
        jobs, texts = finalize(raw, source, keywords, index)
        s["boards"] += 1
        s["scanned"] += len(raw)
        s["matched"] += len(jobs)
        all_jobs += jobs
        all_text.update(texts)

    all_jobs = dedupe(all_jobs)
    all_jobs.sort(key=lambda j: (not j["inTitle"], -min(j["mentions"], 3), -(dt.date.fromisoformat(j["posted"]).toordinal()
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
        "keywords": words,
        "sources": list(sources.values()),
        "jobs": all_jobs,
    })
    write_atomic(args.out / "jobs-text.json", all_text)

    log("")
    for s in sources.values():
        log(f"  {s['label']:<11} {s['boards']:>3} fetched  {s['scanned']:>6} postings scanned  {s['matched']:>4} matched"
            + (f"  ({len(s['problems'])} problem{'s' * (len(s['problems']) != 1)})" if s["problems"] else ""))
    on_map = sum(1 for j in all_jobs if j["regionIds"])
    log(f"\n{len(all_jobs)} postings mention {', '.join(words)}: {sum(j['inTitle'] for j in all_jobs)} in the title, "
        f"{on_map} placed on the map, {sum(j['remote'] for j in all_jobs)} remote.")
    log(f"Wrote {args.out / 'jobs.json'} and jobs-text.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
