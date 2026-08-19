// Droptimizer: turns "sim everything that can drop for me" into one big
// profileset run. Sources and raid drop levels come from the wago.tools loot
// database; M+, delve and world levels come from the hand-curated season
// config. Every suggestion inherits the slot's enchant and gems, so it is
// compared against the character's gear rather than against a bare item.

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
// Maps boss order to one of 4 buckets across the instance. Only used by old
// configs that still carry an array per difficulty.
function bossBucket(order, bossCount) {
  return Math.min(3, Math.floor((order * 4) / Math.max(1, bossCount)));
}

// Which upgrade track a drop belongs to, per source.
const RAID_DIFF_TRACK = { LFR: 'Veteran', Normal: 'Champion', Heroic: 'Hero', Mythic: 'Myth' };

// simc crafted_stats codes for the four selectable secondaries
// (verified empirically: 32/36 raise crit+haste, 40/49 raise vers+mastery)
export const CRAFT_STAT_LABELS = { 32: 'Crit', 36: 'Haste', 40: 'Vers', 49: 'Mastery' };

const SLOT_LABEL = (s) => String(s)
  .replace(/(finger|trinket)(\d)/, '$1 $2')
  .replace(/_/g, ' ')
  .replace(/^\w/, (c) => c.toUpperCase());
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
      // what this boss drops per difficulty, so the UI can show it and the
      // numbers can be checked against the in-game adventure guide
      ...(bossDrops(b) ? { drops: bossDrops(b) } : {}),
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

// All of a boss's items share its drop levels, so the first annotated item
// speaks for the boss.
function bossDrops(boss) {
  const item = boss.items.find((it) => it.drops);
  if (!item) return null;
  const out = {};
  for (const [diff, drop] of Object.entries(item.drops)) {
    out[diff] = { ilvl: drop.ilvl, track: drop.track, step: drop.step, max: drop.max };
  }
  return out;
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
export function buildDroptimizerInput(profileText, options, selection, lootDb, spec, knownItems = null, seasonOverride = null, socketBonusIds = null) {
  // Carry each slot's enchant onto whatever we suggest for it. Without this
  // every candidate is simmed bare while the character keeps theirs, which
  // makes upgrades look like losses -- worst on weapons, where a death
  // knight's runeforge is worth well over 10%.
  const enchantBySlot = {};
  for (const [slot, line] of Object.entries(parseGear(profileText).equipped)) {
    const m = line.match(/enchant_id=(\d+)/);
    if (m) enchantBySlot[slot] = m[1];
  }
  const ench = (slot) => (enchantBySlot[slot] ? `,enchant_id=${enchantBySlot[slot]}` : '');

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

  // Gems ride along with the slot, for the same reason enchants do. Sockets in
  // this expansion are added per slot by the player rather than being born on
  // the item, so a replacement in that slot gets the same treatment: the same
  // socket bonus ids, filled with the same gems. A gem is duplicated to fill a
  // spare socket, EXCEPT an Eversong Diamond -- those are unique-equipped, so
  // duplicating one would invent a gem the character cannot wear, and the
  // spare socket is left empty instead.
  const socketIds = socketBonusIds ?? new Set();
  const diamondIds = new Set((fullSeason.diamondOptions?.knownIds ?? []).map(Number));
  const carriedBySlot = {};
  for (const [slot, line] of Object.entries(parseGear(profileText).equipped)) {
    const bonuses = (line.match(/bonus_id=([\d/]+)/)?.[1] ?? '').split('/')
      .map(Number).filter((id) => socketIds.has(id));
    const gems = (line.match(/gem_id=([\d/]+)/)?.[1] ?? '').split('/')
      .filter((g) => g && g !== '0');
    if (bonuses.length || gems.length) carriedBySlot[slot] = { bonuses, gems };
  }
  // -> { bonusIds, gems } for one placement of one item
  const socketPayload = (slot, item) => {
    const carried = carriedBySlot[slot];
    const sockets = (item.sockets ?? 0) + (carried?.bonuses.length ?? 0);
    if (!carried || !sockets) return { bonusIds: [], gems: [] };
    const gems = [];
    for (let i = 0; i < sockets; i++) {
      const gem = carried.gems[i] ?? carried.gems[carried.gems.length - 1];
      if (!gem) break;
      if (i >= carried.gems.length && diamondIds.has(Number(gem))) break;
      gems.push(gem);
    }
    return { bonusIds: carried.bonuses, gems };
  };
  // the ",bonus_id=...,gem_id=..." tail for an item line, merging any bonus
  // ids the row already needs (an embellishment, say)
  const sock = (slot, item, extraBonusIds = []) => {
    const { bonusIds, gems } = socketPayload(slot, item);
    const all = [...extraBonusIds, ...bonusIds];
    return (all.length ? `,bonus_id=${all.join('/')}` : '')
      + (gems.length ? `,gem_id=${gems.join('/')}` : '');
  };

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
      lines.push(`profileset."${name}"=${placement}=,id=${item.id},ilevel=${ilvl}${ench(placement)}${sock(placement, item)}`);
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
      lines.push(`profileset."${name}"=${placement}=,id=${item.id},ilevel=${ilvl},crafted_stats=${pair},crafting_quality=5${ench(placement)}${sock(placement, item)}`);
      sets[name] = {
        group,
        itemName: `${item.name}${embTag} (${pairLabel})`,
        itemId: item.id,
        ilvl,
        origIlvl: ilvl,
        slot: placement,
        placement,
        section: 'Crafted gear',
        boss: SLOT_LABEL(placement),
        sourceKind: 'crafted',
      };
    }
  };

  for (const source of lootDb.sources) {
    if (source.kind === 'raid') {
      const diffs = selection.raids?.[source.instanceId] ?? [];
      for (const diff of diffs) {
        // Each item carries its own drop level, read from its bonus tree at
        // build time -- the level is a property of the item, so bosses later
        // in the instance drop higher. season.raidDifficulties is the fallback
        // for caches built before that lookup existed (a flat number, or the
        // even older four-bucket array).
        const entry = season.raidDifficulties[diff];
        for (const boss of source.bosses) {
          const fallback = entry == null ? null
            : Array.isArray(entry) ? entry[bossBucket(boss.order, source.bosses.length)]
            : entry;
          for (const item of dedupe(boss.items)) {
            const drop = item.drops?.[diff];
            if (!drop && fallback == null) continue;
            addItem(item, drop?.ilvl ?? fallback, drop?.track ?? RAID_DIFF_TRACK[diff],
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

      // --- embellishment rows: the same crafted items, carrying an effect ---
      const embOptions = fullSeason.embellishmentOptions?.options ?? [];
      const embSel = Array.isArray(c.embellishmentSel) ? new Set(c.embellishmentSel.map(String)) : null;
      if (embOptions.length && embSel?.size && pairs.length) {
        // Hosts carry the effect. ARMOR only — swapping a weapon distorts the
        // row with the weapon change itself — except when the character's own
        // embellished piece IS a weapon (then a weapon-for-weapon swap on that
        // slot is the fair comparison). Prefer slots that replace an
        // already-embellished piece so the 2-cap stays satisfiable.
        const HOST_PREF = [16, 9, 6, 8, 1, 3, 5, 7, 10]; // back, wrist, waist, feet, then other armor
        const prefIdx = (invType) => {
          const i = HOST_PREF.indexOf(invType);
          return i === -1 ? 99 : i;
        };
        const hosts = [...best.values()]
          .filter((it) => !it.embellished)
          .map((it) => {
            const us = usableSlots(it, classId, specKey, offspec) ?? [];
            return { it, slot: us.find((s) => equippedEmbSlots.has(s)) ?? us[0] };
          })
          .filter((h) => h.slot
            && (h.it.classId === 4 ? HOST_PREF.includes(h.it.invType) : equippedEmbSlots.has(h.slot)))
          .sort((a, b) => {
            const ae = equippedEmbSlots.has(a.slot) ? 0 : 1;
            const be = equippedEmbSlots.has(b.slot) ? 0 : 1;
            if (ae !== be) return ae - be;
            return prefIdx(a.it.invType) - prefIdx(b.it.invType);
          })
          // two-piece rows need two DIFFERENT slots — one host per slot
          .filter(((seen) => (h) => (seen.has(h.slot) ? false : (seen.add(h.slot), true)))(new Set()));
        const pair = pairs[0];
        const pairLabel = pair.split('/').map((s) => CRAFT_STAT_LABELS[Number(s)] ?? s).join(' / ');
        const emitEmb = (rowLabel, boss, placements) => {
          // placements: [{host, bonus}] — one profileset row, cap-checked
          if (!capOk(placements.map((pl) => pl.host.slot), placements.length)) return;
          group++;
          const name = `${rowLabel.replace(/["\r\n$\\]/g, "'").slice(0, 64)} [${++counter}]`;
          placements.forEach((pl, i) => {
            lines.push(`profileset."${name}"${i ? '+' : ''}=${pl.host.slot}=,id=${pl.host.it.id},ilevel=${ilvl},crafted_stats=${pair},crafting_quality=5${ench(pl.host.slot)}${sock(pl.host.slot, pl.host.it, [pl.bonus])}`);
          });
          sets[name] = {
            group,
            itemName: rowLabel,
            itemId: placements[0].host.it.id,
            ilvl,
            origIlvl: ilvl,
            slot: placements[0].host.slot,
            placement: placements[0].host.slot,
            section: 'Crafted gear',
            boss,
            sourceKind: 'crafted',
          };
        };
        for (const opt of embOptions) {
          if (!embSel.has(String(opt.key))) continue;
          if (!hosts.length) break;
          const [a, b] = hosts;
          if (opt.secondBonus) {
            // a two-piece pairing (e.g. Iris + Bandolier) — needs two hosts
            if (b) {
              emitEmb(`${a.it.name} + ${b.it.name} (${pairLabel}) — ${opt.label}`,
                'Embellished pairs',
                [{ host: a, bonus: opt.bonus }, { host: b, bonus: opt.secondBonus }]);
            }
            continue;
          }
          // single: this crafted item, with this embellishment — grouped
          // under its slot right next to the plain version of the same item
          emitEmb(`${a.it.name} (${pairLabel}) — ${opt.label}`,
            SLOT_LABEL(a.slot),
            [{ host: a, bonus: opt.bonus }]);
          // the same embellishment on two items stacks its value in game
          if (b) {
            emitEmb(`${a.it.name} + ${b.it.name} (${pairLabel}) — ${opt.label} ×2`,
              'Embellished pairs',
              [{ host: a, bonus: opt.bonus }, { host: b, bonus: opt.bonus }]);
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
