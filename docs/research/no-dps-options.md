# Which enchants and Folio runes actually move DPS

Measured in simc at `target_error=0.05` (±30 DPS on a ~120k baseline) against a
no-enchant / no-rune baseline, on `MID1_Rogue_Outlaw`. A result counts as real
only if the gain clears 3× the combined error of the two means.

Everything marked below carries `"dps": false` in `data/season.json` (and the
12.1 file) and is filtered out of the pickers and the sims — simming them only
produced noise rows that looked like real differences.

## Enchants with no DPS effect

| Enchant | Slot | What it actually grants | Measured |
|---|---|---|---|
| Empowered Hex of Leeching | head | Leech (tertiary) | −17 |
| Empowered Blessing of Speed | head | Speed (tertiary) | −32 |
| Empowered Rune of Avoidance | head | Avoidance (tertiary) | +10 |
| Lynx's Dexterity | feet | Avoidance + Stamina | −10 |
| Shaladrassil's Roots | feet | Leech + Stamina | −31 |
| Farstrider's Hunt | feet | Speed + Stamina | −1 |
| Worldsoul Cradle | weapon | barrier on **healing** spells (healer only) | −29 |
| Worldsoul Aegis | weapon | barrier when damaged (defensive) | −31 |

**Every head and feet enchant this season is tertiary-stat only**, so those two
categories are empty for damage specs — that is correct, not a missing list.

## Enchants that are primary-stat specific

Chest enchants each grant one primary stat, so only the matching spec benefits.
They now carry a `stat` filter (`str` / `agi` / `int` / `all`), like leg
enchants already did. On the Outlaw test character, Mark of Nalorakk (Strength,
+1) and Mark of the Magister (Intellect, −26) did nothing at all, while Mark of
the Rootwarden (Agility) gave +1802 and Mark of the Worldsoul (all primaries)
+2261. Without the filter, an Agility spec was being shown two dead options.

## Omnium Folio

The Folio is a **Core Rune** system: row 1 picks the Core Rune, and rows 2-5
only do anything *when the Core Rune activates*. Measuring a rune on its own
therefore reads zero for every row past the first — the correct measurement is
Core Rune alone vs Core Rune + the rune.

| Row | Runes | Verdict |
|---|---|---|
| 1 | Void-Touched Orbs, Unleashed Fire | the Core Rune itself — DPS |
| 2 | Self-Mending (heal), Void-Tainted Shell (absorb), Lynxlike Reflexes (Speed on taking damage) | **entire row is defensive — hidden** |
| 3 | Lingering | +257 |
| 4 | Critical Power +1710, Versatile Warrior +1620, Burning Haste +1359, Masterful Cunning +948 | DPS |
| 5 | Overload +373; Residual Energy and Echoes measured ~0 | kept — both are *conditional* on other runes (Residual Energy boosts Lingering), so a zero here is a limitation of the isolated test, not proof they do nothing |

Row 2 is the one the user spotted: it is entirely healing/absorb/movement and
can never change DPS, so the whole row is skipped.

## Re-checking this next season

Re-run `scratchpad/classify.mjs` and `classify-folio.mjs` (kept out of the repo)
or simply repeat the recipe: build one simc file with a stripped baseline plus
one profileset per option, run at `target_error=0.05`, and treat anything under
3σ as no effect. Descriptions come from `simc spell_query=spell.id=<id>`.
