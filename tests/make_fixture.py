#!/usr/bin/env python3
"""Write small OEWS-shaped zips for exercising build_data.py without the real BLS files.

The fixture reproduces the gotchas the pipeline must handle: sentinel strings
(*, **, #), total/major/detailed O_GROUP rows, a nonmetro area that must be
dropped by the CBSA join, and a null LOC_QUOTIENT that must be derived.

    python tests/make_fixture.py
    python build_data.py --oews-metro data/fixture/oesm25ma.zip \
        --oews-national data/fixture/oesm25nat.zip --out /tmp/fixture-out
"""

import io
import zipfile
from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parent.parent / "data" / "fixture"

NATIONAL_TOTAL = 155_000_000
NATIONAL = {  # code: (title, group, employment)
    "00-0000": ("All Occupations", "total", NATIONAL_TOTAL),
    "11-1031": ("Legislators", "detailed", 36_000),
    "15-0000": ("Computer and Mathematical Occupations", "major", 5_400_000),
    "15-1252": ("Software Developers", "detailed", 1_700_000),
    "17-2171": ("Petroleum Engineers", "detailed", 21_000),
    "27-2011": ("Actors", "detailed", 45_000),
}

AREAS = {  # code: (title, type, total employment)
    "26420": ("Houston-Pasadena-The Woodlands, TX", "4", 3_300_000),
    "31080": ("Los Angeles-Long Beach-Anaheim, CA", "4", 6_200_000),
    "47900": ("Washington-Arlington-Alexandria, DC-VA-MD-WV", "4", 3_100_000),
    "35620": ("New York-Newark-Jersey City, NY-NJ", "4", 9_500_000),
    "12420": ("Austin-Round Rock-San Marcos, TX", "4", 1_300_000),
    "19100": ("Dallas-Fort Worth-Arlington, TX", "4", 4_000_000),
    "0400001": ("North Arizona nonmetropolitan area", "6", 50_000),
}

# (area, occ): (employment, reported LQ or sentinel, median wage or sentinel)
CELLS = {
    ("26420", "17-2171"): (9_000, None, "185000"),
    ("19100", "17-2171"): (1_200, None, "170000"),
    ("31080", "17-2171"): ("**", "**", "*"),          # fully suppressed -> no data
    ("31080", "27-2011"): (14_000, None, "#"),       # wage top-coded
    ("35620", "27-2011"): (6_000, None, "52000"),
    ("26420", "27-2011"): (500, None, "40000"),
    ("47900", "11-1031"): (900, None, "70000"),
    ("12420", "11-1031"): (40, None, "45000"),        # below the employment floor
    ("35620", "15-1252"): (90_000, None, "#"),
    ("12420", "15-1252"): (40_000, "*", "150000"),   # LQ suppressed -> derived
    ("31080", "15-1252"): (60_000, None, "145000"),
    ("26420", "15-1252"): (25_000, None, "130000"),
    ("47900", "15-1252"): (45_000, None, "150000"),
    ("19100", "15-1252"): (50_000, None, "140000"),
    ("0400001", "15-1252"): (300, None, "90000"),    # nonmetro -> dropped by join
}

COMMON = {"PRIM_STATE": "XX", "NAICS": "000000", "NAICS_TITLE": "Cross-industry",
          "I_GROUP": "cross-industry", "OWN_CODE": "1235", "PCT_TOTAL": "", "PCT_RPT": ""}


def lq(area, occ, emp):
    return round((emp / AREAS[area][2]) / (NATIONAL[occ][2] / NATIONAL_TOTAL), 2)


def metro_rows():
    rows = []
    for area, (title, typ, total) in AREAS.items():
        base = {**COMMON, "AREA": area, "AREA_TITLE": title, "AREA_TYPE": typ}
        rows.append({**base, "OCC_CODE": "00-0000", "OCC_TITLE": "All Occupations", "O_GROUP": "total",
                     "TOT_EMP": f"{total:,}", "JOBS_1000": "1000", "LOC_QUOTIENT": "1.0", "A_MEDIAN": "50000"})
    for (area, occ), (emp, rep_lq, wage) in CELLS.items():
        title, typ, _ = AREAS[area]
        value_lq = rep_lq if rep_lq is not None else (lq(area, occ, emp) if area in AREAS else "")
        rows.append({**COMMON, "AREA": area, "AREA_TITLE": title, "AREA_TYPE": typ, "OCC_CODE": occ,
                     "OCC_TITLE": NATIONAL[occ][0], "O_GROUP": "detailed",
                     "TOT_EMP": emp if isinstance(emp, str) else f"{emp:,}",
                     "JOBS_1000": "**" if isinstance(emp, str) else "1.0",
                     "LOC_QUOTIENT": value_lq, "A_MEDIAN": wage})
    ny = AREAS["35620"]
    rows.append({**COMMON, "AREA": "35620", "AREA_TITLE": ny[0], "AREA_TYPE": "4", "OCC_CODE": "15-0000",
                 "OCC_TITLE": NATIONAL["15-0000"][0], "O_GROUP": "major", "TOT_EMP": "300,000",
                 "JOBS_1000": "31.0", "LOC_QUOTIENT": "0.9", "A_MEDIAN": "120000"})
    return rows


def national_rows():
    return [{**COMMON, "AREA": "99", "AREA_TITLE": "U.S.", "AREA_TYPE": "1", "OCC_CODE": code,
             "OCC_TITLE": title, "O_GROUP": group, "TOT_EMP": f"{emp:,}", "JOBS_1000": "",
             "LOC_QUOTIENT": "", "A_MEDIAN": "#" if code == "17-2171" else "60000"}
            for code, (title, group, emp) in NATIONAL.items()]


def xlsx_bytes(rows, sheet):
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        pd.DataFrame(rows).to_excel(xw, sheet_name=sheet, index=False)
    return buf.getvalue()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    desc = xlsx_bytes([{"Field": "AREA", "Field Description": "Area code"}], "Field descriptions")
    with zipfile.ZipFile(OUT / "oesm25ma.zip", "w") as zf:
        zf.writestr("oesm25ma/Field_descriptions.xlsx", desc)
        zf.writestr("oesm25ma/MSA_M2025_dl.xlsx", xlsx_bytes(metro_rows(), "MSA_M2025_dl"))
    with zipfile.ZipFile(OUT / "oesm25nat.zip", "w") as zf:
        zf.writestr("oesm25nat/national_M2025_dl.xlsx", xlsx_bytes(national_rows(), "national_M2025_dl"))
    print(f"wrote fixture zips to {OUT}")


if __name__ == "__main__":
    main()
