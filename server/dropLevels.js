// Per-item raid drop item levels.
//
// The item level a boss drops is not a property of the difficulty. It is the
// item's own step on that difficulty's upgrade track, and the step climbs
// through the instance -- so the first boss and the last boss of the same
// raid drop different levels on the same difficulty. Three tables carry it:
//
//   DungeonEncounter.ItemSequenceLevel  how far into the instance a boss sits
//   ItemBonusTreeNode                   per ItemContext (= difficulty), which
//                                       upgrade-track GROUP the drop uses
//   ItemBonusListGroupEntry             (group, sequence) -> track bonus id
//
// ItemSequenceLevel counts from 0 while a group's sequence values start at 1,
// so a drop sits at step ItemSequenceLevel + 1. Confirmed in game twice: the
// M0 dungeon table (sequence level 0) drops Champion 1/6, and Caustic
// Keeper-Crusher off the raid's second boss (sequence level 2) reads
// 285 / 298 / 311 / 324 in the adventure guide -- 3/6 on every track.
//
// The item level itself comes from the track bonus id via Raidbots' public
// bonus map, which the cache already carries.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv.js';

// ItemContext, the game's own "where did this drop from" enum
export const DIFFICULTY_CONTEXT = { LFR: 4, Normal: 3, Heroic: 5, Mythic: 6 };

// Returns null when the cache predates these tables — every caller then falls
// back to the curated per-difficulty levels in season.json.
export function loadDropLevels(cacheDir) {
  const path = (name) => join(cacheDir, `${name}.csv`);
  const needed = ['ItemXBonusTree', 'ItemBonusTreeNode', 'ItemBonusListGroupEntry'];
  if (needed.some((t) => !existsSync(path(t)))) return null;
  const bonusPath = join(cacheDir, 'bonuses.json');
  if (!existsSync(bonusPath)) return null;

  let bonuses;
  try {
    bonuses = JSON.parse(readFileSync(bonusPath, 'utf8'));
  } catch {
    return null;
  }

  const treesByItem = new Map();
  for (const r of parseCsv(readFileSync(path('ItemXBonusTree'), 'utf8'),
    ['ItemBonusTreeID', 'ItemID'])) {
    const id = Number(r.ItemID);
    if (!treesByItem.has(id)) treesByItem.set(id, []);
    treesByItem.get(id).push(Number(r.ItemBonusTreeID));
  }

  const nodesByTree = new Map();
  for (const r of parseCsv(readFileSync(path('ItemBonusTreeNode'), 'utf8'),
    ['ItemContext', 'ChildItemBonusTreeID', 'ChildItemBonusListGroupID',
      'MinMythicPlusLevel', 'MaxMythicPlusLevel', 'ParentItemBonusTreeID'])) {
    const parent = Number(r.ParentItemBonusTreeID);
    if (!nodesByTree.has(parent)) nodesByTree.set(parent, []);
    nodesByTree.get(parent).push(r);
  }

  // (group, sequence) -> the upgrade-track bonus id granted at that step
  const bonusByStep = new Map();
  for (const r of parseCsv(readFileSync(path('ItemBonusListGroupEntry'), 'utf8'),
    ['ItemBonusListGroupID', 'ItemBonusListID', 'SequenceValue'])) {
    bonusByStep.set(`${r.ItemBonusListGroupID}:${r.SequenceValue}`, Number(r.ItemBonusListID));
  }

  // itemId -> Map(ItemContext -> group). Keystone-gated nodes are skipped:
  // they are the M+ brackets, which pick a group by key level instead.
  const groupCache = new Map();
  const groupsFor = (itemId) => {
    let found = groupCache.get(itemId);
    if (found) return found;
    found = new Map();
    const seen = new Set();
    const walk = (tree) => {
      if (seen.has(tree)) return;
      seen.add(tree);
      for (const n of nodesByTree.get(tree) ?? []) {
        const group = Number(n.ChildItemBonusListGroupID);
        if (group && !Number(n.MinMythicPlusLevel) && !Number(n.MaxMythicPlusLevel)) {
          found.set(Number(n.ItemContext), group);
        }
        const child = Number(n.ChildItemBonusTreeID);
        if (child) walk(child);
      }
    };
    for (const tree of treesByItem.get(itemId) ?? []) walk(tree);
    groupCache.set(itemId, found);
    return found;
  };

  // One difficulty's drop, or null when this item has no track there (last
  // season's leftovers sit on retired groups the live bonus map has dropped).
  const dropFor = (itemId, sequenceLevel, difficulty) => {
    const group = groupsFor(itemId).get(DIFFICULTY_CONTEXT[difficulty]);
    if (!group) return null;
    const bonusId = bonusByStep.get(`${group}:${Number(sequenceLevel) + 1}`);
    const upgrade = bonusId ? bonuses[bonusId]?.upgrade : null;
    if (!upgrade?.itemLevel || !upgrade.name) return null;
    return {
      ilvl: Number(upgrade.itemLevel),
      track: upgrade.name,
      step: Number(upgrade.level),
      max: Number(upgrade.max),
      bonusId,
    };
  };

  return {
    dropFor,
    // { LFR: {...}, Normal: {...}, ... } — difficulties without a track are omitted
    dropsFor(itemId, sequenceLevel) {
      const out = {};
      for (const difficulty of Object.keys(DIFFICULTY_CONTEXT)) {
        const drop = dropFor(itemId, sequenceLevel, difficulty);
        if (drop) out[difficulty] = drop;
      }
      return Object.keys(out).length ? out : null;
    },
  };
}
