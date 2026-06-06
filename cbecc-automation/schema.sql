-- ======================================================================
-- CBECC-Res Title 24 Automation — Reference Database Schema (SQLite)
-- ----------------------------------------------------------------------
-- Design principle: "enter once, reuse." Every product/assembly row is
-- tagged with the code cycle it was validated against (code_cycle_id) so
-- the generator can REFUSE to build a report from outdated-code data.
--
-- Nuance worth knowing: a window's U-factor is a physical product property
-- and does not itself change between code cycles. We still tag every row
-- with a code cycle to record "which library was reviewed/approved for use
-- under which standard," and to let you retire rows when a cycle sunsets.
-- The genuinely code-cycle-DEPENDENT data lives in the *_requirements
-- tables at the bottom (prescriptive limits), which you grow over time.
--
-- Every product/assembly row carries verified / verified_by / verified_on
-- for a per-row human-QA audit trail (output carries permit liability).
-- ======================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- lookups
CREATE TABLE IF NOT EXISTS code_cycles (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,      -- '2019' | '2022' | '2025'
    title          TEXT NOT NULL,
    effective_on   TEXT NOT NULL,             -- ISO date the code took effect
    superseded_on  TEXT,                      -- ISO date it stopped being valid (NULL = current)
    cbecc_ruleset  TEXT,                      -- ruleset label CBECC uses, e.g. 'CA Res 2025'
    notes          TEXT
);

CREATE TABLE IF NOT EXISTS climate_zones (
    cz                  INTEGER PRIMARY KEY,  -- California CZ 1..16
    representative_city TEXT,
    notes               TEXT
);

-- ------------------------------------------------------------ fenestration
CREATE TABLE IF NOT EXISTS window_products (
    id            INTEGER PRIMARY KEY,
    manufacturer  TEXT NOT NULL,
    series        TEXT NOT NULL,
    frame_type    TEXT,                       -- vinyl | aluminum | fiberglass | wood
    glazing       TEXT,                       -- 'dual LowE2' | 'triple' | ...
    operable      INTEGER NOT NULL DEFAULT 1, -- 1 operable, 0 fixed
    u_factor      REAL NOT NULL,              -- NFRC, Btu/h-ft2-F
    shgc          REAL NOT NULL,              -- NFRC, 0..1
    vt            REAL,                        -- visible transmittance
    nfrc_cpd      TEXT,                        -- NFRC CPD / certification number
    source        TEXT NOT NULL DEFAULT 'NFRC',
    code_cycle_id INTEGER NOT NULL REFERENCES code_cycles(id),
    verified      INTEGER NOT NULL DEFAULT 0, -- 1 = a human QA-confirmed this row
    verified_by   TEXT,
    verified_on   TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    notes         TEXT,
    UNIQUE(manufacturer, series, u_factor, shgc, code_cycle_id)
);

CREATE TABLE IF NOT EXISTS door_products (
    id            INTEGER PRIMARY KEY,
    manufacturer  TEXT NOT NULL,
    model         TEXT NOT NULL,
    door_type     TEXT,                       -- opaque | glazed | sliding
    u_factor      REAL NOT NULL,
    shgc          REAL,                        -- glazed doors only
    nfrc_cpd      TEXT,
    code_cycle_id INTEGER NOT NULL REFERENCES code_cycles(id),
    verified      INTEGER NOT NULL DEFAULT 0,
    verified_by   TEXT,
    verified_on   TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    notes         TEXT
);

-- -------------------------------------------------------- opaque assemblies
CREATE TABLE IF NOT EXISTS wall_assemblies (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,            -- 'R-21 2x6 16oc + R-5 ci'
    framing         TEXT,                     -- '2x6 @ 16 in OC'
    cavity_r        REAL,
    cont_insul_r    REAL,                     -- continuous (exterior) insulation
    assembly_u      REAL,                     -- overall U-factor, if computed
    assembly_kind   TEXT NOT NULL DEFAULT 'wood_framed',
    cbecc_cons_name TEXT,                     -- name of a matching CBECC construction, if reused
    code_cycle_id   INTEGER NOT NULL REFERENCES code_cycles(id),
    verified        INTEGER NOT NULL DEFAULT 0,
    verified_by     TEXT,
    verified_on     TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS roof_assemblies (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    framing         TEXT,
    cavity_r        REAL,
    deck_insul_r    REAL,                     -- above-deck / rigid
    radiant_barrier INTEGER NOT NULL DEFAULT 0,
    cool_roof       INTEGER NOT NULL DEFAULT 0,
    aged_sri        REAL,                     -- solar reflectance index, if cool roof
    assembly_u      REAL,
    code_cycle_id   INTEGER NOT NULL REFERENCES code_cycles(id),
    verified        INTEGER NOT NULL DEFAULT 0,
    verified_by     TEXT,
    verified_on     TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS floor_assemblies (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    floor_kind    TEXT NOT NULL DEFAULT 'over_crawlspace', -- over_crawlspace | over_garage | slab_on_grade
    cavity_r      REAL,
    slab_edge_r   REAL,                       -- slab-on-grade edge insulation
    assembly_u    REAL,
    code_cycle_id INTEGER NOT NULL REFERENCES code_cycles(id),
    verified      INTEGER NOT NULL DEFAULT 0,
    verified_by   TEXT,
    verified_on   TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    notes         TEXT
);

-- ----------------------------------------------------------------- systems
CREATE TABLE IF NOT EXISTS hvac_equipment (
    id               INTEGER PRIMARY KEY,
    equipment_type   TEXT NOT NULL,           -- furnace | split_ac | ducted_heat_pump | packaged_heat_pump
    manufacturer     TEXT NOT NULL,
    model            TEXT NOT NULL,
    ahri_ref         TEXT,                     -- AHRI certified reference number
    cooling_cap_btuh REAL,
    seer2            REAL,
    eer2             REAL,
    heating_cap_btuh REAL,
    hspf2            REAL,                      -- heat pumps
    afue             REAL,                      -- gas furnaces
    code_cycle_id    INTEGER NOT NULL REFERENCES code_cycles(id),
    verified         INTEGER NOT NULL DEFAULT 0,
    verified_by      TEXT,
    verified_on      TEXT,
    active           INTEGER NOT NULL DEFAULT 1,
    notes            TEXT
);

-- Ductless mini-splits kept separate because their HERS verifications and
-- multi-zone head configuration differ from ducted systems.
CREATE TABLE IF NOT EXISTS minisplit_systems (
    id               INTEGER PRIMARY KEY,
    manufacturer     TEXT NOT NULL,
    outdoor_model    TEXT NOT NULL,
    ahri_ref         TEXT,
    configuration    TEXT,                     -- single_zone | multi_zone
    num_heads        INTEGER,
    cooling_cap_btuh REAL,
    heating_cap_btuh REAL,
    seer2            REAL,
    eer2             REAL,
    hspf2            REAL,
    code_cycle_id    INTEGER NOT NULL REFERENCES code_cycles(id),
    verified         INTEGER NOT NULL DEFAULT 0,
    verified_by      TEXT,
    verified_on      TEXT,
    active           INTEGER NOT NULL DEFAULT 1,
    notes            TEXT
);

CREATE TABLE IF NOT EXISTS water_heaters (
    id                INTEGER PRIMARY KEY,
    wh_type           TEXT NOT NULL,          -- storage_gas | tankless_gas | hpwh | electric_storage
    manufacturer      TEXT NOT NULL,
    model             TEXT NOT NULL,
    ahri_ref          TEXT,
    tank_gal          REAL,
    uef               REAL,                    -- Uniform Energy Factor
    nominal_cap_btuh  REAL,
    first_hour_rating REAL,
    code_cycle_id     INTEGER NOT NULL REFERENCES code_cycles(id),
    verified          INTEGER NOT NULL DEFAULT 0,
    verified_by       TEXT,
    verified_on       TEXT,
    active            INTEGER NOT NULL DEFAULT 1,
    notes             TEXT
);

-- Solar: the MODULE is a library item; array size/azimuth/tilt are per-project
-- and live in the intake form, not here.
CREATE TABLE IF NOT EXISTS pv_modules (
    id             INTEGER PRIMARY KEY,
    manufacturer   TEXT NOT NULL,
    model          TEXT NOT NULL,
    stc_watt       REAL,                       -- nameplate watts at STC
    efficiency_pct REAL,
    code_cycle_id  INTEGER NOT NULL REFERENCES code_cycles(id),
    verified       INTEGER NOT NULL DEFAULT 0,
    verified_by    TEXT,
    verified_on    TEXT,
    active         INTEGER NOT NULL DEFAULT 1,
    notes          TEXT
);

CREATE TABLE IF NOT EXISTS battery_systems (
    id                   INTEGER PRIMARY KEY,
    manufacturer         TEXT NOT NULL,
    model                TEXT NOT NULL,
    usable_kwh           REAL,
    rated_kw             REAL,
    round_trip_eff_pct   REAL,
    control_strategy     TEXT,                 -- basic | advanced_dr (JA12)
    code_cycle_id        INTEGER NOT NULL REFERENCES code_cycles(id),
    verified             INTEGER NOT NULL DEFAULT 0,
    verified_by          TEXT,
    verified_on          TEXT,
    active               INTEGER NOT NULL DEFAULT 1,
    notes                TEXT
);

-- --------------------------------------------- code-cycle-dependent limits
-- These tables hold the values that ACTUALLY change per code cycle. Seed
-- them as you encounter them; the generator/QA can use them to sanity-check
-- a project against the prescriptive baseline for its climate zone + cycle.
CREATE TABLE IF NOT EXISTS prescriptive_requirements (
    id            INTEGER PRIMARY KEY,
    code_cycle_id INTEGER NOT NULL REFERENCES code_cycles(id),
    cz            INTEGER NOT NULL REFERENCES climate_zones(cz),
    component     TEXT NOT NULL,              -- 'window_u' | 'window_shgc' | 'wall_r' | 'roof_r' | ...
    metric        TEXT NOT NULL,              -- 'max' | 'min'
    value         REAL NOT NULL,
    units         TEXT,
    citation      TEXT,                       -- e.g. 'Table 150.1-A'
    notes         TEXT,
    UNIQUE(code_cycle_id, cz, component, metric)
);

-- ----------------------------------------------------- operational / workflow
-- Minimal tables so the human-QA gate is real, not just a slide.
CREATE TABLE IF NOT EXISTS projects (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    address        TEXT,
    cz             INTEGER REFERENCES climate_zones(cz),
    code_cycle_id  INTEGER REFERENCES code_cycles(id),
    intake_path    TEXT,                       -- path to the intake JSON used
    status         TEXT NOT NULL DEFAULT 'draft', -- draft | qa_pending | qa_approved | generated | submitted
    created_on     TEXT NOT NULL DEFAULT (date('now')),
    notes          TEXT
);

CREATE TABLE IF NOT EXISTS qa_reviews (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    reviewer    TEXT NOT NULL,
    decision    TEXT NOT NULL,                -- approved | rejected | changes_requested
    reviewed_on TEXT NOT NULL DEFAULT (date('now')),
    comments    TEXT
);

-- helpful indexes
CREATE INDEX IF NOT EXISTS idx_win_cycle  ON window_products(code_cycle_id, active);
CREATE INDEX IF NOT EXISTS idx_hvac_cycle ON hvac_equipment(code_cycle_id, active);
CREATE INDEX IF NOT EXISTS idx_wh_cycle   ON water_heaters(code_cycle_id, active);
