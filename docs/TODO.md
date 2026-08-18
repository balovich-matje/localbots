# Next up

Written 2026-08-19, mid-flight. Three jobs, in the order they should be done —
the first unlocks the second, and the third is independent.

Everything here is about the **Droptimizer's accuracy**, not new surface area.

---

## 1. Per-item drop item levels

**The problem.** `data/season.json` carries one item level per raid difficulty.
The game does not work that way: the level is a property of the *individual
item*, so two bosses in the same raid on the same difficulty drop different
levels — LFR items exist at both 282 and 289.

**Where it stands.** `raidDifficulties` is currently `285 / 298 / 311 / 324`,
read off the adventure guide for Caustic Keeper-Crusher, which sits at the 3/6
step of each difficulty's track. That is a reasonable centre but wrong for any
item that is not 3/6. Do **not** try to improve it by reading a piece someone is
wearing — crest upgrades raise an item above what dropped, which is exactly how
an earlier pass concluded "heroic is flat 308" from a Hero 2/6 tooltip.

**The real fix** is to read each item's own bonus tree, which is what the
adventure guide itself does.

### What is already known

The chain, all from tables we can get:

```
ItemXBonusTree      ItemID -> ItemBonusTreeID
ItemBonusTreeNode   ParentItemBonusTreeID -> ChildItemBonusTreeID
                                          -> ChildItemBonusListID
                                          -> ChildItemLevelSelectorID
                                          -> ChildItemBonusListGroupID
                    each row keyed by ItemContext
ItemLevelSelector   ID -> MinItemLevel
```

Bonus list contents come from simc's `engine/dbc/generated/item_bonus.inc`,
which parses as `{ id, bonus_id, type, value_1..value_4, index }` — 10,086
lists. The type codes are in simc's `data_enums.hh`:

| type | meaning |
|---|---|
| 1 | ILEVEL (a delta) |
| 6 | **SOCKET** |
| 14, 42 | SET_ILEVEL (absolute) |
| 4 | description tag ("Heroic", "Mythic") |

`ItemContext` values seen on a raid item: **3, 4, 5, 6, 11, 14**. The 3/4/5/6
group carries the difficulty *labels*, so mapping context to difficulty should
fall out of the type-4 entries.

### The blocker

Walking Caustic Keeper-Crusher (item 268198, tree 5996) reaches **56 bonus
lists** — labels, sockets, stat mods — and **not one type 14/42 entry**.
`ChildItemLevelSelectorID` is 0 on every node reached. So the level arrives by
a path the parent→child tree walk does not cover.

### What to try next

1. `ChildItemBonusListGroupID` — a column on `ItemBonusTreeNode` that the walk
   currently ignores. Likely `ItemBonusListGroup` / `ItemBonusListGroupEntry`
   hold the per-difficulty levels.
2. `IblGroupPointsModSetID`, same row, if the group tables come up empty.
3. Cross-check against simc: it resolves these correctly, so
   `engine/dbc/item_database.cpp` bonus-id handling shows the intended order.

### How to know it works

| item | expected |
|---|---|
| Caustic Keeper-Crusher (268198) | LFR 285 · Normal 298 · Heroic 311 · Mythic 324 |
| Maze-roa, Warlord's Fury (268213) | Heroic 311 |

When this lands, `raidDifficulties` stops being curated at all, and the same
lookup gives M+ and delve levels for free.

---

## 2. Sockets, so gems can be carried over

**The goal.** Enchants are now carried onto every suggested item. Gems are not,
and should be: copy the equipped slot's gem into the new item, duplicated to
fill however many sockets it has. **Skip diamonds** — they are unique-equipped,
so duplicating one would invent a gem the character cannot wear.

**Why it is blocked.** Placing gems needs the *new* item's socket count, and
sockets come from two places:

| item | declared on the item (`ItemSparse.SocketType_*`) | actually seen in game |
|---|---|---|
| Aqirbane Reliquary (268265) | 1 | **2** |
| Amulet of the Twin Fangs (268251) | 0 | **1** |

So intrinsic sockets are only part of it; the rest are granted by the drop's
bonus list (type 6 above) — the same lookup job 1 is blocked on. A first attempt
that took the maximum socket bonus anywhere in the tree returned "1 socket" for
a two-hand axe and a chest, because the tree also contains sockets an item
*might* get rather than ones it always has. Guaranteed and optional have to be
told apart, per context.

**Interim option**, if job 1 drags: carry gems only where
`ItemSparse.SocketType_*` declares a socket. That fixes Aqirbane Reliquary,
never invents a gem, and still undercounts the Twin Fangs. Strictly better than
carrying none. Ask before shipping it — it is a partial.

---

## 3. Bonus rolls section

New Raidbots feature worth matching: show where a bonus roll token is best
spent, across every raid boss and M+ dungeon at once, ranked by expected gain.

**Reward levels** (from Raidbots' own UI, 12.1 season 2):

| source | item level |
|---|---|
| Raid — LFR / Normal / Heroic / Mythic | 292 / 305 / 318 / 334 |
| M+ — M0 / +2-3 / +4-5 / +6 / +7-9 / +10 | 302 / 305 / 308 / 311 / 315 / 318 |

The M+ column matches `season.json`'s existing **vault** table exactly, which
independently confirms those numbers. The raid column sits about 7 above the
drop levels, so bonus rolls reward at vault tier rather than drop tier.

Shape: this is the existing droptimizer machinery pointed at one item level per
source, then ranked per boss rather than per item — a boss is worth what its
best possible drop is worth.

---

## Smaller things still open

- **Set bonuses show every spec's.** A tier set has one bonus row per spec and
  the tooltip has no spec context, so a Blood death knight sees Frost and Unholy
  bonuses too. Passing the character's spec through `/api/items` fixes it.
- **3 of 6 set bonuses render** on the death knight set. The rest use stack
  tokens (`$u`), named variables (`$<rolemult>`) and a player-level scaling
  system that is not modelled. They are dropped rather than approximated —
  keep it that way; an earlier pass printed "deals 0 Shadow damage" against the
  game's 30,002.
- **53% of loot items with effects render.** Same causes.
- **Tertiary stats** (avoidance / speed / leech) are not shown. They are random
  per drop, so this is deliberate.
- **Delve pool** was re-verified before season 2 opened on 2026-08-18. Worth one
  look at the vendor's stock now that it has.
