# Next up

Updated 2026-08-19. Jobs 1 and 2 are done; job 3 is the one that is left, and
it needs one answer before it can be built.

---

## 1. Per-item drop item levels — **done**

Raid drops now carry their own item level instead of one curated number per
difficulty. `server/dropLevels.js` reads it from three game tables:

```
DungeonEncounter.ItemSequenceLevel   how far into the instance the boss sits
ItemBonusTreeNode                    ItemContext (= difficulty) -> track group
ItemBonusListGroupEntry              (group, step) -> the track bonus id
```

Sequence levels count from 0 and a group's steps start at 1, so a drop sits at
**ItemSequenceLevel + 1**. The item level itself comes from that bonus id via
Raidbots' bonus map, which the cache already holds.

The Venomous Abyss now reads, on heroic: 308 / 311 / 311 / 315 / 315 / 315 /
318 / 318 across its eight bosses. Caustic Keeper-Crusher, off the second
boss, gives 285 / 298 / 311 / 324 — the four levels its adventure guide entry
shows.

The droptimizer lists every boss's levels under each raid ("Drop levels per
boss"), so they can be checked against the game without reading any code.

**Worth a spot-check.** Two readings from the old session do not fit: Maze-roa
off The Coiled Altar was reported at 315 heroic where this gives 318, and
Aqirbane Reliquary off Ula'tek at 308 where this gives 318. Both are final-boss
items, and a final boss cannot drop below the second boss's 311, so those
readings are probably of an obtained copy rather than the guide. Confirming
one of them either way settles it — and if the whole raid is one step high,
it is a single `+ 1` in `dropLevels.js`.

Left alone on purpose: M+, delves and world bosses still use the curated
tables in `season.json`. Dungeon bosses all carry sequence level 0, so there
is no per-boss variation there to recover, and the M+ key-level tables were
already confirmed against Raidbots.

`season.raidDifficulties` survives as the fallback for the three raid items
that have no bonus tree at all, and for caches downloaded before these tables
were added.

---

## 2. Sockets and gems — **done**

Every suggested item now inherits the slot's gems, the same way it already
inherited the slot's enchant.

The socket question turned out to have a simpler answer than expected. Only
one item in the entire raid (Aqirbane Reliquary) is born with a socket; every
other socket in the game is added by the player, per slot, and shows up as a
socket bonus id on the item. So a replacement in a slot gets exactly what the
current piece has: the same socket bonus ids, filled with the same gems.

- A gem is duplicated to fill a spare socket.
- **Except a diamond** — Eversong Diamonds are unique-equipped, so the spare
  socket is left empty rather than inventing a gem that cannot be worn.
- Socket count = the item's own sockets + the carried socket bonuses. That
  gives Aqirbane Reliquary 2 and the Twin Fangs amulet 1, which is what the
  game shows — the two mismatches recorded here before.

Checked against simc's own stat report: bare, Aqirbane reads 1309 crit; with
the carried socket bonus and two gems, 1341. Note that simc applies as many
gems as the line lists and does not cap them, so the count has to be right.

---

## 3. Bonus rolls section — **open, needs one answer**

New Raidbots feature worth matching: show where a bonus roll token is best
spent, across every raid boss and M+ dungeon at once, ranked by expected gain.

Raidbots models it as one pseudo-instance holding the raid's eight bosses
(each with its own sequence level, as above) plus the eight M+ dungeons.

**The blocker is the reward item level, and it should not be guessed** — that
is what went wrong twice with the raid levels. Two readings of the numbers
captured from the Raidbots UI both fit:

| source | captured |
|---|---|
| Raid — LFR / Normal / Heroic / Mythic | 292 / 305 / 318 / 334 |
| M+ — M0 / +2-3 / +4-5 / +6 / +7-9 / +10 | 302 / 305 / 308 / 311 / 315 / 318 |

- The first three raid numbers are exactly what the **last** bosses drop
  (292 / 305 / 318). If a bonus roll simply gives that boss's own loot at that
  boss's own level, those are the picker's maximums and the section is
  per-boss, using the levels job 1 already computes. But mythic breaks the
  pattern: 334 is Myth 6/6, three above the 331 the last bosses drop.
- Or the reward is a flat level per difficulty, in which case those four
  numbers are it and the ranking is per boss only through which items each
  boss can give.

**What would settle it:** a screenshot of the Raidbots bonus-roll section with
a raid difficulty picked — if each boss shows its own item level, it is the
first reading; if every boss shows the same number, it is the second.

The M+ column matches `season.json`'s existing **vault** table exactly, which
independently confirms that half.

Once the level is known the rest is small: it is the existing droptimizer
machinery pointed at one item level per source, ranked per boss rather than
per item — a boss is worth what its best possible drop is worth.

---

## Smaller things still open

- **Set bonuses show every spec's.** A tier set has one bonus row per spec and
  the tooltip has no spec context, so a Blood death knight sees Frost and
  Unholy bonuses too. Passing the character's spec through `/api/items` fixes
  it.
- **3 of 6 set bonuses render** on the death knight set. The rest use stack
  tokens (`$u`), named variables (`$<rolemult>`) and a player-level scaling
  system that is not modelled. They are dropped rather than approximated —
  keep it that way; an earlier pass printed "deals 0 Shadow damage" against
  the game's 30,002.
- **53% of loot items with effects render.** Same causes.
- **Tertiary stats** (avoidance / speed / leech) are not shown. They are
  random per drop, so this is deliberate.
- **Delve pool** was re-verified before season 2 opened on 2026-08-18. Worth
  one look at the vendor's stock now that it has.
