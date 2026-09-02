// Item tooltip stats, computed the way the game computes them.
//
// The formula is simc's item_database::scaled_stat():
//
//   value = stat_alloc * budget(ilvl, slot_type) * 0.0001
//   combat ratings are then multiplied by CombatRatingsMultByILvl[type][ilvl]
//   stamina is multiplied by StaminaMultByILvl[type][ilvl]
//   round
//
// The two multiplier curves are not published by wago under any name in the
// current build, but simc generates them into engine/dbc/generated/
// sc_scale_data.inc, which is the same source we already read talent tables
// from — so they follow the simc install and the PTR toggle for free.
//
// Verified against in-game tooltips for a chest, a two-hand weapon and one
// trinket at two different item levels: every stat, the armour value and the
// weapon damage range match exactly.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseCsv } from './csv.js';

// ItemSparse.StatModifier_bonusStat_N values we know how to name
const STAT_NAMES = {
  3: 'Agility', 4: 'Strength', 5: 'Intellect', 6: 'Spirit', 7: 'Stamina',
  32: 'Critical Strike', 36: 'Haste', 40: 'Versatility', 49: 'Mastery',
  // 71-74 are COMBINED primaries: the game shows whichever one your class uses
  // and greys out the rest. Naming any single one of them would be wrong for
  // most readers -- a Strength-or-Agility weapon read as "Agility" on a death
  // knight -- so they all share the neutral label. (Loot filtering knows the
  // real sets; see SPEC_PRIMARY in lootFilter.js.)
  71: 'Primary Stat', 72: 'Primary Stat', 73: 'Primary Stat', 74: 'Primary Stat',
};
const RATINGS = new Set([32, 36, 40, 49]);
const PRIMARY_COMBINED = new Set([71, 72, 73, 74]); // "best of" primary placeholders

// Item.SubclassID, for the type line under an item's slot ("Chest ... Cloth")
// -- stable WoW constants (ITEM_SUBCLASS_ARMOR / _WEAPON), not something wago
// needs to be asked for by name.
const ARMOR_SUBCLASS = { 1: 'Cloth', 2: 'Leather', 3: 'Mail', 4: 'Plate', 6: 'Shield' };
const WEAPON_SUBCLASS = {
  0: 'One-Handed Axe', 1: 'Two-Handed Axe', 2: 'Bow', 3: 'Gun', 4: 'One-Handed Mace',
  5: 'Two-Handed Mace', 6: 'Polearm', 7: 'One-Handed Sword', 8: 'Two-Handed Sword',
  10: 'Staff', 13: 'Fist Weapon', 15: 'Dagger', 16: 'Thrown', 17: 'Spear',
  18: 'Crossbow', 19: 'Wand',
};
// Item.Bonding -> ITEM_BIND enum
const BIND_TEXT = { 1: 'Binds when picked up', 2: 'Binds when equipped' };

// combat_rating_multiplier_type, in simc's order
const CR_ARMOR = 0, CR_WEAPON = 1, CR_TRINKET = 2, CR_JEWELRY = 3;

// InventoryType -> budget slot (item_database::random_suffix_type)
const INV = {
  HEAD: 1, NECK: 2, SHOULDERS: 3, CHEST: 5, WAIST: 6, LEGS: 7, FEET: 8,
  WRISTS: 9, HANDS: 10, FINGER: 11, TRINKET: 12, WEAPON: 13, SHIELD: 14,
  RANGED: 15, CLOAK: 16, TWOHAND: 17, ROBE: 20, MAINHAND: 21, OFFHAND: 22,
  HOLDABLE: 23, RANGEDRIGHT: 26,
};

function budgetSlot(invType, itemClass, subClass) {
  if (itemClass === 2) { // weapon
    // two-handers and ranged sit in the top budget bracket, the rest in 3
    const twoHand = [1, 5, 6, 8, 10, 2, 3, 18, 16].includes(subClass);
    return twoHand ? 0 : 3;
  }
  switch (invType) {
    case INV.HEAD: case INV.CHEST: case INV.LEGS: case INV.ROBE: return 0;
    case INV.SHOULDERS: case INV.WAIST: case INV.FEET: case INV.HANDS: case INV.TRINKET: return 1;
    case INV.NECK: case INV.FINGER: case INV.CLOAK: case INV.WRISTS: return 2;
    default: return 3;
  }
}

function ratingType(invType) {
  if (invType === INV.NECK || invType === INV.FINGER) return CR_JEWELRY;
  if (invType === INV.TRINKET) return CR_TRINKET;
  if ([INV.WEAPON, INV.TWOHAND, INV.MAINHAND, INV.OFFHAND, INV.RANGED,
    INV.RANGEDRIGHT, INV.HOLDABLE, INV.SHIELD].includes(invType)) return CR_WEAPON;
  return CR_ARMOR;
}

// ---------- simc's scaling curves ----------

const scaleCache = new Map(); // "live"|"ptr" -> { cr, stam }

function scaleFileFor(simcPath, ptr) {
  try {
    const srcDir = dirname(dirname(realpathSync(simcPath)));
    const f = join(srcDir, 'engine', 'dbc', 'generated', ptr ? 'sc_scale_data_ptr.inc' : 'sc_scale_data.inc');
    return existsSync(f) ? f : null;
  } catch {
    return null;
  }
}

function parseCurves(text, name) {
  const marker = `__${name}[][1300] = {`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let depth = 0, end = -1;
  const open = text.indexOf('{', start);
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null;
  const body = text.slice(open + 1, end);
  return [...body.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => (m[1].match(/-?\d+\.?\d*(?:e[-+]?\d+)?/g) ?? []).map(Number));
}

export function loadScaling(simcPath, ptr = false) {
  const key = ptr ? 'ptr' : 'live';
  if (scaleCache.has(key)) return scaleCache.get(key);
  const file = scaleFileFor(simcPath, ptr);
  if (!file) { scaleCache.set(key, null); return null; }
  try {
    // the generated file numbers every fifth entry in a trailing comment;
    // those digits would be read as data, so comments go first
    const text = readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '');
    const cr = parseCurves(text, 'combat_ratings_mult_by_ilvl');
    const stam = parseCurves(text, 'stamina_mult_by_ilvl');
    const out = cr && stam ? { cr, stam } : null;
    scaleCache.set(key, out);
    return out;
  } catch {
    scaleCache.set(key, null);
    return null;
  }
}

export function clearScalingCache() { scaleCache.clear(); }

// ---------- the per-patch item tables ----------

export function loadItemTables(cacheDir) {
  const read = (name, cols) => {
    const p = join(cacheDir, `${name}.csv`);
    return existsSync(p) ? parseCsv(readFileSync(p, 'utf8'), cols) : null;
  };

  const rpp = read('RandPropPoints', ['ID', 'EpicF_0', 'EpicF_1', 'EpicF_2', 'EpicF_3', 'EpicF_4',
    'DamageReplaceStatF', 'DamageSecondaryF']);
  if (!rpp) return null;
  const budget = new Map(rpp.map((r) => [Number(r.ID),
    [+r.EpicF_0, +r.EpicF_1, +r.EpicF_2, +r.EpicF_3, +r.EpicF_4]]));
  // the separate budgets item effects scale against
  const damageBudget = new Map(rpp.map((r) => [Number(r.ID),
    { replaceStat: +r.DamageReplaceStatF, secondary: +r.DamageSecondaryF }]));

  const sparse = read('ItemSparse', [
    'ID', 'Display_lang', 'OverallQualityID', 'InventoryType', 'ItemDelay', 'DmgVariance',
    'StatPercentEditor_0', 'StatPercentEditor_1', 'StatPercentEditor_2',
    'StatPercentEditor_3', 'StatPercentEditor_4', 'StatPercentEditor_5',
    'StatModifier_bonusStat_0', 'StatModifier_bonusStat_1', 'StatModifier_bonusStat_2',
    'StatModifier_bonusStat_3', 'StatModifier_bonusStat_4', 'StatModifier_bonusStat_5',
    'Bonding', 'RequiredLevel',
  ]);
  if (!sparse) return null;
  const items = new Map();
  for (const r of sparse) {
    const allocs = [];
    for (let i = 0; i < 6; i++) {
      const stat = Number(r[`StatModifier_bonusStat_${i}`]);
      const alloc = Number(r[`StatPercentEditor_${i}`]);
      if (stat >= 0 && alloc !== 0) allocs.push({ stat, alloc });
    }
    items.set(Number(r.ID), {
      name: r.Display_lang,
      quality: Number(r.OverallQualityID),
      invType: Number(r.InventoryType),
      delay: Number(r.ItemDelay),
      variance: Number(r.DmgVariance),
      bonding: Number(r.Bonding),
      requiredLevel: Number(r.RequiredLevel),
      allocs,
    });
  }

  const cls = read('Item', ['ID', 'ClassID', 'SubclassID']);
  const classes = new Map((cls ?? []).map((r) => [Number(r.ID), { cls: Number(r.ClassID), sub: Number(r.SubclassID) }]));

  const dmgRow = (name) => {
    const rows = read(name, ['ItemLevel', 'Quality_4']);
    return rows ? new Map(rows.map((r) => [Number(r.ItemLevel), Number(r.Quality_4)])) : null;
  };
  const armorTotal = read('ItemArmorTotal', ['ItemLevel', 'Cloth', 'Leather', 'Mail', 'Plate']);
  const armorLoc = read('ArmorLocation', ['ID', 'Clothmodifier', 'Leathermodifier', 'Chainmodifier', 'Platemodifier', 'Modifier']);

  return {
    budget,
    damageBudget,
    items,
    classes,
    dmg1h: dmgRow('ItemDamageOneHand'),
    dmg2h: dmgRow('ItemDamageTwoHand'),
    armorTotal: armorTotal ? new Map(armorTotal.map((r) => [Number(r.ItemLevel),
      { 1: +r.Cloth, 2: +r.Leather, 3: +r.Mail, 4: +r.Plate }])) : null,
    // per armour class, keyed by Item.SubclassID (1 cloth .. 4 plate). The
    // generic Modifier column disagrees with the class-specific ones on several
    // slots -- shoulders read 0.13 there but 0.11 for plate -- so it is unused.
    armorLoc: armorLoc ? new Map(armorLoc.map((r) => [Number(r.ID), {
      1: +r.Clothmodifier, 2: +r.Leathermodifier, 3: +r.Chainmodifier, 4: +r.Platemodifier,
    }])) : null,
  };
}

// ---------- the calculation ----------

// The budgets an item's effects scale against. Kept here because the rating
// type depends on the same inventory-type mapping the stats use.
export function effectContext(itemId, ilvl, tables, scaling) {
  if (!tables || !scaling || !ilvl) return null;
  const it = tables.items.get(Number(itemId));
  const budget = tables.budget.get(Number(ilvl));
  if (!it || !budget) return null;
  const crType = ratingType(it.invType);
  const rpp = tables.damageBudget?.get(Number(ilvl)) ?? null;
  return {
    primaryBudget: budget[0],
    secondaryBudget: rpp?.secondary ?? 0,
    crMult: scaling.cr[crType]?.[ilvl - 1] ?? 1,
  };
}

// statSourceId: a Catalyst-converted item keeps the SECONDARIES of the piece it
// was made from, so its stat line does not match its own item record. The simc
// export writes that source as `redirected_base_stats=<id>`, and simc sims it
// that way — without this the tooltip shows the tier piece's original stats and
// disagrees with the game.
export function itemStats(itemId, ilvl, tables, scaling, statSourceId = null) {
  if (!tables || !scaling || !ilvl) return null;
  const it = tables.items.get(Number(itemId));
  if (!it) return null;
  const budget = tables.budget.get(Number(ilvl));
  if (!budget) return null;
  const allocs = (statSourceId && tables.items.get(Number(statSourceId))?.allocs) || it.allocs;

  const c = tables.classes.get(Number(itemId)) ?? { cls: 4, sub: 0 };
  const slot = budgetSlot(it.invType, c.cls, c.sub);
  const crType = ratingType(it.invType);
  const crMult = scaling.cr[crType]?.[ilvl - 1] ?? 1;
  const stamMult = scaling.stam[crType]?.[ilvl - 1] ?? 1;

  const primary = [];
  const secondary = [];
  let stamina = null;
  for (const { stat, alloc } of allocs) {
    let v = alloc * budget[slot] * 0.0001;
    if (RATINGS.has(stat)) v *= crMult;
    else if (stat === 7) v *= stamMult;
    const value = Math.round(v);
    if (!value) continue;
    const row = { stat, name: STAT_NAMES[stat] ?? `Stat ${stat}`, value };
    if (stat === 7) stamina = row;
    else if (RATINGS.has(stat)) secondary.push(row);
    else if (PRIMARY_COMBINED.has(stat) || stat <= 7) primary.push(row);
  }

  // weapons: damage range and speed
  let weapon = null;
  if (c.cls === 2 && it.delay) {
    const twoHand = slot === 0;
    const table = twoHand ? tables.dmg2h : tables.dmg1h;
    const dps = table?.get(Number(ilvl));
    if (dps) {
      const speed = it.delay / 1000;
      const avg = dps * speed;
      const v = it.variance || 0;
      const min = Math.floor(avg * (1 - v / 2));
      const max = Math.floor(avg * (1 + v / 2));
      // the game shows dps derived from the ROUNDED damage range, truncated
      const shown = ((min + max) / 2) / speed;
      weapon = { min, max, speed, dps: Math.floor(shown * 10) / 10 };
    }
  }

  // armour: only for actual armour pieces
  let armor = null;
  if (c.cls === 4 && tables.armorTotal && tables.armorLoc) {
    const totals = tables.armorTotal.get(Number(ilvl));
    const mods = tables.armorLoc.get(it.invType);
    if (totals && mods && c.sub >= 1 && c.sub <= 4 && mods[c.sub]) {
      armor = Math.round(totals[c.sub] * mods[c.sub]);
    }
  }

  const typeLabel = c.cls === 4 ? ARMOR_SUBCLASS[c.sub] : c.cls === 2 ? WEAPON_SUBCLASS[c.sub] : null;

  return {
    name: it.name, quality: it.quality, primary, stamina, secondary, weapon, armor, typeLabel,
    bindText: BIND_TEXT[it.bonding] ?? null,
    requiredLevel: it.requiredLevel > 1 ? it.requiredLevel : null,
  };
}
