// Turns the pasted /simc export + UI options into a complete simc input file.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placementsFor } from './gearParser.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CONSUMABLE_DEFAULTS = JSON.parse(readFileSync(join(DATA_DIR, 'consumables.json'), 'utf8'));

const FIGHT_STYLES = new Set(['Patchwerk', 'DungeonSlice', 'HecticAddCleave']);

// Raid-buff override names accepted by simc (validated against the midnight branch).
// These are the user-facing toggles; optimal_raid=1 additionally enables
// mortal_wounds, bleeding and blessing_of_the_bronze, which we leave on
// (Raidbots does the same — turning them off cost ~3% DPS in testing).
export const RAID_BUFF_OVERRIDES = [
  'bloodlust',
  'arcane_intellect',
  'battle_shout',
  'mark_of_the_wild',
  'power_word_fortitude',
  'mystic_touch',
  'chaos_brand',
  'skyfury',
  'hunters_mark',
];

export const CONSUMABLE_KEYS = ['flask', 'food', 'potion', 'augmentation', 'temporary_enchant'];

const CLASSES = [
  'deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior',
];
const CLASS_LINE = new RegExp(`^\\s*(${CLASSES.join('|')})\\s*=\\s*"?([^"\\n]*)"?`, 'm');

export function detectSpec(profileText) {
  const classMatch = profileText.match(CLASS_LINE);
  const specMatch = profileText.match(/^\s*spec\s*=\s*(\w+)/m);
  return {
    class: classMatch?.[1] ?? null,
    name: classMatch?.[2] ?? null,
    spec: specMatch?.[1] ?? null,
    key: classMatch && specMatch ? `${classMatch[1]}_${specMatch[1]}` : null,
  };
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

// Strip any global directives from the pasted profile that would fight with our
// UI-controlled settings (people sometimes paste full simc files, not just exports).
const BLOCKED_LINE = /^\s*(iterations|target_error|fight_style|max_time|desired_targets|threads|json2|output|html|report_details|optimal_raid)\s*=/i;

export function sanitizeProfile(text) {
  return text
    .split('\n')
    .filter((line) => !BLOCKED_LINE.test(line))
    .join('\n');
}

export function buildInput(profileText, options = {}) {
  const opts = normalizeOptions(options);
  const lines = [];

  // --- global sim settings ---
  lines.push(`fight_style=${opts.fightStyle}`);
  lines.push(`max_time=${opts.fightLength}`);
  lines.push(`desired_targets=${opts.numEnemies}`);
  if (opts.dummyMode) {
    // Training dummies: fixed-length fight, no execute-phase length variance.
    lines.push('vary_combat_length=0');
    lines.push('fixed_time=1');
  } else {
    lines.push('vary_combat_length=0.2');
  }

  if (opts.iterations) {
    lines.push(`iterations=${opts.iterations}`);
  } else {
    lines.push(`target_error=${opts.targetError}`);
  }

  // Start from "everything on" (like Raidbots), then switch off what the user unticked.
  lines.push('optimal_raid=1');
  for (const buff of RAID_BUFF_OVERRIDES) {
    if (!opts.buffs[buff]) lines.push(`override.${buff}=0`);
  }

  lines.push('');
  lines.push(sanitizeProfile(profileText).trim());
  lines.push('');

  // --- consumables: appended after the profile so they win ---
  const specKey = detectSpec(profileText).key;
  const defaults = (specKey && CONSUMABLE_DEFAULTS[specKey]) || {};
  for (const key of CONSUMABLE_KEYS) {
    if (opts.consumables[key]) {
      // Only inject a default when the pasted profile doesn't name one itself.
      if (!hasConsumableLine(profileText, key) && defaults[key]) {
        lines.push(`${key}=${defaults[key]}`);
      }
    } else {
      lines.push(`${key}=disabled`);
    }
  }

  return lines.join('\n') + '\n';
}

function hasConsumableLine(text, key) {
  return new RegExp(`^\\s*${key}\\s*=`, 'm').test(text);
}

// Builds a Top Gear input: baseline profile plus one profileset per
// (item, placement). Returns { input, sets } where sets maps the exact
// profileset name back to the item it represents.
export function buildTopGearInput(profileText, options, items) {
  const base = buildInput(profileText, options);
  const lines = [base];
  const sets = {};
  const usedNames = new Set();

  for (const [index, item] of items.entries()) {
    const slotMatch = String(item.line ?? '').trim().match(/^([a-z_0-9]+)=(.*)$/);
    if (!slotMatch) continue;
    let rest = slotMatch[2];
    const upgraded = item.targetIlvl && item.targetIlvl !== item.ilvl;
    if (upgraded) {
      // ilevel= wins over bonus_id-derived levels, so this "upgrades" the item.
      rest = rest.replace(/,ilevel=\d+/g, '');
      rest += `,ilevel=${item.targetIlvl}`;
    }
    for (const placement of placementsFor(slotMatch[1])) {
      let name = sanitizeSetName(
        `${item.name ?? slotMatch[1]}${upgraded ? ` +${item.targetIlvl}` : ''} @${placement}`);
      let n = 2;
      while (usedNames.has(name)) name = sanitizeSetName(`${item.name} #${n++} @${placement}`);
      usedNames.add(name);
      lines.push(`profileset."${name}"=${placement}=${rest}`);
      sets[name] = {
        group: index, // one group per source item, across its placements
        itemName: item.name ?? null,
        ilvl: upgraded ? item.targetIlvl : (item.ilvl ?? null),
        origIlvl: item.ilvl ?? null,
        slot: slotMatch[1],
        placement,
        section: item.section ?? 'Bags',
      };
    }
  }
  return { input: lines.join('\n') + '\n', sets };
}

function sanitizeSetName(name) {
  return name.replace(/["\r\n]/g, "'").replace(/[$\\]/g, ' ').slice(0, 80).trim();
}

export function normalizeOptions(options) {
  const dummyMode = options.fightStyle === 'Dummy';
  const fightStyle = dummyMode
    ? 'Patchwerk'
    : FIGHT_STYLES.has(options.fightStyle)
      ? options.fightStyle
      : 'Patchwerk';

  const buffs = {};
  for (const buff of RAID_BUFF_OVERRIDES) {
    buffs[buff] = options.buffs?.[buff] !== false; // default on
  }
  const consumables = {};
  for (const key of CONSUMABLE_KEYS) {
    consumables[key] = options.consumables?.[key] !== false; // default on
  }

  return {
    fightStyle,
    dummyMode,
    numEnemies: clamp(options.numEnemies, 1, 10, 1),
    fightLength: clamp(options.fightLength, 30, 1200, dummyMode ? 600 : 300),
    iterations: options.iterations ? clamp(options.iterations, 100, 100000, null) : null,
    targetError: clamp(options.targetError, 0.05, 2, 0.2),
    buffs,
    consumables,
  };
}
