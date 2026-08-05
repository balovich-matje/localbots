# crafted — easy / effort: medium

DATA: wago DB2 CSVs only: existing ItemSparse (already cached/parsed) + one new small table CraftingData (2786 rows). Item.csv (already cached) for class/subclass. No crafting-reagent tables needed. No Blizzard API, no Wowhead.

APPROACH: Add CraftingData to wagoData.js TABLES, then build a "crafted" loot source: ItemSparse rows where ExpansionID == current (11) AND the StatModifier_bonusStat slots contain BOTH placeholder codes 24 and 25 (the two user-selectable secondary slots) AND the id is a CraftingData.CraftedItemID. Reuse the existing shapeItem()/usableSlots() machinery unchanged (quality>=3 filter already excludes the uncommon PvP set; the 71-74 primary-combo codes are already handled; 24/25 are ignored as non-primaries). In droptimizer.js buildDroptimizerInput add an `else if (source.kind === 'crafted')` branch that, for each usable item and each chosen unordered stat pair, emits one profileset: `profileset."Name crit/vers"=<placement>=,id=<id>,ilevel=<season.crafted.maxIlvl=285>,crafted_stats=32/40,crafting_quality=5`. Stat codes map crit=32, haste=36, vers=40, mastery=49 (verified by simming buffed_stats). Default to max quality (crafting_quality=5, ilevel=285); let the user pick the stat pair(s) like Raidbots. Front-end gets a crafted-source panel reusing the existing enchant/gem multiselect pattern.

EVIDENCE: Tables/columns: ItemSparse (cached) cols StatModifier_bonusStat_0..5 (idx 36-41), ExpansionID(7), ItemLevel(85), AllowableClass(86), InventoryType(102), OverallQualityID(103). CraftingData (fetched via same https://wago.tools/db2/CraftingData/csv pattern) cols ID, CraftedItemID(4). Sample: user's warrior off-hand id=237846 "Blood Knight's Warblade" is exp=11, stat slots [4,7,24,25,...] and appears in CraftingData row 2737 (CraftedItemID=237846) — confirms exp=11=current craftable + codes 24/25=selectable secondary slots. Enumeration: 171 exp=11 items carry BOTH codes 24&25; 154 of those are in CraftingData (profession-crafted); 106 survive quality>=3 (excludes 48 uncommon "Thalassian Competitor's" PvP pieces). Per-type coverage (q>=3): cloth 18, plate 17, mail 16, leather 16, misc/back-ring-neck 6, shields 3, ~24 weapons — full slot coverage. Stat-code proof (simc /opt/homebrew/bin/simc, item_db_source=local, iterations=1, item id=237846): crafted_stats=32/36 -> buffed crit + haste rise; 40/49 -> versatility + mastery rise; so 32=Crit, 36=Haste, 40=Vers, 49=Mastery. Order-independence proven: 32/40 vs 40/32 give identical unbuffed gear stats crit=12.66%(81 rating)/vers=8.68%(81 rating) (the differing first number is a 1-iteration buffed-snapshot artifact) -> unordered pair, C(4,2)=6 combos, both slots equal budget. crafting_quality alone does NOT set item level (q1 vs q5 without ilevel left weapon power at 179 and crit ~6.25->6.74%); ilevel=285 must be supplied explicitly (season.json crafted.maxIlvl=285 already exists). Only placeholder codes present on crafted items are 24 and 25 (no tertiary placeholders) -> pool is exactly the 4 secondaries. CraftingQuality table: QualityTier 1..5 = IDs 1,2,3,7,8; max=5.

RISKS: 1) ExpansionID==11 is a brittle "current" signal that must be bumped each expansion (mirror the existing CURRENT_SEASON_TIER=505 pattern with a season config constant). 2) A single crafted.maxIlvl=285 is assumed for every crafted item; 3 of 106 have a lower base ilvl (183 vs 197) and may cap below 285 at q5 — minor accuracy risk, but consistent with the existing equipped-crafted-upgrade path which already assumes 285. 3) Same-slot crafted items with identical ilvl+stats are DPS-identical (e.g. every plate helm), so simming all named items produces redundant equal rows — dedupe by (slot, stat-pair). 4) Combinatorics: simming all 6 pairs across all usable items is ~90-180 profilesets/spec (fine for the existing profileset runner, comparable to droptimizer), but default to user-picked pairs to keep it lean. 5) The craftable PvP "Thalassian Competitor's" set is in CraftingData; the existing quality>=3 gate in shapeItem() already drops it (base q2).

OPEN: Whether to expose all 6 stat pairs per item (best-stat discovery) or a single user-chosen pair (Raidbots parity) — recommend user-picks-pair with an optional "sim all 6" toggle. Whether to include the craftable PvP set (currently auto-excluded by q>=3). Whether per-item max-craft ilvl should be derived from CraftingData.ItemBonusTreeID later instead of the flat 285.

---FULL REPORT---
## Can Localbots add a crafted-gear source? Yes — cleanly, DB2-only.

The data path is clean and reuses ~90% of the existing droptimizer plumbing. No Blizzard API, no Wowhead — just the already-cached ItemSparse plus one new tiny table (CraftingData).

### 1) Enumerating current crafted gear + stat options (wago tables)

The selectable-stat mechanism is visible directly in **ItemSparse**: crafted "pick-your-stat" gear carries the placeholder stat codes **24 and 25** in its `StatModifier_bonusStat_*` slots (one per selectable secondary). Real proof — the user's off-hand `id=237846` "Blood Knight's Warblade" has stat slots `[4(str),7(stam),24,25,-1,-1]` and `ExpansionID=11`.

Filter recipe (all from cached data + one fetch):
- **ItemSparse**: `ExpansionID == 11` (current/Midnight) AND slots contain BOTH `24` and `25` -> **171** items.
- Intersect with **CraftingData** (`https://wago.tools/db2/CraftingData/csv`, col `CraftedItemID`) to keep only true profession-crafted -> **154**. (237846 is CraftingData row 2737.)
- The existing `shapeItem()` `quality >= 3` gate drops the 48 uncommon "Thalassian Competitor's" PvP pieces -> **106** PvE crafted items with selectable stats. Full slot/armor coverage: cloth 18, plate 17, mail 16, leather 16, back/ring/neck 6, shields 3, ~24 weapons.

Only placeholder codes present are 24 and 25 (no tertiary placeholders), so the stat pool is **exactly the 4 secondaries**. The reagent tables (ModifiedCraftingReagentSlot/Item, ModifiedCraftingItem) are **not needed** — they don't drive the sim.

### 2) simc representation (verified by simming)

Format (from the user's export and confirmed): `<slot>=,id=<id>,ilevel=285,crafted_stats=<A>/<B>,crafting_quality=5`.

Stat codes, proven by reading buffed_stats on `id=237846` (`/opt/homebrew/bin/simc <file> item_db_source=local iterations=1`):
- **32 = Critical Strike, 36 = Haste, 40 = Versatility, 49 = Mastery** (`crafted_stats=32/36` raised crit+haste; `40/49` raised vers+mastery).
- **Pair is unordered**: `32/40` and `40/32` give identical unbuffed gear stats `crit=12.66%(81 rating) / vers=8.68%(81 rating)`; both selectable slots get equal budget. (An apparent difference in the buffed snapshot was 1-iteration RNG noise.) -> `C(4,2)=6` combos per item.
- **`ilevel=` is mandatory**: `crafting_quality` alone did NOT raise item level (q1 vs q5 with no ilevel left weapon power at 179). Must supply `ilevel=285` (= existing `season.crafted.maxIlvl`). `crafting_quality` 1..5 (max 5, per CraftingQuality.QualityTier).

### 3) Combinatorics + pragmatic scope

Per spec, usable crafted items ≈ one armor type (~16-17 pieces) + back/rings/neck (~6) + usable weapons (~10) ≈ 30, but stat-identical same-slot duplicates collapse to ~13-15 distinct slots. Pragmatic v1:
- Only current-expansion craftable gear the spec can use (reuse `usableSlots()` — it already handles the 71-74 primary-combo codes and ignores 24/25).
- Default **max quality** (`crafting_quality=5`, `ilevel=285`).
- User picks the stat pair(s) like Raidbots; sim each `(item, pair)` as one profileset. ~13-40 profilesets typical; an optional "sim all 6 pairs" is still only ~90-180 (well within the existing runner's range).
- Dedupe by `(slot, stat-pair)` to avoid identical-DPS rows.

### 4) Slot-in points (files/functions)

- **server/wagoData.js**: add `CraftingData: ['ID','CraftedItemID']` to `TABLES` (line ~28). In `buildLootDb()` add a crafted-pool step emitting a source `{ kind: 'crafted', ... }` (filter above; reuse `shapeItem()`). In `shapeItem()` set a `crafted`/`selectableStats` flag when `stats` contains 24 && 25, and strip 24/25 from the stored `stats` so the primary logic stays clean. Add a `CURRENT_CRAFT_EXPANSION = 11` constant (mirrors `CURRENT_SEASON_TIER`).
- **server/droptimizer.js**: `buildSourceTree()` — add `tree.crafted`. `buildDroptimizerInput()` — add `else if (source.kind === 'crafted')`: for each usable item × selected stat pair, emit `profileset."<name> <A>/<B>"=<placement>=,id=<id>,ilevel=${season.crafted.maxIlvl},crafted_stats=<A>/<B>,crafting_quality=5`. Mirrors the existing `addItem()` but swaps the ilvl-only payload for the crafted payload.
- **server/lootFilter.js** `usableSlots()`: no change needed (verified logic passes crafted items correctly).
- **server/profileBuilder.js**: add a small `{32:'crit',36:'haste',40:'vers',49:'mastery'}` label map for profileset names. Alternatively this could ride Top Gear (`buildTopGearInput` — gearParser already flags `crafted`), but droptimizer's "sim a whole source" model is the more natural home.
- **data/season.json**: `crafted.maxIlvl` (285) already exists.
- **public/app.js**: new "Crafted gear" source panel with per-item stat-pair pickers, reusing the existing consumable/enchant multiselect pattern; `upgradeOptionsFor()` already understands crafted items.