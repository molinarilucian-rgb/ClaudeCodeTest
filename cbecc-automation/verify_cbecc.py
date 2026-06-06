#!/usr/bin/env python3
"""
verify_cbecc.py — Phase 0: locate a CBECC install and probe batch/CLI capability.

This is the single highest-risk unknown in the whole project: if the installed
CBECC build does NOT expose a real command-line / batch mode, the "invoke the
engine headlessly" architecture needs adjustment. Run this AFTER installing
CBECC-Res to gather the facts.

Usage:
    python verify_cbecc.py                       # search default locations, report
    python verify_cbecc.py --search "D:\\Apps"     # add a search root
    python verify_cbecc.py --probe               # also try running --help/ /? on finds
                                                 # (may briefly open the GUI — opt-in)

Stdlib only. Read-only unless --probe is passed.
"""

import argparse
import os
import subprocess
import sys

DEFAULT_ROOTS = [
    os.environ.get("ProgramFiles", r"C:\Program Files"),
    os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    r"C:\\",
]

DATA_HINTS = (".bin", ".txt")             # ruleset / data-model files live alongside
PROJECT_HINTS = (".ribd", ".cibd")        # example project files shipped with install


def is_engine_exe(low):
    # CBECC apps; CSE = California Simulation Engine (Res). Match whole-name-ish
    # so we don't catch unrelated services that merely contain the letters "cse".
    return "cbecc" in low or low == "cse.exe"


def depth_of(path, base):
    return os.path.abspath(path).rstrip(os.sep).count(os.sep) - base


def find(roots, max_depth=3):
    exes, examples, rulesets = [], [], []
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        root = os.path.abspath(root)
        base = root.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root):
            depth = depth_of(dirpath, base)
            if depth >= max_depth:
                dirnames[:] = []
            # at the root, only descend into dirs that look CBECC-related
            if depth == 0:
                dirnames[:] = [d for d in dirnames if "cbecc" in d.lower()]
            for f in filenames:
                low = f.lower()
                full = os.path.join(dirpath, f)
                if low.endswith(".exe") and is_engine_exe(low):
                    exes.append(full)
                elif any(low.endswith(h) for h in PROJECT_HINTS):
                    examples.append(full)
                elif "ruleset" in dirpath.lower() and low.endswith(tuple(DATA_HINTS)):
                    rulesets.append(full)
    return exes, examples, rulesets


def probe(exe):
    """Try common help flags; capture whatever the exe prints. Best-effort."""
    for flag in ("/?", "--help", "-h", "/help"):
        try:
            r = subprocess.run([exe, flag], capture_output=True, text=True, timeout=8)
            out = (r.stdout or "") + (r.stderr or "")
            if out.strip():
                return flag, out.strip()[:1500]
        except Exception as e:  # noqa: BLE001 — best-effort probe
            last = str(e)
    return None, f"no textual help output (GUI-only build?) — last: {locals().get('last','n/a')}"


def main():
    ap = argparse.ArgumentParser(description="Locate CBECC and probe batch/CLI capability.")
    ap.add_argument("--search", action="append", default=[], help="extra root(s) to search")
    ap.add_argument("--probe", action="store_true", help="run help flags on found exes (opt-in)")
    args = ap.parse_args()

    roots = DEFAULT_ROOTS + args.search
    print("Searching:", ", ".join(r for r in roots if r))
    exes, examples, rulesets = find(roots)

    print("\n== Executables ==")
    if exes:
        for e in exes:
            print("  ", e)
    else:
        print("   none found — is CBECC installed? Try --search <its folder>")

    print("\n== Example project files (.ribd/.cibd) ==")
    for e in examples[:15]:
        print("  ", e)
    if not examples:
        print("   none found (a shipped example would be a perfect tag-mapping reference!)")

    print("\n== Ruleset / data-model files ==")
    for r in rulesets[:10]:
        print("  ", r)
    if not rulesets:
        print("   none found")

    if args.probe and exes:
        print("\n== CLI probe ==")
        for e in exes:
            flag, out = probe(e)
            tag = f"responded to '{flag}'" if flag else "NO CLI HELP"
            print(f"\n--- {os.path.basename(e)} [{tag}] ---")
            print(out)

    print("\nNext: confirm the exact batch invocation in CBECC docs / the open-source")
    print("repo (github.com/CBECC-software/cbecc), and copy any example .ribd into")
    print("./reference_files/ to finish the generator's tag mapping.")
    return 0 if exes else 1


if __name__ == "__main__":
    raise SystemExit(main())
