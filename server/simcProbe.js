// Probes which loot-database items exist in the local simc item database.
// Game data ships item records for unreleased content (next raid, next
// season's dungeons) that simc doesn't know yet — equipping one aborts a
// profileset run, so we find them up front via bisection and skip them.
//
// Result is cached per simc build + loot database build.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const PROBE_CACHE = join(CACHE_DIR, 'simc-known-items.json');

// inventory type -> a slot simc will accept for the probe
const PROBE_SLOT = {
  1: 'head', 2: 'neck', 3: 'shoulder', 5: 'chest', 20: 'chest', 6: 'waist',
  7: 'legs', 8: 'feet', 9: 'wrist', 10: 'hands', 11: 'finger1', 12: 'trinket1',
  16: 'back', 13: 'main_hand', 21: 'main_hand', 17: 'main_hand', 15: 'main_hand',
  26: 'main_hand', 22: 'off_hand', 23: 'off_hand', 14: 'off_hand',
};

// The probe equips items onto the user's own character (a naked synthetic
// character fails simc init). iterations=1 keeps each run near-pure init cost.
function probeBase(profileText) {
  return [
    'item_db_source=local',
    'iterations=1',
    'max_time=10',
    'fight_style=Patchwerk',
    'optimal_raid=0',
    '',
    profileText.trim(),
    '',
  ].join('\n');
}

export function loadProbeCache(simcBuild, lootDbBuiltAt) {
  if (!existsSync(PROBE_CACHE)) return null;
  try {
    const c = JSON.parse(readFileSync(PROBE_CACHE, 'utf8'));
    if (c.simcBuild === simcBuild && c.lootDbBuiltAt === lootDbBuiltAt) return new Set(c.knownIds);
  } catch { /* rebuilt below */ }
  return null;
}

// items: [{id, invType}] — returns Set of item ids simc knows.
export async function probeKnownItems(simcPath, simcBuild, lootDbBuiltAt, profileText, items, onProgress = () => {}) {
  const cached = loadProbeCache(simcBuild, lootDbBuiltAt);
  if (cached) return cached;

  const dir = join(CACHE_DIR, 'probe');
  mkdirSync(dir, { recursive: true });

  const base = probeBase(profileText);
  const candidates = items.filter((it) => PROBE_SLOT[it.invType]);
  const bad = [];
  let runs = 0;

  const runsOk = async (subset) => {
    runs++;
    onProgress({ runs, remaining: subset.length, found: bad.length });
    const input = base + subset
      .map((it, i) => `profileset."p${i}"=${PROBE_SLOT[it.invType]}=,id=${it.id},ilevel=272`)
      .join('\n') + '\n';
    const inputPath = join(dir, 'probe.simc');
    const jsonPath = join(dir, 'probe.json');
    rmSync(jsonPath, { force: true });
    writeFileSync(inputPath, input);
    try {
      await execFileP(simcPath, [inputPath, `json2=${jsonPath}`, 'threads=2'], { timeout: 120000 });
      return existsSync(jsonPath);
    } catch {
      return false;
    }
  };

  const findBad = async (subset) => {
    if (!subset.length) return;
    if (await runsOk(subset)) return;
    if (subset.length === 1) { bad.push(subset[0].id); return; }
    const mid = Math.floor(subset.length / 2);
    await findBad(subset.slice(0, mid));
    await findBad(subset.slice(mid));
  };

  await findBad(candidates);
  rmSync(dir, { recursive: true, force: true });

  const badSet = new Set(bad);
  const knownIds = candidates.filter((it) => !badSet.has(it.id)).map((it) => it.id);
  writeFileSync(PROBE_CACHE, JSON.stringify({
    simcBuild, lootDbBuiltAt, probedAt: Date.now(), runs,
    knownIds, unknownIds: bad,
  }));
  return new Set(knownIds);
}
