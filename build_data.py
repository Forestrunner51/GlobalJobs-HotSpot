#!/usr/bin/env python3
"""Build static JSON for the Career Hotspot Globe.

Reads locally downloaded public files (BLS OEWS, Census gazetteer, CBSA
crosswalk, O*NET) and writes the normalized records the web app consumes.
Runs offline; nothing is fetched here. See README.md for download links.

    python build_data.py                     # full build with defaults
    python build_data.py --occ 15-1252       # single occupation, for inspection
    python build_data.py --verify-only       # re-run checks on existing output
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("pandas is required: pip install -r requirements.txt")

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data"

VINTAGE = {
    "survey": "May 2025",
    "label": "BLS OEWS, May 2025 estimates",
    "note": "Survey estimates from May 2025, published in 2026. Not live job-market data.",
}

# BLS writes suppressed/unavailable values as strings, never blanks.
#   *  estimate not released     ** not available     # wage >= top-code threshold
#   ~  share below 0.5%          (blank cells also occur)
SENTINELS = {"*", "**", "***", "#", "~", "", "nan", "NaN", "None"}
NUMERIC_COLS = ["TOT_EMP", "JOBS_1000", "LOC_QUOTIENT", "A_MEDIAN"]
REQUIRED_COLS = ["AREA", "AREA_TITLE", "OCC_CODE", "OCC_TITLE", "O_GROUP", "TOT_EMP",
                 "JOBS_1000", "LOC_QUOTIENT"]

SKILLS_PER_RECORD = 3
SKILLS_PER_OCC = 10
TECH_PER_OCC = 25
TITLES_PER_OCC = 80
TOP_OCCS_PER_METRO = 15
METRO_TOP_FLOOR = 50  # employment floor for the per-metro "most concentrated" list
SHARD_THRESHOLD_BYTES = 3_000_000


def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str) -> None:
    sys.exit(f"\nERROR: {msg}\n")


def require(path: Path, what: str, how: str) -> Path:
    if not path.exists():
        die(f"{what} not found at {path}\n  {how}")
    return path


# ---------------------------------------------------------------------------
# OEWS
# ---------------------------------------------------------------------------

def _read_oews_sheet(data: bytes, name: str) -> pd.DataFrame | None:
    """Return the sheet containing OCC_CODE, or None if this workbook has none."""
    book = pd.read_excel(io.BytesIO(data), sheet_name=None, dtype=str, engine="openpyxl")
    for sheet, df in book.items():
        df.columns = [str(c).strip().upper() for c in df.columns]
        if "OCC_CODE" in df.columns and "AREA" in df.columns:
            log(f"  using sheet '{sheet}' of {name} ({len(df):,} rows)")
            return df
    return None


def load_oews(path: Path) -> pd.DataFrame:
    """Load an OEWS table from a .zip (xlsx discovered inside) or a bare .xlsx."""
    if path.suffix.lower() == ".xlsx":
        df = _read_oews_sheet(path.read_bytes(), path.name)
    else:
        if not zipfile.is_zipfile(path):
            die(f"{path} is not a zip file. BLS may have returned an 'Access Denied' HTML page;"
                " download it in a browser instead.")
        df = None
        with zipfile.ZipFile(path) as zf:
            # Filenames vary by release (MSA_M2025_dl.xlsx, national_M2025_dl.xlsx, ...),
            # and some zips also carry a field-description workbook. Try each.
            candidates = [n for n in zf.namelist()
                          if n.lower().endswith(".xlsx") and not n.split("/")[-1].startswith("~$")]
            candidates.sort(key=lambda n: ("desc" in n.lower(), -zf.getinfo(n).file_size))
            if not candidates:
                die(f"No .xlsx found inside {path}. Contents: {zf.namelist()}")
            for name in candidates:
                df = _read_oews_sheet(zf.read(name), name)
                if df is not None:
                    break
    if df is None:
        die(f"No sheet with AREA and OCC_CODE columns found in {path}")
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        die(f"{path} is missing columns {missing}. Found: {list(df.columns)}")
    return df


def clean_oews(df: pd.DataFrame, label: str) -> pd.DataFrame:
    df = df.copy()
    for col in ["AREA", "AREA_TITLE", "AREA_TYPE", "OCC_CODE", "OCC_TITLE", "O_GROUP",
                "I_GROUP", "OWN_CODE"]:
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()
    # Metro file areas are CBSA codes; keep them as zero-padded strings.
    df["AREA"] = df["AREA"].str.replace(r"\.0$", "", regex=True).str.zfill(5)
    df["O_GROUP"] = df["O_GROUP"].str.lower()

    # Cross-industry, all-ownership rows only (guards against multi-slice files).
    if "I_GROUP" in df.columns:
        df = df[df["I_GROUP"].str.lower() == "cross-industry"]
    if "OWN_CODE" in df.columns and df["OWN_CODE"].nunique() > 1:
        df = df[df["OWN_CODE"].str.replace(r"\.0$", "", regex=True) == "1235"]

    for col in NUMERIC_COLS:
        if col not in df.columns:
            df[col] = None
            continue
        raw = df[col].astype(str).str.strip().str.replace(",", "", regex=False)
        is_sentinel = raw.isin(SENTINELS) | df[col].isna()
        coerced = pd.to_numeric(raw.where(~is_sentinel), errors="coerce")
        unexpected = raw[~is_sentinel & coerced.isna()].unique()
        if len(unexpected):
            die(f"{label}: unrecognized non-numeric values in {col}: {list(unexpected)[:10]}")
        df[col] = coerced
        log(f"  {label} {col}: {int(is_sentinel.sum()):,} suppressed/blank -> null")
    return df


# ---------------------------------------------------------------------------
# Geography
# ---------------------------------------------------------------------------

def _read_delimited(path: Path) -> list[dict]:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith((".txt", ".csv"))]
            if not names:
                die(f"No .txt/.csv inside {path}")
            text = zf.read(names[0]).decode("utf-8-sig", errors="replace")
    else:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    first = text.split("\n", 1)[0]
    # The gazetteer delimiter has changed between years (tab vs pipe); detect it.
    delim = max(["|", "\t", ","], key=first.count)
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    reader.fieldnames = [f.strip() for f in reader.fieldnames or []]
    rows = [{k.strip(): (v or "").strip() for k, v in r.items() if k} for r in reader]
    log(f"  {path.name}: delimiter {delim!r}, columns {reader.fieldnames[:8]}...")
    return rows


def build_centroids(gazetteer: Path, crosswalk: Path) -> dict[str, dict]:
    counties = {}
    gaz_rows = _read_delimited(gazetteer)
    for need in ("GEOID", "ALAND", "INTPTLAT", "INTPTLONG"):
        if gaz_rows and need not in gaz_rows[0]:
            die(f"Gazetteer {gazetteer} lacks column {need}; found {list(gaz_rows[0])}")
    for r in gaz_rows:
        counties[r["GEOID"].zfill(5)] = (float(r["ALAND"]), float(r["INTPTLAT"]), float(r["INTPTLONG"]))

    xw_rows = _read_delimited(crosswalk)
    if not xw_rows:
        die(f"Crosswalk {crosswalk} is empty")
    cols = {c.lower(): c for c in xw_rows[0]}
    cbsa_col = cols.get("cbsacode") or cols.get("cbsa code")
    title_col = cols.get("cbsatitle") or cols.get("cbsa title")
    fips_col = cols.get("county_fips") or cols.get("fipscounty")
    state_col = cols.get("fipsstatecode") or cols.get("fips state code")
    cty_col = cols.get("fipscountycode") or cols.get("fips county code")
    if not (cbsa_col and title_col and (fips_col or (state_col and cty_col))):
        die(f"Unrecognized crosswalk columns in {crosswalk}: {list(xw_rows[0])}")

    members: dict[str, list[str]] = defaultdict(list)
    titles: dict[str, str] = {}
    for r in xw_rows:
        cbsa = r[cbsa_col].zfill(5)
        if not cbsa.strip("0"):
            continue
        fips = r[fips_col].zfill(5) if fips_col else r[state_col].zfill(2) + r[cty_col].zfill(3)
        members[cbsa].append(fips)
        titles[cbsa] = r[title_col]

    centroids, missing_counties = {}, 0
    for cbsa, fips_list in members.items():
        wsum = lat = lng = 0.0
        for fips in set(fips_list):
            if fips not in counties:
                missing_counties += 1
                continue
            aland, clat, clng = counties[fips]
            wsum += aland
            lat += aland * clat
            lng += aland * clng
        if wsum > 0:
            centroids[cbsa] = {"lat": lat / wsum, "lng": lng / wsum, "title": titles[cbsa]}
    log(f"  centroids for {len(centroids):,} CBSAs "
        f"({missing_counties} crosswalk counties absent from gazetteer, e.g. renamed CT regions)")
    return centroids


# ---------------------------------------------------------------------------
# O*NET
# ---------------------------------------------------------------------------

class OnetSource:
    """Reads O*NET tables from an extracted directory or the distribution zip."""

    def __init__(self, path: Path):
        self.path = path
        self.zip = zipfile.ZipFile(path) if path.is_file() else None
        names = self.zip.namelist() if self.zip else [str(p.relative_to(path)) for p in path.rglob("*.txt")]
        self.index = {Path(n).name.lower(): n for n in names}

    def table(self, *candidates: str) -> list[dict] | None:
        for cand in candidates:
            key = cand.lower()
            if key in self.index:
                name = self.index[key]
                raw = self.zip.read(name) if self.zip else (self.path / name).read_bytes()
                text = raw.decode("utf-8-sig", errors="replace")
                log(f"  O*NET: {Path(name).name}")
                return list(csv.DictReader(io.StringIO(text), delimiter="\t"))
        return None


def soc6(code: str) -> str:
    return code.split(".")[0].strip()


def load_onet(path: Path) -> dict[str, dict]:
    src = OnetSource(path)
    occ = defaultdict(lambda: {"skills": defaultdict(list), "tech": {}, "titles": {}, "onetTitles": []})

    data = src.table("Occupation Data.txt")
    if data is None:
        die(f"'Occupation Data.txt' not found in {path}")
    for r in data:
        occ[soc6(r["O*NET-SOC Code"])]["onetTitles"].append(r["Title"])

    # O*NET <=30 ships Skills.txt; 31.0 split it into Essential and Transferable Skills.
    skill_tables = [t for t in (src.table("Skills.txt"),) if t] or \
        [t for t in (src.table("Essential Skills.txt"), src.table("Transferable Skills.txt")) if t]
    if not skill_tables:
        die(f"No skills table (Skills.txt or Essential/Transferable Skills.txt) in {path}")
    for table in skill_tables:
        for r in table:
            if r.get("Scale ID") != "IM" or r.get("Recommend Suppress") == "Y":
                continue
            try:
                occ[soc6(r["O*NET-SOC Code"])]["skills"][r["Element Name"]].append(float(r["Data Value"]))
            except (ValueError, KeyError):
                continue

    tech = src.table("Technology Skills.txt", "Software Skills.txt")
    if tech:
        for r in tech:
            name = r.get("Example") or r.get("Workplace Example") or ""
            if not name:
                continue
            hot = (r.get("Hot Technology") == "Y") + (r.get("In Demand") == "Y")
            bucket = occ[soc6(r["O*NET-SOC Code"])]["tech"]
            bucket[name] = max(bucket.get(name, 0), hot)

    for table, col in ((src.table("Alternate Titles.txt"), "Alternate Title"),
                       (src.table("Job Titles.txt"), "Job Title"),
                       (src.table("Sample of Reported Titles.txt"), "Reported Job Title")):
        if not table:
            continue
        for r in table:
            t = (r.get(col) or "").strip()
            if t and t.lower() != "n/a":
                occ[soc6(r["O*NET-SOC Code"])]["titles"].setdefault(t, None)
            short = (r.get("Short Title") or "").strip()
            if short and short.lower() != "n/a":
                occ[soc6(r["O*NET-SOC Code"])]["titles"].setdefault(short, None)

    result = {}
    for code, d in occ.items():
        skills = sorted(d["skills"].items(), key=lambda kv: -sum(kv[1]) / len(kv[1]))
        tech = sorted(d["tech"].items(), key=lambda kv: (-kv[1], kv[0]))
        titles = list(dict.fromkeys(d["onetTitles"] + list(d["titles"])))
        result[code] = {
            "skills": [k for k, _ in skills[:SKILLS_PER_OCC]],
            "tech": [k for k, _ in tech[:TECH_PER_OCC]],
            "titles": titles[:TITLES_PER_OCC],
        }
    log(f"  O*NET rolled up to {len(result):,} six-digit SOC codes")
    return result


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def rnd(v, nd):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), nd)


def build(args) -> None:
    log("1. OEWS metro file")
    metro_raw = load_oews(require(args.oews_metro, "OEWS metro file",
                                  "Download https://www.bls.gov/oes/special-requests/oesm25ma.zip"))
    raw_rows = len(metro_raw)
    metro = clean_oews(metro_raw, "metro")
    totals = metro[metro["O_GROUP"] == "total"].set_index("AREA")["TOT_EMP"].to_dict()
    detailed = metro[metro["O_GROUP"] == "detailed"].copy()
    log(f"  rows: {raw_rows:,} raw -> {len(detailed):,} detailed "
        f"({detailed['AREA'].nunique()} areas, {detailed['OCC_CODE'].nunique()} occupations)")
    if args.occ:
        detailed = detailed[detailed["OCC_CODE"].isin(args.occ)]
        log(f"  --occ filter: {len(detailed):,} rows for {args.occ}")
        if detailed.empty:
            die(f"No detailed rows for {args.occ}")

    log("   OEWS national file")
    nat = clean_oews(load_oews(require(args.oews_national, "OEWS national file",
                                       "Download https://www.bls.gov/oes/special-requests/oesm25nat.zip")),
                     "national")
    # Some codes appear as both a broad group and its single detailed occupation
    # (e.g. 13-1020) with identical figures; the detailed row is the denominator we need.
    nat = nat[nat["O_GROUP"].isin(["total", "detailed"])]
    if nat.duplicated("OCC_CODE").any():
        die("National file has duplicate OCC_CODE rows after filtering; cannot pick a denominator.")
    nat_emp = nat.set_index("OCC_CODE")["TOT_EMP"].to_dict()
    nat_total = nat_emp.get("00-0000")
    if not nat_total:
        die("National file lacks the 00-0000 all-occupations total row.")

    log("2. CBSA centroids")
    centroids = build_centroids(
        require(args.gazetteer, "County gazetteer",
                "Download 2025_Gaz_counties_national.zip from the Census 2025_Gazetteer directory"),
        require(args.crosswalk, "CBSA-county crosswalk",
                "Download cbsa2fipsxw_2023.csv from the NBER CBSA crosswalk page"))

    log("3. Join OEWS areas to CBSAs")
    in_xw = detailed["AREA"].isin(centroids.keys())
    dropped = detailed[~in_xw].groupby(["AREA", "AREA_TITLE"]).size().reset_index(name="rows")
    log(f"  kept {int(in_xw.sum()):,} rows; dropped {int((~in_xw).sum()):,} rows in "
        f"{len(dropped)} areas with no CBSA match (nonmetro areas and retired codes):")
    for _, r in dropped.head(8).iterrows():
        log(f"    {r['AREA']} {r['AREA_TITLE']} ({r['rows']} rows)")
    if len(dropped) > 8:
        log(f"    ... and {len(dropped) - 8} more")
    nonmetro_like = dropped["AREA_TITLE"].str.contains("nonmetropolitan", case=False).sum()
    metro_like = len(dropped) - nonmetro_like
    if metro_like:
        log(f"  WARNING: {metro_like} dropped areas are not nonmetropolitan; "
            "the crosswalk vintage may not match OEWS delineations.")
    detailed = detailed[in_xw]

    log("4. O*NET skills")
    onet = load_onet(require(args.onet, "O*NET text database",
                             "Download db_31_0_text.zip from https://www.onetcenter.org/database.html"))

    log("5. Records")
    records, derived, unmatched_occ, calibration = [], 0, set(), []
    for r in detailed.itertuples(index=False):
        emp, lq, source = r.TOT_EMP, r.LOC_QUOTIENT, "reported"
        emp = None if pd.isna(emp) else float(emp)
        lq = None if pd.isna(lq) else float(lq)
        metro_total, nat_occ = totals.get(r.AREA), nat_emp.get(r.OCC_CODE)
        computable = (emp is not None and metro_total and nat_occ
                      and not pd.isna(metro_total) and not pd.isna(nat_occ))
        fallback = (emp / metro_total) / (nat_occ / nat_total) if computable else None
        if lq is None:
            source = None
            if fallback is not None:
                lq, source = fallback, "derived"
                derived += 1
        elif fallback and lq > 0:
            calibration.append(fallback / lq)
        info = onet.get(r.OCC_CODE)
        if info is None:
            unmatched_occ.add(r.OCC_CODE)
        c = centroids[r.AREA]
        records.append({
            "id": f"{r.AREA}:{r.OCC_CODE}",
            "regionId": r.AREA,
            "regionLabel": r.AREA_TITLE,
            "lat": round(c["lat"], 4),
            "lng": round(c["lng"], 4),
            "occCode": r.OCC_CODE,
            "occLabel": r.OCC_TITLE,
            "employment": rnd(emp, 0),
            "concentration": rnd(lq, 2),
            "concentrationSource": source,
            "medianWage": rnd(r.A_MEDIAN, 0),
            "skills": (info or {}).get("skills", [])[:SKILLS_PER_RECORD],
        })
    log(f"  {len(records):,} records; {derived:,} with derived LQ; "
        f"{len(unmatched_occ)} OEWS codes without O*NET data (e.g. {sorted(unmatched_occ)[:4]})")
    calibration.sort()
    calib = round(calibration[len(calibration) // 2], 4) if calibration else None
    log(f"  fallback formula vs reported LQ: median ratio {calib} over {len(calibration):,} rows")

    write_outputs(records, detailed, onet, nat_emp, nat_total, args, calib)
    group_counts = metro["O_GROUP"].value_counts().to_dict()
    verify(OUT if args.out is None else args.out, metro_raw_rows=raw_rows,
           nat_total=nat_total, full_build=not args.occ,
           metro_totals={k: v for k, v in totals.items() if not pd.isna(v)}, group_counts=group_counts)


def write_outputs(records, detailed, onet, nat_emp, nat_total, args, calib) -> None:
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    for stale in list(out.glob("hotspots*.json")) + list((out / "hotspots").glob("*.json")):
        stale.unlink()

    occ_titles = detailed.groupby("OCC_CODE")["OCC_TITLE"].first().to_dict()
    occupations = []
    for code in sorted(occ_titles):
        info = onet.get(code, {})
        occupations.append({
            "code": code,
            "label": occ_titles[code],
            "major": code[:2],
            "nationalEmployment": rnd(nat_emp.get(code), 0),
            "skills": info.get("skills", []),
            "tech": info.get("tech", []),
            "titles": info.get("titles", []),
        })
    dump(out / "occupations.json", occupations)

    by_metro = defaultdict(list)
    for rec in records:
        by_metro[rec["regionId"]].append(rec)
    metros = []
    for rid, recs in sorted(by_metro.items()):
        ranked = sorted((x for x in recs if x["concentration"] is not None
                         and (x["employment"] or 0) >= METRO_TOP_FLOOR),
                        key=lambda x: -x["concentration"])[:TOP_OCCS_PER_METRO]
        metros.append({
            "regionId": rid, "regionLabel": recs[0]["regionLabel"],
            "lat": recs[0]["lat"], "lng": recs[0]["lng"],
            "top": [[x["occCode"], x["concentration"], x["employment"], x["medianWage"]] for x in ranked],
        })
    dump(out / "metros.json", metros)

    single = json.dumps(records, separators=(",", ":"))
    shards = None
    if len(single) > args.shard_threshold:
        shards = {}
        grouped = defaultdict(list)
        for rec in records:
            grouped[rec["occCode"][:2]].append(rec)
        for major, recs in sorted(grouped.items()):
            path = out / "hotspots" / f"{major}.json"
            dump(path, recs, quiet=True)
            shards[major] = path.stat().st_size
        log(f"  hotspots: {len(single) / 1e6:.1f} MB unsharded > {args.shard_threshold / 1e6:.1f} MB; "
            f"wrote {len(shards)} shards (largest {max(shards.values()) / 1e6:.1f} MB)")
    else:
        dump(out / "hotspots.json", records)

    dump(out / "meta.json", {
        "vintage": VINTAGE,
        "schemaVersion": 1,
        "coverage": "US metropolitan statistical areas",
        "recordCount": len(records),
        "metroCount": len(metros),
        "occupationCount": len(occupations),
        "nationalTotalEmployment": nat_total,
        "derivedLqCalibration": calib,
        "shards": sorted(shards) if shards else None,
        "partial": bool(args.occ),
        "sources": [
            "BLS Occupational Employment and Wage Statistics (OEWS), May 2025",
            "U.S. Census Bureau 2025 Gazetteer, counties",
            "NBER CBSA-to-county FIPS crosswalk (OMB July 2023 delineations)",
            "O*NET 31.0 Database, U.S. Department of Labor/ETA (CC BY 4.0)",
        ],
    })


def dump(path: Path, obj, quiet=False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    if not quiet:
        log(f"  wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} "
            f"({path.stat().st_size / 1e6:.2f} MB)")


# ---------------------------------------------------------------------------
# Verification (spec section 9, data layer)
# ---------------------------------------------------------------------------

def load_records(out: Path) -> list[dict]:
    if (out / "hotspots.json").exists():
        return json.loads((out / "hotspots.json").read_text())
    shard_dir = out / "hotspots"
    if not shard_dir.is_dir():
        die(f"No hotspots output in {out}; run a build first.")
    return [rec for p in sorted(shard_dir.glob("*.json")) for rec in json.loads(p.read_text())]


def verify(out: Path, metro_raw_rows: int | None = None, nat_total: float | None = None,
           full_build: bool = True, metro_totals: dict | None = None,
           group_counts: dict | None = None) -> None:
    log("\nVerification")
    meta = json.loads((out / "meta.json").read_text())
    records = load_records(out)
    nat_total = nat_total or meta.get("nationalTotalEmployment")
    failures = []

    def check(ok: bool, label: str, detail: str = "", warn_only=False):
        tag = "PASS" if ok else ("WARN" if warn_only else "FAIL")
        log(f"  [{tag}] {label}{': ' + detail if detail else ''}")
        if not ok and not warn_only:
            failures.append(label)

    numeric = ("employment", "concentration", "medianWage", "lat", "lng")
    bad = [r["id"] for r in records for k in numeric
           if r[k] is not None and not isinstance(r[k], (int, float))]
    check(not bad, "No sentinel strings in numeric fields", f"{len(bad)} bad values {bad[:3]}")

    if metro_raw_rows:
        # How much the filter removes depends on which aggregate levels a release includes
        # (May 2025 metro: total + major only), so test for double counting directly.
        check(len(records) < metro_raw_rows, "Detailed filter removed aggregate rows",
              f"{metro_raw_rows:,} raw -> {len(records):,} records; groups in source: {group_counts}")
    if metro_totals and full_build:
        emp_by_metro = defaultdict(float)
        for r in records:
            emp_by_metro[r["regionId"]] += r["employment"] or 0
        over = {rid: round(s / metro_totals[rid], 3) for rid, s in emp_by_metro.items()
                if rid in metro_totals and s > metro_totals[rid] * 1.02}
        check(not over, "No double counting: detailed jobs per metro <= metro total",
              f"{len(over)} metros over total {dict(list(over.items())[:3])}")

    geo_bad = [r["id"] for r in records if r["lat"] is None or r["lng"] is None
               or not (17 <= r["lat"] <= 72 and -180 <= r["lng"] <= -64)
               or (abs(r["lat"]) < 1 and abs(r["lng"]) < 1)]
    check(not geo_bad, "Every record has lat/lng inside US bounds", f"{len(geo_bad)} outside {geo_bad[:3]}")

    # Coastal sanity: a centroid in the ocean is usually a join/weighting bug.
    probes = {"35620": (40.3, 41.3, -74.8, -73.4), "31080": (33.6, 34.9, -118.9, -117.3),
              "33100": (25.2, 27.2, -81.0, -80.0), "42660": (46.9, 48.3, -123.0, -121.0)}
    locs = {r["regionId"]: (r["lat"], r["lng"]) for r in records}
    for rid, (la0, la1, ln0, ln1) in probes.items():
        if rid in locs:
            la, ln = locs[rid]
            check(la0 <= la <= la1 and ln0 <= ln <= ln1, f"Centroid plausible for {rid}", f"({la}, {ln})")

    if full_build:
        by_occ = defaultdict(list)
        for r in records:
            if r["concentration"] is not None and (r["employment"] or 0) >= 50:
                by_occ[r["occCode"]].append(r)
        for occ, rid, name in (("17-2171", "26420", "Petroleum engineers -> Houston"),
                               ("27-2011", "31080", "Actors -> Los Angeles"),
                               # Legislators (11-1031) are not published at metro level in OEWS.
                               ("19-3094", "47900", "Political scientists -> Washington")):
            ranked = sorted(by_occ.get(occ, []), key=lambda r: -r["concentration"])
            ids = [r["regionId"] for r in ranked]
            pos = ids.index(rid) + 1 if rid in ids else None
            top = ", ".join(f"{r['regionLabel'].split(',')[0]} {r['concentration']}" for r in ranked[:3])
            # By employment the cluster should be unmistakable even when a small metro out-ranks on LQ.
            by_emp = [r["regionId"] for r in sorted(by_occ.get(occ, []), key=lambda r: -(r["employment"] or 0))]
            emp_pos = by_emp.index(rid) + 1 if rid in by_emp else None
            check(pos is not None and (pos <= 10 or (emp_pos or 99) <= 3), f"Known cluster: {name}",
                  f"LQ rank {pos}, employment rank {emp_pos}; LQ top: {top}")

    # The direct test of the national denominator: apply the fallback formula to rows
    # where BLS did report an LQ. A systematic offset from 1.0 means the denominator is wrong.
    calib = meta.get("derivedLqCalibration")
    if calib is not None:
        check(0.9 <= calib <= 1.1, "Fallback LQ formula reproduces reported LQ",
              f"median computed/reported ratio {calib}")
    rep = sorted(r["concentration"] for r in records if r["concentrationSource"] == "reported")
    der = sorted(r["concentration"] for r in records if r["concentrationSource"] == "derived")
    if der and rep:
        med = lambda xs: xs[len(xs) // 2]
        ratio = med(der) / med(rep)
        # Derived rows skew toward small cells, so only a gross gap is meaningful, and only with volume.
        check(0.33 <= ratio <= 3.0 or len(der) < 30, "Derived LQ in same range as reported",
              f"median derived {med(der)} vs reported {med(rep)} (n={len(der):,})", warn_only=True)
    else:
        log(f"  [INFO] derived LQ records: {len(der)}")

    if full_build and nat_total:
        metro_sum = sum(r["employment"] or 0 for r in records)
        check(metro_sum < nat_total * 0.98, "Metro employment sum below national total",
              f"{metro_sum:,.0f} vs national {nat_total:,.0f} ({metro_sum / nat_total:.0%})")

    if failures:
        die(f"{len(failures)} verification check(s) failed: {failures}")
    log("  all checks passed")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--oews-metro", type=Path, default=RAW / "oesm25ma.zip")
    p.add_argument("--oews-national", type=Path, default=RAW / "oesm25nat.zip")
    p.add_argument("--gazetteer", type=Path, default=RAW / "2025_Gaz_counties_national.zip")
    p.add_argument("--crosswalk", type=Path, default=RAW / "cbsa2fipsxw_2023.csv")
    p.add_argument("--onet", type=Path, default=RAW / "db_31_0_text.zip")
    p.add_argument("--out", type=Path, default=OUT)
    p.add_argument("--occ", nargs="+", help="Limit to these SOC codes (e.g. 15-1252) for inspection")
    p.add_argument("--shard-threshold", type=int, default=SHARD_THRESHOLD_BYTES,
                   help="Shard hotspots by SOC major group above this many bytes")
    p.add_argument("--verify-only", action="store_true")
    args = p.parse_args()
    if args.verify_only:
        verify(args.out)
    else:
        build(args)


if __name__ == "__main__":
    main()
