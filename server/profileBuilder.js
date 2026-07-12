// Turns the pasted /simc export + UI options into a complete simc input file.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placementsFor } from './gearParser.js';
import { isDualWield } from './lootFilter.js';

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
  // Never fall back to the Blizzard API for unknown items (no key available;
  // the fallback can crash simc mid-profileset). Local-only fails cleanly.
  lines.push('item_db_source=local');
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
// setCtx (optional) enforces "Minimum Set Bonus": { byItem: {itemId: setId},
// equippedIds: {slot: itemId}, minimums: {setId: 2|4} } — swaps that would
// drop a set below its minimum are skipped.
export function buildTopGearInput(profileText, options, items, setCtx = null) {
  const base = buildInput(profileText, options);
  const lines = [base];
  const sets = {};
  const usedNames = new Set();
  let skippedBySets = 0;

  // equipped piece count per set, for the minimum-bonus constraint
  const setCounts = {};
  if (setCtx?.minimums && Object.keys(setCtx.minimums).length) {
    for (const id of Object.values(setCtx.equippedIds ?? {})) {
      const sid = setCtx.byItem[id];
      if (sid != null) setCounts[sid] = (setCounts[sid] ?? 0) + 1;
    }
  }
  const breaksSetMinimum = (candidateId, placement) => {
    if (!setCtx?.minimums) return false;
    const replacedSet = setCtx.byItem[setCtx.equippedIds?.[placement]];
    const candidateSet = setCtx.byItem[candidateId];
    if (replacedSet == null || replacedSet === candidateSet) return false;
    const min = Number(setCtx.minimums[replacedSet]);
    if (!min) return false;
    return ((setCounts[replacedSet] ?? 0) - 1) < min && (setCounts[replacedSet] ?? 0) >= min;
  };

  for (const [index, item] of items.entries()) {
    const slotMatch = String(item.line ?? '').trim().match(/^([a-z_0-9]+)=(.*)$/);
    if (!slotMatch) continue;
    let rest = slotMatch[2];
    const itemId = Number(rest.match(/(?:^|,)id=(\d+)/)?.[1]) || null;
    const upgraded = item.targetIlvl && item.targetIlvl !== item.ilvl;
    if (upgraded) {
      // ilevel= wins over bonus_id-derived levels, so this "upgrades" the item.
      rest = rest.replace(/,ilevel=\d+/g, '');
      rest += `,ilevel=${item.targetIlvl}`;
    }
    for (const placement of placementsFor(slotMatch[1])) {
      if (breaksSetMinimum(itemId, placement)) { skippedBySets++; continue; }
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
  return { input: lines.join('\n') + '\n', sets, skippedBySets };
}

function sanitizeSetName(name) {
  return name.replace(/["\r\n]/g, "'").replace(/[$\\]/g, ' ').slice(0, 80).trim();
}

// "Which flask/food/potion/oil is best for me": one profileset per season
// alternative, overriding just that consumable against the baseline.
// Returns { lines, sets } to append to a Top Gear input.
export function buildConsumableVariants(profileText, options, consumableOptions, startGroup = 5000) {
  const opts = normalizeOptions(options);
  const spec = detectSpec(profileText);
  const defaults = (spec.key && CONSUMABLE_DEFAULTS[spec.key]) || {};
  const lines = [];
  const sets = {};
  let group = startGroup;
  const CATEGORY_LABELS = {
    flask: 'Flask', food: 'Food', potion: 'Potion', temporary_enchant: 'Weapon oil',
  };

  for (const [category, choices] of Object.entries(consumableOptions ?? {})) {
    if (category.startsWith('_') || !Array.isArray(choices)) continue;
    if (opts.consumables[category] === false) continue; // category toggled off entirely
    const current = currentConsumable(profileText, category, defaults);
    for (const choice of choices) {
      let value = choice.value;
      if (category === 'temporary_enchant') {
        value = isDualWield(spec.key)
          ? `main_hand:${choice.value}/off_hand:${choice.value}`
          : `main_hand:${choice.value}`;
      }
      const isCurrent = current != null && (value === current || choice.value === current);
      const name = sanitizeSetName(`${choice.label}${isCurrent ? ' (current)' : ''} @${category}`);
      lines.push(`profileset."${name}"=${category}=${value}`);
      sets[name] = {
        group: ++group,
        itemName: `${choice.label}${isCurrent ? ' (current)' : ''}`,
        ilvl: null,
        slot: category,
        placement: CATEGORY_LABELS[category] ?? category,
        section: 'Consumables',
        boss: CATEGORY_LABELS[category] ?? category,
        sourceKind: 'consumables',
      };
    }
  }
  return { lines, sets };
}

function currentConsumable(profileText, category, defaults) {
  const m = profileText.match(new RegExp(`^\\s*${category}\\s*=\\s*(\\S+)`, 'm'));
  const raw = m ? m[1] : (defaults[category] ?? null);
  if (raw && category === 'temporary_enchant') {
    // normalize "main_hand:oil_x/off_hand:oil_x" to the bare oil name
    return raw.split('/')[0].replace(/^main_hand:/, '');
  }
  return raw;
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
