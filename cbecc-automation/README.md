# CBECC-Res Title 24 Automation — Smart Sketch Inc.

Phased system to cut residential Title 24 (CF1R) report production from several
hours to **under ~30 minutes** for repeat-type projects, **without** compromising
accuracy or code compliance.

**Scope (locked):** CBECC-Res first (`.ribd` → CF1R-PRF), architected so
CBECC-Com (`.cibd` → NRCC) can be added later. Platform: Windows (CBECC's native
OS). Volume: ~20 reports/month. Code cycle: **2025** is in effect as of 2026-01-01.

> **Hard rules this design obeys**
> 1. **No GUI automation.** We generate/modify the XML project file directly and
>    invoke the CBECC engine in batch. No screen-clicking.
> 2. **Code-cycle tagging everywhere.** Every reference-DB row carries a
>    `code_cycle_id`; the generator refuses to mix cycles.
> 3. **Human-QA gate is mandatory.** No straight-through automation of data
>    extraction into a permit-bound CF1R. A person signs off before final docs.

---

## 1. Target architecture

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ INTAKE                                                                     │
 │  • Spreadsheet / simple web form (structured)  ──► intake.json            │
 │  • Plan sets (PDF) ─► [assisted extraction] ─► PROPOSED intake.json       │
 │                              (Phase 5, AI, low-confidence flagged)        │
 └───────────────┬───────────────────────────────────────────┬──────────────┘
                 │ structured                    proposed     │
                 ▼                                            ▼
        ┌───────────────────┐                    ┌────────────────────────┐
        │  REFERENCE DB      │  resolve *_ref     │  HUMAN QA GATE         │
        │  (SQLite)          │◄───────────────────│  reviewer confirms     │
        │  enter-once-reuse  │                    │  every extracted field │
        │  every row tagged  │                    │  → status=qa_approved  │
        │  by code cycle     │                    └───────────┬────────────┘
        └─────────┬─────────┘                                │ approved only
                  │ verified rows                            │
                  ▼                                          ▼
        ┌──────────────────────────────────────────────────────────┐
        │  XML GENERATOR  (generate_ribd.py)                        │
        │  • validates: referential integrity, code-cycle match,    │
        │    required fields, (strict) verified=1                    │
        │  • emits project.ribd (SDD XML)                            │
        └─────────────────────────┬────────────────────────────────┘
                                  ▼
        ┌──────────────────────────────────────────────────────────┐
        │  CBECC BATCH RUN  (CBECC-Res engine, command line)        │
        │  • loads .ribd → runs CSE simulation → compliance result  │
        │  ⚠ Phase 0 must CONFIRM the exact CLI/batch invocation     │
        └─────────────────────────┬────────────────────────────────┘
                                  ▼
        ┌──────────────────────────────────────────────────────────┐
        │  OUTPUT: CF1R-PRF (PDF) + pass/fail + margin              │
        │  → attach to permit set; log in projects/qa_reviews       │
        └──────────────────────────────────────────────────────────┘
```

The reference DB sits at the center: **data is entered once, QA'd once, and
reused** across every report, which is where most of the time savings and
consistency gains come from — independent of any AI.

---

## 2. Reference database

Defined in [`schema.sql`](schema.sql); created/seeded by
[`init_db.py`](init_db.py). Tables:

| Table | Holds | Code-cycle tagged |
|---|---|---|
| `code_cycles`, `climate_zones` | lookups (2019/2022/2025; CA CZ 1–16) | — |
| `window_products` | mfr / series / U-factor / SHGC / VT / NFRC CPD | ✅ |
| `door_products` | opaque & glazed doors, U-factor | ✅ |
| `wall_assemblies` / `roof_assemblies` / `floor_assemblies` | framing, cavity R, ci, U | ✅ |
| `hvac_equipment` | furnaces, ACs, ducted heat pumps (SEER2/EER2/HSPF2/AFUE) | ✅ |
| `minisplit_systems` | ductless mini-splits (multi-zone, HERS) | ✅ |
| `water_heaters` | storage gas / tankless / HPWH (UEF) | ✅ |
| `pv_modules` | solar modules (array geometry is per-project, in intake) | ✅ |
| `battery_systems` | usable kWh, control strategy (JA12) | ✅ |
| `prescriptive_requirements` | per-cycle, per-CZ baseline limits (grow over time) | ✅ |
| `projects`, `qa_reviews` | operational state + QA sign-off log | — |

Every product row has `verified` (0/1), `verified_by`, `verified_on`. The
generator's `--strict` mode refuses any row with `verified=0`, so unreviewed
library data can't reach a permit document.

---

## 3. Intake form spec

Formal contract: [`intake_schema.json`](intake_schema.json) (JSON Schema, 2020-12).
Example: [`sample_intake.json`](sample_intake.json). It captures:

- **project** — name, address, city, zip, **climate zone**, building type,
  stories, **conditioned floor area**, dwelling units, front orientation
- **windows[]** — tag, `product_ref` (→ library), orientation, area, count,
  overhang, optional U/SHGC override for one-offs
- **doors[]** — tag, `product_ref`, orientation, area, count
- **walls[] / roofs[] / floors[]** — tag, `assembly_ref` (→ library),
  orientation/area
- **hvac[]** — system kind, `equipment_ref`, duct location / R-value / leakage
- **water_heating** — `product_ref`, distribution, recirculation
- **solar** — `module_ref`, DC size kW, azimuth, tilt, array type
- **battery** — `product_ref`, usable kWh

Design choice: components reference library rows by id (`*_ref`) so the bulk of
data is entered once. Inline overrides exist for genuine one-offs.

The intake "form" can start as a **clean spreadsheet** (one tab per section) that
exports to this JSON — no web app needed to begin.

---

## 4. Starter generator

[`generate_ribd.py`](generate_ribd.py): `intake.json` + `reference.db` →
`project.ribd`. It validates referential integrity, **code-cycle consistency**
(won't put 2022 product data in a 2025 report), required fields, and—in
`--strict`—`verified=1`.

### ⚠ What needs a real `.ribd` to finish

The exact SDD XML element/attribute names are **placeholders** isolated in the
`TAGS` dict and `build_*` functions, each marked `>>>CONFIRM<<<`. Once you drop a
real CBECC-passing `.ribd` into `reference_files/`, reconciling the names is a
localized edit. Specifically still needed from a real file:

- Root element (is it `<SDDXML>` or `<Proj>` directly?) and ruleset filename string
- Whether climate zone / code cycle are **elements vs attributes**
- How constructions are referenced (CBECC likely wants a **named Construction
  object** referenced by walls/roofs, not raw cavity-R inline)
- Exact fenestration tags (`UFactor` vs `NFRCUfactor`, etc.)
- HVAC/DHW/PV/Battery object structure and required child fields
- Geometry model CBECC-Res expects (we emit a simplified **single thermal zone**;
  confirm whether your project types need per-zone geometry)

### Run it (once Python is installed — see below)

```powershell
python init_db.py                 # creates reference.db with placeholder data
python generate_ribd.py --intake sample_intake.json --out Doe.ribd
python generate_ribd.py --strict  # will fail until rows are marked verified=1
```

> **Python is not yet installed on this machine.** The Store-alias `python.exe`
> is a stub. Install Python 3.11+ from python.org (check "Add to PATH"). The
> scripts use **only the standard library** — no `pip install` needed.

---

## 5. Phased roadmap (honest)

Effort = build complexity. Risk = chance it stalls / needs rework.
Hours assume one developer. Savings assume ~20 reports/month.

| Phase | Goal | Effort | Risk | Dev hrs | Automatable now? |
|---|---|---|---|---|---|
| **0. Discovery & batch verification** | Install CBECC-Res 2025; run a known project in the GUI; locate the `.ribd` it writes; **confirm the engine exposes a real CLI/batch mode** and capture the exact invocation. | Low | **Med** | 8–16 | Verification, not automation |
| **1. Reference DB + XML round-trip** | Build SQLite DB (this schema); hand-enter your top ~20 windows / ~10 HVAC / common assemblies; generate a `.ribd` from sample intake and **confirm it loads + simulates in CBECC**. Locks the tag mapping. | Low | Low | 16–30 | ✅ Yes |
| **2. Intake + full generator + batch** | Structured intake (spreadsheet→JSON); generator fills all sections; invoke CBECC batch; collect CF1R PDF; add validation (cycle/refs/required). **This is where you hit <30 min/report for repeat types.** | Med | Med | 30–60 | ✅ Yes |
| **3. QA gate + library tooling** | Reviewer checklist UI/CLI; `verified` workflow; "intake vs generated model" diff; sign-off logged in `qa_reviews`. Required because output carries permit liability. | Med | Low | 20–40 | ✅ Yes |
| **4. Deterministic extraction (spreadsheets/cut sheets)** | Parse already-structured intake spreadsheets & manufacturer cut sheets → intake JSON. **Rule-based parsing, not AI.** High reliability. | Med | Med | 20–40 | ✅ Mostly |
| **5. AI-assisted plan-set extraction** | LLM/vision reads window schedules & areas from PDF **drawings** → *proposed* intake → **mandatory human QA**. Never straight-through. | High | **High** | 60–120+ | ⚠ Research-stage |

**Estimated labor savings:** repeat-type projects drop from ~3–4 hrs to ~20–40
min after Phases 2–3 (~2.5–3 hrs saved each). At 20/month that's **~50 hrs/month**.
Complex custom homes save less. Phase 5 doesn't add much *time* savings over a
good Phase 4 spreadsheet — its value is handling messy inputs, at high risk.

### Sequencing advice
Phases 0→3 deliver the bulk of the ROI at low/medium risk and are fully
automatable today. **Do those first and stop to evaluate** before investing in
Phase 5. The reference DB (Phase 1) alone improves consistency immediately.

---

## 6. The honest take on "PDF → AI extraction" (Phase 5)

This is the hard part, and it's where automation can quietly create liability.

**Why it's hard**
- Plan sets are **not standardized**. Window schedules live in tables, tags, or
  callouts that vary per firm, per sheet, per project.
- Vision/LLM models **hallucinate plausible-but-wrong numbers** — U-0.30 read as
  0.32, SHGC and U transposed, miscounted windows, misread areas, wrong orientation.
- Areas require **scale/units math** the model can get subtly wrong; revised
  sheets vs superseded sheets; mixed units.

**The dangerous failure mode** is *silent* error: a wrong SHGC still produces a
clean-looking CF1R that either fails plan check (rework) or **passes and ships a
non-compliant design** (liability).

**Mitigations baked into this architecture**
- Extraction only ever **proposes** an intake; it never writes a final doc.
- Every extracted value must **map to a known, verified reference-DB row** or it
  is flagged — the library is the vocabulary, so free-text hallucinations get caught.
- **Confidence scores**; low-confidence fields force human review.
- **Mandatory QA sign-off** (`qa_reviews`) before generation; `--strict` blocks
  unverified data.
- Never auto-submit to a permit portal.

Start Phase 4 (deterministic parsing of structured inputs) and treat Phase 5 as a
**human accelerator**, not a replacement.

---

## Files

| File | Purpose |
|---|---|
| `schema.sql` | Reference DB schema (SQLite) |
| `init_db.py` | Create + seed `reference.db` |
| `intake_schema.json` | Intake form contract (JSON Schema) |
| `sample_intake.json` | Worked example intake |
| `generate_ribd.py` | Intake + DB → `.ribd` (starter, tag names flagged) |
| `reference_files/` | **Drop a real CBECC-passing `.ribd` here** to finish the mapping |
