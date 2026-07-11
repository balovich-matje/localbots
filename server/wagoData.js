// Downloads wago.tools DB2 exports (the live game client's own database),
// caches them in data/cache/, and builds the season loot database:
// every source (raid boss / M+ dungeon / world boss / outdoor event) and
// every equippable item it drops.
//
// wago.tools updates per game build — downloads happen only on demand
// ("Refresh data" in the UI) or when the cache is empty.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LOOT_DB = join(CACHE_DIR, 'lootdb.json');

const CURRENT_SEASON_TIER = 505; // JournalTier "Current Season" — stable across seasons

// table -> columns we keep (null = all)
const TABLES = {
  JournalTierXInstance: ['JournalTierID', 'JournalInstanceID', 'OrderIndex'],
  JournalInstance: ['ID', 'Name_lang', 'MapID', 'Flags'],
  JournalEncounter: ['ID', 'Name_lang', 'JournalInstanceID', 'OrderIndex', 'DifficultyMask'],
  JournalEncounterItem: ['ID', 'JournalEncounterID', 'ItemID', 'DifficultyMask', 'Flags'],
  MythicPlusSeasonTrackedMap: ['MapChallengeModeID', 'DisplaySeasonID'],
  MapChallengeMode: ['ID', 'Name_lang', 'MapID'],
  Item: ['ID', 'ClassID', 'SubclassID', 'InventoryType', 'IconFileDataID'],
  ItemSparse: [
    'ID', 'Display_lang', 'ItemLevel', 'AllowableClass', 'InventoryType', 'OverallQualityID',
    'StatModifier_bonusStat_0', 'StatModifier_bonusStat_1', 'StatModifier_bonusStat_2',
    'StatModifier_bonusStat_3', 'StatModifier_bonusStat_4', 'StatModifier_bonusStat_5',
  ],
};

export async function downloadTables(onProgress = () => {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const names = Object.keys(TABLES);
  for (const [i, table] of names.entries()) {
    onProgress({ table, index: i + 1, total: names.length });
    const resp = await fetch(`https://wago.tools/db2/${table}/csv`, {
      headers: { 'User-Agent': 'localbots (github.com/balovich-matje/localbots)' },
    });
    if (!resp.ok) throw new Error(`wago.tools ${table}: HTTP ${resp.status}`);
    writeFileSync(join(CACHE_DIR, `${table}.csv`), await resp.text());
  }
}

export function cacheStatus() {
  const missing = Object.keys(TABLES).filter((t) => !existsSync(join(CACHE_DIR, `${t}.csv`)));
  if (missing.length === Object.keys(TABLES).length) return { present: false };
  let oldest = null;
  for (const t of Object.keys(TABLES)) {
    const p = join(CACHE_DIR, `${t}.csv`);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (oldest === null || m < oldest) oldest = m;
    }
  }
  return { present: missing.length === 0, missing, downloadedAt: oldest };
}

function loadTable(name) {
  return parseCsv(readFileSync(join(CACHE_DIR, `${name}.csv`), 'utf8'), TABLES[name]);
}

// Build (and persist) the joined loot database from the cached CSVs.
// Raids / world bosses / outdoor events come from the "Current Season"
// journal tier. The live M+ dungeon pool rotates out of the DB2 tables,
// so it is named explicitly in data/season.json (mythicPlusDungeons).
export function buildLootDb(mplusDungeonNames = []) {
  const txi = loadTable('JournalTierXInstance')
    .filter((r) => Number(r.JournalTierID) === CURRENT_SEASON_TIER);
  const instances = loadTable('JournalInstance');
  const encounters = loadTable('JournalEncounter');
  const jei = loadTable('JournalEncounterItem');

  const instById = new Map(instances.map((r) => [r.ID, r]));
  const encByInstance = new Map();
  for (const e of encounters) {
    if (!encByInstance.has(e.JournalInstanceID)) encByInstance.set(e.JournalInstanceID, []);
    encByInstance.get(e.JournalInstanceID).push(e);
  }
  const itemsByEncounter = new Map();
  for (const r of jei) {
    if (!itemsByEncounter.has(r.JournalEncounterID)) itemsByEncounter.set(r.JournalEncounterID, []);
    itemsByEncounter.get(r.JournalEncounterID).push(r);
  }

  // M+ pool: resolve configured names to journal instances (newest wins on
  // name collisions — remakes like Magisters' Terrace reuse the name).
  const dungeonInstances = [];
  for (const name of mplusDungeonNames) {
    const matches = instances.filter((r) => r.Name_lang === name);
    if (!matches.length) continue;
    matches.sort((a, b) => Number(b.ID) - Number(a.ID));
    dungeonInstances.push(matches[0]);
  }

  const picked = []; // { inst, bosses, kind }
  const addInstance = (inst, kind) => {
    const bosses = (encByInstance.get(inst.ID) ?? [])
      .sort((a, b) => Number(a.OrderIndex) - Number(b.OrderIndex));
    if (!bosses.some((b) => (itemsByEncounter.get(b.ID) ?? []).length > 0)) return;
    picked.push({ inst, bosses, kind });
  };

  for (const t of txi) {
    const inst = instById.get(t.JournalInstanceID);
    if (!inst) continue;
    const bosses = encByInstance.get(inst.ID) ?? [];
    const kind = Number(inst.Flags) & 2 ? 'worldboss'
      : bosses.length >= 6 ? 'raid'
      : bosses.length <= 2 ? 'outdoor'
      : null; // 3-5 boss dungeons in this tier are a future M+ pool — skip
    if (kind) addInstance(inst, kind);
  }
  for (const inst of dungeonInstances) addInstance(inst, 'dungeon');

  // curated delve pool (server-side loot; see data/delve-loot.json)
  let delveEntries = [];
  try {
    delveEntries = JSON.parse(readFileSync(join(DATA_DIR, 'delve-loot.json'), 'utf8')).items ?? [];
  } catch { /* optional */ }
  const delveIds = new Set(delveEntries.filter((e) => e.id).map((e) => String(e.id)));
  const delveNames = new Set(delveEntries.filter((e) => e.name).map((e) => e.name));

  const wantedItemIds = new Set(delveIds);
  for (const { bosses } of picked) {
    for (const b of bosses) {
      for (const r of itemsByEncounter.get(b.ID) ?? []) wantedItemIds.add(r.ItemID);
    }
  }

  const sparse = new Map();
  for (const r of loadTable('ItemSparse')) {
    if (wantedItemIds.has(r.ID)) sparse.set(r.ID, r);
    else if (delveNames.has(r.Display_lang)) { wantedItemIds.add(r.ID); sparse.set(r.ID, r); delveIds.add(r.ID); }
  }
  const itemMeta = new Map();
  for (const r of loadTable('Item')) if (wantedItemIds.has(r.ID)) itemMeta.set(r.ID, r);

  const sources = [];
  for (const { inst, bosses, kind } of picked) {
    const bossEntries = bosses.map((b, order) => {
      const seen = new Set();
      return {
        id: b.ID,
        name: b.Name_lang,
        order,
        items: (itemsByEncounter.get(b.ID) ?? [])
          .filter((r) => (seen.has(r.ItemID) ? false : (seen.add(r.ItemID), true)))
          .map((r) => shapeItem(r.ItemID, sparse, itemMeta))
          .filter(Boolean),
      };
    }).filter((b) => b.items.length > 0);

    if (bossEntries.length) {
      sources.push({
        instanceId: inst.ID,
        name: inst.Name_lang,
        kind,
        bosses: bossEntries,
      });
    }
  }

  const delveItems = [...delveIds].map((id) => shapeItem(id, sparse, itemMeta)).filter(Boolean);
  if (delveItems.length) {
    sources.push({
      instanceId: 'delves',
      name: 'Delves',
      kind: 'delves',
      bosses: [{ id: 'delve-pool', name: 'Bountiful loot pool', order: 0, items: delveItems }],
    });
  }

  const db = { builtAt: Date.now(), sources };
  writeFileSync(LOOT_DB, JSON.stringify(db));
  return db;
}

// Only keep equippable gear (armor/weapons), drop quest items, tokens, recipes.
function shapeItem(itemId, sparse, itemMeta) {
  const s = sparse.get(itemId);
  const m = itemMeta.get(itemId);
  if (!s || !m) return null;
  const invType = Number(s.InventoryType);
  if (!invType || invType === 18 || invType === 24 || invType === 27 || invType === 28) return null; // bags, ammo, quivers
  const classId = Number(m.ClassID);
  if (classId !== 2 && classId !== 4) return null; // weapons + armor only
  const stats = [];
  for (let i = 0; i < 6; i++) {
    const v = Number(s[`StatModifier_bonusStat_${i}`]);
    if (v > 0) stats.push(v);
  }
  return {
    id: Number(itemId),
    name: s.Display_lang,
    invType,
    quality: Number(s.OverallQualityID),
    allowableClass: Number(s.AllowableClass),
    classId,
    subclassId: Number(m.SubclassID),
    stats,
    icon: Number(m.IconFileDataID) || null,
  };
}

export function loadLootDb() {
  if (!existsSync(LOOT_DB)) return null;
  try {
    return JSON.parse(readFileSync(LOOT_DB, 'utf8'));
  } catch {
    return null;
  }
}
