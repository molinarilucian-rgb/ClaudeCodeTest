#!/usr/bin/env python3
"""
intake_from_csv.py — Phase 4: deterministic spreadsheet -> intake.json.

A project lead fills in a small pack of CSVs (one per section — export each tab
of an Excel workbook as CSV, or edit directly). This converts them to the
intake.json that generate_ribd.py consumes. NO AI: pure, predictable parsing.

Usage:
    python intake_from_csv.py templates ./intake_csv        # write blank templates
    python intake_from_csv.py build ./intake_csv --out intake.json

Stdlib only (csv, json).

CSV pack layout (a folder):
    project.csv        key,value pairs (incl. code_cycle)   [required]
    windows.csv        one row per window tag                [required]
    doors.csv          one row per door tag                  [optional]
    walls.csv          one row per wall                      [required]
    roofs.csv          one row per roof                      [required]
    floors.csv         one row per floor                     [optional]
    hvac.csv           one row per HVAC system               [required]
    water_heating.csv  single data row                       [required]
    solar.csv          single data row                       [optional]
    battery.csv        single data row                       [optional]
"""

import argparse
import csv
import json
import os
import sys

# column -> python type for each list/single section. Columns not listed here
# default to str. Empty cells are dropped (so optional fields stay absent).
TYPES = {
    "project": {"climate_zone": int, "stories": int, "conditioned_floor_area_ft2": float,
                "num_dwelling_units": int, "front_orientation_deg": float},
    "windows": {"product_ref": int, "orientation_deg": float, "area_ft2": float,
                "count": int, "overhang_ft": float, "u_factor_override": float, "shgc_override": float},
    "doors": {"product_ref": int, "orientation_deg": float, "area_ft2": float, "count": int},
    "walls": {"assembly_ref": int, "orientation_deg": float, "gross_area_ft2": float},
    "roofs": {"assembly_ref": int, "area_ft2": float},
    "floors": {"assembly_ref": int, "area_ft2": float},
    "hvac": {"equipment_ref": int, "duct_r": float, "duct_leakage_pct": float},
    "water_heating": {"product_ref": int, "recirculation": bool},
    "solar": {"module_ref": int, "dc_size_kw": float, "azimuth_deg": float, "tilt_deg": float},
    "battery": {"product_ref": int, "usable_kwh": float},
}

# headers used when writing blank templates
HEADERS = {
    "windows": ["tag", "product_ref", "orientation_deg", "area_ft2", "count", "overhang_ft", "u_factor_override", "shgc_override"],
    "doors": ["tag", "product_ref", "orientation_deg", "area_ft2", "count"],
    "walls": ["tag", "assembly_ref", "orientation_deg", "gross_area_ft2"],
    "roofs": ["tag", "assembly_ref", "area_ft2"],
    "floors": ["tag", "assembly_ref", "area_ft2"],
    "hvac": ["tag", "system_kind", "equipment_ref", "duct_location", "duct_r", "duct_leakage_pct"],
}
SINGLE_HEADERS = {
    "water_heating": ["product_ref", "distribution", "recirculation"],
    "solar": ["module_ref", "dc_size_kw", "azimuth_deg", "tilt_deg", "array_type"],
    "battery": ["product_ref", "usable_kwh"],
}
PROJECT_KEYS = ["code_cycle", "name", "address", "city", "zip", "climate_zone",
                "building_type", "stories", "conditioned_floor_area_ft2",
                "num_dwelling_units", "front_orientation_deg"]


def coerce(value, typ):
    value = (value or "").strip()
    if value == "":
        return None
    if typ is int:
        return int(float(value))
    if typ is float:
        return float(value)
    if typ is bool:
        return value.lower() in ("1", "true", "yes", "y")
    return value


def read_rows(path, section):
    """Read a list-section CSV into a list of coerced dicts (empty cells dropped)."""
    if not os.path.exists(path):
        return []
    types = TYPES.get(section, {})
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for raw in csv.DictReader(fh):
            row = {}
            for k, v in raw.items():
                if k is None:
                    continue
                val = coerce(v, types.get(k, str))
                if val is not None:
                    row[k] = val
            if row:
                out.append(row)
    return out


def read_single(path, section):
    rows = read_rows(path, section)
    return rows[0] if rows else None


def build(src_dir):
    proj_path = os.path.join(src_dir, "project.csv")
    if not os.path.exists(proj_path):
        sys.exit(f"missing required {proj_path}")

    # project.csv is key,value
    proj = {}
    with open(proj_path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            if not row or row[0].strip().lower() in ("key", ""):
                continue
            key = row[0].strip()
            val = coerce(row[1] if len(row) > 1 else "", TYPES["project"].get(key, str))
            if val is not None:
                proj[key] = val

    code_cycle = proj.pop("code_cycle", None)
    if code_cycle is None:
        sys.exit("project.csv must include a 'code_cycle' row")

    intake = {
        "code_cycle": str(code_cycle),
        "project": proj,
        "windows": read_rows(os.path.join(src_dir, "windows.csv"), "windows"),
        "doors": read_rows(os.path.join(src_dir, "doors.csv"), "doors"),
        "walls": read_rows(os.path.join(src_dir, "walls.csv"), "walls"),
        "roofs": read_rows(os.path.join(src_dir, "roofs.csv"), "roofs"),
        "floors": read_rows(os.path.join(src_dir, "floors.csv"), "floors"),
        "hvac": read_rows(os.path.join(src_dir, "hvac.csv"), "hvac"),
    }
    wh = read_single(os.path.join(src_dir, "water_heating.csv"), "water_heating")
    if wh:
        intake["water_heating"] = wh
    solar = read_single(os.path.join(src_dir, "solar.csv"), "solar")
    if solar:
        intake["solar"] = solar
    batt = read_single(os.path.join(src_dir, "battery.csv"), "battery")
    if batt:
        intake["battery"] = batt

    # drop empty optional lists for a cleaner file
    for k in ("doors", "floors"):
        if not intake[k]:
            intake.pop(k)
    return intake


def write_templates(dst_dir):
    os.makedirs(dst_dir, exist_ok=True)
    # project.csv (key,value)
    with open(os.path.join(dst_dir, "project.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["key", "value"])
        for k in PROJECT_KEYS:
            w.writerow([k, ""])
    for name, hdr in HEADERS.items():
        with open(os.path.join(dst_dir, f"{name}.csv"), "w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerow(hdr)
    for name, hdr in SINGLE_HEADERS.items():
        with open(os.path.join(dst_dir, f"{name}.csv"), "w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerow(hdr)
    print(f"wrote blank CSV templates to {dst_dir}")


def main():
    ap = argparse.ArgumentParser(description="Convert a CSV pack to intake.json (and back-fill templates).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_t = sub.add_parser("templates", help="write blank CSV templates")
    p_t.add_argument("dir")
    p_b = sub.add_parser("build", help="build intake.json from a CSV pack")
    p_b.add_argument("dir")
    p_b.add_argument("--out", default="intake.json")
    args = ap.parse_args()

    if args.cmd == "templates":
        write_templates(args.dir)
    elif args.cmd == "build":
        intake = build(args.dir)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(intake, fh, indent=2)
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
