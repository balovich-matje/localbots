# talents — easy / effort: small

DATA: None. The saved-loadout name + talents string come entirely from the pasted /simc export; simc decodes and validates the string itself. NO wago.tools DB2 table is required for the comparison feature (unlike droptimizer/enchants/folio). This is the single most important finding: the feature is pure export-parsing + profileset plumbing. (A wago table would only be needed for an optional, out-of-scope "human-readable node diff" — the DB2 tables for that are TraitTreeLoadout / TraitNodeEntry / TraitNode, fetchable via the same https://wago.tools/db2/<Table>/csv pattern used in server/wagoData.js downloadTables(); not fetched because the feature does not need them.)

APPROACH: Add server/talents.js with two functions that mirror the comment-parsing style of gearParser.js and the profileset-builder style of buildFolioVariants() in enhancements.js. parseLoadouts(profileText) scans lines for the bare `talents=<active>` line and for each `# Saved Loadout: <name>` comment reads the following `# talents=<string>` comment (a one-line lookahead, exactly like gearParser's pendingName). buildLoadoutVariants(profileText, selection) emits one `profileset."Loadout <name> [tN]"=talents=<string>` per SAVED loadout (skipping any whose string equals the active build, since the active build already IS the baseline), tagging each set object with { section:'Talent loadouts', boss:'Loadouts', sourceKind:'talents' }. Wire it into server/index.js mode==='topgear' exactly like folio: add `if (compare.talents) append(buildLoadoutVariants(profile, sel('talents')?.talents ?? null))`, add 'talents' to the "nothing to compare" guard, and expose the loadout list from POST /api/gear (`out.loadouts = parseLoadouts(profile).loadouts`). extractTopGear() in simRunner.js already groups/deltas by the generic set fields, so results (a "Talent loadouts" section, delta DPS vs the active baseline) render with zero changes to the runner. Frontend adds one more compare-group (public/app.js renderCompareGroups) whose option rows are built from /api/gear's loadouts array with a per-profile count.

EVIDENCE: Verified simc accepts a talents= profileset override and yields different DPS: built scratchpad/talent_test.simc = bundled base ~/tools/simc-src/profiles/MID1/MID1_Hunter_Marksmanship.simc (item_db_source=local, iterations=1000) + two profilesets overriding talents= with the two real marksmanship strings from a user export. Result on /opt/homebrew/bin/simc (build 1205-01 / WoW 12.0.7.68887): Baseline (native MID1 talents) DPS=128,044; profileset "Export Active" median ~115,600; profileset "Export Dark Ranger" median ~87,750 — three distinct talent strings, three clearly different DPS (32% spread, vs 0.24% error), proving the override fully replaces the tree (Dark Ranger is even a different hero tree). Export format confirmed against TWO real exports in the repo: jobs/job-1785265176484-1/input.simc lines 29-34 (Hunter, loadout "Class Codex: Dark Ranger All Dungeons") and jobs/job-1783842567642-3/input.simc lines 24-29 (Death Knight, loadout "Class Codex: Annihilator All Bosses Heroic"). Both show: bare `talents=<active>`, then `# Saved Loadout: <name>` immediately followed by `# talents=<string>`, then a single global `omnium_talents=` line. Closest existing analog is buildFolioVariants() (server/enhancements.js:251) which already overrides omnium_talents= per profileset the same way.

RISKS: 1) Loadout names contain ':' and spaces ("Class Codex: Dark Ranger All Dungeons") — harmless; the existing clean()/sanitizeSetName() only strip quotes/newlines/backslash and truncate, and ':' is legal in simc profileset names. 2) Duplicate loadout names -> the [tN] group-counter suffix keeps profileset names unique, same trick folio uses ([fN]). 3) A saved loadout whose string == active build would duplicate the baseline -> skip via an isActive check. 4) A stale/invalid loadout string (older build) -> simRunner.js already self-heals: it drops the failed `Profileset '<name>'` and retries (up to 5), so one bad loadout never kills the run. 5) sanitizeProfile() in profileBuilder.js does NOT strip `talents=` (not in BLOCKED_LINE), so the active build correctly survives as the baseline, and the `# talents=`/`# Saved Loadout:` comment lines pass through as harmless comments. 6) Per-profile count: unlike folio (fixed 13) or consumables (season.json), loadout count is only known after parsing the pasted export, so the "≈ N sims" hint must come from /api/gear, not static config.

OPEN: (a) Whether to also emit an explicit "Active build (current)" profileset row so it shows in the ranked table with delta 0 (parity with how consumables/folio label a "(current)" row), or leave the active build implicit as the baseline. (b) Cosmetic: strip the game's "Class Codex: " prefix from displayed labels. Both are minor UX calls, not blockers.

---FULL REPORT---
## Talent Loadout Comparison — design for Localbots Top Gear

### Summary
Fully feasible and **small effort**, because it needs **no new data source** and reuses the entire existing Top Gear profileset pipeline. The /simc export already contains the loadout name + talent string, and simc decodes/validates the string itself — verified below.

---

### TASK 1 — Parse saved loadouts from the export (mirror gearParser.js)

Confirmed export layout (two real samples in-repo):
- `jobs/job-1785265176484-1/input.simc` L29-34 (Hunter, "Class Codex: Dark Ranger All Dungeons")
- `jobs/job-1783842567642-3/input.simc` L24-29 (Death Knight, "Class Codex: Annihilator All Bosses Heroic")

```
talents=<ACTIVE STRING>          <- bare, uncommented (this is the active build)

# Saved Loadout: <name>          <- comment
# talents=<STRING>               <- next comment line

omnium_talents=<STRING>          <- single, global, NOT per-loadout
```

New `server/talents.js` (comment-scan + one-line lookahead, like gearParser.js's `pendingName`):

```js
export function parseLoadouts(profileText) {
  const active = profileText.match(/^\s*talents\s*=\s*(\S+)/m)?.[1] ?? null;
  const lines = profileText.split('\n');
  const loadouts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*#\s*Saved Loadout:\s*(.+?)\s*$/);
    if (!m) continue;
    const t = lines[i + 1]?.match(/^\s*#\s*talents\s*=\s*(\S+)/); // the paired comment
    if (t) loadouts.push({ name: m[1], talents: t[1], isActive: t[1] === active });
  }
  return { active, loadouts };
}
```
The name regex intentionally captures everything after `Saved Loadout:` (names contain their own colons).

### TASK 2 — Generate one profileset per saved loadout (reuse Top Gear plumbing)

New `buildLoadoutVariants()` in `server/talents.js`, modeled 1:1 on `buildFolioVariants()` (enhancements.js:251). The **active build is the baseline**, so only *saved* loadouts become profilesets and the delta is computed for free by `extractTopGear()`:

```js
const clean = (s) => String(s).replace(/["\r\n$\\]/g, "'");
export function buildLoadoutVariants(profileText, selection = null, startGroup = 10000) {
  const { loadouts } = parseLoadouts(profileText);
  const wanted = Array.isArray(selection) ? new Set(selection) : null; // selected names
  const lines = [], sets = {}; let group = startGroup;
  for (const lo of loadouts) {
    if (lo.isActive) continue;                    // == baseline; don't duplicate
    if (wanted && !wanted.has(lo.name)) continue;
    const label = lo.name.replace(/^Class Codex:\s*/, '');
    const name = clean(`Loadout ${label} [t${++group}]`).slice(0, 78);
    lines.push(`profileset."${name}"=talents=${lo.talents}`);
    sets[name] = { group, itemName: label, ilvl: null, slot: 'talents',
      placement: 'loadout', section: 'Talent loadouts', boss: 'Loadouts', sourceKind: 'talents' };
  }
  return { lines, sets };
}
```
`startGroup=10000` sits above every existing range (items 0+, consumables 5000, enchants 6000, gems 7000, diamonds 7500, folio 8000, upgrades 9000).

Wiring in `server/index.js` (mode==='topgear'), identical to the folio block at L307-309:
```js
if (compare.talents) append(buildLoadoutVariants(profile, sel('talents')?.talents ?? null));
```
Also: add `talents` to the "Nothing to compare" guard (L273), add a `talents` entry to the compare payload (app.js L837), and return the loadout list from `POST /api/gear` (`out.loadouts = parseLoadouts(profile).loadouts.map(l => ({name:l.name, isActive:l.isActive}))`) so the UI can render the per-loadout checkbox list + live count.

**No changes needed** to `simRunner.js`: `extractTopGear()` (L242) already groups by `info.group`, keeps the best per group, and computes `delta`/`deltaPct` vs `baselineDps` from the generic `section`/`boss`/`sourceKind` fields — the loadout rows drop straight into the results table under a "Talent loadouts" section.

### TASK 3 — VERIFIED: simc accepts a talents= profileset override and DPS changes

Ran `/opt/homebrew/bin/simc` (build **1205-01 / WoW 12.0.7.68887**) on a scratch file = bundled `~/tools/simc-src/profiles/MID1/MID1_Hunter_Marksmanship.simc` with `item_db_source=local`, `iterations=1000`, plus two profilesets each overriding `talents=` with a real MM string from the user export:

| Build | Talents source | DPS |
|---|---|---|
| Baseline | MID1 profile's native talents | **128,044** |
| `profileset."Export Active"=talents=...` | export active string | **~115,600** |
| `profileset."Export Dark Ranger"=talents=...` | export saved loadout | **~87,750** |

Three distinct strings → three clearly different DPS (32% spread vs 0.24% error). The Dark Ranger swing proves the override *fully replaces* the tree including the hero-tree portion. Mechanism confirmed exactly as the feature requires.

### TASK 4 — omnium_talents should NOT swap with class talents

**Keep them separate.** Both real exports show saved loadouts carry only `# talents=`, never `# omnium_talents=`; the `omnium_talents=` line is singular and global. That mirrors the game: the in-game loadout system stores class/spec talents only, while the Omnium Folio (expansion trait tree) is an independent config. A loadout profileset that overrides just `talents=` therefore correctly inherits the one active `omnium_talents=` from the baseline — which is what the game does when you switch loadouts. The Folio already has its own orthogonal compare group (`buildFolioVariants`); both groups can run in the same Top Gear job and rank independently. Bundling them would (a) misrepresent the data model and (b) multiply the profileset count for no in-game meaning.

---

### Effort / files touched
- **New:** `server/talents.js` (~40 lines: `parseLoadouts` + `buildLoadoutVariants`).
- **Edit:** `server/index.js` (~4 lines: append block, guard, /api/gear field), `public/app.js` (~40 lines: one compare-group built from `/api/gear` loadouts + count).
- **Unchanged:** `simRunner.js`, `profileBuilder.js`, `enhancements.js`, `wagoData.js`, `data/season.json` — no data pipeline, no season config.

### Other Raidbots talent-related features (noted)
1. **Saved-loadout comparison** — this feature. Raidbots reads the same SimC-import loadouts; parity is straightforward here.
2. **Manual multi-talent-string entry** — trivially supported by the same builder if the UI ever offers a paste-your-own-string box (just feed extra `{name, talents}` entries to `buildLoadoutVariants`).
3. **Per-node / single-talent swaps** ("Droptalent"-style) — Raidbots does not brute-force full talent trees; a node-level swap tool would require decoding strings via DB2 `TraitTreeLoadout`/`TraitNodeEntry`/`TraitNode` (same wago URL pattern). Large research effort, not needed for loadout comparison — recommend deferring, same posture as the ROADMAP folio note.
4. **Talent-tree image/diff rendering** — out of scope (needs the trait DB2 decode above); the loadout name is enough to identify a build.