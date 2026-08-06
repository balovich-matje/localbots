// Droptimizer: turns "sim everything that can drop for me" into one big
// profileset run. Sources come from the wago.tools loot database; item
// levels come from the hand-curated season config.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usableSlots, CLASS_IDS } from './lootFilter.js';
import { buildInput } from './profileBuilder.js';
import { parseGear } from './gearParser.js';

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

// simc crafted_stats codes for the four selectable secondaries
// (verified empirically: 32/36 raise crit+haste, 40/49 raise vers+mastery)
export const CRAFT_STAT_LABELS = { 32: 'Crit', 36: 'Haste', 40: 'Vers', 49: 'Mastery' };
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
  const tree = { raids: [], dungeons: [], worldBosses: [], outdoor: [], delves: [], crafted: [] };
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
    else if (source.kind === 'crafted') tree.crafted.push(entry);
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
export function buildDroptimizerInput(profileText, options, selection, lootDb, spec, knownItems = null, seasonOverride = null) {
  const classId = CLASS_IDS[spec.class];
  const specKey = spec.key;
  const fullSeason = seasonOverride ?? seasonConfig();
  const season = fullSeason.droptimizer;
  const tracks = fullSeason.tracks ?? {};
  const rawUpgrade = Number(selection.upgradeTo);
  // Voidcores only apply on top of fully upgraded (6/6) items
  const withVoidcore = rawUpgrade === 6 || (selection.voidcores === true && rawUpgrade === 5);
  const upgradeTo = withVoidcore ? 5
    : Number.isInteger(rawUpgrade) && rawUpgrade >= 1 && rawUpgrade <= 5 ? rawUpgrade : null;
  const voidcoreSlots = new Set(fullSeason.voidcore?.slots ?? []);
  const voidcoreIlvl = { Myth: fullSeason.voidcore?.mythIlvl, Hero: fullSeason.voidcore?.heroIlvl };
  const offspec = selection.offspec === true;
  let skippedUnknown = 0;

  const base = buildInput(profileText, options);
  const lines = [base];
  const sets = {};
  let counter = 0;
  let group = 0;

  const addItem = (item, baseIlvl, track, labels) => {
    if (knownItems && !knownItems.has(item.id)) { skippedUnknown++; return; }
    const slots = usableSlots(item, classId, specKey, offspec);
    if (!slots || !baseIlvl) return;
    let ilvl = upgradedIlvl(baseIlvl, track, upgradeTo, tracks);
    // Voidcores apply only to fully upgraded Hero/Myth-track weapons and trinkets
    if (withVoidcore && voidcoreIlvl[track] && slots.some((s) => voidcoreSlots.has(s))) {
      ilvl = voidcoreIlvl[track];
    }
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

  // Crafted gear: the player picks the two secondary stats, so the item line
  // carries crafted_stats=A/B + crafting_quality (always max) instead of a
  // dropped item's plain ilevel-only payload.
  const addCrafted = (item, baseIlvl, pair, craftedVoidcoreIlvl) => {
    if (knownItems && !knownItems.has(item.id)) { skippedUnknown++; return; }
    const slots = usableSlots(item, classId, specKey, offspec);
    if (!slots || !baseIlvl) return;
    // crafted Voidcores: weapons/trinkets at max craft can go higher
    const ilvl = craftedVoidcoreIlvl && slots.some((s) => voidcoreSlots.has(s))
      ? craftedVoidcoreIlvl : baseIlvl;
    const [a, b] = pair.split('/').map(Number);
    const pairLabel = `${CRAFT_STAT_LABELS[a] ?? a} / ${CRAFT_STAT_LABELS[b] ?? b}`;
    const embTag = item.embellished ? ' — embellished' : '';
    group++;
    for (const placement of slots) {
      const name = `${String(item.name).replace(/["\r\n$\\]/g, "'").slice(0, 46)} ${pairLabel} [${++counter}]`;
      lines.push(`profileset."${name}"=${placement}=,id=${item.id},ilevel=${ilvl},crafted_stats=${pair},crafting_quality=5`);
      sets[name] = {
        group,
        itemName: `${item.name}${embTag} (${pairLabel})`,
        itemId: item.id,
        ilvl,
        origIlvl: ilvl,
        slot: placement,
        placement,
        section: 'Crafted gear',
        boss: pairLabel,
        sourceKind: 'crafted',
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
    } else if (source.kind === 'crafted') {
      const c = selection.crafted;
      if (!c?.enabled) continue;
      const pairs = (Array.isArray(c.statPairs) ? c.statPairs : [])
        .map(String).filter((p) => /^\d+\/\d+$/.test(p));
      if (!pairs.length) continue;
      const ilvl = Number(c.ilvl) || fullSeason.crafted?.maxIlvl || 285;
      const craftedVoidcoreIlvl = c.voidcores === true
        ? (fullSeason.voidcore?.craftedIlvl ?? null) : null;
      // Same-slot crafts are stat-identical (every plate helm sims the same),
      // so keep one usable representative per (class, subclass, inventory
      // type) — highest quality wins, so the epic craft names the row rather
      // than a rare or PvP twin that would fail the usability gate anyway.
      // Embellished designs carry their own effect, so they never collapse
      // into a plain twin (and can be excluded outright).
      const best = new Map();
      for (const boss of source.bosses) {
        for (const item of dedupe(boss.items)) {
          if (item.embellished && c.embellishments === false) continue;
          if (knownItems && !knownItems.has(item.id)) { skippedUnknown++; continue; }
          if (!usableSlots(item, classId, specKey, offspec)) continue;
          const key = `${item.classId}:${item.subclassId}:${item.invType}:${item.embellished ? 1 : 0}`;
          const prev = best.get(key);
          if (!prev || item.quality > prev.quality
              || (item.quality === prev.quality && item.id > prev.id)) {
            best.set(key, item);
          }
        }
      }
      // The 2-embellished cap is a GAME rule simc does not enforce — count
      // what the character already wears (embellished items carry a marker
      // bonus id) so suggestions stay actually equippable.
      const markers = new Set((fullSeason.embellishmentOptions?.markerBonusIds ?? [8960]).map(Number));
      const equippedEmbSlots = new Set();
      for (const [slot, line] of Object.entries(parseGear(profileText).equipped)) {
        const ids = (line.match(/bonus_id=([\d/]+)/)?.[1] ?? '').split('/').map(Number);
        if (ids.some((id) => markers.has(id))) equippedEmbSlots.add(slot);
      }
      const capOk = (usedSlots, added) =>
        [...equippedEmbSlots].filter((s) => !usedSlots.includes(s)).length + added <= 2;

      for (const item of best.values()) {
        // inherently-embellished designs count toward the cap too
        if (item.embellished) {
          const slots = usableSlots(item, classId, specKey, offspec) ?? [];
          if (!capOk(slots, 1)) continue;
        }
        for (const pair of pairs) addCrafted(item, ilvl, pair, craftedVoidcoreIlvl);
      }

      // --- embellishment rows: which craft-time effect is worth the most? ---
      const embOptions = fullSeason.embellishmentOptions?.options ?? [];
      const embSel = Array.isArray(c.embellishmentSel) ? new Set(c.embellishmentSel.map(String)) : null;
      if (embOptions.length && embSel?.size && pairs.length) {
        // hosts: plain crafted armor pieces to carry the effect; prefer slots
        // that REPLACE an already-embellished piece (keeps the cap legal)
        const HOST_PREF = [16, 9, 6, 8, 1, 3, 5, 7, 10]; // back, wrist, waist, feet, then other armor
        const hosts = [...best.values()]
          .filter((it) => !it.embellished)
          .map((it) => {
            const us = usableSlots(it, classId, specKey, offspec) ?? [];
            // land on an already-embellished slot when possible (replacing
            // that piece keeps the 2-cap satisfied, e.g. an off-hand craft)
            return { it, slot: us.find((s) => equippedEmbSlots.has(s)) ?? us[0] };
          })
          .filter((h) => h.slot && h.slot !== 'finger2' && h.slot !== 'trinket2')
          .sort((a, b) => {
            const ae = equippedEmbSlots.has(a.slot) ? 0 : 1;
            const be = equippedEmbSlots.has(b.slot) ? 0 : 1;
            if (ae !== be) return ae - be;
            return HOST_PREF.indexOf(a.it.invType) - HOST_PREF.indexOf(b.it.invType);
          })
          // two-piece rows need two DIFFERENT slots — one host per slot
          .filter(((seen) => (h) => (seen.has(h.slot) ? false : (seen.add(h.slot), true)))(new Set()));
        const pair = pairs[0];
        const emitEmb = (label, placements, opts = {}) => {
          // placements: [{host, bonus|null}] — one profileset row, cap-checked
          if (!capOk(placements.map((pl) => pl.host.slot), placements.filter((pl) => pl.bonus).length)) return null;
          group++;
          const name = `${opts.refRow ? 'Emb host' : 'Embellishment:'} ${label.replace(/["\r\n$\\]/g, "'").slice(0, 52)} [${++counter}]`;
          const lines2 = placements.map((pl, i) =>
            `profileset."${name}"${i ? '+' : ''}=${pl.host.slot}=,id=${pl.host.it.id},ilevel=${ilvl},crafted_stats=${pair},crafting_quality=5${pl.bonus ? `,bonus_id=${pl.bonus}` : ''}`);
          lines.push(...lines2);
          sets[name] = {
            group,
            itemName: `Embellishment: ${label}`,
            itemId: placements[0].host.it.id,
            ilvl,
            origIlvl: ilvl,
            slot: placements[0].host.slot,
            placement: placements[0].host.slot,
            section: 'Crafted gear',
            boss: 'Embellishments',
            sourceKind: 'crafted',
            // reference rows exist only as a comparison point and stay hidden;
            // embellishment rows rank against their plain host, so the delta
            // reads as "what the embellishment itself is worth"
            ...(opts.refRow ? { hidden: true } : {}),
            ...(opts.rebaseTo ? { rebaseTo: opts.rebaseTo } : {}),
          };
          return name;
        };
        // hidden plain-host references: same items, no embellishment
        const ref1 = hosts.length >= 1
          ? emitEmb('host ×1', [{ host: hosts[0], bonus: null }], { refRow: true }) : null;
        const ref2 = hosts.length >= 2
          ? emitEmb('host ×2', [{ host: hosts[0], bonus: null }, { host: hosts[1], bonus: null }], { refRow: true }) : null;
        for (const opt of embOptions) {
          if (!embSel.has(String(opt.key))) continue;
          if (!hosts.length) break;
          if (opt.secondBonus) {
            // a two-piece pairing (e.g. Iris + Bandolier) — needs two hosts
            if (hosts.length >= 2) {
              emitEmb(opt.label, [
                { host: hosts[0], bonus: opt.bonus },
                { host: hosts[1], bonus: opt.secondBonus },
              ], { rebaseTo: ref2 });
            }
            continue;
          }
          emitEmb(opt.label, [{ host: hosts[0], bonus: opt.bonus }], { rebaseTo: ref1 });
          // the same embellishment on two items stacks its value in game
          if (hosts.length >= 2) {
            emitEmb(`${opt.label} ×2 (two items)`, [
              { host: hosts[0], bonus: opt.bonus },
              { host: hosts[1], bonus: opt.bonus },
            ], { rebaseTo: ref2 });
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
