#!/usr/bin/env python3
"""
init_db.py — Create the reference DB from schema.sql and seed minimal data.

Usage:
    python init_db.py                 # creates ./reference.db
    python init_db.py --db other.db   # custom path
    python init_db.py --force         # drop & recreate if it already exists

Stdlib only (sqlite3) — no pip install required.

All seeded product rows are intentionally marked verified=0 to demonstrate the
human-QA flag: a row is NOT trusted by the generator's strict mode until a
person has confirmed it and set verified=1.
"""

import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")


def seed(con: sqlite3.Connection) -> None:
    # --- code cycles (2025 is current as of 2026-01-01) ---
    con.executemany(
        "INSERT INTO code_cycles (id, code, title, effective_on, superseded_on, cbecc_ruleset, notes)"
        " VALUES (?,?,?,?,?,?,?)",
        [
            (1, "2019", "2019 Building Energy Efficiency Standards", "2020-01-01", "2023-01-01", "CA Res 2019", None),
            (2, "2022", "2022 Building Energy Efficiency Standards", "2023-01-01", "2026-01-01", "CA Res 2022", None),
            (3, "2025", "2025 Building Energy Efficiency Standards", "2026-01-01", None, "CA Res 2025", "Current code"),
        ],
    )

    # --- a few California climate zones (CZ 13 = Bakersfield) ---
    con.executemany(
        "INSERT INTO climate_zones (cz, representative_city, notes) VALUES (?,?,?)",
        [
            (12, "Sacramento", None),
            (13, "Bakersfield", "Smart Sketch Inc. home turf"),
            (14, "Palmdale", None),
            (15, "Palm Springs", None),
        ],
    )

    CYCLE_2025 = 3  # FK id for the 2025 cycle, used for every demo row below

    con.execute(
        "INSERT INTO window_products"
        " (id, manufacturer, series, frame_type, glazing, operable, u_factor, shgc, vt, nfrc_cpd, code_cycle_id, notes)"
        " VALUES (1,'Milgard','Trinsic',?,?,1,0.30,0.23,0.52,'XXXX-X-XXXXX',?, 'EXAMPLE row — replace with your real NFRC data')",
        ("vinyl", "dual LowE2", CYCLE_2025),
    )

    con.execute(
        "INSERT INTO door_products (id, manufacturer, model, door_type, u_factor, code_cycle_id, notes)"
        " VALUES (1,'Therma-Tru','Smooth-Star','opaque',0.20,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )

    con.execute(
        "INSERT INTO wall_assemblies (id, name, framing, cavity_r, cont_insul_r, assembly_kind, code_cycle_id, notes)"
        " VALUES (1,'R-21 2x6 16oc + R-5 ci','2x6 @ 16 in OC',21,5,'wood_framed',?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )
    con.execute(
        "INSERT INTO roof_assemblies (id, name, framing, cavity_r, deck_insul_r, radiant_barrier, cool_roof, code_cycle_id, notes)"
        " VALUES (1,'R-38 attic + radiant barrier','2x4 truss',38,0,1,0,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )
    con.execute(
        "INSERT INTO floor_assemblies (id, name, floor_kind, slab_edge_r, code_cycle_id, notes)"
        " VALUES (1,'Slab-on-grade, R-0 edge','slab_on_grade',0,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )

    con.execute(
        "INSERT INTO hvac_equipment"
        " (id, equipment_type, manufacturer, model, ahri_ref, cooling_cap_btuh, seer2, eer2, heating_cap_btuh, hspf2, code_cycle_id, notes)"
        " VALUES (1,'ducted_heat_pump','Carrier','25SPB6',NULL,36000,15.2,11.0,36000,7.8,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )
    con.execute(
        "INSERT INTO minisplit_systems"
        " (id, manufacturer, outdoor_model, configuration, num_heads, cooling_cap_btuh, heating_cap_btuh, seer2, hspf2, code_cycle_id, notes)"
        " VALUES (1,'Mitsubishi','MXZ-3C24NAHZ','multi_zone',3,24000,25000,18.0,9.5,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )
    con.execute(
        "INSERT INTO water_heaters (id, wh_type, manufacturer, model, tank_gal, uef, code_cycle_id, notes)"
        " VALUES (1,'hpwh','Rheem','ProTerra 50',50,3.75,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )
    con.execute(
        "INSERT INTO pv_modules (id, manufacturer, model, stc_watt, efficiency_pct, code_cycle_id, notes)"
        " VALUES (1,'REC','Alpha Pure-R 430',430,22.3,?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )
    con.execute(
        "INSERT INTO battery_systems (id, manufacturer, model, usable_kwh, rated_kw, round_trip_eff_pct, control_strategy, code_cycle_id, notes)"
        " VALUES (1,'Tesla','Powerwall 3',13.5,11.5,90,'advanced_dr',?, 'EXAMPLE row')",
        (CYCLE_2025,),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Initialize the CBECC reference DB.")
    ap.add_argument("--db", default=os.path.join(HERE, "reference.db"))
    ap.add_argument("--force", action="store_true", help="drop existing DB first")
    args = ap.parse_args()

    if os.path.exists(args.db):
        if not args.force:
            print(f"refusing to overwrite existing {args.db} (use --force)", file=sys.stderr)
            return 1
        os.remove(args.db)

    with open(SCHEMA, "r", encoding="utf-8") as fh:
        ddl = fh.read()

    con = sqlite3.connect(args.db)
    try:
        con.executescript(ddl)
        seed(con)
        con.commit()
    finally:
        con.close()

    print(f"created and seeded {args.db}")
    print("NOTE: all seeded product rows are verified=0 (placeholder data).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
