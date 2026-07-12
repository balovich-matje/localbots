// Filters the loot database down to items a given class/spec can actually
// use and would want: armor type, weapon proficiency, primary stat,
// class-locked items (tier), shields/off-hands.

// simc class name -> WoW class id
export const CLASS_IDS = {
  warrior: 1, paladin: 2, hunter: 3, rogue: 4, priest: 5, deathknight: 6,
  shaman: 7, mage: 8, warlock: 9, monk: 10, druid: 11, demonhunter: 12, evoker: 13,
};

// class id -> armor subclass (1 cloth, 2 leather, 3 mail, 4 plate)
const ARMOR_TYPE = { 1: 4, 2: 4, 6: 4, 3: 3, 7: 3, 13: 3, 4: 2, 10: 2, 11: 2, 12: 2, 5: 1, 8: 1, 9: 1 };

// primary stat per spec key ("class_spec"), stat ids: 3 agi, 4 str, 5 int
const SPEC_PRIMARY = {
  warrior_arms: 4, warrior_fury: 4, warrior_protection: 4,
  paladin_holy: 5, paladin_protection: 4, paladin_retribution: 4,
  hunter_beast_mastery: 3, hunter_marksmanship: 3, hunter_survival: 3,
  rogue_assassination: 3, rogue_outlaw: 3, rogue_subtlety: 3,
  priest_discipline: 5, priest_holy: 5, priest_shadow: 5,
  deathknight_blood: 4, deathknight_frost: 4, deathknight_unholy: 4,
  shaman_elemental: 5, shaman_enhancement: 3, shaman_restoration: 5,
  mage_arcane: 5, mage_fire: 5, mage_frost: 5,
  warlock_affliction: 5, warlock_demonology: 5, warlock_destruction: 5,
  monk_brewmaster: 3, monk_mistweaver: 5, monk_windwalker: 3,
  druid_balance: 5, druid_feral: 3, druid_guardian: 3, druid_restoration: 5,
  demonhunter_havoc: 3, demonhunter_vengeance: 3, demonhunter_devourer: 3,
  evoker_devastation: 5, evoker_preservation: 5, evoker_augmentation: 5,
};

// stat id -> set of primary stats it grants (71-74 are the multi-stat combos)
const STAT_GRANTS = {
  3: [3], 4: [4], 5: [5],
  71: [3, 4, 5], 72: [3, 4], 73: [3, 5], 74: [4, 5],
};

// weapon subclasses per class id
// 0 axe1h 1 axe2h 2 bow 3 gun 4 mace1h 5 mace2h 6 polearm 7 sword1h 8 sword2h
// 9 warglaive 10 staff 13 fist 15 dagger 18 crossbow 19 wand
const WEAPONS = {
  1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15, 18],
  2: [0, 1, 4, 5, 6, 7, 8],
  3: [0, 1, 2, 3, 6, 7, 8, 10, 13, 15, 18],
  4: [0, 4, 7, 13, 15],
  5: [4, 10, 15, 19],
  6: [0, 1, 4, 5, 6, 7, 8],
  7: [0, 1, 4, 5, 10, 13, 15],
  8: [7, 10, 15, 19],
  9: [7, 10, 15, 19],
  10: [0, 4, 6, 7, 10, 13],
  11: [4, 5, 6, 10, 13, 15],
  12: [0, 7, 9, 13, 15],
  13: [0, 1, 4, 5, 7, 8, 10, 13, 15],
};

const SHIELD_SPECS = new Set([
  'warrior_protection', 'paladin_holy', 'paladin_protection',
  'shaman_elemental', 'shaman_restoration',
]);

// specs that dual-wield: a looted weapon should also be tried in the off hand
export function isDualWield(specKey) {
  return DUAL_WIELD_1H.has(specKey) || DUAL_WIELD_2H.has(specKey);
}
const DUAL_WIELD_1H = new Set([
  'warrior_fury', 'deathknight_frost', 'shaman_enhancement',
  'rogue_assassination', 'rogue_outlaw', 'rogue_subtlety',
  'demonhunter_havoc', 'demonhunter_vengeance', 'demonhunter_devourer',
  'monk_windwalker',
]);
const DUAL_WIELD_2H = new Set(['warrior_fury']); // Titan's Grip

// inventory type -> simc slot(s)
const INV_SLOTS = {
  1: ['head'], 2: ['neck'], 3: ['shoulder'], 5: ['chest'], 20: ['chest'],
  6: ['waist'], 7: ['legs'], 8: ['feet'], 9: ['wrist'], 10: ['hands'],
  11: ['finger1', 'finger2'], 12: ['trinket1', 'trinket2'], 16: ['back'],
  13: ['main_hand'], 21: ['main_hand'], 17: ['main_hand'],
  15: ['main_hand'], 26: ['main_hand'],
  22: ['off_hand'], 23: ['off_hand'], 14: ['off_hand'],
};

export function specKeyFor(spec) {
  return spec?.key ?? null; // from detectSpec(): "mage_fire"
}

// Returns null if unusable, otherwise the list of simc slots to try.
export function usableSlots(item, classId, specKey) {
  if (item.quality < 3 && !item.curated) return null;
  if (item.allowableClass !== -1 && !(item.allowableClass & (1 << (classId - 1)))) return null;

  const primary = SPEC_PRIMARY[specKey];
  const primaries = new Set(item.stats.flatMap((s) => STAT_GRANTS[s] ?? []));
  // items with a primary stat must include ours; secondary-only items pass
  if (primaries.size > 0 && primary && !primaries.has(primary)) return null;

  let slots = INV_SLOTS[item.invType];
  if (!slots) return null;

  if (item.classId === 2) { // weapon
    if (!(WEAPONS[classId] ?? []).includes(item.subclassId)) return null;
    const is2h = item.invType === 17;
    const is1h = item.invType === 13 || item.invType === 21 || item.invType === 15 || item.invType === 26;
    if (item.invType === 22) return ['off_hand'];
    if ((is1h && DUAL_WIELD_1H.has(specKey)) || (is2h && DUAL_WIELD_2H.has(specKey))) {
      return ['main_hand', 'off_hand'];
    }
    return slots;
  }

  // armor
  if (item.subclassId === 5) return null; // cosmetic
  if (item.classId === 4 && item.subclassId !== 0 && item.stats.length === 0) return null; // statless (cosmetic/quest)
  if (item.subclassId === 6) { // shield
    return SHIELD_SPECS.has(specKey) ? slots : null;
  }
  if (item.invType === 23) { // held in off-hand (caster only, stat filter did the work)
    return primary === 5 ? slots : null;
  }
  if (item.subclassId >= 1 && item.subclassId <= 4 && item.invType !== 16) {
    if (item.subclassId !== ARMOR_TYPE[classId]) return null;
  }
  return slots;
}
