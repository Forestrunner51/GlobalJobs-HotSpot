# Career Hotspot Globe

A static web app that shows where in the US specific occupations are concentrated, on a 3D globe,
a 2D map and a ranked table. Upload a resume to get suggested occupations. The resume is parsed
in your browser and never leaves your machine.

A second tab, **Job postings**, lists live openings by programming language (Rust, C++, Go, Python
and others), puts them on the same globe, and hands any posting to `apply/jobprep.py` to draft a
tailored application.

There is no backend. `build_data.py` runs once, offline, and writes static JSON into `web/data/`.
The `web/` directory is the entire site.

## Quick start

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# download the source files listed below into data/raw/
.venv/bin/python build_data.py
python3 -m http.server 8000 -d web      # open http://localhost:8000
```

## Job postings

```sh
python3 jobs/fetch_jobs.py        # 2-3 minutes; writes web/data/jobs.json and web/data/jobs-text/
```

Then open the site's **Job postings** tab. `jobs/sources.json` sets the languages and the company
boards to read. A language is a name (`"Rust"`, case-insensitive whole word) or an object with
`caseSensitive` and/or its own `pattern`. Go has one, so "go-to-market" and "go live" don't count;
it only matches in language contexts such as "Go, Rust", "written in Go" or "Golang". Patterns are
also used by the site for highlighting, so they must be valid in both Python and JavaScript. The script uses only the standard library, so it doesn't need the venv.

| Source | How | Key |
| --- | --- | --- |
| Greenhouse, Lever, Ashby | Public job-board APIs of each company in `sources.json` (about 280) | None |
| Hacker News | The last 3 monthly "Ask HN: Who is hiring?" threads, via the Algolia HN API | None |
| Himalayas | Keyword search of remote jobs open to US residents, up to 200 per language | None |
| The Muse | Software Engineering and Data Science jobs in about 30 US tech cities | None |
| Remotive, Remote OK, Jobicy | Remote developer job feeds (their terms: name them and link to their listing; the site does) | None |
| Adzuna | Keyword search across US job sites, 5 pages of 50 per language, spaced 2.5 s apart | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` (free at developer.adzuna.com) |
| USAJobs | Keyword search, federal jobs | `USAJOBS_API_KEY`, `USAJOBS_EMAIL` (free at developer.usajobs.gov) |

Sources without keys are skipped and listed as skipped in the sidebar. A failing board is reported
and the rest still load. To add a company, find its board name in its careers-page URL
(`job-boards.greenhouse.io/<board>`, `jobs.lever.co/<board>`, `jobs.ashbyhq.com/<board>`).

How postings are matched and placed:

- A posting is kept if any language appears in its title or text, as a whole word, so "Rust" doesn't
  match "trust". Counts are kept per language. A posting is **focused** on a language if it's in the
  title or mentioned at least twice; otherwise it's listed once, usually among several. The site's
  language buttons, focus filter, sort order and highlights all follow the languages you pick.
- Full posting text is split into 32 files (`jobs-text/NN.json`, picked by a hash of the posting id)
  so reading one posting downloads about 1/32 of it.
- Locations are matched to metro areas by city and state, including common suburbs (Irvine to
  Los Angeles, Waltham to Boston). Remote and non-US postings stay in the list but aren't on the map.
  Each posting also records its US states, for the State filter. A city without a stated state counts
  in its metro's main state (a Washington, DC metro posting counts as DC unless it says Reston, VA).
- Experience: level (Intern to Manager) comes from the job title, and years from the first phrase
  like "5+ years of experience". About half of postings state years.
- Adzuna and USAJobs return only part of each posting's text, so their results are trusted as
  matches even when the returned snippet doesn't include the keyword.

- Work style: **Hybrid** comes from the location field, the board's workplace type (Lever, Ashby), or
  phrases like "hybrid role" and "3 days a week in the office" ("hybrid cloud" doesn't count).
  **On-site** means a posting names a place and mentions neither remote nor hybrid work, so some
  of those are hybrid in practice.

### Keeping postings current

Every run rebuilds the list from scratch, so closed roles drop out:

- Company boards (Greenhouse, Lever, Ashby), The Muse, Himalayas and the remote feeds list only open
  roles; when a role is filled it leaves their API and the next run removes it. Himalayas postings
  past their listed expiry date are skipped, and so are USAJobs postings whose applications closed.
- Hacker News and Adzuna don't say when a role closes, so their postings expire after
  `maxAgeDays` in `sources.json` (60 and 45 days).
- If a source fails to load (network error, server error after two retries), its postings from the
  previous run are kept rather than counted as closed.
- Each posting records `firstSeen`. The site tags postings first seen in the last 7 days as **New**,
  has a "New in the last 7 days" filter, and shows "N new, M closed or expired" since the last run.

Automatic refresh on your Mac (launchd, which unlike cron catches up on runs missed while asleep):

```sh
jobs/schedule.sh install     # refresh at 7:00 and 19:00 every day
jobs/schedule.sh status      # installed? last log lines
jobs/schedule.sh run         # refresh now in the background
jobs/schedule.sh uninstall
```

It runs `jobs/update.sh`, which logs to `jobs/logs/update.log` and reads optional API keys from
`~/.config/jobglobal/env` (lines like `export ADZUNA_APP_ID=...`), so keys stay out of the repo.

Job data (`web/data/jobs.json`, `web/data/jobs-text/`) is git-ignored: it's 80+ MB and changes on
every run. The Pages workflow downloads the live site's copy, refreshes it, and redeploys, twice a day.

### Applying (fast, never automatic)

Nothing on the site or in `apply/` submits an application. The tools cut the time around it:

- **☆ Save / Not interested / Mark applied** on each posting. **My applications** shows Saved, Applied
  and Hidden lists; applied and hidden postings leave the main list. Follow-ups come due 6 days after
  applying. Saved postings that disappear from the data are shown as "no longer listed".
- **Apply kit**: your standard form answers (name, email, links, work authorization, salary, "how did
  you hear", saved paragraphs), entered once. **Apply** opens the employer's form in a new tab and the
  kit beside it, with a Copy button per answer and **Mark as applied**.
- **Batch prep**: **Download saved for prep** saves your shortlist (full posting text included), and
  `apply/jobprep.py batch <file>` drafts a memo, email and form answers for each, after confirming.
- **With the Autofill extension** (`extension/`, see its README): **Apply to saved with Autofill**
  opens up to 10 saved postings' applications in tabs, already filled in, for you to check and
  submit. The extension keeps a history of every application with its job description
  (**Application history**), marks postings applied here when it sees you submit, and records
  postings you mark applied here. The buttons only appear when the extension is installed.
- Keyboard: `j`/`k` move, `s` save, `a` apply, `p` copy for prep, `r` read, `h` hide, `Esc` close kit.
- Export CSV, back up and restore. Everything is in this browser's localStorage, never uploaded.

The Pages workflow fetches fresh postings before every deploy and at 00:00 and 12:00 UTC. Add the
optional keys as repository secrets with the same names. GitHub only runs scheduled workflows from
the default branch, so the scheduled refresh starts once this workflow is on `main`.

## Source data (all public, no API keys)

Put these in `data/raw/`. Every path can be overridden with a CLI flag (`build_data.py --help`).
The script stops with a clear message if a file is missing. It never builds a partial dataset
without saying so.

| File | Where | Notes |
| --- | --- | --- |
| `oesm25ma.zip` | https://www.bls.gov/oes/special-requests/oesm25ma.zip | OEWS metro/nonmetro, May 2025. **BLS blocks scripted downloads**; use a browser. |
| `oesm25nat.zip` | https://www.bls.gov/oes/special-requests/oesm25nat.zip | National totals, used for derived LQ. Browser download. |
| `2025_Gaz_counties_national.zip` | https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/ | County land area and interior points (pipe-delimited in 2025). |
| `cbsa2fipsxw_2023.csv` | https://data.nber.org/cbsa-csa-fips-county-crosswalk/2023/cbsa2fipsxw_2023.csv | CBSA to county crosswalk (OMB July 2023). |
| `db_31_0_text.zip` | https://www.onetcenter.org/database.html (Text download) | O*NET 31.0. |

The pipeline reads the zips directly. It finds the `.xlsx` inside each OEWS zip by looking for the
sheet with `AREA` and `OCC_CODE` columns, because filenames change between releases. It also
detects the gazetteer delimiter.

### O*NET 31.0 table names

O*NET 31.0 renamed several tables. The loader accepts both the old and new names:

| Purpose | ≤ 30.x | 31.0 |
| --- | --- | --- |
| Skills (importance scale `IM`) | `Skills.txt` | `Essential Skills.txt` + `Transferable Skills.txt` |
| Tools | `Technology Skills.txt` | `Software Skills.txt` |
| Alternate titles | `Alternate Titles.txt` | `Job Titles.txt` + `Sample of Reported Titles.txt` |

O*NET codes such as `15-1252.00` are cut down to 6-digit SOC codes (`15-1252`) and merged.

Each occupation also gets a `languages` list (Rust, Python, Go, ...) taken from the *full* software
list, before the 25-item `tech` cut, so rare entries like Rust survive. The patterns are in
`LANGUAGES` in `build_data.py`. The sidebar's "Jobs that use a language" buttons and a search like
`rust jobs` select those occupations. These are occupations O*NET says use the language, not job
postings for it: O*NET 31.0 lists Rust only for penetration testers and blockchain engineers, which
both roll up to 15-1299 (Computer Occupations, All Other).

## Pipeline (`build_data.py`)

1. Load OEWS metro data. BLS sentinels (`*`, `**`, `#`, `~`) become null. Any other non-numeric
   value stops the build. Keep only `O_GROUP == detailed` rows.
2. Compute each CBSA centroid as the land-area-weighted mean of its counties' interior points.
3. Inner-join OEWS `AREA` to CBSA codes. Dropped areas are logged by name, and any dropped area
   that isn't nonmetropolitan triggers a warning.
4. Attach O*NET skills, tools and titles.
5. Compute concentration. `LOC_QUOTIENT` is used when reported (`concentrationSource: "reported"`).
   Otherwise it is derived as `(TOT_EMP / metro total) / (national occ / national total)`
   (`"derived"`).
6. Write `occupations.json`, `metros.json` (top occupations per metro), `meta.json` and hotspot
   records. The records go in one `hotspots.json`, or `hotspots/<major group>.json` shards when
   the single file would exceed 3 MB. The app lazy-loads only the shards it needs.
7. Run the verification checks listed below. A failure exits non-zero.

Useful flags: `--occ 15-1252 17-2171` builds a few occupations for inspection. `--verify-only`
re-checks existing output.

`tests/make_fixture.py` writes small OEWS-shaped zips. They reproduce the gotchas (sentinels,
nonmetro rows, a suppressed LQ that must be derived), so the pipeline can run without the BLS
downloads:

```sh
.venv/bin/python tests/make_fixture.py
.venv/bin/python build_data.py --oews-metro data/fixture/oesm25ma.zip \
    --oews-national data/fixture/oesm25nat.zip --out /tmp/fixture-out
```

### Record schema (the contract between data and visualization)

```json
{
  "id": "35620:15-1252", "regionId": "35620",
  "regionLabel": "New York-Newark-Jersey City, NY-NJ", "lat": 40.71, "lng": -74.01,
  "occCode": "15-1252", "occLabel": "Software Developers",
  "employment": 98500, "concentration": 1.42, "concentrationSource": "reported",
  "medianWage": 145000, "skills": ["Programming", "Critical Thinking", "Complex Problem Solving"]
}
```

A non-US source only has to produce this shape. The views never read source-specific fields.

## Web app (`web/`)

Plain ES modules with no build step. All libraries are vendored in `web/vendor/`: globe.gl 2.46.2,
pdf.js 4.10.38 (legacy build), mammoth 1.12.3, d3 7.9.0, topojson-client 3.1.0 and us-atlas 3.0.1.
The page's Content Security Policy allows only same-origin scripts and connections.

| Module | Role |
| --- | --- |
| `aggregate.js` | One ranking function shared by the table, map and globe. Suppressed estimates count as *no data*, never zero. |
| `table.js` | Ranked metro table: the fallback view and the reference for checking the other views. |
| `map2d.js` | SVG Albers map, used when WebGL is unavailable or the context is lost. |
| `globe.js` | globe.gl view. Merged point geometry (one draw call), DOM labels limited by zoom, render loop pauses when idle or the tab is hidden, pixel ratio capped at 2, 1K texture on phones, no auto-rotate. |
| `matcher.js` | v1 resume matching: IDF-weighted n-gram overlap with titles, alternate titles, tools and skills. Shows which terms matched. |
| `resume.js` | PDF/DOCX/TXT text extraction in the browser, including detection of scanned (image-only) PDFs. |
| `state.js` | Selected occupations, metric, floor, metro, tab and job filters kept in the URL. |
| `jobs.js` | Job postings: filters, per-metro counts for the map, and the text handed to `jobprep.py`. |
| `tracker.js` | Saved/applied/hidden postings, follow-ups, apply kit, CSV/backup and batch-prep files (localStorage only). |

Add `?nowebgl` to any URL to force the fallback view.

### Encoding

- LQ uses a fixed log scale from 0.5× to 8×, shown by both marker height or size and color
  (the upper range of viridis). Color is never the only cue.
- With several occupations selected, each metro gets one marker at the maximum LQ across the
  selection, or the total jobs in "Number of jobs" mode. The tooltip breaks down the parts.
- Default employment floor is 50 jobs for LQ ranking. The globe shows at most 300 markers with
  LQ ≥ 1.0 (150 and ≥ 1.25 on narrow screens). These are always the top rows of the table, in the
  same order.
- No data: flat grey dot (globe), dashed ring (map), and a separate list under the table.

## Tests

```sh
node --test tests/js/*.test.mjs                 # ranking, matching, search, URL state, scale, job filters
python3 -m unittest tests/test_fetch_jobs.py   # job keyword, location and Hacker News parsing
.venv/bin/python -m unittest tests/test_jobprep.py   # application prep, with Claude stubbed out
```

## Verification checklist

Data layer: `build_data.py` checks these automatically on every build.

- [x] No sentinel strings survive into numeric fields
- [x] The detailed filter cuts the row count well below the raw count
- [x] Every lat/lng is inside US bounds; probe centroids for NYC, LA, Miami and Seattle fall on land
- [x] Known clusters: petroleum engineers in Houston (#1 by jobs), actors in LA, political scientists
      in Washington. Legislators (11-1031) aren't published at metro level, so they can't be checked.
- [x] No double counting: in each metro, detailed-occupation jobs add up to no more than that
      metro's total
- [x] The fallback LQ formula, applied to rows where BLS *did* report LQ, gives a median ratio
      between 0.9 and 1.1. This directly tests the national denominator.
- [x] Summed metro employment is below the national total

Rendering layer:

- [x] WebGL disabled: 2D map and table work (tested in headless Chrome with `--disable-3d-apis`)
- [x] Forced `WEBGL_lose_context`: switches to the 2D map with a "Try 3D again" button
- [x] Render loop pauses after interaction stops and when the tab is hidden
- [x] Table and globe list the same top metros in the same order
- [ ] Holds ~60 fps on a mid-range Android device. **Needs profiling on a real device.**

## Honesty requirements, as implemented

- The header and About panel give the data vintage (May 2025 survey).
- The About panel, tooltips and metro panel say a high LQ is not the same as job openings.
- Suppressed estimates are shown as "no data", visually distinct from low values.
- Resume privacy: files are read with the File API, parsed by vendored code, and never included
  in any request. The CSP enforces `connect-src 'self'`. If server-side processing is ever added,
  this copy must change too.

## Not built yet

- **v2 embedding matching** (spec §5.2): precomputed occupation vectors, quantized binary,
  `transformers.js` in the browser. Before it ships, the model weights must be vendored or the CSP
  loosened, and the privacy copy re-checked.
- Non-US sources and accounts: out of scope for v1. The record schema is ready for non-US data.

## Deployment

`.github/workflows/pages.yml` publishes `web/` to GitHub Pages when a push changes `web/`, or when
you run it by hand from the Actions tab. One-time setup: **Settings → Pages → Source: GitHub
Actions**. Before the first deploy, build and commit `web/data/`. CI can't build it because BLS
blocks automated downloads.
