// Regenerates data/consumables.json from SimulationCraft's bundled season profiles.
// Run once per season/tier when new profiles land in the simc repo:
//   node scripts/generate-consumables.mjs ~/tools/simc-src/profiles/MID1
//
// The output maps "<class>_<spec>" to the default consumables that spec uses,
// so the app can apply sane current-season consumables to pasted /simc exports
// (the in-game addon export contains no consumable lines).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLASSES = [
  'deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior',
];
const CONSUMABLE_KEYS = ['flask', 'food', 'potion', 'augmentation', 'temporary_enchant'];

const profilesDir = process.argv[2];
if (!profilesDir) {
  console.error('Usage: node scripts/generate-consumables.mjs <path-to-simc-profiles-season-dir>');
  process.exit(1);
}

const classPattern = new RegExp(`^\\s*(${CLASSES.join('|')})\\s*=`, 'm');
const result = {};

for (const file of readdirSync(profilesDir).sort()) {
  if (!file.endsWith('.simc')) continue;
  const text = readFileSync(join(profilesDir, file), 'utf8');
  const classMatch = text.match(classPattern);
  const specMatch = text.match(/^\s*spec\s*=\s*(\w+)/m);
  if (!classMatch || !specMatch) continue;
  const key = `${classMatch[1]}_${specMatch[1]}`;
  if (result[key]) continue; // first profile per spec wins (variants agree anyway)

  const entry = {};
  for (const ck of CONSUMABLE_KEYS) {
    const m = text.match(new RegExp(`^\\s*${ck}\\s*=\\s*(.+)$`, 'm'));
    if (m) entry[ck] = m[1].trim();
  }
  if (Object.keys(entry).length) result[key] = entry;
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'consumables.json');
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(`Wrote ${Object.keys(result).length} specs to ${outPath}`);
