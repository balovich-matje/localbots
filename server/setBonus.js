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
