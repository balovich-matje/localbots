// Which simc option name switches a tier set bonus on.
//
// The droptimizer's "keep my tier set bonus" toggle needs to tell simc "count
// this profileset as still having the set", which simc spells
// `set_bonus=<name>_4pc=1`. The name comes from its own generated table,
// engine/dbc/generated/item_set_bonus.inc, keyed by the game's ItemSet id --
// the same id our loot database already uses -- so the two can never drift.
//
// Rows look like:
//   { "Baleful Grave-Knight's Crucible", "midnight_season_2", "MID2", 27, 2055,
//     2, 6, 252, -1, 1296654, { 271477, ... } },
// and we want columns 2 (option name) and 5 (ItemSet id).

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROW_RE = /^\s*\{\s*"(?:[^"\\]|\\.)*"\s*,\s*"([a-z0-9_]+)"\s*,\s*"[^"]*"\s*,\s*-?\d+\s*,\s*(\d+)\s*,/;

const cache = new Map(); // "live" | "ptr" -> Map(setId -> optionName)

export function loadSetBonusNames(simcPath, ptr = false) {
  const key = ptr ? 'ptr' : 'live';
  if (cache.has(key)) return cache.get(key);
  let names = null;
  try {
    const dir = join(dirname(dirname(realpathSync(simcPath))), 'engine', 'dbc', 'generated');
    const file = join(dir, ptr ? 'item_set_bonus_ptr.inc' : 'item_set_bonus.inc');
    if (existsSync(file)) {
      names = new Map();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(ROW_RE);
        if (m) names.set(Number(m[2]), m[1]);
      }
    }
  } catch { /* binary-only simc install — the caller falls back to "latest" */ }
  cache.set(key, names);
  return names;
}

// simc understands "latest" as "the newest tier set", which is the right
// answer whenever the character is wearing the current season's set — so a
// simc we cannot read the table from still gets the toggle, just less exactly.
export function optionForSet(names, setId) {
  return names?.get(Number(setId)) ?? 'latest';
}

// Each class's CURRENT tier set, straight from the same generated table --
// "Catalyze looted items" needs the real 5 piece ids (Top Gear then simply
// swaps a candidate in a tier slot for the matching piece, keeping the
// candidate's own stats via redirected_base_stats= — the same field the
// game's own /simc export writes for an already-catalyzed item). There is no
// per-item "what does the Catalyst turn this into" table in the game's own
// data (the real in-game system resolves it through an item-bonus-tree
// choice screen, not a static map) — this table's rows are simc's own
// per-class/spec set-bonus definitions, keyed by the game's ItemSet id, and
// ItemSet ids are handed out in order as new sets are added, so the row with
// the HIGHEST id for a class is always that class's newest tier set, with no
// season name to keep in sync by hand.
//
// Row shape (whitespace collapsed for readability):
//   { "Primal Leywarden's Attire", "midnight_season_2", "MID2", 27, 2060,
//     2, 8, 64, -1, 1296585, { 271567, 271565, 271564, 271563, 271562, 0 } }
// columns: name, season tag, short tag, ?, ItemSet id, pc-threshold,
// class id, spec id, ?, spell id, { the 5 piece ids (0-padded) }.
const ROW_RE_CATALYST =
  /^\s*\{\s*"(?:[^"\\]|\\.)*"\s*,\s*"[a-z0-9_]+"\s*,\s*"[^"]*"\s*,\s*-?\d+\s*,\s*(\d+)\s*,\s*-?\d+\s*,\s*(\d+)\s*,\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*,\s*\{([^}]*)\}/;

const catalystCache = new Map(); // "live" | "ptr" -> Map(classId -> { setId, name, itemIds })

export function loadCatalystSets(simcPath, ptr = false) {
  const key = ptr ? 'ptr' : 'live';
  if (catalystCache.has(key)) return catalystCache.get(key);
  let byClass = null;
  try {
    const dir = join(dirname(dirname(realpathSync(simcPath))), 'engine', 'dbc', 'generated');
    const file = join(dir, ptr ? 'item_set_bonus_ptr.inc' : 'item_set_bonus.inc');
    if (existsSync(file)) {
      const bySet = new Map();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(ROW_RE_CATALYST);
        if (!m) continue;
        const setId = Number(m[1]);
        if (bySet.has(setId)) continue;
        const itemIds = m[3].split(',').map((s) => Number(s.trim())).filter((id) => id > 0);
        if (itemIds.length !== 5) continue; // only real 5-piece tier armor sets
        bySet.set(setId, { classId: Number(m[2]), itemIds });
      }
      byClass = new Map();
      for (const [setId, info] of bySet) {
        const cur = byClass.get(info.classId);
        if (!cur || setId > cur.setId) byClass.set(info.classId, { setId, itemIds: info.itemIds });
      }
    }
  } catch { /* binary-only simc install — the caller just skips the toggle */ }
  catalystCache.set(key, byClass);
  return byClass;
}
