# inventory — mixed / effort: large

DATA: Everything below is buildable from the two sources Localbots already uses: (1) the pasted /simc addon export, and (2) wago.tools DB2 CSVs fetched with the existing `downloadTables()` pattern in server/wagoData.js — `https://wago.tools/db2/${table}/csv`. Tier-set/catalyst data comes from the ItemSet table, which is ALREADY in the cache (data/cache/ItemSet.csv, listed in the TABLES map). Trinket/talent/stat-weight features need no new data at all — they are pure simc option strings run against the local build (12.0.7.68887, confirmed via `simc display_build=1`). The one genuine INFEASIBLE item (armory/account import) needs the Blizzard API.

APPROACH: Build in value/effort order. (1) Stat Weights as a new sim mode — cheapest high-value win: add `calculate_scale_factors=1` to buildInput and surface player.scale_factors in extractResult; ~1 day. (2) Talent-loadout comparison — reuse the exact profileset+sets pattern from enhancements.js (buildFolioVariants is the template): one profileset per pasted talents= string, ranked in the Top Gear table; ~1 day. (3) Catalyst/tier-set pieces in Droptimizer — the single biggest gear-source gap; ItemSet.csv is already cached and parsed, so for each selected drop in a catalyst-eligible slot add a second profileset pointing at the class's matching set-piece id at the same ilvl (simc applies 2pc/4pc automatically). (4) Small droptimizer sources that reuse existing pipelines: off-spec toggle (one filter flag), vault socket (append a gem to each profileset line), non-keystone dungeons (journal data already cached), previous-season selector (split season.json per season). (5) Trinket customization dropdowns — map the 11 midnight.* options to per-trinket UI controls, emitted as global option lines. (6) Gear Compare and Combos as free-form multi-profileset modes. (7) PvP and Prey via the curated-file pattern already used for delves (data/delve-loot.json → data/pvp-loot.json / prey-loot.json). (8) Crafted gear + embellishments last (largest: player-chosen crafted_stats combinatorics). Leave armory import out entirely (no API key).

EVIDENCE: Verified by running the local simc build (/opt/homebrew/bin/simc, 1205-01 for 12.0.7.68887):
- Stat weights: `simc MID1_Warrior_Fury.simc item_db_source=local calculate_scale_factors=1` → JSON contained player.scale_factors = {Str:40.30, AP:28.80, Crit:24.19, Haste:20.35, Mastery:17.64, Vers:16.03, ...}. Options confirmed present in engine: calculate_scale_factors, normalize_scale_factors, scale_only, scale_lag, center_scale_delta.
- Talent comparison: appended `profileset."Alt talents"=talents=<string>` → json.sim.profilesets.results had the row (mean 114711). Localbots' extractTopGear already reads json.sim.profilesets.results, so the plumbing exists.
- Trinket customization: simc registers 11 `midnight.*` item options in engine/player/player.cpp:13617+, e.g. midnight.crucible_of_erratic_energies_violence / _sustenance / _predation (bool), midnight.arcanoweave_trappings_uptime, midnight.darkmoon_hunt_race, midnight.vessel_of_tortured_souls_miss_chance. Localbots emits none of them.
- Tier sets/catalyst: cached data/cache/ItemSet.csv already holds current-tier sets, e.g. setId 1990 "Rage of the Night Ender" → ItemID 249955 "Night Ender's Breastplate", OverallQualityID=4, AllowableClass=1 (warrior-only). loadItemSetMap() in wagoData.js already parses this table for the Minimum-Set-Bonus feature.
- Fight styles: simc supports Patchwerk, CastingPatchwerk, HecticAddCleave, CleaveAdd, HelterSkelter, LightMovement, HeavyMovement, Ultraxion, DungeonSlice, DungeonRoute (engine/util/util.cpp fight_style_string). Localbots exposes only Patchwerk, DungeonSlice, HecticAddCleave, plus a "Dummy" pseudo-style (public/index.html lines 40-45; FIGHT_STYLES set in server/profileBuilder.js:12).
- Off-spec: server/lootFilter.js usableSlots() line ~99 rejects any item whose primary stat != the spec's primary; relaxing that flag is the whole feature.
- Code confirmed ABSENT (grep over server/ + public/): no "talent" handling (except omnium_talents), no scale_factor/stat-weight, no gear-compare/combos/advanced. server/simRunner.js extractResult() never reads scale_factors even though simc emits it.

RISKS: Stat-weights and combos multiply sim time (each stat = a delta sub-sim; combos are combinatorial) — must default to Fast precision and show a variant-count preview like the existing updateCompareCounts(). Catalyst needs a per-class current-tier set map curated once per season (name family or ItemSet ids), and the ilvl of a catalyzed token must be inferred from its source slot. Crafted gear's crafted_stats stat-pair explosion and embellishment effects are the reason Raidbots itself treats them as advanced — v1 should sim only the spec's default stat pair. Trinket options change every patch (they live in simc's expansion module, not DB2), so that list needs maintenance. Off-spec/vault-socket are genuinely trivial.

OPEN: Which specific fight styles does the user actually want beyond the current four (HelterSkelter and CastingPatchwerk are the common Raidbots extras)? For catalyst, confirm the exact current-tier ItemSet id per class (the "Night Ender" family is warrior S1; the other 12 classes need their set ids pinned). Prey Season 1 rewards are not in the journal DB2 (same as delves) and need 2-3 real item-name anchors before the curated-file approach can work. Does the user want Stat Weights as its own tab or folded into Quick Sim (Raidbots does both)?

---FULL REPORT---
# Localbots vs Raidbots — complete SimulationCraft feature gap list

Ground truth: Localbots ships **three** sim modes — Quick Sim, Top Gear, Droptimizer (public/index.html tab-bar lines 26-30) — plus rich Top-Gear extras (item swaps, item-set Minimum-Bonus protection, track upgrades, consumable/enchant/gem/diamond/Omnium-Folio comparisons) and a full Droptimizer (raids per difficulty, M+ per key/vault, world bosses, outdoor, delves, upgrade tracks + Voidcores). Data comes only from the /simc paste and wago.tools DB2 CSVs. Everything below is a Raidbots SimulationCraft feature that Localbots does **not** yet have.

Verified against the live local build (simc 1205-01, WoW 12.0.7.68887).

---

## A. Missing top-level sim modes

### A1. Stat Weights (scale factors) — HIGH VALUE, SMALL effort ✅ feasible
- **What Raidbots does:** ranks each secondary/primary stat by DPS-per-point ("Crit 1.00, Haste 0.92…"), optionally normalized to a chosen stat.
- **Constraint fit:** fully within constraints — pure simc option, no new data.
- **Evidence:** ran `calculate_scale_factors=1` on the Fury profile → `player.scale_factors = {Str:40.30, AP:28.80, Crit:24.19, Haste:20.35, Mastery:17.64, Vers:16.03}`. Engine also exposes `normalize_scale_factors`, `scale_only`, `scale_lag`, `center_scale_delta`.
- **Gap in code:** no reference anywhere in server/ or public/. `extractResult()` (server/simRunner.js:297) does not read `scale_factors`.
- **Effort:** small — add the option in `buildInput()` (server/profileBuilder.js:71), read `player.scale_factors` in extractResult, add a results table. Note it runs N sub-sims per stat, so gate behind Fast precision.

### A2. Talent-loadout comparison — HIGH VALUE, SMALL effort ✅ feasible
- **What Raidbots does:** paste 2+ talent strings (or loadouts), compare DPS; also offered as an add-on inside Top Gear/Droptimizer.
- **Constraint fit:** within constraints.
- **Evidence:** appended `profileset."Alt talents"=talents=<string>` → appeared in `json.sim.profilesets.results` (mean 114711). This is the same profileset+`sets{}` mechanism Localbots already uses for Folio/gems.
- **Gap in code:** grep for "talent" finds only `omnium_talents`. No talent input field.
- **Effort:** small–medium — clone `buildFolioVariants()` (server/enhancements.js:251) to emit one profileset per pasted `talents=` line; reuse the Top-Gear ranking table.

### A3. Gear Compare — MEDIUM VALUE, MEDIUM effort ✅ feasible
- **What Raidbots does:** paste several complete gear sets and rank them head-to-head (not item-by-item — whole loadouts).
- **Localbots today:** Top Gear only swaps **one** bag item at a time vs equipped; there is no whole-set-vs-whole-set mode.
- **Constraint fit:** within constraints — each set becomes one full-override profileset.
- **Effort:** medium — new UI for N pasted gear blocks; emit each as a profileset overriding all 16 slots; reuse extractTopGear ranking.

### A4. Combos — MEDIUM VALUE, MEDIUM–LARGE effort ✅ feasible
- **What Raidbots does:** sim the cartesian product of chosen variables (gear × talents × trinkets…) to find the best combination.
- **Localbots today:** none; each comparison group is independent, best-per-group only.
- **Effort:** medium–large — combinatorial profileset generation + a variant-count guard (extend `updateCompareCounts()`, public/app.js:100). Runtime risk is the main concern.

### A5. Advanced / Single Sim (raw simc passthrough, reforge/scale plots) — MEDIUM VALUE, MEDIUM effort ✅ feasible
- **What Raidbots does:** an Advanced tab accepting raw simc options/APL and producing reforge plots, scale-factor plots, multi-target scaling curves.
- **Localbots today:** `sanitizeProfile()` (server/profileBuilder.js:64) strips `fight_style/iterations/target_error/max_time/desired_targets/threads/optimal_raid…`; there is no escape hatch to pass arbitrary options like `reforge_plot_*` or `dps_plot_*`.
- **Effort:** medium — an opt-in "advanced options" textarea appended after the profile, plus plot-output parsing.

### A6. Armory / Battle.net account import — ❌ INFEASIBLE (hard constraint)
- **What Raidbots does:** import a character straight from the armory / logged-in account.
- **Why blocked:** requires the Blizzard API; the user has no key. Localbots deliberately requires the in-game `/simc` paste instead. **List as permanently out of scope**, not a bug.

---

## B. Missing cross-mode options

### B1. Trinket customization / buff-mode variants — MEDIUM VALUE, MEDIUM effort ✅ feasible
- **What Raidbots does:** per-trinket dropdowns (e.g. "Crucible of Erratic Energies" Violence/Sustenance/Predation mode; stance/stack/uptime pickers).
- **Constraint fit:** within constraints — global simc option strings, no new data.
- **Evidence:** engine/player/player.cpp:13617+ registers **11** `midnight.*` item options: `midnight.crucible_of_erratic_energies_violence` / `_sustenance` / `_predation`, `midnight.arcanoweave_trappings_uptime` (+interval/stddev), `midnight.darkmoon_hunt_race`, `midnight.refueling_orb_heal_chance`, `midnight.sealed_chaos_urn_dispell` (+_time), `midnight.vessel_of_tortured_souls_miss_chance`.
- **Gap in code:** Localbots emits none of these.
- **Effort:** medium — detect equipped trinket ids, show the matching option control, emit the option line. Needs per-patch maintenance (these live in the simc module, not DB2).

### B2. More fight styles — LOW VALUE, SMALL effort ✅ feasible
- **What Raidbots offers:** Patchwerk, CastingPatchwerk, HelterSkelter, LightMovement, HeavyMovement, Ultraxion, HecticAddCleave, DungeonSlice…
- **Localbots today:** Patchwerk, DungeonSlice, HecticAddCleave + a "Dummy" pseudo-style (public/index.html:40-45; `FIGHT_STYLES` server/profileBuilder.js:12).
- **Evidence:** simc build supports CastingPatchwerk, CleaveAdd, HelterSkelter, LightMovement, HeavyMovement, Ultraxion, DungeonRoute in addition (engine/util/util.cpp fight_style_string).
- **Effort:** small — add options to the select and the `FIGHT_STYLES` allowlist.

---

## C. Missing Droptimizer / Top-Gear gear sources

Most of these are already in docs/ROADMAP.md Phase 4 (noted per item). All fit the constraints — the loot pipeline already runs entirely on cached wago.tools DB2 + curated JSON.

### C1. Tier sets / Catalyst — HIGH VALUE, MEDIUM effort ✅ feasible (roadmap #1)
- **What Raidbots does:** shows "CAT" entries — raid tokens/any-slot pieces converted to the class tier set; simc applies 2pc/4pc automatically.
- **Evidence:** the **ItemSet table is already downloaded and parsed** (TABLES map in wagoData.js:30; `loadItemSetMap()` at :295 already used for Minimum Set Bonus). Current-tier sets are present, e.g. setId 1990 "Rage of the Night Ender" → ItemID 249955 "Night Ender's Breastplate", quality 4, AllowableClass=1 (warrior). Raid class **tokens** are currently dropped by `shapeItem()` (wagoData.js:274, keeps only classId 2/4), so this also fixes the "tokens missing" gap.
- **Effort:** medium — for each selected drop in a catalyst-eligible slot, add a second profileset with the class's matching set-piece id at the same ilvl. Needs a per-class current-tier set-id map curated once per season.

### C2. Off-spec loot toggle — LOW/MED VALUE, SMALL effort ✅ feasible (roadmap #7)
- **What Raidbots does:** "Include Off-Spec Items" relaxes the primary-stat filter.
- **Gap in code:** `usableSlots()` (server/lootFilter.js:~99) hard-rejects items whose primary stat ≠ spec primary.
- **Effort:** small — thread a boolean through to skip that one check.

### C3. Vault socket option — LOW VALUE, SMALL effort ✅ feasible (roadmap #7)
- **What Raidbots does:** "Add Vault Socket" appends a prismatic socket+gem to each simmed item.
- **Effort:** small — append `,gem_id=<stat gem>` to each droptimizer/topgear profileset line.

### C4. Normal / Heroic / M0 (non-keystone) dungeons — LOW VALUE (this season), SMALL effort ✅ feasible (roadmap #2)
- Journal data for all Midnight dungeons is already cached; add a fixed-ilvl group per difficulty. Valuable at patch start.

### C5. Previous-tier / multi-season selector — LOW VALUE now, SMALL effort ✅ feasible (roadmap #6)
- **What Raidbots does:** "Show Previous Tiers".
- **Gap:** data/season.json is single-season. Split into per-season files + a selector. Only meaningful once Season 2 exists.

### C6. PvP gear (Conquest / Honor / Bloody Tokens) — MED VALUE, SMALL–MED effort ✅ feasible (roadmap #4)
- Clean name families in ItemSparse ("<Season> Gladiator's…"). Extract to a curated file (reuse the delve pipeline), sim at PvE ilvls. Instanced-PvP scaling won't be modeled — same limitation Raidbots has.

### C7. Prey Season 1 rewards — MED VALUE, SMALL effort once anchored ✅ feasible (roadmap #3)
- Not in the journal DB2 (like delves). Needs 2-3 real item-name anchors, then reuse the curated-file → source pipeline (data/delve-loot.json is the template).

### C8. Crafted gear (Epic/Rare profession items) — MED VALUE, LARGE effort ✅ feasible (roadmap #5)
- Identifiable in item tables. Complications: player-chosen `crafted_stats` combos (combinatorial) and per-slot max craft ilvl. v1: sim each craftable slot at max craft (285), Voidforged 295 for weapons/trinkets, default spec stat pair.

### C9. Embellishments — MED VALUE, LARGE effort ✅ feasible (part of roadmap #5)
- Crafted-gear effects. Largest single item — needs the embellishment→effect mapping and stacking rules. Do last.

---

## D. Explicitly-skipped Raidbots limiters (roadmap acknowledges)

### D1. Catalyst Charges limiter — LOW VALUE, SMALL–MED effort ✅ feasible
Raidbots caps how many catalyst conversions the ranking assumes. Only meaningful after C1 exists.

### D2. Item Upgrade Currency budget — LOW VALUE, MED effort ✅ feasible
Raidbots limits upgrades to an affordable Valorstone/crest budget. Localbots' upgrade pickers (dropt-upgrade / track-upgrades) are unconstrained. Niche; ROADMAP deliberately deferred both.

---

## Summary table (value/effort ordered)

| Feature | Mode | Constraint fit | Effort | Roadmap? |
|---|---|---|---|---|
| A1 Stat Weights | new | ✅ | S | no |
| A2 Talent comparison | Top Gear add-on | ✅ | S–M | no |
| C1 Tier set / Catalyst | Droptimizer | ✅ (ItemSet cached) | M | #1 |
| C2 Off-spec toggle | Dropt/TopGear | ✅ | S | #7 |
| C3 Vault socket | Dropt/TopGear | ✅ | S | #7 |
| B2 More fight styles | all | ✅ | S | no |
| C4 Non-keystone dungeons | Droptimizer | ✅ | S | #2 |
| C5 Previous seasons | Droptimizer | ✅ | S | #6 |
| B1 Trinket customization | all | ✅ | M | no |
| A3 Gear Compare | new | ✅ | M | no |
| C6 PvP gear | Droptimizer | ✅ | S–M | #4 |
| C7 Prey rewards | Droptimizer | ✅ (needs anchors) | S | #3 |
| A5 Advanced/raw + plots | new | ✅ | M | no |
| A4 Combos | new | ✅ | M–L | no |
| D1 Catalyst charges | Dropt/TopGear | ✅ | S–M | skipped |
| D2 Upgrade currency budget | Dropt/TopGear | ✅ | M | skipped |
| C8 Crafted gear | Droptimizer | ✅ | L | #5 |
| C9 Embellishments | Droptimizer | ✅ | L | #5 |
| A6 Armory import | new | ❌ INFEASIBLE (no Blizzard API) | — | no |

**Net:** every Raidbots SimulationCraft feature except **armory/account import** is achievable under the hard constraints. The four not already on the roadmap and worth adding first are **Stat Weights, Talent comparison, Trinket customization, and Gear Compare** — none need new data beyond what's cached, and three of the four are small.