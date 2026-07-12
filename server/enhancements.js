// Enchant, gem, diamond and Omnium Folio comparisons for Top Gear: sim each
// season alternative by re-emitting the character's own equipped item line
// with the enchant_id / gem_id swapped.
//
// Weapons (when dual-wielding) and ring pairs sim COMBINATIONS: every
// main-hand × off-hand ordering (weapon procs care which hand) and every
// unordered ring pair (flat stat enchants don't care which ring).
//
// `selection` filters which options run: arrays of ids/values per group,
// as picked in the UI (absent/true = everything).

import { parseGear } from './gearParser.js';
import { detectSpec } from './profileBuilder.js';
import { isDualWield, primaryStat } from './lootFilter.js';

const SINGLE_SLOTS = { chest: 'chest', head: 'head', feet: 'feet', legs: 'legs' };

const clean = (s) => String(s).replace(/["\r\n$\\]/g, "'");

function swapEnchant(line, enchantId) {
  const stripped = line.replace(/,enchant_id=\d+/g, '').replace(/,enchant=[^,]+/g, '');
  return `${stripped},enchant_id=${enchantId}`;
}

function currentEnchantId(line) {
  return Number(line?.match(/,enchant_id=(\d+)/)?.[1]) || null;
}

function pickSelected(choices, selectedIds) {
  if (!Array.isArray(selectedIds)) return choices;
  const wanted = new Set(selectedIds.map(Number));
  return choices.filter((c) => wanted.has(Number(c.id)));
}

export function buildEnchantVariants(profileText, enchantOptions, selection = null, startGroup = 6000) {
  const { equipped } = parseGear(profileText);
  const spec = detectSpec(profileText);
  const dw = isDualWield(spec.key);
  const primary = primaryStat(spec.key);
  const lines = [];
  const sets = {};
  let group = startGroup;

  const emit = (label, slotLines, boss, isCurrent) => {
    const full = `${label}${isCurrent ? ' (current)' : ''}`;
    const name = clean(`Ench ${full} [e${++group}]`).slice(0, 78);
    lines.push(...slotLines.map((l, i) => `profileset."${name}"${i > 0 ? '+' : ''}=${l}`));
    sets[name] = {
      group, itemName: full, ilvl: null, slot: boss.toLowerCase(), placement: boss.toLowerCase(),
      section: 'Enchants', boss, sourceKind: 'enchants',
    };
  };

  const statOk = (choice) =>
    !(choice.stat === 'attack' && primary === 5) && !(choice.stat === 'int' && primary !== 5);

  // --- single slots ---
  for (const [category, slot] of Object.entries(SINGLE_SLOTS)) {
    if (!equipped[slot]) continue;
    const choices = pickSelected(enchantOptions?.[category] ?? [], selection?.[category]).filter(statOk);
    for (const choice of choices) {
      const isCurrent = currentEnchantId(equipped[slot]) === choice.id;
      emit(choice.label, [swapEnchant(equipped[slot], choice.id)],
        category[0].toUpperCase() + category.slice(1), isCurrent);
    }
  }

  // --- weapons: MH x OH combinations for dual-wielders ---
  const weaponChoices = pickSelected(enchantOptions?.weapon ?? [], selection?.weapon);
  if (equipped.main_hand && weaponChoices.length) {
    const curMh = currentEnchantId(equipped.main_hand);
    const curOh = currentEnchantId(equipped.off_hand);
    if (dw && equipped.off_hand) {
      for (const mh of weaponChoices) {
        for (const oh of weaponChoices) {
          const label = mh.id === oh.id
            ? `${mh.label} (both weapons)`
            : `MH: ${mh.label} + OH: ${oh.label}`;
          emit(label,
            [swapEnchant(equipped.main_hand, mh.id), swapEnchant(equipped.off_hand, oh.id)],
            'Weapons', curMh === mh.id && curOh === oh.id);
        }
      }
    } else {
      for (const mh of weaponChoices) {
        emit(mh.label, [swapEnchant(equipped.main_hand, mh.id)], 'Weapon', curMh === mh.id);
      }
    }
  }

  // --- rings: unordered pairs (flat stats — which finger doesn't matter) ---
  const ringChoices = pickSelected(enchantOptions?.ring ?? [], selection?.ring);
  const fingers = ['finger1', 'finger2'].filter((f) => equipped[f]);
  if (fingers.length === 2 && ringChoices.length) {
    const cur = new Set(fingers.map((f) => currentEnchantId(equipped[f])));
    for (let i = 0; i < ringChoices.length; i++) {
      for (let j = i; j < ringChoices.length; j++) {
        const [a, b] = [ringChoices[i], ringChoices[j]];
        const label = a.id === b.id ? `${a.label} (both rings)` : `${a.label} + ${b.label}`;
        const isCurrent = cur.has(a.id) && cur.has(b.id) && (a.id === b.id ? cur.size === 1 : cur.size === 2);
        emit(label,
          [swapEnchant(equipped.finger1, a.id), swapEnchant(equipped.finger2, b.id)],
          'Rings', isCurrent);
      }
    }
  } else if (fingers.length === 1 && ringChoices.length) {
    for (const c of ringChoices) {
      emit(c.label, [swapEnchant(equipped[fingers[0]], c.id)], 'Rings',
        currentEnchantId(equipped[fingers[0]]) === c.id);
    }
  }

  return { lines, sets };
}

// Uniform-gem comparison: every socket that holds a known stat gem is
// swapped to the candidate; diamonds and unknown ids are left untouched.
export function buildGemVariants(profileText, gemOptions, selection = null, startGroup = 7000) {
  const { equipped } = parseGear(profileText);
  const choices = pickSelected(gemOptions ?? [], selection);
  const knownGemIds = new Set((gemOptions ?? []).map((g) => String(g.id)));
  const lines = [];
  const sets = {};
  let group = startGroup;

  const gemmedSlots = Object.entries(equipped).filter(([, line]) => /,gem_id=[\d/]+/.test(line));
  if (!gemmedSlots.length || !choices.length) return { lines, sets };

  const swapLine = (line, gemId) =>
    line.replace(/,gem_id=([\d/]+)/, (m, ids) =>
      `,gem_id=${ids.split('/').map((id) => (knownGemIds.has(id) ? gemId : id)).join('/')}`);

  for (const gem of choices) {
    const swapped = gemmedSlots
      .map(([slot, line]) => [slot, swapLine(line, gem.id)])
      .filter(([slot, line]) => line !== equipped[slot]);
    const isCurrent = swapped.length === 0;
    const label = `All gems: ${gem.label}${isCurrent ? ' (current)' : ''}`;
    const name = clean(`${label} [g${++group}]`).slice(0, 78);
    const emitLines = isCurrent ? gemmedSlots : swapped;
    lines.push(...emitLines.map(([, line], i) => `profileset."${name}"${i > 0 ? '+' : ''}=${line}`));
    sets[name] = {
      group, itemName: label, ilvl: null, slot: 'gems', placement: 'all sockets',
      section: 'Gems', boss: 'Stat gems', sourceKind: 'gems',
    };
  }
  return { lines, sets };
}

// Eversong Diamond comparison: swap whichever socket currently holds one.
export function buildDiamondVariants(profileText, diamondConfig, selection = null, startGroup = 7500) {
  const { equipped } = parseGear(profileText);
  const lines = [];
  const sets = {};
  const options = pickSelected(diamondConfig?.options ?? [], selection);
  const known = new Set((diamondConfig?.knownIds ?? []).map(String));
  if (!options.length) return { lines, sets };
  let group = startGroup;

  // find the socket holding a diamond
  let holder = null; // [slot, line, currentDiamondId]
  for (const [slot, line] of Object.entries(equipped)) {
    const ids = line.match(/,gem_id=([\d/]+)/)?.[1]?.split('/') ?? [];
    const hit = ids.find((id) => known.has(id));
    if (hit) { holder = [slot, line, Number(hit)]; break; }
  }
  if (!holder) return { lines, sets };
  const [slot, line, currentId] = holder;

  for (const d of options) {
    const isCurrent = d.id === currentId || d.id === currentId + 1 || d.id === currentId - 1;
    const swapped = line.replace(/,gem_id=([\d/]+)/, (m, ids) =>
      `,gem_id=${ids.split('/').map((id) => (known.has(id) ? d.id : id)).join('/')}`);
    const label = `${d.label}${isCurrent ? ' (current)' : ''}`;
    const name = clean(`${label} [d${++group}]`).slice(0, 78);
    lines.push(`profileset."${name}"=${swapped}`);
    sets[name] = {
      group, itemName: label, ilvl: null, slot: 'gems', placement: slot,
      section: 'Gems', boss: 'Diamonds', sourceKind: 'gems',
    };
  }
  return { lines, sets };
}

// Track upgrades: sim equipped items upgraded within their own track,
// one item per variant plus one "everything together" row. The item's
// track is inferred from its resolved ilvl (highest track containing it);
// items whose level matches no track step (already Voidforged, crafted
// oddities) are skipped.
const TRACK_ORDER = ['Myth', 'Hero', 'Champion', 'Veteran', 'Adventurer'];

export function trackFor(ilvl, tracks) {
  for (const name of TRACK_ORDER) {
    const idx = (tracks[name] ?? []).indexOf(ilvl);
    if (idx >= 0) return { track: name, stepIdx: idx };
  }
  return null;
}

export function buildTrackUpgradeVariants(profileText, resolved, seasonFull, opts, startGroup = 9000) {
  const { equipped } = parseGear(profileText);
  const tracks = seasonFull.tracks ?? {};
  const vc = seasonFull.voidcore ?? {};
  const vcSlots = new Set(vc.slots ?? []);
  const step = Math.min(Math.max(Number(opts.step) || 5, 0), 5);
  const wanted = new Set(opts.slots ?? []);
  const lines = [];
  const sets = {};
  let group = startGroup;

  const upgrades = []; // [slot, upgradedLine, label]
  for (const item of resolved) {
    if (!wanted.has(item.slot) || !equipped[item.slot]) continue;
    // prefer the exact track/step decoded from the item's bonus ids
    const info = item.track != null && item.stepIdx != null
      ? { track: item.track, stepIdx: item.stepIdx }
      : trackFor(item.ilvl, tracks);
    if (!info || !tracks[info.track]) continue;
    let target = tracks[info.track][Math.max(info.stepIdx, step)];
    if (opts.voidcores && step === 5 && vcSlots.has(item.slot)) {
      if (info.track === 'Myth' && vc.mythIlvl) target = vc.mythIlvl;
      if (info.track === 'Hero' && vc.heroIlvl) target = vc.heroIlvl;
    }
    if (target <= item.ilvl) continue;
    const line = `${equipped[item.slot].replace(/,ilevel=\d+/g, '')},ilevel=${target}`;
    upgrades.push([item.slot, line, `${item.name} (${item.ilvl} → ${target})`]);
  }

  for (const [slot, line, label] of upgrades) {
    const name = clean(`Up ${label} [u${++group}]`).slice(0, 78);
    lines.push(`profileset."${name}"=${line}`);
    sets[name] = {
      group, itemName: label, ilvl: null, slot, placement: slot,
      section: 'Track upgrades', boss: 'Per item', sourceKind: 'upgrades',
    };
  }
  if (upgrades.length >= 2) {
    const name = clean(`Up all ${upgrades.length} ticked items together [u${++group}]`).slice(0, 78);
    lines.push(...upgrades.map(([, line], i) => `profileset."${name}"${i > 0 ? '+' : ''}=${line}`));
    sets[name] = {
      group, itemName: `All ${upgrades.length} ticked items upgraded together`, ilvl: null,
      slot: 'combined', placement: 'combined', section: 'Track upgrades', boss: 'Combined',
      sourceKind: 'upgrades',
    };
  }
  return { lines, sets };
}

// Omnium Folio comparison: swap one rune choice per variant in the
// export's omnium_talents= string.
export function buildFolioVariants(profileText, folioConfig, startGroup = 8000) {
  const lines = [];
  const sets = {};
  const m = profileText.match(/^\s*omnium_talents\s*=\s*(\S+)/m);
  if (!m || !folioConfig?.rows) return { lines, sets };
  let group = startGroup;

  const current = new Map(m[1].split('/').map((e) => {
    const [id, rank] = e.split(':');
    return [Number(id), Number(rank) || 1];
  }));

  for (const row of folioConfig.rows) {
    const rowEntries = row.choices.map((c) => c.entry);
    const active = rowEntries.find((e) => current.has(e)) ?? null;
    for (const choice of row.choices) {
      const isCurrent = choice.entry === active;
      const picks = new Map(current);
      if (active !== null) picks.delete(active);
      picks.set(choice.entry, 1);
      const str = [...picks.entries()].map(([id, r]) => `${id}:${r}`).join('/');
      const label = `${choice.label}${isCurrent ? ' (current)' : ''}`;
      const name = clean(`Folio ${label} [f${++group}]`).slice(0, 78);
      lines.push(`profileset."${name}"=omnium_talents=${str}`);
      sets[name] = {
        group, itemName: label, ilvl: null, slot: 'folio', placement: `row ${row.row}`,
        section: 'Omnium Folio', boss: `Row ${row.row}`, sourceKind: 'folio',
      };
    }
  }
  return { lines, sets };
}
