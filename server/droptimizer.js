// Droptimizer: turns "sim everything that can drop for me" into one big
// profileset run. Sources come from the wago.tools loot database; item
// levels come from the hand-curated season config.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usableSlots, CLASS_IDS } from './lootFilter.js';
import { buildInput } from './profileBuilder.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function seasonConfig() {
  return JSON.parse(readFileSync(join(DATA_DIR, 'season.json'), 'utf8'));
}

export function delvePool() {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'delve-loot.json'), 'utf8'));
  } catch {
    return { items: [] };
  }
}

// Per-boss item-level bucket: raids drop higher ilvl on later bosses.
// Maps boss order to one of 4 buckets across the instance.
function bossBucket(order, bossCount) {
  return Math.min(3, Math.floor((order * 4) / Math.max(1, bossCount)));
}

// Which upgrade track a drop belongs to, per source.
const RAID_DIFF_TRACK = { LFR: 'Veteran', Normal: 'Champion', Heroic: 'Hero', Mythic: 'Myth' };
function mplusTrack(keyLevel, reward) {
  const k = Number(keyLevel);
  if (reward === 'vault') return k === 0 ? 'Champion' : k >= 10 ? 'Myth' : 'Hero';
  return k <= 5 ? 'Champion' : 'Hero';
}

// "Upgrade up to X/6" à la Raidbots: lift the drop within its own track.
// upgradeTo is a step index 1..5 (2/6..6/6); null/0 = as dropped.
function upgradedIlvl(baseIlvl, trackName, upgradeTo, tracks) {
  const steps = trackName ? tracks[trackName] : null;
  if (!steps || !upgradeTo) return baseIlvl;
  let idx = steps.indexOf(baseIlvl);
  if (idx < 0) return baseIlvl; // ilvl not on the track (custom value) — leave alone
  const target = Math.min(Math.max(idx, upgradeTo), steps.length - 1);
  return steps[target];
}

// What the UI needs: every source with usable-item counts for this spec.
// `knownItems` (from the simc probe) marks which items the local simc build
// can actually sim — sources with zero simmable items are flagged
// unavailable (usually content that isn't released yet).
export function buildSourceTree(lootDb, classId, specKey, knownItems = null) {
  const tree = { raids: [], dungeons: [], worldBosses: [], outdoor: [], delves: [] };
  for (const source of lootDb.sources) {
    const bosses = source.bosses.map((b) => ({
      name: b.name,
      order: b.order,
      usable: countUsable(b.items, classId, specKey, knownItems),
    }));
    const usable = bosses.reduce((n, b) => n + b.usable, 0);
    const total = source.bosses.reduce(
      (n, b) => n + countUsable(b.items, classId, specKey, null), 0);
    if (!total) continue;
    const entry = {
      instanceId: source.instanceId,
      name: source.name,
      kind: source.kind,
      usable,
      available: knownItems === null ? true : usable > 0,
      bosses,
    };
    if (source.kind === 'raid') tree.raids.push(entry);
    else if (source.kind === 'dungeon') tree.dungeons.push(entry);
    else if (source.kind === 'worldboss') tree.worldBosses.push(entry);
    else if (source.kind === 'delves') tree.delves.push(entry);
    else tree.outdoor.push(entry);
  }
  return tree;
}

function countUsable(items, classId, specKey, knownItems) {
  const seen = new Set();
  let n = 0;
  for (const it of dedupeByName(items)) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (knownItems && !knownItems.has(it.id)) continue;
    if (usableSlots(it, classId, specKey)) n++;
  }
  return n;
}

// selection = {
//   raids:   { [instanceId]: ["Heroic", ...] },
//   dungeons:{ instanceIds: [...], keyLevel: "10", reward: "end"|"vault" },
//   worldBoss: { enabled: true, ilvl: 256 },
//   outdoor: { instanceIds: [...], ilvl: 250 },
// }
export function buildDroptimizerInput(profileText, options, selection, lootDb, spec, knownItems = null) {
  const classId = CLASS_IDS[spec.class];
  const specKey = spec.key;
  const fullSeason = seasonConfig();
  const season = fullSeason.droptimizer;
  const tracks = fullSeason.tracks ?? {};
  const upgradeTo = Number.isInteger(selection.upgradeTo) && selection.upgradeTo >= 1 && selection.upgradeTo <= 5
    ? selection.upgradeTo : null;
  let skippedUnknown = 0;

  const base = buildInput(profileText, options);
  const lines = [base];
  const sets = {};
  let counter = 0;
  let group = 0;

  const addItem = (item, baseIlvl, track, labels) => {
    if (knownItems && !knownItems.has(item.id)) { skippedUnknown++; return; }
    const slots = usableSlots(item, classId, specKey);
    if (!slots || !baseIlvl) return;
    const ilvl = upgradedIlvl(baseIlvl, track, upgradeTo, tracks);
    group++;
    for (const placement of slots) {
      const name = `${String(item.name).replace(/["\r\n$\\]/g, "'").slice(0, 60)} [${++counter}]`;
      lines.push(`profileset."${name}"=${placement}=,id=${item.id},ilevel=${ilvl}`);
      sets[name] = {
        group,
        itemName: item.name,
        itemId: item.id,
        ilvl,
        origIlvl: baseIlvl,
        slot: placement,
        placement,
        ...labels,
      };
    }
  };

  for (const source of lootDb.sources) {
    if (source.kind === 'raid') {
      const diffs = selection.raids?.[source.instanceId] ?? [];
      for (const diff of diffs) {
        const ilvls = season.raidDifficulties[diff];
        if (!ilvls) continue;
        for (const boss of source.bosses) {
          const ilvl = ilvls[bossBucket(boss.order, source.bosses.length)];
          for (const item of dedupe(boss.items)) {
            addItem(item, ilvl, RAID_DIFF_TRACK[diff],
              { section: `${source.name} ${diff}`, boss: boss.name, sourceKind: 'raid' });
          }
        }
      }
    } else if (source.kind === 'dungeon') {
      const d = selection.dungeons;
      if (!d?.instanceIds?.includes(source.instanceId)) continue;
      const table = d.reward === 'vault' ? season.mythicPlus.vault : season.mythicPlus.endOfDungeon;
      const ilvl = table[String(d.keyLevel)] ?? table['10'];
      const track = mplusTrack(d.keyLevel, d.reward);
      const label = d.reward === 'vault' ? `+${d.keyLevel} Vault` : `+${d.keyLevel}`;
      for (const boss of source.bosses) {
        for (const item of dedupe(boss.items)) {
          addItem(item, ilvl, track,
            { section: `${source.name} ${label}`, boss: boss.name, sourceKind: 'dungeon' });
        }
      }
    } else if (source.kind === 'worldboss') {
      if (!selection.worldBoss?.enabled) continue;
      const ilvl = Number(selection.worldBoss.ilvl) || season.worldBossIlvl;
      for (const boss of source.bosses) {
        for (const item of dedupe(boss.items)) {
          addItem(item, ilvl, null, { section: 'World boss', boss: boss.name, sourceKind: 'worldboss' });
        }
      }
    } else if (source.kind === 'outdoor') {
      if (!selection.outdoor?.instanceIds?.includes(source.instanceId)) continue;
      const ilvl = Number(selection.outdoor.ilvl) || season.outdoorIlvl;
      for (const boss of source.bosses) {
        for (const item of dedupe(boss.items)) {
          addItem(item, ilvl, null, { section: source.name, boss: boss.name, sourceKind: 'outdoor' });
        }
      }
    } else if (source.kind === 'delves') {
      const d = selection.delves ?? {};
      for (const track of ['Champion', 'Hero']) {
        if (!d[track.toLowerCase()]) continue;
        const ilvl = season.delveTracks?.[track];
        if (!ilvl) continue;
        for (const boss of source.bosses) {
          for (const item of dedupe(boss.items)) {
            addItem(item, ilvl, track,
              { section: `Delves · ${track}`, boss: 'Bountiful pool', sourceKind: 'delves' });
          }
        }
      }
    }
  }

  return { input: lines.join('\n') + '\n', sets, profilesetCount: counter, skippedUnknown };
}

// Legacy dungeons keep loot rows for old item versions with the same name
// (e.g. the 2014 and current Chakram-Breaker Greatsword). Keep the newest.
function dedupeByName(items) {
  const byName = new Map();
  for (const it of items) {
    const prev = byName.get(it.name);
    if (!prev || it.id > prev.id) byName.set(it.name, it);
  }
  return [...byName.values()];
}

function dedupe(items) {
  return dedupeByName(items);
}
