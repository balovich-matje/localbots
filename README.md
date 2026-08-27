# Localbots

**Your hardware, your sims.** A locally-hosted alternative to Raidbots that wraps your own
[SimulationCraft](https://github.com/simulationcraft/simc) install in a friendly web page.

Paste your character straight from the game — or just look it up by name and realm — hit
**Sim it**, and get DPS with a full damage breakdown. No queue, no premium tier, no API
keys. Runs entirely on your machine from public data.

## Status / Roadmap

- ✅ **Phase 1 — Quick Sim**: paste `/simc` export → DPS + ability breakdown + buff uptimes,
  with fight style, training dummies, raid buff and consumable toggles, live progress, cancel.
- ✅ **Phase 2 — Top Gear**: compare the gear in your bags (and this week's vault choices)
  against what you're wearing — one combined run, ranked by DPS gain.
- ✅ **Phase 3 — Droptimizer**: sim every item that can drop for you this season — raid
  (per difficulty), all M+ dungeons (per key level, end-of-dungeon or vault), world
  bosses, outdoor events and delves — in ONE run, with upgrade-track and Voidcore
  options, ranked by DPS gain with per-source filters. This is the feature Raidbots
  gates behind premium.
- ✅ **Phase 3.5 — Beyond gear**: item sets with Minimum Set Bonus protection, plus
  consumables / enchants / gems / Omnium Folio comparisons in Top Gear.
- ✅ **Armory lookup**: find a character by name and realm instead of pasting an
  export. Keyless by default; optional Blizzard credentials make it a live read.
- ✅ **Item tooltips**: every item list shows the icon, and hovering gives the
  in-game tooltip — armour or weapon damage, primary, stamina and secondaries,
  plus Equip/Use effects and tier set bonuses. Values are computed the way the
  game computes them and checked against in-game tooltips.
- 🔨 **Droptimizer accuracy**: a suggested item is now simmed the way you would
  actually wear it. It inherits the slot's enchant (a missing death-knight
  runeforge was turning real upgrades into 14% losses) and the slot's gems, and
  raid drops carry their own item level read from the game's own tables, so the
  first and last bosses of a raid no longer look identical. Still open: a
  bonus-roll section — see **[docs/TODO.md](docs/TODO.md)**.
- ✅ **Keep my tier set bonus**: a droptimizer toggle for "what if I ran this
  through the Catalyst" — items landing in a tier slot keep the set bonus, so
  the row shows the item's own stat difference instead of a 4-set loss.
- ✅ **Shareable reports**: "Save report" in the footer writes any finished sim
  to one self-contained HTML file — opens in any browser, no install, and
  prints to PDF if you want one.
- ⬜ **Phase 4 — Full source parity with Raidbots**: catalyst/tier-set pieces, normal
  dungeons, Prey rewards, PvP gear, crafted gear, previous-season tiers, vault-socket
  option and off-spec loot. Detailed plan in [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

1. **Node.js 18+** — [nodejs.org](https://nodejs.org) (any current version works)
2. **SimulationCraft CLI (`simc`)** — see per-OS install below
3. The **Simulationcraft addon** in game — install "Simulationcraft" from CurseForge/Wago,
   then type `/simc` in chat and copy the text with Ctrl+C (Cmd+C on Mac).
   Optional: the **Armory** tab can look a character up by name instead, though the
   addon export is the exact one (see below).

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

Under **Character** you can switch to the **Armory** tab and look a character up by
region, realm and name instead of pasting anything.

Out of the box that reads a free public scan of the character (via raider.io), so no
API key is needed — the scan runs a little behind, and only carries the active talent
build. If you drop free Blizzard API credentials into a `.env` file (copy
[.env.example](.env.example)), the same tab reads the character **live from the real
Armory** instead: current gear, every saved talent build, and item icons that work even
for brand-new items. Localbots falls back to the keyless source by itself if the
credentials are missing or Blizzard is down.

Either way the Armory route cannot see your Omnium Folio or professions, since those
are not on the Armory at all — paste the `/simc` export when you want an exact picture.

To stop the server, use the **Shut down server** button at the bottom of the page.

**Sim history:** every sim that finishes is saved on your machine (in `data/history/`,
never uploaded anywhere). The **History** button in the header lists them all — click
one to bring its full results back, ✕ deletes it.

**Patch switch:** the header has a **Live / PTR** switch. The PTR patch sims against
the test-realm dataset your simc already carries (next patch's items, tuning and loot),
with its own game data and season numbers — handy for planning gear before a patch
drops. PTR numbers are provisional until release. Each patch keeps its own data cache
(first PTR use needs its own "Refresh data" download), and history entries are tagged
with the patch they ran on. Patches are defined in [data/patches.json](data/patches.json);
when a patch goes live, its entry just gets promoted there.

**Update lights:** the two dots in the header tell you whether your Localbots copy is
behind GitHub (fix: `git pull` in the localbots folder, then restart the server) and
whether your simc build still matches the live game version. Green = up to date,
orange = update needed, gray = couldn't check (usually no internet). Hover a light
for details.

When simc was built from source on this machine (the macOS/Linux recipe above), the
orange Simc light is **clickable** — one click pulls the latest simc and rebuilds it
right there, with progress in the chip; sims wait until it's done. Windows nightly
installs can't be rebuilt automatically — grab the newest nightly instead.

After that rebuild Localbots re-downloads the game tables by itself: a new simc means a
new game build, and the cached tables would otherwise be the wrong build and get
rejected, leaving the Droptimizer empty. You no longer need to press **Refresh data**
yourself after a simc update.

**macOS tip:** drop a double-clickable launcher in the repo folder (it's gitignored):

```bash
cat > "Start Localbots.command" <<'EOF'
#!/bin/zsh
cd "$(dirname "$0")"
if lsof -iTCP:4747 -sTCP:LISTEN >/dev/null 2>&1; then open "http://localhost:4747"; exit 0; fi
(sleep 2 && open "http://localhost:4747") &
npm start
EOF
chmod +x "Start Localbots.command"
```

## Running on a server (Docker)

One machine runs Localbots, everyone else just opens the page — no one else needs
Node, simc, or the repo. You don't install SimulationCraft yourself: the image
compiles it during the build.

```bash
git clone https://github.com/balovich-matje/localbots.git
cd localbots
docker compose up -d --build
```

Then open **http://your-server-address:4747** from any machine on the network.
The first build takes 15–45 minutes (nearly all of it compiling simc) and wants
4 GB of RAM to get through that compile; later rebuilds reuse the cached layers.
On first use hit **Refresh data** once to download the game data (~60 MB, kept in
a volume).

> **Setting this up for a group? See [DOCKER.md](DOCKER.md)** — the full server
> guide: requirements, patch-day rebuilds, backups, exposing it safely, and what
> to do when something fails.

**Updating.** Pull and rebuild. This updates Localbots, and rebuilds simc too
when SimulationCraft itself has moved on — the image checks the branch head, so
a patch-day simc gets picked up rather than the build silently reusing the simc
it was first built with:

```bash
git pull && docker compose up -d --build
```

If you ever need to force the whole thing from scratch, add `--no-cache` to a
`docker compose build`.

The in-page **Simc** light still tells you when a game patch has moved past your
build, but its one-click update is disabled in Docker (there are no build tools in
the runtime image) — rebuild instead.

**Sharing it with friends — things worth knowing:**

- Sims run **one at a time**; a second person's run queues and starts automatically,
  and the page shows its position.
- **History is shared** — everyone sees everyone's saved sims on that server.
- Each person's character, settings and pasted talent builds live in *their own
  browser*, so you don't overwrite each other.
- The **Shut down server** button is hidden, so nobody can stop everyone's sims
  from a browser tab. Set `LOCALBOTS_ALLOW_SHUTDOWN=1` in `docker-compose.yml` to
  put it back; to stop the server properly use `docker compose stop`.
- **There is no login.** Anyone who can reach the port can use it and read the
  shared history, so keep it on your LAN or a VPN rather than exposing it to the
  open internet.

Useful commands: `docker compose logs -f` (what the server is doing),
`docker compose restart`, `docker compose down` (stop; your data volumes survive).

## Options explained

| UI option | What it does (simc setting) |
|---|---|
| Fight style | `fight_style=` Patchwerk (stand-still boss), DungeonSlice (M+ style pulls), HecticAddCleave (adds spawning constantly) |
| Training dummy | boss pinned at 100% health (`enemy_fixed_health_percentage=100`) so there is no execute phase — pure rotational throughput, matching Raidbots' "Target Dummy" |
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

**Item sets:** detected automatically from your equipped and bagged gear, with
Raidbots-style "Minimum Set Bonus" pickers (0 / 2 / 4 set) — suggestions that would
break the bonus you chose to keep are hidden.

**Track upgrades:** an optional section that answers "what is upgrading each equipped
item actually worth?" — pick a target (2/6 … 6/6, optionally + Voidcores) and every
ticked equipped item sims at that level within its own track, one at a time, plus one
"all together" row. Item levels are decoded from your export by simc itself; the
upgrade track is inferred from the level (untick anything that looks off).

**Also compare:** optional groups that rank alongside gear in the same table, each
with a Raidbots-style picker (everything on by default, All/None buttons, live sim
count) so you can exclude options you'd never use:

- **Consumables** — every season flask, food, potion and weapon oil.
- **Enchants** — every season enchant per slot on your own items. Dual-wielders sim
  every main-hand × off-hand **combination**, and rings sim every pair — so "MH: X +
  OH: Y" mixes show up when they beat matching enchants.
- **Gems** — your setup with all stat gems swapped to each type (the Eversong
  Diamond keeps its own separate comparison and is never replaced by a stat gem),
  plus **empty sockets detected and filled**. Every gem and enchant row has an
  expandable **"N changes"** pill listing exactly which item changes what:
  *"Omission of Light (finger 1): Flawless Deadly Amethyst → Flawless Deadly Lapis"*.
- **Omnium Folio** — each rune alternative, one row at a time.
- **Talent builds** — every loadout you saved in game (the addon exports them
  automatically) shown as a **card with its class and spec trees drawn**, its hero
  tree named, and a checkbox to sim it against your active build. **Add a build**
  takes any talent string you paste (in-game export, Wowhead, Archon, a friend's
  build) and sims that too — pasted builds are remembered between sessions.
  Builds for the wrong specialization, or strings that don't decode, are flagged
  instead of silently failing mid-sim.

Your current choice is tagged "(current)", and when viewing one comparison group the
table splits into per-slot sections (Weapons, Rings, Flask, …). All options live in
[data/season.json](data/season.json).

**Only options that can actually change DPS are offered.** Every enchant and Folio
rune was measured in simc: ones that grant tertiary stats (leech, speed, avoidance)
or heal/absorb are hidden, because simming them produces noise that reads like a
real difference. This season that empties the head and feet enchant lists entirely,
and drops the Folio's defensive row. Enchants that grant a primary stat are only
shown to the specs that use it. The measurements are in
[docs/research/no-dps-options.md](docs/research/no-dps-options.md).

**Best setup:** results have two tabs — *Details* (the full ranked table) and
*Best setup*, which collapses the run into a shopping list: the winner of each
independent choice (each enchant slot, gems, flask, each Folio row, each gear slot),
what it replaces, and the estimated total gain. Gains within the run's margin of
error are labeled as such, and a category where you already use the best option is
simply left out.

**Simming upgrades:** every item row has an item-level dropdown — sim the item as-is, at
any upgrade step of the current season's tracks (e.g. a fresh 272 Myth-track piece at its
6/6 cap of 289), at Voidcore levels (weapons/trinkets only: 295 crafted / 298 Myth), or
at a custom item level you type in. Result rows read as a swap: *"Suggested Item
(your item's level → the suggestion's simmed level) → the item it replaces (slot)"*.
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
- **Delves** — the (unverified, datamined) bountiful gear pool at Champion or Hero track.
- **Crafted gear** — every profession craft your class can wear, simmed at max quality
  with the stat combinations you tick (crafted gear lets you pick two secondary stats).
  Same-slot crafts share stats, so one item stands in per slot. Off by default — tick
  the group to include it. Options: **Apply Voidcores** (crafted weapons/trinkets sim
  at the Voidcore level) and **Include embellished crafts** (designs with a built-in
  effect, which simc simulates).
- **Embellishments** — every craft-time embellishment simc can model, simmed on a
  concrete crafted piece and labeled as such: *"Item (Crit / Vers) — Arcanoweave
  Lining"*. Single rows sit in their slot's group next to the plain version of the
  same item; two-piece rows (*"same embellishment on two items — its value stacks"*
  and the Iris + Bandolier pairing) group under **Embellished pairs**. Rows respect
  the game's 2-embellished-items limit, counting what your character already wears.
  A few are deliberately excluded: effects simc doesn't implement yet, the on-use
  robot (a net DPS loss in practice), and healer/utility effects.
- **Results filters** — two chip rows: by source (raid, dungeon, crafted…) and by
  gear slot (weapons, rings, trinkets, feet…), combinable with the text search.
- **Include off-spec items** — also sims items whose primary stat isn't yours
  (armor type and weapon proficiency stay enforced). Weapons your spec *can* use are
  always included — e.g. Outlaw off-hand daggers sim out of the box.
- **Upgrade items to X/6** — sim every item upgraded within its own track, like
  Raidbots' "Upgrade up to": a Mythic raid drop at Myth 6/6, a delve Hero drop at
  Hero 6/6, and so on. Result rows read as a swap: *"Suggested Item (your item's
  level → the suggestion's simmed level) → the item it replaces (slot)"* — hover
  the item levels to see the drop's base level when it was simmed upgraded.
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

Match the **fight style** too: Localbots' Patchwerk = Raidbots' Patchwerk (the boss dies,
so melee get an execute phase), and Localbots' **Training dummy = Raidbots' Target Dummy**
(boss pinned at 100% health, no execute phase). Comparing a Localbots dummy run to a
Raidbots Patchwerk run — or vice versa — can differ by several percent on execute-heavy
specs (Fury Warrior, Arms, Assassination…) purely from that one setting, even with
identical gear.

## For maintainers: patch-day checklist

What a content patch needs, in order. Most of it is two clicks; the rest is one
config file.

1. **Update simc** — the orange **Simc** light in the header, or `git pull` +
   `ninja -C build simc`. Nothing else works until simc has the new game data.
2. **Refresh data** in the Droptimizer tab — re-downloads the game tables pinned
   to the build your simc speaks.
3. **Re-copy your character** — type `/simc` in game again. Talent trees change
   every patch, so an export from before it will be rejected (with an explanation).
4. **Update `data/season.json`** — the only hand-edited part:
   - *Upgrade tracks, crafted cap, Voidforged levels:* read them straight from
     `raidbots.com/static/data/live/bonuses.json` (each `upgrade` entry gives
     track name, step and item level). These are exact, not guesses.
   - *`upgradeSeasonId`:* the `upgrade.seasonId` those entries carry. It is what
     tells last season's gear apart from this season's — old gear keeps its item
     level but loses its track, and the levels overlap, so without this the app
     would offer upgrades the game will not sell.
   - *Raid / M+ / delve / world-boss drop levels:* these are not in any clean data
     source. Derive them from the track positions the previous season used, then
     confirm against in-game tooltips.
   - *M+ pool:* join `MythicPlusSeasonTrackedMap` (newest `DisplaySeasonID`) to
     `MapChallengeMode` for the dungeon names.
   - *Delve pool:* `data/delve-loot.json` needs re-verifying each season — delve
     loot is server-side and appears in no client table.
5. **Consumable defaults:** `node scripts/generate-consumables.mjs ~/tools/simc-src/profiles/<SEASON>`
   (e.g. `MID2`) once simc ships the new season's profiles.
6. **`data/patches.json`** — the first entry is the live patch. When a test realm
   opens for the *next* patch, add a second entry with `ptr: true` and its own
   season/consumables/delve files; simc reaches that data automatically.

Localbots figures out the rest on its own: which journal group is the current
season (anchored to the M+ pool, so last season's raids drop off), which items
your simc build can actually sim, and which enchants have no DPS effect.

## License

MIT
