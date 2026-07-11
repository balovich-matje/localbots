# Localbots

**Your hardware, your sims.** A locally-hosted alternative to Raidbots that wraps your own
[SimulationCraft](https://github.com/simulationcraft/simc) install in a friendly web page.

Paste your character straight from the game, hit **Sim it**, get DPS with a full damage
breakdown — no queue, no premium tier, no API keys. Runs entirely on your machine from
public data.

## Status / Roadmap

- ✅ **Phase 1 — Quick Sim**: paste `/simc` export → DPS + ability breakdown + buff uptimes,
  with fight style, training dummies, raid buff and consumable toggles, live progress, cancel.
- ✅ **Phase 2 — Top Gear**: compare the gear in your bags (and this week's vault choices)
  against what you're wearing — one combined run, ranked by DPS gain.
- ✅ **Phase 3 — Droptimizer**: sim every item that can drop for you this season — raid
  (per difficulty), all M+ dungeons (per key level, end-of-dungeon or vault), world
  bosses and outdoor events — in ONE run, ranked by DPS gain with per-source filters.
  This is the feature Raidbots gates behind premium.

## Requirements

1. **Node.js 18+** — [nodejs.org](https://nodejs.org) (any current version works)
2. **SimulationCraft CLI (`simc`)** — see per-OS install below
3. The **Simulationcraft addon** in game — install "Simulationcraft" from CurseForge/Wago,
   then type `/simc` in chat and copy the text with Ctrl+C (Cmd+C on Mac)

### Installing simc

Localbots finds `simc` on your PATH automatically. If it lives somewhere else, set the
`SIMC_PATH` environment variable to the full path of the executable.

**Windows**

1. Download the latest nightly from [downloads.simulationcraft.org](http://downloads.simulationcraft.org/?C=M;O=D)
   (grab the `simc-*-win64.7z` matching the current game version)
2. Extract it somewhere permanent, e.g. `C:\Program Files\SimulationCraft`
3. Either add that folder to your PATH, or set `SIMC_PATH` to `C:\...\simc.exe`

**macOS (Apple Silicon or Intel)** — build from source, it takes ~5 minutes:

```bash
xcode-select --install          # once, if you don't have the compiler yet
brew install cmake ninja        # build tools
git clone --depth 1 --branch midnight https://github.com/simulationcraft/simc.git ~/tools/simc-src
cd ~/tools/simc-src
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF
ninja -C build simc
ln -sf ~/tools/simc-src/build/simc /opt/homebrew/bin/simc   # Intel Macs: /usr/local/bin
simc display_build=1            # should print the version
```

**Linux** — same as macOS, using your distro's packages:

```bash
sudo apt install git cmake ninja-build g++ libcurl4-openssl-dev   # Debian/Ubuntu
git clone --depth 1 --branch midnight https://github.com/simulationcraft/simc.git ~/tools/simc-src
cd ~/tools/simc-src
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF
ninja -C build simc
sudo ln -sf ~/tools/simc-src/build/simc /usr/local/bin/simc
```

> The branch name changes each expansion (`midnight` today). When a new expansion hits,
> re-clone with the new branch name and rebuild — same commands.

## Running Localbots

```bash
git clone https://github.com/balovich-matje/localbots.git
cd localbots
npm install
npm start
```

Open **http://localhost:4747**, paste your `/simc` export, hit **Sim it**.

## Options explained

| UI option | What it does (simc setting) |
|---|---|
| Fight style | `fight_style=` Patchwerk (stand-still boss), DungeonSlice (M+ style pulls), HecticAddCleave (adds spawning constantly) |
| Training dummy | Patchwerk with a fixed fight length and no length variance — pure "stand and pump" |
| Enemies | `desired_targets=` 1–10 targets (Patchwerk/dummy) |
| Fight length | `max_time=` in seconds |
| Precision | `target_error=` — Fast 0.5% / Normal 0.2% / High 0.1% / Extreme 0.05% (≈ Raidbots Smart Sim), or a fixed iteration count |
| Raid buffs | starts from `optimal_raid=1` (everything on, like Raidbots), unticking a buff adds `override.<buff>=0` |
| Consumables | flask / food / potion / augment rune / weapon oil. On = current-season defaults for your spec (from simc's own profiles), Off = `disabled` |

## Top Gear (compare gear you own)

The `/simc` addon export lists your bag gear and weekly vault choices at the bottom
(as comment lines) — paste the WHOLE export, switch to the **Top Gear** tab, and every
comparable item shows up with a checkbox. Hit **Compare gear** and each ticked item is
simmed in place of your equipped one (rings and trinkets are tried in both slots
automatically; only the better placement is shown). The result is a table ranked by
DPS gain versus your current gear, with vault choices labeled separately — handy for
picking your weekly reward.

Under the hood this uses simc's *profilesets*: one baseline sim plus a cheap delta sim
per item, all in a single run.

**Simming upgrades:** every item row has an item-level dropdown — sim the item as-is, at
any upgrade step of the current season's tracks (e.g. a fresh 272 Myth-track piece at its
6/6 cap of 289), at Voidcore levels (weapons/trinkets only: 295 crafted / 298 Myth), or
at a custom item level you type in. Upgraded items show as "272 → 289" in the results.
Track/voidcore numbers live in [data/season.json](data/season.json) and are updated by
hand once per season.

## Droptimizer (sim everything that can drop)

Paste your export, open the **Droptimizer** tab, pick your sources, hit
**Run droptimizer**:

- **Raids** — per difficulty (LFR/Normal/Heroic/Mythic); later bosses drop higher item
  levels automatically.
- **Mythic+** — every dungeon in the season pool at your chosen key level, as
  end-of-dungeon or Great Vault item level.
- **World bosses & outdoor events** — with editable item levels.
- **Include everything** does what it says. A full scan is a few hundred items; on an
  M-series Mac it takes well under a minute on Fast precision.

Results are one ranked table of DPS gain per item, labeled with source and boss, with
per-source filter chips and text search.

### Where the data comes from

Loot tables come from [wago.tools](https://wago.tools) DB2 exports — clean CSVs of the
live game client's own database (the same data Wowhead renders). The first use needs a
one-time download (~60 MB, "Refresh data" button); it's cached in `data/cache/` and only
re-downloaded when you ask (game data changes with patches). No Blizzard API key, no
scraping.

On first use Localbots also runs a one-time probe (~30 s) to learn which items your simc
build can actually simulate — game data ships loot for unreleased content (next season's
raid and dungeons), and those show up grayed out as "not in your simc build yet" until
Blizzard releases them and you update simc.

### Known limitations

- **Delves**: delve loot pools exist only server-side — no client database lists them.
  Add items to `data/delve-loot.json` (by id or exact name) and hit Refresh data to
  enable the Delves source.
- **Tier set pieces**: raid bosses drop class tokens, which aren't mapped to your set
  pieces yet.
- **Legacy dungeons** (returning ones like Skyreach) may list a few old item variants
  that no longer drop — they sim fine, just ignore rows you know aren't obtainable.
- Item levels use simc's `ilevel=` override rather than full per-difficulty bonus IDs —
  accurate for stats, approximate for items whose effects scale oddly.

## Sanity-checking against Raidbots

Localbots uses the same SimulationCraft engine as Raidbots, so the same character with the
same settings should produce DPS within the margin of error (a fraction of a percent).
On Raidbots pick Patchwerk, 300s fight, and leave buffs/consumables at their defaults —
that matches Localbots' defaults.

## For maintainers: new season checklist

- Consumable defaults come from `data/consumables.json`, generated from simc's bundled
  season profiles: `node scripts/generate-consumables.mjs ~/tools/simc-src/profiles/<SEASON>`

## License

MIT
