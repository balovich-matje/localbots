# patch121 — moderate / effort: medium

DATA: wago.tools DB2 CSV exports fetched per-build via the existing `https://wago.tools/db2/{table}/csv?build={version}` pattern (build param VERIFIED to work); plus the local simc PTR item/spell dataset toggled with `ptr=1`. No Blizzard API, no scraping.

APPROACH: Ship a per-patch data pipeline rather than one shared cache. Fetch each patch's wago tables with an explicit `?build=` param into its own cache dir (live = 12.0.7.68887, 12.1 = 12.1.0.68914 to match simc's PTR data build exactly), build a separate loot DB per patch, and probe each with a separate, ptr-keyed cache. The sim/probe input must PREPEND `ptr=1` as the first line (before the pasted gear) when the 12.1 patch is selected — verified that a trailing `ptr=1` flips the banner but still fails item init. In the UI add a two-chip patch switch under the New sim / History nav; every /api call carries a `patch` id that selects the right lootDb, knownItems set, season config, and ptr flag. The single riskiest bug to avoid is the shared probe cache: `simc-known-items.json` is keyed only on `{simcBuild, lootDbBuiltAt}`, and `simcBuild` (from `display_build=1`, no ptr) is byte-identical across patches — so two patches sharing one loot DB collide and each poisons the other (every 12.1 item read back as "unknown", or 12.1-only items wrongly marked "known" for a live sim). The fix is to add `ptr`/patch to the cache key and give each patch its own cache file.

EVIDENCE: TASK 1 (ptr swaps dataset + inits 12.1 items) — VERIFIED by running /opt/homebrew/bin/simc:
- `ptr=1 display_build=1` -> banner "12.1.0.68914 PTR (hotfix 2026-07-24/68914)"; `ptr=0` -> "12.0.7.68887 Live". SC_USE_PTR=1 in engine/config.hpp:161; item_data.cpp:28-31 `dbc_item_data_t::data(ptr)` returns items() vs items_ptr(); item_data.inc has __item_data_chunk*, item_data_ptr.inc has __ptr_item_data_chunk* (68233 vs 67313 stats entries).
- Set-difference of item ids between the two .inc files: 1435 items are PTR-only (extracted /tmp diff). Item 270167 (Wavecaller's Seastone, trinket, The Tidebound Grotto) is PTR-only (grep count 0 in live inc, 1 in ptr inc).
- Controlled run, live main_hand 249293 + trinket1=270167: ptr=0 -> "Item 'inactive' Slot 'trinket1': Cannot initialize data", NO json. ptr=1 -> DPS=485.0, json produced. Same item, only the flag differs.
- ORDER matters (load-bearing): `simc profile.simc ptr=1` (trailing) -> banner shows PTR but trinket still "Cannot initialize data", no json. `simc ptr=1 profile.simc` (leading) -> works. Also verified ptr=1 at TOP of file fixes PROFILESET-injected items (p0=270167, p1=270165 both simmed: 248/187 DPS) — this is how the probe and droptimizer inject items.

TASK 2 (what identifies 12.1 in wago) — VERIFIED via curl with UA 'localbots ...':
- `?build=` param works: MythicPlusSeasonTrackedMap default=120 rows (md5 cff2d49...), `?build=12.0.7.68887`=112 rows (md5 b547204...). The 8 extra rows are DisplaySeasonID=37.
- MythicPlusSeasonTrackedMap.DisplaySeasonID 37 = 12.1 M+ season (live = 34). Season-37 MapChallengeModeIDs 588/399/250/249/584/585/586/587 resolve (MapChallengeMode) to: Altar of Fangs, Ruby Life Pools, Temple of Sethraliss, Kings' Rest, The Blinding Vale, Voidscar Arena, Den of Nalorakk, Murder Row. Season 34 resolves to exactly season.json's mythicPlusDungeons list.
- JournalTierXInstance (cols ID,JournalTierID,JournalInstanceID,OrderIndex,AvailabilityCondition): the 4 raids sit in tier 505 (CURRENT_SEASON_TIER, gated by AvailabilityCondition 149388/158721) AND tier 516 (cond=0). AvailabilityCondition does NOT cleanly separate live vs 12.1 (Voidspire[live] and Sporefall[12.1] both 149388), so it is not a reliable discriminator.
- Ground truth from the probe cache + ptr diff (per-source known/unknown/ptr-only): The Voidspire 52/8/0 and March on Quel'Danas 22/2/0 are LIVE; The Tidebound Grotto 0/13/13 and The Venomous Abyss 0/82/82 are 100% PTR-only (12.1). Sporefall (10/2/0, 1 boss) and The Dreamrift (7/1/0, 1 boss) are only partially datamined in the current cache.
- wago builds API products: wow(live)=12.0.7.68974, wowt(PTR)=12.1.0.69111, and wowt 12.1.0.68914 (created 2026-07-24) EXACTLY matches simc's PTR build+hotfix date. Item-id RANGE is NOT a discriminator: 268289 (Girdle of Devouring Rot) is in BOTH arrays; ptr-only ids overlap live 268xxx.

RISKS: 1. ORDER regression: `ptr=1` must stay the first input line. If a later edit moves it below the gear block, item init silently fails while the banner still says PTR — subtle. Add a guard/test that asserts a known PTR-only id (e.g. 270167) sims under the 12.1 path. 2. Silent self-heal masking: if the 12.1 droptimizer runs without ptr (or with the wrong knownItems), simRunner drops every failing profileset and returns an empty/near-empty result rather than erroring. Verify the probe ran with matching ptr before simming. 3. Incomplete PTR data: current 12.1 build datamines raids partially (Sporefall/Dreamrift = 1 boss). Loot DB is thin until the PTR matures; re-fetch as the build advances. 4. simc/wago build skew: simc's PTR inc is 68914 but wago wowt is now 69111 — fetch wago at the build matching simc (read it from `ptr=1 display_build=1`) so simc knows every item wago lists. 5. Unknown 12.1 ilvls: season-12_1.json's upgrade-track and per-source ilvls need hand-curation from PTR tooltips (same as season.json today). 6. Don't trust wago's default build (currently returns a 12.1 wowt build) — always pin `?build=`.

OPEN: 1. 12.1 upgrade-track ilvls and per-source loot ilvls are not yet known — pull from ItemSparse in the 12.1 build or PTR tooltips before the numbers are trustworthy. 2. Auto-detect simc's PTR build and fetch the matching wago build, or pin manually in season-12_1.json? Auto is more robust but adds a display_build parse. 3. Should the 12.1 chip be hidden entirely when simc lacks PTR data (non-PTR build), and how to surface that to a vibe-coder user? 4. Cache-dir layout: subfolder per patch (`data/cache/live/`, `data/cache/12_1/`) is cleanest but touches every path in wagoData.js — confirm that's acceptable vs. filename-suffixing in the flat dir. 5. Whether to derive the M+ pool from DisplaySeasonID at build time (robust, self-updating) or keep the hand-typed names array for parity with the current code.

---FULL REPORT---
# 12.1 patch selector for Localbots — feasibility + architecture

## Bottom line
Feasible and clean. simc's `ptr=1` genuinely swaps the whole client dataset to **12.1.0.68914 PTR** and successfully initializes 12.1-only items that abort on live. wago.tools serves any build via a `?build=` query param (verified), so a proper 12.1 loot DB is a normal download, not scraping. The work is a **per-patch data pipeline** plus a UI switch — medium effort, spread thin across ~7 files. The one non-obvious trap is the shared probe cache; get that key right and the rest is mechanical.

---

## TASK 1 — Does `ptr=1` swap simc to the PTR dataset, and init a 12.1-only item? YES (both).

- `SC_USE_PTR` defaults to 1 (`engine/config.hpp:161`), and this binary is built with it. `engine/dbc/item_data.cpp:28-31`: `dbc_item_data_t::data(ptr)` returns `dbc::items()` for live vs `dbc::items_ptr()` for PTR — two different arrays (`__item_data_chunk*` vs `__ptr_item_data_chunk*`).
- `ptr=1 display_build=1` prints `...12.1.0.68914 PTR`; `ptr=0` prints `...12.0.7.68887 Live`.
- **1435 items are PTR-exclusive** (id set-diff of `item_data.inc` vs `item_data_ptr.inc`). Test item **270167** (Wavecaller's Seastone, Tidebound Grotto trinket) is PTR-only.
- Decisive controlled run (live weapon 249293 + trinket 270167, only the flag varies):
  - `ptr=0`: `Item 'inactive' Slot 'trinket1': Cannot initialize data` → no output.
  - `ptr=1`: `DPS=485.0`, JSON produced.

### Load-bearing gotcha: `ptr=1` must precede the item lines
- `simc profile.simc ptr=1` (flag **trailing**) → banner says PTR **but the item still fails to init**. Items are resolved against the DBC at the moment their line is parsed; a late `ptr` is too late.
- `simc ptr=1 profile.simc` (flag **leading**) → works.
- Verified that `ptr=1` as the **first line of the file** also fixes **profileset-injected** items (how both the probe and droptimizer add candidates): `profileset."p0"=trinket1=,id=270167` and `p1=270165` both simmed (248 / 187 DPS).
- Implication: inject `ptr=1` at the very top of `buildInput` (before `item_db_source=local`, well before the pasted `sanitizeProfile(profileText)` gear block) and at the top of `probeBase`.

---

## TASK 2 — What identifies 12.1 content in wago

**Reliable discriminators (use these):**
1. **`MythicPlusSeasonTrackedMap.DisplaySeasonID`** — live season = **34**, 12.1 season = **37**. The season-37 rows exist only in the 12.1 build. Joining the 8 season-37 `MapChallengeModeID`s (588, 399, 250, 249, 584, 585, 586, 587) through `MapChallengeMode.Name_lang` gives the 12.1 M+ pool: **Altar of Fangs, Ruby Life Pools, Temple of Sethraliss, Kings' Rest, The Blinding Vale, Voidscar Arena, Den of Nalorakk, Murder Row**. (Season 34 join reproduces season.json's current list exactly — so this can *replace* the hand-typed `mythicPlusDungeons` array.)
2. **The simc ptr=0 vs ptr=1 known-item set** — the empirical ground truth for "is this item in this patch's client data." Tidebound Grotto (0/13 known) and Venomous Abyss (0/82 known) are 100% PTR-only; Voidspire (52/8) and March on Quel'Danas (22/2) are live.

**The 4 raids** (JournalInstance): Sporefall 1305, The Dreamrift 1314, The Tidebound Grotto 1317, The Venomous Abyss 1320. In `JournalTierXInstance` they appear in **tier 505** ("Current Season", `CURRENT_SEASON_TIER`) gated by `AvailabilityCondition` (149388/158721) **and** in **tier 516** (cond=0, an all-Midnight catalog tier).

**Signals that DON'T work — avoid:**
- **`AvailabilityCondition`** does not separate live from 12.1: The Voidspire (live raid) and Sporefall (12.1 raid) both carry 149388.
- **Item-id range** does not separate them: 268289 (Girdle of Devouring Rot) is in *both* live and PTR arrays; PTR-only ids are scattered (262398+, 268xxx, 270xxx, 281xxx) and interleave with live ids.
- Tier id alone doesn't isolate 12.1 (tier 505 currently holds both live and 12.1 sources; tier 516 holds the whole expansion).

**wago build products** (`/api/builds`): `wow` (live) = 12.0.7.68974, `wowt` (PTR) = 12.1.0.69111, and **`wowt` 12.1.0.68914 (2026-07-24) exactly matches simc's PTR data build + hotfix date**. `?build=` is verified working (`?build=12.0.7.68887` → 112 M+ rows vs default 120). NOTE: wago's **default** (no build param) currently returns a 12.1 `wowt` build — which is why the *existing* July cache already contains 12.1 content that only the probe hides. Always pin `?build=` explicitly rather than trusting the default.

**PTR data maturity caveat:** even the 12.1 build datamines raids incrementally — Sporefall and The Dreamrift show only 1 boss / a handful of items right now. The 12.1 loot DB will be thin until the PTR matures; it fills in on re-fetch.

---

## TASK 3 — Architecture

### What breaks if live and 12.1 share one lootDb / probe cache

**Shared loot DB:**
- `data/cache/*.csv` and `lootdb.json` are a single flat set. The two patches' CSVs would overwrite each other; there's no `patch` tag on sources, so a 12.1 droptimizer would list Voidspire (live) and a live droptimizer would list Venomous Abyss (12.1), each at the wrong ilvls.
- `buildLootDb` filters `JournalTierID === 505`, and tier 505 currently mixes both patches — a single build can't cleanly split them. The M+ pool comes from a hardcoded live-names array; 12.1 needs the season-37 pool.

**Shared probe cache — the critical one** (`server/simcProbe.js`):
- Cache key is `{ simcBuild, lootDbBuiltAt }` only (`loadProbeCache`, lines 41-48). `simcBuild` is read once at startup via `display_build=1` **without ptr**, so it's byte-identical for both patches (`...12.0.7.68887 Live`). If both patches share one loot DB (same `builtAt`), the key **collides**:
  - Probe live (ptr=0) writes `knownIds` = live-only → switch to 12.1 → `loadProbeCache` returns that same file → **every 12.1 item is "unknown"** → the entire 12.1 droptimizer shows zero usable items / all sources `available:false`.
  - Reverse order: 12.1 probe (ptr=1) marks 12.1-only items "known" → a later live sim tries to sim a 12.1 item → simc-live aborts the profileset; `simRunner`'s self-heal silently drops it (wasted runs), or it's fatal if in the baseline.
- Separately: `probeBase` never sets `ptr`, so probing 12.1 items under live data returns them all "unknown" regardless. The probe must run simc with `ptr=1` (prepended) for the 12.1 patch.

### Staged plan

**Stage 0 — Per-patch config.** Keep `data/season.json` (live). Add `data/season-12_1.json` with a small header `{ id:"12_1", label:"PTR 12.1", ptr:true, wagoBuild:"12.1.0.68914", mplusSeason:37 }` plus the same shape (tracks, consumables, droptimizer ilvls, mythicPlusDungeons = season-37 pool). Prefer deriving the M+ pool from `MythicPlusSeasonTrackedMap.DisplaySeasonID` at build time over hardcoding names. A tiny `data/patches.json` registry lists the available patches for the UI.

**Stage 1 — `wagoData.js`: per-build fetch + per-patch cache + per-patch loot DB.**
- `downloadTables(onProgress, { build })` → append `?build=${build}` to each `https://wago.tools/db2/{table}/csv` URL. To keep simc and wago in lockstep, resolve the 12.1 build from simc itself: parse `ptr=1 display_build=1` → `12.1.0.68914` → fetch that exact wago build (avoids items wago knows but simc doesn't).
- Write each patch's CSVs into `data/cache/<patch>/` (e.g. `live/`, `12_1/`) so they don't clobber each other. `CACHE_DIR`, `LOOT_DB`, `loadTable`, `cacheStatus` take a patch/dir arg.
- `buildLootDb(mplusDungeonNames, { cacheDir, lootDbPath, mplusSeason })`; stamp `patch` into the db object. Same join logic; the M+ filter uses the patch's pool.

**Stage 2 — `simcProbe.js`: ptr + patch-keyed cache.**
- `probeBase(profileText, ptr)` prepends `ptr=1` as the **first line** when `ptr`.
- `probeKnownItems(..., { ptr, patchId })`; cache key becomes `{ simcBuild, lootDbBuiltAt, ptr }`, and the file lives at `data/cache/<patch>/simc-known-items.json`. This removes the poisoning entirely.

**Stage 3 — `profileBuilder.js` / `droptimizer.js`: ptr in the sim input.**
- `buildInput` gains `options.ptr` (or a patch arg) and, when set, unshifts `ptr=1` as line 1. `buildDroptimizerInput` and `buildTopGearInput` inherit it through `buildInput`; droptimizer reads the selected patch's loot DB + season config.

**Stage 4 — `index.js`: patch registry + endpoints.**
- Replace the singletons (`lootDb`, `knownItems`, probe flags, `refreshState`) with a `patches` map keyed by patch id, each `{ config, lootDb, knownItems, probe state, cacheStatus }`.
- `POST /api/data/refresh` takes `{ patch }` and refreshes only that patch (download at its build → rebuild its loot DB → reset its probe).
- `/api/droptimizer/sources` and `/api/sim` take a `patch` field: pick that patch's lootDb / knownItems / seasonConfig, and pass `ptr` into `buildInput`/`ensureProbe`. `/api/season` takes `?patch=`.
- Optional: `checkSimc` in `status.js` compares against `builds.wowt[0]` for 12.1 (vs `builds.wow[0]` for live), and the header can badge "PTR".

**Stage 5 — UI (`index.html` + `app.js`).**
- Add a `patch-switch` under `<nav class="page-nav">` (index.html:14-17): two chips, "Live 12.0" / "PTR 12.1". Persist the selection in app state and include `patch` in every /api body. Season-derived option lists (tracks, consumables, enchants, gems, folio) reload from the selected patch's `/api/season`. The "Refresh data" button (id `dropt-refresh`) refreshes the selected patch and shows its own cache/probe status. Gate the 12.1 chip on simc actually having PTR data (detect a PTR banner from `ptr=1 display_build=1`; else disable with a tooltip).