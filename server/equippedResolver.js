// Resolves the character's equipped items to their ACTUAL item levels by
// asking simc (a 1-iteration run): the export encodes ilvl in bonus IDs and
// simc is the only local source of truth for decoding them.
// Results are cached per profile text.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeProfile } from './profileBuilder.js';

const execFileP = promisify(execFile);
const WORK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache', 'resolve');

// simc's internal gear keys -> the export's slot names
const SLOT_NAMES = { shoulders: 'shoulder', wrists: 'wrist' };

const cache = new Map(); // profile hash -> [{slot, name, ilvl}]

export async function resolveEquipped(simcPath, profileText) {
  const key = createHash('sha1').update(profileText).digest('hex');
  if (cache.has(key)) return cache.get(key);

  mkdirSync(WORK_DIR, { recursive: true });
  const inputPath = join(WORK_DIR, `${key.slice(0, 12)}.simc`);
  const jsonPath = join(WORK_DIR, `${key.slice(0, 12)}.json`);
  const input = [
    'item_db_source=local', 'iterations=1', 'max_time=10',
    'fight_style=Patchwerk', 'optimal_raid=0', '',
    sanitizeProfile(profileText).trim(), '',
  ].join('\n');
  writeFileSync(inputPath, input);
  try {
    await execFileP(simcPath, [inputPath, `json2=${jsonPath}`, 'threads=2'], { timeout: 60000 });
    if (!existsSync(jsonPath)) throw new Error('simc produced no output');
    const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const gear = json.sim?.players?.[0]?.gear ?? {};
    const items = Object.entries(gear)
      .filter(([, g]) => g && g.ilevel > 0)
      .map(([slot, g]) => ({
        slot: SLOT_NAMES[slot] ?? slot,
        name: prettify(g.name),
        ilvl: g.ilevel,
      }));
    if (cache.size > 30) cache.clear();
    cache.set(key, items);
    return items;
  } finally {
    rmSync(inputPath, { force: true });
    rmSync(jsonPath, { force: true });
  }
}

function prettify(slug) {
  return String(slug ?? '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
