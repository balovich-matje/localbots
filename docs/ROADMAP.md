# Roadmap: full source parity with Raidbots' droptimizer

Where we stand (✅) and how we'll add the rest, in the order that pays off most.
Reference: Raidbots' source picker offers — Season Raids, March on Quel'Danas,
Sporefall, The Dreamrift, The Voidspire, World Bosses, Mythic+ Dungeons, Normal
Dungeons, Delves, Prey, PvP (Conquest / Bloody Tokens / Honor), Catalyst,
Epic/Rare/PvP Profession Items, plus "Show Previous Tiers" and per-source
Voidforged tiers.

## Already covered

- ✅ All five season raids with per-difficulty pickers and per-boss item levels
- ✅ World bosses, outdoor events
- ✅ Mythic+ (full season pool, key level, end-of-dungeon vs vault)
- ✅ Delves (Champion/Hero tracks; pool vendor-verified via Zah'ran)
- ✅ Upgrade-track picker incl. Voidforged (Hero 285 / Myth 298)

## Planned sources

### 1. Catalyst (tier sets) — biggest win, do first
Raid bosses drop class tokens and the catalyst converts eligible slot pieces
into tier set items; Raidbots shows these as "CAT" entries.
**How:** identify each class's current tier set via the ItemSet DB2 table on
wago.tools (or by name family — e.g. Warrior "Night Ender's"). For every
selected drop in a catalyst-eligible slot (head/shoulder/chest/hands/legs...),
add a second profileset: the matching set piece at the same item level.
simc picks up 2pc/4pc bonuses automatically based on what's equipped.
This also implicitly fixes the "raid tokens missing" gap.
**Effort:** medium. **Data:** already-cached tables + one new DB2 (ItemSet).

### 2. Normal / Heroic / M0 dungeons — trivial
The journal data for all Midnight dungeons (including the four not in the M+
rotation) is already cached. Add a "Dungeons (non-keystone)" group at the
fixed Adventurer/Veteran/Champion item levels per difficulty (season config).
Low value this season (as noted — nobody sims normal-dungeon gear mid-season)
but exactly what's wanted at the start of a patch.
**Effort:** small.

### 3. Prey Season 1 — needs one anchor
Midnight's hunt content. Its reward pool is (like delves) not in the journal,
but it's almost certainly a coherent datamined item family, and there may be a
vendor page like Zah'ran's that lists it. **How:** get 2-3 item names the user
has seen from Prey rewards (or a Wowhead vendor/npc page), extract the family
from ItemSparse into `data/prey-loot.json`, reuse the whole delve pipeline
(curated file → source with track pickers).
**Effort:** small once anchors are known.

### 4. PvP gear (Conquest / Honor / Bloody Tokens)
PvP sets are clean name families in the item table ("<Season> Gladiator's ..."
for conquest, aspirant/combatant equivalents for honor). Extract per family
into a curated file; sim at their PvE item levels from season config (note:
instanced-PvP scaling won't be modeled — sims reflect world/PvE value, same
as Raidbots).
**Effort:** small–medium.

### 5. Crafted gear (Epic/Rare profession items)
Crafted items are identifiable in the item tables (and simc's own profiles use
them). Two complications: crafted stats are player-chosen (crafted_stats
combos) and embellishments add effects. **Plan:** v1 sims each craftable slot
at max craft (285) with the spec's default stat pair (reuse the per-spec
defaults idea from consumables), Voidforged 295 for weapons/trinkets; sim all
stat combos as variants later; embellishments last.
**Effort:** the largest of the list.

### 6. Show previous tiers / multi-season
Turn `data/season.json` into per-season files with a season selector. Only
becomes meaningful once season 2 exists.
**Effort:** small, do when needed.

### 7. Extras
- Vault socket option (Raidbots' "Add Vault Socket"): append a gem to simmed
  items — small.
- Re-attach the UI to a running job after a page reload — small, QOL.
- Off-spec loot toggle (Raidbots' "Include Off-Spec Items") — small: relax the
  primary-stat filter.
