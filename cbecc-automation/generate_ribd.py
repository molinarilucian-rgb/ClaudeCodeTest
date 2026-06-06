#!/usr/bin/env python3
r"""
generate_ribd.py — Starter CBECC-Res .ribd XML generator.

Pipeline position:   intake JSON + reference.db  ->  project.ribd  ->  (CBECC batch run)

Usage:
    python generate_ribd.py --intake sample_intake.json --db reference.db --out Doe.ribd
    python generate_ribd.py --intake sample_intake.json --strict      # require verified=1 rows

Stdlib only (json, sqlite3, xml.etree) — no pip install required.

================================ READ THIS ================================
The exact XML element/attribute names CBECC-Res expects come from the SDD
(Standard Data Dictionary) building model compiled into the CBECC ruleset
(the data-model .txt / .bin files in github.com/CBECC-software/cbecc). Until a
REAL .ribd that already passes CBECC is placed in ./reference_files/, every tag
emitted below is a BEST-GUESS PLACEHOLDER that follows SDD naming conventions.

Search this file for  >>>CONFIRM<<<  to find every spot that must be reconciled
against a real file before ANY output is submitted for a permit. The tag names
are deliberately isolated in the TAGS dict and the build_* functions so that,
once you have a real file, fixing them is a localized edit — not a rewrite.
==========================================================================
"""

import argparse
import json
import os
import sqlite3
import sys
import xml.etree.ElementTree as ET
from xml.dom import minidom

HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------
# Tag vocabulary — the ONE place to fix names once a real .ribd is in hand.
# >>>CONFIRM<<< every value in this dict against a real file / the SDD model.
# ----------------------------------------------------------------------
TAGS = {
    "root": "SDDXML",          # >>>CONFIRM<<< root element (may be <Proj> directly)
    "proj": "Proj",
    "ruleset": "RulesetFilename",
    "zone": "Zone",
    "construction": "Cons",
    "window": "Win",
    "door": "Dr",
    "wall": "ExtWall",
    "roof": "Roof",
    "floor": "Flr",
    "hvac": "HVACSys",
    "dhw": "DHWSys",
    "pv": "PVArray",
    "battery": "Battery",
}


class GenError(Exception):
    pass


# ----------------------------------------------------------------------
# DB helpers
# ----------------------------------------------------------------------
def connect(db_path: str) -> sqlite3.Connection:
    if not os.path.exists(db_path):
        raise GenError(f"reference DB not found: {db_path} (run init_db.py first)")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def fetch(con: sqlite3.Connection, table: str, row_id: int) -> sqlite3.Row:
    row = con.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        raise GenError(f"{table} id={row_id} referenced by intake does not exist")
    return row


def code_label(con: sqlite3.Connection, code_cycle_id: int) -> str:
    row = con.execute("SELECT code FROM code_cycles WHERE id = ?", (code_cycle_id,)).fetchone()
    return row["code"] if row else "?"


# ----------------------------------------------------------------------
# Resolve every *_ref in the intake to a full DB row, while enforcing:
#   1. referential integrity (the row exists)
#   2. code-cycle consistency (no mixing 2022 product data into a 2025 report)
#   3. (strict mode) every used row is verified=1 (human-QA'd)
# ----------------------------------------------------------------------
def resolve(con, intake, strict):
    cycle = intake["code_cycle"]
    cyc_row = con.execute("SELECT id FROM code_cycles WHERE code = ?", (cycle,)).fetchone()
    if cyc_row is None:
        raise GenError(f"unknown code_cycle '{cycle}'")
    cycle_id = cyc_row["id"]

    problems = []
    resolved = {"windows": [], "doors": [], "walls": [], "roofs": [], "floors": [], "hvac": []}

    def check(row, table, ref):
        if row["code_cycle_id"] != cycle_id:
            problems.append(
                f"{table} id={ref} is tagged code {code_label(con, row['code_cycle_id'])}, "
                f"but the project is code {cycle}"
            )
        if strict and not row["verified"]:
            problems.append(f"{table} id={ref} is not verified (verified=0) — blocked by --strict")

    for w in intake.get("windows", []):
        if "product_ref" in w:
            row = fetch(con, "window_products", w["product_ref"])
            check(row, "window_products", w["product_ref"])
            resolved["windows"].append({"intake": w, "product": row})
        else:
            resolved["windows"].append({"intake": w, "product": None})  # inline override expected

    for d in intake.get("doors", []):
        row = fetch(con, "door_products", d["product_ref"]) if "product_ref" in d else None
        if row is not None:
            check(row, "door_products", d["product_ref"])
        resolved["doors"].append({"intake": d, "product": row})

    for wall in intake.get("walls", []):
        row = fetch(con, "wall_assemblies", wall["assembly_ref"])
        check(row, "wall_assemblies", wall["assembly_ref"])
        resolved["walls"].append({"intake": wall, "assembly": row})

    for r in intake.get("roofs", []):
        row = fetch(con, "roof_assemblies", r["assembly_ref"])
        check(row, "roof_assemblies", r["assembly_ref"])
        resolved["roofs"].append({"intake": r, "assembly": row})

    for f in intake.get("floors", []):
        row = fetch(con, "floor_assemblies", f["assembly_ref"])
        check(row, "floor_assemblies", f["assembly_ref"])
        resolved["floors"].append({"intake": f, "assembly": row})

    for h in intake.get("hvac", []):
        table = "minisplit_systems" if h["system_kind"] == "ductless_minisplit" else "hvac_equipment"
        row = fetch(con, table, h["equipment_ref"]) if "equipment_ref" in h else None
        if row is not None:
            check(row, table, h["equipment_ref"])
        resolved["hvac"].append({"intake": h, "equipment": row, "table": table})

    wh = intake.get("water_heating")
    if wh and "product_ref" in wh:
        row = fetch(con, "water_heaters", wh["product_ref"])
        check(row, "water_heaters", wh["product_ref"])
        resolved["water_heating"] = {"intake": wh, "product": row}

    solar = intake.get("solar")
    if solar and "module_ref" in solar:
        row = fetch(con, "pv_modules", solar["module_ref"])
        check(row, "pv_modules", solar["module_ref"])
        resolved["solar"] = {"intake": solar, "module": row}

    batt = intake.get("battery")
    if batt and "product_ref" in batt:
        row = fetch(con, "battery_systems", batt["product_ref"])
        check(row, "battery_systems", batt["product_ref"])
        resolved["battery"] = {"intake": batt, "product": row}

    if problems:
        raise GenError("intake/reference consistency check failed:\n  - " + "\n  - ".join(problems))
    return resolved


# ----------------------------------------------------------------------
# XML construction. Every element here is PLACEHOLDER structure. >>>CONFIRM<<<
# ----------------------------------------------------------------------
def sub(parent, tag, text=None, **attrs):
    el = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    if text is not None:
        el.text = str(text)
    return el


def build_xml(intake, resolved):
    p = intake["project"]
    root = ET.Element(TAGS["root"])
    proj = sub(root, TAGS["proj"])

    # --- project header --- >>>CONFIRM<<< element names & whether CZ/code are attrs
    sub(proj, "Name", p["name"])
    sub(proj, "RunTitle", f"{p['name']} — Title 24 {intake['code_cycle']}")
    sub(proj, TAGS["ruleset"], f"T24_{intake['code_cycle']}")     # >>>CONFIRM<<<
    sub(proj, "CodeCycle", intake["code_cycle"])                  # >>>CONFIRM<<<
    sub(proj, "ClimateZone", p["climate_zone"])                   # >>>CONFIRM<<<
    sub(proj, "CondFloorArea", p["conditioned_floor_area_ft2"])   # >>>CONFIRM<<<
    sub(proj, "NumStories", p.get("stories", 1))
    sub(proj, "NumDwellingUnits", p.get("num_dwelling_units", 1))
    sub(proj, "FrontOrientation", p.get("front_orientation_deg", 0))

    # --- single conditioned zone (starter assumption: one thermal zone) ---
    # >>>CONFIRM<<< real projects often need per-zone geometry; CBECC-Res can
    # run a simplified single-zone model, which is what we emit here.
    zone = sub(proj, TAGS["zone"], Name="Zone1")                  # >>>CONFIRM<<<
    sub(zone, "FloorArea", p["conditioned_floor_area_ft2"])

    # --- walls ---
    for item in resolved["walls"]:
        w, a = item["intake"], item["assembly"]
        el = sub(proj, TAGS["wall"], Name=w["tag"])
        sub(el, "Azimuth", w["orientation_deg"])
        sub(el, "Area", w["gross_area_ft2"])
        sub(el, "CavityR", a["cavity_r"])                        # >>>CONFIRM<<< CBECC wants a Construction ref, not raw R
        sub(el, "ContInsulR", a["cont_insul_r"] or 0)
        sub(el, "ConsAssembly", a["name"])

    # --- roofs ---
    for item in resolved["roofs"]:
        r, a = item["intake"], item["assembly"]
        el = sub(proj, TAGS["roof"], Name=r["tag"])
        sub(el, "Area", r["area_ft2"])
        sub(el, "CavityR", a["cavity_r"])                        # >>>CONFIRM<<<
        sub(el, "RadiantBarrier", a["radiant_barrier"])
        sub(el, "CoolRoof", a["cool_roof"])

    # --- floors ---
    for item in resolved["floors"]:
        f, a = item["intake"], item["assembly"]
        el = sub(proj, TAGS["floor"], Name=f["tag"])
        sub(el, "Area", f["area_ft2"])
        sub(el, "FloorKind", a["floor_kind"])

    # --- windows ---
    for item in resolved["windows"]:
        w = item["intake"]
        prod = item["product"]
        u = w.get("u_factor_override", prod["u_factor"] if prod else None)
        shgc = w.get("shgc_override", prod["shgc"] if prod else None)
        if u is None or shgc is None:
            raise GenError(f"window {w['tag']} has no product_ref and no U/SHGC override")
        el = sub(proj, TAGS["window"], Name=w["tag"])
        sub(el, "Azimuth", w["orientation_deg"])
        sub(el, "Area", w["area_ft2"] * w.get("count", 1))      # total area for this tag
        sub(el, "UFactor", u)                                    # >>>CONFIRM<<< NFRCUfactor?
        sub(el, "SHGC", shgc)                                    # >>>CONFIRM<<< NFRCSHGC?
        if w.get("overhang_ft"):
            sub(el, "OverhangDepth", w["overhang_ft"])

    # --- doors ---
    for item in resolved["doors"]:
        d, prod = item["intake"], item["product"]
        el = sub(proj, TAGS["door"], Name=d["tag"])
        sub(el, "Area", d["area_ft2"] * d.get("count", 1))
        if prod is not None:
            sub(el, "UFactor", prod["u_factor"])

    # --- HVAC ---
    for item in resolved["hvac"]:
        h, eq, table = item["intake"], item["equipment"], item["table"]
        el = sub(proj, TAGS["hvac"], Name=h["tag"])
        sub(el, "SystemKind", h["system_kind"])                  # >>>CONFIRM<<<
        if eq is not None:
            if table == "minisplit_systems":
                sub(el, "SEER2", eq["seer2"])
                sub(el, "HSPF2", eq["hspf2"])
                sub(el, "Manufacturer", eq["manufacturer"])
                sub(el, "Model", eq["outdoor_model"])
            else:
                if eq["seer2"] is not None:
                    sub(el, "SEER2", eq["seer2"])
                if eq["hspf2"] is not None:
                    sub(el, "HSPF2", eq["hspf2"])
                if eq["afue"] is not None:
                    sub(el, "AFUE", eq["afue"])
                sub(el, "Manufacturer", eq["manufacturer"])
                sub(el, "Model", eq["model"])
        # ducts
        sub(el, "DuctLocation", h.get("duct_location", "conditioned"))
        sub(el, "DuctInsulR", h.get("duct_r", 0))
        sub(el, "DuctLeakagePct", h.get("duct_leakage_pct", 0))

    # --- water heating ---
    wh = resolved.get("water_heating")
    if wh:
        prod = wh["product"]
        el = sub(proj, TAGS["dhw"], Name="DHW1")
        sub(el, "Type", prod["wh_type"])                         # >>>CONFIRM<<<
        if prod["uef"] is not None:
            sub(el, "UEF", prod["uef"])
        if prod["tank_gal"] is not None:
            sub(el, "TankVolume", prod["tank_gal"])
        sub(el, "Distribution", wh["intake"].get("distribution", "standard"))
        sub(el, "Recirculation", int(bool(wh["intake"].get("recirculation", False))))

    # --- solar PV ---
    solar = resolved.get("solar")
    if solar:
        s = solar["intake"]
        el = sub(proj, TAGS["pv"], Name="PV1")
        sub(el, "DCSystemSize", s["dc_size_kw"])                 # >>>CONFIRM<<<
        sub(el, "Azimuth", s.get("azimuth_deg", 180))
        sub(el, "Tilt", s.get("tilt_deg", 22))
        sub(el, "ArrayType", s.get("array_type", "roof_mounted"))

    # --- battery ---
    batt = resolved.get("battery")
    if batt:
        b = batt["intake"]
        el = sub(proj, TAGS["battery"], Name="Batt1")
        sub(el, "UsableCapacity", b.get("usable_kwh", batt["product"]["usable_kwh"]))
        sub(el, "ControlStrategy", batt["product"]["control_strategy"])

    return root


def pretty(elem) -> str:
    rough = ET.tostring(elem, encoding="utf-8")
    return minidom.parseString(rough).toprettyxml(indent="  ")


# ----------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a CBECC-Res .ribd from intake + reference DB.")
    ap.add_argument("--intake", default=os.path.join(HERE, "sample_intake.json"))
    ap.add_argument("--db", default=os.path.join(HERE, "reference.db"))
    ap.add_argument("--out", default=os.path.join(HERE, "project.ribd"))
    ap.add_argument("--strict", action="store_true",
                    help="require every referenced row to be verified=1 (recommended for real reports)")
    args = ap.parse_args()

    try:
        with open(args.intake, "r", encoding="utf-8") as fh:
            intake = json.load(fh)
        con = connect(args.db)
        resolved = resolve(con, intake, args.strict)
        root = build_xml(intake, resolved)
    except GenError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(pretty(root))

    print(f"wrote {args.out}")
    print("WARNING: tag names are placeholders — see the >>>CONFIRM<<< markers and validate")
    print("         against a real .ribd before submitting anything for a permit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
