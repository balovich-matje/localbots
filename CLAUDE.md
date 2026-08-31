# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Localbots is a locally-hosted alternative to Raidbots: a Node/Express server that wraps a
local SimulationCraft (`simc`) install with a plain HTML/JS/CSS frontend (no build step,
no framework). It sims a pasted WoW `/simc` export (or an Armory lookup) to produce DPS,
gear-upgrade ("Top Gear"), and full droptimizer reports.

## Commands

```bash
npm install     # install deps (just express)
npm start        # runs server/index.js, serves on http://localhost:4747
```

There is no build step, linter, or test suite configured — `public/` is served as static
files as-is and `server/` runs directly under Node's native ESM (`"type": "module"`).
Verify changes by running `npm start` and exercising the feature in a browser.

`simc` must be resolvable (on PATH, or via `SIMC_PATH` env var) or the server refuses to
start (`server/index.js` calls `findSimc()` at boot). See README for installing simc
from source (needed for droptimizer accuracy/probing to work against a current build).

`scripts/generate-consumables.mjs <simc-profiles-dir>` regenerates
`data/season.json`'s consumable defaults from simc's own shipped profiles — run once per
new season (see "For maintainers: patch-day checklist" in README).

## Architecture

**No framework, no bundler.** Backend is a single Express app (`server/index.js`, ~850
lines) that wires together a set of focused modules under `server/`; frontend is one
`public/app.js` (~2000 lines) doing DOM manipulation directly against `public/index.html`,
talking to the backend over plain JSON `fetch` + Server-Sent Events for live sim progress.

**The sim pipeline** (the core flow all three features — Quick Sim, Top Gear,
Droptimizer — funnel through):
1. `gearParser.js` parses a pasted `/simc` addon export into structured gear/character data.
2. `profileBuilder.js` (Quick Sim / Top Gear) or `droptimizer.js` (full droptimizer) turns
   that + user-chosen options into a simc input file, optionally as simc *profilesets* (one
   baseline + many cheap delta variants in a single simc process) for comparison modes.
3. `simRunner.js`'s `SimQueue` runs `simc` as a child process — **one sim at a time,
   server-wide**, queueing everyone else and reporting queue position — and streams
   progress back to the browser as SSE (`/api/sim/:id/events`).
4. Output is parsed back into a report and optionally persisted via `history.js`
   (`data/history/`) and rendered as a single self-contained HTML file by `report.js`
   ("Save report").

**Game data lives outside simc**, in `data/`:
- `data/season.json` — hand-maintained per season: upgrade tracks, crafted/Voidcore item
  levels, `upgradeSeasonId`. Read by `droptimizer.js`/`enhancements.js`.
- `data/patches.json` — the Live/PTR patch list; each patch has its own cached game-data
  set and season config.
- `data/cache/` — downloaded [wago.tools](https://wago.tools) DB2 CSVs (loot tables, item
  stats/effects, set bonuses), fetched/parsed by `wagoData.js`, `itemStats.js`,
  `itemEffects.js`. This is what "Refresh data" re-downloads; it's keyed per patch build
  so a simc rebuild invalidates and re-fetches it.
- `data/delve-loot.json` — delve loot pool, hand-maintained (no client DB lists it).

**Supporting modules**: `armory.js`/`blizzard.js` (character lookup, live Blizzard API or
keyless raider.io fallback), `itemIcons.js` (icon resolution), `talents.js`/`talentData.js`
(loadout parsing/decoding for the talent-build comparison feature), `setBonus.js`
(item-set / Minimum-Set-Bonus logic), `equippedResolver.js` (resolving "what's currently
equipped" for delta comparisons), `lootFilter.js`/`dropLevels.js` (which items are
obtainable by class/spec and at what item level per source), `simcProbe.js` (probes which
items the local simc build can actually simulate, since game data ships unreleased
content), `simcUpdater.js` (one-click simc rebuild for from-source installs), `status.js`
(the header's "behind GitHub" / "behind live game" indicator lights).

**Multiplayer note**: when shared (e.g. via Docker), the sim queue and `data/history/`
are shared across all users hitting the same server; each user's in-progress character
paste/settings live only in their own browser (not persisted server-side per-user).

## Docs worth reading before large changes

- `README.md` — full user-facing feature docs, options reference, and the "For
  maintainers: patch-day checklist" (what must be updated by hand each WoW patch).
- `docs/ROADMAP.md` — planned droptimizer source additions and what was decided against.
- `docs/TODO.md` — open work items with more detail than the roadmap.
- `DOCKER.md` — server-deployment specifics (shared history, shutdown-button gating via
  `LOCALBOTS_ALLOW_SHUTDOWN`, patch-day rebuilds).
