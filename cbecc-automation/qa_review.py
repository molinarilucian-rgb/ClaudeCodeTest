#!/usr/bin/env python3
"""
qa_review.py — Human-QA gate for the reference library (Phase 3 starter).

A reference-DB row is NOT trusted for permit-bound reports until a person
confirms it (verified=1) with their name and a date. generate_ribd.py --strict
refuses any unverified row, so this tool is what unlocks real report generation.

Usage:
    python qa_review.py list                         # show unverified rows
    python qa_review.py list --all                   # include verified rows
    python qa_review.py verify --table window_products --id 1 --by "L. Molinari"
    python qa_review.py verify-all --by "L. Molinari" # bulk-confirm everything (demo)
    python qa_review.py unverify --table window_products --id 1

Stdlib only.
"""

import argparse
import datetime
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# table -> SQL expression that produces a human-readable label for a row
TABLES = {
    "window_products":  "manufacturer || ' ' || series",
    "door_products":    "manufacturer || ' ' || model",
    "wall_assemblies":  "name",
    "roof_assemblies":  "name",
    "floor_assemblies": "name",
    "hvac_equipment":   "manufacturer || ' ' || model",
    "minisplit_systems":"manufacturer || ' ' || outdoor_model",
    "water_heaters":    "manufacturer || ' ' || model",
    "pv_modules":       "manufacturer || ' ' || model",
    "battery_systems":  "manufacturer || ' ' || model",
}


def connect(db_path):
    if not os.path.exists(db_path):
        sys.exit(f"reference DB not found: {db_path} (run init_db.py first)")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def cmd_list(con, show_all):
    total = 0
    for table, label in TABLES.items():
        where = "active = 1" if show_all else "active = 1 AND verified = 0"
        rows = con.execute(
            f"SELECT id, ({label}) AS label, verified, verified_by, verified_on "
            f"FROM {table} WHERE {where} ORDER BY id"
        ).fetchall()
        if not rows:
            continue
        print(f"\n{table}")
        for r in rows:
            flag = f"verified by {r['verified_by']} on {r['verified_on']}" if r["verified"] else "UNVERIFIED"
            print(f"  [{r['id']:>3}] {r['label']:<40} {flag}")
            total += 1
    if total == 0:
        print("nothing to show — all clear." if not show_all else "no active rows.")
    print(f"\n{total} row(s).")


def cmd_verify(con, table, row_id, by, note, value):
    if table not in TABLES:
        sys.exit(f"unknown table '{table}'. Known: {', '.join(TABLES)}")
    row = con.execute(f"SELECT id FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        sys.exit(f"{table} id={row_id} not found")
    today = datetime.date.today().isoformat()
    if value:
        con.execute(
            f"UPDATE {table} SET verified=1, verified_by=?, verified_on=?,"
            f" notes = COALESCE(notes,'') || ? WHERE id=?",
            (by, today, (f" | QA: {note}" if note else ""), row_id),
        )
        print(f"verified {table} id={row_id} (by {by}, {today})")
    else:
        con.execute(f"UPDATE {table} SET verified=0, verified_by=NULL, verified_on=NULL WHERE id=?", (row_id,))
        print(f"un-verified {table} id={row_id}")
    con.commit()


def cmd_verify_all(con, by):
    today = datetime.date.today().isoformat()
    n = 0
    for table in TABLES:
        cur = con.execute(
            f"UPDATE {table} SET verified=1, verified_by=?, verified_on=? "
            f"WHERE active=1 AND verified=0",
            (by, today),
        )
        n += cur.rowcount
    con.commit()
    print(f"verified {n} row(s) by {by} on {today}")


def main():
    ap = argparse.ArgumentParser(description="Human-QA gate for the reference library.")
    ap.add_argument("--db", default=os.path.join(HERE, "reference.db"))
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="list rows needing review")
    p_list.add_argument("--all", action="store_true", help="include already-verified rows")

    p_ver = sub.add_parser("verify", help="confirm a single row")
    p_ver.add_argument("--table", required=True)
    p_ver.add_argument("--id", type=int, required=True)
    p_ver.add_argument("--by", required=True)
    p_ver.add_argument("--note")

    p_all = sub.add_parser("verify-all", help="bulk-confirm every unverified row")
    p_all.add_argument("--by", required=True)

    p_un = sub.add_parser("unverify", help="revoke confirmation on a row")
    p_un.add_argument("--table", required=True)
    p_un.add_argument("--id", type=int, required=True)

    args = ap.parse_args()
    con = connect(args.db)

    if args.cmd == "list":
        cmd_list(con, args.all)
    elif args.cmd == "verify":
        cmd_verify(con, args.table, args.id, args.by, args.note, value=True)
    elif args.cmd == "verify-all":
        cmd_verify_all(con, args.by)
    elif args.cmd == "unverify":
        cmd_verify(con, args.table, args.id, None, None, value=False)


if __name__ == "__main__":
    main()
