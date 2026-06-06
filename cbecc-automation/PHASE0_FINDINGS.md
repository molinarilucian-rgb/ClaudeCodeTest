# Phase 0 Findings — CBECC 2025 (verified on this machine, 2026-06-06)

Ran `verify_cbecc.py --probe` after CBECC 2025 was installed, then investigated
the install, the manuals, and a real example project file. Results below
**materially change the design** — read this before trusting `generate_ribd.py`.

## 1. CBECC is installed; headless operation is feasible ✅

`C:\Program Files\CBECC 2025\`:
- `CBECC-25.exe` — the GUI (Qt app).
- **`CBECC-CLI25.exe` — a real command-line executable.** It parses a "primary
  function" as its first arg (`/?`, `help`, and no-arg all return
  *"Unrecognized primary function"*, i.e. it has a command grammar we haven't
  matched yet). **Open item:** find the exact primary-function keyword (check
  the CLI against the open-source repo `CBECC-software/cbecc`, or the BatchRunSet
  docs).
- `CSE\CSE.exe` — the California Simulation Engine CBECC drives. Clean documented
  CLI: `cse <switches> <inputfile>` (`-b` batch, `-ipath`, etc.).
- The GUI also has a **Batch Processing** mode driven by **Run Set CSV/XLSX**
  files (see `…\CBECC 2025 Projects\BatchRunSets\*.csv`). Format: each row names
  input file(s), an output subdir, an output filename, and parameter overrides.

**Conclusion:** the "no GUI automation / invoke the engine headlessly" premise
is sound. Two headless routes exist (CBECC-CLI25, and native Batch Run Sets).

## 2. The native `.ribd25` is **BEMProc text, NOT XML** ⚠ (design change)

A CBECC-Res project file is an indented key/value text format, e.g.:

```
RulesetFilename   "CA Res 2025.bin"

Proj   "1 Story Example "
   ClimateZone = "CZ12  (Sacramento)"
   BattMaxCap = 5
   PVWDCSysSize = ( 3, 0, 0, 0, 0 )
   ..

WindowType   "30 / 23 Window"
   NFRCUfactor = 0.3
   NFRCSHGC = 0.23
   ..
```

Rules:
- Component header at **column 0**: `Type   "Name"`.
- Properties indented 3 spaces: `   Key = value`. Strings quoted; numbers bare.
- Arrays: `   Key = ( a, b, c )` (may wrap across lines). Indexed: `   Key[1] = v`.
- Each component closes with a line that is exactly `   ..`.
- Components are a **flat, ordered list** (not nested by indentation). Containment
  (a `Win` belongs to an `ExtWall` belongs to a `Zone`) is by document order +
  name references, not by nesting.

Component order in a real single-family file:
`RulesetFilename → Proj → Garage(+walls/door/slab/ceiling) → Zone(+ceiling/walls/
windows/doors/slab) → Attic(s) → EUseSummary (results) → SchDay (schedules) →
Cons (constructions) → Mat (materials) → WindowType → HVACSys/HVACHeat/HVACCool/
HVACHtPump/HVACDist/HVACFan → DHWSys`.

**Implication:** the earlier `generate_ribd.py` (emits XML via ElementTree) does
**not** produce a file CBECC-Res opens. It's retained only as an illustrative
data-flow demo. The real serialization is BEMProc text — handled by the new
`ribd_patch.py` (template-and-patch).

## 3. Real property-name mapping (supersedes the placeholder XML tags)

| Our intake / reference field | Real `.ribd25` location |
|---|---|
| climate zone | `Proj.ClimateZone = "CZ13  (Bakersfield)"` |
| address / zip / city | `Proj.Address`, `Proj.ZipCode`, `Proj.City` |
| front orientation | `Proj.FrontOrientation` |
| conditioned floor area | `Zone "Conditioned".FloorArea` |
| window U-factor / SHGC | `WindowType "<name>".NFRCUfactor` / `.NFRCSHGC` (a `Win` references it via `WinType = "<name>"`) |
| window geometry | `Win "<tag>"`: `Area`, `Height`, `Width`, `Multiplier`, `OverhangDepth`… |
| wall assembly | `ExtWall "<name>".Construction = "<Cons name>"` (+ `Orientation`, `Area`, `Tilt`) |
| heat-pump efficiency | `HVACHtPump "<name>"`: `HSPF2`, `SEER2`, `EER2`, `Cap47`, `Cap17` |
| AC efficiency | `HVACCool "<name>"`: `SEER`, `EER2b`, `EER2a` |
| furnace efficiency | `HVACHeat "<name>".AFUE` |
| ducts | `HVACDist "<name>"`: `DuctLeakageVal`, `DuctInsRvalOpt`, `SupplyDuctLoc` |
| water heater | `DHWSys "<name>"` → `DHWHeater[1] = "<heater>"` |
| solar PV | `Proj`: `PVWDCSysSize = ( kW,0,0,0,0 )`, `PVWAzm[1]`, `PVWArrayTiltDeg[1]` |
| battery | `Proj`: `BattMaxCap`, `BatteryControl`, `BattJA12Compliant` |

## 4. File locations & the example library 🎁

Manual §2.1.1 — CBECC uses three folders (the user's Documents is OneDrive-redirected):
- Executable: `C:\Program Files\CBECC 2025`
- Data (program library): `…\Documents\CBECC 2025 Data`
- **Projects: `C:\Users\y_sam\OneDrive\Documents\CBECC 2025 Projects`**

The Projects folder ships **95 `.ribd25`** single-family examples + 112 `.cibd25`
multifamily, e.g. `SingleFamilySamples\1storyExample.ribd25` (CZ12, slab, tile
cool roof, VCHP, 3 kW PV, 5 kWh battery), `CUACExample.ribd25` (CZ13 Bakersfield),
plus per-CZ prototypes `SingleFamilyPrototypes\2025_CZ##_####ft2_{Prop,Std}.ribd25`.
A copy of `1storyExample.ribd25` lives in `reference_files/` as the patch template.

## 5. Revised strategy: template-and-patch (reliable) over generate-from-scratch

Generating a full valid `.ribd25` from nothing means emitting Proj (~170 props),
every wall/window (~45 props each), the Cons + Mat thermal libraries, WindowType,
and the full HVAC tree — high effort, high risk without iterative CBECC validation.

Instead (and mirroring CBECC's own Batch Run Set approach):
1. Pick the **closest example/prototype** to the project (by stories / floor / CZ).
2. **Patch** only the project-specific values with `ribd_patch.py` (verified
   working: 15 values patched into a real file and read back correctly).
3. Run headless via `CBECC-CLI25.exe` (or a native Run Set CSV) — pending the
   exact CLI keyword.

The reference DB, intake form, QA gate, and CSV converter all still apply — they
now feed a **patch spec** instead of an XML tree.

## 6. Open items (next session)
- [ ] Determine the `CBECC-CLI25.exe` primary-function keyword (try the repo /
      a Run Set; e.g. candidates like `analyze`, `-prj`, `runset`).
- [ ] Open `reference_files/Doe_patched.ribd25` in CBECC and run analysis to
      confirm the patched template simulates and produces a CF1R.
- [ ] Auto-map intake.json + reference.db → patch.json (close the loop).
- [ ] Decide template-selection logic (stories × CZ × foundation → which prototype).
