#!/usr/bin/env python3
r"""
ribd_patch.py — patch a known-good CBECC .ribd25 template (the RELIABLE path).

DISCOVERY (Phase 0): a CBECC-Res .ribd25 is NOT XML. It is BEMProc indented
text — components written as

    WindowType   "30 / 23 Window"
       NFRCUfactor = 0.3
       NFRCSHGC = 0.23
       ..

(header at col 0, "   Key = value" properties, block closed by "   ..").
See PHASE0_FINDINGS.md. Because a real example file is already CBECC-valid,
the robust automation is to COPY the closest example and overwrite only the
project-specific values — not to regenerate the whole file from scratch.

This tool does exactly that, plus a --get mode to read a value back for QA.

Usage:
    python ribd_patch.py --template reference_files\1storyExample.ribd25 \
                         --patch sample_patch.json --out out.ribd25
    python ribd_patch.py --template out.ribd25 --get Zone Conditioned FloorArea

Patch JSON shape:
    {
      "proj": { "ClimateZone": "CZ13  (Bakersfield)", "ZipCode": 93301,
                "FrontOrientation": 180, "BattMaxCap": 13.5,
                "PVWDCSysSize": "@raw:( 4.5, 0, 0, 0, 0 )", "PVWAzm[1]": 180 },
      "components": [
        { "type":"WindowType", "name":"30 / 23 Window",
          "props": { "NFRCUfactor": 0.28, "NFRCSHGC": 0.22 } },
        { "type":"Zone", "name":"Conditioned", "props": { "FloorArea": 2150 } },
        { "type":"HVACHtPump", "name":"Variable Capacity Heat Pump",
          "props": { "HSPF2": 9.8, "SEER2": 18 } }
      ]
    }

String values are quoted automatically. Use the "@raw:" prefix to emit a value
verbatim (arrays like "( a, b )"). Indexed keys are written literally, e.g.
"PVWAzm[1]". Stdlib only.
"""

import argparse
import json
import re
import sys


class Ribd:
    def __init__(self, text):
        # keep line endings normalized to \n internally
        self.lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # --- block location -------------------------------------------------
    def _block_bounds(self, ctype, cname=None):
        """Return (header_idx, close_idx) for the first matching component."""
        if cname is None:
            hdr = re.compile(rf'^{re.escape(ctype)}\s+"')
        else:
            hdr = re.compile(rf'^{re.escape(ctype)}\s+"{re.escape(cname)}"\s*$')
        for i, ln in enumerate(self.lines):
            if hdr.match(ln.rstrip()):
                for j in range(i + 1, len(self.lines)):
                    if self.lines[j].strip() == "..":
                        return i, j
                raise ValueError(f'{ctype} "{cname}" has no closing ".."')
        return None

    # --- value formatting ----------------------------------------------
    @staticmethod
    def _fmt(value):
        if isinstance(value, str):
            if value.startswith("@raw:"):
                return value[len("@raw:"):]
            return f'"{value}"'
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)

    # --- mutation -------------------------------------------------------
    def set_prop(self, ctype, cname, key, value):
        bounds = self._block_bounds(ctype, cname)
        if bounds is None:
            raise KeyError(f'component not found: {ctype} "{cname}"')
        start, close = bounds
        kre = re.compile(rf"^(\s*){re.escape(key)}\s*=")
        for i in range(start + 1, close):
            m = kre.match(self.lines[i])
            if m:
                indent = m.group(1) or "   "
                self.lines[i] = f"{indent}{key} = {self._fmt(value)}"
                return "updated"
        # not present — insert just before the closing ".."
        self.lines.insert(close, f"   {key} = {self._fmt(value)}")
        return "inserted"

    def get_prop(self, ctype, cname, key):
        bounds = self._block_bounds(ctype, cname)
        if bounds is None:
            raise KeyError(f'component not found: {ctype} "{cname}"')
        start, close = bounds
        kre = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(.*)$")
        for i in range(start + 1, close):
            m = kre.match(self.lines[i])
            if m:
                return m.group(1).strip()
        return None

    def text(self):
        return "\n".join(self.lines)


def apply_patch(doc, patch):
    log = []
    for key, value in patch.get("proj", {}).items():
        action = doc.set_prop("Proj", None, key, value)
        log.append(f"  Proj.{key} = {value}  ({action})")
    for comp in patch.get("components", []):
        for key, value in comp["props"].items():
            action = doc.set_prop(comp["type"], comp["name"], key, value)
            log.append(f'  {comp["type"]}["{comp["name"]}"].{key} = {value}  ({action})')
    return log


def main():
    ap = argparse.ArgumentParser(description="Patch a CBECC .ribd25 template.")
    ap.add_argument("--template", required=True)
    ap.add_argument("--patch")
    ap.add_argument("--out")
    ap.add_argument("--get", nargs=3, metavar=("TYPE", "NAME", "KEY"),
                    help="read one property and print it (no write)")
    args = ap.parse_args()

    with open(args.template, "r", encoding="utf-8", errors="replace") as fh:
        doc = Ribd(fh.read())

    if args.get:
        ctype, cname, key = args.get
        val = doc.get_prop(ctype, cname, key)
        print(val if val is not None else f"(no '{key}' in {ctype} \"{cname}\")")
        return 0

    if not args.patch or not args.out:
        ap.error("provide --patch and --out (or use --get)")

    with open(args.patch, "r", encoding="utf-8") as fh:
        patch = json.load(fh)

    try:
        log = apply_patch(doc, patch)
    except (KeyError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    # preserve CBECC's CRLF line endings on write
    with open(args.out, "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write(doc.text())

    print(f"patched {len(log)} value(s) -> {args.out}")
    print("\n".join(log))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
