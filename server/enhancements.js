// Enchant and gem comparisons for Top Gear: sim each season alternative by
// re-emitting the character's own equipped item line with the enchant_id or
// gem_id swapped. One profileset per variant; rings/dual weapons change
// together in a single variant so the row reads as one decision.

import { parseGear } from './gearParser.js';
import { detectSpec } from './profileBuilder.js';
import { isDualWield, primaryStat } from './lootFilter.js';

const ENCHANT_SLOTS = {
  weapon: ['main_hand', 'off_hand'], // off_hand only when dual-wielding
  chest: ['chest'],
  head: ['head'],
  feet: ['feet'],
  legs: ['legs'],
  ring: ['finger1', 'finger2'],
};

function swapEnchant(line, enchantId) {
  const cleaned = line.replace(/,enchant_id=\d+/g, '').replace(/,enchant=[^,]+/g, '');
  return `${cleaned},enchant_id=${enchantId}`;
}

function currentEnchantId(line) {
  return Number(line.match(/,enchant_id=(\d+)/)?.[1]) || null;
}

export function buildEnchantVariants(profileText, enchantOptions, startGroup = 6000) {
  const { equipped } = parseGear(profileText);
  const spec = detectSpec(profileText);
  const dw = isDualWield(spec.key);
  const primary = primaryStat(spec.key);
  const lines = [];
  const sets = {};
  let group = startGroup;

  for (const [category, choices] of Object.entries(enchantOptions ?? {})) {
    if (category.startsWith('_') || !Array.isArray(choices)) continue;
    let slots = (ENCHANT_SLOTS[category] ?? []).filter((s) => equipped[s]);
    if (category === 'weapon' && !dw) slots = slots.filter((s) => s !== 'off_hand');
    if (!slots.length) continue;

    for (const choice of choices) {
      // leg kits/spellthreads are primary-stat specific
      if (choice.stat === 'attack' && primary === 5) continue;
      if (choice.stat === 'int' && primary !== 5) continue;
      const isCurrent = slots.every((s) => currentEnchantId(equipped[s]) === choice.id);
      const label = `${choice.label}${isCurrent ? ' (current)' : ''}`;
      const name = `Ench ${label} [e${++group}]`.replace(/["\r\n$\\]/g, "'").slice(0, 80);
      lines.push(...slots.map((s, i) =>
        `profileset."${name}"${i > 0 ? '+' : ''}=${swapEnchant(equipped[s], choice.id)}`));
      sets[name] = {
        group,
        itemName: label,
        ilvl: null,
        slot: category,
        placement: category === 'ring' ? 'rings' : category,
        section: 'Enchants',
        boss: category === 'ring' ? 'Rings' : category[0].toUpperCase() + category.slice(1),
        sourceKind: 'enchants',
      };
    }
  }
  return { lines, sets };
}

// Uniform-gem comparison: every socket that holds a known stat gem is
// swapped to the candidate; special gems (Eversong Diamonds etc.) and
// unknown ids are left untouched.
export function buildGemVariants(profileText, gemOptions, startGroup = 7000) {
  const { equipped } = parseGear(profileText);
  const knownGemIds = new Set((gemOptions ?? []).map((g) => String(g.id)));
  const lines = [];
  const sets = {};
  let group = startGroup;

  const gemmedSlots = Object.entries(equipped).filter(([, line]) => /,gem_id=[\d/]+/.test(line));
  if (!gemmedSlots.length || !gemOptions?.length) return { lines, sets };

  const swapLine = (line, gemId) =>
    line.replace(/,gem_id=([\d/]+)/, (m, ids) =>
      `,gem_id=${ids.split('/').map((id) => (knownGemIds.has(id) ? gemId : id)).join('/')}`);

  for (const gem of gemOptions) {
    const swapped = gemmedSlots
      .map(([slot, line]) => [slot, swapLine(line, gem.id)])
      .filter(([slot, line]) => line !== equipped[slot]);
    const isCurrent = swapped.length === 0;
    const label = `All gems: ${gem.label}${isCurrent ? ' (current)' : ''}`;
    const name = `${label} [g${++group}]`.replace(/["\r\n$\\]/g, "'").slice(0, 80);
    const emit = isCurrent ? gemmedSlots : swapped; // current still gets a row for reference
    lines.push(...emit.map(([, line], i) => `profileset."${name}"${i > 0 ? '+' : ''}=${line}`));
    sets[name] = {
      group,
      itemName: label,
      ilvl: null,
      slot: 'gems',
      placement: 'all sockets',
      section: 'Gems',
      boss: 'Gems',
      sourceKind: 'gems',
    };
  }
  return { lines, sets };
}
