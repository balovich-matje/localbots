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
const CRAFT_EXPANSION = 11; // ItemSparse.ExpansionID for Midnight — bump each expansion
const LOOT_DB_VERSION = 3; // bump to force a rebuild when the db shape changes
// ItemLimitCategory ids marking inherently-embellished crafted designs
const EMBELLISHED_LIMIT_CATEGORIES = new Set([512, 697]);

// table -> columns we keep (null = all)
const TABLES = {
  JournalTierXInstance: ['JournalTierID', 'JournalInstanceID', 'OrderIndex'],
  JournalInstance: ['ID', 'Name_lang', 'MapID', 'Flags'],
  JournalEncounter: ['ID', 'Name_lang', 'JournalInstanceID', 'OrderIndex', 'DifficultyMask'],
  JournalEncounterItem: ['ID', 'JournalEncounterID', 'ItemID', 'DifficultyMask', 'Flags', 'WorldStateExpressionID'],
  MythicPlusSeasonTrackedMap: ['MapChallengeModeID', 'DisplaySeasonID'],
  MapChallengeMode: ['ID', 'Name_lang', 'MapID'],
  Map: ['ID', 'InstanceType'],
  ItemSet: null, // small table; need all ItemID_N columns
  Item: ['ID', 'ClassID', 'SubclassID', 'InventoryType', 'IconFileDataID'],
  ItemSparse: [
    'ID', 'Display_lang', 'ItemLevel', 'AllowableClass', 'InventoryType', 'OverallQualityID', 'ExpansionID',
    'LimitCategory',
    'StatModifier_bonusStat_0', 'StatModifier_bonusStat_1', 'StatModifier_bonusStat_2',
    'StatModifier_bonusStat_3', 'StatModifier_bonusStat_4', 'StatModifier_bonusStat_5',
  ],
  CraftingData: ['ID', 'CraftedItemID'],
};

// Tables added after the first release: an older cache without them still
// counts as present (the features they power just stay off until a refresh).
const OPTIONAL_TABLES = new Set(['CraftingData']);

// Per-patch file locations. The live patch keeps the original flat layout
// (no migration for existing installs); other patches get a subdirectory.
export function patchPaths(patchId = 'live', delveFile = null) {
  const cacheDir = patchId === 'live' ? CACHE_DIR : join(CACHE_DIR, patchId);
  return {
    cacheDir,
    lootDbPath: patchId === 'live' ? LOOT_DB : join(cacheDir, 'lootdb.json'),
    delvePath: join(DATA_DIR, delveFile ?? (patchId === 'live' ? 'delve-loot.json' : `delve-loot-${patchId}.json`)),
    probeCachePath: join(cacheDir, 'simc-known-items.json'),
  };
}

// opts.build pins the exact game build wago serves (never trust wago's
// default — it sometimes points at a test build); opts.cacheDir selects the
// patch; opts.bonusesChannel picks Raidbots' live vs ptr bonus map.
export async function downloadTables(onProgress = () => {}, opts = {}) {
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const buildParam = opts.build ? `?build=${encodeURIComponent(opts.build)}` : '';
  mkdirSync(cacheDir, { recursive: true });
  const names = Object.keys(TABLES);
  for (const [i, table] of names.entries()) {
    onProgress({ table, index: i + 1, total: names.length });
    const resp = await fetch(`https://wago.tools/db2/${table}/csv${buildParam}`, {
      headers: { 'User-Agent': 'localbots (github.com/balovich-matje/localbots)' },
    });
    if (!resp.ok) throw new Error(`wago.tools ${table}: HTTP ${resp.status}`);
    writeFileSync(join(cacheDir, `${table}.csv`), await resp.text());
  }
  // Raidbots' public bonus-id map: the community-standard decode of upgrade
  // tracks ("Hero 6/6"), sockets etc. Static file, cached like the CSVs.
  onProgress({ table: 'bonuses.json (raidbots)', index: names.length, total: names.length });
  const channel = opts.bonusesChannel === 'ptr' ? 'ptr' : 'live';
  const resp = await fetch(`https://www.raidbots.com/static/data/${channel}/bonuses.json`, {
    headers: { 'User-Agent': 'localbots (github.com/balovich-matje/localbots)' },
  });
  if (resp.ok) writeFileSync(join(cacheDir, 'bonuses.json'), await resp.text());
  // Record which game build these tables came from — cacheStatus compares it
  // against the build the local simc expects, so a cache downloaded from the
  // wrong build (e.g. wago's default while it pointed at a test build) is
  // flagged for a re-download instead of silently served.
  writeFileSync(join(cacheDir, 'meta.json'),
    JSON.stringify({ build: opts.build ?? null, downloadedAt: Date.now() }));
}

// bonus id -> { track, level, max, ilvl } for upgrade-track bonuses
export function loadBonusUpgradeMap(cacheDir = CACHE_DIR) {
  const path = join(cacheDir, 'bonuses.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const map = new Map();
    for (const entry of Object.values(raw)) {
      const u = entry?.upgrade;
      if (u?.name && u.level && u.max) {
        map.set(Number(entry.id), { track: u.name, level: u.level, max: u.max, ilvl: u.itemLevel ?? null });
      }
    }
    return map;
  } catch {
    return null;
  }
}

export function cacheStatus(cacheDir = CACHE_DIR, expectedBuild = null) {
  const missing = Object.keys(TABLES)
    .filter((t) => !OPTIONAL_TABLES.has(t))
    .filter((t) => !existsSync(join(cacheDir, `${t}.csv`)));
  if (missing.length === Object.keys(TABLES).length - OPTIONAL_TABLES.size) return { present: false };
  const missingOptional = [...OPTIONAL_TABLES]
    .filter((t) => !existsSync(join(cacheDir, `${t}.csv`)));
  let cachedBuild = null;
  try {
    cachedBuild = JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf8')).build ?? null;
  } catch { /* pre-marker cache — treated as unknown build */ }
  // A cache from the wrong (or unknown) game build must be re-downloaded:
  // wago's default build sometimes points at a test build, and serving those
  // tables as "live" quietly corrupts the loot database.
  const buildMismatch = expectedBuild !== null && cachedBuild !== expectedBuild;
  let oldest = null;
  for (const t of Object.keys(TABLES)) {
    const p = join(cacheDir, `${t}.csv`);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (oldest === null || m < oldest) oldest = m;
    }
  }
  return {
    present: missing.length === 0,
    // complete = every table incl. optional ones AND the right game build; a
    // silent startup rebuild is only safe then — otherwise the UI prompts
    complete: missing.length === 0 && missingOptional.length === 0 && !buildMismatch,
    missing,
    missingOptional,
    cachedBuild,
    buildMismatch,
    downloadedAt: oldest,
  };
}

function loadTable(name, cacheDir = CACHE_DIR) {
  return parseCsv(readFileSync(join(cacheDir, `${name}.csv`), 'utf8'), TABLES[name]);
}

// Build (and persist) the joined loot database from the cached CSVs.
// Raids / world bosses / outdoor events come from the "Current Season"
// journal tier. The live M+ dungeon pool rotates out of the DB2 tables,
// so it is named explicitly in data/season.json (mythicPlusDungeons).
export function buildLootDb(mplusDungeonNames = [], paths = {}) {
  const cacheDir = paths.cacheDir ?? CACHE_DIR;
  const lootDbPath = paths.lootDbPath ?? LOOT_DB;
  const delvePath = paths.delvePath ?? join(DATA_DIR, 'delve-loot.json');
  const txi = loadTable('JournalTierXInstance', cacheDir)
    .filter((r) => Number(r.JournalTierID) === CURRENT_SEASON_TIER);
  const instances = loadTable('JournalInstance', cacheDir);
  const encounters = loadTable('JournalEncounter', cacheDir);
  const jei = loadTable('JournalEncounterItem', cacheDir);

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

  // Legacy dungeons keep their historical loot rows in the journal. Two
  // filters recover the CURRENT drop table (matches the in-game journal):
  //  1. difficulty mask must include Mythic/M+ (drops old leveling-only rows)
  //  2. when rows are gated by WorldStateExpression (Blizzard's "which era
  //     of this dungeon is active" switch), keep only the current group —
  //     identified as the one containing current-expansion item ids.
  const MYTHIC_BITS = (1 << 22) | (1 << 7); // difficulty 23 (Mythic) + 8 (M+)
  const CURRENT_ITEM_ID = 240000;
  const filterDungeonRows = (instId) => {
    const encIds = (encByInstance.get(instId) ?? []).map((e) => e.ID);
    const rows = encIds.flatMap((id) => itemsByEncounter.get(id) ?? []);
    const wseGroups = new Set(rows.map((r) => r.WorldStateExpressionID).filter((w) => w !== '0'));
    let currentWse = null;
    if (wseGroups.size > 1) {
      // the group holding newly-minted items is the live one; tie-break newest
      const candidates = [...wseGroups].filter((w) =>
        rows.some((r) => r.WorldStateExpressionID === w && Number(r.ItemID) >= CURRENT_ITEM_ID));
      currentWse = (candidates.length ? candidates : [...wseGroups])
        .sort((a, b) => Number(b) - Number(a))[0];
    }
    const keep = new Set();
    for (const r of rows) {
      const mask = Number(r.DifficultyMask);
      if (mask !== -1 && !(mask & MYTHIC_BITS)) continue;
      if (currentWse !== null && r.WorldStateExpressionID !== '0' && r.WorldStateExpressionID !== currentWse) continue;
      keep.add(r.ID);
    }
    return keep;
  };

  const picked = []; // { inst, bosses, kind, keepRows }
  const addInstance = (inst, kind) => {
    const bosses = (encByInstance.get(inst.ID) ?? [])
      .sort((a, b) => Number(a.OrderIndex) - Number(b.OrderIndex));
    if (!bosses.some((b) => (itemsByEncounter.get(b.ID) ?? []).length > 0)) return;
    const keepRows = kind === 'dungeon' ? filterDungeonRows(inst.ID) : null;
    picked.push({ inst, bosses, kind, keepRows });
  };

  // Map.InstanceType is the game's own raid/dungeon marker (2 = raid, 1 = dungeon)
  const instanceTypeByMap = new Map(loadTable('Map', cacheDir).map((r) => [r.ID, Number(r.InstanceType)]));

  for (const t of txi) {
    const inst = instById.get(t.JournalInstanceID);
    if (!inst) continue;
    const kind = Number(inst.Flags) & 2 ? 'worldboss'
      : instanceTypeByMap.get(inst.MapID) === 2 ? 'raid'
      : null; // tier dungeons not in the configured M+ pool are future content — skip
    if (kind) addInstance(inst, kind);
  }
  for (const inst of dungeonInstances) addInstance(inst, 'dungeon');

  // curated delve pool (server-side loot; see data/delve-loot.json —
  // per-patch file, optional: a patch without one just has no delve source)
  let delveEntries = [];
  try {
    delveEntries = JSON.parse(readFileSync(delvePath, 'utf8')).items ?? [];
  } catch { /* optional */ }
  const delveIds = new Set(delveEntries.filter((e) => e.id).map((e) => String(e.id)));
  const delveNames = new Set(delveEntries.filter((e) => e.name).map((e) => e.name));

  const wantedItemIds = new Set(delveIds);
  for (const { bosses, keepRows } of picked) {
    for (const b of bosses) {
      for (const r of itemsByEncounter.get(b.ID) ?? []) {
        if (keepRows && !keepRows.has(r.ID)) continue;
        wantedItemIds.add(r.ItemID);
      }
    }
  }

  // Profession-crafted gear with selectable secondary stats: the two
  // placeholder codes 24 & 25 in the stat slots mark the player-choice
  // slots, and CraftingData.CraftedItemID confirms it's an actual craft.
  const craftedRecipeIds = new Set();
  const craftingPath = join(cacheDir, 'CraftingData.csv');
  if (existsSync(craftingPath)) {
    for (const r of parseCsv(readFileSync(craftingPath, 'utf8'), TABLES.CraftingData)) {
      craftedRecipeIds.add(r.CraftedItemID);
    }
  }
  const hasSelectableStats = (r) => {
    let has24 = false, has25 = false;
    for (let i = 0; i < 6; i++) {
      const v = Number(r[`StatModifier_bonusStat_${i}`]);
      if (v === 24) has24 = true;
      if (v === 25) has25 = true;
    }
    return has24 && has25;
  };

  // Resolve delve names to the best item version (some names have old or
  // low-quality doppelgangers): highest quality wins, then newest id.
  const nameCandidates = new Map();
  const sparse = new Map();
  const craftedIds = [];
  for (const r of loadTable('ItemSparse', cacheDir)) {
    if (wantedItemIds.has(r.ID)) sparse.set(r.ID, r);
    if (craftedRecipeIds.has(r.ID) && Number(r.ExpansionID) === CRAFT_EXPANSION && hasSelectableStats(r)) {
      craftedIds.push(r.ID);
      sparse.set(r.ID, r);
    }
    if (delveNames.has(r.Display_lang)) {
      const prev = nameCandidates.get(r.Display_lang);
      const better = !prev
        || Number(r.OverallQualityID) > Number(prev.OverallQualityID)
        || (Number(r.OverallQualityID) === Number(prev.OverallQualityID) && Number(r.ID) > Number(prev.ID));
      if (better) nameCandidates.set(r.Display_lang, r);
    }
  }
  for (const r of nameCandidates.values()) {
    wantedItemIds.add(r.ID);
    sparse.set(r.ID, r);
    delveIds.add(r.ID);
  }
  for (const id of craftedIds) wantedItemIds.add(id);
  const itemMeta = new Map();
  for (const r of loadTable('Item', cacheDir)) if (wantedItemIds.has(r.ID)) itemMeta.set(r.ID, r);

  const sources = [];
  for (const { inst, bosses, kind, keepRows } of picked) {
    const bossEntries = bosses.map((b, order) => {
      const seen = new Set();
      return {
        id: b.ID,
        name: b.Name_lang,
        order,
        items: (itemsByEncounter.get(b.ID) ?? [])
          .filter((r) => !keepRows || keepRows.has(r.ID))
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

  // Curated pool entries are trusted even when the base item record is
  // low quality (epic quality often comes from server-side bonuses).
  const delveItems = [...delveIds]
    .map((id) => shapeItem(id, sparse, itemMeta))
    .filter(Boolean)
    .map((it) => ({ ...it, curated: true }));
  if (delveItems.length) {
    sources.push({
      instanceId: 'delves',
      name: 'Delves',
      kind: 'delves',
      bosses: [{ id: 'delve-pool', name: 'Bountiful loot pool', order: 0, items: delveItems }],
    });
  }

  // Craftable gear pool (one source; the stat pair is chosen at sim time)
  const craftedItems = craftedIds
    .map((id) => shapeItem(id, sparse, itemMeta))
    .filter(Boolean);
  if (craftedItems.length) {
    sources.push({
      instanceId: 'crafted',
      name: 'Crafted gear',
      kind: 'crafted',
      bosses: [{ id: 'crafted-pool', name: 'Profession crafts', order: 0, items: craftedItems }],
    });
  }

  const db = { builtAt: Date.now(), version: LOOT_DB_VERSION, sources };
  writeFileSync(lootDbPath, JSON.stringify(db));
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
    // inherently-embellished crafted designs (effect baked into the item)
    ...(EMBELLISHED_LIMIT_CATEGORIES.has(Number(s.LimitCategory)) ? { embellished: true } : {}),
  };
}

// Item-set membership from the game's ItemSet table:
// { byItem: Map(itemId -> setId), sets: Map(setId -> { name, items: [ids] }) }
export function loadItemSetMap(cacheDir = CACHE_DIR) {
  const path = join(cacheDir, 'ItemSet.csv');
  if (!existsSync(path)) return null;
  const byItem = new Map();
  const sets = new Map();
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const items = [];
    for (let i = 0; i <= 16; i++) {
      const id = Number(r[`ItemID_${i}`]);
      if (id > 0) items.push(id);
    }
    if (items.length < 2) continue;
    const setId = Number(r.ID);
    sets.set(setId, { name: r.Name_lang, items });
    for (const id of items) byItem.set(id, setId);
  }
  return { byItem, sets };
}

export function loadLootDb(lootDbPath = LOOT_DB) {
  if (!existsSync(lootDbPath)) return null;
  try {
    const db = JSON.parse(readFileSync(lootDbPath, 'utf8'));
    // an older db shape forces a rebuild from the cached CSVs at startup
    if (db.version !== LOOT_DB_VERSION) return null;
    return db;
  } catch {
    return null;
  }
}
