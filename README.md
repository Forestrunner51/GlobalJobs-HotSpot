# Career Hotspot Globe

A static web app that shows where in the US specific occupations are concentrated, on a 3D globe,
a 2D map and a ranked table. Upload a resume to get suggested occupations. The resume is parsed
in your browser and never leaves your machine.

There is no backend. `build_data.py` runs once, offline, and writes static JSON into `web/data/`.
The `web/` directory is the entire site.

## Quick start

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# download the source files listed below into data/raw/
.venv/bin/python build_data.py
python3 -m http.server 8000 -d web      # open http://localhost:8000
```

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
| `state.js` | Selected occupations, metric, floor and metro kept in the URL. |

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
node --test tests/js/*.test.mjs        # ranking, matching, search, URL state, scale
```

## Verification checklist

Data layer: `build_data.py` checks these automatically on every build.

- [x] No sentinel strings survive into numeric fields
- [x] The detailed filter cuts the row count well below the raw count
- [x] Every lat/lng is inside US bounds; probe centroids for NYC, LA, Miami and Seattle fall on land
- [x] Known clusters: petroleum engineers in Houston, actors in LA, legislators in Washington
      (the legislators check only warns)
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
- Non-US sources, job postings, accounts: out of scope for v1. The record schema is ready for
  non-US data.
- Deployment: GitHub Pages serves only the repo root or `/docs`. Either publish `web/` with an
  Actions workflow or move it to `docs/`.
