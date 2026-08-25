// Probes which loot-database items exist in the local simc item database.
// Game data ships item records for unreleased content (next raid, next
// season's dungeons) that simc doesn't know yet — equipping one aborts a
// profileset run, so we find them up front via bisection and skip them.
//
// Armour is probed on a stand-in character that can actually WEAR it: putting
// plate on a rogue segfaults simc, which looks exactly like "simc has never
// heard of this item". The result is cached and shared between everyone using
// the server, so a probe run by a leather character used to mark every plate
// and mail item in the game unknown — and plate wearers then got a droptimizer
// with no armour in it at all.
//
// Result is cached per simc build + loot database build.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeProfile } from './profileBuilder.js';

const execFileP = promisify(execFile);
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const PROBE_CACHE = join(CACHE_DIR, 'simc-known-items.json');
// per-patch probe caches must never share a file: a live probe would mark
// every PTR-only item unknown for the PTR patch (and vice versa)

// Armour subclass -> a class that can wear it, so the probe tests the ITEM
// rather than the wearer's proficiency. Everything else (weapons, cloaks,
// jewellery, trinkets, shields) is proficiency-agnostic enough in simc to go
// on the character we were handed.
const ARMOR_PROBE = {
  1: ['mage', 'fire'],
  2: ['rogue', 'assassination'],
  3: ['hunter', 'beast_mastery'],
  4: ['warrior', 'fury'],
};
// Worn Shortsword — a vanilla white weapon every one of those classes can hold.
// simc refuses to start a character with no weapon at all ("No active players
// in sim!"), and this is the least interesting item that fixes that.
const PROBE_WEAPON = 25;

// inventory type -> a slot simc will accept for the probe
const PROBE_SLOT = {
  1: 'head', 2: 'neck', 3: 'shoulder', 5: 'chest', 20: 'chest', 6: 'waist',
  7: 'legs', 8: 'feet', 9: 'wrist', 10: 'hands', 11: 'finger1', 12: 'trinket1',
  16: 'back', 13: 'main_hand', 21: 'main_hand', 17: 'main_hand', 15: 'main_hand',
  26: 'main_hand', 22: 'off_hand', 23: 'off_hand', 14: 'off_hand',
};

// The probe equips items onto the user's own character (a naked synthetic
// character fails simc init). iterations=1 keeps each run near-pure init cost.
function syntheticBase(cls, spec, ptr) {
  return [
    ...(ptr ? ['ptr=1'] : []),
    'item_db_source=local',
    'iterations=1',
    'max_time=10',
    'fight_style=Patchwerk',
    'optimal_raid=0',
    '',
    `${cls}="Probe"`,
    'level=90',
    'race=human',
    `spec=${spec}`,
    `main_hand=,id=${PROBE_WEAPON}`,
    '',
  ].join('\n');
}

function probeBase(profileText, ptr) {
  // The probe only tests whether ITEMS initialize — talents are irrelevant,
  // and a live export's talent hash may not decode under a PTR dataset
  // (which would fail the baseline and mark every item unknown). Strip them.
  // sanitizeProfile also strips a pasted ptr= line, which would otherwise
  // override our own flag below and poison the persisted probe cache.
  const noTalents = sanitizeProfile(profileText)
    .split('\n')
    .filter((l) => !/^\s*(talents|omnium_talents)\s*=/.test(l))
    .join('\n');
  return [
    // ptr must be the FIRST line — items resolve against the database at parse time
    ...(ptr ? ['ptr=1'] : []),
    'item_db_source=local',
    'iterations=1',
    'max_time=10',
    'fight_style=Patchwerk',
    'optimal_raid=0',
    '',
    noTalents.trim(),
    '',
  ].join('\n');
}

// Bumped when the probe's METHOD changes, so a cache written by an older
// (wrong) method is thrown away instead of trusted.
const PROBE_VERSION = 2;

export function loadProbeCache(simcBuild, lootDbBuiltAt, cachePath = PROBE_CACHE) {
  if (!existsSync(cachePath)) return null;
  try {
    const c = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (c.probeVersion === PROBE_VERSION && c.simcBuild === simcBuild
        && c.lootDbBuiltAt === lootDbBuiltAt) return new Set(c.knownIds);
  } catch { /* rebuilt below */ }
  return null;
}

// items: [{id, invType}] — returns Set of item ids simc knows.
// opts.ptr probes against simc's PTR dataset; opts.cachePath keeps each
// patch's result in its own file.
export async function probeKnownItems(simcPath, simcBuild, lootDbBuiltAt, profileText, items, onProgress = () => {}, opts = {}) {
  const ptr = opts.ptr === true;
  const cachePath = opts.cachePath ?? PROBE_CACHE;
  const cached = loadProbeCache(simcBuild, lootDbBuiltAt, cachePath);
  if (cached) return cached;

  const dir = join(dirname(cachePath), ptr ? 'probe-ptr' : 'probe');
  mkdirSync(dir, { recursive: true });

  const ownBase = probeBase(profileText, ptr);
  const candidates = items.filter((it) => PROBE_SLOT[it.invType]);
  const bad = [];
  let runs = 0;

  const run = async (base, subset) => {
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

  const findBad = async (base, subset) => {
    if (!subset.length) return;
    if (await run(base, subset)) return;
    if (subset.length === 1) { bad.push(subset[0].id); return; }
    const mid = Math.floor(subset.length / 2);
    await findBad(base, subset.slice(0, mid));
    await findBad(base, subset.slice(mid));
  };

  // one bucket per stand-in wearer, plus everything else on the given character
  const buckets = new Map(); // armour subclass (or "own") -> { base, items }
  for (const it of candidates) {
    const stand = Number(it.classId) === 4 ? ARMOR_PROBE[Number(it.subclassId)] : null;
    const key = stand ? Number(it.subclassId) : 'own';
    if (!buckets.has(key)) {
      buckets.set(key, {
        base: stand ? syntheticBase(stand[0], stand[1], ptr) : ownBase,
        items: [],
      });
    }
    buckets.get(key).items.push(it);
  }

  // A base profile that cannot even start a sim fails every run, and bisection
  // would then condemn the whole bucket -- silently deleting loot from the
  // droptimizer, which is far worse than letting one sim fail loudly. So each
  // base is checked empty first, with the plate stand-in as the fallback, and
  // a bucket with no working base is left unprobed (everything counts as
  // known). The character we are handed is the usual casualty: an export with
  // no weapon in it gives simc "No active players in sim!".
  const fallbackBase = syntheticBase(...ARMOR_PROBE[4], ptr);
  const workingBase = async (base) => {
    if (await run(base, [])) return base;
    return (base !== fallbackBase && await run(fallbackBase, [])) ? fallbackBase : null;
  };
  let unprobed = 0;
  for (const bucket of buckets.values()) {
    const base = await workingBase(bucket.base);
    if (!base) { unprobed += bucket.items.length; continue; }
    await findBad(base, bucket.items);
  }
  rmSync(dir, { recursive: true, force: true });

  const badSet = new Set(bad);
  const knownIds = candidates.filter((it) => !badSet.has(it.id)).map((it) => it.id);
  writeFileSync(cachePath, JSON.stringify({
    probeVersion: PROBE_VERSION,
    simcBuild, lootDbBuiltAt, probedAt: Date.now(), runs, unprobed,
    knownIds, unknownIds: bad,
  }));
  return new Set(knownIds);
}
